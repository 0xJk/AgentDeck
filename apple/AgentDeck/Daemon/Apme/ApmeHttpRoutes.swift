#if os(macOS)
// ApmeHttpRoutes.swift — HTTP API routes for APME data.
// Mounted into DaemonServer's HTTPServer alongside existing routes.

import Foundation

enum ApmeHttpRoutes {
    /// Register all /apme/* routes on the given HTTP server.
    static func register(on httpServer: HTTPServer, store: ApmeStore) async {
        // Dashboard HTML — same self-contained SPA as Node.js bridge.
        // Fetches data from /apme/* JSON endpoints (relative URLs, so port-agnostic).
        await httpServer.get("/apme") { _ in
            HTTPServer.HTTPResponse(
                status: 200,
                headers: ["Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store"],
                body: Data(Self.dashboardHtml.utf8)
            )
        }

        await httpServer.get("/apme/runs") { request in
            let limit = Int(request.queryParams["limit"] ?? "") ?? 50
            let agent = request.queryParams["agent"]

            let runs = store.listRuns(limit: limit, agentType: agent)
            let result = runs.map { run -> [String: Any] in
                let evals = store.listEvalsForRun(run.id)
                let overall = evals.first(where: { $0.layer == "llm_judge" && $0.metric == "overall" })
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
                dict["overallScore"] = overall?.score ?? run.compositeScore as Any
                dict["evals"] = evals.map { e -> [String: Any] in
                    var ed: [String: Any] = ["layer": e.layer, "metric": e.metric, "score": e.score, "createdAt": e.createdAt]
                    if let v = e.judgeModel { ed["judgeModel"] = v }
                    return ed
                }
                return dict
            }
            return .json(["runs": result])
        }

        // Run detail — uses query param ?id= because HTTPServer only does exact path match.
        // Dashboard JS tries /apme/run/<id> first (Node.js), falls back to /apme/run?id=<id> (Swift).
        await httpServer.get("/apme/run") { request in
            guard let id = request.queryParams["id"], !id.isEmpty else {
                return .json(["error": "missing ?id= parameter"], status: 400)
            }
            guard let run = store.getRun(id: id) else {
                return .json(["error": "run not found"], status: 404)
            }
            let evals = store.listEvalsForRun(run.id)
            let steps = store.listSteps(runId: run.id)
            let turns = store.listTurns(runId: run.id)
            var runDict: [String: Any] = [
                "id": run.id, "session_id": run.sessionId, "agent_type": run.agentType,
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
            let evalsArr = evals.map { e -> [String: Any] in
                var ed: [String: Any] = ["layer": e.layer, "metric": e.metric, "score": e.score, "createdAt": e.createdAt]
                if let v = e.raw { ed["raw"] = v }
                if let v = e.judgeModel { ed["judgeModel"] = v }
                return ed
            }
            return .json(["run": runDict, "evals": evalsArr, "steps": steps.count, "turns": turns, "vibe": NSNull()])
        }

        await httpServer.get("/apme/scorecard") { _ in
            return .json(["scorecards": store.scorecard()])
        }

        await httpServer.get("/apme/categories") { _ in
            return .json(["categories": store.categoryScorecard()])
        }

        await httpServer.get("/apme/rubric/current") { _ in
            guard let rubric = store.getCurrentRubric() else {
                return .json(["error": "no rubric"], status: 404)
            }
            return .json(["rubric": rubric])
        }

        await httpServer.post("/apme/vibe") { request in
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

        await httpServer.get("/apme/categories") { _ in
            return .json(["categories": store.categoryScorecard()])
        }
    }

    // The dashboard HTML is served from the Node.js build output at runtime.
    // If unavailable, serve a redirect hint.
    static let dashboardHtml: String = {
        // Try to load from ~/.agentdeck/apme-dashboard.html (generated by Node.js build)
        let path = AuthManager.agentDeckDir.appendingPathComponent("apme-dashboard.html").path
        if let html = try? String(contentsOfFile: path, encoding: .utf8) {
            return html
        }
        // Fallback: minimal redirect page pointing at the JSON API
        return """
        <!DOCTYPE html><html><head><meta charset="utf-8">
        <title>APME Dashboard</title>
        <style>body{background:#0f172a;color:#e2e8f0;font-family:system-ui;padding:40px;text-align:center}
        a{color:#3b82f6}</style></head><body>
        <h2>APME Dashboard</h2>
        <p>The full dashboard requires the Node.js bridge build.</p>
        <p>Run <code>pnpm build && agentdeck daemon start</code> to enable it,<br>
        or use the JSON API directly:</p>
        <p><a href="/apme/runs">/apme/runs</a> · <a href="/apme/scorecard">/apme/scorecard</a> · <a href="/apme/categories">/apme/categories</a></p>
        </body></html>
        """
    }()
}
#endif
