import type { UtilityMode } from './types.js';
import { brightnessUp, brightnessDown } from './macos.js';

/**
 * Brightness mode — uses System Events key codes to adjust display brightness.
 * macOS Accessibility permission may be required for key code simulation.
 * Tracks a local step counter (0–16) since there's no direct API to read brightness level.
 */
export function createBrightnessMode(): UtilityMode {
  let level = 8; // 0-16 steps, start at midpoint
  const MAX = 16;

  return {
    id: 'brightness',
    label: 'BRT',

    async onRotate(ticks) {
      const steps = Math.abs(ticks);
      for (let i = 0; i < steps; i++) {
        if (ticks > 0 && level < MAX) {
          level++;
          brightnessUp();
        } else if (ticks < 0 && level > 0) {
          level--;
          brightnessDown();
        }
      }
    },

    async onPush() {
      // Toggle to minimum brightness
      if (level > 0) {
        const stepsDown = level;
        level = 0;
        for (let i = 0; i < stepsDown; i++) {
          brightnessDown();
        }
      } else {
        level = MAX;
        for (let i = 0; i < MAX; i++) {
          brightnessUp();
        }
      }
    },

    getFeedback() {
      const pct = Math.round((level / MAX) * 100);
      return {
        title: 'BRT',
        value: `${pct}%`,
        indicator: {
          value: pct,
          bar_fill_c: '#fbbf24',
        },
      };
    },
  };
}
