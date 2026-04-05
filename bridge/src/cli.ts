#!/usr/bin/env node

import { Command } from 'commander';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { BRIDGE_WS_PORT } from './types.js';

function log(msg: string): void {
  process.stderr.write(msg + '\n');
}

// ===== LaunchAgent plist =====

const PLIST_LABEL = 'dev.agentdeck.daemon';
const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);

function getAgentdeckBin(): string {
  try {
    return execSync('which agentdeck', { encoding: 'utf-8' }).trim();
  } catch {
    const distDir = new URL('.', import.meta.url).pathname;
    return join(distDir, 'cli.js');
  }
}

function buildPlist(): string {
  const bin = getAgentdeckBin();
  const logDir = join(homedir(), '.agentdeck');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bin}</string>
    <string>daemon</string>
    <string>start</string>
    <string>--foreground</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${logDir}/daemon-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${logDir}/daemon-stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${process.env.PATH}</string>
  </dict>
</dict>
</plist>`;
}

// ===== Helpers =====

async function stopDaemon(port: number): Promise<void> {
  const { readDaemonInfo, findDaemonPort } = await import('./session-registry.js');
  const info = readDaemonInfo();
  const targetPort = info?.httpPort ?? info?.port ?? findDaemonPort() ?? port;
  try {
    await fetch(`http://127.0.0.1:${targetPort}/shutdown`, { method: 'POST' });
    log('Shutdown signal sent');
  } catch {
    log('Daemon is not running');
  }
}

// ===== Program =====

const program = new Command();

program
  .name('agentdeck')
  .description('AgentDeck — Physical Controller for AI Coding Agents')
  .version('0.1.0');

// ===== Agent session commands =====

program
  .command('claude')
  .description('Start Claude Code session (PTY + bridge)')
  .option('-p, --port <port>', 'Bridge server port', String(BRIDGE_WS_PORT))
  .option('-c, --command <cmd>', 'Command to spawn', 'claude')
  .option('-d, --debug', 'Enable debug logging')
  .option('--no-update-check', 'Skip version check and auto-update')
  .option('--local', 'Disable all device modules (WS only)')
  // --no-mdns removed: session bridges never advertise mDNS (daemon only)
  .option('--no-adb', 'Disable ADB reverse setup')
  .option('--no-postit', 'Disable terminal tab title updates')
  .option('--wake-word', 'Enable wake word voice assistant ("오픈클로")')
  .action(async (opts) => {
    const { startSession } = await import('./index.js');
    await startSession({
      agentType: 'claude-code',
      port: parseInt(opts.port, 10),
      command: opts.command,
      debug: opts.debug,
      noUpdateCheck: opts.updateCheck === false,
      postit: opts.postit !== false,
      wakeWord: !!opts.wakeWord,
      modules: opts.local ? { mdns: false, adb: false, serial: false, pixoo: false, d200h: false } : {
        mdns: false,   // daemon-only — session bridges never advertise mDNS
        adb: opts.adb !== false ? 'auto' : false,
        serial: false, // daemon-only — session bridges never talk to ESP32
        pixoo: false,  // daemon-only — session bridges never talk to Pixoo
        d200h: false,  // daemon-only — session bridges never talk to D200H
      },
    });
  });

program
  .command('codex')
  .description('Start Codex CLI session (PTY + bridge)')
  .option('-p, --port <port>', 'Bridge server port', String(BRIDGE_WS_PORT))
  .option('-c, --command <cmd>', 'Command to spawn', 'codex')
  .option('-d, --debug', 'Enable debug logging')
  .option('--local', 'Disable all device modules (WS only)')
  .option('--no-adb', 'Disable ADB reverse setup')
  .option('--no-postit', 'Disable terminal tab title updates')
  .action(async (opts) => {
    const { startSession } = await import('./index.js');
    await startSession({
      agentType: 'codex-cli',
      port: parseInt(opts.port, 10),
      command: opts.command,
      debug: opts.debug,
      postit: opts.postit !== false,
      modules: opts.local ? { mdns: false, adb: false, serial: false, pixoo: false, d200h: false } : {
        mdns: false,   // daemon-only
        adb: opts.adb !== false ? 'auto' : false,
        serial: false, // daemon-only
        pixoo: false,  // daemon-only
        d200h: false,  // daemon-only
      },
    });
  });

program
  .command('opencode')
  .description('Start OpenCode session (PTY + SSE bridge)')
  .option('-p, --port <port>', 'Bridge server port', String(BRIDGE_WS_PORT))
  .option('-c, --command <cmd>', 'Command to spawn', 'opencode')
  .option('-d, --debug', 'Enable debug logging')
  .option('--local', 'Disable all device modules (WS only)')
  .option('--no-adb', 'Disable ADB reverse setup')
  .option('--no-postit', 'Disable terminal tab title updates')
  .action(async (opts) => {
    const { startSession } = await import('./index.js');
    await startSession({
      agentType: 'opencode',
      port: parseInt(opts.port, 10),
      command: opts.command,
      debug: opts.debug,
      postit: opts.postit !== false,
      modules: opts.local ? { mdns: false, adb: false, serial: false, pixoo: false, d200h: false } : {
        mdns: false,
        adb: opts.adb !== false ? 'auto' : false,
        serial: false,
        pixoo: false,
        d200h: false,
      },
    });
  });

program
  .command('monitor')
  .description('Start hook-only bridge (no PTY — run claude separately)')
  .option('-p, --port <port>', 'Bridge server port', String(BRIDGE_WS_PORT))
  .option('-d, --debug', 'Enable debug logging')
  .option('--local', 'Disable all device modules')
  .action(async (opts) => {
    const { startSession } = await import('./index.js');
    const port = parseInt(opts.port, 10);
    log(`\nMonitor mode: hook server on port ${port}`);
    log(`Run in another terminal: AGENTDECK_PORT=${port} claude\n`);
    await startSession({
      agentType: 'monitor',
      port,
      debug: opts.debug,
      modules: opts.local ? { mdns: false, adb: false, serial: false, pixoo: false, d200h: false } : undefined,
    });
  });

// ===== Daemon commands =====

const daemon = program.command('daemon').description('Manage monitoring daemon');

daemon
  .command('start')
  .description('Start monitoring daemon (WS + mDNS + Gateway proxy)')
  .option('-p, --port <port>', 'Server port', String(BRIDGE_WS_PORT))
  .option('-d, --debug', 'Enable debug logging')
  .option('-f, --foreground', 'Run in foreground (default: background fork)')
  .option('--wake-word', 'Enable wake word voice assistant ("오픈클로")')
  .action(async (opts) => {
    const { findExistingDaemon, readDaemonInfo } = await import('./session-registry.js');
    const daemonInfo = readDaemonInfo();
    if (daemonInfo) {
      log(`Daemon already running on port ${daemonInfo.port} (PID ${daemonInfo.pid}). Use 'agentdeck daemon stop' first.`);
      process.exit(0);
    }
    const existing = findExistingDaemon();
    if (existing) {
      log(`Daemon already running on port ${existing.port} (PID ${existing.pid}). Use 'agentdeck daemon stop' first.`);
      process.exit(0);
    }

    // Background fork unless --foreground
    if (!opts.foreground) {
      const { openSync } = await import('fs');
      const logDir = join(homedir(), '.agentdeck');
      const scriptPath = fileURLToPath(import.meta.url);
      const args = [scriptPath, 'daemon', 'start', '--foreground'];
      if (opts.port !== String(BRIDGE_WS_PORT)) args.push('-p', opts.port);
      if (opts.debug) args.push('-d');
      if (opts.wakeWord) args.push('--wake-word');

      // Use log files instead of 'ignore' — preserves device access (mic, etc.)
      const out = openSync(join(logDir, 'daemon-stdout.log'), 'w');
      const err = openSync(join(logDir, 'daemon-stderr.log'), 'w');

      const child = spawn(process.execPath, args, {
        detached: true,
        stdio: ['ignore', out, err],
      });
      child.unref();
      log(`Daemon started (PID ${child.pid})`);
      process.exit(0);
    }

    const { startDaemon } = await import('./daemon-server.js');
    await startDaemon({
      port: parseInt(opts.port, 10),
      debug: opts.debug,
      wakeWord: !!opts.wakeWord,
    });
  });

daemon
  .command('stop')
  .description('Stop the daemon')
  .option('-p, --port <port>', 'Server port', String(BRIDGE_WS_PORT))
  .action(async (opts) => {
    await stopDaemon(parseInt(opts.port, 10));
  });

daemon
  .command('restart')
  .description('Stop and restart the daemon')
  .option('-p, --port <port>', 'Server port', String(BRIDGE_WS_PORT))
  .option('-d, --debug', 'Enable debug logging')
  .action(async (opts) => {
    await stopDaemon(parseInt(opts.port, 10));
    // Wait for port release + session cleanup
    await new Promise(resolve => setTimeout(resolve, 1500));

    const scriptPath = fileURLToPath(import.meta.url);
    const args = [scriptPath, 'daemon', 'start', '--foreground'];
    if (opts.port !== String(BRIDGE_WS_PORT)) args.push('-p', opts.port);
    if (opts.debug) args.push('-d');

    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    log(`Daemon restarted (PID ${child.pid})`);
    process.exit(0);
  });

daemon
  .command('status')
  .description('Show daemon status')
  .option('-p, --port <port>', 'Server port', String(BRIDGE_WS_PORT))
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    const { listActive, readDaemonInfo } = await import('./session-registry.js');
    const info = readDaemonInfo();
    const sessions = listActive();
    const d = sessions.find(s => s.agentType === 'daemon');
    const targetPort = info?.httpPort ?? info?.port ?? d?.port ?? port;
    try {
      const res = await fetch(`http://127.0.0.1:${targetPort}/health`);
      const data = await res.json() as Record<string, unknown>;
      log(`Daemon status (port ${targetPort}): ${JSON.stringify(data, null, 2)}`);
    } catch {
      log('Daemon is not running');
      process.exit(1);
    }
  });

daemon
  .command('install')
  .description('Install macOS LaunchAgent for auto-start')
  .action(() => {
    if (process.platform !== 'darwin') {
      log('LaunchAgent is macOS-only');
      process.exit(1);
    }
    const plist = buildPlist();
    writeFileSync(PLIST_PATH, plist, 'utf-8');
    log(`Wrote ${PLIST_PATH}`);
    try { execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null`); } catch {}
    execSync(`launchctl load "${PLIST_PATH}"`);
    log('LaunchAgent loaded. Daemon will auto-start on login.');
  });

daemon
  .command('uninstall')
  .description('Remove macOS LaunchAgent')
  .action(() => {
    if (!existsSync(PLIST_PATH)) {
      log('LaunchAgent not installed');
      return;
    }
    try { execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null`); } catch {}
    unlinkSync(PLIST_PATH);
    log('LaunchAgent removed.');
  });

// ===== Session management =====

program
  .command('status')
  .description('Show all sessions and daemon status')
  .action(async () => {
    const { listActive } = await import('./session-registry.js');
    const sessions = listActive();
    if (sessions.length === 0) {
      log('No active sessions.');
      return;
    }
    log(`${sessions.length} active session(s):\n`);
    for (const s of sessions) {
      const type = s.agentType ?? 'unknown';
      const age = Math.round((Date.now() - new Date(s.startedAt).getTime()) / 1000);
      log(`  [${type}] :${s.port} — ${s.projectName} (PID ${s.pid}, ${age}s)`);
    }
  });

program
  .command('stop')
  .description('Stop a session or all sessions')
  .option('-p, --port <port>', 'Bridge server port', String(BRIDGE_WS_PORT))
  .option('-a, --all', 'Stop all sessions')
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    if (opts.all) {
      const { listActive } = await import('./session-registry.js');
      const sessions = listActive();
      for (const s of sessions) {
        try {
          const url = s.agentType === 'daemon'
            ? `http://127.0.0.1:${s.port}/shutdown`
            : `http://127.0.0.1:${s.port}/hooks/shutdown`;
          await fetch(url, { method: 'POST' });
          log(`Sent stop to :${s.port} (${s.projectName})`);
        } catch {
          log(`Failed to reach :${s.port}`);
        }
      }
    } else {
      try {
        await fetch(`http://127.0.0.1:${port}/hooks/shutdown`, { method: 'POST' });
        log('Shutdown signal sent');
      } catch {
        log('Session is not running');
      }
    }
  });

// ===== Device commands =====

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
  .description('Show pairing URL and QR code')
  .option('-p, --port <port>', 'Bridge server port (auto-detects from running sessions)')
  .action(async (opts) => {
    const { getOrCreateToken, getWsUrl } = await import('./auth.js');
    const { listActive } = await import('./session-registry.js');

    let port: number;
    if (opts.port) {
      port = parseInt(opts.port, 10);
    } else {
      const sessions = listActive();
      if (sessions.length > 0) {
        port = sessions[0].port;
        if (sessions.length > 1) {
          log(`Multiple sessions running. Using port ${port} (${sessions[0].projectName}).`);
        }
      } else {
        port = BRIDGE_WS_PORT;
      }
    }

    getOrCreateToken();
    const url = getWsUrl(port);
    log(`\nPairing URL:\n  ${url}\n`);

    try {
      const { default: QRCode } = await import('qrcode');
      const text = await (QRCode as any).toString(url, { type: 'terminal', small: true });
      log(text);
    } catch {
      // qrcode not available
    }
  });

program
  .command('diag')
  .description('Generate diagnostic dump')
  .option('-p, --port <port>', 'Bridge server port', String(BRIDGE_WS_PORT))
  .option('-a, --analyze', 'Run AI analysis on the dump')
  .option('-t, --tail <lines>', 'Number of journal entries', '200')
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

// ===== Pixoo commands =====

const pixoo = program.command('pixoo').description('Manage Pixoo64 LED matrix devices');

pixoo
  .command('scan')
  .description('Discover Pixoo devices on LAN')
  .action(async () => {
    const { discoverDevices, getDeviceConfig } = await import('./pixoo/pixoo-client.js');
    const { loadPixooDevices, savePixooDevices } = await import('./pixoo/pixoo-settings.js');

    log('Scanning for Pixoo devices...');
    const found = await discoverDevices();
    if (found.length === 0) {
      log('No devices found.');
      return;
    }

    const verified: Array<{ name: string; ip: string; ok: boolean }> = [];
    for (const d of found) {
      const config = await getDeviceConfig(d.ip);
      verified.push({ ...d, ok: config !== null });
    }

    log(`\nFound ${verified.length} device(s):`);
    for (const d of verified) {
      log(`  ${d.name} (${d.ip}) ${d.ok ? '\u2713 reachable' : '\u2717 unreachable'}`);
    }

    const reachable = verified.filter(d => d.ok);
    if (reachable.length === 0) {
      log('\nNo reachable devices to save.');
      return;
    }

    const readline = await import('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const answer = await new Promise<string>(resolve => {
      rl.question(`\nSave ${reachable.length} device(s)? (Y/n) `, resolve);
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
  .description('Manually add a Pixoo device')
  .option('-n, --name <name>', 'Device name', 'Pixoo64')
  .option('-b, --brightness <value>', 'Brightness 0-100')
  .action(async (ip: string, opts) => {
    const { getDeviceConfig } = await import('./pixoo/pixoo-client.js');
    const { addDevice } = await import('./pixoo/pixoo-settings.js');

    log(`Testing connection to ${ip}...`);
    const config = await getDeviceConfig(ip);
    log(config ? 'Device reachable \u2713' : `Cannot reach ${ip}. Adding anyway.`);

    const device: { ip: string; name?: string; brightness?: number } = { ip, name: opts.name };
    if (opts.brightness) device.brightness = Math.max(0, Math.min(100, parseInt(opts.brightness, 10)));

    if (addDevice(device)) {
      log(`Added ${device.name} (${ip}) to settings.`);
    } else {
      log(`Device ${ip} already exists.`);
    }
  });

pixoo
  .command('list')
  .description('List configured Pixoo devices')
  .action(async () => {
    const { loadPixooDevices } = await import('./pixoo/pixoo-settings.js');
    const devices = loadPixooDevices();
    if (devices.length === 0) {
      log('No Pixoo devices configured. Run `agentdeck pixoo scan`.');
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
  .description('Remove a Pixoo device')
  .action(async (ip: string) => {
    const { removeDevice } = await import('./pixoo/pixoo-settings.js');
    if (removeDevice(ip)) {
      log(`Removed ${ip}.`);
    } else {
      log(`Device ${ip} not found.`);
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
        log('No device specified and none configured.');
        return;
      }
      targetIp = devices[0].ip;
      log(`Using first configured device: ${targetIp}`);
    }

    const buf = new Uint8Array(64 * 64 * 3);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const i = (y * 64 + x) * 3;
        const hue = ((x + y) * 4) % 256;
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
    log(ok ? `Test frame sent to ${targetIp} \u2713` : `Failed to send to ${targetIp}`);
  });

// ===== WiFi Setup =====

program
  .command('wifi-setup')
  .description('Configure WiFi for ESP32 independent operation (USB-free)')
  .option('--ssid <ssid>', 'WiFi network name (auto-detected from macOS if omitted)')
  .option('--password <password>', 'WiFi password (auto-fetched from Keychain if omitted)')
  .action(async (opts) => {
    const { detectCurrentSSID, getKeychainPassword, saveWifiConfig } = await import('./wifi-config.js');

    let ssid = opts.ssid as string | undefined;
    let password = opts.password as string | undefined;

    if (!ssid) {
      const detected = detectCurrentSSID();
      if (detected) {
        log(`Detected WiFi: ${detected}`);
        ssid = detected;
      } else {
        log('Could not detect WiFi network. Use --ssid <name>');
        process.exit(1);
      }
    }

    if (!password) {
      log(`Looking up Keychain password for "${ssid}"...`);
      const keychainPw = getKeychainPassword(ssid);
      if (keychainPw) {
        log('Found password in Keychain \u2713');
        password = keychainPw;
      } else {
        log('Password not found in Keychain. Use --password <pw>');
        process.exit(1);
      }
    }

    saveWifiConfig({ ssid, password, autoProvision: true });
    log(`WiFi config saved: SSID="${ssid}" \u2192 ~/.agentdeck/wifi-config.json`);
    log('Daemon will auto-provision ESP32 devices on next restart.');
  });

// ===== TUI Dashboard =====

program
  .command('dashboard')
  .alias('dash')
  .description('TUI monitoring dashboard with terrarium animation')
  .option('-p, --port <port>', 'Bridge port (auto-discover if omitted)')
  .option('-s, --session <id>', 'Specific session ID')
  .action(async (opts) => {
    const { startDashboard } = await import('./tui/dashboard.js');
    await startDashboard(opts);
  });

// ===== Backward compat: `agentdeck start` → `agentdeck daemon start` =====

program
  .command('start', { hidden: true })
  .description('(legacy) Start daemon in foreground — use `agentdeck daemon start`')
  .option('-p, --port <port>', 'Server port', String(BRIDGE_WS_PORT))
  .option('-d, --debug', 'Enable debug logging')
  .action(async (opts) => {
    // Legacy: runs foreground (LaunchAgent plist compatibility)
    const { findExistingDaemon } = await import('./session-registry.js');
    const existing = findExistingDaemon();
    if (existing) {
      log(`Daemon already running on port ${existing.port} (PID ${existing.pid}).`);
      process.exit(0);
    }
    const { startDaemon } = await import('./daemon-server.js');
    await startDaemon({
      port: parseInt(opts.port, 10),
      debug: opts.debug,
    });
  });

// ===== Default command (no args) =====

// If no command specified, show status or help
program.action(async () => {
  const { listActive } = await import('./session-registry.js');
  const sessions = listActive();

  if (sessions.length === 0) {
    program.help();
    return;
  }

  log('AgentDeck — Active sessions:\n');
  for (const s of sessions) {
    const type = s.agentType ?? 'unknown';
    const age = Math.round((Date.now() - new Date(s.startedAt).getTime()) / 1000);
    log(`  [${type}] :${s.port} — ${s.projectName} (PID ${s.pid}, ${age}s)`);
  }
  log('\nRun `agentdeck --help` for all commands.');
});

program.parse();
