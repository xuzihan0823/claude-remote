import AppKit
import WebKit

/// 手动管理的二维码窗口：裸 SPM 可执行 + MenuBarExtra 下 SwiftUI Window scene 的
/// openWindow 不可靠（静默无效），直接用 NSWindow + WKWebView 最稳。
@MainActor
final class QRWindowController {
    static let shared = QRWindowController()

    private var window: NSWindow?
    private var webView: WKWebView?

    func show(url: URL) {
        if window == nil {
            let webView = WKWebView(frame: .zero)
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 420, height: 620),
                styleMask: [.titled, .closable, .resizable],
                backing: .buffered,
                defer: false
            )
            window.title = "配对二维码"
            window.contentView = webView
            window.center()
            window.isReleasedWhenClosed = false
            self.window = window
            self.webView = webView
        }
        // 每次打开都重载：daemon 重启后 token 可能已轮换。
        webView?.load(URLRequest(url: url))
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}
