import type { BridgeEvent, StateSnapshot } from './types.js';
import type { ApiUsageData } from './usage-api.js';
import type { OllamaStatus } from './ollama-probe.js';

/**
 * Build a usage_update BridgeEvent from current state.
 * Single source of truth — used by both index.ts and daemon-server.ts.
 */
export function buildUsageEvent(
  snapshot: StateSnapshot,
  apiUsage?: ApiUsageData | null,
  oauthStatus?: boolean,
  ollamaStatus?: OllamaStatus | null,
  stale?: boolean,
): BridgeEvent {
  return {
    type: 'usage_update',
    sessionDurationSec: snapshot.sessionDurationSec,
    inputTokens: snapshot.inputTokens,
    outputTokens: snapshot.outputTokens,
    toolCalls: snapshot.toolCalls,
    estimatedCostUsd: snapshot.estimatedCostUsd ?? undefined,
    sessionPercent: snapshot.sessionPercent ?? undefined,
    costSpent: snapshot.costSpent ?? undefined,
    costLimit: snapshot.costLimit ?? undefined,
    resetTime: snapshot.resetTime ?? undefined,
    resetDate: snapshot.resetDate ?? undefined,
    fiveHourPercent: apiUsage?.fiveHourPercent ?? undefined,
    fiveHourResetsAt: apiUsage?.fiveHourResetsAt ?? undefined,
    sevenDayPercent: apiUsage?.sevenDayPercent ?? undefined,
    sevenDayResetsAt: apiUsage?.sevenDayResetsAt ?? undefined,
    extraUsageEnabled: apiUsage?.extraUsageEnabled ?? undefined,
    extraUsageMonthlyLimit: apiUsage?.extraUsageMonthlyLimit ?? undefined,
    extraUsageUsedCredits: apiUsage?.extraUsageUsedCredits ?? undefined,
    extraUsageUtilization: apiUsage?.extraUsageUtilization ?? undefined,
    oauthConnected: oauthStatus,
    ollamaStatus: ollamaStatus ?? undefined,
    usageStale: stale || undefined,
  };
}
