import { WebSocketServer, WebSocket } from 'ws';
import type { Server, IncomingMessage } from 'http';
import type { BridgeEvent, PluginCommand } from './types.js';
import { isLocalConnection, validateToken } from './auth.js';
import { debug } from './logger.js';
import { WS_PING_INTERVAL_MS } from '@agentdeck/shared';

export class WsServer {
  private wss: WebSocketServer;
  private commandCallback: ((cmd: PluginCommand, sender: WebSocket) => void) | null = null;
  private rawMessageCallback: ((msg: Record<string, unknown>, sender: WebSocket) => boolean) | null = null;
  private onConnectCallback: ((ws: WebSocket) => void) | null = null;
  private onDisconnectCallback: ((ws: WebSocket) => void) | null = null;
  private clientAlive = new Map<WebSocket, boolean>();
  private pingTimer: ReturnType<typeof setInterval>;

  constructor(server: Server) {
    this.wss = new WebSocketServer({ server });

    // Catch server-level errors (e.g., upgrade failures, internal ws errors)
    // Without this handler, EventEmitter throws synchronously → process dies
    this.wss.on('error', (err) => {
      debug('WS', `WebSocketServer error: ${err}`);
    });

    // Server-side ping/pong to detect zombie connections
    this.pingTimer = setInterval(() => {
      const dead: WebSocket[] = [];
      for (const ws of this.wss.clients) {
        if (this.clientAlive.get(ws) === false) {
          dead.push(ws);
          continue;
        }
        this.clientAlive.set(ws, false);
        ws.ping();
      }
      // Terminate outside iteration — ws.terminate() synchronously removes
      // the client from wss.clients Set, which would corrupt the iterator.
      for (const ws of dead) {
        debug('WS', 'Terminating unresponsive client');
        this.clientAlive.delete(ws);
        ws.terminate();
      }
    }, WS_PING_INTERVAL_MS);

    this.wss.on('connection', (ws, req: IncomingMessage) => {
      // Token auth for remote connections
      const remoteIp = req.socket.remoteAddress || '';
      if (!isLocalConnection(remoteIp)) {
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const token = url.searchParams.get('token') || '';
        if (!validateToken(token)) {
          debug('WS', `Rejected remote connection from ${remoteIp} (invalid token)`);
          ws.close(4001, 'Unauthorized');
          return;
        }
        debug('WS', `Remote client authenticated from ${remoteIp}`);
      }

      debug('WS', 'Plugin connected');
      this.clientAlive.set(ws, true);

      // Send current state to newly connected client
      if (this.onConnectCallback) {
        this.onConnectCallback(ws);
      }

      ws.on('pong', () => {
        this.clientAlive.set(ws, true);
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>;
          debug('WS', `recv cmd: ${msg.type}`);
          // Allow raw message callback to intercept relay events (e.g. deck_slot_map)
          if (this.rawMessageCallback && this.rawMessageCallback(msg, ws)) {
            return; // handled
          }
          if (this.commandCallback) {
            this.commandCallback(msg as unknown as PluginCommand, ws);
          }
        } catch (err) {
          debug('WS', `Failed to parse message: ${err}`);
        }
      });

      ws.on('close', () => {
        debug('WS', 'Plugin disconnected');
        this.clientAlive.delete(ws);
        if (this.onDisconnectCallback) {
          this.onDisconnectCallback(ws);
        }
      });

      ws.on('error', (err) => {
        debug('WS', `WebSocket error: ${err}`);
      });
    });
  }

  private broadcastHooks: Array<(event: BridgeEvent) => void> = [];

  /** Register a hook that gets called on every broadcast (e.g., ESP32 serial relay). */
  onBroadcast(hook: (event: BridgeEvent) => void): void {
    this.broadcastHooks.push(hook);
  }

  broadcast(event: BridgeEvent): void {
    const payload = JSON.stringify(event);
    const clientCount = this.wss.clients.size;
    debug('WS', `broadcast(${event.type}) to ${clientCount} clients`);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try { client.send(payload); } catch { /* client disconnecting */ }
      }
    }
    // Relay to registered hooks (ESP32 serial, etc.)
    for (const hook of this.broadcastHooks) {
      try { hook(event); } catch { /* best-effort */ }
    }
  }

  onCommand(callback: (cmd: PluginCommand, sender: WebSocket) => void): void {
    this.commandCallback = callback;
  }

  /** Inject a command from a non-WS source (e.g., D200H agent via stdout/stdin pipe). */
  dispatchCommand(cmd: PluginCommand): void {
    // Non-WS sources don't have a sender; cast to satisfy the type signature.
    // daemon-server.ts guards for this with `sender ?` checks.
    this.commandCallback?.(cmd, null as unknown as WebSocket);
  }

  /** Register a callback for raw messages before PluginCommand dispatch. Return true to consume. */
  onRawMessage(callback: (msg: Record<string, unknown>, sender: WebSocket) => boolean): void {
    this.rawMessageCallback = callback;
  }

  /** Broadcast to all clients except the sender */
  broadcastExcept(event: BridgeEvent, except: WebSocket): void {
    const payload = JSON.stringify(event);
    for (const client of this.wss.clients) {
      if (client !== except && client.readyState === WebSocket.OPEN) {
        try { client.send(payload); } catch { /* client disconnecting */ }
      }
    }
  }

  onClientConnect(callback: (ws: WebSocket) => void): void {
    this.onConnectCallback = callback;
  }

  onClientDisconnect(callback: (ws: WebSocket) => void): void {
    this.onDisconnectCallback = callback;
  }

  sendTo(ws: WebSocket, event: BridgeEvent): void {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(event)); } catch { /* client disconnecting */ }
    }
  }

  getClientCount(): number {
    return this.wss.clients.size;
  }

  close(): void {
    clearInterval(this.pingTimer);
    this.clientAlive.clear();
    // Spread to array — client.close() modifies wss.clients Set
    for (const client of [...this.wss.clients]) {
      client.close();
    }
    this.wss.close();
  }
}
