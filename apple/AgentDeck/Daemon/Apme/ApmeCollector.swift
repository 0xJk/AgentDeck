#if os(macOS)
// ApmeCollector.swift — Ingests hook events into the APME SQLite store.
// Mirror of bridge/src/apme/collector.ts for the Swift daemon.
//
// Key design: the Swift daemon receives hook POSTs from potentially multiple
// Claude Code sessions. Each session_start/session_end pair is tracked with
// an auto-generated hookSessionId. Tool events between them are attributed
// to the active session. The daemon's own sessionId is NOT used — hooks
// carry their own lifecycle.

import Foundation

@MainActor
final class ApmeCollector {
    private let store: ApmeStore

    /// Maps a hookSessionId → runId. A hookSessionId is generated per
    /// session_start and lives until session_end.
    private var sessionToRun: [String: String] = [:]

    /// The currently active hook session (most recent session_start that
    /// hasn't yet received session_end). Tool events are attributed here.
    private var activeHookSession: String?

    /// Counter for generating unique hook session IDs.
    private var hookSessionCounter = 0

    init(store: ApmeStore) {
        self.store = store
    }

    // MARK: - Hook ingestion (called from DaemonServer.handleHookEvent)

    /// Main entry point — routes every hook event to the right run.
    func handleHook(event: String, data: [String: Any]) {
        guard store.isOpen else { return }

        switch event {
        case "session_start":
            // Generate a unique session key for this Claude session.
            hookSessionCounter += 1
            let hookSessionId = "hook-\(hookSessionCounter)-\(Int(Date().timeIntervalSince1970))"
            activeHookSession = hookSessionId

            let agentType = data["agent_type"] as? String ?? "claude-code"
            let projectName = data["project_name"] as? String
            let modelId = data["model_name"] as? String

            let runId = UUID().uuidString
            let run = ApmeRun(
                id: runId,
                sessionId: hookSessionId,
                agentType: agentType,
                modelId: modelId,
                projectName: projectName,
                projectPath: nil,
                startedAt: nowMs(),
                gitBefore: nil
            )
            store.insertRun(run)
            sessionToRun[hookSessionId] = runId
            DaemonLogger.shared.debug("APME", "openRun \(runId.prefix(8)) hookSession=\(hookSessionId) agent=\(agentType)")

        case "session_end":
            guard let hookSession = activeHookSession,
                  let runId = sessionToRun.removeValue(forKey: hookSession) else { return }
            activeHookSession = nil

            store.updateRun(id: runId, fields: ["endedAt": nowMs()])

            // Classify based on accumulated steps
            let result = ApmeClassifier.classifyRun(store: store, runId: runId)
            if let signals = try? JSONEncoder().encode(result.signals),
               let json = String(data: signals, encoding: .utf8) {
                store.updateRun(id: runId, fields: [
                    "taskSignals": json,
                    "taskCategory": result.category.rawValue,
                    "taskCategorySource": "auto",
                ])
            }
            DaemonLogger.shared.debug("APME", "closeRun \(runId.prefix(8)) category=\(result.category.rawValue)")

            // Record the session_end step too
            recordStep(hookSession: hookSession, runId: runId, event: event, data: data)
            return // skip the generic recordStep below since we already handled it

        default:
            break
        }

        // Record every event as a step on the active session.
        if let hookSession = activeHookSession, let runId = sessionToRun[hookSession] {
            recordStep(hookSession: hookSession, runId: runId, event: event, data: data)

            // Lazily capture task_prompt from first user_prompt_submit
            if event == "user_prompt_submit", let prompt = data["prompt"] as? String {
                let run = store.getRun(id: runId)
                if run?.taskPrompt == nil {
                    store.updateRun(id: runId, fields: ["taskPrompt": String(prompt.prefix(8000))])
                }
            }

            // Update model when we see it
            if event == "tool_start" || event == "tool_end" {
                // model_name may be piggybacked on hook data
            }
        }
    }

    /// Update model name from state machine (called by DaemonServer when
    /// modelName changes via state_update/timeline relay, not from hooks).
    func updateModel(_ modelId: String?) {
        guard let hookSession = activeHookSession,
              let runId = sessionToRun[hookSession],
              let model = modelId else { return }
        store.updateRun(id: runId, fields: ["modelId": model])
    }

    /// Update token/cost usage (called when usage_update is received).
    func updateUsage(inputTokens: Int, outputTokens: Int, costUsd: Double?) {
        guard let hookSession = activeHookSession,
              let runId = sessionToRun[hookSession] else { return }
        var fields: [String: Any?] = [
            "inputTokens": inputTokens,
            "outputTokens": outputTokens,
        ]
        if let c = costUsd { fields["costUsd"] = c }
        store.updateRun(id: runId, fields: fields)
    }

    // MARK: - Sibling session tracking

    /// Called when a sibling session bridge registers in sessions.json.
    /// Creates a run for it so the daemon has a record even if that session
    /// doesn't POST hooks directly (e.g., it posts to its own bridge port).
    @discardableResult
    func openSiblingRun(sessionId: String, agentType: String, projectName: String?, modelId: String?) -> String {
        guard store.isOpen else { return "" }
        // Don't duplicate if a hook session already covers this
        if sessionToRun[sessionId] != nil { return sessionToRun[sessionId]! }

        let runId = UUID().uuidString
        let run = ApmeRun(
            id: runId, sessionId: sessionId, agentType: agentType,
            modelId: modelId, projectName: projectName, projectPath: nil,
            startedAt: nowMs()
        )
        store.insertRun(run)
        sessionToRun[sessionId] = runId
        return runId
    }

    func closeSiblingRun(sessionId: String) {
        guard let runId = sessionToRun.removeValue(forKey: sessionId) else { return }
        store.updateRun(id: runId, fields: ["endedAt": nowMs()])
        let result = ApmeClassifier.classifyRun(store: store, runId: runId)
        if let signals = try? JSONEncoder().encode(result.signals),
           let json = String(data: signals, encoding: .utf8) {
            store.updateRun(id: runId, fields: [
                "taskSignals": json,
                "taskCategory": result.category.rawValue,
                "taskCategorySource": "auto",
            ])
        }
    }

    // MARK: - Private

    private func recordStep(hookSession: String, runId: String, event: String, data: [String: Any]) {
        let toolName = data["tool_name"] as? String
        store.insertStep(
            runId: runId,
            ts: nowMs(),
            kind: event,
            toolName: toolName,
            payload: jsonString(data)
        )
    }

    private func nowMs() -> Int { Int(Date().timeIntervalSince1970 * 1000) }

    private func jsonString(_ dict: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let str = String(data: data, encoding: .utf8) else { return "{}" }
        return str
    }
}
#endif
