/**
 * APME Task Classifier — 2-layer: signal vector + derived label.
 *
 * Layer 1: `computeSignals()` aggregates steps into a fixed-shape TaskSignals
 * object that is stored as JSON on `runs.task_signals`. The signals are
 * agent-agnostic so the same shape works for Claude Code, Codex, OpenCode,
 * and OpenClaw runs alike.
 *
 * Layer 2: `classify()` maps a TaskSignals object to a task_category label
 * via a priority-ordered rule table. Users can override with `agentdeck apme
 * tag <id> <category>`. The taxonomy is intentionally simple — the raw
 * signals are always available for re-classification with a smarter model.
 */

import type { ApmeStore } from './store.js';

// ─── TaskSignals — agent-agnostic feature vector ─────────────────────────────

export interface TaskSignals {
  toolCounts: Record<string, number>;
  dominantTool: string | null;
  totalToolCalls: number;

  turnCount: number;
  sessionDurationSec: number;
  promptLengthChars: number;

  planModeUsed: boolean;
  permissionRequests: number;
  diffReviews: number;
  filesCreated: number;
  filesModified: number;
  testCommandsRun: number;
  webSearches: number;
  agentDelegations: number;

  isAutomated?: boolean;
  ocToolNames?: string[];
}

// ─── Taxonomy ────────────────────────────────────────────────────────────────

export type TaskCategory =
  | 'planning'
  | 'research'
  | 'coding'
  | 'debugging'
  | 'refactoring'
  | 'review'
  | 'ops'
  | 'conversation'
  | 'multi_agent'
  | 'unknown';

export const TASK_CATEGORIES: readonly TaskCategory[] = [
  'planning', 'research', 'coding', 'debugging', 'refactoring',
  'review', 'ops', 'conversation', 'multi_agent', 'unknown',
];

// ─── Signal computation ─────────────────────────────────────────────────────

const TEST_PATTERNS = /\b(test|vitest|jest|pytest|cargo\s+test|go\s+test|xcodebuild\s+test|gradlew\s+test|pnpm\s+test|npm\s+test)\b/i;

export function computeSignals(store: ApmeStore, runId: string): TaskSignals {
  const run = store.getRun(runId);
  const steps = store.listSteps(runId);

  const toolCounts: Record<string, number> = {};
  let turnCount = 0;
  let planModeUsed = false;
  let permissionRequests = 0;
  let diffReviews = 0;
  let filesCreated = 0;
  let filesModified = 0;
  let testCommandsRun = 0;
  let webSearches = 0;
  let agentDelegations = 0;
  let isAutomated: boolean | undefined;
  const ocToolNames = new Set<string>();

  for (const step of steps) {
    if (step.kind === 'PreToolUse' && step.toolName) {
      toolCounts[step.toolName] = (toolCounts[step.toolName] ?? 0) + 1;

      if (step.toolName === 'Write') filesCreated++;
      if (step.toolName === 'Edit') filesModified++;
      if (step.toolName === 'WebSearch' || step.toolName === 'WebFetch') webSearches++;
      if (step.toolName === 'Agent') agentDelegations++;
      if (step.toolName === 'Bash') {
        try {
          const payload = JSON.parse(step.payload);
          const cmd = typeof payload.command === 'string' ? payload.command : '';
          if (TEST_PATTERNS.test(cmd)) testCommandsRun++;
        } catch { /* ignore */ }
      }
    }

    if (step.kind === 'UserPromptSubmit') turnCount++;

    // State-based signals from step payloads
    try {
      const payload = JSON.parse(step.payload);
      if (payload.mode === 'plan' || step.kind === 'mode_change') {
        if (typeof payload.mode === 'string' && payload.mode === 'plan') planModeUsed = true;
      }
      if (step.kind === 'permission_prompt') permissionRequests++;
      if (step.kind === 'diff_prompt') diffReviews++;
      // OpenClaw signals
      if (typeof payload.chatIsAutomated === 'boolean') isAutomated = payload.chatIsAutomated;
      if (Array.isArray(payload.chatToolNames)) {
        for (const t of payload.chatToolNames) {
          if (typeof t === 'string') ocToolNames.add(t);
        }
      }
    } catch { /* ignore */ }
  }

  const totalToolCalls = Object.values(toolCounts).reduce((a, b) => a + b, 0);
  let dominantTool: string | null = null;
  let maxCount = 0;
  for (const [tool, count] of Object.entries(toolCounts)) {
    if (count > maxCount) { maxCount = count; dominantTool = tool; }
  }

  const sessionDurationSec = run?.endedAt && run?.startedAt
    ? Math.round((run.endedAt - run.startedAt) / 1000)
    : 0;

  return {
    toolCounts,
    dominantTool,
    totalToolCalls,
    turnCount,
    sessionDurationSec,
    promptLengthChars: run?.taskPrompt?.length ?? 0,
    planModeUsed,
    permissionRequests,
    diffReviews,
    filesCreated,
    filesModified,
    testCommandsRun,
    webSearches,
    agentDelegations,
    isAutomated: isAutomated ?? undefined,
    ocToolNames: ocToolNames.size > 0 ? [...ocToolNames] : undefined,
  };
}

// ─── Rule-based classifier ──────────────────────────────────────────────────

function toolPct(signals: TaskSignals, ...tools: string[]): number {
  if (signals.totalToolCalls === 0) return 0;
  const sum = tools.reduce((a, t) => a + (signals.toolCounts[t] ?? 0), 0);
  return sum / signals.totalToolCalls;
}

type Rule = { category: TaskCategory; test: (s: TaskSignals) => boolean };

const RULES: Rule[] = [
  // Highest-signal categories first — these have unambiguous markers.
  {
    category: 'multi_agent',
    test: (s) => s.agentDelegations >= 2,
  },
  {
    category: 'planning',
    test: (s) => s.planModeUsed,
  },
  {
    category: 'conversation',
    test: (s) => s.totalToolCalls <= 2 && s.sessionDurationSec < 120,
  },
  {
    category: 'planning',
    test: (s) => s.turnCount >= 1 && s.turnCount <= 3 && s.totalToolCalls <= 5 && s.filesModified === 0 && s.filesCreated === 0,
  },
  {
    category: 'research',
    test: (s) => s.webSearches > 0 || (toolPct(s, 'Grep', 'Glob') > 0.4 && s.filesModified === 0 && s.filesCreated === 0),
  },
  {
    category: 'debugging',
    test: (s) => s.testCommandsRun >= 1 && (s.filesModified > 0 || s.filesCreated > 0) && toolPct(s, 'Bash') > 0.2,
  },
  {
    category: 'refactoring',
    test: (s) => toolPct(s, 'Edit') > 0.5 && s.filesCreated === 0 && s.filesModified >= 3,
  },
  {
    category: 'coding',
    test: (s) => toolPct(s, 'Edit', 'Write') > 0.3 && (s.filesModified >= 1 || s.filesCreated >= 1),
  },
  {
    category: 'review',
    test: (s) => toolPct(s, 'Read') > 0.5 && s.totalToolCalls >= 5 && s.filesModified <= 1 && s.filesCreated === 0,
  },
  {
    category: 'ops',
    test: (s) => toolPct(s, 'Bash') > 0.5 && toolPct(s, 'Edit', 'Write') < 0.2,
  },
];

export function classify(signals: TaskSignals): TaskCategory {
  for (const rule of RULES) {
    if (rule.test(signals)) return rule.category;
  }
  return 'unknown';
}

/** Compute signals + classify in one call, return both. */
export function classifyRun(store: ApmeStore, runId: string): { signals: TaskSignals; category: TaskCategory } {
  const signals = computeSignals(store, runId);
  const category = classify(signals);
  return { signals, category };
}

// ──�� LLM-based classification (local MLX, cost-free) ──────────────────────

const LLM_CLASSIFY_PROMPT = `You are a task classifier for coding agent sessions.
Given the user's prompt and tool usage summary, classify this task into exactly ONE category.

Categories:
- planning: architecture design, plan mode, thinking about approach
- research: searching code, reading docs, web search, investigating
- coding: writing/editing code, creating files, implementing features
- debugging: fixing bugs, running tests, investigating failures
- refactoring: restructuring existing code without changing behavior
- review: reading code for understanding, code review
- ops: git operations, deployments, config changes, CI/CD
- conversation: quick question, chat, no tools used
- multi_agent: delegating to sub-agents

Respond with ONLY the category name, nothing else.`;

/**
 * Classify a run using the local MLX server. Falls back to rule-based
 * classification if MLX is unavailable. Cost: $0 (local inference).
 */
export async function classifyWithLlm(
  taskPrompt: string,
  signals: TaskSignals,
): Promise<TaskCategory> {
  if (!taskPrompt || taskPrompt.trim().length < 5) return classify(signals);

  const toolSummary = Object.entries(signals.toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([t, c]) => `${t}×${c}`)
    .join(', ');

  const userMsg = `Prompt: "${taskPrompt.slice(0, 500)}"
Tools used: ${toolSummary || 'none'} (${signals.totalToolCalls} total)
Files modified: ${signals.filesModified}, created: ${signals.filesCreated}
Duration: ${signals.sessionDurationSec}s, turns: ${signals.turnCount}`;

  try {
    // Auto-detect MLX endpoint + model (same logic as runner.ts callMlx)
    let model = 'default';
    const base = 'http://127.0.0.1:8800';
    for (const path of ['/v1/models', '/models']) {
      const mResp = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
      if (mResp?.ok) {
        const mJson = await mResp.json() as { data?: Array<{ id?: string }> };
        const first = mJson.data?.find(m => m.id && !m.id.toLowerCase().includes('nanollava'))?.id;
        if (first) { model = first; break; }
      }
    }

    const resp = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: LLM_CLASSIFY_PROMPT },
          { role: 'user', content: userMsg },
        ],
        temperature: 0,
        max_tokens: 20,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) return classify(signals);
    const json = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
    const raw = json.choices?.[0]?.message?.content?.trim().toLowerCase().replace(/[^a-z_]/g, '') ?? '';

    if (TASK_CATEGORIES.includes(raw as TaskCategory)) return raw as TaskCategory;
    // Partial match
    const match = TASK_CATEGORIES.find(c => raw.includes(c));
    return match ?? classify(signals);
  } catch {
    // MLX not available — fall back to rules
    return classify(signals);
  }
}

/** Classify with LLM if rule-based gives unknown, otherwise use rules. */
export async function classifyRunSmart(
  store: ApmeStore,
  runId: string,
): Promise<{ signals: TaskSignals; category: TaskCategory; source: 'rule' | 'llm' }> {
  const signals = computeSignals(store, runId);
  const ruleCategory = classify(signals);

  if (ruleCategory !== 'unknown') {
    return { signals, category: ruleCategory, source: 'rule' };
  }

  // Rule-based gave unknown — try LLM
  const run = store.getRun(runId);
  const prompt = run?.taskPrompt;
  if (!prompt) return { signals, category: 'unknown', source: 'rule' };

  const llmCategory = await classifyWithLlm(prompt, signals);
  return { signals, category: llmCategory, source: llmCategory !== 'unknown' ? 'llm' : 'rule' };
}
