/**
 * Session Timeline Relay — daemon subscribes to sibling session bridges'
 * WebSocket servers to relay their timeline events to all daemon clients.
 *
 * This eliminates the need for Android/Apple/TUI clients to implement their
 * own StateTimelineGenerator — the daemon provides a unified timeline stream.
 */

import WebSocket from 'ws';
import { listActive as listActiveSessions, type SessionEntry } from './session-registry.js';
import type { BridgeTimelineStore } from './timeline-store.js';
import type { TimelineEntry, ModelCatalogEntry } from './types.js';
import { debug } from './logger.js';

const TAG = 'timeline-relay';
const RECONNECT_DELAY_MS = 5_000;
const SYNC_INTERVAL_MS = 10_000;

interface SessionSubscription {
  ws: WebSocket | null;
  port: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

export class SessionTimelineRelay {
  private subscriptions = new Map<string, SessionSubscription>(); // sessionId → sub
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private selfPort: number;
  private timeline: BridgeTimelineStore;
  private onModelCatalog?: (models: ModelCatalogEntry[]) => void;

  constructor(selfPort: number, timeline: BridgeTimelineStore) {
    this.selfPort = selfPort;
    this.timeline = timeline;
  }

  /** Register callback for modelCatalog received from sibling state_update */
  setOnModelCatalog(fn: (models: ModelCatalogEntry[]) => void): void {
    this.onModelCatalog = fn;
  }

  /** Start periodic scanning for new/removed session bridges */
  start(): void {
    this.sync();
    this.syncTimer = setInterval(() => this.sync(), SYNC_INTERVAL_MS);
  }

  stop(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    for (const [id, sub] of this.subscriptions) {
      sub.closed = true;
      if (sub.reconnectTimer) clearTimeout(sub.reconnectTimer);
      sub.ws?.close();
      this.subscriptions.delete(id);
    }
  }

  /** Sync subscriptions with active sessions list */
  private sync(): void {
    const sessions = listActiveSessions();
    const siblings = sessions.filter(
      (s) => s.port !== this.selfPort && s.agentType !== 'daemon',
    );

    const activeIds = new Set(siblings.map((s) => s.id));

    // Remove subscriptions for sessions that no longer exist
    for (const [id, sub] of this.subscriptions) {
      if (!activeIds.has(id)) {
        debug(TAG, `Session ${id} gone, removing subscription`);
        sub.closed = true;
        if (sub.reconnectTimer) clearTimeout(sub.reconnectTimer);
        sub.ws?.close();
        this.subscriptions.delete(id);
      }
    }

    // Add subscriptions for new sessions
    for (const session of siblings) {
      if (!this.subscriptions.has(session.id)) {
        this.subscribe(session);
      }
    }
  }

  private subscribe(session: SessionEntry): void {
    const sub: SessionSubscription = {
      ws: null,
      port: session.port,
      reconnectTimer: null,
      closed: false,
    };
    this.subscriptions.set(session.id, sub);
    this.connect(session.id, sub);
  }

  private connect(sessionId: string, sub: SessionSubscription): void {
    if (sub.closed) return;

    const ws = new WebSocket(`ws://127.0.0.1:${sub.port}`);
    sub.ws = ws;
    const session = listActiveSessions().find((s) => s.id === sessionId);
    const enrichEntry = (entry: TimelineEntry): TimelineEntry => ({
      ...entry,
      projectName: entry.projectName ?? session?.projectName,
      sessionId: entry.sessionId ?? sessionId,
      agentType: entry.agentType ?? session?.agentType,
    });

    ws.on('open', () => {
      debug(TAG, `Connected to session ${sessionId} on port ${sub.port}`);
    });

    ws.on('message', (raw: Buffer | string) => {
      try {
        const evt = JSON.parse(raw.toString());
        if (evt.type === 'timeline_event' && evt.entry) {
          const entry = enrichEntry(evt.entry as TimelineEntry);
          if (evt.upsert) this.timeline.upsertEntry(entry);
          else this.timeline.addEntry(entry);
        } else if (evt.type === 'timeline_history' && Array.isArray(evt.entries)) {
          for (const entry of evt.entries as TimelineEntry[]) {
            this.timeline.addEntry(enrichEntry(entry));
          }
        } else if (evt.type === 'state_update' && Array.isArray(evt.modelCatalog) && evt.modelCatalog.length > 0) {
          this.onModelCatalog?.(evt.modelCatalog as ModelCatalogEntry[]);
        }
      } catch {
        // Ignore non-JSON or irrelevant messages
      }
    });

    ws.on('close', () => {
      sub.ws = null;
      if (!sub.closed) {
        sub.reconnectTimer = setTimeout(() => {
          sub.reconnectTimer = null;
          this.connect(sessionId, sub);
        }, RECONNECT_DELAY_MS);
      }
    });

    ws.on('error', () => {
      // Error triggers close event — reconnect handled there
    });
  }
}
