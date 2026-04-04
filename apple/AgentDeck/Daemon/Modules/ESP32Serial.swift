#if os(macOS)
// ESP32Serial.swift — USB serial communication with ESP32 devices
// Ported from bridge/src/esp32-serial.ts

import Foundation
import Darwin

/// Thread-safe token to signal read threads to stop.
/// Shared between actor (invalidate) and read dispatch queue (check).
final class ReadToken: @unchecked Sendable {
    private let lock = NSLock()
    private var _active = true
    var isActive: Bool { lock.withLock { _active } }
    func invalidate() { lock.withLock { _active = false } }
}

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
        let readToken = ReadToken()
        let openedAt = Date()
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
    private static let deviceInfoTimeoutSec: TimeInterval = 30  // reconnect if no device_info after 30s

    /// Thread-safe queue for incoming serial data (read thread → actor)
    private struct PendingRead: @unchecked Sendable {
        let port: String
        let data: String
    }
    nonisolated(unsafe) private let pendingReadsLock = NSLock()
    nonisolated(unsafe) private var pendingReads: [PendingRead] = []

    private nonisolated func enqueuePendingRead(port: String, data: String) {
        pendingReadsLock.lock()
        pendingReads.append(PendingRead(port: port, data: data))
        pendingReadsLock.unlock()
    }

    private func drainPendingReads() {
        pendingReadsLock.lock()
        let reads = pendingReads
        pendingReads.removeAll()
        pendingReadsLock.unlock()
        for r in reads {
            if r.data.hasPrefix("<<READ_ERR:") {
                let details = String(r.data.dropFirst("<<READ_ERR:".count).dropLast(2))
                markReadFailure(port: r.port, message: "read failed on \(r.port): \(details)")
            } else {
                handleReadData(port: r.port, data: r.data)
            }
        }
    }
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

    private var drainTask: Task<Void, Never>?

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
                try? await Task.sleep(for: .seconds(3))
                await self?.sendHeartbeat()
            }
        }

        // Drain incoming serial data every 100ms
        drainTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(100))
                await self?.drainPendingReads()
            }
        }

        DaemonLogger.shared.debug("ESP32", "Serial bridge started")
    }

    func stop() async {
        pollTask?.cancel()
        heartbeatTask?.cancel()
        drainTask?.cancel()
        // Wait for tasks to actually finish so no in-flight pollForDevices() opens new ports
        await pollTask?.value
        await heartbeatTask?.value
        await drainTask?.value
        pollTask = nil
        heartbeatTask = nil
        drainTask = nil
        closeAllConnections()
        DaemonLogger.shared.debug("ESP32", "Serial bridge stopped")
    }

    /// Wake recovery — full stop + restart to avoid FD leaks
    func handleWake() async {
        DaemonLogger.shared.info("ESP32 serial wake recovery — closing \(connections.count) stale connection(s)")
        await stop()
        start()
    }

    /// Close all connections, invalidate read tokens, release FDs
    private func closeAllConnections() {
        for conn in connections {
            conn.readToken.invalidate()
            try? conn.writeHandle?.close()
            // readHandle is the same FileHandle — no separate close needed
        }
        connections.removeAll()
        failedPorts.removeAll()
        lastOpenError = nil
        lastReadError = nil
        lastWriteError = nil
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

            openAndRegisterPort(port)
        }
    }

    // MARK: - Port Open

    private func openAndRegisterPort(_ port: String) {
        // Close any existing connection to the same port first (prevents FD leak on restart/wake race)
        if let existingIdx = connections.firstIndex(where: { $0.port == port }) {
            let old = connections.remove(at: existingIdx)
            old.readToken.invalidate()
            try? old.writeHandle?.close()
            DaemonLogger.shared.debug("ESP32", "Closed stale connection to \(port) before reopening")
        }

        guard let conn = openPort(port) else { return }
        // IMPORTANT: append to connections array BEFORE starting read thread,
        // otherwise handleReadData won't find the connection by port name
        connections.append(conn)
        guard let readHandle = conn.readHandle else {
            DaemonLogger.shared.throttledDebug("ESP32", key: "missing-read:\(port)", "No read handle for \(port), skipping", minInterval: 60)
            return
        }
        startReading(port: port, handle: readHandle, token: conn.readToken)
    }

    private func openPort(_ port: String) -> SerialConnection? {
        // O_NONBLOCK needed to avoid blocking on DCD during open; cleared after termios config
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
                DaemonLogger.shared.throttledDebug(
                    "ESP32",
                    key: "open-fail:\(port):\(message)",
                    "Failed to open serial: \(port) (\(message)) [attempt \(count)]",
                    minInterval: 30
                )
            }

            lastOpenError = "failed to open serial handle for \(port): \(message)"
            return nil
        }
        failedPorts.removeValue(forKey: port)

        // Configure termios: raw mode, blocking read
        var options = termios()
        tcgetattr(descriptor, &options)
        cfmakeraw(&options)
        options.c_cflag |= UInt(CLOCAL | CREAD)
        options.c_cflag &= ~UInt(HUPCL)  // Match Node serial bridge: don't drop DTR on close/reopen.
        cfsetispeed(&options, speed_t(B115200))
        cfsetospeed(&options, speed_t(B115200))
        withUnsafeMutablePointer(to: &options.c_cc) { ptr in
            let cc = UnsafeMutableRawPointer(ptr).assumingMemoryBound(to: UInt8.self)
            cc[Int(VMIN)] = 1   // block until 1+ byte available
            cc[Int(VTIME)] = 0
        }
        tcsetattr(descriptor, TCSANOW, &options)
        tcflush(descriptor, TCIOFLUSH)
        // Keep O_NONBLOCK set — matches pyserial behavior (read returns EAGAIN when no data)

        // Use single fd for both read and write (no dup — simpler, avoids fd management issues)
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        let writeHandle = handle
        let readHandle = handle

        lastOpenError = nil

        var conn = SerialConnection(port: port, writeHandle: writeHandle, readHandle: readHandle)

        DaemonLogger.shared.info("ESP32 opened: \(port) [\(port.contains("usbmodem") ? "CDC" : "UART")]")

        // Request device info
        sendToConnection(&conn, json: #"{"type":"device_info_request"}"#)

        // Brief delay to let ESP32 process and respond, then read initial data
        Thread.sleep(forTimeInterval: 0.5)
        var initBuf = [UInt8](repeating: 0, count: 2048)
        let initN = Darwin.read(descriptor, &initBuf, initBuf.count)
        if initN > 0, let initStr = String(bytes: initBuf[0..<initN], encoding: .utf8) {
            enqueuePendingRead(port: port, data: initStr)
        }

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

        return conn
    }

    private func startReading(port: String, handle: FileHandle, token: ReadToken) {
        // Use a dedicated thread for serial reading — FileHandle.readabilityHandler
        // uses dispatch sources which don't reliably trigger for serial port fds.
        let fd = handle.fileDescriptor
        // Read on a dispatch queue — poll fd with O_NONBLOCK
        let readQueue = DispatchQueue(label: "esp32.read.\(port)", qos: .default)
        readQueue.async { [weak self, handle] in
            _ = handle  // Retain the FileHandle for the entire reader lifetime.
            let bufSize = 1024
            let buf = UnsafeMutablePointer<UInt8>.allocate(capacity: bufSize)
            defer { buf.deallocate() }

            while token.isActive {
                let n = Darwin.read(fd, buf, bufSize)
                if n > 0 {
                    if let str = String(bytes: UnsafeBufferPointer(start: buf, count: n), encoding: .utf8) {
                        self?.enqueuePendingRead(port: port, data: str)
                    }
                } else if n < 0 {
                    let errNo = errno
                    if errNo == EAGAIN || errNo == EWOULDBLOCK {
                        Thread.sleep(forTimeInterval: 0.05)
                        continue
                    }
                    DaemonLogger.shared.throttledDebug("ESP32", key: "read-exit:\(port):\(errNo)", "Read exit \(port): errno=\(errNo)", minInterval: 30)
                    let errText = String(cString: strerror(errNo))
                    self?.enqueuePendingRead(port: port, data: "<<READ_ERR:errno=\(errNo) \(errText)>>")
                    break
                } else {
                    Thread.sleep(forTimeInterval: 0.05)
                }
            }
        }
    }

    private func markReadFailure(port: String, message: String) {
        lastReadError = message
        if let idx = connections.firstIndex(where: { $0.port == port }) {
            connections[idx].readToken.invalidate()
            connections[idx].connected = false
        }
    }

    private func handleReadData(port: String, data: String) {
        guard let idx = connections.firstIndex(where: { $0.port == port }) else { return }
        connections[idx].readBuffer += data
        // Normalize CR/CRLF to LF — ESP32 Serial.println() sends \r\n,
        // cfmakeraw disables ICRNL so \r arrives as-is
        connections[idx].readBuffer = connections[idx].readBuffer
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")

        while let newlineIdx = connections[idx].readBuffer.firstIndex(of: "\n") {
            let line = String(connections[idx].readBuffer[..<newlineIdx]).trimmingCharacters(in: .whitespaces)
            connections[idx].readBuffer = String(connections[idx].readBuffer[connections[idx].readBuffer.index(after: newlineIdx)...])

            guard line.hasPrefix("{") else { continue }
            guard let jsonData = line.data(using: .utf8),
                  let msg = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
                  let type = msg["type"] as? String else { continue }

            DaemonLogger.shared.sampledDebug("ESP32", key: "recv:\(port):\(type)", every: 20, "← \(port): \(type)")

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
        drainPendingReads()
        guard !connections.isEmpty else { return }

        // Check for connections that never received device_info — reconnect them
        let now = Date()
        for i in connections.indices.reversed() where connections[i].connected {
            if connections[i].deviceInfo == nil,
               now.timeIntervalSince(connections[i].openedAt) > Self.deviceInfoTimeoutSec {
                let port = connections[i].port
                DaemonLogger.shared.info("ESP32 \(port): no device_info after \(Int(Self.deviceInfoTimeoutSec))s — reconnecting")
                connections[i].readToken.invalidate()
                connections[i].connected = false
                try? connections[i].writeHandle?.close()
                // Will be pruned + reopened on next pollForDevices() cycle
            }
        }

        var sentData = false

        if let event = stateProvider?() {
            let prepared = prepareForSerial(event)
            if let data = try? JSONSerialization.data(withJSONObject: prepared),
               let json = String(data: data, encoding: .utf8) {
                for i in connections.indices where connections[i].connected {
                    sendToConnection(&connections[i], json: json)
                }
                sentData = true
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
                sentData = true
            }
        }

        // Keepalive: if no state/usage data available, send minimal JSON
        // so ESP32 doesn't hit its 10s serial timeout
        if !sentData {
            let keepalive = "{\"type\":\"keepalive\"}"
            for i in connections.indices where connections[i].connected {
                sendToConnection(&connections[i], json: keepalive)
            }
        }
    }

    // MARK: - Serial Helpers

    private func sendToConnection(_ conn: inout SerialConnection, json: String) {
        guard conn.connected, let handle = conn.writeHandle else { return }
        do {
            let payload = Array((json + "\n").utf8)
            let written = Darwin.write(handle.fileDescriptor, payload, payload.count)
            guard written == payload.count else {
                throw NSError(domain: "ESP32", code: -1, userInfo: [NSLocalizedDescriptionKey: "write returned \(written), expected \(payload.count), errno=\(errno)"])
            }
            lastWriteError = nil
        } catch {
            conn.readToken.invalidate()
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
