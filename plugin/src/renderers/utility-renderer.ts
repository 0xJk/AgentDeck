/**
 * SVG pixmap renderers for the Utility Dial.
 * Follows Voice Dial design pattern: #0f172a bg, header, centered content, accent bar.
 */

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

function svgWrap(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${inner}</svg>`;
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + '\u2026' : str;
}

export interface UtilityRenderData {
  title: string;
  icon?: string;
  value?: string;
  indicator: { value: number; bar_fill_c: string };
  dots: string;
  // Media-specific
  state?: string;
  track?: string;
  artist?: string;
}

/** Setup required state for E1 utility dial */
export function renderSetupUtility(): string {
  const accent = '#818cf8';
  return svgWrap(`
    <rect width="${W}" height="${H}" fill="#0f172a"/>
    <text x="100" y="18" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="bold" fill="${accent}">SETUP</text>
    <text x="82" y="58" text-anchor="middle" font-family="Arial,sans-serif" font-size="22" fill="${accent}" opacity="0.7">\u2699\uFE0F</text>
    <text x="120" y="58" font-family="Arial,sans-serif" font-size="18" font-weight="bold" fill="${accent}" opacity="0.6">Open PI</text>
    <rect x="10" y="90" width="180" height="2" rx="1" fill="${accent}" opacity="0.2"/>
  `);
}

/** Generic utility mode (volume, mic, timer, brightness, darkmode) */
export function renderUtilityGeneric(data: UtilityRenderData): string {
  const { title, icon, value, indicator, dots } = data;
  const barColor = indicator.bar_fill_c || '#22c55e';
  const barW = Math.round((180 * indicator.value) / 100);
  const multiMode = dots.length > 1;
  const valueY = multiMode ? 56 : 62;
  const valStr = value || '--';

  // Text-only values (Muted, Dark, Light) use smaller font — icon conveys state
  const isNumeric = /\d/.test(valStr);
  const valFontSize = isNumeric ? 24 : 18;
  const charPx = Math.round(valFontSize * 0.55);

  let valueSvg: string;
  if (icon) {
    // Center icon+value as a group: estimate widths, compute offset
    const iconPx = 20;                       // emoji ≈ 1em at 20px
    const gap = 4;
    const valPx = valStr.length * charPx;
    const groupX = Math.round(100 - (iconPx + gap + valPx) / 2);
    const iconX = groupX + 10;               // center of icon slot
    const valueX = groupX + iconPx + gap;    // start of value text
    valueSvg = `<text x="${iconX}" y="${valueY}" text-anchor="middle" font-family="Arial,sans-serif" font-size="20" fill="${barColor}" opacity="0.7">${icon}</text>`
      + `<text x="${valueX}" y="${valueY}" font-family="Arial,sans-serif" font-size="${valFontSize}" font-weight="bold" fill="${barColor}" opacity="0.9">${escapeXml(valStr)}</text>`;
  } else {
    valueSvg = `<text x="100" y="${valueY}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${valFontSize}" font-weight="bold" fill="${barColor}" opacity="0.9">${escapeXml(valStr)}</text>`;
  }

  return svgWrap(`
    <rect width="${W}" height="${H}" fill="#0f172a"/>
    <text x="100" y="18" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="bold" fill="#94a3b8">${escapeXml(title)}</text>
    ${valueSvg}
    ${multiMode ? `<text x="100" y="76" text-anchor="middle" font-family="Arial,sans-serif" font-size="10" fill="#475569" letter-spacing="2">${escapeXml(dots)}</text>` : ''}
    <rect x="10" y="90" width="180" height="2" rx="1" fill="#1e293b"/>
    <rect x="10" y="90" width="${Math.max(2, barW)}" height="2" rx="1" fill="${barColor}" opacity="0.4"/>
  `);
}

/** Media mode with track/artist */
export function renderUtilityMedia(data: UtilityRenderData): string {
  const { title, icon, track, artist, indicator, dots } = data;
  const barColor = indicator.bar_fill_c || '#a855f7';
  const barW = Math.round((180 * indicator.value) / 100);
  const playing = icon === '\u25B6';
  const multiMode = dots.length > 1;

  const headerColor = playing ? '#a855f7' : '#94a3b8';
  const displayTrack = track ? escapeXml(truncate(track, 18)) : 'No track';
  const displayArtist = artist ? escapeXml(truncate(artist, 26)) : '';

  // Icon + track centered as group (same pattern as generic icon+value)
  let trackSvg: string;
  if (icon) {
    const iconPx = 14;
    const gap = 3;
    const trackPx = displayTrack.length * 9;  // ~0.55em per char at 16px
    const groupX = Math.round(100 - (iconPx + gap + trackPx) / 2);
    const iconX = groupX + 7;
    const trackX = groupX + iconPx + gap;
    trackSvg = `<text x="${iconX}" y="48" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" fill="${headerColor}" opacity="0.8">${icon}</text>`
      + `<text x="${trackX}" y="48" font-family="Arial,sans-serif" font-size="16" font-weight="bold" fill="#e2e8f0">${displayTrack}</text>`;
  } else {
    trackSvg = `<text x="100" y="48" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" font-weight="bold" fill="#e2e8f0">${displayTrack}</text>`;
  }

  return svgWrap(`
    <rect width="${W}" height="${H}" fill="#0f172a"/>
    <text x="100" y="18" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="bold" fill="${headerColor}">${escapeXml(title || 'MEDIA')}</text>
    ${trackSvg}
    <text x="100" y="66" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" fill="#94a3b8">${displayArtist}</text>
    ${multiMode ? `<text x="100" y="82" text-anchor="middle" font-family="Arial,sans-serif" font-size="10" fill="#475569" letter-spacing="2">${escapeXml(dots)}</text>` : ''}
    <rect x="10" y="90" width="180" height="2" rx="1" fill="#1e293b"/>
    <rect x="10" y="90" width="${Math.max(2, barW)}" height="2" rx="1" fill="${barColor}" opacity="0.4"/>
  `);
}
