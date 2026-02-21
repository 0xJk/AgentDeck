import streamDeck, {
  action,
  SingletonAction,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from '@elgato/streamdeck';
import { State, type BillingType } from '@agentdeck/shared';
import { BridgeClient } from '../bridge-client.js';
import { renderButton, svgToDataUrl } from '../renderers/button-renderer.js';
import { ButtonConfig } from '../layout-manager.js';
import { handleExpandedAction } from '../expanded-actions.js';
import { dlog } from '../log.js';

const SIZE = 144;

let bridge: BridgeClient;
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

// Display pages: 5h → 7d → extra (if enabled) → session
type Page = '5h' | '7d' | 'extra' | 'session';
let pageIndex = 0;
let billingType: BillingType = 'unknown';

let overrideConfig: ButtonConfig | null = null;

const actionIds: string[] = [];

function getPages(): Page[] {
  // API users have no subscription rate limits — only show session page
  if (billingType === 'api') {
    return ['session'];
  }
  const pages: Page[] = ['5h', '7d'];
  if (extraUsageEnabled) {
    pages.push('extra');
  }
  pages.push('session');
  return pages;
}

export function initUsageButton(b: BridgeClient): void {
  bridge = b;
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
  inputTokens = usage.inputTokens;
  outputTokens = usage.outputTokens;
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

function renderUsageSvg(): string {
  const pages = getPages();
  // Clamp pageIndex if extra page was removed
  if (pageIndex >= pages.length) pageIndex = 0;
  const page = pages[pageIndex];

  switch (page) {
    case '5h': {
      if (fiveHourPercent != null) {
        const pct = Math.round(fiveHourPercent);
        const color = pct > 80 ? '#ef4444' : pct > 50 ? '#fbbf24' : '#4ade80';
        const bg = pct > 80 ? '#2e0a0a' : pct > 50 ? '#2a1f00' : '#0a2e14';
        const reset = fiveHourResetsAt ? `Reset ${formatReset(fiveHourResetsAt)}` : '';
        return infoSvg('5-HOUR', `${pct}%`, reset, color, bg, pages);
      }
      return infoSvg('5-HOUR', '--', 'Push to fetch', '#666666', '#1a1a1a', pages);
    }

    case '7d': {
      if (sevenDayPercent != null) {
        const pct = Math.round(sevenDayPercent);
        const color = pct > 80 ? '#ef4444' : pct > 50 ? '#fbbf24' : '#60a5fa';
        const bg = pct > 80 ? '#2e0a0a' : pct > 50 ? '#2a1f00' : '#0a1a2e';
        const reset = sevenDayResetsAt ? `Reset ${formatReset(sevenDayResetsAt)}` : '';
        return infoSvg('7-DAY', `${pct}%`, reset, color, bg, pages);
      }
      return infoSvg('7-DAY', '--', 'Push to fetch', '#666666', '#1a1a1a', pages);
    }

    case 'extra': {
      if (extraUsageUsedCredits != null && extraUsageMonthlyLimit != null) {
        const spent = `$${extraUsageUsedCredits.toFixed(2)}`;
        const limit = `of $${extraUsageMonthlyLimit}/mo`;
        const pct = extraUsageUtilization != null ? Math.round(extraUsageUtilization) : 0;
        const color = pct > 80 ? '#ef4444' : pct > 50 ? '#fbbf24' : '#a78bfa';
        const bg = pct > 80 ? '#2e0a0a' : pct > 50 ? '#2a1f00' : '#1a0a2e';
        return infoSvg('EXTRA', spent, limit, color, bg, pages);
      }
      return infoSvg('EXTRA', '--', 'Push to fetch', '#666666', '#1a1a1a', pages);
    }

    case 'session': {
      const totalK = ((inputTokens + outputTokens) / 1000).toFixed(1);
      const inK = (inputTokens / 1000).toFixed(1);
      const outK = (outputTokens / 1000).toFixed(1);
      return infoSvg('SESSION', `${totalK}K`, `${inK}K in / ${outK}K out`, '#4ade80', '#0a2e14', pages);
    }

    default:
      return infoSvg('--', '--', '', '#666666', '#1a1a1a', pages);
  }
}

function infoSvg(title: string, value: string, sub: string, color: string, bg: string, pages: Page[]): string {
  // Page indicator dots
  const dots = pages.map((_, i) => {
    const cx = 72 - ((pages.length - 1) * 8) / 2 + i * 8;
    const fill = i === pageIndex ? color : `${color}40`;
    return `<circle cx="${cx}" cy="132" r="3" fill="${fill}"/>`;
  }).join('');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
    `<rect width="${SIZE}" height="${SIZE}" rx="12" fill="${bg}"/>`,
    `<text x="72" y="36" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" font-weight="bold" fill="${color}" opacity="0.6">${escXml(title)}</text>`,
    `<text x="72" y="78" text-anchor="middle" font-family="Arial,sans-serif" font-size="32" font-weight="bold" fill="${color}">${escXml(value)}</text>`,
    `<text x="72" y="108" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" fill="${color}" opacity="0.5">${escXml(sub)}</text>`,
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
    if (diffMin < 60) return `in ${diffMin}m`;
    const h = Math.floor(diffMin / 60);
    const m = diffMin % 60;
    return m > 0 ? `in ${h}h ${m}m` : `in ${h}h`;
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
    await ev.action.setImage(svgToDataUrl(renderUsageSvg()));
  }

  override async onKeyDown(_ev: KeyDownEvent): Promise<void> {
    if (overrideConfig?.action) {
      dlog('UsaBut', `keyDown: override action="${overrideConfig.action}"`);
      handleExpandedAction(overrideConfig.action, bridge);
      return;
    }
    const pages = getPages();
    pageIndex = (pageIndex + 1) % pages.length;
    dlog('UsaBut', `keyDown: page=${pages[pageIndex]} (${pageIndex + 1}/${pages.length})`);
    bridge.send({ type: 'query_usage' });
    refreshAll();
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    const idx = actionIds.indexOf(ev.action.id);
    if (idx !== -1) actionIds.splice(idx, 1);
  }
}
