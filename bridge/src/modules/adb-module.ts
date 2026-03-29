import type { DeviceModule, BridgeContext } from './types.js';
import { setupAdbReverse, cleanupAdbReverse, startAdbReversePolling, startD200hPolling, updateD200hState, onD200hCommand } from '../adb-reverse.js';
import { execSync } from 'child_process';

export class AdbModule implements DeviceModule {
  readonly name = 'adb';
  private port = 0;
  private stopPolling: (() => void) | null = null;
  private stopD200hPolling: (() => void) | null = null;

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

    // D200H: fast 0.5s polling to catch the 4-second ADB window
    this.stopD200hPolling = startD200hPolling(ctx.port);

    // Forward state/usage broadcasts to D200H agent via stdin pipe
    ctx.wsServer.onBroadcast((evt: any) => {
      if (evt?.type === 'state_update' || evt?.type === 'usage_update') {
        updateD200hState(evt);
      }
    });

    // Wire D200H button commands to WS command handler
    onD200hCommand((cmd) => ctx.wsServer.dispatchCommand(cmd));
  }

  async stop(): Promise<void> {
    this.stopD200hPolling?.();
    this.stopD200hPolling = null;
    this.stopPolling?.();
    this.stopPolling = null;
    cleanupAdbReverse(this.port);
  }
}
