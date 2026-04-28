#if os(macOS)
// WifiConfig.swift — WiFi credential management for ESP32 auto-provisioning.
//
// Persists user-supplied SSID/password for ESP32 firmware to consume during
// the first-boot handshake. Auto-detection of the current SSID and Keychain
// password lookup both required `networksetup` / `security` subprocesses,
// which are not allowed under Apple Review Guideline 2.5.2 — the
// ESP32ProvisionSheet asks the user to type both fields directly.

import Foundation

struct WifiConfig: Codable {
    let ssid: String
    let password: String
    var autoProvision: Bool = true
}

private final class WifiConfigDataBox: @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data?

    func set(_ data: Data?) {
        lock.lock()
        self.data = data
        lock.unlock()
    }

    func get() -> Data? {
        lock.lock()
        defer { lock.unlock() }
        return data
    }
}

enum WifiConfigManager {
    private static let configFile = AuthManager.agentDeckDir.appendingPathComponent("wifi-config.json")
    // .userInteractive: DaemonServer.startDeviceModules calls load() from the
    // main actor and sync-waits via DispatchSemaphore. .userInitiated still
    // leaves a one-step inversion (User-interactive → User-initiated) that TPC
    // flags. The work is a single Data(contentsOf:) bounded by a 700 ms cap,
    // so the elevated QoS is justified for the main-actor critical path.
    private static let readQueue = DispatchQueue(label: "dev.agentdeck.wifi-config.read", qos: .userInteractive)
    private static let readTimeout: DispatchTimeInterval = .milliseconds(700)

    static func load() -> WifiConfig? {
        let box = WifiConfigDataBox()
        let semaphore = DispatchSemaphore(value: 0)
        readQueue.async {
            box.set(try? Data(contentsOf: configFile))
            semaphore.signal()
        }
        guard semaphore.wait(timeout: .now() + readTimeout) == .success else {
            DaemonLogger.shared.debug("WifiConfig", "Read timed out; treating as unconfigured")
            return nil
        }

        guard let data = box.get(),
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

    /// SSID auto-detection is unavailable in the App Store build; the
    /// provisioning sheet prompts the user for the SSID.
    static func detectCurrentSSID() -> String? { nil }

    /// Keychain password lookup is unavailable in the App Store build; the
    /// provisioning sheet prompts the user for the password.
    static func getKeychainPassword(ssid: String) -> String? {
        _ = ssid
        return nil
    }
}
#endif
