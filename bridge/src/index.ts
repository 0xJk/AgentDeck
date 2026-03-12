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
  type ButtonSlotState,
  type ButtonStateEvent,
  type DeckSlotMapEvent,
  type UtilityCommand,
} from './types.js';
import { UtilityProxy } from './utility-proxy.js';
import { BridgeTimelineStore } from './timeline-store.js';
import { BridgeLogStream } from './log-stream.js';
import { extractTopicHint } from './timeline-summarizer.js';
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
import { fetchUsageFromApi, hasOAuthToken, didLastFetchFail, type ApiUsageData } from './usage-api.js';
import { OllamaProbe, type OllamaStatus } from './ollama-probe.js';
import { buildUsageEvent } from './usage-event.js';
import { probeGateway, checkGatewayHealth } from './gateway-probe.js';

import { getOrCreateToken, getWsUrl } from './auth.js';
import { buildEnrichedSessionsList } from './session-aggregator.js';
import type { HookServer } from './hook-server.js';
import { setupAdbReverse, cleanupAdbReverse, startAdbReversePolling } from './adb-reverse.js';
import { startESP32Serial, broadcastESP32, stopESP32Serial, setESP32StateProvider, esp32ConnectionCount, getESP32Ports } from './esp32-serial.js';
import { startPixooBridge, broadcastPixoo, stopPixooBridge, getPixooDeviceDetails } from './pixoo/pixoo-bridge.js';
import { getAdbDeviceCount } from './adb-reverse.js';

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
  .option('--no-update-check', 'Skip Claude Code version check and auto-update')
  .action(async (opts) => {
    if (opts.debug) {
      enableDebugLog();
      log('[sdc] Debug logging enabled → /tmp/sdc-debug.log');
    }
    const port = parseInt(opts.port, 10);
    const agentType = opts.agent as AgentType;
    await startBridge(port, opts.command, agentType, opts.gateway, opts.updateCheck === false);
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
  .command('devices')
  .description('Show connected devices (WebSocket, ESP32, Pixoo, ADB)')
  .option('-p, --port <port>', 'Bridge server port', String(BRIDGE_WS_PORT))
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/devices`, {
        signal: AbortSignal.timeout(2000),
      });
      const data = await res.json() as { devices: Array<{ type: string; count?: number; ports?: string[]; details?: Array<{ ip: string; name: string; backedOff: boolean; failures: number; nextProbeMs: number; lastPushAgo: number }> }> };
      const lines: string[] = ['Connected devices:'];
      let total = 0;

      for (const d of data.devices) {
        if (d.type === 'websocket' && d.count) {
          lines.push(`  WebSocket    ${d.count} client${d.count !== 1 ? 's' : ''}`);
          total += d.count;
        } else if (d.type === 'esp32' && d.count) {
          const portInfo = d.ports?.length ? ` (${d.ports.join(', ')})` : '';
          lines.push(`  ESP32        ${d.count} serial${portInfo}`);
          total += d.count;
        } else if (d.type === 'pixoo' && d.details) {
          for (const px of d.details) {
            if (px.backedOff) {
              const mins = Math.ceil(px.nextProbeMs / 60_000);
              lines.push(`  Pixoo64      ${px.ip} (${px.name}) \u26A0 backed off (next probe ${mins}m)`);
            } else {
              const ago = px.lastPushAgo >= 0 ? `${Math.round(px.lastPushAgo / 1000)}s ago` : 'no push yet';
              lines.push(`  Pixoo64      ${px.ip} (${px.name}) \u2713 ${ago}`);
            }
            total++;
          }
        } else if (d.type === 'adb' && d.count) {
          lines.push(`  ADB          ${d.count} USB device${d.count !== 1 ? 's' : ''}`);
          total += d.count;
        }
      }

      if (total === 0) {
        log('No devices connected.');
      } else {
        lines.push('');
        lines.push(`Total: ${total} device connection${total !== 1 ? 's' : ''}`);
        log(lines.join('\n'));
      }
    } catch {
      // Bridge not running — show configured Pixoo devices as fallback
      const { loadPixooDevices } = await import('./pixoo/pixoo-settings.js');
      const pixoo = loadPixooDevices();
      if (pixoo.length > 0) {
        log('Bridge is not running.\nConfigured Pixoo devices:');
        for (const d of pixoo) {
          log(`  ${d.ip} (${d.name || 'Pixoo64'})`);
        }
      } else {
        log('Bridge is not running.');
      }
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

// ===== Pixoo64 device management =====
const pixoo = program.command('pixoo').description('Manage Pixoo64 LED matrix devices');

pixoo
  .command('scan')
  .description('Discover Pixoo devices on LAN via Divoom cloud API')
  .action(async () => {
    const { discoverDevices, getDeviceConfig } = await import('./pixoo/pixoo-client.js');
    const { loadPixooDevices, savePixooDevices } = await import('./pixoo/pixoo-settings.js');

    log('Scanning for Pixoo devices...');
    const found = await discoverDevices();
    if (found.length === 0) {
      log('No devices found. Ensure your Pixoo is on the same LAN and powered on.');
      return;
    }

    // Verify connectivity for each device
    const verified: Array<{ name: string; ip: string; ok: boolean }> = [];
    for (const d of found) {
      const config = await getDeviceConfig(d.ip);
      verified.push({ ...d, ok: config !== null });
    }

    log(`\nFound ${verified.length} device(s):`);
    for (const d of verified) {
      log(`  ${d.name} (${d.ip}) ${d.ok ? '✓ reachable' : '✗ unreachable'}`);
    }

    const reachable = verified.filter(d => d.ok);
    if (reachable.length === 0) {
      log('\nNo reachable devices to save.');
      return;
    }

    // Interactive confirmation
    const readline = await import('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const answer = await new Promise<string>(resolve => {
      rl.question(`\nSave ${reachable.length} device(s) to settings? (Y/n) `, resolve);
    });
    rl.close();

    if (answer.toLowerCase() === 'n') {
      log('Cancelled.');
      return;
    }

    const existing = loadPixooDevices();
    const existingIps = new Set(existing.map(d => d.ip));
    const newDevices = reachable
      .filter(d => !existingIps.has(d.ip))
      .map(d => ({ ip: d.ip, name: d.name }));

    if (newDevices.length === 0) {
      log('All discovered devices already in settings.');
      return;
    }

    savePixooDevices([...existing, ...newDevices]);
    log(`Added ${newDevices.length} device(s) to ~/.agentdeck/settings.json`);
  });

pixoo
  .command('add <ip>')
  .description('Manually add a Pixoo device by IP')
  .option('-n, --name <name>', 'Device name', 'Pixoo64')
  .option('-b, --brightness <value>', 'Brightness 0-100')
  .action(async (ip: string, opts) => {
    const { getDeviceConfig } = await import('./pixoo/pixoo-client.js');
    const { addDevice } = await import('./pixoo/pixoo-settings.js');

    log(`Testing connection to ${ip}...`);
    const config = await getDeviceConfig(ip);
    if (!config) {
      log(`Cannot reach device at ${ip}. Adding anyway.`);
    } else {
      log(`Device reachable ✓`);
    }

    const device: { ip: string; name?: string; brightness?: number } = { ip, name: opts.name };
    if (opts.brightness) device.brightness = Math.max(0, Math.min(100, parseInt(opts.brightness, 10)));

    if (addDevice(device)) {
      log(`Added ${device.name} (${ip}) to settings.`);
    } else {
      log(`Device ${ip} already exists in settings.`);
    }
  });

pixoo
  .command('list')
  .description('List configured Pixoo devices')
  .action(async () => {
    const { loadPixooDevices } = await import('./pixoo/pixoo-settings.js');
    const devices = loadPixooDevices();
    if (devices.length === 0) {
      log('No Pixoo devices configured. Run `sdc pixoo scan` or `sdc pixoo add <ip>`.');
      return;
    }
    log(`${devices.length} device(s):`);
    for (const d of devices) {
      const parts = [d.name || 'Pixoo', `(${d.ip})`];
      if (d.brightness !== undefined) parts.push(`brightness=${d.brightness}`);
      log(`  ${parts.join(' ')}`);
    }
  });

pixoo
  .command('remove <ip>')
  .description('Remove a Pixoo device by IP')
  .action(async (ip: string) => {
    const { removeDevice } = await import('./pixoo/pixoo-settings.js');
    if (removeDevice(ip)) {
      log(`Removed ${ip} from settings.`);
    } else {
      log(`Device ${ip} not found in settings.`);
    }
  });

pixoo
  .command('test [ip]')
  .description('Send a test frame to a Pixoo device')
  .action(async (ip?: string) => {
    const { loadPixooDevices } = await import('./pixoo/pixoo-settings.js');
    const { pushFrame, setBrightness } = await import('./pixoo/pixoo-client.js');

    let targetIp = ip;
    if (!targetIp) {
      const devices = loadPixooDevices();
      if (devices.length === 0) {
        log('No device specified and none configured. Use `sdc pixoo test <ip>` or add a device first.');
        return;
      }
      targetIp = devices[0].ip;
      log(`Using first configured device: ${targetIp}`);
    }

    // Generate a colorful test pattern (diagonal rainbow stripes)
    const buf = new Uint8Array(64 * 64 * 3);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const i = (y * 64 + x) * 3;
        const hue = ((x + y) * 4) % 256;
        // Simple HSV→RGB with S=V=1
        const region = Math.floor(hue / 43);
        const remainder = (hue - region * 43) * 6;
        const q = 255 - remainder;
        const t = remainder;
        if (region === 0) { buf[i] = 255; buf[i+1] = t; buf[i+2] = 0; }
        else if (region === 1) { buf[i] = q; buf[i+1] = 255; buf[i+2] = 0; }
        else if (region === 2) { buf[i] = 0; buf[i+1] = 255; buf[i+2] = t; }
        else if (region === 3) { buf[i] = 0; buf[i+1] = q; buf[i+2] = 255; }
        else if (region === 4) { buf[i] = t; buf[i+1] = 0; buf[i+2] = 255; }
        else { buf[i] = 255; buf[i+1] = 0; buf[i+2] = q; }
      }
    }

    await setBrightness(targetIp, 60);
    const ok = await pushFrame(targetIp, buf);
    log(ok ? `Test frame sent to ${targetIp} ✓` : `Failed to send frame to ${targetIp}`);
  });

program.parse();

/** Extract tool input for timeline display (mirrors state-machine.ts formatToolInput) */
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

async function startBridge(port: number, command: string, agentType: AgentType, gatewayUrl?: string, noUpdateCheck?: boolean): Promise<void> {
  const deps = checkDependencies();
  if (!deps.ok) {
    process.exit(1);
  }
  for (const w of deps.warnings) {
    log(`[sdc] WARNING: ${w}`);
  }

  // Version compatibility check + auto-update
  const { checkVersionCompatibility } = await import('./version-check.js');
  const versionResult = await checkVersionCompatibility({
    skipCheck: noUpdateCheck,
    claudeCodeVersion: deps.claudeCodeVersion,
  });
  for (const w of versionResult.warnings) {
    log(`[sdc] WARNING: ${w}`);
  }
  if (versionResult.restartNeeded) {
    log('[sdc] AgentDeck updated. Please restart sdc.');
    process.exit(0);
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
  let apiUsageStale = false;
  let previousBridgeState: State = State.IDLE;

  // Ollama status probe
  const ollamaProbe = new OllamaProbe();
  let cachedOllamaStatus: OllamaStatus | null = null;

  // Gateway availability probe
  let cachedGatewayAvailable = false;
  let cachedGatewayHasError = false;

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

  // Timeline components (always-on for Android; log stream for OpenClaw only)
  const bridgeTimeline = new BridgeTimelineStore();
  const bridgeLogStream = agentType === 'openclaw' ? new BridgeLogStream() : null;

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

  // 2d. Set up adb reverse for all connected Android devices (best-effort)
  setupAdbReverse(port);
  const stopAdbPolling = startAdbReversePolling(port);

  // 2e. SSE broadcasting helper (only for ClaudeCode adapter which has HookServer)
  let hookServer: HookServer | null = null;
  if (adapter instanceof ClaudeCodeAdapter) {
    hookServer = adapter.hookServer;
    hookServer.setMeta({ agentType, projectName });
    hookServer.setVoiceManager(voiceManager);
    hookServer.onApiUsage(() => ({ usage: cachedApiUsage, fetchedAt: lastApiFetchTime }));
  }
  const broadcastSse = (event: BridgeEvent) => hookServer?.broadcastSse(event);

  // 2f. Start ESP32 serial bridge (USB JSON relay)
  let lastStateEvent: BridgeEvent | null = null;
  startESP32Serial();
  setESP32StateProvider(() => lastStateEvent);

  // 2g. Start Pixoo64 LED matrix bridge (HTTP push)
  const pixooSettingsPath = join(homedir(), '.agentdeck', 'settings.json');
  let pixooDevices: Array<{ ip: string; name?: string; brightness?: number }> | undefined;
  try {
    if (existsSync(pixooSettingsPath)) {
      const settings = JSON.parse(readFileSync(pixooSettingsPath, 'utf-8'));
      pixooDevices = settings.pixooDevices;
    }
  } catch { /* ignore malformed settings */ }
  startPixooBridge(pixooDevices);

  // 3. Attach WebSocket server to adapter's HTTP server
  const wsServer = new WsServer(adapter.getHttpServer());
  wsServer.onBroadcast(broadcastESP32);
  wsServer.onBroadcast(broadcastPixoo);
  log(`[sdc] WebSocket server ready on port ${port}`);

  // 3+. Device info getter for GET /devices endpoint
  hookServer?.setDeviceInfoGetter(() => ({
    devices: [
      { type: 'websocket', count: wsServer.getClientCount() },
      { type: 'esp32', count: esp32ConnectionCount(), ports: getESP32Ports() },
      { type: 'pixoo', details: getPixooDeviceDetails() },
      { type: 'adb', count: getAdbDeviceCount() },
    ],
  }));

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
            wsServer.broadcast(buildUsageEvent(stateMachine.getSnapshot(), cachedApiUsage, oauthConnected, cachedOllamaStatus, apiUsageStale));
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

        // Start/stop log stream on gateway connect/disconnect
        if (evt.status === 'connected' && bridgeLogStream) {
          bridgeLogStream.start();
        } else if (evt.status === 'disconnected' && bridgeLogStream) {
          bridgeLogStream.stop();
        }
        break;
      }

      case 'timeline': {
        if (bridgeTimeline) {
          if (evt.upsert) {
            bridgeTimeline.upsertEntry(evt.entry);
          } else {
            bridgeTimeline.addEntry(evt.entry);
          }
          // Dedup: track tool_request in log stream
          if (evt.entry.type === 'tool_request' && bridgeLogStream) {
            bridgeLogStream.trackToolRequest(evt.entry.raw);
          }
        }
        break;
      }
    }
  });

  // 4a-timeline. Wire log stream + timeline store → WS broadcast
  if (bridgeLogStream && bridgeTimeline) {
    bridgeLogStream.on('entry', (entry) => {
      bridgeTimeline.addEntry(entry);
    });
  }
  if (bridgeTimeline) {
    bridgeTimeline.onEntry((entry, upsert) => {
      const evt: BridgeEvent = { type: 'timeline_event', entry, ...(upsert ? { upsert: true } : {}) };
      wsServer.broadcast(evt);
      broadcastSse(evt);
    });
  }

  // 4a-cc-timeline. Wire Claude Code hook events → timeline entries
  if (agentType === 'claude-code') {
    let ccLastState: string | null = null;
    let ccChatStart: number | null = null;
    let ccPendingChatStart = false;
    let ccPendingChatStartTimer: ReturnType<typeof setTimeout> | null = null;
    let ccLastPromptText: string | null = null;

    const emitChatStart = (text: string) => {
      if (ccPendingChatStartTimer) {
        clearTimeout(ccPendingChatStartTimer);
        ccPendingChatStartTimer = null;
      }
      ccPendingChatStart = false;
      ccLastPromptText = text || null;
      const snippet = text.length > 500 ? text.slice(0, 497) + '...' : text;
      const detail = text.length > 100 ? (text.length > 1000 ? text.slice(0, 1000) + '...' : text) : undefined;
      bridgeTimeline.addEntry({
        ts: ccChatStart ?? Date.now(), type: 'chat_start',
        raw: snippet || 'Prompt sent',
        ...(detail ? { detail } : {}),
        agentType: 'claude-code',
      });
    };

    // Listen for PTY user_prompt to get actual prompt text
    adapter.on('event', (evt: AdapterEvent) => {
      if (evt.source === 'metadata' && evt.event === 'user_prompt' && ccPendingChatStart) {
        const text = (evt.data?.text as string) || '';
        emitChatStart(text);
      }
    });

    adapter.on('event', (evt: AdapterEvent) => {
      if (evt.source === 'hook') {
        const now = Date.now();
        switch (evt.event) {
          case 'UserPromptSubmit': {
            ccChatStart = now;
            usageTracker.resetToolCounts();
            ccPendingChatStart = true;
            // Fallback: if PTY user_prompt doesn't arrive within 500ms, emit with hook text
            debug('Timeline', `UserPromptSubmit keys: ${Object.keys(evt.data || {}).join(',')}`);
            const hookText = (evt.data?.prompt as string)
              || (evt.data?.text as string)
              || (evt.data?.message as string)
              || '';
            ccPendingChatStartTimer = setTimeout(() => {
              if (ccPendingChatStart) {
                emitChatStart(hookText);
              }
            }, 500);
            break;
          }
          case 'PreToolUse': {
            const toolName = (evt.data?.tool_name as string) || 'tool';
            const toolInputData = evt.data?.tool_input as Record<string, unknown> | undefined;
            const formatted = formatToolInputForTimeline(toolName, toolInputData);
            bridgeTimeline.addEntry({
              ts: now, type: 'tool_request',
              raw: formatted ? `${toolName} ${formatted}` : toolName,
              agentType: 'claude-code',
            });
            break;
          }
          case 'PostToolUse': {
            bridgeTimeline.addEntry({
              ts: now, type: 'tool_resolved',
              raw: 'Approved',
              agentType: 'claude-code',
            });
            break;
          }
          case 'Stop': {
            // Flush any pending chat_start before emitting chat_end
            if (ccPendingChatStart) {
              emitChatStart('');
            }
            const duration = ccChatStart ? Math.round((now - ccChatStart) / 1000) : null;
            const toolSummary = usageTracker.getToolSummary();
            // Use last_assistant_message from Stop hook for topic extraction
            const lastAssistantMsg = (evt.data?.last_assistant_message as string) || '';
            // Priority: assistant response topic > prompt topic > "Completed"
            const responseTopic = lastAssistantMsg ? extractTopicHint(lastAssistantMsg) : null;
            const promptTopic = ccLastPromptText ? extractTopicHint(ccLastPromptText) : null;
            const completedLabel = responseTopic || promptTopic || 'Completed';
            let summary = duration != null ? `${completedLabel} · ${duration}s` : completedLabel;
            if (toolSummary) {
              summary += ` · ${toolSummary}`;
            }
            // Include response snippet in detail, fallback to prompt context
            let chatEndDetail: string | undefined;
            if (lastAssistantMsg) {
              chatEndDetail = lastAssistantMsg.length > 1000 ? lastAssistantMsg.slice(0, 1000) + '...' : lastAssistantMsg;
            } else if (ccLastPromptText) {
              chatEndDetail = `Prompt: ${ccLastPromptText.length > 200 ? ccLastPromptText.slice(0, 200) + '...' : ccLastPromptText}`;
            }
            ccChatStart = null;
            ccLastPromptText = null;
            bridgeTimeline.addEntry({
              ts: now, type: 'chat_end',
              raw: summary,
              ...(chatEndDetail ? { detail: chatEndDetail } : {}),
              agentType: 'claude-code',
            });
            break;
          }
        }
      }
    });
  }

  // 4b. Handle adapter exit (agent process died)
  adapter.on('exit', (_code: number, _signal: number) => {
    log('[sdc] Agent process exited');
    // Don't shutdown — bridge stays alive for session info/devices/reconnection
    // State machine already handles DISCONNECTED via adapter's 'connection' event
  });

  // Debounce tracker for sessions_list on state_changed
  let lastSessionsListBroadcast = 0;

  // Default idle button config (must be before state_changed handler that calls computeButtonState)
  const DEFAULT_IDLE_BUTTONS: { label: string; action: string }[] = [
    { label: 'GO ON', action: 'continue' },
    { label: 'REVIEW', action: '/review' },
    { label: 'COMMIT', action: '/commit' },
    { label: 'CLEAR', action: '/clear' },
  ];

  // 5. Wire StateMachine state changes → WsServer broadcast
  stateMachine.on('state_changed', (snapshot: StateSnapshot) => {
    // PROCESSING→IDLE: immediately fetch fresh usage (rate limits likely changed)
    const wasActive = previousBridgeState === State.PROCESSING;
    previousBridgeState = snapshot.state;
    if (wasActive && snapshot.state === State.IDLE && wsServer.getClientCount() > 0) {
      if (Date.now() - lastApiFetchTime > 10_000) {
        fetchUsageFromApi().then((apiUsage) => {
          if (apiUsage) {
            cachedApiUsage = apiUsage;
            lastApiFetchTime = Date.now();
            oauthConnected = true;
            apiUsageStale = false;
            if (apiUsage.inferredBillingType) {
              stateMachine.inferBillingType(apiUsage.inferredBillingType);
            }
            const snap = stateMachine.getSnapshot();
            wsServer.broadcast(buildUsageEvent(snap, cachedApiUsage, oauthConnected, cachedOllamaStatus, apiUsageStale));
          }
        }).catch(() => {});
      }
    }

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
      modelCatalog: cachedModelCatalog ?? undefined,
      remoteUrl: snapshot.remoteUrl ?? undefined,
      pairingUrl: wsUrl,
      ollamaStatus: cachedOllamaStatus ?? undefined,
      gatewayAvailable: cachedGatewayAvailable,
      gatewayHasError: cachedGatewayHasError,
    };
    wsServer.broadcast(stateEvent);
    broadcastSse(stateEvent);
    lastStateEvent = stateEvent;  // Cache for ESP32 heartbeat

    // Trigger sessions_list refresh on state change (debounced 2s)
    const now = Date.now();
    if (now - lastSessionsListBroadcast > 2000 && wsServer.getClientCount() > 0) {
      lastSessionsListBroadcast = now;
      buildSessionsList().then((sessions) => {
        wsServer.broadcast({ type: 'sessions_list', sessions } as BridgeEvent);
      }).catch(() => {});
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

    const usageEvt = buildUsageEvent(snapshot, cachedApiUsage, oauthConnected, cachedOllamaStatus, apiUsageStale);
    wsServer.broadcast(usageEvt);
    broadcastSse(usageEvt);

    // Broadcast encoder state alongside state updates
    const encEvt = computeEncoderState();
    wsServer.broadcast(encEvt);
    broadcastSse(encEvt);

    // Broadcast button state for Android Deck UI
    const btnEvt = computeButtonState();
    wsServer.broadcast(btnEvt);
    broadcastSse(btnEvt);
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
            apiUsageStale = false;
            if (apiUsage.inferredBillingType) {
              stateMachine.inferBillingType(apiUsage.inferredBillingType);
            }
          } else if (cachedApiUsage) {
            apiUsageStale = true;
          }
          const snapshot = stateMachine.getSnapshot();
          wsServer.broadcast(buildUsageEvent(snapshot, cachedApiUsage, oauthConnected, cachedOllamaStatus, apiUsageStale));
        }).catch(() => {});
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
      // Re-broadcast button state since PI settings may have changed
      const btnEvt = computeButtonState();
      wsServer.broadcast(btnEvt);
      broadcastSse(btnEvt);
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
      effortLevel: snapshot.effortLevel ?? undefined,
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
      gatewayAvailable: cachedGatewayAvailable,
      gatewayHasError: cachedGatewayHasError,
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

    wsServer.sendTo(ws, buildUsageEvent(snapshot, cachedApiUsage, oauthConnected, cachedOllamaStatus, apiUsageStale));

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
    }).catch(() => {});

    // Send current display state
    wsServer.sendTo(ws, { type: 'display_state', displayOn: displayMonitor.isDisplayOn() } as BridgeEvent);

    // Send encoder state
    wsServer.sendTo(ws, computeEncoderState());

    // Send button state
    wsServer.sendTo(ws, computeButtonState());

    // Send cached slot map if available
    if (cachedSlotMap) {
      wsServer.sendTo(ws, cachedSlotMap);
    }

    // Send timeline history for OpenClaw mode
    if (bridgeTimeline) {
      const entries = bridgeTimeline.getHistory();
      if (entries.length > 0) {
        wsServer.sendTo(ws, { type: 'timeline_history', entries } as BridgeEvent);
      }
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
          apiUsageStale = false;
          if (apiUsage.inferredBillingType) {
            stateMachine.inferBillingType(apiUsage.inferredBillingType);
          }
          const snap2 = stateMachine.getSnapshot();
          wsServer.broadcast(buildUsageEvent(snap2, cachedApiUsage, oauthConnected, cachedOllamaStatus, apiUsageStale));
        } else {
          oauthConnected = hasOAuthToken();
          if (cachedApiUsage) apiUsageStale = true;
        }
      }).catch(() => {});
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
  const USAGE_STALE_TTL = 10 * 60 * 1000; // 10 minutes — clear stale cache after this
  const usageInterval = setInterval(() => {
    if (wsServer.getClientCount() > 0) {
      // TTL: if cache is older than 10 minutes, clear it so Android hides gauges
      if (cachedApiUsage && lastApiFetchTime > 0 && (Date.now() - lastApiFetchTime) > USAGE_STALE_TTL) {
        debug('bridge', `API usage cache expired (${Math.round((Date.now() - lastApiFetchTime) / 1000)}s old), clearing`);
        cachedApiUsage = null;
        apiUsageStale = false;
      }
      const snapshot = stateMachine.getSnapshot();
      wsServer.broadcast(buildUsageEvent(snapshot, cachedApiUsage, oauthConnected, cachedOllamaStatus, apiUsageStale));
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
          apiUsageStale = false;
          if (apiUsage.inferredBillingType) {
            stateMachine.inferBillingType(apiUsage.inferredBillingType);
          }
          // Broadcast updated usage so clients see fresh rate-limit data
          const snapshot = stateMachine.getSnapshot();
          wsServer.broadcast(buildUsageEvent(snapshot, cachedApiUsage, oauthConnected, cachedOllamaStatus, apiUsageStale));
        } else {
          oauthConnected = hasOAuthToken();
          if (cachedApiUsage) apiUsageStale = true;
        }
      }).catch(() => {});
    }
  }, 45_000);

  // 9b2. Periodic Ollama status probe (piggyback on state_update interval)
  const ollamaInterval = setInterval(() => {
    ollamaProbe.getStatus().then((status) => {
      cachedOllamaStatus = status;
    }).catch(() => {});
  }, 5000);
  // Initial probe
  ollamaProbe.getStatus().then((status) => {
    cachedOllamaStatus = status;
  }).catch(() => {});

  // 9b3. Periodic Gateway probe (OpenClaw availability)
  const gatewayInterval = setInterval(() => {
    probeGateway().then((status) => {
      cachedGatewayAvailable = status.available;
    }).catch(() => {});
  }, 800);
  // Initial probe
  probeGateway().then((status) => {
    cachedGatewayAvailable = status.available;
    // Broadcast gateway availability to already-connected clients
    stateMachine.emit('state_changed', stateMachine.getSnapshot());
  }).catch(() => {});

  // 9b4. Periodic Gateway health check (doctor warnings/errors, 30s cadence)
  function updateGatewayHealth() {
    checkGatewayHealth().then((hasError) => {
      const changed = hasError !== cachedGatewayHasError;
      cachedGatewayHasError = hasError;
      if (changed) {
        // Re-broadcast current state with updated gatewayHasError
        stateMachine.emit('state_changed', stateMachine.getSnapshot());
      }
    }).catch(() => {});
  }
  const healthInterval = setInterval(() => {
    if (!cachedGatewayAvailable) return; // skip if gateway is down
    updateGatewayHealth();
  }, 30_000);
  // Initial check (delayed 5s to let gateway stabilize)
  setTimeout(updateGatewayHealth, 5000);

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
      }).catch(() => {});
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

  // Button state computation (Android Deck UI)
  function computeButtonState(): ButtonStateEvent {
    const snapshot = stateMachine.getSnapshot();
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

    // Helper: get PI settings for response-button slots from cachedSlotMap
    function getIdleButtons(): { label: string; action: string }[] {
      if (!cachedSlotMap) return DEFAULT_IDLE_BUTTONS;
      const responseSlots = cachedSlotMap.buttons
        .filter(s => s.actionType === 'response-button')
        .sort((a, b) => a.slot - b.slot);
      if (responseSlots.length === 0) return DEFAULT_IDLE_BUTTONS;
      return responseSlots.map((s, i) => {
        const settings = s.settings ?? {};
        const defLabel = DEFAULT_IDLE_BUTTONS[i]?.label ?? '';
        const defAction = DEFAULT_IDLE_BUTTONS[i]?.action ?? '';
        return {
          label: (settings.label as string) ?? defLabel,
          action: (settings.action as string) ?? defAction,
        };
      });
    }

    // Helper: color for permission/diff options
    function colorForOption(opt: import('./types.js').PromptOption): { bg: string; text: string } {
      const shortcut = (opt.shortcut ?? '').toLowerCase();
      const lower = opt.label.toLowerCase();
      if (lower.startsWith('always')) return { bg: '#1e40af', text: '#ffffff' };
      if (/don[''\u2019]t\s+ask\s+again/i.test(lower)) return { bg: '#1e40af', text: '#ffffff' };
      if (/allow\s+all\s+sessions/i.test(lower)) return { bg: '#1e40af', text: '#ffffff' };
      if (shortcut === 'n' || shortcut === 'd' || lower.startsWith('no') || lower.startsWith('deny')) {
        return { bg: '#991b1b', text: '#ffffff' };
      }
      if (shortcut === 'y' || shortcut === 'a') return { bg: '#166534', text: '#ffffff' };
      if (opt.recommended) return { bg: '#1e4d2b', text: '#86efac' };
      return { bg: '#1e3a5f', text: '#93c5fd' };
    }

    // Helper: uppercase short labels
    function uppercaseShort(label: string): string {
      return label.length <= 12 ? label.toUpperCase() : label;
    }

    const buttons: ButtonSlotState[] = [];

    // --- Slot 0: Mode ---
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

    // --- Slot 1: Session/Status ---
    if (st === State.IDLE) {
      const effortSuffix = snapshot.effortLevel && snapshot.effortLevel !== 'medium'
        ? snapshot.effortLevel : null;
      const sessionSubtitle = effortSuffix && snapshot.modelName
        ? `${snapshot.modelName} · ${effortSuffix}`
        : snapshot.modelName ?? undefined;
      buttons.push({
        slot: 1,
        title: snapshot.projectName ?? '—',
        subtitle: sessionSubtitle,
        bgColor: '#1e293b',
        textColor: '#ffffff',
        enabled: false,
      });
    } else if (st === State.PROCESSING) {
      buttons.push({
        slot: 1,
        title: snapshot.currentTool ?? '...',
        subtitle: snapshot.toolProgress ?? undefined,
        bgColor: '#1e3a5f',
        textColor: '#93c5fd',
        enabled: false,
      });
    } else if (st === State.AWAITING_PERMISSION || st === State.AWAITING_DIFF) {
      buttons.push({
        slot: 1,
        title: 'PERMIT?',
        bgColor: '#b45309',
        textColor: '#ffffff',
        enabled: false,
      });
    } else if (st === State.AWAITING_OPTION) {
      buttons.push({
        slot: 1,
        title: 'SELECT',
        bgColor: '#b45309',
        textColor: '#ffffff',
        enabled: false,
      });
    } else {
      buttons.push({ ...DIM, slot: 1 });
    }

    // --- Slot 2: Usage ---
    const pct = cachedApiUsage?.fiveHourPercent ?? null;
    const usageText = pct != null ? `${Math.round(pct)}%` : '—';
    const usageBg = pct == null ? '#1e293b'
      : pct >= 90 ? '#991b1b'
      : pct >= 70 ? '#92400e'
      : '#166534';
    buttons.push({
      slot: 2,
      title: usageText,
      subtitle: '5h',
      bgColor: usageBg,
      textColor: '#ffffff',
      enabled: false,
    });

    // --- Slots 3-6: Response buttons ---
    if (st === State.IDLE) {
      const idleBtns = getIdleButtons();
      for (let i = 0; i < 4; i++) {
        const btn = idleBtns[i];
        if (btn) {
          const isGoOn = btn.action === 'continue' || btn.label.toLowerCase() === 'go on';
          buttons.push({
            slot: 3 + i,
            title: btn.label,
            bgColor: isGoOn ? '#1e3a2f' : '#1e293b',
            textColor: isGoOn ? '#22c55e' : '#ffffff',
            enabled: true,
            action: `command:${btn.action === 'continue' ? 'go on' : btn.action}`,
          });
        } else {
          buttons.push({ ...DIM, slot: 3 + i });
        }
      }
    } else if (st === State.PROCESSING) {
      for (let i = 0; i < 4; i++) {
        buttons.push({ ...DIM, slot: 3 + i });
      }
    } else if (isInteractive) {
      // Permission / Option / Diff states
      if (options.length === 0 && (st === State.AWAITING_PERMISSION)) {
        buttons.push({ slot: 3, title: 'YES', bgColor: '#166534', textColor: '#ffffff', enabled: true, action: 'respond:y' });
        buttons.push({ slot: 4, title: 'NO', bgColor: '#991b1b', textColor: '#ffffff', enabled: true, action: 'respond:n' });
        buttons.push({ slot: 5, title: 'ALWAYS', bgColor: '#1e40af', textColor: '#ffffff', enabled: true, action: 'respond:a' });
        buttons.push({ ...DIM, slot: 6 });
      } else if (options.length === 0 && (st === State.AWAITING_DIFF)) {
        buttons.push({ slot: 3, title: 'APPLY', bgColor: '#166534', textColor: '#ffffff', enabled: true, action: 'respond:a' });
        buttons.push({ slot: 4, title: 'DENY', bgColor: '#991b1b', textColor: '#ffffff', enabled: true, action: 'respond:d' });
        buttons.push({ slot: 5, title: 'VIEW', bgColor: '#1e3a5f', textColor: '#93c5fd', enabled: true, action: 'respond:v' });
        buttons.push({ ...DIM, slot: 6 });
      } else if (options.length <= 4) {
        for (let i = 0; i < 4; i++) {
          if (i < options.length) {
            const opt = options[i];
            const colors = (st === State.AWAITING_PERMISSION || st === State.AWAITING_DIFF)
              ? colorForOption(opt)
              : opt.recommended ? { bg: '#1e4d2b', text: '#86efac' } : { bg: '#1e3a5f', text: '#93c5fd' };
            const action = snapshot.navigable
              ? `select_option:${opt.index}`
              : `respond:${opt.shortcut || opt.label.charAt(0).toLowerCase()}`;
            const badge = opt.recommended ? '\u2605' : opt.selected ? '\u2713' : undefined;
            buttons.push({
              slot: 3 + i,
              title: uppercaseShort(opt.label),
              bgColor: colors.bg,
              textColor: colors.text,
              enabled: true,
              badge,
              action,
            });
          } else {
            buttons.push({ ...DIM, slot: 3 + i });
          }
        }
      } else {
        // 5+ options: first 3 + MORE
        for (let i = 0; i < 3; i++) {
          const opt = options[i];
          const colors = (st === State.AWAITING_PERMISSION || st === State.AWAITING_DIFF)
            ? colorForOption(opt)
            : opt.recommended ? { bg: '#1e4d2b', text: '#86efac' } : { bg: '#1e3a5f', text: '#93c5fd' };
          const action = snapshot.navigable
            ? `select_option:${opt.index}`
            : `respond:${opt.shortcut || opt.label.charAt(0).toLowerCase()}`;
          buttons.push({
            slot: 3 + i,
            title: uppercaseShort(opt.label),
            bgColor: colors.bg,
            textColor: colors.text,
            enabled: true,
            action,
          });
        }
        buttons.push({
          slot: 6,
          title: 'MORE \u25BC',
          bgColor: '#334155',
          textColor: '#94a3b8',
          enabled: true,
          action: 'expand_options',
        });
      }
    } else {
      // DISCONNECTED or fallback
      for (let i = 0; i < 4; i++) {
        buttons.push({ ...DIM, slot: 3 + i });
      }
    }

    // --- Slot 7: Stop/ESC ---
    if (st === State.PROCESSING) {
      buttons.push({
        slot: 7,
        title: 'STOP',
        bgColor: '#cc0000',
        textColor: '#ffffff',
        enabled: true,
        action: 'interrupt',
      });
    } else if (isInteractive) {
      buttons.push({
        slot: 7,
        title: 'ESC',
        bgColor: '#b45309',
        textColor: '#ffffff',
        enabled: true,
        action: 'escape',
      });
    } else if (st === State.IDLE) {
      buttons.push({
        slot: 7,
        title: 'ESC',
        bgColor: '#3d2607',
        textColor: '#ffb347',
        enabled: true,
        action: 'escape',
        dim: false,
      });
    } else {
      buttons.push({ ...DIM, slot: 7 });
    }

    return { type: 'button_state', buttons };
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
    clearInterval(healthInterval);
    clearInterval(sessionsListInterval);
    deregisterSession(sessionId);

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }

    displayMonitor.stop();
    utilityProxy.cleanup();
    voiceManager.disconnectFromServer();
    bridgeLogStream?.stop();
    journal.close();
    wsServer.close();
    stopAdbPolling();
    cleanupAdbReverse(port);
    stopESP32Serial();
    stopPixooBridge();

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
    debug('Bridge', `Unhandled rejection stack: ${reason instanceof Error ? reason.stack : reason}`);
    // Don't shutdown — unhandled rejections are non-fatal
  });
}

// buildUsageEvent is imported from ./usage-event.js

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
