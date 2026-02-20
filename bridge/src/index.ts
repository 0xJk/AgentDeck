#!/usr/bin/env node

import { Command } from 'commander';
import { PtyManager } from './pty-manager.js';
import { OutputParser } from './output-parser.js';
import { HookServer } from './hook-server.js';
import { UsageTracker } from './usage-tracker.js';
import { StateMachine } from './state-machine.js';
import { WsServer } from './ws-server.js';
import { VoiceManager } from './voice.js';
import { checkDependencies } from './check-deps.js';
import { enableDebugLog, debug } from './logger.js';
import {
  BRIDGE_WS_PORT,
  State,
  type PluginCommand,
  type BridgeEvent,
  type StateSnapshot,
} from './types.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import {
  register as registerSession,
  deregister as deregisterSession,
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
  .description('Start bridge server and spawn Claude CLI')
  .option('-p, --port <port>', 'Bridge server port', String(BRIDGE_WS_PORT))
  .option('-c, --command <cmd>', 'Command to spawn', 'claude')
  .option('-d, --debug', 'Enable debug logging to /tmp/sdc-debug.log')
  .action(async (opts) => {
    if (opts.debug) {
      enableDebugLog();
      log('[sdc] Debug logging enabled → /tmp/sdc-debug.log');
    }
    const port = parseInt(opts.port, 10);
    await startBridge(port, opts.command);
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

program.parse();

async function startBridge(port: number, command: string): Promise<void> {
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

  log(`[sdc] Starting AgentDeck bridge on port ${port}...`);

  // API usage data (fetched from Anthropic, not from PTY)
  let cachedApiUsage: ApiUsageData | null = null;

  // Mode switch debounce
  let lastModeSwitchTime = 0;

  // 1. Initialize components
  const hookServer = new HookServer();
  const usageTracker = new UsageTracker();
  const stateMachine = new StateMachine(usageTracker);
  const ptyManager = new PtyManager();
  const outputParser = new OutputParser();
  const voiceManager = new VoiceManager();

  // 2. Start HTTP server
  try {
    await hookServer.listen(port);
    log(`[sdc] Hook server listening on port ${port}`);
  } catch (err) {
    log(`[sdc] Failed to start server: ${err}`);
    process.exit(1);
  }

  // 3. Attach WebSocket server to HTTP server
  const wsServer = new WsServer(hookServer.getServer());
  log(`[sdc] WebSocket server ready on port ${port}`);

  // 4. Wire HookServer events → StateMachine
  hookServer.on('hook', ({ event, data }: { event: string; data: Record<string, unknown> }) => {
    if (event === 'shutdown') {
      shutdown();
      return;
    }
    stateMachine.handleHookEvent(event, data);
  });

  // 5. Wire OutputParser events → StateMachine
  const parserEvents = [
    'spinner_start',
    'spinner_stop',
    'permission_prompt',
    'option_prompt',
    'diff_prompt',
    'idle',
    'status_line',
    'tool_action',
    'project_name',
    'model_info',
    'mode_change',
  ];
  for (const eventName of parserEvents) {
    outputParser.on(eventName, (data?: Record<string, unknown>) => {
      stateMachine.handleParserEvent(eventName, data);
    });
  }

  // 5b. Wire usage_info events → UsageTracker
  outputParser.on('usage_info', (data?: Record<string, unknown>) => {
    if (data) {
      usageTracker.setUsageInfo(data);
      // Immediately broadcast updated usage
      const snapshot = stateMachine.getSnapshot();
      wsServer.broadcast(buildUsageEvent(snapshot, cachedApiUsage));
    }
  });

  // 5c. Wire user_prompt events → broadcast for plugin history
  outputParser.on('user_prompt', (data?: Record<string, unknown>) => {
    const text = data?.text as string | undefined;
    if (text) {
      const evt: BridgeEvent = { type: 'user_prompt', text };
      wsServer.broadcast(evt);
    }
  });

  // 6. Wire StateMachine state changes → WsServer broadcast
  stateMachine.on('state_changed', (snapshot: StateSnapshot) => {
    const stateEvent: BridgeEvent = {
      type: 'state_update',
      state: snapshot.state,
      permissionMode: snapshot.permissionMode,
      currentTool: snapshot.currentTool ?? undefined,
      toolProgress: snapshot.toolProgress ?? undefined,
      projectName: snapshot.projectName ?? undefined,
      modelName: snapshot.modelName ?? undefined,
    };
    wsServer.broadcast(stateEvent);

    if (snapshot.options.length > 0) {
      let promptType: 'yes_no' | 'yes_no_always' | 'multi_select' | 'diff_review' = 'multi_select';
      if (snapshot.state === State.AWAITING_PERMISSION) {
        promptType = snapshot.options.length > 2 ? 'yes_no_always' : 'yes_no';
      } else if (snapshot.state === State.AWAITING_DIFF) {
        promptType = 'diff_review';
      }

      const promptEvent: BridgeEvent = {
        type: 'prompt_options',
        promptType,
        question: snapshot.question ?? undefined,
        options: snapshot.options,
      };
      wsServer.broadcast(promptEvent);
    }

    wsServer.broadcast(buildUsageEvent(snapshot, cachedApiUsage));
  });

  // 7. Handle PluginCommands from WsServer
  wsServer.onCommand((cmd: PluginCommand) => {
    debug('sdc', `pluginCmd: ${cmd.type}`);
    switch (cmd.type) {
      case 'respond':
        debug('sdc', `respond: "${cmd.value}"`);
        ptyManager.write(cmd.value + '\n');
        stateMachine.handleUserAction('respond');
        break;

      case 'select_option':
        debug('sdc', `select_option: idx=${cmd.index}`);
        ptyManager.write(String(cmd.index + 1) + '\n');
        stateMachine.handleUserAction('select_option');
        break;

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
          ptyManager.write(text + '\n');
        }
        break;
      }

      case 'switch_mode': {
        const now = Date.now();
        if (now - lastModeSwitchTime < 800) {
          debug('sdc', `switch_mode: debounced (${now - lastModeSwitchTime}ms < 800ms)`);
          break;
        }
        lastModeSwitchTime = now;
        debug('sdc', 'switch_mode: sending Shift+Tab');
        outputParser.notifyModeSwitchSent();
        ptyManager.write('\x1b[Z');
        break;
      }

      case 'interrupt':
        ptyManager.interrupt();
        stateMachine.handleUserAction('interrupt');
        break;

      case 'voice':
        handleVoiceCommand(cmd.action, voiceManager, ptyManager, wsServer);
        break;

      case 'query_usage':
        // Fetch usage from Anthropic API (no PTY echo)
        debug('sdc', 'Fetching usage from API');
        fetchUsageFromApi().then((apiUsage) => {
          if (apiUsage) {
            cachedApiUsage = apiUsage;
          }
          const snapshot = stateMachine.getSnapshot();
          wsServer.broadcast(buildUsageEvent(snapshot, cachedApiUsage));
        });
        break;
    }
  });

  // 8. Send current state to newly connected WebSocket clients
  wsServer.onClientConnect((ws) => {
    const snapshot = stateMachine.getSnapshot();
    const stateEvent: BridgeEvent = {
      type: 'state_update',
      state: snapshot.state,
      permissionMode: snapshot.permissionMode,
      currentTool: snapshot.currentTool ?? undefined,
      toolProgress: snapshot.toolProgress ?? undefined,
      projectName: snapshot.projectName ?? undefined,
      modelName: snapshot.modelName ?? undefined,
    };
    wsServer.sendTo(ws, stateEvent);
    wsServer.sendTo(ws, buildUsageEvent(snapshot, cachedApiUsage));

    const connectEvt: BridgeEvent = {
      type: 'connection',
      status: ptyManager.isAlive() ? 'connected' : 'disconnected',
    };
    wsServer.sendTo(ws, connectEvt);

    // Fetch API usage on first client connect (silent — no PTY echo)
    if (!cachedApiUsage) {
      fetchUsageFromApi().then((apiUsage) => {
        if (apiUsage) {
          cachedApiUsage = apiUsage;
          const snap = stateMachine.getSnapshot();
          wsServer.broadcast(buildUsageEvent(snap, cachedApiUsage));
        }
      });
    }
  });

  // 9. Spawn Claude via PTY (with AGENTDECK_PORT so hooks POST to this bridge)
  try {
    ptyManager.spawn(command, { AGENTDECK_PORT: String(port) });
    log(`[sdc] Spawned: ${command}`);
  } catch (err) {
    log(`[sdc] Failed to spawn ${command}: ${err}`);
    await hookServer.close();
    process.exit(1);
  }

  // PTY spawned successfully — assume session started (hooks may arrive later as confirmation)
  stateMachine.handleHookEvent('SessionStart', {});

  // Register with session registry for multi-session support
  registerSession({
    id: sessionId,
    port,
    pid: process.pid,
    projectName: outputParser.getProjectName() || process.cwd().split('/').pop() || 'unknown',
    tmuxSession,
    startedAt: new Date().toISOString(),
  });

  // 10. Feed PTY output to OutputParser
  ptyManager.on('data', (data: string) => {
    outputParser.feed(data);
  });

  // 11. Handle PTY exit
  ptyManager.on('exit', (code: number, signal: number) => {
    debug('sdc', `Claude exited (code=${code}, signal=${signal})`);
    stateMachine.handleHookEvent('SessionEnd', {});

    const disconnectEvent: BridgeEvent = {
      type: 'connection',
      status: 'disconnected',
    };
    wsServer.broadcast(disconnectEvent);

    shutdown();
  });

  // 12. Attach user's terminal to PTY
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  ptyManager.attachTerminal(process.stdin, process.stdout);

  // 13. Broadcast initial connection event
  const connectEvent: BridgeEvent = {
    type: 'connection',
    status: 'connected',
  };
  wsServer.broadcast(connectEvent);

  // 14. Periodic usage update (so session timer ticks on Stream Deck)
  const usageInterval = setInterval(() => {
    if (wsServer.getClientCount() > 0) {
      const snapshot = stateMachine.getSnapshot();
      wsServer.broadcast(buildUsageEvent(snapshot, cachedApiUsage));
    }
  }, 5000);

  // 14b. Periodic API usage refresh (silent — no PTY echo)
  const apiUsageInterval = setInterval(() => {
    if (wsServer.getClientCount() > 0) {
      fetchUsageFromApi().then((apiUsage) => {
        if (apiUsage) {
          cachedApiUsage = apiUsage;
        }
      });
    }
  }, 60_000);

  // 15. Graceful shutdown
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

    if (ptyManager.isAlive()) {
      ptyManager.kill();
    }

    wsServer.close();
    hookServer.close().then(() => {
      process.exit(0);
    });

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
  ptyManager: PtyManager,
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
        if (text) {
          ptyManager.write(text + '\n');
        }
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
