#if os(macOS)
// AdbModule.swift — Android device ADB reverse + D200H Deck Dock support
// Ported from bridge/src/modules/adb-module.ts + bridge/src/adb-reverse.ts

import Foundation

final class AdbModule: DeviceModule, @unchecked Sendable {
    let name = "adb"
    private let daemonPort: Int
    private var pollTask: Task<Void, Never>?
    private var d200hPollTask: Task<Void, Never>?

    // D200H state
    private var d200hDetected = false
    nonisolated(unsafe) var stateProvider: (() -> [String: Any]?)?
    nonisolated(unsafe) var usageProvider: (() -> [String: Any]?)?

    init(daemonPort: Int) {
        self.daemonPort = daemonPort
    }

    func start() async {
        guard adbAvailable() else {
            DaemonLogger.shared.debug("ADB", "adb not found in PATH, skipping")
            return
        }

        // Initial reverse setup
        setupAdbReverse()

        // Poll every 30s for USB reconnections + reverse tunnel check
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                guard let self else { break }
                self.pollAdbReverse()
            }
        }

        // D200H fast polling (0.5s) — catch the 4-second ADB window
        d200hPollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(500))
                guard let self else { break }
                self.checkD200H()
            }
        }

        DaemonLogger.shared.info("ADB module started (port \(daemonPort))")
    }

    func stop() async {
        pollTask?.cancel()
        d200hPollTask?.cancel()
        cleanupAdbReverse()
    }

    // MARK: - ADB Reverse

    private func setupAdbReverse() {
        let devices = getConnectedDevices()
        for serial in devices {
            _ = shell("adb", "-s", serial, "reverse", "tcp:\(daemonPort)", "tcp:\(daemonPort)")
            DaemonLogger.shared.debug("ADB", "Reverse tunnel set: \(serial)")
        }
    }

    private func pollAdbReverse() {
        let devices = getConnectedDevices()
        for serial in devices {
            if let existing = shell("adb", "-s", serial, "reverse", "--list"),
               !existing.contains("tcp:\(daemonPort)") {
                _ = shell("adb", "-s", serial, "reverse", "tcp:\(daemonPort)", "tcp:\(daemonPort)")
                DaemonLogger.shared.debug("ADB", "Reverse re-established: \(serial)")
            }
        }
    }

    private func cleanupAdbReverse() {
        let devices = getConnectedDevices()
        for serial in devices {
            _ = shell("adb", "-s", serial, "reverse", "--remove", "tcp:\(daemonPort)")
        }
    }

    // MARK: - D200H Detection

    /// D200H Deck Dock has a 4-second ADB window after USB connection.
    /// Fast polling at 0.5s catches this window for initial state push.
    private func checkD200H() {
        let devices = getConnectedDevices()
        for serial in devices {
            if let model = shell("adb", "-s", serial, "shell", "getprop", "ro.product.model"),
               model.trimmingCharacters(in: .whitespacesAndNewlines).contains("D200H") {
                if !d200hDetected {
                    d200hDetected = true
                    DaemonLogger.shared.info("D200H Deck Dock detected: \(serial)")
                    pushStateToD200H(serial: serial)
                }
                return
            }
        }
        if d200hDetected {
            d200hDetected = false
            DaemonLogger.shared.debug("ADB", "D200H disconnected")
        }
    }

    /// Push current state + usage to D200H via adb
    private func pushStateToD200H(serial: String) {
        if let state = stateProvider?(),
           let data = try? JSONSerialization.data(withJSONObject: state),
           let json = String(data: data, encoding: .utf8) {
            _ = shell("adb", "-s", serial, "shell", "input", "text", json)
        }
    }

    // MARK: - Helpers

    private func getConnectedDevices() -> [String] {
        guard let output = shell("adb", "devices") else { return [] }
        return output.components(separatedBy: "\n")
            .dropFirst()
            .filter { $0.contains("\tdevice") }
            .compactMap { $0.split(separator: "\t").first.map(String.init) }
    }

    private func adbAvailable() -> Bool {
        shell("which", "adb") != nil
    }

    @discardableResult
    private func shell(_ args: String...) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = args
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { return nil }
            return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            return nil
        }
    }
}
#endif
