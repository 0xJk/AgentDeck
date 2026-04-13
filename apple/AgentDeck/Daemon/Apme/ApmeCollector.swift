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

    /// Optional APME runner — the collector fires turn-level evals through it
    /// after response capture. Set by DaemonServer during init. Left nil when
    /// Phase 1 wiring isn't complete (e.g. during tests), in which case
    /// `setTurnResponse` still records the response text but doesn't trigger
    /// a judge.
    var runner: ApmeRunner?

    /// Maps a hookSessionId → runId. A hookSessionId is generated per
    /// session_start and lives until session_end.
    private var sessionToRun: [String: String] = [:]

    /// The currently active hook session (most recent session_start that
    /// hasn't yet received session_end). Tool events are attributed here.
    private var activeHookSession: String?

    /// Counter for generating unique hook session IDs.
    private var hookSessionCounter = 0

    /// Active turn tracking per hook session.
    private struct ActiveTurn {
        let id: String
        let runId: String
        var index: Int
        let startedAt: Int
        var toolCalls: Int = 0
        var filesModified: Int = 0
        var filesCreated: Int = 0
    }
    private var activeTurn: ActiveTurn?
    /// Most recently closed turn (one per hookSession) — survives `closeTurn()`
    /// so late-arriving response text can still land on the right turn.
    /// Maps runId → turnId.
    private var lastClosedTurnByRun: [String: String] = [:]
    private var turnCounter = 0

    init(store: ApmeStore) {
        self.store = store
    }

    // MARK: - Hook ingestion (called from DaemonServer.handleHookEvent)

    /// Main entry point — routes every hook event to the right run.
    func handleHook(event: String, data: [String: Any]) {
        guard store.isOpen else { return }

        switch event.lowercased() {
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
            closeTurn(runId: runId) // close last turn

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

            // ── Turn management ──
            if event.lowercased() == "user_prompt_submit" || event == "UserPromptSubmit" {
                // Claude Code sends { message: { content: "..." } }, legacy sends { prompt: "..." }
                let prompt = data["prompt"] as? String
                    ?? (data["message"] as? [String: Any])?["content"] as? String
                // Close previous turn
                closeTurn(runId: runId)
                // Open new turn
                turnCounter += 1
                let turnId = UUID().uuidString
                activeTurn = ActiveTurn(id: turnId, runId: runId, index: turnCounter - 1, startedAt: nowMs())
                store.insertTurn(id: turnId, runId: runId, turnIndex: turnCounter - 1, prompt: prompt, startedAt: nowMs())

                // Set run's task_prompt from first prompt
                let run = store.getRun(id: runId)
                if run?.taskPrompt == nil, let p = prompt {
                    store.updateRun(id: runId, fields: ["taskPrompt": String(p.prefix(8000))])
                }
            }

            // Track tool calls on active turn
            if (event.lowercased() == "tool_start" || event == "PreToolUse" || event == "tool_start"), var turn = activeTurn {
                turn.toolCalls += 1
                let toolName = data["tool_name"] as? String
                if toolName == "Edit" { turn.filesModified += 1 }
                if toolName == "Write" { turn.filesCreated += 1 }
                activeTurn = turn
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

    private func closeTurn(runId: String) {
        guard let turn = activeTurn else { return }
        activeTurn = nil
        lastClosedTurnByRun[runId] = turn.id
        store.updateTurn(id: turn.id, fields: [
            "endedAt": nowMs(),
            "toolCalls": turn.toolCalls,
            "filesModified": turn.filesModified,
            "filesCreated": turn.filesCreated,
        ])
    }

    // MARK: - Turn response capture (mid-session eval entry point)

    /// Categories where the LLM judge is triggered per-turn (non-code).
    /// Mirrors the NON_CODE set in bridge/src/apme/index.ts.
    private static let nonCodeCategories: Set<String> = [
        "conversation", "planning", "research", "review",
    ]

    /// Record the agent's response on the active turn (or the most recently
    /// closed turn if close already fired) and — if this is the first response
    /// for the run — classify the run inline so a turn_judge eval can fire
    /// immediately. Mirrors the TS `index.ts` fix from commit e76325f7 and is
    /// the Swift side of the category-aware pipeline.
    ///
    /// Returns the turnId that was updated, or nil if no turn is in scope.
    @discardableResult
    func setTurnResponse(_ response: String, runId overrideRunId: String? = nil) -> String? {
        guard store.isOpen else { return nil }
        guard !response.isEmpty else { return nil }

        // Resolve target turn.
        let runId: String?
        let turnId: String?
        if let turn = activeTurn {
            runId = turn.runId
            turnId = turn.id
        } else if let rid = overrideRunId, let tid = lastClosedTurnByRun[rid] {
            runId = rid
            turnId = tid
        } else if let hs = activeHookSession, let rid = sessionToRun[hs], let tid = lastClosedTurnByRun[rid] {
            runId = rid
            turnId = tid
        } else {
            return nil
        }
        guard let runId, let turnId else { return nil }

        // Persist response (capped to 10k chars to match TS runner.ts).
        let clamped = String(response.prefix(10_000))
        store.updateTurn(id: turnId, fields: ["response": clamped])
        DaemonLogger.shared.debug("APME", "setTurnResponse turn=\(turnId.prefix(8)) respLen=\(clamped.count)")

        // Mid-session classification: the TS bug this fixes was that the
        // classifier only ran on closeRun(), so run.taskCategory was nil at
        // turn-eval time and the turn_judge layer never fired. Inline
        // rule-based classification closes that race.
        guard var run = store.getRun(id: runId) else { return turnId }
        var category = run.taskCategory
        if category == nil {
            let result = ApmeClassifier.classifyRun(store: store, runId: runId)
            let cat = result.category.rawValue
            if cat != "unknown" {
                category = cat
                if let data = try? JSONEncoder().encode(result.signals),
                   let json = String(data: data, encoding: .utf8) {
                    store.updateRun(id: runId, fields: [
                        "taskCategory": cat,
                        "taskSignals": json,
                        "taskCategorySource": "rule",
                    ])
                } else {
                    store.updateRun(id: runId, fields: [
                        "taskCategory": cat,
                        "taskCategorySource": "rule",
                    ])
                }
                run.taskCategory = cat
                DaemonLogger.shared.debug("APME", "mid-session classify runId=\(runId.prefix(8)) → \(cat)")
            }
        }

        // Stamp turn with category — turn-level analytics aggregation depends on this.
        if let category {
            store.updateTurn(id: turnId, fields: ["taskCategory": category])
        }

        // Fire a category-aware turn_judge for non-code categories.
        if let category, Self.nonCodeCategories.contains(category) {
            runner?.enqueueTurn(runId: runId, turnId: turnId, category: category)
        }

        return turnId
    }

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
