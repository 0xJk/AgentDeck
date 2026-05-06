/**
 * Coverage for the telemetry-envelope ingestion path.
 *
 * Two layers under test:
 *   1. Adapters (claude-hook / claude-pty / timeline) — pure functions that
 *      translate per-source events into TelemetrySpan[]. Verified by direct
 *      input/output assertions, no DB.
 *   2. ingestSpan dispatch — uses a real SQLite store to confirm each span
 *      kind reaches the right collector method (turn opens, response stored,
 *      tool counters increment, /clear splits the run).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { AdapterContext } from '@agentdeck/shared';
import { EVAL_SCHEMA_VERSION, spanNameForKind } from '@agentdeck/shared';

import { claudeHookToSpans } from '../apme/adapters/claude-hook.js';
import {
  claudePtyParserEventToSpans,
  claudePtyResponseToSpan,
} from '../apme/adapters/claude-pty.js';
import { timelineEntryToSpans } from '../apme/adapters/timeline.js';
import { ApmeStore } from '../apme/store.js';
import { ApmeCollector } from '../apme/collector.js';

function ctx(extra: Partial<AdapterContext> = {}): AdapterContext {
  return {
    sessionId: 'sess-1',
    agentType: 'claude-code',
    traceId: 'trace-1',
    cwd: '/tmp/proj',
    ...extra,
  };
}

// ─── Adapter unit tests (no DB) ───────────────────────────────────────────────

describe('claudeHookToSpans', () => {
  it('emits turn_start with prompt for UserPromptSubmit', () => {
    const spans = claudeHookToSpans(ctx(), 'UserPromptSubmit', {
      message: { content: 'fix the bug' },
    });
    expect(spans).toHaveLength(1);
    expect(spans[0].kind).toBe('turn_start');
    expect(spans[0].name).toBe(spanNameForKind('turn_start'));
    expect(spans[0].attributes['agentdeck.prompt_text']).toBe('fix the bug');
    expect(spans[0].attributes['agentdeck.agent_type']).toBe('claude-code');
    expect(spans[0].attributes['agentdeck.cwd']).toBe('/tmp/proj');
  });

  it('detects /clear and emits a task_boundary span (not turn_start)', () => {
    const spans = claudeHookToSpans(ctx(), 'UserPromptSubmit', {
      message: { content: '/clear' },
    });
    expect(spans).toHaveLength(1);
    expect(spans[0].kind).toBe('task_boundary');
    expect(spans[0].attributes['agentdeck.boundary_signal']).toBe('clear');
    // Must not also emit a turn_start — that would create a phantom turn.
    expect(spans.find(s => s.kind === 'turn_start')).toBeUndefined();
  });

  it('emits tool_call for PreToolUse with gen_ai.tool.name', () => {
    const spans = claudeHookToSpans(ctx(), 'PreToolUse', {
      tool_name: 'Edit',
      tool_input: { path: 'foo.ts' },
    });
    expect(spans).toHaveLength(1);
    expect(spans[0].kind).toBe('tool_call');
    expect(spans[0].attributes['gen_ai.tool.name']).toBe('Edit');
    expect(spans[0].attributes['agentdeck.tool_name']).toBe('Edit');
    // Raw payload preserved so the collector can detect TodoWrite all-completed.
    expect(spans[0].attributes['agentdeck.raw_payload']).toMatchObject({ tool_name: 'Edit' });
  });

  it('emits tool_result for PostToolUse', () => {
    const spans = claudeHookToSpans(ctx(), 'PostToolUse', { tool_name: 'TodoWrite' });
    expect(spans[0].kind).toBe('tool_result');
    expect(spans[0].attributes['gen_ai.tool.name']).toBe('TodoWrite');
  });

  it('falls through to raw_step for unknown events (Stop, SessionEnd, …)', () => {
    const spans = claudeHookToSpans(ctx(), 'Stop', { transcript_path: '/x' });
    expect(spans[0].kind).toBe('raw_step');
    expect(spans[0].attributes['agentdeck.raw_event']).toBe('Stop');
    expect(spans[0].attributes['agentdeck.raw_payload']).toMatchObject({ transcript_path: '/x' });
  });

  it('handles legacy { prompt: ... } shape on UserPromptSubmit', () => {
    const spans = claudeHookToSpans(ctx(), 'UserPromptSubmit', { prompt: 'hello' });
    expect(spans[0].attributes['agentdeck.prompt_text']).toBe('hello');
  });
});

describe('claudePtyParserEventToSpans', () => {
  it('maps tool_start to a tool_call span', () => {
    const spans = claudePtyParserEventToSpans(ctx(), 'tool_start', { tool_name: 'Bash' });
    expect(spans).toHaveLength(1);
    expect(spans[0].kind).toBe('tool_call');
    expect(spans[0].attributes['gen_ai.tool.name']).toBe('Bash');
    // Raw event is the legacy hook name so ingestSpan dispatches via PreToolUse.
    expect(spans[0].attributes['agentdeck.raw_event']).toBe('PreToolUse');
  });

  it('maps tool_end to a tool_result span', () => {
    const spans = claudePtyParserEventToSpans(ctx(), 'tool_end', { tool_name: 'Bash' });
    expect(spans[0].kind).toBe('tool_result');
    expect(spans[0].attributes['agentdeck.raw_event']).toBe('PostToolUse');
  });

  it('emits a raw_step for spinner_start/idle/spinner_stop', () => {
    expect(claudePtyParserEventToSpans(ctx(), 'spinner_start')[0].kind).toBe('raw_step');
    expect(claudePtyParserEventToSpans(ctx(), 'idle')[0].kind).toBe('raw_step');
    expect(claudePtyParserEventToSpans(ctx(), 'spinner_stop')[0].kind).toBe('raw_step');
  });

  it('drops unknown parser events', () => {
    expect(claudePtyParserEventToSpans(ctx(), 'something_else')).toHaveLength(0);
  });
});

describe('claudePtyResponseToSpan', () => {
  it('returns a turn_response span for non-trivial text', () => {
    const span = claudePtyResponseToSpan(ctx(), 'Done — patched the bug.');
    expect(span).not.toBeNull();
    expect(span!.kind).toBe('turn_response');
    expect(span!.attributes['agentdeck.response_text']).toBe('Done — patched the bug.');
    expect(span!.attributes['agentdeck.fallback_to_last_closed']).toBeUndefined();
  });

  it('marks fallback_to_last_closed when requested', () => {
    const span = claudePtyResponseToSpan(ctx(), 'late response', {
      fallbackToLastClosed: true,
    });
    expect(span!.attributes['agentdeck.fallback_to_last_closed']).toBe(true);
  });

  it('returns null for empty / single-character text (filters silence)', () => {
    expect(claudePtyResponseToSpan(ctx(), '')).toBeNull();
    expect(claudePtyResponseToSpan(ctx(), '   ')).toBeNull();
    expect(claudePtyResponseToSpan(ctx(), '.')).toBeNull();
  });
});

describe('timelineEntryToSpans', () => {
  it('translates chat_start to turn_start with detail as prompt', () => {
    const spans = timelineEntryToSpans(ctx({ agentType: 'openclaw' }), {
      ts: 1, type: 'chat_start', raw: 'Prompt sent', detail: 'fix the bug',
      agentType: 'openclaw',
    });
    expect(spans[0].kind).toBe('turn_start');
    expect(spans[0].attributes['agentdeck.prompt_text']).toBe('fix the bug');
  });

  it('translates chat_response to turn_response', () => {
    const spans = timelineEntryToSpans(ctx({ agentType: 'opencode' }), {
      ts: 2, type: 'chat_response', raw: '', detail: 'patched it',
      agentType: 'opencode',
    });
    expect(spans[0].kind).toBe('turn_response');
    expect(spans[0].attributes['agentdeck.response_text']).toBe('patched it');
    expect(spans[0].attributes['agentdeck.fallback_to_last_closed']).toBeUndefined();
  });

  it('translates chat_end with response detail to turn_response with fallback flag', () => {
    const spans = timelineEntryToSpans(ctx({ agentType: 'opencode' }), {
      ts: 3, type: 'chat_end', raw: '', detail: 'final response',
      agentType: 'opencode',
    });
    expect(spans[0].kind).toBe('turn_response');
    expect(spans[0].attributes['agentdeck.fallback_to_last_closed']).toBe(true);
  });

  it('drops chat_response / chat_end with empty body', () => {
    expect(timelineEntryToSpans(ctx(), {
      ts: 4, type: 'chat_response', raw: '', detail: '', agentType: 'openclaw',
    })).toHaveLength(0);
    expect(timelineEntryToSpans(ctx(), {
      ts: 5, type: 'chat_end', raw: '', detail: '', agentType: 'openclaw',
    })).toHaveLength(0);
  });

  it('translates tool_request with first-token tool name', () => {
    const spans = timelineEntryToSpans(ctx({ agentType: 'openclaw' }), {
      ts: 6, type: 'tool_request', raw: 'Bash echo hi', agentType: 'openclaw',
    });
    expect(spans[0].kind).toBe('tool_call');
    expect(spans[0].attributes['gen_ai.tool.name']).toBe('Bash');
  });

  it('translates tool_exec the same as tool_request (legacy + Codex paths)', () => {
    const spans = timelineEntryToSpans(ctx({ agentType: 'codex-cli' }), {
      ts: 6, type: 'tool_exec', raw: 'shell ls -la', agentType: 'codex-cli',
    });
    expect(spans).toHaveLength(1);
    expect(spans[0].kind).toBe('tool_call');
    expect(spans[0].attributes['gen_ai.tool.name']).toBe('shell');
    expect(spans[0].attributes['agentdeck.tool_name']).toBe('shell');
  });

  it('translates tool_resolved to a tool_result span', () => {
    const spans = timelineEntryToSpans(ctx({ agentType: 'openclaw' }), {
      ts: 7, type: 'tool_resolved', raw: '', agentType: 'openclaw',
    });
    expect(spans[0].kind).toBe('tool_result');
  });
});

// ─── ingestSpan dispatch tests (with real SQLite) ─────────────────────────────

async function makeCollector(): Promise<{ store: ApmeStore; collector: ApmeCollector; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'apme-envelope-'));
  const store = new ApmeStore(join(dir, 'apme.sqlite'));
  const ok = await store.init();
  if (!ok) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error('APME store failed to init — is better-sqlite3 installed?');
  }
  return { store, collector: new ApmeCollector(store), dir };
}

describe('ApmeCollector.ingestSpan dispatch', () => {
  let store: ApmeStore;
  let collector: ApmeCollector;
  let tmp: string;

  beforeEach(async () => {
    const made = await makeCollector();
    store = made.store;
    collector = made.collector;
    tmp = made.dir;
    collector.openRun({
      sessionId: 'S',
      agentType: 'claude-code',
      modelId: 'claude-opus-4-7',
      projectPath: tmp,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('turn_start span opens a turn and records the prompt', () => {
    const spans = claudeHookToSpans(ctx(), 'UserPromptSubmit', {
      message: { content: 'do the thing' },
    });
    for (const s of spans) collector.ingestSpan('S', s);

    const turnId = collector.getActiveTurnId('S');
    expect(turnId).not.toBeNull();
    const turn = store.getTurn(turnId!);
    expect(turn?.prompt).toBe('do the thing');
  });

  it('turn_response span persists the response on the active turn', () => {
    for (const s of claudeHookToSpans(ctx(), 'UserPromptSubmit', { message: { content: 'q' } })) {
      collector.ingestSpan('S', s);
    }
    const turnId = collector.getActiveTurnId('S');
    const span = claudePtyResponseToSpan(ctx(), 'the answer is 42');
    collector.ingestSpan('S', span!);
    expect(store.getTurn(turnId!)?.response).toBe('the answer is 42');
  });

  it('tool_call span increments tool_calls on the active turn', () => {
    for (const s of claudeHookToSpans(ctx(), 'UserPromptSubmit', { message: { content: 'q' } })) {
      collector.ingestSpan('S', s);
    }
    const firstTurnId = collector.getActiveTurnId('S');
    for (const s of claudeHookToSpans(ctx(), 'PreToolUse', { tool_name: 'Bash' })) {
      collector.ingestSpan('S', s);
    }
    for (const s of claudeHookToSpans(ctx(), 'PreToolUse', { tool_name: 'Edit' })) {
      collector.ingestSpan('S', s);
    }
    // tool_calls is buffered in memory and flushed on closeTurn(); open a
    // second turn to force the first one closed, then read its row.
    for (const s of claudeHookToSpans(ctx(), 'UserPromptSubmit', { message: { content: 'next' } })) {
      collector.ingestSpan('S', s);
    }
    const turn = store.getTurn(firstTurnId!);
    expect(turn?.tool_calls).toBe(2);
  });

  it('task_boundary span with signal=clear splits the run', () => {
    const beforeRunId = collector.getRunId('S');
    expect(beforeRunId).toBeTruthy();
    for (const s of claudeHookToSpans(ctx(), 'UserPromptSubmit', { message: { content: '/clear' } })) {
      collector.ingestSpan('S', s);
    }
    const afterRunId = collector.getRunId('S');
    expect(afterRunId).toBeTruthy();
    expect(afterRunId).not.toBe(beforeRunId);
  });

  it('raw_step span inserts a steps row without lifecycle effects', () => {
    for (const s of claudeHookToSpans(ctx(), 'UserPromptSubmit', { message: { content: 'q' } })) {
      collector.ingestSpan('S', s);
    }
    const beforeTurnId = collector.getActiveTurnId('S');
    for (const s of claudeHookToSpans(ctx(), 'Stop', { transcript_path: '/tmp/x' })) {
      collector.ingestSpan('S', s);
    }
    // Stop must NOT close or change the active turn.
    expect(collector.getActiveTurnId('S')).toBe(beforeTurnId);
    const runId = collector.getRunId('S')!;
    const steps = store.listSteps(runId);
    expect(steps.find(s => s.kind === 'Stop')).toBeDefined();
  });

  it('session_meta span updates the model id on the run', () => {
    collector.ingestSpan('S', {
      traceId: 'T', spanId: '1', name: 'agentdeck.session.meta',
      kind: 'session_meta', ts: Date.now(),
      attributes: { 'gen_ai.request.model': 'claude-haiku-4-5-20251001' },
    });
    const runId = collector.getRunId('S')!;
    const run = store.getRun(runId);
    expect(run?.modelId).toBe('claude-haiku-4-5-20251001');
  });

  it('timeline adapter feeds the same dispatch path correctly', () => {
    const spans = timelineEntryToSpans(ctx({ agentType: 'openclaw' }), {
      ts: Date.now(), type: 'chat_start', raw: '',
      detail: 'investigate the bug',
      agentType: 'openclaw',
    });
    for (const s of spans) collector.ingestSpan('S', s);
    const turnId = collector.getActiveTurnId('S');
    expect(turnId).not.toBeNull();
    expect(store.getTurn(turnId!)?.prompt).toBe('investigate the bug');
  });
});

describe('eval-schema constants', () => {
  it('exports a stable schema version string', () => {
    expect(EVAL_SCHEMA_VERSION).toBe('agentdeck-eval/v1');
  });
});
