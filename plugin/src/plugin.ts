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
  type BillingType,
} from '@agentdeck/shared';

import { ConnectionManager } from './connection-manager.js';
import { LayoutManager } from './layout-manager.js';
import { setExpandCallback } from './expanded-actions.js';
import {
  isEncoderTakeoverActive,
  enterEncoderTakeover,
  exitEncoderTakeover,
} from './encoder-takeover.js';
import { setVoiceTextExitCallback } from './encoder-registry.js';
import { dlog, dinfo } from './log.js';
import { readFileSync } from 'fs';
import { homedir } from 'os';

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
  overrideStopButton,
} from './actions/stop-button.js';
import {
  ModeButtonAction,
  initModeButton,
  updateModeButton,
  overrideModeButton,
} from './actions/mode-button.js';
import {
  SessionButtonAction,
  initSessionButton,
  updateSessionButton,
  overrideSessionButton,
} from './actions/session-button.js';

// Keypad button actions (usage)
import {
  UsageButtonAction,
  initUsageButton,
  updateUsageButton,
  updateUsageModelCatalog,
  overrideUsageButton,
  setUsageBridgeConnected,
  setUsageCapabilities,
  setUsageState,
} from './actions/usage-button.js';

// Encoder actions
import {
  ResponseDialAction,
  initOptionDial,
  updateOptionDialState,
} from './actions/option-dial.js';
import {
  VoiceDialAction,
  initVoiceDial,
  updateVoiceDialState,
  setVoiceRecordingState,
  setVoiceTranscription,
  setVoiceError,
} from './actions/voice-dial.js';
import {
  UtilityDialAction,
  initUtilityDial,
  updateUtilityDialState,
} from './actions/utility-dial.js';
import {
  ItermDialAction,
  initItermDial,
  updateItermDialState,
} from './actions/iterm-dial.js';

// ---- Shared state ----
let currentState = State.DISCONNECTED;
let currentMode = PermissionMode.DEFAULT;
let currentTool: string | undefined;
let currentToolInput: string | undefined;
let currentProjectName: string | undefined;
let currentModelName: string | undefined;
let currentBillingType: BillingType = 'unknown';
let currentOptions: import('@agentdeck/shared').PromptOption[] = [];
let currentQuestion: string | undefined;
let currentNavigable = false;
let currentCursorIndex = 0;
let currentSuggestedPrompt: string | undefined;
let currentSessionStatus: Record<string, unknown> | null = null;
let takeoverGeneration = 0;

// ---- Expanded mode state ----
let expandedMode = false;

export function enterExpandedMode(): void {
  expandedMode = true;
  broadcastStateUpdate();
}

export function exitExpandedMode(): void {
  expandedMode = false;
  broadcastStateUpdate();
}

// Wire up expand callback
setExpandCallback(enterExpandedMode);

// ---- Instances ----
const connMgr = new ConnectionManager();
const layoutManager = new LayoutManager();

// ---- Initialize action modules ----
initResponseButtons(connMgr, layoutManager);
initStopButton(connMgr);
initModeButton(connMgr);
initSessionButton(connMgr);
initUsageButton(connMgr);
initOptionDial(connMgr);
initVoiceDial(connMgr);
initUtilityDial();
initItermDial(connMgr);

// Refresh other dials when voice text takeover exits
setVoiceTextExitCallback(() => {
  const agentType = connMgr.getActiveAgentType();
  updateOptionDialState(currentState, currentOptions, undefined, undefined, undefined, undefined, undefined, currentSuggestedPrompt, agentType, currentSessionStatus);
  updateUtilityDialState(currentState);
  updateItermDialState(currentState, agentType, currentSessionStatus);
});

// ---- Bridge event handlers ----

connMgr.on('state_update', (ev: StateUpdateEvent) => {
  dlog('Plugin', `state_update: ${ev.state} mode=${ev.permissionMode} tool=${ev.currentTool || '-'} project=${ev.projectName || '-'} opts=${ev.options?.length ?? '-'} nav=${ev.navigable ?? '-'}`);
  currentState = ev.state;
  currentMode = ev.permissionMode;
  currentTool = ev.currentTool;
  currentToolInput = ev.toolInput;
  if (ev.projectName) currentProjectName = ev.projectName;
  if (ev.modelName) currentModelName = ev.modelName;
  if (ev.billingType) currentBillingType = ev.billingType;

  // Update capabilities from state_update (Bridge sends agentCapabilities on client connect)
  if (ev.agentCapabilities) {
    setUsageCapabilities(ev.agentCapabilities);
  }

  // Update model catalog if present
  if (ev.modelCatalog) {
    updateUsageModelCatalog(ev.modelCatalog);
  }

  // Capture question from state_update
  if (ev.question !== undefined) {
    currentQuestion = ev.question;
  }

  // Capture navigable/cursorIndex
  if (ev.navigable !== undefined) {
    currentNavigable = ev.navigable;
  }
  if (ev.cursorIndex !== undefined) {
    currentCursorIndex = ev.cursorIndex;
  }

  // Capture suggested prompt
  if (ev.suggestedPrompt !== undefined) {
    currentSuggestedPrompt = ev.suggestedPrompt;
  }
  // Capture session status (OpenClaw)
  if (ev.sessionStatus !== undefined) {
    currentSessionStatus = ev.sessionStatus;
  }
  // Clear suggestion on non-IDLE states
  if (ev.state !== State.IDLE) {
    currentSuggestedPrompt = undefined;
  }

  // Use options from state_update atomically (avoids race with separate prompt_options)
  if (ev.options && ev.options.length > 0) {
    currentOptions = ev.options;
  } else if (
    ev.state !== State.AWAITING_OPTION &&
    ev.state !== State.AWAITING_PERMISSION &&
    ev.state !== State.AWAITING_DIFF
  ) {
    currentOptions = [];
    currentQuestion = undefined;
    currentNavigable = false;
    currentCursorIndex = 0;
    currentToolInput = undefined;
  }

  broadcastStateUpdate();
});

connMgr.on('prompt_options', (ev: PromptOptionsEvent) => {
  dlog('Plugin', `prompt_options: type=${ev.promptType} count=${ev.options.length} q=${ev.question ? `"${ev.question.slice(0, 40)}"` : '-'}`);
  currentOptions = ev.options;
  if (ev.question) currentQuestion = ev.question;
  broadcastStateUpdate();
});

connMgr.on('usage_update', (ev: UsageEvent) => {
  dlog('Plugin', `usage_update: 5h=${ev.fiveHourPercent ?? '-'}% 7d=${ev.sevenDayPercent ?? '-'}% extra=${ev.extraUsageEnabled ? 'on' : 'off'} tokens=${ev.inputTokens + ev.outputTokens}`);
  updateUsageButton(currentState, {
    sessionDurationSec: ev.sessionDurationSec,
    inputTokens: ev.inputTokens,
    outputTokens: ev.outputTokens,
    estimatedCostUsd: ev.estimatedCostUsd,
    fiveHourPercent: ev.fiveHourPercent,
    fiveHourResetsAt: ev.fiveHourResetsAt,
    sevenDayPercent: ev.sevenDayPercent,
    sevenDayResetsAt: ev.sevenDayResetsAt,
    extraUsageEnabled: ev.extraUsageEnabled,
    extraUsageMonthlyLimit: ev.extraUsageMonthlyLimit,
    extraUsageUsedCredits: ev.extraUsageUsedCredits,
    extraUsageUtilization: ev.extraUsageUtilization,
  }, currentBillingType);
});

connMgr.on('connection', (ev: ConnectionEvent) => {
  dinfo('Plugin', `connection: ${ev.status}`);
  if (ev.status === 'disconnected') {
    currentState = State.DISCONNECTED;
    currentOptions = [];
    currentQuestion = undefined;
    currentNavigable = false;
    currentCursorIndex = 0;
    currentToolInput = undefined;
    currentSuggestedPrompt = undefined;
    broadcastStateUpdate();
  }
  // 'connected' case: state_update (sent before connection event) already
  // set the correct state — don't clobber it to IDLE here.
});

connMgr.on('user_prompt', (ev: UserPromptEvent) => {
  dlog('Plugin', `user_prompt: "${ev.text.slice(0, 60)}"`);
});

connMgr.on('voice_state', (ev: VoiceStateEvent) => {
  dlog('Plugin', `voice_state: ${ev.state} text=${ev.text ? `"${ev.text.slice(0, 40)}"` : '-'} err=${ev.error || '-'}`);
  if (ev.state === 'error') {
    setVoiceError(ev.error);
  } else {
    const vs = ev.state === 'recording' ? 'recording'
      : ev.state === 'transcribing' ? 'transcribing'
      : 'idle';
    setVoiceRecordingState(vs);
  }
  // Show transcribed text on voice dial LCD
  if (ev.state === 'idle' && ev.text) {
    setVoiceTranscription(ev.text);
  }
});

connMgr.on('active_agent_changed', (agentType: string) => {
  dinfo('Plugin', `active_agent_changed: ${agentType}`);
  const caps = connMgr.getCapabilities();
  setUsageCapabilities(caps);
  broadcastStateUpdate();
});

connMgr.on('connected', () => {
  dinfo('Plugin', `connected (activeAgent=${connMgr.getActiveAgentType()} prevState=${currentState})`);
  setUsageBridgeConnected(true);
  setUsageCapabilities(connMgr.getCapabilities());
  // Request fresh usage data immediately on connect (covers sleep/wake recovery)
  connMgr.send({ type: 'query_usage' });
});

connMgr.on('disconnected', () => {
  dinfo('Plugin', `disconnected (activeAgent=${connMgr.getActiveAgentType()} prevState=${currentState})`);
  setUsageBridgeConnected(false);
  setUsageCapabilities(null);
  currentState = State.DISCONNECTED;
  currentOptions = [];
  currentQuestion = undefined;
  currentNavigable = false;
  currentCursorIndex = 0;
  currentToolInput = undefined;
  currentSuggestedPrompt = undefined;
  broadcastStateUpdate();
});

function isInteractiveState(state: State): boolean {
  return (
    state === State.AWAITING_PERMISSION ||
    state === State.AWAITING_OPTION ||
    state === State.AWAITING_DIFF
  );
}

function broadcastStateUpdate(): void {
  // Auto-exit expanded mode on non-interactive state transitions
  if (expandedMode && !isInteractiveState(currentState)) {
    expandedMode = false;
  }

  dlog('Plugin', `broadcast: state=${currentState} mode=${currentMode} opts=${currentOptions.length} expanded=${expandedMode} takeover=${isEncoderTakeoverActive()}`);

  const agentType = connMgr.getActiveAgentType();
  const caps = connMgr.getCapabilities();
  const standby = connMgr.isStandby();

  if (expandedMode && currentOptions.length > 4) {
    // Expanded mode: all 7 keypad slots show options
    const configs = layoutManager.getExpandedLayout(currentState, currentOptions);
    overrideModeButton(configs[0]);
    overrideSessionButton(configs[1]);
    overrideUsageButton(configs[2]);
    updateResponseState(currentState, currentMode as any, currentOptions, configs.slice(3, 7), agentType, standby, currentNavigable);
    // With 7 options filling slots 0-6, stop button (slot 7) shows normal ESC/STOP
    overrideStopButton(null);
    updateStopState(currentState, undefined, standby);
  } else {
    // Normal mode: clear overrides, render normally
    overrideModeButton(null);
    overrideSessionButton(null);
    overrideUsageButton(null);
    setUsageState(currentState);
    updateModeButton(currentState, currentMode, caps);
    updateSessionButton(currentState, currentMode, currentProjectName, currentTool, currentModelName, agentType, standby);
    updateResponseState(currentState, currentMode as any, currentOptions, undefined, agentType, standby, currentNavigable);

    // Stop slot: may show 4th option or MORE button
    const stopOverride = layoutManager.getStopSlotOverride(currentState, currentOptions);
    if (stopOverride) {
      overrideStopButton(stopOverride);
    } else {
      overrideStopButton(null);
      updateStopState(currentState, undefined, standby);
    }
  }

  // Encoder actions — manage takeover lifecycle
  const shouldTakeover = isInteractiveState(currentState) && currentOptions.length > 0;

  if (shouldTakeover && !isEncoderTakeoverActive()) {
    // Exit VT before encoder takeover (clears all panels atomically)
    updateVoiceDialState(currentState);
    // Enter takeover, then update option dial with full context
    const enterGen = ++takeoverGeneration;
    void enterEncoderTakeover().then(() => {
      if (enterGen !== takeoverGeneration) return; // superseded by newer transition
      updateOptionDialState(
        currentState, currentOptions, currentQuestion, currentTool,
        currentNavigable, currentCursorIndex, currentToolInput,
        currentSuggestedPrompt, agentType, currentSessionStatus,
      );
    });
  } else if (!shouldTakeover && isEncoderTakeoverActive()) {
    // Exit takeover, then restore all dials
    const exitGen = ++takeoverGeneration;
    void exitEncoderTakeover().then(() => {
      if (exitGen !== takeoverGeneration) return; // superseded by newer transition
      updateVoiceDialState(currentState);
      updateUtilityDialState(currentState);
      updateItermDialState(currentState, agentType, currentSessionStatus);
    });
    updateOptionDialState(currentState, currentOptions, undefined, undefined, undefined, undefined, undefined, currentSuggestedPrompt, agentType, currentSessionStatus);
  } else if (shouldTakeover) {
    // Already in takeover — just refresh
    updateOptionDialState(
      currentState, currentOptions, currentQuestion, currentTool,
      currentNavigable, currentCursorIndex, currentToolInput,
      currentSuggestedPrompt, agentType, currentSessionStatus,
    );
  } else {
    // Not in takeover, not entering — normal updates
    updateOptionDialState(currentState, currentOptions, undefined, undefined, undefined, undefined, undefined, currentSuggestedPrompt, agentType, currentSessionStatus);
    updateVoiceDialState(currentState);
    updateUtilityDialState(currentState);
    updateItermDialState(currentState, agentType, currentSessionStatus);
  }
}

// ---- Register actions ----
streamDeck.actions.registerAction(new ResponseButtonAction());
streamDeck.actions.registerAction(new StopButtonAction());
streamDeck.actions.registerAction(new ModeButtonAction());
streamDeck.actions.registerAction(new SessionButtonAction());
streamDeck.actions.registerAction(new UsageButtonAction());
streamDeck.actions.registerAction(new ResponseDialAction());
streamDeck.actions.registerAction(new VoiceDialAction());
streamDeck.actions.registerAction(new UtilityDialAction());
streamDeck.actions.registerAction(new ItermDialAction());

// ---- Connect ----

/** Find the most recently started session's port, or undefined for default */
function findLatestSessionPort(): number | undefined {
  try {
    const data = readFileSync(`${homedir()}/.agentdeck/sessions.json`, 'utf-8');
    const sessions = JSON.parse(data) as Array<{ port: number; pid: number; startedAt: string }>;
    // Filter alive sessions
    const alive = sessions.filter((s) => {
      try { process.kill(s.pid, 0); return true; } catch { return false; }
    });
    if (alive.length === 0) return undefined;
    alive.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    dinfo('Plugin', `Latest session port: ${alive[0].port} (${alive.length} active)`);
    return alive[0].port;
  } catch {
    return undefined;
  }
}

streamDeck.connect().then(() => {
  dinfo('Plugin', 'Stream Deck connected, starting connection manager');
  connMgr.scanLatestPort = () => findLatestSessionPort();
  const port = findLatestSessionPort();
  connMgr.start(port);
});
