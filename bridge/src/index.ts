/**
 * AgentDeck Bridge — session entry point.
 *
 * Exports `startSession()` called by cli.ts.
 * Uses BridgeCore for shared infrastructure.
 */

import { BridgeCore } from './bridge-core.js';
import { initApme } from './apme/index.js';
import { readLastTurn as readClaudeTranscriptLastTurn } from './apme/claude-transcript-reader.js';
import { claudeHookToSpans } from './apme/adapters/claude-hook.js';
import { claudePtyParserEventToSpans, claudePtyResponseToSpan } from './apme/adapters/claude-pty.js';
import { timelineEntryToSpans } from './apme/adapters/timeline.js';
import type { AdapterContext as ApmeAdapterContext } from '@agentdeck/shared';
import { VoiceManager } from './voice.js';
import { checkDependencies } from './check-deps.js';
import { enableDebugLog, log, logError, debug, setPtyMode } from './logger.js';
import { EventJournal } from './event-journal.js';
import { PtyRingBuffer } from './pty-ringbuffer.js';
import { createDiagDump } from './diag-analyzer.js';
import { createAdapter, ClaudeCodeAdapter, CodexCliAdapter, OpenCodeAdapter } from './adapters/index.js';
import { MonitorAdapter } from './adapters/monitor.js';
import { UtilityProxy } from './utility-proxy.js';
import { BridgeLogStream } from './log-stream.js';
import { extractTopicHint, summarizeResponse } from './timeline-summarizer.js';
import { cleanDetailText, cleanRawText } from '@agentdeck/shared';
import { VoiceAssistantManager } from './voice-assistant.js';
import { TerminalStatus } from './terminal-status.js';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import {
  listActive as listActiveSessions,
  findAvailablePort,
  detectTmuxSession,
  findDaemonPortAsync,
} from './session-registry.js';
import { resolveProjectName } from './utils/project-name.js';
import { DaemonWsClient } from './daemon-ws-client.js';
import { fetchUsageFromApi, hasOAuthToken } from './usage-api.js';
import { buildUsageEvent } from './usage-event.js';
import { getLanIp } from '@agentdeck/shared';
import { buildEnrichedSessionsList } from './session-aggregator.js';
import { migrateHooksIfNeeded } from './hook-migration.js';
import {
  initModules,
  stopModules,
  createDefaultModules,
  SerialModule,
} from './modules/index.js';
import type { ModuleConfigs } from './modules/types.js';
import type { HookServer } from './hook-server.js';
import {
  onESP32Message,
  sendWifiProvisionToAll,
} from './esp32-serial.js';
import { loadWifiConfig } from './wifi-config.js';
import { getAdbDeviceCount } from './adb-reverse.js';
import { esp32ConnectionCount, getESP32Ports } from './esp32-serial.js';
import { getPixooDeviceDetails, getLastFrame, renderPreviewFrame } from './pixoo/pixoo-bridge.js';
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
  type ButtonSlotState,
  type ButtonStateEvent,
  type DeckSlotMapEvent,
  type UtilityCommand,
} from './types.js';

// ===== Prompt templates =====

interface PromptTemplate {
  label: string;
  prompt: string;
}

function loadTemplates(): PromptTemplate[] {
  try {
    const candidates = [
      resolve(dirname(fileURLToPath(import.meta.url)), '../../config/prompt-templates.json'),
      resolve(process.cwd(), 'config/prompt-templates.json'),
    ];
    for (const p of candidates) {
      try {
        const data = JSON.parse(readFileSync(p, 'utf-8'));
        if (Array.isArray(data?.templates)) {
          debug('agentdeck', `Loaded ${data.templates.length} templates from ${p}`);
          return data.templates;
        }
      } catch { /* try next */ }
    }
  } catch { /* ignore */ }
  return [];
}

const promptTemplates = loadTemplates();

// log(), logError(), debug() imported from logger.ts
// log() is suppressed after setPtyMode(true) — startup messages still shown

/** Extract tool input for timeline display */
function formatToolInputForTimeline(toolName: string, input: Record<string, unknown> | undefined): string | null {
  if (!input) return null;
  const keyMap: Record<string, string> = {
    Bash: 'command', Read: 'file_path', Write: 'file_path', Edit: 'file_path',
    Glob: 'pattern', Grep: 'pattern', WebFetch: 'url', WebSearch: 'query', Task: 'prompt',
  };
  const key = keyMap[toolName];
  if (key && typeof input[key] === 'string') {
    const line = (input[key] as string).split('\n')[0];
    return line.length > 120 ? line.slice(0, 119) + '\u2026' : line;
  }
  for (const v of Object.values(input)) {
    if (typeof v === 'string' && v.length > 0 && v.length < 200) {
      const line = v.split('\n')[0];
      return line.length > 120 ? line.slice(0, 119) + '\u2026' : line;
    }
  }
  return null;
}

// ===== Session options =====

export interface SessionOptions {
  agentType: AgentType;
  port?: number;
  command?: string;
  gatewayUrl?: string;
  debug?: boolean;
  noUpdateCheck?: boolean;
  wakeWord?: boolean;
  postit?: boolean;
  modules?: ModuleConfigs;
}

// ===== startSession =====

export async function startSession(opts: SessionOptions): Promise<void> {
  const agentType = opts.agentType;

  if (opts.debug) {
    enableDebugLog();
    log('Debug logging enabled');
  }

  // Dependency check (skip for monitor — no PTY needed)
  if (agentType !== 'monitor') {
    const deps = checkDependencies(agentType);
    if (!deps.ok) process.exit(1);
    for (const w of deps.warnings) log(`WARNING: ${w}`);

    // Version compatibility check (Claude Code only — uses npm registry + compatibleClaudeCode range)
    if (agentType === 'claude-code' && !opts.noUpdateCheck) {
      const { checkVersionCompatibility } = await import('./version-check.js');
      const versionResult = await checkVersionCompatibility({
        skipCheck: false,
        claudeCodeVersion: deps.agentVersion,
      });
      for (const w of versionResult.warnings) log(`WARNING: ${w}`);
      if (versionResult.restartNeeded) {
        log('AgentDeck updated. Please restart.');
        process.exit(0);
      }
    }
  }

  // Multi-session port allocation — session bridges reserve 9120 for the daemon
  const requestedPort = opts.port ?? BRIDGE_WS_PORT;
  let port = requestedPort === BRIDGE_WS_PORT ? await findAvailablePort({ reserveDaemon: true }) : requestedPort;

  // Auto-migrate hooks (Claude Code mode only)
  if (agentType === 'claude-code') {
    migrateHooksIfNeeded();
  }

  const tmuxSession = detectTmuxSession();
  const parentTty = (() => {
    try { return execSync('tty', { stdio: ['inherit', 'pipe', 'pipe'] }).toString().trim(); }
    catch { return undefined; }
  })();
  const projectName = resolveProjectName();

  // Warn if same project already has a non-daemon session running
  const existingSessions = listActiveSessions();
  const sameProject = existingSessions.filter((s) =>
    s.projectName === projectName && s.agentType !== 'daemon',
  );
  if (sameProject.length > 0) {
    const ports = sameProject.map((s) => s.port).join(', ');
    log(`\u26A0 Session "${projectName}" already running on port ${ports}. Starting new session on port ${port}.`);
  }

  log(`Starting AgentDeck bridge on port ${port} (agent: ${agentType})...`);

  // ===== Create adapter =====
  const adapter = createAdapter(agentType, opts.gatewayUrl);

  // ===== Start adapter (creates HTTP server, spawns process) =====
  try {
    await adapter.start({ port, command: opts.command, gatewayUrl: opts.gatewayUrl });
    log(`Adapter started: ${adapter.capabilities.displayName}`);
  } catch (err) {
    log(`Failed to start adapter: ${err}`);
    process.exit(1);
  }

  // Suppress stderr logging once PTY is active (PTY adapters share terminal)
  // Non-PTY adapters (Monitor, OpenClaw) keep logs visible
  if (adapter.capabilities.hasTerminal) {
    setPtyMode(true);
  }

  // ===== BridgeCore =====
  const core = new BridgeCore({
    port,
    projectName,
    httpServer: adapter.getHttpServer(),
  });

  // ===== APME (Agent Performance Monitoring & Evaluation) =====
  // Optional: degrades to no-op if better-sqlite3 isn't installed.
  const apme = await initApme();
  if (apme) {
    core.setApme(apme, process.cwd());
    log('APME enabled — runs will be logged to ~/.agentdeck/apme.sqlite');

    // Wire APME eval results → timeline entries (session bridge mode).
    // Daemon has its own richer wiring; this covers standalone session bridges.
    apme.runner.onResult(({ runId, turnId }) => {
      if (turnId) {
        // Turn-level eval completed
        const run = apme.store.getRun(runId);
        if (!run) return;
        const turnEvals = apme.store.listEvalsForTurn(turnId);
        const overall = turnEvals.find(e => e.metric === 'overall');
        if (!overall) return;
        const pct = Math.round(overall.score * 100);
        const axes = turnEvals.filter(e => e.metric !== 'overall');
        const axisStr = axes.map(e => `${e.metric}=${Math.round(e.score * 100)}%`).join(' ');
        core.bridgeTimeline.addEntry({
          ts: Date.now(), type: 'eval_result',
          raw: `★ turn ${pct}% [${run.taskCategory ?? '?'}]`,
          detail: axisStr || `Turn eval · ${run.taskPrompt?.slice(0, 80) ?? ''}`,
          agentType: run.agentType,
        });
      }
    });
  }

  // ===== Session-specific components =====
  const voiceManager = new VoiceManager();
  const utilityProxy = new UtilityProxy();
  const journal = new EventJournal();
  const ptyRingBuffer = new PtyRingBuffer();
  let cachedSlotMap: DeckSlotMapEvent | null = null;
  let previousBridgeState: State = State.IDLE;

  // Timeline log stream (OpenClaw/Claude Code)
  const bridgeLogStream = agentType === 'openclaw' ? new BridgeLogStream() : null;

  // Voice server (non-blocking)
  voiceManager.connectToServer().catch((err) => {
    debug('agentdeck', `whisper-server connection failed: ${err}`);
  });

  // Voice assistant (wake word → STT → LLM → TTS)
  let voiceAssistant: VoiceAssistantManager | null = null;
  if (opts.wakeWord) {
    voiceAssistant = new VoiceAssistantManager({
      sendPrompt: (text) => {
        if (adapter.handleCommand({ type: 'send_prompt', text })) {
          core.stateMachine.handleUserAction('send_prompt');
        } else {
          // Fallback for PTY-based adapters
          adapter.writeInput(text);
          setTimeout(() => adapter.writeInput('\r'), 50);
          core.stateMachine.handleUserAction('send_prompt');
        }
      },
      transcribeFile: (filePath) => voiceManager.transcribeFile(filePath),
      isPttRecording: () => voiceManager.isRecording(),
    });

    // Wire state broadcasts
    voiceAssistant.on('state_change', (info: { state: string; text?: string; responseText?: string }) => {
      // Broadcast dedicated event (for plugin FORWARDED_EVENTS)
      core.broadcast({
        type: 'voice_assistant_state',
        state: info.state,
        deviceId: 'mac-builtin',
        text: info.text,
        responseText: info.responseText,
      } as BridgeEvent);
      // Piggyback on state_update so all clients get it automatically
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

    // Start (non-blocking)
    voiceAssistant.start().then((ok) => {
      if (ok) log('Wake word voice assistant active ("오픈클로")');
      else log('Wake word not available (missing model or access key)');
    }).catch((err) => {
      log(`Wake word start failed: ${err}`);
    });
  }

  // SSE broadcast (ClaudeCodeAdapter / MonitorAdapter have HookServer)
  let hookServer: HookServer | null = null;
  if (adapter instanceof ClaudeCodeAdapter) {
    hookServer = adapter.getClaudeHookServer();
    hookServer.setMeta({ agentType, projectName });
    hookServer.setVoiceManager(voiceManager);
    hookServer.onApiUsage(() => ({ usage: core.cachedApiUsage, fetchedAt: core.lastApiFetchTime }));
    hookServer.pairingToken = core.authToken;
  } else if (adapter instanceof CodexCliAdapter) {
    hookServer = adapter.getCodexHookServer();
    hookServer.setMeta({ agentType, projectName });
    hookServer.setVoiceManager(voiceManager);
    hookServer.pairingToken = core.authToken;
  } else if (adapter instanceof OpenCodeAdapter) {
    hookServer = adapter.getHookServer();
    hookServer.setMeta({ agentType, projectName });
    hookServer.setVoiceManager(voiceManager);
    hookServer.pairingToken = core.authToken;
  } else if (adapter instanceof MonitorAdapter) {
    hookServer = adapter.getHookServer();
    hookServer.setMeta({ agentType, projectName });
    hookServer.setVoiceManager(voiceManager);
    hookServer.onApiUsage(() => ({ usage: core.cachedApiUsage, fetchedAt: core.lastApiFetchTime }));
    hookServer.pairingToken = core.authToken;
  }
  const broadcastSse = (event: BridgeEvent) => hookServer?.broadcastSse(event);
  core.setSseBroadcast(broadcastSse);

  // ===== Display monitor =====
  core.wireDisplayMonitor();

  // ===== Terminal status (tab title + user vars) =====
  const postit = opts.postit !== false && adapter.capabilities.hasTerminal
    ? new TerminalStatus(process.stdout)
    : null;

  // Register process handlers early (before module init) so uncaughtException
  // handler is active before mDNS module starts — suppresses "already in use" errors
  core.registerProcessHandlers('agentdeck');

  // Override unhandledRejection to not shutdown (index.ts original behavior)
  process.removeAllListeners('unhandledRejection');
  process.on('unhandledRejection', (reason) => {
    debug('Bridge', `Unhandled rejection: ${reason}`);
    debug('Bridge', `Unhandled rejection stack: ${reason instanceof Error ? reason.stack : reason}`);
    // Don't shutdown — non-fatal
  });

  // ===== Device modules =====
  const moduleConfigs: ModuleConfigs = opts.modules ?? {
    mdns: false,   // daemon-only — session bridges never advertise mDNS
    adb: 'auto',
    serial: false, // daemon-only — session bridges never talk to ESP32
    pixoo: false,  // daemon-only — session bridges never talk to Pixoo
  };
  const deviceModules = createDefaultModules(agentType);

  // Set up ESP32 state provider before module init
  let lastStateEvent: BridgeEvent | null = null;
  const serialModule = deviceModules.find(m => m.name === 'serial') as SerialModule | undefined;
  if (serialModule) {
    serialModule.setStateProvider(() => lastStateEvent);
    serialModule.setUsageProvider(() => core.buildUsage());
    serialModule.setInitialStateProvider(() => {
      const events: BridgeEvent[] = [];
      if (lastStateEvent) events.push(lastStateEvent);
      events.push(core.buildUsage());
      events.push({ type: 'display_state', displayOn: core.displayMonitor.isDisplayOn() } as BridgeEvent);
      core.broadcastSessionsList().catch(() => {});
      return events;
    });
    // Include ESP32 serial connections in client count for polling guards
    core.setExternalClientCountProvider(() => esp32ConnectionCount());
  }

  const startedModules = await initModules(deviceModules, moduleConfigs, {
    port,
    authToken: core.authToken,
    projectName,
    wsServer: core.wsServer,
    broadcastSse,
  });

  // WiFi auto-provisioning for ESP32
  const wifiConfig = loadWifiConfig();
  if (wifiConfig?.autoProvision) {
    const lanIp = getLanIp();
    onESP32Message((portPath, msg) => {
      if (msg.type === 'device_info' && !msg.wifiConnected) {
        sendWifiProvisionToAll({
          type: 'wifi_provision' as const,
          ssid: wifiConfig.ssid,
          password: wifiConfig.password,
          bridgeIp: lanIp,
          bridgePort: port,
          authToken: core.authToken,
        });
        log(`WiFi provision sent to ESP32 on ${portPath}`);
      } else if (msg.type === 'wifi_provision_ack') {
        log(msg.success ? `ESP32 WiFi connected: ${msg.ip} \u2713` : `ESP32 WiFi failed: ${msg.error || 'unknown'}`);
      }
    });
  }

  log(`WebSocket server ready on port ${port}`);
  log(`Auth token ready. Pairing URL: ${core.wsUrl}`);

  // Device info getter for GET /devices
  hookServer?.setDeviceInfoGetter(() => ({
    devices: [
      { type: 'websocket', count: core.wsServer.getClientCount() },
      { type: 'esp32', count: esp32ConnectionCount(), ports: getESP32Ports() },
      { type: 'pixoo', details: getPixooDeviceDetails() },
      { type: 'adb', count: getAdbDeviceCount() },
    ],
  }));

  // Pixoo live preview frame getter for GET /pixoo/frame
  hookServer?.setPixooFrameGetter(() => getLastFrame() ?? renderPreviewFrame());

  // ===== Diagnostics =====
  adapter.onDiag((tail) => createDiagDump(core.stateMachine, core.wsServer, journal, ptyRingBuffer, tail));
  adapter.onRawData((data: string) => {
    ptyRingBuffer.push(data);
    const preview = data.replace(/[\x00-\x1f\x1b]/g, '').slice(0, 200);
    journal.write('pty_chunk', 'pty', { size: data.length, preview });
  });

  // Voice errors
  voiceManager.on('error', (err: Error) => {
    debug('agentdeck', `Voice error: ${err.message}`);
    core.wsServer.broadcast({ type: 'voice_state', state: 'error', error: err.message } as any);
  });

  // ===== Timeline wiring =====
  core.wireTimeline(bridgeLogStream ?? undefined);

  // Claude Code hook events → timeline entries
  if (agentType === 'claude-code') {
    wireClaudeCodeTimeline(adapter, core, journal, ptyRingBuffer);
  }
  // APME wiring for non-Claude-Code agents (OpenCode, Codex, OpenClaw)
  if (apme && agentType !== 'claude-code' && agentType !== 'monitor') {
    wireAgentApme(adapter, agentType, apme, core, ptyRingBuffer);
  }

  // ===== Wire adapter events → StateMachine + journal =====
  // APME: PTY response fallback — captures response from terminal output when
  // the Stop hook doesn't fire (unreliable in Claude Code v2.1+).
  // Three capture paths handle the hook/PTY race condition:
  //   Path A: idle fires, turn exists → apply directly
  //   Path B: idle fires before hook (fast responses) → buffer, apply on hook arrival
  //   Path C: UserPromptSubmit closes prev turn → apply PTY text to closed turn
  let pendingPtyResponse: string | null = null;
  adapter.on('event', (evt: AdapterEvent) => {
    switch (evt.source) {
      case 'hook':
        journal.write('hook', 'hook', { event: evt.event, data: evt.data });
        // APME ingestion via the shared TelemetrySpan envelope. The Claude
        // hook adapter handles `/clear` (emits a `task_boundary` span) so
        // there's no separate splitRun branch here. Path B/C below preserve
        // the existing PTY-vs-hook race coordination — that's about timing,
        // not ingestion semantics, so it stays in this file.
        if (apme) {
          const ctx = makeApmeAdapterCtx(apme, core.sessionId, agentType);
          for (const span of claudeHookToSpans(ctx, evt.event, evt.data ?? {})) {
            apme.collector.ingestSpan(core.sessionId, span);
          }
        }
        if (evt.event === 'UserPromptSubmit' && apme) {
          // Path B: apply buffered response to the NEW turn (idle fired before hook)
          if (pendingPtyResponse) {
            debug('APME', `hook:UPS Path B: applying pending (${pendingPtyResponse.length} chars)`);
            const ctx = makeApmeAdapterCtx(apme, core.sessionId, agentType);
            const span = claudePtyResponseToSpan(ctx, pendingPtyResponse);
            if (span) apme.collector.ingestSpan(core.sessionId, span);
            pendingPtyResponse = null;
          }
          // Path C: prev turn was just closed by ingestHook — apply pending response
          if (pendingPtyResponse) {
            debug('APME', `hook:UPS Path C: applying pending to closed turn (${pendingPtyResponse.length} chars)`);
            const ctx = makeApmeAdapterCtx(apme, core.sessionId, agentType);
            const span = claudePtyResponseToSpan(ctx, pendingPtyResponse, { fallbackToLastClosed: true });
            if (span) apme.collector.ingestSpan(core.sessionId, span);
            pendingPtyResponse = null;
          }
        }
        if (evt.event === 'Stop') pendingPtyResponse = null; // Stop has cleaner response
        if (evt.event === 'shutdown') {
          shutdown();
          return;
        }
        core.stateMachine.handleHookEvent(evt.event, evt.data);
        break;

      case 'parser':
        journal.write('parser_emit', 'pty', { event: evt.event, ...evt.data });
        core.stateMachine.handleParserEvent(evt.event, evt.data);
        // APME ingestion fallback: PTY parser sees tool use + state changes
        // even when Claude Code hooks are flaky (memory: feedback_apme_stop_hook).
        if (apme && evt.event) {
          const ctx = makeApmeAdapterCtx(apme, core.sessionId, agentType);
          for (const span of claudePtyParserEventToSpans(ctx, evt.event, evt.data ?? {})) {
            apme.collector.ingestSpan(core.sessionId, span);
          }
        }
        // APME: Path A — spinner_stop fires when Claude finishes responding.
        // Delay 500ms to let response render in PTY, then extract text after ⏺ marker.
        if (apme && evt.event === 'spinner_stop') {
          const sid = core.sessionId;
          setTimeout(async () => {
            if (!apme) return;
            const tail = ptyRingBuffer.getTail(5000);
            // Claude's response starts with ⏺ — extract content after last ⏺ marker.
            // Take only meaningful lines (stop at spinner chars ✢✻⏸, prompt ❯, or separator ──).
            const marker = tail.lastIndexOf('⏺');
            let response = '';
            if (marker >= 0) {
              const afterMarker = tail.slice(marker + 1).trim();
              const lines = afterMarker.split('\n');
              const clean: string[] = [];
              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                // Stop at UI artifacts: spinner chars (✢✳✶✻✽), plan mode (⏸), prompt (❯), separator (─)
                if (/^[✢✳✶✻✽⏸⏵❯─>]/.test(trimmed)) break;
                if (/planmode|plan\s*mode|shift\+tab|accept\s*edits/i.test(trimmed)) break;
                // Status text: "Whirring…", "Finagling…", token count, shortcuts hint
                if (/^\S+…(\s|$)/.test(trimmed) && /tokens|shortcuts|\d+[ms]\s/i.test(trimmed)) break;
                if (/\?\s*for\s*shortcuts/.test(trimmed)) break;
                clean.push(trimmed);
              }
              response = clean.join('\n').trim();
            }
            debug('APME', `spinner_stop+500ms: tailLen=${tail.length} marker=${marker} respLen=${response.length}`);
            if (response.length > 2) {
              const turnId = apme.collector.getActiveTurnId(sid);
              if (turnId) {
                const ctx = makeApmeAdapterCtx(apme, sid, agentType);
                const span = claudePtyResponseToSpan(ctx, response);
                if (span) apme.collector.ingestSpan(sid, span);
                pendingPtyResponse = null;
                await classifyAndEnqueueTurn(apme, sid);
              } else {
                pendingPtyResponse = response;
              }
            }
          }, 500);
        }
        break;

      case 'metadata':
        switch (evt.event) {
          case 'cursor_update':
            core.stateMachine.updateCursorIndex((evt.data?.cursorIndex as number) ?? 0, 'pty');
            break;
          case 'usage_info':
            core.usageTracker.setUsageInfo(evt.data);
            core.broadcastUsage();
            apme?.collector.updateUsage(core.sessionId, core.usageTracker.getSnapshot());
            break;
          case 'user_prompt': {
            const text = evt.data?.text as string | undefined;
            if (text) core.broadcast({ type: 'user_prompt', text } as BridgeEvent);
            // APME: user_prompt is the PTY-detected prompt — use it to open a turn
            // and capture the prompt text (fallback for when hooks don't fire).
            if (apme && text) {
              apme.collector.ingestHook(core.sessionId, 'UserPromptSubmit', { message: { content: text } });
            }
            break;
          }
          case 'model_catalog': {
            const models = evt.data?.models as ModelCatalogEntry[] | undefined;
            if (models) {
              core.cachedModelCatalog = models;
              debug('agentdeck', `Model catalog updated: ${models.length} models`);
              const snap = core.stateMachine.getSnapshot();
              const stateEvent = core.buildStateEvent({
                agentType: adapter.capabilities.type,
                snapshot: snap,
              });
              core.broadcast(stateEvent);
              lastStateEvent = stateEvent;
              core.broadcastUsage();
            }
            break;
          }
        }
        break;

      case 'activity':
        core.stateMachine.onPtyActivity();
        break;

      case 'connection': {
        const connEvt: BridgeEvent = { type: 'connection', status: evt.status };
        core.broadcast(connEvt);
        if (evt.status === 'connected' && bridgeLogStream) bridgeLogStream.start();
        else if (evt.status === 'disconnected' && bridgeLogStream) bridgeLogStream.stop();
        break;
      }

      case 'timeline': {
        if (evt.upsert) {
          core.bridgeTimeline.upsertEntry(evt.entry);
        } else {
          core.bridgeTimeline.addEntry(evt.entry);
        }
        if (evt.entry.type === 'tool_request' && bridgeLogStream) {
          bridgeLogStream.trackToolRequest(evt.entry.raw);
        }
        break;
      }
    }
  });

  // Adapter exit — always shutdown (shutdownInProgress guard prevents double-shutdown)
  adapter.on('exit', (code, signal) => {
    log(`Agent process exited (code=${code}, signal=${signal})`);
    shutdown();
  });

  // Default idle button config
  const DEFAULT_IDLE_BUTTONS: { label: string; action: string }[] = [
    { label: 'GO ON', action: 'continue' },
    { label: 'REVIEW', action: '/review' },
    { label: 'COMMIT', action: '/commit' },
    { label: 'CLEAR', action: '/clear' },
  ];

  // ===== Internal WS: push state to daemon =====
  // Port-drift resilient: portProvider is re-invoked on every (re)connect,
  // so the client follows daemon restarts onto fallback ports and the case
  // where the session bridge starts before the daemon is up.
  //
  // Async provider: on cold start the registry may still be empty (session
  // bridge raced the daemon) or the active daemon may be writing its
  // daemon.json into an unreadable dir (App Store group container vs CLI
  // `~/.agentdeck` split). `findDaemonPortAsync` probes 9120-9139 /health
  // as a last resort so the session still attaches instead of staying
  // orphaned.
  const daemonPortProvider = async (): Promise<number | null> => {
    const resolved = await findDaemonPortAsync();
    if (!resolved) return null;
    return resolved.port !== core.port ? resolved.port : null;
  };
  const daemonWsClient = new DaemonWsClient(
    core.sessionId,
    core.port,
    agentType,
    core.projectName,
    daemonPortProvider,
  );
  daemonWsClient.connect(null);
  core.onShutdown(() => { daemonWsClient.close(); });

  // ===== State changed → broadcast =====
  core.stateMachine.on('state_changed', (snapshot: StateSnapshot) => {
    postit?.update(snapshot);
    // Voice assistant: reset timeout on any activity during processing
    if (snapshot.state === State.PROCESSING && voiceAssistant?.getState() === 'processing') {
      voiceAssistant.resetResponseTimeout();
    }

    // PROCESSING→IDLE: fetch fresh usage + voice assistant TTS
    const wasActive = previousBridgeState === State.PROCESSING;
    previousBridgeState = snapshot.state;
    if (wasActive && snapshot.state === State.IDLE) {
      if (core.wsServer.getClientCount() > 0 && Date.now() - core.lastApiFetchTime > 10_000) {
        core.fetchAndUpdateUsage().catch(() => {});
      }

      // Voice assistant: if processing a wake-word prompt, speak the response
      if (voiceAssistant?.getState() === 'processing') {
        const lastEntry = core.bridgeTimeline.getLastEntry('chat_end');
        const responseText = lastEntry?.detail;
        if (responseText) {
          voiceAssistant.handleResponse(responseText).catch((err) => {
            debug('agentdeck', `Voice assistant TTS error: ${err}`);
          });
        } else {
          // No response text available, return to idle
          voiceAssistant.handleResponse('완료했습니다.').catch(() => {});
        }
      }
    }

    hookServer?.setMeta({
      state: snapshot.state,
      modelName: snapshot.modelName ?? undefined,
      effortLevel: snapshot.effortLevel ?? undefined,
    });
    apme?.collector.updateModel(core.sessionId, snapshot.modelName ?? null);
    journal.write('state_change', 'internal', { state: snapshot.state, permissionMode: snapshot.permissionMode, suggestedPrompt: snapshot.suggestedPrompt });

    const stateEvent = core.buildStateEvent({
      agentType: adapter.capabilities.type,
      snapshot,
    });
    core.broadcast(stateEvent);
    lastStateEvent = stateEvent;

    core.maybeBroadcastSessionsList();

    // Backward-compat prompt_options
    if (snapshot.options.length > 0) {
      let promptType: 'yes_no' | 'yes_no_always' | 'multi_select' | 'diff_review' = 'multi_select';
      if (snapshot.state === State.AWAITING_PERMISSION) {
        promptType = snapshot.options.length > 2 ? 'yes_no_always' : 'yes_no';
      } else if (snapshot.state === State.AWAITING_DIFF) {
        promptType = 'diff_review';
      }
      core.broadcast({
        type: 'prompt_options',
        promptType,
        question: snapshot.question ?? undefined,
        options: snapshot.options,
      } as BridgeEvent);
    }

    core.broadcastUsage();

    // Push state to daemon via internal WS
    daemonWsClient.pushState(snapshot.state, snapshot.modelName ?? undefined, snapshot.effortLevel ?? undefined);

    // Encoder + button state
    const encEvt = computeEncoderState();
    core.broadcast(encEvt);
    const btnEvt = computeButtonState();
    core.broadcast(btnEvt);
  });

  // ===== Commands from WS clients =====
  core.wsServer.onCommand((cmd: PluginCommand) => {
    debug('agentdeck', `pluginCmd: ${cmd.type}`);

    // Adapter-owned commands
    if (adapter.handleCommand(cmd)) {
      switch (cmd.type) {
        case 'respond': core.stateMachine.handleUserAction('respond'); break;
        case 'interrupt': core.stateMachine.handleUserAction('interrupt'); break;
        case 'escape': core.stateMachine.handleUserAction('interrupt'); break;
        case 'select_option': core.stateMachine.handleUserAction('select_option'); break;
        case 'send_prompt': core.stateMachine.handleUserAction('send_prompt'); break;
      }
      return;
    }

    // Bridge-coordinated commands
    switch (cmd.type) {
      case 'select_option': {
        const snapshot = core.stateMachine.getSnapshot();
        if (snapshot.navigable) {
          const delta = cmd.index - snapshot.cursorIndex;
          if (delta !== 0) {
            const arrow = delta > 0 ? '\x1b[B' : '\x1b[A';
            adapter.writeInput(arrow.repeat(Math.abs(delta)));
          }
          setTimeout(() => adapter.writeInput('\r'), 50 + Math.abs(delta) * 20);
        } else {
          adapter.writeInput(String(cmd.index + 1) + '\r');
        }
        core.stateMachine.handleUserAction('select_option');
        break;
      }

      case 'navigate_option': {
        const total = core.stateMachine.getOptionsCount();
        const cur = core.stateMachine.getCursorIndex();
        const newIdx = total > 0
          ? (cmd.direction === 'up' ? Math.max(cur - 1, 0) : Math.min(cur + 1, total - 1))
          : cur;
        core.stateMachine.updateCursorIndex(newIdx, 'optimistic');
        adapter.prepareForNavigation?.();
        adapter.writeInput(cmd.direction === 'up' ? '\x1b[A' : '\x1b[B');
        break;
      }

      case 'send_prompt': {
        let text = cmd.text;
        const templateMatch = text.match(/^__template:(\d+)$/);
        if (templateMatch) {
          const idx = parseInt(templateMatch[1], 10);
          if (idx >= 0 && idx < promptTemplates.length) {
            text = promptTemplates[idx].prompt;
          } else break;
        }
        if (text) {
          adapter.writeInput(text);
          setTimeout(() => adapter.writeInput('\r'), 50);
          core.stateMachine.handleUserAction('send_prompt');
        }
        break;
      }

      case 'utility':
        utilityProxy.handleCommand(cmd as UtilityCommand);
        core.broadcast(computeEncoderState());
        break;

      case 'voice':
        handleVoiceCommand(cmd.action, voiceManager, core);
        break;

      case 'query_usage':
        core.fetchAndUpdateUsage().catch(() => {});
        break;
    }
  });

  // Deck slot map relay
  core.wsServer.onRawMessage((msg, sender) => {
    if (msg.type === 'deck_slot_map') {
      cachedSlotMap = msg as unknown as DeckSlotMapEvent;
      core.wsServer.broadcastExcept(cachedSlotMap, sender);
      broadcastSse(cachedSlotMap);
      core.broadcast(computeButtonState());
      // Re-broadcast sessions_list so slot buttons populate after plugin startup race
      core.broadcastSessionsList().catch(() => {});
      return true;
    }
    return false;
  });

  // WS connect/disconnect journal
  core.wsServer.onClientDisconnect(() => {
    journal.write('ws_event', 'ws', { action: 'disconnect', clients: core.wsServer.getClientCount() });
    hookServer?.setMeta({ clientCount: core.wsServer.getClientCount() });
  });

  // Kick initial state
  if (adapter.isAlive()) {
    core.stateMachine.handleHookEvent('SessionStart', {});
  }

  // Register session
  core.registerSession(agentType, {
    tmuxSession,
    parentTty,
    tty: adapter.getTtyPath(),
  });


  // ===== Client connect =====
  core.wsServer.onClientConnect((ws) => {
    journal.write('ws_event', 'ws', { action: 'connect', clients: core.wsServer.getClientCount() });
    hookServer?.setMeta({ clientCount: core.wsServer.getClientCount() });

    const snapshot = core.stateMachine.getSnapshot();

    // Restore suggested prompt on reconnect
    let reconnectSuggestion: string | null = snapshot.suggestedPrompt;
    if (!reconnectSuggestion && snapshot.state === State.IDLE) {
      reconnectSuggestion = core.stateMachine.getLastValidSuggestedPrompt();
    }

    // Build state event with capabilities for initial connect
    const stateEvent = core.buildStateEvent({
      agentType: adapter.capabilities.type,
      agentCapabilities: adapter.capabilities,
      snapshot,
    });
    // Override suggestedPrompt with reconnect value
    if (reconnectSuggestion) {
      (stateEvent as any).suggestedPrompt = reconnectSuggestion;
    }

    // Extra events for initial state
    const extraEvents: BridgeEvent[] = [];

    // Backward-compat prompt_options
    if (snapshot.options.length > 0) {
      let initPromptType: 'yes_no' | 'yes_no_always' | 'multi_select' | 'diff_review' = 'multi_select';
      if (snapshot.state === State.AWAITING_PERMISSION) {
        initPromptType = snapshot.options.length > 2 ? 'yes_no_always' : 'yes_no';
      } else if (snapshot.state === State.AWAITING_DIFF) {
        initPromptType = 'diff_review';
      }
      extraEvents.push({
        type: 'prompt_options',
        promptType: initPromptType,
        question: snapshot.question ?? undefined,
        options: snapshot.options,
      } as BridgeEvent);
    }

    // Encoder + button state
    extraEvents.push(computeEncoderState());
    extraEvents.push(computeButtonState());

    // Slot map
    if (cachedSlotMap) extraEvents.push(cachedSlotMap);

    core.sendInitialState(ws, {
      agentType: adapter.capabilities.type,
      agentCapabilities: adapter.capabilities,
      isAlive: adapter.isAlive(),
      extraEvents,
    });
  });

  // ===== Terminal attachment =====
  if (adapter.capabilities.hasTerminal) {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    adapter.attachTerminal(process.stdin, process.stdout);
  }

  // ===== Polling =====
  core.startUsageTick();
  core.startApiUsagePolling(90_000);
  core.startOllamaProbe();
  core.startMlxProbe();
  core.startAntigravityProbe();
  core.startGatewayProbe(800);
  core.startGatewayHealthCheck();
  core.startSessionsListPolling();

  // Inject virtual OpenClaw session when Gateway is detected (same as daemon-server.ts)
  core.setSessionsEnricher((sessions) => {
    if (!core.cachedGatewayAvailable) return sessions;
    if (sessions.some(s => s.agentType === 'openclaw')) return sessions;
    return [...sessions, {
      id: 'openclaw-gateway',
      port: 18789,
      projectName: 'OpenClaw',
      agentType: 'openclaw' as const,
      alive: true,
    }];
  });

  // ===== Encoder state computation =====
  function computeEncoderState(): EncoderStateEvent {
    const snapshot = core.stateMachine.getSnapshot();
    const isInteractive = snapshot.state === State.AWAITING_OPTION ||
      snapshot.state === State.AWAITING_PERMISSION ||
      snapshot.state === State.AWAITING_DIFF;

    const utilState = utilityProxy.getState();
    const e1: EncoderSlotState = {
      slot: 0, encoderType: 'utility',
      header: utilState.mode.toUpperCase(),
      value: utilState.value, icon: utilState.icon,
      accentColor: '#3b82f6', progress: utilState.level,
    };

    const e2: EncoderSlotState = {
      slot: 1, encoderType: 'action',
      header: 'ACTION', accentColor: '#f59e0b',
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

    const pct5 = core.cachedApiUsage?.fiveHourPercent ?? null;
    const pct7 = core.cachedApiUsage?.sevenDayPercent ?? null;
    const worstPct = Math.max(pct5 ?? 0, pct7 ?? 0);
    const usageColor = worstPct > 80 ? '#ef4444' : worstPct > 50 ? '#eab308' : '#22c55e';
    const e3: EncoderSlotState = {
      slot: 2, encoderType: 'usage',
      header: 'USAGE',
      value: pct5 != null ? `${Math.round(pct5)}% / ${Math.round(pct7 ?? 0)}%` : '\u2014',
      accentColor: usageColor,
      progress: worstPct / 100,
    };

    const isRec = voiceManager.isRecording();
    const e4: EncoderSlotState = {
      slot: 3, encoderType: 'voice',
      header: 'VOICE', value: isRec ? 'Recording...' : 'Ready',
      icon: isRec ? '\uD83D\uDD34' : '\uD83C\uDFA4',
      accentColor: isRec ? '#ef4444' : '#8b5cf6',
      voiceState: isRec ? 'recording' : 'idle',
    };

    return {
      type: 'encoder_state',
      encoders: [e1, e2, e3, e4],
      takeoverActive: isInteractive && snapshot.options.length > 0,
    };
  }

  // ===== Button state computation =====
  function computeButtonState(): ButtonStateEvent {
    const snapshot = core.stateMachine.getSnapshot();
    const st = snapshot.state;
    const mode = snapshot.permissionMode;
    const options = snapshot.options;
    const isInteractive = st === State.AWAITING_OPTION ||
      st === State.AWAITING_PERMISSION ||
      st === State.AWAITING_DIFF;

    const DIM: ButtonSlotState = {
      slot: 0, title: '', bgColor: '#1a1a1a', textColor: '#444444',
      enabled: false, dim: true,
    };

    function getIdleButtons(): { label: string; action: string }[] {
      if (!cachedSlotMap) return DEFAULT_IDLE_BUTTONS;
      const responseSlots = cachedSlotMap.buttons
        .filter(s => s.actionType === 'response-button')
        .sort((a, b) => a.slot - b.slot);
      if (responseSlots.length === 0) return DEFAULT_IDLE_BUTTONS;
      return responseSlots.map((s, i) => ({
        label: (s.settings?.label as string) ?? DEFAULT_IDLE_BUTTONS[i]?.label ?? '',
        action: (s.settings?.action as string) ?? DEFAULT_IDLE_BUTTONS[i]?.action ?? '',
      }));
    }

    function colorForOption(opt: import('./types.js').PromptOption): { bg: string; text: string } {
      const shortcut = (opt.shortcut ?? '').toLowerCase();
      const lower = opt.label.toLowerCase();
      if (lower.startsWith('always')) return { bg: '#1e40af', text: '#ffffff' };
      if (/don[''\u2019]t\s+ask\s+again/i.test(lower)) return { bg: '#1e40af', text: '#ffffff' };
      if (/allow\s+all\s+sessions/i.test(lower)) return { bg: '#1e40af', text: '#ffffff' };
      if (shortcut === 'n' || shortcut === 'd' || lower.startsWith('no') || lower.startsWith('deny')) return { bg: '#991b1b', text: '#ffffff' };
      if (shortcut === 'y' || shortcut === 'a') return { bg: '#166534', text: '#ffffff' };
      if (opt.recommended) return { bg: '#1e4d2b', text: '#86efac' };
      return { bg: '#1e3a5f', text: '#93c5fd' };
    }

    function uppercaseShort(label: string): string {
      return label.length <= 12 ? label.toUpperCase() : label;
    }

    const buttons: ButtonSlotState[] = [];

    // Slot 0: Mode
    const modeColors: Record<string, string> = {
      default: '#2a2a2a', plan: '#7c3aed', acceptEdits: '#2563eb',
      dontAsk: '#0e7490', bypassPermissions: '#991b1b',
    };
    const modeLabels: Record<string, string> = {
      default: 'DEFAULT', plan: 'PLAN', acceptEdits: 'ACCEPT',
      dontAsk: "DON'T ASK", bypassPermissions: 'BYPASS',
    };
    const modeEnabled = st === State.IDLE;
    buttons.push({
      slot: 0,
      title: modeLabels[mode] ?? 'DEFAULT',
      subtitle: 'Mode',
      bgColor: modeEnabled ? (modeColors[mode] ?? '#2a2a2a') : '#1a1a1a',
      textColor: modeEnabled ? '#ffffff' : '#444444',
      enabled: modeEnabled,
      action: modeEnabled ? 'switch_mode' : undefined,
      dim: !modeEnabled,
    });

    // Slot 1: Session/Status
    if (st === State.IDLE) {
      // Skip model-agnostic neutral levels — "medium" (legacy default) and "default"
      // (Claude Code 2.1+ name for the per-model default). Show everything else
      // including max/xhigh/high/low/fast as an informational suffix.
      const effortSuffix = snapshot.effortLevel
        && snapshot.effortLevel !== 'medium'
        && snapshot.effortLevel !== 'default'
        ? snapshot.effortLevel : null;
      const sessionSubtitle = effortSuffix && snapshot.modelName
        ? `${snapshot.modelName} \u00B7 ${effortSuffix}` : snapshot.modelName ?? undefined;
      buttons.push({
        slot: 1, title: snapshot.projectName ?? '\u2014',
        subtitle: sessionSubtitle, bgColor: '#1e293b', textColor: '#ffffff', enabled: false,
      });
    } else if (st === State.PROCESSING) {
      buttons.push({
        slot: 1, title: snapshot.currentTool ?? '...',
        subtitle: snapshot.toolProgress ?? undefined,
        bgColor: '#1e3a5f', textColor: '#93c5fd', enabled: false,
      });
    } else if (st === State.AWAITING_PERMISSION || st === State.AWAITING_DIFF) {
      buttons.push({ slot: 1, title: 'PERMIT?', bgColor: '#b45309', textColor: '#ffffff', enabled: false });
    } else if (st === State.AWAITING_OPTION) {
      buttons.push({ slot: 1, title: 'SELECT', bgColor: '#b45309', textColor: '#ffffff', enabled: false });
    } else {
      buttons.push({ ...DIM, slot: 1 });
    }

    // Slot 2: Usage
    const pct = core.cachedApiUsage?.fiveHourPercent ?? null;
    const usageText = pct != null ? `${Math.round(pct)}%` : '\u2014';
    const usageBg = pct == null ? '#1e293b' : pct >= 90 ? '#991b1b' : pct >= 70 ? '#92400e' : '#166534';
    buttons.push({ slot: 2, title: usageText, subtitle: '5h', bgColor: usageBg, textColor: '#ffffff', enabled: false });

    // Slots 3-6: Response buttons
    if (st === State.IDLE) {
      const idleBtns = getIdleButtons();
      for (let i = 0; i < 4; i++) {
        const btn = idleBtns[i];
        if (btn) {
          const isGoOn = btn.action === 'continue' || btn.label.toLowerCase() === 'go on';
          buttons.push({
            slot: 3 + i, title: btn.label,
            bgColor: isGoOn ? '#1e3a2f' : '#1e293b',
            textColor: isGoOn ? '#22c55e' : '#ffffff',
            enabled: true, action: `command:${btn.action === 'continue' ? 'go on' : btn.action}`,
          });
        } else {
          buttons.push({ ...DIM, slot: 3 + i });
        }
      }
    } else if (st === State.PROCESSING) {
      for (let i = 0; i < 4; i++) buttons.push({ ...DIM, slot: 3 + i });
    } else if (isInteractive) {
      if (options.length === 0 && st === State.AWAITING_PERMISSION) {
        buttons.push({ slot: 3, title: 'YES', bgColor: '#166534', textColor: '#ffffff', enabled: true, action: 'respond:y' });
        buttons.push({ slot: 4, title: 'NO', bgColor: '#991b1b', textColor: '#ffffff', enabled: true, action: 'respond:n' });
        buttons.push({ slot: 5, title: 'ALWAYS', bgColor: '#1e40af', textColor: '#ffffff', enabled: true, action: 'respond:a' });
        buttons.push({ ...DIM, slot: 6 });
      } else if (options.length === 0 && st === State.AWAITING_DIFF) {
        buttons.push({ slot: 3, title: 'APPLY', bgColor: '#166534', textColor: '#ffffff', enabled: true, action: 'respond:a' });
        buttons.push({ slot: 4, title: 'DENY', bgColor: '#991b1b', textColor: '#ffffff', enabled: true, action: 'respond:d' });
        buttons.push({ slot: 5, title: 'VIEW', bgColor: '#1e3a5f', textColor: '#93c5fd', enabled: true, action: 'respond:v' });
        buttons.push({ ...DIM, slot: 6 });
      } else if (options.length <= 4) {
        for (let i = 0; i < 4; i++) {
          if (i < options.length) {
            const opt = options[i];
            const colors = (st === State.AWAITING_PERMISSION || st === State.AWAITING_DIFF)
              ? colorForOption(opt) : opt.recommended ? { bg: '#1e4d2b', text: '#86efac' } : { bg: '#1e3a5f', text: '#93c5fd' };
            const action = snapshot.navigable
              ? `select_option:${opt.index}` : `respond:${opt.shortcut || opt.label.charAt(0).toLowerCase()}`;
            buttons.push({
              slot: 3 + i, title: uppercaseShort(opt.label),
              bgColor: colors.bg, textColor: colors.text,
              enabled: true, badge: opt.recommended ? '\u2605' : opt.selected ? '\u2713' : undefined,
              action,
            });
          } else {
            buttons.push({ ...DIM, slot: 3 + i });
          }
        }
      } else {
        for (let i = 0; i < 3; i++) {
          const opt = options[i];
          const colors = (st === State.AWAITING_PERMISSION || st === State.AWAITING_DIFF)
            ? colorForOption(opt) : opt.recommended ? { bg: '#1e4d2b', text: '#86efac' } : { bg: '#1e3a5f', text: '#93c5fd' };
          const action = snapshot.navigable
            ? `select_option:${opt.index}` : `respond:${opt.shortcut || opt.label.charAt(0).toLowerCase()}`;
          buttons.push({
            slot: 3 + i, title: uppercaseShort(opt.label),
            bgColor: colors.bg, textColor: colors.text, enabled: true, action,
          });
        }
        buttons.push({ slot: 6, title: 'MORE \u25BC', bgColor: '#334155', textColor: '#94a3b8', enabled: true, action: 'expand_options' });
      }
    } else {
      for (let i = 0; i < 4; i++) buttons.push({ ...DIM, slot: 3 + i });
    }

    // Slot 7: Stop/ESC
    if (st === State.PROCESSING) {
      buttons.push({ slot: 7, title: 'STOP', bgColor: '#cc0000', textColor: '#ffffff', enabled: true, action: 'interrupt' });
    } else if (isInteractive) {
      buttons.push({ slot: 7, title: 'ESC', bgColor: '#b45309', textColor: '#ffffff', enabled: true, action: 'escape' });
    } else if (st === State.IDLE) {
      buttons.push({ slot: 7, title: 'ESC', bgColor: '#3d2607', textColor: '#ffb347', enabled: true, action: 'escape', dim: false });
    } else {
      buttons.push({ ...DIM, slot: 7 });
    }

    return { type: 'button_state', buttons };
  }

  // ===== Shutdown =====

  let shutdownInProgress = false;

  function shutdown(): void {
    if (shutdownInProgress) return;
    shutdownInProgress = true;

    // Hard failsafe — exit no matter what after 3s
    setTimeout(() => process.exit(0), 3000).unref();

    log('Shutting down...');

    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdin.removeAllListeners();

    postit?.cleanup();
    utilityProxy.cleanup();
    voiceAssistant?.stop();
    voiceManager.disconnectFromServer();
    bridgeLogStream?.stop();
    journal.close();

    core.onShutdown(async () => {
      await Promise.all([
        adapter.shutdown(),
        stopModules(startedModules).catch(() => {}),
      ]);
      process.exit(0);
    });
    core.shutdown();
  }

}

// Mid-session classify + turn-level eval enqueue.
// Shared between Claude spinner_stop, OpenClaw/OpenCode chat_response, and Codex spinner_stop
// so all agents get the same turns.task_category stamping and non-code turn_judge evals.
async function classifyAndEnqueueTurn(
  apme: import('./apme/index.js').ApmeModule,
  sid: string,
): Promise<void> {
  const turnId = apme.collector.getActiveTurnId(sid);
  const runId = apme.collector.getRunId(sid);
  if (!turnId || !runId) return;
  const run = apme.store.getRun(runId);
  if (!run) return;

  let category = run.taskCategory ?? null;
  if (!category) {
    try {
      const { classifyRun } = await import('./apme/classifier.js');
      const { category: c, signals } = classifyRun(apme.store, run.id);
      if (c && c !== 'unknown') {
        category = c;
        apme.store.updateRun(run.id, {
          taskCategory: c,
          taskSignals: JSON.stringify(signals),
          taskCategorySource: 'rule',
        });
      }
    } catch (err) {
      debug('APME', `mid-session classify failed: ${String(err)}`);
    }
  }
  if (category) {
    try { apme.store.updateTurn(turnId, { taskCategory: category }); }
    catch { /* ignore */ }
  }
  const NON_CODE = new Set(['conversation', 'planning', 'research', 'review']);
  if (category && NON_CODE.has(category)) {
    apme.runner.enqueueTurn({ runId: run.id, turnId, category });
  }
}

// ===== Non-Claude agent APME wiring =====
// For OpenCode, Codex, OpenClaw: intercepts adapter timeline events to create
// APME turns with prompts and responses. Claude Code uses hooks instead.

// Delay between the Codex parser's idle event and the bridge closing the
// active turn. The parser fires idle on any `›\s` match — including the
// status line shown mid-processing — so we wait this long before committing
// chat_end. A new spinner_start within the window cancels the close, which
// is how we differentiate spurious mid-turn idles from real turn ends.
const CODEX_IDLE_CLOSE_DELAY_MS = 1500;
// Upper bound on the tool-silence flag's lifetime. If Codex finishes the
// final tool and prints the response WITHOUT re-engaging the spinner, no
// spinner_start arrives to clear the flag and any prompt-idle is suppressed.
// After this window we clear the flag defensively and replay the suppressed
// idle so the turn closes — at the cost of splitting genuine bash runs that
// exceed this duration.
const CODEX_TOOL_SILENCE_MAX_MS = 15_000;

function wireAgentApme(
  adapter: import('./types.js').AgentAdapter,
  agentType: import('@agentdeck/shared').AgentType,
  apme: import('./apme/index.js').ApmeModule,
  core: BridgeCore,
  ptyRingBuffer: PtyRingBuffer,
): void {
  const sid = core.sessionId;
  let codexChatStart: number | null = null;
  let codexLastPromptText: string | null = null;
  // Codex turn-boundary state. spinner_stop is not the turn end (Ink TUI
  // pauses the spinner whenever a bash command runs); idle is. The status
  // line that Codex prints during processing can also match the parser's
  // IDLE_PROMPT (`›\s`), so a single idle event is not enough — we defer
  // the close by `CODEX_IDLE_CLOSE_DELAY_MS` and cancel the timer if a new
  // spinner_start arrives.
  let codexIdleCloseTimer: ReturnType<typeof setTimeout> | null = null;
  // True between a spinner-timeout idle and the next spinner_start. Marks
  // periods when Codex's spinner went silent because a tool (bash, file op)
  // is running, not because the turn ended. Prompt-source idles that arrive
  // during this window — e.g., a stale `›` frame surfacing while bash is
  // mid-flight — must be ignored, otherwise the deferred close fires before
  // Codex has a chance to resume.
  let codexInToolSilence = false;
  // Reset on every spinner_start, set on every tool_action. A timeout-idle
  // is treated as tool silence only when this flag is true — otherwise the
  // silence is a normal end-of-thinking quiet (Codex finished the response
  // without spinning again) and must not block the next prompt-idle close.
  let codexToolActiveSinceLastSpinner = false;
  // Auto-clear timer for codexInToolSilence. Set when entering tool silence;
  // cleared on spinner_start. If it fires, Codex has been silent past the
  // grace window — assume the tool finished and the turn ended without a
  // spinner re-engagement (e.g. tool output IS the final response).
  let codexToolSilenceTimer: ReturnType<typeof setTimeout> | null = null;
  // Latches a prompt-source idle that arrived while codexInToolSilence was
  // true. If the silence later resolves via the auto-clear timer (= turn
  // really did end after the tool), we replay it as a deferred close. On
  // spinner_start with a latched pending, we close the previous turn now
  // so it doesn't merge with the next one.
  let codexPendingPromptIdle = false;
  // PTY tail captured at the moment the prompt-idle was latched. By the
  // time we replay (auto-clear timer or next spinner_start) the live PTY
  // ringbuffer holds the user's next prompt and Codex's new processing,
  // which would contaminate turn N's chat_response. The snapshot pins
  // turn N's tail at the right boundary.
  let codexPendingTailSnapshot: string | null = null;

  const ensureCodexChatStart = (text?: string): number => {
    if (codexChatStart) {
      if (text && !codexLastPromptText) {
        codexLastPromptText = text;
        const raw = text.length > 500 ? text.slice(0, 497) + '...' : text;
        const detail = text.length > 100
          ? (text.length > 1000 ? text.slice(0, 997) + '...' : text)
          : undefined;
        core.bridgeTimeline.upsertEntry({
          ts: codexChatStart,
          type: 'chat_start',
          raw,
          ...(detail ? { detail } : {}),
          agentType: 'codex-cli',
          startedAt: codexChatStart,
        });
      }
      return codexChatStart;
    }
    const now = Date.now();
    codexChatStart = now;
    codexLastPromptText = text || null;
    const raw = text
      ? (text.length > 500 ? text.slice(0, 497) + '...' : text)
      : 'Codex turn started';
    const detail = text && text.length > 100
      ? (text.length > 1000 ? text.slice(0, 997) + '...' : text)
      : undefined;
    core.bridgeTimeline.addEntry({
      ts: now,
      type: 'chat_start',
      raw,
      ...(detail ? { detail } : {}),
      agentType: 'codex-cli',
      startedAt: now,
    });
    return now;
  };

  // Close the Codex turn that started at `startedAt`: extract the response
  // tail (from the live PTY ringbuffer or a passed snapshot), emit
  // chat_response + chat_end timeline entries, and ingest the response
  // span. The snapshot path is used when closing in response to a delayed
  // signal (auto-clear timer or next spinner_start) — by that point the
  // live ringbuffer contains content from turn N+1 that would contaminate
  // turn N's response.
  const closeCodexTurn = (startedAt: number, tailSnapshot?: string): void => {
    if (codexChatStart !== startedAt) return;
    const endedAt = Date.now();
    codexChatStart = null;
    codexLastPromptText = null;
    const ctx = makeApmeAdapterCtx(apme, sid, agentType);
    const tail = tailSnapshot ?? ptyRingBuffer.getTail(5000);
    const lines = tail.split('\n').map(l => l.trim()).filter(Boolean);
    // Filter out spinner/UI artifacts from tail (Codex PTY output)
    const clean = lines.filter(l =>
      !/^[✢✳✶✻✽⏸⏵❯─>]/.test(l) &&
      !/planmode|plan\s*mode|shift\+tab|accept\s*edits/i.test(l) &&
      !/\?\s*for\s*shortcuts/.test(l),
    );
    const response = clean.slice(-5).join('\n');
    if (response.length > 2) {
      const span = claudePtyResponseToSpan(ctx, response);
      if (span) apme.collector.ingestSpan(sid, span);
      void classifyAndEnqueueTurn(apme, sid);
      const respRaw = response.length > 200 ? response.slice(0, 197) + '...' : response;
      core.bridgeTimeline.addEntry({
        ts: endedAt - 1,
        type: 'chat_response',
        raw: cleanRawText(respRaw),
        detail: cleanDetailText(response.slice(0, 3000)) || undefined,
        agentType: 'codex-cli',
        startedAt,
        endedAt,
      });
    }
    const duration = Math.round((endedAt - startedAt) / 1000);
    const topicHint = response ? extractTopicHint(response) : null;
    const label = topicHint || 'Codex turn completed';
    core.bridgeTimeline.addEntry({
      ts: endedAt,
      type: 'chat_end',
      raw: `${label} · ${duration}s`,
      detail: response.length > 2 ? cleanDetailText(response.slice(0, 1000)) || undefined : undefined,
      agentType: 'codex-cli',
      startedAt,
      endedAt,
    });
  };

  const scheduleCodexClose = (startedAt: number, tailSnapshot?: string): void => {
    if (codexIdleCloseTimer) clearTimeout(codexIdleCloseTimer);
    codexIdleCloseTimer = setTimeout(() => {
      codexIdleCloseTimer = null;
      closeCodexTurn(startedAt, tailSnapshot);
    }, CODEX_IDLE_CLOSE_DELAY_MS);
  };

  const exitCodexToolSilence = (): void => {
    codexInToolSilence = false;
    if (codexToolSilenceTimer) {
      clearTimeout(codexToolSilenceTimer);
      codexToolSilenceTimer = null;
    }
  };

  adapter.on('event', (evt: import('./types.js').AdapterEvent) => {
    // ── Timeline events (OpenCode / OpenClaw) ──
    // Both adapters emit { source: 'timeline', entry: TimelineEntry }.
    // The timeline adapter normalizes them to AgentDeck telemetry spans.
    if (evt.source === 'timeline' && evt.entry) {
      const entry = evt.entry as import('@agentdeck/shared').TimelineEntry;
      const ctx = makeApmeAdapterCtx(apme, sid, agentType);
      for (const span of timelineEntryToSpans(ctx, entry)) {
        apme.collector.ingestSpan(sid, span);
      }
      // Mid-session classification still runs once we've captured a response.
      if (entry.type === 'chat_response') {
        void classifyAndEnqueueTurn(apme, sid);
      }
    }

    // ── Codex: PTY parser fallback ──
    if (evt.source === 'parser' && (agentType as string) === 'codex-cli') {
      if (evt.event === 'spinner_start') {
        // Codex resumed work. Two cases:
        //   1. A prompt-idle was suppressed by tool-silence and now spinner
        //      is starting fresh — that's the user submitting the NEXT
        //      prompt, so the previous turn really did end. Close it
        //      synchronously before opening the new one (using the tail
        //      snapshot taken at latch time so the response doesn't pick
        //      up turn N+1's input), otherwise the new turn inherits the
        //      old chat_start and the two turns merge in the timeline.
        //   2. No pending suppression — Codex is just continuing the same
        //      turn (e.g. resuming after a bash result). Cancel any pending
        //      deferred close (status-line false positive) and keep the
        //      existing chat_start.
        if (codexPendingPromptIdle && codexChatStart !== null) {
          const prevStart = codexChatStart;
          const snapshot = codexPendingTailSnapshot;
          closeCodexTurn(prevStart, snapshot ?? undefined);
        }
        // Always reset pending state on spinner_start: either we just
        // consumed it, or codexChatStart was null and the pending state
        // was stale from a prior turn that closed via another path.
        codexPendingPromptIdle = false;
        codexPendingTailSnapshot = null;
        if (codexIdleCloseTimer) {
          clearTimeout(codexIdleCloseTimer);
          codexIdleCloseTimer = null;
        }
        exitCodexToolSilence();
        codexToolActiveSinceLastSpinner = false;
        ensureCodexChatStart();
      }
      if (evt.event === 'tool_action') {
        const now = Date.now();
        const data = (evt.data ?? {}) as Record<string, unknown>;
        const tool = typeof data.tool === 'string' && data.tool ? data.tool : 'tool';
        const args = typeof data.args === 'string' ? data.args : '';
        const raw = args ? `${tool} ${args}` : tool;
        ensureCodexChatStart();
        codexToolActiveSinceLastSpinner = true;
        core.bridgeTimeline.addEntry({
          ts: now,
          type: 'tool_request',
          raw: raw.length > 500 ? raw.slice(0, 497) + '...' : raw,
          detail: args && args !== raw ? args.slice(0, 1000) : undefined,
          agentType: 'codex-cli',
          ...(codexChatStart ? { startedAt: codexChatStart } : {}),
        });
      }
      if (evt.event === 'idle') {
        // The parser emits two flavours: `source: 'prompt'` when the input
        // prompt actually appeared (real turn end) and `source: 'timeout'`
        // when the spinner went silent (typically mid-turn while a tool is
        // running). Mark tool silence on timeout so prompt idles arriving
        // before the next spinner_start are ignored — those are stale `›`
        // frames or status-line redraws, not the real turn end.
        const idleSource = (evt.data as Record<string, unknown> | undefined)?.source;
        if (idleSource === 'timeout') {
          // Only treat the silence as mid-tool if a tool actually ran in
          // this thinking segment. End-of-turn quiet (final response with
          // no further spinning) also produces a timeout idle and must NOT
          // block the next prompt-idle close.
          if (codexToolActiveSinceLastSpinner) {
            codexInToolSilence = true;
            // Bound the silence: if no spinner_start arrives within the
            // grace window, Codex finished the tool and ended the turn
            // without re-engaging the spinner (e.g. tool output IS the
            // final response). On timer fire we clear the flag and replay
            // any suppressed prompt-idle as a deferred close.
            if (codexToolSilenceTimer) clearTimeout(codexToolSilenceTimer);
            codexToolSilenceTimer = setTimeout(() => {
              codexToolSilenceTimer = null;
              codexInToolSilence = false;
              if (codexPendingPromptIdle) {
                const snapshot = codexPendingTailSnapshot;
                codexPendingPromptIdle = false;
                codexPendingTailSnapshot = null;
                if (codexChatStart !== null) {
                  // Close immediately rather than via scheduleCodexClose:
                  // we already waited the full silence window, and any
                  // further deferral would let a quickly-typed next prompt
                  // (its spinner_start cancels codexIdleCloseTimer) drop
                  // the close entirely.
                  closeCodexTurn(codexChatStart, snapshot ?? undefined);
                }
              }
            }, CODEX_TOOL_SILENCE_MAX_MS);
          }
          return;
        }
        if (idleSource !== 'prompt') return;
        if (codexChatStart === null) return;
        if (codexInToolSilence) {
          // Latch this prompt-idle, with a PTY tail snapshot pinned to
          // *this* moment. Either the auto-clear timer will replay it
          // (turn really ended without re-spinning) or the next
          // spinner_start will close turn N before opening N+1. Both
          // paths use the snapshot — the live tail by then would be
          // contaminated with N+1's input/processing.
          codexPendingPromptIdle = true;
          codexPendingTailSnapshot = ptyRingBuffer.getTail(5000);
          return;
        }
        // Defer the close. A new spinner_start within the delay cancels
        // this timer, which is how we reject status-line false positives
        // (the status row also matches IDLE_PROMPT) without a wall-clock
        // guard that would also drop real fast turns.
        scheduleCodexClose(codexChatStart);
      }
    }
  });
}

/** Build the AdapterContext used by every APME ingestion adapter. The
 *  trace id mirrors the active run id so future OTLP exports tie spans
 *  emitted in the same session together. `cwd` falls back to `process.cwd()`
 *  because the bridge is started from the project directory. */
function makeApmeAdapterCtx(
  apme: import('./apme/index.js').ApmeModule,
  sid: string,
  agentType: AgentType,
): ApmeAdapterContext {
  return {
    sessionId: sid,
    agentType,
    traceId: apme.collector.getRunId(sid) ?? sid,
    cwd: process.cwd(),
    activeTurnId: apme.collector.getActiveTurnId(sid) ?? undefined,
  };
}

// ===== Claude Code timeline wiring =====

function wireClaudeCodeTimeline(
  adapter: import('./types.js').AgentAdapter,
  core: BridgeCore,
  journal: EventJournal,
  ptyRingBuffer: PtyRingBuffer,
): void {
  let ccChatStart: number | null = null;
  let ccPendingChatStart = false;
  let ccPendingChatStartTimer: ReturnType<typeof setTimeout> | null = null;
  let ccLastPromptText: string | null = null;
  let ccLastHookToolTs = 0;          // Change 1: track last hook-based tool_request
  let ccPendingCompletion = false;   // Change 2: track pending chat_end for PTY fallback
  let ccPendingCompletionTimer: ReturnType<typeof setTimeout> | null = null;

  const emitChatStart = (text: string) => {
    if (ccPendingChatStartTimer) {
      clearTimeout(ccPendingChatStartTimer);
      ccPendingChatStartTimer = null;
    }
    ccPendingChatStart = false;
    ccLastPromptText = text || null;
    const snippet = text.length > 500 ? text.slice(0, 497) + '...' : text;
    const detail = text.length > 100 ? (text.length > 1000 ? text.slice(0, 1000) + '...' : text) : undefined;
    // Change 4: better fallback text — include project name
    const fallbackRaw = (() => {
      const proj = core.stateMachine.getSnapshot().projectName;
      return proj ? `Prompt \u00B7 ${proj}` : 'Prompt sent';
    })();
    core.bridgeTimeline.addEntry({
      ts: ccChatStart ?? Date.now(), type: 'chat_start',
      raw: snippet || fallbackRaw,
      ...(detail ? { detail } : {}),
      agentType: 'claude-code',
      startedAt: ccChatStart ?? Date.now(),
    });
  };

  /** Extract response text from PTY ringbuffer after ⏺ marker (same pattern as APME) */
  const extractPtyResponse = (): string => {
    const tail = ptyRingBuffer.getTail(5000);
    const marker = tail.lastIndexOf('⏺');
    if (marker < 0) return '';
    const afterMarker = tail.slice(marker + 1).trim();
    const lines = afterMarker.split('\n');
    const clean: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^[✢✳✶✻✽⏸⏵❯─>]/.test(trimmed)) break;
      if (/planmode|plan\s*mode|shift\+tab|accept\s*edits/i.test(trimmed)) break;
      if (/^\S+…(\s|$)/.test(trimmed) && /tokens|shortcuts|\d+[ms]\s/i.test(trimmed)) break;
      if (/\?\s*for\s*shortcuts/.test(trimmed)) break;
      clean.push(trimmed);
    }
    return clean.join('\n').trim();
  };

  /** Emit chat_response + chat_end from response text (shared by Stop hook and PTY fallback) */
  const emitCompletion = (responseText: string, duration: number | null, toolSummary: string) => {
    const now = Date.now();
    const startedAt = ccChatStart ?? undefined;

    // Change 5: emit chat_response if meaningful response text exists
    if (responseText.length > 20) {
      const respRaw = responseText.length > 200 ? responseText.slice(0, 197) + '...' : responseText;
      core.bridgeTimeline.addEntry({
        ts: now - 1, type: 'chat_response',
        raw: cleanRawText(respRaw),
        detail: cleanDetailText(responseText.slice(0, 3000)) || undefined,
        agentType: 'claude-code',
        ...(startedAt ? { startedAt } : {}),
        endedAt: now,
      });
    }

    const topicHint = responseText ? extractTopicHint(responseText) : null;
    const promptTopic = ccLastPromptText ? extractTopicHint(ccLastPromptText) : null;
    const completedLabel = topicHint || promptTopic || 'Completed';
    let summary = duration != null ? `${completedLabel} \u00B7 ${duration}s` : completedLabel;
    if (toolSummary) summary += ` \u00B7 ${toolSummary}`;
    const chatEndDetail = responseText
      ? (() => { const c = cleanDetailText(responseText); return c ? (c.length > 1000 ? c.slice(0, 1000) + '...' : c) : undefined; })()
      : ccLastPromptText
        ? `Prompt: ${ccLastPromptText.length > 200 ? ccLastPromptText.slice(0, 200) + '...' : ccLastPromptText}`
        : undefined;
    const chatEndTs = now;
    ccChatStart = null;
    ccLastPromptText = null;
    core.bridgeTimeline.addEntry({
      ts: chatEndTs, type: 'chat_end', raw: summary,
      ...(chatEndDetail ? { detail: chatEndDetail } : {}),
      agentType: 'claude-code',
      ...(startedAt ? { startedAt } : {}),
      endedAt: chatEndTs,
    });

    // Async LLM summarization — fire-and-forget, upsert chat_end when ready
    if (responseText && responseText.length > 30) {
      const savedDuration = duration;
      const savedToolSummary = toolSummary;
      const savedDetail = chatEndDetail;
      summarizeResponse(responseText).then((llmSummary) => {
        if (llmSummary) {
          const enrichedParts = [llmSummary];
          if (savedDuration != null) enrichedParts.push(`${savedDuration}s`);
          if (savedToolSummary) enrichedParts.push(savedToolSummary);
          debug('timeline', `CC LLM summary: ${llmSummary}`);
          core.bridgeTimeline.upsertEntry({
            ts: chatEndTs, type: 'chat_end',
            raw: enrichedParts.join(' \u00B7 '),
            ...(savedDetail ? { detail: savedDetail } : {}),
            agentType: 'claude-code',
            ...(startedAt ? { startedAt } : {}),
            endedAt: chatEndTs,
          });
        }
      }).catch(() => { /* summarization failed — keep heuristic */ });
    }
  };

  // Change 4: late upsert — user_prompt metadata arriving after 500ms timer
  adapter.on('event', (evt: AdapterEvent) => {
    if (evt.source === 'metadata' && evt.event === 'user_prompt') {
      const text = (evt.data?.text as string) || '';
      if (ccPendingChatStart) {
        emitChatStart(text);
      } else if (ccChatStart && Date.now() - ccChatStart < 5000 && text) {
        // Late arrival — upsert chat_start with actual prompt text
        const snippet = text.length > 500 ? text.slice(0, 497) + '...' : text;
        core.bridgeTimeline.upsertEntry({
          ts: ccChatStart, type: 'chat_start',
          raw: snippet, agentType: 'claude-code',
        });
        ccLastPromptText = text;
      }
    }
  });

  // Change 1: PTY tool_action → tool_exec timeline entry (fills gap when hooks don't fire)
  adapter.on('event', (evt: AdapterEvent) => {
    if (evt.source !== 'parser' || evt.event !== 'tool_action') return;
    const now = Date.now();
    // Skip if hook already emitted tool_request within 2s (avoid duplicates)
    if (now - ccLastHookToolTs < 2000) return;
    const toolName = (evt.data?.toolName as string) || 'tool';
    const toolArgs = (evt.data?.toolArgs as string) || '';
    const raw = toolArgs ? `${toolName} ${toolArgs}` : toolName;
    core.bridgeTimeline.addEntry({
      ts: now, type: 'tool_exec',
      raw: raw.length > 500 ? raw.slice(0, 497) + '...' : raw,
      agentType: 'claude-code',
    });
  });

  // Change 2: PTY fallback chat_end from spinner_stop/idle (when Stop hook doesn't fire)
  adapter.on('event', (evt: AdapterEvent) => {
    if (evt.source !== 'parser') return;
    if ((evt.event === 'spinner_stop' || evt.event === 'idle') && ccPendingCompletion) {
      // Wait 1.5s — Stop hook may still arrive
      if (ccPendingCompletionTimer) clearTimeout(ccPendingCompletionTimer);
      ccPendingCompletionTimer = setTimeout(() => {
        ccPendingCompletionTimer = null;
        if (!ccPendingCompletion) return; // Stop hook already handled it
        ccPendingCompletion = false;
        if (ccPendingChatStart) emitChatStart('');
        const now = Date.now();
        const duration = ccChatStart ? Math.round((now - ccChatStart) / 1000) : null;
        const toolSummary = core.usageTracker.getToolSummary();
        // Extract response from PTY ringbuffer
        const responseText = extractPtyResponse();
        debug('timeline', `CC PTY fallback chat_end: respLen=${responseText.length} duration=${duration}`);
        emitCompletion(responseText, duration, toolSummary);
      }, 1500);
    }
  });

  adapter.on('event', (evt: AdapterEvent) => {
    if (evt.source !== 'hook') return;
    const now = Date.now();
    switch (evt.event) {
      case 'UserPromptSubmit': {
        ccChatStart = now;
        core.usageTracker.resetToolCounts();
        ccPendingChatStart = true;
        ccPendingCompletion = true;  // Change 2: arm PTY fallback
        // Claude Code v2.1+ sends { message: { content: "..." } }, not { prompt: "..." }
        const msg = evt.data?.message;
        const hookText = (evt.data?.prompt as string)
          || (evt.data?.text as string)
          || (typeof msg === 'object' && msg !== null ? (msg as Record<string, unknown>).content as string : undefined)
          || (typeof msg === 'string' ? msg : '')
          || '';
        ccPendingChatStartTimer = setTimeout(() => {
          if (ccPendingChatStart) emitChatStart(hookText);
        }, 500);
        break;
      }
      case 'PreToolUse': {
        ccLastHookToolTs = now;  // Change 1: mark hook tool time for dedup
        const toolName = (evt.data?.tool_name as string) || 'tool';
        const formatted = formatToolInputForTimeline(toolName, evt.data?.tool_input as Record<string, unknown> | undefined);
        core.bridgeTimeline.addEntry({
          ts: now, type: 'tool_request',
          raw: formatted ? `${toolName} ${formatted}` : toolName,
          agentType: 'claude-code',
        });
        break;
      }
      case 'PostToolUse': {
        // Change 3: include tool name instead of generic "Approved"
        const resolvedTool = (evt.data?.tool_name as string) || 'tool';
        core.bridgeTimeline.addEntry({ ts: now, type: 'tool_resolved', raw: `${resolvedTool} approved`, agentType: 'claude-code' });
        break;
      }
      case 'Stop': {
        // Race guard: if ccPendingCompletion is already false, the PTY fallback
        // timer fired first (Stop hook arrived >1.5s after spinner_stop) and
        // already emitted chat_response/chat_end. Skipping here prevents the
        // duplicate-line bug visible on the dashboard timeline.
        const wasPending = ccPendingCompletion;
        ccPendingCompletion = false;  // Change 2: disarm PTY fallback — hook handled it
        if (ccPendingCompletionTimer) {
          clearTimeout(ccPendingCompletionTimer);
          ccPendingCompletionTimer = null;
        }
        if (!wasPending) {
          debug('timeline', 'CC Stop hook arrived after PTY fallback emit — skipping duplicate');
          break;
        }
        if (ccPendingChatStart) emitChatStart('');
        const duration = ccChatStart ? Math.round((now - ccChatStart) / 1000) : null;
        const toolSummary = core.usageTracker.getToolSummary();

        // Response capture priority (CLI bridge only — the App Store Swift
        // daemon is sandboxed off the projects/ path and relies on
        // Task 2's response_kind heuristic instead):
        //   1. transcript_path JSONL — authoritative; Claude Code writes
        //      every user/assistant/tool block here, and the Stop hook
        //      payload points at it.
        //   2. last_assistant_message — ~18% reliable field on the hook
        //      payload; honoured when the transcript isn't reachable.
        //   3. PTY ringbuffer — last-resort fallback already handled by
        //      the existing spinner_stop pathway.
        const transcriptPath = (evt.data?.transcript_path as string) || '';
        let lastAssistantMsg = (evt.data?.last_assistant_message as string) || '';
        if (transcriptPath) {
          try {
            const excerpt = readClaudeTranscriptLastTurn(transcriptPath);
            if (excerpt?.hasAssistantText) {
              lastAssistantMsg = excerpt.assistantText;
            }
          } catch (err) {
            debug('agentdeck', `transcript read skipped: ${String(err)}`);
          }
        }

        // APME: store Claude's response on the current turn
        const apmeRef = core.getApme();
        if (apmeRef && lastAssistantMsg) {
          apmeRef.collector.setTurnResponse(core.sessionId, lastAssistantMsg);
        }

        emitCompletion(lastAssistantMsg, duration, toolSummary);
        break;
      }
    }
  });
}

// ===== Voice command handler =====

function handleVoiceCommand(
  action: 'start' | 'stop' | 'cancel',
  voiceManager: VoiceManager,
  core: BridgeCore,
): void {
  switch (action) {
    case 'start':
      voiceManager.startRecording();
      core.wsServer.broadcast({ type: 'voice_state', state: 'recording' } as any);
      break;
    case 'stop':
      core.wsServer.broadcast({ type: 'voice_state', state: 'transcribing' } as any);
      voiceManager.stopRecording().then((text) => {
        core.wsServer.broadcast({ type: 'voice_state', state: 'idle', text: text || '' } as any);
      }).catch((err) => {
        core.wsServer.broadcast({ type: 'voice_state', state: 'error', error: String(err) } as any);
      });
      break;
    case 'cancel':
      voiceManager.cancel();
      core.wsServer.broadcast({ type: 'voice_state', state: 'idle' } as any);
      break;
  }
}
