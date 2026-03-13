#!/usr/bin/env npx tsx
/**
 * Pixoo64 Frame Emulator / Preview Tool
 *
 * Renders animation frames from pixoo-renderer and saves as upscaled PNGs
 * for visual inspection. No external image deps — uses PPM + macOS sips.
 *
 * Usage:
 *   npx tsx bridge/scripts/pixoo-preview.ts [options]
 *
 * Options:
 *   --state idle|processing|awaiting   Agent state (default: idle)
 *   --usage 0-100                      5h rate limit % (default: 30)
 *   --frames N                         Number of frames (default: 16)
 *   --open                             Open strip image in Preview
 *   --gateway                          Show crayfish (gateway available)
 */

import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { renderFrame } from '../src/pixoo/pixoo-renderer.js';
import { State, PermissionMode } from '../src/types.js';
import type { StateUpdateEvent, UsageEvent } from '../src/types.js';
import type { SessionInfo } from '@agentdeck/shared/protocol';

// ===== CLI args =====

const args = process.argv.slice(2);

function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return fallback;
  return args[idx + 1];
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

const stateMap: Record<string, State> = {
  idle: State.IDLE,
  processing: State.PROCESSING,
  awaiting: State.AWAITING_OPTION,
  permission: State.AWAITING_PERMISSION,
  diff: State.AWAITING_DIFF,
  disconnected: State.DISCONNECTED,
};

const stateName = getArg('state', 'idle');
const state = stateMap[stateName] ?? State.IDLE;
const usagePct = parseInt(getArg('usage', '30'), 10);
const frameCount = parseInt(getArg('frames', '16'), 10);
const shouldOpen = hasFlag('open');
const hasGateway = hasFlag('gateway');

const W = 64;
const SCALE = 8;
const BIG = W * SCALE; // 512

// ===== Output dir =====

const outDir = '/tmp/pixoo-preview';
if (existsSync(outDir)) rmSync(outDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

// ===== Mock data =====

const stateEvent: StateUpdateEvent = {
  type: 'state_update',
  state,
  permissionMode: PermissionMode.DEFAULT,
  projectName: 'preview',
  modelName: 'opus-4',
  gatewayAvailable: hasGateway,
};

const usageEvent: UsageEvent = {
  type: 'usage_update',
  sessionDurationSec: 600,
  inputTokens: 50000,
  outputTokens: 12000,
  toolCalls: 8,
  fiveHourPercent: usagePct,
};

const sessions: SessionInfo[] = [
  { id: 'preview-1', port: 9120, projectName: 'preview', agentType: 'claude-code', alive: true },
];
if (hasGateway) {
  sessions.push({ id: 'oc-1', port: 18789, projectName: 'preview', agentType: 'openclaw', alive: true, state: 'processing' });
}

// ===== PPM writer (P6 binary, no deps) =====

function writePPM(path: string, width: number, height: number, rgb: Uint8Array): void {
  const header = `P6\n${width} ${height}\n255\n`;
  const headerBuf = Buffer.from(header, 'ascii');
  const out = Buffer.alloc(headerBuf.length + rgb.length);
  headerBuf.copy(out);
  Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength).copy(out, headerBuf.length);
  writeFileSync(path, out);
}

/** Nearest-neighbor upscale an RGB buffer */
function upscale(src: Uint8Array, srcW: number, srcH: number, scale: number): Uint8Array {
  const dstW = srcW * scale;
  const dstH = srcH * scale;
  const dst = new Uint8Array(dstW * dstH * 3);
  for (let y = 0; y < dstH; y++) {
    const sy = Math.floor(y / scale);
    for (let x = 0; x < dstW; x++) {
      const sx = Math.floor(x / scale);
      const srcOff = (sy * srcW + sx) * 3;
      const dstOff = (y * dstW + x) * 3;
      dst[dstOff] = src[srcOff];
      dst[dstOff + 1] = src[srcOff + 1];
      dst[dstOff + 2] = src[srcOff + 2];
    }
  }
  return dst;
}

/** Compose multiple upscaled frames into a horizontal strip */
function makeStrip(frames: Uint8Array[], frameW: number, frameH: number): Uint8Array {
  const totalW = frameW * frames.length;
  const strip = new Uint8Array(totalW * frameH * 3);
  for (let fi = 0; fi < frames.length; fi++) {
    const frame = frames[fi];
    const xOff = fi * frameW;
    for (let y = 0; y < frameH; y++) {
      for (let x = 0; x < frameW; x++) {
        const srcOff = (y * frameW + x) * 3;
        const dstOff = (y * totalW + xOff + x) * 3;
        strip[dstOff] = frame[srcOff];
        strip[dstOff + 1] = frame[srcOff + 1];
        strip[dstOff + 2] = frame[srcOff + 2];
      }
    }
  }
  return strip;
}

/** Count differing pixels between two raw RGB buffers */
function pixelDiff(a: Uint8Array, b: Uint8Array): number {
  let count = 0;
  const pixels = a.length / 3;
  for (let i = 0; i < pixels; i++) {
    const off = i * 3;
    if (a[off] !== b[off] || a[off + 1] !== b[off + 1] || a[off + 2] !== b[off + 2]) {
      count++;
    }
  }
  return count;
}

// ===== Render frames =====

console.log(`Pixoo64 Preview — state=${stateName} usage=${usagePct}% frames=${frameCount} gateway=${hasGateway}`);
console.log(`Output: ${outDir}/\n`);

const rawFrames: Uint8Array[] = [];
const upscaledFrames: Uint8Array[] = [];

for (let i = 0; i < frameCount; i++) {
  const raw = renderFrame(stateEvent, usageEvent, sessions);
  rawFrames.push(raw);

  const big = upscale(raw, W, W, SCALE);
  upscaledFrames.push(big);

  // Save individual frame as PPM, convert to PNG with sips
  const ppmPath = join(outDir, `frame-${String(i).padStart(2, '0')}.ppm`);
  const pngPath = join(outDir, `frame-${String(i).padStart(2, '0')}.png`);
  writePPM(ppmPath, BIG, BIG, big);
  try {
    execSync(`sips -s format png "${ppmPath}" --out "${pngPath}" 2>/dev/null`, { stdio: 'pipe' });
    rmSync(ppmPath); // clean up PPM
  } catch {
    // sips failed — keep PPM as fallback
  }
}

// ===== Pixel diff report =====

console.log('Pixel diff report (64×64 = 4096 pixels):');
const totalPixels = W * W;
let allSame = true;
for (let i = 1; i < rawFrames.length; i++) {
  const diff = pixelDiff(rawFrames[i - 1], rawFrames[i]);
  const pct = ((diff / totalPixels) * 100).toFixed(1);
  const tag = diff === 0 ? ' ⚠ STATIC' : '';
  console.log(`  Frame ${String(i - 1).padStart(2, '0')}→${String(i).padStart(2, '0')}: ${diff} pixels changed (${pct}%)${tag}`);
  if (diff > 0) allSame = false;
}

if (allSame) {
  console.log('\n⚠ WARNING: All frames are identical — animation is not working!');
} else {
  console.log('\n✓ Frames differ — animation is working.');
}

// ===== Strip image =====

const stripBuf = makeStrip(upscaledFrames, BIG, BIG);
const stripPpmPath = join(outDir, 'strip.ppm');
const stripPngPath = join(outDir, 'strip.png');
writePPM(stripPpmPath, BIG * frameCount, BIG, stripBuf);
try {
  execSync(`sips -s format png "${stripPpmPath}" --out "${stripPngPath}" 2>/dev/null`, { stdio: 'pipe' });
  rmSync(stripPpmPath);
  console.log(`\nStrip: ${stripPngPath} (${BIG * frameCount}×${BIG})`);
} catch {
  console.log(`\nStrip (PPM): ${stripPpmPath} (${BIG * frameCount}×${BIG})`);
}

// ===== Individual frame listing =====

const ext = existsSync(join(outDir, 'frame-00.png')) ? 'png' : 'ppm';
console.log(`Frames: ${outDir}/frame-00.${ext} ... frame-${String(frameCount - 1).padStart(2, '0')}.${ext}`);

// ===== Open =====

if (shouldOpen) {
  const target = existsSync(stripPngPath) ? stripPngPath : stripPpmPath;
  console.log(`\nOpening ${target}...`);
  try {
    execSync(`open "${target}"`, { stdio: 'pipe' });
  } catch {
    console.log('  (open command failed — view the file manually)');
  }
}
