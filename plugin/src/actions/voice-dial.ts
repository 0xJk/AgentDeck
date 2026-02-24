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
import type { AgentLink } from '../agent-link.js';
import { isEncoderTakeoverActive } from '../encoder-takeover.js';
import { handleTakeoverPush, handleTakeoverRotate, requestTakeoverRefresh } from './option-dial.js';
import { isPickerActive, scrollPicker, selectProject } from '../project-picker.js';
import {
  encoderRegistry, resetEncoderLayouts,
  setVoiceTextTakeover,
} from '../encoder-registry.js';
import { dlog } from '../log.js';
import { pasteText, osascript } from '../utility-modes/macos.js';
import { startLocalRecording, stopLocalRecording, cancelLocalRecording } from '../voice-local.js';
import { svgToDataUrl } from '../renderers/button-renderer.js';
import {
  renderVoiceReady,
  renderVoiceRecording,
  renderVoiceTranscribing,
  renderVoiceError,
  renderWideVoiceText,
} from '../renderers/voice-renderer.js';

let bridge: AgentLink;
let currentState = State.DISCONNECTED;

type VoiceState = 'idle' | 'recording' | 'transcribing' | 'error';
let voiceState: VoiceState = 'idle';
let lastTranscription: string | undefined;
let errorMessage: string | undefined;
let recordStartTime = 0;

// Unified animation
let animationTimer: ReturnType<typeof setInterval> | null = null;
let animationFrame = 0;

const MIN_RECORDING_MS = 500;

// Voice text takeover state
let vtActive = false;
let vtScrollY = 0;       // pixel-based scroll offset
let vtMaxScroll = 0;     // max scrollY from last render
let vtLineHeight = 20;   // line height from last render
let vtDownTime = 0;
const VT_PRESS_THRESHOLD = 500; // ms: short press = send, long press = cancel

export function initVoiceDial(b: AgentLink): void {
  bridge = b;
}

export function updateVoiceDialState(state: State): void {
  currentState = state;
  // Exit VT if encoder takeover active or interactive state incoming (takeover imminent)
  const interactiveIncoming = state === State.AWAITING_PERMISSION
    || state === State.AWAITING_OPTION || state === State.AWAITING_DIFF;
  if (vtActive && (isEncoderTakeoverActive() || interactiveIncoming)) {
    exitVoiceTextTakeover();
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
  }
  refreshVoiceDials();
}

export function setVoiceTranscription(text: string): void {
  dlog('VoiceDial', `transcription(${text.length} chars): "${text.slice(0, 60)}"`);
  lastTranscription = text;

  // Always enter voice text takeover for review-then-send
  enterVoiceTextTakeover();
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

function stopAnimation(): void {
  if (animationTimer) {
    clearInterval(animationTimer);
    animationTimer = null;
  }
  animationFrame = 0;
}

// --- Voice Text Takeover ---

/** Physical left-to-right order of encoder ID arrays */
function getVtPanelIds(): string[][] {
  const panels: string[][] = [];
  if (encoderRegistry.utilityIds.length > 0) panels.push(encoderRegistry.utilityIds);
  panels.push(encoderRegistry.optionIds);
  if (encoderRegistry.itermIds.length > 0) panels.push(encoderRegistry.itermIds);
  panels.push(encoderRegistry.voiceIds);
  return panels;
}

function enterVoiceTextTakeover(): void {
  if (isEncoderTakeoverActive() || vtActive) return;
  vtActive = true;
  vtScrollY = 0;

  const panelIds = getVtPanelIds();
  const totalPanels = panelIds.length;

  setVoiceTextTakeover(true, onVtRotate, onVtDown, onVtUp);
  dlog('VoiceDial', `enterVoiceTextTakeover: ${totalPanels} panels (wide canvas)`);

  // Switch all non-voice panels to pixmap canvas layout
  for (let i = 0; i < totalPanels - 1; i++) { // exclude voice (last), already pixmap
    for (const id of panelIds[i]) {
      const dial = streamDeck.actions.getActionById(id) as any;
      if (dial) void dial.setFeedbackLayout('layouts/voice-layout.json').catch(() => {});
    }
  }
}

function exitVoiceTextTakeover(): void {
  if (!vtActive) return;
  vtActive = false;
  dlog('VoiceDial', 'exitVoiceTextTakeover: clearing & restoring all panels');

  const panelIds = getVtPanelIds();

  // Clear all panels with blank background (atomic visual reset — no VT traces)
  const blank = svgToDataUrl(
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#0f172a"/></svg>',
  );
  for (const ids of panelIds) {
    for (const id of ids) {
      const dial = streamDeck.actions.getActionById(id) as any;
      if (dial) void dial.setFeedback({ canvas: blank }).catch(() => {});
    }
  }

  // Restore layouts for all non-voice panels
  resetEncoderLayouts();
  for (let i = 0; i < panelIds.length - 1; i++) { // exclude voice (last)
    for (const id of panelIds[i]) {
      const dial = streamDeck.actions.getActionById(id) as any;
      if (dial) void dial.setFeedbackLayout('layouts/voice-layout.json').catch(() => {});
    }
  }

  setVoiceTextTakeover(false); // triggers _onVtExitCallback for content refresh
}

function refreshVoiceTextTakeover(): void {
  if (!lastTranscription) return;

  const panelIds = getVtPanelIds();
  const panelCount = panelIds.length;

  const { panels, maxScrollY, lineHeight } = renderWideVoiceText(
    lastTranscription, panelCount, vtScrollY,
  );
  vtMaxScroll = maxScrollY;
  vtLineHeight = lineHeight;

  for (let i = 0; i < panelCount; i++) {
    const feedback = { canvas: svgToDataUrl(panels[i]) };
    for (const id of panelIds[i]) {
      const dial = streamDeck.actions.getActionById(id) as any;
      if (dial) void dial.setFeedback(feedback).catch(() => {});
    }
  }
}

function onVtRotate(ticks: number): void {
  vtScrollY = Math.max(0, Math.min(vtScrollY + ticks * vtLineHeight, vtMaxScroll));
  refreshVoiceTextTakeover();
}

let vtLongPressTimer: ReturnType<typeof setTimeout> | null = null;
let vtCancelled = false;

function onVtDown(): void {
  vtDownTime = Date.now();
  vtCancelled = false;
  // Auto-cancel after threshold — immediate visual feedback
  vtLongPressTimer = setTimeout(() => {
    vtLongPressTimer = null;
    vtCancelled = true;
    dlog('VoiceDial', 'vtCancel: discard transcription (long press auto)');
    lastTranscription = undefined;
    vtScrollY = 0;
    exitVoiceTextTakeover();
    refreshVoiceDials();
  }, VT_PRESS_THRESHOLD);
}

function onVtUp(): void {
  // Clear pending long-press timer
  if (vtLongPressTimer) {
    clearTimeout(vtLongPressTimer);
    vtLongPressTimer = null;
  }
  // Already cancelled by long-press timer — nothing to do
  if (vtCancelled) return;

  const elapsed = Date.now() - vtDownTime;
  dlog('VoiceDial', `onVtUp: elapsed=${elapsed}, hasText=${!!lastTranscription}, state=${currentState}, connected=${bridge.isConnected()}`);
  // Short press: confirm transcription
  if (lastTranscription) {
    if (bridge.isConnected()) {
      const caps = bridge.getCapabilities();
      if (caps && !caps.hasTerminal) {
        // OpenClaw: no terminal → always send via Gateway (state-independent)
        dlog('VoiceDial', `vtSendOC: "${lastTranscription.slice(0, 60)}"`);
        bridge.send({ type: 'send_prompt', text: lastTranscription });
      } else if (currentState === State.IDLE) {
        // Claude Code: IDLE → send via PTY
        dlog('VoiceDial', `vtSend: "${lastTranscription.slice(0, 60)}"`);
        bridge.send({ type: 'send_prompt', text: lastTranscription });
      } else {
        dlog('VoiceDial', `vtPaste: "${lastTranscription.slice(0, 60)}"`);
        smartPaste(lastTranscription);
      }
    } else {
      dlog('VoiceDial', `vtPaste: "${lastTranscription.slice(0, 60)}"`);
      smartPaste(lastTranscription);
    }
  }
  lastTranscription = undefined;
  vtScrollY = 0;
  exitVoiceTextTakeover();
  refreshVoiceDials();
}

/**
 * Paste text at cursor.
 * Always copies to clipboard first (pbcopy), then Cmd+V.
 */
function smartPaste(text: string): void {
  pasteText(text);
}

// --- Rendering ---

function refreshVoiceDials(): void {
  if (isEncoderTakeoverActive()) return;

  // Voice text takeover: render to all panels
  if (vtActive && lastTranscription) {
    refreshVoiceTextTakeover();
    return;
  }

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

  // Always show active UI — voice is independent like utility dial
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
      svg = renderVoiceReady();
      break;
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
    // If encoder takeover is active, join the takeover rendering instead of voice feedback
    if (isEncoderTakeoverActive()) {
      requestTakeoverRefresh();
      return;
    }
    await (ev.action as any).setFeedback(getVoiceFeedback());
  }

  override async onDialDown(_ev: DialDownEvent): Promise<void> {
    if (isPickerActive()) { void selectProject(); return; }
    if (isEncoderTakeoverActive()) { handleTakeoverPush(); return; }
    if (vtActive) { onVtDown(); return; }

    if (voiceState === 'error') {
      voiceState = 'idle';
      errorMessage = undefined;
      stopAnimation();
      refreshVoiceDials();
      return;
    }

    // Always use local recording (Terminal.app for mic permission)
    // Bridge path only used for final delivery (send prompt when IDLE+connected)
    dlog('VoiceDial', 'dialDown: start local recording');
    recordStartTime = Date.now();
    voiceState = 'recording';
    startAnimation(60);
    refreshVoiceDials();
    try {
      await startLocalRecording();
    } catch (err) {
      voiceState = 'error';
      errorMessage = err instanceof Error ? err.message : String(err);
      stopAnimation();
      refreshVoiceDials();
    }
  }

  override async onDialUp(_ev: DialUpEvent): Promise<void> {
    if (isEncoderTakeoverActive()) return;
    if (vtActive) { onVtUp(); return; }
    if (voiceState !== 'recording') return;

    const elapsed = Date.now() - recordStartTime;

    // Always use local recording path
    if (elapsed < MIN_RECORDING_MS) {
      dlog('VoiceDial', `dialUp: cancel (${elapsed}ms < ${MIN_RECORDING_MS}ms)`);
      voiceState = 'idle';
      await cancelLocalRecording();
      stopAnimation();
      refreshVoiceDials();
      return;
    }

    dlog('VoiceDial', `dialUp: stop recording (${elapsed}ms)`);
    voiceState = 'transcribing';
    startAnimation(100);
    refreshVoiceDials();
    try {
      const text = await stopLocalRecording();
      if (!text || !text.trim()) {
        voiceState = 'error';
        errorMessage = 'Empty transcription — check mic permission for Terminal.app';
        stopAnimation();
        refreshVoiceDials();
        return;
      }
      lastTranscription = text;
      voiceState = 'idle';
      stopAnimation();
      enterVoiceTextTakeover();
      refreshVoiceDials();
    } catch (err) {
      voiceState = 'error';
      errorMessage = err instanceof Error ? err.message : String(err);
      stopAnimation();
      refreshVoiceDials();
    }
  }

  override async onDialRotate(ev: DialRotateEvent): Promise<void> {
    if (isPickerActive()) { scrollPicker(ev.payload.ticks); return; }
    if (isEncoderTakeoverActive()) { handleTakeoverRotate(ev.payload.ticks); return; }
    if (vtActive) { onVtRotate(ev.payload.ticks); return; }
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
