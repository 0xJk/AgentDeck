/**
 * TUI Dashboard — main entry point.
 * WS client connects to running Bridge/Daemon, renders real-time state.
 */

import WebSocket from 'ws';
import type {
  BridgeEvent, StateUpdateEvent, UsageEvent,
  SessionsListEvent, SessionInfo, TimelineEventMsg, TimelineHistoryMsg,
  ModelCatalogEntry,
} from '@agentdeck/shared';
import type { TimelineEntry } from '@agentdeck/shared';
import { listActive, findDaemonPort } from '../session-registry.js';
import { Screen } from './screen.js';
import {
  renderDashboard, getLayout, shouldShowTerrarium, spinner, buildHudEntries,
} from './renderer.js';
import {
  initTerrarium, updateTerrarium, setOctopi, setJellyfish, setOpenCode, setCrayfish,
  setVoiceAssistantState, renderTerrariumFrame,
} from './terrarium.js';

// ===== Types =====

export type LayoutMode = 'wide' | 'standard' | 'narrow';

export interface DashboardState {
  state: string;
  connectionStatus: 'connected' | 'reconnecting' | 'disconnected';
  isStale: boolean;
  projectName: string | null;
  modelName: string | null;
  currentTool: string | null;
  sessions: SessionInfo[];
  usage: UsageEvent | null;
  modelCatalog: ModelCatalogEntry[];
  timeline: TimelineEntry[];
  helpVisible: boolean;
  currentPort: number | null;
  agentType: string | null;
  gatewayAvailable: boolean;
  crayfishRouting: boolean;
  gatewayHasError: boolean;
  voiceAssistantState: string;
  voiceAssistantText: string | null;
  voiceAssistantResponseText: string | null;
}

export interface DashboardOptions {
  port?: string;
  session?: string;
}

export function applyStateUpdate(state: DashboardState, e: StateUpdateEvent): void {
  state.state = e.state;
  state.projectName = e.projectName || state.projectName;
  state.modelName = e.modelName || state.modelName;
  state.currentTool = e.currentTool || null;
  state.agentType = e.agentType || state.agentType;
  if (e.modelCatalog !== undefined) {
    state.modelCatalog = e.modelCatalog;
  }
  state.gatewayAvailable = e.gatewayAvailable || false;
  state.gatewayHasError = e.gatewayHasError || false;
  if (e.state === 'processing' && e.agentType === 'openclaw') {
    state.crayfishRouting = true;
  }
  if (e.voiceAssistantState !== undefined) {
    state.voiceAssistantState = e.voiceAssistantState;
  }
  state.voiceAssistantText = e.voiceAssistantText || null;
  state.voiceAssistantResponseText = e.voiceAssistantResponseText || null;
}

// ===== Dashboard =====

export async function startDashboard(opts: DashboardOptions): Promise<void> {
  // Check TTY
  if (!process.stdout.isTTY) {
    // Non-TTY: output JSON snapshot and exit
    const sessions = listActive();
    process.stdout.write(JSON.stringify({ sessions }, null, 2) + '\n');
    return;
  }

  // Discover target port
  let targetPort: number;
  if (opts.port) {
    targetPort = parseInt(opts.port, 10);
  } else {
    const daemonPort = findDaemonPort();
    if (daemonPort) {
      targetPort = daemonPort;
    } else {
      process.stderr.write(
        'No AgentDeck daemon running.\n' +
        'Start with: agentdeck daemon start\n'
      );
      process.exit(1);
    }
  }

  // State
  const state: DashboardState = {
    state: 'disconnected',
    connectionStatus: 'disconnected',
    isStale: false,
    projectName: null,
    modelName: null,
    currentTool: null,
    sessions: [],
    usage: null,
    modelCatalog: [],
    timeline: [],
    helpVisible: false,
    currentPort: targetPort,
    agentType: null,
    gatewayAvailable: false,
    crayfishRouting: false,
    gatewayHasError: false,
    voiceAssistantState: 'disabled',
    voiceAssistantText: null,
    voiceAssistantResponseText: null,
  };

  const terrCtx = initTerrarium();
  let frame = 0;
  let scrollOffset = 0;
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let terrariumTimer: ReturnType<typeof setInterval> | null = null;
  let renderTimer: ReturnType<typeof setInterval> | null = null;

  // Screen
  const screen = new Screen({
    onResize: () => render(),
    onKey: handleKey,
  });

  function render(): void {
    const { cols, rows } = screen;

    // Update terrarium creatures from state
    // Daemon-like: sessions list already contains all agents. Just pass through.
    // Session bridge: sessions has siblings only — prepend self.
    const octSessions: Array<{ id?: string; state: string; name?: string; agentType?: string }> = state.sessions
      .map(s => ({ id: s.id, state: s.state || 'idle', name: s.projectName, agentType: s.agentType as string | undefined }));

    const isDaemonLikeRender = state.agentType === 'daemon' ||
      (state.agentType && state.sessions.some(s => s.agentType === state.agentType));
    if (!isDaemonLikeRender && state.state && state.state !== 'disconnected') {
      // Session bridge mode: add self if not already present
      const selfInList = octSessions.some(s => s.name === state.projectName && s.agentType === (state.agentType ?? undefined));
      if (!selfInList) {
        octSessions.unshift({ id: 'primary', state: state.state, name: state.projectName ?? undefined, agentType: state.agentType ?? undefined });
      }
    }
    setOctopi(terrCtx, octSessions);
    setJellyfish(terrCtx, octSessions);
    setOpenCode(terrCtx, octSessions);

    // Crayfish
    const ocSibling = state.sessions.find(s =>
      s.agentType === 'openclaw' || (s as any).agentType === 'gateway'
    );
    setCrayfish(terrCtx, state.gatewayAvailable || !!ocSibling, state.crayfishRouting, ocSibling?.projectName, state.gatewayHasError);

    // Render terrarium
    const layout = getLayout(cols, rows);
    const showTerr = shouldShowTerrarium(cols, rows);
    let terrLines: string[] = [];
    if (showTerr) {
      // Keep terrarium visible, but leave more room for status/timeline in monitoring mode.
      const tH = layout === 'wide'
        ? Math.max(3, Math.floor((rows - 3) * (rows >= 40 ? 0.42 : 0.34)))
        : Math.max(3, Math.min(10, Math.floor((rows - 6) * 0.28)));
      const tW = layout === 'wide'
        ? cols - Math.max(20, Math.floor(cols * 0.22)) - 3
        : cols - 2;
      setVoiceAssistantState(terrCtx, state.voiceAssistantState);
      terrLines = renderTerrariumFrame(terrCtx, tW, tH, frame);
    }

    const output = renderDashboard(state, cols, rows, terrLines, frame, scrollOffset);
    screen.write(output);
  }

  function handleKey(key: string): void {
    switch (key) {
      case 'q':
        shutdown();
        break;
      case 'h':
      case '?':
        state.helpVisible = !state.helpVisible;
        render();
        break;
      case '\x1b':
        if (state.helpVisible) {
          state.helpVisible = false;
          render();
        }
        break;
      case 'up':
      case 'k':
        if (state.helpVisible) break;
        scrollOffset = Math.min(scrollOffset + 1, Math.max(0, state.timeline.length - 5));
        render();
        break;
      case 'down':
      case 'j':
        if (state.helpVisible) break;
        scrollOffset = Math.max(0, scrollOffset - 1);
        render();
        break;
      default:
        if (state.helpVisible) break;
        // 1-9: switch session — uses the same buildHudEntries pipeline as
        // the renderer so hotkey indices align with what's drawn on screen
        // (primary self and the virtual OpenClaw row never claim a hotkey).
        if (key >= '1' && key <= '9') {
          const idx = parseInt(key, 10) - 1;
          const focusable = buildHudEntries(state).filter((e) =>
            !e.isPrimary && !e.isVirtualOpenClaw && e.port !== undefined && e.controlMode !== 'observed'
          );
          if (idx < focusable.length) {
            const sess = focusable[idx]!;
            if (sess.port !== undefined && sess.port !== targetPort) {
              targetPort = sess.port;
              state.currentPort = targetPort;
              reconnect();
            }
          }
        }
        break;
    }
  }

  function shutdown(): void {
    if (terrariumTimer) clearInterval(terrariumTimer);
    if (renderTimer) clearInterval(renderTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    clearActivityTimer();
    closeSocket();
    screen.cleanup();
    process.exit(0);
  }

  function closeSocket(): void {
    if (!ws) return;
    const socket = ws;
    ws = null;

    // `ws` throws/aborts on CONNECTING close(). Swallow shutdown noise and
    // ignore any late events from stale sockets.
    socket.on('error', () => {});
    socket.on('close', () => {});

    try {
      socket.close();
    } catch {
      // Ignore reconnect/shutdown race errors.
    }
  }

  // Activity timeout: if no WS message arrives within this window, the
  // connection is considered stale (daemon crashed / port in TIME_WAIT).
  const ACTIVITY_TIMEOUT_MS = 20_000;
  const PING_INTERVAL_MS = 10_000;
  let activityTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  function resetActivityTimer(socket: WebSocket): void {
    if (activityTimer) clearTimeout(activityTimer);
    activityTimer = setTimeout(() => {
      if (socket !== ws) return;
      // No message from daemon for 20s — treat as dead connection.
      state.connectionStatus = 'disconnected';
      state.isStale = true;
      receivingBridgeTimeline = false;
      render();
      closeSocket();
      scheduleReconnect();
    }, ACTIVITY_TIMEOUT_MS);
  }

  function clearActivityTimer(): void {
    if (activityTimer) { clearTimeout(activityTimer); activityTimer = null; }
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  }

  function connect(): void {
    closeSocket();
    clearActivityTimer();

    state.connectionStatus = 'reconnecting';

    let socket: WebSocket;
    try {
      socket = new WebSocket(`ws://127.0.0.1:${targetPort}`);
    } catch {
      scheduleReconnect();
      return;
    }
    ws = socket;

    socket.on('open', () => {
      if (socket !== ws) return;
      state.connectionStatus = 'connected';
      state.isStale = false;
      state.currentPort = targetPort;
      resetActivityTimer(socket);
      // Periodic ping so the daemon sends pong — keeps the activity timer fed.
      pingTimer = setInterval(() => {
        try { if (socket === ws && socket.readyState === WebSocket.OPEN) socket.ping(); } catch { /* ignore */ }
      }, PING_INTERVAL_MS);
      render();
    });

    socket.on('message', (data) => {
      if (socket !== ws) return;
      resetActivityTimer(socket);
      try {
        const event = JSON.parse(data.toString()) as BridgeEvent;
        handleEvent(event);
      } catch {
        // Ignore malformed messages
      }
    });

    socket.on('pong', () => {
      if (socket !== ws) return;
      resetActivityTimer(socket);
    });

    socket.on('close', () => {
      if (socket !== ws) return;
      clearActivityTimer();
      state.connectionStatus = 'disconnected';
      state.isStale = true;
      receivingBridgeTimeline = false;
      render();
      scheduleReconnect();
    });

    socket.on('error', () => {
      if (socket !== ws) return;
      // close event will fire after this
    });
  }

  function scheduleReconnect(): void {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      connect();
    }, 3000);
  }

  function reconnect(): void {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    connect();
  }

  let receivingBridgeTimeline = false;
  let prevState = '';
  let prevTool = '';

  /** Generate local timeline entry from state transitions (like Android StateTimelineGenerator) */
  function generateLocalTimeline(e: StateUpdateEvent): void {
    if (receivingBridgeTimeline) return;
    const now = Date.now();

    if (e.state !== prevState) {
      // First state_update after connect — log initial state
      if (prevState === '') {
        const stateLabel = e.state.toUpperCase().replace(/_/g, ' ');
        const project = e.projectName || '';
        const model = e.modelName ? ` \u00B7 ${e.modelName}` : '';
        pushTimeline({ ts: now, type: 'chat_start', raw: `Connected: ${project}${model} [${stateLabel}]` });
      }
      // State transitions
      else if (e.state === 'processing') {
        pushTimeline({ ts: now, type: 'chat_start', raw: e.currentTool ? `Tool: ${e.currentTool}` : 'Processing started' });
      } else if (e.state === 'idle' && (prevState === 'processing' || prevState.startsWith('awaiting'))) {
        pushTimeline({ ts: now, type: 'chat_end', raw: `Completed \u00B7 ${e.modelName || ''}` });
      } else if (e.state.startsWith('awaiting')) {
        const label = e.state === 'awaiting_permission' ? 'Permission required' :
                      e.state === 'awaiting_diff' ? 'Diff review' : 'Selection required';
        pushTimeline({ ts: now, type: 'user_action', raw: label });
      }

      prevState = e.state;
    }

    // Tool activity — track tool changes during processing
    const tool = e.currentTool || '';
    if (e.state === 'processing' && tool && tool !== prevTool) {
      pushTimeline({ ts: now, type: 'tool_request', raw: tool });
    }
    prevTool = tool;
  }

  function pushTimeline(entry: TimelineEntry): void {
    state.timeline.push(entry);
    if (state.timeline.length > 200) state.timeline = state.timeline.slice(-200);
    scrollOffset = 0;
  }

  function handleEvent(event: BridgeEvent): void {
    switch (event.type) {
      case 'state_update': {
        const e = event as StateUpdateEvent;
        generateLocalTimeline(e);
        applyStateUpdate(state, e);
        break;
      }
      case 'usage_update': {
        state.usage = event as UsageEvent;
        break;
      }
      case 'sessions_list': {
        const e = event as SessionsListEvent;
        state.sessions = e.sessions;
        // Update crayfish routing from sibling states
        const ocSibling = e.sessions.find(s =>
          s.agentType === 'openclaw' && s.state === 'processing'
        );
        state.crayfishRouting = !!ocSibling;
        break;
      }
      case 'timeline_event': {
        receivingBridgeTimeline = true; // Bridge sends richer events, suppress local generation
        const e = event as TimelineEventMsg;
        if (e.upsert) {
          // Update existing entry with same ts+type
          const idx = state.timeline.findIndex(
            t => t.ts === e.entry.ts && t.type === e.entry.type
          );
          if (idx >= 0) {
            state.timeline[idx] = e.entry;
          } else {
            state.timeline.push(e.entry);
          }
        } else {
          state.timeline.push(e.entry);
        }
        // Keep last 200 entries
        if (state.timeline.length > 200) {
          state.timeline = state.timeline.slice(-200);
        }
        // Auto-scroll to bottom on new events
        scrollOffset = 0;
        break;
      }
      case 'timeline_history': {
        receivingBridgeTimeline = true;
        const e = event as TimelineHistoryMsg;
        // Merge, dedup by ts
        const existing = new Set(state.timeline.map(t => `${t.ts}:${t.type}`));
        for (const entry of e.entries) {
          const key = `${entry.ts}:${entry.type}`;
          if (!existing.has(key)) {
            state.timeline.push(entry);
            existing.add(key);
          }
        }
        state.timeline.sort((a, b) => a.ts - b.ts);
        if (state.timeline.length > 200) {
          state.timeline = state.timeline.slice(-200);
        }
        break;
      }
    }
  }

  // ===== Start =====

  screen.enter();

  // Terrarium animation loop (10fps)
  terrariumTimer = setInterval(() => {
    frame++;
    updateTerrarium(terrCtx, frame);
  }, 100);

  // Render loop (4fps for info panels, terrarium updates via frame counter)
  renderTimer = setInterval(() => {
    render();
  }, 250);

  // Initial render
  render();

  // Connect
  connect();
}
