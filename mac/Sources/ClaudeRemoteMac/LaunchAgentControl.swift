import Darwin
import Foundation

/// 与 scripts/launchd/install.sh 安装的 LaunchAgent 交互。
///
/// 安装了 LaunchAgent 时 daemon 由 launchd 常驻托管（登录即起、崩溃重启、与终端会话无关），
/// 菜单栏 App 不再自己拉子进程，而是把启动/停止/重启转成 launchctl 操作；
/// 否则菜单栏 App 一停，launchd 立刻又把它拉起来，或者两边抢同一个端口。
enum LaunchAgentControl {
    static let daemonLabel = "com.claude-remote.daemon"

    static var daemonPlistURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(daemonLabel).plist")
    }

    private static var domain: String { "gui/\(getuid())" }
    private static var serviceTarget: String { "\(domain)/\(daemonLabel)" }

    /// plist 存在即视为「由 launchd 托管」（即使当前被 bootout 停掉）。
    static var isDaemonInstalled: Bool {
        FileManager.default.fileExists(atPath: daemonPlistURL.path)
    }

    static func isDaemonLoaded() -> Bool {
        run(["print", serviceTarget]).status == 0
    }

    /// 加载（若未加载）并立即启动。
    @discardableResult
    static func startDaemon() -> Result {
        if !isDaemonLoaded() {
            let result = run(["bootstrap", domain, daemonPlistURL.path])
            if result.status != 0 { return result }
        }
        return run(["kickstart", serviceTarget])
    }

    /// 卸载服务：KeepAlive 下单纯发 SIGTERM 会被立刻拉起，必须 bootout 才能真正停住。
    /// plist 保留，下次登录或点「启动」会重新加载。
    @discardableResult
    static func stopDaemon() -> Result {
        guard isDaemonLoaded() else { return Result(status: 0, output: "") }
        return run(["bootout", serviceTarget])
    }

    /// -k：先杀掉正在运行的实例再启动。
    @discardableResult
    static func restartDaemon() -> Result {
        if !isDaemonLoaded() { return startDaemon() }
        return run(["kickstart", "-k", serviceTarget])
    }

    struct Result {
        let status: Int32
        let output: String
    }

    private static func run(_ arguments: [String]) -> Result {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        do {
            try process.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            return Result(status: process.terminationStatus, output: String(decoding: data, as: UTF8.self))
        } catch {
            return Result(status: -1, output: error.localizedDescription)
        }
    }
}
