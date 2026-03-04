import { createServer, type Server } from 'http';
import { randomUUID } from 'crypto';
import { UsageTracker } from './usage-tracker.js';
import { StateMachine } from './state-machine.js';
import { WsServer } from './ws-server.js';
import { OllamaProbe, type OllamaStatus } from './ollama-probe.js';
import { probeGateway } from './gateway-probe.js';
import { fetchUsageFromApi, hasOAuthToken, type ApiUsageData } from './usage-api.js';
import { advertiseBridge } from './mdns.js';
import { getOrCreateToken, getWsUrl } from './auth.js';
import { isLocalConnection, validateToken } from './auth.js';
import { buildEnrichedSessionsList } from './session-aggregator.js';
import { OpenClawAdapter } from './adapters/openclaw.js';
import {
  register as registerSession,
  deregister as deregisterSession,
  findAvailablePort,
} from './session-registry.js';
import {
  BRIDGE_WS_PORT,
  OPENCLAW_CAPABILITIES,
  State,
  type BridgeEvent,
  type StateSnapshot,
  type AdapterEvent,
  type PluginCommand,
  type ModelCatalogEntry,
} from './types.js';
import { DisplayMonitor } from './display-monitor.js';
import { enableDebugLog, debug } from './logger.js';

function log(msg: string): void {
  process.stderr.write(msg + '\n');
}

export interface DaemonOptions {
  port?: number;
  debug?: boolean;
}

export async function startDaemon(opts: DaemonOptions): Promise<void> {
  if (opts.debug) {
    enableDebugLog('/tmp/agentdeck-debug.log');
    log('[agentdeck] Debug logging enabled → /tmp/agentdeck-debug.log');
  }

  const requestedPort = opts.port ?? BRIDGE_WS_PORT;
  const port = requestedPort === BRIDGE_WS_PORT
    ? await findAvailablePort()
    : requestedPort;
  if (port !== requestedPort) {
    log(`[agentdeck] Port ${requestedPort} in use, using ${port}`);
  }

  const sessionId = randomUUID();
  const projectName = 'AgentDeck';

  log(`[agentdeck] Starting daemon on port ${port}...`);

  // State tracking
  let cachedApiUsage: ApiUsageData | null = null;
  let lastApiFetchTime = 0;
  let oauthConnected = hasOAuthToken();
  let cachedOllamaStatus: OllamaStatus | null = null;
  let cachedGatewayAvailable = false;
  let cachedModelCatalog: ModelCatalogEntry[] | null = null;

  // Core components (no PTY, no voice)
  const usageTracker = new UsageTracker();
  const stateMachine = new StateMachine(usageTracker);
  const ollamaProbe = new OllamaProbe();
  const displayMonitor = new DisplayMonitor();

  // Gateway adapter (dynamically created when Gateway is detected)
  let gatewayAdapter: OpenClawAdapter | null = null;
  let gatewayConnecting = false;

  // HTTP server
  const httpServer = createServer((req, res) => {
    // Token auth for remote requests
    const remoteIp = req.socket.remoteAddress || '';
    const needsAuth = !isLocalConnection(remoteIp);

    if (needsAuth) {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const token = url.searchParams.get('token') || '';
      if (!validateToken(token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    if (req.method === 'GET' && req.url === '/health') {
      const snap = stateMachine.getSnapshot();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        mode: 'daemon',
        state: snap.state,
        gateway: gatewayAdapter?.isAlive() ? 'connected' : 'disconnected',
        uptime: process.uptime(),
        port,
      }));
      return;
    }

    if (req.method === 'GET' && req.url === '/status') {
      const snap = stateMachine.getSnapshot();
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><body>
        <h2>AgentDeck Daemon</h2>
        <p>State: ${snap.state}</p>
        <p>Gateway: ${gatewayAdapter?.isAlive() ? 'connected' : 'disconnected'}</p>
        <p>Uptime: ${Math.floor(process.uptime())}s</p>
        <p>Clients: ${wsServer?.getClientCount() ?? 0}</p>
      </body></html>`);
      return;
    }

    if (req.method === 'GET' && req.url === '/sse') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(`event: connected\ndata: {}\n\n`);
      // SSE clients get state updates via WS broadcast (simplified — daemon uses WS primarily)
      req.on('close', () => { /* client disconnected */ });
      return;
    }

    if (req.method === 'POST' && req.url === '/shutdown') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'shutting_down' }));
      shutdown();
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  // Start HTTP server
  await new Promise<void>((resolve, reject) => {
    httpServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use.`));
      } else {
        reject(err);
      }
    });
    httpServer.listen(port, '0.0.0.0', () => {
      debug('daemon', `HTTP server listening on 0.0.0.0:${port}`);
      resolve();
    });
  });

  // WebSocket server
  const wsServer = new WsServer(httpServer);
  log(`[agentdeck] WebSocket server ready on port ${port}`);

  // Auth token + mDNS
  const authToken = getOrCreateToken();
  const wsUrl = getWsUrl(port);
  const mdnsCleanup = advertiseBridge(port, projectName, 'daemon' as any, authToken);
  log(`[agentdeck] Pairing URL: ${wsUrl}`);

  // Register session
  registerSession({
    id: sessionId,
    port,
    pid: process.pid,
    projectName,
    agentType: 'daemon',
    startedAt: new Date().toISOString(),
  });

  // Debounce tracker for sessions_list on state_changed
  let lastSessionsListBroadcast = 0;

  // Display monitor → WS broadcast
  displayMonitor.start();
  displayMonitor.on('display_state_changed', (displayOn: boolean) => {
    const evt: BridgeEvent = { type: 'display_state', displayOn };
    wsServer.broadcast(evt);
  });

  // Wire StateMachine → WS broadcast
  stateMachine.on('state_changed', (snapshot: StateSnapshot) => {
    const gwAlive = gatewayAdapter?.isAlive() ?? false;
    const stateEvent: BridgeEvent = {
      type: 'state_update',
      state: snapshot.state,
      permissionMode: snapshot.permissionMode,
      agentType: gwAlive ? 'openclaw' : 'daemon' as any,
      agentCapabilities: gwAlive ? OPENCLAW_CAPABILITIES : undefined,
      projectName: snapshot.projectName ?? projectName,
      modelName: snapshot.modelName ?? undefined,
      billingType: snapshot.billingType,
      options: snapshot.options.length > 0 ? snapshot.options : undefined,
      modelCatalog: cachedModelCatalog ?? undefined,
      pairingUrl: wsUrl,
      ollamaStatus: cachedOllamaStatus ?? undefined,
    };
    wsServer.broadcast(stateEvent);

    // Trigger sessions_list refresh on state change (debounced 2s)
    const now = Date.now();
    if (now - lastSessionsListBroadcast > 2000 && wsServer.getClientCount() > 0) {
      lastSessionsListBroadcast = now;
      buildEnrichedSessionsList(sessionId, snapshot.state).then((sessions) => {
        wsServer.broadcast({ type: 'sessions_list', sessions } as BridgeEvent);
      });
    }

    const usageEvt = buildUsageEvent(snapshot, cachedApiUsage, oauthConnected);
    wsServer.broadcast(usageEvt);
  });

  // Handle commands from WS clients
  wsServer.onCommand((cmd: PluginCommand) => {
    debug('daemon', `cmd: ${cmd.type}`);

    // Forward commands to gateway adapter if alive
    if (gatewayAdapter?.isAlive() && gatewayAdapter.handleCommand(cmd)) {
      switch (cmd.type) {
        case 'respond':
          stateMachine.handleUserAction('respond');
          break;
        case 'interrupt':
          stateMachine.handleUserAction('interrupt');
          break;
        case 'escape':
          stateMachine.handleUserAction('interrupt');
          break;
        case 'select_option':
          stateMachine.handleUserAction('select_option');
          break;
        case 'send_prompt':
          stateMachine.handleUserAction('send_prompt');
          break;
      }
      return;
    }

    // Daemon-specific commands
    if (cmd.type === 'query_usage') {
      fetchUsageFromApi().then((apiUsage) => {
        if (apiUsage) {
          cachedApiUsage = apiUsage;
          lastApiFetchTime = Date.now();
          if (apiUsage.inferredBillingType) {
            stateMachine.inferBillingType(apiUsage.inferredBillingType);
          }
        }
        const snapshot = stateMachine.getSnapshot();
        wsServer.broadcast(buildUsageEvent(snapshot, cachedApiUsage, oauthConnected));
      });
    }
  });

  // Client connect → send initial state
  wsServer.onClientConnect((ws) => {
    const snapshot = stateMachine.getSnapshot();
    const gwAlive = gatewayAdapter?.isAlive() ?? false;

    const stateEvent: BridgeEvent = {
      type: 'state_update',
      state: snapshot.state,
      permissionMode: snapshot.permissionMode,
      agentType: gwAlive ? 'openclaw' : 'daemon' as any,
      agentCapabilities: gwAlive ? OPENCLAW_CAPABILITIES : undefined,
      projectName: snapshot.projectName ?? projectName,
      modelName: snapshot.modelName ?? undefined,
      billingType: snapshot.billingType,
      options: snapshot.options.length > 0 ? snapshot.options : undefined,
      modelCatalog: cachedModelCatalog ?? undefined,
      pairingUrl: wsUrl,
      ollamaStatus: cachedOllamaStatus ?? undefined,
    };
    wsServer.sendTo(ws, stateEvent);
    wsServer.sendTo(ws, buildUsageEvent(snapshot, cachedApiUsage, oauthConnected));

    const connEvt: BridgeEvent = {
      type: 'connection',
      status: gatewayAdapter?.isAlive() ? 'connected' : 'disconnected',
      sessionId,
    };
    wsServer.sendTo(ws, connEvt);

    // Display state
    wsServer.sendTo(ws, { type: 'display_state', displayOn: displayMonitor.isDisplayOn() } as BridgeEvent);

    // Sessions list
    buildEnrichedSessionsList(sessionId, snapshot.state).then((sessions) => {
      wsServer.sendTo(ws, { type: 'sessions_list', sessions } as BridgeEvent);
    });

    // Fetch API usage on connect if stale
    const cacheAge = Date.now() - lastApiFetchTime;
    const cacheStale = lastApiFetchTime > 0 && cacheAge > 5 * 60 * 1000;
    if (!cachedApiUsage || cacheStale) {
      fetchUsageFromApi().then((apiUsage) => {
        if (apiUsage) {
          cachedApiUsage = apiUsage;
          lastApiFetchTime = Date.now();
          oauthConnected = true;
          if (apiUsage.inferredBillingType) {
            stateMachine.inferBillingType(apiUsage.inferredBillingType);
          }
          const snap2 = stateMachine.getSnapshot();
          wsServer.broadcast(buildUsageEvent(snap2, cachedApiUsage, oauthConnected));
        } else {
          oauthConnected = hasOAuthToken();
        }
      });
    }
  });

  // ===== Probes =====

  // Ollama probe (5s)
  const ollamaInterval = setInterval(() => {
    ollamaProbe.getStatus().then((status) => {
      cachedOllamaStatus = status;
    });
  }, 5000);
  ollamaProbe.getStatus().then((status) => { cachedOllamaStatus = status; });

  // Gateway probe (5s) — dynamic adapter creation
  const gatewayInterval = setInterval(async () => {
    const status = await probeGateway();
    const wasAvailable = cachedGatewayAvailable;
    cachedGatewayAvailable = status.available;

    if (status.available && !wasAvailable && !gatewayAdapter && !gatewayConnecting) {
      // Gateway appeared — create adapter
      connectGatewayAdapter();
    } else if (!status.available && wasAvailable && gatewayAdapter) {
      // Gateway disappeared — only cleanup if adapter is also dead
      // (it may have already reconnected on its own before probe detected the gap)
      if (!gatewayAdapter.isAlive()) {
        disconnectGatewayAdapter();
      }
    }
  }, 5000);
  // Initial probe
  probeGateway().then((status) => {
    cachedGatewayAvailable = status.available;
    if (status.available) {
      connectGatewayAdapter();
    }
  });

  // Usage update (5s tick for session timer)
  const usageInterval = setInterval(() => {
    if (wsServer.getClientCount() > 0) {
      const snapshot = stateMachine.getSnapshot();
      wsServer.broadcast(buildUsageEvent(snapshot, cachedApiUsage, oauthConnected));
    }
  }, 5000);

  // API usage refresh (60s)
  const apiUsageInterval = setInterval(() => {
    if (wsServer.getClientCount() > 0) {
      fetchUsageFromApi().then((apiUsage) => {
        if (apiUsage) {
          cachedApiUsage = apiUsage;
          lastApiFetchTime = Date.now();
          oauthConnected = true;
          if (apiUsage.inferredBillingType) {
            stateMachine.inferBillingType(apiUsage.inferredBillingType);
          }
          const snapshot = stateMachine.getSnapshot();
          wsServer.broadcast(buildUsageEvent(snapshot, cachedApiUsage, oauthConnected));
        } else {
          oauthConnected = hasOAuthToken();
        }
      });
    }
  }, 60_000);

  // Sessions list broadcast (10s)
  const sessionsListInterval = setInterval(() => {
    if (wsServer.getClientCount() > 0) {
      const snapshot = stateMachine.getSnapshot();
      buildEnrichedSessionsList(sessionId, snapshot.state).then((sessions) => {
        wsServer.broadcast({ type: 'sessions_list', sessions } as BridgeEvent);
      });
    }
  }, 10_000);

  // ===== Gateway Adapter Lifecycle =====

  function connectGatewayAdapter(): void {
    if (gatewayAdapter || gatewayConnecting) return;
    gatewayConnecting = true;

    log('[agentdeck] OpenClaw Gateway detected, connecting...');
    const adapter = new OpenClawAdapter({ autoReconnect: false });

    // Wire adapter events → StateMachine
    adapter.on('event', (evt: AdapterEvent) => {
      switch (evt.source) {
        case 'hook':
          if (evt.event === 'SessionStart') {
            stateMachine.handleHookEvent('SessionStart', {});
          } else if (evt.event === 'SessionEnd') {
            stateMachine.handleHookEvent('SessionEnd', {});
          }
          break;
        case 'parser':
          stateMachine.handleParserEvent(evt.event, evt.data);
          break;
        case 'metadata':
          if (evt.event === 'model_catalog') {
            const models = evt.data?.models as ModelCatalogEntry[] | undefined;
            if (models) {
              cachedModelCatalog = models;
              debug('daemon', `Model catalog updated: ${models.length} models`);
              const snap = stateMachine.getSnapshot();
              wsServer.broadcast({
                type: 'state_update',
                state: snap.state,
                permissionMode: snap.permissionMode,
                agentType: 'openclaw',
                modelCatalog: cachedModelCatalog,
              } as BridgeEvent);
            }
          }
          break;
        case 'activity':
          stateMachine.onPtyActivity();
          break;
        case 'connection': {
          const connEvt: BridgeEvent = { type: 'connection', status: evt.status };
          wsServer.broadcast(connEvt);
          if (evt.status === 'connected') {
            log('[agentdeck] OpenClaw Gateway connected');
            // Force full state_update — StateMachine may not transition if already IDLE
            const snap = stateMachine.getSnapshot();
            wsServer.broadcast({
              type: 'state_update',
              state: snap.state,
              permissionMode: snap.permissionMode,
              agentType: 'openclaw',
              agentCapabilities: OPENCLAW_CAPABILITIES,
              projectName: snap.projectName ?? projectName,
              modelName: snap.modelName ?? undefined,
              billingType: snap.billingType,
              options: snap.options.length > 0 ? snap.options : undefined,
              modelCatalog: cachedModelCatalog ?? undefined,
              pairingUrl: wsUrl,
              ollamaStatus: cachedOllamaStatus ?? undefined,
            } as BridgeEvent);
            wsServer.broadcast(buildUsageEvent(snap, cachedApiUsage, oauthConnected));
          } else {
            log('[agentdeck] OpenClaw Gateway disconnected');
          }
          break;
        }
      }
    });

    adapter.on('exit', () => {
      disconnectGatewayAdapter();
    });

    // Start adapter with external server (no new HTTP server)
    adapter.start({ port, externalServer: httpServer }).then(() => {
      gatewayAdapter = adapter;
      gatewayConnecting = false;
      debug('daemon', 'OpenClaw adapter started');
    }).catch((err) => {
      log(`[agentdeck] Failed to connect to Gateway: ${err}`);
      gatewayConnecting = false;
    });
  }

  function disconnectGatewayAdapter(): void {
    if (!gatewayAdapter) return;
    log('[agentdeck] OpenClaw Gateway lost, cleaning up adapter...');

    const wasAlive = gatewayAdapter.isAlive();
    gatewayAdapter.shutdown().catch(() => {});
    gatewayAdapter = null;
    cachedModelCatalog = null;

    // Only emit SessionEnd if adapter was still alive (hasn't already emitted its own via ws.close)
    if (wasAlive) {
      stateMachine.handleHookEvent('SessionEnd', {});
    }
    // Always broadcast disconnected to ensure clients are notified
    wsServer.broadcast({ type: 'connection', status: 'disconnected' } as BridgeEvent);
  }

  // ===== Shutdown =====

  let shutdownInProgress = false;

  function shutdown(): void {
    if (shutdownInProgress) return;
    shutdownInProgress = true;

    log('[agentdeck] Shutting down...');
    clearInterval(usageInterval);
    clearInterval(apiUsageInterval);
    clearInterval(ollamaInterval);
    clearInterval(gatewayInterval);
    clearInterval(sessionsListInterval);
    displayMonitor.stop();
    deregisterSession(sessionId);
    mdnsCleanup();

    if (gatewayAdapter) {
      gatewayAdapter.shutdown().catch(() => {});
      gatewayAdapter = null;
    }

    wsServer.close();
    httpServer.close(() => {
      process.exit(0);
    });

    setTimeout(() => {
      process.exit(1);
    }, 3000);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('uncaughtException', (err) => {
    log(`[agentdeck] Uncaught exception: ${err}`);
    shutdown();
  });
  process.on('unhandledRejection', (reason) => {
    log(`[agentdeck] Unhandled rejection: ${reason}`);
    shutdown();
  });

  log(`[agentdeck] Daemon running. Gateway probe active.`);
}

function buildUsageEvent(snapshot: StateSnapshot, apiUsage?: ApiUsageData | null, oauthStatus?: boolean): BridgeEvent {
  return {
    type: 'usage_update',
    sessionDurationSec: snapshot.sessionDurationSec,
    inputTokens: snapshot.inputTokens,
    outputTokens: snapshot.outputTokens,
    toolCalls: snapshot.toolCalls,
    estimatedCostUsd: snapshot.estimatedCostUsd ?? undefined,
    sessionPercent: snapshot.sessionPercent ?? undefined,
    costSpent: snapshot.costSpent ?? undefined,
    costLimit: snapshot.costLimit ?? undefined,
    resetTime: snapshot.resetTime ?? undefined,
    resetDate: snapshot.resetDate ?? undefined,
    fiveHourPercent: apiUsage?.fiveHourPercent ?? undefined,
    fiveHourResetsAt: apiUsage?.fiveHourResetsAt ?? undefined,
    sevenDayPercent: apiUsage?.sevenDayPercent ?? undefined,
    sevenDayResetsAt: apiUsage?.sevenDayResetsAt ?? undefined,
    extraUsageEnabled: apiUsage?.extraUsageEnabled ?? undefined,
    extraUsageMonthlyLimit: apiUsage?.extraUsageMonthlyLimit ?? undefined,
    extraUsageUsedCredits: apiUsage?.extraUsageUsedCredits ?? undefined,
    extraUsageUtilization: apiUsage?.extraUsageUtilization ?? undefined,
    oauthConnected: oauthStatus,
  };
}
