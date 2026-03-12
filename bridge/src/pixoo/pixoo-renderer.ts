/**
 * Pixoo64 Frame Renderer — composites 64×64 RGB frames from AgentDeck state.
 *
 * Layout (Y coordinates):
 *   0-7    Water surface + wave
 *   8-40   Terrarium (water body, creatures, seaweed, bubbles)
 *  41-43   Sand/gravel
 *  44      Separator line
 *  45-51   Status bar: state label + rate limit gauge
 *  52-58   Info bar: model | tokens/cost
 *  59-63   Bottom bar: tool name or uptime
 */

import { State } from '../types.js';
import type { StateUpdateEvent, UsageEvent } from '../types.js';
import type { SessionInfo } from '@agentdeck/shared/protocol';
import { drawText, drawTextCentered, measureText } from './pixoo-font.js';
import {
  COLORS, setPixel, fillRect,
  drawOctopus, drawCrayfish, drawTetra,
} from './pixoo-sprites.js';

// ===== Layout Constants =====
const W = 64;
const WATER_TOP = 0;
const WATER_BOTTOM = 40;
const SAND_TOP = 41;
const SAND_BOTTOM = 43;
const SEP_Y = 44;
const STATUS_Y = 45;
const INFO_Y = 52;
const BOTTOM_Y = 59;

// Cached static background (water + sand + seaweed + rocks)
let cachedBg: Uint8Array | null = null;

/** Create a fresh 64×64 RGB buffer. */
export function createFrame(): Uint8Array {
  return new Uint8Array(W * W * 3);
}

/** Copy the static terrarium background into a frame buffer. */
function blitBackground(buf: Uint8Array): void {
  if (!cachedBg) {
    cachedBg = createFrame();
    drawTerrariumBg(cachedBg);
  }
  buf.set(cachedBg);
}

// ===== Background Rendering =====

function drawTerrariumBg(buf: Uint8Array): void {
  // Water gradient (top to bottom)
  for (let y = WATER_TOP; y <= WATER_BOTTOM; y++) {
    const t = y / WATER_BOTTOM;
    const r = Math.round(COLORS.waterLight[0] * (1 - t) + COLORS.water[0] * t);
    const g = Math.round(COLORS.waterLight[1] * (1 - t) + COLORS.water[1] * t);
    const b = Math.round(COLORS.waterLight[2] * (1 - t) + COLORS.water[2] * t);
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 3;
      buf[idx] = r;
      buf[idx + 1] = g;
      buf[idx + 2] = b;
    }
  }

  // Sand/gravel
  for (let y = SAND_TOP; y <= SAND_BOTTOM; y++) {
    for (let x = 0; x < W; x++) {
      const color = (x + y) % 7 === 0 ? COLORS.sandLight : COLORS.sand;
      setPixel(buf, x, y, color);
    }
  }

  // Seaweed (left and right edges)
  drawSeaweed(buf, 3, SAND_TOP, 8);
  drawSeaweed(buf, 5, SAND_TOP, 6);
  drawSeaweed(buf, 58, SAND_TOP, 9);
  drawSeaweed(buf, 60, SAND_TOP, 7);

  // Small rocks
  setPixel(buf, 12, SAND_TOP, COLORS.rock);
  setPixel(buf, 13, SAND_TOP, COLORS.rock);
  setPixel(buf, 50, SAND_TOP, COLORS.rock);
  setPixel(buf, 51, SAND_TOP, COLORS.rock);
  setPixel(buf, 52, SAND_TOP, COLORS.rock);

  // Info area background (below sand)
  for (let y = SEP_Y; y < W; y++) {
    for (let x = 0; x < W; x++) {
      setPixel(buf, x, y, COLORS.black);
    }
  }

  // Separator line
  for (let x = 0; x < W; x++) {
    setPixel(buf, x, SEP_Y, COLORS.gaugeEmpty);
  }
}

function drawSeaweed(buf: Uint8Array, x: number, bottomY: number, height: number): void {
  for (let i = 0; i < height; i++) {
    const wobble = (i % 3 === 1) ? 1 : 0;
    const color = i % 2 === 0 ? COLORS.seaweed : COLORS.seaweedDark;
    setPixel(buf, x + wobble, bottomY - i, color);
  }
}

// ===== State-Dependent Rendering =====

/** Map AgentDeck State to creature visual state. */
function creatureState(state: State): 'idle' | 'working' | 'sleeping' | 'asking' {
  switch (state) {
    case State.IDLE: return 'idle';
    case State.PROCESSING: return 'working';
    case State.AWAITING_OPTION:
    case State.AWAITING_PERMISSION:
    case State.AWAITING_DIFF:
      return 'asking';
    default: return 'idle';
  }
}

/** Get state display color. */
function stateColor(state: State): readonly [number, number, number] {
  switch (state) {
    case State.IDLE: return COLORS.stateIdle;
    case State.PROCESSING: return COLORS.stateProcessing;
    case State.AWAITING_OPTION:
    case State.AWAITING_PERMISSION:
    case State.AWAITING_DIFF:
      return COLORS.stateAwaiting;
    default: return COLORS.textDim;
  }
}

/** Abbreviate state name for 3×5 font. */
function stateLabel(state: State): string {
  switch (state) {
    case State.IDLE: return 'IDLE';
    case State.PROCESSING: return 'PROC';
    case State.AWAITING_OPTION: return 'INPUT';
    case State.AWAITING_PERMISSION: return 'PERM';
    case State.AWAITING_DIFF: return 'DIFF';
    default: return 'INIT';
  }
}

/** Abbreviate model name (e.g., "opus-4" → "OP4", "sonnet-4" → "SN4"). */
function shortModel(name?: string): string {
  if (!name) return '---';
  const lower = name.toLowerCase();
  if (lower.includes('opus')) return 'OP4';
  if (lower.includes('sonnet')) return 'SN4';
  if (lower.includes('haiku')) return 'HK4';
  // Truncate to ~6 chars
  return name.slice(0, 6).toUpperCase();
}

/** Draw a horizontal gauge bar. */
function drawGauge(
  buf: Uint8Array, x: number, y: number, width: number, pct: number,
  filledColor: readonly [number, number, number] = COLORS.gaugeFilled,
  emptyColor: readonly [number, number, number] = COLORS.gaugeEmpty
): void {
  const filled = Math.round(width * Math.min(1, Math.max(0, pct / 100)));
  for (let i = 0; i < width; i++) {
    const color = i < filled ? filledColor : emptyColor;
    setPixel(buf, x + i, y, color);
    setPixel(buf, x + i, y + 1, color);
  }
}

/** Draw wave surface effect. */
function drawWave(buf: Uint8Array, animFrame: number): void {
  const y = WATER_TOP;
  for (let x = 0; x < W; x++) {
    const wave = Math.sin(x * 0.3 + animFrame * 0.15);
    if (wave > 0.5) {
      setPixel(buf, x, y, COLORS.waterLight);
    }
  }
}

/** Draw bubbles rising in the water. */
function drawBubbles(buf: Uint8Array, animFrame: number): void {
  // 3 bubble columns with different phases
  const bubbleCols = [15, 35, 48];
  for (let i = 0; i < bubbleCols.length; i++) {
    const phase = animFrame * 0.4 + i * 7;
    const by = WATER_BOTTOM - (phase % (WATER_BOTTOM - WATER_TOP - 4));
    if (by > WATER_TOP + 2) {
      setPixel(buf, bubbleCols[i], Math.round(by), COLORS.bubble);
    }
  }
}

// ===== Tetra School =====

interface TetraState {
  x: number;
  y: number;
  heading: number; // +1 right, -1 left
  speed: number;
  phase: number;
}

const NUM_TETRAS = 6;
let tetras: TetraState[] | null = null;

function initTetras(): TetraState[] {
  const result: TetraState[] = [];
  for (let i = 0; i < NUM_TETRAS; i++) {
    result.push({
      x: 15 + Math.random() * 34,
      y: 10 + Math.random() * 25,
      heading: Math.random() > 0.5 ? 1 : -1,
      speed: 0.3 + Math.random() * 0.3,
      phase: Math.random() * Math.PI * 2,
    });
  }
  return result;
}

function updateTetras(frame: number): void {
  if (!tetras) tetras = initTetras();

  for (const t of tetras) {
    // Simple movement with boundary bounce
    t.x += t.heading * t.speed;
    t.y += Math.sin(frame * 0.1 + t.phase) * 0.15;

    if (t.x < 10 || t.x > 54) {
      t.heading *= -1;
      t.x = Math.max(10, Math.min(54, t.x));
    }
    if (t.y < 8 || t.y > 36) {
      t.y = Math.max(8, Math.min(36, t.y));
    }
  }
}

// ===== Main Render Entry =====

/** Current animation frame counter. */
let animFrame = 0;

/**
 * Render a complete 64×64 frame from current AgentDeck state.
 * Returns a 12,288-byte RGB buffer ready for pushFrame().
 */
export function renderFrame(
  stateEvent: StateUpdateEvent | null,
  usageEvent: UsageEvent | null,
  sessions: SessionInfo[] | null,
): Uint8Array {
  const buf = createFrame();
  animFrame++;

  // 1. Static background (cached)
  blitBackground(buf);

  // 2. Animated water surface + bubbles
  drawWave(buf, animFrame);
  drawBubbles(buf, animFrame);

  const state = stateEvent?.state ?? State.IDLE;
  const cState = creatureState(state);

  // 3. Tetras
  updateTetras(animFrame);
  if (tetras) {
    for (const t of tetras) {
      drawTetra(buf, Math.round(t.x), Math.round(t.y), t.heading);
    }
  }

  // 4. Octopus (centered in terrarium)
  const sessionCount = sessions?.filter(s => s.alive && s.agentType).length ?? 1;
  const octopusX = sessionCount > 1 ? 22 : 28;
  drawOctopus(buf, octopusX, 18, cState, animFrame);

  // Second octopus if multi-session
  if (sessionCount > 1) {
    drawOctopus(buf, 36, 20, 'idle', animFrame);
  }

  // 5. Crayfish (if gateway available)
  if (stateEvent?.gatewayAvailable) {
    const routing = sessions?.some(s =>
      s.agentType === 'openclaw' && s.state === 'processing'
    ) ?? false;
    drawCrayfish(buf, 48, 28, routing, animFrame);
  }

  // 6. Status bar (y=45-51)
  const sColor = stateColor(state);
  const sLabel = stateLabel(state);
  drawText(buf, 1, STATUS_Y + 1, sLabel, rgbToHex(sColor));

  // Rate limit gauge
  const pct5h = usageEvent?.fiveHourPercent ?? 0;
  const gaugeX = measureText(sLabel) + 3;
  drawGauge(buf, gaugeX, STATUS_Y + 1, 20, pct5h);

  // Percentage text after gauge
  const pctText = `${Math.round(pct5h)}%`;
  drawText(buf, gaugeX + 22, STATUS_Y + 1, pctText, rgbToHex(COLORS.textDim));

  // 7. Info bar (y=52-58)
  const model = shortModel(stateEvent?.modelName);
  drawText(buf, 1, INFO_Y + 1, model, rgbToHex(COLORS.textBright));

  if (usageEvent) {
    const tokens = formatTokens(
      (usageEvent.inputTokens ?? 0) + (usageEvent.outputTokens ?? 0)
    );
    drawText(buf, 30, INFO_Y + 1, tokens, rgbToHex(COLORS.textDim));

    if (usageEvent.estimatedCostUsd !== undefined) {
      const cost = `$${usageEvent.estimatedCostUsd.toFixed(1)}`;
      const costX = W - measureText(cost) - 1;
      drawText(buf, costX, INFO_Y + 1, cost, rgbToHex(COLORS.textDim));
    }
  }

  // 8. Bottom bar (y=59-63): current tool or project name
  const bottomText = stateEvent?.currentTool
    ? stateEvent.currentTool.slice(0, 14)
    : stateEvent?.projectName?.slice(0, 14) ?? '';
  if (bottomText) {
    drawTextCentered(buf, BOTTOM_Y + 1, bottomText, rgbToHex(COLORS.textDim));
  }

  return buf;
}

/**
 * Render IDLE breathing animation frames (uploaded as GIF, device loops internally).
 * Returns 4 frames for a subtle breathing cycle.
 */
export function renderIdleAnimation(
  stateEvent: StateUpdateEvent | null,
  usageEvent: UsageEvent | null,
  sessions: SessionInfo[] | null,
): Uint8Array[] {
  const frames: Uint8Array[] = [];
  // Save and restore animFrame so idle loop has consistent base
  const savedFrame = animFrame;

  for (let i = 0; i < 4; i++) {
    animFrame = savedFrame + i * 3; // spread frames for visible movement
    frames.push(renderFrame(stateEvent, usageEvent, sessions));
  }

  animFrame = savedFrame + 12;
  return frames;
}

// ===== Utility =====

function rgbToHex(rgb: readonly [number, number, number]): string {
  return '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(0)}K`;
  return String(count);
}
