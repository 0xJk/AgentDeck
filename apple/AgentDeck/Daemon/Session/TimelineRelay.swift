#if os(macOS)
// TimelineRelay.swift — Subscribe to sibling session WS streams, relay timeline events
// Ported from bridge/src/session-timeline-relay.ts

import Foundation

/// Relays timeline events from sibling session bridges to daemon clients.
actor TimelineRelay {
    private var subscriptions: [Int: URLSessionWebSocketTask] = [:] // port → task
    private var knownPorts = Set<Int>()
    private let selfPort: Int
    private var onEvent: (@Sendable ([String: Any]) -> Void)?
    private var syncTask: Task<Void, Never>?

    // Retry / backoff tracking
    private var retryCounters: [Int: Int] = [:]  // port → retry count
    private var failedPorts = Set<Int>()  // ports that exhausted retries, skip until next sync()
    private static let maxRetries = 3
    private static let maxConcurrentSubscriptions = 20

    init(selfPort: Int) {
        self.selfPort = selfPort
    }

    func setEventHandler(_ handler: @escaping @Sendable ([String: Any]) -> Void) {
        self.onEvent = handler
    }

    func start() {
        syncTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                await self?.sync()
            }
        }
    }

    func stop() {
        syncTask?.cancel()
        for (_, task) in subscriptions {
            task.cancel(with: .goingAway, reason: nil)
        }
        subscriptions.removeAll()
    }

    func sync() async {
        let sessions = await SessionRegistry.shared.listActiveAndReachable()
        let siblingPorts = Set(sessions
            .filter { $0.port != selfPort && $0.agentType != "daemon" }
            .map(\.port))

        // Reset failed ports each sync cycle — allow re-attempts for ports still alive
        failedPorts.removeAll()

        // Unsubscribe from removed siblings
        for port in knownPorts where !siblingPorts.contains(port) {
            unsubscribe(port: port)
            retryCounters.removeValue(forKey: port)
        }

        // Subscribe to new siblings AND re-subscribe previously failed ports (respect concurrent cap)
        for port in siblingPorts where !knownPorts.contains(port) || subscriptions[port] == nil {
            if subscriptions.count >= Self.maxConcurrentSubscriptions {
                DaemonLogger.shared.debug("TimelineRelay", "Subscription cap (\(Self.maxConcurrentSubscriptions)) reached, skipping port \(port)")
                break
            }
            retryCounters.removeValue(forKey: port)  // Reset retries for re-subscribe
            subscribe(port: port)
        }

        knownPorts = siblingPorts
    }

    private func subscribe(port: Int) {
        guard !failedPorts.contains(port) else { return }
        guard subscriptions.count < Self.maxConcurrentSubscriptions else {
            DaemonLogger.shared.debug("TimelineRelay", "Subscription cap reached, cannot subscribe to port \(port)")
            return
        }
        guard let url = URL(string: "ws://127.0.0.1:\(port)") else { return }
        let task = URLSession.shared.webSocketTask(with: url)
        subscriptions[port] = task
        task.resume()
        receiveLoop(port: port, task: task)
        DaemonLogger.shared.debug("TimelineRelay", "Subscribed to port \(port)")
    }

    private func incrementRetry(port: Int) -> Int {
        let count = (retryCounters[port] ?? 0) + 1
        retryCounters[port] = count
        return count
    }

    private func markFailed(port: Int) {
        failedPorts.insert(port)
        unsubscribe(port: port)
    }

    private func resetRetry(port: Int) {
        retryCounters[port] = 0
    }

    private func unsubscribe(port: Int) {
        subscriptions[port]?.cancel(with: .goingAway, reason: nil)
        subscriptions.removeValue(forKey: port)
        DaemonLogger.shared.debug("TimelineRelay", "Unsubscribed from port \(port)")
    }

    private func receiveLoop(port: Int, task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            Task {
                guard let self else { return }
                switch result {
                case .success(let message):
                    // Successful receive — reset retry counter for this port
                    await self.resetRetry(port: port)
                    switch message {
                    case .string(let text):
                        if let data = text.data(using: .utf8),
                           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                           let type = json["type"] as? String {
                            if type == "timeline_event" || type == "timeline_history" ||
                               type == "state_update" {
                                await self.onEvent?(json)
                            }
                        }
                    default:
                        break
                    }
                    await self.receiveLoop(port: port, task: task)
                case .failure:
                    // Only reconnect if port is still a known sibling (not a dead session)
                    guard await self.knownPorts.contains(port) else { return }
                    // Skip if this port has been marked as failed for this sync cycle
                    guard await !self.failedPorts.contains(port) else { return }
                    // Verify session is still alive before reconnecting
                    let alive = SessionRegistry.shared.listActive().contains { $0.port == port }
                    guard alive else {
                        await self.unsubscribe(port: port)
                        return
                    }
                    // Per-port retry counter with exponential backoff (2s, 4s, 8s)
                    let retryCount = await self.incrementRetry(port: port)
                    if retryCount > TimelineRelay.maxRetries {
                        DaemonLogger.shared.debug("TimelineRelay", "Port \(port) exhausted \(TimelineRelay.maxRetries) retries, skipping until next sync")
                        await self.markFailed(port: port)
                        return
                    }
                    let backoffSeconds = UInt64(1) << UInt64(retryCount)  // 2, 4, 8
                    DaemonLogger.shared.debug("TimelineRelay", "Port \(port) retry \(retryCount)/\(TimelineRelay.maxRetries), backoff \(backoffSeconds)s")
                    try? await Task.sleep(for: .seconds(backoffSeconds))
                    await self.subscribe(port: port)
                }
            }
        }
    }
}
#endif
