/**
 * GatewayClient — connects the plugin directly to OpenClaw Gateway.
 *
 * Replicates the protocol logic from bridge/src/adapters/openclaw.ts but
 * emits BridgeEvent types (state_update, prompt_options, etc.) so plugin.ts
 * event handlers work unchanged.
 *
 * Used when no Bridge session is active — the plugin auto-connects to the
 * Gateway which is assumed to be always running locally.
 */
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createPublicKey, createPrivateKey, sign as cryptoSign, randomUUID } from 'crypto';
import { execSync } from 'child_process';
import {
  State,
  PermissionMode,
  PluginCommand,
  AgentCapabilities,
  OPENCLAW_CAPABILITIES,
  OPENCLAW_GATEWAY_PORT,
} from '@agentdeck/shared';
import type { StateUpdateEvent, ModelCatalogEntry } from '@agentdeck/shared';
import { augmentedPath, OPENCLAW_CANDIDATES } from '@agentdeck/shared';
import type { AgentLink } from './agent-link.js';
import { timelineStore, type TimelineEntry } from './timeline-store.js';
import { dlog, dinfo, dwarn, derr } from './log.js';

const TAG = 'Gateway';

/** Ed25519 SPKI DER prefix length (bytes before the raw 32-byte key) */
const ED25519_SPKI_PREFIX_LEN = 12;

/** Protocol version supported by this client */
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

interface GatewaySession {
  key: string;
  kind?: string;
  label?: string;
  displayName?: string;
  updatedAt?: number;
  sessionId?: string;
}

// ===== GatewayClient =====

export class GatewayClient extends EventEmitter implements AgentLink {
  private gatewayUrl: string;
  private ws: WebSocket | null = null;
  private reqId = 0;
  private pendingRpc = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    method: string;
  }>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _connected = false;
  private shutdownRequested = false;

  // Mini state tracking
  private state: State = State.DISCONNECTED;
  private currentSessionKey: string | null = null;
  private currentRunId: string | null = null;
  private pendingApprovalId: string | null = null;
  private pendingApprovalQuestion: string | undefined;
  private projectName: string | undefined;

  // Timeline tracking
  private chatStarted = false;
  private chatStartTime = 0;
  private chatToolCount = 0;
  private chatToolNames: string[] = [];
  private lastPrompt: string | null = null;

  // Model catalog (fetched via CLI)
  private modelCatalog: ModelCatalogEntry[] | null = null;
  private modelCatalogTime = 0;
  private static readonly MODEL_CATALOG_TTL = 60_000;

  // Device identity
  private deviceIdentity: DeviceIdentity | null = null;
  private deviceAuthToken: DeviceAuthToken | null = null;

  /** Reconnect delay (doubles on each failure, max 30s) */
  private reconnectDelay = 1000;
  private static readonly MAX_RECONNECT_DELAY = 30_000;
  private static readonly RPC_TIMEOUT = 10_000;

  constructor(gatewayUrl?: string) {
    super();
    this.gatewayUrl = gatewayUrl || `ws://127.0.0.1:${OPENCLAW_GATEWAY_PORT}`;
  }

  // ===== AgentLink interface =====

  send(command: PluginCommand): void {
    if (!this._connected) {
      dwarn(TAG, `send(${command.type}) dropped — not connected`);
      return;
    }

    switch (command.type) {
      case 'send_prompt': {
        dlog(TAG, `send_prompt: "${command.text.slice(0, 60)}"`);
        this.lastPrompt = command.text;
        if (this.currentSessionKey) {
          this.rpcCall('chat.send', {
            sessionKey: this.currentSessionKey,
            message: command.text,
            idempotencyKey: randomUUID(),
          }).catch((err) => dwarn(TAG, `chat.send failed: ${err}`));
        } else {
          // Session not yet loaded — wait and retry
          this.waitForSession(command.text);
        }
        break;
      }

      case 'respond': {
        dlog(TAG, `respond: "${command.value}"`);
        if (this.pendingApprovalId) {
          const decision = command.value === 'y' ? 'allow' : 'deny';
          this.rpcCall('exec.approval.resolve', {
            id: this.pendingApprovalId,
            decision,
          }).catch((err) => dwarn(TAG, `exec.approval.resolve failed: ${err}`));
          this.pendingApprovalId = null;
        }
        break;
      }

      case 'select_option': {
        dlog(TAG, `select_option: idx=${command.index}`);
        if (this.pendingApprovalId) {
          const decision = command.index === 0 ? 'allow' : 'deny';
          this.rpcCall('exec.approval.resolve', {
            id: this.pendingApprovalId,
            decision,
          }).catch((err) => dwarn(TAG, `exec.approval.resolve failed: ${err}`));
          this.pendingApprovalId = null;
        }
        break;
      }

      case 'navigate_option':
        // OpenClaw doesn't have navigable prompts
        break;

      case 'interrupt':
      case 'escape': {
        dlog(TAG, `${command.type}: sending chat.abort`);
        if (this.currentSessionKey) {
          this.rpcCall('chat.abort', {
            sessionKey: this.currentSessionKey,
            ...(this.currentRunId ? { runId: this.currentRunId } : {}),
          }).catch((err) => dwarn(TAG, `chat.abort failed: ${err}`));
        }
        break;
      }

      case 'switch_mode':
      case 'query_usage':
      case 'voice':
      case 'diag':
        // Not supported by OpenClaw
        break;

      default:
        dwarn(TAG, `unhandled command: ${(command as PluginCommand).type}`);
    }
  }

  isConnected(): boolean {
    return this._connected;
  }

  getCapabilities(): AgentCapabilities | null {
    return this._connected ? OPENCLAW_CAPABILITIES : null;
  }

  disconnect(): void {
    dlog(TAG, 'disconnect()');
    this.shutdownRequested = true;
    this.cleanup();

    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }

    if (this._connected) {
      this._connected = false;
      this.state = State.DISCONNECTED;
      this.emit('disconnected');
    }
  }

  // ===== Connection lifecycle =====

  /**
   * Start connecting to the Gateway. Non-blocking — emits 'connected'
   * when handshake succeeds, 'disconnected' when connection drops.
   */
  connect(): void {
    this.shutdownRequested = false;
    this.loadDeviceIdentity();
    this.connectGateway();
  }

  /** Pause reconnection without a full shutdown — allows resuming later. */
  pause(): void {
    dlog(TAG, 'pause()');
    this.cleanup();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    if (this._connected) {
      this._connected = false;
      this.state = State.DISCONNECTED;
      this.emit('disconnected');
    }
  }

  /** Resume connection after pause. */
  resume(): void {
    dlog(TAG, 'resume()');
    this.shutdownRequested = false;
    if (!this._connected && !this.reconnectTimer) {
      this.reconnectDelay = 1000;
      this.connectGateway();
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

      dlog(TAG, `Device identity loaded: ${this.deviceIdentity.deviceId.slice(0, 16)}...`);
    } catch (err) {
      dlog(TAG, `Device identity not available: ${err}`);
    }
  }

  private getPublicKeyBase64Url(): string {
    if (!this.deviceIdentity) throw new Error('No device identity');
    const pubKey = createPublicKey(this.deviceIdentity.publicKeyPem);
    const spki = pubKey.export({ type: 'spki', format: 'der' });
    const rawKey = (spki as Buffer).subarray(ED25519_SPKI_PREFIX_LEN);
    return rawKey.toString('base64url');
  }

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

  // ===== Private: Gateway WebSocket =====

  private connectGateway(): void {
    if (this.shutdownRequested) return;

    dlog(TAG, `Connecting to ${this.gatewayUrl}`);

    try {
      this.ws = new WebSocket(this.gatewayUrl);
    } catch (err) {
      dlog(TAG, `WebSocket constructor error: ${err}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      dlog(TAG, 'WebSocket open, awaiting connect.challenge...');
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString()) as GatewayMessage;
        this.handleGatewayMessage(msg);
      } catch (err) {
        derr(TAG, `Failed to parse gateway message: ${err}`);
      }
    });

    this.ws.on('close', () => {
      dlog(TAG, 'Gateway disconnected');
      const wasConnected = this._connected;
      this._connected = false;
      this.state = State.DISCONNECTED;

      // Clean pending RPCs
      for (const [id, pending] of this.pendingRpc) {
        pending.reject(new Error('Gateway disconnected'));
        this.pendingRpc.delete(id);
      }

      if (wasConnected) {
        this.emit('disconnected');
      }

      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      dlog(TAG, `WebSocket error: ${err.message}`);
    });
  }

  private scheduleReconnect(): void {
    if (this.shutdownRequested || this.reconnectTimer) return;

    dlog(TAG, `Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectGateway();
    }, this.reconnectDelay);

    this.reconnectDelay = Math.min(
      this.reconnectDelay * 2,
      GatewayClient.MAX_RECONNECT_DELAY,
    );
  }

  private cleanup(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ===== Private: RPC =====

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
      }, GatewayClient.RPC_TIMEOUT);

      try {
        this.ws.send(JSON.stringify(message));
        dlog(TAG, `→ ${method} (id=${id})`);
      } catch (err) {
        this.pendingRpc.delete(id);
        reject(err);
      }
    });
  }

  // ===== Private: Message Handling =====

  private handleGatewayMessage(msg: GatewayMessage): void {
    if (msg.type === 'res') {
      const pending = this.pendingRpc.get(msg.id);
      if (pending) {
        this.pendingRpc.delete(msg.id);
        if (!msg.ok && msg.error) {
          dlog(TAG, `RPC error (${pending.method}): ${JSON.stringify(msg.error)}`);
          pending.reject(new Error(msg.error.message || 'RPC error'));
        } else {
          dlog(TAG, `← ${pending.method} (id=${msg.id})`);
          pending.resolve(msg.payload);
        }
      }
      return;
    }

    if (msg.type === 'event') {
      this.handleGatewayEvent(msg.event, msg.payload || {});
    }
  }

  private handleGatewayEvent(event: string, payload: Record<string, unknown>): void {
    dlog(TAG, `Event: ${event}`);

    switch (event) {
      // ===== Connection handshake =====
      case 'connect.challenge': {
        const nonce = payload.nonce as string;
        if (!nonce) {
          derr(TAG, 'connect.challenge missing nonce');
          return;
        }
        this.sendConnectRequest(nonce);
        break;
      }

      // ===== Chat streaming =====
      case 'chat': {
        const chatState = payload.state as string;
        const runId = payload.runId as string;
        const sessionKey = payload.sessionKey as string;

        dlog(TAG, `Chat event: state=${chatState} keys=${Object.keys(payload).join(',')}`);

        if (runId) this.currentRunId = runId;
        if (sessionKey) this.currentSessionKey = sessionKey;

        switch (chatState) {
          case 'delta': {
            if (!this.chatStarted) {
              this.chatStarted = true;
              this.chatStartTime = Date.now();
              this.chatToolCount = 0;
              this.chatToolNames = [];
              const prompt = this.lastPrompt
                ? this.lastPrompt.length > 150 ? this.lastPrompt.slice(0, 147) + '...' : this.lastPrompt
                : 'Task started';
              this.addTimelineEntry({ ts: Date.now(), type: 'chat_start', raw: prompt });
            }
            this.state = State.PROCESSING;
            this.emitStateUpdate();
            break;
          }

          case 'final': {
            this.chatStarted = false;
            const elapsed = this.chatStartTime > 0 ? Math.round((Date.now() - this.chatStartTime) / 1000) : 0;
            const parts: string[] = ['Completed'];
            if (elapsed > 0) parts.push(elapsed >= 60 ? `${Math.floor(elapsed / 60)}m${elapsed % 60}s` : `${elapsed}s`);
            if (this.chatToolNames.length > 0) {
              parts.push(this.chatToolNames.join(', '));
            } else if (this.chatToolCount > 0) {
              parts.push(`${this.chatToolCount} tool${this.chatToolCount > 1 ? 's' : ''}`);
            }
            // Append prompt snippet for context
            if (this.lastPrompt) {
              const promptSnippet = this.lastPrompt.length > 80
                ? this.lastPrompt.slice(0, 77) + '...'
                : this.lastPrompt;
              parts.push(promptSnippet);
            }
            this.addTimelineEntry({ ts: Date.now(), type: 'chat_end', raw: parts.join(' · ') });

            // Attempt post-enrichment from history (async, best-effort)
            const enrichStartTime = this.chatStartTime;
            this.enrichTimelineFromHistory(enrichStartTime);

            this.currentRunId = null;
            this.lastPrompt = null;
            this.chatToolNames = [];
            this.state = State.IDLE;
            this.emitStateUpdate();
            break;
          }

          case 'aborted': {
            this.chatStarted = false;
            const elapsed = this.chatStartTime > 0 ? Math.round((Date.now() - this.chatStartTime) / 1000) : 0;
            const abortParts: string[] = ['Aborted'];
            if (elapsed > 0) abortParts.push(`after ${elapsed}s`);
            if (this.chatToolNames.length > 0) abortParts.push(this.chatToolNames.join(', '));
            if (this.lastPrompt) {
              const abortSnippet = this.lastPrompt.length > 80
                ? this.lastPrompt.slice(0, 77) + '...'
                : this.lastPrompt;
              abortParts.push(abortSnippet);
            }
            this.addTimelineEntry({ ts: Date.now(), type: 'chat_end', raw: abortParts.join(' · ') });
            this.currentRunId = null;
            this.lastPrompt = null;
            this.chatToolNames = [];
            this.state = State.IDLE;
            this.emitStateUpdate();
            break;
          }

          case 'error':
            this.chatStarted = false;
            this.addTimelineEntry({ ts: Date.now(), type: 'error', raw: (payload.errorMessage as string) || 'Error' });
            this.currentRunId = null;
            this.lastPrompt = null;
            this.chatToolNames = [];
            dlog(TAG, `Chat error: ${payload.errorMessage || 'unknown'}`);
            this.state = State.IDLE;
            this.emitStateUpdate();
            break;
        }
        break;
      }

      // ===== Tool approval =====
      case 'exec.approval.requested': {
        const approvalId = payload.id as string;
        const command = payload.command as string;
        const ask = payload.ask as string | undefined;
        this.chatToolCount++;

        // Extract tool name from command (e.g. "Read", "Bash", "Edit", "Write")
        if (command) {
          const toolName = command.split(/[\s(/:]/)[0];
          if (toolName && !this.chatToolNames.includes(toolName)) {
            this.chatToolNames.push(toolName);
          }
        }

        // Prefer command (e.g. "Read /path/to/file.ts") over ask ("Allow Read?")
        // If both exist and differ, combine them for maximum context
        let toolRaw: string;
        if (command && ask && ask !== command) {
          toolRaw = `${command} — ${ask}`;
        } else {
          toolRaw = command || ask || 'Tool execution';
        }

        this.addTimelineEntry({
          ts: Date.now(),
          type: 'tool_request',
          raw: toolRaw,
          approvalId,
          status: 'pending',
        });

        this.pendingApprovalId = approvalId;
        this.pendingApprovalQuestion = ask || command || 'Approve tool execution?';
        this.state = State.AWAITING_PERMISSION;

        // Emit state_update with options embedded (atomic delivery)
        this.emitStateUpdate();

        // Also emit prompt_options for consistency
        this.emit('prompt_options', {
          type: 'prompt_options',
          promptType: 'yes_no',
          question: this.pendingApprovalQuestion,
          options: [
            { index: 0, label: 'Allow', shortcut: 'y' },
            { index: 1, label: 'Deny', shortcut: 'n' },
          ],
        });
        break;
      }

      case 'exec.approval.resolved': {
        const resolvedId = this.pendingApprovalId;
        if (resolvedId) {
          timelineStore.updateEntryStatus(resolvedId, 'approved');
        }
        this.pendingApprovalId = null;
        this.pendingApprovalQuestion = undefined;
        this.state = State.PROCESSING;
        this.emitStateUpdate();
        break;
      }

      // ===== Presence / keepalive =====
      case 'presence':
      case 'tick':
        break;

      // ===== Lifecycle =====
      case 'shutdown':
        dlog(TAG, 'Gateway shutdown event');
        this.state = State.DISCONNECTED;
        this.emitStateUpdate();
        break;

      default:
        dlog(TAG, `Unhandled event: ${event}`);
        break;
    }
  }

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
        displayName: 'AgentDeck Plugin',
        version: '0.3.0',
        platform: process.platform,
        mode: 'backend',
      },
      role: 'operator',
      scopes,
      caps: ['tool-events'],
    };

    if (this.deviceIdentity && this.deviceAuthToken) {
      try {
        params.device = this.buildDeviceAuth(nonce, scopes, authToken);
        params.auth = { token: authToken };
      } catch (err) {
        dwarn(TAG, `Device auth signing failed: ${err}`);
      }
    }

    const id = 'init-1';
    const message: GatewayRequest = { type: 'req', id, method: 'connect', params };

    this.pendingRpc.set(id, {
      resolve: (_payload) => {
        dinfo(TAG, 'Handshake complete');
        this._connected = true;
        this.reconnectDelay = 1000;
        this.state = State.IDLE;

        this.emit('connected');
        this.emitStateUpdate();

        // Fetch sessions to find an active one
        this.fetchSessions();

        // Fetch model catalog via CLI
        this.fetchModelCatalog();

        // Fetch history (events that occurred while plugin was offline)
        this.fetchHistory();

        // Fetch scheduled tasks (if Gateway supports it)
        this.fetchScheduled();
      },
      reject: (err) => {
        derr(TAG, `Handshake failed: ${err.message}`);
      },
      method: 'connect',
    });

    setTimeout(() => {
      if (this.pendingRpc.has(id)) {
        this.pendingRpc.delete(id);
        dwarn(TAG, 'Connect handshake timeout');
      }
    }, GatewayClient.RPC_TIMEOUT);

    try {
      this.ws.send(JSON.stringify(message));
      dlog(TAG, '→ connect (handshake)');
    } catch (err) {
      this.pendingRpc.delete(id);
      derr(TAG, `Failed to send connect request: ${err}`);
    }
  }

  private async fetchSessions(): Promise<void> {
    try {
      const result = await this.rpcCall('sessions.list', {});
      if (!result || typeof result !== 'object') return;

      const resp = result as { sessions?: GatewaySession[]; count?: number };
      const sessions = resp.sessions;
      if (!sessions || sessions.length === 0) {
        dlog(TAG, 'No sessions available');
        return;
      }

      dlog(TAG, `Sessions: ${sessions.length}`);

      const sorted = [...sessions].sort(
        (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
      );
      this.currentSessionKey = sorted[0].key;

      const label = sorted[0].label || sorted[0].displayName;
      if (label) {
        this.projectName = label;
        // Re-emit state with project name
        this.emitStateUpdate();
      }

      dlog(TAG, `Active session: ${this.currentSessionKey}`);
    } catch (err) {
      dwarn(TAG, `sessions.list failed: ${err}`);
    }
  }

  // ===== Private: Model Catalog =====

  /**
   * Wait for currentSessionKey to become available, then send chat.send.
   * Polls every 500ms, up to `retries` attempts (default 10 = 5 seconds).
   */
  private waitForSession(text: string, retries = 10): void {
    if (this.currentSessionKey) {
      dlog(TAG, `waitForSession: session ready, sending "${text.slice(0, 40)}"`);
      this.rpcCall('chat.send', {
        sessionKey: this.currentSessionKey,
        message: text,
        idempotencyKey: randomUUID(),
      }).catch((err) => dwarn(TAG, `chat.send failed: ${err}`));
      return;
    }
    if (retries <= 0 || !this._connected) {
      dwarn(TAG, 'send_prompt: session timeout after waiting');
      return;
    }
    dlog(TAG, `waitForSession: no session yet, retrying (${retries} left)`);
    setTimeout(() => this.waitForSession(text, retries - 1), 500);
  }

  /** Resolve `openclaw` binary: try known candidate paths, fallback to bare name on PATH. */
  private static resolveOpenClawBin(): string {
    for (const candidate of OPENCLAW_CANDIDATES) {
      if (existsSync(candidate)) return candidate;
    }
    return 'openclaw'; // fallback to PATH lookup
  }

  /** Fetch model catalog via `openclaw models list --json`. */
  private fetchModelCatalog(retries = 2): void {
    const now = Date.now();
    if (this.modelCatalog && now - this.modelCatalogTime < GatewayClient.MODEL_CATALOG_TTL) {
      return;
    }

    const bin = GatewayClient.resolveOpenClawBin();
    try {
      const output = execSync(`${bin} models list --json`, {
        timeout: 5000,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, PATH: augmentedPath() },
      }).trim();

      const result = JSON.parse(output) as { count: number; models: Array<{
        key: string; name: string; tags?: string[]; available?: boolean;
      }> };

      if (!result.models || !Array.isArray(result.models)) return;

      this.modelCatalog = result.models.map((m) => {
        let role: ModelCatalogEntry['role'] = 'configured';
        const tags = m.tags ?? [];
        if (tags.includes('default')) {
          role = 'default';
        } else {
          for (const tag of tags) {
            const match = tag.match(/^fallback#(\d+)$/);
            if (match) {
              role = `fallback-${match[1]}` as `fallback-${number}`;
              break;
            }
          }
        }
        return { name: m.name, role, available: m.available !== false };
      });
      this.modelCatalogTime = now;

      dlog(TAG, `Model catalog: ${this.modelCatalog.length} models`);

      // Re-emit state with catalog
      this.emitStateUpdate();
    } catch (err) {
      dlog(TAG, `Model catalog fetch failed: ${err}`);
      if (retries > 0 && this._connected) {
        dlog(TAG, `Retrying model catalog in 10s (${retries} left)`);
        setTimeout(() => this.fetchModelCatalog(retries - 1), 10_000);
      }
    }
  }

  /** Fetch scheduled/future tasks from Gateway (silently ignored if unsupported). */
  private async fetchScheduled(): Promise<void> {
    try {
      const result = await this.rpcCall('tasks.scheduled', {});
      if (!result || typeof result !== 'object') return;
      const resp = result as { tasks?: Array<{ at: number; label: string }> };
      if (!resp.tasks || resp.tasks.length === 0) {
        timelineStore.setScheduled([]);
        return;
      }
      timelineStore.setScheduled(
        resp.tasks.map((t) => ({ ts: t.at, type: 'scheduled' as const, raw: t.label })),
      );
    } catch {
      // Gateway doesn't support scheduled tasks yet — ignore
    }
  }

  /** Fetch events that occurred while plugin was offline. */
  private async fetchHistory(): Promise<void> {
    const since = timelineStore.getLastTimestamp();
    try {
      const result = await this.rpcCall('events.history', { since });
      if (!result || typeof result !== 'object') return;
      const resp = result as { events?: Array<{
        ts: number; type: string; raw: string;
        approvalId?: string; status?: string;
      }> };
      if (!resp.events || resp.events.length === 0) return;
      const entries: TimelineEntry[] = resp.events
        .filter((e) => ['tool_request', 'tool_resolved', 'chat_start', 'chat_end', 'error'].includes(e.type))
        .map((e) => ({
          ts: e.ts,
          type: e.type as TimelineEntry['type'],
          raw: e.raw,
          ...(e.approvalId ? { approvalId: e.approvalId } : {}),
          ...(e.status ? { status: e.status as TimelineEntry['status'] } : {}),
        }));
      if (entries.length > 0) {
        dlog(TAG, `History: merged ${entries.length} offline events (since=${since})`);
        timelineStore.mergeHistory(entries);
      }
    } catch {
      // Gateway doesn't support events.history yet — ignore
    }
  }

  /** Get cached model catalog (for standalone usage poll). */
  getModelCatalog(): ModelCatalogEntry[] | null {
    return this.modelCatalog;
  }

  // ===== Private: Timeline =====

  /**
   * Post-enrich the latest chat_end entry with tool details from events.history.
   * Best-effort — silently ignored if Gateway doesn't support it.
   */
  private async enrichTimelineFromHistory(since: number): Promise<void> {
    try {
      const result = await this.rpcCall('events.history', { since });
      if (!result || typeof result !== 'object') return;

      const resp = result as { events?: Array<{
        ts: number; type: string; raw?: string; command?: string; tool?: string;
      }> };
      if (!resp.events || resp.events.length === 0) return;

      // Extract tool names from history events
      const toolNames: string[] = [];
      const toolCounts = new Map<string, number>();
      for (const ev of resp.events) {
        const toolName = ev.tool || (ev.command ? ev.command.split(/[\s(/:]/)[0] : null);
        if (toolName) {
          toolCounts.set(toolName, (toolCounts.get(toolName) || 0) + 1);
          if (!toolNames.includes(toolName)) {
            toolNames.push(toolName);
          }
        }
      }

      if (toolNames.length === 0) return;

      // Build enriched tool summary: "Read(3), Bash(2), Edit(1)"
      const toolSummary = toolNames
        .map((name) => {
          const count = toolCounts.get(name) || 1;
          return count > 1 ? `${name}(${count})` : name;
        })
        .join(', ');

      // Find the last chat_end entry and update its raw text
      const idx = timelineStore.findLastIndex('chat_end');
      if (idx < 0) return;

      const groups = timelineStore.getGroupedDisplay();
      // Reconstruct: find the grouped entry for this index to get current raw
      // Simpler: just read the raw from the entry via getGroupedDisplay or direct access
      // We'll patch the raw by appending/replacing tool info
      const currentEntry = groups.find(
        (g) => g.entry.type === 'chat_end' && g.lastTs >= since,
      );
      if (!currentEntry) return;

      const currentRaw = currentEntry.entry.raw;
      // If already has tool info from chatToolNames, replace; otherwise append
      const parts = currentRaw.split(' · ');
      // Parts: ["Completed", "42s", maybe tool names, maybe prompt]
      // Insert tool summary after the time part (index 1 or 2)
      const enrichedParts: string[] = [];
      let toolInserted = false;
      for (const part of parts) {
        // Skip any existing weak tool info (e.g. "2 tools")
        if (/^\d+ tools?$/.test(part)) {
          enrichedParts.push(toolSummary);
          toolInserted = true;
        } else {
          enrichedParts.push(part);
        }
      }
      if (!toolInserted) {
        // Insert after time (position 2) or after "Completed" (position 1)
        const insertIdx = enrichedParts.length >= 2 ? 2 : 1;
        enrichedParts.splice(insertIdx, 0, toolSummary);
      }

      const newRaw = enrichedParts.join(' · ');
      if (newRaw !== currentRaw) {
        timelineStore.updateEntryRaw(idx, newRaw);
        dlog(TAG, `Timeline enriched: ${newRaw}`);
      }
    } catch {
      // Gateway doesn't support events.history — silently ignore
    }
  }

  private addTimelineEntry(entry: TimelineEntry): void {
    timelineStore.addEntry(entry);
  }

  // ===== Private: State Emission =====

  /**
   * Emit a state_update BridgeEvent matching the current internal state.
   * This is what the plugin event handlers expect.
   */
  private emitStateUpdate(): void {
    const ev: StateUpdateEvent = {
      type: 'state_update',
      state: this.state,
      permissionMode: PermissionMode.DEFAULT,
      agentType: 'openclaw',
      agentCapabilities: OPENCLAW_CAPABILITIES,
      projectName: this.projectName,
      navigable: false,
      modelCatalog: this.modelCatalog ?? undefined,
    };

    if (this.pendingApprovalId) {
      ev.options = [
        { index: 0, label: 'Allow', shortcut: 'y' },
        { index: 1, label: 'Deny', shortcut: 'n' },
      ];
      ev.promptType = 'yes_no';
      ev.question = this.pendingApprovalQuestion;
    }

    this.emit('state_update', ev);
  }
}
