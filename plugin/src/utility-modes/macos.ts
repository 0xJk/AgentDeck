/**
 * macOS system control via osascript.
 * Uses execFile (no shell) for safety. Debounced execution for rapid dial rotation.
 */
import { execFile, spawn } from 'child_process';

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
  inputVolume: number | null;
  outputMuted: boolean;
}

export async function getVolumeSettings(): Promise<VolumeSettings> {
  const raw = await osascript('get volume settings');
  // "output volume:65, input volume:80, alert volume:100, output muted:false"
  const num = (key: string): number | null => {
    const m = new RegExp(`${key}:(\\d+)`).exec(raw);
    return m ? parseInt(m[1], 10) : null;
  };
  return {
    outputVolume: num('output volume') ?? 0,
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

// ---- iTerm2 ----

export interface ItermSession {
  windowId: string;
  tabIndex: string;
  sessionId: string;
  name: string;
  tty: string;
  isGhost?: boolean;    // tmux alive + bridge dead
  tmuxName?: string;    // bare tmux session name (for re-attach)
}

const TMUX_PATHS = ['/usr/local/bin/tmux', '/opt/homebrew/bin/tmux', '/usr/bin/tmux'];

/** Get the set of currently live tmux session names. */
export async function getLiveTmuxSessionNames(): Promise<Set<string>> {
  const names = new Set<string>();
  for (const tmuxBin of TMUX_PATHS) {
    try {
      const out = await new Promise<string>((resolve, reject) =>
        execFile(tmuxBin, ['list-sessions', '-F', '#{session_name}'],
          { timeout: 2000 }, (err, stdout) => err ? reject(err) : resolve(stdout.trim())),
      );
      for (const line of out.split('\n')) {
        if (line) names.add(line);
      }
      break;
    } catch {}
  }
  return names;
}

/** Build tty → tmux session name map from `tmux list-clients`. */
export async function getTmuxSessionMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const tmuxBin of TMUX_PATHS) {
    try {
      const out = await new Promise<string>((resolve, reject) =>
        execFile(tmuxBin, ['list-clients', '-F', '#{client_tty} #{session_name}'],
          { timeout: 2000 }, (err, stdout) => err ? reject(err) : resolve(stdout.trim())),
      );
      for (const line of out.split('\n')) {
        const sp = line.indexOf(' ');
        if (sp > 0) map.set(line.slice(0, sp), line.slice(sp + 1));
      }
      break; // success
    } catch {}
  }
  return map;
}

/**
 * Derive a short, readable label from an iTerm2 session name + tty.
 *
 * Priority:
 *  1. tty matches a tmux client → "session-name" (tmux session)
 *  2. Strip leading status emoji/char, strip trailing (process), extract last path component
 */
function resolveSessionName(rawName: string, tty: string, tmuxMap: Map<string, string>): string {
  if (tty && tmuxMap.has(tty)) {
    return tmuxMap.get(tty)!;
  }
  // Strip leading non-word status chars (✳ ⠂ etc.) and trailing whitespace
  let name = rawName.replace(/^[\p{So}\p{Sm}\p{Sk}\p{Sc}\p{Ps}\p{Pe}•·⠂✳✦★☆▶◀…]+\s*/u, '').trim();
  // Strip trailing (process-name) suffix
  name = name.replace(/\s*\([^)]+\)\s*$/, '').trim();
  // If it's a path (has /), take last component
  if (name.includes('/')) {
    name = name.split('/').filter(Boolean).pop() ?? name;
  }
  return name || rawName;
}

export async function getItermSessions(): Promise<ItermSession[]> {
  try {
    const [raw, tmuxMap] = await Promise.all([
      osascript(
        'tell application "iTerm2"\n' +
        '  set sessionList to {}\n' +
        '  repeat with w in windows\n' +
        '    set wid to id of w\n' +
        '    set ti to 0\n' +
        '    repeat with t in tabs of w\n' +
        '      set ti to ti + 1\n' +
        '      repeat with s in sessions of t\n' +
        '        set ttyVal to ""\n' +
        '        try\n' +
        '          set ttyVal to tty of s as text\n' +
        '        end try\n' +
        '        set end of sessionList to (wid as text) & "|" & (ti as text) & "|" & (unique ID of s) & "|" & ttyVal & "|" & (name of s)\n' +
        '      end repeat\n' +
        '    end repeat\n' +
        '  end repeat\n' +
        '  return sessionList\n' +
        'end tell',
      ),
      getTmuxSessionMap(),
    ]);
    if (!raw) return [];
    return raw.split(', ').map(entry => {
      // Format: windowId|tabIndex|uniqueId|tty|name  (name may contain |)
      const p1 = entry.indexOf('|');
      const p2 = entry.indexOf('|', p1 + 1);
      const p3 = entry.indexOf('|', p2 + 1);
      const p4 = entry.indexOf('|', p3 + 1);
      const windowId = entry.slice(0, p1);
      const tabIndex = entry.slice(p1 + 1, p2);
      const sessionId = entry.slice(p2 + 1, p3);
      const tty = entry.slice(p3 + 1, p4);
      const rawName = entry.slice(p4 + 1);
      return { windowId, tabIndex, sessionId, name: resolveSessionName(rawName, tty, tmuxMap), tty };
    });
  } catch {
    return [];
  }
}

export async function activateItermSession(windowId: string, tabIndex: string, _sessionId: string): Promise<void> {
  await osascript(
    'tell application "iTerm2"\n' +
    '  activate\n' +
    '  repeat with w in windows\n' +
    `    if id of w is ${windowId} then\n` +
    `      select item ${tabIndex} of tabs of w\n` +
    '    end if\n' +
    '  end repeat\n' +
    'end tell',
  ).catch(() => {});
}

/** Check if iTerm2 is the frontmost application. */
export async function isItermFrontmost(): Promise<boolean> {
  try {
    const name = await osascript(
      'tell application "System Events" to name of first process whose frontmost is true',
    );
    return name === 'iTerm2';
  } catch { return false; }
}

/** Get the tty of the active iTerm2 session (frontmost tab of frontmost window). */
export async function getActiveItermTty(): Promise<string | null> {
  try {
    const tty = await osascript(
      'tell application "iTerm2" to tty of current session of current tab of current window',
    );
    return tty || null;
  } catch {
    return null;
  }
}

/** Open a new iTerm2 window and attach to a tmux session using iTerm2's tmux integration (-CC). */
export async function attachTmuxInIterm(sessionName: string): Promise<void> {
  await osascript(
    'tell application "iTerm2"\n' +
    '  activate\n' +
    '  set newWin to (create window with default profile)\n' +
    `  tell current session of current tab of newWin to write text "tmux -CC attach -t ${sessionName.replace(/"/g, '\\"')}"\n` +
    'end tell',
  ).catch(() => {});
}

// ---- iTerm2 Window Cycling & Exposé ----

/** Cmd+` (next window) */
export async function cycleItermWindowNext(): Promise<void> {
  await osascript(
    'tell application "iTerm2" to activate\n' +
    // Use physical key code (50 = `~) to avoid layout-dependent failures
    'tell application "System Events" to key code 50 using command down',
  ).catch(() => {});
}

/** Cmd+Shift+` (previous window) */
export async function cycleItermWindowPrev(): Promise<void> {
  await osascript(
    'tell application "iTerm2" to activate\n' +
    'tell application "System Events" to key code 50 using {command down, shift down}',
  ).catch(() => {});
}

/** Activate iTerm2 + App Exposé (Control+↓) */
export async function enterItermExpose(): Promise<void> {
  await osascript(
    'tell application "iTerm2" to activate\n' +
    'delay 0.15\n' +
    'tell application "System Events" to key code 125 using control down',
  ).catch(() => {});
}

/** Arrow key navigation in Exposé */
export async function exposeNavigate(dir: 'left' | 'right'): Promise<void> {
  const keyCode = dir === 'left' ? 123 : 124;
  await osascript(
    `tell application "System Events" to key code ${keyCode}`,
  ).catch(() => {});
}

/** Return key to confirm Exposé selection */
export async function exposeConfirm(): Promise<void> {
  await osascript(
    'tell application "System Events" to key code 36',
  ).catch(() => {});
}

/** Escape key to cancel Exposé */
export async function exposeCancel(): Promise<void> {
  await osascript(
    'tell application "System Events" to key code 53',
  ).catch(() => {});
}

// ---- Window Highlight (optional) ----

/**
 * Briefly nudge the front iTerm2 window and restore its position to make it visually stand out.
 * Requires Accessibility permission (same as other System Events keystrokes).
 */
export async function shakeItermFrontWindow(amplitude = 10): Promise<void> {
  const amp = Math.max(1, Math.min(30, Math.floor(amplitude)));
  await osascript(
    'tell application "System Events"\n' +
    '  try\n' +
    '    tell process "iTerm2"\n' +
    '      set w to front window\n' +
    '      set p to position of w\n' +
    '      set px to item 1 of p\n' +
    '      set py to item 2 of p\n' +
    `      set position of w to {px + ${amp}, py + ${amp}}\n` +
    '      delay 0.03\n' +
    '      set position of w to {px, py}\n' +
    '    end tell\n' +
    '  end try\n' +
    'end tell',
  ).catch(() => {});
}

// ---- Clipboard Paste (STT) ----

/**
 * Paste text at current cursor position.
 * iTerm2: use `write text` API directly.
 * Other apps: copy to clipboard + notification (Cmd+V unreliable via System Events).
 */
export function pasteText(text: string): void {
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  osascript(
    `set frontApp to name of (info for (path to frontmost application))\n` +
    `if frontApp is "iTerm.app" then\n` +
    `  tell application "iTerm2" to tell current session of current tab of current window to write text "${escaped}"\n` +
    `else\n` +
    `  set the clipboard to "${escaped}"\n` +
    `  display notification "Press ⌘V to paste" with title "AgentDeck" sound name "Pop"\n` +
    `end if`,
  ).catch(() => {});
}

// ---- Browser Tab Focus ----

const CHROMIUM_BROWSERS = ['Google Chrome', 'Brave Browser', 'Microsoft Edge', 'Arc'] as const;
const SEARCHABLE_BROWSERS = [...CHROMIUM_BROWSERS, 'Safari'] as const;

/** Get list of searchable browsers currently running. */
async function getRunningBrowsers(): Promise<string[]> {
  const names = SEARCHABLE_BROWSERS.map(b => `"${b}"`).join(', ');
  try {
    const result = await osascript(
      `tell application "System Events" to get name of every process whose name is in {${names}}`,
    );
    if (!result) return [];
    return result.split(', ').filter(n => (SEARCHABLE_BROWSERS as readonly string[]).includes(n));
  } catch {
    return [];
  }
}

/** Try to focus an existing tab matching urlPrefix in the given browser. */
async function focusBrowserTab(browser: string, urlPrefix: string): Promise<boolean> {
  const escaped = urlPrefix.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const isChromium = (CHROMIUM_BROWSERS as readonly string[]).includes(browser);

  const script = isChromium
    ? `tell application "${browser}"
  set wIndex to 0
  repeat with w in windows
    set wIndex to wIndex + 1
    set tIndex to 0
    repeat with t in tabs of w
      set tIndex to tIndex + 1
      if URL of t starts with "${escaped}" then
        set active tab index of w to tIndex
        set index of w to 1
        activate
        return "found"
      end if
    end repeat
  end repeat
end tell
return "notfound"`
    : `tell application "Safari"
  set wIndex to 0
  repeat with w in windows
    set wIndex to wIndex + 1
    set tIndex to 0
    repeat with t in tabs of w
      set tIndex to tIndex + 1
      if URL of t starts with "${escaped}" then
        set current tab of w to t
        set index of w to 1
        activate
        return "found"
      end if
    end repeat
  end repeat
end tell
return "notfound"`;

  try {
    const result = await osascript(script);
    return result === 'found';
  } catch {
    return false;
  }
}

/**
 * Focus an existing browser tab matching urlPrefix, or open a new one.
 * Searches running Chromium browsers and Safari. Falls back to `open` command.
 */
export async function openOrFocusBrowserTab(urlPrefix: string): Promise<void> {
  const browsers = await getRunningBrowsers();
  for (const browser of browsers) {
    const found = await focusBrowserTab(browser, urlPrefix);
    if (found) return;
  }
  // No existing tab found — open normally
  await new Promise<void>((resolve, reject) => {
    execFile('open', [urlPrefix], { timeout: 3000 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// ---- Notification ----

export async function showNotification(title: string, message: string): Promise<void> {
  await osascript(
    `display notification "${message.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}" sound name "Glass"`,
  ).catch(() => {});
}
