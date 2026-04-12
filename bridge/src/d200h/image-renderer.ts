/**
 * D200H Image Renderer — Renders AgentDeck state as 196×196 PNG key icons
 * using the shared SVG renderers (same visual output as Stream Deck plugin).
 *
 * Pipeline: state → shared SVG generators (144×144) → resvg rasterize (196×196 PNG) → ZIP
 *
 * Falls back to solid-color PNGs if resvg-js is not available.
 */

import { deflateSync } from 'zlib';
import {
  renderSessionSlot,
  renderEmptySlot,
  renderBackButton,
  renderEscButton,
  renderStopButton,
  renderOptionButton,
  renderDetailInfo,
  svgFrame,
  stateColor,
} from '@agentdeck/shared';
import type { SessionInfo, PromptOption } from '@agentdeck/shared';
import { State } from '@agentdeck/shared';
import { debug } from '../logger.js';
import { validateZipBoundaries } from './hid-protocol.js';

const TAG = 'd200h-render';

const ICON_SIZE = 196;

// --- resvg-js loader (optional dependency) ---

type ResvgClass = new (svg: string, opts?: any) => { render(): { asPng(): Uint8Array } };
let Resvg: ResvgClass | null = null;
let resvgLoaded = false;

async function loadResvg(): Promise<ResvgClass | null> {
  if (resvgLoaded) return Resvg;
  resvgLoaded = true;
  try {
    const mod = await import('@resvg/resvg-js');
    Resvg = (mod as any).Resvg ?? (mod as any).default?.Resvg;
    debug(TAG, 'resvg-js loaded — SVG rendering enabled');
    return Resvg;
  } catch {
    debug(TAG, 'resvg-js not available — falling back to solid-color PNGs');
    return null;
  }
}

/** Initialize the renderer (call once at module start). */
export async function initRenderer(): Promise<void> {
  await loadResvg();
}

// --- SVG → 196×196 PNG rasterization ---

function svgToPng(svg144: string): Buffer {
  if (!Resvg) return fallbackSolidPng(20, 20, 25); // dark fallback

  // Wrap 144×144 SVG content into 196×196 viewport with auto-scaling
  const inner = svg144.replace(/<\/?svg[^>]*>/g, '');
  const wrapped = `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_SIZE}" height="${ICON_SIZE}" viewBox="0 0 144 144">${inner}</svg>`;

  try {
    const resvg = new Resvg(wrapped, {
      fitTo: { mode: 'width' as const, value: ICON_SIZE },
      font: { loadSystemFonts: false },
    });
    return Buffer.from(resvg.render().asPng());
  } catch (err) {
    debug(TAG, `SVG rasterization failed: ${err}`);
    return fallbackSolidPng(20, 20, 25);
  }
}

/** Rasterize custom-sized SVG (e.g. 288×144 → 392×196 for merged slot). */
function svgToPngWide(svg: string, width: number, height: number): Buffer {
  if (!Resvg) return fallbackSolidPng(20, 20, 25);

  try {
    const resvg = new Resvg(svg, {
      fitTo: { mode: 'width' as const, value: width },
      font: { loadSystemFonts: false },
    });
    return Buffer.from(resvg.render().asPng());
  } catch (err) {
    debug(TAG, `Wide SVG rasterization failed: ${err}`);
    return fallbackSolidPng(20, 20, 25);
  }
}

// --- Layout: Key definitions ---

// The D200H has 14 physical keys (5×3 grid, slot 13 is 2-col merged at col3+col4, row2)
// In single-session bridge mode, we show one session with its details/options.

interface KeySlot {
  col: number;
  row: number;
  svg: string;
  label: string;
}

// --- State parsing ---

export interface DashState {
  state: string;
  projectName: string;
  modelName: string;
  mode: string;
  agentType: string;
  fiveHourPercent: number;
  sevenDayPercent: number;
  totalTokens: number;
  totalCost: number;
  options: PromptOption[];
  currentTool: string;
  allSessions: SessionInfo[];
}

export function parseState(evt: any): DashState {
  return {
    state: evt?.state ?? 'DISCONNECTED',
    projectName: evt?.projectName ?? '',
    modelName: evt?.modelName ?? '',
    mode: evt?.mode ?? 'default',
    agentType: evt?.agentType ?? 'claude-code',
    fiveHourPercent: evt?.fiveHourPercent ?? 0,
    sevenDayPercent: evt?.sevenDayPercent ?? 0,
    totalTokens: evt?.totalTokens ?? 0,
    totalCost: evt?.totalCost ?? 0,
    options: (evt?.options ?? []).map((o: any) =>
      typeof o === 'string' ? { label: o } : { label: o?.label ?? '', shortcut: o?.shortcut ?? '' }
    ),
    currentTool: evt?.currentTool ?? '',
    allSessions: Array.isArray(evt?.allSessions) ? evt.allSessions : [],
  };
}

// --- SVG helpers for info/usage buttons ---

function escXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function gaugeBar(pct: number, width = 8): string {
  const filled = Math.round(Math.min(pct, 100) / 100 * width);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled);
}

function gaugeColor(pct: number): string {
  return pct > 80 ? '#ef4444' : pct > 50 ? '#eab308' : '#22c55e';
}

function renderUsageButton(label: string, percent: number, color: string): string {
  const pctColor = gaugeColor(percent);
  const gBar = gaugeBar(percent, 8);
  const elements = [
    // Header label
    `<text x="72" y="36" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" fill="#94a3b8">${escXml(label)}</text>`,
    // Unicode gauge bar
    `<text x="72" y="60" text-anchor="middle" font-family="monospace" font-size="14" fill="${color}">${escXml(gBar)}</text>`,
    // Percentage (larger, 28px bold)
    `<text x="72" y="90" text-anchor="middle" font-family="Arial,sans-serif" font-size="28" font-weight="bold" fill="#ffffff">${Math.round(percent)}%</text>`,
    // Bottom accent bar (2px)
    `<rect x="16" y="110" width="112" height="2" rx="1" fill="#1e293b"/>`,
    `<rect x="16" y="110" width="${Math.round(112 * Math.min(percent, 100) / 100)}" height="2" rx="1" fill="${color}"/>`,
  ].join('');
  return svgFrame('#0f172a', elements);
}

/** Wide merged slot (3_2) — 288×144 SVG (viewBox) → 392×196 PNG. StreamDeck overview style: 5H | 7D side-by-side. */
function renderUsageWideSlot(fiveHourPct: number, sevenDayPct: number): string {
  const c5 = gaugeColor(fiveHourPct);
  const c7 = gaugeColor(sevenDayPct);
  const g5 = gaugeBar(fiveHourPct, 10);
  const g7 = gaugeBar(sevenDayPct, 10);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="288" height="144" viewBox="0 0 288 144">
    <defs>
      <linearGradient id="usage-wide-bg" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" style="stop-color:#0f172a"/>
        <stop offset="100%" style="stop-color:#06091a"/>
      </linearGradient>
    </defs>
    <!-- Background -->
    <rect width="288" height="144" rx="12" fill="url(#usage-wide-bg)"/>
    <!-- Inner panel -->
    <rect x="8" y="8" width="272" height="128" rx="8" fill="#1e293b" opacity="0.4"/>
    <!-- Header: USAGE centered -->
    <text x="144" y="26" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="bold" fill="#94a3b8">USAGE</text>
    <!-- Vertical divider at x=144 -->
    <line x1="144" y1="35" x2="144" y2="120" stroke="#334155" stroke-width="1" opacity="0.5"/>
    <!-- Left half: 5H -->
    <text x="50" y="50" font-family="Arial,sans-serif" font-size="11" fill="#94a3b8">5H</text>
    <text x="80" y="62" font-family="monospace" font-size="13" fill="${c5}">${escXml(g5)}</text>
    <text x="80" y="90" text-anchor="middle" font-family="Arial,sans-serif" font-size="24" font-weight="bold" fill="#ffffff">${Math.round(fiveHourPct)}%</text>
    <!-- Right half: 7D -->
    <text x="208" y="50" font-family="Arial,sans-serif" font-size="11" fill="#94a3b8">7D</text>
    <text x="208" y="62" font-family="monospace" font-size="13" fill="${c7}">${escXml(g7)}</text>
    <text x="208" y="90" text-anchor="middle" font-family="Arial,sans-serif" font-size="24" font-weight="bold" fill="#ffffff">${Math.round(sevenDayPct)}%</text>
    <!-- Bottom accent bar (split): 5H on left, 7D on right -->
    <rect x="12" y="128" width="280" height="2" rx="1" fill="#1e293b"/>
    <rect x="12" y="128" width="${Math.round(140 * Math.min(fiveHourPct, 100) / 100)}" height="2" rx="1" fill="${c5}"/>
    <rect x="152" y="128" width="${Math.round(140 * Math.min(sevenDayPct, 100) / 100)}" height="2" rx="1" fill="${c7}"/>
  </svg>`;
}

function renderInfoButton(title: string, value: string, titleColor = '#94a3b8', valueColor = '#ffffff'): string {
  const valueFontSize = value.length > 8 ? 16 : value.length > 5 ? 20 : 24;
  const elements = [
    `<text x="72" y="52" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="bold" fill="${titleColor}">${escXml(title)}</text>`,
    `<text x="72" y="${86 + (valueFontSize < 20 ? 2 : 0)}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${valueFontSize}" font-weight="bold" fill="${valueColor}">${escXml(value)}</text>`,
  ].join('');
  return svgFrame('#1C1C1E', elements);
}

function renderModeButton(mode: string): string {
  const elements = [
    `<text x="72" y="52" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="bold" fill="#94a3b8">MODE</text>`,
    `<text x="72" y="88" text-anchor="middle" font-family="Arial,sans-serif" font-size="18" font-weight="bold" fill="#a78bfa">${escXml(mode.toUpperCase())}</text>`,
  ].join('');
  return svgFrame('#1C1C1E', elements);
}

/** Renders a uniform "dimmed" offline placeholder for a single key slot. */
function renderOfflineSlot(hero = false): string {
  if (hero) {
    // Central hero card: large OFFLINE + DAEMON STOPPED
    const elements = [
      `<text x="72" y="54" text-anchor="middle" font-family="Arial,sans-serif" font-size="28" font-weight="bold" fill="#4b5563">OFFLINE</text>`,
      `<text x="72" y="82" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" fill="#374151">DAEMON STOPPED</text>`,
    ].join('');
    return svgFrame('#0f0f0f', elements);
  }
  // Regular key: uniform dark dim
  return svgFrame('#0a0a0a', `<text x="72" y="80" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" fill="#1f2937">--</text>`);
}

// --- Main layout computation ---

function computeLayout(state: DashState): KeySlot[] {
  // ============================
  // DISCONNECTED (daemon stopped) — all keys dimmed, hero shows OFFLINE
  // ============================
  const isDisconnected = state.state === 'DISCONNECTED' || state.state === 'disconnected';
  if (isDisconnected) {
    const slots: KeySlot[] = [];
    // 5×3 grid: position the hero card at col1+col2, row0+row1 (wide center)
    const heroCol = 2, heroRow = 1; // center of the grid
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 5; col++) {
        const isHero = col === heroCol && row === heroRow;
        slots.push({ col, row, svg: renderOfflineSlot(isHero), label: '' });
      }
    }
    return slots;
  }

  const slots: KeySlot[] = [];
  const isAwaiting = state.state.startsWith('AWAITING') || state.state.startsWith('awaiting');
  const isProcessing = state.state === 'PROCESSING' || state.state === 'processing';

  // Build a SessionInfo-like object for the active (focused) state
  const activeSession: SessionInfo = {
    id: 'local',
    agentType: state.agentType as any,
    projectName: state.projectName,
    modelName: state.modelName,
    state: state.state.toLowerCase(),
    alive: true,
    port: 0,
  };

  const sessionsToDisplay = state.allSessions.length > 0 ? state.allSessions.slice(0, 4) : [activeSession];
  const isMultiSession = sessionsToDisplay.length > 1;

  if (isMultiSession) {
    // ============================
    // MULTI-SESSION OVERVIEW LAYOUT
    // ============================

    // Row 0: Mode, Session 1..4
    slots.push({ col: 0, row: 0, svg: renderModeButton(state.mode), label: '' });
    for (let i = 0; i < 4; i++) {
      const col = i + 1;
      const sess = sessionsToDisplay[i];
      if (sess) {
        const isActive = sess.projectName === activeSession.projectName && sess.agentType === activeSession.agentType;
        slots.push({ col, row: 0, svg: renderSessionSlot(sess, isActive, 0), label: '' });
      } else {
        slots.push({ col, row: 0, svg: renderEmptySlot(), label: '' });
      }
    }

    // Row 1: Options 1..4, Model Info
    for (let i = 0; i < 4; i++) {
      const col = i;
      const opt = state.options[i];
      if (opt && isAwaiting) {
        slots.push({ col, row: 1, svg: renderOptionButton(opt, i), label: '' });
      } else {
        slots.push({ col, row: 1, svg: renderEmptySlot(), label: '' });
      }
    }
    slots.push({ col: 4, row: 1, svg: renderInfoButton('MODEL', state.modelName.slice(0, 12) || 'N/A'), label: '' });
  } else {
    // ============================
    // SINGLE-SESSION DETAIL LAYOUT
    // ============================

    // Row 0: Mode, Hero Session, Extended Detail
    slots.push({ col: 0, row: 0, svg: renderModeButton(state.mode), label: '' });
    slots.push({ col: 1, row: 0, svg: renderSessionSlot(sessionsToDisplay[0], true, 0), label: '' });
    slots.push({ col: 2, row: 0, svg: renderDetailInfo(sessionsToDisplay[0], state.state.toLowerCase() as State, state.currentTool, state.modelName, state.mode), label: '' });

    // Options mapping identically to old 13-slot original design
    // Slots 3_0, 4_0, 0_1, 1_1
    for (let i = 0; i < 4; i++) {
      const col = (i + 3) % 5;
      const row = Math.floor((i + 3) / 5);
      const opt = state.options[i];
      if (opt && isAwaiting) {
        slots.push({ col, row, svg: renderOptionButton(opt, i), label: '' });
      } else {
        slots.push({ col, row, svg: renderEmptySlot(), label: '' });
      }
    }

    // Row 1 remaining stats: 2_1, 3_1, 4_1
    slots.push({ col: 2, row: 1, svg: renderInfoButton('MODEL', state.modelName.slice(0, 12) || 'N/A'), label: '' });
    slots.push({ col: 3, row: 1, svg: renderUsageButton('5H', state.fiveHourPercent, '#28a0b4'), label: '' });
    slots.push({ col: 4, row: 1, svg: renderUsageButton('7D', state.sevenDayPercent, '#2850a0'), label: '' });
  }

  // ============================
  // ROW 2: SHARED ACTIONS (STOP, TOKENS, COST)
  // ============================

  // Slot 0_2: STOP/ESC
  if (isProcessing) {
    slots.push({ col: 0, row: 2, svg: renderStopButton(true), label: '' });
  } else if (isAwaiting) {
    slots.push({ col: 0, row: 2, svg: renderEscButton(true), label: '' });
  } else {
    slots.push({ col: 0, row: 2, svg: renderStopButton(false), label: '' });
  }

  // Slot 1_2: Tokens
  const tk = state.totalTokens > 1000 ? `${(state.totalTokens / 1000).toFixed(0)}K` : `${state.totalTokens}`;
  slots.push({ col: 1, row: 2, svg: renderInfoButton('TOKENS', tk), label: '' });

  // Slot 2_2: Cost
  slots.push({ col: 2, row: 2, svg: renderInfoButton('COST', `$${state.totalCost.toFixed(2)}`), label: '' });

  return slots;
}

// --- ZIP creation (reused from original, with boundary validation) ---

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c;
}

function normalizeExtraLength(length: number): number {
  if (length <= 0) return 0;
  return Math.max(4, length);
}

function makeZipExtraField(length: number): Buffer {
  const normalized = normalizeExtraLength(length);
  if (normalized === 0) return Buffer.alloc(0);
  const extra = Buffer.alloc(normalized, 0x41);
  extra.writeUInt16LE(0x4141, 0);
  extra.writeUInt16LE(Math.max(0, normalized - 4), 2);
  return extra;
}

function firstInvalidZipBoundaryOffset(zipData: Buffer): number | null {
  for (let i = 1016; i < zipData.length; i += 1024) {
    if (zipData[i] === 0x00 || zipData[i] === 0x7c) return i;
  }
  return null;
}

interface ZipLayoutEntry { extraInsertOffset: number; }
interface ZipBuildArtifact { zip: Buffer; layouts: ZipLayoutEntry[]; }

function createZipInMemory(files: Map<string, Buffer>, extraLengths: number[] = []): ZipBuildArtifact {
  const centralDir: Buffer[] = [];
  const localParts: Buffer[] = [];
  const layouts: ZipLayoutEntry[] = [];
  let offset = 0;
  let index = 0;

  for (const [name, data] of files) {
    const nameBytes = Buffer.from(name, 'utf-8');
    const crc = crc32(data);
    const extraLen = normalizeExtraLength(extraLengths[index] ?? 0);
    const extra = makeZipExtraField(extraLen);

    const localExtraOffset = offset + 30 + nameBytes.length;
    const local = Buffer.alloc(30 + nameBytes.length + extra.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(extra.length, 28);
    nameBytes.copy(local, 30);
    extra.copy(local, 30 + nameBytes.length);

    const central = Buffer.alloc(46 + nameBytes.length + extra.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    extra.copy(central, 46 + nameBytes.length);

    localParts.push(local, data);
    centralDir.push(central);
    layouts.push({ extraInsertOffset: localExtraOffset });
    offset += local.length + data.length;
    index += 1;
  }

  const centralDirData = Buffer.concat(centralDir);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.size, 8);
  eocd.writeUInt16LE(files.size, 10);
  eocd.writeUInt32LE(centralDirData.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return { zip: Buffer.concat([...localParts, centralDirData, eocd]), layouts };
}

// --- Fallback solid-color PNG (when resvg-js unavailable) ---

function fallbackSolidPng(r: number, g: number, b: number): Buffer {
  const w = ICON_SIZE, h = ICON_SIZE;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB

  const rowLen = 1 + w * 3;
  const raw = Buffer.alloc(rowLen * h);
  for (let y = 0; y < h; y++) {
    const off = y * rowLen;
    raw[off] = 0;
    for (let x = 0; x < w; x++) {
      const px = off + 1 + x * 3;
      raw[px] = r; raw[px + 1] = g; raw[px + 2] = b;
    }
  }

  const compressed = deflateSync(raw);
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  function pngChunk(type: string, data: Buffer): Buffer {
    const typeBytes = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const crcData = Buffer.concat([typeBytes, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(crcData), 0);
    return Buffer.concat([len, typeBytes, data, crc]);
  }

  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', compressed), pngChunk('IEND', Buffer.alloc(0))]);
}

// --- Public API ---

/**
 * Render the full AgentDeck dashboard as a ZIP ready for SET_BUTTONS.
 * Uses shared SVG renderers → resvg rasterization for SD+-quality output.
 */
export function renderDashboardZip(stateEvt: any): Buffer {
  const state = parseState(stateEvt);
  const layout = computeLayout(state);

  const manifest: Record<string, any> = {};
  const files = new Map<string, Buffer>();

  for (let i = 0; i < layout.length; i++) {
    const slot = layout[i];
    const iconPath = `icons/btn${i}.png`;
    const colRow = `${slot.col}_${slot.row}`;

    const png = svgToPng(slot.svg);
    files.set(iconPath, png);

    manifest[colRow] = {
      State: 0,
      ViewParam: [{ Text: slot.label, Icon: iconPath }],
    };
  }

  // Merged hardware slot (3_2) — 392×196 PNG with StreamDeck-style usage display
  // No Action = device firmware clock overlay suppressed (solves clock overlap)
  const wideUsageSvg = renderUsageWideSlot(state.fiveHourPercent, state.sevenDayPercent);
  const wideUsagePng = svgToPngWide(wideUsageSvg, 392, 196);
  files.set('icons/usage-wide.png', wideUsagePng);
  manifest['3_2'] = {
    State: 0,
    ViewParam: [{ Icon: 'icons/usage-wide.png', Text: '' }],
  };

  files.set('manifest.json', Buffer.from(JSON.stringify(manifest), 'utf-8'));

  // Build ZIP with boundary validation
  const orderedEntries = [...files.entries()];
  const extraLengths = new Array<number>(orderedEntries.length).fill(0);

  for (let attempt = 0; attempt < 256; attempt++) {
    const artifact = createZipInMemory(new Map(orderedEntries), extraLengths);
    const invalidOffset = firstInvalidZipBoundaryOffset(artifact.zip);
    if (invalidOffset == null) return artifact.zip;

    let targetIndex = -1;
    for (let i = artifact.layouts.length - 1; i >= 0; i--) {
      if (artifact.layouts[i].extraInsertOffset <= invalidOffset) {
        targetIndex = i;
        break;
      }
    }
    if (targetIndex < 0) return artifact.zip;

    const currentExtra = extraLengths[targetIndex];
    const extraInsertOffset = artifact.layouts[targetIndex].extraInsertOffset;
    let shift = 1;
    while (shift <= 512) {
      if (invalidOffset < extraInsertOffset + currentExtra + shift) break;
      const candidate = artifact.zip[invalidOffset - shift];
      if (candidate !== 0x00 && candidate !== 0x7c) break;
      shift += 1;
    }
    extraLengths[targetIndex] = normalizeExtraLength(extraLengths[targetIndex] + shift);
    debug(TAG, `ZIP boundary invalid at ${invalidOffset}, shifting entry ${targetIndex} by ${shift} byte(s)`);
  }

  const fallback = createZipInMemory(new Map(orderedEntries), extraLengths).zip;
  debug(TAG, `WARNING: ZIP boundary validation failed after search; stillValid=${validateZipBoundaries(fallback)}`);
  return fallback;
}

/**
 * Create a simple hash of the visual state for change detection.
 */
export function stateHash(stateEvt: any): string {
  const s = parseState(stateEvt);
  const sessIds = s.allSessions.map(sess => sess.id).join(',');
  return `${s.state}|${s.mode}|${s.projectName}|${s.modelName}|${s.fiveHourPercent}|${s.sevenDayPercent}|${s.totalTokens}|${s.totalCost}|${s.options.map(o => o.label).join(',')}|${s.currentTool}|${sessIds}`;
}
