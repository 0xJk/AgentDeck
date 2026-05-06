/**
 * Timeline event → TelemetrySpan adapter.
 *
 * Used by OpenClaw and OpenCode adapters which emit `chat_start` /
 * `chat_response` / `chat_end` / `tool_request` / `tool_resolved` timeline
 * entries (`shared/src/timeline.ts`). Translates each into the canonical
 * AgentDeck span set so the collector sees one consistent ingestion stream.
 *
 * `chat_end` carries the assistant response in `entry.detail` only as a
 * fallback path for sources that didn't emit `chat_response` mid-stream.
 * That case maps to `turn_response` with `fallbackToLastClosed: true` so the
 * collector applies it via `setLastClosedTurnResponse`.
 */

import { randomUUID } from 'crypto';
import type {
  AdapterContext,
  TelemetrySpan,
  TelemetryAttributes,
  TimelineEntry,
} from '@agentdeck/shared';
import { spanNameForKind } from '@agentdeck/shared';

export function timelineEntryToSpans(
  ctx: AdapterContext,
  entry: TimelineEntry,
): TelemetrySpan[] {
  const ts = entry.ts ?? Date.now();
  const baseAttrs: TelemetryAttributes = {
    'agentdeck.agent_type': ctx.agentType,
    ...(ctx.cwd ? { 'agentdeck.cwd': ctx.cwd } : {}),
  };
  const make = (
    kind: TelemetrySpan['kind'],
    attributes: TelemetryAttributes,
  ): TelemetrySpan => ({
    traceId: ctx.traceId,
    spanId: randomUUID(),
    parentSpanId: ctx.activeTurnId,
    name: spanNameForKind(kind),
    kind,
    ts,
    attributes: { ...baseAttrs, ...attributes },
  });

  switch (entry.type) {
    case 'chat_start': {
      const prompt = entry.detail || entry.raw || '';
      return [make('turn_start', { 'agentdeck.prompt_text': prompt })];
    }
    case 'chat_response': {
      const response = entry.detail || entry.raw || '';
      if (response.length <= 2) return [];
      return [make('turn_response', { 'agentdeck.response_text': response })];
    }
    case 'chat_end': {
      const response = entry.detail || '';
      if (response.length <= 2) return [];
      return [make('turn_response', {
        'agentdeck.response_text': response,
        'agentdeck.fallback_to_last_closed': true,
      })];
    }
    // tool_request: Claude PreToolUse hook + Codex parser tool_action (after
    // 2025-05 alignment) emit this. tool_exec: legacy OpenClaw parseLogLine
    // and pre-alignment Codex emits — treated identically so APME counts
    // every tool invocation regardless of source.
    case 'tool_request':
    case 'tool_exec': {
      // Some sources pack the tool name as the first whitespace-delimited token
      // in `raw`; when missing, the collector falls back to the literal 'tool'.
      const toolName = entry.raw?.split(' ')[0] ?? 'tool';
      return [make('tool_call', {
        'gen_ai.tool.name': toolName,
        'agentdeck.tool_name': toolName,
      })];
    }
    case 'tool_resolved':
      return [make('tool_result', {})];
    default:
      return [];
  }
}
