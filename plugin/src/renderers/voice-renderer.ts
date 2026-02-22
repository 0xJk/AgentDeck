import { isWide, charPx, measureTextWidth, sliceByPx } from './text-utils.js';

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

/** Idle — no transcription */
export function renderVoiceReady(): string {
  return svgWrap(`
    <rect width="${W}" height="${H}" fill="#0f172a"/>
    <text x="100" y="18" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="bold" fill="#94a3b8">VOICE</text>
    <text x="100" y="55" text-anchor="middle" font-family="Arial,sans-serif" font-size="28" fill="#67e8f9" opacity="0.8">🎙</text>
    <text x="100" y="78" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" fill="#67e8f9" opacity="0.6">Ready</text>
    <rect x="60" y="90" width="80" height="2" rx="1" fill="#67e8f9" opacity="0.2"/>
  `);
}

/** Recording — pulsing red, waveform bars, timer */
export function renderVoiceRecording(elapsedMs: number, frame: number): string {
  // Pulsing dot: smooth sine wave
  const pulse = 0.5 + 0.5 * Math.sin(frame * 0.15);
  const dotColor = lerpColor([239, 68, 68], [252, 165, 165], pulse);

  // Timer
  const secs = Math.floor(elapsedMs / 1000);
  const mins = Math.floor(secs / 60);
  const timer = `${mins}:${String(secs % 60).padStart(2, '0')}`;

  // Waveform bars (5 bars, pseudo-random heights from frame)
  const bars: string[] = [];
  for (let i = 0; i < 5; i++) {
    const h = 8 + 18 * (0.5 + 0.5 * Math.sin(frame * 0.2 + i * 1.8));
    const x = 60 + i * 20;
    bars.push(`<rect x="${x}" y="${82 - h}" width="8" rx="2" height="${h}" fill="#ef4444" opacity="0.8"/>`);
  }

  const bgGrad = `<defs><linearGradient id="rg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#7f1d1d"/><stop offset="100%" stop-color="#450a0a"/>
  </linearGradient></defs>`;

  return svgWrap(`
    <rect width="${W}" height="${H}" fill="url(#rg)"/>
    <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="4" fill="none" stroke="#ef4444" stroke-opacity="0.3" stroke-width="1"/>
    <circle cx="55" cy="30" r="6" fill="${dotColor}"/>
    <text x="68" y="35" font-family="Arial,sans-serif" font-size="18" font-weight="bold" fill="#fca5a5">REC</text>
    <text x="130" y="35" font-family="Arial,sans-serif" font-size="16" fill="#fca5a5" opacity="0.8">${timer}</text>
    ${bars.join('')}
  `, bgGrad);
}

/** Transcribing — spinner dots, amber progress bar */
export function renderVoiceTranscribing(frame: number): string {
  // 3 dots cycling
  const dotPhase = Math.floor(frame / 3) % 3;
  const dots: string[] = [];
  for (let i = 0; i < 3; i++) {
    const active = i === dotPhase;
    const r = active ? 5 : 3;
    const opacity = active ? '1' : '0.3';
    dots.push(`<circle cx="${85 + i * 15}" cy="45" r="${r}" fill="#fbbf24" opacity="${opacity}"/>`);
  }

  // Oscillating progress bar
  const barX = 10 + 90 * (0.5 + 0.5 * Math.sin(frame * 0.08));

  return svgWrap(`
    <rect width="${W}" height="${H}" fill="#0f172a"/>
    ${dots.join('')}
    <text x="100" y="70" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" fill="#fbbf24">Transcribing...</text>
    <rect x="10" y="88" width="180" height="3" rx="1.5" fill="#1e293b"/>
    <rect x="${barX}" y="88" width="80" height="3" rx="1.5" fill="#fbbf24" opacity="0.7"/>
  `);
}

/** Error state */
export function renderVoiceError(msg?: string): string {
  const errorText = msg || 'Error';
  const display = errorText.length > 28 ? errorText.slice(0, 27) + '…' : errorText;

  return svgWrap(`
    <rect width="${W}" height="${H}" fill="#0f172a"/>
    <text x="100" y="30" text-anchor="middle" font-family="Arial,sans-serif" font-size="22" fill="#ef4444">⚠</text>
    <text x="100" y="55" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" fill="#fca5a5">${escapeXml(display)}</text>
    <text x="100" y="75" text-anchor="middle" font-family="Arial,sans-serif" font-size="10" fill="#64748b">Push to clear</text>
    <rect x="10" y="90" width="180" height="3" rx="1.5" fill="#991b1b"/>
  `);
}

/** Disabled state (disconnected) */
export function renderVoiceDisabled(): string {
  return svgWrap(`
    <rect width="${W}" height="${H}" fill="#0f172a"/>
    <text x="100" y="18" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="bold" fill="#475569">VOICE</text>
    <text x="100" y="55" text-anchor="middle" font-family="Arial,sans-serif" font-size="22" fill="#475569" opacity="0.5">🎙</text>
    <text x="100" y="78" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" fill="#475569">Offline</text>
  `);
}

function lerpColor(a: number[], b: number[], t: number): string {
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgb(${r},${g},${bl})`;
}

// === Voice Text Takeover (wide canvas word-wrapped display) ===

export const VT_FONT_SIZE = 16;
export const VT_COMPACT_FONT_SIZE = 13;
const VT_LINE_HEIGHT = 20;
const VT_COMPACT_LINE_HEIGHT = 17;

/** Adaptive font tiers: try largest first, fall back to smaller */
const FONT_TIERS = [
  { fontSize: 48, lineHeight: 54, maxLines: 1 },
  { fontSize: 36, lineHeight: 42, maxLines: 1 },
  { fontSize: 24, lineHeight: 30, maxLines: 2 },
  { fontSize: 18, lineHeight: 23, maxLines: 3 },
  { fontSize: 16, lineHeight: 20, maxLines: Infinity },
];

const MAX_LINE_PX = 180; // fallback for single-panel

// Wide canvas layout constants
const HEADER_H = 22;     // header area (y=0..22)
const TEXT_AREA_H = 58;  // text clipping area (y=22..80)
const FOOTER_H = 20;     // action hints + accent bar (y=80..100)

export { TEXT_AREA_H as VT_TEXT_AREA_H };

// estimatePx alias for local use
const estimatePx = measureTextWidth;

/** Word-wrap text by estimated pixel width (works naturally for all scripts). */
export function wrapVoiceText(text: string, fontSize = VT_FONT_SIZE, maxPx = MAX_LINE_PX): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  let currentPx = 0;
  const spacePx = fontSize * 0.28;  // Arial space ≈ 0.25-0.28em

  for (const word of words) {
    const wordPx = estimatePx(word, fontSize);

    // Flush current line if adding this word would overflow
    if (current && currentPx + spacePx + wordPx > maxPx) {
      lines.push(current);
      current = '';
      currentPx = 0;
    }

    // Word wider than one line → break at character boundaries
    if (wordPx > maxPx) {
      if (current) { lines.push(current); current = ''; currentPx = 0; }
      let rem = word;
      while (estimatePx(rem, fontSize) > maxPx) {
        const [chunk, rest] = sliceByPx(rem, maxPx, fontSize);
        lines.push(chunk);
        rem = rest;
      }
      current = rem;
      currentPx = estimatePx(rem, fontSize);
    } else {
      // Append word to current line
      if (current) {
        current += ' ' + word;
        currentPx += spacePx + wordPx;
      } else {
        current = word;
        currentPx = wordPx;
      }
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Lines visible on a panel: first panel has header → fewer lines */
export function vtLinesPerPanel(isFirst: boolean, compact = false): number {
  if (compact) return isFirst ? 4 : 5;
  return isFirst ? 3 : 4;
}

/** Total visible lines across N panels */
export function vtTotalVisibleLines(panelCount: number, compact = false): number {
  const first = compact ? 4 : 3;
  const rest = compact ? 5 : 4;
  return first + (panelCount - 1) * rest;
}

// === Wide Canvas Voice Text ===

const FIRST_BASELINE_Y = 34;

export interface WideVoiceTextResult {
  panels: string[];
  maxScrollY: number;
  lineHeight: number;
}

/**
 * Render transcription text as a wide canvas (panelCount × 200 px),
 * then slice into per-panel SVGs via viewBox.
 */
export function renderWideVoiceText(
  text: string,
  panelCount: number,
  scrollY: number,
): WideVoiceTextResult {
  const totalW = panelCount * W;
  const maxLinePx = totalW - 20; // 10px margin each side

  // Adaptive font: try largest font first, fall back until text fits
  let lines: string[] = [];
  let fontSize = VT_FONT_SIZE;
  let lineHeight = VT_LINE_HEIGHT;

  for (const tier of FONT_TIERS) {
    lines = wrapVoiceText(text, tier.fontSize, maxLinePx);
    if (lines.length <= tier.maxLines) {
      fontSize = tier.fontSize;
      lineHeight = tier.lineHeight;
      break;
    }
  }

  // Vertical centering: short text centered in clip area, long text top-aligned
  const textBlockH = (lines.length - 1) * lineHeight;
  const centeredY = HEADER_H + Math.round((TEXT_AREA_H - textBlockH) / 2) + Math.round(fontSize * 0.3);
  const firstY = Math.max(FIRST_BASELINE_Y, centeredY);

  // Max scroll: last line baseline at most bottom of text clip area
  const maxScrollY = Math.max(0,
    firstY + (lines.length - 1) * lineHeight - (HEADER_H + TEXT_AREA_H));
  const sy = Math.max(0, Math.min(scrollY, maxScrollY));

  // Text elements — center-aligned on wide canvas
  const cx = Math.round(totalW / 2);
  let textElements = '';
  for (let i = 0; i < lines.length; i++) {
    const y = firstY + i * lineHeight;
    textElements += `<text x="${cx}" y="${y}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${fontSize}" fill="#e2e8f0">${escapeXml(lines[i])}</text>`;
  }

  // Action hint pills (anchored to right end, 10px padding from edge)
  const hx = totalW - 120;
  const hints = `<rect x="${hx}" y="80" width="50" height="16" rx="5" fill="#14532d"/>`
    + `<text x="${hx + 25}" y="93" text-anchor="middle" font-family="Arial,sans-serif" font-size="13" font-weight="bold" fill="#4ade80">tap \u2713</text>`
    + `<rect x="${hx + 54}" y="80" width="56" height="16" rx="5" fill="#450a0a"/>`
    + `<text x="${hx + 82}" y="93" text-anchor="middle" font-family="Arial,sans-serif" font-size="13" font-weight="bold" fill="#f87171">hold \u2715</text>`;

  // Assemble wide SVG content (800×100 coordinate system)
  const defs = `<defs><clipPath id="ta"><rect x="0" y="${HEADER_H}" width="${totalW}" height="${TEXT_AREA_H}"/></clipPath></defs>`;
  const content = `<rect width="${totalW}" height="${H}" fill="#0f172a"/>`
    + `<text x="10" y="16" font-family="Arial,sans-serif" font-size="14" font-weight="bold" fill="#fbbf24">\uD83C\uDF99 REVIEW</text>`
    + hints
    + `<rect x="10" y="95" width="${totalW - 20}" height="2" rx="1" fill="#fbbf24" opacity="0.15"/>`
    + `<g clip-path="url(#ta)"><g transform="translate(0,${-sy})">${textElements}</g></g>`;

  // Slice into per-panel SVGs via translate (viewBox offset unreliable on SD renderer)
  const panels: string[] = [];
  for (let i = 0; i < panelCount; i++) {
    panels.push(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
      + defs
      + `<g transform="translate(${-i * W},0)">${content}</g>`
      + `</svg>`,
    );
  }

  return { panels, maxScrollY, lineHeight };
}
