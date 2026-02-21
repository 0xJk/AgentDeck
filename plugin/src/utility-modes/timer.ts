import type { UtilityMode, RefreshCallback } from './types.js';
import { showNotification } from './macos.js';

const MIN_SECONDS = 30;      // 30 seconds
const MAX_SECONDS = 120 * 60; // 120 minutes

export function createTimerMode(refresh: RefreshCallback, defaultMinutes = 5): UtilityMode {
  let totalSeconds = defaultMinutes * 60;
  let remainingSeconds = totalSeconds;
  let running = false;
  let interval: ReturnType<typeof setInterval> | null = null;

  function stopInterval(): void {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
  }

  function startInterval(): void {
    stopInterval();
    interval = setInterval(() => {
      remainingSeconds--;
      if (remainingSeconds <= 0) {
        remainingSeconds = 0;
        running = false;
        stopInterval();
        void showNotification('Timer', "Time's up!");
      }
      refresh();
    }, 1000);
  }

  return {
    id: 'timer',
    label: '\u23F1',

    // NOTE: onDeactivate intentionally only stops interval on full cleanup
    // (rebuildModes / onWillDisappear). Mode-switch uses switchAway flag instead.
    // The timer keeps its running state so it can resume on mode switch back.
    onDeactivate() {
      stopInterval();
      running = false;
    },

    async onActivate() {
      // Resume interval if timer was running before mode switch
      if (running && !interval) {
        startInterval();
      }
    },

    async onRotate(ticks) {
      if (!running) {
        // Variable step: 30s under 5min, 60s otherwise
        const step = totalSeconds < 300 ? 30 : 60;
        totalSeconds = Math.max(MIN_SECONDS, Math.min(totalSeconds + ticks * step, MAX_SECONDS));
        remainingSeconds = totalSeconds;
      }
    },

    async onPush() {
      if (running) {
        // Pause — stop interval but keep running=true so onActivate won't restart
        running = false;
        stopInterval();
      } else if (remainingSeconds <= 0) {
        // Reset
        remainingSeconds = totalSeconds;
      } else {
        // Start
        running = true;
        startInterval();
      }
    },

    getFeedback() {
      const mins = Math.floor(remainingSeconds / 60);
      const secs = remainingSeconds % 60;
      const timeStr = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      const progress = totalSeconds > 0
        ? Math.round(((totalSeconds - remainingSeconds) / totalSeconds) * 100)
        : 0;

      const barColor = running ? '#f59e0b'
        : remainingSeconds <= 0 ? '#22c55e'
        : '#64748b';

      return {
        title: running ? '\u23F1 RUN' : '\u23F1',
        value: timeStr,
        indicator: {
          value: progress,
          bar_fill_c: barColor,
        },
      };
    },
  };
}
