/**
 * SVG Fisheye renderer for the OpenClaw Timeline Panel.
 * 400px x 100px wide canvas split into two 200px panels (E2 + E3).
 *
 * No bottom bar — maximizes event text area below compact header.
 * Grouped entries show "(xN)" suffix. Scheduled entries dimmed.
 */

import type { GroupedEntry } from '../timeline-store.js';
import { measureTextWidth, sliceByPx, wrapTextByWidth } from './text-utils.js';

const PANEL_W = 200;
const CANVAS_W = 400;
const H = 100;
const ACCENT = '#c084fc';

// Event area: below header (y=18 baseline + descenders ~4px gap)
const EVENT_TOP = 26;
const EVENT_BOTTOM = H;
const CENTER_Y = Math.round((EVENT_TOP + EVENT_BOTTOM) / 2); // 63

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function typeIcon(type: string, status?: string): string {
  switch (type) {
    case 'tool_request':
      if (status === 'approved') return '\u2713';
      if (status === 'denied') return '\u2717';
      return '\u26A0';
    case 'tool_resolved': return '\u2713';
    case 'chat_start': return '\u25B6';
    case 'chat_end': return '\u25A0';
    case 'error': return '\u2717';
    case 'scheduled': return '\u23F0';
    default: return '\u2022';
  }
}

/** Shorten file paths inline: /very/long/path/to/file.ts -> .../to/file.ts */
function smartSummary(raw: string): string {
  return raw.replace(/((?:\/[\w.+-]+){3,})/, (match) => {
    const parts = match.split('/').filter(Boolean);
    return parts.length > 2 ? `\u2026/${parts.slice(-2).join('/')}` : match;
  });
}

function truncateByPx(str: string, maxPx: number, fontSize: number): string {
  if (measureTextWidth(str, fontSize) <= maxPx) return str;
  const ellipsisPx = measureTextWidth('\u2026', fontSize);
  const [fit] = sliceByPx(str, maxPx - ellipsisPx, fontSize);
  return fit + '\u2026';
}

export interface TimelinePanels {
  panels: [string, string];
}

/** Main render entry point */
export function renderTimeline(
  groups: readonly GroupedEntry[],
  scrollIndex: number,
  detailMode: boolean,
): TimelinePanels {
  let inner: string;

  if (groups.length === 0) {
    inner = renderEmpty();
  } else if (detailMode) {
    inner = renderDetailView(groups, scrollIndex);
  } else {
    inner = renderFisheyeView(groups, scrollIndex);
  }

  const panel0 = `<svg xmlns="http://www.w3.org/2000/svg" width="${PANEL_W}" height="${H}" viewBox="0 0 ${PANEL_W} ${H}"><g>${inner}</g></svg>`;
  const panel1 = `<svg xmlns="http://www.w3.org/2000/svg" width="${PANEL_W}" height="${H}" viewBox="0 0 ${PANEL_W} ${H}"><g transform="translate(-${PANEL_W}, 0)">${inner}</g></svg>`;

  return { panels: [panel0, panel1] };
}

/** Empty state */
function renderEmpty(): string {
  return `
    <rect width="${CANVAS_W}" height="${H}" fill="#000000"/>
    <text x="200" y="18" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="bold" fill="#94a3b8">TIMELINE</text>
    <text x="200" y="${CENTER_Y}" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" fill="#475569">No events</text>
  `;
}

/** Detail mode: full raw text of focused group, word-wrapped across 400px */
function renderDetailView(
  groups: readonly GroupedEntry[],
  scrollIndex: number,
): string {
  const idx = clamp(Math.round(scrollIndex), 0, groups.length - 1);
  const group = groups[idx];
  if (!group) return renderEmpty();

  const { entry, count, firstTs, lastTs } = group;
  const icon = typeIcon(entry.type, entry.status);
  const typeBadge = entry.type.replace('_', ' ').toUpperCase();
  const countSuffix = count > 1 ? ` \u00d7${count}` : '';
  const timeStr = count > 1 && firstTs !== lastTs
    ? `${formatTime(firstTs)}\u2013${formatTime(lastTs)}`
    : formatTime(entry.ts);

  // Word-wrap raw text across full width — use smaller font (11px) to fit more content
  // Available height: y=30 to y=98 = 68px, at 12px line height = ~5-6 lines
  const lines = wrapTextByWidth(entry.raw, 370, 11).slice(0, 6);
  const linesXml = lines.map((line, i) =>
    `<text x="15" y="${32 + i * 12}" font-family="Arial,sans-serif" font-size="11" fill="#e2e8f0">${escapeXml(line)}</text>`,
  ).join('\n    ');

  return `
    <rect width="${CANVAS_W}" height="${H}" fill="#000000"/>
    <text x="15" y="18" font-family="Arial,sans-serif" font-size="12" font-weight="bold" fill="${ACCENT}">${escapeXml(icon)} ${escapeXml(typeBadge)}${escapeXml(countSuffix)}</text>
    <text x="${CANVAS_W - 15}" y="18" text-anchor="end" font-family="Arial,sans-serif" font-size="11" fill="#94a3b8">${timeStr}</text>
    ${linesXml}
  `;
}

/** Fisheye view: font size / opacity / spacing interpolated from center */
function renderFisheyeView(
  groups: readonly GroupedEntry[],
  scrollIndex: number,
): string {
  const baseLine = 17;
  const elements: string[] = [];

  // Background (black — blends with LCD for transparent look) + header
  elements.push(`<rect width="${CANVAS_W}" height="${H}" fill="#000000"/>`);
  elements.push(`<text x="200" y="18" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="bold" fill="#94a3b8">TIMELINE</text>`);

  // Clip event area (header to bottom, no bar)
  elements.push(`<clipPath id="evtClip"><rect x="0" y="${EVENT_TOP}" width="${CANVAS_W}" height="${EVENT_BOTTOM - EVENT_TOP}"/></clipPath>`);
  elements.push(`<g clip-path="url(#evtClip)">`);

  const centerIdx = clamp(Math.round(scrollIndex), 0, groups.length - 1);

  const props = (gIdx: number) => {
    const absOffset = Math.abs(gIdx - scrollIndex);
    const t = clamp(absOffset, 0, 3) / 3;
    return {
      fontSize: lerp(15, 10, t),
      opacity: lerp(1.0, 0.3, t),
    };
  };

  // Center item
  if (centerIdx >= 0 && centerIdx < groups.length) {
    const p = props(centerIdx);
    renderGroupLine(elements, groups[centerIdx], 10, CENTER_Y, p.fontSize, p.opacity);
  }

  // Items above center
  let yUp = CENTER_Y;
  for (let i = centerIdx - 1; i >= Math.max(0, centerIdx - 4); i--) {
    const p = props(i);
    const prevP = props(i + 1);
    const gap = baseLine * ((p.fontSize + prevP.fontSize) / 2 / 15);
    yUp -= gap;
    if (yUp < EVENT_TOP - 5) break;
    renderGroupLine(elements, groups[i], 10, yUp, p.fontSize, p.opacity);
  }

  // Items below center
  let yDown = CENTER_Y;
  for (let i = centerIdx + 1; i <= Math.min(groups.length - 1, centerIdx + 4); i++) {
    const p = props(i);
    const prevP = props(i - 1);
    const gap = baseLine * ((p.fontSize + prevP.fontSize) / 2 / 15);
    yDown += gap;
    if (yDown > EVENT_BOTTOM + 5) break;
    renderGroupLine(elements, groups[i], 10, yDown, p.fontSize, p.opacity);
  }

  elements.push(`</g>`);
  return elements.join('\n    ');
}

/** Render one grouped entry line in the fisheye view */
function renderGroupLine(
  elements: string[],
  group: GroupedEntry,
  x: number,
  y: number,
  fontSize: number,
  opacity: number,
): void {
  const { entry, count } = group;
  const isScheduled = entry.type === 'scheduled';
  const time = formatTime(entry.ts);
  const icon = typeIcon(entry.type, entry.status);
  const countSuffix = count > 1 ? ` (\u00d7${count})` : '';
  const fullText = `${time} ${icon} ${entry.raw}${countSuffix}`;
  const truncated = truncateByPx(fullText, CANVAS_W - 10, fontSize);
  const fillColor = isScheduled ? '#94a3b8' : '#e2e8f0';
  const finalOpacity = isScheduled ? opacity * 0.6 : opacity;

  elements.push(
    `<text x="${x}" y="${y.toFixed(1)}" font-family="Arial,sans-serif" font-size="${fontSize.toFixed(1)}" fill="${fillColor}" opacity="${finalOpacity.toFixed(2)}">${escapeXml(truncated)}</text>`,
  );
}
