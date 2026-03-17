/**
 * Pixoo64 Bridge — event listener + HTTP realtime 2FPS streamer.
 *
 * Real-time continuous streaming approach:
 *   - The device cannot handle real-time HTTP single-frame pushes faster than ~4 FPS.
 *   - Multi-frame loops trigger an unavoidable hardware loading screen.
 *   - Solution: Constantly push `PicNum: 1` with a **static PicId** every 333ms (3 FPS).
 *   - The device will smoothly overwrite its buffer without stalling.
 */

import { State } from '../types.js';
import type { BridgeEvent, StateUpdateEvent, UsageEvent } from '../types.js';
import type { SessionInfo, SessionsListEvent } from '@agentdeck/shared/protocol';
import { DISPLAY_FORWARDED_EVENTS } from '@agentdeck/shared/protocol';
import { pushFrame, setBrightness, clearText, getDeviceBackoffStatus, switchToCustomChannel, onDeviceStatusChange, stopProbeTimer } from './pixoo-client.js';
import { renderFrame } from './pixoo-renderer.js';
import { debug } from '../logger.js';

const TAG = 'Pixoo';

// ===== Configuration =====

export interface PixooDevice {
  ip: string;
  name?: string;
  brightness?: number; // 0-100, default 100
}

// ===== Internal State =====

let devices: PixooDevice[] = [];
let streamTimer: ReturnType<typeof setInterval> | null = null;
let lastPushTime = 0;
let pushing = false; // guard against overlapping pushes

// Cached latest events
let lastStateEvent: StateUpdateEvent | null = null;
let lastUsageEvent: UsageEvent | null = null;
let lastSessions: SessionInfo[] | null = null;

// Display sleep state — when Mac display is off, dim Pixoo and pause stream
let displayDimmed = false;

// Frame listeners for SSE streaming
let frameListeners: Array<(frame: Uint8Array) => void> = [];
let previewTimer: ReturnType<typeof setInterval> | null = null;
let previewFps = 10; // Adjustable 1–10 FPS for /pixoo live preview

const HTTP_STREAM_INTERVAL_MS = 333;     // 3 FPS hardware push (smooth animation, stable on Pixoo64)
const CHANNEL_REASSERT_MS = 30_000;     // Re-assert custom channel every 30s (fast recovery after reboots)
const DEFAULT_BRIGHTNESS = 100;

const FORWARDED_EVENTS = DISPLAY_FORWARDED_EVENTS;

// Broadcast function injected by module for sending status notifications
let broadcastFn: ((event: BridgeEvent) => void) | null = null;

// ===== Public API =====

/** Set broadcast function for pushing Pixoo status events to WS clients. */
export function setPixooBroadcast(fn: (event: BridgeEvent) => void): void {
  broadcastFn = fn;
}

export function startPixooBridge(pixooDevices?: PixooDevice[]): void {
  if (!pixooDevices || pixooDevices.length === 0) {
    debug(TAG, 'No Pixoo devices configured, skipping');
    return;
  }

  devices = pixooDevices;
  debug(TAG, `Starting with ${devices.length} device(s): ${devices.map(d => d.name || d.ip).join(', ')}`);

  // Switch to custom channel + set brightness (fire-and-forget, one-time only)
  // Do NOT repeat this call — it resets the HTTP GIF buffer, clearing the display.
  for (const dev of devices) {
    switchToCustomChannel(dev.ip).catch(() => {});
    setBrightness(dev.ip, dev.brightness ?? DEFAULT_BRIGHTNESS).catch(() => {});
  }

  // Wire device status change → WS notification
  onDeviceStatusChange((ip, online) => {
    const dev = devices.find(d => d.ip === ip);
    const name = dev?.name || 'Pixoo64';
    if (broadcastFn) {
      broadcastFn({
        type: 'device_status',
        device: 'pixoo',
        name,
        ip,
        online,
        message: online
          ? `${name} reconnected`
          : `${name} offline — power cycle may be needed`,
      } as any);
    }
    debug(TAG, online ? `${name} (${ip}) back online` : `${name} (${ip}) went offline`);
  });

  // Start continuous 3 FPS stream — no repeated channel switches
  if (streamTimer) clearInterval(streamTimer);
  streamTimer = setInterval(doStreamPush, HTTP_STREAM_INTERVAL_MS);

  debug(TAG, 'Bridge started (Continuous 3 FPS stream)');
}

export function broadcastPixoo(event: BridgeEvent): void {
  if (!FORWARDED_EVENTS.has(event.type)) return;

  // Always cache state for live preview (even without Pixoo devices)
  switch (event.type) {
    case 'state_update':
      lastStateEvent = event as StateUpdateEvent;
      break;
    case 'usage_update':
      lastUsageEvent = event as UsageEvent;
      break;
    case 'sessions_list':
      lastSessions = (event as SessionsListEvent).sessions;
      break;
    case 'connection':
      if ((event as any).status === 'disconnected') {
        lastStateEvent = null;
        lastUsageEvent = null;
      }
      break;
    case 'display_state': {
      const displayOn = (event as any).displayOn as boolean;
      if (!displayOn && !displayDimmed) {
        // Mac display off → dim Pixoo and pause stream
        displayDimmed = true;
        for (const dev of devices) {
          setBrightness(dev.ip, 0).catch(() => {});
        }
        if (streamTimer) {
          clearInterval(streamTimer);
          streamTimer = null;
        }
        debug(TAG, 'Display sleep — brightness 0, stream paused');
      } else if (displayOn && displayDimmed) {
        // Mac display on → restore brightness and resume stream
        displayDimmed = false;
        for (const dev of devices) {
          setBrightness(dev.ip, dev.brightness ?? DEFAULT_BRIGHTNESS).catch(() => {});
        }
        // Resume stream after brief delay (let brightness restore first)
        setTimeout(() => {
          if (!displayDimmed && !streamTimer && devices.length > 0) {
            streamTimer = setInterval(doStreamPush, HTTP_STREAM_INTERVAL_MS);
            doStreamPush(); // Immediate first frame
          }
        }, 100);
        debug(TAG, 'Display wake — brightness restored, stream resumed');
      }
      break;
    }
  }

  // Immediate push on major disconnections to feel snappy
  if (event.type === 'connection' && devices.length > 0) {
    if (!pushing) doStreamPush();
  }
}

export function stopPixooBridge(): void {
  if (streamTimer) {
    clearInterval(streamTimer);
    streamTimer = null;
  }
  stopProbeTimer();

  for (const dev of devices) {
    clearText(dev.ip).catch(() => {});
  }

  stopPreviewTimer();
  devices = [];
  lastStateEvent = null;
  lastUsageEvent = null;
  lastSessions = null;
  displayDimmed = false;
  broadcastFn = null;
  frameListeners = [];
  debug(TAG, 'Bridge stopped');
}

/** Register a listener called whenever a new frame is rendered. */
export function onFrameRendered(listener: (frame: Uint8Array) => void): void {
  frameListeners.push(listener);
  startPreviewTimer();
}

/** Remove a frame listener. */
export function offFrameRendered(listener: (frame: Uint8Array) => void): void {
  frameListeners = frameListeners.filter(l => l !== listener);
  if (frameListeners.length === 0) stopPreviewTimer();
}

/**
 * Set the live preview frame rate (1–10 FPS).
 * Takes effect immediately by restarting the preview timer.
 */
export function setPreviewFps(fps: number): void {
  previewFps = Math.max(1, Math.min(10, Math.round(fps)));
  if (frameListeners.length > 0) {
    stopPreviewTimer();
    startPreviewTimer();
  }
  debug(TAG, `Preview FPS set to ${previewFps}`);
}

/** Get current preview FPS setting. */
export function getPreviewFps(): number {
  return previewFps;
}

export function pixooDeviceCount(): number {
  return devices.length;
}

export function getPixooDeviceDetails(): Array<{
  ip: string;
  name: string;
  backedOff: boolean;
  failures: number;
  nextProbeMs: number;
  lastPushAgo: number;
}> {
  return devices.map(dev => {
    const backoff = getDeviceBackoffStatus(dev.ip);
    return {
      ip: dev.ip,
      name: dev.name || 'Pixoo64',
      backedOff: backoff.backedOff,
      failures: backoff.failures,
      nextProbeMs: backoff.nextProbeMs,
      lastPushAgo: lastPushTime > 0 ? Date.now() - lastPushTime : -1,
    };
  });
}

// ===== Internal =====

/**
 * Main Continuous Stream tick: 3 FPS push to all hardware devices (333ms interval).
 */
function doStreamPush(): void {
  if (devices.length === 0) return;
  if (pushing) return;
  if (displayDimmed) return;

  const elapsed = Date.now() - lastPushTime;
  if (elapsed < HTTP_STREAM_INTERVAL_MS * 0.8) return;

  pushing = true;
  lastPushTime = Date.now();

  try {
    const frame = renderFrame(lastStateEvent, lastUsageEvent, lastSessions);
    const ts = new Date().toISOString().slice(11, 19);
    process.stderr.write(`[Pixoo] ${ts} pushing to ${devices.length} dev(s)\n`);

    const promises = devices.map(dev =>
      pushFrame(dev.ip, frame).then(ok => {
        process.stderr.write(`[Pixoo] ${ts}   → ${dev.ip}: ${ok ? 'OK' : 'FAIL'}\n`);
      }).catch((err: any) => {
        process.stderr.write(`[Pixoo] ${ts}   → ${dev.ip}: ERROR ${err?.message}\n`);
      })
    );

    Promise.all(promises).then(() => { pushing = false; });
  } catch (err: any) {
    pushing = false;
    process.stderr.write(`[Pixoo] renderFrame error: ${err?.message}\n`);
  }
}

/**
 * Render a fresh frame using current cached state.
 * Used by the live preview endpoint when no Pixoo device is connected.
 */
export function renderPreviewFrame(): Uint8Array {
  return renderFrame(lastStateEvent, lastUsageEvent, lastSessions);
}

/**
 * Get the last calculated frame.
 */
export function getLastFrame(): Uint8Array | null {
  return renderFrame(lastStateEvent, lastUsageEvent, lastSessions);
}

/** Notify all SSE frame listeners. */
function notifyFrameListeners(frame: Uint8Array): void {
  for (const listener of frameListeners) {
    try { listener(frame); } catch { /* best-effort */ }
  }
}

/** Preview timer: Generates frames at previewFps for the Web UI stream. */
function startPreviewTimer(): void {
  if (previewTimer) return;
  const intervalMs = Math.round(1000 / previewFps);
  previewTimer = setInterval(() => {
    if (frameListeners.length === 0) { stopPreviewTimer(); return; }
    const frame = renderFrame(lastStateEvent, lastUsageEvent, lastSessions);
    notifyFrameListeners(frame);
  }, intervalMs);
}

function stopPreviewTimer(): void {
  if (previewTimer) { clearInterval(previewTimer); previewTimer = null; }
}
