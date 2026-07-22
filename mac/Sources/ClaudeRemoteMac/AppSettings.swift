import Foundation

@MainActor
final class AppSettings: ObservableObject {
    // 根 package.json 的 dev 脚本即 daemon（tsx packages/daemon/src/index.ts）；
    // 勿用 --filter daemon：daemon 包名是 @claude-remote/daemon 且无 dev 脚本。
    static let defaultCommand = "pnpm --dir /Users/mac/Desktop/claude-remote dev"

    private enum Key {
        static let launchCommand = "daemonLaunchCommand"
        static let port = "daemonPort"
        static let claudePath = "claudeExecutablePath"
    }

    @Published var launchCommand: String {
        didSet { defaults.set(launchCommand, forKey: Key.launchCommand) }
    }

    @Published var port: Int {
        didSet {
            port = min(max(port, 1), 65_535)
            defaults.set(port, forKey: Key.port)
        }
    }

    @Published var claudePath: String? {
        didSet { defaults.set(claudePath, forKey: Key.claudePath) }
    }

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        launchCommand = defaults.string(forKey: Key.launchCommand) ?? Self.defaultCommand
        let savedPort = defaults.integer(forKey: Key.port)
        port = savedPort == 0 ? 8788 : savedPort
        claudePath = defaults.string(forKey: Key.claudePath)
    }

    var baseURL: URL {
        URL(string: "http://127.0.0.1:\(port)")!
    }
}
