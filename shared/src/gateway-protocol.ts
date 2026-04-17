/**
 * OpenClaw Gateway WebSocket protocol — single source of truth.
 *
 * Wire shape: JSON-encoded frames with a `type` discriminator (`req`/`res`/`event`).
 * Auth: Ed25519 device signature over `v2|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce`.
 * Bridge implementation: `bridge/src/adapters/openclaw.ts` (Node) / `apple/AgentDeck/Daemon/Modules/OpenClawAdapter.swift` (Swift).
 *
 * This file is used by `scripts/generate-protocol.sh` to emit Swift/Kotlin bindings
 * under `generated/protocol/`, ensuring protocol parity across the three implementations.
 */

// ===== Protocol version =====

/** Protocol major version. Bridge rejects mismatched Gateway versions. */
export const GATEWAY_PROTOCOL_VERSION = 3;

/** Default Gateway port (OpenClaw backend). */
export const GATEWAY_DEFAULT_PORT = 18789;

/** Ed25519 SPKI DER prefix length (bytes before the raw 32-byte key). */
export const ED25519_SPKI_PREFIX_LEN = 12;

// ===== Frame envelopes =====

/** Client → Gateway: RPC request. */
export interface GatewayRequestFrame {
  type: 'req';
  id: string;
  method: GatewayMethodName;
  params: GatewayMethodParams;
}

/** Gateway → Client: RPC response (ok=true) or error (ok=false). */
export interface GatewayResponseFrame {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: GatewayMethodResult;
  error?: GatewayError;
}

/** Gateway → Client: unsolicited event. */
export interface GatewayEventFrame {
  type: 'event';
  event: GatewayEventName;
  payload: GatewayEventPayload;
  /** Monotonic sequence number (optional, used for ordering on reconnect). */
  seq?: string;
  /** Server-side state version for dedup on replay. */
  stateVersion?: string;
}

export type GatewayFrame = GatewayRequestFrame | GatewayResponseFrame | GatewayEventFrame;

export interface GatewayError {
  code: string;
  message: string;
  details?: unknown;
}

// ===== Method catalog =====

export type GatewayMethodName =
  | 'connect'
  | 'chat.send'
  | 'chat.abort'
  | 'exec.approval.resolve'
  | 'sessions.list';

export type GatewayMethodParams =
  | ConnectParams
  | ChatSendParams
  | ChatAbortParams
  | ExecApprovalResolveParams
  | SessionsListParams;

export type GatewayMethodResult =
  | ConnectResult
  | ChatSendResult
  | ChatAbortResult
  | ExecApprovalResolveResult
  | SessionsListResult;

// connect — signed handshake response to connect.challenge
export interface ConnectParams {
  auth: DeviceAuth;
  requestScopes: string[];
  clientInfo?: {
    clientId: string;
    clientMode: 'backend' | 'frontend';
    version?: string;
  };
}

export interface ConnectResult {
  accepted: boolean;
  sessionToken?: string;
  expiresAt?: number;
}

export interface DeviceAuth {
  id: string;
  publicKey: string;  // base64url raw Ed25519 key (32 bytes)
  signature: string;  // base64url Ed25519 signature
  signedAt: number;   // ms since epoch
  nonce: string;      // from connect.challenge
}

// chat.send — dispatch user message to active session
export interface ChatSendParams {
  sessionKey: string;
  message: string;
  idempotencyKey: string;
}

export interface ChatSendResult {
  runId?: string;
  accepted: boolean;
}

// chat.abort — cancel in-flight run
export interface ChatAbortParams {
  sessionKey: string;
  runId?: string;
}

export interface ChatAbortResult {
  aborted: boolean;
}

// exec.approval.resolve — allow/deny a tool execution approval
export interface ExecApprovalResolveParams {
  id: string;
  decision: 'allow' | 'deny';
}

export interface ExecApprovalResolveResult {
  resolved: boolean;
}

// sessions.list — enumerate active Gateway sessions
export interface SessionsListParams {
  kind?: string;
}

export interface SessionsListResult {
  sessions: GatewaySession[];
}

export interface GatewaySession {
  key: string;
  kind?: string;
  label?: string;
  displayName?: string;
  updatedAt?: number;
  sessionId?: string;
}

// ===== Event catalog =====

export type GatewayEventName =
  | 'connect.challenge'
  | 'chat'
  | 'exec.approval.requested'
  | 'exec.approval.resolved'
  | 'presence'
  | 'tick'
  | 'shutdown';

export type GatewayEventPayload =
  | ConnectChallengePayload
  | ChatEventPayload
  | ExecApprovalRequestedPayload
  | ExecApprovalResolvedPayload
  | PresencePayload
  | TickPayload
  | ShutdownPayload;

export interface ConnectChallengePayload {
  nonce: string;
  expiresAt?: number;
}

export interface ChatEventPayload {
  state: 'delta' | 'final' | 'aborted' | 'error';
  runId?: string;
  sessionKey?: string;
  /** Incremental text chunk (delta state). */
  delta?: string;
  /** Full assembled response (final state). */
  response?: string;
  /** Tool invocations observed in this turn. */
  tools?: ChatToolInvocation[];
  /** User prompt text, as echoed by Gateway on first delta. */
  prompt?: string;
  /** Error message (error state). */
  error?: string;
  /** Model identifier used for this turn. */
  modelId?: string;
  /** Token accounting (final state). */
  inputTokens?: number;
  outputTokens?: number;
  /** Session identifier when Gateway creates a new session mid-chat. */
  newSessionId?: string;
}

export interface ChatToolInvocation {
  name: string;
  input?: unknown;
  output?: unknown;
  status?: 'pending' | 'success' | 'error';
}

export interface ExecApprovalRequestedPayload {
  id: string;
  sessionKey?: string;
  tool: string;
  command?: string;
  reason?: string;
  /** Options surfaced to the user (default: allow/deny). */
  options?: Array<{ key: string; label: string }>;
}

export interface ExecApprovalResolvedPayload {
  id: string;
  decision: 'allow' | 'deny' | 'timeout';
  sessionKey?: string;
}

export interface PresencePayload {
  connected: boolean;
  clientId?: string;
  deviceId?: string;
}

export interface TickPayload {
  serverTime: number;
}

export interface ShutdownPayload {
  reason?: string;
  restartAt?: number;
}

// ===== Device identity =====

/** On-disk identity, loaded from `~/.openclaw/identity/device.json`. */
export interface DeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

/** Loaded from `~/.openclaw/identity/device-auth.json` → `tokens.operator`. */
export interface DeviceAuthToken {
  token: string;
  role: string;
  scopes: string[];
}
