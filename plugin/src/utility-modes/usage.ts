/**
 * Usage data types and shared formatting helpers.
 * Used by the dedicated Usage Dial (E3) renderer.
 */

export interface UsageModeData {
  fiveHourPercent?: number;
  fiveHourResetsAt?: string;
  sevenDayPercent?: number;
  sevenDayResetsAt?: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  sessionDurationSec?: number;
  extraUsageEnabled?: boolean;
  extraUsageUtilization?: number;
  extraUsageMonthlyLimit?: number;
  extraUsageUsedCredits?: number;
  subscriptions?: { name: string; until?: string }[];
}

let sharedData: UsageModeData = {};
let onRefreshRequest: (() => void) | null = null;

/** Update shared usage data (called from plugin.ts on usage_update). */
export function updateUsageModeData(data: UsageModeData): void {
  sharedData = { ...sharedData, ...data };
}

/** Get current shared usage data snapshot. */
export function getUsageModeData(): UsageModeData {
  return sharedData;
}

/** Set callback for refresh request (query_usage). */
export function setUsageRefreshCallback(cb: () => void): void {
  onRefreshRequest = cb;
}

/** Fire refresh request. */
export function fireUsageRefresh(): void {
  onRefreshRequest?.();
}

export function gaugeBar(percent: number, width = 10): string {
  const filled = Math.round((percent / 100) * width);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled);
}

export function formatResetTime(iso?: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const now = Date.now();
    const diff = d.getTime() - now;
    if (diff <= 0) return 'now';
    const totalH = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    if (totalH >= 24) {
      const days = Math.floor(totalH / 24);
      const remainH = totalH % 24;
      return remainH > 0 ? `${days}d${remainH}h` : `${days}d`;
    }
    return totalH > 0 ? `${totalH}h${m}m` : `${m}m`;
  } catch { return ''; }
}

export function formatTokens(n?: number): string {
  if (n == null) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
