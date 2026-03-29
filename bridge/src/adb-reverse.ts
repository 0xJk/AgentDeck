import { execSync, spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { debug } from './logger.js';
import type { PluginCommand } from './types.js';

const TAG = 'adb';

/**
 * ULANZI D200H (SSD210) ADB persistence + on-device agent.
 * 1. Locks USB sysfs to prevent ADB→HID switch at 4-second mark
 * 2. Deploys agent binary to /data/agentdeck
 * 3. Spawns agent via `adb shell` with stdin JSON streaming
 * 4. Streams state_update/usage_update events to agent stdin
 * 5. Parses button command JSON from agent stdout
 */
const D200H_SERIAL = '0123456789ABCDEF';
const D200H_SYSFS = '/sys/class/zkswe_usb/zkswe0';
const D200H_POLL_INTERVAL = 500;
const D200H_AGENT_PATH = '/data/agentdeck';

let d200hLocked = false;
let d200hAgentProc: ChildProcess | null = null;
let d200hPollTimer: ReturnType<typeof setInterval> | null = null;
let d200hCommandCallback: ((cmd: PluginCommand) => void) | null = null;

function lockD200hUsb(serial: string): boolean {
  try {
    execSync(
      `adb -s ${serial} shell "chmod 444 ${D200H_SYSFS}/functions ${D200H_SYSFS}/enable"`,
      { stdio: 'pipe', timeout: 3000 },
    );
    debug(TAG, 'D200H sysfs locked');
    return true;
  } catch {
    return false;
  }
}

function deployAgent(serial: string): boolean {
  // Check if agent already exists on device
  try {
    const check = execSync(
      `adb -s ${serial} shell "ls -la ${D200H_AGENT_PATH} 2>/dev/null"`,
      { stdio: 'pipe', timeout: 3000 },
    ).toString();
    if (check.includes('agentdeck')) {
      debug(TAG, 'D200H agent already deployed');
      return true;
    }
  } catch { /* not found, deploy */ }

  // Find local binary — look in zkswe/agent/
  const candidates = [
    join(dirname(fileURLToPath(import.meta.url)), '../../zkswe/agent/agentdeck-d200h'),
    join(dirname(fileURLToPath(import.meta.url)), '../../../zkswe/agent/agentdeck-d200h'),
  ];
  const localBin = candidates.find(p => existsSync(p));
  if (!localBin) {
    debug(TAG, 'D200H agent binary not found locally');
    return false;
  }

  try {
    execSync(`adb -s ${serial} push ${localBin} ${D200H_AGENT_PATH}`, {
      stdio: 'pipe', timeout: 15000,
    });
    execSync(`adb -s ${serial} shell "chmod +x ${D200H_AGENT_PATH}"`, {
      stdio: 'pipe', timeout: 3000,
    });
    debug(TAG, 'D200H agent deployed');
    return true;
  } catch (err) {
    debug(TAG, `D200H agent deploy failed: ${err}`);
    return false;
  }
}

function startD200hAgent(serial: string): boolean {
  if (d200hAgentProc) return true;

  // Kill any existing agent on device
  try {
    execSync(
      `adb -s ${serial} shell "for P in \\$(ps | busybox awk '/agentdeck/{print \\$1}'); do kill \\$P 2>/dev/null; done"`,
      { stdio: 'pipe', timeout: 3000 },
    );
  } catch { /* ignore */ }

  const proc = spawn('adb', ['-s', serial, 'shell', `${D200H_AGENT_PATH} --stdin`], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Parse stdout: JSON lines starting with '{' are commands, rest is debug log
  let stdoutBuf = '';
  proc.stdout?.on('data', (data: Buffer) => {
    stdoutBuf += data.toString();
    let nl: number;
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;
      if (line.startsWith('{')) {
        try {
          const cmd = JSON.parse(line) as PluginCommand;
          if (cmd.type && d200hCommandCallback) {
            debug(TAG, `D200H cmd: ${cmd.type}`);
            d200hCommandCallback(cmd);
          }
        } catch {
          debug(TAG, `D200H: ${line}`);
        }
      } else {
        debug(TAG, `D200H: ${line}`);
      }
    }
  });

  proc.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) debug(TAG, `D200H err: ${msg}`);
  });

  proc.on('close', (code) => {
    debug(TAG, `D200H agent exited (code ${code})`);
    d200hAgentProc = null;
  });

  d200hAgentProc = proc;
  debug(TAG, `D200H agent started (pid ${proc.pid})`);
  return true;
}

function stopD200hAgent(): void {
  if (d200hAgentProc) {
    d200hAgentProc.stdin?.end();
    d200hAgentProc.kill();
    d200hAgentProc = null;
  }
}

/** Send a BridgeEvent to D200H agent via stdin pipe */
export function updateD200hState(evt: unknown): void {
  if (!d200hAgentProc?.stdin?.writable) return;
  try {
    d200hAgentProc.stdin.write(JSON.stringify(evt) + '\n');
  } catch { /* ignore write errors */ }
}

/** Register callback for button commands from D200H agent */
export function onD200hCommand(cb: (cmd: PluginCommand) => void): void {
  d200hCommandCallback = cb;
}

/**
 * Start fast polling for D200H device.
 * On detection: lock sysfs → deploy agent → start agent → stream state.
 */
export function startD200hPolling(_port: number): () => void {
  if (!hasAdb()) return () => {};

  d200hLocked = false;

  d200hPollTimer = setInterval(() => {
    const devices = getConnectedDevices();
    const hasD200h = devices.includes(D200H_SERIAL);

    if (hasD200h && !d200hLocked) {
      if (lockD200hUsb(D200H_SERIAL)) {
        d200hLocked = true;
        debug(TAG, 'D200H locked, deploying agent...');
        if (deployAgent(D200H_SERIAL)) {
          startD200hAgent(D200H_SERIAL);
        }
      }
    } else if (!hasD200h && d200hLocked) {
      d200hLocked = false;
      stopD200hAgent();
      debug(TAG, 'D200H disconnected');
    }
  }, D200H_POLL_INTERVAL);

  return () => {
    if (d200hPollTimer) {
      clearInterval(d200hPollTimer);
      d200hPollTimer = null;
    }
    stopD200hAgent();
  };
}

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
 * Get number of currently connected ADB devices (best-effort, cached from last poll).
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
