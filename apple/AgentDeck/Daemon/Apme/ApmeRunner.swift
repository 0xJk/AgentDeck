#if os(macOS)
// ApmeRunner.swift — Swift port of bridge/src/apme/runner.ts.
//
// Phase 0 scope (App Store MVP):
//   - Layer 2 (LLM judge) only. Layer 1 (deterministic pnpm/xcodebuild/git)
//     is graceful-disabled under App Sandbox because it requires subprocess
//     spawn (`Process`/`posix_spawn`) which the sandbox denies.
//     `isLayer1Available` below is the single source of truth for that gate.
//     When Layer 1 is skipped, the HTTP/WS response payload carries
//     `layer1SkippedReason` so the dashboard + Swift Settings UI can surface
//     "LLM-only evaluation" instead of silently omitting scores.
//   - A future phase will port the Layer 1 signals (files touched, tests
//     passed/failed, lines changed) into pure Swift using LibGit2 + the
//     Xcode results bundle reader. Until then Layer 1 runs nowhere.
//   - Turn-level eval via `enqueueTurn(runId:turnId:category:)` — this is the
//     path the category-aware rubric pipeline flows through. When the user
//     asks a conversation/research/planning/review question and the Swift
//     daemon captures the response, this method fires the judge and writes
//     `turn_judge` rows scored on the category's specific axes (accuracy,
//     helpfulness, thoroughness, etc.).
//   - Run-level eval via `enqueue(runId:)` is a pass-through: picks the
//     category rubric, calls the judge, writes `llm_judge` rows on the run.
//
// Parity notes with TS runner.ts (commit e76325f7):
//   - `parseJudgeJson` accepts ANY numeric field except a reserved set
//     {reasoning, done, missed, notes}. This is critical — the hardcoded
//     whitelist bug in the TS version dropped conversation rubric axes
//     (accuracy/helpfulness/conciseness) entirely until the fix.
//   - clamp01 rescales 0..10 input to 0..1 by dividing by 10.
//   - Category rubric lookup via `store.getCurrentRubric(purpose:)` with
//     fallback to `general`.

import Foundation

// MARK: - Public types

struct ApmeEvalJobResult {
    let runId: String
    /// Set when this result came from a turn-level eval.
    let turnId: String?
    let layer1Ran: Bool
    let layer2Ran: Bool
    let overall: Double?
    /// Machine-readable reason Layer 1 was skipped for this result, or `nil`
    /// when Layer 1 either ran or wasn't expected to.
    ///
    /// Current known values:
    ///   - "sandbox" — subprocess spawn blocked by App Sandbox (App Store build).
    ///   - "not_implemented" — Swift Layer 1 port not yet written.
    ///
    /// Shipped in the `apme_eval` WS event + HTTP payloads so the dashboard
    /// can render an "LLM-only" badge when present.
    var layer1SkippedReason: String? = nil
}

/// Parsed judge output.
struct ApmeParsedJudge {
    /// All numeric axes from the JSON response. Must include `overall` or
    /// the parse returns nil.
    let scores: [String: Double]
    let reasoning: String
    let done: [String]?
    let missed: [String]?
}

// MARK: - Runner

actor ApmeRunner {
    private let store: ApmeStore
    private var config: ApmeConfig
    /// Listeners notified after each successful eval. DaemonServer registers
    /// one to broadcast `apmeEval` WebSocket events and append `eval_result`
    /// timeline entries.
    private var listeners: [@Sendable (ApmeEvalJobResult) -> Void] = []

    // MARK: - Layer 1 availability gate

    /// Single source of truth: can Layer 1 (deterministic pnpm/xcodebuild/git)
    /// run in the current process?
    ///
    /// Currently returns `false` everywhere because (a) inside App Sandbox
    /// subprocess spawn is denied, and (b) the Swift port of the TS Layer 1
    /// signal extractors in `bridge/src/apme/runner.ts` hasn't been written
    /// yet. Phase 2+ will flip this to a runtime-computed value once the
    /// LibGit2 + results-bundle port lands.
    ///
    /// Gating on this lets callers produce a stable `layer1SkippedReason` so
    /// the dashboard + Settings UI can render "LLM-only evaluation" instead
    /// of looking broken when Layer 1 rows never appear.
    static var isLayer1Available: Bool {
        // TODO(phase2): replace with `!AgentDeckRuntime.isSandboxed && swiftLayer1Implemented`
        //               once the Swift Layer 1 port lands.
        return false
    }

    /// Machine-readable reason Layer 1 was skipped for this process.
    /// Returns `nil` when Layer 1 is available. Used to tag eval results
    /// shipped over WS/HTTP so the UI can surface the gap.
    static var layer1SkippedReason: String? {
        if isLayer1Available { return nil }
        if AgentDeckRuntime.isSandboxed { return "sandbox" }
        // Outside sandbox we're still skipping Layer 1 until the Swift port
        // lands. Label it distinct from "sandbox" so future dashboards can
        // tell a user-facing "App Store build" story apart from an internal
        // "not yet implemented" one.
        return "not_implemented"
    }

    init(store: ApmeStore, config: ApmeConfig = ApmeSettings.load()) {
        self.store = store
        self.config = config
    }

    /// Update config (e.g. after settings UI change in Phase 2).
    func setConfig(_ cfg: ApmeConfig) { self.config = cfg }

    /// Register a result listener. The closure must be `@Sendable` because
    /// listeners are invoked from within the actor and dispatched across
    /// arbitrary tasks.
    func onResult(_ handler: @Sendable @escaping (ApmeEvalJobResult) -> Void) {
        listeners.append(handler)
    }

    // MARK: - Turn-level eval

    /// Fire a category-aware judge on a single completed turn.
    /// Fire-and-forget — runs on a detached Task so callers (the collector's
    /// mid-session response handler) don't block.
    nonisolated func enqueueTurn(runId: String, turnId: String, category: String) {
        Task.detached { [weak self] in
            await self?.runTurnEval(runId: runId, turnId: turnId, category: category)
        }
    }

    private func runTurnEval(runId: String, turnId: String, category: String) async {
        guard config.enabled else { return }

        guard let turn = store.getTurn(id: turnId) else { return }
        let prompt = (turn["prompt"] as? String) ?? ""
        let response = (turn["response"] as? String) ?? ""
        if prompt.isEmpty && response.isEmpty { return }
        // Skip turns the agent answered with tool calls only (or nothing) —
        // the rubric prompt can't score "silence" meaningfully. The collector
        // tags turns.efficiency_json.response_kind on setTurnResponse so we
        // can distinguish these from genuine short answers like "4".
        let kind = Self.readResponseKind(turn: turn)
        if kind == "tool_only" || kind == "empty" {
            DaemonLogger.shared.debug("APME", "runTurnEval skip turn=\(turnId.prefix(8)) kind=\(kind)")
            return
        }

        // Select category rubric, fall back to conversation (the closest
        // non-code rubric) if the specific category rubric is missing.
        let rubric = store.getCurrentRubric(purpose: category)
            ?? store.getCurrentRubric(purpose: "conversation")
        guard let rubric = rubric,
              let rubricPrompt = rubric["prompt"] as? String
        else { return }

        let judgePrompt = Self.buildTurnJudgePrompt(
            rubricPrompt: rubricPrompt,
            category: category,
            userPrompt: prompt,
            agentResponse: response
        )

        guard let judgeText = await callJudge(prompt: judgePrompt) else {
            DaemonLogger.shared.debug("APME", "turn judge returned nil for turn=\(turnId.prefix(8)) category=\(category)")
            return
        }
        guard let parsed = Self.parseJudgeJson(judgeText) else {
            DaemonLogger.shared.debug("APME", "turn judge unparseable for turn=\(turnId.prefix(8))")
            return
        }

        let now = Int(Date().timeIntervalSince1970 * 1000)
        let rubricVer = rubric["version"] as? Int
        let judgeModel = self.judgeModelLabel

        for (axis, score) in parsed.scores {
            var raw: String? = nil
            if axis == "overall" {
                let meta: [String: Any] = [
                    "reasoning": parsed.reasoning,
                    "done": parsed.done ?? [],
                    "missed": parsed.missed ?? [],
                ]
                if let data = try? JSONSerialization.data(withJSONObject: meta),
                   let s = String(data: data, encoding: .utf8) {
                    raw = s
                }
            }
            let eval = ApmeEval(
                id: 0,
                runId: runId,
                layer: "turn_judge",
                metric: axis,
                score: score,
                raw: raw,
                rubricVer: rubricVer,
                judgeModel: judgeModel,
                createdAt: now
            )
            store.insertEvalForTurn(eval, turnId: turnId)
        }

        let overall = parsed.scores["overall"]
        DaemonLogger.shared.debug("APME", "turn eval \(turnId.prefix(8)): overall=\(overall ?? -1)")
        let result = ApmeEvalJobResult(
            runId: runId,
            turnId: turnId,
            layer1Ran: false,
            layer2Ran: true,
            overall: overall,
            // Turn-level evals never ran Layer 1 in any build, but label the
            // reason anyway so downstream consumers don't have to branch on
            // "turn vs run" to decide if Layer 1 was applicable.
            layer1SkippedReason: Self.layer1SkippedReason
        )
        for listener in listeners { listener(result) }
    }

    // MARK: - Run-level eval (layer 2 only in Phase 1)

    /// Enqueue a run-level eval. Phase 1 calls the judge against the run's
    /// category rubric using its accumulated turns as context (no git diff,
    /// no deterministic results).
    nonisolated func enqueue(runId: String) {
        Task.detached { [weak self] in
            await self?.runOne(runId: runId)
        }
    }

    private func runOne(runId: String) async {
        guard config.enabled else { return }
        guard let run = store.getRun(id: runId) else { return }

        // Phase 0: Layer 1 graceful-disabled (see `isLayer1Available` above —
        // subprocess spawn blocked by App Sandbox). Gate Layer 2 on the
        // sampling config but bypass `onlyWhenDisagreement` since there's no
        // deterministic signal to disagree with. The result payload carries
        // `layer1SkippedReason` so the dashboard can render an "LLM-only
        // evaluation" badge instead of looking broken.
        if !ApmeSettings.shouldJudge(config.judge, deterministicPassed: nil) {
            return
        }

        let category = run.taskCategory ?? "general"
        let rubric = store.getCurrentRubric(purpose: category)
            ?? store.getCurrentRubric(purpose: "general")
        guard let rubric = rubric,
              let rubricPrompt = rubric["prompt"] as? String
        else { return }

        let judgePrompt = Self.buildRunJudgePrompt(
            rubricPrompt: rubricPrompt,
            run: run,
            store: store
        )

        guard let judgeText = await callJudge(prompt: judgePrompt) else { return }
        guard let parsed = Self.parseJudgeJson(judgeText) else { return }

        let now = Int(Date().timeIntervalSince1970 * 1000)
        let rubricVer = rubric["version"] as? Int
        let judgeModel = self.judgeModelLabel
        for (axis, score) in parsed.scores {
            var raw: String? = nil
            if axis == "overall" {
                let meta: [String: Any] = [
                    "reasoning": parsed.reasoning,
                    "done": parsed.done ?? [],
                    "missed": parsed.missed ?? [],
                ]
                if let data = try? JSONSerialization.data(withJSONObject: meta),
                   let s = String(data: data, encoding: .utf8) {
                    raw = s
                }
            }
            let eval = ApmeEval(
                id: 0,
                runId: runId,
                layer: "llm_judge",
                metric: axis,
                score: score,
                raw: raw,
                rubricVer: rubricVer,
                judgeModel: judgeModel,
                createdAt: now
            )
            store.insertEval(eval)
        }

        let overall = parsed.scores["overall"]
        let result = ApmeEvalJobResult(
            runId: runId,
            turnId: nil,
            layer1Ran: false,
            layer2Ran: true,
            overall: overall
        )
        for listener in listeners { listener(result) }
    }

    // MARK: - Judge dispatch

    /// Route to the configured backend. Phase 2 wires MLX + API adapters
    /// alongside Foundation Models. Per feedback_cost_sensitive_defaults
    /// memory, never silently fall back from a paid/local backend to the
    /// free on-device one — if the user picked MLX and it's offline, the
    /// eval is skipped so the user notices, rather than paying a mental
    /// cost wondering why "their" model didn't run.
    ///
    /// `openclaw` remains a round-trip compatibility stub (settings.json
    /// can round-trip it but the adapter isn't wired yet). It degrades to
    /// Foundation Models until Phase 3.
    private func callJudge(prompt: String) async -> String? {
        switch config.judge.backend {
        case .foundationModels:
            return await ApmeJudgeFoundationModels.judge(prompt: prompt)
        case .mlx:
            return await ApmeJudgeMlx.judge(prompt: prompt, config: config.judge)
        case .api:
            return await ApmeJudgeApi.judge(prompt: prompt, config: config.judge)
        case .openclaw:
            DaemonLogger.shared.debug("APME", "openclaw backend not wired, degrading to foundationModels")
            return await ApmeJudgeFoundationModels.judge(prompt: prompt)
        }
    }

    /// Judge model label to persist on the eval row. Matches `callJudge`
    /// dispatch so the `evals.judge_model` column correctly identifies
    /// which backend produced each row.
    private var judgeModelLabel: String {
        switch config.judge.backend {
        case .foundationModels: return ApmeJudgeFoundationModels.judgeModelLabel
        case .mlx:              return ApmeJudgeMlx.judgeModelLabel
        case .api:              return ApmeJudgeApi.judgeModelLabel
        case .openclaw:         return "openclaw:\(config.judge.model)"
        }
    }

    // MARK: - Response-kind helper (parity with TS runner.ts readResponseKind)

    /// Inspect `turns.efficiency_json.response_kind` written by the collector on
    /// `setTurnResponse`. Falls back to heuristic classification when the tag is
    /// missing (older rows or third-party callers).
    ///
    /// Returned values: "text" | "tool_only" | "empty" — the runner skips judge
    /// for anything other than "text".
    static func readResponseKind(turn: [String: Any]) -> String {
        if let raw = turn["efficiency_json"] as? String,
           !raw.isEmpty,
           let data = raw.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let k = obj["response_kind"] as? String,
           ["text", "tool_only", "empty"].contains(k) {
            return k
        }
        let response = ((turn["response"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let toolCalls = (turn["tool_calls"] as? Int) ?? 0
        if !response.isEmpty { return "text" }
        return toolCalls > 0 ? "tool_only" : "empty"
    }

    // MARK: - Prompt builders

    static func buildTurnJudgePrompt(
        rubricPrompt: String,
        category: String,
        userPrompt: String,
        agentResponse: String
    ) -> String {
        let clampedPrompt = String(userPrompt.prefix(2000))
        let clampedResponse = String(agentResponse.prefix(4000))
        return [
            rubricPrompt,
            "",
            "--- TURN CONTEXT ---",
            "task_category: \(category)",
            "",
            "--- USER PROMPT ---",
            clampedPrompt.isEmpty ? "(not captured)" : clampedPrompt,
            "",
            "--- AGENT RESPONSE ---",
            clampedResponse.isEmpty ? "(not captured)" : clampedResponse,
            "",
            "Respond with strict JSON only.",
        ].joined(separator: "\n")
    }

    static func buildRunJudgePrompt(
        rubricPrompt: String,
        run: ApmeRun,
        store: ApmeStore
    ) -> String {
        let task = String((run.taskPrompt ?? "").prefix(4000))
        let isNonCode = run.taskCategory.map { ["conversation", "planning", "research", "review"].contains($0) } ?? false

        var sections: [String] = [
            rubricPrompt,
            "",
            "--- RUN CONTEXT ---",
            "agent_type: \(run.agentType)",
            "model: \(run.modelId ?? "unknown")",
            "project: \(run.projectName ?? "unknown")",
            "task_category: \(run.taskCategory ?? "unknown")",
            "deterministic_checks: unknown",
            "",
            "--- TASK PROMPT ---",
            task.isEmpty ? "(not captured)" : task,
        ]

        if isNonCode {
            sections.append("")
            sections.append("--- CONVERSATION ---")
            let turns = store.listTurns(runId: run.id).prefix(10)
            for t in turns {
                let idx = t["turn_index"] as? Int ?? 0
                let prompt = ((t["prompt"] as? String) ?? "").prefix(2000)
                let response = ((t["response"] as? String) ?? "").prefix(3000)
                sections.append("[Turn \(idx)] User: \(prompt)")
                if !response.isEmpty { sections.append("Agent: \(response)") }
            }
        } else {
            // Phase 1: no diff collection (sandbox). Leave a placeholder so
            // the rubric knows there's no artifact to review.
            sections.append("")
            sections.append("--- DIFF (truncated) ---")
            sections.append("(diff not provided)")
        }

        sections.append("")
        sections.append("Respond with strict JSON only.")
        return sections.joined(separator: "\n")
    }

    // MARK: - parseJudgeJson (parity with runner.ts post-e76325f7)

    /// Reserved JSON fields that are NOT numeric axes.
    /// Must match the TS `RESERVED` set in runner.ts exactly.
    private static let reservedFields: Set<String> = ["reasoning", "done", "missed", "notes"]

    /// Parse the judge's JSON response into scores + metadata.
    ///
    /// Robustness:
    ///   - Extracts the first `{...}` block (handles code-fence wrapping and
    ///     prose prefixes that models sometimes emit even at temperature=0).
    ///   - Accepts ANY numeric field except the reserved set — this is the
    ///     critical fix that makes category rubric axes (accuracy, thoroughness,
    ///     etc.) actually land in the evals table.
    ///   - Rescales 0..10 input to 0..1 when max > 1 (models occasionally
    ///     ignore the "float in [0,1]" instruction).
    ///   - Requires an `overall` score — returns nil otherwise.
    static func parseJudgeJson(_ text: String) -> ApmeParsedJudge? {
        // Grab first {...} block via a regex that matches the outermost braces.
        guard let jsonBlock = extractFirstJsonBlock(text) else { return nil }
        guard let data = jsonBlock.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }

        var scores: [String: Double] = [:]
        for (key, value) in obj {
            if reservedFields.contains(key) { continue }
            if let num = value as? Double {
                scores[key] = Self.clamp01(num)
            } else if let num = value as? Int {
                scores[key] = Self.clamp01(Double(num))
            }
            // Non-numeric fields (strings, arrays, objects) are ignored.
        }
        guard scores["overall"] != nil else { return nil }

        let reasoning = (obj["reasoning"] as? String) ?? ""
        let done = (obj["done"] as? [Any])?.compactMap { $0 as? String }
        let missed = (obj["missed"] as? [Any])?.compactMap { $0 as? String }

        return ApmeParsedJudge(
            scores: scores,
            reasoning: reasoning,
            done: done,
            missed: missed
        )
    }

    /// Extract the first balanced `{...}` block from arbitrary text.
    /// Handles the common case of models wrapping JSON in ```json fences
    /// or adding "Here is the JSON:" prefixes.
    private static func extractFirstJsonBlock(_ text: String) -> String? {
        guard let firstBrace = text.firstIndex(of: "{") else { return nil }
        var depth = 0
        var i = firstBrace
        var inString = false
        var escaped = false
        while i < text.endIndex {
            let c = text[i]
            if escaped {
                escaped = false
            } else if c == "\\" && inString {
                escaped = true
            } else if c == "\"" {
                inString.toggle()
            } else if !inString {
                if c == "{" { depth += 1 }
                else if c == "}" {
                    depth -= 1
                    if depth == 0 {
                        return String(text[firstBrace...i])
                    }
                }
            }
            i = text.index(after: i)
        }
        return nil
    }

    /// Clamp a score to [0,1], rescaling 0..10 inputs by /10 when max > 1.
    /// Matches TS `clamp01` in runner.ts exactly.
    static func clamp01(_ n: Double) -> Double {
        var v = n
        if v > 1 && v <= 10 { v = v / 10 }
        if v > 1 { v = 1 }
        if v < 0 { v = 0 }
        return v
    }
}
#endif
