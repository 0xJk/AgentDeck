/**
 * Pixoo64 Creature Sprites + Environment — pixel art for 64×64 LED matrix.
 *
 * Grids match Android TerrainCreature designs:
 *   Octopus: 14×7 grid (Android OctopusCreature), PIXEL_ASPECT 2.0
 *   Crayfish: 12×8 grid (Android CrayfishCreature simplified)
 *   Tetra: 4-pixel fish (body 2 + stripe 1 + fin 1)
 *
 * Pixel art readability stack:
 *   1. Colored outline (body-color darkened 50% — silhouette definition)
 *   2. Silhouette-first grids (round head, separated tentacles)
 *   3. Bright eye highlights (warm white — visible on LED)
 *   4. LOD sprites (chunky grids for zoom < 1.3)
 *   5. Glow halo (subtle radial glow behind creatures, stronger for LOD)
 *   6. Camera timing (wide zone zoom 1.2, shorter dwell)
 *   7. LOD outline reduction (alpha 0.4 instead of 0.8 — prevents shape smearing)
 *   8. Composite breathing wave (sin + harmonic — organic rhythm)
 *   9. Minimum animation amplitude (1px floor — no invisible motion)
 *
 * Camera-scaled rendering:
 *   cellPx = creature world width / grid columns × camera zoom
 *   zoom 1.2 → octopus ~8.4px wide, crayfish ~14.4px wide
 *   zoom 2.0 → octopus ~14px wide, crayfish ~24px wide
 */

import type { Camera } from './pixoo-camera.js';
import { worldToScreen, isVisible } from './pixoo-camera.js';

// ===== Cell Types (shared with ESP32/Android) =====
const EMPTY = 0;
const BODY = 1;
const EYE = 2;
const LEFT_ARM = 3;
const RIGHT_ARM = 4;
const LEFT_LEG = 5;
const RIGHT_LEG = 6;
const ANTENNA = 7;

// ===== Octopus 14×7 — rounded head + narrow waist + separated tentacles =====
export const OCTOPUS_GRID: number[][] = [
  [0,0,0,1,1,1,1,1,1,1,1,0,0,0],  // rounded top (narrow)
  [0,0,1,1,1,1,1,1,1,1,1,1,0,0],  // head
  [0,0,1,1,2,1,1,1,1,2,1,1,0,0],  // eyes at col 4,9
  [3,3,1,1,1,1,1,1,1,1,1,1,4,4],  // arms + body (widest)
  [0,0,0,1,1,1,1,1,1,1,1,0,0,0],  // waist (narrow)
  [0,0,5,0,5,0,1,1,0,6,0,6,0,0],  // upper tentacles + center
  [0,0,0,5,0,0,0,0,0,0,6,0,0,0],  // lower tentacles (separated)
];
const OCTO_COLS = 14;
const OCTO_ROWS = 7;
/** World width of octopus in normalized coords (7 world-pixels / 64). */
export const OCTO_WORLD_W = 7 / 64;

// ===== Octopus LOD 7×5 — chunky grid for zoom < 1.3 =====
const OCTOPUS_LOD: number[][] = [
  [0,1,1,1,1,1,0],  // dome
  [0,1,2,1,2,1,0],  // eyes (bright)
  [1,1,1,1,1,1,1],  // body + arms
  [0,1,0,1,0,1,0],  // tentacles
  [0,0,1,0,1,0,0],  // tentacle tips
];
const OCTO_LOD_COLS = 7;
const OCTO_LOD_ROWS = 5;

// ===== Crayfish 12×8 — expanded front-facing sprite =====
export const CRAYFISH_GRID: number[][] = [
  [0,0,0,7,0,0,0,0,0,7,0,0],  // antennae tips (wide)
  [0,0,0,0,7,0,0,7,0,0,0,0],  // antennae shafts
  [3,3,0,0,0,1,1,0,0,0,4,4],  // claw tips (widest)
  [0,0,3,0,1,1,1,1,0,4,0,0],  // claw arms + carapace
  [0,0,0,1,2,1,1,2,1,0,0,0],  // head + eyes
  [0,0,0,1,1,1,1,1,1,0,0,0],  // thorax
  [0,0,0,0,1,1,1,1,0,0,0,0],  // abdomen
  [0,0,5,0,0,1,1,0,0,6,0,0],  // tail + walking legs
];
const CF_COLS = 12;
const CF_ROWS = 8;
/** World width of crayfish in normalized coords (12 world-pixels / 64). */
export const CF_WORLD_W = 12 / 64;

// ===== Crayfish LOD 8×6 — claws close to body =====
const CRAYFISH_LOD: number[][] = [
  [0,0,7,0,0,7,0,0],  // antennae
  [3,0,0,1,1,0,0,4],  // claws (close to body)
  [0,3,1,1,1,1,4,0],  // claw arms + carapace
  [0,0,1,2,2,1,0,0],  // eyes (bright)
  [0,0,1,1,1,1,0,0],  // thorax
  [0,5,0,1,1,0,6,0],  // legs + tail
];
const CF_LOD_COLS = 8;
const CF_LOD_ROWS = 6;

// ===== Colors — Android-matching darker palette =====
type RGB = readonly [number, number, number];

export const COLORS = {
  // Octopus (terracotta — Android match)
  octopusBody:      [0xC0, 0x70, 0x58] as const,
  octopusEyeHighlight: [0xFF, 0xF0, 0xD0] as const,  // warm white — LED visible
  octopusEyePupil:     [0x40, 0x20, 0x18] as const,   // dark brown (not black)
  octopusArm:       [0xA0, 0x58, 0x40] as const,
  octopusLeg:       [0xA0, 0x58, 0x40] as const,
  octopusSleeping:  [0x80, 0x50, 0x40] as const,
  octopusStarburst: [0xD0, 0x88, 0x70] as const,
  octopusGlow:      [0x60, 0x38, 0x2C] as const,  // warm terracotta glow

  // Crayfish (red — Android match)
  crayfishBody:    [0xFF, 0x4D, 0x4D] as const,
  crayfishEye:     [0x00, 0xE5, 0xCC] as const,
  crayfishClaw:    [0xCC, 0x44, 0x33] as const,  // brighter than body for visibility on dark water
  crayfishLeg:     [0xCC, 0x33, 0x33] as const,
  crayfishRouting: [0xFF, 0x6B, 0x6B] as const,
  crayfishAntenna: [0xDD, 0x55, 0x55] as const,
  crayfishGlow:    [0x80, 0x20, 0x20] as const,  // warm red glow

  // Tetra (neon)
  tetraNeon: [0x00, 0xE5, 0xFF] as const,
  tetraBody: [0x1E, 0x40, 0xAF] as const,
  tetraFin:  [0xFF, 0x6B, 0x6B] as const,

  // Environment — brightened for LED visibility (was Android-dark, too dim on Pixoo)
  waterDeep:    [0x14, 0x24, 0x3C] as const,
  waterMid:     [0x1C, 0x38, 0x58] as const,
  waterLight:   [0x24, 0x48, 0x6C] as const,
  waterSurface: [0x2C, 0x58, 0x80] as const,

  // Teal zone (50-70%) — brightened for LED
  waterTealDeep:    [0x10, 0x30, 0x3C] as const,
  waterTealMid:     [0x18, 0x44, 0x50] as const,
  waterTealLight:   [0x22, 0x58, 0x64] as const,
  waterTealSurface: [0x2C, 0x6C, 0x78] as const,

  // Amber zone (70-90%) — brightened for LED
  waterAmberDeep:    [0x34, 0x24, 0x14] as const,
  waterAmberMid:     [0x4C, 0x36, 0x1C] as const,
  waterAmberLight:   [0x60, 0x48, 0x24] as const,
  waterAmberSurface: [0x78, 0x5C, 0x2E] as const,

  // Red zone (90%+) — brightened for LED
  waterRedDeep:    [0x3C, 0x14, 0x14] as const,
  waterRedMid:     [0x58, 0x1E, 0x1E] as const,
  waterRedLight:   [0x70, 0x28, 0x28] as const,
  waterRedSurface: [0x88, 0x32, 0x32] as const,

  // Terrain — brightened for LED
  sand:      [0x38, 0x2C, 0x1E] as const,
  sandLight: [0x4C, 0x3C, 0x28] as const,
  sandDark:  [0x28, 0x20, 0x14] as const,
  gravel:    [0x44, 0x36, 0x24] as const,
  rock:      [0x24, 0x24, 0x3C] as const,
  rockLight: [0x34, 0x34, 0x4C] as const,

  // Seaweed (Android green)
  seaweed:      [0x22, 0xC5, 0x5E] as const,
  seaweedDark:  [0x18, 0x90, 0x42] as const,
  seaweedLight: [0x30, 0xE0, 0x70] as const,

  // Effects
  bubble:            [0x40, 0x70, 0xA0] as const,
  bubbleBright:      [0x60, 0x98, 0xCC] as const,
  lightRay:          [0x20, 0x40, 0x60] as const,
  caustic:           [0x1C, 0x36, 0x50] as const,
  dataParticle:      [0x70, 0xB0, 0xFF] as const,
  dataParticleGreen: [0x50, 0xF0, 0x90] as const,

  // Tank walls (above water)
  tankWall:     [0x06, 0x0A, 0x10] as const,
  tankWallEdge: [0x10, 0x14, 0x1C] as const,

  // State shimmer
  stateIdle:       [0x22, 0xC5, 0x5E] as const,
  stateProcessing: [0x3B, 0x82, 0xF6] as const,
  stateAwaiting:   [0xF5, 0x9E, 0x0B] as const,
  stateError:      [0xEF, 0x44, 0x44] as const,

  white: [0xFF, 0xFF, 0xFF] as const,
  black: [0x00, 0x00, 0x00] as const,
};

export { type RGB };

// ===== Pixel Operations =====

/** Set a pixel in the 64×64 RGB buffer. */
export function setPixel(buf: Uint8Array, x: number, y: number, color: RGB): void {
  if (x < 0 || x >= 64 || y < 0 || y >= 64) return;
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (ix < 0 || ix >= 64 || iy < 0 || iy >= 64) return;
  const idx = (iy * 64 + ix) * 3;
  buf[idx] = color[0];
  buf[idx + 1] = color[1];
  buf[idx + 2] = color[2];
}

/** Alpha-blend a pixel onto existing buffer content. */
export function blendPixel(buf: Uint8Array, x: number, y: number, color: RGB, alpha: number): void {
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (ix < 0 || ix >= 64 || iy < 0 || iy >= 64 || alpha <= 0) return;
  const idx = (iy * 64 + ix) * 3;
  const a = Math.min(1, alpha);
  const inv = 1 - a;
  buf[idx] = Math.min(255, Math.round(buf[idx] * inv + color[0] * a));
  buf[idx + 1] = Math.min(255, Math.round(buf[idx + 1] * inv + color[1] * a));
  buf[idx + 2] = Math.min(255, Math.round(buf[idx + 2] * inv + color[2] * a));
}

/** Additive-blend (glow) a pixel. */
export function glowPixel(buf: Uint8Array, x: number, y: number, color: RGB, intensity: number): void {
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (ix < 0 || ix >= 64 || iy < 0 || iy >= 64 || intensity <= 0) return;
  const idx = (iy * 64 + ix) * 3;
  buf[idx] = Math.min(255, buf[idx] + Math.round(color[0] * intensity));
  buf[idx + 1] = Math.min(255, buf[idx + 1] + Math.round(color[1] * intensity));
  buf[idx + 2] = Math.min(255, buf[idx + 2] + Math.round(color[2] * intensity));
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

/** Fill a scaled cell (variable size rectangle) — edge rounding for correct PIXEL_ASPECT. */
function fillCell(buf: Uint8Array, x: number, y: number, w: number, h: number, color: RGB): void {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iw = Math.max(1, Math.round(ix + w) - ix);  // right edge - left edge
  const ih = Math.max(1, Math.round(iy + h) - iy);
  for (let dy = 0; dy < ih; dy++) {
    for (let dx = 0; dx < iw; dx++) {
      setPixel(buf, ix + dx, iy + dy, color);
    }
  }
}

/** Fill a scaled cell and track drawn pixels for outline generation. */
function fillCellTracked(
  buf: Uint8Array, x: number, y: number, w: number, h: number,
  color: RGB, pixels: Set<number>,
): void {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iw = Math.max(1, Math.round(ix + w) - ix);
  const ih = Math.max(1, Math.round(iy + h) - iy);
  for (let dy = 0; dy < ih; dy++) {
    for (let dx = 0; dx < iw; dx++) {
      const px = ix + dx;
      const py = iy + dy;
      if (px >= 0 && px < 64 && py >= 0 && py < 64) {
        const idx = (py * 64 + px) * 3;
        buf[idx] = color[0];
        buf[idx + 1] = color[1];
        buf[idx + 2] = color[2];
        pixels.add(py * 64 + px);
      }
    }
  }
}

/** Glow-fill a scaled cell — edge rounding. */
function glowCell(buf: Uint8Array, x: number, y: number, w: number, h: number, color: RGB, intensity: number): void {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iw = Math.max(1, Math.round(ix + w) - ix);
  const ih = Math.max(1, Math.round(iy + h) - iy);
  for (let dy = 0; dy < ih; dy++) {
    for (let dx = 0; dx < iw; dx++) {
      glowPixel(buf, ix + dx, iy + dy, color, intensity);
    }
  }
}

/** Linearly interpolate between two colors. */
export function lerpColor(a: RGB, b: RGB, t: number): RGB {
  const s = Math.max(0, Math.min(1, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * s),
    Math.round(a[1] + (b[1] - a[1]) * s),
    Math.round(a[2] + (b[2] - a[2]) * s),
  ] as unknown as RGB;
}

// ===== Creature Glow Halo =====

/** Draw elliptical glow halo behind a creature (additive blend). */
function drawCreatureGlow(
  buf: Uint8Array,
  cx: number, cy: number,
  rx: number, ry: number,
  glowColor: RGB,
  intensity = 0.15,
  isLOD = false,
): void {
  // LOD: stronger glow to compensate for smaller creature ("something is here" beacon)
  const actualIntensity = isLOD ? intensity * 1.7 : intensity;
  const spread = isLOD ? 1.5 : 1.3;
  const irx = Math.ceil(rx * spread);
  const iry = Math.ceil(ry * spread);
  for (let dy = -iry; dy <= iry; dy++) {
    for (let dx = -irx; dx <= irx; dx++) {
      const dist = Math.sqrt((dx / rx) ** 2 + (dy / ry) ** 2);
      if (dist > spread) continue;
      const falloff = (1 - dist / spread) ** 2;
      glowPixel(buf, cx + dx, cy + dy, glowColor, actualIntensity * falloff);
    }
  }
}

// ===== Creature Outline =====

/** 8-directional colored outline around tracked creature pixels. */
function drawCreatureOutline(
  buf: Uint8Array,
  creaturePixels: Set<number>,
  bodyColor: RGB,
  alpha = 0.8,
): void {
  const outlineColor: RGB = [
    Math.round(bodyColor[0] * 0.5),
    Math.round(bodyColor[1] * 0.5),
    Math.round(bodyColor[2] * 0.5),
  ] as unknown as RGB;

  const neighbors = [-1, 0, 1];
  for (const key of creaturePixels) {
    const cx = key % 64;
    const cy = Math.floor(key / 64);
    for (const ndx of neighbors) {
      for (const ndy of neighbors) {
        if (ndx === 0 && ndy === 0) continue;
        const nx = cx + ndx;
        const ny = cy + ndy;
        if (nx < 0 || nx >= 64 || ny < 0 || ny >= 64) continue;
        if (!creaturePixels.has(ny * 64 + nx)) {
          blendPixel(buf, nx, ny, outlineColor, alpha);
        }
      }
    }
  }
}

// ===== Octopus Cell Color =====

function getOctopusCellColor(
  cellType: number, state: 'idle' | 'working' | 'sleeping' | 'asking',
  blinkPhase: boolean, isLOD: boolean,
): RGB | null {
  if (cellType === EMPTY) return null;
  if (state === 'sleeping') return COLORS.octopusSleeping;
  switch (cellType) {
    case BODY: return state === 'working' ? COLORS.octopusStarburst : COLORS.octopusBody;
    case EYE:
      if (blinkPhase) return state === 'working' ? COLORS.octopusStarburst : COLORS.octopusBody;
      // LOD: single bright pixel. Detail: highlight (use pupil for adjacent cell if needed)
      return isLOD ? COLORS.octopusEyeHighlight : COLORS.octopusEyeHighlight;
    case LEFT_ARM: case RIGHT_ARM: return COLORS.octopusArm;
    case LEFT_LEG: case RIGHT_LEG: return COLORS.octopusLeg;
    default: return COLORS.octopusBody;
  }
}

// ===== Crayfish Cell Color =====

function getCrayfishCellColor(cellType: number, routing: boolean): RGB | null {
  if (cellType === EMPTY) return null;
  const bodyColor = routing ? COLORS.crayfishRouting : COLORS.crayfishBody;
  switch (cellType) {
    case BODY: return bodyColor;
    case EYE: return COLORS.crayfishEye;
    case LEFT_ARM: case RIGHT_ARM: return COLORS.crayfishClaw;
    case LEFT_LEG: case RIGHT_LEG: return COLORS.crayfishLeg;
    case ANTENNA: return COLORS.crayfishAntenna;
    default: return bodyColor;
  }
}

// ===== Animation Helpers =====

/** Ensure animation offset has at least `minPx` magnitude when non-zero. */
function ensureMinAmplitude(value: number, minPx: number): number {
  if (Math.abs(value) < 0.01) return 0; // truly zero → stay zero
  const rounded = Math.round(value);
  if (rounded === 0) return value > 0 ? minPx : -minPx;
  return rounded;
}

// ===== Scaled Creature Renderers (camera-aware) =====

/**
 * Draw octopus scaled by camera zoom.
 * @param worldX  Octopus center in normalized world X (0~1)
 * @param worldY  Octopus center in normalized world Y (0~1)
 */
export function drawOctopus(
  buf: Uint8Array,
  worldX: number, worldY: number,
  state: 'idle' | 'working' | 'sleeping' | 'asking',
  animFrame: number,
  cam: Camera,
): void {
  if (!isVisible(worldX, worldY, cam, 0.12)) return;

  const [scx, scy] = worldToScreen(worldX, worldY, cam);

  // LOD selection — wide view (zoom 1.2) uses LOD for chunkier, visible cells
  const useLOD = cam.zoom < 1.3;
  const grid = useLOD ? OCTOPUS_LOD : OCTOPUS_GRID;
  const cols = useLOD ? OCTO_LOD_COLS : OCTO_COLS;
  const rows = useLOD ? OCTO_LOD_ROWS : OCTO_ROWS;

  // Cell size on screen
  const cellW = useLOD ? cam.zoom : cam.zoom / 2;
  const cellH = cellW * 2; // PIXEL_ASPECT 2.0
  const spriteW = cols * cellW;
  const spriteH = rows * cellH;

  // Top-left
  const baseX = scx - spriteW / 2;
  const baseY = scy - spriteH / 2;

  // Composite breathing — sin + harmonic for organic rhythm
  let breathPx: number;
  if (state === 'idle') {
    const primary = Math.sin(animFrame * 0.35);
    const harmonic = Math.sin(animFrame * 0.35 * 2.1) * 0.3;
    breathPx = ensureMinAmplitude((primary + harmonic) * cellH, 1);
  } else if (state === 'working') {
    breathPx = ensureMinAmplitude(Math.sin(animFrame * 0.7) * cellW, 1);
  } else {
    breathPx = 0;
  }

  // Blink every ~40 frames for 3 frames
  const blinkPhase = (animFrame % 40) >= 37;

  // 1. Glow halo (before creature — stronger for LOD)
  const glowRx = spriteW / 2 + 2;
  const glowRy = spriteH / 2 + 2;
  drawCreatureGlow(buf, scx, scy + breathPx, glowRx, glowRy, COLORS.octopusGlow, 0.15, useLOD);

  // 2. Draw cells with pixel tracking
  const trackedPixels = new Set<number>();

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cellType = grid[row][col];
      const color = getOctopusCellColor(cellType, state, blinkPhase, useLOD);
      if (!color) continue;

      let dx = 0;
      // Tentacle swing — bidirectional, min 1px amplitude
      if ((cellType === LEFT_LEG || cellType === RIGHT_LEG) && state !== 'sleeping') {
        dx = ensureMinAmplitude(Math.sin(animFrame * 0.5 + col * 2) * cellW * 2, 1);
      }
      // Arm wave — bidirectional swing (not abs), symmetric
      if ((cellType === LEFT_ARM || cellType === RIGHT_ARM) && state !== 'sleeping') {
        const amp = state === 'working' ? 2 : 1;
        const spd = state === 'working' ? 0.7 : 0.3;
        const swing = Math.sin(animFrame * spd) * amp * cellW;
        dx = ensureMinAmplitude(cellType === LEFT_ARM ? -swing : swing, 1);
      }

      fillCellTracked(buf,
        baseX + col * cellW + dx,
        baseY + row * cellH + breathPx,
        cellW, cellH, color, trackedPixels,
      );

      // Detail grid: draw pupil on EYE cells (bottom 1px of the cell)
      if (!useLOD && cellType === EYE && !blinkPhase && state !== 'sleeping') {
        const eyeX = Math.floor(baseX + col * cellW);
        const eyeY = Math.floor(baseY + row * cellH + breathPx);
        const eyeH = Math.max(1, Math.round(Math.floor(eyeY + cellH) - eyeY));
        // Pupil: bottom portion of eye cell
        if (eyeH >= 2) {
          const pupilY = eyeY + eyeH - 1;
          const pupilW = Math.max(1, Math.round(Math.floor(eyeX + cellW) - eyeX));
          for (let px = 0; px < pupilW; px++) {
            setPixel(buf, eyeX + px, pupilY, COLORS.octopusEyePupil);
          }
        }
      }
    }
  }

  // 3. Colored outline — reduced alpha for LOD (prevents shape smearing)
  const outlineAlpha = useLOD ? 0.4 : 0.8;
  drawCreatureOutline(buf, trackedPixels, COLORS.octopusBody, outlineAlpha);

  // "?" bubble when asking (drawn after outline)
  if (state === 'asking') {
    const bobY = ensureMinAmplitude(Math.sin(animFrame * 0.5) * cellW, 1);
    const bx = scx;
    const by = baseY - cellH * 1.5 + breathPx + bobY;
    const r = Math.max(2, Math.round(cellW * 2.5));
    // More opaque bubble (0.7 instead of 0.5)
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy <= r * r) {
          blendPixel(buf, bx + dx, by + dy, COLORS.white, 0.7);
        }
      }
    }
    // "?" shape: curved top (2-3px) + dot below
    const qx = Math.round(bx);
    const qy = Math.round(by);
    // Upper curve
    setPixel(buf, qx + 1, qy - Math.round(r * 0.4), COLORS.stateAwaiting);
    setPixel(buf, qx + 1, qy - Math.round(r * 0.2), COLORS.stateAwaiting);
    setPixel(buf, qx, qy, COLORS.stateAwaiting);
    // Dot
    setPixel(buf, qx, qy + Math.max(1, Math.round(r * 0.35)), COLORS.stateAwaiting);
  }

  // Starburst particles when working — solid center + glow surround
  if (state === 'working') {
    const sparkPhase = animFrame * 0.8;
    const dist = (3 + Math.sin(animFrame * 0.6)) * cellW * 2;
    for (let i = 0; i < 6; i++) {
      const angle = sparkPhase + (i * Math.PI * 2 / 6);
      const sx = scx + Math.cos(angle) * dist;
      const sy = scy + breathPx + Math.sin(angle) * dist * 0.6;
      // Solid center pixel for LED visibility
      fillCell(buf, sx, sy, Math.max(1, Math.round(cellW)), Math.max(1, Math.round(cellW)), COLORS.octopusStarburst);
      // Glow surround
      glowCell(buf, sx - 1, sy - 1, Math.max(1, Math.round(cellW)) + 2, Math.max(1, Math.round(cellW)) + 2, COLORS.octopusGlow, 0.4);
    }
  }
}

/**
 * Draw crayfish scaled by camera zoom.
 * @param worldX  Crayfish center in normalized world X (0~1)
 * @param worldY  Crayfish center in normalized world Y (0~1)
 */
export function drawCrayfish(
  buf: Uint8Array,
  worldX: number, worldY: number,
  routing: boolean,
  animFrame: number,
  cam: Camera,
): void {
  if (!isVisible(worldX, worldY, cam, 0.15)) return;

  const [scx, scy] = worldToScreen(worldX, worldY, cam);

  // LOD selection — matches octopus threshold
  const useLOD = cam.zoom < 1.3;
  const grid = useLOD ? CRAYFISH_LOD : CRAYFISH_GRID;
  const cols = useLOD ? CF_LOD_COLS : CF_COLS;
  const rows = useLOD ? CF_LOD_ROWS : CF_ROWS;

  // Cell size: detail cellW = Z, LOD cellW = 12*Z/8 = 1.5*Z (bigger cells for fewer cols)
  const cellW = useLOD ? cam.zoom * 1.5 : cam.zoom;
  const cellH = cellW * 1.5;
  const spriteW = cols * cellW;
  const spriteH = rows * cellH;
  const baseX = scx - spriteW / 2;
  const baseY = scy - spriteH / 2;

  // Composite breathing — asymmetric (slow inhale, quick exhale)
  const breathRaw = Math.pow(Math.abs(Math.sin(animFrame * 0.3)), 0.7)
    * Math.sign(Math.sin(animFrame * 0.3));
  const breathPx = ensureMinAmplitude(breathRaw * cellH * 0.5, 1);

  // Heartbeat glow (time-based for consistent 4s period regardless of frame step)
  const heartPhase = (animFrame * 0.15) % (Math.PI * 2);
  const beat1 = Math.max(0, Math.sin(heartPhase * 2) * 0.8);
  const beat2 = Math.max(0, Math.sin(heartPhase * 2 + 1.2) * 0.5);
  const heartGlow = Math.max(beat1, beat2);

  // 1. Glow halo (before creature — stronger for LOD)
  const glowRx = spriteW / 2 + 2;
  const glowRy = spriteH / 2 + 2;
  drawCreatureGlow(buf, scx, scy + breathPx, glowRx, glowRy, COLORS.crayfishGlow, 0.12, useLOD);

  // 2. Draw cells with pixel tracking
  const trackedPixels = new Set<number>();

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cellType = grid[row][col];
      const color = getCrayfishCellColor(cellType, routing);
      if (!color) continue;

      let dx = 0;
      const dy = breathPx;

      // Antenna wiggle — with occasional twitch
      if (cellType === ANTENNA) {
        const spd = routing ? 0.7 : 0.3;
        const wiggle = Math.sin(animFrame * spd + col * 3) * cellW * 1.5;
        // Random-ish twitch: sharp spike every ~30 frames
        const twitch = ((animFrame + col * 17) % 30) < 2 ? cellW * 2 * (col < 6 ? -1 : 1) : 0;
        dx = ensureMinAmplitude(wiggle + twitch, 1);
      }

      // Claw animation — routing: slower, wider clap; idle: gentle sway
      if (cellType === LEFT_ARM || cellType === RIGHT_ARM) {
        if (routing) {
          const clap = Math.sin(animFrame * 0.6) * cellW * 3; // slower + wider
          dx = ensureMinAmplitude(cellType === LEFT_ARM ? clap : -clap, 1);
        } else {
          const gentle = Math.sin(animFrame * 0.25) * cellW;
          dx = ensureMinAmplitude(cellType === LEFT_ARM ? gentle : -gentle, 1);
        }
      }

      // Leg shift — larger amplitude for visibility
      if (cellType === LEFT_LEG || cellType === RIGHT_LEG) {
        dx = ensureMinAmplitude(
          Math.sin(animFrame * 0.2 + (cellType === LEFT_LEG ? 0 : Math.PI)) * cellW * 1.2, 1
        );
      }

      fillCellTracked(buf,
        baseX + col * cellW + dx,
        baseY + row * cellH + dy,
        cellW, cellH, color, trackedPixels,
      );
    }
  }

  // 3. Colored outline — reduced alpha for LOD
  const bodyColor = routing ? COLORS.crayfishRouting : COLORS.crayfishBody;
  const outlineAlpha = useLOD ? 0.4 : 0.8;
  drawCreatureOutline(buf, trackedPixels, bodyColor, outlineAlpha);

  // Eye glow pulse (after outline)
  const eyeIntensity = routing ? heartGlow * 0.6 : heartGlow * 0.3;
  if (useLOD) {
    for (const ec of [3, 4]) {
      glowCell(buf,
        baseX + ec * cellW, baseY + 3 * cellH + breathPx,
        cellW, cellH, COLORS.crayfishEye, eyeIntensity,
      );
    }
  } else {
    for (const ec of [4, 7]) {
      glowCell(buf,
        baseX + ec * cellW, baseY + 4 * cellH + breathPx,
        cellW, cellH, COLORS.crayfishEye, eyeIntensity,
      );
    }
  }

  // Routing: signal wave particles (after outline)
  if (routing) {
    const wavePhase = animFrame * 0.6;
    for (let i = 0; i < 4; i++) {
      const angle = wavePhase + (i * Math.PI / 2);
      const dist = (4 + Math.sin(animFrame * 0.4 + i)) * cellW;
      const sx = scx + Math.cos(angle) * dist;
      const sy = scy + breathPx + Math.sin(angle) * dist * 0.5;
      glowCell(buf, sx, sy, cellW, cellW, COLORS.crayfishEye, 0.4);
    }

    // Body glow pulse
    const bodyPulse = (Math.sin(animFrame * 0.5) + 1) * 0.15;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        if (grid[row]?.[col] !== EMPTY) {
          glowCell(buf,
            baseX + col * cellW, baseY + row * cellH + breathPx,
            cellW, cellH, COLORS.crayfishRouting, bodyPulse,
          );
        }
      }
    }
  }
}

/**
 * Draw a scaled neon tetra.
 * At zoom 1.0: ~4 screen pixels. At zoom 2.0: ~8 screen pixels.
 */
export function drawTetra(
  buf: Uint8Array,
  worldX: number, worldY: number,
  heading: number,
  cam: Camera,
): void {
  if (!isVisible(worldX, worldY, cam, 0.08)) return;

  const [sx, sy] = worldToScreen(worldX, worldY, cam);
  const px = cam.zoom; // pixel scale

  // Body (2px-equivalent)
  const bw = Math.max(1, Math.round(px * 2));
  const bh = Math.max(1, Math.round(px));
  fillCell(buf, sx, sy, bw, bh, COLORS.tetraBody);

  // Neon stripe (1px behind body)
  const stripeX = heading > 0 ? sx - Math.round(px) : sx + Math.round(px * 2);
  fillCell(buf, stripeX, sy, Math.max(1, Math.round(px)), bh, COLORS.tetraNeon);

  // Tail fin
  const finX = heading > 0 ? stripeX - Math.max(1, Math.round(px * 0.5)) : stripeX + Math.max(1, Math.round(px));
  fillCell(buf, finX, sy, Math.max(1, Math.round(px * 0.5)), bh, COLORS.tetraFin);
}

// ===== Legacy World-Buffer Renderers (used for environment-embedded drawing) =====

/** Draw a tetra at pixel coordinates (for world buffer, zoom-unaware). */
export function drawTetraWorld(
  buf: Uint8Array, x: number, y: number, heading: number
): void {
  setPixel(buf, x, y, COLORS.tetraBody);
  const tailX = heading > 0 ? x - 1 : x + 1;
  setPixel(buf, tailX, y, COLORS.tetraNeon);
}
