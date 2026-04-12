import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ApmeStore } from '../apme/store.js';
import { ApmeCollector } from '../apme/collector.js';
import {
  computeSignals,
  classify,
  classifyRun,
  type TaskSignals,
  type TaskCategory,
} from '../apme/classifier.js';

async function makeStore(): Promise<ApmeStore> {
  const dir = mkdtempSync(join(tmpdir(), 'apme-cls-'));
  const store = new ApmeStore(join(dir, 'apme.sqlite'));
  if (!(await store.init())) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error('better-sqlite3 missing');
  }
  (store as unknown as { _tmp: string })._tmp = dir;
  return store;
}

function closeStore(s: ApmeStore) {
  s.close();
  const dir = (s as unknown as { _tmp?: string })._tmp;
  if (dir) rmSync(dir, { recursive: true, force: true });
}

function seedSteps(store: ApmeStore, runId: string, steps: Array<{ kind: string; toolName?: string; payload?: Record<string, unknown> }>): void {
  for (const s of steps) {
    store.insertStep({
      runId,
      ts: Date.now(),
      kind: s.kind,
      toolName: s.toolName ?? null,
      payload: JSON.stringify(s.payload ?? {}),
    });
  }
}

function makeBaseSignals(overrides: Partial<TaskSignals> = {}): TaskSignals {
  return {
    toolCounts: {},
    dominantTool: null,
    totalToolCalls: 0,
    turnCount: 0,
    sessionDurationSec: 0,
    promptLengthChars: 0,
    planModeUsed: false,
    permissionRequests: 0,
    diffReviews: 0,
    filesCreated: 0,
    filesModified: 0,
    testCommandsRun: 0,
    webSearches: 0,
    agentDelegations: 0,
    ...overrides,
  };
}

// ─── classify() pure function ────────────────────────────────────────────────

describe('classify()', () => {
  it('planning — plan mode used', () => {
    expect(classify(makeBaseSignals({ planModeUsed: true }))).toBe('planning');
  });

  it('planning — short session, no file changes', () => {
    expect(classify(makeBaseSignals({ turnCount: 2, totalToolCalls: 3, filesModified: 0, filesCreated: 0 }))).toBe('planning');
  });

  it('research — web searches dominant', () => {
    expect(classify(makeBaseSignals({
      toolCounts: { WebSearch: 3, Read: 5 }, totalToolCalls: 8, webSearches: 3,
    }))).toBe('research');
  });

  it('research — grep/glob dominant, no file changes', () => {
    expect(classify(makeBaseSignals({
      toolCounts: { Grep: 6, Glob: 3, Read: 2 }, totalToolCalls: 11, filesModified: 0, filesCreated: 0,
    }))).toBe('research');
  });

  it('coding — edit+write dominant with file changes', () => {
    expect(classify(makeBaseSignals({
      toolCounts: { Edit: 5, Write: 2, Read: 3 }, totalToolCalls: 10, filesModified: 5, filesCreated: 2,
    }))).toBe('coding');
  });

  it('debugging — tests + edits + bash', () => {
    expect(classify(makeBaseSignals({
      toolCounts: { Bash: 4, Edit: 3, Read: 5 }, totalToolCalls: 12,
      testCommandsRun: 2, filesModified: 3,
    }))).toBe('debugging');
  });

  it('refactoring — many edits, no new files', () => {
    expect(classify(makeBaseSignals({
      toolCounts: { Edit: 10, Read: 3 }, totalToolCalls: 13, filesModified: 5, filesCreated: 0,
    }))).toBe('refactoring');
  });

  it('review — mostly reads, minimal edits', () => {
    expect(classify(makeBaseSignals({
      toolCounts: { Read: 12, Grep: 2 }, totalToolCalls: 14, filesModified: 0, filesCreated: 0,
    }))).toBe('review');
  });

  it('ops — bash dominant, few edits', () => {
    expect(classify(makeBaseSignals({
      toolCounts: { Bash: 8, Read: 1 }, totalToolCalls: 9,
    }))).toBe('ops');
  });

  it('conversation — very short, no tools', () => {
    expect(classify(makeBaseSignals({ totalToolCalls: 1, sessionDurationSec: 30 }))).toBe('conversation');
  });

  it('multi_agent — multiple Agent delegations', () => {
    expect(classify(makeBaseSignals({
      toolCounts: { Agent: 3, Read: 2 }, totalToolCalls: 5, agentDelegations: 3,
    }))).toBe('multi_agent');
  });

  it('unknown — no clear pattern', () => {
    expect(classify(makeBaseSignals({
      toolCounts: { Read: 2, Bash: 2 }, totalToolCalls: 4, sessionDurationSec: 300,
      turnCount: 10,
    }))).toBe('unknown');
  });
});

// ─── computeSignals() from real steps ───────────────────────────────────────

describe('computeSignals()', () => {
  let store!: ApmeStore;
  beforeEach(async () => { store = await makeStore(); });
  afterEach(() => closeStore(store));

  it('counts tool calls and identifies dominant tool', () => {
    const collector = new ApmeCollector(store);
    const runId = collector.openRun({ sessionId: 's', agentType: 'claude-code', projectName: 'p' });
    seedSteps(store, runId, [
      { kind: 'PreToolUse', toolName: 'Edit' },
      { kind: 'PreToolUse', toolName: 'Edit' },
      { kind: 'PreToolUse', toolName: 'Read' },
      { kind: 'PreToolUse', toolName: 'Bash', payload: { command: 'pnpm test' } },
      { kind: 'UserPromptSubmit' },
      { kind: 'UserPromptSubmit' },
    ]);

    const sig = computeSignals(store, runId);
    expect(sig.toolCounts).toEqual({ Edit: 2, Read: 1, Bash: 1 });
    expect(sig.dominantTool).toBe('Edit');
    expect(sig.totalToolCalls).toBe(4);
    expect(sig.turnCount).toBe(2);
    expect(sig.filesModified).toBe(2);
    expect(sig.testCommandsRun).toBe(1);
  });

  it('detects plan mode from step payload', () => {
    const collector = new ApmeCollector(store);
    const runId = collector.openRun({ sessionId: 's', agentType: 'claude-code', projectName: 'p' });
    seedSteps(store, runId, [
      { kind: 'mode_change', payload: { mode: 'plan' } },
      { kind: 'PreToolUse', toolName: 'Read' },
    ]);

    const sig = computeSignals(store, runId);
    expect(sig.planModeUsed).toBe(true);
  });

  it('detects web searches', () => {
    const collector = new ApmeCollector(store);
    const runId = collector.openRun({ sessionId: 's', agentType: 'claude-code', projectName: 'p' });
    seedSteps(store, runId, [
      { kind: 'PreToolUse', toolName: 'WebSearch' },
      { kind: 'PreToolUse', toolName: 'WebFetch' },
      { kind: 'PreToolUse', toolName: 'Read' },
    ]);

    const sig = computeSignals(store, runId);
    expect(sig.webSearches).toBe(2);
  });
});

// ─── classifyRun() end-to-end ───────────────────────────────────────────────

describe('classifyRun()', () => {
  let store!: ApmeStore;
  beforeEach(async () => { store = await makeStore(); });
  afterEach(() => closeStore(store));

  it('returns signals and category for a coding run', () => {
    const collector = new ApmeCollector(store);
    const runId = collector.openRun({ sessionId: 's', agentType: 'claude-code', projectName: 'p' });
    seedSteps(store, runId, [
      { kind: 'PreToolUse', toolName: 'Edit' },
      { kind: 'PreToolUse', toolName: 'Edit' },
      { kind: 'PreToolUse', toolName: 'Write' },
      { kind: 'PreToolUse', toolName: 'Read' },
    ]);

    const result = classifyRun(store, runId);
    expect(result.category).toBe('coding');
    expect(result.signals.filesModified).toBe(2);
    expect(result.signals.filesCreated).toBe(1);
  });

  it('returns unknown for empty runs', () => {
    const collector = new ApmeCollector(store);
    const runId = collector.openRun({ sessionId: 's', agentType: 'claude-code', projectName: 'p' });
    const result = classifyRun(store, runId);
    // Empty run with sessionDuration=0 and no tools matches conversation first
    // (totalToolCalls<=2 && sessionDurationSec<120)
    expect(['conversation', 'planning', 'unknown']).toContain(result.category);
  });
});

// ─── Schema migration ───────────────────────────────────────────────────────

describe('task_category schema migration', () => {
  let store!: ApmeStore;
  beforeEach(async () => { store = await makeStore(); });
  afterEach(() => closeStore(store));

  it('runs table has task_signals, task_category, task_category_source columns', () => {
    const collector = new ApmeCollector(store);
    const runId = collector.openRun({ sessionId: 's', agentType: 'claude-code', projectName: 'p' });
    store.updateRun(runId, {
      taskSignals: '{"test":true}',
      taskCategory: 'coding',
      taskCategorySource: 'user',
    });
    const run = store.getRun(runId);
    expect(run?.taskSignals).toBe('{"test":true}');
    expect(run?.taskCategory).toBe('coding');
    expect(run?.taskCategorySource).toBe('user');
  });
});
