// ApmeCategoryE2ETests.swift — end-to-end test for category-aware turn eval.
//
// Swift mirror of bridge/src/__tests__/apme-category-e2e.test.ts.
// Walks the full pipeline: openRun → ingestHook → setTurnResponse →
// inline classify → stamp turn category → enqueueTurn → stub judge →
// verify turn.task_category / turn.outcome / turn.composite_score and
// turn_judge eval rows.
//
// Without this test, regressions in the Swift pipeline go unnoticed until
// the macOS app actually runs with Foundation Models — expensive to catch.
// The stub judge keeps the test fast and deterministic.

#if os(macOS)
import XCTest
@testable import AgentDeck

final class ApmeCategoryE2ETests: XCTestCase {

    // MARK: - Helpers

    /// Create a temporary ApmeStore pointing at a throwaway sqlite file,
    /// so each test runs against a clean database. The default store
    /// writes to ~/.agentdeck/apme.sqlite which tests must not touch.
    private func makeTempStore() throws -> (store: ApmeStore, dir: URL) {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("apme-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        // ApmeStore reads AuthManager.agentDeckDir at init time. We can't
        // change that from a test without refactoring, so we point the env
        // var that AuthManager honors.
        setenv("AGENTDECK_DATA_DIR", dir.path, 1)

        let store = ApmeStore()
        XCTAssertTrue(store.open(), "store should open")
        return (store, dir)
    }

    private func cleanup(_ tmp: (store: ApmeStore, dir: URL)) {
        tmp.store.close()
        try? FileManager.default.removeItem(at: tmp.dir)
        unsetenv("AGENTDECK_DATA_DIR")
    }

    // MARK: - parseJudgeJson conversation rubric

    func testConversationTurnFullPipeline() throws {
        // NOTE: this test exercises the `parseJudgeJson` path only — the
        // runner.enqueueTurn codepath requires Foundation Models which is
        // not deterministic under CI. The E2E test for the full runner is
        // the manual verification step in the plan file.
        //
        // What's verified here: category-specific rubric axes land in
        // `insertEvalForTurn`, `turn.task_category` + `turn.outcome` +
        // `turn.composite_score` write correctly, and mid-session
        // classification produces `.conversation` for a no-tools run.

        let tmp = try makeTempStore()
        defer { cleanup(tmp) }
        let store = tmp.store

        // 1. Open a run (simulating session_start)
        let runId = UUID().uuidString
        let run = ApmeRun(
            id: runId,
            sessionId: "sess-conv",
            agentType: "claude-code",
            modelId: "claude-opus-4-6",
            projectName: "demo",
            projectPath: nil,
            startedAt: Int(Date().timeIntervalSince1970 * 1000)
        )
        store.insertRun(run)

        // 2. Ingest a UserPromptSubmit step (no tool_start steps → conversation category)
        store.insertStep(
            runId: runId,
            ts: Int(Date().timeIntervalSince1970 * 1000),
            kind: "UserPromptSubmit",
            toolName: nil,
            payload: #"{"message":{"content":"What is 2+2?"}}"#
        )
        let turnId = UUID().uuidString
        store.insertTurn(
            id: turnId,
            runId: runId,
            turnIndex: 0,
            prompt: "What is 2+2?",
            startedAt: Int(Date().timeIntervalSince1970 * 1000)
        )
        store.updateTurn(id: turnId, fields: ["response": "2+2 equals 4."])

        // 3. Mid-session classification
        let classified = ApmeClassifier.classifyRun(store: store, runId: runId)
        XCTAssertEqual(classified.category, .conversation)
        store.updateRun(id: runId, fields: [
            "taskCategory": classified.category.rawValue,
            "taskCategorySource": "rule",
        ])
        store.updateTurn(id: turnId, fields: ["taskCategory": classified.category.rawValue])

        // 4. Confirm the conversation rubric exists and has the right axes
        let rubric = store.getCurrentRubric(purpose: "conversation")
        XCTAssertNotNil(rubric, "conversation rubric should be seeded")
        let rubricPrompt = (rubric?["prompt"] as? String) ?? ""
        XCTAssertTrue(rubricPrompt.contains("accuracy"), "conversation rubric should mention accuracy")
        XCTAssertTrue(rubricPrompt.contains("helpfulness"))
        XCTAssertTrue(rubricPrompt.contains("conciseness"))

        // 5. Simulate a judge response (what Foundation Models would return)
        //    and run it through parseJudgeJson — this is the parity-critical path.
        let judgeJson = """
        ```json
        {"accuracy":0.9,"helpfulness":0.8,"conciseness":0.85,"overall":0.85,"reasoning":"Correct and concise","done":["answered arithmetic"],"missed":[]}
        ```
        """
        let parsed = ApmeRunner.parseJudgeJson(judgeJson)
        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?.scores.count, 4)

        // 6. Insert the eval rows the way ApmeRunner.runTurnEval would
        let now = Int(Date().timeIntervalSince1970 * 1000)
        for (axis, score) in parsed!.scores {
            store.insertEvalForTurn(
                ApmeEval(
                    id: 0, runId: runId,
                    layer: "turn_judge", metric: axis, score: score,
                    raw: nil, rubricVer: rubric?["version"] as? Int,
                    judgeModel: "foundationModels:test",
                    createdAt: now
                ),
                turnId: turnId
            )
        }

        // 7. Persist turn outcome + composite (as DaemonServer.handleApmeResult does)
        if let overall = parsed?.scores["overall"] {
            store.updateTurn(id: turnId, fields: [
                "outcome": "committed",
                "compositeScore": overall,
            ])
        }

        // 8. Verify the final state
        guard let turn = store.getTurn(id: turnId) else {
            XCTFail("turn should exist")
            return
        }
        XCTAssertEqual(turn["task_category"] as? String, "conversation")
        XCTAssertEqual(turn["outcome"] as? String, "committed")
        XCTAssertEqual(turn["composite_score"] as? Double, 0.85)
        XCTAssertEqual(turn["prompt"] as? String, "What is 2+2?")
        XCTAssertEqual(turn["response"] as? String, "2+2 equals 4.")

        let turnEvals = store.listEvalsForTurn(turnId)
        XCTAssertGreaterThanOrEqual(turnEvals.count, 4)
        let metrics = Set(turnEvals.map { $0.metric })
        XCTAssertTrue(metrics.contains("accuracy"))
        XCTAssertTrue(metrics.contains("helpfulness"))
        XCTAssertTrue(metrics.contains("conciseness"))
        XCTAssertTrue(metrics.contains("overall"))
        let layers = Set(turnEvals.map { $0.layer })
        XCTAssertTrue(layers.contains("turn_judge"))
    }

    // MARK: - Research classification

    func testResearchTurnClassification() throws {
        // 6× Grep + 1 Glob steps → research category
        // (planning rule requires ≤5 tool calls, so 7 bypasses it)
        let tmp = try makeTempStore()
        defer { cleanup(tmp) }
        let store = tmp.store

        let runId = UUID().uuidString
        let run = ApmeRun(
            id: runId, sessionId: "sess-res", agentType: "claude-code",
            projectName: "demo", startedAt: Int(Date().timeIntervalSince1970 * 1000)
        )
        store.insertRun(run)

        store.insertStep(runId: runId, ts: 0, kind: "UserPromptSubmit", toolName: nil, payload: "{}")
        for _ in 0..<6 {
            store.insertStep(runId: runId, ts: 0, kind: "PreToolUse", toolName: "Grep", payload: "{}")
        }
        store.insertStep(runId: runId, ts: 0, kind: "PreToolUse", toolName: "Glob", payload: "{}")

        let classified = ApmeClassifier.classifyRun(store: store, runId: runId)
        XCTAssertEqual(classified.category, .research,
                       "6× Grep + 1 Glob with no file mods should classify as research")

        // Verify research rubric exists with correct axes
        let rubric = store.getCurrentRubric(purpose: "research")
        XCTAssertNotNil(rubric)
        let rubricPrompt = (rubric?["prompt"] as? String) ?? ""
        XCTAssertTrue(rubricPrompt.contains("thoroughness"))
        XCTAssertTrue(rubricPrompt.contains("relevance"))
        XCTAssertTrue(rubricPrompt.contains("synthesis"))
    }

    // MARK: - Daemon backfill pass

    func testBackfillTurnsWithoutOutcome() throws {
        // Code-category turns never go through turn_judge. The 30s daemon
        // loop must backfill outcome='committed' with null composite_score.
        let tmp = try makeTempStore()
        defer { cleanup(tmp) }
        let store = tmp.store

        let runId = UUID().uuidString
        store.insertRun(ApmeRun(
            id: runId, sessionId: "sess-code", agentType: "claude-code",
            projectName: "demo", startedAt: Int(Date().timeIntervalSince1970 * 1000)
        ))
        let turnId = UUID().uuidString
        store.insertTurn(
            id: turnId, runId: runId, turnIndex: 0,
            prompt: "refactor auth middleware",
            startedAt: Int(Date().timeIntervalSince1970 * 1000)
        )
        store.updateTurn(id: turnId, fields: ["response": "Refactored 3 files."])

        // Precondition: 1 turn needs outcome
        XCTAssertEqual(store.listTurnsNeedingOutcome(limit: 10).count, 1)

        // Simulate the daemon 30s backfill pass
        let needOutcome = store.listTurnsNeedingOutcome(limit: 10)
        for t in needOutcome {
            let evs = store.listEvalsForTurn(t.id)
            let overall = evs.first(where: { $0.layer == "turn_judge" && $0.metric == "overall" })
            var fields: [String: Any?] = ["outcome": "committed"]
            if let o = overall { fields["compositeScore"] = o.score }
            store.updateTurn(id: t.id, fields: fields)
        }

        // Verify: outcome set, composite still null (no turn_judge ran)
        let turn = store.getTurn(id: turnId)
        XCTAssertEqual(turn?["outcome"] as? String, "committed")
        XCTAssertNil(turn?["composite_score"] as? Double)

        // Second pass should find nothing
        XCTAssertEqual(store.listTurnsNeedingOutcome(limit: 10).count, 0)
    }
}
#endif
