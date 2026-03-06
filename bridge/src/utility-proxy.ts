import { execSync } from 'child_process';
import { debug } from './logger.js';
import type { UtilityCommand } from './types.js';

export interface UtilityState {
  mode: string;
  value: string;
  icon: string;
  level: number; // 0-1
}

type UtilityMode = 'volume' | 'brightness' | 'media';

const MODES: UtilityMode[] = ['volume', 'brightness', 'media'];

export class UtilityProxy {
  private currentMode: UtilityMode = 'volume';
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private cachedVolume = 50;
  private cachedMuted = false;
  private cachedBrightness = 50;

  constructor() {
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), 5000);
  }

  cycleMode(): void {
    const idx = MODES.indexOf(this.currentMode);
    this.currentMode = MODES[(idx + 1) % MODES.length];
    debug('Utility', `Mode → ${this.currentMode}`);
  }

  getState(): UtilityState {
    switch (this.currentMode) {
      case 'volume':
        return {
          mode: 'volume',
          value: this.cachedMuted ? 'MUTE' : `${this.cachedVolume}%`,
          icon: this.cachedMuted ? '🔇' : this.cachedVolume > 50 ? '🔊' : '🔉',
          level: this.cachedMuted ? 0 : this.cachedVolume / 100,
        };
      case 'brightness':
        return {
          mode: 'brightness',
          value: `${this.cachedBrightness}%`,
          icon: '☀️',
          level: this.cachedBrightness / 100,
        };
      case 'media':
        return {
          mode: 'media',
          value: 'MEDIA',
          icon: '🎵',
          level: 0.5,
        };
    }
  }

  handleCommand(cmd: UtilityCommand): void {
    switch (cmd.action) {
      case 'adjust_volume':
        this.adjustVolume(cmd.value ?? 1);
        break;
      case 'toggle_mute':
        this.toggleMute();
        break;
      case 'adjust_brightness':
        this.adjustBrightness(cmd.value ?? 1);
        break;
      case 'media_play_pause':
        this.mediaPlayPause();
        break;
      case 'media_next':
        this.mediaNext();
        break;
      case 'media_prev':
        this.mediaPrev();
        break;
    }
  }

  adjustVolume(delta: number): void {
    // Each tick ~6.25% (16 ticks = 0..100)
    const step = Math.round(delta * 6.25);
    const newVol = Math.max(0, Math.min(100, this.cachedVolume + step));
    try {
      execSync(`osascript -e 'set volume output volume ${newVol}'`, { timeout: 2000, stdio: 'pipe' });
      this.cachedVolume = newVol;
      if (newVol > 0) this.cachedMuted = false;
      debug('Utility', `Volume → ${newVol}%`);
    } catch (err) {
      debug('Utility', `adjustVolume error: ${err}`);
    }
  }

  toggleMute(): void {
    try {
      const script = `osascript -e 'set volume with output muted:${this.cachedMuted ? 'false' : 'true'}'`;
      execSync(script, { timeout: 2000, stdio: 'pipe' });
      this.cachedMuted = !this.cachedMuted;
      debug('Utility', `Mute → ${this.cachedMuted}`);
    } catch (err) {
      debug('Utility', `toggleMute error: ${err}`);
    }
  }

  adjustBrightness(delta: number): void {
    const step = delta * 6.25 / 100; // normalized 0-1 for brightness
    try {
      const script = `osascript -e '
        tell application "System Events"
          key code ${delta > 0 ? 144 : 145}
        end tell'`;
      execSync(script, { timeout: 2000, stdio: 'pipe' });
      // Approximate new brightness
      this.cachedBrightness = Math.max(0, Math.min(100, this.cachedBrightness + Math.round(delta * 6.25)));
      debug('Utility', `Brightness → ~${this.cachedBrightness}%`);
    } catch (err) {
      debug('Utility', `adjustBrightness error: ${err}`);
    }
  }

  mediaPlayPause(): void {
    try {
      execSync(`osascript -e 'tell application "System Events" to key code 16 using {command down}'`, { timeout: 2000, stdio: 'pipe' });
      debug('Utility', 'Media: play/pause');
    } catch (err) {
      debug('Utility', `mediaPlayPause error: ${err}`);
    }
  }

  mediaNext(): void {
    try {
      execSync(`osascript -e 'tell application "System Events" to key code 124 using {command down}'`, { timeout: 2000, stdio: 'pipe' });
      debug('Utility', 'Media: next');
    } catch (err) {
      debug('Utility', `mediaNext error: ${err}`);
    }
  }

  mediaPrev(): void {
    try {
      execSync(`osascript -e 'tell application "System Events" to key code 123 using {command down}'`, { timeout: 2000, stdio: 'pipe' });
      debug('Utility', 'Media: prev');
    } catch (err) {
      debug('Utility', `mediaPrev error: ${err}`);
    }
  }

  private poll(): void {
    // Poll volume
    try {
      const vol = execSync(`osascript -e 'output volume of (get volume settings)'`, { timeout: 2000, encoding: 'utf8', stdio: 'pipe' }).trim();
      this.cachedVolume = parseInt(vol, 10) || 0;
    } catch { /* ignore */ }

    // Poll mute
    try {
      const muted = execSync(`osascript -e 'output muted of (get volume settings)'`, { timeout: 2000, encoding: 'utf8', stdio: 'pipe' }).trim();
      this.cachedMuted = muted === 'true';
    } catch { /* ignore */ }

    // Poll brightness (CoreBrightness via AppleScript)
    try {
      const br = execSync(
        `osascript -e 'tell application "System Events" to tell appearance preferences to get dark mode'`,
        { timeout: 2000, encoding: 'utf8', stdio: 'pipe' },
      ).trim();
      // brightness is harder to read reliably; keep cached estimate
    } catch { /* ignore */ }
  }

  cleanup(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
