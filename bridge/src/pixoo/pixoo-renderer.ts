/**
 * Pixoo64 Frame Renderer — full-screen animated terrarium.
 *
 * No text. All information encoded visually:
 *
 *   Water level  ↔  5h rate limit (full tank = 0%, shallow = 100%)
 *   Water color  ↔  usage zone (blue → teal → amber → red)
 *   Waves        ↔  agent state (calm=IDLE, choppy=PROC, golden pulse=AWAITING)
 *   Bubbles      ↔  activity density
 *   Creatures    ↔  sessions + gateway
 *   Particles    ↔  data flow during processing
 *   Surface glow ↔  state color (green / blue / amber)
 *
 * Layout (64×64):
 *   0 ~ surfaceY   : tank wall (dark, empty above waterline)
 *   surfaceY        : animated wave surface with state shimmer
 *   surfaceY ~ 53   : water body (gradient, creatures, effects)
 *   54 ~ 58         : sand / gravel terrain
 *   59 ~ 63         : rocks + dark substrate
 */

import { State } from '../types.js';
import type { StateUpdateEvent, UsageEvent } from '../types.js';
import type { SessionInfo } from '@agentdeck/shared/protocol';
import {
  type RGB, COLORS, setPixel, blendPixel, glowPixel, fillRect, lerpColor,
  drawOctopus, drawCrayfish, drawTetra,
} from './pixoo-sprites.js';

const W = 64;

// ===== Layout =====
const SAND_TOP = 54;
const SAND_BOT = 59;
const SUBSTRATE_TOP = 60;

// Water always fills the screen — usage encoded via color only
const SURFACE_Y = 2;  // Fixed wave position near top

// ===== Water Color Zones =====

interface WaterPalette {
  surface: RGB;
  light: RGB;
  mid: RGB;
  deep: RGB;
}

const ZONE_BLUE: WaterPalette = {
  surface: COLORS.waterSurface,
  light: COLORS.waterLight,
  mid: COLORS.waterMid,
  deep: COLORS.waterDeep,
};
const ZONE_TEAL: WaterPalette = {
  surface: COLORS.waterTealSurface,
  light: COLORS.waterTealLight,
  mid: COLORS.waterTealMid,
  deep: COLORS.waterTealDeep,
};
const ZONE_AMBER: WaterPalette = {
  surface: COLORS.waterAmberSurface,
  light: COLORS.waterAmberLight,
  mid: COLORS.waterAmberMid,
  deep: COLORS.waterAmberDeep,
};
const ZONE_RED: WaterPalette = {
  surface: COLORS.waterRedSurface,
  light: COLORS.waterRedLight,
  mid: COLORS.waterRedMid,
  deep: COLORS.waterRedDeep,
};

function getWaterPalette(pct: number): WaterPalette {
  if (pct < 50) {
    const t = pct / 50;
    return {
      surface: lerpColor(ZONE_BLUE.surface, ZONE_TEAL.surface, t),
      light: lerpColor(ZONE_BLUE.light, ZONE_TEAL.light, t),
      mid: lerpColor(ZONE_BLUE.mid, ZONE_TEAL.mid, t),
      deep: lerpColor(ZONE_BLUE.deep, ZONE_TEAL.deep, t),
    };
  } else if (pct < 75) {
    const t = (pct - 50) / 25;
    return {
      surface: lerpColor(ZONE_TEAL.surface, ZONE_AMBER.surface, t),
      light: lerpColor(ZONE_TEAL.light, ZONE_AMBER.light, t),
      mid: lerpColor(ZONE_TEAL.mid, ZONE_AMBER.mid, t),
      deep: lerpColor(ZONE_TEAL.deep, ZONE_AMBER.deep, t),
    };
  } else {
    const t = (pct - 75) / 25;
    return {
      surface: lerpColor(ZONE_AMBER.surface, ZONE_RED.surface, t),
      light: lerpColor(ZONE_AMBER.light, ZONE_RED.light, t),
      mid: lerpColor(ZONE_AMBER.mid, ZONE_RED.mid, t),
      deep: lerpColor(ZONE_AMBER.deep, ZONE_RED.deep, t),
    };
  }
}

function waterColorAt(palette: WaterPalette, surfaceY: number, y: number): RGB {
  const waterDepth = SAND_TOP - surfaceY;
  if (waterDepth <= 0) return palette.deep;
  const t = (y - surfaceY) / waterDepth; // 0=surface, 1=sand
  if (t < 0.25) return lerpColor(palette.surface, palette.light, t / 0.25);
  if (t < 0.6) return lerpColor(palette.light, palette.mid, (t - 0.25) / 0.35);
  return lerpColor(palette.mid, palette.deep, (t - 0.6) / 0.4);
}

// ===== Tetra School =====

interface TetraState {
  x: number;
  y: number;
  heading: number;
  speed: number;
  phase: number;
}

const NUM_TETRAS = 8;
let tetras: TetraState[] | null = null;

function initTetras(): TetraState[] {
  const result: TetraState[] = [];
  for (let i = 0; i < NUM_TETRAS; i++) {
    result.push({
      x: 12 + Math.random() * 40,
      y: 20 + Math.random() * 25,
      heading: Math.random() > 0.5 ? 1 : -1,
      speed: 0.2 + Math.random() * 0.3,
      phase: Math.random() * Math.PI * 2,
    });
  }
  return result;
}

function updateTetras(frame: number, surfaceY: number, maxY: number): void {
  if (!tetras) tetras = initTetras();

  // School center drifts via Lissajous (wider movement)
  const schoolCX = 32 + Math.sin(frame * 0.05) * 18;
  const schoolCY = Math.max(surfaceY + 8, 22) + Math.cos(frame * 0.035) * 10;

  for (const t of tetras) {
    // Cohesion: drift toward school center
    const dx = schoolCX - t.x;
    const dy = schoolCY - t.y;
    t.x += dx * 0.03 + t.heading * t.speed;
    t.y += dy * 0.03 + Math.sin(frame * 0.1 + t.phase) * 0.4;

    // Boundary handling
    const minY = surfaceY + 3;
    if (t.x < 4 || t.x > 60) {
      t.heading *= -1;
      t.x = Math.max(4, Math.min(60, t.x));
    }
    if (t.y < minY) t.y = minY;
    if (t.y > maxY) t.y = maxY;
  }
}

// ===== Bubble System =====

interface Bubble {
  x: number;
  y: number;
  speed: number;
  wobblePhase: number;
  bright: boolean;
}

let bubbles: Bubble[] = [];

function spawnBubble(surfaceY: number): Bubble {
  return {
    x: 4 + Math.random() * 56,
    y: SAND_TOP - 1 - Math.random() * 4,
    speed: 0.3 + Math.random() * 0.4,
    wobblePhase: Math.random() * Math.PI * 2,
    bright: Math.random() > 0.6,
  };
}

function updateBubbles(frame: number, surfaceY: number, density: number): void {
  // Spawn new bubbles based on density
  const maxBubbles = Math.round(density);
  while (bubbles.length < maxBubbles) {
    bubbles.push(spawnBubble(surfaceY));
  }

  // Update positions
  for (const b of bubbles) {
    b.y -= b.speed;
    b.x += Math.sin(frame * 0.15 + b.wobblePhase) * 0.3;
  }

  // Remove bubbles that reached surface or above
  bubbles = bubbles.filter(b => b.y > surfaceY + 1);

  // Pop surplus
  while (bubbles.length > maxBubbles + 4) {
    bubbles.shift();
  }
}

// ===== Data Particles (PROCESSING only) =====

interface DataParticle {
  x: number;
  y: number;
  vy: number;
  life: number;
  green: boolean;
}

let dataParticles: DataParticle[] = [];

function updateDataParticles(frame: number, surfaceY: number, active: boolean): void {
  if (active && frame % 3 === 0) {
    // Spawn from near surface
    dataParticles.push({
      x: 10 + Math.random() * 44,
      y: surfaceY + 2 + Math.random() * 3,
      vy: 0.4 + Math.random() * 0.3,
      life: 30 + Math.random() * 20,
      green: Math.random() > 0.6,
    });
  }

  for (const p of dataParticles) {
    p.y += p.vy;
    p.x += Math.sin(frame * 0.2 + p.x * 0.3) * 0.4;
    p.life--;
  }

  dataParticles = dataParticles.filter(p =>
    p.life > 0 && p.y < SAND_TOP - 1 && p.y > surfaceY
  );

  // Cap
  if (dataParticles.length > 16) {
    dataParticles.splice(0, dataParticles.length - 16);
  }
}

// ===== Seaweed =====

const SEAWEED_POSITIONS = [
  { x: 2, h: 13, phase: 0 },
  { x: 5, h: 9, phase: 1.2 },
  { x: 8, h: 6, phase: 2.5 },
  { x: 55, h: 12, phase: 0.8 },
  { x: 58, h: 8, phase: 1.9 },
  { x: 61, h: 7, phase: 3.1 },
];

function drawSeaweed(buf: Uint8Array, frame: number, surfaceY: number): void {
  for (const sw of SEAWEED_POSITIONS) {
    const maxHeight = Math.min(sw.h, SAND_TOP - surfaceY - 2);
    if (maxHeight <= 0) continue;

    for (let i = 0; i < maxHeight; i++) {
      // Sway increases with height
      const swayAmount = (i / maxHeight) * 1.5;
      const sway = Math.round(Math.sin(frame * 0.12 + sw.phase + i * 0.4) * swayAmount);
      const color = i % 3 === 0 ? COLORS.seaweedLight
        : i % 2 === 0 ? COLORS.seaweed : COLORS.seaweedDark;
      const px = sw.x + sway;
      const py = SAND_TOP - 1 - i;
      if (py > surfaceY) {
        setPixel(buf, px, py, color);
      }
    }
  }
}

// ===== Light Rays =====

function drawLightRays(buf: Uint8Array, frame: number, surfaceY: number): void {
  // 3 diagonal light shafts from surface, slowly drifting
  const rays = [
    { baseX: 15 + Math.sin(frame * 0.04) * 5, angle: 0.15 },
    { baseX: 35 + Math.sin(frame * 0.03 + 1) * 6, angle: -0.1 },
    { baseX: 50 + Math.sin(frame * 0.05 + 2) * 4, angle: 0.2 },
  ];

  for (const ray of rays) {
    const depth = SAND_TOP - surfaceY;
    for (let d = 2; d < depth - 2; d++) {
      const y = surfaceY + d;
      const x = Math.round(ray.baseX + d * ray.angle);
      const fadeIn = Math.min(1, d / 6);
      const fadeOut = Math.max(0, 1 - d / depth);
      const alpha = fadeIn * fadeOut * 0.2;
      if (alpha > 0.02) {
        glowPixel(buf, x, y, COLORS.lightRay, alpha);
        // Wider beam (±1px with half intensity)
        glowPixel(buf, x - 1, y, COLORS.lightRay, alpha * 0.4);
        glowPixel(buf, x + 1, y, COLORS.lightRay, alpha * 0.4);
      }
    }
  }
}

// ===== Caustics on Sand =====

function drawCaustics(buf: Uint8Array, frame: number, surfaceY: number): void {
  if (surfaceY >= SAND_TOP - 3) return; // No caustics if water too shallow
  for (let x = 1; x < W - 1; x++) {
    const pattern = Math.sin(x * 0.5 + frame * 0.1) * Math.cos(x * 0.3 - frame * 0.07);
    if (pattern > 0.5) {
      const intensity = (pattern - 0.5) * 0.4;
      glowPixel(buf, x, SAND_TOP, COLORS.caustic, intensity);
      glowPixel(buf, x, SAND_TOP + 1, COLORS.caustic, intensity * 0.5);
    }
  }
}

// ===== Surface Waves =====

function drawSurface(
  buf: Uint8Array, frame: number, surfaceY: number,
  palette: WaterPalette, state: State
): void {
  // State-based shimmer color
  const shimmerColor: RGB = state === State.PROCESSING ? COLORS.stateProcessing
    : state === State.AWAITING_OPTION || state === State.AWAITING_PERMISSION || state === State.AWAITING_DIFF
      ? COLORS.stateAwaiting
      : COLORS.stateIdle;

  // Wave parameters vary by state
  const waveSpeed = state === State.PROCESSING ? 0.25 : 0.1;
  const waveAmp = state === State.PROCESSING ? 1.5 : 0.8;
  const shimmerIntensity = state === State.PROCESSING ? 0.35
    : (state === State.AWAITING_OPTION || state === State.AWAITING_PERMISSION || state === State.AWAITING_DIFF)
      ? 0.25 + Math.sin(frame * 0.3) * 0.15  // pulsing
      : 0.15;

  for (let x = 0; x < W; x++) {
    const wave = Math.sin(x * 0.25 + frame * waveSpeed) * waveAmp;
    const wy = surfaceY + Math.round(wave);

    // Surface pixels: bright highlight
    blendPixel(buf, x, wy, palette.surface, 0.8);

    // Wave crest shimmer
    if (wave > waveAmp * 0.3) {
      glowPixel(buf, x, wy, shimmerColor, shimmerIntensity);
    }

    // Foam/sparkle on crests (sparse)
    if (wave > waveAmp * 0.6 && (x + frame) % 5 === 0) {
      glowPixel(buf, x, wy, COLORS.white, 0.15);
    }
  }
}

// ===== Terrain =====

function drawTerrain(buf: Uint8Array): void {
  // Sand layer
  for (let y = SAND_TOP; y <= SAND_BOT; y++) {
    for (let x = 0; x < W; x++) {
      const noise = ((x * 7 + y * 13) % 11);
      const color = noise < 3 ? COLORS.sandLight
        : noise < 7 ? COLORS.sand
          : COLORS.sandDark;
      setPixel(buf, x, y, color);
    }
  }

  // Gravel specks
  const gravelPositions = [8, 15, 22, 29, 37, 44, 51, 57];
  for (const gx of gravelPositions) {
    setPixel(buf, gx, SAND_TOP, COLORS.gravel);
  }

  // Rocks (darker substrate at bottom)
  for (let y = SUBSTRATE_TOP; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const noise = ((x * 11 + y * 7) % 13);
      const color = noise < 4 ? COLORS.rockLight : COLORS.rock;
      setPixel(buf, x, y, color);
    }
  }

  // Larger rock shapes
  const rocks = [
    { x: 12, y: SAND_BOT, w: 4, h: 2 },
    { x: 30, y: SAND_BOT + 1, w: 3, h: 2 },
    { x: 48, y: SAND_BOT, w: 5, h: 3 },
  ];
  for (const r of rocks) {
    for (let dy = 0; dy < r.h; dy++) {
      for (let dx = 0; dx < r.w; dx++) {
        const edge = dx === 0 || dx === r.w - 1 || dy === 0;
        setPixel(buf, r.x + dx, r.y + dy, edge ? COLORS.rockLight : COLORS.rock);
      }
    }
  }
}

// ===== Main Render =====

let animFrame = 0;

function createFrame(): Uint8Array {
  return new Uint8Array(W * W * 3);
}

/** Map state to creature animation state. */
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

/**
 * Render a complete 64×64 frame.
 * Returns 12,288-byte RGB buffer.
 */
export function renderFrame(
  stateEvent: StateUpdateEvent | null,
  usageEvent: UsageEvent | null,
  sessions: SessionInfo[] | null,
): Uint8Array {
  const buf = createFrame();
  animFrame += 6; // big step for visible movement at ~1fps push rate

  const state = stateEvent?.state ?? State.IDLE;
  const usagePct = usageEvent?.fiveHourPercent ?? 0;

  // Fixed water surface — usage encoded via color, not level
  const surfaceY = SURFACE_Y;

  // Water palette
  const palette = getWaterPalette(usagePct);

  // === Layer 1: Water body (fills entire screen above sand) ===
  for (let y = 0; y < SAND_TOP; y++) {
    const color = waterColorAt(palette, surfaceY, y);
    for (let x = 0; x < W; x++) {
      setPixel(buf, x, y, color);
    }
  }

  // === Layer 3: Terrain (sand, rocks — static) ===
  drawTerrain(buf);

  // === Layer 4: Light rays (through water) ===
  drawLightRays(buf, animFrame, surfaceY);

  // === Layer 5: Caustics (on sand) ===
  drawCaustics(buf, animFrame, surfaceY);

  // === Layer 6: Seaweed (animated sway) ===
  drawSeaweed(buf, animFrame, surfaceY);

  // === Layer 7: Bubbles ===
  const bubbleDensity = state === State.PROCESSING ? 10
    : state === State.IDLE ? 3 : 5;
  updateBubbles(animFrame, surfaceY, bubbleDensity);
  for (const b of bubbles) {
    const bx = Math.round(b.x);
    const by = Math.round(b.y);
    const color = b.bright ? COLORS.bubbleBright : COLORS.bubble;
    blendPixel(buf, bx, by, color, 0.6);
  }

  // === Layer 8: Data particles (PROCESSING only) ===
  updateDataParticles(animFrame, surfaceY, state === State.PROCESSING);
  for (const p of dataParticles) {
    const px = Math.round(p.x);
    const py = Math.round(p.y);
    const fadeAlpha = Math.min(1, p.life / 10);
    const color = p.green ? COLORS.dataParticleGreen : COLORS.dataParticle;
    glowPixel(buf, px, py, color, 0.5 * fadeAlpha);
  }

  // === Layer 9: Tetras ===
  const tetraMaxY = SAND_TOP - 3;
  updateTetras(animFrame, surfaceY, tetraMaxY);
  if (tetras) {
    for (const t of tetras) {
      drawTetra(buf, Math.round(t.x), Math.round(t.y), t.heading);
    }
  }

  // === Layer 10: Creatures ===
  const cState = creatureState(state);

  // Octopus Y adapts to water level (stays in water, never below sand)
  const waterMidY = Math.round((surfaceY + SAND_TOP) / 2);
  const octopusBaseY = Math.min(waterMidY - 2, SAND_TOP - 12);
  const octopusY = Math.max(surfaceY + 3, octopusBaseY);

  const sessionCount = sessions?.filter(s => s.alive && s.agentType === 'claude-code').length ?? 1;
  const hasGateway = stateEvent?.gatewayAvailable ?? false;

  if (sessionCount <= 1) {
    // Single octopus centered
    const octoX = hasGateway ? 22 : 28;
    drawOctopus(buf, octoX, octopusY, cState, animFrame);
  } else {
    // Multiple octopuses spread horizontally
    const spacing = Math.min(14, Math.floor(40 / sessionCount));
    const startX = Math.round(32 - (sessionCount * spacing) / 2);
    for (let i = 0; i < Math.min(sessionCount, 4); i++) {
      const jitterY = Math.round(Math.sin(i * 2.3) * 2);
      const st = i === 0 ? cState : 'idle';
      drawOctopus(buf, startX + i * spacing, octopusY + jitterY, st, animFrame + i * 5);
    }
  }

  // Crayfish (9×12px — needs more clearance from sand)
  if (hasGateway) {
    const routing = sessions?.some(s =>
      s.agentType === 'openclaw' && s.state === 'processing'
    ) ?? false;
    const cfY = Math.min(octopusY + 4, SAND_TOP - 14);
    drawCrayfish(buf, 46, Math.max(surfaceY + 3, cfY), routing, animFrame);
  }

  // === Layer 11: Surface waves + state shimmer ===
  drawSurface(buf, animFrame, surfaceY, palette, state);

  // === Layer 12: Danger flash (>90% usage) ===
  if (usagePct >= 90) {
    const flashIntensity = (Math.sin(animFrame * 0.4) + 1) * 0.08;
    for (let y = surfaceY; y < SAND_TOP; y++) {
      for (let x = 0; x < W; x++) {
        glowPixel(buf, x, y, COLORS.stateError, flashIntensity);
      }
    }
  }

  return buf;
}

/**
 * Render IDLE breathing animation frames.
 * 8 frames for smooth loop, uploaded as device-side GIF.
 */
export function renderIdleAnimation(
  stateEvent: StateUpdateEvent | null,
  usageEvent: UsageEvent | null,
  sessions: SessionInfo[] | null,
): Uint8Array[] {
  const frames: Uint8Array[] = [];
  const savedFrame = animFrame;

  for (let i = 0; i < 8; i++) {
    frames.push(renderFrame(stateEvent, usageEvent, sessions));
  }

  animFrame = savedFrame + 48;
  return frames;
}
