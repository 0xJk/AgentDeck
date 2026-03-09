import { execSync } from 'child_process';
import { debug } from './logger.js';

const USAGE_API_URL = 'https://api.anthropic.com/api/oauth/usage';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

export interface ApiUsageData {
  fiveHourPercent: number | null;
  fiveHourResetsAt: string | null;
  sevenDayPercent: number | null;
  sevenDayResetsAt: string | null;
  extraUsageEnabled: boolean;
  extraUsageMonthlyLimit: number | null;
  extraUsageUsedCredits: number | null;
  extraUsageUtilization: number | null;
  /** Inferred from API response: subscription if rate-limit fields present, api if 401/no fields */
  inferredBillingType: 'subscription' | 'api' | null;
}

let lastFetchFailed = false;

export function didLastFetchFail(): boolean {
  return lastFetchFailed;
}

function getOAuthToken(): string | null {
  try {
    const raw = execSync(
      `security find-generic-password -s "${KEYCHAIN_SERVICE}" -w`,
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    const creds = JSON.parse(raw);
    return creds?.claudeAiOauth?.accessToken ?? null;
  } catch {
    debug('UsageAPI', 'Failed to read OAuth token from Keychain');
    return null;
  }
}

export function hasOAuthToken(): boolean {
  return getOAuthToken() !== null;
}

export async function fetchUsageFromApi(): Promise<ApiUsageData | null> {
  const token = getOAuthToken();
  if (!token) {
    debug('UsageAPI', 'No OAuth token available');
    return null;
  }

  try {
    const headers = {
      'Authorization': `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'Accept': 'application/json',
    };

    let res = await fetch(USAGE_API_URL, {
      method: 'GET', headers,
      signal: AbortSignal.timeout(10000),
    });

    // Rate limited — retry once after Retry-After (min 30s, max 60s)
    if (res.status === 429) {
      const raw = parseInt(res.headers.get('retry-after') || '', 10);
      const retryAfter = Math.max(isNaN(raw) ? 30 : raw, 30);
      debug('UsageAPI', `Rate limited (429), retrying in ${retryAfter}s...`);
      await new Promise(r => setTimeout(r, Math.min(retryAfter, 60) * 1000));
      res = await fetch(USAGE_API_URL, {
        method: 'GET', headers,
        signal: AbortSignal.timeout(10000),
      });
    }

    if (!res.ok) {
      debug('UsageAPI', `API returned ${res.status}: ${res.statusText}`);
      lastFetchFailed = true;
      return null;
    }

    const data = await res.json() as Record<string, any>;

    if (data.error) {
      debug('UsageAPI', `API error: ${data.error.type}`);
      lastFetchFailed = true;
      return null;
    }

    const extraUsage = data.extra_usage;
    const hasRateLimitData = data.five_hour != null || data.seven_day != null;
    const result: ApiUsageData = {
      fiveHourPercent: data.five_hour?.utilization ?? null,
      fiveHourResetsAt: data.five_hour?.resets_at ?? null,
      sevenDayPercent: data.seven_day?.utilization ?? null,
      sevenDayResetsAt: data.seven_day?.resets_at ?? null,
      extraUsageEnabled: !!extraUsage?.enabled,
      extraUsageMonthlyLimit: extraUsage?.monthly_limit ?? null,
      extraUsageUsedCredits: extraUsage?.used_credits ?? null,
      extraUsageUtilization: extraUsage?.utilization ?? null,
      inferredBillingType: hasRateLimitData ? 'subscription' : 'api',
    };

    debug('UsageAPI', `5h: ${result.fiveHourPercent}%, 7d: ${result.sevenDayPercent}%, extra: ${result.extraUsageEnabled ? 'enabled' : 'disabled'}`);
    lastFetchFailed = false;
    return result;
  } catch (err) {
    debug('UsageAPI', `Fetch failed: ${err}`);
    lastFetchFailed = true;
    return null;
  }
}

/** Format ISO timestamp to relative time like "2h 30m" or "10:30am" */
export function formatResetTime(isoString: string): string {
  try {
    const resetAt = new Date(isoString);
    const now = new Date();
    const diffMs = resetAt.getTime() - now.getTime();

    if (diffMs <= 0) return 'now';

    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 60) return `${diffMin}m`;

    const h = Math.floor(diffMin / 60);
    const m = diffMin % 60;
    if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`;

    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  } catch {
    return isoString;
  }
}
