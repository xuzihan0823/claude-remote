import Foundation
import Security

enum KeychainTokenStore {
    private static let service = "claude-remote"
    private static let account = "bridge-token"

    static func token() throws -> String {
        if let existing = try read() {
            return existing
        }

        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw TokenError.randomGenerationFailed
        }
        let token = bytes.map { String(format: "%02x", $0) }.joined()
        try save(token)
        return token
    }

    private static func read() throws -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data,
              let token = String(data: data, encoding: .utf8) else {
            throw TokenError.keychain(status)
        }
        return token
    }

    private static func save(_ token: String) throws {
        let attributes: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: Data(token.utf8),
        ]
        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else { throw TokenError.keychain(status) }
    }

    enum TokenError: LocalizedError {
        case randomGenerationFailed
        case keychain(OSStatus)

        var errorDescription: String? {
            switch self {
            case .randomGenerationFailed: return "无法生成桥接 token。"
            case .keychain(let status): return "钥匙串错误：\(status)。"
            }
        }
    }
}
