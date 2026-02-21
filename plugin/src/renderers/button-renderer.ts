import { ButtonConfig } from '../layout-manager.js';

const SIZE = 144; // Stream Deck+ high DPI

export function renderButton(config: ButtonConfig): string {
  const textOpacity = config.enabled ? '1' : '0.4';

  // Badge + title
  const displayTitle = config.badge ? `${config.badge} ${config.title}` : config.title;

  // 2-line layout: title (bold, larger) + subtitle (regular, smaller)
  if (config.subtitle) {
    const mainFontSize = displayTitle.length > 9 ? 20 : 24;
    const subFontSize = 14;
    const titleLines = wrapText(displayTitle, mainFontSize <= 20 ? 13 : 11);
    const subLines = wrapText(config.subtitle, 16);

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

    return svgFrame(config.color, elements.join(''));
  }

  // Single-text layout with adaptive font size
  const fontSize = displayTitle.length > 12 ? 20 : displayTitle.length > 8 ? 24 : 28;
  const maxChars = fontSize <= 20 ? 13 : fontSize <= 24 ? 11 : 9;
  const lines = wrapText(displayTitle, maxChars);
  const lineHeight = fontSize + 8;
  const startY = lines.length === 1 ? 84 : 84 - ((lines.length - 1) * lineHeight) / 2;

  const textElements = lines
    .map(
      (line, i) =>
        `<text x="72" y="${startY + i * lineHeight}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${fontSize}" font-weight="bold" fill="${config.textColor}" opacity="${textOpacity}">${escapeXml(line)}</text>`,
    )
    .join('');

  return svgFrame(config.color, textElements);
}

function svgFrame(bgColor: string, innerElements: string): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
    `<rect width="${SIZE}" height="${SIZE}" rx="12" fill="${bgColor}"/>`,
    innerElements,
    `</svg>`,
  ].join('');
}

export function svgToDataUrl(svg: string): string {
  // Official SD SDK pattern: data:image/svg+xml,{encodeURIComponent}
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function wrapText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length + word.length + (current ? 1 : 0) > maxChars) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
