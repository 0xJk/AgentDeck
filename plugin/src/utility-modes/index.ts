/**
 * Mode registry — creates and manages the set of enabled utility modes.
 */
import type { UtilityMode, RefreshCallback } from './types.js';
import { createVolumeMode } from './volume.js';
import { createMicMode } from './mic.js';
import { createMediaMode } from './media.js';
import { createTimerMode } from './timer.js';

export type { UtilityMode, RefreshCallback } from './types.js';

const DEFAULT_ENABLED = ['volume'];

interface ModeFactoryOptions {
  refresh: RefreshCallback;
}

/** All available mode factories, keyed by id. */
const FACTORIES: Record<string, (opts: ModeFactoryOptions) => UtilityMode> = {
  volume: () => createVolumeMode(),
  mic: () => createMicMode(),
  media: (opts) => createMediaMode(opts.refresh),
  timer: (opts) => createTimerMode(opts.refresh),
};

/** Ordered list of all available mode IDs. */
export const ALL_MODE_IDS = ['volume', 'mic', 'media', 'timer'];

/**
 * Create the enabled modes based on a comma-separated list.
 * Returns an array of instantiated modes in the order specified.
 */
export function createModes(
  enabledList: string | undefined,
  opts: ModeFactoryOptions,
): UtilityMode[] {
  const ids = enabledList
    ? enabledList.split(',').map(s => s.trim()).filter(s => FACTORIES[s])
    : DEFAULT_ENABLED;

  if (ids.length === 0) return DEFAULT_ENABLED.map(id => FACTORIES[id](opts));
  return ids.map(id => FACTORIES[id](opts));
}

/**
 * Generate mode-dots string showing active mode position.
 * e.g. "●○○○" for first of 4 modes.
 */
export function modeDots(activeIndex: number, total: number): string {
  return Array.from({ length: total }, (_, i) =>
    i === activeIndex ? '\u25CF' : '\u25CB',
  ).join('');
}
