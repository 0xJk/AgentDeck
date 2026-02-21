/**
 * macOS system control via osascript.
 * Uses execFile (no shell) for safety. Debounced execution for rapid dial rotation.
 */
import { execFile } from 'child_process';

// ---- Core executor ----

export function osascript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: 5000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

/**
 * Debounced osascript execution per channel key.
 * Coalesces rapid calls (e.g. fast dial rotation) — only the final value commits.
 */
const debounceMap = new Map<string, ReturnType<typeof setTimeout>>();

export function debouncedExec(key: string, script: string, delayMs = 100): void {
  const existing = debounceMap.get(key);
  if (existing) clearTimeout(existing);
  debounceMap.set(key, setTimeout(() => {
    debounceMap.delete(key);
    osascript(script).catch(() => {});
  }, delayMs));
}

// ---- Volume ----

export interface VolumeSettings {
  outputVolume: number;
  inputVolume: number;
  outputMuted: boolean;
}

export async function getVolumeSettings(): Promise<VolumeSettings> {
  const raw = await osascript('get volume settings');
  // "output volume:65, input volume:80, alert volume:100, output muted:false"
  const num = (key: string) => {
    const re = new RegExp(`${key}:(\\d+)`);
    return parseInt(re.exec(raw)?.[1] ?? '0', 10);
  };
  return {
    outputVolume: num('output volume'),
    inputVolume: num('input volume'),
    outputMuted: /output muted:true/.test(raw),
  };
}

export function setOutputVolume(vol: number): void {
  debouncedExec('output-volume', `set volume output volume ${Math.round(vol)}`);
}

export function setOutputMuted(muted: boolean): void {
  void osascript(`set volume output muted ${muted}`).catch(() => {});
}

export function setInputVolume(vol: number): void {
  debouncedExec('input-volume', `set volume input volume ${Math.round(vol)}`);
}

// ---- Brightness ----
// Each key code press is a discrete ±1 step — no debounce (every call must fire).

export function brightnessUp(): void {
  osascript('tell application "System Events" to key code 145').catch(() => {});
}

export function brightnessDown(): void {
  osascript('tell application "System Events" to key code 144').catch(() => {});
}

// ---- Media ----

async function getRunningPlayer(): Promise<'Spotify' | 'Music' | null> {
  try {
    const result = await osascript(
      'tell application "System Events" to get name of every process whose name is "Spotify" or name is "Music"',
    );
    if (result.includes('Spotify')) return 'Spotify';
    if (result.includes('Music')) return 'Music';
  } catch { /* ignore */ }
  return null;
}

export async function mediaPlayPause(): Promise<void> {
  const player = await getRunningPlayer();
  if (player) {
    await osascript(`tell application "${player}" to playpause`);
  }
}

export async function mediaNext(): Promise<void> {
  const player = await getRunningPlayer();
  if (player) {
    await osascript(`tell application "${player}" to next track`);
  }
}

export async function mediaPrevious(): Promise<void> {
  const player = await getRunningPlayer();
  if (player) {
    await osascript(`tell application "${player}" to previous track`);
  }
}

export async function getTrackInfo(): Promise<{ name: string; artist: string; playing: boolean } | null> {
  const player = await getRunningPlayer();
  if (!player) return null;
  try {
    const name = await osascript(`tell application "${player}" to name of current track`);
    const artist = await osascript(`tell application "${player}" to artist of current track`);
    const state = await osascript(`tell application "${player}" to player state as string`);
    return { name, artist, playing: state === 'playing' };
  } catch {
    return null;
  }
}

// ---- Dark Mode ----

export async function getDarkMode(): Promise<boolean> {
  const result = await osascript(
    'tell application "System Events" to tell appearance preferences to get dark mode',
  );
  return result === 'true';
}

export async function toggleDarkMode(): Promise<boolean> {
  await osascript(
    'tell application "System Events" to tell appearance preferences to set dark mode to not dark mode',
  );
  return getDarkMode();
}

// ---- Notification ----

export async function showNotification(title: string, message: string): Promise<void> {
  await osascript(
    `display notification "${message.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}" sound name "Glass"`,
  ).catch(() => {});
}
