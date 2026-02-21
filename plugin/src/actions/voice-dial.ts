import streamDeck, {
  action,
  SingletonAction,
  DialDownEvent,
  DialUpEvent,
  DialRotateEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from '@elgato/streamdeck';
import { State } from '@agentdeck/shared';
import { BridgeClient } from '../bridge-client.js';
import { isEncoderTakeoverActive } from '../encoder-takeover.js';
import { handleTakeoverPush, handleTakeoverRotate } from './option-dial.js';
import { encoderRegistry } from '../encoder-registry.js';
import { dlog } from '../log.js';

let bridge: BridgeClient;
let currentState = State.DISCONNECTED;

type VoiceState = 'idle' | 'recording' | 'transcribing' | 'error';
let voiceState: VoiceState = 'idle';
let lastTranscription: string | undefined;
let recordStartTime = 0;
let scrollOffset = 0;

// Pulsing animation for recording indicator
let pulseTimer: ReturnType<typeof setInterval> | null = null;
let pulseOn = true;

const MIN_RECORDING_MS = 500;

export function initVoiceDial(b: BridgeClient): void {
  bridge = b;
}

export function updateVoiceDialState(state: State): void {
  currentState = state;
  if (state !== State.IDLE) {
    voiceState = 'idle';
    stopPulse();
  }
  refreshVoiceDials();
}

export function setVoiceRecordingState(vs: VoiceState): void {
  dlog('VoiceDial', `voiceState: ${voiceState} -> ${vs}`);
  voiceState = vs;
  if (vs === 'recording') {
    startPulse();
  } else {
    stopPulse();
  }
  refreshVoiceDials();
}

export function setVoiceTranscription(text: string): void {
  dlog('VoiceDial', `transcription(${text.length} chars): "${text.slice(0, 60)}"`);
  lastTranscription = text;
  scrollOffset = 0;
  refreshVoiceDials();
}

function startPulse(): void {
  stopPulse();
  pulseOn = true;
  pulseTimer = setInterval(() => {
    pulseOn = !pulseOn;
    refreshVoiceDials();
  }, 500);
}

function stopPulse(): void {
  if (pulseTimer) {
    clearInterval(pulseTimer);
    pulseTimer = null;
  }
  pulseOn = true;
}

function refreshVoiceDials(): void {
  if (isEncoderTakeoverActive()) return;
  const feedback = getVoiceFeedback();
  for (const id of encoderRegistry.voiceIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) {
      void dial.setFeedback(feedback).catch(() => {});
    }
  }
}

function getVoiceFeedback(): Record<string, unknown> {
  if (currentState !== State.IDLE) {
    return {
      title: 'VOICE',
      value: '--',
      indicator: { value: 0 },
    };
  }

  switch (voiceState) {
    case 'recording':
      return {
        title: '\ud83c\udfa4 REC',
        value: 'Recording...',
        indicator: {
          value: pulseOn ? 100 : 0,
          bar_fill_c: '#ef4444',
        },
      };
    case 'transcribing':
      return {
        title: 'VOICE',
        value: 'Transcribing...',
        indicator: {
          value: 50,
          bar_fill_c: '#fbbf24',
        },
      };
    case 'error':
      return {
        title: 'VOICE',
        value: 'ERROR - push to clear',
        indicator: {
          value: 100,
          bar_fill_c: '#991b1b',
        },
      };
    default:
      if (lastTranscription) {
        const display = scrollOffset > 0
          ? lastTranscription.substring(scrollOffset)
          : lastTranscription;
        return {
          title: 'VOICE',
          value: truncateVoice(display, 60),
          indicator: { value: 0 },
        };
      }
      return {
        title: 'VOICE',
        value: 'Ready',
        indicator: { value: 0 },
      };
  }
}

function truncateVoice(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '\u2026' : s;
}

@action({ UUID: 'bound.serendipity.agentdeck.voice-dial' })
export class VoiceDialAction extends SingletonAction {
  static get actionIds(): string[] { return encoderRegistry.voiceIds; }

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    if (!encoderRegistry.voiceIds.includes(ev.action.id)) {
      encoderRegistry.voiceIds.push(ev.action.id);
    }
    await (ev.action as any).setFeedback(getVoiceFeedback());
  }

  override async onDialDown(_ev: DialDownEvent): Promise<void> {
    if (isEncoderTakeoverActive()) { handleTakeoverPush(); return; }
    if (currentState !== State.IDLE) return;

    // Error state: clear error on push
    if (voiceState === 'error') {
      voiceState = 'idle';
      stopPulse();
      refreshVoiceDials();
      return;
    }

    dlog('VoiceDial', 'dialDown: start recording');
    recordStartTime = Date.now();
    voiceState = 'recording';
    bridge.send({ type: 'voice', action: 'start' });
    startPulse();
    refreshVoiceDials();
  }

  override async onDialUp(_ev: DialUpEvent): Promise<void> {
    if (isEncoderTakeoverActive()) return;
    if (voiceState !== 'recording') return;

    const elapsed = Date.now() - recordStartTime;
    if (elapsed < MIN_RECORDING_MS) {
      dlog('VoiceDial', `dialUp: cancel (${elapsed}ms < ${MIN_RECORDING_MS}ms)`);
      voiceState = 'idle';
      bridge.send({ type: 'voice', action: 'cancel' });
      stopPulse();
      refreshVoiceDials();
      return;
    }

    dlog('VoiceDial', `dialUp: stop recording (${elapsed}ms)`);
    voiceState = 'transcribing';
    bridge.send({ type: 'voice', action: 'stop' });
    stopPulse();
    refreshVoiceDials();
  }

  override async onDialRotate(ev: DialRotateEvent): Promise<void> {
    if (isEncoderTakeoverActive()) { handleTakeoverRotate(ev.payload.ticks); return; }
    // Scroll through last transcription text
    if (voiceState === 'idle' && lastTranscription && currentState === State.IDLE) {
      if (ev.payload.ticks > 0) {
        scrollOffset += 20;
      } else {
        scrollOffset -= 20;
      }
      scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, lastTranscription.length - 30)));
      refreshVoiceDials();
    }
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    const idx = encoderRegistry.voiceIds.indexOf(ev.action.id);
    if (idx !== -1) {
      encoderRegistry.voiceIds.splice(idx, 1);
    }
  }
}
