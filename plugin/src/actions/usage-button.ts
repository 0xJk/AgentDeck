import streamDeck, {
  action,
  SingletonAction,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from '@elgato/streamdeck';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { State, augmentedPath, OPENCLAW_CANDIDATES, type BillingType, type AgentCapabilities, type ModelCatalogEntry } from '@agentdeck/shared';
import type { AgentLink } from '../agent-link.js';
import { renderButton, svgToDataUrl } from '../renderers/button-renderer.js';
import { ButtonConfig } from '../layout-manager.js';
import { handleExpandedAction } from '../expanded-actions.js';
import { dlog } from '../log.js';

const SIZE = 144;

let bridge: AgentLink;
let currentState = State.DISCONNECTED;

// API usage data
let fiveHourPercent: number | undefined;
let fiveHourResetsAt: string | undefined;
let sevenDayPercent: number | undefined;
let sevenDayResetsAt: string | undefined;

// Extra usage data
let extraUsageEnabled = false;
let extraUsageMonthlyLimit: number | undefined;
let extraUsageUsedCredits: number | undefined;
let extraUsageUtilization: number | undefined;

// Session usage data
let inputTokens = 0;
let outputTokens = 0;
let estimatedCostUsd: number | undefined;

// Token delta tracking (for speed/activity display)
let prevTotalTokens = 0;
let tokenDelta = 0; // tokens added since last update

// Model catalog (OpenClaw)
let modelCatalog: ModelCatalogEntry[] | null = null;

// Display pages: 5h → 7d → extra (if enabled) → session → models
type Page = '5h' | '7d' | 'extra' | 'session' | 'models';
let pageIndex = 0;
let billingType: BillingType = 'unknown';
let bridgeConnected = false;

// Animation frames — driven by independent 8fps timer, decoupled from data updates
let borderFrame = 0;       // continuously incrementing, drives border spin
let waveFrameFine = 0;     // 0-63, drives smooth wave sloshing (8s cycle at 8fps)

// Animation timer — runs while any usage button is visible
let animInterval: ReturnType<typeof setInterval> | null = null;
let waveAccum = 0; // float accumulator for fractional wave speed

function getWaveParams(): { amp: number; speedMul: number } {
  if (currentState !== State.PROCESSING) {
    return { amp: 0, speedMul: 1 };
  }
  if (tokenDelta <= 0) {
    return { amp: 2, speedMul: 0.5 };
  }
  const scaled = Math.min(8, 3 + Math.log10(Math.max(1, tokenDelta)) * 1.5);
  const speed = Math.min(2, 0.8 + tokenDelta / 2000);
  return { amp: scaled, speedMul: speed };
}

function startAnimLoop(): void {
  if (animInterval) return;
  animInterval = setInterval(() => {
    borderFrame++;
    const { speedMul } = getWaveParams();
    waveAccum += speedMul;
    waveFrameFine = Math.floor(waveAccum) % 64;
    refreshAll();
  }, 125); // 8fps
}

function stopAnimLoop(): void {
  if (animInterval) {
    clearInterval(animInterval);
    animInterval = null;
  }
}

// Standalone usage poll interval (when bridge is not connected)
let standaloneInterval: ReturnType<typeof setInterval> | null = null;

// Independent model catalog poll (runs for OpenClaw regardless of bridge state)
let catalogInterval: ReturnType<typeof setInterval> | null = null;

let currentCapabilities: AgentCapabilities | null = null;
let overrideConfig: ButtonConfig | null = null;

const actionIds: string[] = [];

// ---- Standalone OAuth usage fetch (works without bridge) ----
async function fetchStandaloneUsage(): Promise<void> {
  try {
    const raw = execSync('security find-generic-password -s "Claude Code-credentials" -w', {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    const creds = JSON.parse(raw) as Record<string, unknown>;
    const oauthCreds = creds?.claudeAiOauth as Record<string, unknown> | undefined;
    const token = oauthCreds?.accessToken as string | undefined;
    if (!token) return;

    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return;

    const data = await res.json() as Record<string, unknown>;
    if ((data as Record<string, unknown>).error) return;

    const fiveHour = data.five_hour as Record<string, unknown> | undefined;
    const sevenDay = data.seven_day as Record<string, unknown> | undefined;
    const extra = data.extra_usage as Record<string, unknown> | undefined;

    const hasRateLimits = fiveHour != null || sevenDay != null;
    if (hasRateLimits && billingType === 'unknown') billingType = 'subscription';
    else if (!hasRateLimits && billingType === 'unknown') billingType = 'api';

    if (fiveHour?.utilization != null) fiveHourPercent = fiveHour.utilization as number;
    if (fiveHour?.resets_at) fiveHourResetsAt = fiveHour.resets_at as string;
    if (sevenDay?.utilization != null) sevenDayPercent = sevenDay.utilization as number;
    if (sevenDay?.resets_at) sevenDayResetsAt = sevenDay.resets_at as string;
    if (extra?.enabled != null) extraUsageEnabled = !!(extra.enabled);
    if (extra?.monthly_limit != null) extraUsageMonthlyLimit = extra.monthly_limit as number;
    if (extra?.used_credits != null) extraUsageUsedCredits = extra.used_credits as number;
    if (extra?.utilization != null) extraUsageUtilization = extra.utilization as number;

    dlog('UsaBut', `standalone fetch: 5h=${fiveHourPercent ?? '-'}% 7d=${sevenDayPercent ?? '-'}% billing=${billingType}`);
    refreshAll();
  } catch {
    // Ignore — no keychain access or network error
  }
}

/** Resolve `openclaw` binary: try known candidate paths, fallback to bare name on PATH. */
function resolveOpenClawBin(): string {
  for (const candidate of OPENCLAW_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return 'openclaw';
}

/** Fetch OpenClaw model catalog via CLI (standalone — no bridge needed) */
function fetchStandaloneModelCatalog(): void {
  const bin = resolveOpenClawBin();
  try {
    const output = execSync(`${bin} models list --json`, {
      timeout: 5000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, PATH: augmentedPath() },
    }).trim();

    const result = JSON.parse(output) as { count: number; models: Array<{
      key: string; name: string; tags?: string[]; available?: boolean;
    }> };

    if (!result.models || !Array.isArray(result.models)) return;

    modelCatalog = result.models.map((m) => {
      let role: ModelCatalogEntry['role'] = 'configured';
      const tags = m.tags ?? [];
      if (tags.includes('default')) {
        role = 'default';
      } else {
        for (const tag of tags) {
          const match = tag.match(/^fallback#(\d+)$/);
          if (match) {
            role = `fallback-${match[1]}` as `fallback-${number}`;
            break;
          }
        }
      }
      return { name: m.name, role, available: m.available !== false };
    });

    dlog('UsaBut', `standalone model catalog: ${modelCatalog.length} models`);
    refreshAll();
  } catch {
    // openclaw not installed — ignore
  }
}

function startStandalonePoll(): void {
  if (standaloneInterval) return;
  // Fetch immediately, then every 60 seconds (OAuth usage only)
  void fetchStandaloneUsage();
  standaloneInterval = setInterval(() => {
    void fetchStandaloneUsage();
  }, 60_000);
}

function stopStandalonePoll(): void {
  if (standaloneInterval) {
    clearInterval(standaloneInterval);
    standaloneInterval = null;
  }
}

function startCatalogPoll(): void {
  if (catalogInterval) return;
  fetchStandaloneModelCatalog();
  catalogInterval = setInterval(fetchStandaloneModelCatalog, 60_000);
}

function stopCatalogPoll(): void {
  if (catalogInterval) {
    clearInterval(catalogInterval);
    catalogInterval = null;
  }
}

/** Called from plugin.ts when bridge connection state changes */
export function setUsageBridgeConnected(connected: boolean): void {
  bridgeConnected = connected;
  if (!connected) {
    startStandalonePoll();
  } else {
    stopStandalonePoll();
  }
}

function getPages(): Page[] {
  // OpenClaw: show model roster
  if (currentCapabilities?.hasModelCatalog) {
    return ['models'];
  }
  // API users have no subscription rate limits — only show session page
  if (billingType === 'api') {
    return ['session'];
  }
  const pages: Page[] = ['5h', '7d'];
  if (extraUsageEnabled) {
    pages.push('extra');
  }
  // Session page only for API users — subscription users use rate-limit pages
  return pages;
}

export function initUsageButton(b: AgentLink): void {
  bridge = b;
}

export function setUsageCapabilities(capabilities: AgentCapabilities | null): void {
  currentCapabilities = capabilities;
  // OpenClaw with model catalog: keep catalog poll as fallback (GatewayClient may fail)
  if (capabilities?.hasModelCatalog) {
    startCatalogPoll();
  } else {
    stopCatalogPoll();
  }
  refreshAll();
}

export function overrideUsageButton(config: ButtonConfig | null): void {
  overrideConfig = config;
  refreshAll();
}

export function updateUsageButton(
  state: State,
  usage: {
    sessionDurationSec: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd?: number;
    fiveHourPercent?: number;
    fiveHourResetsAt?: string;
    sevenDayPercent?: number;
    sevenDayResetsAt?: string;
    extraUsageEnabled?: boolean;
    extraUsageMonthlyLimit?: number;
    extraUsageUsedCredits?: number;
    extraUsageUtilization?: number;
  },
  bt?: BillingType,
): void {
  if (bt) billingType = bt;
  currentState = state;
  const newTotal = usage.inputTokens + usage.outputTokens;
  tokenDelta = Math.max(0, newTotal - prevTotalTokens);
  prevTotalTokens = newTotal;
  inputTokens = usage.inputTokens;
  outputTokens = usage.outputTokens;
  if (usage.estimatedCostUsd != null) estimatedCostUsd = usage.estimatedCostUsd;
  if (usage.fiveHourPercent != null) fiveHourPercent = usage.fiveHourPercent;
  if (usage.fiveHourResetsAt) fiveHourResetsAt = usage.fiveHourResetsAt;
  if (usage.sevenDayPercent != null) sevenDayPercent = usage.sevenDayPercent;
  if (usage.sevenDayResetsAt) sevenDayResetsAt = usage.sevenDayResetsAt;
  if (usage.extraUsageEnabled != null) extraUsageEnabled = usage.extraUsageEnabled;
  if (usage.extraUsageMonthlyLimit != null) extraUsageMonthlyLimit = usage.extraUsageMonthlyLimit;
  if (usage.extraUsageUsedCredits != null) extraUsageUsedCredits = usage.extraUsageUsedCredits;
  if (usage.extraUsageUtilization != null) extraUsageUtilization = usage.extraUsageUtilization;
  refreshAll();
}

export function updateUsageModelCatalog(catalog: ModelCatalogEntry[] | null): void {
  modelCatalog = catalog;
  refreshAll();
}

function refreshAll(): void {
  const dataUrl = overrideConfig
    ? svgToDataUrl(renderButton(overrideConfig))
    : svgToDataUrl(renderUsageSvg());
  for (const id of actionIds) {
    const act = streamDeck.actions.getActionById(id);
    if (act) {
      void act.setImage(dataUrl).catch(() => {});
    }
  }
}

function dimUsageSvg(): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
    `<rect width="${SIZE}" height="${SIZE}" rx="12" fill="#1a1a1a"/>`,
    `<text x="72" y="56" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" font-weight="600" fill="#444444">USAGE</text>`,
    `<text x="72" y="90" text-anchor="middle" font-family="Arial,sans-serif" font-size="22" fill="#444444">--</text>`,
    `</svg>`,
  ].join('');
}

function renderUsageSvg(): string {
  // Capability gating: neither API usage nor model catalog → DIM
  if (currentCapabilities && !currentCapabilities.hasApiUsage && !currentCapabilities.hasModelCatalog) {
    return dimUsageSvg();
  }

  const pages = getPages();
  // Clamp pageIndex if extra page was removed
  if (pageIndex >= pages.length) pageIndex = 0;
  const page = pages[pageIndex];

  switch (page) {
    case '5h': {
      if (fiveHourPercent != null) {
        const pct = fiveHourPercent;
        const baseColor = pct > 80 ? '#ef4444' : pct > 50 ? '#fbbf24' : '#4ade80';
        const timeLeft = fiveHourResetsAt ? formatReset(fiveHourResetsAt) : '--';
        const sub = tokenActivitySub(pct);
        return waterFillSvg('5-HOUR', timeLeft, sub, pct, baseColor, pages);
      }
      return infoSvg('5-HOUR', '--', 'Push to fetch', '#666666', '#111111', pages);
    }

    case '7d': {
      if (sevenDayPercent != null) {
        const pct = sevenDayPercent;
        const baseColor = pct > 80 ? '#ef4444' : pct > 50 ? '#fbbf24' : '#60a5fa';
        const timeLeft = sevenDayResetsAt ? formatReset(sevenDayResetsAt) : '--';
        const sub = tokenActivitySub(pct);
        return waterFillSvg('7-DAY', timeLeft, sub, pct, baseColor, pages);
      }
      return infoSvg('7-DAY', '--', 'Push to fetch', '#666666', '#111111', pages);
    }

    case 'extra': {
      if (extraUsageUsedCredits != null && extraUsageMonthlyLimit != null) {
        const pct = extraUsageUtilization ?? 0;
        const baseColor = pct > 80 ? '#ef4444' : pct > 50 ? '#fbbf24' : '#a78bfa';
        const spent = `$${extraUsageUsedCredits.toFixed(2)}`;
        const sub = `of $${extraUsageMonthlyLimit}/mo · ${pct.toFixed(1)}%`;
        return waterFillSvg('EXTRA', spent, sub, pct, baseColor, pages);
      }
      return infoSvg('EXTRA', '--', 'Push to fetch', '#666666', '#111111', pages);
    }

    case 'session': {
      // Only shown for API users
      const total = inputTokens + outputTokens;
      if (total === 0) {
        const costStr = estimatedCostUsd != null ? `$${estimatedCostUsd.toFixed(4)}` : '--';
        return infoSvg('SESSION', costStr, 'API · no session', '#60a5fa', '#0a1020', pages);
      }
      const totalK = (total / 1000).toFixed(1);
      const inK = (inputTokens / 1000).toFixed(1);
      const outK = (outputTokens / 1000).toFixed(1);
      const sub = estimatedCostUsd != null
        ? `$${estimatedCostUsd.toFixed(4)} · ${inK}K/${outK}K`
        : `${inK}K in / ${outK}K out`;
      return infoSvg('SESSION', `${totalK}K`, sub, '#4ade80', '#071a0f', pages);
    }

    case 'models': {
      if (!modelCatalog || modelCatalog.length === 0) {
        return infoSvg('MODELS', '--', 'No models configured', '#666666', '#111111', pages);
      }
      return renderModelsSvg(modelCatalog, pages);
    }

    default:
      return infoSvg('--', '--', '', '#666666', '#111111', pages);
  }
}

/** Build subtitle text showing token activity: delta when active, total when idle */
function tokenActivitySub(pct: number): string {
  const total = inputTokens + outputTokens;
  if (currentState === State.PROCESSING && tokenDelta > 0) {
    const deltaStr = tokenDelta >= 1000
      ? `+${(tokenDelta / 1000).toFixed(1)}K`
      : `+${tokenDelta}`;
    return `${Math.round(pct)}% · ${deltaStr}`;
  }
  if (total > 0) {
    return `${Math.round(pct)}% · ${(total / 1000).toFixed(1)}K`;
  }
  return `${Math.round(pct)}% used`;
}

/**
 * Water-fill gauge SVG — used for rate-limit pages (5h, 7d, extra).
 * pct drives the fill level (0=empty, 100=full) and waveFrame creates
 * a gentle sloshing animation across updates (0.2 fps at 5s intervals).
 */
function waterFillSvg(
  title: string,
  value: string,
  sub: string,
  pct: number,
  color: string,
  pages: Page[],
): string {
  // Fill level: pct=0 → water at very bottom, pct=100 → full
  const clampedPct = Math.max(0, Math.min(100, pct));
  const fillY = Math.round(4 + (140 * (1 - clampedPct / 100)));

  // Wave amplitude and speed based on token activity
  const isActive = currentState === State.PROCESSING;
  const { amp } = getWaveParams();
  const phase = Math.sin((waveFrameFine / 64) * 2 * Math.PI);
  const a = phase * amp;
  const b = -phase * amp;

  const waveFill = [
    `M -18 ${fillY}`,
    `C 0 ${fillY + a}, 36 ${fillY + b}, 54 ${fillY}`,
    `C 72 ${fillY + a}, 108 ${fillY + b}, 126 ${fillY}`,
    `C 144 ${fillY + a}, 162 ${fillY + b}, 180 ${fillY}`,
    `L 180 ${SIZE} L -18 ${SIZE} Z`,
  ].join(' ');

  const waveLine = [
    `M -18 ${fillY}`,
    `C 0 ${fillY + a}, 36 ${fillY + b}, 54 ${fillY}`,
    `C 72 ${fillY + a}, 108 ${fillY + b}, 126 ${fillY}`,
    `C 144 ${fillY + a}, 162 ${fillY + b}, 180 ${fillY}`,
  ].join(' ');

  // Second wave layer offset by quarter cycle
  const phase2 = Math.sin(((waveFrameFine + 16) / 64) * 2 * Math.PI);
  const a2 = phase2 * (amp * 0.6);
  const b2 = -phase2 * (amp * 0.6);
  const waveFill2 = [
    `M -18 ${fillY + 5}`,
    `C 0 ${fillY + 5 + a2}, 36 ${fillY + 5 + b2}, 54 ${fillY + 5}`,
    `C 72 ${fillY + 5 + a2}, 108 ${fillY + 5 + b2}, 126 ${fillY + 5}`,
    `C 144 ${fillY + 5 + a2}, 162 ${fillY + 5 + b2}, 180 ${fillY + 5}`,
    `L 180 ${SIZE} L -18 ${SIZE} Z`,
  ].join(' ');

  // Thin progress bar on right edge for precise readability at any fill level
  const barH = Math.round(136 * clampedPct / 100);
  const barY = 140 - barH;

  // ---- Spinning border — only shown while tokens are being consumed ----
  const perim = 544;
  const advPx = tokenDelta > 0
    ? Math.min(60, 30 + Math.log10(Math.max(1, tokenDelta)) * 10)
    : 25;
  const dashLen = 160;
  const borderOffset = -((borderFrame * advPx) % perim);
  const borderOpacity = 0.92;
  const borderWidth = 3;

  const dots = pages.map((_, i) => {
    const cx = 72 - ((pages.length - 1) * 8) / 2 + i * 8;
    const fill = i === pageIndex ? color : `${color}40`;
    return `<circle cx="${cx}" cy="132" r="3" fill="${fill}"/>`;
  }).join('');

  const defs = [
    `<defs>`,
    `<clipPath id="btn-clip"><rect width="${SIZE}" height="${SIZE}" rx="12"/></clipPath>`,
    `<filter id="txt-glow" x="-20%" y="-20%" width="140%" height="140%">`,
    `<feGaussianBlur in="SourceGraphic" stdDeviation="2.5" result="blur"/>`,
    `<feComposite in="SourceGraphic" in2="blur" operator="over"/>`,
    `</filter>`,
    `<filter id="border-glow" x="-10%" y="-10%" width="120%" height="120%">`,
    `<feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur"/>`,
    `<feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>`,
    `</filter>`,
    `</defs>`,
  ].join('');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
    defs,
    `<rect width="${SIZE}" height="${SIZE}" rx="12" fill="#0c0e10"/>`,
    `<g clip-path="url(#btn-clip)">`,
    `<path d="${waveFill2}" fill="${color}" opacity="0.10"/>`,
    `<path d="${waveFill}" fill="${color}" opacity="0.18"/>`,
    `<path d="${waveLine}" fill="none" stroke="${color}" stroke-width="1.5" opacity="0.55"/>`,
    `<rect x="140" y="${barY}" width="4" height="${barH}" fill="${color}" opacity="0.35" rx="2"/>`,
    `</g>`,
    // Dim static border (always visible, subtle)
    `<rect x="1.5" y="1.5" width="141" height="141" rx="11.5" fill="none" stroke="${color}" stroke-width="1.5" opacity="0.12"/>`,
    // Spinning segment — only rendered while actively consuming tokens
    ...(isActive ? [
      `<rect x="1.5" y="1.5" width="141" height="141" rx="11.5" fill="none"`,
      ` stroke="${color}" stroke-width="${borderWidth}"`,
      ` stroke-dasharray="${dashLen} ${perim - dashLen}"`,
      ` stroke-dashoffset="${borderOffset}"`,
      ` opacity="${borderOpacity}"`,
      ` filter="url(#border-glow)"/>`,
    ] : []),
    // Text
    `<text x="72" y="30" text-anchor="middle" font-family="Arial,sans-serif" font-size="18" font-weight="bold" fill="${color}" opacity="0.65">${escXml(title)}</text>`,
    `<text x="72" y="80" text-anchor="middle" font-family="Arial,sans-serif" font-size="32" font-weight="bold" fill="${color}" filter="url(#txt-glow)">${escXml(value)}</text>`,
    `<text x="72" y="112" text-anchor="middle" font-family="Arial,sans-serif" font-size="18" fill="${color}" opacity="0.80">${escXml(sub)}</text>`,
    dots,
    `</svg>`,
  ].join('');
}

function infoSvg(title: string, value: string, sub: string, color: string, bg: string, pages: Page[]): string {
  const dots = pages.map((_, i) => {
    const cx = 72 - ((pages.length - 1) * 8) / 2 + i * 8;
    const fill = i === pageIndex ? color : `${color}40`;
    return `<circle cx="${cx}" cy="132" r="3" fill="${fill}"/>`;
  }).join('');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
    `<rect width="${SIZE}" height="${SIZE}" rx="12" fill="${bg}"/>`,
    `<text x="72" y="30" text-anchor="middle" font-family="Arial,sans-serif" font-size="18" font-weight="bold" fill="${color}" opacity="0.6">${escXml(title)}</text>`,
    `<text x="72" y="80" text-anchor="middle" font-family="Arial,sans-serif" font-size="32" font-weight="bold" fill="${color}">${escXml(value)}</text>`,
    `<text x="72" y="112" text-anchor="middle" font-family="Arial,sans-serif" font-size="18" fill="${color}" opacity="0.65">${escXml(sub)}</text>`,
    dots,
    `</svg>`,
  ].join('');
}

/** Provider color from model key prefix */
function providerColor(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes('glm')) return '#22d3ee';     // cyan — ZhipuAI
  if (lower.includes('gpt') || lower.includes('codex')) return '#4ade80'; // green — OpenAI
  if (lower.includes('deepseek')) return '#a78bfa'; // purple
  if (lower.includes('claude')) return '#f59e0b';   // amber
  if (lower.includes('gemini')) return '#60a5fa';    // blue
  return '#94a3b8'; // slate default
}

/** Render models roster SVG for the usage button. */
function renderModelsSvg(models: ModelCatalogEntry[], pages: Page[]): string {
  const dots = pages.map((_, i) => {
    const cx = 72 - ((pages.length - 1) * 8) / 2 + i * 8;
    const fill = i === pageIndex ? '#22d3ee' : '#22d3ee40';
    return `<circle cx="${cx}" cy="132" r="3" fill="${fill}"/>`;
  }).join('');

  // Sort: default first, then fallback in order, then configured
  const sorted = [...models].sort((a, b) => {
    const order = (r: string) => {
      if (r === 'default') return 0;
      const m = r.match(/^fallback-(\d+)$/);
      if (m) return parseInt(m[1], 10);
      return 100;
    };
    return order(a.role) - order(b.role);
  });

  // Show up to 4 models
  const visible = sorted.slice(0, 4);
  const startY = 30;
  const lineHeight = 24;

  const lines = visible.map((m, i) => {
    const y = startY + i * lineHeight;
    const color = m.available ? providerColor(m.name) : '#444444';
    const roleIcon = m.role === 'default' ? '\u2605 '
      : m.role.startsWith('fallback-') ? `#${m.role.slice(9)} `
      : '';
    const displayName = `${roleIcon}${m.name}`;
    const truncated = displayName.length > 14 ? displayName.slice(0, 13) + '\u2026' : displayName;
    return `<text x="72" y="${y}" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" fill="${color}" opacity="${m.available ? '1' : '0.4'}">${escXml(truncated)}</text>`;
  }).join('');

  const moreText = sorted.length > 4
    ? `<text x="72" y="${startY + 4 * lineHeight}" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" fill="#666">+${sorted.length - 4} more</text>`
    : '';

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
    `<rect width="${SIZE}" height="${SIZE}" rx="12" fill="#0a1020"/>`,
    `<text x="72" y="16" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" font-weight="bold" fill="#22d3ee" opacity="0.6">MODELS</text>`,
    lines,
    moreText,
    dots,
    `</svg>`,
  ].join('');
}

function formatReset(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = d.getTime() - now.getTime();
    if (diffMs <= 0) return 'now';
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 60) return `${diffMin}m`;
    const h = Math.floor(diffMin / 60);
    const m = diffMin % 60;
    if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`;
    const d2 = Math.floor(h / 24);
    return `${d2}d ${h % 24}h`;
  } catch {
    return '';
  }
}

function escXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

@action({ UUID: 'bound.serendipity.agentdeck.usage-button' })
export class UsageButtonAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    if (!actionIds.includes(ev.action.id)) {
      actionIds.push(ev.action.id);
    }
    if (!bridgeConnected) {
      startStandalonePoll();
    }
    startAnimLoop();
    await ev.action.setImage(svgToDataUrl(renderUsageSvg()));
  }

  override async onKeyDown(_ev: KeyDownEvent): Promise<void> {
    if (overrideConfig?.action) {
      dlog('UsaBut', `keyDown: override action="${overrideConfig.action}"`);
      handleExpandedAction(overrideConfig.action, bridge);
      return;
    }
    if (currentCapabilities && !currentCapabilities.hasApiUsage && !currentCapabilities.hasModelCatalog) return;
    const pages = getPages();
    pageIndex = (pageIndex + 1) % pages.length;
    dlog('UsaBut', `keyDown: page=${pages[pageIndex]} (${pageIndex + 1}/${pages.length})`);
    if (currentCapabilities?.hasApiUsage) {
      bridge.send({ type: 'query_usage' });
    }
    refreshAll();
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    const idx = actionIds.indexOf(ev.action.id);
    if (idx !== -1) actionIds.splice(idx, 1);
    if (actionIds.length === 0) {
      stopStandalonePoll();
      stopCatalogPoll();
      stopAnimLoop();
    }
  }
}
