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
    <text x="100" y="18" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" font-weight="bold" fill="#94a3b8">VOICE</text>
    <text x="100" y="55" text-anchor="middle" font-family="Arial,sans-serif" font-size="28" fill="#67e8f9" opacity="0.8">🎙</text>
    <text x="100" y="78" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" fill="#67e8f9" opacity="0.6">Ready</text>
    <rect x="60" y="90" width="80" height="2" rx="1" fill="#67e8f9" opacity="0.2"/>
  `);
}

/** Idle — with transcription, scrollable */
export function renderVoiceIdle(text: string, scrollPx: number, totalWidth: number): string {
  const maxVisible = 180;
  // Scroll progress bar
  const progressW = totalWidth > maxVisible ? (maxVisible / totalWidth) * 180 : 180;
  const progressX = totalWidth > maxVisible ? (scrollPx / totalWidth) * 180 + 10 : 10;

  return svgWrap(`
    <rect width="${W}" height="${H}" fill="#0f172a"/>
    <text x="100" y="18" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" font-weight="bold" fill="#4ade80">✓ SENT</text>
    <clipPath id="tc"><rect x="8" y="28" width="184" height="52"/></clipPath>
    <g clip-path="url(#tc)">
      <text x="${8 - scrollPx}" y="48" font-family="Arial,sans-serif" font-size="13" fill="#e2e8f0">${escapeXml(text)}</text>
      <text x="${8 - scrollPx}" y="68" font-family="Arial,sans-serif" font-size="11" fill="#94a3b8" opacity="0.5"> </text>
    </g>
    <rect x="10" y="88" width="180" height="3" rx="1.5" fill="#1e293b"/>
    <rect x="${progressX}" y="88" width="${Math.max(10, progressW)}" height="3" rx="1.5" fill="#4ade80" opacity="0.5"/>
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

/** Disabled state (not idle) */
export function renderVoiceDisabled(): string {
  return svgWrap(`
    <rect width="${W}" height="${H}" fill="#0f172a"/>
    <text x="100" y="45" text-anchor="middle" font-family="Arial,sans-serif" font-size="22" fill="#475569" opacity="0.5">🎙</text>
    <text x="100" y="70" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" fill="#475569">--</text>
  `);
}

function lerpColor(a: number[], b: number[], t: number): string {
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgb(${r},${g},${bl})`;
}

/** Estimate text width in pixels (approximate for 13px Arial) */
export function estimateTextWidth(text: string, fontSize = 13): number {
  return text.length * fontSize * 0.6;
}
