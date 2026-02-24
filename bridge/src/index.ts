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
import { createAdapter } from './adapters/index.js';
import {
  BRIDGE_WS_PORT,
  State,
  type PluginCommand,
  type BridgeEvent,
  type StateSnapshot,
  type AdapterEvent,
  type AgentType,
  type ModelCatalogEntry,
} from './types.js';
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
import { fetchUsageFromApi, type ApiUsageData } from './usage-api.js';

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

  // Model catalog (OpenClaw: from CLI)
  let cachedModelCatalog: ModelCatalogEntry[] | null = null;

  // 1. Initialize components
  const adapter = createAdapter(agentType, gatewayUrl);
  const usageTracker = new UsageTracker();
  const stateMachine = new StateMachine(usageTracker);
  const voiceManager = new VoiceManager();
  const journal = new EventJournal();
  const ptyRingBuffer = new PtyRingBuffer();

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

  // 3. Attach WebSocket server to adapter's HTTP server
  const wsServer = new WsServer(adapter.getHttpServer());
  log(`[sdc] WebSocket server ready on port ${port}`);

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
            stateMachine.updateCursorIndex(idx);
            break;
          }
          case 'usage_info':
            usageTracker.setUsageInfo(evt.data);
            // Immediately broadcast updated usage
            wsServer.broadcast(buildUsageEvent(stateMachine.getSnapshot(), cachedApiUsage));
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

      case 'connection':
        wsServer.broadcast({ type: 'connection', status: evt.status } as BridgeEvent);
        break;
    }
  });

  // 4b. Handle adapter exit (agent process died)
  adapter.on('exit', (_code: number, _signal: number) => {
    shutdown();
  });

  // 5. Wire StateMachine state changes → WsServer broadcast
  stateMachine.on('state_changed', (snapshot: StateSnapshot) => {
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
      cursorIndex: snapshot.navigable ? snapshot.cursorIndex : undefined,
      suggestedPrompt: snapshot.suggestedPrompt ?? undefined,
      modelCatalog: cachedModelCatalog ?? undefined,
    };
    wsServer.broadcast(stateEvent);

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

    wsServer.broadcast(buildUsageEvent(snapshot, cachedApiUsage));
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
          // Brief delay for PTY to process arrow keys, then confirm with Enter
          setTimeout(() => {
            adapter.writeInput('\r');
          }, 50);
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
        stateMachine.updateCursorIndex(newIdx);
        debug('sdc', `navigate_option: ${cmd.direction} cursor=${cur}->${newIdx}`);
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
          wsServer.broadcast(buildUsageEvent(snapshot, cachedApiUsage));
        });
        break;
      }
    }
  });

  // 6b. Wire WS connect/disconnect to journal
  wsServer.onClientDisconnect(() => {
    journal.write('ws_event', 'ws', { action: 'disconnect', clients: wsServer.getClientCount() });
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
    tmuxSession,
    parentTty,
    tty: adapter.getTtyPath(),
    startedAt: new Date().toISOString(),
  });

  // 7. Send current state to newly connected WebSocket clients
  wsServer.onClientConnect((ws) => {
    journal.write('ws_event', 'ws', { action: 'connect', clients: wsServer.getClientCount() });
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
      cursorIndex: snapshot.navigable ? snapshot.cursorIndex : undefined,
      suggestedPrompt: reconnectSuggestion ?? undefined,
      modelCatalog: cachedModelCatalog ?? undefined,
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

    wsServer.sendTo(ws, buildUsageEvent(snapshot, cachedApiUsage));

    const connectEvt: BridgeEvent = {
      type: 'connection',
      status: adapter.isAlive() ? 'connected' : 'disconnected',
    };
    wsServer.sendTo(ws, connectEvt);

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
          if (apiUsage.inferredBillingType) {
            stateMachine.inferBillingType(apiUsage.inferredBillingType);
          }
          const snap2 = stateMachine.getSnapshot();
          wsServer.broadcast(buildUsageEvent(snap2, cachedApiUsage));
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
      wsServer.broadcast(buildUsageEvent(snapshot, cachedApiUsage));
    }
  }, 5000);

  // 9b. Periodic API usage refresh (silent — no PTY echo)
  const apiUsageInterval = setInterval(() => {
    if (wsServer.getClientCount() > 0) {
      fetchUsageFromApi().then((apiUsage) => {
        if (apiUsage) {
          cachedApiUsage = apiUsage;
          lastApiFetchTime = Date.now();
          if (apiUsage.inferredBillingType) {
            stateMachine.inferBillingType(apiUsage.inferredBillingType);
          }
          // Broadcast updated usage so clients see fresh rate-limit data
          const snapshot = stateMachine.getSnapshot();
          wsServer.broadcast(buildUsageEvent(snapshot, cachedApiUsage));
        }
      });
    }
  }, 60_000);

  // 10. Graceful shutdown
  let shutdownInProgress = false;

  function shutdown(): void {
    if (shutdownInProgress) return;
    shutdownInProgress = true;

    log('[sdc] Shutting down...');
    clearInterval(usageInterval);
    clearInterval(apiUsageInterval);
    deregisterSession(sessionId);

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }

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

function buildUsageEvent(snapshot: StateSnapshot, apiUsage?: ApiUsageData | null): BridgeEvent {
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

/** Auto-migrate hooks from hardcoded localhost:9120 to $AGENTDECK_PORT env var */
function migrateHooksIfNeeded(): void {
  const settingsPath = join(homedir(), '.claude', 'settings.local.json');
  try {
    if (!existsSync(settingsPath)) return;
    const raw = readFileSync(settingsPath, 'utf-8');

    // Quick check: old format has literal "localhost:9120" but NOT "AGENTDECK_PORT"
    if (!raw.includes('localhost:9120') || raw.includes('AGENTDECK_PORT')) return;

    const settings = JSON.parse(raw);
    if (!settings.hooks) return;

    let migrated = false;
    for (const event of Object.keys(settings.hooks)) {
      const hooks = settings.hooks[event];
      if (!Array.isArray(hooks)) continue;
      for (const hook of hooks) {
        if (hook.command?.includes('localhost:9120') && !hook.command?.includes('AGENTDECK_PORT')) {
          hook.command = hook.command.replace(
            /localhost:9120/g,
            'localhost:${AGENTDECK_PORT:-9120}',
          );
          migrated = true;
        }
      }
    }

    if (migrated) {
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      log('[sdc] Auto-migrated hooks to dynamic port format');
    }
  } catch (err) {
    debug('sdc', `Hook migration check failed: ${err}`);
  }
}
