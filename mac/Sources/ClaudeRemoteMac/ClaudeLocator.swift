import AppKit
import Foundation

@MainActor
final class ClaudeLocator: ObservableObject {
    @Published private(set) var path: String?

    private let settings: AppSettings
    private let fileManager = FileManager.default

    init(settings: AppSettings) {
        self.settings = settings
        path = locate()
    }

    func locate() -> String? {
        if let saved = settings.claudePath, isExecutable(saved) {
            path = saved
            return saved
        }

        let home = fileManager.homeDirectoryForCurrentUser.path
        let candidates = [
            "\(home)/.local/bin/claude",
            "/opt/homebrew/bin/claude",
            "/usr/local/bin/claude",
        ]
        let found = candidates.first(where: isExecutable)
        path = found
        if let found { settings.claudePath = found }
        return found
    }

    func chooseManually() {
        let panel = NSOpenPanel()
        panel.title = "选择 claude 可执行文件"
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let selected = panel.url?.path {
            guard isExecutable(selected) else {
                showAlert("所选文件不可执行。")
                return
            }
            settings.claudePath = selected
            path = selected
        }
    }

    private func isExecutable(_ path: String) -> Bool {
        fileManager.isExecutableFile(atPath: path)
    }

    private func showAlert(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "无法使用 claude"
        alert.informativeText = message
        alert.runModal()
    }
}
