import { EventEmitter } from 'events';
import { createServer, type Server } from 'http';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createPublicKey, createPrivateKey, sign as cryptoSign, randomUUID } from 'crypto';
import WebSocket from 'ws';
import { debug } from '../logger.js';
import { summarizeResponse, extractTopicHint } from '../timeline-summarizer.js';
import { cleanDetailText, cleanRawText, cleanNopMarkers } from '@agentdeck/shared';
import type {
  AgentAdapter,
  AgentCapabilities,
  AdapterStartOptions,
  AdapterEvent,
  PluginCommand,
  TimelineEntry,
} from '../types.js';
import { OPENCLAW_CAPABILITIES, OPENCLAW_GATEWAY_PORT } from '../types.js';
import { fetchModelCatalog, getDefaultModelName, invalidateModelCache } from '../model-catalog.js';

/** Ed25519 SPKI DER prefix length (bytes before the raw 32-byte key) */
const ED25519_SPKI_PREFIX_LEN = 12;

/** Protocol version supported by this adapter */
const PROTOCOL_VERSION = 3;

// ===== Device Identity Types =====

interface DeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

interface DeviceAuthToken {
  token: string;
  role: string;
  scopes: string[];
}

// ===== Gateway Frame Types =====

interface GatewayRequest {
  type: 'req';
  id: string;
  method: string;
  params: Record<string, unknown>;
}

interface GatewayResponse {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

interface GatewayEventFrame {
  type: 'event';
  event: string;
  payload: Record<string, unknown>;
  seq?: string;
  stateVersion?: string;
}

type GatewayMessage = GatewayResponse | GatewayEventFrame;

// ===== Session Types =====

interface GatewaySession {
  key: string;
  kind?: string;
  label?: string;
  displayName?: string;
  updatedAt?: number;
  sessionId?: string;
}

/**
 * OpenClaw adapter — connects to OpenClaw Gateway via WebSocket.
 *
 * Protocol: Custom framing (req/res/event), Ed25519 device auth handshake,
 * v3 protocol. Unlike ClaudeCodeAdapter (PTY-based), this adapter:
 * - Connects to an already-running Gateway process
 * - Authenticates via Ed25519 device signature (~/.openclaw/identity/)
 * - Uses req/res framing over WebSocket for all commands
 * - Has no terminal (PTY), mode switching, or diff review
 * - Handles select_option/navigate_option/send_prompt directly via RPC
 */
export interface OpenClawAdapterOptions {
  gatewayUrl?: string;
  /** Set false to disable automatic reconnect (daemon manages lifecycle externally) */
  autoReconnect?: boolean;
}

export class OpenClawAdapter extends EventEmitter implements AgentAdapter {
  readonly capabilities: AgentCapabilities = OPENCLAW_CAPABILITIES;

  private gatewayUrl: string;
  private ws: WebSocket | null = null;
  private httpServer: Server;
  private reqId = 0;
  private pendingRpc = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    method: string;
  }>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private projectName: string | null = null;
  private alive = false;
  private shutdownRequested = false;
  private externalHttpServer = false;
  private diagHandler: ((tail?: number) => unknown) | null = null;
  private rawDataCallback: ((data: string) => void) | null = null;
  private autoReconnect: boolean;

  // Session tracking
  private currentSessionKey: string | null = null;
  private currentRunId: string | null = null;
  private pendingApprovalId: string | null = null;

  // Chat tracking for timeline events
  private chatStarted = false;
  private chatStartTime = 0;
  private chatToolCount = 0;
  private chatToolNames: string[] = [];
  private lastPrompt: string | null = null;
  private accumulatedResponse = '';
  private topicExtracted = false;
  private chatIsAutomated = false;

  // Device identity (loaded once on start)
  private deviceIdentity: DeviceIdentity | null = null;
  private deviceAuthToken: DeviceAuthToken | null = null;

  /** Reconnect delay (doubles on each failure, max 30s) */
  private reconnectDelay = 1000;
  private static readonly MAX_RECONNECT_DELAY = 30_000;
  private static readonly RPC_TIMEOUT = 10_000;

  constructor(options?: string | OpenClawAdapterOptions) {
    super();
    if (typeof options === 'string') {
      // Legacy: constructor(gatewayUrl?: string)
      this.gatewayUrl = options || `ws://127.0.0.1:${OPENCLAW_GATEWAY_PORT}`;
      this.autoReconnect = true;
    } else {
      this.gatewayUrl = options?.gatewayUrl || `ws://127.0.0.1:${OPENCLAW_GATEWAY_PORT}`;
      this.autoReconnect = options?.autoReconnect ?? true;
    }

    // Create bare HTTP server for WsServer (plugin) attachment.
    this.httpServer = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          agent: 'openclaw',
          gateway: this.alive ? 'connected' : 'disconnected',
          session: this.currentSessionKey ?? undefined,
          uptime: process.uptime(),
        }));
        return;
      }

      if (req.method === 'GET' && req.url?.startsWith('/diag')) {
        if (!this.diagHandler) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Diagnostic system not initialized' }));
          return;
        }
        const urlObj = new URL(req.url, `http://localhost`);
        const tail = urlObj.searchParams.get('tail');
        try {
          const dump = this.diagHandler(tail ? parseInt(tail, 10) : undefined);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(dump));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });
  }

  async start(options: AdapterStartOptions & { externalServer?: Server }): Promise<void> {
    if (options.gatewayUrl) {
      this.gatewayUrl = options.gatewayUrl;
    }

    // Load device identity for Ed25519 auth (non-fatal if missing)
    this.loadDeviceIdentity();

    if (options.externalServer) {
      // Use externally provided HTTP server (daemon mode)
      this.httpServer = options.externalServer;
      this.externalHttpServer = true;
      debug('adapter:openclaw', 'Using external HTTP server');
    } else {
      // Start own HTTP server for plugin WebSocket attachment
      await new Promise<void>((resolve, reject) => {
        this.httpServer.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') {
            reject(new Error(`Port ${options.port} is already in use.`));
          } else {
            reject(err);
          }
        });
        this.httpServer.listen(options.port, '127.0.0.1', () => {
          debug('adapter:openclaw', `HTTP server listening on 127.0.0.1:${options.port}`);
          resolve();
        });
      });
    }

    // Connect to OpenClaw Gateway
    this.connectGateway();
  }

  handleCommand(cmd: PluginCommand): boolean {
    switch (cmd.type) {
      case 'respond': {
        debug('adapter:openclaw', `respond: "${cmd.value}"`);
        if (this.pendingApprovalId) {
          const decision = cmd.value === 'y' ? 'allow' : 'deny';
          this.rpcCall('exec.approval.resolve', {
            id: this.pendingApprovalId,
            decision,
          }).catch((err) => {
            debug('adapter:openclaw', `exec.approval.resolve failed: ${err}`);
          });
          this.pendingApprovalId = null;
        }
        return true;
      }

      case 'select_option': {
        debug('adapter:openclaw', `select_option: idx=${cmd.index}`);
        // Permission prompts: index 0 = Allow, index 1 = Deny
        if (this.pendingApprovalId) {
          const decision = cmd.index === 0 ? 'allow' : 'deny';
          this.rpcCall('exec.approval.resolve', {
            id: this.pendingApprovalId,
            decision,
          }).catch((err) => {
            debug('adapter:openclaw', `exec.approval.resolve failed: ${err}`);
          });
          this.pendingApprovalId = null;
        }
        return true;
      }

      case 'navigate_option':
        // OpenClaw doesn't have navigable prompts — no-op but mark as handled
        return true;

      case 'send_prompt': {
        debug('adapter:openclaw', `send_prompt: "${cmd.text.slice(0, 60)}"`);
        this.lastPrompt = cmd.text;

        // Optimistic: immediate timeline + PROCESSING state (no waiting for delta)
        if (!this.chatStarted) {
          this.chatStarted = true;
          this.chatIsAutomated = false;
          this.chatStartTime = Date.now();
          this.chatToolCount = 0;
          this.chatToolNames = [];
          const prompt = cmd.text;
          const promptRaw = prompt.length > 500 ? prompt.slice(0, 497) + '...' : prompt;
          const promptDetail = prompt.length > 100 ? (prompt.length > 1000 ? prompt.slice(0, 997) + '...' : prompt) : undefined;
          this.emitTimelineEntry({
            ts: Date.now(), type: 'chat_start', raw: promptRaw,
            ...(promptDetail ? { detail: promptDetail } : {}),
          });
          this.emitAdapterEvent({ source: 'parser', event: 'spinner_start' });
        }

        if (this.currentSessionKey) {
          this.rpcCall('chat.send', {
            sessionKey: this.currentSessionKey,
            message: cmd.text,
            idempotencyKey: randomUUID(),
          }).catch((err) => {
            debug('adapter:openclaw', `chat.send failed: ${err}`);
            this.emitTimelineEntry({
              ts: Date.now(), type: 'error', raw: `Send failed: ${err instanceof Error ? err.message : String(err)}`,
            });
            this.chatStarted = false;
            this.lastPrompt = null;
            this.accumulatedResponse = '';
            this.currentRunId = null;
            this.emitAdapterEvent({ source: 'parser', event: 'idle' });
          });
        } else {
          debug('adapter:openclaw', 'send_prompt: no active session');
          this.emitTimelineEntry({
            ts: Date.now(), type: 'error', raw: 'No active session',
          });
          this.chatStarted = false;
          this.emitAdapterEvent({ source: 'parser', event: 'idle' });
          return false;
        }
        return true;
      }

      case 'interrupt': {
        debug('adapter:openclaw', 'interrupt: sending chat.abort');
        if (this.currentSessionKey) {
          this.rpcCall('chat.abort', {
            sessionKey: this.currentSessionKey,
            ...(this.currentRunId ? { runId: this.currentRunId } : {}),
          }).catch((err) => {
            debug('adapter:openclaw', `chat.abort failed: ${err}`);
          });
        }
        return true;
      }

      case 'escape': {
        debug('adapter:openclaw', 'escape: sending chat.abort');
        if (this.currentSessionKey) {
          this.rpcCall('chat.abort', {
            sessionKey: this.currentSessionKey,
          }).catch((err) => {
            debug('adapter:openclaw', `chat.abort failed: ${err}`);
          });
        }
        return true;
      }

      case 'switch_mode':
        // OpenClaw doesn't have mode switching
        return false;

      case 'voice':
      case 'query_usage':
        // Handled by bridge (VoiceManager, UsageTracker)
        return false;

      default:
        return false;
    }
  }

  writeInput(data: string): void {
    // Fallback: send raw text as a chat message
    debug('adapter:openclaw', `writeInput fallback: "${data.slice(0, 60)}"`);
    if (this.currentSessionKey) {
      this.rpcCall('chat.send', {
        sessionKey: this.currentSessionKey,
        message: data,
        idempotencyKey: randomUUID(),
      }).catch((err) => {
        debug('adapter:openclaw', `writeInput RPC failed: ${err}`);
      });
    }
  }

  isAlive(): boolean {
    return this.alive;
  }

  attachTerminal(_stdin: NodeJS.ReadableStream, _stdout: NodeJS.WritableStream): void {
    // No-op: OpenClaw has no PTY terminal
  }

  getTtyPath(): string | undefined {
    return undefined;
  }

  getProjectName(): string | null {
    return this.projectName;
  }

  getHttpServer(): Server {
    return this.httpServer;
  }

  onDiag(handler: (tail?: number) => unknown): void {
    this.diagHandler = handler;
  }

  onRawData(callback: (data: string) => void): void {
    this.rawDataCallback = callback;
  }

  async shutdown(): Promise<void> {
    this.shutdownRequested = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    for (const [id, pending] of this.pendingRpc) {
      pending.reject(new Error('Adapter shutting down'));
      this.pendingRpc.delete(id);
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.alive = false;

    if (!this.externalHttpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer.close(() => resolve());
      });
    }
  }

  // ===== Private: Device Identity =====

  private loadDeviceIdentity(): void {
    const identityDir = join(homedir(), '.openclaw', 'identity');
    try {
      const deviceJson = JSON.parse(
        readFileSync(join(identityDir, 'device.json'), 'utf-8'),
      );
      this.deviceIdentity = {
        deviceId: deviceJson.deviceId,
        publicKeyPem: deviceJson.publicKeyPem,
        privateKeyPem: deviceJson.privateKeyPem,
      };

      const authJson = JSON.parse(
        readFileSync(join(identityDir, 'device-auth.json'), 'utf-8'),
      );
      const operatorToken = authJson.tokens?.operator;
      if (operatorToken) {
        this.deviceAuthToken = {
          token: operatorToken.token,
          role: operatorToken.role,
          scopes: operatorToken.scopes,
        };
      }

      debug('adapter:openclaw', `Device identity loaded: ${this.deviceIdentity.deviceId.slice(0, 16)}...`);
    } catch (err) {
      debug('adapter:openclaw', `Device identity not available: ${err}`);
    }
  }

  /** Extract raw 32-byte Ed25519 public key from PEM → base64url */
  private getPublicKeyBase64Url(): string {
    if (!this.deviceIdentity) throw new Error('No device identity');
    const pubKey = createPublicKey(this.deviceIdentity.publicKeyPem);
    const spki = pubKey.export({ type: 'spki', format: 'der' });
    const rawKey = (spki as Buffer).subarray(ED25519_SPKI_PREFIX_LEN);
    return rawKey.toString('base64url');
  }

  /** Build signed device auth for connect request */
  private buildDeviceAuth(nonce: string, requestScopes: string[], authToken: string): {
    id: string;
    publicKey: string;
    signature: string;
    signedAt: number;
    nonce: string;
  } {
    if (!this.deviceIdentity || !this.deviceAuthToken) {
      throw new Error('Device identity or auth token not loaded');
    }

    const signedAt = Date.now();
    const scopes = requestScopes.join(',');

    // v2|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce
    const payload = [
      'v2',
      this.deviceIdentity.deviceId,
      'gateway-client',
      'backend',
      this.deviceAuthToken.role,
      scopes,
      String(signedAt),
      authToken,
      nonce,
    ].join('|');

    const privateKey = createPrivateKey(this.deviceIdentity.privateKeyPem);
    const signature = cryptoSign(null, Buffer.from(payload, 'utf8'), privateKey);

    return {
      id: this.deviceIdentity.deviceId,
      publicKey: this.getPublicKeyBase64Url(),
      signature: signature.toString('base64url'),
      signedAt,
      nonce,
    };
  }

  // ===== Private: Gateway WebSocket Connection =====

  private connectGateway(): void {
    if (this.shutdownRequested) return;

    debug('adapter:openclaw', `Connecting to Gateway: ${this.gatewayUrl}`);

    try {
      this.ws = new WebSocket(this.gatewayUrl);
    } catch (err) {
      debug('adapter:openclaw', `WebSocket constructor error: ${err}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      debug('adapter:openclaw', 'WebSocket connected, awaiting connect.challenge...');
      // alive is set only after successful handshake (hello-ok response)
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      const raw = data.toString();

      if (this.rawDataCallback) {
        this.rawDataCallback(raw);
      }

      try {
        const msg = JSON.parse(raw) as GatewayMessage;
        this.handleGatewayMessage(msg);
      } catch (err) {
        debug('adapter:openclaw', `Failed to parse gateway message: ${err}`);
      }
    });

    this.ws.on('close', () => {
      debug('adapter:openclaw', 'Gateway disconnected');
      const wasAlive = this.alive;
      this.alive = false;

      if (wasAlive) {
        this.emitAdapterEvent({ source: 'connection', status: 'disconnected' });
        this.emitAdapterEvent({ source: 'hook', event: 'SessionEnd', data: {} });
      }

      for (const [id, pending] of this.pendingRpc) {
        pending.reject(new Error('Gateway disconnected'));
        this.pendingRpc.delete(id);
      }

      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      debug('adapter:openclaw', `Gateway WebSocket error: ${err.message}`);
    });
  }

  private scheduleReconnect(): void {
    if (this.shutdownRequested || this.reconnectTimer || !this.autoReconnect) return;

    debug('adapter:openclaw', `Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectGateway();
    }, this.reconnectDelay);

    this.reconnectDelay = Math.min(
      this.reconnectDelay * 2,
      OpenClawAdapter.MAX_RECONNECT_DELAY,
    );
  }

  // ===== Private: Request/Response =====

  private rpcCall(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Gateway not connected'));
        return;
      }

      const id = `r${++this.reqId}`;
      const message: GatewayRequest = { type: 'req', id, method, params };

      this.pendingRpc.set(id, { resolve, reject, method });

      setTimeout(() => {
        if (this.pendingRpc.has(id)) {
          this.pendingRpc.delete(id);
          reject(new Error(`RPC timeout: ${method} (id=${id})`));
        }
      }, OpenClawAdapter.RPC_TIMEOUT);

      try {
        this.ws.send(JSON.stringify(message));
        debug('adapter:openclaw', `→ ${method} (id=${id})`);
      } catch (err) {
        this.pendingRpc.delete(id);
        reject(err);
      }
    });
  }

  // ===== Private: Gateway Message Handling =====

  private handleGatewayMessage(msg: GatewayMessage): void {
    // Response to a request we sent
    if (msg.type === 'res') {
      const pending = this.pendingRpc.get(msg.id);
      if (pending) {
        this.pendingRpc.delete(msg.id);
        if (!msg.ok && msg.error) {
          debug('adapter:openclaw', `RPC error (${pending.method}): ${JSON.stringify(msg.error)}`);
          pending.reject(new Error(msg.error.message || 'RPC error'));
        } else {
          debug('adapter:openclaw', `← ${pending.method} (id=${msg.id})`);
          pending.resolve(msg.payload);
        }
      }
      return;
    }

    // Unsolicited event from Gateway
    if (msg.type === 'event') {
      // Only emit activity after handshake is complete
      if (this.alive) {
        this.emitAdapterEvent({ source: 'activity' });
      }
      this.handleGatewayEvent(msg.event, msg.payload || {});
    }
  }

  private handleGatewayEvent(event: string, payload: Record<string, unknown>): void {
    debug('adapter:openclaw', `Event: ${event}`);

    switch (event) {
      // ===== Connection handshake =====
      case 'connect.challenge': {
        const nonce = payload.nonce as string;
        if (!nonce) {
          debug('adapter:openclaw', 'connect.challenge missing nonce');
          return;
        }
        debug('adapter:openclaw', `Challenge nonce: ${nonce.slice(0, 8)}...`);
        this.sendConnectRequest(nonce);
        break;
      }

      // ===== Chat streaming =====
      case 'chat': {
        const state = payload.state as string;
        const runId = payload.runId as string;
        const sessionKey = payload.sessionKey as string;

        // Debug: log payload structure for diagnostic (delta/final only)
        if (state === 'delta' || state === 'final') {
          const keys = Object.keys(payload).join(',');
          debug('adapter:openclaw', `Chat ${state} keys=[${keys}]`);
          if (state === 'delta') {
            // Log first delta fully for prompt discovery, then just keys
            if (!this.chatStarted) {
              debug('adapter:openclaw', `First delta payload: ${JSON.stringify(payload).slice(0, 800)}`);
            }
          } else {
            debug('adapter:openclaw', `Final payload: ${JSON.stringify(payload).slice(0, 800)}`);
          }
        }

        // Track active run and session
        if (runId) this.currentRunId = runId;
        if (sessionKey) this.currentSessionKey = sessionKey;

        switch (state) {
          case 'delta': {
            // Extract text from Gateway message structure:
            // payload.message = { role: "assistant", content: [{ type: "text", text: "..." }] }
            const deltaText = this.extractMessageText(payload);

            if (!this.chatStarted) {
              // Non-optimistic path: gateway-initiated chat (cron, web, etc.)
              this.chatStarted = true;
              this.chatIsAutomated = !this.lastPrompt;
              this.chatStartTime = Date.now();
              this.chatToolCount = 0;
              this.chatToolNames = [];
              this.topicExtracted = false;
              this.accumulatedResponse = deltaText || '';
              const prompt = this.lastPrompt || '자동 작업';
              const promptRaw = prompt.length > 500 ? prompt.slice(0, 497) + '...' : prompt;
              const promptDetail = prompt.length > 100 ? (prompt.length > 1000 ? prompt.slice(0, 997) + '...' : prompt) : undefined;
              this.emitTimelineEntry({
                ts: Date.now(), type: 'chat_start', raw: promptRaw,
                ...(promptDetail ? { detail: promptDetail } : {}),
                ...(this.chatIsAutomated ? { automated: true } : {}),
              });
            } else {
              // Gateway always sends cumulative content — replace, never append
              if (deltaText) {
                this.accumulatedResponse = deltaText;
              }

              // Early topic extraction — upsert chat_start with topic hint
              if (!this.topicExtracted && this.accumulatedResponse.length > 20) {
                const topicHint = extractTopicHint(this.accumulatedResponse);
                if (topicHint && (!this.lastPrompt || this.lastPrompt === '자동 작업')) {
                  this.topicExtracted = true;
                  this.emitTimelineUpsert({
                    ts: this.chatStartTime, type: 'chat_start',
                    raw: cleanRawText(topicHint),
                  });
                }
              }
            }

            this.emitAdapterEvent({
              source: 'parser',
              event: 'spinner_start',
              data: { runId, sessionKey },
            });
            break;
          }

          case 'final': {
            // Extract modelId from payload if present (fallback when catalog probe fails)
            const modelId = payload.model ?? payload.modelId;
            if (typeof modelId === 'string' && modelId) {
              this.emitAdapterEvent({
                source: 'parser', event: 'model_info',
                data: { model: modelId, plan: null },
              });
            }

            const duration = this.chatStarted ? Math.round((Date.now() - this.chatStartTime) / 1000) : 0;
            const toolSummary = this.buildToolSummary();

            // Extract response content for detail + LLM summarization
            const finalText = this.extractMessageText(payload);
            const responseContent = (finalText || undefined)
              || (this.accumulatedResponse || undefined);

            // Emit chat_response for APME turn response capture
            if (responseContent) {
              const respRaw = responseContent.length > 500 ? responseContent.slice(0, 497) + '...' : responseContent;
              this.emitTimelineEntry({
                ts: Date.now(), type: 'chat_response',
                raw: cleanRawText(respRaw),
                detail: cleanDetailText(responseContent.slice(0, 3000)),
              });
            }
            const cleanedResponse = responseContent ? cleanNopMarkers(cleanDetailText(responseContent)) : undefined;
            const responseDetail = cleanedResponse
              ? (cleanedResponse.length > 1000 ? cleanedResponse.slice(0, 997) + '...' : cleanedResponse)
              : undefined;

            // Emit chat_end with heuristic summary, then async LLM enrichment
            const heuristicLabel = (responseContent && extractTopicHint(responseContent)) || 'Completed';
            const parts = [heuristicLabel];
            if (duration > 0) parts.push(`${duration}s`);
            if (toolSummary) parts.push(toolSummary);
            const chatEndTs = Date.now();
            this.emitTimelineEntry({
              ts: chatEndTs, type: 'chat_end', raw: parts.join(' \u00b7 '),
              ...(responseDetail ? { detail: responseDetail } : {}),
              ...(this.chatIsAutomated ? { automated: true } : {}),
            });

            // Async LLM summarization — fire-and-forget, upsert chat_end when ready
            if (responseContent && responseContent.length > 30) {
              const savedToolSummary = toolSummary;
              const savedDuration = duration;
              const savedAutomated = this.chatIsAutomated;
              summarizeResponse(responseContent).then((summary) => {
                if (summary) {
                  const enrichedParts = [summary];
                  if (savedDuration > 0) enrichedParts.push(`${savedDuration}s`);
                  if (savedToolSummary) enrichedParts.push(savedToolSummary);
                  debug('adapter:openclaw', `LLM summary: ${summary}`);
                  // Upsert chat_end with LLM summary replacing "Completed"
                  this.emitTimelineUpsert({
                    ts: chatEndTs, type: 'chat_end',
                    raw: enrichedParts.join(' \u00b7 '),
                    ...(responseDetail ? { detail: responseDetail } : {}),
                    ...(savedAutomated ? { automated: true } : {}),
                  });
                }
              }).catch(() => { /* summarization failed — keep heuristic */ });
            }

            this.chatStarted = false;
            this.lastPrompt = null;
            this.accumulatedResponse = '';
            this.currentRunId = null;
            this.emitAdapterEvent({ source: 'parser', event: 'idle' });
            break;
          }

          case 'aborted': {
            const abortDuration = this.chatStarted ? Math.round((Date.now() - this.chatStartTime) / 1000) : 0;
            const abortToolSummary = this.buildToolSummary();
            const abortParts = ['Aborted'];
            if (abortDuration > 0) abortParts.push(`after ${abortDuration}s`);
            if (abortToolSummary) abortParts.push(abortToolSummary);
            const abortDetail = this.accumulatedResponse || undefined;
            this.emitTimelineEntry({
              ts: Date.now(), type: 'chat_end', raw: abortParts.join(' \u00b7 '),
              ...(abortDetail ? { detail: abortDetail } : {}),
              ...(this.chatIsAutomated ? { automated: true } : {}),
            });
            this.chatStarted = false;
            this.lastPrompt = null;
            this.accumulatedResponse = '';
            this.currentRunId = null;
            this.emitAdapterEvent({ source: 'parser', event: 'idle' });
            break;
          }

          case 'error': {
            const errMsg = (payload.errorMessage as string) || 'unknown';
            this.emitTimelineEntry({
              ts: Date.now(), type: 'error', raw: errMsg,
            });
            this.chatStarted = false;
            this.lastPrompt = null;
            this.accumulatedResponse = '';
            this.currentRunId = null;
            debug('adapter:openclaw', `Chat error: ${errMsg}`);
            this.emitAdapterEvent({ source: 'parser', event: 'idle' });
            break;
          }
        }
        break;
      }

      // ===== Tool approval =====
      case 'exec.approval.requested': {
        const approvalId = payload.id as string;
        const command = payload.command as string;
        const ask = payload.ask as string | undefined;

        this.pendingApprovalId = approvalId;

        // Track tool for chat summary
        const toolName = command?.split(' ')[0] || 'tool';
        this.chatToolCount++;
        if (!this.chatToolNames.includes(toolName)) {
          this.chatToolNames.push(toolName);
        }

        const toolRaw = ask ? `${command}: ${ask}` : (command || 'Approve tool execution?');
        const toolRequestRaw = toolRaw.length > 500 ? toolRaw.slice(0, 497) + '...' : toolRaw;
        const toolRequestDetail = ask && ask.length > 100 ? (ask.length > 1000 ? ask.slice(0, 997) + '...' : ask) : undefined;
        this.emitTimelineEntry({
          ts: Date.now(), type: 'tool_request', raw: toolRequestRaw,
          ...(toolRequestDetail ? { detail: toolRequestDetail } : {}),
          approvalId, status: 'pending',
        });

        this.emitAdapterEvent({
          source: 'parser',
          event: 'permission_prompt',
          data: {
            question: ask || command || 'Approve tool execution?',
            options: [
              { index: 0, label: 'Allow', shortcut: 'y' },
              { index: 1, label: 'Deny', shortcut: 'n' },
            ],
            navigable: false,
            cursorIndex: 0,
          },
        });
        break;
      }

      case 'exec.approval.resolved': {
        // Approval resolved (by us or another client) → processing continues
        const resolvedId = this.pendingApprovalId;
        const decision = (payload.decision as string) || 'allow';
        this.pendingApprovalId = null;

        if (resolvedId) {
          this.emitTimelineEntry({
            ts: Date.now(), type: 'tool_resolved',
            raw: decision === 'allow' ? 'Approved' : 'Denied',
            approvalId: resolvedId,
            status: decision === 'allow' ? 'approved' : 'denied',
          });
        }

        this.emitAdapterEvent({ source: 'parser', event: 'spinner_start' });
        break;
      }

      // ===== Gateway health =====
      case 'health': {
        const ok = payload.ok as boolean;
        this.emitAdapterEvent({
          source: 'metadata',
          event: 'gateway_health',
          data: { ok, payload },
        });
        break;
      }

      // ===== Presence / keepalive =====
      case 'presence':
      case 'tick':
        // Activity already emitted in handleGatewayMessage
        break;

      // ===== Lifecycle =====
      case 'shutdown':
        debug('adapter:openclaw', 'Gateway shutdown event');
        this.emitAdapterEvent({ source: 'hook', event: 'SessionEnd', data: {} });
        break;

      default:
        debug('adapter:openclaw', `Unhandled event: ${event}`);
        break;
    }
  }

  /**
   * Send `connect` request with Ed25519 device authentication.
   * Called when Gateway sends `connect.challenge` event with nonce.
   */
  private sendConnectRequest(nonce: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // Scopes must match between signed payload and request params — Gateway
    // reconstructs the payload from request params for signature verification.
    const scopes = this.deviceAuthToken?.scopes
      ?? ['operator.admin', 'operator.approvals', 'operator.read'];
    const authToken = this.deviceAuthToken?.token ?? '';

    const params: Record<string, unknown> = {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: 'gateway-client',
        displayName: 'AgentDeck',
        version: '0.3.0',
        platform: process.platform,
        mode: 'backend',
      },
      role: 'operator',
      scopes,
      caps: ['tool-events'],
    };

    // Add device auth if identity is available
    if (this.deviceIdentity && this.deviceAuthToken) {
      try {
        params.device = this.buildDeviceAuth(nonce, scopes, authToken);
        params.auth = { token: authToken };
      } catch (err) {
        debug('adapter:openclaw', `Device auth signing failed: ${err}`);
      }
    }

    const id = 'init-1';
    const message: GatewayRequest = { type: 'req', id, method: 'connect', params };

    this.pendingRpc.set(id, {
      resolve: (payload) => {
        debug('adapter:openclaw', 'Handshake complete (hello-ok)');
        this.alive = true;
        this.reconnectDelay = 1000;

        this.emitAdapterEvent({ source: 'connection', status: 'connected' });
        this.emitAdapterEvent({ source: 'hook', event: 'SessionStart', data: {} });

        // Log available features
        if (payload && typeof payload === 'object') {
          const p = payload as Record<string, unknown>;
          const features = p.features as Record<string, unknown> | undefined;
          if (features) {
            const methods = features.methods as string[] | undefined;
            const events = features.events as string[] | undefined;
            debug('adapter:openclaw', `Gateway features: ${methods?.length || 0} methods, ${events?.length || 0} events`);
          }
        }

        // Fetch sessions (async, non-blocking)
        this.fetchSessions().catch(err => debug('adapter:openclaw', `fetchSessions error: ${err}`));

        // Fetch model catalog (async, non-blocking)
        this.emitModelCatalog().catch(err => debug('adapter:openclaw', `emitModelCatalog error: ${err}`));
      },
      reject: (err) => {
        debug('adapter:openclaw', `Handshake failed: ${err.message}`);
        // WebSocket will close → reconnect
      },
      method: 'connect',
    });

    // Timeout for handshake
    setTimeout(() => {
      if (this.pendingRpc.has(id)) {
        this.pendingRpc.delete(id);
        debug('adapter:openclaw', 'Connect handshake timeout');
      }
    }, OpenClawAdapter.RPC_TIMEOUT);

    try {
      this.ws.send(JSON.stringify(message));
      debug('adapter:openclaw', '→ connect (handshake)');
    } catch (err) {
      this.pendingRpc.delete(id);
      debug('adapter:openclaw', `Failed to send connect request: ${err}`);
    }
  }

  /** Fetch sessions and set the most recently updated one as active. */
  private async fetchSessions(): Promise<void> {
    try {
      const result = await this.rpcCall('sessions.list', {});
      if (!result || typeof result !== 'object') return;

      const resp = result as { sessions?: GatewaySession[]; count?: number };
      const sessions = resp.sessions;
      if (!sessions || sessions.length === 0) {
        debug('adapter:openclaw', 'No sessions available');
        return;
      }

      debug('adapter:openclaw', `Sessions: ${sessions.length}`);

      // Pick the most recently updated session
      const sorted = [...sessions].sort(
        (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
      );
      this.currentSessionKey = sorted[0].key;

      // Use fixed name — Gateway session labels can be user identifiers
      // (e.g. phone numbers) which are unsuitable as project names
      this.projectName = 'OpenClaw';
      this.emitAdapterEvent({
        source: 'parser',
        event: 'project_name',
        data: { name: 'OpenClaw' },
      });

      debug('adapter:openclaw', `Active session: ${this.currentSessionKey}`);
    } catch (err) {
      debug('adapter:openclaw', `sessions.list failed: ${err}`);
    }
  }

  /** Fetch model catalog via CLI and emit events. Retries once on failure. */
  private async emitModelCatalog(retry = true): Promise<void> {
    // Invalidate cache on reconnect to get fresh data
    invalidateModelCache();

    try {
      const catalog = await fetchModelCatalog();
      if (!catalog) {
        if (retry && this.alive) {
          debug('adapter:openclaw', 'Model catalog empty — retrying in 10s');
          setTimeout(() => this.emitModelCatalog(false), 10_000);
        }
        return;
      }

      // Emit model_info for default model name (StateMachine uses this)
      const defaultModel = await getDefaultModelName();
      if (defaultModel) {
        this.emitAdapterEvent({
          source: 'parser',
          event: 'model_info',
          data: { model: defaultModel, plan: null },
        });
      }

      // Emit model_catalog metadata for the full list
      this.emitAdapterEvent({
        source: 'metadata',
        event: 'model_catalog',
        data: { models: catalog.entries },
      });
    } catch (err) {
      debug('adapter:openclaw', `Model catalog fetch failed: ${err}`);
      if (retry && this.alive) {
        debug('adapter:openclaw', 'Retrying model catalog in 10s');
        setTimeout(() => this.emitModelCatalog(false), 10_000);
      }
    }
  }

  /**
   * Extract text from Gateway chat message structure.
   * Format: payload.message = { role, content: [{ type: "text", text: "..." }], timestamp }
   */
  private extractMessageText(payload: Record<string, unknown>): string | undefined {
    const msg = payload.message as Record<string, unknown> | undefined;
    if (!msg) return undefined;
    const content = msg.content as Array<{ type: string; text: string }> | undefined;
    if (!content || !Array.isArray(content)) return undefined;
    const texts = content
      .filter(c => c.type === 'text' && c.text)
      .map(c => c.text);
    return texts.length > 0 ? texts.join('') : undefined;
  }

  /** Build tool count summary like "Read(3), Bash(2)" */
  private buildToolSummary(): string {
    if (this.chatToolNames.length === 0) return '';
    // Count occurrences (simplified — uses total count distributed)
    return this.chatToolNames.join(', ');
  }

  /** Emit a timeline event through the adapter event system */
  private emitTimelineEntry(entry: TimelineEntry): void {
    this.emitAdapterEvent({ source: 'timeline', entry });
  }

  /** Emit a timeline upsert (update existing entry with same ts+type, or add new) */
  private emitTimelineUpsert(entry: TimelineEntry): void {
    this.emitAdapterEvent({ source: 'timeline', entry, upsert: true });
  }

  /** Fetch event history from Gateway via RPC (for offline recovery) */
  async fetchHistory(since: number): Promise<TimelineEntry[]> {
    try {
      const result = await this.rpcCall('events.history', { since });
      if (!result || !Array.isArray(result)) return [];
      // Gateway returns raw event objects — map to TimelineEntry
      return (result as Record<string, unknown>[]).filter(Boolean).map((e) => ({
        ts: (e.ts as number) || Date.now(),
        type: (e.type as TimelineEntry['type']) || 'user_action',
        raw: (e.raw as string) || (e.summary as string) || '',
        approvalId: e.approvalId as string | undefined,
        status: e.status as TimelineEntry['status'],
      }));
    } catch (err) {
      debug('adapter:openclaw', `fetchHistory failed: ${err}`);
      return [];
    }
  }

  private emitAdapterEvent(evt: AdapterEvent): void {
    this.emit('event', evt);
  }
}
