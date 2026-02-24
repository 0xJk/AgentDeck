import { EventEmitter } from 'events';
import type { Server } from 'http';
import type { PluginCommand } from './protocol.js';

// ===== Agent Types =====

export type AgentType = 'claude-code' | 'openclaw';

export interface AgentCapabilities {
  type: AgentType;
  displayName: string;
  /** PTY terminal attachment (stdin/stdout proxy) */
  hasTerminal: boolean;
  /** Plan/AcceptEdits/Default mode switching */
  hasModeSwitching: boolean;
  /** Diff review UI (view/apply/deny) */
  hasDiffReview: boolean;
  /** Numbered option lists with arrow navigation */
  hasOptionLists: boolean;
  /** Arrow-key navigable prompts */
  hasNavigablePrompts: boolean;
  /** Ghost text suggested prompts */
  hasSuggestedPrompts: boolean;
  /** OAuth-based API usage tracking */
  hasApiUsage: boolean;
  /** CLI-based model catalog (openclaw models list) */
  hasModelCatalog: boolean;
}

// ===== Adapter Options =====

export interface AdapterStartOptions {
  /** Bridge port (injected as env var for hook scripts) */
  port: number;
  /** Command to spawn (e.g. 'claude') — only relevant for PTY-based agents */
  command?: string;
  /** Gateway WebSocket URL — only relevant for gateway-based agents (OpenClaw) */
  gatewayUrl?: string;
}

// ===== Adapter Events =====

/** Hook-sourced event (Claude Code HTTP hooks / OpenClaw WS events) */
export interface AdapterHookEvent {
  source: 'hook';
  event: string;
  data: Record<string, unknown>;
}

/** Parser-sourced event (PTY regex parsing / OpenClaw structured events) */
export interface AdapterParserEvent {
  source: 'parser';
  event: string;
  data?: Record<string, unknown>;
}

/** Metadata update (cursor, usage, user prompt, model catalog — no state transition) */
export interface AdapterMetadataEvent {
  source: 'metadata';
  event: 'cursor_update' | 'usage_info' | 'user_prompt' | 'model_catalog';
  data: Record<string, unknown>;
}

/** Activity signal — resets stuck timer */
export interface AdapterActivityEvent {
  source: 'activity';
}

/** Connection status change */
export interface AdapterConnectionEvent {
  source: 'connection';
  status: 'connected' | 'disconnected';
}

export type AdapterEvent =
  | AdapterHookEvent
  | AdapterParserEvent
  | AdapterMetadataEvent
  | AdapterActivityEvent
  | AdapterConnectionEvent;

// ===== Adapter Interface =====

/**
 * Agent adapter interface.
 *
 * **Command handling split**:
 * - `handleCommand()` handles transport-only commands (interrupt, escape, switch_mode, respond)
 *   where the adapter owns the full logic.
 * - Commands needing StateMachine context (select_option, navigate_option, send_prompt)
 *   are handled by the bridge, which calls `writeInput()` for the transport layer.
 * - Bridge-only commands (voice, query_usage) are never passed to the adapter.
 *
 * **Phase 2 note**: For non-PTY agents (OpenClaw), `select_option` and `navigate_option`
 * will move into `handleCommand()` since they map to RPC calls, not PTY escape sequences.
 * The bridge will check `capabilities.hasNavigablePrompts` to decide the routing.
 */
export interface AgentAdapter extends EventEmitter {
  readonly capabilities: AgentCapabilities;

  /**
   * Start the agent process/connection.
   * Emits 'event' with AdapterEvent payloads.
   */
  start(options: AdapterStartOptions): Promise<void>;

  /**
   * Handle a command from the plugin.
   * Returns true if the command was handled, false if not applicable.
   */
  handleCommand(cmd: PluginCommand): boolean;

  /**
   * Send raw text/keystrokes to the agent's input stream.
   *
   * For PTY agents (Claude Code): writes directly to PTY (may include escape sequences).
   * For non-PTY agents: this is a low-level fallback. Prefer handleCommand() for
   * structured commands; Phase 2 adapters should handle select_option/navigate_option
   * in handleCommand() via RPC rather than relying on writeInput() escape sequences.
   */
  writeInput(data: string): void;

  /** Whether the agent process/connection is alive */
  isAlive(): boolean;

  /** Attach user terminal to agent process (no-op for non-PTY agents) */
  attachTerminal(stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream): void;

  /** Get the PTY tty path (undefined for non-PTY agents) */
  getTtyPath(): string | undefined;

  /** Get project name detected by the adapter */
  getProjectName(): string | null;

  /**
   * Get the underlying HTTP server.
   * Every adapter provides an HTTP server for WebSocket (plugin) attachment.
   * PTY adapters reuse the hook server; non-PTY adapters create a bare server.
   */
  getHttpServer(): Server;

  /** Register a diagnostic dump handler */
  onDiag(handler: (tail?: number) => unknown): void;

  /** Register a callback for raw agent output data (for ring buffer / journal diagnostics) */
  onRawData(callback: (data: string) => void): void;

  /** Graceful shutdown */
  shutdown(): Promise<void>;
}

// ===== Adapter Event Declaration (for TypeScript EventEmitter typing) =====

export interface AgentAdapterEvents {
  event: (evt: AdapterEvent) => void;
  exit: (code: number, signal: number) => void;
}

// ===== Agent Capabilities (constants) =====

export const CLAUDE_CODE_CAPABILITIES: AgentCapabilities = {
  type: 'claude-code',
  displayName: 'Claude Code',
  hasTerminal: true,
  hasModeSwitching: true,
  hasDiffReview: true,
  hasOptionLists: true,
  hasNavigablePrompts: true,
  hasSuggestedPrompts: true,
  hasApiUsage: true,
  hasModelCatalog: false,
};

export const OPENCLAW_CAPABILITIES: AgentCapabilities = {
  type: 'openclaw',
  displayName: 'OpenClaw',
  hasTerminal: false,
  hasModeSwitching: false,
  hasDiffReview: false,
  hasOptionLists: true,
  hasNavigablePrompts: false,
  hasSuggestedPrompts: false,
  hasApiUsage: false,
  hasModelCatalog: true,
};

/** Default OpenClaw Gateway port */
export const OPENCLAW_GATEWAY_PORT = 18789;
