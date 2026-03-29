#if os(macOS)
// WifiConfig.swift — WiFi credential management for ESP32 auto-provisioning
// Ported from bridge/src/wifi-config.ts

import Foundation

struct WifiConfig: Codable {
    let ssid: String
    let password: String
    var autoProvision: Bool = true
}

enum WifiConfigManager {
    private static let configFile = AuthManager.agentDeckDir.appendingPathComponent("wifi-config.json")

    static func load() -> WifiConfig? {
        guard let data = try? Data(contentsOf: configFile),
              let config = try? JSONDecoder().decode(WifiConfig.self, from: data),
              !config.ssid.isEmpty, !config.password.isEmpty else { return nil }
        return config
    }

    static func save(_ config: WifiConfig) throws {
        try FileManager.default.createDirectory(at: AuthManager.agentDeckDir, withIntermediateDirectories: true)
        let data = try JSONEncoder.pretty.encode(config)
        try data.write(to: configFile)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: configFile.path)
    }

    /// Detect current macOS WiFi SSID
    static func detectCurrentSSID() -> String? {
        guard let output = try? shellSync("networksetup -listallhardwareports") else { return nil }
        let ifaceMatch = output.range(of: #"Hardware Port: Wi-Fi\nDevice: (en\d+)"#, options: .regularExpression)
        let iface: String
        if let match = ifaceMatch {
            let deviceLine = output[match].components(separatedBy: "\n").last ?? "en0"
            iface = deviceLine.trimmingCharacters(in: .whitespaces).components(separatedBy: " ").last ?? "en0"
        } else {
            iface = "en0"
        }

        guard let ssidOutput = try? shellSync("networksetup -getairportnetwork \(iface)") else { return nil }
        if let range = ssidOutput.range(of: "Current Wi-Fi Network: ") {
            return String(ssidOutput[range.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return nil
    }

    /// Retrieve WiFi password from macOS Keychain
    static func getKeychainPassword(ssid: String) -> String? {
        let escaped = ssid.replacingOccurrences(of: "\"", with: "\\\"")
        guard let output = try? shellSync("security find-generic-password -ga \"\(escaped)\" -w 2>/dev/null") else { return nil }
        let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func shellSync(_ command: String) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", command]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
        return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    }
}
#endif
