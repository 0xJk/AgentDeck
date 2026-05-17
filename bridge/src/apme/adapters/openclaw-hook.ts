/**
 * OpenClaw Gateway event → TelemetrySpan adapter.
 *
 * OpenClaw is a chat-style remote agent reached over a WebSocket Gateway
 * (`shared/src/gateway-protocol.ts`). Unlike Claude Code (Stop hook +
 * PostToolUse TodoWrite) and Codex CLI (hook system), OpenClaw never emits a
 * structured "task complete" signal — it streams `chat.delta` chunks during
 * generation and a single `chat.final` per assistant turn. With nothing
 * stronger to anchor a task to, OpenClaw previously fell back to
 * `session_end` only, collapsing every chat session to a single APME task
 * and defeating per-task evaluation.
 *
 * # Boundary signal: idle_gap (90 s)
 *
 * The chosen boundary is **idle_gap**: after `chat.final`, if the user
 * doesn't send a new `chat.send` within 90 seconds, treat the conversation
 * as one closed task. Rationale, derived from inspecting the chat-final /
 * chat-delta fixture set (`tests/parity/gateway-frames/`) and the four
 * scenario classes that ship in the audit plan:
 *
 *   (a) Single Q/A         → 1 final, no follow-up → idle_gap fires once.
 *   (b) Multi-turn collab  → user keeps replying within 90 s → 1 task
 *                            (collaboration stays together).
 *   (c) Long task w/ Qs    → same as (b), user clarifications keep the
 *                            idle timer reset until the agent fully closes
 *                            the topic.
 *   (d) Abrupt new topic   → if the pivot happens within 90 s of the
 *                            previous final, this v1 will lump both into
 *                            one task. Acceptable v1 limitation —
 *                            user-driven `manual` boundary or longer
 *                            silence between topics splits them. A future
 *                            topic-shift embedder is the obvious next step.
 *
 * 90 s is conservative: long enough that genuine multi-turn debugging
 * stays together, short enough that a real "I'm done, walking away"
 * gesture closes the task within a normal coffee break. The threshold is
 * exposed as `OPENCLAW_IDLE_GAP_MS` so a downstream consumer can override
 * for a hot-research session if needed.
 *
 * # Alternative boundaries considered (rejected for v1)
 *
 *   - `chat.final` per turn: too granular — every user/assistant turn pair
 *     would be its own task. Defeats the "what did the agent accomplish"
 *     framing — evaluation should span the work, not the words.
 *   - Embedding-based topic shift: cost-heavy + cold-start fragile. Not v1.
 *   - Gateway `taskCompleted` event: no such event in `GatewayEventPayload`
 *     union. Adding it requires the OpenClaw server to emit it, which the
 *     bridge can't unilaterally do.
 *
 * # Wiring
 *
 * `bridge/src/adapters/openclaw.ts` calls `openclawChatEventToSpans(ctx,
 * payload)` from its `chat` event branch and forwards the resulting spans
 * to `apme.collector.ingestSpan`. The idle timer is owned by the OpenClaw
 * adapter (not this module) because it needs access to the active session
 * id and an actual `setTimeout`. This module is pure — given a payload it
 * returns the spans the adapter should currently emit, no side effects.
 */

import { randomUUID } from 'crypto';
import type {
  AdapterContext,
  TelemetrySpan,
  TelemetryAttributes,
  ChatEventPayload,
} from '@agentdeck/shared';
import { spanNameForKind } from '@agentdeck/shared';

/** Default idle-gap threshold after `chat.final` before we close the task. */
export const OPENCLAW_IDLE_GAP_MS = 90_000;

/**
 * Convert a Gateway `chat` event payload into the spans the APME collector
 * should ingest right now. Does NOT emit the idle-gap `task_boundary` —
 * that's owned by the adapter's timer (it needs setTimeout + per-session
 * state). Callers should also fire `emitIdleGapTaskBoundary(...)` when the
 * idle timer expires.
 */
export function openclawChatEventToSpans(
  ctx: AdapterContext,
  payload: ChatEventPayload,
): TelemetrySpan[] {
  const ts = Date.now();
  const baseAttrs: TelemetryAttributes = {
    'agentdeck.agent_type': ctx.agentType,
    ...(ctx.cwd ? { 'agentdeck.cwd': ctx.cwd } : {}),
    ...(payload.runId ? { 'agentdeck.run_id': payload.runId } : {}),
    ...(payload.sessionKey ? { 'agentdeck.gateway_session_key': payload.sessionKey } : {}),
  };
  const make = (
    kind: TelemetrySpan['kind'],
    attributes: TelemetryAttributes = {},
  ): TelemetrySpan => ({
    traceId: ctx.traceId,
    spanId: randomUUID(),
    parentSpanId: ctx.activeTurnId,
    name: spanNameForKind(kind),
    kind,
    ts,
    attributes: { ...baseAttrs, ...attributes },
  });

  if (payload.state === 'delta') {
    // Deltas are streaming chunks — only the first delta of a new turn is
    // load-bearing for APME (opens the turn). The OpenClaw adapter detects
    // "first delta" via `chatStarted` and is responsible for emitting the
    // turn_start when calling us. We don't emit on every delta — that
    // would balloon the steps table and add no eval signal.
    return [];
  }

  if (payload.state === 'final') {
    const spans: TelemetrySpan[] = [];
    if (payload.response) {
      spans.push(make('turn_response', { 'agentdeck.response_text': payload.response }));
    }
    if (Array.isArray(payload.tools)) {
      for (const t of payload.tools) {
        if (!t.name) continue;
        spans.push(make('tool_result', {
          'gen_ai.tool.name': t.name,
          'agentdeck.tool_name': t.name,
          ...(t.status ? { 'agentdeck.tool_status': t.status } : {}),
        }));
      }
    }
    return spans;
  }

  if (payload.state === 'aborted') {
    // Treat as a manual boundary — user explicitly stopped this turn. The
    // composite outcome derivation will see the absence of a complete
    // response and score accordingly.
    return [make('task_boundary', { 'agentdeck.boundary_signal': 'manual' })];
  }

  if (payload.state === 'error') {
    // Error doesn't close the task — agent might retry on the same prompt.
    // The error is recorded for context but the idle timer continues to
    // run. Returning empty array lets the adapter keep its lifecycle state.
    return [];
  }

  return [];
}

/**
 * Build the spans the adapter should emit when its idle-gap timer expires.
 * Returned as a function (not a constant) because the timestamp is "now"
 * at expiry, not "now" at adapter construction.
 */
export function openclawIdleGapTaskBoundary(ctx: AdapterContext): TelemetrySpan {
  return {
    traceId: ctx.traceId,
    spanId: randomUUID(),
    parentSpanId: ctx.activeTurnId,
    name: spanNameForKind('task_boundary'),
    kind: 'task_boundary',
    ts: Date.now(),
    attributes: {
      'agentdeck.agent_type': ctx.agentType,
      ...(ctx.cwd ? { 'agentdeck.cwd': ctx.cwd } : {}),
      'agentdeck.boundary_signal': 'idle_gap',
    },
  };
}

/**
 * Build the user-prompt span the adapter should emit on `chat.send`. Kept
 * here for symmetry with `claude-hook.ts::claudeHookToSpans` and so future
 * test fixtures can exercise the boundary detector without spinning a real
 * Gateway connection.
 */
export function openclawChatSendToSpan(
  ctx: AdapterContext,
  prompt: string,
): TelemetrySpan {
  return {
    traceId: ctx.traceId,
    spanId: randomUUID(),
    parentSpanId: undefined,
    name: spanNameForKind('turn_start'),
    kind: 'turn_start',
    ts: Date.now(),
    attributes: {
      'agentdeck.agent_type': ctx.agentType,
      ...(ctx.cwd ? { 'agentdeck.cwd': ctx.cwd } : {}),
      'agentdeck.prompt_text': prompt,
    },
  };
}
