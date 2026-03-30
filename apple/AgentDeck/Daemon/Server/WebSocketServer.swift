#if os(macOS)
// WebSocketServer.swift — Unified HTTP + WebSocket server on a single port
// Raw TCP listener with protocol detection: WS upgrade or plain HTTP

import Foundation
import Network
import CryptoKit

/// A unified server handling both HTTP requests and WebSocket connections on one port.
/// Also advertises Bonjour service for mDNS discovery.
actor WebSocketServer {
    private var listener: NWListener?
    private var connections = Set<WebSocketConnection>()
    private var broadcastHooks: [@Sendable (Data) -> Void] = []

    var onCommand: (@Sendable ([String: Any]) -> Void)?
    var onClientConnect: (@Sendable (WebSocketConnection) -> Void)?
    var onClientDisconnect: (@Sendable () -> Void)?

    var clientCount: Int { connections.count }

    // HTTP handler delegation
    private var httpHandler: HTTPServer?

    // Bonjour service
    private var bonjourService: NWListener.Service?

    func setCommandHandler(_ handler: @escaping @Sendable ([String: Any]) -> Void) {
        onCommand = handler
    }
    func setConnectHandler(_ handler: @escaping @Sendable (WebSocketConnection) -> Void) {
        onClientConnect = handler
    }
    func setDisconnectHandler(_ handler: @escaping @Sendable () -> Void) {
        onClientDisconnect = handler
    }

    /// Set the HTTP server to delegate plain HTTP requests to
    func setHTTPHandler(_ handler: HTTPServer) {
        self.httpHandler = handler
    }

    /// Set Bonjour service for mDNS advertisement (call before start)
    func setBonjourService(_ service: NWListener.Service) {
        self.bonjourService = service
    }

    // MARK: - Lifecycle

    func start(port: UInt16) throws {
        let params = NWParameters.tcp  // Raw TCP — no WebSocket protocol layer
        let listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)
        self.listener = listener

        // Attach Bonjour service for mDNS discovery
        if let service = bonjourService {
            listener.service = service
        }

        listener.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                DaemonLogger.shared.info("Server listening on port \(port) (HTTP + WebSocket + mDNS)")
            case .failed(let error):
                DaemonLogger.shared.error("Server listener failed: \(error)")
            default:
                break
            }
        }

        listener.newConnectionHandler = { [weak self] nwConn in
            Task { await self?.handleNewConnection(nwConn) }
        }

        listener.start(queue: .main)
    }

    func stop() {
        listener?.cancel()
        for conn in connections {
            conn.close()
        }
        connections.removeAll()
    }

    // MARK: - Connection Detection

    private func handleNewConnection(_ nwConn: NWConnection) {
        nwConn.start(queue: .main)

        // Read first bytes to detect HTTP vs WebSocket upgrade
        nwConn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, _, error in
            guard let data, error == nil else {
                nwConn.cancel()
                return
            }
            Task {
                guard let self else { return }
                if Self.isWebSocketUpgrade(data) {
                    await self.handleWebSocketUpgrade(nwConn, requestData: data)
                } else {
                    await self.handleHTTPRequest(nwConn, data: data)
                }
            }
        }
    }

    private static func isWebSocketUpgrade(_ data: Data) -> Bool {
        guard let text = String(data: data, encoding: .utf8) else { return false }
        return text.range(of: "upgrade: websocket", options: .caseInsensitive) != nil
    }

    // MARK: - WebSocket Upgrade

    private func handleWebSocketUpgrade(_ nwConn: NWConnection, requestData: Data) {
        guard let text = String(data: requestData, encoding: .utf8) else {
            nwConn.cancel()
            return
        }

        // Extract Sec-WebSocket-Key
        var wsKey: String?
        for line in text.components(separatedBy: "\r\n") {
            if line.lowercased().hasPrefix("sec-websocket-key:") {
                wsKey = String(line.dropFirst("sec-websocket-key:".count)).trimmingCharacters(in: .whitespaces)
                break
            }
        }

        guard let key = wsKey else {
            nwConn.cancel()
            return
        }

        // Compute accept key (RFC 6455)
        let magic = key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        let hash = Insecure.SHA1.hash(data: Data(magic.utf8))
        let acceptKey = Data(hash).base64EncodedString()

        // Send 101 Switching Protocols
        let response = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(acceptKey)\r\n\r\n"

        nwConn.send(content: Data(response.utf8), completion: .contentProcessed({ [weak self] error in
            guard error == nil else {
                nwConn.cancel()
                return
            }
            Task { await self?.setupWebSocketConnection(nwConn) }
        }))
    }

    private func setupWebSocketConnection(_ nwConn: NWConnection) {
        let conn = WebSocketConnection(connection: nwConn)
        connections.insert(conn)
        DaemonLogger.shared.debug("WS", "Client connected (\(connections.count) total)")

        conn.onMessage = { [weak self] data in
            let c = conn
            Task { await self?.handleMessage(data, from: c) }
        }

        conn.onClose = { [weak self] in
            let c = conn
            Task { await self?.handleDisconnect(c) }
        }

        conn.startReceiveLoop()
        onClientConnect?(conn)
    }

    // MARK: - HTTP Request Handling

    private func handleHTTPRequest(_ nwConn: NWConnection, data: Data) async {
        guard let httpHandler else {
            // No HTTP handler — send 503
            let body = Data("{\"error\":\"no http handler\"}".utf8)
            let response = "HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
            nwConn.send(content: Data(response.utf8) + body, completion: .contentProcessed({ _ in nwConn.cancel() }))
            return
        }

        let request = HTTPServer.parseHTTPRequest(data, remoteIP: nwConn.endpoint.debugDescription)
        let httpResponse = await httpHandler.route(request)
        let raw = HTTPServer.formatHTTPResponse(httpResponse)
        nwConn.send(content: raw, completion: .contentProcessed({ _ in
            nwConn.cancel()
        }))
    }

    // MARK: - WebSocket Message Handling

    private func handleMessage(_ data: Data, from conn: WebSocketConnection) {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        DaemonLogger.shared.debug("WS", "recv cmd: \(json["type"] as? String ?? "unknown")")
        onCommand?(json)
    }

    private func handleDisconnect(_ conn: WebSocketConnection) {
        connections.remove(conn)
        DaemonLogger.shared.debug("WS", "Client disconnected (\(connections.count) remaining)")
        onClientDisconnect?()
    }

    // MARK: - Broadcast

    func broadcast(_ event: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: event) else { return }
        for conn in connections {
            conn.send(data)
        }
        for hook in broadcastHooks {
            hook(data)
        }
    }

    func broadcastRaw(_ data: Data) {
        for conn in connections {
            conn.send(data)
        }
        for hook in broadcastHooks {
            hook(data)
        }
    }

    func sendTo(_ conn: WebSocketConnection, event: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: event) else { return }
        conn.send(data)
    }

    func onBroadcast(_ hook: @escaping @Sendable (Data) -> Void) {
        broadcastHooks.append(hook)
    }
}

// MARK: - WebSocketConnection (manual frame handling)

final class WebSocketConnection: Hashable, Sendable {
    let id = UUID()
    private let connection: NWConnection
    private let frameParser = WebSocketFrameParser()

    nonisolated(unsafe) var onMessage: (@Sendable (Data) -> Void)?
    nonisolated(unsafe) var onClose: (@Sendable () -> Void)?

    init(connection: NWConnection) {
        self.connection = connection
    }

    func startReceiveLoop() {
        receiveLoop()
    }

    private func receiveLoop() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] content, _, _, error in
            guard let self else { return }
            if let error {
                DaemonLogger.shared.debug("WS", "Receive error: \(error)")
                self.onClose?()
                return
            }
            guard let content else {
                self.receiveLoop()
                return
            }

            let frames = self.frameParser.feed(content)
            for (opcode, payload) in frames {
                switch opcode {
                case 0x1, 0x2: // text, binary
                    self.onMessage?(payload)
                case 0x8: // close
                    let closeFrame = Self.buildFrame(opcode: 0x8, payload: payload.prefix(2))
                    self.connection.send(content: closeFrame, completion: .contentProcessed({ _ in
                        self.connection.cancel()
                    }))
                    self.onClose?()
                    return
                case 0x9: // ping → pong
                    let pongFrame = Self.buildFrame(opcode: 0xA, payload: payload)
                    self.connection.send(content: pongFrame, completion: .contentProcessed({ _ in }))
                default:
                    break // pong, continuation, etc.
                }
            }

            self.receiveLoop()
        }
    }

    func send(_ data: Data) {
        let frame = Self.buildFrame(opcode: 0x1, payload: data)
        connection.send(content: frame, isComplete: true, completion: .contentProcessed({ _ in }))
    }

    func close() {
        let closeFrame = Self.buildFrame(opcode: 0x8, payload: Data())
        connection.send(content: closeFrame, completion: .contentProcessed({ [weak self] _ in
            self?.connection.cancel()
        }))
    }

    // MARK: - Frame Building (server → client: no mask)

    static func buildFrame(opcode: UInt8, payload: Data) -> Data {
        var frame = Data()
        frame.append(0x80 | opcode) // FIN + opcode

        if payload.count < 126 {
            frame.append(UInt8(payload.count))
        } else if payload.count < 65536 {
            frame.append(126)
            frame.append(UInt8((payload.count >> 8) & 0xFF))
            frame.append(UInt8(payload.count & 0xFF))
        } else {
            frame.append(127)
            for i in (0..<8).reversed() {
                frame.append(UInt8((payload.count >> (i * 8)) & 0xFF))
            }
        }

        frame.append(payload)
        return frame
    }

    // Hashable
    static func == (lhs: WebSocketConnection, rhs: WebSocketConnection) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

// MARK: - WebSocket Frame Parser (client → server: masked)

final class WebSocketFrameParser: @unchecked Sendable {
    private let lock = NSLock()
    private var buffer = Data()

    /// Feed raw TCP data, returns parsed frames as (opcode, payload)
    func feed(_ data: Data) -> [(UInt8, Data)] {
        lock.lock()
        defer { lock.unlock() }

        buffer.append(data)
        var frames: [(UInt8, Data)] = []

        while true {
            guard buffer.count >= 2 else { break }

            let byte0 = buffer[buffer.startIndex]
            let byte1 = buffer[buffer.startIndex + 1]
            let opcode = byte0 & 0x0F
            let masked = (byte1 & 0x80) != 0
            var payloadLen = UInt64(byte1 & 0x7F)
            var headerLen = 2

            if payloadLen == 126 {
                guard buffer.count >= 4 else { break }
                payloadLen = UInt64(buffer[buffer.startIndex + 2]) << 8
                    | UInt64(buffer[buffer.startIndex + 3])
                headerLen = 4
            } else if payloadLen == 127 {
                guard buffer.count >= 10 else { break }
                payloadLen = 0
                for i in 0..<8 {
                    payloadLen = (payloadLen << 8) | UInt64(buffer[buffer.startIndex + 2 + i])
                }
                headerLen = 10
            }

            let maskLen = masked ? 4 : 0
            let totalLen = headerLen + maskLen + Int(payloadLen)
            guard buffer.count >= totalLen else { break }

            let maskStart = buffer.startIndex + headerLen
            let payloadStart = maskStart + maskLen
            var payload = Data(buffer[payloadStart..<(payloadStart + Int(payloadLen))])

            if masked {
                let maskKey = buffer[maskStart..<(maskStart + 4)]
                for i in 0..<payload.count {
                    payload[payload.startIndex + i] ^= maskKey[maskKey.startIndex + (i % 4)]
                }
            }

            frames.append((opcode, payload))
            buffer.removeFirst(totalLen)
        }

        return frames
    }
}
#endif
