import type { DeviceModule, BridgeContext } from './types.js';
import { startPixooBridge, stopPixooBridge, broadcastPixoo, setPixooBroadcast } from '../pixoo/pixoo-bridge.js';
import { loadPixooDevices } from '../pixoo/pixoo-settings.js';

export class PixooModule implements DeviceModule {
  readonly name = 'pixoo';

  async shouldActivate(config: 'auto' | boolean): Promise<boolean> {
    if (config === false) return false;
    if (config === true) return true;
    // auto: check if any Pixoo devices are configured
    const devices = loadPixooDevices();
    return devices.length > 0;
  }

  async start(ctx: BridgeContext): Promise<void> {
    const devices = loadPixooDevices();
    setPixooBroadcast((event) => ctx.wsServer.broadcast(event));
    startPixooBridge(devices);
    ctx.wsServer.onBroadcast(broadcastPixoo);
  }

  async stop(): Promise<void> {
    await stopPixooBridge();
  }
}
