/**
 * D200H HID Device Module — communicates with Ulanzi D200H via stock HID protocol.
 *
 * The D200H boots into HID mode (VID 0x2207, PID 0x0019) after 4 seconds.
 * This module:
 *  - Detects the device via node-hid enumeration
 *  - Sends dashboard images via SET_BUTTONS (ZIP with manifest.json + PNGs)
 *  - Receives button press events and dispatches commands
 *  - Manages brightness and keep-alive
 *
 * No ADB, no firmware modification, no on-device agent needed.
 */

import type { DeviceModule, BridgeContext } from './types.js';
import { buildZipPackets, buildBrightnessPacket, buildSmallWindowPacket, parseIncoming, CMD } from '../d200h/hid-protocol.js';
import { renderDashboardZip, stateHash } from '../d200h/image-renderer.js';
import { debug } from '../logger.js';

const TAG = 'd200h';

const VID = 0x2207;
const PID = 0x0019;
const CONSUMER_USAGE_PAGE = 12;
const KEYBOARD_USAGE_PAGE = 1;

const POLL_INTERVAL = 500;     // Device detection polling (ms)
const READ_INTERVAL = 20;      // HID read polling (ms)
const KEEPALIVE_INTERVAL = 30_000; // Keep-alive interval (ms)

// Button index → AgentDeck command mapping
const BUTTON_COMMANDS: Record<number, any> = {
  0: { type: 'mode_toggle' },
  1: { type: 'session_switch' },
  2: { type: 'usage_toggle' },
  3: { type: 'select_option', index: 0 },
  4: { type: 'select_option', index: 1 },
  5: { type: 'select_option', index: 2 },
  6: { type: 'select_option', index: 3 },
  10: { type: 'interrupt' },
};

type HIDDevice = {
  write(data: Buffer | number[]): number;
  read(length?: number): number[] | Buffer;
  readTimeout?(timeout: number): number[] | Buffer;
  close(): void;
  on?(event: string, callback: (...args: any[]) => void): void;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type HIDModule = {
  devices(...args: any[]): any[];
  HID: new (path: string) => HIDDevice;
};

export class D200hModule implements DeviceModule {
  readonly name = 'd200h';

  private hidModule: HIDModule | null = null;
  private consumerDevice: HIDDevice | null = null;
  private keyboardDevice: HIDDevice | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readTimer: ReturnType<typeof setInterval> | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private commandHandler: ((cmd: any) => void) | null = null;
  private lastStateHash = '';
  private lastState: any = null;
  private connected = false;

  async shouldActivate(config: 'auto' | boolean): Promise<boolean> {
    if (config === false) return false;

    try {
      this.hidModule = await this.loadHidModule();
      if (!this.hidModule) return false;

      if (config === true) return true;

      // auto: check if D200H is connected
      return this.findDevice() !== null;
    } catch {
      return false;
    }
  }

  async start(ctx: BridgeContext): Promise<void> {
    debug(TAG, 'Starting D200H HID module');

    // Wire command handler
    this.commandHandler = (cmd) => ctx.wsServer.dispatchCommand(cmd);

    // Forward state broadcasts to display
    ctx.wsServer.onBroadcast((evt: any) => {
      if (evt?.type === 'state_update') {
        this.lastState = evt;
        this.updateDisplay(evt);
      }
    });

    // Start device detection polling
    this.tryConnect();
    this.pollTimer = setInterval(() => {
      if (!this.connected) {
        this.tryConnect();
      }
    }, POLL_INTERVAL);
  }

  async stop(): Promise<void> {
    debug(TAG, 'Stopping D200H HID module');

    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.readTimer) { clearInterval(this.readTimer); this.readTimer = null; }
    if (this.keepAliveTimer) { clearInterval(this.keepAliveTimer); this.keepAliveTimer = null; }

    this.disconnect();
    this.commandHandler = null;
  }

  // --- Private methods ---

  private async loadHidModule(): Promise<HIDModule | null> {
    try {
      const mod = await import('node-hid');
      return (mod.default ?? mod) as any as HIDModule;
    } catch {
      debug(TAG, 'node-hid not available');
      return null;
    }
  }

  private findDevice(): { consumerPath: string; keyboardPath?: string; serial: string } | null {
    if (!this.hidModule) return null;

    const devices = this.hidModule.devices();
    let consumerPath: string | undefined;
    let keyboardPath: string | undefined;
    let serial = '';

    for (const d of devices) {
      if (d.vendorId === VID && d.productId === PID) {
        serial = d.serialNumber ?? '';
        if (d.usagePage === CONSUMER_USAGE_PAGE) {
          consumerPath = d.path;
        } else if (d.usagePage === KEYBOARD_USAGE_PAGE) {
          keyboardPath = d.path;
        }
      }
    }

    if (consumerPath) {
      return { consumerPath, keyboardPath, serial };
    }
    return null;
  }

  private tryConnect(): void {
    if (!this.hidModule) return;

    const info = this.findDevice();
    if (!info) return;

    try {
      // Open consumer control interface (display updates + some events)
      this.consumerDevice = new this.hidModule.HID(info.consumerPath);
      debug(TAG, `Connected to D200H (serial: ${info.serial}) via Consumer Control`);

      // Try to open keyboard interface (button events) — may fail on macOS
      if (info.keyboardPath) {
        try {
          this.keyboardDevice = new this.hidModule.HID(info.keyboardPath);
          debug(TAG, 'Opened keyboard interface for button events');
        } catch {
          debug(TAG, 'Keyboard interface not available (macOS restriction) — buttons via Consumer interface only');
        }
      }

      this.connected = true;

      // Start reading events
      this.startReading();

      // Start keep-alive
      this.keepAliveTimer = setInterval(() => this.sendKeepAlive(), KEEPALIVE_INTERVAL);

      // Set initial brightness
      this.writeToDevice(buildBrightnessPacket(100));

      // Send current state if available
      if (this.lastState) {
        this.updateDisplay(this.lastState);
      }
    } catch (err) {
      debug(TAG, `Failed to connect: ${err}`);
      this.disconnect();
    }
  }

  private disconnect(): void {
    try { this.consumerDevice?.close(); } catch { /* ignore */ }
    try { this.keyboardDevice?.close(); } catch { /* ignore */ }
    this.consumerDevice = null;
    this.keyboardDevice = null;
    this.connected = false;
    this.lastStateHash = '';
  }

  private startReading(): void {
    if (this.readTimer) { clearInterval(this.readTimer); }

    this.readTimer = setInterval(() => {
      this.readFrom(this.consumerDevice);
      this.readFrom(this.keyboardDevice);
    }, READ_INTERVAL);
  }

  private readFrom(device: HIDDevice | null): void {
    if (!device) return;

    try {
      // Use readTimeout for non-blocking behavior (node-hid v3+)
      const data = device.readTimeout ? device.readTimeout(1) : device.read();
      if (!data || (Array.isArray(data) && data.length === 0)) return;

      const buf = Buffer.from(data as any);
      const event = parseIncoming(buf);
      if (!event) return;

      if (event.type === 'button' && event.data.pressed) {
        const cmd = BUTTON_COMMANDS[event.data.index];
        if (cmd) {
          debug(TAG, `Button ${event.data.index} pressed → ${cmd.type}`);
          this.commandHandler?.(cmd);
        } else {
          debug(TAG, `Button ${event.data.index} pressed (unmapped)`);
        }
      } else if (event.type === 'device_info') {
        debug(TAG, `Device: ${event.data.deviceType} fw=${event.data.firmwareVersion} hw=${event.data.hardwareVersion}`);
      }
    } catch (err: any) {
      if (err?.message?.includes('could not read')) {
        // Device disconnected
        debug(TAG, 'Device disconnected');
        this.disconnect();
      }
    }
  }

  private updateDisplay(stateEvt: any): void {
    const hash = stateHash(stateEvt);
    if (hash === this.lastStateHash) return;
    this.lastStateHash = hash;

    try {
      const zip = renderDashboardZip(stateEvt);
      const packets = buildZipPackets(zip);

      for (const pkt of packets) {
        this.writeToDevice(pkt);
      }

      debug(TAG, `Display updated: ${zip.length} bytes, ${packets.length} packets`);
    } catch (err) {
      debug(TAG, `Display update failed: ${err}`);
    }
  }

  private sendKeepAlive(): void {
    if (!this.connected) return;

    const now = new Date();
    const timeStr = now.toTimeString().slice(0, 8);
    const packet = buildSmallWindowPacket(1, 0, 0, timeStr, 0);
    this.writeToDevice(packet);
  }

  private writeToDevice(packet: Buffer): boolean {
    if (!this.consumerDevice) return false;

    try {
      // node-hid v3 expects number[] for write
      this.consumerDevice.write(Array.from(packet));
      return true;
    } catch (err: any) {
      if (err?.message?.includes('could not write') || err?.message?.includes('could not send')) {
        debug(TAG, 'Write failed — device disconnected');
        this.disconnect();
      }
      return false;
    }
  }
}
