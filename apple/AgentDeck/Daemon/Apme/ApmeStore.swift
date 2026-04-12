#if os(macOS)
// ApmeStore.swift — SQLite3 C API wrapper for APME data.
// Shares the same DDL as bridge/src/apme/store.ts so both Node.js bridge
// and Swift daemon can read/write the same ~/.agentdeck/apme.sqlite file.
// WAL mode ensures safe concurrent access.

import Foundation
import SQLite3

final class ApmeStore: @unchecked Sendable {
    private var db: OpaquePointer?
    let dbPath: String
    private(set) var isOpen = false

    init() {
        dbPath = AuthManager.agentDeckDir
            .appendingPathComponent("apme.sqlite").path
    }

    // MARK: - Open / Close

    func open() -> Bool {
        guard db == nil else { return true }
        var handle: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(dbPath, &handle, flags, nil) == SQLITE_OK else {
            DaemonLogger.shared.error("APME store open failed: \(dbPath)")
            return false
        }
        db = handle
        exec("PRAGMA journal_mode = WAL")
        exec("PRAGMA foreign_keys = ON")
        exec(Self.ddl)
        migrateSchema()
        seedDefaultRubric()
        isOpen = true
        DaemonLogger.shared.info("APME store ready at \(dbPath)")
        return true
    }

    func close() {
        if let db { sqlite3_close_v2(db) }
        db = nil; isOpen = false
    }

    // MARK: - Runs

    func insertRun(_ run: ApmeRun) {
        guard let db else { return }
        let sql = """
        INSERT INTO runs
          (id, session_id, agent_type, model_id, project_name, project_path,
           task_prompt, started_at, ended_at, input_tokens, output_tokens,
           cost_usd, exit_code, git_before, git_after, hw_profile,
           task_signals, task_category, task_category_source)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, run.id)
        bindText(stmt, 2, run.sessionId)
        bindText(stmt, 3, run.agentType)
        bindTextOrNull(stmt, 4, run.modelId)
        bindTextOrNull(stmt, 5, run.projectName)
        bindTextOrNull(stmt, 6, run.projectPath)
        bindTextOrNull(stmt, 7, run.taskPrompt)
        sqlite3_bind_int64(stmt, 8, Int64(run.startedAt))
        if let e = run.endedAt { sqlite3_bind_int64(stmt, 9, Int64(e)) } else { sqlite3_bind_null(stmt, 9) }
        if let v = run.inputTokens { sqlite3_bind_int(stmt, 10, Int32(v)) } else { sqlite3_bind_null(stmt, 10) }
        if let v = run.outputTokens { sqlite3_bind_int(stmt, 11, Int32(v)) } else { sqlite3_bind_null(stmt, 11) }
        if let v = run.costUsd { sqlite3_bind_double(stmt, 12, v) } else { sqlite3_bind_null(stmt, 12) }
        if let v = run.exitCode { sqlite3_bind_int(stmt, 13, Int32(v)) } else { sqlite3_bind_null(stmt, 13) }
        bindTextOrNull(stmt, 14, run.gitBefore)
        bindTextOrNull(stmt, 15, run.gitAfter)
        bindTextOrNull(stmt, 16, run.hwProfile)
        bindTextOrNull(stmt, 17, run.taskSignals)
        bindTextOrNull(stmt, 18, run.taskCategory)
        bindTextOrNull(stmt, 19, run.taskCategorySource)
        sqlite3_step(stmt)
    }

    func updateRun(id: String, fields: [String: Any?]) {
        guard let db, !fields.isEmpty else { return }
        let colMap: [String: String] = [
            "modelId": "model_id", "projectName": "project_name", "projectPath": "project_path",
            "taskPrompt": "task_prompt", "endedAt": "ended_at",
            "inputTokens": "input_tokens", "outputTokens": "output_tokens",
            "costUsd": "cost_usd", "exitCode": "exit_code",
            "gitBefore": "git_before", "gitAfter": "git_after", "hwProfile": "hw_profile",
            "taskSignals": "task_signals", "taskCategory": "task_category",
            "taskCategorySource": "task_category_source",
        ]
        var setClauses: [String] = []
        var values: [Any?] = []
        for (key, val) in fields {
            guard let col = colMap[key] else { continue }
            setClauses.append("\(col) = ?")
            values.append(val)
        }
        guard !setClauses.isEmpty else { return }
        values.append(id)
        let sql = "UPDATE runs SET \(setClauses.joined(separator: ", ")) WHERE id = ?"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        for (i, val) in values.enumerated() {
            let idx = Int32(i + 1)
            switch val {
            case let s as String: sqlite3_bind_text(stmt, idx, (s as NSString).utf8String, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
            case let n as Int: sqlite3_bind_int64(stmt, idx, Int64(n))
            case let d as Double: sqlite3_bind_double(stmt, idx, d)
            default: sqlite3_bind_null(stmt, idx)
            }
        }
        sqlite3_step(stmt)
    }

    func getRun(id: String) -> ApmeRun? {
        guard let db else { return nil }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT * FROM runs WHERE id = ?", -1, &stmt, nil) == SQLITE_OK else { return nil }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, id)
        guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
        return readRun(stmt)
    }

    func listRuns(limit: Int = 50, agentType: String? = nil) -> [ApmeRun] {
        guard let db else { return [] }
        var sql = "SELECT * FROM runs"
        var args: [String] = []
        if let a = agentType { sql += " WHERE agent_type = ?"; args.append(a) }
        sql += " ORDER BY started_at DESC LIMIT \(min(max(limit, 1), 500))"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        for (i, arg) in args.enumerated() { bindText(stmt, Int32(i + 1), arg) }
        var result: [ApmeRun] = []
        while sqlite3_step(stmt) == SQLITE_ROW { result.append(readRun(stmt)) }
        return result
    }

    func listUnevaluatedRuns(limit: Int = 20) -> [(id: String, projectPath: String?)] {
        guard let db else { return [] }
        let sql = """
        SELECT r.id, r.project_path FROM runs r
        WHERE r.ended_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM evals e WHERE e.run_id = r.id)
        ORDER BY r.ended_at DESC LIMIT ?
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_int(stmt, 1, Int32(limit))
        var result: [(String, String?)] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            let id = String(cString: sqlite3_column_text(stmt, 0))
            let path = sqlite3_column_type(stmt, 1) == SQLITE_NULL ? nil : String(cString: sqlite3_column_text(stmt, 1))
            result.append((id, path))
        }
        return result
    }

    // MARK: - Turns

    func insertTurn(id: String, runId: String, turnIndex: Int, prompt: String?, startedAt: Int) {
        guard let db else { return }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db,
            "INSERT INTO turns (id, run_id, turn_index, prompt, started_at) VALUES (?,?,?,?,?)",
            -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, id)
        bindText(stmt, 2, runId)
        sqlite3_bind_int(stmt, 3, Int32(turnIndex))
        bindTextOrNull(stmt, 4, prompt)
        sqlite3_bind_int64(stmt, 5, Int64(startedAt))
        sqlite3_step(stmt)
    }

    func updateTurn(id: String, fields: [String: Any?]) {
        updateRun(id: id, fields: fields)
        // Reuse the same generic update logic — column names match
        // Actually turns table has different column names. Do a direct update.
        guard let db, !fields.isEmpty else { return }
        let colMap: [String: String] = [
            "endedAt": "ended_at", "toolCalls": "tool_calls",
            "filesModified": "files_modified", "filesCreated": "files_created",
            "gitAfter": "git_after", "taskCategory": "task_category",
            "outcome": "outcome", "compositeScore": "composite_score",
        ]
        var sets: [String] = []
        var vals: [Any?] = []
        for (key, val) in fields {
            guard let col = colMap[key] else { continue }
            sets.append("\(col) = ?")
            vals.append(val)
        }
        guard !sets.isEmpty else { return }
        vals.append(id)
        let sql = "UPDATE turns SET \(sets.joined(separator: ", ")) WHERE id = ?"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        for (i, val) in vals.enumerated() {
            let idx = Int32(i + 1)
            switch val {
            case let s as String: sqlite3_bind_text(stmt, idx, (s as NSString).utf8String, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
            case let n as Int: sqlite3_bind_int64(stmt, idx, Int64(n))
            case let d as Double: sqlite3_bind_double(stmt, idx, d)
            default: sqlite3_bind_null(stmt, idx)
            }
        }
        sqlite3_step(stmt)
    }

    func listTurns(runId: String) -> [[String: Any]] {
        return query("SELECT * FROM turns WHERE run_id = '\(runId.replacingOccurrences(of: "'", with: "''"))' ORDER BY turn_index ASC")
    }

    // MARK: - Steps

    func insertStep(runId: String, ts: Int, kind: String, toolName: String?, payload: String) {
        guard let db else { return }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db,
            "INSERT INTO steps (run_id, ts, kind, tool_name, payload) VALUES (?,?,?,?,?)",
            -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, runId)
        sqlite3_bind_int64(stmt, 2, Int64(ts))
        bindText(stmt, 3, kind)
        bindTextOrNull(stmt, 4, toolName)
        bindText(stmt, 5, payload)
        sqlite3_step(stmt)
    }

    func listSteps(runId: String) -> [ApmeStep] {
        guard let db else { return [] }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db,
            "SELECT * FROM steps WHERE run_id = ? ORDER BY ts ASC",
            -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, runId)
        var result: [ApmeStep] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            result.append(ApmeStep(
                id: Int(sqlite3_column_int(stmt, 0)),
                runId: String(cString: sqlite3_column_text(stmt, 1)),
                ts: Int(sqlite3_column_int64(stmt, 2)),
                kind: String(cString: sqlite3_column_text(stmt, 3)),
                toolName: sqlite3_column_type(stmt, 4) == SQLITE_NULL ? nil : String(cString: sqlite3_column_text(stmt, 4)),
                payload: sqlite3_column_type(stmt, 5) == SQLITE_NULL ? "{}" : String(cString: sqlite3_column_text(stmt, 5))
            ))
        }
        return result
    }

    // MARK: - Evals

    func insertEval(_ eval: ApmeEval) {
        guard let db else { return }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db,
            "INSERT INTO evals (run_id, layer, metric, score, raw, rubric_ver, judge_model, created_at) VALUES (?,?,?,?,?,?,?,?)",
            -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, eval.runId)
        bindText(stmt, 2, eval.layer)
        bindText(stmt, 3, eval.metric)
        sqlite3_bind_double(stmt, 4, eval.score)
        bindTextOrNull(stmt, 5, eval.raw)
        if let v = eval.rubricVer { sqlite3_bind_int(stmt, 6, Int32(v)) } else { sqlite3_bind_null(stmt, 6) }
        bindTextOrNull(stmt, 7, eval.judgeModel)
        sqlite3_bind_int64(stmt, 8, Int64(eval.createdAt))
        sqlite3_step(stmt)
    }

    func listEvalsForRun(_ runId: String) -> [ApmeEval] {
        guard let db else { return [] }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db,
            "SELECT * FROM evals WHERE run_id = ? ORDER BY created_at ASC",
            -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, runId)
        var result: [ApmeEval] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            result.append(ApmeEval(
                id: Int(sqlite3_column_int(stmt, 0)),
                runId: String(cString: sqlite3_column_text(stmt, 1)),
                layer: String(cString: sqlite3_column_text(stmt, 2)),
                metric: String(cString: sqlite3_column_text(stmt, 3)),
                score: sqlite3_column_double(stmt, 4),
                raw: sqlite3_column_type(stmt, 5) == SQLITE_NULL ? nil : String(cString: sqlite3_column_text(stmt, 5)),
                rubricVer: sqlite3_column_type(stmt, 6) == SQLITE_NULL ? nil : Int(sqlite3_column_int(stmt, 6)),
                judgeModel: sqlite3_column_type(stmt, 7) == SQLITE_NULL ? nil : String(cString: sqlite3_column_text(stmt, 7)),
                createdAt: Int(sqlite3_column_int64(stmt, 8))
            ))
        }
        return result
    }

    // MARK: - Vibe

    func insertVibe(runId: String, verdict: String, note: String?) {
        guard let db else { return }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db,
            "INSERT INTO vibe_feedback (run_id, verdict, note, ts) VALUES (?,?,?,?)",
            -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, runId)
        bindText(stmt, 2, verdict)
        bindTextOrNull(stmt, 3, note)
        sqlite3_bind_int64(stmt, 4, Int64(Date().timeIntervalSince1970 * 1000))
        sqlite3_step(stmt)
    }

    // MARK: - Scorecard

    func scorecard() -> [[String: Any]] {
        return query("SELECT * FROM v_model_scorecard")
    }

    func categoryScorecard() -> [[String: Any]] {
        return query("SELECT * FROM v_category_scorecard")
    }

    // MARK: - Rubric

    func getCurrentRubric() -> [String: Any]? {
        guard let db else { return nil }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db,
            "SELECT * FROM rubrics WHERE purpose = 'general' ORDER BY version DESC LIMIT 1",
            -1, &stmt, nil) == SQLITE_OK else { return nil }
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
        return rowToDict(stmt)
    }

    // MARK: - Private helpers

    private func exec(_ sql: String) {
        guard let db else { return }
        sqlite3_exec(db, sql, nil, nil, nil)
    }

    private func migrateSchema() {
        guard let db else { return }
        let cols = query("PRAGMA table_info(runs)").compactMap { $0["name"] as? String }
        let migrations: [(String, String)] = [
            ("task_signals", "ALTER TABLE runs ADD COLUMN task_signals TEXT"),
            ("task_category", "ALTER TABLE runs ADD COLUMN task_category TEXT"),
            ("task_category_source", "ALTER TABLE runs ADD COLUMN task_category_source TEXT DEFAULT 'auto'"),
        ]
        for (col, sql) in migrations where !cols.contains(col) {
            exec(sql)
        }
    }

    private func seedDefaultRubric() {
        guard let db else { return }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT COUNT(*) FROM rubrics", -1, &stmt, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_step(stmt) == SQLITE_ROW, sqlite3_column_int(stmt, 0) == 0 else { return }
        let prompt = "You are a strict but fair senior engineer judging the output of an AI coding agent.\n\nGiven the task prompt, the git diff produced, the deterministic test results, and\na sample of the agent''s tool calls, score the run on the following axes. Each score\nis a float in [0,1] where 0=failure and 1=excellent. Be concise in reasoning.\n\nAxes:\n- intent: Did the final output actually address what the user asked for?\n- correctness: Is the code correct given its claimed purpose?\n- style: Does it match the codebase''s conventions (naming, structure, imports)?\n- convention: Does it avoid footguns (no dead code, no debug prints, no unrelated churn)?\n- overall: Your holistic judgment weighted by the above.\n\nReturn strict JSON: {\"intent\":N,\"correctness\":N,\"style\":N,\"convention\":N,\"overall\":N,\"reasoning\":\"...\"}."
        let now = Int(Date().timeIntervalSince1970 * 1000)
        exec("INSERT INTO rubrics (version, purpose, prompt, weights, created_at, notes) VALUES (1, 'general', '\(prompt)', '{\"intent\":0.35,\"correctness\":0.3,\"style\":0.15,\"convention\":0.2}', \(now), 'seeded default')")
    }

    private func query(_ sql: String) -> [[String: Any]] {
        guard let db else { return [] }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        var rows: [[String: Any]] = []
        while sqlite3_step(stmt) == SQLITE_ROW { rows.append(rowToDict(stmt)) }
        return rows
    }

    private func rowToDict(_ stmt: OpaquePointer?) -> [String: Any] {
        guard let stmt else { return [:] }
        var dict: [String: Any] = [:]
        let count = sqlite3_column_count(stmt)
        for i in 0..<count {
            let name = String(cString: sqlite3_column_name(stmt, i))
            switch sqlite3_column_type(stmt, i) {
            case SQLITE_INTEGER: dict[name] = Int(sqlite3_column_int64(stmt, i))
            case SQLITE_FLOAT:   dict[name] = sqlite3_column_double(stmt, i)
            case SQLITE_TEXT:    dict[name] = String(cString: sqlite3_column_text(stmt, i))
            case SQLITE_NULL:    dict[name] = NSNull()
            default: break
            }
        }
        return dict
    }

    private func readRun(_ stmt: OpaquePointer?) -> ApmeRun {
        let d = rowToDict(stmt)
        return ApmeRun(
            id: d["id"] as? String ?? "",
            sessionId: d["session_id"] as? String ?? "",
            agentType: d["agent_type"] as? String ?? "",
            modelId: d["model_id"] as? String,
            projectName: d["project_name"] as? String,
            projectPath: d["project_path"] as? String,
            taskPrompt: d["task_prompt"] as? String,
            startedAt: d["started_at"] as? Int ?? 0,
            endedAt: d["ended_at"] as? Int,
            inputTokens: d["input_tokens"] as? Int,
            outputTokens: d["output_tokens"] as? Int,
            costUsd: d["cost_usd"] as? Double,
            exitCode: d["exit_code"] as? Int,
            gitBefore: d["git_before"] as? String,
            gitAfter: d["git_after"] as? String,
            hwProfile: d["hw_profile"] as? String,
            taskSignals: d["task_signals"] as? String,
            taskCategory: d["task_category"] as? String,
            taskCategorySource: d["task_category_source"] as? String,
            outcome: d["outcome"] as? String,
            outcomeConfidence: d["outcome_confidence"] as? String,
            efficiencyJson: d["efficiency_json"] as? String,
            compositeScore: d["composite_score"] as? Double
        )
    }

    private func bindText(_ stmt: OpaquePointer?, _ idx: Int32, _ val: String) {
        sqlite3_bind_text(stmt, idx, (val as NSString).utf8String, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
    }

    private func bindTextOrNull(_ stmt: OpaquePointer?, _ idx: Int32, _ val: String?) {
        if let v = val { bindText(stmt, idx, v) } else { sqlite3_bind_null(stmt, idx) }
    }

    // MARK: - DDL (identical to Node.js store.ts)

    private static let ddl = """
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_type TEXT NOT NULL,
      model_id TEXT, project_name TEXT, project_path TEXT, task_prompt TEXT,
      started_at INTEGER NOT NULL, ended_at INTEGER,
      input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL,
      exit_code INTEGER, git_before TEXT, git_after TEXT, hw_profile TEXT,
      task_signals TEXT, task_category TEXT, task_category_source TEXT DEFAULT 'auto'
    );
    CREATE TABLE IF NOT EXISTS steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      ts INTEGER NOT NULL, kind TEXT NOT NULL, tool_name TEXT, payload TEXT
    );
    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      turn_index INTEGER NOT NULL, prompt TEXT, response TEXT, started_at INTEGER NOT NULL,
      ended_at INTEGER, tool_calls INTEGER DEFAULT 0,
      files_modified INTEGER DEFAULT 0, files_created INTEGER DEFAULT 0,
      git_before TEXT, git_after TEXT, task_category TEXT,
      outcome TEXT, composite_score REAL, efficiency_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_turns_run ON turns(run_id);
    CREATE TABLE IF NOT EXISTS artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT, bytes INTEGER
    );
    CREATE TABLE IF NOT EXISTS evals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      layer TEXT NOT NULL, metric TEXT NOT NULL, score REAL,
      raw TEXT, rubric_ver INTEGER, judge_model TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rubrics (
      version INTEGER PRIMARY KEY, purpose TEXT NOT NULL, prompt TEXT NOT NULL,
      weights TEXT NOT NULL, created_at INTEGER NOT NULL, parent_ver INTEGER, notes TEXT
    );
    CREATE TABLE IF NOT EXISTS vibe_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      verdict TEXT NOT NULL, note TEXT, ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runs_model ON runs(model_id);
    CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agent_type);
    CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at);
    CREATE INDEX IF NOT EXISTS idx_evals_run ON evals(run_id);
    CREATE INDEX IF NOT EXISTS idx_steps_run ON steps(run_id);
    CREATE VIEW IF NOT EXISTS v_run_metrics AS
    SELECT run_id,
      MAX(CASE WHEN metric='overall' AND layer='llm_judge' THEN score END) AS overall,
      MAX(CASE WHEN metric='tests_pass' AND layer='deterministic' THEN score END) AS tests_pass
    FROM evals GROUP BY run_id;
    CREATE VIEW IF NOT EXISTS v_model_scorecard AS
    SELECT r.agent_type, COALESCE(r.model_id,'unknown') AS model_id,
      COUNT(*) AS runs, AVG(m.overall) AS avg_overall, AVG(m.tests_pass) AS avg_tests_pass,
      SUM(r.cost_usd) AS total_cost,
      CASE WHEN AVG(m.overall)>0 THEN SUM(r.cost_usd)/AVG(m.overall) ELSE NULL END AS cost_per_quality
    FROM runs r LEFT JOIN v_run_metrics m ON m.run_id=r.id GROUP BY r.agent_type, r.model_id;
    CREATE VIEW IF NOT EXISTS v_category_scorecard AS
    SELECT r.task_category, COALESCE(r.model_id,'unknown') AS model_id,
      COUNT(*) AS runs, AVG(m.overall) AS avg_overall, AVG(m.tests_pass) AS avg_tests_pass,
      SUM(r.cost_usd) AS total_cost
    FROM runs r LEFT JOIN v_run_metrics m ON m.run_id=r.id
    WHERE r.task_category IS NOT NULL AND r.task_category != 'unknown'
    GROUP BY r.task_category, r.model_id;
    """
}

// MARK: - Data models

struct ApmeRun {
    let id: String
    let sessionId: String
    let agentType: String
    var modelId: String?
    var projectName: String?
    var projectPath: String?
    var taskPrompt: String?
    let startedAt: Int
    var endedAt: Int?
    var inputTokens: Int?
    var outputTokens: Int?
    var costUsd: Double?
    var exitCode: Int?
    var gitBefore: String?
    var gitAfter: String?
    var hwProfile: String?
    var taskSignals: String?
    var taskCategory: String?
    var taskCategorySource: String?
    var outcome: String?
    var outcomeConfidence: String?
    var efficiencyJson: String?
    var compositeScore: Double?
}

struct ApmeStep {
    let id: Int
    let runId: String
    let ts: Int
    let kind: String
    let toolName: String?
    let payload: String
}

struct ApmeEval {
    var id: Int = 0
    let runId: String
    let layer: String
    let metric: String
    let score: Double
    var raw: String?
    var rubricVer: Int?
    var judgeModel: String?
    let createdAt: Int
}
#endif
