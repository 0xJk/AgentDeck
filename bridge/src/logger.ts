import { createWriteStream, type WriteStream } from 'fs';

let debugStream: WriteStream | null = null;
let debugEnabled = false;
let ptyMode = false;

/**
 * Enable debug logging to a file. This avoids interfering with PTY terminal.
 * User can `tail -f /tmp/agentdeck-debug.log` in another terminal.
 */
export function enableDebugLog(path = '/tmp/agentdeck-debug.log'): void {
  debugStream = createWriteStream(path, { flags: 'w' });
  debugEnabled = true;
  debugStream.write(`[agentdeck] Debug log started at ${new Date().toISOString()}\n`);
}

/**
 * Suppress stderr logging after PTY is active (bridge shares terminal with PTY).
 * When enabled, log() redirects to debug file only (if --debug). Daemon/CLI never call this.
 */
export function setPtyMode(enabled: boolean): void {
  ptyMode = enabled;
}

/** Standard logging to stderr (suppressed in PTY mode to avoid terminal noise) */
export function log(...args: unknown[]): void {
  if (ptyMode) {
    if (debugEnabled && debugStream) {
      const ts = new Date().toISOString().slice(11, 23);
      debugStream.write(`${ts} [log] ${args.map(String).join(' ')}\n`);
    }
    return;
  }
  process.stderr.write(`[agentdeck] ${args.map(String).join(' ')}\n`);
}

export function logTagged(tag: string, ...args: unknown[]): void {
  if (ptyMode) {
    if (debugEnabled && debugStream) {
      const ts = new Date().toISOString().slice(11, 23);
      debugStream.write(`${ts} [${tag}] ${args.map(String).join(' ')}\n`);
    }
    return;
  }
  process.stderr.write(`[${tag}] ${args.map(String).join(' ')}\n`);
}

/** Debug logging — only goes to file when --debug is enabled */
export function debug(tag: string, ...args: unknown[]): void {
  if (!debugEnabled || !debugStream) return;
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  debugStream.write(`${ts} [${tag}] ${args.map(String).join(' ')}\n`);
}
