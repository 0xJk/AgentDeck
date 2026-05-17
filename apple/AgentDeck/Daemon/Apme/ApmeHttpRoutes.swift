#if os(macOS)
// ApmeHttpRoutes.swift — HTTP API routes for APME data.
// Mounted into DaemonServer's HTTPServer alongside existing routes.

import Foundation

enum ApmeHttpRoutes {
    private static let schemaVersion = "agentdeck-eval/v1"

    private static func unauthorizedResponse() -> HTTPServer.HTTPResponse {
        .json(["error": "Unauthorized — token required for APME routes"], status: 401)
    }

    private static func requireToken(_ request: HTTPServer.HTTPRequest) -> HTTPServer.HTTPResponse? {
        let token = request.queryParams["token"] ?? ""
        return AuthManager.shared.validateToken(token) ? nil : unauthorizedResponse()
    }

    private static func evalDict(_ e: ApmeEval, includeRaw: Bool = false) -> [String: Any] {
        var ed: [String: Any] = [
            "layer": e.layer,
            "metric": e.metric,
            "score": e.score,
            "createdAt": e.createdAt,
        ]
        if let v = e.rubricVer { ed["rubricVer"] = v }
        if let v = e.judgeModel { ed["judgeModel"] = v }
        if includeRaw, let v = e.raw { ed["raw"] = v }
        return ed
    }

    private static func vibeDict(_ vibe: (verdict: String, note: String?, ts: Int)?) -> [String: Any]? {
        guard let vibe else { return nil }
        var dict: [String: Any] = [
            "verdict": vibe.verdict,
            "ts": vibe.ts,
        ]
        if let note = vibe.note { dict["note"] = note }
        return dict
    }

    /// Register all /apme/* routes on the given HTTP server.
    static func register(on httpServer: HTTPServer, store: ApmeStore) async {
        // Dashboard HTML — same self-contained SPA as Node.js bridge.
        // Fetches data from /apme/* JSON endpoints (relative URLs, so port-agnostic).
        await httpServer.get("/apme") { request in
            if let denied = Self.requireToken(request) { return denied }
            return HTTPServer.HTTPResponse(
                status: 200,
                headers: ["Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store"],
                body: Data(Self.dashboardHtml.utf8)
            )
        }

        await httpServer.get("/apme/runs") { request in
            if let denied = Self.requireToken(request) { return denied }
            let limit = Int(request.queryParams["limit"] ?? "") ?? 50
            let agent = request.queryParams["agent"]

            let runs = store.listRuns(limit: limit, agentType: agent)
            let result = runs.map { run -> [String: Any] in
                let evals = store.listEvalsForRun(run.id)
                let overall = evals.first(where: { $0.layer == "llm_judge" && $0.metric == "overall" })
                let vibe = store.latestVibeForRun(run.id)
                var dict: [String: Any] = [
                    "id": run.id,
                    "sessionId": run.sessionId,
                    "agentType": run.agentType,
                    "startedAt": run.startedAt,
                ]
                if let v = run.modelId { dict["modelId"] = v }
                if let v = run.projectName { dict["projectName"] = v }
                if let v = run.taskPrompt { dict["taskPrompt"] = v }
                if let v = run.endedAt { dict["endedAt"] = v }
                if let v = run.inputTokens { dict["inputTokens"] = v }
                if let v = run.outputTokens { dict["outputTokens"] = v }
                if let v = run.costUsd { dict["costUsd"] = v }
                if let v = run.exitCode { dict["exitCode"] = v }
                if let v = run.taskCategory { dict["taskCategory"] = v }
                if let v = run.outcome { dict["outcome"] = v }
                if let v = run.compositeScore { dict["compositeScore"] = v }
                if let score = overall?.score ?? run.compositeScore { dict["overallScore"] = score }
                if let reason = ApmeRunner.layer1SkippedReason { dict["layer1SkippedReason"] = reason }
                dict["evals"] = evals.map { Self.evalDict($0) }
                if let vibe = Self.vibeDict(vibe) { dict["vibe"] = vibe }
                return dict
            }
            return .json(["schema": Self.schemaVersion, "runs": result])
        }

        // Run detail — supports both Node-compatible /apme/run/<id> and the
        // older Swift fallback /apme/run?id=<id>.
        await httpServer.get("/apme/run/*") { request in
            if let denied = Self.requireToken(request) { return denied }
            let id = String(request.path.dropFirst("/apme/run/".count))
            return Self.runDetailResponse(id: id, store: store)
        }

        await httpServer.get("/apme/run") { request in
            if let denied = Self.requireToken(request) { return denied }
            guard let id = request.queryParams["id"], !id.isEmpty else {
                return .json(["error": "missing ?id= parameter"], status: 400)
            }
            return Self.runDetailResponse(id: id, store: store)
        }

        // Single task detail — mirrors Node bridge `GET /apme/tasks/:id`.
        // Returns the task row, its evals, and the turns belonging to it.
        await httpServer.get("/apme/tasks/*") { request in
            if let denied = Self.requireToken(request) { return denied }
            let taskId = String(request.path.dropFirst("/apme/tasks/".count))
            return Self.taskDetailResponse(id: taskId, store: store)
        }

        await httpServer.get("/apme/scorecard") { request in
            if let denied = Self.requireToken(request) { return denied }
            return .json(["schema": Self.schemaVersion, "scorecards": store.scorecard()])
        }

        await httpServer.get("/apme/categories") { request in
            if let denied = Self.requireToken(request) { return denied }
            return .json(["schema": Self.schemaVersion, "categories": store.categoryScorecard()])
        }

        await httpServer.get("/apme/rubric/current") { request in
            if let denied = Self.requireToken(request) { return denied }
            guard let rubric = store.getCurrentRubric() else {
                return .json(["error": "no rubric"], status: 404)
            }
            return .json(["schema": Self.schemaVersion, "rubric": rubric])
        }

        // Phase 2: model recommendation endpoint backed by v_model_scorecard.
        // Query params: ?budget=<usd>&models=<comma-separated> (both optional)
        await httpServer.get("/apme/recommend") { request in
            if let denied = Self.requireToken(request) { return denied }
            var input = ApmeRecommendInput()
            if let b = request.queryParams["budget"], let d = Double(b) { input.budgetUsd = d }
            if let models = request.queryParams["models"], !models.isEmpty {
                input.availableModels = models.split(separator: ",").map { String($0) }
            }
            return Self.recommendResponse(store: store, input: input)
        }

        await httpServer.post("/apme/recommend") { request in
            if let denied = Self.requireToken(request) { return denied }
            var input = ApmeRecommendInput()
            if let body = request.body,
               let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any] {
                if let taskKind = json["taskKind"] as? String { input.taskKind = taskKind }
                if let budget = json["budgetUsd"] as? Double { input.budgetUsd = budget }
                if let budget = json["budgetUsd"] as? Int { input.budgetUsd = Double(budget) }
                if let latency = json["latencyBudgetMs"] as? Double { input.latencyBudgetMs = latency }
                if let latency = json["latencyBudgetMs"] as? Int { input.latencyBudgetMs = Double(latency) }
                if let preferLocal = json["preferLocal"] as? Bool { input.preferLocal = preferLocal }
                if let models = json["availableModels"] as? [String] { input.availableModels = models }
            }
            return Self.recommendResponse(store: store, input: input)
        }

        // Foundation Models judge — routes TS bridge `callFoundationModels`
        // (bridge/src/apme/runner.ts) into `ApmeJudgeFoundationModels.judge`.
        // Phase 1: no auth header — caller already reached the daemon's bound
        // 127.0.0.1 port, which is same-machine-only per App Review notes.
        //
        // Contract (matches bridge/src/apme/runner.ts callFoundationModels):
        //   Request : { "prompt": "..." }
        //   Response: { "text": "..." } | { "error": "unavailable", "reason": "..." }
        await httpServer.post("/apme/judge/foundation-models") { request in
            guard let body = request.body,
                  let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                  let prompt = json["prompt"] as? String,
                  !prompt.isEmpty else {
                return .json(["error": "bad_request", "reason": "expected { prompt: string }"], status: 400)
            }
            if !ApmeJudgeFoundationModels.isAvailable {
                return .json([
                    "error": "unavailable",
                    "reason": ApmeJudgeFoundationModels.unavailableReason,
                ])
            }
            guard let text = await ApmeJudgeFoundationModels.judge(prompt: prompt) else {
                return .json([
                    "error": "unavailable",
                    "reason": "judge returned nil (content filter, timeout, or session error)",
                ])
            }
            return .json(["text": text])
        }

        await httpServer.post("/apme/vibe") { request in
            if let denied = Self.requireToken(request) { return denied }
            guard let body = request.body,
                  let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                  let runId = json["runId"] as? String,
                  let verdict = json["verdict"] as? String,
                  ["approve", "reject", "neutral"].contains(verdict) else {
                return .json(["error": "expected { runId, verdict, note? }"], status: 400)
            }
            guard store.getRun(id: runId) != nil else {
                return .json(["error": "run not found"], status: 404)
            }
            store.insertVibe(runId: runId, verdict: verdict, note: json["note"] as? String)
            return .json(["ok": true])
        }
    }

    private static func runDetailResponse(id: String, store: ApmeStore) -> HTTPServer.HTTPResponse {
        guard !id.isEmpty else {
            return .json(["error": "missing run id"], status: 400)
        }
        guard let run = store.getRun(id: id) else {
            return .json(["error": "run not found"], status: 404)
        }

        let evals = store.listEvalsForRun(run.id)
        let steps = store.listSteps(runId: run.id)
        let rawTurns = store.listTurns(runId: run.id)
        let turns = rawTurns.map { turn -> [String: Any] in
            var row = turn
            if let turnId = turn["id"] as? String {
                row["turnEvals"] = store.listEvalsForTurn(turnId).map { evalDict($0, includeRaw: true) }
            }
            return row
        }
        let tasks = store.listTasksForRun(run.id).map { t -> [String: Any] in
            var dict = taskDict(t)
            dict["evals"] = store.listEvalsForTask(t.id).map { evalDict($0, includeRaw: true) }
            return dict
        }
        let vibe = store.latestVibeForRun(run.id)

        var runDict: [String: Any] = [
            "id": run.id,
            "session_id": run.sessionId,
            "agent_type": run.agentType,
            "started_at": run.startedAt,
        ]
        if let v = run.modelId { runDict["model_id"] = v }
        if let v = run.projectName { runDict["project_name"] = v }
        if let v = run.taskPrompt { runDict["task_prompt"] = v }
        if let v = run.endedAt { runDict["ended_at"] = v }
        if let v = run.taskCategory { runDict["task_category"] = v }
        if let v = run.outcome { runDict["outcome"] = v }
        if let v = run.outcomeConfidence { runDict["outcome_confidence"] = v }
        if let v = run.efficiencyJson { runDict["efficiency_json"] = v }
        if let v = run.compositeScore { runDict["composite_score"] = v }
        if let reason = ApmeRunner.layer1SkippedReason { runDict["layer1SkippedReason"] = reason }

        var body: [String: Any] = [
            "schema": schemaVersion,
            "run": runDict,
            "evals": evals.map { evalDict($0, includeRaw: true) },
            "steps": steps.count,
            "turns": turns,
            "tasks": tasks,
            "vibe": vibeDict(vibe) ?? NSNull(),
        ]
        if let score = evals.first(where: { $0.layer == "llm_judge" && $0.metric == "overall" })?.score
            ?? run.compositeScore {
            body["overallScore"] = score
        }
        return .json(body)
    }

    private static func taskDetailResponse(id: String, store: ApmeStore) -> HTTPServer.HTTPResponse {
        guard !id.isEmpty else {
            return .json(["error": "missing task id"], status: 400)
        }
        guard let task = store.getTask(id: id) else {
            return .json(["error": "task not found"], status: 404)
        }
        let evals = store.listEvalsForTask(id)
        let turns = store.listTurnsForTask(id)
        let body: [String: Any] = [
            "schema": schemaVersion,
            "task": taskDict(task),
            "evals": evals.map { evalDict($0, includeRaw: true) },
            "turns": turns,
            "overallScore": evals.first(where: { $0.layer == "task_judge" && $0.metric == "overall" })?.score
                ?? task.compositeScore
                ?? NSNull(),
        ]
        return .json(body)
    }

    /// Serialize ApmeTask → JSON dict using snake_case keys for Node-bridge parity.
    private static func taskDict(_ t: ApmeTask) -> [String: Any] {
        var dict: [String: Any] = [
            "id": t.id,
            "run_id": t.runId,
            "task_index": t.taskIndex,
            "boundary_signal": t.boundarySignal,
            "started_at": t.startedAt,
        ]
        if let v = t.endedAt { dict["ended_at"] = v }
        if let v = t.firstTurnIndex { dict["first_turn_index"] = v }
        if let v = t.lastTurnIndex { dict["last_turn_index"] = v }
        if let v = t.summary { dict["summary"] = v }
        if let v = t.outcome { dict["outcome"] = v }
        if let v = t.compositeScore { dict["composite_score"] = v }
        if let v = t.taskCategory { dict["task_category"] = v }
        if let v = t.notesJson { dict["notes_json"] = v }
        return dict
    }

    private static func recommendResponse(store: ApmeStore, input: ApmeRecommendInput) -> HTTPServer.HTTPResponse {
        let candidates = ApmeRecommender.recommend(store: store, input: input)
        let json = candidates.map { c -> [String: Any] in
            [
                "modelId": c.modelId,
                "agentType": c.agentType,
                "expectedScore": c.expectedScore,
                "expectedCostUsd": c.expectedCostUsd,
                "confidence": c.confidence,
                "rationale": c.rationale,
            ]
        }
        return .json(["schema": schemaVersion, "candidates": json])
    }

    /// Dashboard HTML, resolved at first access in priority order:
    ///   1. App bundle resource (`apme-dashboard.html` — shipped with App Store
    ///      build, updated at `pnpm generate-protocol` time).
    ///   2. `~/.agentdeck/apme-dashboard.html` (written by the Node.js bridge
    ///      on boot, may be newer than the bundled copy when both stacks coexist).
    ///   3. Minimal inline fallback pointing at the JSON API.
    ///
    /// This order means App Store users always get a working dashboard even
    /// when no Node bridge has ever run on the machine.
    static let dashboardHtml: String = {
        // 1. Bundled resource
        if let url = Bundle.main.url(forResource: "apme-dashboard", withExtension: "html"),
           let html = try? String(contentsOf: url, encoding: .utf8) {
            return html
        }
        // 2. Node.js bridge's write-target (newer when both stacks run)
        let path = AuthManager.agentDeckDir.appendingPathComponent("apme-dashboard.html").path
        if let html = try? String(contentsOfFile: path, encoding: .utf8) {
            return html
        }
        // 3. Minimal fallback — should not be reached in shipped builds
        return """
        <!DOCTYPE html><html><head><meta charset="utf-8">
        <title>APME Dashboard</title>
        <style>body{background:#0f172a;color:#e2e8f0;font-family:system-ui;padding:40px;text-align:center}
        a{color:#3b82f6}</style></head><body>
        <h2>APME Dashboard</h2>
        <p>Dashboard HTML resource missing from this build.</p>
        <p><a href="/apme/runs">/apme/runs</a> · <a href="/apme/scorecard">/apme/scorecard</a> · <a href="/apme/categories">/apme/categories</a></p>
        </body></html>
        """
    }()
}
#endif
