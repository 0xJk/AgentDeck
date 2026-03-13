/**
 * Pixoo64 Creature Sprites + Environment — pixel art for 64×64 LED matrix.
 *
 * Octopus: 7×5 grid, PIXEL_ASPECT 2.0 → 7×10px actual.
 * Crayfish: 6×4 simplified front-facing sprite → 6×8px actual.
 * Tetra: 2-pixel fish with directional neon stripe.
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

// ===== Crayfish 9×6 (wide claws + antennae, front-facing) =====
const ANTENNA = 7;

export const CRAYFISH_GRID: number[][] = [
  [0, 0, 0, 7, 0, 7, 0, 0, 0],  // row 0: antennae
  [3, 0, 0, 0, 0, 0, 0, 0, 4],  // row 1: big claw tips (wide spread)
  [0, 3, 0, 1, 1, 1, 0, 4, 0],  // row 2: claw arms + head
  [0, 0, 1, 2, 1, 2, 1, 0, 0],  // row 3: body + eyes
  [0, 0, 0, 1, 1, 1, 0, 0, 0],  // row 4: body
  [0, 0, 5, 0, 1, 0, 6, 0, 0],  // row 5: legs + tail
];

// ===== Colors =====
type RGB = readonly [number, number, number];

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
  crayfishAntenna: [0xDD, 0x55, 0x55] as const,

  // Tetra (neon)
  tetraNeon: [0x00, 0xE5, 0xFF] as const,
  tetraBody: [0x1E, 0x40, 0xAF] as const,
  tetraFin: [0xFF, 0x6B, 0x6B] as const,

  // Environment — water zones (LED-bright: 3x original for visibility)
  waterDeep:  [0x10, 0x22, 0x48] as const,
  waterMid:   [0x18, 0x33, 0x5A] as const,
  waterLight: [0x22, 0x44, 0x6E] as const,
  waterSurface: [0x30, 0x58, 0x82] as const,

  // Teal zone (50-70%)
  waterTealDeep:    [0x10, 0x30, 0x38] as const,
  waterTealMid:     [0x18, 0x42, 0x4A] as const,
  waterTealLight:   [0x22, 0x55, 0x5E] as const,
  waterTealSurface: [0x30, 0x68, 0x72] as const,

  // Amber zone (70-90%)
  waterAmberDeep:    [0x30, 0x20, 0x10] as const,
  waterAmberMid:     [0x44, 0x30, 0x18] as const,
  waterAmberLight:   [0x58, 0x40, 0x20] as const,
  waterAmberSurface: [0x6C, 0x50, 0x28] as const,

  // Red zone (90%+)
  waterRedDeep:    [0x38, 0x10, 0x10] as const,
  waterRedMid:     [0x50, 0x18, 0x18] as const,
  waterRedLight:   [0x68, 0x20, 0x20] as const,
  waterRedSurface: [0x80, 0x28, 0x28] as const,

  // Terrain (warm, visible)
  sand:      [0x6A, 0x4A, 0x30] as const,
  sandLight: [0x82, 0x60, 0x40] as const,
  sandDark:  [0x50, 0x38, 0x24] as const,
  gravel:    [0x72, 0x56, 0x3C] as const,
  rock:      [0x48, 0x48, 0x48] as const,
  rockLight: [0x60, 0x60, 0x60] as const,
  seaweed:      [0x28, 0x80, 0x45] as const,
  seaweedDark:  [0x1C, 0x60, 0x32] as const,
  seaweedLight: [0x38, 0x98, 0x55] as const,

  // Effects
  bubble:       [0x60, 0x90, 0xC0] as const,
  bubbleBright: [0x88, 0xBB, 0xEE] as const,
  lightRay:     [0x30, 0x50, 0x70] as const,
  caustic:      [0x28, 0x44, 0x60] as const,
  dataParticle: [0x70, 0xB0, 0xFF] as const,
  dataParticleGreen: [0x50, 0xF0, 0x90] as const,

  // Tank walls (exposed above water)
  tankWall:     [0x0C, 0x10, 0x18] as const,
  tankWallEdge: [0x1A, 0x1E, 0x28] as const,

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
  const idx = (y * 64 + x) * 3;
  buf[idx] = color[0];
  buf[idx + 1] = color[1];
  buf[idx + 2] = color[2];
}

/** Alpha-blend a pixel onto existing buffer content. */
export function blendPixel(buf: Uint8Array, x: number, y: number, color: RGB, alpha: number): void {
  if (x < 0 || x >= 64 || y < 0 || y >= 64 || alpha <= 0) return;
  const idx = (y * 64 + x) * 3;
  const a = Math.min(1, alpha);
  const inv = 1 - a;
  buf[idx] = Math.min(255, Math.round(buf[idx] * inv + color[0] * a));
  buf[idx + 1] = Math.min(255, Math.round(buf[idx + 1] * inv + color[1] * a));
  buf[idx + 2] = Math.min(255, Math.round(buf[idx + 2] * inv + color[2] * a));
}

/** Additive-blend (glow) a pixel — brightens without darkening. */
export function glowPixel(buf: Uint8Array, x: number, y: number, color: RGB, intensity: number): void {
  if (x < 0 || x >= 64 || y < 0 || y >= 64 || intensity <= 0) return;
  const idx = (y * 64 + x) * 3;
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

/** Linearly interpolate between two colors. t=0→a, t=1→b. */
export function lerpColor(a: RGB, b: RGB, t: number): RGB {
  const s = Math.max(0, Math.min(1, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * s),
    Math.round(a[1] + (b[1] - a[1]) * s),
    Math.round(a[2] + (b[2] - a[2]) * s),
  ] as unknown as RGB;
}

// ===== Creature Renderers =====

/** Get cell color for octopus based on cell type and state. */
function getOctopusCellColor(
  cellType: number, state: 'idle' | 'working' | 'sleeping' | 'asking',
  blinkPhase: boolean
): RGB | null {
  if (cellType === EMPTY) return null;
  if (state === 'sleeping') {
    return COLORS.octopusSleeping;
  }
  switch (cellType) {
    case BODY: return state === 'working' ? COLORS.octopusStarburst : COLORS.octopusBody;
    case EYE:
      // Blink: close eyes briefly
      if (blinkPhase) return state === 'working' ? COLORS.octopusStarburst : COLORS.octopusBody;
      return COLORS.octopusEye;
    case LEFT_ARM: case RIGHT_ARM: return COLORS.octopusArm;
    case LEFT_LEG: case RIGHT_LEG: return COLORS.octopusLeg;
    default: return COLORS.octopusBody;
  }
}

/**
 * Draw an octopus sprite. 7×5 grid, each cell 1×2px.
 */
export function drawOctopus(
  buf: Uint8Array, x: number, y: number,
  state: 'idle' | 'working' | 'sleeping' | 'asking',
  animFrame: number
): void {
  // Breathing: visible y offset (2px amplitude for clear movement)
  const breathOffset = state === 'idle'
    ? Math.round(Math.sin(animFrame * 0.35) * 2)
    : state === 'working'
      ? Math.round(Math.sin(animFrame * 0.7) * 1)
      : 0;

  // Blink every ~40 frames for 3 frames
  const blinkCycle = animFrame % 40;
  const blinkPhase = blinkCycle >= 37;

  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 7; col++) {
      const cellType = OCTOPUS_GRID[row][col];
      const color = getOctopusCellColor(cellType, state, blinkPhase);
      if (!color) continue;

      // Tentacle animation (2px swing for visibility)
      let dx = 0;
      if ((cellType === LEFT_LEG || cellType === RIGHT_LEG) && state !== 'sleeping') {
        dx = Math.round(Math.sin(animFrame * 0.5 + col * 2) * 2);
      }
      // Arm wave (always when not sleeping, bigger when working)
      if ((cellType === LEFT_ARM || cellType === RIGHT_ARM) && state !== 'sleeping') {
        const amp = state === 'working' ? 2 : 1;
        const spd = state === 'working' ? 0.7 : 0.3;
        dx = cellType === LEFT_ARM
          ? -Math.round(Math.abs(Math.sin(animFrame * spd)) * amp)
          : Math.round(Math.abs(Math.sin(animFrame * spd)) * amp);
      }

      const px = x + col + dx;
      const py = y + row * 2 + breathOffset;
      setPixel(buf, px, py, color);
      setPixel(buf, px, py + 1, color);
    }
  }

  // "?" bubble when asking — larger, more visible
  if (state === 'asking') {
    const bobY = Math.round(Math.sin(animFrame * 0.5) * 1);
    // Bubble circle (3px)
    blendPixel(buf, x + 3, y - 4 + bobY, COLORS.white, 0.6);
    blendPixel(buf, x + 4, y - 4 + bobY, COLORS.white, 0.6);
    blendPixel(buf, x + 3, y - 5 + bobY, COLORS.white, 0.6);
    blendPixel(buf, x + 4, y - 5 + bobY, COLORS.white, 0.6);
    // "?" dot
    setPixel(buf, x + 3, y - 3 + bobY, COLORS.white);
  }

  // Starburst particles when working (6 particles, rotating)
  if (state === 'working') {
    const sparkPhase = animFrame * 0.8;
    for (let i = 0; i < 6; i++) {
      const angle = sparkPhase + (i * Math.PI * 2 / 6);
      const dist = 5 + Math.sin(animFrame * 0.6 + i * 1.5) * 2;
      const sx = Math.round(x + 3 + Math.cos(angle) * dist);
      const sy = Math.round(y + 5 + breathOffset + Math.sin(angle) * dist * 0.6);
      glowPixel(buf, sx, sy, COLORS.octopusStarburst, 0.7);
    }
  }
}

/** Get cell color for crayfish. */
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

/**
 * Draw a crayfish sprite. 9×6 grid, each cell 1×2px = 9×12px total.
 * Wide claws + antennae for recognizable silhouette.
 * Always animated — heartbeat glow + antenna wiggle (idle), full clap (routing).
 */
export function drawCrayfish(
  buf: Uint8Array, x: number, y: number,
  routing: boolean, animFrame: number
): void {
  const ROWS = CRAYFISH_GRID.length;
  const COLS = CRAYFISH_GRID[0].length;

  // Breathing: visible vertical bob (2px)
  const breathOffset = Math.round(Math.sin(animFrame * 0.3) * 2);

  // Heartbeat glow — 4s double-beat (even when idle)
  const heartPhase = (animFrame * 0.15) % (Math.PI * 2);
  const beat1 = Math.max(0, Math.sin(heartPhase * 2) * 0.8);
  const beat2 = Math.max(0, Math.sin(heartPhase * 2 + 1.2) * 0.5);
  const heartGlow = Math.max(beat1, beat2);

  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const cellType = CRAYFISH_GRID[row][col];
      const color = getCrayfishCellColor(cellType, routing);
      if (!color) continue;

      let dx = 0;
      let dy = breathOffset;

      // Antenna wiggle (always on, 2px swing, faster when routing)
      if (cellType === ANTENNA) {
        const wiggleSpeed = routing ? 0.7 : 0.3;
        dx = Math.round(Math.sin(animFrame * wiggleSpeed + col * 3) * 2);
      }

      // Claw animation (always visible)
      if (cellType === LEFT_ARM || cellType === RIGHT_ARM) {
        if (routing) {
          // Routing: wide clap in/out
          const clap = Math.round(Math.sin(animFrame * 0.8) * 3);
          dx = cellType === LEFT_ARM ? clap : -clap;
        } else {
          // Idle: slow open/close (2px visible swing)
          const gentle = Math.round(Math.sin(animFrame * 0.25) * 2);
          dx = cellType === LEFT_ARM ? gentle : -gentle;
        }
      }

      // Leg shift (slow walk, 1px)
      if (cellType === LEFT_LEG || cellType === RIGHT_LEG) {
        dx = Math.round(Math.sin(animFrame * 0.2 + (cellType === LEFT_LEG ? 0 : Math.PI)) * 1);
      }

      const px = x + col + dx;
      const py = y + row * 2 + dy;
      setPixel(buf, px, py, color);
      setPixel(buf, px, py + 1, color);
    }
  }

  // Eye glow — heartbeat pulse (always on, brighter when routing)
  const eyeIntensity = routing ? heartGlow * 0.6 : heartGlow * 0.3;
  // Eyes are at row 3, cols 3 and 5 in the grid
  const eyeY = y + 3 * 2 + breathOffset;
  glowPixel(buf, x + 3, eyeY, COLORS.crayfishEye, eyeIntensity);
  glowPixel(buf, x + 3, eyeY + 1, COLORS.crayfishEye, eyeIntensity);
  glowPixel(buf, x + 5, eyeY, COLORS.crayfishEye, eyeIntensity);
  glowPixel(buf, x + 5, eyeY + 1, COLORS.crayfishEye, eyeIntensity);

  // Routing: signal wave particles radiating outward
  if (routing) {
    const wavePhase = animFrame * 0.6;
    for (let i = 0; i < 4; i++) {
      const angle = wavePhase + (i * Math.PI / 2);
      const dist = 6 + Math.sin(animFrame * 0.4 + i) * 2;
      const sx = Math.round(x + 4 + Math.cos(angle) * dist);
      const sy = Math.round(y + 6 + breathOffset + Math.sin(angle) * dist * 0.5);
      glowPixel(buf, sx, sy, COLORS.crayfishEye, 0.4);
    }

    // Body glow pulse
    const bodyPulse = (Math.sin(animFrame * 0.5) + 1) * 0.15;
    for (let row = 2; row <= 4; row++) {
      for (let col = 2; col <= 6; col++) {
        if (CRAYFISH_GRID[row][col] !== EMPTY) {
          glowPixel(buf, x + col, y + row * 2 + breathOffset, COLORS.crayfishRouting, bodyPulse);
        }
      }
    }
  }
}

/**
 * Draw a single neon tetra (2-pixel: body + neon stripe).
 */
export function drawTetra(
  buf: Uint8Array, x: number, y: number, heading: number
): void {
  setPixel(buf, x, y, COLORS.tetraBody);
  const tailX = heading > 0 ? x - 1 : x + 1;
  setPixel(buf, tailX, y, COLORS.tetraNeon);
}
