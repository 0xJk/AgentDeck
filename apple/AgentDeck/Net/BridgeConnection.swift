// BridgeConnection.swift — WebSocket connection to AgentDeck bridge
// Ported from android BridgeConnection.kt

import Foundation
import Combine

final class BridgeConnection: ObservableObject, @unchecked Sendable {
    private final class HealthCheckBox: @unchecked Sendable {
        private let lock = NSLock()
        private var completed = false

        func tryComplete() -> Bool {
            lock.lock()
            defer { lock.unlock() }
            guard !completed else { return false }
            completed = true
            return true
        }
    }

    // MARK: - Constants

    private static let initialBackoffMs = 1000
    private static let maxBackoffMs = 8000
    private static let maxReconnectAttempts = 20
    private static let pingIntervalSec: TimeInterval = 15
    private static let healthCheckTimeoutSec: TimeInterval = 3

    // MARK: - Observable State

    @Published private(set) var status: ConnectionStatus = .disconnected
    @Published private(set) var url: String?
    @Published private(set) var lastError: String?
    @Published private(set) var isReconnecting = false
    @Published private(set) var reconnectAttempt = 0

    // MARK: - Event callback

    var onEvent: ((BridgeEvent) -> Void)?

    /// Called when WebSocket disconnects (before reconnect attempts)
    var onDisconnect: (() -> Void)?

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
    private var pingSource: DispatchSourceTimer?
    private var reconnectWork: DispatchWorkItem?
    private let queue = DispatchQueue(label: "dev.agentdeck.bridge", qos: .userInitiated)
    private var hasReceivedMessage = false
    /// Incremented on disconnect(reconnect: false) to invalidate pending reconnect work
    private var connectionGeneration = 0
    /// Guard against concurrent handleDisconnect calls (ping callback + receive loop race)
    private var isHandlingDisconnect = false

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
        // Allow handleDisconnect to run again for this new connection
        isHandlingDisconnect = false

        // Clean up previous socket without resetting reconnect state
        let wasReconnecting = isReconnecting
        let savedAttempt = reconnectAttempt
        pingSource?.cancel()  // Already on queue — direct access safe
        pingSource = nil
        webSocket?.cancel(with: .goingAway, reason: nil)
        webSocket = nil
        urlSession?.invalidateAndCancel()
        urlSession = nil

        guard let wsUrl = URL(string: urlString) else {
            DispatchQueue.main.async { self.lastError = "Invalid URL: \(urlString)" }
            return
        }

        DispatchQueue.main.async {
            self.url = urlString
            self.status = .connecting
            self.lastError = nil
            self.hasReceivedMessage = false
            // Only enable shouldReconnect for fresh connections.
            // Reconnect-originated calls already have it set; re-setting it
            // would undo a concurrent disconnect(reconnect: false) call.
            if !wasReconnecting {
                self.shouldReconnect = true
            }
            // Preserve reconnecting state across reconnect attempts
            if wasReconnecting {
                self.isReconnecting = true
                self.reconnectAttempt = savedAttempt
            }
        }

        print("[BridgeConnection] connecting to \(urlString)")

        let config = URLSessionConfiguration.default
        // timeoutIntervalForRequest applies per outstanding URLSession receive
        // call for WebSocketTask. When no server push arrives within the window
        // the pending `ws.receive` fails with "Operation timed out" and we tear
        // the socket down. Must comfortably exceed `pingIntervalSec` (15s) so
        // ping/pong round-trips keep the connection alive between quiet periods.
        config.timeoutIntervalForRequest = 60
        #if os(iOS)
        // iOS: WiFi may not be ready on cold start — wait instead of failing immediately
        config.waitsForConnectivity = true
        #else
        // macOS: network is always up — fast failure enables quicker reconnect
        config.waitsForConnectivity = false
        // Half-open detection: abort reads that idle longer than this. Live sockets
        // produce traffic via pingIntervalSec so healthy connections never trip it;
        // after sleep/wake the dead socket fails within the window and reconnect fires.
        config.timeoutIntervalForResource = 120
        #endif
        let session = URLSession(configuration: config)
        self.urlSession = session
        let task = session.webSocketTask(with: wsUrl)

        // Half-open detection: idle timeout
        task.maximumMessageSize = 1_048_576  // 1MB

        self.webSocket = task
        task.resume()

        // Don't set .connected here — wait for first message in receiveLoop
        startPingTimerOnQueue()  // Already on queue
        receiveLoop()
    }

    // MARK: - Disconnect

    func disconnect(reconnect: Bool = false) {
        shouldReconnect = reconnect
        reconnectWork?.cancel()
        reconnectWork = nil
        isHandlingDisconnect = false  // Reset so future handleDisconnect can fire
        stopPingTimer()

        webSocket?.cancel(with: .goingAway, reason: nil)
        webSocket = nil
        urlSession?.invalidateAndCancel()
        urlSession = nil

        if !reconnect {
            // Bump generation so any in-flight reconnect work on queue sees stale gen
            connectionGeneration += 1
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
                    print("[BridgeConnection] first message received — connected!")
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
                print("[BridgeConnection] Receive error: \(error.localizedDescription)")
                self.handleDisconnect(error: error)
            }
        }
    }

    // MARK: - Ping

    func startPingTimer() {
        queue.async { [weak self] in
            self?.startPingTimerOnQueue()
        }
    }

    /// Cancel ping timer immediately. DispatchSource.cancel() is thread-safe,
    /// so this is safe to call from any thread (including disconnect()).
    func stopPingTimer() {
        pingSource?.cancel()
    }

    /// Start ping timer — must be called on `queue`
    private func startPingTimerOnQueue() {
        pingSource?.cancel()
        pingSource = nil
        let source = DispatchSource.makeTimerSource(queue: queue)
        source.schedule(deadline: .now() + Self.pingIntervalSec, repeating: Self.pingIntervalSec)
        source.setEventHandler { [weak self] in
            guard let owner = self else { return }
            owner.webSocket?.sendPing { error in
                if let error {
                    print("[BridgeConnection] Ping failed: \(error)")
                    owner.handleDisconnect(error: error)
                }
            }
        }
        source.resume()
        pingSource = source
    }

    // MARK: - Health Check & Force Reconnect

    /// Send an immediate ping with a short timeout to check if the socket is alive.
    func forceHealthCheck(completion: @escaping @Sendable (Bool) -> Void) {
        guard let ws = webSocket else {
            completion(false)
            return
        }

        let box = HealthCheckBox()

        ws.sendPing { error in
            guard box.tryComplete() else { return }
            DispatchQueue.main.async { completion(error == nil) }
        }

        // Timeout
        DispatchQueue.global().asyncAfter(deadline: .now() + Self.healthCheckTimeoutSec) {
            guard box.tryComplete() else { return }
            print("[BridgeConnection] health check timed out")
            DispatchQueue.main.async { completion(false) }
        }
    }

    /// Tear down the socket without triggering reconnect. Caller is responsible for restarting.
    func forceDisconnectAndRestart() {
        disconnect(reconnect: false)
    }

    /// Reset reconnect counter (e.g. after foreground return).
    func resetReconnectCount() {
        reconnectAttempt = 0
        backoffMs = Self.initialBackoffMs
    }

    // MARK: - Reconnect

    private func handleDisconnect(error: Error? = nil) {
        // Serialize on queue to prevent concurrent calls (ping callback + receive loop race).
        // isHandlingDisconnect stays true until connectInternal resets it —
        // this prevents the second error callback (ping + receive loop both fire when
        // bridge dies) from scheduling a duplicate reconnect.
        queue.async { [weak self] in
            guard let self, !self.isHandlingDisconnect else { return }
            self.isHandlingDisconnect = true

            self.pingSource?.cancel()
            self.pingSource = nil
            self.webSocket?.cancel(with: .goingAway, reason: nil)
            self.webSocket = nil

            let wasConnected = self.hasReceivedMessage
            self.hasReceivedMessage = false

            // Notify state holder immediately so UI shows disconnect
            if wasConnected {
                DispatchQueue.main.async { self.onDisconnect?() }
            }

            // Check for auth rejection (4001)
            if let urlError = error as? URLError,
               urlError.code == .userAuthenticationRequired {
                self.isHandlingDisconnect = false  // No reconnect will follow
                DispatchQueue.main.async {
                    self.status = .disconnected
                    self.lastError = "Unauthorized — check pairing token"
                    self.shouldReconnect = false
                    self.isReconnecting = false
                }
                return
            }

            guard self.shouldReconnect, let urlString = self.url else {
                self.isHandlingDisconnect = false  // No reconnect will follow
                DispatchQueue.main.async {
                    self.status = .disconnected
                }
                return
            }

            // Give up after max attempts (fewer for localhost since local discovery will re-find it)
            let isLocalhost = urlString.contains("127.0.0.1") || urlString.contains("localhost")
            let maxAttempts = isLocalhost ? 5 : Self.maxReconnectAttempts
            if self.reconnectAttempt >= maxAttempts {
                self.isHandlingDisconnect = false  // No reconnect will follow
                DispatchQueue.main.async {
                    self.status = .disconnected
                    self.url = nil
                    self.isReconnecting = false
                    self.shouldReconnect = false
                    self.lastError = wasConnected
                        ? "Bridge disconnected"
                        : "Connection failed"
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
            if let check = self.onReconnectAttempt, check() {
                self.isHandlingDisconnect = false  // Caller takes over connection
                DispatchQueue.main.async {
                    self.isReconnecting = false
                    self.shouldReconnect = false
                }
                return
            }

            let delay = Double(self.backoffMs) / 1000.0
            self.backoffMs = min(self.backoffMs * 2, Self.maxBackoffMs)

            let gen = self.connectionGeneration
            let work = DispatchWorkItem { [weak self] in
                guard let self, self.connectionGeneration == gen,
                      self.shouldReconnect, let url = self.url else { return }
                self.connectInternal(url)
            }
            self.reconnectWork = work
            self.queue.asyncAfter(deadline: .now() + delay, execute: work)
        }
    }
}
