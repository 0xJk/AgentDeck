#!/usr/bin/env node

import { Command } from 'commander';
import { UsageTracker } from './usage-tracker.js';
import { StateMachine } from './state-machine.js';
import { WsServer } from './ws-server.js';
import { VoiceManager } from './voice.js';
import { checkDependencies } from './check-deps.js';
import { enableDebugLog, debug } from './logger.js';
import { EventJournal } from './event-journal.js';
import { PtyRingBuffer } from './pty-ringbuffer.js';
import { createDiagDump } from './diag-analyzer.js';
import { DisplayMonitor } from './display-monitor.js';
import { createAdapter } from './adapters/index.js';
import { ClaudeCodeAdapter } from './adapters/claude-code.js';
import {
  BRIDGE_WS_PORT,
  State,
  type PluginCommand,
  type BridgeEvent,
  type StateSnapshot,
  type AdapterEvent,
  type AgentType,
  type ModelCatalogEntry,
  type EncoderSlotState,
  type EncoderStateEvent,
  type DeckSlotMapEvent,
  type UtilityCommand,
} from './types.js';
import { UtilityProxy } from './utility-proxy.js';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import {
  register as registerSession,
  deregister as deregisterSession,
  listActive as listActiveSessions,
  findAvailablePort,
  detectTmuxSession,
} from './session-registry.js';
import { fetchUsageFromApi, hasOAuthToken, type ApiUsageData } from './usage-api.js';
import { OllamaProbe, type OllamaStatus } from './ollama-probe.js';
import { probeGateway } from './gateway-probe.js';

import { getOrCreateToken, getWsUrl } from './auth.js';
import { buildEnrichedSessionsList } from './session-aggregator.js';
import type { HookServer } from './hook-server.js';

// Load prompt templates
interface PromptTemplate {
  label: string;
  prompt: string;
}

function loadTemplates(): PromptTemplate[] {
  try {
    // Try multiple locations: relative to bridge, project root, etc.
    const candidates = [
      resolve(dirname(fileURLToPath(import.meta.url)), '../../config/prompt-templates.json'),
      resolve(process.cwd(), 'config/prompt-templates.json'),
    ];
    for (const p of candidates) {
      try {
        const data = JSON.parse(readFileSync(p, 'utf-8'));
        if (Array.isArray(data?.templates)) {
          debug('sdc', `Loaded ${data.templates.length} templates from ${p}`);
          return data.templates;
        }
      } catch {
        // try next
      }
    }
  } catch {
    // ignore
  }
  return [];
}

const promptTemplates = loadTemplates();

// All bridge logging goes to stderr so it doesn't interfere with PTY stdout
function log(msg: string): void {
  process.stderr.write(msg + '\n');
}

const program = new Command();

program
  .name('sdc')
  .description('AgentDeck bridge server')
  .version('0.1.0');

// Default command: start bridge + spawn claude + attach terminal
program
  .command('start', { isDefault: true })
  .description('Start bridge server and spawn agent CLI')
  .option('-p, --port <port>', 'Bridge server port', String(BRIDGE_WS_PORT))
  .option('-c, --command <cmd>', 'Command to spawn', 'claude')
  .option('-a, --agent <type>', 'Agent type (claude-code|openclaw)', 'claude-code')
  .option('-g, --gateway <url>', 'OpenClaw gateway WebSocket URL')
  .option('-d, --debug', 'Enable debug logging to /tmp/sdc-debug.log')
  .action(async (opts) => {
    if (opts.debug) {
      enableDebugLog();
      log('[sdc] Debug logging enabled → /tmp/sdc-debug.log');
    }
    const port = parseInt(opts.port, 10);
    const agentType = opts.agent as AgentType;
    await startBridge(port, opts.command, agentType, opts.gateway);
  });

program
  .command('attach')
  .description('Attach to an existing bridge session')
  .option('-p, --port <port>', 'Bridge server port', String(BRIDGE_WS_PORT))
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    log(`Attaching to bridge on port ${port}...`);
    log('Attach mode not yet implemented');
    process.exit(1);
  });

program
  .command('status')
  .description('Show bridge and session status')
  .option('-p, --port <port>', 'Bridge server port', String(BRIDGE_WS_PORT))
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      const data = await res.json() as Record<string, unknown>;
      log(`Bridge status: ${JSON.stringify(data, null, 2)}`);
    } catch {
      log('Bridge is not running');
      process.exit(1);
    }
  });

program
  .command('stop')
  .description('Stop the bridge and session')
  .option('-p, --port <port>', 'Bridge server port', String(BRIDGE_WS_PORT))
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    try {
      await fetch(`http://127.0.0.1:${port}/hooks/shutdown`, { method: 'POST' });
      log('Shutdown signal sent');
    } catch {
      log('Bridge is not running');
    }
  });

program
  .command('qr')
  .description('Show pairing URL and QR code for remote clients')
  .option('-p, --port <port>', 'Bridge server port (auto-detects from running sessions)')
  .action(async (opts) => {
    const { getOrCreateToken, getWsUrl } = await import('./auth.js');
    const { listActive } = await import('./session-registry.js');

    // Determine port: explicit flag > running session > default
    let port: number;
    if (opts.port) {
      port = parseInt(opts.port, 10);
    } else {
      const sessions = listActive();
      if (sessions.length > 0) {
        port = sessions[0].port;
        if (sessions.length > 1) {
          log(`Multiple sessions running. Using port ${port} (${sessions[0].projectName}).`);
          log(`Specify --port to target a different session.`);
        }
      } else {
        port = BRIDGE_WS_PORT;
      }
    }

    getOrCreateToken();
    const url = getWsUrl(port);
    log(`\nPairing URL:\n  ${url}\n`);

    // Generate text QR in terminal using qrcode lib (if available)
    try {
      const { default: QRCode } = await import('qrcode');
      const text = await (QRCode as any).toString(url, { type: 'terminal', small: true });
      log(text);
    } catch {
      // qrcode not available in bridge — URL is sufficient
    }
  });

program
  .command('diag')
  .description('Generate diagnostic dump and optionally run AI analysis')
  .option('-p, --port <port>', 'Bridge server port', String(BRIDGE_WS_PORT))
  .option('-a, --analyze', 'Run AI analysis on the dump')
  .option('-t, --tail <lines>', 'Number of journal entries to include', '200')
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    const tail = parseInt(opts.tail, 10);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/diag?tail=${tail}`);
      if (!res.ok) {
        log(`Diag endpoint error: ${res.status} ${res.statusText}`);
        process.exit(1);
      }
      const dump = await res.json() as import('./diag-analyzer.js').DiagDump;

      // Save dump to disk
      const { saveDiagDump, analyzeDump } = await import('./diag-analyzer.js');
      const dumpPath = saveDiagDump(dump);
      log(`Diagnostic dump saved: ${dumpPath}`);

      if (opts.analyze) {
        log('Running AI analysis...');
        const analysis = await analyzeDump(dumpPath);
        if (analysis) {
          log('\n--- AI Analysis ---\n');
          log(analysis);
        } else {
          log('AI analysis failed (is `claude` CLI available?)');
        }
      }
    } catch {
      log('Bridge is not running. Cannot generate live diagnostic dump.');
      process.exit(1);
    }
  });

program.parse();

async function startBridge(port: number, command: string, agentType: AgentType, gatewayUrl?: string): Promise<void> {
  const deps = checkDependencies();
  if (!deps.ok) {
    process.exit(1);
  }
  for (const w of deps.warnings) {
    log(`[sdc] WARNING: ${w}`);
  }

  // Multi-session: find available port if default is taken
  const actualPort = port === BRIDGE_WS_PORT ? await findAvailablePort() : port;
  if (actualPort !== port) {
    log(`[sdc] Port ${port} in use, using ${actualPort}`);
  }
  port = actualPort;

  // Auto-migrate old-format hooks (hardcoded port → env var)
  migrateHooksIfNeeded();

  const sessionId = randomUUID();
  const tmuxSession = detectTmuxSession();
  const parentTty = (() => {
    try { return execSync('tty', { stdio: ['inherit', 'pipe', 'pipe'] }).toString().trim(); }
    catch { return undefined; }
  })();
  const projectName = process.cwd().split('/').pop() || 'unknown';

  // Warn if same project is already running in another session
  const existingSessions = listActiveSessions();
  const sameProject = existingSessions.filter((s) => s.projectName === projectName);
  if (sameProject.length > 0) {
    const ports = sameProject.map((s) => s.port).join(', ');
    log(`[sdc] ⚠ Session "${projectName}" already running on port ${ports}. Starting new session on port ${port}.`);
  }

  log(`[sdc] Starting AgentDeck bridge on port ${port} (agent: ${agentType})...`);

  // API usage data (fetched from Anthropic, not from PTY)
  let cachedApiUsage: ApiUsageData | null = null;
  let lastApiFetchTime = 0;
  let oauthConnected = hasOAuthToken();

  // Ollama status probe
  const ollamaProbe = new OllamaProbe();
  let cachedOllamaStatus: OllamaStatus | null = null;

  // Gateway availability probe
  let cachedGatewayAvailable = false;

  // Model catalog (OpenClaw: from CLI)
  let cachedModelCatalog: ModelCatalogEntry[] | null = null;

  // 1. Initialize components
  const adapter = createAdapter(agentType, gatewayUrl);
  const usageTracker = new UsageTracker();
  const stateMachine = new StateMachine(usageTracker);
  const voiceManager = new VoiceManager();
  const utilityProxy = new UtilityProxy();
  const journal = new EventJournal();
  const ptyRingBuffer = new PtyRingBuffer();

  // Slot map cache (plugin → bridge → Android relay)
  let cachedSlotMap: DeckSlotMapEvent | null = null;

  // 1b. Connect to singleton whisper-server (non-blocking — don't delay bridge startup)
  voiceManager.connectToServer().catch((err) => {
    debug('sdc', `whisper-server connection failed (will use whisper-cli): ${err}`);
  });

  // 2. Start adapter (creates HTTP server, spawns agent process)
  try {
    await adapter.start({ port, command, gatewayUrl });
    log(`[sdc] Adapter started: ${adapter.capabilities.displayName}`);
  } catch (err) {
    log(`[sdc] Failed to start adapter: ${err}`);
    process.exit(1);
  }

  // 2b. Display sleep monitor (macOS)
  const displayMonitor = new DisplayMonitor();
  displayMonitor.start();

  // 2c. Auth token initialization (must be before mDNS so token is available)
  const authToken = getOrCreateToken();
  const wsUrl = getWsUrl(port);

  // mDNS is handled by daemon-server only (avoids name collisions in multi-session)
  log(`[sdc] Auth token ready. Pairing URL: ${wsUrl}`);

  // 2e. SSE broadcasting helper (only for ClaudeCode adapter which has HookServer)
  let hookServer: HookServer | null = null;
  if (adapter instanceof ClaudeCodeAdapter) {
    hookServer = adapter.hookServer;
    hookServer.setMeta({ agentType, projectName });
    hookServer.setVoiceManager(voiceManager);
  }
  const broadcastSse = (event: BridgeEvent) => hookServer?.broadcastSse(event);

  // 3. Attach WebSocket server to adapter's HTTP server
  const wsServer = new WsServer(adapter.getHttpServer());
  log(`[sdc] WebSocket server ready on port ${port}`);

  // 3a. Display state broadcast (after wsServer is ready)
  displayMonitor.on('display_state_changed', (displayOn: boolean) => {
    const evt: BridgeEvent = { type: 'display_state', displayOn };
    wsServer.broadcast(evt);
    broadcastSse(evt);
  });

  // 3b. Register diag handler
  adapter.onDiag((tail) => createDiagDump(stateMachine, wsServer, journal, ptyRingBuffer, tail));

  // 3c. Register raw agent data handler for diagnostics
  adapter.onRawData((data: string) => {
    ptyRingBuffer.push(data);
    const preview = data.replace(/[\x00-\x1f\x1b]/g, '').slice(0, 200);
    journal.write('pty_chunk', 'pty', { size: data.length, preview });
  });

  // 3d. Handle VoiceManager errors (prevent uncaught exception crash)
  voiceManager.on('error', (err: Error) => {
    debug('sdc', `Voice error: ${err.message}`);
    wsServer.broadcast({ type: 'voice_state', state: 'error', error: err.message } as any);
  });

  // 4. Wire adapter events → StateMachine + journal
  adapter.on('event', (evt: AdapterEvent) => {
    switch (evt.source) {
      case 'hook':
        journal.write('hook', 'hook', { event: evt.event, data: evt.data });
        if (evt.event === 'shutdown') {
          shutdown();
          return;
        }
        stateMachine.handleHookEvent(evt.event, evt.data);
        break;

      case 'parser':
        journal.write('parser_emit', 'pty', { event: evt.event, ...evt.data });
        stateMachine.handleParserEvent(evt.event, evt.data);
        break;

      case 'metadata':
        switch (evt.event) {
          case 'cursor_update': {
            const idx = (evt.data?.cursorIndex as number) ?? 0;
            stateMachine.updateCursorIndex(idx, 'pty');
            break;
          }
          case 'usage_info':
            usageTracker.setUsageInfo(evt.data);
            // Immediately broadcast updated usage
            wsServer.broadcast(buildUsageEvent(stateMachine.getSnapshot(), cachedApiUsage, oauthConnected));
            break;
          case 'user_prompt': {
            const text = evt.data?.text as string | undefined;
            if (text) {
              wsServer.broadcast({ type: 'user_prompt', text } as BridgeEvent);
            }
            break;
          }
          case 'model_catalog': {
            const models = evt.data?.models as ModelCatalogEntry[] | undefined;
            if (models) {
              cachedModelCatalog = models;
              debug('sdc', `Model catalog updated: ${models.length} models`);
              // Broadcast updated state with model catalog
              const snap = stateMachine.getSnapshot();
              const stateEvt: BridgeEvent = {
                type: 'state_update',
                state: snap.state,
                permissionMode: snap.permissionMode,
                agentType: adapter.capabilities.type,
                modelCatalog: cachedModelCatalog ?? undefined,
              };
              wsServer.broadcast(stateEvt);
            }
            break;
          }
        }
        break;

      case 'activity':
        stateMachine.onPtyActivity();
        break;

      case 'connection': {
        const connEvt: BridgeEvent = { type: 'connection', status: evt.status };
        wsServer.broadcast(connEvt);
        broadcastSse(connEvt);
        break;
      }
    }
  });

  // 4b. Handle adapter exit (agent process died)
  adapter.on('exit', (_code: number, _signal: number) => {
    shutdown();
  });

  // Debounce tracker for sessions_list on state_changed
  let lastSessionsListBroadcast = 0;

  // 5. Wire StateMachine state changes → WsServer broadcast
  stateMachine.on('state_changed', (snapshot: StateSnapshot) => {
    hookServer?.setMeta({ state: snapshot.state });
    journal.write('state_change', 'internal', { state: snapshot.state, permissionMode: snapshot.permissionMode, suggestedPrompt: snapshot.suggestedPrompt });
    // Compute promptType if options are present
    let promptType: 'yes_no' | 'yes_no_always' | 'multi_select' | 'diff_review' | undefined;
    if (snapshot.options.length > 0) {
      promptType = 'multi_select';
      if (snapshot.state === State.AWAITING_PERMISSION) {
        promptType = snapshot.options.length > 2 ? 'yes_no_always' : 'yes_no';
      } else if (snapshot.state === State.AWAITING_DIFF) {
        promptType = 'diff_review';
      }
    }

    // Include options atomically in state_update to avoid race conditions
    // Note: agentCapabilities sent only on client connect (static), not on every broadcast
    const stateEvent: BridgeEvent = {
      type: 'state_update',
      state: snapshot.state,
      permissionMode: snapshot.permissionMode,
      agentType: adapter.capabilities.type,
      currentTool: snapshot.currentTool ?? undefined,
      toolInput: snapshot.toolInput ?? undefined,
      toolProgress: snapshot.toolProgress ?? undefined,
      projectName: snapshot.projectName ?? undefined,
      modelName: snapshot.modelName ?? undefined,
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
      modelCatalog: cachedModelCatalog ?? undefined,
      remoteUrl: snapshot.remoteUrl ?? undefined,
      pairingUrl: wsUrl,
      ollamaStatus: cachedOllamaStatus ?? undefined,
      gatewayAvailable: cachedGatewayAvailable || undefined,
    };
    wsServer.broadcast(stateEvent);
    broadcastSse(stateEvent);

    // Trigger sessions_list refresh on state change (debounced 2s)
    const now = Date.now();
    if (now - lastSessionsListBroadcast > 2000 && wsServer.getClientCount() > 0) {
      lastSessionsListBroadcast = now;
      buildSessionsList().then((sessions) => {
        wsServer.broadcast({ type: 'sessions_list', sessions } as BridgeEvent);
      });
    }

    // Also send separate prompt_options for backward compatibility
    if (snapshot.options.length > 0) {
      const promptEvent: BridgeEvent = {
        type: 'prompt_options',
        promptType: promptType!,
        question: snapshot.question ?? undefined,
        options: snapshot.options,
      };
      wsServer.broadcast(promptEvent);
    }

    const usageEvt = buildUsageEvent(snapshot, cachedApiUsage, oauthConnected);
    wsServer.broadcast(usageEvt);
    broadcastSse(usageEvt);

    // Broadcast encoder state alongside state updates
    const encEvt = computeEncoderState();
    wsServer.broadcast(encEvt);
    broadcastSse(encEvt);
  });

  // 6. Handle PluginCommands from WsServer
  wsServer.onCommand((cmd: PluginCommand) => {
    debug('sdc', `pluginCmd: ${cmd.type}`);

    // Let adapter handle commands it owns.
    // ClaudeCode: switch_mode, interrupt, escape, respond
    // OpenClaw: also select_option, navigate_option, send_prompt (via RPC)
    if (adapter.handleCommand(cmd)) {
      // Adapter handled the transport side; update StateMachine as needed
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

    // Commands that need bridge coordination
    switch (cmd.type) {
      case 'select_option': {
        const snapshot = stateMachine.getSnapshot();
        debug('sdc', `select_option: idx=${cmd.index} navigable=${snapshot.navigable} cursor=${snapshot.cursorIndex}`);
        if (snapshot.navigable) {
          // Arrow-key mode: navigate to desired option then press Enter
          const delta = cmd.index - snapshot.cursorIndex;
          if (delta !== 0) {
            const arrow = delta > 0 ? '\x1b[B' : '\x1b[A';
            const steps = Math.abs(delta);
            debug('sdc', `select_option: navigating ${steps} steps ${delta > 0 ? 'down' : 'up'}`);
            adapter.writeInput(arrow.repeat(steps));
          }
          // Proportional delay for PTY to process arrow keys, then confirm with Enter
          const delay = 50 + Math.abs(delta) * 20;
          setTimeout(() => {
            adapter.writeInput('\r');
          }, delay);
        } else {
          // Number input mode: type the 1-based index
          adapter.writeInput(String(cmd.index + 1) + '\r');
        }
        stateMachine.handleUserAction('select_option');
        break;
      }

      case 'navigate_option': {
        const total = stateMachine.getOptionsCount();
        const cur = stateMachine.getCursorIndex();
        const newIdx = total > 0
          ? (cmd.direction === 'up'
              ? Math.max(cur - 1, 0)
              : Math.min(cur + 1, total - 1))
          : cur;
        stateMachine.updateCursorIndex(newIdx, 'optimistic');
        debug('sdc', `navigate_option: ${cmd.direction} cursor=${cur}->${newIdx}`);
        adapter.prepareForNavigation?.();
        adapter.writeInput(cmd.direction === 'up' ? '\x1b[A' : '\x1b[B');
        // Don't call handleUserAction — cursor movement is not a selection
        break;
      }

      case 'send_prompt': {
        let text = cmd.text;
        // Expand template references
        const templateMatch = text.match(/^__template:(\d+)$/);
        if (templateMatch) {
          const idx = parseInt(templateMatch[1], 10);
          if (idx >= 0 && idx < promptTemplates.length) {
            text = promptTemplates[idx].prompt;
            debug('sdc', `Template ${idx} → "${text.slice(0, 50)}"`);
          } else {
            debug('sdc', `Template ${idx} out of range (${promptTemplates.length} available)`);
            break;
          }
        }
        if (text) {
          adapter.writeInput(text);
          setTimeout(() => adapter.writeInput('\r'), 50);
          stateMachine.handleUserAction('send_prompt');
        }
        break;
      }

      case 'utility':
        utilityProxy.handleCommand(cmd as UtilityCommand);
        // Broadcast updated encoder state after utility change
        wsServer.broadcast(computeEncoderState());
        broadcastSse(computeEncoderState());
        break;

      case 'voice':
        handleVoiceCommand(cmd.action, voiceManager, wsServer);
        break;

      case 'query_usage': {
        // Fetch fresh usage from Anthropic API (no PTY echo)
        debug('sdc', 'Fetching usage from API (on demand)');
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
        break;
      }
    }
  });

  // 6a. Handle deck_slot_map relay (plugin → bridge → other clients)
  wsServer.onRawMessage((msg, sender) => {
    if (msg.type === 'deck_slot_map') {
      debug('sdc', `Received deck_slot_map from plugin, caching + relaying`);
      cachedSlotMap = msg as unknown as DeckSlotMapEvent;
      wsServer.broadcastExcept(cachedSlotMap, sender);
      broadcastSse(cachedSlotMap);
      return true; // consumed
    }
    return false;
  });

  // 6b. Wire WS connect/disconnect to journal + update SSE metadata
  wsServer.onClientDisconnect(() => {
    journal.write('ws_event', 'ws', { action: 'disconnect', clients: wsServer.getClientCount() });
    hookServer?.setMeta({ clientCount: wsServer.getClientCount() });
  });

  // Kick initial state: synthetic SessionStart in adapter.start() was emitted before
  // the event listener was wired, so fire it explicitly now.
  if (adapter.isAlive()) {
    stateMachine.handleHookEvent('SessionStart', {});
  }

  // Register with session registry for multi-session support
  registerSession({
    id: sessionId,
    port,
    pid: process.pid,
    projectName: adapter.getProjectName() || projectName,
    agentType,
    tmuxSession,
    parentTty,
    tty: adapter.getTtyPath(),
    startedAt: new Date().toISOString(),
  });

  // 7. Send current state to newly connected WebSocket clients
  wsServer.onClientConnect((ws) => {
    journal.write('ws_event', 'ws', { action: 'connect', clients: wsServer.getClientCount() });
    hookServer?.setMeta({ clientCount: wsServer.getClientCount() });
    const snapshot = stateMachine.getSnapshot();

    // Compute promptType for initial state
    let initPromptType: 'yes_no' | 'yes_no_always' | 'multi_select' | 'diff_review' | undefined;
    if (snapshot.options.length > 0) {
      initPromptType = 'multi_select';
      if (snapshot.state === State.AWAITING_PERMISSION) {
        initPromptType = snapshot.options.length > 2 ? 'yes_no_always' : 'yes_no';
      } else if (snapshot.state === State.AWAITING_DIFF) {
        initPromptType = 'diff_review';
      }
    }

    // Restore last valid suggestion on reconnect when IDLE (current suggestedPrompt may already be null)
    let reconnectSuggestion: string | null = snapshot.suggestedPrompt;
    if (!reconnectSuggestion && snapshot.state === State.IDLE) {
      reconnectSuggestion = stateMachine.getLastValidSuggestedPrompt();
      if (reconnectSuggestion) {
        debug('sdc', `Restoring lastValidSuggestedPrompt on reconnect: "${reconnectSuggestion.slice(0, 40)}"`);
      }
    }

    const stateEvent: BridgeEvent = {
      type: 'state_update',
      state: snapshot.state,
      permissionMode: snapshot.permissionMode,
      agentType: adapter.capabilities.type,
      agentCapabilities: adapter.capabilities,
      currentTool: snapshot.currentTool ?? undefined,
      toolInput: snapshot.toolInput ?? undefined,
      toolProgress: snapshot.toolProgress ?? undefined,
      projectName: snapshot.projectName ?? undefined,
      modelName: snapshot.modelName ?? undefined,
      billingType: snapshot.billingType,
      options: snapshot.options.length > 0 ? snapshot.options : undefined,
      promptType: initPromptType,
      question: snapshot.question ?? undefined,
      navigable: snapshot.navigable || undefined,
      cursorIndex: (snapshot.state === State.AWAITING_OPTION ||
                   snapshot.state === State.AWAITING_PERMISSION ||
                   snapshot.state === State.AWAITING_DIFF)
                   ? snapshot.cursorIndex : undefined,
      suggestedPrompt: reconnectSuggestion ?? undefined,
      modelCatalog: cachedModelCatalog ?? undefined,
      pairingUrl: wsUrl,
      ollamaStatus: cachedOllamaStatus ?? undefined,
      gatewayAvailable: cachedGatewayAvailable || undefined,
    };
    wsServer.sendTo(ws, stateEvent);

    // Also send separate prompt_options for backward compatibility
    if (snapshot.options.length > 0) {
      wsServer.sendTo(ws, {
        type: 'prompt_options',
        promptType: initPromptType!,
        question: snapshot.question ?? undefined,
        options: snapshot.options,
      });
    }

    wsServer.sendTo(ws, buildUsageEvent(snapshot, cachedApiUsage, oauthConnected));

    const connectEvt: BridgeEvent = {
      type: 'connection',
      status: adapter.isAlive() ? 'connected' : 'disconnected',
      sessionId,
    };
    wsServer.sendTo(ws, connectEvt);

    // Send sibling sessions on connect (don't wait for 30s interval)
    buildSessionsList().then((sessions) => {
      wsServer.sendTo(ws, {
        type: 'sessions_list',
        sessions,
      } as BridgeEvent);
    });

    // Send current display state
    wsServer.sendTo(ws, { type: 'display_state', displayOn: displayMonitor.isDisplayOn() } as BridgeEvent);

    // Send encoder state
    wsServer.sendTo(ws, computeEncoderState());

    // Send cached slot map if available
    if (cachedSlotMap) {
      wsServer.sendTo(ws, cachedSlotMap);
    }

    // Fetch API usage on client connect:
    // - Always fetch if no cache yet
    // - Re-fetch if cache is stale (>5 min, e.g. after sleep/wake)
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

  // 8. Attach user's terminal to adapter (PTY agents proxy stdin/stdout)
  if (adapter.capabilities.hasTerminal) {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    adapter.attachTerminal(process.stdin, process.stdout);
  }

  // 9. Periodic usage update (so session timer ticks on Stream Deck)
  const usageInterval = setInterval(() => {
    if (wsServer.getClientCount() > 0) {
      const snapshot = stateMachine.getSnapshot();
      wsServer.broadcast(buildUsageEvent(snapshot, cachedApiUsage, oauthConnected));
    }
  }, 5000);

  // 9b. Periodic API usage refresh (silent — no PTY echo)
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
          // Broadcast updated usage so clients see fresh rate-limit data
          const snapshot = stateMachine.getSnapshot();
          wsServer.broadcast(buildUsageEvent(snapshot, cachedApiUsage, oauthConnected));
        } else {
          oauthConnected = hasOAuthToken();
        }
      });
    }
  }, 60_000);

  // 9b2. Periodic Ollama status probe (piggyback on state_update interval)
  const ollamaInterval = setInterval(() => {
    ollamaProbe.getStatus().then((status) => {
      cachedOllamaStatus = status;
    });
  }, 5000);
  // Initial probe
  ollamaProbe.getStatus().then((status) => {
    cachedOllamaStatus = status;
  });

  // 9b3. Periodic Gateway probe (OpenClaw availability)
  const gatewayInterval = setInterval(() => {
    probeGateway().then((status) => {
      cachedGatewayAvailable = status.available;
    });
  }, 5000);
  // Initial probe
  probeGateway().then((status) => {
    cachedGatewayAvailable = status.available;
  });

  // 9c. Build enriched sessions list (shared with daemon-server)
  async function buildSessionsList() {
    return buildEnrichedSessionsList(sessionId, stateMachine.getSnapshot().state);
  }

  // 9c2. Periodic sibling sessions broadcast (for multi-session terrarium)
  const sessionsListInterval = setInterval(() => {
    if (wsServer.getClientCount() > 0) {
      buildSessionsList().then((sessions) => {
        wsServer.broadcast({
          type: 'sessions_list',
          sessions,
        } as BridgeEvent);
      });
    }
  }, 10_000);

  // Encoder state computation (scoped inside startBridge for access to local vars)
  function computeEncoderState(): EncoderStateEvent {
    const snapshot = stateMachine.getSnapshot();
    const isInteractive = snapshot.state === State.AWAITING_OPTION ||
      snapshot.state === State.AWAITING_PERMISSION ||
      snapshot.state === State.AWAITING_DIFF;

    // E1: Utility
    const utilState = utilityProxy.getState();
    const e1: EncoderSlotState = {
      slot: 0,
      encoderType: 'utility',
      header: utilState.mode.toUpperCase(),
      value: utilState.value,
      icon: utilState.icon,
      accentColor: '#3b82f6',
      progress: utilState.level,
    };

    // E2: Action
    const e2: EncoderSlotState = {
      slot: 1,
      encoderType: 'action',
      header: 'ACTION',
      accentColor: '#f59e0b',
    };
    if (isInteractive && snapshot.options.length > 0) {
      const opt = snapshot.options[snapshot.cursorIndex];
      e2.header = 'OPTION';
      e2.value = opt?.label ?? '';
      e2.counter = `${snapshot.cursorIndex + 1}/${snapshot.options.length}`;
      e2.detail = opt?.label;
    } else if (snapshot.suggestedPrompt) {
      e2.header = 'PROMPT';
      e2.value = snapshot.suggestedPrompt;
    }

    // E3: Terminal
    const sessions = listActiveSessions();
    const e3: EncoderSlotState = {
      slot: 2,
      encoderType: 'terminal',
      header: 'SESSION',
      value: `${sessions.length} active`,
      accentColor: '#22c55e',
      counter: sessions.length > 1 ? `1/${sessions.length}` : undefined,
    };

    // E4: Voice
    const isRec = voiceManager.isRecording();
    const e4: EncoderSlotState = {
      slot: 3,
      encoderType: 'voice',
      header: 'VOICE',
      value: isRec ? 'Recording...' : 'Ready',
      icon: isRec ? '🔴' : '🎤',
      accentColor: isRec ? '#ef4444' : '#8b5cf6',
      voiceState: isRec ? 'recording' : 'idle',
    };

    return {
      type: 'encoder_state',
      encoders: [e1, e2, e3, e4],
      takeoverActive: isInteractive && snapshot.options.length > 0,
    };
  }

  // 10. Graceful shutdown
  let shutdownInProgress = false;

  function shutdown(): void {
    if (shutdownInProgress) return;
    shutdownInProgress = true;

    log('[sdc] Shutting down...');
    clearInterval(usageInterval);
    clearInterval(apiUsageInterval);
    clearInterval(ollamaInterval);
    clearInterval(gatewayInterval);
    clearInterval(sessionsListInterval);
    deregisterSession(sessionId);

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }

    displayMonitor.stop();
    utilityProxy.cleanup();
    voiceManager.disconnectFromServer();
    journal.close();
    wsServer.close();

    // Adapter handles killing the agent process and closing its HTTP server
    adapter.shutdown().then(() => {
      process.exit(0);
    });

    // Force exit if adapter shutdown hangs
    setTimeout(() => {
      process.exit(1);
    }, 3000);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('uncaughtException', (err) => {
    log(`[sdc] Uncaught exception: ${err}`);
    shutdown();
  });
  process.on('unhandledRejection', (reason) => {
    log(`[sdc] Unhandled rejection: ${reason}`);
    shutdown();
  });
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

function handleVoiceCommand(
  action: 'start' | 'stop' | 'cancel',
  voiceManager: VoiceManager,
  wsServer: WsServer,
): void {
  switch (action) {
    case 'start':
      voiceManager.startRecording();
      wsServer.broadcast({ type: 'voice_state', state: 'recording' } as any);
      break;

    case 'stop':
      wsServer.broadcast({ type: 'voice_state', state: 'transcribing' } as any);
      voiceManager.stopRecording().then((text) => {
        debug('sdc', `Voice result: "${text?.slice(0, 60) || '(empty)'}"`);
        // Don't auto-send — plugin shows review UI; user confirms via send_prompt
        wsServer.broadcast({ type: 'voice_state', state: 'idle', text: text || '' } as any);
      }).catch((err) => {
        debug('sdc', `Voice transcription error: ${err}`);
        wsServer.broadcast({ type: 'voice_state', state: 'error', error: String(err) } as any);
      });
      break;

    case 'cancel':
      voiceManager.cancel();
      wsServer.broadcast({ type: 'voice_state', state: 'idle' } as any);
      break;
  }
}

/**
 * Auto-migrate hooks:
 * 1. Hardcoded localhost:9120 → $AGENTDECK_PORT env var
 * 2. Old flat format → new matcher-group format (Claude Code v2.1+)
 *    Old: { type: "command", command: "curl ..." }
 *    New: { matcher: "", hooks: [{ type: "command", command: "curl ..." }] }
 */
function migrateHooksIfNeeded(): void {
  const settingsPath = join(homedir(), '.claude', 'settings.local.json');
  try {
    if (!existsSync(settingsPath)) return;
    const raw = readFileSync(settingsPath, 'utf-8');
    if (!raw.includes('AGENTDECK_PORT') && !raw.includes('localhost:9120')) return;

    const settings = JSON.parse(raw);
    if (!settings.hooks) return;

    let migrated = false;
    for (const event of Object.keys(settings.hooks)) {
      const hooks = settings.hooks[event];
      if (!Array.isArray(hooks)) continue;
      for (let i = 0; i < hooks.length; i++) {
        const hook = hooks[i];

        // Migration 1: hardcoded port → env var
        if (hook.command?.includes('localhost:9120') && !hook.command?.includes('AGENTDECK_PORT')) {
          hook.command = hook.command.replace(
            /localhost:9120/g,
            'localhost:${AGENTDECK_PORT:-9120}',
          );
          migrated = true;
        }

        // Migration 2: flat format → matcher-group format
        // Detect flat format: has "type" + "command" at top level, no "hooks" array
        if (hook.type === 'command' && hook.command?.includes('AGENTDECK_PORT') && !hook.hooks) {
          const handler: Record<string, unknown> = { type: hook.type, command: hook.command };
          hooks[i] = { matcher: '', hooks: [handler] };
          migrated = true;
        }

        // Also migrate matcher-group entries with hardcoded port inside
        if (Array.isArray(hook.hooks)) {
          for (const inner of hook.hooks) {
            if (inner.command?.includes('localhost:9120') && !inner.command?.includes('AGENTDECK_PORT')) {
              inner.command = inner.command.replace(
                /localhost:9120/g,
                'localhost:${AGENTDECK_PORT:-9120}',
              );
              migrated = true;
            }
          }
        }
      }
    }

    if (migrated) {
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      log('[sdc] Auto-migrated hooks to v2.1 matcher-group format');
    }
  } catch (err) {
    debug('sdc', `Hook migration check failed: ${err}`);
  }
}
