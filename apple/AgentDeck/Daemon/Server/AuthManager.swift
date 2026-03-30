#if os(macOS)
// AuthManager.swift — Token generation, validation, local connection detection
// Ported from bridge/src/auth.ts

import Foundation
import Security

final class AuthManager: Sendable {
    static let shared = AuthManager()

    static let agentDeckDir: URL = {
        // getpwuid returns the real home directory even inside the App Sandbox
        if let pw = getpwuid(getuid()), let dir = pw.pointee.pw_dir {
            return URL(fileURLWithPath: String(cString: dir))
                .appendingPathComponent(".agentdeck")
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".agentdeck")
    }()
    static let tokenFile = agentDeckDir.appendingPathComponent("auth-token")
    private static let tokenLength = 32 // 32 hex chars = 16 bytes

    private let cachedToken: String

    private init() {
        self.cachedToken = AuthManager.loadOrCreateToken()
    }

    var token: String { cachedToken }

    // MARK: - Token Management

    private static func loadOrCreateToken() -> String {
        // Try reading existing token
        if let data = try? Data(contentsOf: tokenFile),
           let existing = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
           existing.count >= tokenLength {
            return existing
        }

        // Generate new token
        var bytes = [UInt8](repeating: 0, count: tokenLength / 2)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let token = bytes.map { String(format: "%02x", $0) }.joined()

        // Write to file
        do {
            try FileManager.default.createDirectory(at: agentDeckDir, withIntermediateDirectories: true)
            try (token + "\n").write(to: tokenFile, atomically: true, encoding: .utf8)
            // Set file permissions to 0600
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o600],
                ofItemAtPath: tokenFile.path
            )
            DaemonLogger.shared.debug("auth", "Generated new auth token")
        } catch {
            DaemonLogger.shared.error("Failed to write token file: \(error)")
        }

        return token
    }

    // MARK: - Validation

    func validateToken(_ candidate: String) -> Bool {
        let stored = cachedToken
        guard candidate.count == stored.count else { return false }
        // Constant-time comparison
        var result: UInt8 = 0
        for (a, b) in zip(candidate.utf8, stored.utf8) {
            result |= a ^ b
        }
        return result == 0
    }

    // MARK: - Local Connection Detection

    func isLocalConnection(_ ip: String) -> Bool {
        if ip == "127.0.0.1" || ip == "::1" || ip == "::ffff:127.0.0.1" { return true }

        // Check against this machine's network interfaces
        let localIPs = Self.getLocalIPAddresses()
        return localIPs.contains(ip) || localIPs.contains(where: { "::ffff:\($0)" == ip })
    }

    // MARK: - Network Helpers

    static func getLanIP() -> String? {
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let firstAddr = ifaddr else { return nil }
        defer { freeifaddrs(ifaddr) }

        for ptr in sequence(first: firstAddr, next: { $0.pointee.ifa_next }) {
            let flags = Int32(ptr.pointee.ifa_flags)
            guard (flags & IFF_UP) != 0, (flags & IFF_LOOPBACK) == 0 else { continue }
            let addr = ptr.pointee.ifa_addr.pointee
            guard addr.sa_family == UInt8(AF_INET) else { continue }

            var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(ptr.pointee.ifa_addr, socklen_t(addr.sa_len),
                           &hostname, socklen_t(hostname.count), nil, 0, NI_NUMERICHOST) == 0 {
                let ip = String(cString: hostname)
                if !ip.hasPrefix("169.254.") { return ip } // Skip link-local
            }
        }
        return nil
    }

    private static func getLocalIPAddresses() -> Set<String> {
        var result = Set<String>()
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let firstAddr = ifaddr else { return result }
        defer { freeifaddrs(ifaddr) }

        for ptr in sequence(first: firstAddr, next: { $0.pointee.ifa_next }) {
            let addr = ptr.pointee.ifa_addr.pointee
            guard addr.sa_family == UInt8(AF_INET) || addr.sa_family == UInt8(AF_INET6) else { continue }
            var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(ptr.pointee.ifa_addr, socklen_t(addr.sa_len),
                           &hostname, socklen_t(hostname.count), nil, 0, NI_NUMERICHOST) == 0 {
                result.insert(String(cString: hostname))
            }
        }
        return result
    }

    func getWsUrl(port: Int) -> String {
        let ip = Self.getLanIP() ?? "127.0.0.1"
        return "ws://\(ip):\(port)?token=\(cachedToken)"
    }
}
#endif
