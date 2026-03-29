/**
 * D200H framebuffer renderer — renders AgentDeck 14-key dashboard
 * Screen: 960×540 logical (landscape), fb0: 540×960 with 90° CW rotation
 * Transform: screen(sx,sy) → fb(sy, 959-sx)
 * Layout: 3 rows × 5 cols, row2 col3+4 merged = 14 keys
 */
import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { debug } from '../logger.js';
import type { BridgeEvent } from '../types.js';

const TAG = 'd200h-render';

// Screen dimensions (logical, after rotation)
const SW = 960;
const SH = 540;
// Framebuffer dimensions (physical)
const FBW = 540;
const FBH = 960;
// Double buffer
const FB_SIZE = FBW * FBH * 2 * 4; // 2 pages, BGRA32
const PAGE_SIZE = FBW * FBH * 4;

// Key grid: 3 rows × 5 cols
const COLS = 5;
const ROWS = 3;
const COL_W = Math.floor(SW / COLS); // 192
const ROW_H = Math.floor(SH / ROWS); // 180
const GAP = 3;

const D200H_SERIAL = '0123456789ABCDEF';

// Colors (BGRA format)
const COLOR_BG = [20, 20, 25, 255];        // dark background
const COLOR_IDLE = [60, 50, 40, 255];       // slate
const COLOR_PROCESSING = [160, 80, 20, 255]; // blue (BGRA: high B)
const COLOR_AWAITING = [30, 140, 200, 255]; // amber
const COLOR_ERROR = [40, 40, 180, 255];     // red
const COLOR_TEXT = [220, 220, 220, 255];    // light gray
const COLOR_DIM = [120, 120, 120, 255];     // dim text
const COLOR_ACCENT = [200, 140, 40, 255];   // accent blue
const COLOR_GREEN = [60, 180, 60, 255];     // green
const COLOR_BAR_BG = [50, 50, 55, 255];     // gauge background
const COLOR_BAR_5H = [180, 160, 40, 255];   // 5h gauge color
const COLOR_BAR_7D = [160, 80, 40, 255];    // 7d gauge color

// 3×5 bitmap font — full alphanumeric (lowercase rendered, input lowercased)
const FONT_3X5: Record<string, number[]> = {
  '0': [0b111, 0b101, 0b101, 0b101, 0b111],
  '1': [0b010, 0b110, 0b010, 0b010, 0b111],
  '2': [0b111, 0b001, 0b111, 0b100, 0b111],
  '3': [0b111, 0b001, 0b111, 0b001, 0b111],
  '4': [0b101, 0b101, 0b111, 0b001, 0b001],
  '5': [0b111, 0b100, 0b111, 0b001, 0b111],
  '6': [0b111, 0b100, 0b111, 0b101, 0b111],
  '7': [0b111, 0b001, 0b010, 0b010, 0b010],
  '8': [0b111, 0b101, 0b111, 0b101, 0b111],
  '9': [0b111, 0b101, 0b111, 0b001, 0b111],
  'a': [0b010, 0b101, 0b111, 0b101, 0b101],
  'b': [0b110, 0b101, 0b110, 0b101, 0b110],
  'c': [0b011, 0b100, 0b100, 0b100, 0b011],
  'd': [0b110, 0b101, 0b101, 0b101, 0b110],
  'e': [0b111, 0b100, 0b110, 0b100, 0b111],
  'f': [0b111, 0b100, 0b110, 0b100, 0b100],
  'g': [0b011, 0b100, 0b101, 0b101, 0b011],
  'h': [0b101, 0b101, 0b111, 0b101, 0b101],
  'i': [0b111, 0b010, 0b010, 0b010, 0b111],
  'j': [0b001, 0b001, 0b001, 0b101, 0b010],
  'k': [0b101, 0b110, 0b100, 0b110, 0b101],
  'l': [0b100, 0b100, 0b100, 0b100, 0b111],
  'm': [0b101, 0b111, 0b111, 0b101, 0b101],
  'n': [0b101, 0b111, 0b111, 0b111, 0b101],
  'o': [0b010, 0b101, 0b101, 0b101, 0b010],
  'p': [0b110, 0b101, 0b110, 0b100, 0b100],
  'q': [0b010, 0b101, 0b101, 0b110, 0b011],
  'r': [0b110, 0b101, 0b110, 0b101, 0b101],
  's': [0b011, 0b100, 0b010, 0b001, 0b110],
  't': [0b111, 0b010, 0b010, 0b010, 0b010],
  'u': [0b101, 0b101, 0b101, 0b101, 0b011],
  'v': [0b101, 0b101, 0b101, 0b101, 0b010],
  'w': [0b101, 0b101, 0b111, 0b111, 0b101],
  'x': [0b101, 0b101, 0b010, 0b101, 0b101],
  'y': [0b101, 0b101, 0b010, 0b010, 0b010],
  'z': [0b111, 0b001, 0b010, 0b100, 0b111],
  '%': [0b101, 0b001, 0b010, 0b100, 0b101],
  '.': [0b000, 0b000, 0b000, 0b000, 0b010],
  ',': [0b000, 0b000, 0b000, 0b010, 0b100],
  ':': [0b000, 0b010, 0b000, 0b010, 0b000],
  '-': [0b000, 0b000, 0b111, 0b000, 0b000],
  '_': [0b000, 0b000, 0b000, 0b000, 0b111],
  '/': [0b001, 0b001, 0b010, 0b100, 0b100],
  '$': [0b011, 0b110, 0b010, 0b011, 0b110],
  ' ': [0b000, 0b000, 0b000, 0b000, 0b000],
};

// Key definitions
interface KeyDef {
  id: number;
  col: number;
  row: number;
  colSpan: number;
  label: string;
  type: 'action' | 'info';
}

const KEY_DEFS: KeyDef[] = [
  // Row 0: Mode, Session, Usage, Quick1, Quick2
  { id: 0, col: 0, row: 0, colSpan: 1, label: 'MODE', type: 'action' },
  { id: 1, col: 1, row: 0, colSpan: 1, label: 'SESSION', type: 'info' },
  { id: 2, col: 2, row: 0, colSpan: 1, label: 'USAGE', type: 'info' },
  { id: 3, col: 3, row: 0, colSpan: 1, label: 'QA 1', type: 'action' },
  { id: 4, col: 4, row: 0, colSpan: 1, label: 'QA 2', type: 'action' },
  // Row 1: Quick3, Quick4, Model, 5h Rate, 7d Rate
  { id: 5, col: 0, row: 1, colSpan: 1, label: 'QA 3', type: 'action' },
  { id: 6, col: 1, row: 1, colSpan: 1, label: 'QA 4', type: 'action' },
  { id: 7, col: 2, row: 1, colSpan: 1, label: 'MODEL', type: 'info' },
  { id: 8, col: 3, row: 1, colSpan: 1, label: '5h', type: 'info' },
  { id: 9, col: 4, row: 1, colSpan: 1, label: '7d', type: 'info' },
  // Row 2: Stop, Tokens, Cost, Info (merged 2-wide)
  { id: 10, col: 0, row: 2, colSpan: 1, label: 'STOP', type: 'action' },
  { id: 11, col: 1, row: 2, colSpan: 1, label: 'TOKENS', type: 'info' },
  { id: 12, col: 2, row: 2, colSpan: 1, label: 'COST', type: 'info' },
  { id: 13, col: 3, row: 2, colSpan: 2, label: 'INFO', type: 'info' },
];

/** Cached framebuffer */
let fbBuffer: Buffer | null = null;
let lastRenderHash = '';
const tmpPath = join(tmpdir(), 'd200h_fb.raw');

function setPixel(fb: Buffer, sx: number, sy: number, color: number[]): void {
  // Screen(sx,sy) → fb(sy, 959-sx)
  const fx = sy;
  const fy = 959 - sx;
  if (fx < 0 || fx >= FBW || fy < 0 || fy >= FBH) return;
  const offset = (fy * FBW + fx) * 4;
  fb[offset] = color[0];     // B
  fb[offset + 1] = color[1]; // G
  fb[offset + 2] = color[2]; // R
  fb[offset + 3] = color[3]; // A
}

function fillRect(fb: Buffer, x1: number, y1: number, x2: number, y2: number, color: number[]): void {
  for (let sy = Math.max(0, y1); sy < Math.min(SH, y2); sy++) {
    for (let sx = Math.max(0, x1); sx < Math.min(SW, x2); sx++) {
      setPixel(fb, sx, sy, color);
    }
  }
}

function drawText(fb: Buffer, x: number, y: number, text: string, scale: number, color: number[]): void {
  let cx = x;
  for (const ch of text.toLowerCase()) {
    const glyph = FONT_3X5[ch];
    if (!glyph) { cx += 4 * scale; continue; }
    for (let dy = 0; dy < 5; dy++) {
      for (let dx = 0; dx < 3; dx++) {
        if (glyph[dy] & (1 << (2 - dx))) {
          for (let ssy = 0; ssy < scale; ssy++) {
            for (let ssx = 0; ssx < scale; ssx++) {
              setPixel(fb, cx + dx * scale + ssx, y + dy * scale + ssy, color);
            }
          }
        }
      }
    }
    cx += 4 * scale;
  }
}

function drawTextCentered(fb: Buffer, cx: number, cy: number, text: string, scale: number, color: number[]): void {
  const textW = text.length * 4 * scale;
  const textH = 5 * scale;
  drawText(fb, cx - Math.floor(textW / 2), cy - Math.floor(textH / 2), text, scale, color);
}

function drawGauge(fb: Buffer, x: number, y: number, w: number, h: number, percent: number, barColor: number[]): void {
  fillRect(fb, x, y, x + w, y + h, COLOR_BAR_BG);
  const filled = Math.floor(w * Math.min(100, Math.max(0, percent)) / 100);
  fillRect(fb, x, y, x + filled, y + h, barColor);
}

/** Extract simple state info from a state_update event */
interface DashState {
  state: string;
  projectName: string;
  modelName: string;
  agentType: string;
  mode: string;
  fiveHourPercent: number;
  sevenDayPercent: number;
  totalTokens: number;
  totalCost: number;
  options: string[];
  currentTool: string;
}

function parseState(evt: any): DashState {
  return {
    state: evt?.state ?? 'DISCONNECTED',
    projectName: evt?.projectName ?? '',
    modelName: evt?.modelName ?? '',
    agentType: evt?.agentType ?? 'claude-code',
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
    case 'PROCESSING': return COLOR_PROCESSING;
    case 'AWAITING_PERMISSION': case 'AWAITING_INPUT': case 'AWAITING_PROMPT': return COLOR_AWAITING;
    case 'ERROR': return COLOR_ERROR;
    default: return COLOR_IDLE;
  }
}

/** Render a single key to the framebuffer */
function renderKey(fb: Buffer, key: KeyDef, state: DashState): void {
  const x1 = key.col * COL_W + GAP;
  const y1 = key.row * ROW_H + GAP;
  const x2 = (key.col + key.colSpan) * COL_W - GAP;
  const y2 = (key.row + 1) * ROW_H - GAP;
  const cx = Math.floor((x1 + x2) / 2);
  const cy = Math.floor((y1 + y2) / 2);

  switch (key.id) {
    case 0: // MODE
      fillRect(fb, x1, y1, x2, y2, COLOR_IDLE);
      drawTextCentered(fb, cx, cy - 16, 'mode', 3, COLOR_DIM);
      drawTextCentered(fb, cx, cy + 10, state.mode, 3, COLOR_TEXT);
      break;

    case 1: // SESSION
      fillRect(fb, x1, y1, x2, y2, stateColor(state.state));
      drawTextCentered(fb, cx, cy - 20, state.projectName.slice(0, 10), 3, COLOR_TEXT);
      drawTextCentered(fb, cx, cy + 5, state.state.slice(0, 12).toLowerCase(), 2, COLOR_DIM);
      break;

    case 2: // USAGE
      fillRect(fb, x1, y1, x2, y2, COLOR_IDLE);
      drawTextCentered(fb, cx, cy - 16, 'usage', 3, COLOR_DIM);
      break;

    case 3: case 4: case 5: case 6: { // Quick Actions
      const qaIdx = key.id <= 4 ? key.id - 3 : key.id - 3;
      const label = state.options[qaIdx] ?? '';
      if (label) {
        fillRect(fb, x1, y1, x2, y2, COLOR_ACCENT);
        drawTextCentered(fb, cx, cy, label.slice(0, 10), 3, COLOR_TEXT);
      } else {
        fillRect(fb, x1, y1, x2, y2, COLOR_IDLE);
        drawTextCentered(fb, cx, cy, key.label, 2, COLOR_DIM);
      }
      break;
    }

    case 7: // MODEL
      fillRect(fb, x1, y1, x2, y2, COLOR_IDLE);
      drawTextCentered(fb, cx, cy - 12, 'model', 2, COLOR_DIM);
      drawTextCentered(fb, cx, cy + 8, state.modelName.slice(0, 10), 3, COLOR_TEXT);
      break;

    case 8: // 5h Rate
      fillRect(fb, x1, y1, x2, y2, COLOR_IDLE);
      drawTextCentered(fb, cx, y1 + 20, '5h', 2, COLOR_DIM);
      drawGauge(fb, x1 + 10, cy - 4, x2 - x1 - 20, 12, state.fiveHourPercent, COLOR_BAR_5H);
      drawTextCentered(fb, cx, y2 - 25, `${Math.round(state.fiveHourPercent)}%`, 3, COLOR_TEXT);
      break;

    case 9: // 7d Rate
      fillRect(fb, x1, y1, x2, y2, COLOR_IDLE);
      drawTextCentered(fb, cx, y1 + 20, '7d', 2, COLOR_DIM);
      drawGauge(fb, x1 + 10, cy - 4, x2 - x1 - 20, 12, state.sevenDayPercent, COLOR_BAR_7D);
      drawTextCentered(fb, cx, y2 - 25, `${Math.round(state.sevenDayPercent)}%`, 3, COLOR_TEXT);
      break;

    case 10: // STOP
      fillRect(fb, x1, y1, x2, y2, state.state === 'PROCESSING' ? COLOR_ERROR : COLOR_IDLE);
      drawTextCentered(fb, cx, cy, 'stop', 3, state.state === 'PROCESSING' ? COLOR_TEXT : COLOR_DIM);
      break;

    case 11: // TOKENS
      fillRect(fb, x1, y1, x2, y2, COLOR_IDLE);
      drawTextCentered(fb, cx, cy - 12, 'tokens', 2, COLOR_DIM);
      const tk = state.totalTokens > 1000 ? `${(state.totalTokens / 1000).toFixed(0)}k` : `${state.totalTokens}`;
      drawTextCentered(fb, cx, cy + 10, tk, 3, COLOR_TEXT);
      break;

    case 12: // COST
      fillRect(fb, x1, y1, x2, y2, COLOR_IDLE);
      drawTextCentered(fb, cx, cy - 12, 'cost', 2, COLOR_DIM);
      drawTextCentered(fb, cx, cy + 10, `${state.totalCost.toFixed(2)}`, 3, COLOR_GREEN);
      break;

    case 13: // INFO (merged)
      fillRect(fb, x1, y1, x2, y2, COLOR_IDLE);
      if (state.currentTool) {
        drawTextCentered(fb, cx, cy - 12, 'tool', 2, COLOR_DIM);
        drawTextCentered(fb, cx, cy + 10, state.currentTool.slice(0, 18), 2, COLOR_TEXT);
      } else {
        drawTextCentered(fb, cx, cy - 12, state.agentType, 2, COLOR_DIM);
        drawTextCentered(fb, cx, cy + 10, 'agentdeck', 3, COLOR_ACCENT);
      }
      break;
  }
}

/** Render full dashboard and return raw BGRA framebuffer */
export function renderDashboard(stateEvt: any): Buffer {
  const fb = Buffer.alloc(FB_SIZE, 0);
  const state = parseState(stateEvt);

  // Fill background
  for (let sy = 0; sy < SH; sy++) {
    for (let sx = 0; sx < SW; sx++) {
      setPixel(fb, sx, sy, COLOR_BG);
    }
  }

  // Render all 14 keys
  for (const key of KEY_DEFS) {
    renderKey(fb, key, state);
  }

  return fb;
}

/** Push framebuffer to D200H via ADB */
export function pushToDevice(fb: Buffer): boolean {
  try {
    writeFileSync(tmpPath, fb);
    execSync(`adb -s ${D200H_SERIAL} push ${tmpPath} /tmp/agentdeck.raw`, {
      stdio: 'pipe',
      timeout: 5000,
    });
    execSync(`adb -s ${D200H_SERIAL} shell "cat /tmp/agentdeck.raw > /dev/fb0"`, {
      stdio: 'pipe',
      timeout: 3000,
    });
    return true;
  } catch (err) {
    debug(TAG, `push failed: ${err}`);
    return false;
  }
}

/** Render and push dashboard to D200H */
export function updateD200hDisplay(stateEvt: any): void {
  const hash = JSON.stringify(stateEvt?.state) + JSON.stringify(stateEvt?.fiveHourPercent);
  if (hash === lastRenderHash) return; // skip if unchanged
  lastRenderHash = hash;

  const fb = renderDashboard(stateEvt);
  pushToDevice(fb);
}
