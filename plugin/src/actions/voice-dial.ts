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
import { svgToDataUrl } from '../renderers/button-renderer.js';
import {
  renderVoiceReady,
  renderVoiceIdle,
  renderVoiceRecording,
  renderVoiceTranscribing,
  renderVoiceError,
  renderVoiceDisabled,
  estimateTextWidth,
} from '../renderers/voice-renderer.js';

let bridge: BridgeClient;
let currentState = State.DISCONNECTED;

type VoiceState = 'idle' | 'recording' | 'transcribing' | 'error';
let voiceState: VoiceState = 'idle';
let lastTranscription: string | undefined;
let errorMessage: string | undefined;
let recordStartTime = 0;

// Scroll state (pixel-based)
let scrollPx = 0;
let textTotalWidth = 0;

// Auto-scroll state
let autoScrollActive = false;
let autoScrollPauseUntil = 0;
let autoScrollStartDelay = 0;
const AUTO_SCROLL_INITIAL_DELAY = 1500;
const AUTO_SCROLL_PAUSE_DURATION = 3000;
const AUTO_SCROLL_END_PAUSE = 2000;
let autoScrollEndPauseUntil = 0;

// Unified animation
let animationTimer: ReturnType<typeof setInterval> | null = null;
let animationFrame = 0;

const MIN_RECORDING_MS = 500;
const MAX_VISIBLE_PX = 184;

export function initVoiceDial(b: BridgeClient): void {
  bridge = b;
}

export function updateVoiceDialState(state: State): void {
  currentState = state;
  if (state !== State.IDLE) {
    voiceState = 'idle';
    stopAnimation();
  }
  refreshVoiceDials();
}

export function setVoiceRecordingState(vs: VoiceState): void {
  dlog('VoiceDial', `voiceState: ${voiceState} -> ${vs}`);
  voiceState = vs;

  if (vs === 'recording') {
    startAnimation(60);
  } else if (vs === 'transcribing') {
    startAnimation(100);
  } else {
    stopAnimation();
    if (vs === 'idle' && lastTranscription) {
      startAutoScroll();
    }
  }
  refreshVoiceDials();
}

export function setVoiceTranscription(text: string): void {
  dlog('VoiceDial', `transcription(${text.length} chars): "${text.slice(0, 60)}"`);
  lastTranscription = text;
  scrollPx = 0;
  textTotalWidth = estimateTextWidth(text);
  autoScrollStartDelay = Date.now() + AUTO_SCROLL_INITIAL_DELAY;
  autoScrollEndPauseUntil = 0;
  autoScrollPauseUntil = 0;
  startAutoScroll();
  refreshVoiceDials();
}

export function setVoiceError(msg?: string): void {
  errorMessage = msg;
  voiceState = 'error';
  stopAnimation();
  refreshVoiceDials();
}

// --- Animation ---

function startAnimation(intervalMs: number): void {
  stopAnimation();
  animationFrame = 0;
  animationTimer = setInterval(() => {
    animationFrame++;
    refreshVoiceDials();
  }, intervalMs);
}

function startAutoScroll(): void {
  if (autoScrollActive) return;
  if (!lastTranscription || textTotalWidth <= MAX_VISIBLE_PX) return;
  autoScrollActive = true;
  if (!animationTimer) {
    animationFrame = 0;
    animationTimer = setInterval(() => {
      animationFrame++;
      tickAutoScroll();
      refreshVoiceDials();
    }, 80);
  }
}

function stopAutoScroll(): void {
  autoScrollActive = false;
  if (voiceState === 'idle' && animationTimer) {
    clearInterval(animationTimer);
    animationTimer = null;
  }
}

function tickAutoScroll(): void {
  if (!autoScrollActive || !lastTranscription) return;
  const now = Date.now();

  if (now < autoScrollStartDelay) return;
  if (now < autoScrollPauseUntil) return;
  if (now < autoScrollEndPauseUntil) return;

  const maxScroll = Math.max(0, textTotalWidth - MAX_VISIBLE_PX);
  if (maxScroll <= 0) { stopAutoScroll(); return; }

  scrollPx += 2;

  if (scrollPx >= maxScroll) {
    scrollPx = maxScroll;
    autoScrollEndPauseUntil = now + AUTO_SCROLL_END_PAUSE;
    setTimeout(() => {
      scrollPx = 0;
      autoScrollStartDelay = Date.now() + 500;
    }, AUTO_SCROLL_END_PAUSE);
  }
}

function stopAnimation(): void {
  if (animationTimer) {
    clearInterval(animationTimer);
    animationTimer = null;
  }
  autoScrollActive = false;
  animationFrame = 0;
}

// --- Rendering ---

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
  let svg: string;

  if (currentState !== State.IDLE) {
    svg = renderVoiceDisabled();
  } else {
    switch (voiceState) {
      case 'recording':
        svg = renderVoiceRecording(Date.now() - recordStartTime, animationFrame);
        break;
      case 'transcribing':
        svg = renderVoiceTranscribing(animationFrame);
        break;
      case 'error':
        svg = renderVoiceError(errorMessage);
        break;
      default:
        if (lastTranscription) {
          svg = renderVoiceIdle(lastTranscription, scrollPx, textTotalWidth);
        } else {
          svg = renderVoiceReady();
        }
        break;
    }
  }

  return { canvas: svgToDataUrl(svg) };
}

// --- Action ---

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

    if (voiceState === 'error') {
      voiceState = 'idle';
      errorMessage = undefined;
      stopAnimation();
      refreshVoiceDials();
      return;
    }

    dlog('VoiceDial', 'dialDown: start recording');
    recordStartTime = Date.now();
    voiceState = 'recording';
    bridge.send({ type: 'voice', action: 'start' });
    startAnimation(60);
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
      stopAnimation();
      refreshVoiceDials();
      return;
    }

    dlog('VoiceDial', `dialUp: stop recording (${elapsed}ms)`);
    voiceState = 'transcribing';
    bridge.send({ type: 'voice', action: 'stop' });
    startAnimation(100);
    refreshVoiceDials();
  }

  override async onDialRotate(ev: DialRotateEvent): Promise<void> {
    if (isEncoderTakeoverActive()) { handleTakeoverRotate(ev.payload.ticks); return; }
    if (voiceState === 'idle' && lastTranscription && currentState === State.IDLE) {
      const step = 20;
      if (ev.payload.ticks > 0) {
        scrollPx += step;
      } else {
        scrollPx -= step;
      }
      const maxScroll = Math.max(0, textTotalWidth - MAX_VISIBLE_PX);
      scrollPx = Math.max(0, Math.min(scrollPx, maxScroll));
      autoScrollPauseUntil = Date.now() + AUTO_SCROLL_PAUSE_DURATION;
      refreshVoiceDials();
    }
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    const idx = encoderRegistry.voiceIds.indexOf(ev.action.id);
    if (idx !== -1) {
      encoderRegistry.voiceIds.splice(idx, 1);
    }
    if (encoderRegistry.voiceIds.length === 0) {
      stopAnimation();
    }
  }
}
