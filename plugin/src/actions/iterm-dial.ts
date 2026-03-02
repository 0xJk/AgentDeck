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
import type { AgentType, AgentCapabilities, OcSessionStatus } from '@agentdeck/shared';
import { isEncoderTakeoverActive } from '../encoder-takeover.js';
import { handleTakeoverPush, handleTakeoverRotate, requestTakeoverRefresh } from './option-dial.js';
import { isPickerActive, scrollPicker, selectProject } from '../project-picker.js';
import { encoderRegistry, isVoiceTextTakeoverActive, handleVtRotate, handleVtDown, handleVtUp } from '../encoder-registry.js';
import { getItermSessions, activateItermSession, attachTmuxInIterm, getActiveItermTty, getTmuxSessionMap, getLiveTmuxSessionNames, isItermFrontmost, cycleItermWindowNext, cycleItermWindowPrev, enterItermExpose, exposeNavigate, exposeConfirm, exposeCancel, type ItermSession } from '../utility-modes/macos.js';
import { svgToDataUrl } from '../renderers/button-renderer.js';
import { renderItermPanel, renderItermReady } from '../renderers/iterm-renderer.js';
import { timelineStore } from '../timeline-store.js';
import { renderTimeline } from '../renderers/timeline-renderer.js';
import { switchToPort } from './session-button.js';
import { ConnectionManager } from '../connection-manager.js';
import { dlog, dinfo } from '../log.js';
import { readFileSync } from 'fs';
import { homedir } from 'os';

const POLL_INTERVAL = 2000;
const SKIP_AFTER_ACTION = 3000;
// After a rotate, do a quick one-shot refresh based on the active iTerm TTY
// so the dial label updates immediately instead of waiting for the poll.
const FAST_REFRESH_DELAY_MS = 120;
const PIXMAP_LAYOUT = 'layouts/voice-layout.json';
const SESSIONS_FILE = `${homedir()}/.agentdeck/sessions.json`;

let currentState = State.DISCONNECTED;
let sessions: ItermSession[] = [];
let activeIndex = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastActionAt = 0;
let polling = false;
let currentLayout = PIXMAP_LAYOUT;
let bridgeRef: ConnectionManager | null = null;
let currentAgentType: AgentType | null = null;
let currentCapabilities: AgentCapabilities | null = null;
let currentSessionStatus: OcSessionStatus | null = null;
let exposeActive = false;
let exposeTimeout: ReturnType<typeof setTimeout> | null = null;
const EXPOSE_TIMEOUT_MS = 8000;
let fastRotateTimer: ReturnType<typeof setTimeout> | null = null;

function clearExposeTimeout(): void {
  if (exposeTimeout) { clearTimeout(exposeTimeout); exposeTimeout = null; }
}

function startExposeTimeout(): void {
  clearExposeTimeout();
  exposeTimeout = setTimeout(() => {
    exposeActive = false;
    exposeTimeout = null;
    void exposeCancel();
  }, EXPOSE_TIMEOUT_MS);
}

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
  if (currentCapabilities && !currentCapabilities.hasTerminal) return;
  if (polling) return;
  if (Date.now() - lastActionAt < SKIP_AFTER_ACTION) return;
  polling = true;
  try {
    const [rawSessions, activeTty, tmuxClientMap, liveTmuxNames, itermFront] = await Promise.all([
      getItermSessions(),
      getActiveItermTty(),
      getTmuxSessionMap(),
      getLiveTmuxSessionNames(),
      isItermFrontmost(),
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
    // Only when iTerm is frontmost — prevents overriding explicit session switches
    // while user is in a non-terminal app (e.g. VS Code)
    // Skip auto-switch when user explicitly selected OpenClaw
    if (activeTty && bridgeRef && itermFront && bridgeRef.getActiveAgentType() !== 'openclaw') {
      const currentPort = bridgeRef.getBridgePort();

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

/** Suppress iTerm auto-switch for SKIP_AFTER_ACTION ms (called by manual session cycling) */
export function suppressAutoSwitch(): void {
  lastActionAt = Date.now();
}

export function initItermDial(bridge: ConnectionManager): void {
  bridgeRef = bridge;
  dinfo('ItermDial', 'initItermDial called');
  // Timeline store change → re-render right panel when in OC mode
  timelineStore.onChange(() => {
    if (currentCapabilities && !currentCapabilities.hasTerminal && !isEncoderTakeoverActive() && !isVoiceTextTakeoverActive()) {
      renderTimelineRightPanel();
    }
  });
}

function renderTimelineRightPanel(): void {
  if (encoderRegistry.itermIds.length === 0) return;
  ensurePixmapLayout();
  const { panels } = renderTimeline(
    timelineStore.getGroupedDisplay(),
    timelineStore.getScrollIndex(),
    timelineStore.isDetailMode(),
    currentSessionStatus,
  );
  const feedback = { canvas: svgToDataUrl(panels[1]) };
  for (const id of encoderRegistry.itermIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) void dial.setFeedback(feedback).catch(() => {});
  }
}

export function updateItermDialState(state: State, agentType?: AgentType | null, sessionStatus?: OcSessionStatus | null, capabilities?: AgentCapabilities | null): void {
  currentState = state;
  if (agentType !== undefined) currentAgentType = agentType;
  if (capabilities !== undefined) currentCapabilities = capabilities ?? null;
  if (sessionStatus !== undefined) currentSessionStatus = sessionStatus ?? null;
  // Do NOT reset currentLayout here — causes setFeedbackLayout on every state update → SD flicker.
  // Layout is reset only on encoder takeover exit (via resetEncoderLayouts hook below).

  if (currentCapabilities && !currentCapabilities.hasTerminal) {
    stopPolling();
    renderTimelineRightPanel();
    return;
  }

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
  // OC mode: redirect to timeline rendering
  if (currentCapabilities && !currentCapabilities.hasTerminal) {
    renderTimelineRightPanel();
    return;
  }

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
    // OC mode: render timeline, skip iTerm polling
    if (currentCapabilities && !currentCapabilities.hasTerminal) {
      renderTimelineRightPanel();
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
    if (currentCapabilities && !currentCapabilities.hasTerminal) {
      timelineStore.scroll(ev.payload.ticks);
      return;
    }
    lastActionAt = Date.now();

    if (exposeActive) {
      // Arrow key navigation within Exposé
      void exposeNavigate(ev.payload.ticks > 0 ? 'right' : 'left');
      startExposeTimeout();
      return;
    }

    // Cmd+~ / Cmd+Shift+~ window cycling
    if (ev.payload.ticks > 0) {
      void cycleItermWindowNext();
    } else {
      void cycleItermWindowPrev();
    }

    // Quick one-shot refresh: after a short delay (allow focus switch to settle),
    // read active iTerm TTY and sync the index so the name updates instantly.
    if (fastRotateTimer) clearTimeout(fastRotateTimer);
    fastRotateTimer = setTimeout(async () => {
      try {
        const tty = await getActiveItermTty();
        if (!tty) return;
        const idx = sessions.findIndex((s) => s.tty === tty);
        if (idx !== -1 && idx !== activeIndex) {
          activeIndex = idx;
          refreshItermDials();
        }
      } catch {
        // ignore fast refresh errors
      }
    }, FAST_REFRESH_DELAY_MS);
  }

  override async onDialDown(_ev: DialDownEvent): Promise<void> {
    if (isPickerActive()) { void selectProject(); return; }
    if (isEncoderTakeoverActive()) { handleTakeoverPush(); return; }
    if (isVoiceTextTakeoverActive()) { handleVtDown(); return; }
    if (currentCapabilities && !currentCapabilities.hasTerminal) {
      timelineStore.toggleDetail();
      return;
    }

    if (!exposeActive) {
      exposeActive = true;
      void enterItermExpose();
      startExposeTimeout();
    }
  }

  override async onDialUp(_ev: DialUpEvent): Promise<void> {
    if (isEncoderTakeoverActive()) return;
    if (isVoiceTextTakeoverActive()) { handleVtUp(); return; }
    if (currentCapabilities && !currentCapabilities.hasTerminal) return;

    if (exposeActive) {
      exposeActive = false;
      clearExposeTimeout();
      void exposeConfirm();
      return;
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
