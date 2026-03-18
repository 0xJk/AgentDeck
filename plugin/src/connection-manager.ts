/**
 * ConnectionManager — manages Bridge vs Gateway priority.
 *
 * Both clients connect simultaneously. Bridge takes priority:
 * - Bridge connected → activeLink = bridge, gateway paused
 * - Bridge absent + Gateway connected → activeLink = gateway
 * - Bridge arrives later → switch from gateway to bridge
 * - Bridge disconnects → resume gateway
 *
 * Implements AgentLink so plugin.ts can treat it as a drop-in replacement
 * for BridgeClient. All events from the active link are forwarded.
 */
import { EventEmitter } from 'events';
import {
  PluginCommand,
  AgentCapabilities,
  State,
} from '@agentdeck/shared';
import type { BridgeEvent, StateUpdateEvent } from '@agentdeck/shared';
import type { AgentLink } from './agent-link.js';
import { BridgeClient } from './bridge-client.js';
import { GatewayClient } from './gateway-client.js';
import { dlog, dinfo, dwarn } from './log.js';

const TAG = 'ConnMgr';

/** Events forwarded from the active link */
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
] as const;

export class ConnectionManager extends EventEmitter implements AgentLink {
  readonly bridge: BridgeClient;
  private readonly gateway: GatewayClient;
  private activeLink: AgentLink | null = null;
  private started = false;
  private userSelection: 'auto' | 'bridge' | 'gateway' = 'auto';
  private gatewayEverConnected = false;
  private bridgeReportedGateway = false;
  private preconnectEnabled = true;
  private activateTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    super();
    this.bridge = new BridgeClient();
    this.gateway = new GatewayClient();
    this.setupBridgeListeners();
    this.setupGatewayListeners();
  }

  // ===== AgentLink interface =====

  send(command: PluginCommand): void {
    dlog(TAG, `send(${command.type}): activeLink=${this.activeLink ? (this.activeLink === this.bridge ? 'bridge' : 'gateway') : 'NULL'} ` +
      `bridge=${this.bridge.isConnected()} gateway=${this.gateway.isConnected()} userSel=${this.userSelection}`);
    if (this.activeLink) {
      this.activeLink.send(command);
    } else {
      dwarn(TAG, `send(${command.type}) dropped — no active link`);
    }
  }

  isConnected(): boolean {
    return this.activeLink?.isConnected() ?? false;
  }

  getCapabilities(): AgentCapabilities | null {
    return this.activeLink?.getCapabilities() ?? null;
  }

  disconnect(): void {
    this.bridge.disconnect();
    this.gateway.disconnect();
    this.activeLink = null;
  }

  // ===== Public API =====

  /**
   * Start both clients. Bridge connects to the given port (or scans for one);
   * Gateway connects to the default OpenClaw port.
   */
  start(port?: number): void {
    if (this.started) return;
    this.started = true;

    dinfo(TAG, `start(port=${port ?? 'auto'})`);

    // Start bridge
    this.bridge.connect(port);

    // Preconnect gateway in background for instant switching (even if bridge is primary)
    if (this.preconnectEnabled) {
      this.gateway.resume();
    }
  }

  /** Expose bridge's scanLatestPort setter for plugin.ts */
  set scanLatestPort(fn: (() => number | undefined) | null) {
    this.bridge.scanLatestPort = fn;
  }

  /** Reconnect bridge to a different session port (for session switching). */
  reconnectBridgeTo(port: number): void {
    dlog(TAG, `reconnectBridgeTo(${port})`);
    this.bridge.reconnectTo(port);
  }

  /** Get current bridge port (for session/iterm dial). */
  getBridgePort(): number {
    return this.bridge.getPort();
  }

  // ===== Agent Selection API =====

  /** Explicitly switch to OpenClaw (Gateway) as active agent. */
  activateGateway(): void {
    dinfo(TAG, 'activateGateway()');
    this.userSelection = 'gateway';
    this.gateway.resume();

    // Activate immediately (UI responds right away)
    this.activeLink = this.gateway;
    this.emit('active_agent_changed', 'openclaw');

    // Emit the latest state immediately to fix Stream Deck stuck icon
    this.gateway.emitStateUpdate();

    // If already connected, no timeout needed
    if (this.gateway.isConnected()) return;

    // 15s timeout: if gateway doesn't connect, revert to bridge
    if (this.activateTimer) clearTimeout(this.activateTimer);
    this.activateTimer = setTimeout(() => {
      this.activateTimer = null;
      if (this.gateway.isConnected()) return;
      if (this.userSelection !== 'gateway') return;

      dwarn(TAG, 'Gateway activation timeout — reverting to bridge');
      this.userSelection = 'auto';
      if (this.bridge.isConnected()) {
        this.activeLink = this.bridge;
        this.emit('active_agent_changed', 'claude-code');
        this.emit('connected');
      } else {
        this.activeLink = null;
        this.emit('disconnected');
      }
    }, 15000);
  }

  /** Explicitly switch to Claude Code (Bridge) as active agent. */
  activateBridge(): void {
    dinfo(TAG, 'activateBridge()');
    this.userSelection = 'bridge';
    this.activeLink = this.bridge;
    this.emit('active_agent_changed', 'claude-code');
  }

  /** Reset to automatic priority (bridge > gateway). */
  resetToAuto(): void {
    dinfo(TAG, 'resetToAuto()');
    this.userSelection = 'auto';
    if (this.bridge.isConnected()) {
      this.activeLink = this.bridge;
    } else if (this.gateway.isConnected()) {
      this.gateway.resume();
      this.activeLink = this.gateway;
    }
  }

  /** Get the active agent type, or null if disconnected. */
  getActiveAgentType(): 'claude-code' | 'openclaw' | null {
    if (this.activeLink === this.bridge) return 'claude-code';
    if (this.activeLink === this.gateway) return 'openclaw';
    return null;
  }

  /**
   * Whether gateway is available (connected, or was previously connected and can be resumed).
   * Used to determine if OC should appear in the session cycle list.
   */
  setBridgeGatewayAvailable(available: boolean): void {
    this.bridgeReportedGateway = available;
    if (available) this.maybePreconnectGateway();
  }

  isGatewayAvailable(): boolean {
    return this.gateway.isConnected() || this.gatewayEverConnected || this.bridgeReportedGateway;
  }

  /** Get the user's current agent selection preference. */
  getUserSelection(): 'auto' | 'bridge' | 'gateway' {
    return this.userSelection;
  }

  // ===== Private: Event Wiring =====

  /** If gateway is available, keep a background connection ready for instant switching. */
  private maybePreconnectGateway(): void {
    if (!this.preconnectEnabled) return;
    if (!this.bridgeReportedGateway) return;
    if (this.gateway.isConnected()) return;
    // Only preconnect when bridge is up (so we have a primary session) and user didn't force bridge-only
    if (this.bridge.isConnected() && this.userSelection !== 'bridge') {
      dinfo(TAG, 'Preconnecting Gateway in background');
      this.gateway.resume();
    }
  }

  private setupBridgeListeners(): void {
    // Forward all bridge events when bridge is the active link
    for (const eventName of FORWARDED_EVENTS) {
      this.bridge.on(eventName, (ev: BridgeEvent) => {
        if (this.activeLink === this.bridge) {
          this.emit(eventName, ev);
        }
      });
    }

    this.bridge.on('connected', () => {
      dinfo(TAG, 'Bridge connected');
      // Keep Gateway warm in the background for fast switching
      this.maybePreconnectGateway();

      // Bridge provides enriched timeline — suppress gateway's local timeline generation
      this.gateway.receivingBridgeTimeline = true;

      // If user explicitly selected gateway, don't auto-switch
      if (this.userSelection === 'gateway') {
        dlog(TAG, 'User selected gateway — bridge connected but not switching');
        return;
      }

      dinfo(TAG, 'Bridge connected — activating');
      this.activeLink = this.bridge;
      // Keep gateway connected for instant switching; events only forward when activeLink=gateway

      this.emit('connected');
    });

    this.bridge.on('disconnected', () => {
      dinfo(TAG, 'Bridge disconnected');

      // Bridge no longer provides timeline — resume gateway's local timeline generation
      this.gateway.receivingBridgeTimeline = false;

      if (this.activeLink === this.bridge) {
        this.activeLink = null;

        // Reset user selection if it was explicitly set to bridge
        if (this.userSelection === 'bridge') {
          dlog(TAG, 'Resetting userSelection from bridge to auto');
          this.userSelection = 'auto';
        }

        // Try to resume gateway as fallback
        dlog(TAG, 'Resuming gateway as fallback');
        this.gateway.resume();

        // If gateway is already connected, activate it immediately
        if (this.gateway.isConnected()) {
          dinfo(TAG, 'Gateway already connected — activating');
          this.activeLink = this.gateway;
          this.emit('connected');
        } else {
          // Neither connected — emit disconnected
          this.emit('disconnected');
        }
      }
    });
  }

  private setupGatewayListeners(): void {
    // Forward all gateway events when gateway is the active link
    for (const eventName of FORWARDED_EVENTS) {
      this.gateway.on(eventName, (ev: BridgeEvent) => {
        if (this.activeLink === this.gateway) {
          this.emit(eventName, ev);
        }
      });
    }

    this.gateway.on('connected', () => {
      dinfo(TAG, 'Gateway connected');
      this.gatewayEverConnected = true;

      // If user explicitly selected bridge, don't auto-switch
      if (this.userSelection === 'bridge') {
        dlog(TAG, 'User selected bridge — gateway ignored');
        return;
      }

      // User explicitly selected gateway — activate even if bridge is connected
      if (this.userSelection === 'gateway') {
        dinfo(TAG, 'User selected gateway — activating');
        if (this.activateTimer) {
          clearTimeout(this.activateTimer);
          this.activateTimer = null;
        }
        this.activeLink = this.gateway;
        this.emit('connected');
        return;
      }

      // Auto mode: only activate if bridge isn't connected
      if (!this.bridge.isConnected()) {
        dinfo(TAG, 'No bridge — activating gateway');
        this.activeLink = this.gateway;
        this.emit('connected');
      } else {
        dlog(TAG, 'Bridge is active — gateway not activated');
      }
    });

    this.gateway.on('disconnected', () => {
      dlog(TAG, 'Gateway disconnected');

      if (this.activeLink === this.gateway) {
        this.activeLink = null;

        // Reset user selection if it was explicitly set to gateway
        if (this.userSelection === 'gateway') {
          dlog(TAG, 'Resetting userSelection from gateway to auto');
          this.userSelection = 'auto';
        }

        // Bridge should still be trying to reconnect on its own
        if (!this.bridge.isConnected()) {
          this.emit('disconnected');
        }
      }
    });
  }
}
