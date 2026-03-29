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

    private func sync() {
        let sessions = SessionRegistry.shared.listActive()
        let siblingPorts = Set(sessions
            .filter { $0.port != selfPort && $0.agentType != "daemon" }
            .map(\.port))

        // Subscribe to new siblings
        for port in siblingPorts where !knownPorts.contains(port) {
            subscribe(port: port)
        }

        // Unsubscribe from removed siblings
        for port in knownPorts where !siblingPorts.contains(port) {
            unsubscribe(port: port)
        }

        knownPorts = siblingPorts
    }

    private func subscribe(port: Int) {
        let url = URL(string: "ws://127.0.0.1:\(port)")!
        let task = URLSession.shared.webSocketTask(with: url)
        subscriptions[port] = task
        task.resume()
        receiveLoop(port: port, task: task)
        DaemonLogger.shared.debug("TimelineRelay", "Subscribed to port \(port)")
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
                    // Reconnect after delay
                    try? await Task.sleep(for: .seconds(5))
                    await self.subscribe(port: port)
                }
            }
        }
    }
}
#endif
