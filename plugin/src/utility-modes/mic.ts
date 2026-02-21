import type { UtilityMode } from './types.js';
import { getVolumeSettings, setInputVolume } from './macos.js';

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function createMicMode(step = 1): UtilityMode {
  let volume = 80;
  let muted = false;
  let preMuteVolume = 80;

  return {
    id: 'mic',
    label: 'MIC',

    async onActivate() {
      try {
        const s = await getVolumeSettings();
        volume = s.inputVolume;
        muted = volume === 0;
        if (!muted) preMuteVolume = volume;
      } catch { /* keep local values */ }
    },

    async onRotate(ticks) {
      volume = clamp(volume + ticks * step, 0, 100);
      muted = volume === 0;
      setInputVolume(volume);
    },

    async onPush() {
      if (muted) {
        volume = preMuteVolume || 80;
        muted = false;
      } else {
        preMuteVolume = volume;
        volume = 0;
        muted = true;
      }
      setInputVolume(volume);
    },

    getFeedback() {
      return {
        title: muted ? 'MIC MUTE' : 'MIC',
        value: muted ? 'Muted' : `${volume}%`,
        indicator: {
          value: muted ? 0 : volume,
          bar_fill_c: muted ? '#991b1b' : '#3b82f6',
        },
      };
    },
  };
}
