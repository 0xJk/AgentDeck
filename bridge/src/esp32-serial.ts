/**
 * ESP32 Serial Bridge — bidirectional USB serial communication.
 *
 * Detects ESP32 devices (CH340/CP210x) on USB serial ports,
 * opens the port for read+write, and sends newline-delimited JSON
 * matching the same protocol as WebSocket.
 *
 * Read path: parses newline-delimited JSON from ESP32 (device_info,
 * wifi_provision_ack, wifi_status). Non-JSON debug lines are ignored.
 *
 * ESP32 side reads lines starting with '{' and passes to Protocol::parseMessage().
 */

import { exec } from 'child_process';
import { createWriteStream, createReadStream, type WriteStream, type ReadStream } from 'fs';
import type { BridgeEvent } from './types.js';
import { SERIAL_FORWARDED_EVENTS } from '@agentdeck/shared/protocol';
import type { ESP32ToHostMessage, WifiProvisionMessage } from '@agentdeck/shared/protocol';
import { debug } from './logger.js';

// Serial port patterns for ESP32 devices
const ESP32_PORT_PATTERNS = [
  /\/dev\/cu\.usbserial-\d+/,   // CH340 (86 Box)
  /\/dev\/cu\.usbmodem\d+/,      // Native USB JTAG (IPS 3.5", Round AMOLED)
  /\/dev\/ttyUSB\d+/,            // Linux CH340
  /\/dev\/ttyACM\d+/,            // Linux native USB
];

// Exclude known non-ESP32 devices
const EXCLUDE_PATTERNS = [
  /Bluetooth/i,
  /WLAN/i,
];

interface SerialConnection {
  port: string;
  stream: WriteStream;
  reader: ReadStream | null;
  readBuf: string;
  connected: boolean;
  deviceInfo: { board?: string; version?: string; wifiConfigured?: boolean; wifiConnected?: boolean } | null;
  provisionSent: boolean;
}

let connections: SerialConnection[] = [];
let pollTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let stateProvider: (() => BridgeEvent | null) | null = null;
let messageHandler: ((port: string, msg: ESP32ToHostMessage) => void) | null = null;

// Events to forward — shared constant from @agentdeck/shared
const FORWARDED_EVENTS = SERIAL_FORWARDED_EVENTS;

/** Run a shell command with timeout, escalating to SIGKILL if SIGTERM fails. */
function execWithKill(cmd: string, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = exec(cmd, { encoding: 'utf-8', timeout: timeoutMs }, (err, stdout) => {
      if (err) {
        reject(err);
      } else {
        resolve(stdout);
      }
    });
    // When exec timeout fires, it sends SIGTERM. But stty stuck in kernel I/O
    // ignores SIGTERM. Schedule a SIGKILL as escalation.
    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
    }, timeoutMs + 1000);
    child.on('exit', () => clearTimeout(killTimer));
  });
}

async function detectESP32Ports(): Promise<string[]> {
  try {
    const platform = process.platform;
    let output: string;

    if (platform === 'darwin') {
      output = await execWithKill('ls /dev/cu.usb* 2>/dev/null || true');
    } else if (platform === 'linux') {
      output = await execWithKill('ls /dev/ttyUSB* /dev/ttyACM* 2>/dev/null || true');
    } else {
      return [];
    }

    const ports = output.trim().split('\n').filter(Boolean);

    // Filter to ESP32 patterns, exclude known non-ESP32
    return ports.filter(port => {
      if (EXCLUDE_PATTERNS.some(p => p.test(port))) return false;
      return ESP32_PORT_PATTERNS.some(p => p.test(port));
    });
  } catch {
    return [];
  }
}

function handleSerialLine(conn: SerialConnection, line: string): void {
  if (!line.startsWith('{')) return; // Skip debug output like "[WiFi] Connected"

  try {
    const msg = JSON.parse(line) as ESP32ToHostMessage;
    if (msg.type) {
      debug('ESP32', `← ${conn.port}: ${msg.type}`);
      conn.deviceInfo = conn.deviceInfo || {};

      if (msg.type === 'device_info') {
        conn.deviceInfo = {
          board: msg.board,
          version: msg.version,
          wifiConfigured: msg.wifiConfigured,
          wifiConnected: msg.wifiConnected,
        };
      }

      if (messageHandler) {
        messageHandler(conn.port, msg);
      }
    }
  } catch {
    // Not valid JSON — ignore (ESP32 debug output)
  }
}

async function openPort(port: string): Promise<SerialConnection | null> {
  try {
    // Configure baud rate + disable DTR/RTS to prevent ESP32 reset
    const platform = process.platform;
    if (platform === 'darwin') {
      await execWithKill(`stty -f ${port} 115200 cs8 -cstopb -parenb -hupcl`);
    } else if (platform === 'linux') {
      await execWithKill(`stty -F ${port} 115200 cs8 -cstopb -parenb -hupcl`);
    }

    const stream = createWriteStream(port, { flags: 'w' });
    const conn: SerialConnection = {
      port, stream, reader: null, readBuf: '',
      connected: true, deviceInfo: null, provisionSent: false,
    };

    stream.on('error', (err) => {
      debug('ESP32', `Serial write error on ${port}: ${err.message}`);
      conn.connected = false;
    });

    stream.on('close', () => {
      debug('ESP32', `Serial write closed: ${port}`);
      conn.connected = false;
    });

    // Open read stream for incoming ESP32 messages
    try {
      const reader = createReadStream(port, { flags: 'r', encoding: 'utf-8' });
      conn.reader = reader;

      reader.on('data', (chunk: string | Buffer) => {
        const str = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
        conn.readBuf += str;
        let newlineIdx: number;
        while ((newlineIdx = conn.readBuf.indexOf('\n')) !== -1) {
          const line = conn.readBuf.slice(0, newlineIdx).trim();
          conn.readBuf = conn.readBuf.slice(newlineIdx + 1);
          if (line.length > 0) {
            handleSerialLine(conn, line);
          }
        }
        // Prevent buffer bloat from non-newline data
        if (conn.readBuf.length > 8192) {
          conn.readBuf = '';
        }
      });

      reader.on('error', (err) => {
        debug('ESP32', `Serial read error on ${port}: ${err.message}`);
        // Read errors don't necessarily mean write is broken
      });

      reader.on('close', () => {
        conn.reader = null;
      });
    } catch (err: any) {
      debug('ESP32', `Failed to open reader on ${port}: ${err.message}`);
      // Write-only still works for broadcast
    }

    debug('ESP32', `Opened serial port (r/w): ${port}`);

    // Request device info on connect
    sendToConnection(conn, JSON.stringify({ type: 'device_info_request' }));

    return conn;
  } catch (err: any) {
    debug('ESP32', `Failed to open ${port}: ${err.message}`);
    return null;
  }
}

function sendToConnection(conn: SerialConnection, json: string): void {
  if (!conn.connected) return;
  try {
    conn.stream.write(json + '\n');
  } catch {
    conn.connected = false;
  }
}

/**
 * Register a callback that returns the current state_update event.
 * Used to send periodic heartbeats so ESP32 gets data even without
 * state changes (e.g., after reboot while bridge is idle).
 */
export function setESP32StateProvider(provider: () => BridgeEvent | null): void {
  stateProvider = provider;
}

/**
 * Register a handler for messages received from ESP32 devices.
 * Called with (portPath, parsedMessage) for each JSON message.
 */
export function onESP32Message(handler: (port: string, msg: ESP32ToHostMessage) => void): void {
  messageHandler = handler;
}

function sendHeartbeat(): void {
  if (connections.length === 0 || !stateProvider) return;
  const event = stateProvider();
  if (!event) return;
  const json = JSON.stringify(event);
  for (const conn of connections) {
    sendToConnection(conn, json);
  }
}

/**
 * Start ESP32 serial bridge.
 * Detects USB serial ports and opens connections.
 * Call broadcast() to send events to all connected ESP32 devices.
 *
 * Non-blocking: initial device detection runs in background so a hung
 * USB port (stty stuck in kernel I/O) cannot block bridge startup.
 */
export function startESP32Serial(): void {
  // Fire-and-forget initial detection (non-blocking)
  pollForDevices().catch(err => {
    debug('ESP32', `Initial poll failed: ${err.message}`);
  });

  // Poll for new/disconnected devices every 10 seconds
  pollTimer = setInterval(() => {
    pollForDevices().catch(err => {
      debug('ESP32', `Poll failed: ${err.message}`);
    });
  }, 10000);

  // Heartbeat: send current state every 5 seconds so ESP32 stays in sync
  heartbeatTimer = setInterval(sendHeartbeat, 5000);

  debug('ESP32', 'Serial bridge started');
}

async function pollForDevices(): Promise<void> {
  const ports = await detectESP32Ports();

  // Remove disconnected
  connections = connections.filter(c => {
    if (!c.connected) {
      try { c.stream.end(); } catch { /* ignore */ }
      try { c.reader?.destroy(); } catch { /* ignore */ }
      return false;
    }
    return true;
  });

  // Add new ports
  for (const port of ports) {
    if (!connections.some(c => c.port === port)) {
      const conn = await openPort(port);
      if (conn) {
        connections.push(conn);
      }
    }
  }
}

/**
 * Broadcast a BridgeEvent to all connected ESP32 devices via serial.
 */
export function broadcastESP32(event: BridgeEvent): void {
  if (connections.length === 0) return;
  if (!FORWARDED_EVENTS.has(event.type)) return;

  const json = JSON.stringify(event);
  for (const conn of connections) {
    sendToConnection(conn, json);
  }
}

/**
 * Send a WiFi provision message to a specific ESP32 device by port path.
 */
export function sendWifiProvision(port: string, msg: WifiProvisionMessage): boolean {
  const conn = connections.find(c => c.port === port && c.connected);
  if (!conn) return false;
  sendToConnection(conn, JSON.stringify(msg));
  conn.provisionSent = true;
  debug('ESP32', `→ ${port}: wifi_provision (SSID: ${msg.ssid})`);
  return true;
}

/**
 * Send WiFi provision to all connected ESP32 devices that haven't been provisioned.
 */
export function sendWifiProvisionToAll(msg: WifiProvisionMessage): number {
  let count = 0;
  for (const conn of connections) {
    if (!conn.connected) continue;
    // Skip if already provisioned or WiFi already configured
    if (conn.provisionSent) continue;
    if (conn.deviceInfo?.wifiConnected) continue;
    sendToConnection(conn, JSON.stringify(msg));
    conn.provisionSent = true;
    count++;
    debug('ESP32', `→ ${conn.port}: wifi_provision (SSID: ${msg.ssid})`);
  }
  return count;
}

/**
 * Get device info for all connected ESP32 devices.
 */
export function getESP32DeviceInfo(): Array<{ port: string; board?: string; version?: string; wifiConfigured?: boolean; wifiConnected?: boolean }> {
  return connections
    .filter(c => c.connected)
    .map(c => ({
      port: c.port,
      ...c.deviceInfo,
    }));
}

/**
 * Stop ESP32 serial bridge and close all connections.
 */
export function stopESP32Serial(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  for (const conn of connections) {
    conn.connected = false;
    try { conn.stream.end(); } catch { /* ignore */ }
    try { conn.reader?.destroy(); } catch { /* ignore */ }
  }
  connections = [];
  messageHandler = null;
  debug('ESP32', 'Serial bridge stopped');
}

/**
 * Get number of connected ESP32 devices.
 */
export function esp32ConnectionCount(): number {
  return connections.filter(c => c.connected).length;
}

/**
 * Get list of connected ESP32 serial port paths.
 */
export function getESP32Ports(): string[] {
  return connections.filter(c => c.connected).map(c => c.port);
}
