import { execSync } from 'child_process';
import { debug } from './logger.js';

const TAG = 'adb';

/**
 * ADB reverse tunnel management for Android dashboard clients.
 * D200H Deck Dock is now handled by D200hModule (HID protocol) — no ADB needed.
 */

function hasAdb(): boolean {
  try {
    execSync('which adb', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function getConnectedDevices(): string[] {
  try {
    const output = execSync('adb devices', { stdio: 'pipe', timeout: 5000 }).toString();
    return output
      .split('\n')
      .slice(1) // skip "List of devices attached" header
      .filter((line) => line.includes('\tdevice'))
      .map((line) => line.split('\t')[0]);
  } catch {
    return [];
  }
}

/**
 * Set up `adb reverse` for all connected Android devices.
 * Non-blocking, best-effort — bridge starts fine without adb.
 */
export function setupAdbReverse(port: number): void {
  if (!hasAdb()) {
    debug(TAG, 'adb not found, skipping reverse setup');
    return;
  }

  const devices = getConnectedDevices();
  if (devices.length === 0) {
    debug(TAG, 'no connected devices');
    return;
  }

  for (const serial of devices) {
    try {
      execSync(`adb -s ${serial} reverse tcp:${port} tcp:${port}`, {
        stdio: 'pipe',
        timeout: 5000,
      });
      debug(TAG, `adb reverse tcp:${port} → ${serial}`);
    } catch (err) {
      debug(TAG, `adb reverse failed for ${serial}: ${err}`);
    }
  }
}

/**
 * Periodically re-check adb reverse (handles USB re-plug).
 * Returns a cleanup function to stop polling.
 */
export function startAdbReversePolling(port: number, intervalMs = 30_000): () => void {
  if (!hasAdb()) return () => {};

  const timer = setInterval(() => {
    const devices = getConnectedDevices();
    if (devices.length === 0) return;

    for (const serial of devices) {
      try {
        // Check if reverse already exists — if not, set it up
        const existing = execSync(`adb -s ${serial} reverse --list`, {
          stdio: 'pipe',
          timeout: 5000,
        }).toString();
        if (!existing.includes(`tcp:${port}`)) {
          execSync(`adb -s ${serial} reverse tcp:${port} tcp:${port}`, {
            stdio: 'pipe',
            timeout: 5000,
          });
          debug(TAG, `adb reverse re-established tcp:${port} → ${serial}`);
        }
      } catch {
        // ignore — device may be unauthorized or disconnected
      }
    }
  }, intervalMs);

  return () => clearInterval(timer);
}

/**
 * Get number of currently connected ADB devices (best-effort).
 */
export function getAdbDeviceCount(): number {
  if (!hasAdb()) return 0;
  return getConnectedDevices().length;
}

/**
 * Remove `adb reverse` mappings on shutdown.
 */
export function cleanupAdbReverse(port: number): void {
  if (!hasAdb()) return;

  const devices = getConnectedDevices();
  for (const serial of devices) {
    try {
      execSync(`adb -s ${serial} reverse --remove tcp:${port}`, {
        stdio: 'pipe',
        timeout: 3000,
      });
      debug(TAG, `removed reverse for ${serial}`);
    } catch {
      // ignore — device may already be disconnected
    }
  }
}
