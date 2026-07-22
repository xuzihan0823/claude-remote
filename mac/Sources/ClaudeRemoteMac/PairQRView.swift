import CoreImage
import SwiftUI

/// 菜单面板内嵌的二维码：读 loopback-only 的 /api/pair-info，
/// 按契约拼 claude-remote://setup 载荷，CIQRCodeGenerator 本地生成（不依赖 web 资源）。
struct PairQRView: View {
    @ObservedObject var settings: AppSettings
    /// 每次面板打开时递增，触发重新拉取（daemon 重启后 token 可能已轮换）。
    let refreshKey: Int

    @State private var qrImage: NSImage?
    @State private var error: String?

    var body: some View {
        Group {
            if let qrImage {
                Image(nsImage: qrImage)
                    .interpolation(.none)
                    .resizable()
                    .scaledToFit()
                    .frame(width: 180, height: 180)
                    .accessibilityLabel("配对二维码")
            } else if let error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(width: 180, height: 60)
            } else {
                ProgressView()
                    .frame(width: 180, height: 180)
            }
        }
        .task(id: refreshKey) { await load() }
    }

    private func load() async {
        error = nil
        var request = URLRequest(url: settings.baseURL.appendingPathComponent("api/pair-info"))
        request.timeoutInterval = 3
        do {
            let (data, _) = try await URLSession.shared.data(for: request)
            guard let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let token = payload["token"] as? String,
                  let bases = payload["bases"] as? [String], !bases.isEmpty else {
                error = "pair-info 响应异常"
                return
            }
            // 契约：每个 URL 单独 percent-encode，逗号不编码（docs/mac-app-plan.md §4）。
            let enc = { (s: String) -> String in
                s.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? s
            }
            let text = "claude-remote://setup?v=1&token=\(enc(token))&bases=\(bases.map(enc).joined(separator: ","))"
            qrImage = Self.makeQR(text)
            if qrImage == nil { error = "二维码生成失败" }
        } catch {
            self.error = "无法读取配对信息（daemon 未运行？）"
        }
    }

    private static func makeQR(_ text: String) -> NSImage? {
        guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        filter.setValue(Data(text.utf8), forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 8, y: 8))
        guard let cg = CIContext().createCGImage(scaled, from: scaled.extent) else { return nil }
        return NSImage(cgImage: cg, size: NSSize(width: scaled.extent.width, height: scaled.extent.height))
    }
}
