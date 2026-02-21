import type { UtilityMode } from './types.js';
import { getVolumeSettings, setOutputVolume, setOutputMuted } from './macos.js';

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function createVolumeMode(step = 1): UtilityMode {
  let volume = 50;
  let muted = false;

  return {
    id: 'volume',
    label: 'VOL',

    async onActivate() {
      try {
        const s = await getVolumeSettings();
        volume = s.outputVolume;
        muted = s.outputMuted;
      } catch { /* keep local values */ }
    },

    async onRotate(ticks) {
      volume = clamp(volume + ticks * step, 0, 100);
      muted = false;
      setOutputVolume(volume);
    },

    async onPush() {
      muted = !muted;
      setOutputMuted(muted);
    },

    getFeedback() {
      return {
        title: muted ? 'VOL MUTE' : 'VOL',
        value: muted ? 'Muted' : `${volume}%`,
        indicator: {
          value: muted ? 0 : volume,
          bar_fill_c: muted ? '#991b1b' : '#22c55e',
        },
      };
    },
  };
}
