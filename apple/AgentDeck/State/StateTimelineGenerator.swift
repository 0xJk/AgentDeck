// StateTimelineGenerator.swift — Local timeline from state transitions
// Ported from android StateTimelineGenerator.kt
// Generates timeline entries when bridge doesn't provide them (daemon IDLE, etc.)

import Foundation

final class StateTimelineGenerator {
    private var previousState: AgentConnectionState = .disconnected
    private var lastToolName: String?
    private var lastToolTime: TimeInterval = 0
    private var lastAgentType: String?
    private var chatStartTime: TimeInterval?
    private var lastUserPrompt: String?
    private var lastChatPrompt: String?

    /// When bridge provides rich timeline, suppress local generation
    var receivingBridgeTimeline = false

    private static let toolDedupMs: TimeInterval = 2.0

    private let store: TimelineStore

    init(store: TimelineStore) {
        self.store = store
    }

    func onStateUpdate(
        newState: AgentConnectionState,
        agentType: String?,
        currentTool: String?,
        toolInput: String?,
        question: String?,
        projectName: String? = nil,
        sessionId: String? = nil
    ) {
        if receivingBridgeTimeline { return }

        let now = Date().timeIntervalSince1970 * 1000 // ms
        if let at = agentType { lastAgentType = at }
        let agent = lastAgentType
        // projectName / sessionId are attribution fields — always forwarded
        // from the state_update event. Nil is legitimate (single-session
        // CLI mode, gateway-only mode, etc.) and rendered without a prefix.
        let proj = projectName
        let sid = sessionId

        // State transitions
        switch (previousState, newState) {
        case (.idle, .processing):
            // Chat started
            chatStartTime = now
            let prompt = lastUserPrompt
            lastUserPrompt = nil
            lastChatPrompt = prompt
            let raw: String
            let detail: String?
            if let p = prompt, !p.isEmpty {
                raw = p.count > 500 ? String(p.prefix(497)) + "..." : p
                detail = p.count > 100 ? (p.count > 1000 ? String(p.prefix(1000)) + "..." : p) : nil
            } else {
                raw = "Prompt sent"
                detail = nil
            }
            store.addEntry(TimelineEntry(ts: now, type: .chatStart, raw: raw, detail: detail, agentType: agent, projectName: proj, sessionId: sid, startedAt: now))

        case (_, .awaitingPermission) where previousState != .awaitingPermission:
            let q = question ?? "Permission requested"
            store.addEntry(TimelineEntry(ts: now, type: .toolRequest, raw: q, agentType: agent, projectName: proj, sessionId: sid))

        case (.awaitingPermission, .processing),
             (.awaitingOption, .processing),
             (.awaitingDiff, .processing):
            store.addEntry(TimelineEntry(ts: now, type: .chatStart, raw: "Resumed", agentType: agent, projectName: proj, sessionId: sid))

        case (.processing, .idle):
            // Chat completed
            let duration = chatStartTime.map { formatDurationCompact(now - $0) }
            let prompt = lastChatPrompt
            lastChatPrompt = nil
            let topicHint: String? = prompt.flatMap { p in
                let firstLine = p.components(separatedBy: .newlines).first?.trimmingCharacters(in: .whitespaces) ?? ""
                if firstLine.count < 5 { return nil }
                return firstLine.count > 80 ? String(firstLine.prefix(77)) + "..." : firstLine
            }
            let label = topicHint ?? "Completed"
            let summary = duration.map { "\(label) · \($0)" } ?? label
            let detail = prompt.map { p in
                "Prompt: \(p.count > 200 ? String(p.prefix(200)) + "..." : p)"
            }
            let startedAt = chatStartTime
            chatStartTime = nil
            store.addEntry(TimelineEntry(ts: now, type: .chatEnd, raw: summary, detail: detail, agentType: agent, projectName: proj, sessionId: sid, startedAt: startedAt, endedAt: now))

        case (.disconnected, _) where newState != .disconnected:
            store.addEntry(TimelineEntry(ts: now, type: .chatStart, raw: "Connected", agentType: agent, projectName: proj, sessionId: sid))

        default:
            break
        }

        // Tool tracking during PROCESSING (2s dedup)
        if newState == .processing, let tool = currentTool {
            let timeSinceLast = now - lastToolTime
            if tool != lastToolName || timeSinceLast > Self.toolDedupMs * 1000 {
                let summary = formatToolSummary(tool, toolInput)
                store.addEntry(TimelineEntry(ts: now, type: .toolRequest, raw: summary, agentType: agent, projectName: proj, sessionId: sid))
                lastToolName = tool
                lastToolTime = now
            }
        }

        previousState = newState
    }

    func onDisconnected() {
        receivingBridgeTimeline = false
        let now = Date().timeIntervalSince1970 * 1000
        if previousState != .disconnected {
            store.addEntry(TimelineEntry(ts: now, type: .error, raw: "Disconnected", agentType: lastAgentType))
        }
        previousState = .disconnected
        lastToolName = nil
        chatStartTime = nil
        lastUserPrompt = nil
        lastChatPrompt = nil
    }

    func setLastUserPrompt(_ text: String) {
        lastUserPrompt = text
        lastChatPrompt = text
    }

    // MARK: - Helpers

    private func formatToolSummary(_ toolName: String, _ toolInput: String?) -> String {
        guard let input = toolInput else { return toolName }
        let trimmed = input.trimmingCharacters(in: .whitespaces)
        let display: String
        if trimmed.contains("/") && !trimmed.contains(" ") {
            // Abbreviate path to last 2 segments
            let parts = trimmed.components(separatedBy: "/")
            display = parts.count > 2 ? parts.suffix(2).joined(separator: "/") : trimmed
        } else {
            let firstLine = trimmed.components(separatedBy: .newlines).first ?? trimmed
            display = String(firstLine.prefix(100))
        }
        return display.isEmpty ? toolName : "\(toolName) \(display)"
    }

    private func formatDurationCompact(_ ms: TimeInterval) -> String {
        let seconds = Int(ms / 1000)
        if seconds < 60 { return "\(seconds)s" }
        let minutes = seconds / 60
        let secs = seconds % 60
        return "\(minutes)m\(secs)s"
    }
}
