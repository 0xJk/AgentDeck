import { State, PromptOption } from '@agentdeck/shared';
import { processLabel, colorForOption } from '../layout-manager.js';
import { measureTextWidth, sliceByPx } from './text-utils.js';

const W = 200;
const H = 100;

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function svgWrap(inner: string, defs = ''): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${defs}${inner}</svg>`;
}

/** Truncate by pixel width at given fontSize. Falls back to char count if no fontSize. */
function truncate(str: string, max: number, fontSize?: number): string {
  if (fontSize) {
    const maxPx = max * fontSize * 0.55; // approximate: max chars × average char width
    if (measureTextWidth(str, fontSize) <= maxPx) return str;
    const ellipsisPx = measureTextWidth('\u2026', fontSize);
    const [fit] = sliceByPx(str, maxPx - ellipsisPx, fontSize);
    return fit + '\u2026';
  }
  return str.length > max ? str.slice(0, max - 1) + '\u2026' : str;
}


function wrapTextLines(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= maxChars) {
      current += ' ' + word;
    } else {
      lines.push(current);
      if (lines.length >= maxLines) return lines;
      current = word;
    }
  }
  if (current && lines.length < maxLines) {
    lines.push(current);
  }
  if (lines.length === maxLines && current && lines[lines.length - 1] !== current) {
    // Truncate last line if we ran out of space
    lines[lines.length - 1] = truncate(lines[lines.length - 1], maxChars);
  }
  return lines;
}

// ====== E1: Context Panel ======

export interface ContextPanelData {
  state: State;
  selectedIndex: number;
  total: number;
  question?: string;
  currentTool?: string;
}

export function renderContextPanel(data: ContextPanelData): string {
  const { state, selectedIndex, total, question, currentTool } = data;
  const isPermission = state === State.AWAITING_PERMISSION;
  const isDiff = state === State.AWAITING_DIFF;

  // Gradient background based on state
  const gradId = 'cg';
  const gradColors = isPermission
    ? ['#7f1d1d', '#450a0a']
    : isDiff
      ? ['#78350f', '#451a03']
      : ['#1e3a5f', '#0f172a'];
  const defs = `<defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0%" stop-color="${gradColors[0]}"/><stop offset="100%" stop-color="${gradColors[1]}"/>`
    + `</linearGradient></defs>`;

  const ctxLabel = isPermission ? 'PERMISSION'
    : isDiff ? 'DIFF REVIEW'
    : 'SELECT';

  const labelColor = isPermission ? '#fca5a5' : isDiff ? '#fcd34d' : '#93c5fd';
  const toolName = currentTool ? escapeXml(truncate(currentTool, 18)) : '';

  let ctxQuestion = question || '';
  if (!ctxQuestion) {
    if (isPermission && currentTool) {
      ctxQuestion = `Allow ${currentTool}?`;
    } else {
      ctxQuestion = `Choose option (${total})`;
    }
  }
  const questionLines = wrapTextLines(ctxQuestion, 24, 2);

  const inner = `
    <rect width="${W}" height="${H}" fill="url(#${gradId})"/>
    <text x="10" y="16" font-family="Arial,sans-serif" font-size="14" font-weight="bold" fill="${labelColor}">${ctxLabel}</text>
    <text x="190" y="15" text-anchor="end" font-family="Arial,sans-serif" font-size="10" fill="#64748b">${selectedIndex + 1}/${total}</text>
    <text x="100" y="44" text-anchor="middle" font-family="Arial,sans-serif" font-size="18" font-weight="bold" fill="#e2e8f0">${toolName}</text>
    ${questionLines.map((l, i) => `<text x="100" y="${66 + i * 16}" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" fill="#94a3b8">${escapeXml(l)}</text>`).join('')}
  `;

  return svgWrap(inner, defs);
}

// ====== E2: Focus Panel ======

export interface FocusPanelData {
  opt: PromptOption;
  selectedIndex: number;
  total: number;
  isPermOrDiff: boolean;
  state: State;
  currentTool?: string;
  fourEnc: boolean;
}

export function renderFocusPanel(data: FocusPanelData): string {
  const { opt, selectedIndex, total, isPermOrDiff, state, currentTool, fourEnc } = data;
  const label = processLabel(opt.label);
  const colors = isPermOrDiff
    ? colorForOption(opt)
    : opt.recommended
      ? { color: '#1e4d2b', textColor: '#86efac' }
      : { color: '#1e3a5f', textColor: '#93c5fd' };

  // Pill background for option name — adaptive font size
  const mainText = escapeXml(truncate(label.main, 18));
  const fontSize = label.main.length > 12 ? 20 : 24;
  const pillW = Math.min(186, mainText.length * fontSize * 0.6 + 20);
  const pillX = (W - pillW) / 2;
  const pillH = fontSize + 12;

  const badge = opt.recommended ? '\u2605 Recommended'
    : opt.selected ? '\u2713 Selected'
    : '';
  const badgeColor = opt.recommended ? '#86efac'
    : opt.selected ? '#93c5fd'
    : '';

  const inner = `
    <rect width="${W}" height="${H}" fill="#0f172a"/>
    <rect x="${pillX}" y="16" width="${pillW}" height="${pillH}" rx="${pillH / 2}" fill="${colors.color}"/>
    <text x="100" y="44" text-anchor="middle" font-family="Arial,sans-serif" font-size="${fontSize}" font-weight="bold" fill="${colors.textColor}">${mainText}</text>
    ${label.sub ? `<text x="100" y="68" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" fill="#94a3b8">${escapeXml(truncate(label.sub, 32))}</text>` : ''}
    ${badge ? `<text x="100" y="86" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" fill="${badgeColor}">${badge}</text>` : ''}
  `;

  return svgWrap(inner);
}

// ====== E3: List Panel ======

export interface ListPanelData {
  options: PromptOption[];
  selectedIndex: number;
  isPermOrDiff: boolean;
  state: State;
}

export function renderListPanel(data: ListPanelData): string {
  const { options, selectedIndex, isPermOrDiff, state } = data;
  const ROWS = 4;

  let windowStart = 0;
  if (options.length > ROWS) {
    windowStart = Math.max(0, selectedIndex - Math.floor(ROWS / 2));
    windowStart = Math.min(windowStart, options.length - ROWS);
  }

  const ROW_H = 24;
  let rows = '<rect width="200" height="100" fill="#0f172a"/>';

  for (let i = 0; i < ROWS; i++) {
    const optIdx = windowStart + i;
    if (optIdx >= options.length) break;

    const rowOpt = options[optIdx];
    const isSelected = optIdx === selectedIndex;
    const y = 2 + i * ROW_H;
    const label = processLabel(rowOpt.label);
    // Tighter width when scrollable, to leave room for the ▲/▼ chevrons.
    const text = truncate(`${optIdx + 1}. ${label.main}`, options.length > ROWS ? 23 : 26, 14);

    // Use color to distinguish recommended/selected instead of badges
    const rowColors = isPermOrDiff ? colorForOption(rowOpt) : null;
    const isRecommended = !isPermOrDiff && rowOpt.recommended;
    const isChosen = !isPermOrDiff && rowOpt.selected;

    if (isSelected) {
      const bgColor = rowColors?.color ?? (isRecommended ? '#1e4d2b' : '#1e3a5f');
      rows += `<rect x="2" y="${y}" width="194" height="${ROW_H - 1}" rx="3" fill="${bgColor}"/>`;
      rows += `<text x="8" y="${y + 17}" font-family="Arial,sans-serif" font-size="14" font-weight="bold" fill="#ffffff">\u25B6 ${escapeXml(text)}</text>`;
    } else {
      const dimColor = rowColors?.color ?? (isRecommended ? '#1e4d2b' : isChosen ? '#1e3a5f' : null);
      if (dimColor) {
        rows += `<rect x="2" y="${y}" width="194" height="${ROW_H - 1}" rx="3" fill="${dimColor}" opacity="0.25"/>`;
      }
      const textColor = isRecommended ? '#86efac' : isChosen ? '#93c5fd' : '#94a3b8';
      rows += `<text x="14" y="${y + 17}" font-family="Arial,sans-serif" font-size="14" fill="${textColor}">${escapeXml(text)}</text>`;
    }
  }

  // Scroll affordances when more options than fit: a right-edge thumb bar PLUS
  // ▲/▼ chevrons so the user always knows more options exist above/below (the
  // bottom option being silently hidden was the core 显示不全 complaint).
  if (options.length > ROWS) {
    const trackH = ROWS * ROW_H - 2;
    const thumbH = Math.max(10, (ROWS / options.length) * trackH);
    const thumbY = 2 + (windowStart / (options.length - ROWS)) * (trackH - thumbH);
    rows += `<rect x="197" y="2" width="2" height="${trackH}" rx="1" fill="#1e293b"/>`;
    rows += `<rect x="197" y="${thumbY}" width="2" height="${thumbH}" rx="1" fill="#475569"/>`;
    const moreAbove = windowStart > 0;
    const moreBelow = windowStart + ROWS < options.length;
    if (moreAbove) rows += `<text x="190" y="11" text-anchor="middle" font-family="Arial,sans-serif" font-size="10" fill="#64748b">▲</text>`;
    if (moreBelow) rows += `<text x="190" y="97" text-anchor="middle" font-family="Arial,sans-serif" font-size="10" fill="#64748b">▼</text>`;
  }

  return svgWrap(rows);
}

// ====== E4: Detail Panel ======

export interface DetailPanelData {
  opt: PromptOption;
  isPermOrDiff: boolean;
  state: State;
  selectedIndex: number;
  total: number;
  toolInput?: string;
  question?: string;
}

export function renderDetailPanel(data: DetailPanelData): string {
  const { opt, isPermOrDiff, state, selectedIndex, total, toolInput, question } = data;
  const isPermission = state === State.AWAITING_PERMISSION;
  const isDiff = state === State.AWAITING_DIFF;

  // Gradient background
  const gradColors = isPermission
    ? ['#1a0505', '#0f172a']
    : isDiff
      ? ['#1a0f05', '#0f172a']
      : ['#0f172a', '#0f172a'];
  const defs = `<defs><linearGradient id="dg" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0%" stop-color="${gradColors[0]}"/><stop offset="100%" stop-color="${gradColors[1]}"/>`
    + `</linearGradient></defs>`;

  const shortcutText = opt.shortcut ? `[${opt.shortcut}]` : '';

  let inner = `<rect width="${W}" height="${H}" fill="url(#dg)"/>`;

  // Header: DETAIL label + shortcut
  const headerColor = isPermission ? '#fca5a5' : isDiff ? '#fcd34d' : '#93c5fd';
  inner += `<text x="10" y="16" font-family="Arial,sans-serif" font-size="14" font-weight="bold" fill="${headerColor}">DETAIL</text>`;
  if (shortcutText) {
    inner += `<text x="190" y="14" text-anchor="end" font-family="monospace,Courier" font-size="11" fill="#64748b">${shortcutText}</text>`;
  }

  // Main content area: toolInput (permission/diff) or option detail
  if (isPermOrDiff && toolInput) {
    // Show tool argument in monospace — this is the key E4 differentiation
    const lines = wrapMonoText(toolInput, 26, 4);
    for (let i = 0; i < Math.min(lines.length, 4); i++) {
      const y = 34 + i * 16;
      inner += `<text x="10" y="${y}" font-family="monospace,Courier" font-size="13" fill="#e2e8f0">${escapeXml(lines[i])}</text>`;
    }
    if (lines.length > 4) {
      inner += `<text x="190" y="${34 + 4 * 16}" text-anchor="end" font-family="Arial,sans-serif" font-size="9" fill="#475569">\u2026</text>`;
    }
  } else {
    // Option detail: full label word-wrapped (26 chars × 5 lines, 12px, left-aligned)
    const fullLabel = opt.label;
    const labelLines = wrapTextLines(fullLabel, 26, 5);
    for (let i = 0; i < labelLines.length; i++) {
      const y = 30 + i * 13;
      inner += `<text x="10" y="${y}" font-family="Arial,sans-serif" font-size="12" font-weight="bold" fill="#e2e8f0">${escapeXml(labelLines[i])}</text>`;
    }

    // Subtitle word-wrapped below label lines
    const label = processLabel(opt.label);
    if (label.sub) {
      const subLines = wrapTextLines(label.sub, 30, 2);
      const subY0 = 30 + labelLines.length * 13 + 2;
      for (let i = 0; i < subLines.length; i++) {
        inner += `<text x="10" y="${subY0 + i * 12}" font-family="Arial,sans-serif" font-size="11" fill="#94a3b8">${escapeXml(subLines[i])}</text>`;
      }
    }

    const badge = opt.recommended ? '\u2605 Recommended'
      : opt.selected ? '\u2713 Selected'
      : '';
    const badgeColor = opt.recommended ? '#86efac' : opt.selected ? '#93c5fd' : '#64748b';
    if (badge) {
      inner += `<text x="10" y="96" font-family="Arial,sans-serif" font-size="11" fill="${badgeColor}">${badge}</text>`;
    }
  }

  return svgWrap(inner, defs);
}

/** Word-wrap for monospace text (handles multi-line input) */
function wrapMonoText(text: string, maxChars: number, maxLines = 4): string[] {
  const inputLines = text.split('\n');
  const lines: string[] = [];
  for (const inputLine of inputLines) {
    if (lines.length >= maxLines) break;
    if (inputLine.length <= maxChars) {
      lines.push(inputLine);
    } else {
      let remaining = inputLine;
      while (remaining.length > 0 && lines.length < maxLines) {
        lines.push(remaining.slice(0, maxChars));
        remaining = remaining.slice(maxChars);
      }
    }
  }
  return lines;
}
