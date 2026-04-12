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
  layer: 'deterministic' | 'llm_judge' | 'vibe';
  metric: string;
  score: number;
  raw?: string | null;       // JSON
  rubricVer?: number | null;
  judgeModel?: string | null;
  createdAt: number;
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
