#if os(macOS)
// AdbModule.swift — Android device ADB reverse tunnel management
// Sets up `adb reverse` for Android dashboard clients (Crema, Lenovo, Pantone).
// D200H Deck Dock is now handled by D200hHidModule via HID protocol.

import Foundation

final class AdbModule: DeviceModule, @unchecked Sendable {
    let name = "adb"

    private let daemonPort: Int
    private var pollTask: Task<Void, Never>?

    nonisolated(unsafe) var commandHandler: (([String: Any]) -> Void)?

    init(daemonPort: Int) {
        self.daemonPort = daemonPort
    }

    func start() async {
        guard adbAvailable() else {
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

    // MARK: - ADB Reverse

    private func setupAdbReverse() {
        let devices = getConnectedDevices()
        for serial in devices {
            _ = shell(timeout: 5, "adb", "-s", serial, "reverse", "tcp:\(daemonPort)", "tcp:\(daemonPort)")
            DaemonLogger.shared.debug("ADB", "Reverse tunnel set: \(serial)")
        }
    }

    private func pollAdbReverse() {
        let devices = getConnectedDevices()
        for serial in devices {
            if let existing = shell(timeout: 5, "adb", "-s", serial, "reverse", "--list"),
               !existing.contains("tcp:\(daemonPort)") {
                _ = shell(timeout: 5, "adb", "-s", serial, "reverse", "tcp:\(daemonPort)", "tcp:\(daemonPort)")
                DaemonLogger.shared.debug("ADB", "Reverse re-established: \(serial)")
            }
        }
    }

    private func cleanupAdbReverse() {
        let devices = getConnectedDevices()
        for serial in devices {
            _ = shell(timeout: 3, "adb", "-s", serial, "reverse", "--remove", "tcp:\(daemonPort)")
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

    private func adbAvailable() -> Bool {
        shell(timeout: 2, "which", "adb") != nil
    }

    @discardableResult
    private func shell(timeout: TimeInterval, _ args: String...) -> String? {
        let result = runProcess(timeout: timeout, args)
        guard result.status == 0 else { return nil }
        return String(data: result.stdout, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func runProcess(timeout: TimeInterval, _ args: [String]) -> (status: Int32?, stdout: Data) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = args

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
