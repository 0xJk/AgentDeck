/**
 * Wake Word Listener — Porcupine (Picovoice) wrapper.
 *
 * Continuously captures audio from the Mac microphone via @picovoice/pvrecorder-node
 * and runs Porcupine wake word detection for "오픈클로".
 *
 * Emits 'detected' when the wake word is heard.
 * Provides start() / stop() / isListening() interface.
 */

import { EventEmitter } from 'events';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { debug } from './logger.js';

function log(msg: string): void {
  process.stderr.write(`[WakeWord] ${msg}\n`);
}
import {
  WAKE_WORD_MODEL_DIR,
  PICOVOICE_ACCESS_KEY_FILE,
} from '@agentdeck/shared';

const TAG = 'WakeWord';

/** Find the .ppn keyword model file in the wake word model directory */
function findPpnModel(): string | null {
  if (!existsSync(WAKE_WORD_MODEL_DIR)) return null;
  const files = readdirSync(WAKE_WORD_MODEL_DIR).filter(f => f.endsWith('.ppn'));
  if (files.length === 0) return null;
  const preferred = files.find(f => /openclaw|오픈클로/i.test(f));
  return join(WAKE_WORD_MODEL_DIR, preferred ?? files[0]);
}

/** Find the Porcupine language model (.pv) — Korean for "오픈클로" */
function findLanguageModel(): string | null {
  // 1. Check wake-word dir for language model
  if (existsSync(WAKE_WORD_MODEL_DIR)) {
    const pvFiles = readdirSync(WAKE_WORD_MODEL_DIR).filter(f => f.endsWith('.pv'));
    const koModel = pvFiles.find(f => /ko|korean/i.test(f));
    if (koModel) return join(WAKE_WORD_MODEL_DIR, koModel);
    if (pvFiles.length > 0) return join(WAKE_WORD_MODEL_DIR, pvFiles[0]);
  }
  return null;
}

/** Read Picovoice access key from file */
function readAccessKey(): string | null {
  try {
    if (!existsSync(PICOVOICE_ACCESS_KEY_FILE)) return null;
    return readFileSync(PICOVOICE_ACCESS_KEY_FILE, 'utf-8').trim();
  } catch {
    return null;
  }
}

const DEFAULT_SENSITIVITY = 0.8;

interface WakeWordSettings {
  deviceIndex: number;
  sensitivity: number;
}

/** Read wakeWordMic + wakeWordSensitivity from settings.json */
function getWakeWordSettings(PvRecorder: any): WakeWordSettings {
  let deviceIndex = -1;
  let sensitivity = DEFAULT_SENSITIVITY;
  try {
    const settings = JSON.parse(
      readFileSync(join(homedir(), '.agentdeck', 'settings.json'), 'utf-8'),
    );

    // Mic
    const micName = settings.wakeWordMic as string | undefined;
    if (micName) {
      const devices: string[] = PvRecorder.getAvailableDevices();
      const idx = devices.findIndex((d: string) =>
        d.toLowerCase().includes(micName.toLowerCase()),
      );
      if (idx >= 0) {
        debug(TAG, `Configured mic "${micName}" → device ${idx}: ${devices[idx]}`);
        deviceIndex = idx;
      } else {
        debug(TAG, `Configured mic "${micName}" not found, using system default`);
      }
    }

    // Sensitivity
    const sens = settings.wakeWordSensitivity as number | undefined;
    if (typeof sens === 'number' && sens >= 0 && sens <= 1) {
      sensitivity = sens;
    }
  } catch { /* ok */ }
  return { deviceIndex, sensitivity };
}

export class WakeWordListener extends EventEmitter {
  private listening = false;
  /** Whether the detection loop is actively running (false during pause) */
  private active = false;
  private porcupine: any = null;
  private recorder: any = null;
  private accessKey: string;
  private keywordPath: string;
  private languageModelPath: string | null;

  constructor() {
    super();
    this.accessKey = readAccessKey() ?? '';
    this.keywordPath = findPpnModel() ?? '';
    this.languageModelPath = findLanguageModel();
  }

  /** Check if wake word detection is available (deps + model + key) */
  isAvailable(): boolean {
    if (!this.accessKey) {
      debug(TAG, `Access key not found at ${PICOVOICE_ACCESS_KEY_FILE}`);
      return false;
    }
    if (!this.keywordPath || !existsSync(this.keywordPath)) {
      debug(TAG, `No .ppn model found in ${WAKE_WORD_MODEL_DIR}`);
      return false;
    }
    return true;
  }

  async start(): Promise<boolean> {
    if (this.listening) return true;

    if (!this.isAvailable()) {
      debug(TAG, 'Cannot start — missing access key or model');
      return false;
    }

    try {
      // Dynamic imports — these are optional deps
      const { Porcupine } = await import('@picovoice/porcupine-node');
      const { PvRecorder } = await import('@picovoice/pvrecorder-node');

      const options: Record<string, unknown> = {};
      if (this.languageModelPath) {
        options.modelPath = this.languageModelPath;
        debug(TAG, `Using language model: ${this.languageModelPath}`);
      }

      const wwSettings = getWakeWordSettings(PvRecorder);

      this.porcupine = new Porcupine(
        this.accessKey,
        [this.keywordPath],
        [wwSettings.sensitivity],
        options,
      );

      const frameLength = this.porcupine.frameLength;
      const deviceIndex = wwSettings.deviceIndex;

      this.recorder = new PvRecorder(frameLength, deviceIndex);
      this.recorder.start();

      this.listening = true;
      this.active = true;
      log(`Listening on "${this.recorder.getSelectedDevice()}"`);
      debug(TAG, `Listening on "${this.recorder.getSelectedDevice()}" (keyword: ${this.keywordPath})`);

      // Detection loop
      this.runDetectionLoop();

      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debug(TAG, `Failed to start: ${msg}`);
      this.cleanup();
      return false;
    }
  }

  stop(): void {
    if (!this.listening) return;
    debug(TAG, 'Stopping');
    this.listening = false;
    this.active = false;
    this.cleanup();
  }

  isListening(): boolean {
    return this.listening;
  }

  /** Temporarily pause detection (e.g., while recording user speech).
   *  Sets active=false so the detection loop exits naturally,
   *  then stops the recorder. */
  pause(): void {
    if (this.recorder && this.listening && this.active) {
      this.active = false;
      try { this.recorder.stop(); } catch { /* ok */ }
      debug(TAG, 'Paused');
    }
  }

  /** Resume detection after pause — starts a fresh detection loop */
  resume(): void {
    if (this.recorder && this.listening && !this.active) {
      try { this.recorder.start(); } catch { /* ok */ }
      this.active = true;
      debug(TAG, 'Resumed');
      this.runDetectionLoop();
    }
  }

  private async runDetectionLoop(): Promise<void> {
    while (this.active && this.listening && this.recorder && this.porcupine) {
      try {
        const pcm = await this.recorder.read();
        if (!this.active) break;
        const keywordIndex = this.porcupine.process(pcm);

        if (keywordIndex >= 0) {
          log('Detected!');
          this.emit('detected', {
            deviceId: 'mac-builtin',
            timestamp: Date.now(),
          });
        }
      } catch (err) {
        if (!this.active || !this.listening) break;
        debug(TAG, `Detection loop error: ${err}`);
        await new Promise(r => setTimeout(r, 100));
      }
    }
    debug(TAG, `Detection loop exited (active=${this.active}, listening=${this.listening})`);
  }

  private cleanup(): void {
    if (this.recorder) {
      try { this.recorder.stop(); } catch { /* ok */ }
      try { this.recorder.release(); } catch { /* ok */ }
      this.recorder = null;
    }
    if (this.porcupine) {
      try { this.porcupine.release(); } catch { /* ok */ }
      this.porcupine = null;
    }
  }
}
