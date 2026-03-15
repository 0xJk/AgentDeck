/**
 * TUI Terrarium — Unicode Braille aquarium animation.
 * Creature behavior matches Android/iOS/ESP32:
 * - IDLE/SLEEPING: octopus rests on sea floor (touching sand), gentle bob
 * - PROCESSING: octopus swims upward with starburst, tetra school converges
 * - AWAITING: octopus mid-water with "?" bubble
 * - Crayfish: larger than octopus, right side, heartbeat(sitting)/active(routing)
 * - Tetra: 2 schools (5 each), Lissajous centers, boids cohesion
 * - Scaling: small (default) / large (2×) based on terminal size
 */

import { fg, bg, RESET, DIM, colors } from './ansi.js';

// ===== Braille Renderer =====

const BRAILLE_BASE = 0x2800;
const BRAILLE_MAP = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
];

function gridToBraille(grid: boolean[][], width: number, height: number): string[] {
  const charRows = Math.ceil(height / 4);
  const charCols = Math.ceil(width / 2);
  const result: string[] = [];
  for (let cr = 0; cr < charRows; cr++) {
    let row = '';
    for (let cc = 0; cc < charCols; cc++) {
      let code = 0;
      for (let dx = 0; dx < 2; dx++) {
        for (let dy = 0; dy < 4; dy++) {
          const gx = cc * 2 + dx;
          const gy = cr * 4 + dy;
          if (gy < height && gx < width && grid[gy]?.[gx]) {
            code |= BRAILLE_MAP[dx][dy];
          }
        }
      }
      row += String.fromCharCode(BRAILLE_BASE + code);
    }
    result.push(row);
  }
  return result;
}

// ===== Sprite Scaling =====

type SpriteScale = 'small' | 'large' | 'xlarge';

function getSpriteScale(width: number, height: number): SpriteScale {
  if (width >= 160 && height >= 35) return 'xlarge';
  if (width >= 100 && height >= 20) return 'large';
  return 'small';
}

function scaleGridN(grid: number[][], n: number): number[][] {
  const scaled: number[][] = [];
  for (const row of grid) {
    const scaledRow: number[] = [];
    for (const cell of row) {
      for (let i = 0; i < n; i++) scaledRow.push(cell);
    }
    for (let i = 0; i < n; i++) scaled.push([...scaledRow]);
  }
  return scaled;
}

// ===== Octopus Sprite =====
// Small: 14×5 pixel → 7×2 braille, Large: 28×10 → 14×3 braille

const OCTOPUS_GRID_SMALL: number[][] = [
  [0,0,0,0,1,1,1,1,1,1,0,0,0,0],
  [0,0,0,1,1,2,1,1,2,1,1,0,0,0],
  [0,0,3,1,1,1,1,1,1,1,1,4,0,0],
  [0,0,0,5,1,1,1,1,1,1,6,0,0,0],
  [0,0,0,0,5,0,5,6,0,6,0,0,0,0],
];

export interface OctopusInstance {
  id: string;   // unique session identifier
  x: number;
  y: number;
  homeX: number;
  state: string;
  name?: string;
  phaseOffset: number;
}

function renderOctopus(inst: OctopusInstance, frame: number, scale: SpriteScale): { braille: string[]; color: string } {
  const f = frame + inst.phaseOffset;
  const srcGrid = scale === 'xlarge' ? OCTOPUS_GRID_XLARGE :
                  scale === 'large' ? OCTOPUS_GRID_LARGE : OCTOPUS_GRID_SMALL;
  const gh = srcGrid.length;
  const gw = srcGrid[0].length;
  const grid: boolean[][] = [];
  for (let y = 0; y < gh; y++) {
    grid[y] = [];
    for (let x = 0; x < gw; x++) {
      const cell = srcGrid[y][x];
      if (cell === 0) {
        grid[y][x] = false;
      } else if (cell === 2) {
        grid[y][x] = (f % 40) > 3;
      } else if (cell === 3 || cell === 4) {
        if (inst.state === 'processing') {
          const armPhase = cell === 3 ? 0 : Math.PI;
          grid[y][x] = Math.sin(f * 0.3 + armPhase) > -0.3;
        } else {
          grid[y][x] = true;
        }
      } else if (cell === 5 || cell === 6) {
        const legPhase = cell === 5 ? 0 : Math.PI * 0.5;
        grid[y][x] = Math.sin(f * 0.1 + legPhase) > -0.7;
      } else {
        grid[y][x] = true;
      }
    }
  }
  const braille = gridToBraille(grid, gw, gh);
  const color = inst.state === 'disconnected' ? DIM + colors.octopus : colors.octopus;
  return { braille, color };
}

// ===== Crayfish Sprite =====
// Small: 16×8 pixel → 8×2 braille, Large: 32×16 → 16×4 braille

const CRAYFISH_GRID_SMALL: number[][] = [
  [0,0,0,1,0,0,0,0,0,0,1,0,0,0,0,0], // antennae
  [0,0,1,1,0,0,0,0,0,0,1,1,0,0,0,0], // antenna stems
  [0,1,1,0,0,0,0,0,0,0,0,1,1,0,0,0], // claws open
  [0,0,1,1,1,1,1,1,1,1,1,1,0,0,0,0], // body top
  [0,0,0,1,1,1,1,1,1,1,1,0,0,0,0,0], // body mid
  [0,0,0,0,1,1,1,1,1,1,0,0,0,0,0,0], // body bottom
  [0,0,0,1,0,1,0,0,1,0,1,0,0,0,0,0], // legs
  [0,0,1,0,0,0,1,1,0,0,0,1,0,0,0,0], // tail legs
];

// Pre-compute scaled grids (2× and 3× each axis)
const OCTOPUS_GRID_LARGE = scaleGridN(OCTOPUS_GRID_SMALL, 2);
const OCTOPUS_GRID_XLARGE = scaleGridN(OCTOPUS_GRID_SMALL, 3);
const CRAYFISH_GRID_LARGE = scaleGridN(CRAYFISH_GRID_SMALL, 2);
const CRAYFISH_GRID_XLARGE = scaleGridN(CRAYFISH_GRID_SMALL, 3);

interface CrayfishState {
  visible: boolean;
  routing: boolean;
  x: number;
  y: number;
  name?: string;
}

function renderCrayfish(state: CrayfishState, frame: number, scale: SpriteScale): { braille: string[]; color: string } {
  const srcGrid = scale === 'xlarge' ? CRAYFISH_GRID_XLARGE :
                  scale === 'large' ? CRAYFISH_GRID_LARGE : CRAYFISH_GRID_SMALL;
  const gh = srcGrid.length;
  const gw = srcGrid[0].length;
  const grid: boolean[][] = [];
  for (let y = 0; y < gh; y++) {
    grid[y] = [];
    for (let x = 0; x < gw; x++) {
      const cell = srcGrid[y][x];
      if (!cell) { grid[y][x] = false; continue; }
      // Map back to original row/col for animation logic
      const sf = scale === 'xlarge' ? 3 : scale === 'large' ? 2 : 1;
      const origY = Math.floor(y / sf);
      const origX = Math.floor(x / sf);
      // Antennae wiggle (original rows 0-1)
      if (origY <= 1 && (origX === 3 || origX === 10)) {
        grid[y][x] = state.routing || Math.sin(frame * 0.1 + origX) > -0.3;
      }
      // Claw clap when routing (original row 2)
      else if (origY === 2 && (origX === 1 || origX === 12)) {
        grid[y][x] = !state.routing || (frame % 20 > 5);
      }
      // Leg movement (original rows 6-7)
      else if (origY >= 6) {
        const legPhase = origX * 0.5;
        grid[y][x] = Math.sin(frame * 0.08 + legPhase) > -0.5;
      } else {
        grid[y][x] = true;
      }
    }
  }
  const braille = gridToBraille(grid, gw, gh);
  let color: string;
  if (state.routing) {
    color = colors.crayfish;
  } else {
    // Heartbeat: double-pulse every ~50 frames
    const t = frame % 50;
    const pulse = (t < 5 || (t > 8 && t < 13));
    color = pulse ? colors.crayfish : DIM + colors.crayfish;
  }
  return { braille, color };
}

// ===== Neon Tetra =====

interface Fish { x: number; y: number; vx: number; vy: number; }
interface FishSchool { fish: Fish[]; centerX: number; centerY: number; }

function initSchool(count: number, seed: number): FishSchool {
  const fish: Fish[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    fish.push({
      x: 0.4 + seed * 0.2 + Math.cos(angle) * 0.08,
      y: 0.3 + Math.sin(angle) * 0.06,
      vx: (seed % 2 === 0 ? 1 : -1) * (0.003 + Math.random() * 0.002),
      vy: (Math.random() - 0.5) * 0.002,
    });
  }
  return { fish, centerX: 0.4 + seed * 0.2, centerY: 0.3 + seed * 0.1 };
}

function updateSchool(
  school: FishSchool, frame: number, seed: number,
  attractTarget?: { x: number; y: number },
): void {
  const t = frame * 0.015;
  school.centerX = 0.3 + 0.25 * Math.sin(t * (1.0 + seed * 0.4));
  school.centerY = 0.2 + 0.18 * Math.cos(t * (0.7 + seed * 0.3));

  for (const f of school.fish) {
    let targetX = school.centerX;
    let targetY = school.centerY;
    if (attractTarget) {
      targetX = targetX * 0.7 + attractTarget.x * 0.3;
      targetY = targetY * 0.7 + attractTarget.y * 0.3;
    }
    f.vx += (targetX - f.x) * 0.008;
    f.vy += (targetY - f.y) * 0.008;
    for (const other of school.fish) {
      if (other === f) continue;
      const sx = f.x - other.x, sy = f.y - other.y;
      const dist = Math.sqrt(sx * sx + sy * sy);
      if (dist < 0.05 && dist > 0) {
        f.vx += (sx / dist) * 0.002;
        f.vy += (sy / dist) * 0.002;
      }
    }
    const speed = Math.sqrt(f.vx * f.vx + f.vy * f.vy);
    if (speed > 0.008) { f.vx = (f.vx / speed) * 0.008; f.vy = (f.vy / speed) * 0.008; }
    f.x += f.vx; f.y += f.vy;
    if (f.x > 0.92) { f.x = 0.92; f.vx *= -0.5; }
    if (f.x < 0.03) { f.x = 0.03; f.vx *= -0.5; }
    if (f.y > 0.62) { f.y = 0.62; f.vy *= -0.5; }
    if (f.y < 0.08) { f.y = 0.08; f.vy *= -0.5; }
  }
}

// ===== Environment =====

const WAVE_CHARS = ['~', '\u2248', '\u223F', '~', '\u2248'];
const BUBBLE_CHARS = ['\u00B0', '\u00B7', '\u25CB', '\u25E6'];

interface Bubble { x: number; y: number; char: string; speed: number; }

interface TerrariumContext {
  bubbles: Bubble[];
  schools: FishSchool[];
  octopi: OctopusInstance[];
  crayfish: CrayfishState;
}

export function initTerrarium(): TerrariumContext {
  const bubbles: Bubble[] = [];
  for (let i = 0; i < 8; i++) {
    bubbles.push({
      x: 0.1 + Math.random() * 0.8,
      y: 0.3 + Math.random() * 0.6,
      char: BUBBLE_CHARS[Math.floor(Math.random() * BUBBLE_CHARS.length)],
      speed: 0.008 + Math.random() * 0.015,
    });
  }
  return {
    bubbles,
    schools: [initSchool(5, 0), initSchool(5, 1)],
    octopi: [],
    crayfish: { visible: false, routing: false, x: 0.75, y: 0.88 },
  };
}

export function updateTerrarium(ctx: TerrariumContext, frame: number): void {
  for (const b of ctx.bubbles) {
    b.y -= b.speed;
    b.x += Math.sin(frame * 0.1 + b.x * 10) * 0.003;
    if (b.y < 0.02) {
      b.y = 0.85 + Math.random() * 0.1;
      b.x = 0.1 + Math.random() * 0.8;
    }
  }

  // Attract target: processing octopus > routing crayfish > none
  const activeOct = ctx.octopi.find(o => o.state === 'processing');
  let attractTarget: { x: number; y: number } | undefined;
  if (activeOct) {
    attractTarget = { x: activeOct.x, y: activeOct.y };
  } else if (ctx.crayfish.visible && ctx.crayfish.routing) {
    attractTarget = { x: ctx.crayfish.x, y: ctx.crayfish.y };
  }
  for (let i = 0; i < ctx.schools.length; i++) {
    updateSchool(ctx.schools[i], frame, i, attractTarget);
  }

  // Animate octopi Y — IDLE touches the floor (0.88), PROCESSING swims up
  for (const oct of ctx.octopi) {
    // Target Y: idle/disconnected/sleeping → floor, processing → swimming, awaiting → mid
    const targetY = oct.state === 'processing' ? 0.30 :
                    oct.state.startsWith('awaiting') ? 0.50 :
                    0.88; // idle, disconnected → flush with sand
    oct.y += (targetY - oct.y) * 0.05;
    // Bob: small for idle (resting), larger for swimming
    const bobAmp = oct.state === 'processing' ? 0.02 : 0.005;
    const bobFreq = oct.state === 'processing' ? 0.15 : 0.04;
    oct.y += Math.sin((frame + oct.phaseOffset) * bobFreq) * bobAmp;
  }

  // Crayfish Y: routing swims up, sitting rests on floor
  const crayfishTargetY = ctx.crayfish.routing ? 0.50 : 0.85;
  ctx.crayfish.y += (crayfishTargetY - ctx.crayfish.y) * 0.04;
}

export function setOctopi(
  ctx: TerrariumContext,
  sessions: Array<{ id?: string; state: string; name?: string; agentType?: string }>,
): void {
  const octSessions = sessions.filter(s =>
    (s.agentType as string) !== 'daemon' && (s.agentType as string) !== 'openclaw'
  );
  const count = octSessions.length;
  // Count name occurrences to number duplicates
  const nameCounts = new Map<string, number>();
  for (const s of octSessions) {
    const n = s.name || '';
    nameCounts.set(n, (nameCounts.get(n) || 0) + 1);
  }
  const nameSeq = new Map<string, number>();
  const newOctopi: OctopusInstance[] = [];
  for (let i = 0; i < count; i++) {
    const s = octSessions[i];
    const sid = s.id || `oct-${i}`;
    const baseName = s.name || '';
    const seq = (nameSeq.get(baseName) || 0) + 1;
    nameSeq.set(baseName, seq);
    const displayName = (nameCounts.get(baseName) || 0) > 1
      ? `${baseName} #${seq}` : baseName;
    const homeX = count === 1 ? 0.28 : 0.12 + (i * 0.40) / Math.max(1, count - 1);
    const existing = ctx.octopi.find(o => o.id === sid);
    if (existing) {
      existing.state = s.state;
      existing.name = displayName || undefined;
      existing.homeX = homeX;
      existing.x = homeX;
      newOctopi.push(existing);
    } else {
      newOctopi.push({
        id: sid,
        x: homeX, y: 0.88, homeX,
        state: s.state, name: displayName || undefined,
        phaseOffset: Math.floor(Math.random() * 40),
      });
    }
  }
  ctx.octopi = newOctopi;
}

export function setCrayfish(ctx: TerrariumContext, visible: boolean, routing: boolean, name?: string): void {
  ctx.crayfish.visible = visible;
  ctx.crayfish.routing = routing;
  if (name !== undefined) ctx.crayfish.name = name;
}

// ===== Render Frame =====

export function renderTerrariumFrame(
  ctx: TerrariumContext, width: number, height: number, frame: number,
): string[] {
  if (height < 3 || width < 20) return [];
  const scale = getSpriteScale(width, height);
  const scaleFactor = scale === 'xlarge' ? 3 : scale === 'large' ? 2 : 1;
  const lines: string[] = [];
  const sandRow = height - 2; // sand starts at this row

  for (let row = 0; row < height; row++) {
    const t = row / height;
    const r = Math.floor(10 + t * 20);
    const g = Math.floor(22 + t * 36);
    const bv = Math.floor(40 + t * 55);
    const bgColor = bg(r, g, bv);
    const chars: string[] = new Array(width).fill(' ');
    const charColors: string[] = new Array(width).fill('');

    // Water surface wave (row 0)
    if (row === 0) {
      for (let x = 0; x < width; x++) {
        chars[x] = WAVE_CHARS[(x + frame) % WAVE_CHARS.length];
        charColors[x] = fg(100, 149, 237);
      }
    }

    // Sand/gravel bottom (last 2 rows)
    if (row >= sandRow) {
      for (let x = 0; x < width; x++) {
        const sandChars = row === height - 1 ? '░▒░░░░▒▒░░' : '░░░░▒░░░░░';
        chars[x] = sandChars[(x * 7 + 3) % sandChars.length];
        charColors[x] = colors.sand;
      }
    }

    // Seaweed
    if (row >= height - 5 && row < sandRow) {
      const positions = [0.04, 0.10, 0.18, 0.85, 0.92, 0.97];
      for (const pos of positions) {
        const sx = Math.floor(pos * width);
        if (sx >= 0 && sx < width) {
          const depth = sandRow - row;
          if (depth <= 1) chars[sx] = '\u2502';
          else chars[sx] = Math.sin(frame * 0.05 + pos * 15) > 0 ? '\u2571' : '\u2572';
          charColors[sx] = colors.seaweed;
        }
      }
    }

    // Bubbles
    for (const b of ctx.bubbles) {
      const bx = Math.floor(b.x * width);
      const by = Math.floor(b.y * height);
      if (by === row && bx >= 0 && bx < width) {
        chars[bx] = b.char;
        charColors[bx] = colors.bubble;
      }
    }

    // Fish (scale-aware: small=3, large=5, xlarge=7 chars)
    for (const school of ctx.schools) {
      for (const f of school.fish) {
        const fx = Math.floor(f.x * width);
        const fy = Math.floor(f.y * height);
        const fishStrs = scale === 'xlarge'
          ? (f.vx > 0 ? '>>><>>>' : '<<<><<<')
          : scale === 'large'
          ? (f.vx > 0 ? '>><>>' : '<<><>')
          : (f.vx > 0 ? '><>' : '<><');
        const fishLen = fishStrs.length;
        const midIdx = Math.floor(fishLen / 2);
        if (fy === row && fx >= 1 && fx < width - fishLen + 1) {
          for (let c = 0; c < fishLen; c++) {
            if (fx + c < width) {
              chars[fx + c] = fishStrs[c];
              charColors[fx + c] = c === midIdx ? colors.tetraStripe : colors.tetraNeon;
            }
          }
        }
      }
    }

    // Octopi (scale-aware braille)
    for (const oct of ctx.octopi) {
      const { braille, color } = renderOctopus(oct, frame, scale);
      const octHalfW = Math.floor(braille[0]?.length / 2) || 3;
      const ox = Math.floor(oct.x * width) - octHalfW;
      const oy = Math.floor(oct.y * height) - Math.floor(braille.length / 2);
      for (let br = 0; br < braille.length; br++) {
        if (oy + br === row) {
          for (let bc = 0; bc < braille[br].length; bc++) {
            const px = ox + bc;
            if (px >= 0 && px < width) {
              chars[px] = braille[br][bc];
              charColors[px] = color;
            }
          }
        }
      }
      // Name tag — directly above braille sprite
      if (oct.name && oy - 1 === row) {
        const name = oct.name.length > 12 ? oct.name.slice(0, 11) + '\u2026' : oct.name;
        const nx = Math.floor(oct.x * width) - Math.floor(name.length / 2);
        for (let nc = 0; nc < name.length; nc++) {
          const px = nx + nc;
          if (px >= 0 && px < width) { chars[px] = name[nc]; charColors[px] = fg(180, 180, 180); }
        }
      }
      // "?" bubble — same row as name tag, offset right
      if (oct.state.startsWith('awaiting') && oy - 1 === row) {
        const qx = Math.floor(oct.x * width) + octHalfW + 2;
        if (qx >= 0 && qx < width) { chars[qx] = '?'; charColors[qx] = fg(255, 255, 100); }
      }
      // Starburst particles
      if (oct.state === 'processing') {
        const burstR = (2 + (frame % 8) * 0.3) * (scaleFactor * 0.75);
        for (let p = 0; p < 6; p++) {
          const angle = (p / 6) * Math.PI * 2 + frame * 0.15;
          const px = Math.floor(oct.x * width + Math.cos(angle) * burstR);
          const py = Math.floor(oct.y * height + Math.sin(angle) * burstR * 0.5);
          if (py === row && px >= 0 && px < width) {
            chars[px] = '\u2727'; charColors[px] = fg(255, 200, 100);
          }
        }
      }
    }

    // Crayfish (scale-aware braille)
    if (ctx.crayfish.visible) {
      const { braille, color } = renderCrayfish(ctx.crayfish, frame, scale);
      const cfHalfW = Math.floor(braille[0]?.length / 2) || 4;
      const cx = Math.floor(ctx.crayfish.x * width) - cfHalfW;
      const cy = Math.floor(ctx.crayfish.y * height) - Math.floor(braille.length / 2);
      for (let br = 0; br < braille.length; br++) {
        if (cy + br === row) {
          for (let bc = 0; bc < braille[br].length; bc++) {
            const px = cx + bc;
            if (px >= 0 && px < width) {
              chars[px] = braille[br][bc];
              charColors[px] = color;
            }
          }
        }
      }
      // Crayfish name tag — directly above braille sprite
      const cfName = ctx.crayfish.name || 'OpenClaw';
      if (cy - 1 === row) {
        const nx = Math.floor(ctx.crayfish.x * width) - Math.floor(cfName.length / 2);
        for (let nc = 0; nc < cfName.length; nc++) {
          const px = nx + nc;
          if (px >= 0 && px < width) { chars[px] = cfName[nc]; charColors[px] = fg(180, 180, 180); }
        }
      }

      // Signal wave rings + orbiting dots when ROUTING
      if (ctx.crayfish.routing) {
        const cfCenterX = ctx.crayfish.x * width;
        const cfCenterY = ctx.crayfish.y * height;
        const waveScale = scaleFactor * 0.75;
        const waveChars = ['\u25E6', '\u00B7', '\u2219']; // ◦ · ∙

        // 3 concentric signal wave rings, expanding outward
        for (let ring = 0; ring < 3; ring++) {
          const ringPhase = (frame * 0.12 + ring * 2.1) % 6;
          const radius = (2 + ringPhase) * waveScale;
          // Semi-circle (upper half — signals radiate upward/outward)
          for (let p = 0; p < 8; p++) {
            const angle = (p / 8) * Math.PI + Math.PI; // upper semicircle
            const px = Math.floor(cfCenterX + Math.cos(angle) * radius);
            const py = Math.floor(cfCenterY + Math.sin(angle) * radius * 0.5);
            if (py === row && px >= 0 && px < width && chars[px] === ' ') {
              chars[px] = waveChars[ring];
              // Fade opacity with distance
              const fade = Math.max(0, 1 - ringPhase / 6);
              const r = Math.floor(255 * fade);
              const g = Math.floor(107 * fade);
              const b = Math.floor(107 * fade);
              charColors[px] = fg(Math.max(r, 60), Math.max(g, 30), Math.max(b, 30));
            }
          }
        }

        // 4 orbiting signal dots (cyan ✦ — contrasts with octopus gold ✧)
        for (let d = 0; d < 4; d++) {
          const orbitAngle = (d / 4) * Math.PI * 2 + frame * 0.2;
          const orbitRx = (3.5 + Math.sin(frame * 0.08) * 0.5) * waveScale;
          const orbitRy = (1.8 + Math.cos(frame * 0.08) * 0.3) * waveScale;
          const px = Math.floor(cfCenterX + Math.cos(orbitAngle) * orbitRx);
          const py = Math.floor(cfCenterY + Math.sin(orbitAngle) * orbitRy);
          if (py === row && px >= 0 && px < width && chars[px] === ' ') {
            chars[px] = '\u2726'; // ✦
            charColors[px] = colors.tetraNeon;
          }
        }
      }
    }

    // Build line
    let line = bgColor;
    for (let x = 0; x < width; x++) {
      line += charColors[x] ? charColors[x] + chars[x] : chars[x];
    }
    line += RESET;
    lines.push(line);
  }
  return lines;
}
