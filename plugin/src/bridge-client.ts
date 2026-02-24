import WebSocket from 'ws';
import { EventEmitter } from 'events';
import {
  BridgeEvent,
  PluginCommand,
  AgentCapabilities,
  BRIDGE_WS_PORT,
  RECONNECT_INTERVAL_MS,
} from '@agentdeck/shared';
import type { AgentLink } from './agent-link.js';
import { dlog, dwarn, derr } from './log.js';

export class BridgeClient extends EventEmitter implements AgentLink {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setInterval> | null = null;
  private _connected = false;
  private _port = BRIDGE_WS_PORT;
  private _connectGeneration = 0;
  private _capabilities: AgentCapabilities | null = null;

  /** Optional callback to rescan sessions.json for the latest port */
  scanLatestPort: (() => number | undefined) | null = null;

  connect(port?: number): void {
    if (port != null) this._port = port;
    dlog('Bridge', `connect(port=${this._port})`);
    this.cleanup();
    this._connectGeneration++;
    const gen = this._connectGeneration;
    this.attemptConnect(gen);
    this.reconnectTimer = setInterval(() => {
      if (!this._connected && gen === this._connectGeneration) {
        // Rescan sessions to discover newly started bridges
        if (this.scanLatestPort) {
          const latestPort = this.scanLatestPort();
          if (latestPort && latestPort !== this._port) {
            dlog('Bridge', `rescan: new port ${latestPort} (was ${this._port})`);
            this._port = latestPort;
          }
        }
        this.attemptConnect(gen);
      }
    }, RECONNECT_INTERVAL_MS);
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

  private attemptConnect(gen: number): void {
    if (gen !== this._connectGeneration) return;

    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }

    try {
      dlog('Bridge', `attemptConnect ws://localhost:${this._port} (gen=${gen})`);
      this.ws = new WebSocket(`ws://localhost:${this._port}`);

      this.ws.on('open', () => {
        if (gen !== this._connectGeneration) return;
        dlog('Bridge', 'WebSocket open');
        this._connected = true;
        this.emit('connected');
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        if (gen !== this._connectGeneration) return;
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

      this.ws.on('close', () => {
        if (gen !== this._connectGeneration) return;
        const wasConnected = this._connected;
        this._connected = false;
        if (wasConnected) {
          dlog('Bridge', 'WebSocket closed (was connected)');
          this.emit('disconnected');
        }
      });

      this.ws.on('error', (err) => {
        if (gen !== this._connectGeneration) return;
        dlog('Bridge', `WebSocket error: ${err.message}`);
      });
    } catch (err) {
      dlog('Bridge', `attemptConnect exception: ${err}`);
    }
  }

  private cleanup(): void {
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
