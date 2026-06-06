/**
 * SVG pixmap renderer for the Usage Dial (E3).
 * 200x100, #0f172a bg. Shows rate limit gauges, token counts, cost.
 * Follows shared encoder design: 14px bold header, 2px accent bar at y=90.
 */
import { gaugeBar, formatResetTime, formatTokens, type UsageModeData } from '../utility-modes/usage.js';

const W = 200;
const H = 100;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function svgWrap(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${inner}</svg>`;
}

function gaugeColor(pct: number): string {
  return pct > 80 ? '#ef4444' : pct > 50 ? '#eab308' : '#22c55e';
}

/** Shared accent bar: 2px at y=90, x=10..190 with dark bg + colored fill */
function accentBar(color: string, fillRatio = 1): string {
  const barW = Math.max(2, Math.round(180 * fillRatio));
  return `<rect x="10" y="90" width="180" height="2" rx="1" fill="#1e293b"/>
    <rect x="10" y="90" width="${barW}" height="2" rx="1" fill="${color}" opacity="0.4"/>`;
}

/** Format subscription next billing date */
function formatBillingDate(until?: string): string {
  if (!until) return '';
  try {
    const d = new Date(until);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  } catch { return ''; }
}

export type UsagePage = 'overview' | '5h' | '7d' | 'session' | 'extra';
export const USAGE_PAGES: UsagePage[] = ['overview', '5h', '7d', 'session', 'extra'];

export type UsageDisplayMode = 'offline' | 'waiting' | 'unavailable' | 'data';

/**
 * Decide what the usage dial should show. Usage is DAEMON-GLOBAL, so connectivity is
 * keyed on the daemon WS connection — NOT the focused Claude session's state. On the
 * home view no session is focused, but usage still flows from the daemon; gating on the
 * session state wrongly showed "Offline" there. See usage-dial fix plan.
 */
export function resolveUsageDisplayMode(
  daemonConnected: boolean,
  hasReceivedData: boolean,
  usageStale: boolean,
  fiveHourPercent: number | null | undefined,
): UsageDisplayMode {
  if (!daemonConnected) return 'offline';
  if (!hasReceivedData) return 'waiting';
  if (usageStale === true || fiveHourPercent == null) return 'unavailable';
  return 'data';
}

/** Overview: 5h + 7d gauges stacked — % and reset on separate lines */
export function renderUsageOverview(data: UsageModeData): string {
  const pct5 = data.fiveHourPercent ?? 0;
  const pct7 = data.sevenDayPercent ?? 0;
  const reset5 = formatResetTime(data.fiveHourResetsAt);
  const reset7 = formatResetTime(data.sevenDayResetsAt);
  const c5 = gaugeColor(pct5);
  const c7 = gaugeColor(pct7);

  // Subscription billing info (bottom area)
  const subs = data.subscriptions ?? [];
  const billingParts: string[] = [];
  for (const sub of subs) {
    const date = formatBillingDate(sub.until);
    if (date) billingParts.push(`${sub.name} ${date}`);
  }
  const billingLine = billingParts.length > 0
    ? `<text x="100" y="84" text-anchor="middle" font-family="Arial,sans-serif" font-size="10" fill="#475569">${esc(billingParts.join(' · '))}</text>`
    : '';

  return svgWrap(`
    <rect width="${W}" height="${H}" fill="#0f172a"/>
    <text x="100" y="18" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="bold" fill="#94a3b8">USAGE</text>
    <text x="18" y="36" font-family="Arial,sans-serif" font-size="11" fill="#94a3b8">5H</text>
    <text x="42" y="36" font-family="monospace" font-size="12" fill="${c5}">${esc(gaugeBar(pct5, 8))}</text>
    <text x="190" y="36" text-anchor="end" font-family="Arial,sans-serif" font-size="12" font-weight="bold" fill="#ffffff">${Math.round(pct5)}%</text>
    ${reset5 ? `<text x="190" y="47" text-anchor="end" font-family="Arial,sans-serif" font-size="11" fill="#94a3b8">${esc(reset5)}</text>` : ''}
    <text x="18" y="63" font-family="Arial,sans-serif" font-size="11" fill="#94a3b8">7D</text>
    <text x="42" y="63" font-family="monospace" font-size="12" fill="${c7}">${esc(gaugeBar(pct7, 8))}</text>
    <text x="190" y="63" text-anchor="end" font-family="Arial,sans-serif" font-size="12" font-weight="bold" fill="#ffffff">${Math.round(pct7)}%</text>
    ${reset7 ? `<text x="190" y="74" text-anchor="end" font-family="Arial,sans-serif" font-size="11" fill="#94a3b8">${esc(reset7)}</text>` : ''}
    ${billingLine}
    ${accentBar(gaugeColor(Math.max(pct5, pct7)))}
  `);
}

/** Detail view for a single rate limit (5h or 7d) — % and reset split */
export function renderUsageDetail(data: UsageModeData, page: '5h' | '7d'): string {
  const is5h = page === '5h';
  const pct = (is5h ? data.fiveHourPercent : data.sevenDayPercent) ?? 0;
  const reset = formatResetTime(is5h ? data.fiveHourResetsAt : data.sevenDayResetsAt);
  const title = is5h ? '5H LIMIT' : '7D LIMIT';
  const color = gaugeColor(pct);

  return svgWrap(`
    <rect width="${W}" height="${H}" fill="#0f172a"/>
    <text x="100" y="18" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="bold" fill="#94a3b8">${title}</text>
    <text x="100" y="44" text-anchor="middle" font-family="monospace" font-size="14" fill="${color}">${esc(gaugeBar(pct, 12))}</text>
    <text x="100" y="68" text-anchor="middle" font-family="Arial,sans-serif" font-size="20" font-weight="bold" fill="#ffffff">${Math.round(pct)}%</text>
    ${reset ? `<text x="100" y="84" text-anchor="middle" font-family="Arial,sans-serif" font-size="13" fill="#94a3b8">resets in ${esc(reset)}</text>` : ''}
    ${accentBar(color)}
  `);
}

/** Session stats: tokens + cost */
export function renderUsageSession(data: UsageModeData): string {
  const inp = formatTokens(data.inputTokens);
  const out = formatTokens(data.outputTokens);
  const cost = data.estimatedCostUsd != null ? `$${data.estimatedCostUsd.toFixed(2)}` : '';
  const dur = data.sessionDurationSec != null ? formatDuration(data.sessionDurationSec) : '';

  return svgWrap(`
    <rect width="${W}" height="${H}" fill="#0f172a"/>
    <text x="100" y="18" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="bold" fill="#94a3b8">SESSION</text>
    <text x="100" y="46" text-anchor="middle" font-family="monospace" font-size="14" fill="#60a5fa">\u25B2${esc(inp)}  \u25BC${esc(out)}</text>
    <text x="100" y="70" text-anchor="middle" font-family="Arial,sans-serif" font-size="18" font-weight="bold" fill="#ffffff">${esc(cost || '\u2014')}</text>
    ${dur ? `<text x="100" y="84" text-anchor="middle" font-family="Arial,sans-serif" font-size="10" fill="#64748b">${esc(dur)}</text>` : ''}
    ${accentBar('#60a5fa')}
  `);
}

/** Extra usage tier gauge + credit info */
export function renderUsageExtra(data: UsageModeData): string {
  if (!data.extraUsageEnabled) {
    return svgWrap(`
      <rect width="${W}" height="${H}" fill="#0f172a"/>
      <text x="100" y="18" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="bold" fill="#94a3b8">EXTRA USAGE</text>
      <text x="100" y="56" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" fill="#475569">disabled</text>
      ${accentBar('#6b7280', 0)}
    `);
  }
  const pct = data.extraUsageUtilization ?? 0;
  const color = pct > 80 ? '#ef4444' : '#60a5fa';
  const used = data.extraUsageUsedCredits;
  const limit = data.extraUsageMonthlyLimit;
  const creditLine = used != null && limit != null
    ? `$${used.toFixed(2)} / $${limit.toFixed(2)}`
    : used != null ? `$${used.toFixed(2)} used` : '';
  return svgWrap(`
    <rect width="${W}" height="${H}" fill="#0f172a"/>
    <text x="100" y="18" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="bold" fill="#94a3b8">EXTRA USAGE</text>
    <text x="100" y="42" text-anchor="middle" font-family="monospace" font-size="14" fill="${color}">${esc(gaugeBar(pct, 12))}</text>
    <text x="100" y="62" text-anchor="middle" font-family="Arial,sans-serif" font-size="18" font-weight="bold" fill="#ffffff">${Math.round(pct)}%</text>
    ${creditLine ? `<text x="100" y="80" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" fill="#64748b">${esc(creditLine)}</text>` : ''}
    ${accentBar(color, pct / 100)}
  `);
}

/**
 * Placeholder when live usage can't be shown. Three distinct reasons:
 *  - 'offline'     — daemon/session disconnected
 *  - 'waiting'     — connected, first usage payload hasn't arrived yet
 *  - 'unavailable' — connected, but daemon reported stale usage OR never had
 *                    subscription data to report (API-key account, App Store
 *                    sandbox with no CLI relay). Data is not coming.
 */
export type UsageUnavailableReason = 'offline' | 'waiting' | 'unavailable';

export function renderUsageDisconnected(
  connected = true,
  reason: UsageUnavailableReason = connected ? 'waiting' : 'offline',
): string {
  const effective: UsageUnavailableReason = connected ? reason : 'offline';
  let icon: string;
  let label: string;
  switch (effective) {
    case 'offline':
      icon = '\u26A1';
      label = 'Offline';
      break;
    case 'unavailable':
      icon = '\uD83D\uDCCA';
      label = 'No usage data';
      break;
    case 'waiting':
    default:
      icon = '\uD83D\uDCCA';
      label = 'Waiting...';
      break;
  }
  return svgWrap(`
    <rect width="${W}" height="${H}" fill="#0f172a"/>
    <text x="100" y="18" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="bold" fill="#475569">USAGE</text>
    <text x="100" y="55" text-anchor="middle" font-family="Arial,sans-serif" font-size="22" fill="#475569" opacity="0.5">${icon}</text>
    <text x="100" y="78" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" fill="#475569">${label}</text>
    <rect x="10" y="90" width="180" height="2" rx="1" fill="#1e293b"/>
  `);
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m${s > 0 ? ` ${s}s` : ''}`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h${rm > 0 ? ` ${rm}m` : ''}`;
}
