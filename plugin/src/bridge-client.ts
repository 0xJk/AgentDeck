import WebSocket from 'ws';
import { EventEmitter } from 'events';
import {
  BridgeEvent,
  PluginCommand,
  AgentCapabilities,
  BRIDGE_WS_PORT,
  RECONNECT_BACKOFF_MS,
  WS_ACTIVITY_TIMEOUT_MS,
} from '@agentdeck/shared';
import type { AgentLink } from './agent-link.js';
import { dlog, dwarn, derr } from './log.js';

export type PortProvider = () => number | null;

export interface BridgeClientOptions {
  host?: string;
  port?: number;
  token?: string;
}

function isLocalHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1';
}

export class BridgeClient extends EventEmitter implements AgentLink {
  private ws: WebSocket | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private _watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private _lastActivityAt = 0;
  private _connected = false;
  private _host = 'localhost';
  private _port = BRIDGE_WS_PORT;
  private _token = '';
  private _connectGeneration = 0;
  private _capabilities: AgentCapabilities | null = null;
  private _portProvider: PortProvider | null = null;
  private _backoffIdx = 0;

  constructor(opts?: BridgeClientOptions) {
    super();
    if (opts?.host != null) this._host = opts.host;
    if (opts?.port != null) this._port = opts.port;
    if (opts?.token != null) this._token = opts.token;
  }

  /** Active bridge host (default 'localhost'). */
  getHost(): string {
    return this._host;
  }

  /** True when the active bridge host is not loopback. */
  isRemote(): boolean {
    return !isLocalHost(this._host);
  }

  /**
   * AgentLink contract: a single BridgeClient's "active bridge" is simply its
   * own host, so this mirrors isRemote(). ConnectionManager overrides the
   * semantics at the manager level (active = the selected paired bridge).
   */
  isRemoteActiveBridge(): boolean {
    return this.isRemote();
  }

  /**
   * Compute the WebSocket URL for the current host/port/token. The token query
   * param is appended only when non-empty; loopback hosts with an empty token
   * (local daemon) connect without it (plan 001 §2a).
   */
  private buildUrl(): string {
    const base = `ws://${this._host}:${this._port}`;
    if (this._token) {
      return `${base}?token=${encodeURIComponent(this._token)}`;
    }
    return base;
  }

  /**
   * Install a port provider. Called before each (re)connect attempt.
   * Returning null skips that attempt — used when daemon.json is missing or
   * the recorded pid is dead. The same provider survives across reconnects.
   */
  setPortProvider(provider: PortProvider | null): void {
    this._portProvider = provider;
  }

  connect(port?: number): void {
    if (port != null) this._port = port;
    dlog('Bridge', `connect(port=${this._port})`);
    this.cleanup();
    this._connectGeneration++;
    const gen = this._connectGeneration;
    this._backoffIdx = 0;
    this.attemptConnect(gen);
  }

  /** Reconnect to a different session on a different port */
  reconnectTo(port: number): void {
    dlog('Bridge', `reconnectTo(port=${port})`);
    this._port = port;
    // Clean up old connection without emitting 'disconnected'
    this.cleanup();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
    this.connect(port);
  }

  disconnect(): void {
    dlog('Bridge', 'disconnect()');
    this.cleanup();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
    this.emit('disconnected');
  }

  send(command: PluginCommand): void {
    if (this.ws && this._connected) {
      dlog('Bridge', `send(${command.type})`);
      this.ws.send(JSON.stringify(command));
    } else {
      dwarn('Bridge', `send(${command.type}) dropped — not connected`);
    }
  }

  isConnected(): boolean {
    return this._connected;
  }

  getCapabilities(): AgentCapabilities | null {
    return this._capabilities;
  }

  getPort(): number {
    return this._port;
  }

  private scheduleReconnect(gen: number): void {
    if (gen !== this._connectGeneration) return;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    const delay = RECONNECT_BACKOFF_MS[
      Math.min(this._backoffIdx, RECONNECT_BACKOFF_MS.length - 1)
    ];
    if (this._backoffIdx < RECONNECT_BACKOFF_MS.length - 1) this._backoffIdx++;
    dlog('Bridge', `next attempt in ${delay}ms (backoffIdx=${this._backoffIdx})`);
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      if (gen !== this._connectGeneration) return;
      if (this._connected) return;
      this.attemptConnect(gen);
    }, delay);
  }

  private attemptConnect(gen: number): void {
    if (gen !== this._connectGeneration) return;

    // Resolve target port via provider on every attempt so that daemon port
    // drift (or daemon absence) is picked up without restarting the plugin.
    if (this._portProvider) {
      const resolved = this._portProvider();
      if (resolved == null) {
        dlog('Bridge', 'attemptConnect skipped: portProvider returned null (daemon offline)');
        if (this._connected) {
          // Daemon disappeared while we were connected — force a close so the
          // 'disconnected' event fires through the existing 'close' path.
          try { this.ws?.close(); } catch { /* ignore */ }
        }
        this.scheduleReconnect(gen);
        return;
      }
      if (resolved !== this._port) {
        dlog('Bridge', `port rebind ${this._port} -> ${resolved}`);
        this._port = resolved;
        if (this.ws) {
          const stale = this.ws;
          this.ws = null;
          stale.removeAllListeners();
          try { stale.close(); } catch { /* ignore */ }
        }
      }
    }

    if (this.ws) {
      if (this.ws.readyState === WebSocket.CONNECTING) {
        dlog('Bridge', 'attemptConnect skipped: socket still connecting')
        return;
      }
      const staleWs = this.ws;
      this.ws = null;
      staleWs.removeAllListeners();
      try {
        if (
          staleWs.readyState === WebSocket.OPEN ||
          staleWs.readyState === WebSocket.CLOSING
        ) {
          staleWs.close();
        }
      } catch (err) {
        dlog('Bridge', `stale socket cleanup ignored: ${err}`);
      }
    }

    try {
      const url = this.buildUrl();
      dlog('Bridge', `attemptConnect ${url} (gen=${gen})`);
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        if (gen !== this._connectGeneration) return;
        dlog('Bridge', 'WebSocket open');
        this._connected = true;
        this._backoffIdx = 0;
        this._lastActivityAt = Date.now();
        this.startWatchdog(gen);
        this.emit('connected');
      });

      this.ws.on('ping', () => {
        this._lastActivityAt = Date.now();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        if (gen !== this._connectGeneration) return;
        this._lastActivityAt = Date.now();
        try {
          const event = JSON.parse(data.toString()) as BridgeEvent;
          dlog('Bridge', `recv(${event.type})`);
          // Track agent capabilities from state updates
          if (event.type === 'state_update' && event.agentCapabilities) {
            this._capabilities = event.agentCapabilities;
          }
          this.emit(event.type, event);
        } catch (err) {
          derr('Bridge', `message parse error: ${err}`);
        }
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        if (gen !== this._connectGeneration) return;
        const wasConnected = this._connected;
        this._connected = false;
        // Surface the close-code so ConnectionManager can distinguish auth
        // rejection (4001) from a normal drop (plan 001 §2a).
        this.emit('close', { code, reason: reason?.toString() ?? '' });
        // 4001 = bad/expired token. Do NOT auto-reconnect — that would race the
        // ConnectionManager's pairing transition (codex r3 finding 5). Let the
        // manager decide the next step.
        if (code === 4001) {
          dlog('Bridge', 'WebSocket closed 4001 (unauthorized) — no auto-reconnect');
          if (wasConnected) this.emit('disconnected');
          return;
        }
        if (wasConnected) {
          dlog('Bridge', 'WebSocket closed (was connected)');
          this.emit('disconnected');
        }
        this.scheduleReconnect(gen);
      });

      this.ws.on('error', (err) => {
        if (gen !== this._connectGeneration) return;
        dlog('Bridge', `WebSocket error: ${err.message}`);
      });
    } catch (err) {
      dlog('Bridge', `attemptConnect exception: ${err}`);
      this.scheduleReconnect(gen);
    }
  }

  private _lastWatchdogTick = Date.now();

  private startWatchdog(gen: number): void {
    this.stopWatchdog();
    this._lastWatchdogTick = Date.now();
    this._watchdogTimer = setInterval(() => {
      if (gen !== this._connectGeneration) return;

      const now = Date.now();
      const tickGap = now - this._lastWatchdogTick;
      this._lastWatchdogTick = now;

      // Detect system wake via time discontinuity (tick should be ~10s, >20s = likely sleep)
      if (tickGap > 20_000) {
        dlog('Bridge', `Wake detected (tick gap ${tickGap}ms)`);
        if (this._connected) {
          // Immediately check if connection is still alive
          try { this.ws?.ping(); } catch { /* ignore */ }
          setTimeout(() => {
            if (gen !== this._connectGeneration) return;
            if (this._connected && Date.now() - this._lastActivityAt > 5_000) {
              dwarn('Bridge', 'No pong after wake — terminating');
              this.ws?.terminate();
            }
          }, 3000);
        } else {
          // Not connected — reset backoff and try immediately
          this._backoffIdx = 0;
          this.attemptConnect(gen);
        }
        return;
      }

      if (!this._connected) return;
      const elapsed = now - this._lastActivityAt;
      if (elapsed > WS_ACTIVITY_TIMEOUT_MS) {
        dwarn('Bridge', `No activity for ${elapsed}ms — terminating connection`);
        this.ws?.terminate();
      }
    }, 10_000);
  }

  private stopWatchdog(): void {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  private cleanup(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.stopWatchdog();
  }
}
