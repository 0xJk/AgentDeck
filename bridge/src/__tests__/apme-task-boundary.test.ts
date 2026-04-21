import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ApmeStore } from '../apme/store.js';
import { ApmeCollector } from '../apme/collector.js';
import { ApmeRunner } from '../apme/runner.js';

// Task-unit evaluation: TodoWrite all-completed / /clear / session_end
// become automatic task boundaries. See plans/…-silly-horizon.md for the
// rationale (Claude Code's built-in recap is not hookable and is not a
// task-completion signal).

async function makeStore(): Promise<ApmeStore> {
  const dir = mkdtempSync(join(tmpdir(), 'apme-task-'));
  const store = new ApmeStore(join(dir, 'apme.sqlite'));
  const ok = await store.init();
  if (!ok) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error('APME store failed to initialize — is better-sqlite3 installed?');
  }
  (store as unknown as { _tmpDir: string })._tmpDir = dir;
  return store;
}

function cleanup(store: ApmeStore) {
  store.close();
  const dir = (store as unknown as { _tmpDir?: string })._tmpDir;
  if (dir) rmSync(dir, { recursive: true, force: true });
}

function openRun(collector: ApmeCollector): { runId: string; sessionId: string } {
  const sessionId = 'task-test-session';
  const runId = collector.openRun({
    sessionId,
    agentType: 'claude-code',
    projectName: 'demo',
    projectPath: '/tmp/demo',
  });
  return { runId, sessionId };
}

describe('ApmeCollector task boundaries', () => {
  let store!: ApmeStore;
  beforeEach(async () => { store = await makeStore(); });
  afterEach(() => { cleanup(store); });

  it('first UserPromptSubmit opens a task and attaches the turn', () => {
    const collector = new ApmeCollector(store);
    const { runId, sessionId } = openRun(collector);

    collector.ingestHook(sessionId, 'UserPromptSubmit', { prompt: 'hello' });

    const tasks = store.listTasksForRun(runId);
    expect(tasks.length).toBe(1);
    expect(tasks[0].taskIndex).toBe(0);
    expect(tasks[0].endedAt).toBeNull();
    expect(collector.getActiveTaskId(sessionId)).toBe(tasks[0].id);

    const turns = store.listTurns(runId) as Array<Record<string, unknown>>;
    expect(turns.length).toBe(1);
    expect(turns[0].task_id).toBe(tasks[0].id);
  });

  it('TodoWrite with every todo completed closes the active task', () => {
    const collector = new ApmeCollector(store);
    const { runId, sessionId } = openRun(collector);

    collector.ingestHook(sessionId, 'UserPromptSubmit', { prompt: 'build plan' });
    collector.ingestHook(sessionId, 'PreToolUse', { tool_name: 'TodoWrite' });
    collector.ingestHook(sessionId, 'PostToolUse', {
      tool_name: 'TodoWrite',
      tool_input: {
        todos: [
          { content: 'a', status: 'completed', activeForm: 'doing a' },
          { content: 'b', status: 'completed', activeForm: 'doing b' },
        ],
      },
    });

    const tasks = store.listTasksForRun(runId);
    expect(tasks.length).toBe(1);
    expect(tasks[0].boundarySignal).toBe('todo_complete');
    expect(tasks[0].endedAt).toBeGreaterThan(0);
    expect(collector.getActiveTaskId(sessionId)).toBeNull();
  });

  it('TodoWrite with partial completion does NOT close the task', () => {
    const collector = new ApmeCollector(store);
    const { runId, sessionId } = openRun(collector);

    collector.ingestHook(sessionId, 'UserPromptSubmit', { prompt: 'p' });
    collector.ingestHook(sessionId, 'PostToolUse', {
      tool_name: 'TodoWrite',
      tool_input: {
        todos: [
          { content: 'a', status: 'completed' },
          { content: 'b', status: 'in_progress' },
        ],
      },
    });

    const tasks = store.listTasksForRun(runId);
    expect(tasks.length).toBe(1);
    expect(tasks[0].endedAt).toBeNull();
    expect(tasks[0].boundarySignal).toBe('open');
  });

  it('next UserPromptSubmit after boundary opens a new task', () => {
    const collector = new ApmeCollector(store);
    const { runId, sessionId } = openRun(collector);

    collector.ingestHook(sessionId, 'UserPromptSubmit', { prompt: 'first' });
    collector.ingestHook(sessionId, 'PostToolUse', {
      tool_name: 'TodoWrite',
      tool_input: { todos: [{ content: 'a', status: 'completed' }] },
    });
    collector.ingestHook(sessionId, 'UserPromptSubmit', { prompt: 'second' });

    const tasks = store.listTasksForRun(runId);
    expect(tasks.length).toBe(2);
    expect(tasks[0].taskIndex).toBe(0);
    expect(tasks[1].taskIndex).toBe(1);
    expect(tasks[0].endedAt).toBeGreaterThan(0);
    expect(tasks[1].endedAt).toBeNull();
  });

  it('splitRun closes the active task with boundary=clear', () => {
    const collector = new ApmeCollector(store);
    const { runId: firstRun, sessionId } = openRun(collector);
    collector.ingestHook(sessionId, 'UserPromptSubmit', { prompt: 'pre-clear' });

    const newRunId = collector.splitRun(sessionId, '/tmp/demo');
    expect(newRunId).toBeTruthy();
    expect(newRunId).not.toBe(firstRun);

    const tasksFirst = store.listTasksForRun(firstRun);
    expect(tasksFirst.length).toBe(1);
    expect(tasksFirst[0].boundarySignal).toBe('clear');
    expect(tasksFirst[0].endedAt).toBeGreaterThan(0);
  });

  it('closeRun closes the active task with boundary=session_end', () => {
    const collector = new ApmeCollector(store);
    const { runId, sessionId } = openRun(collector);
    collector.ingestHook(sessionId, 'UserPromptSubmit', { prompt: 'x' });

    collector.closeRun(sessionId, 0, '/tmp/demo');

    const tasks = store.listTasksForRun(runId);
    expect(tasks.length).toBe(1);
    expect(tasks[0].boundarySignal).toBe('session_end');
    expect(tasks[0].endedAt).toBeGreaterThan(0);
  });

  it('onTaskClosed fires with the task metadata', () => {
    const collector = new ApmeCollector(store);
    const seen: Array<{ taskId: string; runId: string; boundarySignal: string }> = [];
    collector.onTaskClosed = ({ taskId, runId, boundarySignal }) => {
      seen.push({ taskId, runId, boundarySignal });
    };
    const { runId, sessionId } = openRun(collector);
    collector.ingestHook(sessionId, 'UserPromptSubmit', { prompt: 'x' });
    collector.ingestHook(sessionId, 'PostToolUse', {
      tool_name: 'TodoWrite',
      tool_input: { todos: [{ content: 'a', status: 'completed' }] },
    });

    expect(seen.length).toBe(1);
    expect(seen[0].runId).toBe(runId);
    expect(seen[0].boundarySignal).toBe('todo_complete');
  });

  it('empty task (no turns between two boundaries) is dropped', () => {
    const collector = new ApmeCollector(store);
    const { runId, sessionId } = openRun(collector);

    // Turn 0 + boundary → task 0 closed (has a turn, kept)
    collector.ingestHook(sessionId, 'UserPromptSubmit', { prompt: 'x' });
    collector.ingestHook(sessionId, 'PostToolUse', {
      tool_name: 'TodoWrite',
      tool_input: { todos: [{ content: 'a', status: 'completed' }] },
    });
    // closeRun before a new turn: task 1 would be the "empty" auto-opened one.
    // In practice openTaskIfNone only runs on UserPromptSubmit, so no new task
    // exists here — but session_end should still leave exactly task 0.
    collector.closeRun(sessionId, 0, '/tmp/demo');

    const tasks = store.listTasksForRun(runId);
    expect(tasks.length).toBe(1);
    expect(tasks[0].taskIndex).toBe(0);
  });
});

describe('ApmeRunner task eval', () => {
  let store!: ApmeStore;
  beforeEach(async () => { store = await makeStore(); });
  afterEach(() => { cleanup(store); });

  it('enqueueTask invokes judge with turns and persists summary + scores', async () => {
    const collector = new ApmeCollector(store);
    const runner = new ApmeRunner(store);

    // Mock judge — capture prompt, return a task_rollup-shaped JSON.
    let capturedPrompt = '';
    runner._setJudgeFn(async (prompt) => {
      capturedPrompt = prompt;
      return JSON.stringify({
        summary: 'Added task boundary detection.',
        completion: 0.9, coherence: 0.8, efficiency: 0.7, overall: 0.85,
        reasoning: 'Agent completed the feature end-to-end.',
        done: ['boundary detection'],
        missed: [],
      });
    });

    // Force enabled config with MLX backend (judge is mocked anyway).
    runner._setConfig({
      enabled: true,
      deterministic: { enabled: false, timeoutSec: 1, commands: {} },
      judge: { backend: 'mlx', model: 'test', fallbackToMlx: false },
    } as unknown as import('../apme/settings.js').ApmeConfig);

    collector.onTaskClosed = ({ taskId, runId, taskCategory }) => {
      runner.enqueueTask({ runId, taskId, category: taskCategory ?? undefined });
    };

    const sessionId = 'runner-test';
    const runId = collector.openRun({
      sessionId, agentType: 'claude-code', projectName: 'demo',
    });
    collector.ingestHook(sessionId, 'UserPromptSubmit', { prompt: 'hi' });
    // Provide a response on the active turn so it's not all tool_only/empty.
    collector.setTurnResponse(sessionId, 'Sure — here is the plan.');
    collector.ingestHook(sessionId, 'PostToolUse', {
      tool_name: 'TodoWrite',
      tool_input: { todos: [{ content: 'a', status: 'completed' }] },
    });

    // Drain microtasks until the fire-and-forget task eval settles.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const tasks = store.listTasksForRun(runId);
    expect(tasks.length).toBe(1);
    expect(tasks[0].summary).toBe('Added task boundary detection.');
    expect(tasks[0].compositeScore).toBeCloseTo(0.85, 2);

    expect(capturedPrompt).toContain('--- TURNS ---');
    expect(capturedPrompt).toContain('Sure — here is the plan.');

    const evals = store.listEvalsForTask(tasks[0].id);
    const metrics = new Set(evals.map((e) => e.metric));
    expect(metrics.has('overall')).toBe(true);
    expect(metrics.has('completion')).toBe(true);
    expect(evals.every((e) => e.layer === 'task_judge')).toBe(true);
  });

  it('skips task eval when all turns are tool_only / empty', async () => {
    const collector = new ApmeCollector(store);
    const runner = new ApmeRunner(store);

    let called = 0;
    runner._setJudgeFn(async () => { called++; return '{}'; });
    runner._setConfig({
      enabled: true,
      deterministic: { enabled: false, timeoutSec: 1, commands: {} },
      judge: { backend: 'mlx', model: 'test', fallbackToMlx: false },
    } as unknown as import('../apme/settings.js').ApmeConfig);

    collector.onTaskClosed = ({ taskId, runId, taskCategory }) => {
      runner.enqueueTask({ runId, taskId, category: taskCategory ?? undefined });
    };

    const sessionId = 'empty-turns-session';
    collector.openRun({ sessionId, agentType: 'claude-code', projectName: 'demo' });
    // Prompt is empty AND response is empty → meaningful-text check fails.
    collector.ingestHook(sessionId, 'UserPromptSubmit', { prompt: '' });
    // Intentionally no setTurnResponse — the turn stays empty.
    collector.ingestHook(sessionId, 'PostToolUse', {
      tool_name: 'TodoWrite',
      tool_input: { todos: [{ content: 'a', status: 'completed' }] },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(called).toBe(0);
  });
});
