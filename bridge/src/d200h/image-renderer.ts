/**
 * D200H Image Renderer — Renders AgentDeck state as 196×196 PNG key icons
 * Creates a ZIP (manifest.json + icons/*.png) for SET_BUTTONS HID command.
 *
 * Uses raw PNG generation (no external image libraries) for zero dependencies.
 * Each key is rendered as a solid-color background with a text label.
 */

import { deflateSync } from 'zlib';
import { debug } from '../logger.js';
import { validateZipBoundaries, generateDummyPadding } from './hid-protocol.js';

const TAG = 'd200h-render';

const ICON_SIZE = 196;
const COLS = 5;
const ROWS = 3;

// --- Key definitions (matching existing d200h-renderer.ts layout) ---

interface KeyDef {
  id: number;
  col: number;
  row: number;
  label: string;
  type: 'action' | 'info';
}

const KEY_DEFS: KeyDef[] = [
  { id: 0, col: 0, row: 0, label: 'MODE', type: 'action' },
  { id: 1, col: 1, row: 0, label: 'SESSION', type: 'info' },
  { id: 2, col: 2, row: 0, label: 'USAGE', type: 'info' },
  { id: 3, col: 3, row: 0, label: 'QA 1', type: 'action' },
  { id: 4, col: 4, row: 0, label: 'QA 2', type: 'action' },
  { id: 5, col: 0, row: 1, label: 'QA 3', type: 'action' },
  { id: 6, col: 1, row: 1, label: 'QA 4', type: 'action' },
  { id: 7, col: 2, row: 1, label: 'MODEL', type: 'info' },
  { id: 8, col: 3, row: 1, label: '5H', type: 'info' },
  { id: 9, col: 4, row: 1, label: '7D', type: 'info' },
  { id: 10, col: 0, row: 2, label: 'STOP', type: 'action' },
  { id: 11, col: 1, row: 2, label: 'TOKENS', type: 'info' },
  { id: 12, col: 2, row: 2, label: 'COST', type: 'info' },
  // id 13 = small window slot (3_2), handled separately
];

// --- Colors (RGB) ---

const COLORS: Record<string, number[]> = {
  bg: [20, 20, 25],
  idle: [40, 50, 60],
  processing: [20, 80, 160],
  awaiting: [200, 140, 30],
  error: [180, 40, 40],
  text: [220, 220, 220],
  dim: [120, 120, 120],
  accent: [40, 140, 200],
  green: [60, 180, 60],
  barBg: [50, 50, 55],
  bar5h: [40, 160, 180],
  bar7d: [40, 80, 160],
  stop: [200, 50, 50],
};

// --- State parsing (shared with d200h-renderer.ts) ---

interface DashState {
  state: string;
  projectName: string;
  modelName: string;
  mode: string;
  fiveHourPercent: number;
  sevenDayPercent: number;
  totalTokens: number;
  totalCost: number;
  options: string[];
  currentTool: string;
}

export function parseState(evt: any): DashState {
  return {
    state: evt?.state ?? 'DISCONNECTED',
    projectName: evt?.projectName ?? '',
    modelName: evt?.modelName ?? '',
    mode: evt?.mode ?? 'default',
    fiveHourPercent: evt?.fiveHourPercent ?? 0,
    sevenDayPercent: evt?.sevenDayPercent ?? 0,
    totalTokens: evt?.totalTokens ?? 0,
    totalCost: evt?.totalCost ?? 0,
    options: (evt?.options ?? []).map((o: any) => o?.label ?? o ?? ''),
    currentTool: evt?.currentTool ?? '',
  };
}

function stateColor(state: string): number[] {
  switch (state) {
    case 'PROCESSING': return COLORS.processing;
    case 'AWAITING_PERMISSION': case 'AWAITING_INPUT': case 'AWAITING_PROMPT': return COLORS.awaiting;
    case 'ERROR': return COLORS.error;
    default: return COLORS.idle;
  }
}

// --- Minimal PNG generation (no external deps) ---

function createSolidPng(w: number, h: number, r: number, g: number, b: number): Buffer {
  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Raw image data (filter byte 0 + RGB pixels per row)
  const rowLen = 1 + w * 3;
  const raw = Buffer.alloc(rowLen * h);
  for (let y = 0; y < h; y++) {
    const rowOff = y * rowLen;
    raw[rowOff] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const px = rowOff + 1 + x * 3;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
    }
  }

  const compressed = deflateSync(raw);

  // Build PNG
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks = [
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ];

  return Buffer.concat(chunks);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcData = Buffer.concat([typeBytes, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcData), 0);
  return Buffer.concat([len, typeBytes, data, crc]);
}

// CRC32 lookup table
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c;
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// --- Key icon rendering ---

function renderKeyIcon(key: KeyDef, state: DashState): { png: Buffer; label: string } {
  let bgColor: number[];
  let label = key.label;

  switch (key.id) {
    case 0: // MODE
      bgColor = COLORS.idle;
      label = state.mode.toUpperCase();
      break;
    case 1: // SESSION
      bgColor = stateColor(state.state);
      label = state.projectName.slice(0, 10) || 'SESSION';
      break;
    case 2: // USAGE
      bgColor = COLORS.idle;
      label = 'USAGE';
      break;
    case 3: case 4: case 5: case 6: { // Quick Actions
      const qaIdx = key.id - 3;
      const optLabel = state.options[qaIdx];
      if (optLabel) {
        bgColor = COLORS.accent;
        label = optLabel.slice(0, 12);
      } else {
        bgColor = COLORS.idle;
      }
      break;
    }
    case 7: // MODEL
      bgColor = COLORS.idle;
      label = state.modelName.slice(0, 10) || 'MODEL';
      break;
    case 8: // 5H
      bgColor = COLORS.bar5h;
      label = `5H ${Math.round(state.fiveHourPercent)}%`;
      break;
    case 9: // 7D
      bgColor = COLORS.bar7d;
      label = `7D ${Math.round(state.sevenDayPercent)}%`;
      break;
    case 10: // STOP
      bgColor = state.state === 'PROCESSING' ? COLORS.stop : COLORS.idle;
      label = 'STOP';
      break;
    case 11: // TOKENS
      bgColor = COLORS.idle;
      const tk = state.totalTokens > 1000 ? `${(state.totalTokens / 1000).toFixed(0)}K` : `${state.totalTokens}`;
      label = `TK ${tk}`;
      break;
    case 12: // COST
      bgColor = COLORS.idle;
      label = `$${state.totalCost.toFixed(2)}`;
      break;
    default:
      bgColor = COLORS.idle;
  }

  const [r, g, b] = bgColor;
  const png = createSolidPng(ICON_SIZE, ICON_SIZE, r, g, b);
  return { png, label };
}

// --- ZIP creation (in-memory, no filesystem) ---

/**
 * Create an in-memory ZIP file containing manifest.json + icon PNGs.
 * Uses Store compression (no deflate) for simplicity and speed.
 */
function createZipInMemory(files: Map<string, Buffer>): Buffer {
  const centralDir: Buffer[] = [];
  const localParts: Buffer[] = [];
  let offset = 0;

  for (const [name, data] of files) {
    const nameBytes = Buffer.from(name, 'utf-8');
    const crc = crc32(data);

    // Local file header
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4);  // version needed
    local.writeUInt16LE(0, 6);   // flags
    local.writeUInt16LE(0, 8);   // compression: store
    local.writeUInt16LE(0, 10);  // mod time
    local.writeUInt16LE(0, 12);  // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    nameBytes.copy(local, 30);

    // Central directory header
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0); // signature
    central.writeUInt16LE(20, 4);  // version made by
    central.writeUInt16LE(20, 6);  // version needed
    central.writeUInt16LE(0, 8);   // flags
    central.writeUInt16LE(0, 10);  // compression: store
    central.writeUInt16LE(0, 12);  // mod time
    central.writeUInt16LE(0, 14);  // mod date
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra field
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    nameBytes.copy(central, 46);

    localParts.push(local, data);
    centralDir.push(central);
    offset += local.length + data.length;
  }

  // End of central directory
  const centralDirData = Buffer.concat(centralDir);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4);  // disk number
  eocd.writeUInt16LE(0, 6);  // central dir start disk
  eocd.writeUInt16LE(files.size, 8);   // entries on this disk
  eocd.writeUInt16LE(files.size, 10);  // total entries
  eocd.writeUInt32LE(centralDirData.length, 12); // central dir size
  eocd.writeUInt32LE(offset, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralDirData, eocd]);
}

// --- Public API ---

/**
 * Render the full AgentDeck dashboard as a ZIP ready for SET_BUTTONS.
 * Returns a validated ZIP buffer (boundary bytes checked and fixed).
 */
export function renderDashboardZip(stateEvt: any): Buffer {
  const state = parseState(stateEvt);

  // Build manifest and icons
  const manifest: Record<string, any> = {};
  const files = new Map<string, Buffer>();

  for (const key of KEY_DEFS) {
    const { png, label } = renderKeyIcon(key, state);
    const iconPath = `icons/btn${key.id}.png`;
    const colRow = `${key.col}_${key.row}`;

    manifest[colRow] = {
      State: 0,
      ViewParam: [{ Text: label, Icon: iconPath }],
    };

    files.set(iconPath, png);
  }

  // Small window slot (3_2) — show status info
  manifest['3_2'] = {
    Action: 'com.ulanzi.ulanzideck.smallwindow.window',
    ActionParam: {},
    State: 0,
    ViewParam: [{ Text: state.state }],
  };

  files.set('manifest.json', Buffer.from(JSON.stringify(manifest), 'utf-8'));

  // Try creating ZIP with boundary validation
  let dummyPadding = '';
  for (let attempt = 0; attempt < 20; attempt++) {
    if (attempt > 0) {
      dummyPadding = generateDummyPadding(attempt);
    }
    if (dummyPadding) {
      files.set('dummy.txt', Buffer.from(dummyPadding, 'utf-8'));
    }

    const zip = createZipInMemory(files);

    if (validateZipBoundaries(zip)) {
      return zip;
    }

    debug(TAG, `ZIP boundary invalid at attempt ${attempt}, retrying...`);
  }

  // Fallback: return anyway (may cause parsing issues on device)
  debug(TAG, 'WARNING: ZIP boundary validation failed after 20 attempts');
  return createZipInMemory(files);
}

/**
 * Create a simple hash of the visual state for change detection.
 */
export function stateHash(stateEvt: any): string {
  const s = parseState(stateEvt);
  return `${s.state}|${s.mode}|${s.projectName}|${s.modelName}|${s.fiveHourPercent}|${s.sevenDayPercent}|${s.totalTokens}|${s.totalCost}|${s.options.join(',')}|${s.currentTool}`;
}
