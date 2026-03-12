/**
 * Pixoo64 Creature Sprites — pixel art for 64×64 LED matrix.
 *
 * Octopus: 7×5 grid (14×5 original halved), rendered with PIXEL_ASPECT 2.0 → 7×10px actual.
 * Crayfish: 6×4 simplified front-facing sprite.
 * Tetra: single-pixel fish with directional coloring.
 */

// ===== Cell Types (shared with ESP32/Android) =====
const EMPTY = 0;
const BODY = 1;
const EYE = 2;
const LEFT_ARM = 3;
const RIGHT_ARM = 4;
const LEFT_LEG = 5;
const RIGHT_LEG = 6;

// ===== Octopus 7×5 (downscaled from 14×5, column pairs merged) =====
export const OCTOPUS_GRID: number[][] = [
  [0, 1, 1, 1, 1, 1, 0],  // row 0: head
  [0, 1, 2, 1, 2, 1, 0],  // row 1: eyes (col 2, 4)
  [3, 1, 1, 1, 1, 1, 4],  // row 2: body + arms
  [0, 1, 1, 1, 1, 1, 0],  // row 3: waist
  [0, 5, 0, 0, 0, 6, 0],  // row 4: tentacles
];

// ===== Crayfish 6×4 (simplified front-facing) =====
export const CRAYFISH_GRID: number[][] = [
  [0, 3, 0, 0, 4, 0],  // row 0: claws
  [3, 1, 1, 1, 1, 4],  // row 1: body + arms
  [0, 1, 2, 2, 1, 0],  // row 2: body + eyes
  [0, 5, 1, 1, 6, 0],  // row 3: body + legs
];

// ===== Colors =====
export const COLORS = {
  // Octopus (terracotta)
  octopusBody: [0xC0, 0x70, 0x58] as const,
  octopusEye: [0x2D, 0x1F, 0x16] as const,
  octopusArm: [0xA0, 0x58, 0x40] as const,
  octopusLeg: [0xA0, 0x58, 0x40] as const,
  octopusSleeping: [0x80, 0x50, 0x40] as const,
  octopusStarburst: [0xD0, 0x88, 0x70] as const,

  // Crayfish (red)
  crayfishBody: [0xFF, 0x4D, 0x4D] as const,
  crayfishEye: [0x00, 0xE5, 0xCC] as const,
  crayfishClaw: [0x99, 0x1B, 0x1B] as const,
  crayfishLeg: [0xCC, 0x33, 0x33] as const,
  crayfishRouting: [0xFF, 0x6B, 0x6B] as const,

  // Tetra (neon)
  tetraNeon: [0x00, 0xE5, 0xFF] as const,
  tetraBody: [0x1E, 0x40, 0xAF] as const,
  tetraFin: [0xFF, 0x6B, 0x6B] as const,

  // Environment
  water: [0x0A, 0x16, 0x28] as const,
  waterLight: [0x0E, 0x1E, 0x35] as const,
  sand: [0x3D, 0x2B, 0x1F] as const,
  sandLight: [0x50, 0x3C, 0x2E] as const,
  seaweed: [0x16, 0x5B, 0x33] as const,
  seaweedDark: [0x0E, 0x40, 0x22] as const,
  rock: [0x33, 0x33, 0x33] as const,
  bubble: [0x40, 0x60, 0x80] as const,

  // States
  stateIdle: [0x22, 0xC5, 0x5E] as const,
  stateProcessing: [0x3B, 0x82, 0xF6] as const,
  stateAwaiting: [0xF5, 0x9E, 0x0B] as const,
  stateError: [0xEF, 0x44, 0x44] as const,

  // UI
  gaugeFilled: [0x22, 0xC5, 0x5E] as const,
  gaugeEmpty: [0x1E, 0x29, 0x3B] as const,
  textDim: [0x64, 0x74, 0x8B] as const,
  textBright: [0x94, 0xA3, 0xB8] as const,
  white: [0xFF, 0xFF, 0xFF] as const,
  black: [0x00, 0x00, 0x00] as const,
};

type RGB = readonly [number, number, number];

/** Set a pixel in the 64×64 RGB buffer. */
export function setPixel(buf: Uint8Array, x: number, y: number, color: RGB): void {
  if (x < 0 || x >= 64 || y < 0 || y >= 64) return;
  const idx = (y * 64 + x) * 3;
  buf[idx] = color[0];
  buf[idx + 1] = color[1];
  buf[idx + 2] = color[2];
}

/** Fill a rectangle. */
export function fillRect(
  buf: Uint8Array, x: number, y: number, w: number, h: number, color: RGB
): void {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      setPixel(buf, x + dx, y + dy, color);
    }
  }
}

/** Get cell color for octopus based on cell type and state. */
function getOctopusCellColor(
  cellType: number, state: 'idle' | 'working' | 'sleeping' | 'asking'
): RGB | null {
  if (cellType === EMPTY) return null;
  if (state === 'sleeping') {
    if (cellType === EYE) return COLORS.octopusSleeping; // dimmed eyes when sleeping
    return COLORS.octopusSleeping;
  }
  switch (cellType) {
    case BODY: return state === 'working' ? COLORS.octopusStarburst : COLORS.octopusBody;
    case EYE: return COLORS.octopusEye;
    case LEFT_ARM: case RIGHT_ARM: return COLORS.octopusArm;
    case LEFT_LEG: case RIGHT_LEG: return COLORS.octopusLeg;
    default: return COLORS.octopusBody;
  }
}

/**
 * Draw an octopus sprite at the given position.
 * PIXEL_ASPECT 2.0: each cell is 1px wide × 2px tall.
 * Total: 7×10 pixels.
 *
 * @param animFrame - animation frame for breathing/tentacle movement
 */
export function drawOctopus(
  buf: Uint8Array, x: number, y: number,
  state: 'idle' | 'working' | 'sleeping' | 'asking',
  animFrame: number
): void {
  // Breathing: slight y offset
  const breathOffset = state === 'idle' ? Math.round(Math.sin(animFrame * 0.5) * 0.5) : 0;

  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 7; col++) {
      const cellType = OCTOPUS_GRID[row][col];
      const color = getOctopusCellColor(cellType, state);
      if (!color) continue;

      // Tentacle animation: slight horizontal wobble on legs
      let dx = 0;
      if ((cellType === LEFT_LEG || cellType === RIGHT_LEG) && state !== 'sleeping') {
        dx = Math.round(Math.sin(animFrame * 0.7 + col) * 0.5);
      }

      const px = x + col + dx;
      const py = y + row * 2 + breathOffset;

      // Draw 1×2 pixel (aspect ratio)
      setPixel(buf, px, py, color);
      setPixel(buf, px, py + 1, color);
    }
  }

  // "?" bubble when asking
  if (state === 'asking') {
    setPixel(buf, x + 3, y - 3, COLORS.white);
    setPixel(buf, x + 4, y - 4, COLORS.white);
    setPixel(buf, x + 4, y - 3, COLORS.white);
    setPixel(buf, x + 3, y - 4, COLORS.white);
  }

  // Starburst particles when working
  if (state === 'working') {
    const sparkPhase = animFrame * 1.2;
    for (let i = 0; i < 3; i++) {
      const angle = sparkPhase + (i * Math.PI * 2 / 3);
      const dist = 5 + Math.sin(animFrame * 0.8 + i) * 2;
      const sx = Math.round(x + 3 + Math.cos(angle) * dist);
      const sy = Math.round(y + 5 + Math.sin(angle) * dist);
      setPixel(buf, sx, sy, COLORS.octopusStarburst);
    }
  }
}

/** Get cell color for crayfish. */
function getCrayfishCellColor(
  cellType: number, routing: boolean
): RGB | null {
  if (cellType === EMPTY) return null;
  const bodyColor = routing ? COLORS.crayfishRouting : COLORS.crayfishBody;
  switch (cellType) {
    case BODY: return bodyColor;
    case EYE: return COLORS.crayfishEye;
    case LEFT_ARM: case RIGHT_ARM: return COLORS.crayfishClaw;
    case LEFT_LEG: case RIGHT_LEG: return COLORS.crayfishLeg;
    default: return bodyColor;
  }
}

/**
 * Draw a crayfish sprite. 6×4 grid, each cell 1×2px (PIXEL_ASPECT 2.0).
 * Total: 6×8 pixels.
 */
export function drawCrayfish(
  buf: Uint8Array, x: number, y: number,
  routing: boolean, animFrame: number
): void {
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 6; col++) {
      const cellType = CRAYFISH_GRID[row][col];
      const color = getCrayfishCellColor(cellType, routing);
      if (!color) continue;

      // Claw animation when routing
      let dx = 0;
      if (routing && (cellType === LEFT_ARM || cellType === RIGHT_ARM) && row === 0) {
        dx = cellType === LEFT_ARM
          ? -Math.round(Math.sin(animFrame * 1.2) * 1)
          : Math.round(Math.sin(animFrame * 1.2) * 1);
      }

      const px = x + col + dx;
      const py = y + row * 2;
      setPixel(buf, px, py, color);
      setPixel(buf, px, py + 1, color);
    }
  }
}

/**
 * Draw a single neon tetra (1-pixel body + 1-pixel stripe).
 */
export function drawTetra(
  buf: Uint8Array, x: number, y: number, heading: number
): void {
  // Body pixel
  setPixel(buf, x, y, COLORS.tetraBody);
  // Neon stripe (behind body based on heading)
  const tailX = heading > 0 ? x - 1 : x + 1;
  setPixel(buf, tailX, y, COLORS.tetraNeon);
}
