#if os(macOS)
// SerialModule.swift — ESP32 serial device module
// Ported from bridge/src/modules/serial-module.ts

import Foundation

final class SerialModule: DeviceModule, @unchecked Sendable {
    let name = "serial"
    let serial = ESP32Serial()

    func start() async {
        let devFiles = (try? FileManager.default.contentsOfDirectory(atPath: "/dev")) ?? []
        let hasSerial = devFiles.contains { $0.hasPrefix("cu.usbserial") || $0.hasPrefix("cu.usbmodem") }
        guard hasSerial else {
            DaemonLogger.shared.debug("Serial", "No USB serial devices found, skipping")
            return
        }

        await serial.start()
        DaemonLogger.shared.info("Serial module started")
    }

    func stop() async {
        await serial.stop()
    }

    /// Wire broadcast hook — relay events to ESP32 devices
    func wireBroadcast(_ event: [String: Any]) {
        let box = SendableDict(event)
        Task { await serial.broadcast(box.value) }
    }

    func getConnectionCount() async -> Int {
        await serial.connectionCount
    }
}
#endif
