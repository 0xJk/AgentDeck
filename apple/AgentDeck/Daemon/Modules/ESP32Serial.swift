#if os(macOS)
// ESP32Serial.swift — USB serial communication with ESP32 devices
// Ported from bridge/src/esp32-serial.ts

import Foundation
import Darwin

/// Manages USB serial connections to ESP32 devices (CH340/CP210x/native USB).
/// Newline-delimited JSON protocol, heartbeat, WiFi provisioning.
actor ESP32Serial {
    // Port detection patterns
    private static let portPatterns: [NSRegularExpression] = {
        ["/dev/cu\\.usbserial-\\d+", "/dev/cu\\.wchusbserial\\d+", "/dev/cu\\.usbmodem\\d+"].compactMap {
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

    private struct PortFailure {
        let error: String
        let isPermanent: Bool  // true for EACCES (Operation not permitted)
        var failCount: Int
        var lastAttempt: Date
    }

    private var connections: [SerialConnection] = []
    private var pollTask: Task<Void, Never>?
    private var heartbeatTask: Task<Void, Never>?
    private var lastDetectedPorts: [String] = []
    private var lastOpenError: String?
    private var lastReadError: String?
    private var lastWriteError: String?
    private var failedPorts: [String: PortFailure] = [:]
    private static let permanentBlockDuration: TimeInterval = 300  // 5 minutes
    private static let transientMaxBackoff: TimeInterval = 60

    nonisolated(unsafe) private var stateProvider: (() -> [String: Any]?)?
    nonisolated(unsafe) private var usageProvider: (() -> [String: Any]?)?
    nonisolated(unsafe) private var initialStateProvider: (() -> [[String: Any]])?
    var onMessage: (@Sendable (String, [String: Any]) -> Void)?

    var connectionCount: Int { connections.filter(\.connected).count }

    func statusSnapshot() -> sending [String: Any] {
        [
            "connectionCount": connections.filter(\.connected).count,
            "detectedPorts": lastDetectedPorts,
            "lastOpenError": lastOpenError as Any,
            "lastReadError": lastReadError as Any,
            "lastWriteError": lastWriteError as Any,
            "connections": connections.map { conn in
                [
                    "port": conn.port,
                    "connected": conn.connected,
                    "provisionSent": conn.provisionSent,
                    "deviceInfo": [
                        "board": conn.deviceInfo?.board as Any,
                        "version": conn.deviceInfo?.version as Any,
                        "wifiConfigured": conn.deviceInfo?.wifiConfigured as Any,
                        "wifiConnected": conn.deviceInfo?.wifiConnected as Any,
                    ] as [String: Any],
                ] as [String: Any]
            },
        ]
    }

    nonisolated func setStateProviderFn(_ provider: @escaping () -> [String: Any]?) { stateProvider = provider }
    nonisolated func setUsageProviderFn(_ provider: @escaping () -> [String: Any]?) { usageProvider = provider }
    nonisolated func setInitialStateProviderFn(_ provider: @escaping () -> [[String: Any]]) { initialStateProvider = provider }
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
        failedPorts.removeAll()
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
            let output = try shellSync("ls /dev/cu.usb* /dev/cu.wchusbserial* 2>/dev/null || true")
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
        lastDetectedPorts = ports
        let now = Date()

        for port in ports {
            // Skip if already connected
            if connections.contains(where: { $0.port == port }) { continue }

            // Check failure blocklist
            if let failure = failedPorts[port] {
                if failure.isPermanent {
                    // Only retry permanent failures after 5 minutes
                    if now.timeIntervalSince(failure.lastAttempt) < Self.permanentBlockDuration { continue }
                } else {
                    // Exponential backoff for transient errors: 10s * 2^(n-1), cap 60s
                    let backoff = min(10.0 * pow(2.0, Double(failure.failCount - 1)), Self.transientMaxBackoff)
                    if now.timeIntervalSince(failure.lastAttempt) < backoff { continue }
                }
            }

            if let conn = openPort(port) {
                connections.append(conn)
            }
        }
    }

    // MARK: - Port Open

    private func openPort(_ port: String) -> SerialConnection? {
        let descriptor = open(port, O_RDWR | O_NOCTTY | O_NONBLOCK)
        guard descriptor >= 0 else {
            let errNo = errno
            let message = String(cString: strerror(errNo))
            let isPermanent = (errNo == EACCES)
            let existing = failedPorts[port]
            let count = (existing?.failCount ?? 0) + 1
            failedPorts[port] = PortFailure(error: message, isPermanent: isPermanent, failCount: count, lastAttempt: Date())

            if isPermanent {
                if count == 1 {
                    DaemonLogger.shared.error("ESP32: Permission denied opening \(port) — serial entitlement missing or App Sandbox. Suppressing for 5 min.")
                }
            } else {
                DaemonLogger.shared.debug("ESP32", "Failed to open serial: \(port) (\(message)) [attempt \(count)]")
            }

            lastOpenError = "failed to open serial handle for \(port): \(message)"
            return nil
        }
        failedPorts.removeValue(forKey: port)

        // Configure termios: raw mode (no echo, no canonical, no signal chars)
        let isCDC = port.contains("usbmodem")
        var options = termios()
        tcgetattr(descriptor, &options)
        cfmakeraw(&options)
        options.c_cflag |= UInt(CLOCAL | CREAD)
        if !isCDC {
            cfsetispeed(&options, speed_t(B115200))
            cfsetospeed(&options, speed_t(B115200))
        }
        // Non-blocking read: return immediately with whatever is available
        withUnsafeMutablePointer(to: &options.c_cc) { ptr in
            let cc = UnsafeMutableRawPointer(ptr).assumingMemoryBound(to: UInt8.self)
            cc[Int(VMIN)] = 0
            cc[Int(VTIME)] = 0
        }
        tcsetattr(descriptor, TCSANOW, &options)

        // Clear O_NONBLOCK after termios config (FileHandle needs blocking reads)
        let flags = fcntl(descriptor, F_GETFL)
        _ = fcntl(descriptor, F_SETFL, flags & ~O_NONBLOCK)

        let writeFD = dup(descriptor)
        if writeFD < 0 {
            let message = String(cString: strerror(errno))
            close(descriptor)
            lastOpenError = "failed to dup write handle for \(port): \(message)"
            return nil
        }
        let readFD = dup(descriptor)
        close(descriptor)
        guard readFD >= 0 else {
            let message = String(cString: strerror(errno))
            close(writeFD)
            lastOpenError = "failed to dup read handle for \(port): \(message)"
            return nil
        }
        let writeHandle = FileHandle(fileDescriptor: writeFD, closeOnDealloc: true)
        let readHandle = FileHandle(fileDescriptor: readFD, closeOnDealloc: true)

        lastOpenError = nil

        var conn = SerialConnection(port: port, writeHandle: writeHandle, readHandle: readHandle)

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
        startReading(port: port, handle: readHandle)

        return conn
    }

    private func startReading(port: String, handle: FileHandle) {
        handle.readabilityHandler = { [weak self] fh in
            let data = fh.availableData
            guard !data.isEmpty else {
                Task { await self?.markReadFailure(port: port, message: "EOF on \(port)") }
                return
            }
            guard let str = String(data: data, encoding: .utf8) else {
                Task { await self?.markReadFailure(port: port, message: "non-UTF8 read on \(port)") }
                return
            }
            Task { await self?.handleReadData(port: port, data: str) }
        }
    }

    private func markReadFailure(port: String, message: String) {
        lastReadError = message
        if let idx = connections.firstIndex(where: { $0.port == port }) {
            connections[idx].connected = false
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
            lastWriteError = nil
        } catch {
            conn.connected = false
            lastWriteError = "write failed for \(conn.port): \(error.localizedDescription)"
        }
    }

    /// Strip fields ESP32 doesn't need (reduce payload for small RX buffers)
    private func prepareForSerial(_ event: [String: Any]) -> [String: Any] {
        var e = event
        let type = event["type"] as? String

        // Global strips — large metadata daemon has but small devices don't use
        e.removeValue(forKey: "modelCatalog")
        e.removeValue(forKey: "ollamaStatus")
        e.removeValue(forKey: "tokenStatus")

        if type == "usage_update" {
            e.removeValue(forKey: "extraUsageEnabled")
            e.removeValue(forKey: "extraUsageMonthlyLimit")
            e.removeValue(forKey: "extraUsageUsedCredits")
            e.removeValue(forKey: "extraUsageUtilization")
            e.removeValue(forKey: "costSpent")
            e.removeValue(forKey: "costLimit")
            e.removeValue(forKey: "sessionPercent")
            e.removeValue(forKey: "resetTime")
            e.removeValue(forKey: "resetDate")
        } else if type == "state_update" {
            e.removeValue(forKey: "agentCapabilities")
            e.removeValue(forKey: "billingType")
            e.removeValue(forKey: "remoteUrl")
            // Keep gatewayAvailable and gatewayHasError — ESP32 needs them for crayfish rendering
        } else if type == "sessions_list" {
            // Keep only essential session info to avoid hitting serial limits
            if let sessions = e["sessions"] as? [[String: Any]] {
                e["sessions"] = sessions.map { s in
                    [
                        "id": s["id"] ?? "",
                        "projectName": s["projectName"] ?? "",
                        "agentType": s["agentType"] ?? "",
                        "state": s["state"] ?? "",
                        "alive": s["alive"] ?? true
                    ]
                }
            }
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
