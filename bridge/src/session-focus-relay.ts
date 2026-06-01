/**
 * Session Focus Relay — daemon subscribes to a focused session bridge's
 * WebSocket to relay its full state events to all daemon clients,
 * and routes commands from daemon clients to the focused session.
 *
 * Each plugin WS connection (identified by a Symbol ClientToken) maintains
 * its own focus. Multiple clients can focus the same session; the relay
 * refcounts the underlying WS connection and closes it only when the last
 * client unfocuses that session.
 *
 * Events are passed to onEvent callback (not broadcast directly) so the
 * daemon can merge session state with daemon-level metadata before
 * broadcasting.
 */

import WebSocket from 'ws';
import { listActive as listActiveSessions } from './session-registry.js';
import type { PluginCommand, BridgeEvent } from './types.js';
import { debug } from './logger.js';

const TAG = 'focus-relay';

/** Events relayed from focused session to daemon clients */
const RELAYED_EVENTS = new Set([
  'state_update',
  'prompt_options',
  'usage_update',
]);

/** Commands routed from daemon clients to focused session */
const ROUTED_COMMANDS = new Set([
  'respond',
  'interrupt',
  'escape',
  'select_option',
  'send_prompt',
  'navigate_option',
  'switch_mode',
]);

/**
 * Whether a command is an interactive command that targets the focused session
 * (respond / select_option / send_prompt / navigate / interrupt / mode switch).
 * Used by the daemon to decide gateway-vs-session routing priority.
 */
export function isRoutedCommand(type: string): boolean {
  return ROUTED_COMMANDS.has(type);
}

export type FocusEventHandler = (event: BridgeEvent) => void;

/** Unique identity for each plugin WS connection. */
export type ClientToken = symbol;

/** Shared WS connection to a session bridge, refcounted across clients. */
interface SessionConn {
  ws: WebSocket;
  /** Resolves when the WS reaches OPEN state. Rejects on error/close before open. */
  openPromise: Promise<void>;
  refcount: number;
}

/** Per-client focus entry */
interface FocusEntry {
  sessionId: string;
  conn: SessionConn;
}

export class SessionFocusRelay {
  /** Per-client focus state */
  private clientFocus = new Map<ClientToken, FocusEntry>();
  /** Shared WS connections keyed by sessionId (refcounted) */
  private sessionConns = new Map<string, SessionConn>();
  /**
   * Last relayed state_update + prompt_options per session. Lets an idempotent
   * re-focus (re-entering the detail view while the WS stays open) replay the
   * current prompt instead of showing nothing until the session next emits.
   * See interaction audit #1 (选项时有时无).
   */
  private lastRelayed = new Map<string, { state?: BridgeEvent; options?: BridgeEvent }>();
  /** Single event handler (daemon merges & broadcasts) */
  private onEvent: FocusEventHandler | null = null;
  /**
   * Fired when a focused session's WS closes — once per client that was
   * focusing that session. Daemon reverse-maps token → plugin WS and pushes
   * a focus_lost event so the client can clear its local focus.
   */
  private onFocusLost: ((token: ClientToken, sessionId: string) => void) | null = null;
  private closed = false;

  /** Set handler for relayed events. Daemon should merge and broadcast. */
  setEventHandler(handler: FocusEventHandler): void {
    this.onEvent = handler;
  }

  /** Set handler for focus-lost notifications (session WS died). */
  setOnFocusLost(handler: (token: ClientToken, sessionId: string) => void): void {
    this.onFocusLost = handler;
  }

  /**
   * Get the currently focused session ID for any client.
   * Returns the first non-null focus found (backward-compat with daemon
   * code that calls getFocusedSessionId() for metadata merging).
   */
  getFocusedSessionId(): string | null {
    for (const entry of this.clientFocus.values()) {
      return entry.sessionId;
    }
    return null;
  }

  /**
   * Focus a session for a specific client token.
   *
   * - Idempotent: if the client already focuses the same session, no-op.
   * - If the client had a different focus, the old session refcount is
   *   decremented (WS closed if refcount → 0).
   * - If another client already focuses the same session, the existing WS
   *   connection is reused (refcount++).
   */
  focus(token: ClientToken, sessionId: string): void {
    if (this.closed) return;

    const existing = this.clientFocus.get(token);
    if (existing && existing.sessionId === sessionId) {
      // Idempotent re-focus (e.g. re-entering the detail view): the WS stays
      // open so onClientConnect won't re-fire on the session side. Replay the
      // cached state so the prompt repaints instead of vanishing (audit #1).
      debug(TAG, `[${String(token)}] Already focused on ${sessionId} — replaying cached state`);
      this._replayCached(sessionId);
      return;
    }

    // Release old focus for this client
    if (existing) {
      this._decrementRef(existing.sessionId);
    }

    // Locate the session in the registry
    const sessions = listActiveSessions();
    const session = sessions.find(s => s.id === sessionId && s.agentType !== 'daemon');
    if (!session) {
      debug(TAG, `Session ${sessionId} not found or is daemon`);
      return;
    }

    // Acquire (or share) the connection for this session
    const conn = this._acquireConn(sessionId, session.port);
    this.clientFocus.set(token, { sessionId, conn });
    debug(TAG, `[${String(token)}] Focused session ${session.projectName}:${session.port}`);
  }

  /**
   * Unfocus the current session for a specific client token.
   * Decrements refcount; closes WS if it hits 0.
   */
  unfocus(token: ClientToken): void {
    const entry = this.clientFocus.get(token);
    if (!entry) return;
    this.clientFocus.delete(token);
    this._decrementRef(entry.sessionId);
    debug(TAG, `[${String(token)}] Unfocused session ${entry.sessionId}`);
  }

  /**
   * Route a command to the session focused by the given client token.
   *
   * Awaits the session WS being OPEN before sending — no setTimeout race.
   *
   * @param token     Client identity token
   * @param cmd       The PluginCommand to route
   * @param sessionId Optional: if the client has no focus yet, implicitly
   *                  focus this session first (supports session_command without
   *                  a prior focus_session).
   * @returns true if the command was routed; false if unroutable.
   */
  async routeCommand(token: ClientToken, cmd: PluginCommand, sessionId?: string): Promise<boolean> {
    if (!ROUTED_COMMANDS.has(cmd.type)) return false;

    // Implicit focus if the client has no current focus and sessionId is given
    if (!this.clientFocus.has(token) && sessionId) {
      this.focus(token, sessionId);
    }

    const entry = this.clientFocus.get(token);
    if (!entry) return false;

    try {
      await entry.conn.openPromise;
    } catch {
      // WS failed to open — cannot route
      debug(TAG, `[${String(token)}] WS for session ${entry.sessionId} failed to open`);
      return false;
    }

    if (entry.conn.ws.readyState !== WebSocket.OPEN) {
      debug(TAG, `[${String(token)}] WS for session ${entry.sessionId} not OPEN after wait`);
      return false;
    }

    debug(TAG, `[${String(token)}] Routing ${cmd.type} → session ${entry.sessionId}`);
    entry.conn.ws.send(JSON.stringify(cmd));
    return true;
  }

  /** Stop relay entirely — unfocus all clients and close all WS connections. */
  stop(): void {
    this.closed = true;
    for (const [sessionId, conn] of this.sessionConns) {
      conn.ws.removeAllListeners();
      conn.ws.close();
      debug(TAG, `Closed WS for session ${sessionId} (relay stopped)`);
    }
    this.sessionConns.clear();
    this.clientFocus.clear();
    this.lastRelayed.clear();
  }

  /** Interactive states whose prompt_options are worth replaying on re-focus. */
  private static readonly INTERACTIVE_STATES = new Set([
    'awaiting_option', 'awaiting_permission', 'awaiting_diff',
  ]);

  /** Remember the latest relayed state/options so a re-focus can replay them. */
  private _cacheRelayed(sessionId: string, evt: BridgeEvent): void {
    let entry = this.lastRelayed.get(sessionId);
    if (!entry) { entry = {}; this.lastRelayed.set(sessionId, entry); }
    if (evt.type === 'state_update') {
      entry.state = evt;
      // Once the session leaves an interactive state, its cached options are
      // stale — drop them so we never replay a prompt that's already answered.
      const st = (evt as unknown as { state?: string }).state;
      if (!st || !SessionFocusRelay.INTERACTIVE_STATES.has(st)) entry.options = undefined;
    } else if (evt.type === 'prompt_options') {
      entry.options = evt;
    }
  }

  /** Re-emit the cached state_update (+ prompt_options) for a session. */
  private _replayCached(sessionId: string): void {
    const entry = this.lastRelayed.get(sessionId);
    if (!entry) return;
    if (entry.state) {
      debug(TAG, `Replay cached state_update for session ${sessionId}`);
      this.onEvent?.(entry.state);
    }
    if (entry.options) {
      debug(TAG, `Replay cached prompt_options for session ${sessionId}`);
      this.onEvent?.(entry.options);
    }
  }

  // ─── Internal helpers ──────────────────────────────────────────────────────

  /**
   * Acquire (or share) a WS connection to a session.
   * If one already exists the refcount is incremented and the same conn
   * object is returned.  Otherwise a new connection is created.
   */
  private _acquireConn(sessionId: string, port: number): SessionConn {
    const existing = this.sessionConns.get(sessionId);
    if (existing) {
      existing.refcount++;
      debug(TAG, `Shared WS for session ${sessionId} refcount=${existing.refcount}`);
      return existing;
    }

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);

    const openPromise = new Promise<void>((resolve, reject) => {
      ws.once('open', () => {
        debug(TAG, `Connected to session ${sessionId} on port ${port}`);
        resolve();
      });
      ws.once('error', (err) => {
        debug(TAG, `WS error for session ${sessionId}: ${err}`);
        reject(err);
      });
      ws.once('close', () => {
        // If close fires before open, treat as rejection
        reject(new Error(`WS closed before opening for session ${sessionId}`));
      });
    });

    const conn: SessionConn = { ws, openPromise, refcount: 1 };
    this.sessionConns.set(sessionId, conn);

    ws.on('message', (raw: Buffer | string) => {
      try {
        const evt = JSON.parse(raw.toString()) as BridgeEvent;
        if (RELAYED_EVENTS.has(evt.type)) {
          debug(TAG, `Relay ${evt.type} from session ${sessionId}`);
          this._cacheRelayed(sessionId, evt);
          this.onEvent?.(evt);
        }
      } catch {
        // Ignore non-JSON messages
      }
    });

    ws.on('close', () => {
      // Only act if this conn is still the live conn for the session — guards
      // against a stale closed WS firing after the session reconnected on a
      // fresh conn (avoids double-fire / spurious focus_lost).
      if (this.sessionConns.get(sessionId) === conn) {
        // Notify every client that was focusing this exact conn BEFORE we
        // evict, so each focused client gets exactly one focus_lost.
        for (const [token, entry] of this.clientFocus.entries()) {
          if (entry.conn === conn) {
            this.onFocusLost?.(token, entry.sessionId);
          }
        }
        debug(TAG, `Session ${sessionId} WS closed (evicting from conn pool)`);
        this.sessionConns.delete(sessionId);
        this.lastRelayed.delete(sessionId); // session gone — cached prompt is stale
      }
    });

    ws.on('error', () => {
      // Handled by openPromise rejection; listener needed to prevent unhandled error events
    });

    return conn;
  }

  /**
   * Decrement refcount for a session connection. Closes the WS when it
   * reaches zero.
   */
  private _decrementRef(sessionId: string): void {
    const conn = this.sessionConns.get(sessionId);
    if (!conn) return;

    conn.refcount--;
    debug(TAG, `Decrement WS refcount for session ${sessionId} → ${conn.refcount}`);

    if (conn.refcount <= 0) {
      conn.ws.removeAllListeners();
      conn.ws.close();
      this.sessionConns.delete(sessionId);
      this.lastRelayed.delete(sessionId); // last focuser left — cached prompt is stale
      debug(TAG, `Closed WS for session ${sessionId} (refcount=0)`);
    }
  }
}
