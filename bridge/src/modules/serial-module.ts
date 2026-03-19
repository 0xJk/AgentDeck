import type { DeviceModule, BridgeContext } from './types.js';
import {
  startESP32Serial,
  stopESP32Serial,
  broadcastESP32,
  setESP32StateProvider,
  setESP32UsageProvider,
  setESP32InitialStateProvider,
} from '../esp32-serial.js';
import type { BridgeEvent } from '../types.js';
import { existsSync } from 'fs';

export class SerialModule implements DeviceModule {
  readonly name = 'serial';
  private stateProvider: (() => BridgeEvent | null) | null = null;

  async shouldActivate(config: 'auto' | boolean): Promise<boolean> {
    if (config === false) return false;
    if (config === true) return true;
    // auto: check if any USB serial device is connected
    try {
      const { readdirSync } = await import('fs');
      const devFiles = readdirSync('/dev');
      return devFiles.some((f) => f.startsWith('tty.usbserial') || f.startsWith('tty.wchusbserial') || f.startsWith('tty.usbmodem'));
    } catch {
      return false;
    }
  }

  /** Set a function that provides the latest state event for ESP32 heartbeat.
   *  Can be called before or after start() — if already started, wires immediately. */
  setStateProvider(provider: () => BridgeEvent | null): void {
    this.stateProvider = provider;
    setESP32StateProvider(provider);
  }

  /** Set a function that provides the latest usage event for ESP32 heartbeat. */
  setUsageProvider(provider: () => BridgeEvent | null): void {
    setESP32UsageProvider(provider);
  }

  private initialStateProvider: (() => BridgeEvent[]) | null = null;

  /** Set a provider that returns all initial state events for newly connected devices. */
  setInitialStateProvider(provider: () => BridgeEvent[]): void {
    this.initialStateProvider = provider;
    setESP32InitialStateProvider(provider);
  }

  async start(ctx: BridgeContext): Promise<void> {
    startESP32Serial();
    if (this.stateProvider) {
      setESP32StateProvider(this.stateProvider);
    }
    ctx.wsServer.onBroadcast(broadcastESP32);
  }

  async stop(): Promise<void> {
    stopESP32Serial();
  }
}
