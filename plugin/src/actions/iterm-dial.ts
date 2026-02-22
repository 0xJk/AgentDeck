import streamDeck, {
  action,
  SingletonAction,
  DialRotateEvent,
  DialDownEvent,
  DialUpEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from '@elgato/streamdeck';
import { State } from '@agentdeck/shared';
import { isEncoderTakeoverActive } from '../encoder-takeover.js';
import { handleTakeoverPush, handleTakeoverRotate, requestTakeoverRefresh } from './option-dial.js';
import { isPickerActive, scrollPicker, selectProject } from '../project-picker.js';
import { encoderRegistry, isVoiceTextTakeoverActive, handleVtRotate, handleVtDown, handleVtUp } from '../encoder-registry.js';
import { getItermSessions, activateItermSession, attachTmuxInIterm, getActiveItermTty, getTmuxSessionMap, getLiveTmuxSessionNames, type ItermSession } from '../utility-modes/macos.js';
import { svgToDataUrl } from '../renderers/button-renderer.js';
import { renderItermPanel, renderItermReady } from '../renderers/iterm-renderer.js';
import { switchToPort } from './session-button.js';
import { BridgeClient } from '../bridge-client.js';
import { dlog, dinfo } from '../log.js';
import { readFileSync } from 'fs';
import { homedir } from 'os';

const POLL_INTERVAL = 2000;
const SKIP_AFTER_ACTION = 3000;
const PIXMAP_LAYOUT = 'layouts/voice-layout.json';
const SESSIONS_FILE = `${homedir()}/.agentdeck/sessions.json`;

let currentState = State.DISCONNECTED;
let sessions: ItermSession[] = [];
let activeIndex = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastActionAt = 0;
let polling = false;
let currentLayout = PIXMAP_LAYOUT;
let bridgeRef: BridgeClient | null = null;

interface AgentDeckSession {
  port: number;
  pid: number;
  tty?: string;
  parentTty?: string;
  tmuxSession?: string;
}

function loadAgentDeckSessions(): AgentDeckSession[] {
  try {
    const all = JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8')) as AgentDeckSession[];
    return all.filter((s) => {
      try { process.kill(s.pid, 0); return true; } catch { return false; }
    });
  } catch {
    return [];
  }
}

/** Marker for virtual (detached tmux) entries in the session list. */
const DETACHED_MARKER = '__detached__';

interface DetachedTmuxContext {
  adSessions: AgentDeckSession[];
  tmuxClientMap: Map<string, string>;
  liveTmuxNames: Set<string>;
}

function appendDetachedTmux(itermSessions: ItermSession[], ctx: DetachedTmuxContext): ItermSession[] {
  const { adSessions, tmuxClientMap, liveTmuxNames } = ctx;
  if (adSessions.length === 0) return itermSessions;

  // Names already shown in iTerm session list
  const attachedNames = new Set(itermSessions.map((s) => s.name));

  // TTYs of current iTerm sessions — if a tmux client is on one of these TTYs, it's attached
  const itermTtys = new Set(itermSessions.map((s) => s.tty).filter(Boolean));

  // Build set of tmux sessions that have an attached client on an iTerm TTY
  const clientAttachedNames = new Set<string>();
  for (const [tty, sessionName] of tmuxClientMap) {
    if (itermTtys.has(tty)) clientAttachedNames.add(sessionName);
  }

  const detached: ItermSession[] = [];
  for (const ad of adSessions) {
    if (!ad.tmuxSession) continue;
    const name = ad.tmuxSession.replace(/:.*$/, ''); // strip :window suffix
    // Skip if tmux session no longer exists
    if (!liveTmuxNames.has(name)) continue;
    // Skip if already shown in iTerm list (name match) or has an attached client
    if (attachedNames.has(name)) continue;
    if (clientAttachedNames.has(name)) continue;
    detached.push({
      windowId: DETACHED_MARKER,
      tabIndex: ad.tmuxSession,
      sessionId: '',
      name: `🔌 ${name}`,
      tty: '',
    });
  }
  return detached.length > 0 ? [...itermSessions, ...detached] : itermSessions;
}

async function syncFromSystem(): Promise<void> {
  if (polling) return;
  if (Date.now() - lastActionAt < SKIP_AFTER_ACTION) return;
  polling = true;
  try {
    const [rawSessions, activeTty, tmuxClientMap, liveTmuxNames] = await Promise.all([
      getItermSessions(),
      getActiveItermTty(),
      getTmuxSessionMap(),
      getLiveTmuxSessionNames(),
    ]);
    const adSessions = loadAgentDeckSessions();

    // Ghost marking: tmux alive + bridge dead → ⚠ marker
    const bridgedTmuxNames = new Set(
      adSessions.filter(s => s.tmuxSession).map(s => s.tmuxSession!.replace(/:.*$/, '')),
    );
    const markedSessions = rawSessions.map(s => {
      if (!s.tty) return s;
      const tmuxName = tmuxClientMap.get(s.tty);
      if (!tmuxName || bridgedTmuxNames.has(tmuxName) || !liveTmuxNames.has(tmuxName)) return s;
      return { ...s, name: `⚠ ${tmuxName}`, isGhost: true, tmuxName };
    });

    const newSessions = appendDetachedTmux(markedSessions, { adSessions, tmuxClientMap, liveTmuxNames });
    dlog('ItermDial', `syncFromSystem: got ${newSessions.length} sessions (was ${sessions.length}), activeTty=${activeTty}`);
    if (JSON.stringify(newSessions) !== JSON.stringify(sessions)) {
      sessions = newSessions;
      if (activeIndex >= sessions.length) activeIndex = Math.max(0, sessions.length - 1);
      refreshItermDials();
    }

    // Auto-switch bridge if focused iTerm tty matches an AgentDeck session
    if (activeTty && bridgeRef) {
      const currentPort = bridgeRef.getPort();

      // 1. parentTty match (non-tmux: sdc's stdin tty === iTerm tty)
      let match = adSessions.find((s) => s.parentTty && s.parentTty === activeTty);

      // 2. Legacy direct tty match
      if (!match) match = adSessions.find((s) => s.tty && s.tty === activeTty);

      // 3. tmux match: active tty → tmux session name → AgentDeck tmuxSession
      if (!match) {
        const tmuxName = tmuxClientMap.get(activeTty);
        if (tmuxName) {
          match = adSessions.find((s) => s.tmuxSession && s.tmuxSession.startsWith(tmuxName));
        }
      }

      if (match && match.port !== currentPort) {
        dlog('ItermDial', `auto-switch: tty ${activeTty} → port ${match.port}`);
        lastActionAt = Date.now(); // suppress re-trigger for SKIP_AFTER_ACTION
        switchToPort(match.port);

        // Sync dial display to the matched iTerm session
        const itermIdx = sessions.findIndex((s) => s.tty === activeTty);
        if (itermIdx !== -1) {
          activeIndex = itermIdx;
        }
        refreshItermDials();
      }
    }
  } catch (e) {
    dlog('ItermDial', `syncFromSystem error: ${e}`);
  } finally {
    polling = false;
  }
}

function startPolling(): void {
  stopPolling();
  pollTimer = setInterval(syncFromSystem, POLL_INTERVAL);
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export function initItermDial(bridge: BridgeClient): void {
  bridgeRef = bridge;
  dinfo('ItermDial', 'initItermDial called');
}

export function updateItermDialState(state: State): void {
  currentState = state;
  // Do NOT reset currentLayout here — causes setFeedbackLayout on every state update → SD flicker.
  // Layout is reset only on encoder takeover exit (via resetEncoderLayouts hook below).

  if (encoderRegistry.itermIds.length > 0 && !pollTimer) {
    void syncFromSystem();
    startPolling();
  }
  refreshItermDials();
}

/** Called by encoder-takeover on exit so iterm re-applies its layout after takeover. */
export function resetItermLayout(): void {
  currentLayout = '';
}

function ensurePixmapLayout(): void {
  if (currentLayout === PIXMAP_LAYOUT) return;
  currentLayout = PIXMAP_LAYOUT;
  for (const id of encoderRegistry.itermIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) void dial.setFeedbackLayout(PIXMAP_LAYOUT).catch(() => {});
  }
}

function refreshItermDials(): void {
  if (isEncoderTakeoverActive()) return;
  if (isVoiceTextTakeoverActive()) return;
  if (encoderRegistry.itermIds.length === 0) return;

  ensurePixmapLayout();

  let svg: string;
  if (sessions.length === 0) {
    svg = renderItermReady();
  } else {
    const s = sessions[activeIndex];
    svg = renderItermPanel({ name: s.name, index: activeIndex, total: sessions.length });
  }

  const feedback = { canvas: svgToDataUrl(svg) };
  for (const id of encoderRegistry.itermIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) void dial.setFeedback(feedback).catch(() => {});
  }
}

@action({ UUID: 'bound.serendipity.agentdeck.iterm-dial' })
export class ItermDialAction extends SingletonAction {
  static get actionIds(): string[] { return encoderRegistry.itermIds; }

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    dinfo('ItermDial', `onWillAppear: id=${ev.action.id}`);
    if (!encoderRegistry.itermIds.includes(ev.action.id)) {
      encoderRegistry.itermIds.push(ev.action.id);
    }
    // If encoder takeover is active, join the takeover rendering instead of iterm feedback
    if (isEncoderTakeoverActive()) {
      requestTakeoverRefresh();
      startPolling();
      return;
    }
    // If sessions already cached, show immediately to avoid "No sessions" flash.
    // If not cached yet, fetch first then render.
    if (sessions.length > 0) {
      refreshItermDials();
    }
    await syncFromSystem();
    startPolling();
    refreshItermDials();
  }

  override async onDialRotate(ev: DialRotateEvent): Promise<void> {
    if (isPickerActive()) { scrollPicker(ev.payload.ticks); return; }
    if (isEncoderTakeoverActive()) { handleTakeoverRotate(ev.payload.ticks); return; }
    if (isVoiceTextTakeoverActive()) { handleVtRotate(ev.payload.ticks); return; }
    if (sessions.length === 0) return;

    lastActionAt = Date.now();
    activeIndex = ((activeIndex + ev.payload.ticks) % sessions.length + sessions.length) % sessions.length;
    const s = sessions[activeIndex];
    if (s.windowId !== DETACHED_MARKER) {
      activateItermSession(s.windowId, s.tabIndex, s.sessionId);
    }
    refreshItermDials();
  }

  override async onDialDown(_ev: DialDownEvent): Promise<void> {
    if (isPickerActive()) { void selectProject(); return; }
    if (isEncoderTakeoverActive()) { handleTakeoverPush(); return; }
    if (isVoiceTextTakeoverActive()) { handleVtDown(); return; }
  }

  override async onDialUp(_ev: DialUpEvent): Promise<void> {
    if (isEncoderTakeoverActive()) return;
    if (isVoiceTextTakeoverActive()) { handleVtUp(); return; }

    // Push = activate selected session or attach detached tmux
    const selected = sessions[activeIndex];
    if (!selected) return;

    if (selected.isGhost && selected.tmuxName) {
      // Ghost session — tmux alive but bridge dead, re-attach
      dlog('ItermDial', `push: re-attach ghost tmux ${selected.tmuxName}`);
      attachTmuxInIterm(selected.tmuxName);
    } else if (selected.windowId === DETACHED_MARKER) {
      // Virtual entry — attach detached tmux session
      dlog('ItermDial', `push: attach tmux ${selected.tabIndex}`);
      attachTmuxInIterm(selected.tabIndex);
    } else {
      dlog('ItermDial', `push: activate session ${selected.name}`);
      activateItermSession(selected.windowId, selected.tabIndex, selected.sessionId);
    }
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    dinfo('ItermDial', `onWillDisappear: id=${ev.action.id}`);
    const idx = encoderRegistry.itermIds.indexOf(ev.action.id);
    if (idx !== -1) {
      encoderRegistry.itermIds.splice(idx, 1);
    }
    if (encoderRegistry.itermIds.length === 0) {
      stopPolling();
    }
  }
}
