/**
 * APME SQLite store — wraps better-sqlite3 with a tiny DAO.
 *
 * better-sqlite3 is an optional native dep; if it fails to load (e.g. CI without
 * build tooling), we fall back to a no-op store so the bridge still boots.
 * Callers should check `store.enabled` before assuming persistence.
 */

import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { createRequire } from 'module';
import { debug } from '../logger.js';

// better-sqlite3 is an optional native dep. Resolving via createRequire from
// this file's URL lets Node walk `bridge/node_modules/*` via the pnpm
// workspace symlinks, regardless of the process CWD (vitest runs from the
// repo root, where the symlink doesn't exist).
const require = createRequire(import.meta.url);
import type {
  ApmeRunRow,
  ApmeStepRow,
  ApmeArtifactRow,
  ApmeEvalRowDb,
  ApmeRubricRow,
  ApmeVibeRow,
  ApmeScorecardRow,
} from './types.js';

// ─── Schema ────────────────────────────────────────────────────────────────────

const DDL = `
CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  agent_type    TEXT NOT NULL,
  model_id      TEXT,
  project_name  TEXT,
  project_path  TEXT,
  task_prompt   TEXT,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cost_usd      REAL,
  exit_code     INTEGER,
  git_before    TEXT,
  git_after     TEXT,
  hw_profile    TEXT,
  task_signals  TEXT,
  task_category TEXT,
  task_category_source TEXT DEFAULT 'auto',
  outcome       TEXT,
  outcome_confidence TEXT,
  efficiency_json TEXT,
  composite_score REAL
);

CREATE TABLE IF NOT EXISTS steps (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  ts         INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  tool_name  TEXT,
  payload    TEXT
);

CREATE TABLE IF NOT EXISTS turns (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  turn_index  INTEGER NOT NULL,
  prompt      TEXT,
  response    TEXT,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  tool_calls  INTEGER DEFAULT 0,
  files_modified INTEGER DEFAULT 0,
  files_created INTEGER DEFAULT 0,
  git_before  TEXT,
  git_after   TEXT,
  task_category TEXT,
  outcome     TEXT,
  composite_score REAL,
  efficiency_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_turns_run ON turns(run_id);

CREATE TABLE IF NOT EXISTS artifacts (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id    TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL,
  path      TEXT NOT NULL,
  sha256    TEXT,
  bytes     INTEGER
);

CREATE TABLE IF NOT EXISTS evals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  turn_id     TEXT REFERENCES turns(id) ON DELETE CASCADE,
  layer       TEXT NOT NULL,
  metric      TEXT NOT NULL,
  score       REAL,
  raw         TEXT,
  rubric_ver  INTEGER,
  judge_model TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rubrics (
  version     INTEGER PRIMARY KEY,
  purpose     TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  weights     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  parent_ver  INTEGER,
  notes       TEXT
);

CREATE TABLE IF NOT EXISTS vibe_feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  verdict    TEXT NOT NULL,
  note       TEXT,
  ts         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_model ON runs(model_id);
CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agent_type);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at);
CREATE INDEX IF NOT EXISTS idx_evals_run ON evals(run_id);
CREATE INDEX IF NOT EXISTS idx_steps_run ON steps(run_id);

-- Pre-aggregate per-run eval metrics to avoid inflating cost_usd when
-- multiple eval rows exist per run (e.g. 3 deterministic + 5 judge axes).
CREATE VIEW IF NOT EXISTS v_run_metrics AS
SELECT
  run_id,
  MAX(CASE WHEN metric='overall' AND layer='llm_judge' THEN score END) AS overall,
  MAX(CASE WHEN metric='tests_pass' AND layer='deterministic' THEN score END) AS tests_pass
FROM evals
GROUP BY run_id;

CREATE VIEW IF NOT EXISTS v_model_scorecard AS
SELECT
  r.agent_type AS agent_type,
  COALESCE(r.model_id, 'unknown') AS model_id,
  COUNT(*) AS runs,
  AVG(m.overall) AS avg_overall,
  AVG(m.tests_pass) AS avg_tests_pass,
  SUM(r.cost_usd) AS total_cost,
  CASE
    WHEN AVG(m.overall) > 0
    THEN SUM(r.cost_usd) / AVG(m.overall)
    ELSE NULL
  END AS cost_per_quality
FROM runs r
LEFT JOIN v_run_metrics m ON m.run_id = r.id
GROUP BY r.agent_type, r.model_id;

CREATE VIEW IF NOT EXISTS v_category_scorecard AS
SELECT
  r.task_category AS task_category,
  COALESCE(r.model_id, 'unknown') AS model_id,
  COUNT(*) AS runs,
  AVG(m.overall) AS avg_overall,
  AVG(m.tests_pass) AS avg_tests_pass,
  SUM(r.cost_usd) AS total_cost
FROM runs r
LEFT JOIN v_run_metrics m ON m.run_id = r.id
WHERE r.task_category IS NOT NULL AND r.task_category != 'unknown'
GROUP BY r.task_category, r.model_id;
`;

// ─── Default rubric v1 (seeded on first boot) ──────────────────────────────────

const DEFAULT_RUBRIC_V1 = {
  version: 1,
  purpose: 'general',
  prompt: `You are a senior engineer evaluating whether an AI coding agent completed the user's task.

Given the task prompt and the git diff produced, evaluate the agent's contribution.
Score each axis as a float in [0,1] where 0=failed and 1=excellent.

Axes:
- task_completion: Did the agent actually do what the user asked? A perfect score means the task prompt's request was fully addressed in the diff. A zero means nothing relevant was done.
- code_quality: Is the code correct, safe, and maintainable? Check for bugs, missing error handling, security issues, and dead code.
- efficiency: Did the agent make minimal, focused changes? Penalize unrelated modifications, unnecessary refactoring, or verbose solutions to simple problems.
- overall: Your holistic judgment. Weight task_completion most heavily — a session that completes the task with decent quality is better than a perfect-style session that misses the point.

Important: Explain your reasoning with specific references to what was done and what was missed. List concrete items with checkmarks (done) and crosses (missed). This reasoning will be shown to the user for verification.

Return strict JSON: {"task_completion":N,"code_quality":N,"efficiency":N,"overall":N,"reasoning":"...", "done":["item1","item2"], "missed":["item1"]}.`,
  weights: JSON.stringify({ task_completion: 0.5, code_quality: 0.3, efficiency: 0.2 }),
  notes: 'seeded default',
};

// ─── Store ─────────────────────────────────────────────────────────────────────

type BetterSqliteDb = {
  prepare: (sql: string) => {
    run: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
    get: (...params: unknown[]) => unknown;
    all: (...params: unknown[]) => unknown[];
  };
  exec: (sql: string) => void;
  close: () => void;
  pragma: (s: string) => unknown;
};

export class ApmeStore {
  private db: BetterSqliteDb | null = null;
  public enabled = false;
  public readonly dbPath: string;

  constructor(dbPath?: string) {
    const dataDir = process.env.AGENTDECK_DATA_DIR || join(homedir(), '.agentdeck');
    this.dbPath = dbPath ?? join(dataDir, 'apme.sqlite');
  }

  /** Attempt to open the DB. Returns false if better-sqlite3 is unavailable. */
  async init(): Promise<boolean> {
    try {
      let Ctor: (new (path: string) => BetterSqliteDb) | null = null;
      try {
        Ctor = require('better-sqlite3') as new (path: string) => BetterSqliteDb;
      } catch {
        debug('APME', 'better-sqlite3 not installed — APME store disabled');
        return false;
      }
      const dir = dirname(this.dbPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      this.db = new Ctor(this.dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.db.exec(DDL);
      this.migrateSchema();
      this.seedDefaultRubric();
      this.enabled = true;
      debug('APME', `store ready at ${this.dbPath}`);
      return true;
    } catch (err) {
      debug('APME', `store init failed: ${String(err)}`);
      return false;
    }
  }

  close(): void {
    try { this.db?.close(); } catch { /* ignore */ }
    this.db = null;
    this.enabled = false;
  }

  /** Add columns that may be missing from databases created before this version. */
  private migrateSchema(): void {
    if (!this.db) return;
    const cols = (this.db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map(c => c.name);
    const migrations: Array<[string, string]> = [
      ['task_signals', 'ALTER TABLE runs ADD COLUMN task_signals TEXT'],
      ['task_category', 'ALTER TABLE runs ADD COLUMN task_category TEXT'],
      ['task_category_source', "ALTER TABLE runs ADD COLUMN task_category_source TEXT DEFAULT 'auto'"],
      ['turn_id', 'ALTER TABLE evals ADD COLUMN turn_id TEXT REFERENCES turns(id) ON DELETE CASCADE'],
      ['turn_response', 'ALTER TABLE turns ADD COLUMN response TEXT'],
      ['outcome', 'ALTER TABLE runs ADD COLUMN outcome TEXT'],
      ['outcome_confidence', 'ALTER TABLE runs ADD COLUMN outcome_confidence TEXT'],
      ['efficiency_json', 'ALTER TABLE runs ADD COLUMN efficiency_json TEXT'],
      ['composite_score', 'ALTER TABLE runs ADD COLUMN composite_score REAL'],
    ];
    for (const [col, sql] of migrations) {
      if (!cols.includes(col)) {
        try { this.db.exec(sql); } catch { /* column may already exist from partial migration */ }
      }
    }
  }

  private seedDefaultRubric(): void {
    if (!this.db) return;
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM rubrics').get() as { n: number };
    if (row.n > 0) return;
    this.db.prepare(
      `INSERT INTO rubrics (version, purpose, prompt, weights, created_at, parent_ver, notes)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      DEFAULT_RUBRIC_V1.version,
      DEFAULT_RUBRIC_V1.purpose,
      DEFAULT_RUBRIC_V1.prompt,
      DEFAULT_RUBRIC_V1.weights,
      Date.now(),
      DEFAULT_RUBRIC_V1.notes,
    );
  }

  // ─── Runs ────────────────────────────────────────────────────────────────────

  insertRun(row: ApmeRunRow): void {
    if (!this.db) return;
    this.db.prepare(
      `INSERT INTO runs
        (id, session_id, agent_type, model_id, project_name, project_path, task_prompt,
         started_at, ended_at, input_tokens, output_tokens, cost_usd, exit_code,
         git_before, git_after, hw_profile)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.sessionId,
      row.agentType,
      row.modelId ?? null,
      row.projectName ?? null,
      row.projectPath ?? null,
      row.taskPrompt ?? null,
      row.startedAt,
      row.endedAt ?? null,
      row.inputTokens ?? null,
      row.outputTokens ?? null,
      row.costUsd ?? null,
      row.exitCode ?? null,
      row.gitBefore ?? null,
      row.gitAfter ?? null,
      row.hwProfile ?? null,
    );
  }

  updateRun(id: string, patch: Partial<ApmeRunRow>): void {
    if (!this.db) return;
    const fields: string[] = [];
    const values: unknown[] = [];
    const map: Record<string, string> = {
      modelId: 'model_id',
      projectName: 'project_name',
      projectPath: 'project_path',
      taskPrompt: 'task_prompt',
      endedAt: 'ended_at',
      inputTokens: 'input_tokens',
      outputTokens: 'output_tokens',
      costUsd: 'cost_usd',
      exitCode: 'exit_code',
      gitBefore: 'git_before',
      gitAfter: 'git_after',
      hwProfile: 'hw_profile',
      taskSignals: 'task_signals',
      taskCategory: 'task_category',
      taskCategorySource: 'task_category_source',
      outcome: 'outcome',
      outcomeConfidence: 'outcome_confidence',
      efficiencyJson: 'efficiency_json',
      compositeScore: 'composite_score',
    };
    for (const [k, v] of Object.entries(patch)) {
      const col = map[k];
      if (!col || v === undefined) continue;
      fields.push(`${col} = ?`);
      values.push(v);
    }
    if (fields.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE runs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  getRun(id: string): ApmeRunRow | null {
    if (!this.db) return null;
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? rowToRun(row) : null;
  }

  listRuns(opts: { limit?: number; agentType?: string; modelId?: string } = {}): ApmeRunRow[] {
    if (!this.db) return [];
    const wh: string[] = [];
    const args: unknown[] = [];
    if (opts.agentType) { wh.push('agent_type = ?'); args.push(opts.agentType); }
    if (opts.modelId) { wh.push('model_id = ?'); args.push(opts.modelId); }
    const where = wh.length ? `WHERE ${wh.join(' AND ')}` : '';
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const rows = this.db.prepare(
      `SELECT * FROM runs ${where} ORDER BY started_at DESC LIMIT ${limit}`,
    ).all(...args) as Record<string, unknown>[];
    return rows.map(rowToRun);
  }

  // ─── Turns ──────────────────────────────────────────────────────────────────

  insertTurn(turn: { id: string; runId: string; turnIndex: number; prompt?: string; startedAt: number; gitBefore?: string }): void {
    if (!this.db) return;
    this.db.prepare(
      `INSERT INTO turns (id, run_id, turn_index, prompt, started_at, git_before) VALUES (?,?,?,?,?,?)`,
    ).run(turn.id, turn.runId, turn.turnIndex, turn.prompt ?? null, turn.startedAt, turn.gitBefore ?? null);
  }

  updateTurn(id: string, fields: Record<string, unknown>): void {
    if (!this.db) return;
    const map: Record<string, string> = {
      endedAt: 'ended_at', toolCalls: 'tool_calls', filesModified: 'files_modified',
      filesCreated: 'files_created', gitAfter: 'git_after', taskCategory: 'task_category',
      outcome: 'outcome', compositeScore: 'composite_score', efficiencyJson: 'efficiency_json',
      prompt: 'prompt', response: 'response',
    };
    const sets: string[] = []; const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      const col = map[k]; if (!col || v === undefined) continue;
      sets.push(`${col} = ?`); vals.push(v);
    }
    if (sets.length === 0) return;
    vals.push(id);
    this.db.prepare(`UPDATE turns SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  getTurn(id: string): Record<string, unknown> | null {
    if (!this.db) return null;
    return (this.db.prepare('SELECT * FROM turns WHERE id = ?').get(id) as Record<string, unknown>) ?? null;
  }

  listTurns(runId: string): Array<Record<string, unknown>> {
    if (!this.db) return [];
    return this.db.prepare('SELECT * FROM turns WHERE run_id = ? ORDER BY turn_index ASC').all(runId) as Array<Record<string, unknown>>;
  }

  listEvalsForTurn(turnId: string): ApmeEvalRowDb[] {
    if (!this.db) return [];
    const rows = this.db.prepare(
      'SELECT * FROM evals WHERE turn_id = ? ORDER BY created_at ASC',
    ).all(turnId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      runId: r.run_id as string,
      layer: r.layer as ApmeEvalRowDb['layer'],
      metric: r.metric as string,
      score: r.score as number,
      raw: (r.raw as string | null) ?? null,
      rubricVer: (r.rubric_ver as number | null) ?? null,
      judgeModel: (r.judge_model as string | null) ?? null,
      createdAt: r.created_at as number,
    }));
  }

  insertEvalForTurn(row: ApmeEvalRowDb & { turnId: string }): void {
    if (!this.db) return;
    this.db.prepare(
      `INSERT INTO evals (run_id, turn_id, layer, metric, score, raw, rubric_ver, judge_model, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(row.runId, row.turnId, row.layer, row.metric, row.score,
      row.raw ?? null, row.rubricVer ?? null, row.judgeModel ?? null, row.createdAt);
  }

  // ─── Steps / Artifacts ───────────────────────────────────────────────────────

  insertStep(row: ApmeStepRow): void {
    if (!this.db) return;
    this.db.prepare(
      `INSERT INTO steps (run_id, ts, kind, tool_name, payload) VALUES (?, ?, ?, ?, ?)`,
    ).run(row.runId, row.ts, row.kind, row.toolName ?? null, row.payload);
  }

  listSteps(runId: string): ApmeStepRow[] {
    if (!this.db) return [];
    const rows = this.db.prepare(
      'SELECT * FROM steps WHERE run_id = ? ORDER BY ts ASC',
    ).all(runId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      runId: r.run_id as string,
      ts: r.ts as number,
      kind: r.kind as string,
      toolName: (r.tool_name as string | null) ?? null,
      payload: (r.payload as string | null) ?? '{}',
    }));
  }

  insertArtifact(row: ApmeArtifactRow): void {
    if (!this.db) return;
    this.db.prepare(
      `INSERT INTO artifacts (run_id, kind, path, sha256, bytes) VALUES (?, ?, ?, ?, ?)`,
    ).run(row.runId, row.kind, row.path, row.sha256 ?? null, row.bytes ?? null);
  }

  // ─── Evals ───────────────────────────────────────────────────────────────────

  insertEval(row: ApmeEvalRowDb): void {
    if (!this.db) return;
    this.db.prepare(
      `INSERT INTO evals
        (run_id, layer, metric, score, raw, rubric_ver, judge_model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.runId, row.layer, row.metric, row.score,
      row.raw ?? null, row.rubricVer ?? null, row.judgeModel ?? null, row.createdAt,
    );
  }

  listEvalsForRun(runId: string): ApmeEvalRowDb[] {
    if (!this.db) return [];
    const rows = this.db.prepare(
      'SELECT * FROM evals WHERE run_id = ? ORDER BY created_at ASC',
    ).all(runId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      runId: r.run_id as string,
      layer: r.layer as ApmeEvalRowDb['layer'],
      metric: r.metric as string,
      score: r.score as number,
      raw: (r.raw as string | null) ?? null,
      rubricVer: (r.rubric_ver as number | null) ?? null,
      judgeModel: (r.judge_model as string | null) ?? null,
      createdAt: r.created_at as number,
    }));
  }

  // ─── Rubrics ─────────────────────────────────────────────────────────────────

  getCurrentRubric(purpose: string = 'general'): ApmeRubricRow | null {
    if (!this.db) return null;
    const row = this.db.prepare(
      `SELECT * FROM rubrics WHERE purpose = ? ORDER BY version DESC LIMIT 1`,
    ).get(purpose) as Record<string, unknown> | undefined;
    return row ? rowToRubric(row) : null;
  }

  appendRubric(row: Omit<ApmeRubricRow, 'version'>): number {
    if (!this.db) return 0;
    const next = (this.db.prepare('SELECT COALESCE(MAX(version),0)+1 AS v FROM rubrics').get() as { v: number }).v;
    this.db.prepare(
      `INSERT INTO rubrics (version, purpose, prompt, weights, created_at, parent_ver, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(next, row.purpose, row.prompt, row.weights, row.createdAt, row.parentVer ?? null, row.notes ?? null);
    return next;
  }

  // ─── Vibe ────────────────────────────────────────────────────────────────────

  insertVibe(row: ApmeVibeRow): void {
    if (!this.db) return;
    this.db.prepare(
      `INSERT INTO vibe_feedback (run_id, verdict, note, ts) VALUES (?, ?, ?, ?)`,
    ).run(row.runId, row.verdict, row.note ?? null, row.ts);
  }

  /** Return the most recent vibe verdict for a run, or null if none. */
  latestVibeForRun(runId: string): ApmeVibeRow | null {
    if (!this.db) return null;
    const row = this.db.prepare(
      `SELECT * FROM vibe_feedback WHERE run_id = ? ORDER BY ts DESC LIMIT 1`,
    ).get(runId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as number,
      runId: row.run_id as string,
      verdict: row.verdict as ApmeVibeRow['verdict'],
      note: (row.note as string | null) ?? null,
      ts: row.ts as number,
    };
  }

  /** Runs that have ended but have zero eval rows — candidates for the daemon eval queue. */
  listUnevaluatedRuns(limit: number = 20): { id: string; projectPath: string | null }[] {
    if (!this.db) return [];
    const rows = this.db.prepare(
      `SELECT r.id, r.project_path FROM runs r
       WHERE r.ended_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM evals e WHERE e.run_id = r.id)
       ORDER BY r.ended_at DESC
       LIMIT ?`,
    ).all(limit) as Array<{ id: string; project_path: string | null }>;
    return rows.map((r) => ({ id: r.id, projectPath: r.project_path }));
  }

  // ─── Scorecard ───────────────────────────────────────────────────────────────

  scorecard(): ApmeScorecardRow[] {
    if (!this.db) return [];
    const rows = this.db.prepare('SELECT * FROM v_model_scorecard').all() as Record<string, unknown>[];
    return rows.map((r) => ({
      agentType: r.agent_type as string,
      modelId: r.model_id as string,
      runs: r.runs as number,
      avgOverall: (r.avg_overall as number | null) ?? null,
      avgTestsPass: (r.avg_tests_pass as number | null) ?? null,
      totalCost: (r.total_cost as number | null) ?? null,
      costPerQuality: (r.cost_per_quality as number | null) ?? null,
    }));
  }

  categoryScorecard(): Array<{ taskCategory: string; modelId: string; runs: number; avgOverall: number | null; avgTestsPass: number | null; totalCost: number | null }> {
    if (!this.db) return [];
    const rows = this.db.prepare('SELECT * FROM v_category_scorecard').all() as Record<string, unknown>[];
    return rows.map((r) => ({
      taskCategory: r.task_category as string,
      modelId: r.model_id as string,
      runs: r.runs as number,
      avgOverall: (r.avg_overall as number | null) ?? null,
      avgTestsPass: (r.avg_tests_pass as number | null) ?? null,
      totalCost: (r.total_cost as number | null) ?? null,
    }));
  }
}

// ─── Row mappers ───────────────────────────────────────────────────────────────

function rowToRun(r: Record<string, unknown>): ApmeRunRow {
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    agentType: r.agent_type as ApmeRunRow['agentType'],
    modelId: (r.model_id as string | null) ?? null,
    projectName: (r.project_name as string | null) ?? null,
    projectPath: (r.project_path as string | null) ?? null,
    taskPrompt: (r.task_prompt as string | null) ?? null,
    startedAt: r.started_at as number,
    endedAt: (r.ended_at as number | null) ?? null,
    inputTokens: (r.input_tokens as number | null) ?? null,
    outputTokens: (r.output_tokens as number | null) ?? null,
    costUsd: (r.cost_usd as number | null) ?? null,
    exitCode: (r.exit_code as number | null) ?? null,
    gitBefore: (r.git_before as string | null) ?? null,
    gitAfter: (r.git_after as string | null) ?? null,
    hwProfile: (r.hw_profile as string | null) ?? null,
    taskSignals: (r.task_signals as string | null) ?? null,
    taskCategory: (r.task_category as string | null) ?? null,
    taskCategorySource: (r.task_category_source as string | null) ?? null,
    outcome: (r.outcome as string | null) ?? null,
    outcomeConfidence: (r.outcome_confidence as string | null) ?? null,
    efficiencyJson: (r.efficiency_json as string | null) ?? null,
    compositeScore: (r.composite_score as number | null) ?? null,
  };
}

function rowToRubric(r: Record<string, unknown>): ApmeRubricRow {
  return {
    version: r.version as number,
    purpose: r.purpose as string,
    prompt: r.prompt as string,
    weights: r.weights as string,
    createdAt: r.created_at as number,
    parentVer: (r.parent_ver as number | null) ?? null,
    notes: (r.notes as string | null) ?? null,
  };
}
