#if os(macOS)
// AdbModule.swift — Android device ADB reverse tunnel management
// Sets up `adb reverse` for Android dashboard clients (Crema, Lenovo, Pantone).
// D200H Deck Dock is now handled by D200hHidModule via HID protocol.

import Foundation

final class AdbModule: DeviceModule, @unchecked Sendable {
    let name = "adb"

    private let daemonPort: Int
    /// Android apps always connect to the well-known port (9120).
    /// When daemon binds a fallback port, ADB reverse maps 9120→actual port.
    private let androidPort: Int = 9120
    private var pollTask: Task<Void, Never>?
    private var lastKnownDevices: [String] = []
    private var lastError: String?
    private var reverseReadyCount = 0

    nonisolated(unsafe) var commandHandler: (([String: Any]) -> Void)?

    init(daemonPort: Int) {
        self.daemonPort = daemonPort
    }

    func start() async {
        guard adbAvailable() else {
            lastError = "adb not found"
            DaemonLogger.shared.debug("ADB", "adb not found in PATH, skipping")
            return
        }

        setupAdbReverse()

        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                guard let self else { break }
                self.pollAdbReverse()
            }
        }

        DaemonLogger.shared.info("ADB module started (port \(daemonPort))")
    }

    func stop() async {
        pollTask?.cancel()
        cleanupAdbReverse()
    }

    func handleBroadcast(_ event: [String: Any]) {
        // No-op — ADB reverse tunnel doesn't need state broadcasts
    }

    func statusSnapshot() -> [String: Any] {
        [
            "available": adbAvailable(),
            "devices": lastKnownDevices,
            "reverseReadyCount": reverseReadyCount,
            "lastError": lastError as Any,
        ]
    }

    // MARK: - ADB Reverse

    private func setupAdbReverse() {
        let devices = getConnectedDevices()
        lastKnownDevices = devices
        reverseReadyCount = 0
        for serial in devices {
            // Map Android-side well-known port (9120) → actual daemon port.
            // Android apps always connect to localhost:9120.
            if shell(timeout: 5, "adb", "-s", serial, "reverse", "tcp:\(androidPort)", "tcp:\(daemonPort)") != nil {
                reverseReadyCount += 1
                lastError = nil
                DaemonLogger.shared.debug("ADB", "Reverse tunnel set: \(serial) (android:\(androidPort) → daemon:\(daemonPort))")
            } else {
                lastError = "adb reverse failed for \(serial)"
            }
        }
    }

    private func pollAdbReverse() {
        let devices = getConnectedDevices()
        lastKnownDevices = devices
        reverseReadyCount = 0
        for serial in devices {
            if let existing = shell(timeout: 5, "adb", "-s", serial, "reverse", "--list"),
               existing.contains("tcp:\(androidPort)") {
                reverseReadyCount += 1
            } else {
                if shell(timeout: 5, "adb", "-s", serial, "reverse", "tcp:\(androidPort)", "tcp:\(daemonPort)") != nil {
                    reverseReadyCount += 1
                    lastError = nil
                    DaemonLogger.shared.debug("ADB", "Reverse re-established: \(serial)")
                } else {
                    lastError = "adb reverse re-establish failed for \(serial)"
                }
            }
        }
    }

    private func cleanupAdbReverse() {
        let devices = getConnectedDevices()
        for serial in devices {
            _ = shell(timeout: 3, "adb", "-s", serial, "reverse", "--remove", "tcp:\(androidPort)")
        }
    }

    // MARK: - Helpers

    private func getConnectedDevices() -> [String] {
        guard let output = shell(timeout: 5, "adb", "devices") else { return [] }
        return output.components(separatedBy: "\n")
            .dropFirst()
            .filter { $0.contains("\tdevice") }
            .compactMap { $0.split(separator: "\t").first.map(String.init) }
    }

    /// Resolved adb binary path (searched once at startup)
    private lazy var adbPath: String? = Self.findAdb()

    private func adbAvailable() -> Bool {
        adbPath != nil
    }

    /// Search common locations for adb binary (GUI apps have restricted PATH).
    /// Prioritizes bundled adb in Contents/Helpers/ for App Sandbox compatibility.
    private static func findAdb() -> String? {
        // 1. Bundled adb (copied by copy-adb.sh build script) — Sandbox-safe
        let bundledPath = Bundle.main.bundlePath + "/Contents/Helpers/adb"
        if FileManager.default.isExecutableFile(atPath: bundledPath) {
            DaemonLogger.shared.debug("ADB", "Using bundled adb at \(bundledPath)")
            return bundledPath
        }

        // 2. Fallback: external paths (works outside Sandbox / development builds)
        let realHome = getpwuid(getuid()).map { String(cString: $0.pointee.pw_dir) } ?? NSHomeDirectory()
        let candidates = [
            "\(realHome)/Library/Android/sdk/platform-tools/adb",
            "\(realHome)/Android/sdk/platform-tools/adb",
            "\(realHome)/Library/Developer/Android/sdk/platform-tools/adb",
            "/usr/local/bin/adb",
            "/opt/homebrew/bin/adb",
            "/usr/bin/adb",
        ]
        for path in candidates {
            // isExecutableFile may fail in App Sandbox even when file exists — fall back to fileExists
            if FileManager.default.isExecutableFile(atPath: path) || FileManager.default.fileExists(atPath: path) {
                DaemonLogger.shared.debug("ADB", "Found adb at \(path)")
                return path
            }
        }
        DaemonLogger.shared.debug("ADB", "adb not found — checked bundled path and \(candidates.count) external paths")
        // Fallback: try which via shell (works from terminal, not GUI)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [
            "PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:\(realHome)/Library/Android/sdk/platform-tools:\(realHome)/Android/sdk/platform-tools:\(realHome)/Library/Developer/Android/sdk/platform-tools",
            "which", "adb"
        ]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        try? process.run()
        process.waitUntilExit()
        if process.terminationStatus == 0,
           let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !out.isEmpty {
            DaemonLogger.shared.debug("ADB", "Found adb via which: \(out)")
            return out
        }
        return nil
    }

    @discardableResult
    private func shell(timeout: TimeInterval, _ args: String...) -> String? {
        let result = runProcess(timeout: timeout, args)
        guard result.status == 0 else { return nil }
        return String(data: result.stdout, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func runProcess(timeout: TimeInterval, _ args: [String]) -> (status: Int32?, stdout: Data) {
        let realHome = getpwuid(getuid()).map { String(cString: $0.pointee.pw_dir) } ?? NSHomeDirectory()
        let process = Process()
        // Use resolved adb path for adb commands, /usr/bin/env for others
        if let adb = adbPath, args.first == "adb" {
            process.executableURL = URL(fileURLWithPath: adb)
            process.arguments = Array(args.dropFirst())
        } else {
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = args
        }
        var env = ProcessInfo.processInfo.environment
        env["HOME"] = realHome
        env["PATH"] = [
            "\(realHome)/Library/Android/sdk/platform-tools",
            "\(realHome)/Android/sdk/platform-tools",
            "\(realHome)/Library/Developer/Android/sdk/platform-tools",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
        ].joined(separator: ":")
        process.environment = env

        let stdoutPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
        } catch {
            return (nil, Data())
        }

        let group = DispatchGroup()
        group.enter()
        process.terminationHandler = { _ in group.leave() }

        let waitResult = group.wait(timeout: .now() + timeout)
        if waitResult == .timedOut {
            process.terminate()
            _ = group.wait(timeout: .now() + 1)
        }

        let data = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
        return (waitResult == .timedOut ? nil : process.terminationStatus, data)
    }
}
#endif
