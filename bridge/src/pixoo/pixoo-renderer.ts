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
  drawOctopus, drawJellyfish, drawCrayfish, drawTetra,
  drawText,
  getOctopusPaletteForSession, getJellyfishPaletteForSession,
  OCTO_WORLD_W, JF_WORLD_W, CF_WORLD_W,
} from './pixoo-sprites.js';
import {
  type Camera, type ActiveCreature, CAMERA_WIDE, blitWithCamera,
  updateDirector, setZone, setOverride, resetDirector,
  worldToScreen, isVisible,
} from './pixoo-camera.js';

const W = 64;

// Track last render time for accurate dt calculation
let lastRenderTime = 0;

// ===== Layout (world-buffer pixel coords) =====
const SAND_TOP = 54;
const SAND_BOT = 59;
const SUBSTRATE_TOP = 60;
const SURFACE_Y = 2;

// ===== Creature World Positions (normalized 0~1) =====
const CF_DEFAULT_X = 0.72;
const CF_DEFAULT_Y = 0.76; // just above sand line (sitting on ground)

// ===== Creature Instance Management =====

interface CreatureInstance {
  sessionId: string;
  agentType: string;
  creatureType: 'octopus' | 'jellyfish';
  state: 'idle' | 'processing' | 'awaiting';
  worldX: number;
  worldY: number;
  phaseOffset: number;
}

/** Golden ratio constant for position distribution. */
const PHI = (1 + Math.sqrt(5)) / 2;

/** Active creature instances keyed by sessionId. */
const creatureInstances = new Map<string, CreatureInstance>();

/** Agent types that represent coding agents (draw as octopus). */
const CODING_AGENTS = new Set(['claude-code', 'opencode']);
/** Agent types drawn as jellyfish (cloud creature). */
const JELLYFISH_AGENTS = new Set(['codex-cli']);

// Y positions by state — idle nearly on sand, active higher up
const IDLE_Y = 0.78;      // just above sand line (sleeping on ground)
const WORKING_Y = 0.42;   // mid-water (working/starburst)
const ASKING_Y = 0.38;    // slightly higher (room for "?" bubble)

function stateY(state: 'idle' | 'processing' | 'awaiting'): number {
  if (state === 'processing') return WORKING_Y;
  if (state === 'awaiting') return ASKING_Y;
  return IDLE_Y;
}

/**
 * Sync creature instances with current session data.
 * Called every frame to add/remove/update creatures.
 */
/** Check if agent type gets a creature (octopus or jellyfish). */
function isCreatureAgent(agentType: string): boolean {
  return CODING_AGENTS.has(agentType) || JELLYFISH_AGENTS.has(agentType);
}

function creatureTypeFor(agentType: string): 'octopus' | 'jellyfish' {
  return JELLYFISH_AGENTS.has(agentType) ? 'jellyfish' : 'octopus';
}

function syncCreatures(
  sessions: SessionInfo[] | null,
  stateEvent: StateUpdateEvent | null,
): void {
  // Determine which sessions are alive creature agents (octopus or jellyfish)
  const aliveCoding: { id: string; agentType: string; state: string }[] = [];
  if (sessions) {
    for (const s of sessions) {
      if (s.alive && s.agentType && isCreatureAgent(s.agentType)) {
        aliveCoding.push({ id: s.id, agentType: s.agentType, state: s.state ?? 'idle' });
      }
    }
  }

  // If no sessions data, use stateEvent as single session (only for creature agents)
  const stateAgentType = (stateEvent?.agentType ?? 'claude-code') as string;
  if (aliveCoding.length === 0 && stateEvent && isCreatureAgent(stateAgentType)) {
    aliveCoding.push({
      id: '_primary',
      agentType: stateAgentType,
      state: simplifiedState(stateEvent.state ?? State.IDLE),
    });
  }

  // Remove creatures for dead sessions
  for (const id of creatureInstances.keys()) {
    if (!aliveCoding.some(s => s.id === id)) {
      creatureInstances.delete(id);
    }
  }

  // Add/update creatures
  for (let i = 0; i < aliveCoding.length; i++) {
    const s = aliveCoding[i];
    const existing = creatureInstances.get(s.id);
    const sessionState = mapSessionState(s.state);

    if (existing) {
      existing.state = sessionState;
      existing.agentType = s.agentType;
      existing.creatureType = creatureTypeFor(s.agentType);
      // Update Y position based on state (X stays fixed)
      existing.worldY = stateY(sessionState);
    } else {
      // Golden ratio X distribution, Y by state
      const x = aliveCoding.length === 1
        ? 0.38  // single session: classic center-left
        : 0.15 + ((i * PHI) % 1) * 0.70;
      creatureInstances.set(s.id, {
        sessionId: s.id,
        agentType: s.agentType,
        creatureType: creatureTypeFor(s.agentType),
        state: sessionState,
        worldX: x,
        worldY: stateY(sessionState),
        phaseOffset: i * 5,
      });
    }
  }

  // Override primary session state from stateEvent (more precise than polling)
  // Only when stateEvent is from a creature agent — daemon/openclaw report stale IDLE
  const aType = stateEvent?.agentType as string | undefined;
  const isCreature = isCreatureAgent(aType ?? '');
  if (stateEvent && isCreature && aliveCoding.length > 0) {
    const primaryId = aliveCoding[0].id;
    const primary = creatureInstances.get(primaryId);
    if (primary) {
      const st = simplifiedState(stateEvent.state ?? State.IDLE) as 'idle' | 'processing' | 'awaiting';
      primary.state = st;
      primary.worldY = stateY(st);
    }
  }
}

function mapSessionState(state: string): 'idle' | 'processing' | 'awaiting' {
  if (state === 'processing') return 'processing';
  if (state === 'awaiting' || state === 'awaiting_option' || state === 'awaiting_permission' || state === 'awaiting_diff') return 'awaiting';
  return 'idle';
}

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
      speed: 0.08 + Math.random() * 0.12,  // slower — prevents teleporting at ~1fps
      phase: Math.random() * Math.PI * 2,
      schoolId: i < 7 ? 0 : 1,
    });
  }
  return result;
}

function updateTetras(frame: number, surfaceY: number, maxY: number): void {
  if (!tetras) tetras = initTetras();

  // Two school centers via Lissajous (meet and diverge every ~25s)
  const sc0X = 24 + Math.sin(frame * 0.02) * 16;
  const sc0Y = Math.max(surfaceY + 8, 22) + Math.cos(frame * 0.015) * 8;
  const sc1X = 40 + Math.sin(frame * 0.0175 + 2) * 16;
  const sc1Y = Math.max(surfaceY + 8, 24) + Math.cos(frame * 0.0225 + 1) * 8;
  const centers = [{ x: sc0X, y: sc0Y }, { x: sc1X, y: sc1Y }];

  for (const t of tetras) {
    const sc = centers[t.schoolId];
    const dx = sc.x - t.x;
    const dy = sc.y - t.y;

    // Cohesion + individual motion (stronger cohesion for tighter schooling)
    t.x += dx * 0.025 + t.heading * (t.speed * 0.5);
    t.y += dy * 0.025 + Math.sin(frame * 0.05 + t.phase) * 0.2;

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
    b.y -= (b.speed * 0.5);
    b.x += Math.sin(frame * 0.075 + b.wobblePhase) * 0.15;
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
  if (active && frame % 6 === 0) { // spawn half as often
    dataParticles.push({
      x: 10 + Math.random() * 44,
      y: surfaceY + 2 + Math.random() * 3,
      vy: 0.2 + Math.random() * 0.15,
      life: 60 + Math.random() * 40,
      green: Math.random() > 0.6,
    });
  }

  for (const p of dataParticles) {
    p.y += p.vy;
    p.x += Math.sin(frame * 0.1 + p.x * 0.3) * 0.2;
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
      const sway = Math.round(Math.sin(frame * 0.06 + sw.phase + i * 0.4) * swayAmount);
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
    { baseX: 15 + Math.sin(frame * 0.02) * 5, angle: 0.15 },
    { baseX: 35 + Math.sin(frame * 0.015 + 1) * 6, angle: -0.1 },
    { baseX: 50 + Math.sin(frame * 0.025 + 2) * 4, angle: 0.2 },
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
    const pattern = Math.sin(x * 0.5 + frame * 0.05) * Math.cos(x * 0.3 - frame * 0.035);
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

  const waveSpeed = state === State.PROCESSING ? 0.125 : 0.05;
  const waveAmp = state === State.PROCESSING ? 1.5 : 0.8;
  const shimmerIntensity = state === State.PROCESSING ? 0.35
    : (state === State.AWAITING_OPTION || state === State.AWAITING_PERMISSION || state === State.AWAITING_DIFF)
      ? 0.25 + Math.sin(frame * 0.15) * 0.15
      : 0.15;

  for (let x = 0; x < W; x++) {
    const wave = Math.sin(x * 0.25 + frame * waveSpeed) * waveAmp;
    const wy = surfaceY + Math.round(wave);

    blendPixel(buf, x, wy, palette.surface, 0.8);
    if (wave > waveAmp * 0.3) glowPixel(buf, x, wy, shimmerColor, shimmerIntensity);
    if (wave > waveAmp * 0.6 && (Math.floor(x + frame)) % 5 === 0) {
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

// Time-based animation frame — ensures consistent speed regardless of who/how often
// calls renderFrame() (device push vs preview endpoint won't interfere).
// ~10 units/sec (100ms interval) to match 10fps loop.
function getAnimFrame(timeOverrideMs?: number): number {
  return Math.floor((timeOverrideMs ?? Date.now()) / 100); 
}

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

// ===== Usage HUD Helpers =====

/** Gauge bar color based on usage percentage. */
function gaugeColor(pct: number, animFrame: number): RGB {
  if (pct >= 90) {
    // Red with pulse
    const pulse = (Math.sin(animFrame * 0.2) + 1) * 0.3;
    return lerpColor(COLORS.stateError, COLORS.white, pulse) as RGB;
  }
  if (pct >= 70) return COLORS.stateAwaiting;  // amber
  if (pct >= 50) return [0x00, 0xC8, 0xB4] as unknown as RGB;  // teal
  return COLORS.stateProcessing;  // blue
}

/** Pixoo HUD reset time: "1h23", "4d6", "59m". */
function formatResetDetailed(resetsAt: string | undefined): string {
  if (!resetsAt) return '';
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (ms <= 0) return '0m';
  const totalMins = Math.max(1, Math.ceil(ms / 60000));
  const hours = Math.floor(totalMins / 60);
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  const mins = totalMins % 60;
  if (days > 0 && remHours > 0) return `${days}d${remHours}`;
  if (days > 0) return `${days}d`;
  if (hours > 0 && mins > 0) return `${hours}h${mins}`;
  if (hours > 0) return `${hours}h`;
  return `${mins}m`;
}

/** Draw Usage HUD in screen space (bottom right, zoom-independent).
 *  Single row at rows 57-63:
 *    - 7d absent: full-width, right-aligned (original behavior)
 *    - 7d present: left half [0..30]=5h  |  right half [32..63]=7d
 */
function drawUsageHUD(
  buf: Uint8Array, usageEvent: UsageEvent | null, animFrame: number,
): void {
  if (!usageEvent || usageEvent.fiveHourPercent == null) return;

  const textY = 58;
  const bgTop = textY - 1;
  const bgBot = textY + 5;

  // Full-width dark base — hides sand/terrain at HUD rows regardless of camera zoom
  for (let y = bgTop; y <= bgBot; y++) {
    for (let x = 0; x < 64; x++) {
      blendPixel(buf, x, y, COLORS.black, 0.55);
    }
  }

  const timeColor: RGB = [0x60, 0x70, 0x80];

  /** Render a zone: usage background fill + two-color text (pct + time). */
  function renderZone(
    pctText: string, timeText: string, pct: number, leftX: number, rightX: number,
  ): void {
    const color = gaugeColor(pct, animFrame);
    const zoneW = rightX - leftX + 1;
    const fillW = Math.round(zoneW * Math.max(0, Math.min(100, pct)) / 100);
    // Background fill proportional to usage
    for (let y = bgTop; y <= bgBot; y++) {
      for (let x = leftX; x < leftX + fillW; x++) {
        blendPixel(buf, x, y, color, 0.35);
      }
    }
    // Two-color text: time (dimmed) right-aligned, then pct (gauge color) to its left
    if (timeText) {
      drawText(buf, timeText, rightX, textY, timeColor);
      const timeW = timeText.length * 4; // 3px glyph + 1px gap per char
      drawText(buf, pctText, rightX - timeW, textY, color);
    } else {
      drawText(buf, pctText, rightX, textY, color);
    }
  }

  const pct5 = usageEvent.fiveHourPercent;

  if (usageEvent.sevenDayPercent == null) {
    // Single full-width zone
    const r5 = formatResetDetailed(usageEvent.fiveHourResetsAt);
    renderZone(`${Math.round(pct5)}%`, r5, pct5, 0, 63);
    return;
  }

  // Two-column layout: [5h | 7d]
  const pct7 = usageEvent.sevenDayPercent;
  const r5 = formatResetDetailed(usageEvent.fiveHourResetsAt);
  const r7 = formatResetDetailed(usageEvent.sevenDayResetsAt);
  renderZone(`${Math.round(pct5)}%`, r5, pct5, 0, 30);
  renderZone(`${Math.round(pct7)}%`, r7, pct7, 32, 63);
}

/**
 * Render a complete 64×64 frame with camera system.
 * Returns 12,288-byte RGB buffer.
 */
export function renderFrame(
  stateEvent: StateUpdateEvent | null,
  usageEvent: UsageEvent | null,
  sessions: SessionInfo[] | null,
  timeOverrideMs?: number,
): Uint8Array {
  const worldBuf = new Uint8Array(W * W * 3);
  const outputBuf = new Uint8Array(W * W * 3);
  const animFrame = getAnimFrame(timeOverrideMs);

  const state = stateEvent?.state ?? State.IDLE;
  const usagePct = usageEvent?.fiveHourPercent ?? 0;
  const surfaceY = SURFACE_Y;
  const palette = ZONE_BLUE; // Water stays blue — usage shown only via HUD gauge

  // Gateway available: stateEvent flag OR openclaw session in sessions list
  const hasGateway = (stateEvent?.gatewayAvailable ?? false)
    || (sessions?.some(s => s.agentType === 'openclaw') ?? false);

  // === Sync creature instances ===
  syncCreatures(sessions, stateEvent);

  // === Build active creatures list for camera ===
  const activeCreatures: ActiveCreature[] = [];
  for (const c of creatureInstances.values()) {
    if (c.state === 'awaiting') {
      activeCreatures.push({ x: c.worldX, y: c.worldY, priority: 0 });
    } else if (c.state === 'processing') {
      activeCreatures.push({ x: c.worldX, y: c.worldY, priority: 1 });
    }
  }

  // Crayfish routing
  const cfX = CF_DEFAULT_X;
  const cfY = CF_DEFAULT_Y;
  const crayfishRouting = hasGateway && (sessions?.some(s =>
    s.agentType === 'openclaw' && s.state === 'processing'
  ) ?? false);
  if (crayfishRouting) {
    activeCreatures.push({ x: cfX, y: cfY, priority: 2 });
  }

  // === Update camera director ===
  const now = timeOverrideMs ?? Date.now();
  const dt = lastRenderTime > 0 ? Math.min(5, (now - lastRenderTime) / 1000) : 1.0;
  lastRenderTime = now;
  const schoolPos = getSchoolCenter();
  const camera = updateDirector(
    dt, activeCreatures, crayfishRouting,
    hasGateway ? { x: cfX, y: cfY } : null,
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

  // Effective state: prefer creature-derived state over stateEvent (daemon may be stale)
  const anyCreatureProcessing = [...creatureInstances.values()].some(c => c.state === 'processing');
  const anyCreatureAwaiting = [...creatureInstances.values()].some(c => c.state === 'awaiting');
  const effectiveState = anyCreatureProcessing ? State.PROCESSING
    : anyCreatureAwaiting ? State.AWAITING_OPTION
      : state;

  // Bubbles
  const bubbleDensity = effectiveState === State.PROCESSING ? 10 : effectiveState === State.IDLE ? 3 : 5;
  updateBubbles(animFrame, surfaceY, bubbleDensity);
  for (const b of bubbles) {
    const bx = Math.round(b.x);
    const by = Math.round(b.y);
    blendPixel(worldBuf, bx, by, b.bright ? COLORS.bubbleBright : COLORS.bubble, 0.6);
  }

  // Data particles (spawn when any creature is processing)
  const anyProcessing = [...creatureInstances.values()].some(c => c.state === 'processing');
  updateDataParticles(animFrame, surfaceY, anyProcessing);
  for (const p of dataParticles) {
    const fadeAlpha = Math.min(1, p.life / 10);
    const color = p.green ? COLORS.dataParticleGreen : COLORS.dataParticle;
    glowPixel(worldBuf, Math.round(p.x), Math.round(p.y), color, 0.5 * fadeAlpha);
  }

  // Tetras — update always
  const tetraMaxY = SAND_TOP - 3;
  updateTetras(animFrame, surfaceY, tetraMaxY);

  // Surface waves — use effectiveState so daemon doesn't suppress wave animation
  drawSurface(worldBuf, animFrame, surfaceY, palette, effectiveState);

  // ========================================
  // Phase 2: Blit world → output with camera
  // ========================================
  blitWithCamera(worldBuf, outputBuf, camera);

  // ========================================
  // Phase 3: Draw scaled creatures → output
  // ========================================

  // Tetras (always drawn — camera-scaled)
  if (tetras) {
    for (const t of tetras) {
      drawTetra(outputBuf, t.x / W, t.y / W, t.heading, camera);
    }
  }

  // Creature instances — octopus or jellyfish based on agent type
  const creatureOrder = [...creatureInstances.keys()];
  for (const c of creatureInstances.values()) {
    const sessionToneIndex = creatureOrder.indexOf(c.sessionId);
    const spriteState: 'idle' | 'working' | 'sleeping' | 'asking' =
      c.state === 'processing' ? 'working'
        : c.state === 'awaiting' ? 'asking'
          : 'idle'; // IDLE → idle (limbs move, body color preserved)

    if (c.creatureType === 'jellyfish') {
      drawJellyfish(
        outputBuf,
        c.worldX,
        c.worldY,
        spriteState,
        animFrame + c.phaseOffset,
        camera,
        getJellyfishPaletteForSession(sessionToneIndex),
      );
    } else {
      drawOctopus(
        outputBuf,
        c.worldX,
        c.worldY,
        spriteState,
        animFrame + c.phaseOffset,
        camera,
        getOctopusPaletteForSession(sessionToneIndex),
      );
    }
  }

  // Crayfish — always drawn when gateway available; IDLE = sitting (subtle breathing only)
  if (hasGateway) {
    const gatewayHasError = stateEvent?.gatewayHasError ?? false;
    drawCrayfish(outputBuf, cfX, cfY, crayfishRouting, animFrame, camera, gatewayHasError);
  }

  // ========================================
  // Phase 4: Screen-space overlays
  // ========================================

  // Danger flash (>90% usage)
  if (usagePct >= 90) {
    const flashIntensity = (Math.sin(animFrame * 0.2) + 1) * 0.08;
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        glowPixel(outputBuf, x, y, COLORS.stateError, flashIntensity);
      }
    }
  }

  // Session count indicator (top-left, screen-space) — colored dots when 2+ sessions
  const sessionCount = creatureInstances.size;
  if (sessionCount >= 2) {
    const orderedCreatures = [...creatureInstances.values()];
    for (let i = 0; i < Math.min(sessionCount, 6); i++) {
      const dotX = 1 + i * 3;  // 2px dot + 1px gap
      const c = orderedCreatures[i];
      const dotColor = c.creatureType === 'jellyfish'
        ? getJellyfishPaletteForSession(i).body
        : getOctopusPaletteForSession(i).body;
      setPixel(outputBuf, dotX, 1, dotColor);
      setPixel(outputBuf, dotX + 1, 1, dotColor);
      setPixel(outputBuf, dotX, 2, dotColor);
      setPixel(outputBuf, dotX + 1, 2, dotColor);
    }
  }

  // Usage HUD (bottom-right, screen-space)
  drawUsageHUD(outputBuf, usageEvent, animFrame);

  return outputBuf;
}

// ===== Preview API (re-export camera controls) =====
export { setZone, setOverride, resetDirector } from './pixoo-camera.js';
export type { Camera } from './pixoo-camera.js';
export { ZONES } from './pixoo-camera.js';
