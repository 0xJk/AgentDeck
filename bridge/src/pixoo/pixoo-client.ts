/**
 * Pixoo64 HTTP Client — direct REST API for Divoom Pixoo64 LED matrix.
 *
 * Zero dependencies: uses Node 18+ native fetch().
 * All requests have 2s timeout and fail silently (display is non-critical).
 *
 * Frame format: 64×64 RGB = 12,288 bytes → base64 encoded.
 * PicID counter resets every 30 frames to prevent device lockup (~300 cumulative).
 */

import { debug } from '../logger.js';

const TAG = 'Pixoo';
const REQUEST_TIMEOUT_MS = 2000;
const PIC_ID_RESET_INTERVAL = 30;

let frameCounter = 0;

// ===== Circuit Breaker (per-device exponential backoff) =====

const deviceBackoff = new Map<string, { failures: number; backoffUntil: number }>();
const BACKOFF_THRESHOLD = 3;
const BACKOFF_INITIAL_MS = 30_000;  // 30s
const BACKOFF_MAX_MS = 300_000;     // 5m cap

function isBackedOff(ip: string): boolean {
  const entry = deviceBackoff.get(ip);
  if (!entry || entry.failures < BACKOFF_THRESHOLD) return false;
  return Date.now() < entry.backoffUntil;
}

function recordSuccess(ip: string): void {
  deviceBackoff.delete(ip);
}

function recordFailure(ip: string): void {
  const entry = deviceBackoff.get(ip) ?? { failures: 0, backoffUntil: 0 };
  entry.failures++;
  if (entry.failures >= BACKOFF_THRESHOLD) {
    const delay = Math.min(BACKOFF_INITIAL_MS * Math.pow(2, entry.failures - BACKOFF_THRESHOLD), BACKOFF_MAX_MS);
    entry.backoffUntil = Date.now() + delay;
    debug(TAG, `Backoff ${ip}: ${Math.round(delay / 1000)}s (${entry.failures} failures)`);
  }
  deviceBackoff.set(ip, entry);
}

/** Get circuit breaker status for a device. */
export function getDeviceBackoffStatus(ip: string): { failures: number; backedOff: boolean; nextProbeMs: number } {
  const entry = deviceBackoff.get(ip);
  if (!entry) return { failures: 0, backedOff: false, nextProbeMs: 0 };
  const now = Date.now();
  const backedOff = entry.failures >= BACKOFF_THRESHOLD && now < entry.backoffUntil;
  return {
    failures: entry.failures,
    backedOff,
    nextProbeMs: backedOff ? entry.backoffUntil - now : 0,
  };
}

/** POST a command to the Pixoo device. Returns true on success. */
async function postCommand(ip: string, command: Record<string, unknown>): Promise<boolean> {
  if (isBackedOff(ip)) return false;

  try {
    const response = await fetch(`http://${ip}/post`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      debug(TAG, `HTTP ${response.status} from ${ip}`);
      recordFailure(ip);
      return false;
    }
    recordSuccess(ip);
    return true;
  } catch (err: any) {
    debug(TAG, `Request failed to ${ip}: ${err.message}`);
    recordFailure(ip);
    return false;
  }
}

/**
 * Push a single 64×64 RGB frame to the device.
 * @param buffer - 12,288 bytes (64 * 64 * 3) raw RGB
 */
export async function pushFrame(ip: string, buffer: Uint8Array): Promise<boolean> {
  if (buffer.length !== 64 * 64 * 3) {
    debug(TAG, `Invalid frame size: ${buffer.length} (expected 12288)`);
    return false;
  }

  // Reset + PicID 0 every time — ensures device replaces current image
  frameCounter++;
  if (frameCounter >= PIC_ID_RESET_INTERVAL) {
    await resetPicId(ip);
    frameCounter = 0;
  }

  const base64 = Buffer.from(buffer).toString('base64');
  return postCommand(ip, {
    Command: 'Draw/SendHttpGif',
    PicNum: 1,
    PicWidth: 64,
    PicOffset: 0,
    PicID: 0,
    PicSpeed: 100,
    PicData: base64,
  });
}

/**
 * Push a multi-frame animation (device loops internally, no ongoing HTTP needed).
 * @param frames - Array of 12,288-byte RGB buffers
 * @param speedMs - Per-frame display time in milliseconds
 */
export async function pushAnimation(ip: string, frames: Uint8Array[], speedMs: number): Promise<boolean> {
  if (frames.length === 0 || frames.length > 60) {
    debug(TAG, `Invalid frame count: ${frames.length} (max 60)`);
    return false;
  }

  // Reset counter before animation upload
  await resetPicId(ip);
  frameCounter = 0;

  for (let i = 0; i < frames.length; i++) {
    const base64 = Buffer.from(frames[i]).toString('base64');
    const ok = await postCommand(ip, {
      Command: 'Draw/SendHttpGif',
      PicNum: frames.length,
      PicWidth: 64,
      PicOffset: i,
      PicID: i,
      PicSpeed: speedMs,
      PicData: base64,
    });
    if (!ok) return false;
  }
  return true;
}

/**
 * Send scrolling text overlay (device-native font, supports long text).
 * Up to 20 simultaneous text items supported by device.
 * @param textId - 0-19, used to update/remove specific text
 * @param color - hex color string e.g. "#22c55e"
 * @param speed - scroll speed 0-100 (default 50)
 */
export async function sendScrollText(
  ip: string, textId: number, text: string, color: string, speed = 50
): Promise<boolean> {
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);

  return postCommand(ip, {
    Command: 'Draw/SendHttpText',
    TextId: textId,
    x: 0,
    y: 0,
    dir: 0,          // 0=left scroll
    font: 2,         // small built-in font
    TextWidth: 64,
    speed,
    TextString: text,
    color: `#${color.slice(1)}`,
    align: 1,
  });
}

/** Clear all text overlays. */
export async function clearText(ip: string): Promise<boolean> {
  return postCommand(ip, { Command: 'Draw/ClearHttpText' });
}

/** Set display brightness (0-100). */
export async function setBrightness(ip: string, value: number): Promise<boolean> {
  return postCommand(ip, {
    Command: 'Channel/SetBrightness',
    Brightness: Math.max(0, Math.min(100, value)),
  });
}

/** Reset the PicID counter to prevent device lockup. */
export async function resetPicId(ip: string): Promise<boolean> {
  return postCommand(ip, { Command: 'Draw/ResetHttpGifId' });
}

/** Switch device to the custom channel that shows SendHttpGif content. */
export async function switchToCustomChannel(ip: string): Promise<boolean> {
  // SelectIndex: 0=Faces, 1=Cloud, 2=Visualizer, 3=Custom
  return postCommand(ip, { Command: 'Channel/SetIndex', SelectIndex: 3 });
}

/**
 * Get device configuration (also serves as a connectivity test).
 * Returns null on failure.
 */
export async function getDeviceConfig(ip: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`http://${ip}/post`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Command: 'Channel/GetAllConf' }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return await response.json() as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Discover Pixoo devices via Divoom cloud API.
 * Falls back gracefully if cloud is unreachable.
 */
export async function discoverDevices(): Promise<Array<{ name: string; ip: string }>> {
  try {
    const response = await fetch('https://app.divoom-gz.com/Device/ReturnSameLANDevice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return [];
    const data = await response.json() as any;
    if (!data?.DeviceList) return [];
    return data.DeviceList.map((d: any) => ({
      name: d.DeviceName || 'Pixoo',
      ip: d.DevicePrivateIP,
    }));
  } catch {
    return [];
  }
}
