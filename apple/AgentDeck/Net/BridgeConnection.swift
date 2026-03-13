// BridgeConnection.swift — WebSocket connection to AgentDeck bridge
// Ported from android BridgeConnection.kt

import Foundation
import Combine

@Observable
final class BridgeConnection: @unchecked Sendable {
    // MARK: - Constants

    private static let initialBackoffMs = 1000
    private static let maxBackoffMs = 8000
    private static let maxReconnectAttempts = 10
    private static let pingIntervalSec: TimeInterval = 30
    private static let readTimeoutSec: TimeInterval = 45

    // MARK: - Observable State

    private(set) var status: ConnectionStatus = .disconnected
    private(set) var url: String?
    private(set) var lastError: String?
    private(set) var isReconnecting = false
    private(set) var reconnectAttempt = 0

    // MARK: - Event callback

    var onEvent: ((BridgeEvent) -> Void)?

    /// Called when reconnect gives up — state holder can restart discovery
    var onReconnectExhausted: (() -> Void)?

    /// Called before each reconnect attempt — return true to abort reconnect
    /// and let the caller take over (e.g. switch to a local session).
    var onReconnectAttempt: (() -> Bool)?

    // MARK: - Private

    private var webSocket: URLSessionWebSocketTask?
    private var urlSession: URLSession?
    private var backoffMs = initialBackoffMs
    private var shouldReconnect = false
    private var pingTimer: Timer?
    private var reconnectWork: DispatchWorkItem?
    private let queue = DispatchQueue(label: "dev.agentdeck.bridge", qos: .userInitiated)
    private var hasReceivedMessage = false

    enum ConnectionStatus: Sendable {
        case disconnected
        case connecting
        case connected
    }

    // MARK: - Connect

    func connect(to urlString: String) {
        queue.async { [weak self] in
            self?.connectInternal(urlString)
        }
    }

    private func connectInternal(_ urlString: String) {
        disconnect(reconnect: false)

        guard let wsUrl = URL(string: urlString) else {
            DispatchQueue.main.async { self.lastError = "Invalid URL: \(urlString)" }
            return
        }

        DispatchQueue.main.async {
            self.url = urlString
            self.status = .connecting
            self.lastError = nil
            self.shouldReconnect = true
            self.hasReceivedMessage = false
        }

        let session = URLSession(configuration: .default)
        self.urlSession = session
        let task = session.webSocketTask(with: wsUrl)

        // Half-open detection: idle timeout
        task.maximumMessageSize = 1_048_576  // 1MB

        self.webSocket = task
        task.resume()

        // Don't set .connected here — wait for first message in receiveLoop
        startPingTimer()
        receiveLoop()
    }

    // MARK: - Disconnect

    func disconnect(reconnect: Bool = false) {
        shouldReconnect = reconnect
        reconnectWork?.cancel()
        reconnectWork = nil
        stopPingTimer()

        webSocket?.cancel(with: .goingAway, reason: nil)
        webSocket = nil
        urlSession?.invalidateAndCancel()
        urlSession = nil

        if !reconnect {
            DispatchQueue.main.async {
                self.status = .disconnected
                self.isReconnecting = false
                self.reconnectAttempt = 0
            }
        }
    }

    // MARK: - Send Command

    func send(_ command: PluginCommand) {
        guard let ws = webSocket else { return }

        do {
            let data = try JSONEncoder().encode(command)
            guard let text = String(data: data, encoding: .utf8) else { return }
            ws.send(.string(text)) { error in
                if let error {
                    print("[BridgeConnection] Send error: \(error)")
                }
            }
        } catch {
            print("[BridgeConnection] Encode error: \(error)")
        }
    }

    // MARK: - Receive Loop

    private func receiveLoop() {
        guard let ws = webSocket else { return }

        ws.receive { [weak self] result in
            guard let self else { return }

            switch result {
            case .success(let message):
                // First successful message = connection confirmed
                if !self.hasReceivedMessage {
                    self.hasReceivedMessage = true
                    DispatchQueue.main.async {
                        self.status = .connected
                        self.backoffMs = Self.initialBackoffMs
                        self.reconnectAttempt = 0
                        self.isReconnecting = false
                    }
                }

                switch message {
                case .string(let text):
                    if let event = BridgeEventParser.parse(text) {
                        DispatchQueue.main.async {
                            self.onEvent?(event)
                        }
                    }
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8),
                       let event = BridgeEventParser.parse(text) {
                        DispatchQueue.main.async {
                            self.onEvent?(event)
                        }
                    }
                @unknown default:
                    break
                }
                // Continue receiving
                self.receiveLoop()

            case .failure(let error):
                print("[BridgeConnection] Receive error: \(error)")
                self.handleDisconnect(error: error)
            }
        }
    }

    // MARK: - Ping

    private func startPingTimer() {
        stopPingTimer()
        DispatchQueue.main.async {
            self.pingTimer = Timer.scheduledTimer(withTimeInterval: Self.pingIntervalSec, repeats: true) { [weak self] _ in
                self?.webSocket?.sendPing { error in
                    if let error {
                        print("[BridgeConnection] Ping failed: \(error)")
                        self?.handleDisconnect(error: error)
                    }
                }
            }
        }
    }

    private func stopPingTimer() {
        DispatchQueue.main.async {
            self.pingTimer?.invalidate()
            self.pingTimer = nil
        }
    }

    // MARK: - Reconnect

    private func handleDisconnect(error: Error? = nil) {
        stopPingTimer()
        webSocket?.cancel(with: .goingAway, reason: nil)
        webSocket = nil

        let wasConnected = hasReceivedMessage
        hasReceivedMessage = false

        // Check for auth rejection (4001)
        if let urlError = error as? URLError,
           urlError.code == .userAuthenticationRequired {
            DispatchQueue.main.async {
                self.status = .disconnected
                self.lastError = "Unauthorized — pair with token or use local connection"
                self.shouldReconnect = false
                self.isReconnecting = false
            }
            return
        }

        guard shouldReconnect, let urlString = url else {
            DispatchQueue.main.async {
                self.status = .disconnected
            }
            return
        }

        // Give up after max attempts (fewer for localhost since local discovery will re-find it)
        let isLocalhost = urlString.contains("127.0.0.1") || urlString.contains("localhost")
        let maxAttempts = isLocalhost ? 5 : Self.maxReconnectAttempts
        if reconnectAttempt >= maxAttempts {
            DispatchQueue.main.async {
                self.status = .disconnected
                self.url = nil
                self.isReconnecting = false
                self.shouldReconnect = false
                self.lastError = wasConnected
                    ? "Bridge disconnected — searching for bridges..."
                    : "Connection failed — searching for bridges..."
                self.onReconnectExhausted?()
            }
            return
        }

        DispatchQueue.main.async {
            self.status = .disconnected
            self.isReconnecting = true
            self.reconnectAttempt += 1
        }

        // Let caller short-circuit reconnect (e.g. macOS local session found)
        if let check = onReconnectAttempt, check() {
            DispatchQueue.main.async {
                self.isReconnecting = false
                self.shouldReconnect = false
            }
            return
        }

        let delay = Double(backoffMs) / 1000.0
        backoffMs = min(backoffMs * 2, Self.maxBackoffMs)

        let work = DispatchWorkItem { [weak self] in
            guard let self, self.shouldReconnect, let url = self.url else { return }
            self.connectInternal(url)
        }
        reconnectWork = work
        queue.asyncAfter(deadline: .now() + delay, execute: work)
    }
}
