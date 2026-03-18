/**
 * AgentDeck Daemon — lightweight monitoring server.
 *
 * No PTY, no voice, no utility. Provides:
 * - WS server for display clients
 * - mDNS advertisement
 * - OpenClaw Gateway proxy
 * - Usage relay (sibling HTTP → WS → direct API)
 * - Pixoo + ADB + Serial device modules
 *
 * Exports `startDaemon()` called by cli.ts.
 */

import { createServer, type Server } from 'http';
import WebSocket from 'ws';
import { BridgeCore } from './bridge-core.js';
import { OpenClawAdapter } from './adapters/openclaw.js';
import { BridgeLogStream } from './log-stream.js';
import { VoiceManager } from './voice.js';
import { VoiceAssistantManager } from './voice-assistant.js';
import {
  listActive as listActiveSessions,
  findAvailablePort,
  findExistingDaemon,
  DAEMON_DEFAULT_PORT,
  probeDaemonHealth,
  writeDaemonInfo,
  removeDaemonInfo,
  readDaemonInfo,
} from './session-registry.js';
import { fetchUsageFromApi, hasOAuthToken, type ApiUsageData } from './usage-api.js';
import { isLocalConnection, validateToken } from './auth.js';
import { getLastFrame, renderPreviewFrame, onFrameRendered, offFrameRendered } from './pixoo/pixoo-bridge.js';
import { rgbToBmp, pixooLiveHtml } from './hook-server.js';
import { enableDebugLog, debug } from './logger.js';
import {
  initModules,
  stopModules,
  createDefaultModules,
} from './modules/index.js';
import { SerialModule } from './modules/serial-module.js';
import { esp32ConnectionCount } from './esp32-serial.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  BRIDGE_WS_PORT,
  OPENCLAW_CAPABILITIES,
  State,
  type BridgeEvent,
  type AdapterEvent,
  type ModelCatalogEntry,
} from './types.js';

function loadDaemonSettings(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(join(homedir(), '.agentdeck', 'settings.json'), 'utf-8'));
  } catch {
    return {};
  }
}

function log(msg: string): void {
  process.stderr.write(msg + '\n');
}

// ===== Usage relay (3-tier) =====

interface RelayedUsage {
  usage: ApiUsageData;
  fetchedAt: number;
}

async function fetchUsageViaHttp(siblings: { port: number }[]): Promise<RelayedUsage | null> {
  for (const sibling of siblings) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`http://127.0.0.1:${sibling.port}/usage`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) continue;
      const data = await res.json() as { status: string; usage: ApiUsageData | null; fetchedAt: number };
      if (!data.usage) continue;
      const age = Date.now() - data.fetchedAt;
      if (age > 5 * 60 * 1000) continue;
      return { usage: data.usage, fetchedAt: data.fetchedAt };
    } catch { /* try next */ }
  }
  return null;
}

async function fetchUsageViaWs(siblings: { port: number }[]): Promise<ApiUsageData | null> {
  for (const sibling of siblings) {
    try {
      const usage = await new Promise<ApiUsageData | null>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${sibling.port}`);
        const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 3000);
        ws.on('message', (raw: Buffer | string) => {
          try {
            const evt = JSON.parse(raw.toString());
            if (evt.type === 'usage_update' && evt.fiveHourPercent != null) {
              clearTimeout(timer);
              ws.close();
              resolve({
                fiveHourPercent: evt.fiveHourPercent ?? null,
                fiveHourResetsAt: evt.fiveHourResetsAt ?? null,
                sevenDayPercent: evt.sevenDayPercent ?? null,
                sevenDayResetsAt: evt.sevenDayResetsAt ?? null,
                extraUsageEnabled: evt.extraUsageEnabled ?? false,
                extraUsageMonthlyLimit: evt.extraUsageMonthlyLimit ?? null,
                extraUsageUsedCredits: evt.extraUsageUsedCredits ?? null,
                extraUsageUtilization: evt.extraUsageUtilization ?? null,
                inferredBillingType: null,
              });
            }
          } catch { /* ignore */ }
        });
        ws.on('error', () => { clearTimeout(timer); reject(new Error('ws error')); });
        ws.on('close', () => { clearTimeout(timer); reject(new Error('ws closed')); });
      });
      if (usage) return usage;
    } catch { /* try next */ }
  }
  return null;
}

async function fetchUsageRelayed(selfPort: number): Promise<ApiUsageData | null> {
  const sessions = listActiveSessions();
  const siblings = sessions.filter(s => s.port !== selfPort && s.agentType !== 'daemon');

  if (siblings.length > 0) {
    const httpResult = await fetchUsageViaHttp(siblings);
    if (httpResult) return httpResult.usage;
    const wsResult = await fetchUsageViaWs(siblings);
    if (wsResult) return wsResult;
    debug('daemon', 'Siblings exist but relay failed — skipping direct API');
    return null;
  }

  debug('daemon', 'No siblings, using direct API');
  return fetchUsageFromApi();
}

// ===== Daemon options =====

export interface DaemonOptions {
  port?: number;
  debug?: boolean;
  wakeWord?: boolean;
}

// ===== startDaemon =====

export async function startDaemon(opts: DaemonOptions): Promise<void> {
  if (opts.debug) {
    enableDebugLog('/tmp/agentdeck-debug.log');
    log('[agentdeck] Debug logging enabled');
  }

  // CLI --wake-word flag OR settings.json wakeWord: true
  const settings = loadDaemonSettings();
  const wakeWordEnabled = opts.wakeWord || settings.wakeWord === true;

  // ===== Singleton guard + port allocation =====
  // 1. Check daemon.json and sessions.json for existing daemon
  const existingInfo = readDaemonInfo();
  if (existingInfo) {
    log(`[agentdeck] Daemon already running on port ${existingInfo.port} (PID ${existingInfo.pid}).`);
    process.exit(0);
  }
  const existingSession = findExistingDaemon();
  if (existingSession) {
    log(`[agentdeck] Daemon already running on port ${existingSession.port} (PID ${existingSession.pid}).`);
    process.exit(0);
  }

  // 2. Determine port — try default first, fallback if occupied by non-daemon
  const requestedPort = opts.port ?? DAEMON_DEFAULT_PORT;
  let port = requestedPort;

  // If using default port, check if it's available
  if (requestedPort === DAEMON_DEFAULT_PORT) {
    const health = await probeDaemonHealth(requestedPort);
    if (health) {
      if (health.mode === 'daemon') {
        // Daemon alive but not in our registry — race condition or stale state
        log(`[agentdeck] Daemon already running on port ${requestedPort} (detected via /health).`);
        process.exit(0);
      }
      // Port occupied by non-daemon (e.g. session bridge) — find alternative
      log(`[agentdeck] Port ${requestedPort} occupied (${health.mode ?? 'unknown'}), finding alternative...`);
      port = await findAvailablePort();
    }
  }

  log(`[agentdeck] Starting daemon on port ${port}...`);

  // ===== HTTP server =====
  const httpServer = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;

    // Health check is public (no auth) — used by iOS/Android for pairing token discovery
    if (req.method === 'GET' && pathname === '/health') {
      const snap = core.stateMachine.getSnapshot();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok', mode: 'daemon', state: snap.state,
        gateway: gatewayAdapter?.isAlive() ? 'connected' : 'disconnected',
        uptime: process.uptime(), port,
        pairingToken: core.authToken,
      }));
      return;
    }
    if (req.method === 'GET' && pathname === '/status') {
      const snap = core.stateMachine.getSnapshot();
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><body>
        <h2>AgentDeck Daemon</h2>
        <p>State: ${snap.state}</p>
        <p>Gateway: ${gatewayAdapter?.isAlive() ? 'connected' : 'disconnected'}</p>
        <p>Uptime: ${Math.floor(process.uptime())}s</p>
        <p>Clients: ${core.wsServer.getClientCount()}</p>
      </body></html>`);
      return;
    }
    if (req.method === 'GET' && pathname === '/pixoo/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      const listener = (frame: Uint8Array) => {
        const bmp = rgbToBmp(frame, 64, 64);
        const b64 = bmp.toString('base64');
        try { res.write(`event: frame\ndata: ${b64}\n\n`); } catch { /* client gone */ }
      };
      onFrameRendered(listener);

      // Send current frame immediately
      const current = getLastFrame() ?? renderPreviewFrame();
      listener(current);

      // Heartbeat
      const heartbeat = setInterval(() => {
        try { res.write(':heartbeat\n\n'); } catch { /* */ }
      }, 30_000);

      req.on('close', () => {
        offFrameRendered(listener);
        clearInterval(heartbeat);
      });
      return;
    }
    if (req.method === 'GET' && pathname === '/pixoo/frame') {
      const rgb = getLastFrame() ?? renderPreviewFrame();
      const bmp = rgbToBmp(rgb, 64, 64);
      res.writeHead(200, {
        'Content-Type': 'image/bmp',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(bmp);
      return;
    }
    if (req.method === 'GET' && pathname === '/pixoo') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(pixooLiveHtml({ projectName: 'AgentDeck' }));
      return;
    }
    if (req.method === 'GET' && pathname === '/sse') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      res.write(`event: connected\ndata: {}\n\n`);
      req.on('close', () => {});
      return;
    }
    if (req.method === 'POST' && pathname === '/shutdown') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'shutting_down' }));
      core.shutdown();
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        // Port was grabbed between our check and bind — find alternative
        reject(new Error(`EADDRINUSE:${port}`));
      } else {
        reject(err);
      }
    });
    httpServer.listen(port, '0.0.0.0', () => resolve());
  }).catch(async (err: Error) => {
    // Handle race condition: port became unavailable after probe
    if (err.message.startsWith('EADDRINUSE:') && port === requestedPort) {
      port = await findAvailablePort();
      log(`[agentdeck] Port ${requestedPort} grabbed, retrying on ${port}...`);
      await new Promise<void>((resolve, reject) => {
        httpServer.on('error', (e: NodeJS.ErrnoException) => reject(e));
        httpServer.listen(port, '0.0.0.0', () => resolve());
      });
    } else {
      throw err;
    }
  });

  // Write daemon.json for client discovery (must be after successful bind)
  writeDaemonInfo({ port, pid: process.pid, startedAt: new Date().toISOString() });

  // ===== BridgeCore =====
  const core = new BridgeCore({
    port,
    projectName: 'AgentDeck',
    httpServer,
  });

  // Timeline
  const bridgeLogStream = new BridgeLogStream();
  core.wireTimeline(bridgeLogStream);
  core.wireDisplayMonitor();

  // mDNS + device modules
  const deviceModules = createDefaultModules('daemon' as any);
  const startedModules = await initModules(
    deviceModules,
    { mdns: true, adb: 'auto', serial: 'auto', pixoo: 'auto' },
    { port, authToken: core.authToken, projectName: 'AgentDeck', wsServer: core.wsServer },
  );

  // Serial module state provider (heartbeat needs cached state)
  let lastStateEvent: BridgeEvent | null = null;
  const serialModule = startedModules.find(m => m.name === 'serial') as SerialModule | undefined;
  if (serialModule) {
    serialModule.setStateProvider(() => lastStateEvent);
    serialModule.setUsageProvider(() => core.buildUsage());
    // Send full state (state + usage + sessions) when new ESP32 device connects
    serialModule.setInitialStateProvider(() => {
      const events: BridgeEvent[] = [];
      if (lastStateEvent) events.push(lastStateEvent);
      events.push(core.buildUsage());
      // Sessions list (async enrichment runs synchronously from cache here)
      core.broadcastSessionsList().catch(() => {});
      return events;
    });
    // Include ESP32 serial connections in client count for polling guards
    core.setExternalClientCountProvider(() => esp32ConnectionCount());
  }

  log(`[agentdeck] WebSocket server ready on port ${port}`);
  log(`[agentdeck] Pairing URL: ${core.wsUrl}`);

  // Register session
  core.registerSession('daemon' as any);

  // ===== Gateway adapter lifecycle =====
  let gatewayAdapter: OpenClawAdapter | null = null;
  let gatewayConnecting = false;

  // Inject OpenClaw virtual session into sessions_list when Gateway is reachable.
  // Uses adapter WS connection when available, falls back to TCP probe so that
  // the session list stays consistent with the terrarium (which uses TCP probe).
  core.setSessionsEnricher((sessions) => {
    const adapterAlive = gatewayAdapter?.isAlive() ?? false;
    if (!adapterAlive && !core.cachedGatewayAvailable) return sessions;
    if (sessions.some(s => s.agentType === 'openclaw')) return sessions;
    const snap = core.stateMachine.getSnapshot();
    return [...sessions, {
      id: 'openclaw-gateway',
      port: 18789,
      projectName: adapterAlive ? (snap.projectName ?? 'OpenClaw') : 'OpenClaw',
      agentType: 'openclaw' as const,
      alive: true,
      state: adapterAlive ? snap.state : 'idle',
    }];
  });

  function connectGatewayAdapter(): void {
    if (gatewayAdapter || gatewayConnecting) return;
    gatewayConnecting = true;
    log('[agentdeck] OpenClaw Gateway detected, connecting...');

    const adapter = new OpenClawAdapter({ autoReconnect: false });

    adapter.on('event', (evt: AdapterEvent) => {
      switch (evt.source) {
        case 'hook':
          if (evt.event === 'SessionStart') core.stateMachine.handleHookEvent('SessionStart', {});
          else if (evt.event === 'SessionEnd') core.stateMachine.handleHookEvent('SessionEnd', {});
          break;
        case 'parser':
          core.stateMachine.handleParserEvent(evt.event, evt.data);
          break;
        case 'metadata':
          if (evt.event === 'model_catalog') {
            const models = evt.data?.models as ModelCatalogEntry[] | undefined;
            if (models) {
              core.cachedModelCatalog = models;
              const snap = core.stateMachine.getSnapshot();
              core.broadcast({
                type: 'state_update', state: snap.state, permissionMode: snap.permissionMode,
                agentType: 'openclaw', modelCatalog: core.cachedModelCatalog,
              } as BridgeEvent);
            }
          } else if (evt.event === 'gateway_health') {
            // Use real-time health event from Gateway WS instead of polling `openclaw doctor`
            const hasError = !(evt.data?.ok as boolean);
            const changed = hasError !== core.cachedGatewayHasError;
            core.cachedGatewayHasError = hasError;
            if (changed) {
              core.stateMachine.emit('state_changed', core.stateMachine.getSnapshot());
            }
          }
          break;
        case 'activity':
          core.stateMachine.onPtyActivity();
          break;
        case 'timeline':
          if (evt.entry) {
            if (evt.upsert) core.bridgeTimeline.upsertEntry(evt.entry);
            else core.bridgeTimeline.addEntry(evt.entry);
            if (evt.entry.type === 'tool_request') bridgeLogStream.trackToolRequest(evt.entry.raw);
          }
          break;
        case 'connection': {
          // Do NOT forward gateway adapter connection events as bridge connection
          // events — WS clients would interpret them as their own bridge disconnect
          // and show "disconnected" UI. Gateway status is conveyed via state_update
          // (agentType/gatewayAvailable) and sessions_list.
          if (evt.status === 'connected') {
            bridgeLogStream.start();
            log('[agentdeck] OpenClaw Gateway connected');
            if (core.stateMachine.getSnapshot().state === 'disconnected') {
              core.stateMachine.handleHookEvent('SessionStart', {});
            }
            // Force full state broadcast
            const snap = core.stateMachine.getSnapshot();
            const gwStateEvent = core.buildStateEvent({
              agentType: 'openclaw',
              agentCapabilities: OPENCLAW_CAPABILITIES,
              snapshot: snap,
            });
            lastStateEvent = gwStateEvent;
            core.wsServer.broadcast(gwStateEvent);
            core.broadcastUsage();
            core.broadcastSessionsList().catch(() => {});
          } else {
            bridgeLogStream.stop();
            log('[agentdeck] OpenClaw Gateway disconnected');
            core.broadcastSessionsList().catch(() => {});
          }
          break;
        }
      }
    });

    adapter.on('exit', () => disconnectGatewayAdapter());

    adapter.start({ port, externalServer: httpServer } as any).then(() => {
      gatewayAdapter = adapter;
      gatewayConnecting = false;
    }).catch((err) => {
      log(`[agentdeck] Failed to connect to Gateway: ${err}`);
      gatewayConnecting = false;
      core.stateMachine.emit('state_changed', core.stateMachine.getSnapshot());
    });
  }

  function disconnectGatewayAdapter(): void {
    if (!gatewayAdapter) return;
    log('[agentdeck] OpenClaw Gateway lost, cleaning up...');
    const wasAlive = gatewayAdapter.isAlive();
    gatewayAdapter.shutdown().catch(() => {});
    gatewayAdapter = null;
    core.cachedModelCatalog = null;
    if (wasAlive) core.stateMachine.handleHookEvent('SessionEnd', {});
    // Do NOT broadcast connection:disconnected — that would make WS clients
    // think they lost their bridge connection. State change to 'daemon' agentType
    // and updated sessions_list convey the gateway loss.
    core.broadcastSessionsList().catch(() => {});
  }

  // ===== Voice assistant (wake word) =====
  let voiceAssistant: VoiceAssistantManager | null = null;
  let voiceManager: VoiceManager | null = null;
  let previousDaemonState = State.IDLE;

  if (wakeWordEnabled) {
    voiceManager = new VoiceManager();
    voiceManager.connectToServer().catch((err) => {
      debug('daemon', `whisper-server connection failed: ${err}`);
    });

    voiceAssistant = new VoiceAssistantManager({
      sendPrompt: (text) => {
        if (gatewayAdapter?.isAlive() && gatewayAdapter.handleCommand({ type: 'send_prompt', text })) {
          core.stateMachine.handleUserAction('send_prompt');
        } else {
          debug('daemon', 'Wake word prompt but no active adapter');
        }
      },
      transcribeFile: (filePath) => voiceManager!.transcribeFile(filePath),
    });

    voiceAssistant.on('state_change', (info: { state: string; text?: string; responseText?: string }) => {
      // Broadcast dedicated event (for plugin FORWARDED_EVENTS)
      core.broadcast({
        type: 'voice_assistant_state',
        state: info.state,
        deviceId: 'mac-builtin',
        text: info.text,
        responseText: info.responseText,
      } as BridgeEvent);
      // Piggyback on state_update so all clients (Android/Apple/TUI) get it automatically
      core.updateVoiceAssistantState(
        info.state as import('@agentdeck/shared').VoiceAssistantState,
        info.text,
        info.responseText,
      );
    });

    voiceAssistant.on('wake_word_detected', (info: { deviceId: string; timestamp: number }) => {
      core.broadcast({
        type: 'wake_word_detected',
        deviceId: info.deviceId,
        timestamp: info.timestamp,
      } as BridgeEvent);
    });

    voiceAssistant.start().then((ok) => {
      if (ok) log('[agentdeck] Wake word voice assistant active ("오픈클로")');
      else log('[agentdeck] Wake word not available (missing model or access key)');
    }).catch((err) => {
      log(`[agentdeck] Wake word start failed: ${err}`);
    });
  }

  // ===== State changed → broadcast =====
  core.stateMachine.on('state_changed', (snapshot) => {
    const gwAlive = gatewayAdapter?.isAlive() ?? false;
    const stateEvent = core.buildStateEvent({
      agentType: gwAlive ? 'openclaw' : 'daemon' as any,
      agentCapabilities: gwAlive ? OPENCLAW_CAPABILITIES : undefined,
      snapshot,
    });
    lastStateEvent = stateEvent;
    core.wsServer.broadcast(stateEvent);
    core.maybeBroadcastSessionsList();
    core.broadcastUsage();

    // Voice assistant: reset timeout on any activity during processing
    if (snapshot.state === State.PROCESSING && voiceAssistant?.getState() === 'processing') {
      voiceAssistant.resetResponseTimeout();
    }

    // Voice assistant: PROCESSING→IDLE triggers TTS response
    const wasActive = previousDaemonState === State.PROCESSING;
    previousDaemonState = snapshot.state;
    if (wasActive && snapshot.state === State.IDLE && voiceAssistant?.getState() === 'processing') {
      const lastEntry = core.bridgeTimeline.getLastEntry('chat_end');
      const responseText = lastEntry?.detail ?? lastEntry?.raw ?? '';
      voiceAssistant.handleResponse(responseText || '완료했습니다.').catch((err) => {
        debug('daemon', `Voice assistant TTS error: ${err}`);
      });
    }
  });

  // ===== Commands from WS clients =====
  core.wsServer.onCommand((cmd) => {
    debug('daemon', `cmd: ${cmd.type}`);
    if (gatewayAdapter?.isAlive() && gatewayAdapter.handleCommand(cmd)) {
      switch (cmd.type) {
        case 'respond': core.stateMachine.handleUserAction('respond'); break;
        case 'interrupt': core.stateMachine.handleUserAction('interrupt'); break;
        case 'escape': core.stateMachine.handleUserAction('interrupt'); break;
        case 'select_option': core.stateMachine.handleUserAction('select_option'); break;
        case 'send_prompt': core.stateMachine.handleUserAction('send_prompt'); break;
      }
      return;
    }
    if (cmd.type === 'query_usage') {
      fetchUsageRelayed(port).then((usage) => {
        if (usage) core.updateApiUsage(usage);
        else if (core.cachedApiUsage) core.apiUsageStale = true;
      });
    }
  });

  // ===== Client connect =====
  core.wsServer.onClientConnect((ws) => {
    const gwAlive = gatewayAdapter?.isAlive() ?? false;
    core.sendInitialState(ws, {
      agentType: gwAlive ? 'openclaw' : 'daemon' as any,
      agentCapabilities: gwAlive ? OPENCLAW_CAPABILITIES : undefined,
      isAlive: true,  // WS client IS connected to daemon — gateway status conveyed via state_update
    });

    // Fetch usage on connect if stale
    const cacheAge = Date.now() - core.lastApiFetchTime;
    if (!core.cachedApiUsage || (core.lastApiFetchTime > 0 && cacheAge > 5 * 60 * 1000)) {
      fetchUsageRelayed(port).then((usage) => {
        if (usage) core.updateApiUsage(usage);
        else {
          core.oauthConnected = hasOAuthToken();
          if (core.cachedApiUsage) core.apiUsageStale = true;
        }
      });
    }
  });

  // ===== Probes & polling =====
  core.startOllamaProbe();
  core.startGatewayProbe(5000,
    () => connectGatewayAdapter(),
    () => { if (gatewayAdapter && !gatewayAdapter.isAlive()) disconnectGatewayAdapter(); },
  );
  core.startGatewayHealthCheck();
  core.startUsageTick();
  core.startApiUsagePolling(60_000, () => fetchUsageRelayed(port));
  core.startSessionsListPolling();

  // Initial usage fetch (delayed 10s)
  core.addTimeout(setTimeout(() => {
    fetchUsageRelayed(port).then((usage) => {
      if (usage) core.updateApiUsage(usage);
      else {
        core.oauthConnected = hasOAuthToken();
        if (core.cachedApiUsage) core.apiUsageStale = true;
      }
    });
  }, 10_000));

  // ===== Shutdown =====
  core.onShutdown(async () => {
    removeDaemonInfo();
    voiceAssistant?.stop();
    voiceManager?.disconnectFromServer();
    bridgeLogStream.stop();
    if (gatewayAdapter) {
      await gatewayAdapter.shutdown().catch(() => {});
      gatewayAdapter = null;
    }
    await stopModules(startedModules);
    httpServer.close(() => process.exit(0));
  });

  core.registerProcessHandlers('agentdeck');

  log(`[agentdeck] Daemon running. Gateway probe active.`);
}
