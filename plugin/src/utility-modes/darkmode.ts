import type { UtilityMode } from './types.js';
import { getDarkMode, toggleDarkMode } from './macos.js';

export function createDarkMode(): UtilityMode {
  let isDark = false;

  return {
    id: 'darkmode',
    label: '\u263E',

    async onActivate() {
      try {
        isDark = await getDarkMode();
      } catch { /* keep local */ }
    },

    async onRotate(_ticks) {
      // Rotate toggles dark mode (cycle through Light → Dark → Light)
      try {
        isDark = await toggleDarkMode();
      } catch { /* ignore */ }
    },

    async onPush() {
      try {
        isDark = await toggleDarkMode();
      } catch { /* ignore */ }
    },

    getFeedback() {
      return {
        title: isDark ? '\u263E DARK' : '\u2600 LIGHT',
        value: isDark ? 'Dark Mode' : 'Light Mode',
        indicator: {
          value: isDark ? 100 : 0,
          bar_fill_c: isDark ? '#6366f1' : '#fbbf24',
        },
      };
    },
  };
}
