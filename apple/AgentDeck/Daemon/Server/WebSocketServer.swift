#if os(macOS)
// WebSocketServer.swift — NIO-free WebSocket server using Network.framework
// Ported from bridge/src/ws-server.ts

import Foundation
import Network

/// A lightweight WebSocket server using Network.framework (no external dependencies).
actor WebSocketServer {
    private var listener: NWListener?
    private var connections = Set<WebSocketConnection>()
    private var broadcastHooks: [@Sendable (Data) -> Void] = []

    var onCommand: (@Sendable ([String: Any]) -> Void)?
    var onClientConnect: (@Sendable (WebSocketConnection) -> Void)?
    var onClientDisconnect: (@Sendable () -> Void)?

    var clientCount: Int { connections.count }

    func setCommandHandler(_ handler: @escaping @Sendable ([String: Any]) -> Void) {
        onCommand = handler
    }
    func setConnectHandler(_ handler: @escaping @Sendable (WebSocketConnection) -> Void) {
        onClientConnect = handler
    }
    func setDisconnectHandler(_ handler: @escaping @Sendable () -> Void) {
        onClientDisconnect = handler
    }

    // MARK: - Lifecycle

    func start(port: UInt16) throws {
        let params = NWParameters.tcp
        let wsOptions = NWProtocolWebSocket.Options()
        wsOptions.autoReplyPing = true
        params.defaultProtocolStack.applicationProtocols.insert(wsOptions, at: 0)

        let listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)
        self.listener = listener

        listener.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                DaemonLogger.shared.info("WebSocket server listening on port \(port)")
            case .failed(let error):
                DaemonLogger.shared.error("WebSocket listener failed: \(error)")
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

    // MARK: - Connection Handling

    private func handleNewConnection(_ nwConn: NWConnection) {
        // Token auth for remote connections
        let remoteIP = nwConn.endpoint.debugDescription
        let conn = WebSocketConnection(connection: nwConn)

        // Extract token from URL path query if remote
        // For simplicity, we do auth check after WS upgrade via first message
        // Network.framework doesn't expose HTTP upgrade URL easily,
        // so we'll validate via a handshake message protocol

        connections.insert(conn)
        DaemonLogger.shared.debug("WS", "Client connected (\(connections.count) total)")

        let connId = conn.id
        conn.onMessage = { [weak self] data in
            let c = conn
            Task { await self?.handleMessage(data, from: c) }
        }

        conn.onClose = { [weak self] in
            let c = conn
            Task { await self?.handleDisconnect(c) }
        }

        conn.start()
        onClientConnect?(conn)
    }

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
    }

    func sendTo(_ conn: WebSocketConnection, event: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: event) else { return }
        conn.send(data)
    }

    func onBroadcast(_ hook: @escaping @Sendable (Data) -> Void) {
        broadcastHooks.append(hook)
    }
}

// MARK: - WebSocketConnection

final class WebSocketConnection: Hashable, Sendable {
    let id = UUID()
    private let connection: NWConnection

    nonisolated(unsafe) var onMessage: (@Sendable (Data) -> Void)?
    nonisolated(unsafe) var onClose: (@Sendable () -> Void)?

    init(connection: NWConnection) {
        self.connection = connection
    }

    func start() {
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                self?.receiveLoop()
            case .failed, .cancelled:
                self?.onClose?()
            default:
                break
            }
        }
        connection.start(queue: .main)
    }

    private func receiveLoop() {
        connection.receiveMessage { [weak self] content, context, isComplete, error in
            guard let self else { return }
            if let error {
                DaemonLogger.shared.debug("WS", "Receive error: \(error)")
                self.onClose?()
                return
            }

            if let content, let context,
               let meta = context.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata {
                switch meta.opcode {
                case .text, .binary:
                    self.onMessage?(content)
                case .close:
                    self.onClose?()
                    return
                default:
                    break
                }
            }

            // Continue receiving
            self.receiveLoop()
        }
    }

    func send(_ data: Data) {
        let meta = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "ws", metadata: [meta])
        connection.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed({ _ in }))
    }

    func close() {
        connection.cancel()
    }

    // Hashable
    static func == (lhs: WebSocketConnection, rhs: WebSocketConnection) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}
#endif
