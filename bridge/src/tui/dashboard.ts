/**
 * TUI Dashboard — main entry point.
 * WS client connects to running Bridge/Daemon, renders real-time state.
 */

import WebSocket from 'ws';
import type {
  BridgeEvent, StateUpdateEvent, UsageEvent,
  SessionsListEvent, SessionInfo, TimelineEventMsg, TimelineHistoryMsg,
} from '@agentdeck/shared';
import type { TimelineEntry } from '@agentdeck/shared';
import { listActive, findDaemonPort } from '../session-registry.js';
import { Screen } from './screen.js';
import {
  renderDashboard, getLayout, shouldShowTerrarium, spinner,
} from './renderer.js';
import {
  initTerrarium, updateTerrarium, setOctopi, setCrayfish,
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
  timeline: TimelineEntry[];
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
    timeline: [],
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
      // Larger screens → bigger terrarium (up to 55% for wide, 40% for standard)
      const tH = layout === 'wide'
        ? Math.max(3, Math.floor((rows - 3) * (rows >= 40 ? 0.55 : 0.45)))
        : Math.max(3, Math.min(12, Math.floor((rows - 6) * 0.38)));
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
      case 'up':
      case 'k':
        scrollOffset = Math.min(scrollOffset + 1, Math.max(0, state.timeline.length - 5));
        render();
        break;
      case 'down':
      case 'j':
        scrollOffset = Math.max(0, scrollOffset - 1);
        render();
        break;
      default:
        // 1-9: switch session
        if (key >= '1' && key <= '9') {
          const idx = parseInt(key, 10) - 1;
          if (idx < state.sessions.length) {
            const sess = state.sessions[idx];
            if (sess.port && sess.port !== targetPort) {
              targetPort = sess.port;
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
    if (ws) {
      ws.removeAllListeners();
      ws.close();
    }
    screen.cleanup();
    process.exit(0);
  }

  function connect(): void {
    if (ws) {
      ws.removeAllListeners();
      ws.close();
    }

    state.connectionStatus = 'reconnecting';

    try {
      ws = new WebSocket(`ws://127.0.0.1:${targetPort}`);
    } catch {
      scheduleReconnect();
      return;
    }

    ws.on('open', () => {
      state.connectionStatus = 'connected';
      state.isStale = false;
      render();
    });

    ws.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString()) as BridgeEvent;
        handleEvent(event);
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on('close', () => {
      state.connectionStatus = 'disconnected';
      state.isStale = true;
      receivingBridgeTimeline = false; // Resume local generation on reconnect
      render();
      scheduleReconnect();
    });

    ws.on('error', () => {
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
        state.state = e.state;
        state.projectName = e.projectName || state.projectName;
        state.modelName = e.modelName || state.modelName;
        state.currentTool = e.currentTool || null;
        state.agentType = e.agentType || state.agentType;
        state.gatewayAvailable = e.gatewayAvailable || false;
        state.gatewayHasError = e.gatewayHasError || false;
        if (e.state === 'processing' && e.agentType === 'openclaw') {
          state.crayfishRouting = true;
        }
        // Voice assistant state piggybacked on state_update
        if (e.voiceAssistantState !== undefined) {
          state.voiceAssistantState = e.voiceAssistantState;
        }
        state.voiceAssistantText = e.voiceAssistantText || null;
        state.voiceAssistantResponseText = e.voiceAssistantResponseText || null;
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
