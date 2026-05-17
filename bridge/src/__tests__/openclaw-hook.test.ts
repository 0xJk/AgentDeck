import { describe, it, expect } from 'vitest';
import {
  openclawChatEventToSpans,
  openclawIdleGapTaskBoundary,
  openclawChatSendToSpan,
  OPENCLAW_IDLE_GAP_MS,
} from '../apme/adapters/openclaw-hook.js';
import type { AdapterContext, ChatEventPayload } from '@agentdeck/shared';

const ctx: AdapterContext = {
  sessionId: 'sess',
  agentType: 'openclaw',
  cwd: '/tmp/proj',
  traceId: 'trace-1',
  activeTurnId: undefined,
};

describe('openclaw-hook → telemetry spans', () => {
  it('OPENCLAW_IDLE_GAP_MS is conservative (60–180 s) so multi-turn collab stays together', () => {
    expect(OPENCLAW_IDLE_GAP_MS).toBeGreaterThanOrEqual(60_000);
    expect(OPENCLAW_IDLE_GAP_MS).toBeLessThanOrEqual(180_000);
  });

  it('chat.send produces exactly one turn_start span carrying the prompt text', () => {
    const span = openclawChatSendToSpan(ctx, 'fix the bug');
    expect(span.kind).toBe('turn_start');
    expect(span.attributes['agentdeck.prompt_text']).toBe('fix the bug');
    expect(span.attributes['agentdeck.agent_type']).toBe('openclaw');
  });

  it('chat.final with a response + tools yields turn_response + per-tool tool_result spans', () => {
    const payload: ChatEventPayload = {
      state: 'final',
      runId: 'r1',
      sessionKey: 'sk-1',
      response: 'I refactored auth.ts and verified the tests pass.',
      tools: [
        { name: 'bash', input: {}, status: 'success' },
        { name: 'edit', input: {}, status: 'success' },
      ],
    };
    const spans = openclawChatEventToSpans(ctx, payload);
    const kinds = spans.map((s) => s.kind);
    expect(kinds).toContain('turn_response');
    expect(kinds.filter((k) => k === 'tool_result').length).toBe(2);
    const tr = spans.find((s) => s.kind === 'turn_response')!;
    expect(tr.attributes['agentdeck.response_text']).toContain('refactored');
  });

  it('chat.delta emits no spans — deltas are streaming chunks, not eval signals', () => {
    const spans = openclawChatEventToSpans(ctx, {
      state: 'delta',
      runId: 'r1',
      delta: 'partial...',
    });
    expect(spans).toEqual([]);
  });

  it('chat.aborted emits a manual task_boundary so the user gesture closes the task immediately', () => {
    const spans = openclawChatEventToSpans(ctx, {
      state: 'aborted',
      runId: 'r1',
    });
    expect(spans.length).toBe(1);
    expect(spans[0].kind).toBe('task_boundary');
    expect(spans[0].attributes['agentdeck.boundary_signal']).toBe('manual');
  });

  it('chat.error emits nothing — the agent may retry, idle timer keeps running', () => {
    const spans = openclawChatEventToSpans(ctx, {
      state: 'error',
      runId: 'r1',
      error: 'rate limited',
    });
    expect(spans).toEqual([]);
  });

  it('idle-gap task_boundary span carries boundary_signal=idle_gap', () => {
    const span = openclawIdleGapTaskBoundary(ctx);
    expect(span.kind).toBe('task_boundary');
    expect(span.attributes['agentdeck.boundary_signal']).toBe('idle_gap');
    expect(span.attributes['agentdeck.agent_type']).toBe('openclaw');
  });

  it('all emitted spans propagate traceId for run correlation', () => {
    const finalSpans = openclawChatEventToSpans(ctx, {
      state: 'final',
      response: 'ok',
      tools: [{ name: 'bash', status: 'success' }],
    });
    const idle = openclawIdleGapTaskBoundary(ctx);
    const send = openclawChatSendToSpan(ctx, 'hi');
    for (const s of [...finalSpans, idle, send]) {
      expect(s.traceId).toBe('trace-1');
    }
  });
});
