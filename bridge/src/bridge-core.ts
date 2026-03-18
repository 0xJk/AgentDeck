import type { Server } from 'http';
import type WebSocket from 'ws';
import { randomUUID } from 'crypto';
import { UsageTracker } from './usage-tracker.js';
import { StateMachine } from './state-machine.js';
import { WsServer } from './ws-server.js';
import { OllamaProbe, type OllamaStatus } from './ollama-probe.js';
import { DisplayMonitor } from './display-monitor.js';
import { BridgeTimelineStore } from './timeline-store.js';
import type { BridgeLogStream } from './log-stream.js';
import { buildUsageEvent } from './usage-event.js';
import { probeGateway, checkGatewayHealth } from './gateway-probe.js';
import { fetchUsageFromApi, hasOAuthToken, getTokenStatus, type ApiUsageData } from './usage-api.js';
import { buildEnrichedSessionsList } from './session-aggregator.js';
import {
  register as registerSession,
  deregister as deregisterSession,
} from './session-registry.js';
import { getOrCreateToken, getWsUrl } from './auth.js';
import { debug } from './logger.js';
import {
  State,
  type BridgeEvent,
  type StateSnapshot,
  type AgentType,
  type AgentCapabilities,
  type ModelCatalogEntry,
  type PluginCommand,
  type VoiceAssistantState,
} from './types.js';

function log(msg: string): void {
  process.stderr.write(msg + '\n');
}

// ===== Options =====

export interface BridgeCoreOptions {
  port: number;
  sessionId?: string;
  projectName: string;
  httpServer: Server;
}

// ===== BridgeCore =====

/**
 * Shared infrastructure extracted from index.ts and daemon-server.ts.
 *
 * Manages: StateMachine, WsServer, UsageTracker, DisplayMonitor, OllamaProbe,
 * BridgeTimelineStore, auth, session registry, probes, polling, shutdown.
 *
 * Callers (startSession / startDaemon) wire adapters, voice, utility, etc.
 */
export class BridgeCore {
  // Core components
  readonly port: number;
  readonly sessionId: string;
  readonly projectName: string;
  readonly stateMachine: StateMachine;
  readonly usageTracker: UsageTracker;
  readonly wsServer: WsServer;
  readonly bridgeTimeline: BridgeTimelineStore;
  readonly displayMonitor: DisplayMonitor;
  readonly ollamaProbe: OllamaProbe;

  // Auth
  readonly authToken: string;
  readonly wsUrl: string;

  // State caches (public for caller access)
  cachedApiUsage: ApiUsageData | null = null;
  lastApiFetchTime = 0;
  oauthConnected: boolean;
  apiUsageStale = false;
  cachedOllamaStatus: OllamaStatus | null = null;
  cachedGatewayAvailable = false;
  cachedGatewayHasError = false;
  cachedModelCatalog: ModelCatalogEntry[] | null = null;

  // Voice assistant state (for piggybacking on state_update)
  cachedVoiceAssistantState: VoiceAssistantState = 'disabled';
  cachedVoiceAssistantText: string | undefined;
  cachedVoiceAssistantResponseText: string | undefined;

  // Internal lifecycle tracking
  private intervals: ReturnType<typeof setInterval>[] = [];
  private timeouts: ReturnType<typeof setTimeout>[] = [];
  private lastSessionsListBroadcast = 0;
  private shutdownInProgress = false;
  private shutdownCallbacks: (() => void | Promise<void>)[] = [];
  private sseBroadcast?: (evt: BridgeEvent) => void;

  /** Optional callback to enrich sessions_list (e.g., daemon injects Gateway virtual session) */
  private sessionsEnricher?: (sessions: import('./session-aggregator.js').EnrichedSession[]) => import('./session-aggregator.js').EnrichedSession[];

  /** External client count provider (e.g., ESP32 serial connections) */
  private externalClientCount: () => number = () => 0;

  private static readonly USAGE_STALE_TTL = 10 * 60 * 1000; // 10 minutes

  constructor(opts: BridgeCoreOptions) {
    this.port = opts.port;
    this.sessionId = opts.sessionId ?? randomUUID();
    this.projectName = opts.projectName;

    // Core components
    this.usageTracker = new UsageTracker();
    this.stateMachine = new StateMachine(this.usageTracker);
    this.ollamaProbe = new OllamaProbe();
    this.displayMonitor = new DisplayMonitor();
    this.bridgeTimeline = new BridgeTimelineStore();
    this.oauthConnected = hasOAuthToken();

    // Auth
    this.authToken = getOrCreateToken();
    this.wsUrl = getWsUrl(opts.port);

    // WebSocket server
    this.wsServer = new WsServer(opts.httpServer);
  }

  /** Set optional SSE broadcast callback (for HookServer-based sessions) */
  setSseBroadcast(cb: (evt: BridgeEvent) => void): void {
    this.sseBroadcast = cb;
  }

  /** Broadcast to WS + optional SSE */
  broadcast(evt: BridgeEvent): void {
    this.wsServer.broadcast(evt);
    this.sseBroadcast?.(evt);
  }

  // ===== Timeline wiring =====

  wireTimeline(logStream?: BridgeLogStream): void {
    if (logStream) {
      logStream.on('entry', (entry) => {
        this.bridgeTimeline.addEntry(entry);
      });
    }
    this.bridgeTimeline.onEntry((entry, upsert) => {
      const evt: BridgeEvent = { type: 'timeline_event', entry, ...(upsert ? { upsert: true } : {}) };
      this.broadcast(evt);
    });
  }

  // ===== Display monitor =====

  wireDisplayMonitor(): void {
    this.displayMonitor.start();
    this.displayMonitor.on('display_state_changed', (displayOn: boolean) => {
      const evt: BridgeEvent = { type: 'display_state', displayOn };
      this.broadcast(evt);
    });
  }

  // ===== State event building =====

  /**
   * Build a state_update BridgeEvent.
   * Session mode passes full snapshot extras; daemon uses minimal fields.
   */
  buildStateEvent(opts: {
    agentType: AgentType;
    agentCapabilities?: AgentCapabilities;
    snapshot?: StateSnapshot;
  }): BridgeEvent {
    const snapshot = opts.snapshot ?? this.stateMachine.getSnapshot();

    // Compute promptType
    let promptType: 'yes_no' | 'yes_no_always' | 'multi_select' | 'diff_review' | undefined;
    if (snapshot.options.length > 0) {
      promptType = 'multi_select';
      if (snapshot.state === State.AWAITING_PERMISSION) {
        promptType = snapshot.options.length > 2 ? 'yes_no_always' : 'yes_no';
      } else if (snapshot.state === State.AWAITING_DIFF) {
        promptType = 'diff_review';
      }
    }

    return {
      type: 'state_update',
      state: snapshot.state,
      permissionMode: snapshot.permissionMode,
      agentType: opts.agentType,
      agentCapabilities: opts.agentCapabilities,
      currentTool: snapshot.currentTool ?? undefined,
      toolInput: snapshot.toolInput ?? undefined,
      toolProgress: snapshot.toolProgress ?? undefined,
      projectName: snapshot.projectName ?? this.projectName,
      modelName: snapshot.modelName ?? undefined,
      effortLevel: snapshot.effortLevel ?? undefined,
      billingType: snapshot.billingType,
      options: snapshot.options.length > 0 ? snapshot.options : undefined,
      promptType,
      question: snapshot.question ?? undefined,
      navigable: snapshot.navigable || undefined,
      cursorIndex: (snapshot.state === State.AWAITING_OPTION ||
                   snapshot.state === State.AWAITING_PERMISSION ||
                   snapshot.state === State.AWAITING_DIFF)
                   ? snapshot.cursorIndex : undefined,
      suggestedPrompt: snapshot.suggestedPrompt ?? undefined,
      modelCatalog: this.cachedModelCatalog ?? undefined,
      remoteUrl: snapshot.remoteUrl ?? undefined,
      pairingUrl: this.wsUrl,
      ollamaStatus: this.cachedOllamaStatus ?? undefined,
      gatewayAvailable: this.cachedGatewayAvailable,
      gatewayHasError: this.cachedGatewayHasError,
      voiceAssistantState: this.cachedVoiceAssistantState !== 'disabled' ? this.cachedVoiceAssistantState : undefined,
      voiceAssistantText: this.cachedVoiceAssistantText,
      voiceAssistantResponseText: this.cachedVoiceAssistantResponseText,
    };
  }

  /** Update cached voice assistant state and trigger a state broadcast */
  updateVoiceAssistantState(
    vaState: VoiceAssistantState,
    text?: string,
    responseText?: string,
  ): void {
    this.cachedVoiceAssistantState = vaState;
    this.cachedVoiceAssistantText = text;
    this.cachedVoiceAssistantResponseText = responseText;
    // Trigger state_changed so callers rebuild and broadcast state_update
    this.stateMachine.emit('state_changed', this.stateMachine.getSnapshot());
  }

  /** Build and return a usage event */
  buildUsage(): BridgeEvent {
    const snapshot = this.stateMachine.getSnapshot();
    return buildUsageEvent(snapshot, this.cachedApiUsage, this.oauthConnected, this.cachedOllamaStatus, this.apiUsageStale);
  }

  /** Broadcast current usage to all clients */
  broadcastUsage(): void {
    this.broadcast(this.buildUsage());
  }

  // ===== API Usage helpers =====

  /**
   * Update cached API usage and broadcast.
   * Handles billingType inference.
   */
  updateApiUsage(usage: ApiUsageData): void {
    this.cachedApiUsage = usage;
    this.lastApiFetchTime = Date.now();
    this.oauthConnected = true;
    this.apiUsageStale = false;
    if (usage.inferredBillingType) {
      this.stateMachine.inferBillingType(usage.inferredBillingType);
    }
    this.broadcastUsage();
  }

  /** Fetch usage from API and update cache. Returns true if successful. */
  async fetchAndUpdateUsage(): Promise<boolean> {
    const usage = await fetchUsageFromApi();
    if (usage) {
      this.updateApiUsage(usage);
      // Token status check — if expired, mark stale even though we got cached data
      const tokenStatus = getTokenStatus();
      if (tokenStatus === 'expired' || tokenStatus === 'missing') {
        this.apiUsageStale = true;
      }
      return true;
    }
    this.oauthConnected = hasOAuthToken();
    if (this.cachedApiUsage) this.apiUsageStale = true;
    return false;
  }

  /** Fetch usage if cache is stale or empty (best-effort, no throw) */
  async fetchUsageIfStale(): Promise<void> {
    const cacheAge = Date.now() - this.lastApiFetchTime;
    const cacheStale = this.lastApiFetchTime > 0 && cacheAge > 5 * 60 * 1000;
    if (!this.cachedApiUsage || cacheStale) {
      await this.fetchAndUpdateUsage().catch(() => {});
    }
  }

  // ===== Probes =====

  startOllamaProbe(intervalMs = 5000): void {
    this.ollamaProbe.getStatus().then((s) => { this.cachedOllamaStatus = s; }).catch(() => {});
    this.addInterval(setInterval(() => {
      this.ollamaProbe.getStatus().then((s) => { this.cachedOllamaStatus = s; }).catch(() => {});
    }, intervalMs));
  }

  startGatewayProbe(
    intervalMs: number,
    onAppeared?: () => void,
    onDisappeared?: () => void,
  ): void {
    const poll = async () => {
      const status = await probeGateway();
      const wasAvailable = this.cachedGatewayAvailable;
      this.cachedGatewayAvailable = status.available;

      if (status.available && !wasAvailable) {
        onAppeared?.();
      } else if (!status.available && wasAvailable) {
        onDisappeared?.();
      }
      if (status.available !== wasAvailable) {
        this.stateMachine.emit('state_changed', this.stateMachine.getSnapshot());
      }
    };

    poll().catch(() => {});
    this.addInterval(setInterval(() => { poll().catch(() => {}); }, intervalMs));
  }

  startGatewayHealthCheck(intervalMs = 30_000, delayMs = 5000): void {
    const check = () => {
      if (!this.cachedGatewayAvailable) return;
      checkGatewayHealth().then((hasError) => {
        const changed = hasError !== this.cachedGatewayHasError;
        this.cachedGatewayHasError = hasError;
        if (changed) {
          this.stateMachine.emit('state_changed', this.stateMachine.getSnapshot());
        }
      }).catch(() => {});
    };
    this.addTimeout(setTimeout(check, delayMs));
    this.addInterval(setInterval(check, intervalMs));
  }

  // ===== Polling =====

  /**
   * Start periodic usage tick (session timer on displays).
   * Also clears stale cache after USAGE_STALE_TTL.
   */
  startUsageTick(intervalMs = 5000): void {
    this.addInterval(setInterval(() => {
      if (!this.hasClients()) return;
      // TTL: clear stale cache
      if (this.cachedApiUsage && this.lastApiFetchTime > 0 &&
          (Date.now() - this.lastApiFetchTime) > BridgeCore.USAGE_STALE_TTL) {
        debug('core', `API usage cache expired, clearing`);
        this.cachedApiUsage = null;
        this.apiUsageStale = false;
      }
      this.broadcastUsage();
    }, intervalMs));
  }

  /**
   * Start periodic API usage refresh.
   * @param fetchFn Custom fetch function (for daemon relay). Defaults to direct API.
   */
  startApiUsagePolling(intervalMs: number, fetchFn?: () => Promise<ApiUsageData | null>): void {
    const fetch = fetchFn ?? (() => fetchUsageFromApi());
    this.addInterval(setInterval(() => {
      if (!this.hasClients()) return;
      fetch().then((usage) => {
        if (usage) {
          this.updateApiUsage(usage);
        } else {
          this.oauthConnected = hasOAuthToken();
          if (this.cachedApiUsage) this.apiUsageStale = true;
        }
      }).catch(() => {});
    }, intervalMs));
  }

  /** Start periodic sessions_list broadcast */
  startSessionsListPolling(intervalMs = 10_000): void {
    this.addInterval(setInterval(() => {
      if (!this.hasClients()) return;
      this.broadcastSessionsList().catch(() => {});
    }, intervalMs));
  }

  /** Register a callback to enrich the sessions list before broadcast */
  setSessionsEnricher(fn: (sessions: import('./session-aggregator.js').EnrichedSession[]) => import('./session-aggregator.js').EnrichedSession[]): void {
    this.sessionsEnricher = fn;
  }

  /** Register a provider for non-WS client count (e.g., ESP32 serial connections).
   *  Used to keep sessions_list polling alive even without WebSocket clients. */
  setExternalClientCountProvider(fn: () => number): void {
    this.externalClientCount = fn;
  }

  /** Check if any client (WS or external serial) is connected */
  private hasClients(): boolean {
    return this.wsServer.getClientCount() > 0 || this.externalClientCount() > 0;
  }

  /** Broadcast enriched sessions list (debounced 2s from state_changed) */
  async broadcastSessionsList(): Promise<void> {
    const snapshot = this.stateMachine.getSnapshot();
    let sessions = await buildEnrichedSessionsList(this.sessionId, snapshot.state);
    if (this.sessionsEnricher) sessions = this.sessionsEnricher(sessions);
    this.wsServer.broadcast({ type: 'sessions_list', sessions } as BridgeEvent);
  }

  /** Debounced sessions list broadcast (for state_changed handler) */
  maybeBroadcastSessionsList(): void {
    const now = Date.now();
    if (now - this.lastSessionsListBroadcast > 2000 && this.hasClients()) {
      this.lastSessionsListBroadcast = now;
      this.broadcastSessionsList().catch(() => {});
    }
  }

  // ===== Client connect: send initial state =====

  /**
   * Send initial state to a newly connected WebSocket client.
   * Callers can extend by providing extra events to send.
   */
  sendInitialState(
    ws: WebSocket,
    opts: {
      agentType: AgentType;
      agentCapabilities?: AgentCapabilities;
      isAlive: boolean;
      extraEvents?: BridgeEvent[];
    },
  ): void {
    const snapshot = this.stateMachine.getSnapshot();

    // State update (with capabilities for initial connect)
    const stateEvent = this.buildStateEvent({
      agentType: opts.agentType,
      agentCapabilities: opts.agentCapabilities,
      snapshot,
    });
    this.wsServer.sendTo(ws, stateEvent);

    // Usage
    this.wsServer.sendTo(ws, this.buildUsage());

    // Connection
    this.wsServer.sendTo(ws, {
      type: 'connection',
      status: opts.isAlive ? 'connected' : 'disconnected',
      sessionId: this.sessionId,
    } as BridgeEvent);

    // Display state
    this.wsServer.sendTo(ws, {
      type: 'display_state',
      displayOn: this.displayMonitor.isDisplayOn(),
    } as BridgeEvent);

    // Timeline history
    const history = this.bridgeTimeline.getHistory();
    if (history.length > 0) {
      this.wsServer.sendTo(ws, { type: 'timeline_history', entries: history } as BridgeEvent);
    }

    // Sessions list
    buildEnrichedSessionsList(this.sessionId, snapshot.state).then((sessions) => {
      const enriched = this.sessionsEnricher ? this.sessionsEnricher(sessions) : sessions;
      this.wsServer.sendTo(ws, { type: 'sessions_list', sessions: enriched } as BridgeEvent);
    }).catch(() => {});

    // Extra events from caller
    if (opts.extraEvents) {
      for (const evt of opts.extraEvents) {
        this.wsServer.sendTo(ws, evt);
      }
    }

    // Fetch usage if stale
    this.fetchUsageIfStale().catch(() => {});
  }

  // ===== Session registry =====

  registerSession(agentType: AgentType, extra?: Record<string, unknown>): void {
    registerSession({
      id: this.sessionId,
      port: this.port,
      pid: process.pid,
      projectName: this.projectName,
      agentType,
      startedAt: new Date().toISOString(),
      ...extra,
    });
  }

  deregisterSession(): void {
    deregisterSession(this.sessionId);
  }

  // ===== Lifecycle =====

  addInterval(iv: ReturnType<typeof setInterval>): void {
    this.intervals.push(iv);
  }

  addTimeout(to: ReturnType<typeof setTimeout>): void {
    this.timeouts.push(to);
  }

  /** Register a callback to run during shutdown (before process exit). */
  onShutdown(cb: () => void | Promise<void>): void {
    this.shutdownCallbacks.push(cb);
  }

  /** Register process-level signal handlers for graceful shutdown. */
  registerProcessHandlers(label: string): void {
    const handler = () => this.shutdown();

    process.on('SIGINT', handler);
    process.on('SIGTERM', handler);
    process.on('uncaughtException', (err) => {
      // mDNS "already in use" is non-critical
      if (err?.message?.includes('already in use on the network')) {
        log(`[${label}] mDNS conflict (ignored): ${err.message}`);
        return;
      }
      log(`[${label}] Uncaught exception: ${err}`);
      handler();
    });
    process.on('unhandledRejection', (reason) => {
      log(`[${label}] Unhandled rejection: ${reason}`);
      debug('core', `Unhandled rejection stack: ${reason instanceof Error ? reason.stack : reason}`);
      // Non-fatal — don't shutdown
    });
  }

  /** Graceful shutdown */
  async shutdown(): Promise<void> {
    if (this.shutdownInProgress) return;
    this.shutdownInProgress = true;

    log('[core] Shutting down...');

    // Clear all timers
    for (const iv of this.intervals) clearInterval(iv);
    for (const to of this.timeouts) clearTimeout(to);

    // Deregister session
    this.deregisterSession();

    // Stop display monitor
    this.displayMonitor.stop();

    // Run shutdown callbacks (best-effort, 2s total budget)
    const callbacksDone = Promise.all(
      this.shutdownCallbacks.map(cb =>
        Promise.resolve().then(cb).catch(() => {}),
      ),
    );
    await Promise.race([callbacksDone, new Promise(r => setTimeout(r, 2000))]);

    // Close WS
    this.wsServer.close();

    // Exit immediately — all cleanup is done or timed out
    process.exit(0);
  }
}
