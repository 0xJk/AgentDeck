import streamDeck from '@elgato/streamdeck';
import {
  StateUpdateEvent,
  PromptOptionsEvent,
  UsageEvent,
  ConnectionEvent,
  UserPromptEvent,
  VoiceStateEvent,
  State,
  PermissionMode,
} from '@streamdeck-claude/shared';

import { BridgeClient } from './bridge-client.js';
import { LayoutManager } from './layout-manager.js';
import { dlog, dinfo } from './log.js';

// Keypad button actions
import {
  ResponseButtonAction,
  initResponseButtons,
  updateResponseState,
} from './actions/response-button.js';
import {
  StopButtonAction,
  initStopButton,
  updateStopState,
} from './actions/stop-button.js';
import {
  ModeButtonAction,
  initModeButton,
  updateModeButton,
} from './actions/mode-button.js';
import {
  SessionButtonAction,
  initSessionButton,
  updateSessionButton,
} from './actions/session-button.js';

// Keypad button actions (usage)
import {
  UsageButtonAction,
  initUsageButton,
  updateUsageButton,
} from './actions/usage-button.js';

// Encoder actions
import {
  OptionDialAction,
  initOptionDial,
  updateOptionDialState,
} from './actions/option-dial.js';
import {
  VoiceDialAction,
  initVoiceDial,
  updateVoiceDialState,
  setVoiceRecordingState,
  setVoiceTranscription,
} from './actions/voice-dial.js';
import {
  CommandDialAction,
  initCommandDial,
  updateCommandDialState,
} from './actions/command-dial.js';

// ---- Shared state ----
let currentState = State.DISCONNECTED;
let currentMode = PermissionMode.DEFAULT;
let currentTool: string | undefined;
let currentProjectName: string | undefined;
let currentModelName: string | undefined;
let currentOptions: import('@streamdeck-claude/shared').PromptOption[] = [];

// ---- Instances ----
const bridge = new BridgeClient();
const layoutManager = new LayoutManager();

// ---- Initialize action modules ----
initResponseButtons(bridge, layoutManager);
initStopButton(bridge);
initModeButton(bridge);
initSessionButton(bridge);
initUsageButton(bridge);
initOptionDial(bridge);
initVoiceDial(bridge);
initCommandDial(bridge);

// ---- Bridge event handlers ----

bridge.on('state_update', (ev: StateUpdateEvent) => {
  dlog('Plugin', `state_update: ${ev.state} mode=${ev.permissionMode} tool=${ev.currentTool || '-'} project=${ev.projectName || '-'}`);
  currentState = ev.state;
  currentMode = ev.permissionMode;
  currentTool = ev.currentTool;
  if (ev.projectName) currentProjectName = ev.projectName;
  if (ev.modelName) currentModelName = ev.modelName;

  // Clear options when leaving option state
  if (ev.state !== State.AWAITING_OPTION) {
    currentOptions = [];
  }

  broadcastStateUpdate();
});

bridge.on('prompt_options', (ev: PromptOptionsEvent) => {
  dlog('Plugin', `prompt_options: type=${ev.promptType} count=${ev.options.length}`);
  currentOptions = ev.options;
  broadcastStateUpdate();
});

bridge.on('usage_update', (ev: UsageEvent) => {
  dlog('Plugin', `usage_update: 5h=${ev.fiveHourPercent ?? '-'}% 7d=${ev.sevenDayPercent ?? '-'}% extra=${ev.extraUsageEnabled ? 'on' : 'off'} tokens=${ev.inputTokens + ev.outputTokens}`);
  updateUsageButton(currentState, {
    sessionDurationSec: ev.sessionDurationSec,
    inputTokens: ev.inputTokens,
    outputTokens: ev.outputTokens,
    fiveHourPercent: ev.fiveHourPercent,
    fiveHourResetsAt: ev.fiveHourResetsAt,
    sevenDayPercent: ev.sevenDayPercent,
    sevenDayResetsAt: ev.sevenDayResetsAt,
    extraUsageEnabled: ev.extraUsageEnabled,
    extraUsageMonthlyLimit: ev.extraUsageMonthlyLimit,
    extraUsageUsedCredits: ev.extraUsageUsedCredits,
    extraUsageUtilization: ev.extraUsageUtilization,
  });
});

bridge.on('connection', (ev: ConnectionEvent) => {
  dinfo('Plugin', `connection: ${ev.status}`);
  if (ev.status === 'disconnected') {
    currentState = State.DISCONNECTED;
    currentOptions = [];
    broadcastStateUpdate();
  } else if (ev.status === 'connected') {
    currentState = State.IDLE;
    broadcastStateUpdate();
  }
});

bridge.on('user_prompt', (ev: UserPromptEvent) => {
  dlog('Plugin', `user_prompt: "${ev.text.slice(0, 60)}"`);
});

bridge.on('voice_state', (ev: VoiceStateEvent) => {
  dlog('Plugin', `voice_state: ${ev.state} text=${ev.text ? `"${ev.text.slice(0, 40)}"` : '-'} err=${ev.error || '-'}`);
  const vs = ev.state === 'recording' ? 'recording'
    : ev.state === 'transcribing' ? 'transcribing'
    : ev.state === 'error' ? 'error'
    : 'idle';
  setVoiceRecordingState(vs);
  // Show transcribed text on voice dial LCD
  if (ev.state === 'idle' && ev.text) {
    setVoiceTranscription(ev.text);
  }
});

bridge.on('connected', () => {
  dinfo('Plugin', 'bridge connected');
});

bridge.on('disconnected', () => {
  dinfo('Plugin', 'bridge disconnected');
  currentState = State.DISCONNECTED;
  currentOptions = [];
  broadcastStateUpdate();
});

function broadcastStateUpdate(): void {
  dlog('Plugin', `broadcast: state=${currentState} mode=${currentMode} opts=${currentOptions.length}`);
  // Keypad buttons — slots 0-2 dedicated, slots 3-5 dynamic, slot 6 = STOP
  updateModeButton(currentState, currentMode);
  updateSessionButton(currentState, currentMode, currentProjectName, currentTool, currentModelName);
  updateResponseState(currentState, currentMode, currentOptions);
  updateStopState(currentState);

  // Encoder actions
  updateOptionDialState(currentState, currentOptions);
  updateVoiceDialState(currentState);
  updateCommandDialState(currentState);
}

// ---- Register actions ----
streamDeck.actions.registerAction(new ResponseButtonAction());
streamDeck.actions.registerAction(new StopButtonAction());
streamDeck.actions.registerAction(new ModeButtonAction());
streamDeck.actions.registerAction(new SessionButtonAction());
streamDeck.actions.registerAction(new UsageButtonAction());
streamDeck.actions.registerAction(new OptionDialAction());
streamDeck.actions.registerAction(new VoiceDialAction());
streamDeck.actions.registerAction(new CommandDialAction());

// ---- Connect ----
streamDeck.connect().then(() => {
  dinfo('Plugin', 'Stream Deck connected, starting bridge client');
  bridge.connect();
});
