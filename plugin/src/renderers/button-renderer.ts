import { ButtonConfig } from '../layout-manager.js';
import { measureTextWidth, sliceByPx, wrapTextByWidth } from './text-utils.js';
import { getCachedLabel, requestAbbreviation } from '../label-summarizer.js';

const SIZE = 144; // Stream Deck+ high DPI
const MAX_TEXT_PX = 124; // 144 - 10px padding each side
const MAX_LINES = 3;

/** Abbreviation patterns: applied only when text overflows */
const ABBREVIATIONS: [RegExp, string][] = [
  [/^Yes,?\s+allow\s+and\s+don['\u2019]t\s+ask\s+again$/i, 'Allow always'],
  [/^Yes,?\s+and\s+don['\u2019]t\s+ask\s+again\s+for:\s*/i, 'ALWAYS: '],
  [/^Yes,?\s+and\s+don['\u2019]t\s+ask\s+again$/i, 'ALWAYS'],
  [/^Yes,?\s+allow\s+all\s+sessions\s+in\s+/i, 'Trust: '],
  [/^Yes,?\s+I\s+trust\s+this\s+folder$/i, 'Trust folder'],
  [/^Yes,?\s+allow\s+this\s+/i, 'Allow '],
  [/^Yes,?\s+/i, 'Yes, '],
  [/^No,?\s+don['\u2019]t\s+allow$/i, 'Deny'],
  [/^No,?\s+and\s+don['\u2019]t\s+ask\s+again$/i, 'Deny always'],
];

/** Try to shorten label using known patterns. Returns null if no match. */
function tryAbbreviate(text: string): string | null {
  for (const [pattern, replacement] of ABBREVIATIONS) {
    if (pattern.test(text)) {
      // For patterns that capture a suffix (ending with space), append remaining
      const match = text.match(pattern);
      if (match && replacement.endsWith(' ')) {
        return replacement + text.slice(match[0].length);
      }
      return replacement;
    }
  }
  return null;
}

/** Abbreviate label if it doesn't fit. Returns { text, abbreviated, needsHaiku } */
function abbreviateLabel(text: string, maxWidthPx: number, fontSize: number): { text: string; abbreviated: boolean; needsHaiku: boolean } {
  if (measureTextWidth(text, fontSize) <= maxWidthPx * MAX_LINES) {
    return { text, abbreviated: false, needsHaiku: false };
  }

  // Try local heuristic abbreviation
  const abbr = tryAbbreviate(text);
  if (abbr && measureTextWidth(abbr, fontSize) <= maxWidthPx * MAX_LINES) {
    return { text: abbr, abbreviated: true, needsHaiku: false };
  }

  // Check Haiku cache (sync — no latency)
  const cached = getCachedLabel(text);
  if (cached && measureTextWidth(cached, fontSize) <= maxWidthPx * MAX_LINES) {
    return { text: cached, abbreviated: true, needsHaiku: false };
  }

  // Ellipsis truncation as sync fallback; flag for async Haiku request
  const target = abbr || text;
  const [fit] = sliceByPx(target, maxWidthPx * MAX_LINES - measureTextWidth('\u2026', fontSize), fontSize);
  return { text: fit + '\u2026', abbreviated: true, needsHaiku: !cached };
}

/** Font tier selection based on pixel width */
const FONT_TIERS = [
  { fontSize: 28, maxLines: 2 },
  { fontSize: 24, maxLines: 2 },
  { fontSize: 20, maxLines: 3 },
  { fontSize: 16, maxLines: 3 },
];

function chooseFontTier(text: string): { fontSize: number; maxLines: number } {
  for (const tier of FONT_TIERS) {
    const lines = wrapTextByWidth(text, MAX_TEXT_PX, tier.fontSize);
    if (lines.length <= tier.maxLines) return tier;
  }
  return FONT_TIERS[FONT_TIERS.length - 1];
}

export function renderButton(config: ButtonConfig): string {
  const textOpacity = config.enabled ? '1' : '0.4';

  // Badge + title
  const displayTitle = config.badge ? `${config.badge} ${config.title}` : config.title;

  // 2-line layout: title (bold, larger) + subtitle (regular, smaller)
  if (config.subtitle) {
    const titleTier = chooseFontTier(displayTitle);
    const mainFontSize = titleTier.fontSize > 24 ? 24 : titleTier.fontSize;
    const subFontSize = 14;
    const titleLines = wrapTextByWidth(displayTitle, MAX_TEXT_PX, mainFontSize);
    const subLines = wrapTextByWidth(config.subtitle, MAX_TEXT_PX, subFontSize);

    const totalHeight = titleLines.length * (mainFontSize + 4) + subLines.length * (subFontSize + 2) + 8;
    const startY = Math.max(30, (SIZE - totalHeight) / 2 + mainFontSize);

    let y = startY;
    const elements: string[] = [];
    for (const line of titleLines) {
      elements.push(`<text x="72" y="${y}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${mainFontSize}" font-weight="bold" fill="${config.textColor}" opacity="${textOpacity}">${escapeXml(line)}</text>`);
      y += mainFontSize + 4;
    }
    y += 4; // gap between title and subtitle
    for (const line of subLines) {
      elements.push(`<text x="72" y="${y}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${subFontSize}" fill="${config.textColor}" opacity="0.6">${escapeXml(line)}</text>`);
      y += subFontSize + 2;
    }

    return svgFrame(config.color, elements.join(''), config.slotNumber);
  }

  // Single-text layout: abbreviate if needed, then pick font tier
  const { text: finalText, abbreviated, needsHaiku } = abbreviateLabel(displayTitle, MAX_TEXT_PX, 20);
  const tier = chooseFontTier(finalText);
  const fontSize = tier.fontSize;
  const lines = wrapTextByWidth(finalText, MAX_TEXT_PX, fontSize);
  const lineHeight = fontSize + (fontSize <= 16 ? 4 : 8);
  const startY = lines.length === 1 ? 84 : 84 - ((lines.length - 1) * lineHeight) / 2;

  let textElements = lines
    .map(
      (line, i) =>
        `<text x="72" y="${startY + i * lineHeight}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${fontSize}" font-weight="bold" fill="${config.textColor}" opacity="${textOpacity}">${escapeXml(line)}</text>`,
    )
    .join('');

  // Abbreviated indicator
  if (abbreviated) {
    textElements += `<text x="${SIZE - 8}" y="${SIZE - 8}" text-anchor="end" font-family="Arial,sans-serif" font-size="8" fill="${config.textColor}" opacity="0.3">~</text>`;
  }

  return svgFrame(config.color, textElements, config.slotNumber);
}

function svgFrame(bgColor: string, innerElements: string, slotNumber?: number): string {
  const slotLabel = slotNumber != null
    ? `<text x="${SIZE - 10}" y="18" text-anchor="end" font-family="Arial,sans-serif" font-size="13" fill="#ffffff" opacity="0.3">${slotNumber}</text>`
    : '';
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
    `<rect width="${SIZE}" height="${SIZE}" rx="12" fill="${bgColor}"/>`,
    innerElements,
    slotLabel,
    `</svg>`,
  ].join('');
}

export function svgToDataUrl(svg: string): string {
  // Official SD SDK pattern: data:image/svg+xml,{encodeURIComponent}
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Check if a label would need Haiku summarization (overflows after heuristic abbreviation). */
export function labelNeedsHaiku(title: string): boolean {
  const { needsHaiku } = abbreviateLabel(title, MAX_TEXT_PX, 20);
  return needsHaiku;
}

/** Max chars that fit on a button (approximate, for Haiku prompt) */
export const BUTTON_MAX_CHARS = Math.floor((MAX_TEXT_PX * MAX_LINES) / (20 * 0.55));

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
