import type { UtilityMode, RefreshCallback } from './types.js';
import {
  mediaPlayPause, mediaNext, getTrackInfo,
  getVolumeSettings, setOutputVolume,
} from './macos.js';

const SCROLL_VISIBLE = 18;
const SCROLL_GAP = '     ';
const SCROLL_MS = 350;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function createMediaMode(refresh: RefreshCallback, volumeStep = 1): UtilityMode {
  let trackName = '';
  let artistName = '';
  let playing = false;
  let volume = 50;
  let scrollOffset = 0;
  let scrollTimer: ReturnType<typeof setInterval> | null = null;

  function stopScroll(): void {
    if (scrollTimer) { clearInterval(scrollTimer); scrollTimer = null; }
    scrollOffset = 0;
  }

  function startScroll(): void {
    stopScroll();
    if (trackName.length > SCROLL_VISIBLE) {
      scrollTimer = setInterval(() => {
        scrollOffset++;
        if (scrollOffset >= trackName.length + SCROLL_GAP.length) scrollOffset = 0;
        refresh();
      }, SCROLL_MS);
    }
  }

  function scrolledTrack(): string {
    if (!trackName) return 'No track';
    if (trackName.length <= SCROLL_VISIBLE) return trackName;
    const looped = trackName + SCROLL_GAP + trackName;
    return looped.substring(scrollOffset, scrollOffset + SCROLL_VISIBLE);
  }

  async function fetchTrack(): Promise<void> {
    try {
      const info = await getTrackInfo();
      if (info) {
        trackName = info.name;
        artistName = info.artist;
        playing = info.playing;
      } else {
        trackName = 'No player';
        artistName = '';
        playing = false;
      }
    } catch {
      trackName = 'No player';
      artistName = '';
      playing = false;
    }
  }

  return {
    id: 'media',
    label: '\u266B',
    layout: 'layouts/media-layout.json',

    async onActivate() {
      await fetchTrack();
      try {
        const s = await getVolumeSettings();
        volume = s.outputVolume;
      } catch { /* keep local */ }
      startScroll();
    },

    onDeactivate() {
      stopScroll();
    },

    // Rotate = volume control
    async onRotate(ticks) {
      volume = clamp(volume + ticks * volumeStep, 0, 100);
      setOutputVolume(volume);
    },

    // Short push = play/pause
    async onPush() {
      await mediaPlayPause();
      playing = !playing;
    },

    // Long push = next track
    async onLongPush() {
      await mediaNext();
      setTimeout(async () => {
        await fetchTrack();
        startScroll();
        refresh();
      }, 500);
    },

    getFeedback() {
      return {
        title: '\u266B MEDIA',
        state: playing ? '\u25B6' : '\u23F8',
        track: scrolledTrack(),
        artist: artistName || '',
        indicator: {
          value: volume,
          bar_fill_c: playing ? '#a855f7' : '#555555',
        },
      };
    },
  };
}
