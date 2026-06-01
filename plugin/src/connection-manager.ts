/**
 * ConnectionManager — active-bridge connection state machine (plan 001 §2b).
 *
 * The plugin connects to a single *active* bridge at a time. Bridges are paired
 * via the Property Inspector and stored in plugin globalSettings; the per-bridge
 * auth token lives in the macOS Keychain (token-store.ts).
 *
 * State machine:
 *
 *     idle
 *       │ start(): read globalSettings
 *       ▼
 *   activeBridgeId null? ──yes──▶ unconfigured
 *       │ no
 *       ▼
 *   loadToken(activeBridgeId)
 *       │ keyring throws ──▶ keychain_error  (no retry, no in-memory token)
 *       ▼
 *   connecting ──open──▶ connected
 *       │                   │ onClose 4001: stop reconnect, deleteToken ──▶ pairing
 *       │                   │ focus_lost event: clear local focus, STAY connected
 *       └── (non-4001 close handled by BridgeClient backoff)
 */
import { EventEmitter } from 'events';
import {
  PluginCommand,
  AgentCapabilities,
} from '@agentdeck/shared';
import type { BridgeEvent } from '@agentdeck/shared';
import type { AgentLink } from './agent-link.js';
import { BridgeClient } from './bridge-client.js';
import { loadToken, deleteToken } from './token-store.js';
import {
  getGlobalSettings,
  findBridge,
  type PairedBridge,
} from './bridge-settings.js';
import { dlog, dinfo, dwarn, derr } from './log.js';

const TAG = 'ConnMgr';

export type ConnectionState =
  | 'idle'
  | 'unconfigured'
  | 'connecting'
  | 'connected'
  | 'pairing'
  | 'keychain_error';

export interface ConnectionSnapshot {
  connected: boolean;
  state: ConnectionState;
  activeBridgeId: string | null;
  host: string | null;
  port: number | null;
  message: string;
}

/** Events forwarded from the bridge */
const FORWARDED_EVENTS = [
  'state_update',
  'prompt_options',
  'usage_update',
  'connection',
  'user_prompt',
  'voice_state',
  'timeline_event',
  'timeline_history',
  'display_state',
  'voice_assistant_state',
  'sessions_list',
] as const;

export class ConnectionManager extends EventEmitter implements AgentLink {
  /** Current active bridge client (null in idle / unconfigured / keychain_error). */
  bridge: BridgeClient | null = null;

  private state: ConnectionState = 'idle';
  private started = false;
  private gatewayAvailable = false;

  private activeBridge: PairedBridge | null = null;
  private focusedSessionId: string | null = null;
  private discoveryMessage = '';

  // ===== AgentLink interface =====

  send(command: PluginCommand): void {
    if (this.bridge && this.bridge.isConnected()) {
      dlog(TAG, `send(${command.type})`);
      this.bridge.send(command);
    } else {
      dwarn(TAG, `send(${command.type}) dropped — not connected`);
    }
  }

  isConnected(): boolean {
    return this.bridge?.isConnected() ?? false;
  }

  getCapabilities(): AgentCapabilities | null {
    return this.bridge?.getCapabilities() ?? null;
  }

  /** True when the active bridge host is not loopback (plan 001 §2g routing). */
  isRemoteActiveBridge(): boolean {
    const host = this.activeBridge?.host;
    if (!host) return false;
    return host !== 'localhost' && host !== '127.0.0.1';
  }

  disconnect(): void {
    this.teardownBridge();
  }

  // ===== Public API =====

  /**
   * Start the connection. Reads globalSettings to find the active bridge, loads
   * its token from the keychain, and connects. See class doc for transitions.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.connectActive();
  }

  /**
   * Switch the active bridge. Tears down the existing BridgeClient (including
   * its reconnect timer) and connects to the newly-active bridge from
   * globalSettings (plan 001 §2b / §2e).
   */
  async switchActiveBridge(_bridgeId?: string): Promise<void> {
    dinfo(TAG, `switchActiveBridge(${_bridgeId ?? 'from settings'})`);
    this.teardownBridge();
    await this.connectActive();
  }

  getState(): ConnectionState {
    return this.state;
  }

  getConnectionSnapshot(): ConnectionSnapshot {
    return {
      connected: this.isConnected(),
      state: this.state,
      activeBridgeId: this.activeBridge?.id ?? null,
      host: this.activeBridge?.host ?? null,
      port: this.activeBridge?.port ?? null,
      message: this.discoveryMessage,
    };
  }

  getBridgePort(): number | null {
    return this.bridge?.getPort() ?? this.activeBridge?.port ?? null;
  }

  // ===== Agent/Session Commands (all via the active bridge) =====

  focusSession(sessionId: string): void {
    dinfo(TAG, `focusSession(${sessionId})`);
    this.focusedSessionId = sessionId;
    this.send({ type: 'focus_session', sessionId } as PluginCommand);
  }

  /**
   * Release the daemon-side focus for the current session. Without this the
   * daemon focus-relay stays subscribed after the user leaves the detail view,
   * so re-entering the same session short-circuits and never replays
   * prompt_options — the options silently vanish (plan 002 interaction audit #1).
   */
  clearSessionFocus(): void {
    if (this.focusedSessionId === null) return;
    dinfo(TAG, `clearSessionFocus(${this.focusedSessionId})`);
    this.focusedSessionId = null;
    this.send({ type: 'clear_session_focus' } as PluginCommand);
  }

  getFocusedSessionId(): string | null {
    return this.focusedSessionId;
  }

  switchToOpenClaw(): void {
    dinfo(TAG, 'switchToOpenClaw()');
    this.send({ type: 'switch_agent', agent: 'openclaw' });
  }

  switchToClaude(): void {
    dinfo(TAG, 'switchToClaude()');
    this.send({ type: 'switch_agent', agent: 'claude-code' });
  }

  setBridgeGatewayAvailable(available: boolean): void {
    this.gatewayAvailable = available;
  }

  isGatewayAvailable(): boolean {
    return this.gatewayAvailable;
  }

  // ===== Private =====

  private setState(next: ConnectionState, message = ''): void {
    if (this.state !== next) {
      dinfo(TAG, `state ${this.state} -> ${next}${message ? ` (${message})` : ''}`);
      this.state = next;
      this.emit('state_change', next);
    }
    if (message) this.discoveryMessage = message;
  }

  /**
   * Resolve the active bridge from globalSettings, load its token, and connect.
   * Centralises the idle -> {unconfigured | keychain_error | connecting} fork.
   */
  private async connectActive(): Promise<void> {
    let settings;
    try {
      settings = await getGlobalSettings();
    } catch (err) {
      derr(TAG, `getGlobalSettings failed: ${err}`);
      this.setState('unconfigured', 'settings unavailable');
      return;
    }

    const active = findBridge(settings, settings.activeBridgeId);
    if (!active) {
      this.activeBridge = null;
      this.setState('unconfigured', 'no active bridge');
      return;
    }
    this.activeBridge = active;

    // Load the token from the keychain. A keyring throw is terminal — no retry,
    // never hold the token in memory (plan 001 §2b, eng review Issue 4).
    let token: string;
    try {
      token = (await loadToken(active.id)) ?? '';
    } catch (err) {
      derr(TAG, `loadToken(${active.id}) failed: ${err}`);
      this.setState('keychain_error', String(err));
      return;
    }

    this.setState('connecting', `${active.host}:${active.port}`);
    this.bridge = new BridgeClient({
      host: active.host,
      port: active.port,
      token,
    });
    this.setupBridgeListeners(this.bridge);
    this.bridge.connect();
  }

  /** Tear down the current BridgeClient and its reconnect timer. */
  private teardownBridge(): void {
    if (this.bridge) {
      this.bridge.removeAllListeners();
      try {
        this.bridge.disconnect();
      } catch (err) {
        dlog(TAG, `teardownBridge: disconnect ignored: ${err}`);
      }
      this.bridge = null;
    }
  }

  /**
   * Handle the active bridge closing with code 4001 (bad/expired token).
   * BridgeClient has already stopped its own reconnect loop; we delete the
   * stale token and move to `pairing` so the PI can prompt for a new one.
   */
  private async onAuthRejected(): Promise<void> {
    const bridgeId = this.activeBridge?.id;
    if (bridgeId) {
      try {
        await deleteToken(bridgeId);
      } catch (err) {
        derr(TAG, `deleteToken(${bridgeId}) on 4001 failed: ${err}`);
      }
    }
    this.setState('pairing', 'token rejected (4001)');
  }

  private setupBridgeListeners(bridge: BridgeClient): void {
    for (const eventName of FORWARDED_EVENTS) {
      bridge.on(eventName, (ev: BridgeEvent) => {
        this.emit(eventName, ev);
      });
    }

    bridge.on('connected', () => {
      dinfo(TAG, 'Bridge connected');
      this.setState('connected');
      this.emit('connected');
    });

    bridge.on('disconnected', () => {
      dinfo(TAG, 'Bridge disconnected');
      this.emit('disconnected');
    });

    // Close-code aware: 4001 => pairing (delete token); other codes are left to
    // BridgeClient's backoff reconnect (plan 001 §2a/§2b).
    bridge.on('close', (info: { code: number; reason: string }) => {
      if (info.code === 4001) {
        dwarn(TAG, 'Bridge closed 4001 — entering pairing');
        void this.onAuthRejected();
      }
    });

    // Session the plugin had focused died upstream. Clear local focus but stay
    // connected; the UI prompts the user to re-select (plan 001 §2b).
    bridge.on('focus_lost', (ev: BridgeEvent) => {
      dinfo(TAG, 'focus_lost — clearing local focus, staying connected');
      this.focusedSessionId = null;
      this.emit('focus_lost', ev);
    });
  }
}
