import type { DeviceModule, ModuleConfigs, BridgeContext } from './types.js';
import { MdnsModule } from './mdns-module.js';
import { AdbModule } from './adb-module.js';
import { SerialModule } from './serial-module.js';
import { PixooModule } from './pixoo-module.js';
import { D200hModule } from './d200h-module.js';
import type { AgentType } from '../types.js';
import { debug } from '../logger.js';

export type { DeviceModule, ModuleConfigs, BridgeContext } from './types.js';
export { MdnsModule } from './mdns-module.js';
export { AdbModule } from './adb-module.js';
export { SerialModule } from './serial-module.js';
export { PixooModule } from './pixoo-module.js';
export { D200hModule } from './d200h-module.js';

/**
 * Create default module instances for a given agent type.
 */
export function createDefaultModules(agentType: AgentType): DeviceModule[] {
  return [
    new MdnsModule(agentType),
    new AdbModule(),
    new SerialModule(),
    new PixooModule(),
    new D200hModule(),
  ];
}

/**
 * Initialize and start all modules that should be active.
 *
 * @returns array of started modules (for later shutdown)
 */
export async function initModules(
  modules: DeviceModule[],
  configs: ModuleConfigs,
  ctx: BridgeContext,
): Promise<DeviceModule[]> {
  const started: DeviceModule[] = [];

  for (const mod of modules) {
    const config = (configs as Record<string, 'auto' | boolean | undefined>)[mod.name] ?? 'auto';
    try {
      const shouldActivate = await mod.shouldActivate(config as 'auto' | boolean);
      if (shouldActivate) {
        await mod.start(ctx);
        started.push(mod);
        debug('modules', `${mod.name}: started`);
      } else {
        debug('modules', `${mod.name}: skipped (config=${config})`);
      }
    } catch (err) {
      debug('modules', `${mod.name}: failed to start: ${err}`);
      // Non-critical — continue with other modules
    }
  }

  return started;
}

/**
 * Stop all started modules.
 */
export async function stopModules(modules: DeviceModule[]): Promise<void> {
  for (const mod of modules) {
    try {
      await mod.stop();
      debug('modules', `${mod.name}: stopped`);
    } catch (err) {
      debug('modules', `${mod.name}: stop error: ${err}`);
    }
  }
}
