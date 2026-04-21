/**
 * APME (Agent Performance Monitoring & Evaluation) — shared types.
 *
 * A `run` is one agent session (Claude Code / OpenClaw / Codex / OpenCode).
 * Each run gets a stream of `steps` (hook events, tool calls, timeline entries),
 * optional `artifacts` (diffs, PTY logs, test output), and multiple `evals`
 * (deterministic + llm_judge + vibe). Rubrics are versioned so the auto-tuner
 * can append new revisions without losing history.
 */

import type { AgentType } from '@agentdeck/shared';

export interface ApmeRunRow {
  id: string;
  sessionId: string;
  agentType: AgentType;
  modelId?: string | null;
  projectName?: string | null;
  projectPath?: string | null;
  taskPrompt?: string | null;
  startedAt: number;
  endedAt?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  exitCode?: number | null;
  gitBefore?: string | null;
  gitAfter?: string | null;
  hwProfile?: string | null; // JSON
  taskSignals?: string | null; // JSON TaskSignals
  taskCategory?: string | null;
  taskCategorySource?: string | null; // 'auto' | 'user' | 'llm'
  outcome?: string | null; // committed|abandoned|iterated|ab_winner|ab_loser|interrupted|exploratory
  outcomeConfidence?: string | null; // high|medium|low
  efficiencyJson?: string | null; // JSON EfficiencyMetrics
  compositeScore?: number | null;
}

export interface ApmeStepRow {
  id?: number;
  runId: string;
  ts: number;
  kind: string;      // PreToolUse | PostToolUse | Stop | chat | tool_request | ...
  toolName?: string | null;
  payload: string;   // JSON
}

export interface ApmeArtifactRow {
  id?: number;
  runId: string;
  kind: 'before_snapshot' | 'after_snapshot' | 'diff' | 'pty_log' | 'lint_out' | 'test_out' | string;
  path: string;
  sha256?: string | null;
  bytes?: number | null;
}

export interface ApmeEvalRowDb {
  id?: number;
  runId: string;
  layer: 'deterministic' | 'llm_judge' | 'vibe' | 'turn_judge' | 'task_judge';
  metric: string;
  score: number;
  raw?: string | null;       // JSON
  rubricVer?: number | null;
  judgeModel?: string | null;
  createdAt: number;
}

/** A `task` groups consecutive turns within a run. Boundaries are detected
 *  automatically from Claude Code hook payloads:
 *   - `todo_complete`  — TodoWrite PostToolUse where every todo.status === 'completed'
 *   - `clear`          — UserPromptSubmit `/clear` (also splits the run)
 *   - `session_end`    — closeRun finalization
 *   - `manual`         — reserved for a future explicit task-end marker
 *
 *  A task-level judge reads all turns belonging to the task and writes a
 *  one-line `summary` + `composite_score`. Individual axis scores land in
 *  `evals` rows with `layer='task_judge'` and `task_id` set.
 */
export interface ApmeTaskRow {
  id: string;
  runId: string;
  taskIndex: number;
  boundarySignal: 'todo_complete' | 'clear' | 'session_end' | 'manual' | string;
  startedAt: number;
  endedAt?: number | null;
  firstTurnIndex?: number | null;
  lastTurnIndex?: number | null;
  summary?: string | null;
  outcome?: string | null;
  compositeScore?: number | null;
  taskCategory?: string | null;
  notesJson?: string | null; // raw judge JSON (done/missed/reasoning)
}

export interface ApmeRubricRow {
  version: number;
  purpose: string;           // 'general' | 'swift' | 'typescript' | ...
  prompt: string;
  weights: string;           // JSON { intent: 0.4, style: 0.2, ... }
  createdAt: number;
  parentVer?: number | null;
  notes?: string | null;
}

export interface ApmeVibeRow {
  id?: number;
  runId: string;
  verdict: 'approve' | 'reject' | 'neutral';
  note?: string | null;
  ts: number;
}

export interface ApmeScorecardRow {
  agentType: string;
  modelId: string;
  runs: number;
  avgOverall: number | null;
  avgTestsPass: number | null;
  totalCost: number | null;
  costPerQuality: number | null;
}
