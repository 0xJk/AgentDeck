#if os(macOS)
// AdbModule.swift — Android device ADB reverse tunnel management
// Sets up `adb reverse` for Android dashboard clients (Crema, Lenovo, Pantone).
// D200H Deck Dock is now handled by D200hHidModule via HID protocol.

import Foundation

struct ClassifiedAdbDevice: Sendable, Hashable {
    let serial: String
    let manufacturer: String?
    let model: String?
    let deviceClass: AdbDeviceClass
}

final class AdbModule: DeviceModule, @unchecked Sendable {
    let name = "adb"

    private let daemonPort: Int
    /// Android apps always connect to the well-known port (9120).
    /// When daemon binds a fallback port, ADB reverse maps 9120→actual port.
    private let androidPort: Int = 9120
    private var pollTask: Task<Void, Never>?
    private var lastKnownDevices: [ClassifiedAdbDevice] = []
    private var lastError: String?
    private var reverseReadyCount = 0

    nonisolated(unsafe) var commandHandler: (([String: Any]) -> Void)?

    init(daemonPort: Int) {
        self.daemonPort = daemonPort
    }

    func start() async {
        #if AGENTDECK_APP_STORE
        lastError = "ADB disabled in App Store build"
        DaemonLogger.shared.debug("ADB", "disabled in App Store build")
        return
        #else
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
        #endif
    }

    func stop() async {
        pollTask?.cancel()
        cleanupAdbReverse()
    }

    func handleBroadcast(_ event: [String: Any]) {
        // No-op — ADB reverse tunnel doesn't need state broadcasts
    }

    func statusSnapshot() -> [String: Any] {
        #if AGENTDECK_APP_STORE
        return [
            "available": false,
            "disabled": true,
            "devices": [] as [String],
            "classifiedDevices": [] as [[String: Any]],
            "reverseReadyCount": 0,
        ]
        #else
        let classified = lastKnownDevices.map { dev -> [String: Any] in
            [
                "serial": dev.serial,
                "manufacturer": dev.manufacturer as Any,
                "model": dev.model as Any,
                "class": dev.deviceClass.rawValue,
            ]
        }
        return [
            "available": adbAvailable(),
            // Backcompat: `devices` stays a plain [String] so older
            // consumers (Kotlin sibling client, any cached dashboard) keep
            // working. Rich classification is on `classifiedDevices`.
            "devices": lastKnownDevices.map(\.serial),
            "classifiedDevices": classified,
            "reverseReadyCount": reverseReadyCount,
            "lastError": lastError as Any,
        ]
        #endif
    }

    /// Classify a device by (manufacturer, model) strings. Case-insensitive.
    /// See `AdbDeviceClass` for taxonomy rationale.
    static func classifyDevice(
        manufacturer: String?,
        model: String?
    ) -> AdbDeviceClass {
        let m = (manufacturer ?? "").lowercased()
        let p = (model ?? "").lowercased()
        // TC001 comes back as model "TC001" on most firmware; some builds
        // also advertise manufacturer "ulanzi" — check both.
        if m.contains("ulanzi") || p.contains("tc001") { return .ulanziTc001 }
        if m.contains("ridi") { return .eInkCrema }
        if m.contains("onyx") { return .eInkPantone }
        if m.contains("rakuten") || m.contains("kobo") { return .eInkKobo }
        return .androidTablet
    }

    // MARK: - ADB Reverse

    private func setupAdbReverse() {
        lastKnownDevices = classifyConnectedDevices()
        reverseReadyCount = 0
        for dev in lastKnownDevices {
            // Map Android-side well-known port (9120) → actual daemon port.
            // Android apps always connect to localhost:9120.
            if shell(timeout: 5, "adb", "-s", dev.serial, "reverse", "tcp:\(androidPort)", "tcp:\(daemonPort)") != nil {
                reverseReadyCount += 1
                lastError = nil
                DaemonLogger.shared.debug("ADB", "Reverse tunnel set: \(dev.serial) [\(dev.deviceClass.rawValue)] (android:\(androidPort) → daemon:\(daemonPort))")
            } else {
                lastError = "adb reverse failed for \(dev.serial)"
            }
        }
    }

    private func pollAdbReverse() {
        lastKnownDevices = classifyConnectedDevices()
        reverseReadyCount = 0
        for dev in lastKnownDevices {
            if let existing = shell(timeout: 5, "adb", "-s", dev.serial, "reverse", "--list"),
               existing.contains("tcp:\(androidPort)") {
                reverseReadyCount += 1
            } else {
                if shell(timeout: 5, "adb", "-s", dev.serial, "reverse", "tcp:\(androidPort)", "tcp:\(daemonPort)") != nil {
                    reverseReadyCount += 1
                    lastError = nil
                    DaemonLogger.shared.debug("ADB", "Reverse re-established: \(dev.serial)")
                } else {
                    lastError = "adb reverse re-establish failed for \(dev.serial)"
                }
            }
        }
    }

    private func cleanupAdbReverse() {
        for dev in classifyConnectedDevices() {
            _ = shell(timeout: 3, "adb", "-s", dev.serial, "reverse", "--remove", "tcp:\(androidPort)")
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

    /// Probe each connected device's `ro.product.manufacturer` +
    /// `ro.product.model` via `adb shell getprop` and classify into
    /// `AdbDeviceClass`. Adds a small per-device cost (~50-100ms × N)
    /// which happens once on setup + every 30s on poll — negligible
    /// compared to the existing `adb reverse --list` poll.
    private func classifyConnectedDevices() -> [ClassifiedAdbDevice] {
        let serials = getConnectedDevices()
        return serials.map { serial in
            let manufacturer = shell(
                timeout: 3, "adb", "-s", serial,
                "shell", "getprop", "ro.product.manufacturer"
            )
            let model = shell(
                timeout: 3, "adb", "-s", serial,
                "shell", "getprop", "ro.product.model"
            )
            return ClassifiedAdbDevice(
                serial: serial,
                manufacturer: manufacturer,
                model: model,
                deviceClass: Self.classifyDevice(manufacturer: manufacturer, model: model)
            )
        }
    }

    /// Resolved adb binary path (searched once at startup)
    private lazy var adbPath: String? = Self.findAdb()

    private func adbAvailable() -> Bool {
        adbPath != nil
    }

    /// Search common locations for adb binary (GUI apps have restricted PATH).
    /// Prioritizes bundled adb in Contents/Helpers/ for App Sandbox compatibility.
    private static func findAdb() -> String? {
        #if AGENTDECK_APP_STORE
        // App Store builds do not discover or execute external adb binaries.
        // Android reverse tunneling is a CLI/Homebrew feature.
        return nil
        #else
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
        #endif
    }

    @discardableResult
    private func shell(timeout: TimeInterval, _ args: String...) -> String? {
        let result = runProcess(timeout: timeout, args)
        guard result.status == 0 else { return nil }
        return String(data: result.stdout, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func runProcess(timeout: TimeInterval, _ args: [String]) -> (status: Int32?, stdout: Data) {
        #if AGENTDECK_APP_STORE
        // App Store build: `adb` is an external binary unavailable in the
        // sandbox, and spawning it would violate Apple 2.5.2 even if it were
        // present. All Android integration callers must check `adbPath`
        // before invoking this and gracefully treat nil as "feature disabled".
        _ = timeout; _ = args
        return (status: nil, stdout: Data())
        #else
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
        #endif
    }
}
#endif
