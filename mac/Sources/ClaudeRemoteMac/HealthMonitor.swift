import Foundation

@MainActor
final class HealthMonitor: ObservableObject {
    enum Health: Equatable {
        case unknown
        case healthy
        case unavailable
        case portConflict
    }

    @Published private(set) var health: Health = .unknown
    private let settings: AppSettings
    private let daemon: DaemonManager
    private var task: Task<Void, Never>?

    init(settings: AppSettings, daemon: DaemonManager) {
        self.settings = settings
        self.daemon = daemon
    }

    func start() {
        task?.cancel()
        task = Task { [weak self] in
            while !Task.isCancelled {
                await self?.check()
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
    }

    /// 立即探测一次并返回结果（app 启动时用于决定是否需要拉起 daemon）。
    @discardableResult
    func checkOnce() async -> Health {
        await check()
        return health
    }

    private func check() async {
        var request = URLRequest(url: settings.baseURL.appendingPathComponent("api/health"))
        request.timeoutInterval = 1.5
        // /api/health 在 daemon 侧受 Bearer 保护；带上 Keychain token。
        if let token = try? KeychainTokenStore.token() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                health = .unavailable
                return
            }
            if (200..<300).contains(http.statusCode),
               let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               payload["ok"] as? Bool == true {
                health = .healthy
                return
            }
            // 401 unauthorized = daemon 活着但 token 不一致（如 .env 手工启动的开发 daemon）。
            // 视为运行中，不再叠加拉起第二个进程撞端口。
            if http.statusCode == 401 {
                health = .healthy
                return
            }
            if daemon.isManagedProcessRunning {
                health = .unavailable
            } else {
                health = .portConflict
                daemon.reportPortConflict()
            }
        } catch {
            NSLog("[HealthMonitor] 请求失败: \(error)")
            health = .unavailable
        }
    }
}
