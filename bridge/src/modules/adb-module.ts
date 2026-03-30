import type { DeviceModule, BridgeContext } from './types.js';
import { setupAdbReverse, cleanupAdbReverse, startAdbReversePolling } from '../adb-reverse.js';
import { execSync } from 'child_process';

/**
 * ADB reverse tunnel module for Android dashboard clients.
 * D200H Deck Dock is now handled by D200hModule (HID protocol).
 */
export class AdbModule implements DeviceModule {
  readonly name = 'adb';
  private port = 0;
  private stopPolling: (() => void) | null = null;

  async shouldActivate(config: 'auto' | boolean): Promise<boolean> {
    if (config === false) return false;
    if (config === true) return true;
    // auto: check if adb is available
    try {
      execSync('which adb', { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  async start(ctx: BridgeContext): Promise<void> {
    this.port = ctx.port;
    setupAdbReverse(ctx.port);
    this.stopPolling = startAdbReversePolling(ctx.port);
  }

  async stop(): Promise<void> {
    this.stopPolling?.();
    this.stopPolling = null;
    cleanupAdbReverse(this.port);
  }
}
