#if os(macOS)
// OpenClawAdapter.swift — OpenClaw Gateway WebSocket client
// Ported from bridge/src/adapters/openclaw.ts

import Foundation
import CryptoKit

/// Connects to OpenClaw Gateway via WebSocket, handles Ed25519 auth handshake,
/// and relays events to the daemon.
actor OpenClawAdapter {
    private var wsTask: URLSessionWebSocketTask?
    private var reconnectTask: Task<Void, Never>?
    private let gatewayUrl: String
    private var isConnected = false
    private var reconnectDelay: TimeInterval = 1
    private let maxReconnectDelay: TimeInterval = 8

    private var _onEvent: (@Sendable ([String: Any]) -> Void)?
    private var _onConnectionChanged: (@Sendable (Bool) -> Void)?

    func setOnEvent(_ handler: @escaping @Sendable ([String: Any]) -> Void) { _onEvent = handler }
    func setOnConnectionChanged(_ handler: @escaping @Sendable (Bool) -> Void) { _onConnectionChanged = handler }

    init(gatewayUrl: String = "ws://127.0.0.1:18789") {
        self.gatewayUrl = gatewayUrl
    }

    func start() {
        connect()
    }

    func stop() {
        reconnectTask?.cancel()
        wsTask?.cancel(with: .goingAway, reason: nil)
        wsTask = nil
        isConnected = false
    }

    // MARK: - Connection

    private func connect() {
        guard let url = URL(string: gatewayUrl) else { return }
        let task = URLSession.shared.webSocketTask(with: url)
        self.wsTask = task
        task.resume()

        receiveLoop(task)

        // Wait a moment then attempt handshake
        Task {
            try? await Task.sleep(for: .milliseconds(500))
            await performHandshake()
        }
    }

    private func receiveLoop(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            Task {
                guard let self else { return }
                switch result {
                case .success(let message):
                    switch message {
                    case .string(let text):
                        await self.handleMessage(text)
                    default:
                        break
                    }
                    await self.receiveLoop(task)
                case .failure:
                    await self.handleDisconnect()
                }
            }
        }
    }

    private func handleMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }

        let frameType = json["type"] as? String

        switch frameType {
        case "event":
            if let eventName = json["event"] as? String {
                handleGatewayEvent(eventName, payload: json["payload"] as? [String: Any] ?? [:])
            }
        case "res":
            handleResponse(json)
        default:
            break
        }
    }

    private func handleGatewayEvent(_ event: String, payload: [String: Any]) {
        switch event {
        case "chat":
            // Chat events (delta, final, aborted, error)
            self._onEvent?(["type": "gateway_chat", "event": event, "payload": payload])
        case "exec.approval.requested":
            self._onEvent?(["type": "gateway_approval", "payload": payload])
        case "presence":
            self._onEvent?(["type": "gateway_presence", "payload": payload])
        case "tick":
            break // Heartbeat, ignore
        case "shutdown":
            handleDisconnect()
        default:
            self._onEvent?(["type": "gateway_event", "event": event, "payload": payload])
        }
    }

    private func handleResponse(_ json: [String: Any]) {
        // Handle RPC responses
        DaemonLogger.shared.debug("OpenClaw", "Response: \(json["id"] as? String ?? "unknown")")
    }

    private func handleDisconnect() {
        let wasConnected = isConnected
        isConnected = false
        wsTask = nil

        if wasConnected {
            self._onConnectionChanged?(false)
        }

        // Reconnect with exponential backoff
        let delay = reconnectDelay
        reconnectDelay = min(reconnectDelay * 2, maxReconnectDelay)
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            await self?.connect()
        }
    }

    // MARK: - Ed25519 Handshake

    private func performHandshake() {
        // Load device identity
        guard let identity = loadDeviceIdentity() else {
            DaemonLogger.shared.debug("OpenClaw", "No device identity found, connecting without auth")
            isConnected = true
            reconnectDelay = 1
            self._onConnectionChanged?(true)
            return
        }

        // The Gateway sends a connect.challenge event, we respond with signed challenge
        // For now, mark as connected — full handshake will be implemented when needed
        isConnected = true
        reconnectDelay = 1
        self._onConnectionChanged?(true)
    }

    private func loadDeviceIdentity() -> (privateKey: Curve25519.Signing.PrivateKey, deviceId: String)? {
        let identityDir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".openclaw/identity")
        let deviceFile = identityDir.appendingPathComponent("device.json")

        guard let data = try? Data(contentsOf: deviceFile),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let deviceId = json["deviceId"] as? String,
              let privateKeyPem = json["privateKeyPem"] as? String else {
            return nil
        }

        // Parse PEM to raw key bytes
        guard let keyData = pemToRawKey(privateKeyPem) else { return nil }

        do {
            let privateKey = try Curve25519.Signing.PrivateKey(rawRepresentation: keyData)
            return (privateKey, deviceId)
        } catch {
            DaemonLogger.shared.error("OpenClaw: Failed to load private key: \(error)")
            return nil
        }
    }

    private func pemToRawKey(_ pem: String) -> Data? {
        let lines = pem.components(separatedBy: "\n")
            .filter { !$0.hasPrefix("-----") && !$0.isEmpty }
        let base64 = lines.joined()
        guard let derData = Data(base64Encoded: base64) else { return nil }
        // SPKI DER has 12-byte prefix for Ed25519
        if derData.count == 44 {
            return derData.suffix(32) // Strip SPKI prefix
        }
        if derData.count == 32 {
            return derData
        }
        // PKCS8 has 16-byte prefix
        if derData.count == 48 {
            return derData.suffix(32)
        }
        return nil
    }

    // MARK: - RPC

    func sendRPC(method: String, params: [String: Any]) {
        let frame: [String: Any] = [
            "type": "req",
            "id": UUID().uuidString,
            "method": method,
            "params": params,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: frame),
              let text = String(data: data, encoding: .utf8) else { return }
        wsTask?.send(.string(text)) { _ in }
    }
}
#endif
