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
  OPENCLAW_CAPABILITIES,
  type AgentType,
  type BillingType,
  type DeckSlotConfig,
  type DeckSlotMapEvent,
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
import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { homedir } from 'os';

// Keypad button actions
import {
  ResponseButtonAction,
  initResponseButtons,
  updateResponseState,
  setResponseSetupRequired,
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
  setSessionSetupRequired,
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
  setRemoteUrl,
  setPairingUrl,
} from './actions/usage-button.js';

// Encoder actions
import {
  ResponseDialAction,
  initOptionDial,
  updateOptionDialState,
  setOptionSetupRequired,
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
  setUtilitySetupRequired,
} from './actions/utility-dial.js';
import {
  ItermDialAction,
  initItermDial,
  updateItermDialState,
} from './actions/iterm-dial.js';

// ---- Setup detection ----
let setupRequired = false;

function detectSetupState(): void {
  const bridgeEverStarted = existsSync(`${homedir()}/.agentdeck/`);
  let sdcInPath = false;
  try {
    execSync('which sdc', { stdio: 'ignore', timeout: 3000 });
    sdcInPath = true;
  } catch { /* not found */ }
  setupRequired = !bridgeEverStarted && !sdcInPath;
  dinfo('Plugin', `detectSetupState: bridgeEverStarted=${bridgeEverStarted} sdcInPath=${sdcInPath} setupRequired=${setupRequired}`);
}

function propagateSetupRequired(value: boolean): void {
  setupRequired = value;
  setSessionSetupRequired(value);
  setResponseSetupRequired(value);
  setUtilitySetupRequired(value);
  setOptionSetupRequired(value);
}

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
let proxiedAgentType: AgentType | null = null;

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
  const agentType = proxiedAgentType ?? connMgr.getActiveAgentType();
  const vtCaps = proxiedAgentType === 'openclaw' ? OPENCLAW_CAPABILITIES : connMgr.getCapabilities();
  updateOptionDialState(currentState, currentOptions, undefined, undefined, undefined, undefined, undefined, currentSuggestedPrompt, agentType, currentSessionStatus, vtCaps);
  updateUtilityDialState(currentState);
  updateItermDialState(currentState, agentType, currentSessionStatus, vtCaps);
});

// ---- Bridge event handlers ----

connMgr.on('state_update', (ev: StateUpdateEvent) => {
  dlog('Plugin', `state_update: ${ev.state} mode=${ev.permissionMode} tool=${ev.currentTool || '-'} project=${ev.projectName || '-'} opts=${ev.options?.length ?? '-'} nav=${ev.navigable ?? '-'}`);

  // Auto-resolve setup state on first bridge connection
  if (setupRequired) {
    propagateSetupRequired(false);
  }

  currentState = ev.state;
  currentMode = ev.permissionMode;
  currentTool = ev.currentTool;
  currentToolInput = ev.toolInput;
  if (ev.projectName) currentProjectName = ev.projectName;
  if (ev.modelName) currentModelName = ev.modelName;
  if (ev.billingType) currentBillingType = ev.billingType;
  if (ev.gatewayAvailable !== undefined) {
    connMgr.setBridgeGatewayAvailable(ev.gatewayAvailable);
  }

  // Track proxied agent type from daemon (state_update.agentType overrides connection-level detection)
  if (ev.agentType === 'openclaw' || ev.agentType === 'claude-code') {
    proxiedAgentType = ev.agentType;
  }

  // Update capabilities from state_update (Bridge sends agentCapabilities on client connect)
  // When daemon proxies OpenClaw, it doesn't send agentCapabilities — derive from proxiedAgentType
  if (ev.agentCapabilities) {
    setUsageCapabilities(ev.agentCapabilities);
  } else if (proxiedAgentType === 'openclaw') {
    setUsageCapabilities(OPENCLAW_CAPABILITIES);
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
  // Capture remote URL for QR display
  if (ev.remoteUrl !== undefined) {
    setRemoteUrl(ev.remoteUrl);
  }
  // Capture pairing URL for QR code (authenticated WS URL)
  if (ev.pairingUrl !== undefined) {
    setPairingUrl(ev.pairingUrl);
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
  const caps = proxiedAgentType === 'openclaw' ? OPENCLAW_CAPABILITIES : connMgr.getCapabilities();
  setUsageCapabilities(caps);
  broadcastStateUpdate();
});

connMgr.on('connected', () => {
  dinfo('Plugin', `connected (activeAgent=${connMgr.getActiveAgentType()} prevState=${currentState})`);
  setUsageBridgeConnected(true);
  const connCaps = proxiedAgentType === 'openclaw' ? OPENCLAW_CAPABILITIES : connMgr.getCapabilities();
  setUsageCapabilities(connCaps);
  // Request fresh usage data immediately on connect (covers sleep/wake recovery)
  connMgr.send({ type: 'query_usage' });
});

connMgr.on('disconnected', () => {
  dinfo('Plugin', `disconnected (activeAgent=${connMgr.getActiveAgentType()} prevState=${currentState})`);
  setUsageBridgeConnected(false);
  setUsageCapabilities(null);
  proxiedAgentType = null;
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

  const agentType = proxiedAgentType ?? connMgr.getActiveAgentType();
  const caps = proxiedAgentType === 'openclaw'
    ? OPENCLAW_CAPABILITIES
    : connMgr.getCapabilities();

  if (expandedMode && currentOptions.length > 4) {
    // Expanded mode: all 7 keypad slots show options
    const configs = layoutManager.getExpandedLayout(currentState, currentOptions);
    overrideModeButton(configs[0]);
    overrideSessionButton(configs[1]);
    overrideUsageButton(configs[2]);
    updateResponseState(currentState, currentMode as any, currentOptions, configs.slice(3, 7), agentType, currentNavigable, caps);
    // With 7 options filling slots 0-6, stop button (slot 7) shows normal ESC/STOP
    overrideStopButton(null);
    updateStopState(currentState);
  } else {
    // Normal mode: clear overrides, render normally
    overrideModeButton(null);
    overrideSessionButton(null);
    overrideUsageButton(null);
    setUsageState(currentState);
    updateModeButton(currentState, currentMode, caps);
    updateSessionButton(currentState, currentMode, currentProjectName, currentTool, currentModelName, agentType);
    updateResponseState(currentState, currentMode as any, currentOptions, undefined, agentType, currentNavigable, caps);

    // Stop slot: may show 4th option or MORE button
    const stopOverride = layoutManager.getStopSlotOverride(currentState, currentOptions);
    if (stopOverride) {
      overrideStopButton(stopOverride);
    } else {
      overrideStopButton(null);
      updateStopState(currentState);
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
        currentSuggestedPrompt, agentType, currentSessionStatus, caps,
      );
    });
  } else if (!shouldTakeover && isEncoderTakeoverActive()) {
    // Exit takeover, then restore all dials
    const exitGen = ++takeoverGeneration;
    void exitEncoderTakeover().then(() => {
      if (exitGen !== takeoverGeneration) return; // superseded by newer transition
      updateVoiceDialState(currentState);
      updateUtilityDialState(currentState);
      updateItermDialState(currentState, agentType, currentSessionStatus, caps);
    });
    updateOptionDialState(currentState, currentOptions, undefined, undefined, undefined, undefined, undefined, currentSuggestedPrompt, agentType, currentSessionStatus, caps);
  } else if (shouldTakeover) {
    // Already in takeover — just refresh
    updateOptionDialState(
      currentState, currentOptions, currentQuestion, currentTool,
      currentNavigable, currentCursorIndex, currentToolInput,
      currentSuggestedPrompt, agentType, currentSessionStatus, caps,
    );
  } else {
    // Not in takeover, not entering — normal updates
    updateOptionDialState(currentState, currentOptions, undefined, undefined, undefined, undefined, undefined, currentSuggestedPrompt, agentType, currentSessionStatus, caps);
    updateVoiceDialState(currentState);
    updateUtilityDialState(currentState);
    updateItermDialState(currentState, agentType, currentSessionStatus, caps);
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

// ---- Slot Map Reporting (Phase A7) ----

// UUID suffix → actionType mapping
const UUID_TO_ACTION_TYPE: Record<string, string> = {
  'response-button': 'response-button',
  'stop-button': 'stop-button',
  'mode-button': 'mode-button',
  'session-button': 'session-button',
  'usage-button': 'usage-button',
  'response-dial': 'option-dial',
  'voice-dial': 'voice-dial',
  'utility-dial': 'utility-dial',
  'iterm-dial': 'iterm-dial',
};

interface SlotEntry {
  slot: number;
  controller: 'Keypad' | 'Encoder';
  actionType: string;
  settings?: Record<string, unknown>;
}

const appearedActions = new Map<string, SlotEntry>();
let slotMapTimer: ReturnType<typeof setTimeout> | null = null;

// Global willAppear listener — tracks all actions without modifying individual action files
streamDeck.actions.onWillAppear((ev) => {
  const uuid = ev.action.manifestId;
  const suffix = uuid.replace('bound.serendipity.agentdeck.', '');
  const actionType = UUID_TO_ACTION_TYPE[suffix] || suffix;
  const payload = ev.payload as any;
  const controller = payload.controller || 'Keypad';
  const column = payload.coordinates?.column ?? 0;

  appearedActions.set(ev.action.id, {
    slot: column,
    controller,
    actionType,
    settings: payload.settings,
  });

  // Debounce: wait for all actions to appear before sending
  if (slotMapTimer) clearTimeout(slotMapTimer);
  slotMapTimer = setTimeout(sendSlotMap, 500);
});

function sendSlotMap(): void {
  const buttons: DeckSlotConfig[] = [];
  const encoders: DeckSlotConfig[] = [];

  for (const entry of appearedActions.values()) {
    const config: DeckSlotConfig = {
      slot: entry.slot,
      actionType: entry.actionType,
      settings: entry.settings,
    };
    if (entry.controller === 'Encoder') {
      encoders.push(config);
    } else {
      buttons.push(config);
    }
  }

  // Sort by slot
  buttons.sort((a, b) => a.slot - b.slot);
  encoders.sort((a, b) => a.slot - b.slot);

  const slotMap: DeckSlotMapEvent = {
    type: 'deck_slot_map',
    buttons,
    encoders,
  };

  dinfo('Plugin', `Sending slot map: ${buttons.length} buttons, ${encoders.length} encoders`);
  connMgr.send(slotMap as any);
}

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
  detectSetupState();
  if (setupRequired) {
    propagateSetupRequired(true);
    broadcastStateUpdate();
  }
  connMgr.scanLatestPort = () => findLatestSessionPort();
  const port = findLatestSessionPort();
  connMgr.start(port);
});
