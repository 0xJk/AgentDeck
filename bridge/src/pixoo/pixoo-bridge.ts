/**
 * Pixoo64 Bridge — event listener + push orchestrator.
 *
 * Mirrors esp32-serial.ts pattern: receives BridgeEvents via wsServer.onBroadcast()
 * hook, renders 64×64 frames, and pushes to Pixoo64 devices via HTTP.
 *
 * Key behaviors:
 * - Animation loop: continuous 1.2s frame push (real-time animation on device)
 * - Event-driven: state/usage changes trigger immediate frame push (debounced 800ms)
 * - Multi-device: all configured devices receive simultaneous pushes
 */

import { State } from '../types.js';
import type { BridgeEvent, StateUpdateEvent, UsageEvent } from '../types.js';
import type { SessionInfo, SessionsListEvent } from '@agentdeck/shared/protocol';
import { DISPLAY_FORWARDED_EVENTS } from '@agentdeck/shared/protocol';
import { pushFrame, setBrightness, clearText, getDeviceBackoffStatus, switchToCustomChannel } from './pixoo-client.js';
import { renderFrame } from './pixoo-renderer.js';
import { debug } from '../logger.js';

const TAG = 'Pixoo';

// ===== Configuration =====

export interface PixooDevice {
  ip: string;
  name?: string;
  brightness?: number; // 0-100, default 40
}

// ===== Internal State =====

let devices: PixooDevice[] = [];
let animTimer: ReturnType<typeof setInterval> | null = null;
let lastPushTime = 0;
let pendingPush: ReturnType<typeof setTimeout> | null = null;
let pushing = false; // guard against overlapping pushes

// Cached latest events
let lastStateEvent: StateUpdateEvent | null = null;
let lastUsageEvent: UsageEvent | null = null;
let lastSessions: SessionInfo[] | null = null;

// Last rendered frame (cached for live preview)
let lastRenderedFrame: Uint8Array | null = null;

const DEBOUNCE_MS = 800;      // Min interval between event-driven pushes
const ANIM_INTERVAL_MS = 1200; // Continuous animation frame interval (~0.83fps)
const DEFAULT_BRIGHTNESS = 40;

const FORWARDED_EVENTS = DISPLAY_FORWARDED_EVENTS;

// ===== Public API =====

export function startPixooBridge(pixooDevices?: PixooDevice[]): void {
  if (!pixooDevices || pixooDevices.length === 0) {
    debug(TAG, 'No Pixoo devices configured, skipping');
    return;
  }

  devices = pixooDevices;
  debug(TAG, `Starting with ${devices.length} device(s): ${devices.map(d => d.name || d.ip).join(', ')}`);

  // Switch to custom channel + set brightness (fire-and-forget)
  for (const dev of devices) {
    switchToCustomChannel(dev.ip).catch(() => {});
    setBrightness(dev.ip, dev.brightness ?? DEFAULT_BRIGHTNESS).catch(() => {});
  }

  // Continuous animation loop — push a new frame every 1.2s
  animTimer = setInterval(animTick, ANIM_INTERVAL_MS);

  debug(TAG, 'Bridge started');
}

export function broadcastPixoo(event: BridgeEvent): void {
  if (devices.length === 0) return;
  if (!FORWARDED_EVENTS.has(event.type)) return;

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
  }

  // State changes trigger immediate push (debounced)
  if (event.type === 'state_update' || event.type === 'connection') {
    schedulePush();
  }
}

export function stopPixooBridge(): void {
  if (animTimer) {
    clearInterval(animTimer);
    animTimer = null;
  }
  if (pendingPush) {
    clearTimeout(pendingPush);
    pendingPush = null;
  }

  for (const dev of devices) {
    clearText(dev.ip).catch(() => {});
  }

  devices = [];
  lastStateEvent = null;
  lastUsageEvent = null;
  lastSessions = null;
  lastRenderedFrame = null;
  debug(TAG, 'Bridge stopped');
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

/** Event-driven push (debounced). */
function schedulePush(): void {
  const elapsed = Date.now() - lastPushTime;
  if (elapsed >= DEBOUNCE_MS) {
    doPush();
  } else if (!pendingPush) {
    pendingPush = setTimeout(() => {
      pendingPush = null;
      doPush();
    }, DEBOUNCE_MS - elapsed);
  }
}

/** Animation timer tick — continuous frame push for live animation. */
function animTick(): void {
  if (devices.length === 0) return;
  // Skip if a recent event-driven push already covered this interval
  const elapsed = Date.now() - lastPushTime;
  if (elapsed < ANIM_INTERVAL_MS * 0.7) return;
  doPush();
}

/**
 * Render a fresh frame using current cached state.
 * Used by the live preview endpoint when no Pixoo device is connected.
 */
export function renderPreviewFrame(): Uint8Array {
  return renderFrame(lastStateEvent, lastUsageEvent, lastSessions);
}

/**
 * Get the last frame pushed to Pixoo devices, or render one on-demand.
 * Returns 64×64×3 RGB buffer (12,288 bytes).
 */
export function getLastFrame(): Uint8Array | null {
  return lastRenderedFrame;
}

/** Render and push a single frame to all devices. */
function doPush(): void {
  if (pushing) return; // prevent overlapping async pushes
  pushing = true;
  lastPushTime = Date.now();

  const frame = renderFrame(lastStateEvent, lastUsageEvent, lastSessions);
  lastRenderedFrame = frame;
  debug(TAG, `push ${frame.length}B to ${devices.length} dev(s)`);

  const promises = devices.map(dev =>
    pushFrame(dev.ip, frame).then(ok => {
      if (!ok) debug(TAG, `push FAILED to ${dev.ip}`);
    }).catch(() => {})
  );
  Promise.all(promises).then(() => { pushing = false; });
}
