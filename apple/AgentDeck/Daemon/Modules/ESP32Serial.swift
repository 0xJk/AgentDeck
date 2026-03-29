#if os(macOS)
// ESP32Serial.swift — USB serial communication with ESP32 devices
// Ported from bridge/src/esp32-serial.ts

import Foundation

/// Manages USB serial connections to ESP32 devices (CH340/CP210x/native USB).
/// Newline-delimited JSON protocol, heartbeat, WiFi provisioning.
actor ESP32Serial {
    // Port detection patterns
    private static let portPatterns: [NSRegularExpression] = {
        ["/dev/cu\\.usbserial-\\d+", "/dev/cu\\.usbmodem\\d+"].compactMap {
            try? NSRegularExpression(pattern: $0)
        }
    }()
    private static let excludePatterns = ["Bluetooth", "WLAN"]

    struct SerialConnection: Identifiable {
        let id = UUID()
        let port: String
        var writeHandle: FileHandle?
        var readHandle: FileHandle?
        var connected = true
        var readBuffer = ""
        var deviceInfo: DeviceInfo?
        var provisionSent = false
    }

    struct DeviceInfo {
        var board: String?
        var version: String?
        var wifiConfigured: Bool?
        var wifiConnected: Bool?
    }

    private var connections: [SerialConnection] = []
    private var pollTask: Task<Void, Never>?
    private var heartbeatTask: Task<Void, Never>?

    private var stateProvider: (() -> [String: Any]?)?
    private var usageProvider: (() -> [String: Any]?)?
    private var initialStateProvider: (() -> [[String: Any]])?
    var onMessage: (@Sendable (String, [String: Any]) -> Void)?

    var connectionCount: Int { connections.filter(\.connected).count }

    func setStateProviderFn(_ provider: @escaping () -> [String: Any]?) { stateProvider = provider }
    func setUsageProviderFn(_ provider: @escaping () -> [String: Any]?) { usageProvider = provider }
    func setInitialStateProviderFn(_ provider: @escaping () -> [[String: Any]]) { initialStateProvider = provider }
    func setOnMessage(_ handler: @escaping @Sendable (String, [String: Any]) -> Void) { onMessage = handler }

    // MARK: - Lifecycle

    func start() {
        pollTask = Task { [weak self] in
            await self?.pollForDevices()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                await self?.pollForDevices()
            }
        }

        heartbeatTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                await self?.sendHeartbeat()
            }
        }

        DaemonLogger.shared.debug("ESP32", "Serial bridge started")
    }

    func stop() {
        pollTask?.cancel()
        heartbeatTask?.cancel()
        for var conn in connections {
            conn.connected = false
            try? conn.writeHandle?.close()
            try? conn.readHandle?.close()
        }
        connections.removeAll()
        DaemonLogger.shared.debug("ESP32", "Serial bridge stopped")
    }

    // MARK: - Broadcast

    /// Forward events matching SERIAL_FORWARDED_EVENTS to all connected ESP32
    func broadcast(_ event: [String: Any]) {
        guard !connections.isEmpty else { return }
        guard let type = event["type"] as? String,
              Self.serialForwardedEvents.contains(type) else { return }

        let prepared = prepareForSerial(event)
        guard let data = try? JSONSerialization.data(withJSONObject: prepared),
              let json = String(data: data, encoding: .utf8) else { return }

        for i in connections.indices where connections[i].connected {
            sendToConnection(&connections[i], json: json)
        }
    }

    func sendWifiProvisionToAll(_ msg: [String: Any]) -> Int {
        guard let data = try? JSONSerialization.data(withJSONObject: msg),
              let json = String(data: data, encoding: .utf8) else { return 0 }
        var count = 0
        for i in connections.indices {
            guard connections[i].connected, !connections[i].provisionSent else { continue }
            if connections[i].deviceInfo?.wifiConnected == true { continue }
            sendToConnection(&connections[i], json: json)
            connections[i].provisionSent = true
            count += 1
        }
        return count
    }

    // MARK: - Port Detection

    private func detectPorts() -> [String] {
        do {
            let output = try shellSync("ls /dev/cu.usb* 2>/dev/null || true")
            return output.split(separator: "\n").map(String.init).filter { port in
                guard !Self.excludePatterns.contains(where: { port.localizedCaseInsensitiveContains($0) }) else { return false }
                let range = NSRange(port.startIndex..., in: port)
                return Self.portPatterns.contains { $0.firstMatch(in: port, range: range) != nil }
            }
        } catch {
            return []
        }
    }

    private func pollForDevices() {
        // Prune disconnected
        connections.removeAll { !$0.connected }

        let ports = detectPorts()
        for port in ports {
            if !connections.contains(where: { $0.port == port }) {
                if let conn = openPort(port) {
                    connections.append(conn)
                }
            }
        }
    }

    // MARK: - Port Open

    private func openPort(_ port: String) -> SerialConnection? {
        guard let writeHandle = FileHandle(forWritingAtPath: port) else {
            DaemonLogger.shared.debug("ESP32", "Failed to open write: \(port)")
            return nil
        }

        let readHandle = FileHandle(forReadingAtPath: port)

        var conn = SerialConnection(port: port, writeHandle: writeHandle, readHandle: readHandle)

        // Configure baud rate for UART ports (not CDC)
        let isCDC = port.contains("usbmodem")
        if !isCDC {
            _ = try? shellSync("stty -f \(port) 115200 cs8 -cstopb -parenb -hupcl")
        }

        DaemonLogger.shared.debug("ESP32", "Opened: \(port) [\(isCDC ? "CDC" : "UART")]")

        // Request device info
        sendToConnection(&conn, json: #"{"type":"device_info_request"}"#)

        // Send initial state
        if let events = initialStateProvider?() {
            for event in events {
                guard let type = event["type"] as? String,
                      Self.serialForwardedEvents.contains(type) else { continue }
                let prepared = prepareForSerial(event)
                if let data = try? JSONSerialization.data(withJSONObject: prepared),
                   let json = String(data: data, encoding: .utf8) {
                    sendToConnection(&conn, json: json)
                }
            }
        }

        // Start reading in background
        if let readHandle {
            startReading(port: port, handle: readHandle)
        }

        return conn
    }

    private func startReading(port: String, handle: FileHandle) {
        handle.readabilityHandler = { [weak self] fh in
            let data = fh.availableData
            guard !data.isEmpty, let str = String(data: data, encoding: .utf8) else { return }
            Task { await self?.handleReadData(port: port, data: str) }
        }
    }

    private func handleReadData(port: String, data: String) {
        guard let idx = connections.firstIndex(where: { $0.port == port }) else { return }
        connections[idx].readBuffer += data

        while let newlineIdx = connections[idx].readBuffer.firstIndex(of: "\n") {
            let line = String(connections[idx].readBuffer[..<newlineIdx]).trimmingCharacters(in: .whitespaces)
            connections[idx].readBuffer = String(connections[idx].readBuffer[connections[idx].readBuffer.index(after: newlineIdx)...])

            guard line.hasPrefix("{") else { continue }
            guard let jsonData = line.data(using: .utf8),
                  let msg = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
                  let type = msg["type"] as? String else { continue }

            DaemonLogger.shared.debug("ESP32", "← \(port): \(type)")

            if type == "device_info" {
                connections[idx].deviceInfo = DeviceInfo(
                    board: msg["board"] as? String,
                    version: msg["version"] as? String,
                    wifiConfigured: msg["wifiConfigured"] as? Bool,
                    wifiConnected: msg["wifiConnected"] as? Bool
                )
            }

            onMessage?(port, msg)
        }

        // Prevent buffer bloat
        if connections[idx].readBuffer.count > 8192 {
            connections[idx].readBuffer = ""
        }
    }

    // MARK: - Heartbeat

    private func sendHeartbeat() {
        guard !connections.isEmpty else { return }

        if let event = stateProvider?() {
            let prepared = prepareForSerial(event)
            if let data = try? JSONSerialization.data(withJSONObject: prepared),
               let json = String(data: data, encoding: .utf8) {
                for i in connections.indices where connections[i].connected {
                    sendToConnection(&connections[i], json: json)
                }
            }
        }

        if let event = usageProvider?(),
           event["fiveHourPercent"] != nil {
            let prepared = prepareForSerial(event)
            if let data = try? JSONSerialization.data(withJSONObject: prepared),
               let json = String(data: data, encoding: .utf8) {
                for i in connections.indices where connections[i].connected {
                    sendToConnection(&connections[i], json: json)
                }
            }
        }
    }

    // MARK: - Serial Helpers

    private func sendToConnection(_ conn: inout SerialConnection, json: String) {
        guard conn.connected, let handle = conn.writeHandle else { return }
        do {
            try handle.write(contentsOf: Data((json + "\n").utf8))
        } catch {
            conn.connected = false
        }
    }

    /// Strip fields ESP32 doesn't need (reduce payload for small RX buffers)
    private func prepareForSerial(_ event: [String: Any]) -> [String: Any] {
        var e = event
        if event["type"] as? String == "usage_update" {
            e.removeValue(forKey: "ollamaStatus")
            e.removeValue(forKey: "tokenStatus")
            e.removeValue(forKey: "extraUsageEnabled")
            e.removeValue(forKey: "extraUsageMonthlyLimit")
            e.removeValue(forKey: "extraUsageUsedCredits")
            e.removeValue(forKey: "extraUsageUtilization")
            e.removeValue(forKey: "costSpent")
            e.removeValue(forKey: "costLimit")
            e.removeValue(forKey: "sessionPercent")
            e.removeValue(forKey: "resetTime")
            e.removeValue(forKey: "resetDate")
        }
        if event["type"] as? String == "state_update" {
            e.removeValue(forKey: "agentCapabilities")
            e.removeValue(forKey: "billingType")
            e.removeValue(forKey: "remoteUrl")
        }
        return e
    }

    private func shellSync(_ command: String) throws -> String {
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

    // MARK: - Constants

    static let serialForwardedEvents: Set<String> = [
        "state_update", "usage_update", "sessions_list",
        "connection", "display_state",
        "timeline_event", "timeline_history"
    ]
}
#endif
