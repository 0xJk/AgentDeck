import { describe, it, expect } from 'vitest';
import {
  opencodePartToSpans,
  opencodeMessageToSpans,
} from '../apme/adapters/opencode-hook.js';
import type { AdapterContext } from '@agentdeck/shared';
import type { OpenCodeMessagePart, OpenCodeMessageInfo } from '../opencode-client.js';

const ctx: AdapterContext = {
  sessionId: 'sess',
  agentType: 'opencode',
  cwd: '/tmp/proj',
  traceId: 'trace-1',
  activeTurnId: undefined,
};

function toolPart(over: Partial<OpenCodeMessagePart>): OpenCodeMessagePart {
  return {
    type: 'tool',
    tool: over.tool ?? 'bash',
    sessionID: 'sess',
    state: over.state ?? { status: 'running' },
    ...over,
  } as OpenCodeMessagePart;
}

describe('opencode-hook → telemetry spans', () => {
  it('tool part with status=running produces a tool_call span', () => {
    const spans = opencodePartToSpans(ctx, toolPart({ tool: 'bash', state: { status: 'running' } }));
    expect(spans.length).toBe(1);
    expect(spans[0].kind).toBe('tool_call');
    expect(spans[0].attributes['agentdeck.tool_name']).toBe('bash');
  });

  it('tool part with status=completed produces a tool_result span', () => {
    const spans = opencodePartToSpans(ctx, toolPart({
      tool: 'read',
      state: { status: 'completed', input: { path: 'foo' }, output: 'file contents' },
    }));
    expect(spans.some((s) => s.kind === 'tool_result')).toBe(true);
  });

  it('todowrite completion with all todos completed emits a task_boundary span (todo_complete)', () => {
    const part = toolPart({
      tool: 'todowrite',
      state: {
        status: 'completed',
        input: { todos: [{ status: 'completed', content: 'a' }, { status: 'completed', content: 'b' }] },
      },
    });
    const spans = opencodePartToSpans(ctx, part);
    expect(spans.some((s) =>
      s.kind === 'task_boundary' &&
      s.attributes['agentdeck.boundary_signal'] === 'todo_complete',
    )).toBe(true);
  });

  it('todowrite completion with a pending todo does NOT emit a task_boundary', () => {
    const part = toolPart({
      tool: 'todowrite',
      state: {
        status: 'completed',
        input: { todos: [{ status: 'completed', content: 'a' }, { status: 'in_progress', content: 'b' }] },
      },
    });
    const spans = opencodePartToSpans(ctx, part);
    expect(spans.some((s) => s.kind === 'task_boundary')).toBe(false);
  });

  it('todowrite reads todos out of state.output JSON string when input is absent', () => {
    const part = toolPart({
      tool: 'todowrite',
      state: {
        status: 'completed',
        output: JSON.stringify({ todos: [{ status: 'completed', content: 'a' }] }),
      },
    });
    const spans = opencodePartToSpans(ctx, part);
    expect(spans.some((s) =>
      s.kind === 'task_boundary' &&
      s.attributes['agentdeck.boundary_signal'] === 'todo_complete',
    )).toBe(true);
  });

  it('non-tool part returns an empty span list', () => {
    const partLike = { type: 'text', text: 'hello', sessionID: 'sess' } as OpenCodeMessagePart;
    const spans = opencodePartToSpans(ctx, partLike);
    expect(spans).toEqual([]);
  });

  it('message.updated for user role with prompt emits a turn_start', () => {
    const info = {
      sessionID: 'sess', role: 'user', id: 'msg1', modelID: '', providerID: '',
    } as unknown as OpenCodeMessageInfo;
    const spans = opencodeMessageToSpans(ctx, info, 'fix tests please', undefined);
    expect(spans.length).toBe(1);
    expect(spans[0].kind).toBe('turn_start');
    expect(spans[0].attributes['agentdeck.prompt_text']).toBe('fix tests please');
  });

  it('message.updated for assistant role with response emits a turn_response', () => {
    const info = {
      sessionID: 'sess', role: 'assistant', id: 'msg2', modelID: 'm', providerID: 'p',
    } as unknown as OpenCodeMessageInfo;
    const spans = opencodeMessageToSpans(ctx, info, undefined, 'done — all tests pass.');
    expect(spans.length).toBe(1);
    expect(spans[0].kind).toBe('turn_response');
  });
});
