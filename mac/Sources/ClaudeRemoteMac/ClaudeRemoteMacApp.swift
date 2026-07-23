import AppKit
import ServiceManagement
import SwiftUI

@main
struct ClaudeRemoteMacApp: App {
    @StateObject private var settings: AppSettings
    @StateObject private var claudeLocator: ClaudeLocator
    @StateObject private var daemon: DaemonManager
    @StateObject private var healthMonitor: HealthMonitor
    private let terminationDelegate = TerminationDelegate()

    init() {
        let settings = AppSettings()
        let locator = ClaudeLocator(settings: settings)
        let daemon = DaemonManager(settings: settings, claudeLocator: locator)
        _settings = StateObject(wrappedValue: settings)
        _claudeLocator = StateObject(wrappedValue: locator)
        _daemon = StateObject(wrappedValue: daemon)
        let monitor = HealthMonitor(settings: settings, daemon: daemon)
        _healthMonitor = StateObject(wrappedValue: monitor)
        // 引导放这里而非菜单 onAppear：面板内容只在用户点开时才构建。
        // 注意：必须用局部实例，StateObject 装载前访问 wrappedValue 会得到孤儿副本。
        let delegate = terminationDelegate
        Task { @MainActor in
            guard !Bootstrap.didStart else { return }
            Bootstrap.didStart = true
            // 裸 SPM 可执行默认 .regular：后台/nohup 启动时 MenuBarExtra 状态项不渲染，必须显式降为菜单栏助手形态。
            NSApp.setActivationPolicy(.accessory)
            delegate.manager = daemon
            NSApp.delegate = delegate
            monitor.start()
            // 已有 daemon 存活（如终端手工启动的开发实例）就直接接管显示，避免撞端口。
            if await monitor.checkOnce() != .healthy {
                daemon.start()
            }
        }
    }

    var body: some Scene {
        MenuBarExtra {
            MenuPanelView(
                settings: settings,
                claudeLocator: claudeLocator,
                daemon: daemon,
                healthMonitor: healthMonitor
            )
        } label: {
            Image(systemName: menuIcon)
                .symbolRenderingMode(.hierarchical)
        }
        // .window 样式：面板可承载任意视图（内嵌二维码）；.menu 只能放菜单项。
        .menuBarExtraStyle(.window)
    }

    private var menuIcon: String {
        switch healthMonitor.health {
        case .healthy: return "sparkle"
        case .portConflict: return "exclamationmark.triangle.fill"
        case .unknown, .unavailable: return "circle.dotted"
        }
    }
}

/// 菜单栏面板：状态 + 内嵌二维码 + 控制按钮。
private struct MenuPanelView: View {
    @ObservedObject var settings: AppSettings
    @ObservedObject var claudeLocator: ClaudeLocator
    @ObservedObject var daemon: DaemonManager
    @ObservedObject var healthMonitor: HealthMonitor

    @State private var launchAtLogin = false
    @State private var startupError: String?
    @State private var qrRefreshKey = 0

    var body: some View {
        VStack(spacing: 10) {
            HStack(spacing: 6) {
                Circle()
                    .fill(statusColor)
                    .frame(width: 9, height: 9)
                Text(statusText)
                    .font(.headline)
                Spacer()
            }

            if claudeLocator.path == nil {
                Button("未找到 claude 可执行文件，手动选择...") {
                    claudeLocator.chooseManually()
                }
            }

            if healthMonitor.health == .healthy {
                PairQRView(settings: settings, refreshKey: qrRefreshKey)
                Text("用 iPhone 相机扫码配对")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Button("在浏览器打开完整界面") {
                NSWorkspace.shared.open(settings.baseURL)
            }
            .disabled(healthMonitor.health != .healthy)
            .frame(maxWidth: .infinity)

            Divider()

            HStack(spacing: 8) {
                Button("启动") { daemon.start() }
                    .disabled(daemon.isManagedProcessRunning || healthMonitor.health == .healthy)
                Button("停止") { daemon.stopAny() }
                    .disabled(!daemon.isManagedProcessRunning && healthMonitor.health != .healthy)
                Button("重启") { daemon.restartAny() }
            }
            .frame(maxWidth: .infinity)

            Divider()

            // SMAppService 只能注册打包后的 .app；裸 swift build 可执行下隐藏开关。
            if Bundle.main.bundleURL.pathExtension == "app" {
                HStack {
                    Toggle("开机自启", isOn: $launchAtLogin)
                        .toggleStyle(.checkbox)
                        .onChange(of: launchAtLogin) { _, enabled in
                            configureLaunchAtLogin(enabled)
                        }
                    Spacer()
                }

                if let startupError {
                    Text(startupError)
                        .font(.caption)
                        .foregroundStyle(.red)
                }

                Divider()
            }

            Button("退出") {
                NSApp.terminate(nil)
            }
            .keyboardShortcut("q")
            .frame(maxWidth: .infinity)
        }
        .padding(14)
        .frame(width: 240)
        .onAppear {
            launchAtLogin = SMAppService.mainApp.status == .enabled
            qrRefreshKey += 1  // 每次打开面板刷新二维码（token 可能已轮换）
        }
    }

    private var statusColor: Color {
        switch healthMonitor.health {
        case .healthy: return .green
        case .portConflict: return .orange
        case .unknown, .unavailable: return .gray
        }
    }

    private var statusText: String {
        if healthMonitor.health == .portConflict { return "端口 \(settings.port) 冲突" }
        if healthMonitor.health == .healthy { return "运行中" }
        switch daemon.state {
        case .stopped: return "已停止"
        case .starting: return "正在启动"
        case .running: return "运行中"
        case .portConflict: return "端口 \(settings.port) 冲突"
        case .failed(let message): return message
        }
    }

    private func configureLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            startupError = nil
        } catch {
            let actualState = SMAppService.mainApp.status == .enabled
            if launchAtLogin != actualState { launchAtLogin = actualState }
            startupError = "开机自启设置失败：\(error.localizedDescription)"
        }
    }
}

/// 面板 View 每次打开都会重建，一次性引导标记放进程级存储。
@MainActor
private enum Bootstrap {
    static var didStart = false
}

final class TerminationDelegate: NSObject, NSApplicationDelegate {
    weak var manager: DaemonManager?

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        MainActor.assumeIsolated {
            manager?.stopSynchronouslyForTermination()
        }
        return .terminateNow
    }
}
