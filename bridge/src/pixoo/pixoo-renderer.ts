/**
 * Pixoo64 Frame Renderer — camera-based animated terrarium.
 *
 * No text. All information encoded visually:
 *
 *   Water color  ↔  usage zone (blue → teal → amber → red)
 *   Waves        ↔  agent state (calm=IDLE, choppy=PROC, golden pulse=AWAITING)
 *   Bubbles      ↔  activity density
 *   Creatures    ↔  sessions + gateway
 *   Particles    ↔  data flow during processing
 *   Surface glow ↔  state color (green / blue / amber)
 *   Camera zoom  ↔  state-driven focus (wide, octopus close-up, crayfish, school, surface)
 *
 * Rendering pipeline:
 *   1. Environment → 64×64 world buffer (water, terrain, effects)
 *   2. blitWithCamera() → output buffer (crop + scale by camera zoom/pan)
 *   3. Scaled creatures → output buffer (HD grid sprites with camera-aware sizing)
 *   4. Screen-space overlays (danger flash) → output buffer
 */

import { State } from '../types.js';
import type { StateUpdateEvent, UsageEvent } from '../types.js';
import type { SessionInfo } from '@agentdeck/shared/protocol';
import {
  type RGB, COLORS, setPixel, blendPixel, glowPixel, fillRect, lerpColor,
  drawOctopus, drawCrayfish, drawTetra,
  OCTO_WORLD_W, CF_WORLD_W,
} from './pixoo-sprites.js';
import {
  type Camera, CAMERA_WIDE, blitWithCamera,
  updateDirector, setZone, setOverride, resetDirector,
  worldToScreen, isVisible,
} from './pixoo-camera.js';

const W = 64;

// ===== Layout (world-buffer pixel coords) =====
const SAND_TOP = 54;
const SAND_BOT = 59;
const SUBSTRATE_TOP = 60;
const SURFACE_Y = 2;

// ===== Creature World Positions (normalized 0~1) =====
const OCTO_DEFAULT_X = 0.38;
const OCTO_DEFAULT_Y = 0.45;
const OCTO_GATEWAY_X = 0.34; // shift left when gateway present
const CF_DEFAULT_X = 0.72;
const CF_DEFAULT_Y = 0.58;

// ===== Water Color Zones =====

interface WaterPalette {
  surface: RGB; light: RGB; mid: RGB; deep: RGB;
}

const ZONE_BLUE: WaterPalette = {
  surface: COLORS.waterSurface, light: COLORS.waterLight,
  mid: COLORS.waterMid, deep: COLORS.waterDeep,
};
const ZONE_TEAL: WaterPalette = {
  surface: COLORS.waterTealSurface, light: COLORS.waterTealLight,
  mid: COLORS.waterTealMid, deep: COLORS.waterTealDeep,
};
const ZONE_AMBER: WaterPalette = {
  surface: COLORS.waterAmberSurface, light: COLORS.waterAmberLight,
  mid: COLORS.waterAmberMid, deep: COLORS.waterAmberDeep,
};
const ZONE_RED: WaterPalette = {
  surface: COLORS.waterRedSurface, light: COLORS.waterRedLight,
  mid: COLORS.waterRedMid, deep: COLORS.waterRedDeep,
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
  const t = (y - surfaceY) / waterDepth;
  if (t < 0.25) return lerpColor(palette.surface, palette.light, t / 0.25);
  if (t < 0.6) return lerpColor(palette.light, palette.mid, (t - 0.25) / 0.35);
  return lerpColor(palette.mid, palette.deep, (t - 0.6) / 0.4);
}

// ===== Tetra School =====

interface TetraState {
  x: number; y: number; heading: number; speed: number;
  phase: number; schoolId: number;
}

const NUM_TETRAS = 14;
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
      schoolId: i < 7 ? 0 : 1,
    });
  }
  return result;
}

function updateTetras(frame: number, surfaceY: number, maxY: number): void {
  if (!tetras) tetras = initTetras();

  // Two school centers via Lissajous (meet and diverge every ~25s)
  const sc0X = 24 + Math.sin(frame * 0.04) * 16;
  const sc0Y = Math.max(surfaceY + 8, 22) + Math.cos(frame * 0.03) * 8;
  const sc1X = 40 + Math.sin(frame * 0.035 + 2) * 16;
  const sc1Y = Math.max(surfaceY + 8, 24) + Math.cos(frame * 0.045 + 1) * 8;
  const centers = [{ x: sc0X, y: sc0Y }, { x: sc1X, y: sc1Y }];

  for (const t of tetras) {
    const sc = centers[t.schoolId];
    const dx = sc.x - t.x;
    const dy = sc.y - t.y;

    // Cohesion + individual motion
    t.x += dx * 0.03 + t.heading * t.speed;
    t.y += dy * 0.03 + Math.sin(frame * 0.1 + t.phase) * 0.4;

    // Boundary
    const minY = surfaceY + 3;
    if (t.x < 3 || t.x > 61) {
      t.heading *= -1;
      t.x = Math.max(3, Math.min(61, t.x));
    }
    if (t.y < minY) t.y = minY;
    if (t.y > maxY) t.y = maxY;
  }
}

/** Average position of all tetras (normalized 0~1). */
function getSchoolCenter(): { x: number; y: number } {
  if (!tetras || tetras.length === 0) return { x: 0.5, y: 0.4 };
  let sx = 0, sy = 0;
  for (const t of tetras) { sx += t.x; sy += t.y; }
  return { x: sx / tetras.length / W, y: sy / tetras.length / W };
}

// ===== Bubble System =====

interface Bubble {
  x: number; y: number; speed: number; wobblePhase: number; bright: boolean;
}

let bubbles: Bubble[] = [];

function spawnBubble(): Bubble {
  return {
    x: 4 + Math.random() * 56,
    y: SAND_TOP - 1 - Math.random() * 4,
    speed: 0.3 + Math.random() * 0.4,
    wobblePhase: Math.random() * Math.PI * 2,
    bright: Math.random() > 0.6,
  };
}

function updateBubbles(frame: number, surfaceY: number, density: number): void {
  const maxBubbles = Math.round(density);
  while (bubbles.length < maxBubbles) bubbles.push(spawnBubble());

  for (const b of bubbles) {
    b.y -= b.speed;
    b.x += Math.sin(frame * 0.15 + b.wobblePhase) * 0.3;
  }

  bubbles = bubbles.filter(b => b.y > surfaceY + 1);
  while (bubbles.length > maxBubbles + 4) bubbles.shift();
}

// ===== Data Particles =====

interface DataParticle {
  x: number; y: number; vy: number; life: number; green: boolean;
}

let dataParticles: DataParticle[] = [];

function updateDataParticles(frame: number, surfaceY: number, active: boolean): void {
  if (active && frame % 3 === 0) {
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
  if (dataParticles.length > 16) dataParticles.splice(0, dataParticles.length - 16);
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
      const swayAmount = (i / maxHeight) * 1.5;
      const sway = Math.round(Math.sin(frame * 0.12 + sw.phase + i * 0.4) * swayAmount);
      const color = i % 3 === 0 ? COLORS.seaweedLight
        : i % 2 === 0 ? COLORS.seaweed : COLORS.seaweedDark;
      const px = sw.x + sway;
      const py = SAND_TOP - 1 - i;
      if (py > surfaceY) setPixel(buf, px, py, color);
    }
  }
}

// ===== Light Rays =====

function drawLightRays(buf: Uint8Array, frame: number, surfaceY: number): void {
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
        glowPixel(buf, x - 1, y, COLORS.lightRay, alpha * 0.4);
        glowPixel(buf, x + 1, y, COLORS.lightRay, alpha * 0.4);
      }
    }
  }
}

// ===== Caustics =====

function drawCaustics(buf: Uint8Array, frame: number, surfaceY: number): void {
  if (surfaceY >= SAND_TOP - 3) return;
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
  palette: WaterPalette, state: State,
): void {
  const shimmerColor: RGB = state === State.PROCESSING ? COLORS.stateProcessing
    : state === State.AWAITING_OPTION || state === State.AWAITING_PERMISSION || state === State.AWAITING_DIFF
      ? COLORS.stateAwaiting
      : COLORS.stateIdle;

  const waveSpeed = state === State.PROCESSING ? 0.25 : 0.1;
  const waveAmp = state === State.PROCESSING ? 1.5 : 0.8;
  const shimmerIntensity = state === State.PROCESSING ? 0.35
    : (state === State.AWAITING_OPTION || state === State.AWAITING_PERMISSION || state === State.AWAITING_DIFF)
      ? 0.25 + Math.sin(frame * 0.3) * 0.15
      : 0.15;

  for (let x = 0; x < W; x++) {
    const wave = Math.sin(x * 0.25 + frame * waveSpeed) * waveAmp;
    const wy = surfaceY + Math.round(wave);

    blendPixel(buf, x, wy, palette.surface, 0.8);
    if (wave > waveAmp * 0.3) glowPixel(buf, x, wy, shimmerColor, shimmerIntensity);
    if (wave > waveAmp * 0.6 && (x + frame) % 5 === 0) {
      glowPixel(buf, x, wy, COLORS.white, 0.15);
    }
  }
}

// ===== Terrain =====

function drawTerrain(buf: Uint8Array): void {
  for (let y = SAND_TOP; y <= SAND_BOT; y++) {
    for (let x = 0; x < W; x++) {
      const noise = ((x * 7 + y * 13) % 11);
      const color = noise < 3 ? COLORS.sandLight : noise < 7 ? COLORS.sand : COLORS.sandDark;
      setPixel(buf, x, y, color);
    }
  }

  const gravelPositions = [8, 15, 22, 29, 37, 44, 51, 57];
  for (const gx of gravelPositions) setPixel(buf, gx, SAND_TOP, COLORS.gravel);

  for (let y = SUBSTRATE_TOP; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const noise = ((x * 11 + y * 7) % 13);
      setPixel(buf, x, y, noise < 4 ? COLORS.rockLight : COLORS.rock);
    }
  }

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
let lastRenderTime = 0;

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

function simplifiedState(state: State): 'idle' | 'processing' | 'awaiting' {
  switch (state) {
    case State.PROCESSING: return 'processing';
    case State.AWAITING_OPTION:
    case State.AWAITING_PERMISSION:
    case State.AWAITING_DIFF:
      return 'awaiting';
    default: return 'idle';
  }
}

/**
 * Render a complete 64×64 frame with camera system.
 * Returns 12,288-byte RGB buffer.
 */
export function renderFrame(
  stateEvent: StateUpdateEvent | null,
  usageEvent: UsageEvent | null,
  sessions: SessionInfo[] | null,
): Uint8Array {
  const worldBuf = new Uint8Array(W * W * 3);
  const outputBuf = new Uint8Array(W * W * 3);
  animFrame += 4; // smoother transitions (was 6 — too jumpy)

  const state = stateEvent?.state ?? State.IDLE;
  const usagePct = usageEvent?.fiveHourPercent ?? 0;
  const surfaceY = SURFACE_Y;
  const palette = getWaterPalette(usagePct);

  const hasGateway = stateEvent?.gatewayAvailable ?? false;
  const sessionCount = sessions?.filter(s => s.alive && s.agentType === 'claude-code').length ?? 1;

  // === Compute creature world positions ===
  const octoX = hasGateway ? OCTO_GATEWAY_X : OCTO_DEFAULT_X;
  const octoY = OCTO_DEFAULT_Y;
  const cfX = CF_DEFAULT_X;
  const cfY = CF_DEFAULT_Y;

  // === Update camera director ===
  const dt = 1.2; // approximate seconds between frames at Pixoo push rate
  const schoolPos = getSchoolCenter();
  const camera = updateDirector(
    simplifiedState(state), dt, hasGateway,
    { x: octoX, y: octoY },
    schoolPos,
  );

  // ========================================
  // Phase 1: Render environment → world buffer
  // ========================================

  // Water body
  for (let y = 0; y < SAND_TOP; y++) {
    const color = waterColorAt(palette, surfaceY, y);
    for (let x = 0; x < W; x++) setPixel(worldBuf, x, y, color);
  }

  // Terrain
  drawTerrain(worldBuf);

  // Light rays
  drawLightRays(worldBuf, animFrame, surfaceY);

  // Caustics
  drawCaustics(worldBuf, animFrame, surfaceY);

  // Seaweed
  drawSeaweed(worldBuf, animFrame, surfaceY);

  // Bubbles
  const bubbleDensity = state === State.PROCESSING ? 10 : state === State.IDLE ? 3 : 5;
  updateBubbles(animFrame, surfaceY, bubbleDensity);
  for (const b of bubbles) {
    const bx = Math.round(b.x);
    const by = Math.round(b.y);
    blendPixel(worldBuf, bx, by, b.bright ? COLORS.bubbleBright : COLORS.bubble, 0.6);
  }

  // Data particles
  updateDataParticles(animFrame, surfaceY, state === State.PROCESSING);
  for (const p of dataParticles) {
    const fadeAlpha = Math.min(1, p.life / 10);
    const color = p.green ? COLORS.dataParticleGreen : COLORS.dataParticle;
    glowPixel(worldBuf, Math.round(p.x), Math.round(p.y), color, 0.5 * fadeAlpha);
  }

  // Tetras — update always, but world-buffer draw only at low zoom (prevents double-render)
  const tetraMaxY = SAND_TOP - 3;
  updateTetras(animFrame, surfaceY, tetraMaxY);

  // Surface waves
  drawSurface(worldBuf, animFrame, surfaceY, palette, state);

  // ========================================
  // Phase 2: Blit world → output with camera
  // ========================================
  blitWithCamera(worldBuf, outputBuf, camera);

  // ========================================
  // Phase 3: Draw scaled creatures → output
  // ========================================
  const cState = creatureState(state);

  // Tetras (camera-scaled, drawn on top of blitted environment for crispness)
  if (tetras) {
    for (const t of tetras) {
      drawTetra(outputBuf, t.x / W, t.y / W, t.heading, camera);
    }
  }

  // Octopus(es)
  if (sessionCount <= 1) {
    drawOctopus(outputBuf, octoX, octoY, cState, animFrame, camera);
  } else {
    const spacing = Math.min(0.18, 0.6 / sessionCount);
    const startX = 0.5 - (sessionCount * spacing) / 2;
    for (let i = 0; i < Math.min(sessionCount, 4); i++) {
      const jitterY = Math.sin(i * 2.3) * 0.03;
      const st = i === 0 ? cState : 'idle';
      drawOctopus(outputBuf, startX + i * spacing, octoY + jitterY, st, animFrame + i * 5, camera);
    }
  }

  // Crayfish
  if (hasGateway) {
    const routing = sessions?.some(s =>
      s.agentType === 'openclaw' && s.state === 'processing'
    ) ?? false;
    drawCrayfish(outputBuf, cfX, cfY, routing, animFrame, camera);
  }

  // ========================================
  // Phase 4: Screen-space overlays
  // ========================================

  // Danger flash (>90% usage)
  if (usagePct >= 90) {
    const flashIntensity = (Math.sin(animFrame * 0.4) + 1) * 0.08;
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        glowPixel(outputBuf, x, y, COLORS.stateError, flashIntensity);
      }
    }
  }

  return outputBuf;
}

/**
 * Render IDLE breathing animation frames.
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

  animFrame = savedFrame + 32; // 8 frames × step 4
  return frames;
}

// ===== Preview API (re-export camera controls) =====
export { setZone, setOverride, resetDirector } from './pixoo-camera.js';
export type { Camera } from './pixoo-camera.js';
export { ZONES } from './pixoo-camera.js';
