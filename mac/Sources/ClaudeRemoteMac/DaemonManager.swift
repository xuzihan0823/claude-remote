import Darwin
import Foundation

@MainActor
final class DaemonManager: ObservableObject {
    enum State: Equatable {
        case stopped
        case starting
        case running
        case portConflict
        case failed(String)
    }

    @Published private(set) var state: State = .stopped
    @Published private(set) var lastError: String?

    private let settings: AppSettings
    private let claudeLocator: ClaudeLocator
    private var process: Process?
    private var restartTask: Task<Void, Never>?
    private var restartAttempt = 0
    private var shouldRun = false

    init(settings: AppSettings, claudeLocator: ClaudeLocator) {
        self.settings = settings
        self.claudeLocator = claudeLocator
    }

    var isManagedProcessRunning: Bool {
        process?.isRunning == true
    }

    func start() {
        guard !isManagedProcessRunning else { return }
        restartTask?.cancel()
        shouldRun = true
        launch()
    }

    func restart() {
        restartTask?.cancel()
        shouldRun = true
        Task {
            await stopProcess()
            launch()
        }
    }

    func stop() {
        shouldRun = false
        restartTask?.cancel()
        restartTask = nil
        Task { await stopProcess() }
    }

    /// 停止「任何」占着端口的 daemon：托管子进程走正常路径；
    /// 外部实例（如终端手工启动、或上次 app 未清理的遗留）按端口找 pid 发信号。
    func stopAny() {
        if isManagedProcessRunning {
            stop()
            return
        }
        shouldRun = false
        let pids = Self.listenerPids(port: settings.port)
        for pid in pids { _ = Darwin.kill(pid, SIGTERM) }
        if !pids.isEmpty {
            NSLog("[DaemonManager] 已向外部 daemon 发送 SIGTERM: \(pids)")
        }
        state = .stopped
    }

    /// 重启：先停掉托管或外部实例，再以托管方式拉起。
    func restartAny() {
        restartTask?.cancel()
        Task {
            if isManagedProcessRunning {
                await stopProcess()
            } else {
                let pids = Self.listenerPids(port: settings.port)
                for pid in pids { _ = Darwin.kill(pid, SIGTERM) }
                // 等外部进程释放端口
                for _ in 0..<30 {
                    if Self.listenerPids(port: settings.port).isEmpty { break }
                    try? await Task.sleep(for: .milliseconds(200))
                }
            }
            shouldRun = true
            launch()
        }
    }

    /// 用 lsof 找出监听指定 TCP 端口的进程。
    private static func listenerPids(port: Int) -> [pid_t] {
        let lsof = Process()
        lsof.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        lsof.arguments = ["-ti", "tcp:\(port)", "-sTCP:LISTEN"]
        let pipe = Pipe()
        lsof.standardOutput = pipe
        lsof.standardError = FileHandle.nullDevice
        do {
            try lsof.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            lsof.waitUntilExit()
            return String(decoding: data, as: UTF8.self)
                .split(whereSeparator: \.isNewline)
                .compactMap { pid_t($0) }
        } catch {
            return []
        }
    }

    /// 退出 app 时的同步停止：必须在进程退出前把信号发出去，否则 daemon 成孤儿。
    func stopSynchronouslyForTermination() {
        shouldRun = false
        restartTask?.cancel()
        restartTask = nil
        guard let process else { return }
        self.process = nil
        let pid = process.processIdentifier
        terminateProcessGroup(pid, signal: SIGTERM)
        let deadline = Date().addingTimeInterval(3)
        while process.isRunning && Date() < deadline { usleep(100_000) }
        if process.isRunning { terminateProcessGroup(pid, signal: SIGKILL) }
    }

    func reportPortConflict() {
        guard !isManagedProcessRunning else { return }
        state = .portConflict
    }

    private func launch() {
        guard shouldRun, !isManagedProcessRunning else { return }
        do {
            let token = try KeychainTokenStore.token()
            let shell = Process()
            // setpgid 必须由子进程在 exec 前自己调用（exec 后父进程再调会 EACCES）。
            // macOS 无 setsid 命令，用自带 perl 做 trampoline：先 setpgrp 成组长再 exec zsh→pnpm 链。
            shell.executableURL = URL(fileURLWithPath: "/usr/bin/perl")
            shell.arguments = ["-e", "setpgrp(0,0); exec @ARGV or die $!", "--", "/bin/zsh", "-lc", "exec \(settings.launchCommand)"]
            var environment = ProcessInfo.processInfo.environment
            environment["BRIDGE_TOKEN"] = token
            if let claudePath = claudeLocator.locate() {
                environment["CLAUDE_BIN"] = claudePath
            }
            shell.environment = environment
            shell.terminationHandler = { [weak self, weak shell] process in
                Task { @MainActor in
                    guard let self, self.process === shell else { return }
                    self.process = nil
                    if self.shouldRun {
                        self.scheduleRestart(afterExitStatus: process.terminationStatus)
                    } else {
                        self.state = .stopped
                    }
                }
            }
            state = .starting
            try shell.run()
            process = shell
            restartAttempt = 0
        } catch {
            NSLog("[DaemonManager] launch 失败: \(error)")
            lastError = error.localizedDescription
            state = .failed(error.localizedDescription)
            scheduleRestart(afterExitStatus: -1)
        }
    }

    private func scheduleRestart(afterExitStatus status: Int32) {
        guard shouldRun else { return }
        let delay = min(pow(2.0, Double(restartAttempt)), 60.0)
        restartAttempt = min(restartAttempt + 1, 6)
        lastError = "daemon 退出（状态 \(status)），将在 \(Int(delay)) 秒后重启。"
        NSLog("[DaemonManager] \(lastError!)")
        state = .failed(lastError ?? "daemon 已退出。")
        restartTask?.cancel()
        restartTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            await MainActor.run { self?.launch() }
        }
    }

    private func stopProcess() async {
        guard let process else {
            state = .stopped
            return
        }
        restartTask?.cancel()
        self.process = nil
        let pid = process.processIdentifier
        terminateProcessGroup(pid, signal: SIGTERM)

        let exitedGracefully = await waitForExit(process, timeout: .seconds(8))
        if !exitedGracefully {
            terminateProcessGroup(pid, signal: SIGKILL)
            _ = await waitForExit(process, timeout: .seconds(2))
        }
        state = .stopped
    }

    private func terminateProcessGroup(_ pid: pid_t, signal: Int32) {
        // zsh exec 后 daemon 为组长；负 PID 将信号发送给整个子进程组。
        _ = Darwin.kill(-pid, signal)
        if errno == ESRCH { _ = Darwin.kill(pid, signal) }
    }

    enum ProcessError: LocalizedError {
        case cannotCreateProcessGroup(Int32)

        var errorDescription: String? {
            switch self {
            case .cannotCreateProcessGroup(let code):
                return "无法创建 daemon 进程组（errno \(code)）。"
            }
        }
    }

    private func waitForExit(_ process: Process, timeout: Duration) async -> Bool {
        let clock = ContinuousClock()
        let deadline = clock.now + timeout
        while process.isRunning && clock.now < deadline {
            try? await Task.sleep(for: .milliseconds(100))
        }
        return !process.isRunning
    }
}
