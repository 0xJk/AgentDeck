/**
 * Pixoo64 Bridge — event listener + push orchestrator.
 *
 * Mirrors esp32-serial.ts pattern: receives BridgeEvents via wsServer.onBroadcast()
 * hook, renders 64×64 frames, and pushes to Pixoo64 devices via HTTP.
 *
 * Key behaviors:
 * - Debounce: minimum 800ms between pushes (device ~1fps limit)
 * - Heartbeat: re-push current frame every 10s (device power recovery)
 * - IDLE animation: upload 4-frame GIF loop, device loops internally (zero HTTP)
 * - Multi-device: all configured devices receive simultaneous pushes
 */

import { State } from '../types.js';
import type { BridgeEvent, StateUpdateEvent, UsageEvent } from '../types.js';
import type { SessionInfo, SessionsListEvent } from '@agentdeck/shared/protocol';
import { DISPLAY_FORWARDED_EVENTS } from '@agentdeck/shared/protocol';
import { pushFrame, pushAnimation, setBrightness, clearText, sendScrollText, getDeviceBackoffStatus } from './pixoo-client.js';
import { renderFrame, renderIdleAnimation } from './pixoo-renderer.js';
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
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let lastPushTime = 0;
let pendingPush: ReturnType<typeof setTimeout> | null = null;
let isIdleAnimationActive = false;

// Cached latest events for heartbeat re-rendering
let lastStateEvent: StateUpdateEvent | null = null;
let lastUsageEvent: UsageEvent | null = null;
let lastSessions: SessionInfo[] | null = null;
let lastFrame: Uint8Array | null = null;

const DEBOUNCE_MS = 800;     // Minimum interval between pushes (~1fps)
const HEARTBEAT_MS = 10000;  // Re-push every 10s
const IDLE_ANIM_SPEED = 600; // ms per frame (4 frames × 600ms = 2.4s loop)
const DEFAULT_BRIGHTNESS = 40;

// Events to forward — shared constant from @agentdeck/shared
const FORWARDED_EVENTS = DISPLAY_FORWARDED_EVENTS;

// ===== Public API =====

/**
 * Start the Pixoo bridge with configured devices.
 * Non-blocking: initial brightness set runs in background.
 */
export function startPixooBridge(pixooDevices?: PixooDevice[]): void {
  if (!pixooDevices || pixooDevices.length === 0) {
    debug(TAG, 'No Pixoo devices configured, skipping');
    return;
  }

  devices = pixooDevices;
  debug(TAG, `Starting with ${devices.length} device(s): ${devices.map(d => d.name || d.ip).join(', ')}`);

  // Set initial brightness (fire-and-forget)
  for (const dev of devices) {
    setBrightness(dev.ip, dev.brightness ?? DEFAULT_BRIGHTNESS).catch(() => {});
  }

  // Heartbeat: re-push current frame to handle device power recovery
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);

  debug(TAG, 'Bridge started');
}

/**
 * Broadcast hook — called by wsServer.onBroadcast() for every BridgeEvent.
 */
export function broadcastPixoo(event: BridgeEvent): void {
  if (devices.length === 0) return;
  if (!FORWARDED_EVENTS.has(event.type)) return;

  // Update cached state
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
      // On disconnect, clear display
      if ((event as any).status === 'disconnected') {
        lastStateEvent = null;
        lastUsageEvent = null;
      }
      break;
  }

  schedulePush();
}

/** Stop the Pixoo bridge. */
export function stopPixooBridge(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (pendingPush) {
    clearTimeout(pendingPush);
    pendingPush = null;
  }

  // Clear displays (fire-and-forget)
  for (const dev of devices) {
    clearText(dev.ip).catch(() => {});
  }

  devices = [];
  lastStateEvent = null;
  lastUsageEvent = null;
  lastSessions = null;
  lastFrame = null;
  debug(TAG, 'Bridge stopped');
}

/** Get number of configured Pixoo devices. */
export function pixooDeviceCount(): number {
  return devices.length;
}

/** Get detailed status of all configured Pixoo devices (for /devices endpoint). */
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

function schedulePush(): void {
  const now = Date.now();
  const elapsed = now - lastPushTime;

  if (elapsed >= DEBOUNCE_MS) {
    // Can push immediately
    doPush();
  } else if (!pendingPush) {
    // Schedule push after remaining debounce period
    const delay = DEBOUNCE_MS - elapsed;
    pendingPush = setTimeout(() => {
      pendingPush = null;
      doPush();
    }, delay);
  }
  // If pendingPush already set, it will pick up latest cached state
}

function doPush(): void {
  lastPushTime = Date.now();

  const state = lastStateEvent?.state ?? State.IDLE;

  // IDLE → upload animation loop (device handles looping, no ongoing HTTP)
  if (state === State.IDLE && !isIdleAnimationActive) {
    pushIdleAnimation();
    return;
  }

  // Non-IDLE → single frame push (overrides any running animation)
  if (state !== State.IDLE) {
    isIdleAnimationActive = false;
  }

  const frame = renderFrame(lastStateEvent, lastUsageEvent, lastSessions);
  lastFrame = frame;

  for (const dev of devices) {
    pushFrame(dev.ip, frame).catch(() => {});
  }

  // Project name as scrolling text overlay (device font handles CJK)
  updateProjectNameOverlay();
}

function pushIdleAnimation(): void {
  isIdleAnimationActive = true;

  const frames = renderIdleAnimation(lastStateEvent, lastUsageEvent, lastSessions);
  lastFrame = frames[0]; // Cache first frame for heartbeat fallback

  for (const dev of devices) {
    pushAnimation(dev.ip, frames, IDLE_ANIM_SPEED).catch((err) => {
      debug(TAG, `Animation push failed for ${dev.name || dev.ip}: ${err.message}`);
    });
  }
}

function sendHeartbeat(): void {
  if (devices.length === 0) return;

  if (isIdleAnimationActive) {
    // Device is looping animation — no need to re-push
    return;
  }

  // Re-render and push current state
  if (lastStateEvent || lastUsageEvent) {
    const frame = renderFrame(lastStateEvent, lastUsageEvent, lastSessions);
    lastFrame = frame;
    for (const dev of devices) {
      pushFrame(dev.ip, frame).catch(() => {});
    }
  } else if (lastFrame) {
    // No state yet, re-push last known frame
    for (const dev of devices) {
      pushFrame(dev.ip, lastFrame).catch(() => {});
    }
  }
}

let lastProjectName: string | null = null;

function updateProjectNameOverlay(): void {
  const projectName = lastStateEvent?.projectName;
  if (projectName === lastProjectName) return;
  lastProjectName = projectName ?? null;

  if (!projectName) {
    for (const dev of devices) {
      clearText(dev.ip).catch(() => {});
    }
    return;
  }

  // Only use scroll text for longer names that won't fit in bitmap font
  if (projectName.length > 14) {
    for (const dev of devices) {
      sendScrollText(dev.ip, 0, projectName, '#94a3b8', 40).catch(() => {});
    }
  }
}
