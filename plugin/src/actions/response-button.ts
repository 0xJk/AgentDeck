import streamDeck, {
  action,
  SingletonAction,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
  DidReceiveSettingsEvent,
} from '@elgato/streamdeck';
import { State, PromptOption, type AgentCapabilities, type AgentType, OPENCLAW_GATEWAY_PORT, augmentedPath, resolveOpenClawBin } from '@agentdeck/shared';
import { execFileSync } from 'child_process';
import type { AgentLink } from '../agent-link.js';
import { openOrFocusBrowserTab } from '../utility-modes/macos.js';
import { LayoutManager, ButtonConfig } from '../layout-manager.js';
import { renderButton, svgToDataUrl, labelNeedsHaiku, BUTTON_MAX_CHARS } from '../renderers/button-renderer.js';
import { requestAbbreviation } from '../label-summarizer.js';
import { handleExpandedAction } from '../expanded-actions.js';
import { isPickerActive, selectByButtonSlot, openPicker, setPickerButtonCallback, setPickerBaseDir } from '../project-picker.js';
import { getModelCatalog, fetchStandaloneModelCatalog, stripProviderPrefix } from './usage-button.js';
import { timelineStore } from '../timeline-store.js';
import { OC_BODY, OC_CLAW_L, OC_CLAW_R } from '../renderers/agent-logos.js';
import { dlog, dwarn, derr } from '../log.js';

import type { JsonValue } from '@elgato/utils';

interface ResponseButtonSettings {
  [key: string]: JsonValue;
  slotIndex?: number;
  label?: string;
  action?: string;
  disconnectedLabel?: string;
  disconnectedAction?: string;
  baseDir?: string;
}

const DEFAULT_IDLE_SETTINGS: ResponseButtonSettings[] = [
  { label: 'GO ON', action: 'continue', disconnectedLabel: 'START', disconnectedAction: 'sdc', baseDir: '~/Documents' },
  { label: 'REVIEW', action: '/review' },
  { label: 'COMMIT', action: '/commit' },
  { label: 'CLEAR', action: '/clear' },
];

/** Per-instance user-customised PI settings (only fields explicitly set by user) */
const userSettingsMap = new Map<string, ResponseButtonSettings>();

/** Compute effective settings for a button: slot defaults + user overrides (disconnected* always from defaults) */
function effectiveSettings(actionId: string): ResponseButtonSettings {
  const slot = actionSlots.get(actionId) ?? -1;
  const defaults = (slot >= 0 && slot < DEFAULT_IDLE_SETTINGS.length) ? DEFAULT_IDLE_SETTINGS[slot] : {};
  const user = userSettingsMap.get(actionId);
  if (!user) return defaults;
  // User settings override label/action only; disconnected* always from slot defaults
  const { disconnectedLabel: _dl, disconnectedAction: _da, ...piOnly } = user;
  return { ...defaults, ...piOnly };
}

/** Check if settings contain user customizations that differ from slot defaults */
function hasUserCustomizations(settings: ResponseButtonSettings, slotIndex: number): boolean {
  const defaults = (slotIndex >= 0 && slotIndex < DEFAULT_IDLE_SETTINGS.length)
    ? DEFAULT_IDLE_SETTINGS[slotIndex] : {};
  return (!!settings.label && settings.label !== defaults.label) ||
         (!!settings.action && settings.action !== defaults.action) ||
         (!!settings.baseDir && settings.baseDir !== (defaults as ResponseButtonSettings).baseDir);
}

let bridge: AgentLink;
let layoutManager: LayoutManager;
let currentState = State.DISCONNECTED;
let currentMode = 'default';
let currentOptions: PromptOption[] = [];
let currentAgentType: AgentType | null = null;
let currentStandby = false;
let currentNavigable = false;

// Action ID → fixed slot index (0-based, from PI settings)
const actionSlots = new Map<string, number>();

/** Return action IDs sorted by fixed slot index (0 → N) */
function getSortedIds(): string[] {
  return [...actionSlots.keys()].sort((a, b) =>
    (actionSlots.get(a) ?? 99) - (actionSlots.get(b) ?? 99)
  );
}

export function initResponseButtons(
  b: AgentLink,
  lm: LayoutManager,
): void {
  bridge = b;
  layoutManager = lm;
  // Wire picker button callback (avoids circular dep)
  setPickerButtonCallback((configs) => {
    if (configs) {
      overrideConfigs = configs;
      refreshAllButtons();
    } else {
      overrideConfigs = null;
      refreshAllButtons();
    }
  });
}

let overrideConfigs: ButtonConfig[] | null = null;

export function updateResponseState(
  state: State,
  mode: string,
  options: PromptOption[],
  expandedConfigs?: ButtonConfig[],
  agentType?: AgentType | null,
  standby?: boolean,
  navigable?: boolean,
): void {
  currentState = state;
  currentMode = mode;
  currentOptions = options;
  overrideConfigs = expandedConfigs ?? null;
  if (agentType !== undefined) currentAgentType = agentType;
  if (standby !== undefined) currentStandby = standby;
  if (navigable !== undefined) currentNavigable = navigable;
  refreshAllButtons();
}

function idleButtonConfig(s: ResponseButtonSettings): ButtonConfig {
  const label = s.label ?? '';
  const actionText = s.action?.trim() ?? '';
  const enabled = actionText.length > 0;
  const isCommand = actionText.startsWith('/');
  return {
    title: label,
    color: isCommand ? '#1e293b' : '#1e3a2f',
    textColor: isCommand ? '#94a3b8' : (enabled ? '#6ee7b7' : '#555555'),
    enabled,
    action: `command:${actionText}`,
  };
}

/** Dimmed version of idle config — shows label but greyed out (for DISCONNECTED/PROCESSING) */
function dimButtonConfig(s: ResponseButtonSettings): ButtonConfig {
  const label = s.label ?? '';
  return {
    title: label,
    color: '#1a1a1a',
    textColor: '#444444',
    enabled: false,
  };
}

/** Config for DISCONNECTED state — active if shell command configured, dimmed otherwise */
function disconnectedButtonConfig(s: ResponseButtonSettings): ButtonConfig {
  const cmd = s.disconnectedAction?.trim() ?? '';
  if (!cmd) return dimButtonConfig(s);
  const label = s.disconnectedLabel ?? cmd;
  return {
    title: label,
    color: '#0f3460',
    textColor: '#e2e8f0',
    enabled: true,
    action: `shell:${cmd}`,
  };
}

const DIM_BUTTON: ButtonConfig = { title: '', color: '#1a1a1a', textColor: '#444444', enabled: false };

let modelSwitching = false;

/** Play arrow icon for GO ON button */
const GO_ON_ICON_SVG = [
  `<circle cx="72" cy="44" r="28" fill="none" stroke="#6ee7b7" stroke-width="2.5" opacity="0.5"/>`,
  `<polygon points="62,30 62,58 88,44" fill="#6ee7b7" opacity="0.9"/>`,
].join('');

/** Document summary icon for SUMMARIZE button */
const SUMMARIZE_ICON_SVG = [
  `<rect x="40" y="14" width="64" height="56" rx="5" fill="none" stroke="#93c5fd" stroke-width="2"/>`,
  `<line x1="50" y1="28" x2="94" y2="28" stroke="#93c5fd" stroke-width="2" opacity="0.6"/>`,
  `<line x1="50" y1="40" x2="88" y2="40" stroke="#93c5fd" stroke-width="2" opacity="0.6"/>`,
  `<line x1="50" y1="52" x2="78" y2="52" stroke="#93c5fd" stroke-width="2" opacity="0.6"/>`,
  `<polyline points="82,50 87,56 96,44" fill="none" stroke="#93c5fd" stroke-width="2.5" stroke-linecap="round"/>`,
].join('');

/** Cycling arrows icon for MODEL button */
const MODEL_ICON_SVG = [
  `<path d="M50,22 A28,28 0 1,1 36,55" fill="none" stroke="#e9d5ff" stroke-width="2.5" stroke-linecap="round"/>`,
  `<polygon points="33,48 36,58 44,52" fill="#e9d5ff"/>`,
  `<path d="M94,66 A28,28 0 1,1 108,33" fill="none" stroke="#e9d5ff" stroke-width="2.5" stroke-linecap="round"/>`,
  `<polygon points="111,40 108,30 100,36" fill="#e9d5ff"/>`,
].join('');

/** Browser window + OC lobster icon for GATEWAY button */
const GATEWAY_ICON_SVG = [
  // Browser window frame
  `<rect x="30" y="16" width="84" height="64" rx="6" fill="none" stroke="#94a3b8" stroke-width="2"/>`,
  `<line x1="30" y1="30" x2="114" y2="30" stroke="#94a3b8" stroke-width="1.5"/>`,
  // 3 dots (traffic lights)
  `<circle cx="40" cy="23" r="2.5" fill="#ef4444"/>`,
  `<circle cx="48" cy="23" r="2.5" fill="#fbbf24"/>`,
  `<circle cx="56" cy="23" r="2.5" fill="#4ade80"/>`,
  // OC lobster inside browser (scaled 0.35, centered at ~72,55)
  `<g transform="translate(51,32) scale(0.35)">`,
  `<defs><linearGradient id="oc-btn-g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ff4d4d"/><stop offset="100%" stop-color="#991b1b"/></linearGradient></defs>`,
  `<path d="${OC_BODY}" fill="url(#oc-btn-g)"/>`,
  `<path d="${OC_CLAW_L}" fill="url(#oc-btn-g)"/>`,
  `<path d="${OC_CLAW_R}" fill="url(#oc-btn-g)"/>`,
  `<circle cx="45" cy="35" r="6" fill="#050810"/>`,
  `<circle cx="75" cy="35" r="6" fill="#050810"/>`,
  `<circle cx="46" cy="34" r="2.5" fill="#00e5cc"/>`,
  `<circle cx="76" cy="34" r="2.5" fill="#00e5cc"/>`,
  `</g>`,
].join('');

function getDefaultModelName(): string {
  const catalog = getModelCatalog();
  if (!catalog) return '';
  const def = catalog.find(m => m.role === 'default');
  return def?.name ?? '';
}

function getOpenClawIdlePresets(): ButtonConfig[] {
  const modelName = stripProviderPrefix(getDefaultModelName());
  return [
    { title: 'GO ON', color: '#1e3a2f', textColor: '#6ee7b7', enabled: true, action: 'command:continue', iconSvg: GO_ON_ICON_SVG },
    { title: 'SUMMARIZE', color: '#1a1a3e', textColor: '#93c5fd', enabled: true, action: 'command:summarize', iconSvg: SUMMARIZE_ICON_SVG },
    {
      title: 'MODEL',
      subtitle: modelName || undefined,
      color: '#2d1f3d',
      textColor: '#e9d5ff',
      enabled: true,
      action: 'action:model_switch',
      loading: modelSwitching,
      iconSvg: MODEL_ICON_SVG,
    },
    { title: 'GATEWAY', color: '#1a0f2e', textColor: '#c084fc', enabled: true, action: 'open:gateway_web', iconSvg: GATEWAY_ICON_SVG },
  ];
}

function refreshAllButtons(): void {
  const sorted = getSortedIds();

  // Standby mode: all DIM (unless AWAITING_PERMISSION for alert)
  if (currentStandby && currentState !== State.AWAITING_PERMISSION) {
    for (let i = 0; i < sorted.length; i++) {
      // Keep slot 0 START button if it has a disconnectedAction
      if (i === 0) {
        const s = effectiveSettings(sorted[i]);
        applyButtonConfig(sorted[i], disconnectedButtonConfig(s), actionSlots.get(sorted[i]));
      } else {
        applyButtonConfig(sorted[i], DIM_BUTTON, actionSlots.get(sorted[i]));
      }
    }
    return;
  }

  // OpenClaw agent-specific layouts
  if (currentAgentType === 'openclaw' && !overrideConfigs) {
    dlog('RspBut', `refresh OC: state=${currentState} ids=${sorted.length}`);
    if (currentState === State.IDLE) {
      // OC IDLE: utility presets (GO ON, SUMMARIZE, MODEL, GATEWAY)
      const presets = getOpenClawIdlePresets();
      for (let i = 0; i < sorted.length; i++) {
        const preset = i < presets.length ? presets[i] : DIM_BUTTON;
        applyButtonConfig(sorted[i], preset, actionSlots.get(sorted[i]));
      }
      return;
    }
    if (currentState === State.PROCESSING) {
      for (let i = 0; i < sorted.length; i++) {
        applyButtonConfig(sorted[i], DIM_BUTTON, actionSlots.get(sorted[i]));
      }
      return;
    }
    if (currentState === State.AWAITING_PERMISSION) {
      // OC Permission: Allow / Deny + DIM
      const ocButtons: ButtonConfig[] = [
        { title: 'ALLOW', color: '#166534', textColor: '#ffffff', enabled: true, action: 'respond:y' },
        { title: 'DENY', color: '#991b1b', textColor: '#ffffff', enabled: true, action: 'respond:n' },
        DIM_BUTTON,
        DIM_BUTTON,
      ];
      for (let i = 0; i < sorted.length; i++) {
        applyButtonConfig(sorted[i], i < ocButtons.length ? ocButtons[i] : DIM_BUTTON, actionSlots.get(sorted[i]));
      }
      return;
    }
  }

  if (currentState === State.IDLE && !overrideConfigs) {
    // IDLE: use per-instance PI settings
    dlog('RspBut', `refresh IDLE: ids=${sorted.length}`);
    for (let i = 0; i < sorted.length; i++) {
      const s = effectiveSettings(sorted[i]);
      applyButtonConfig(sorted[i], idleButtonConfig(s), actionSlots.get(sorted[i]));
    }
    return;
  }

  if (overrideConfigs) {
    // Expanded mode: use externally provided configs for slots 3-5
    dlog('RspBut', `refresh expanded: ids=${sorted.length} configs=${overrideConfigs.length}`);
    for (let i = 0; i < sorted.length; i++) {
      if (i < overrideConfigs.length) {
        applyButtonConfig(sorted[i], overrideConfigs[i], actionSlots.get(sorted[i]));
      } else {
        applyButtonConfig(sorted[i], { title: '', color: '#1a1a1a', textColor: '#444444', enabled: false }, actionSlots.get(sorted[i]));
      }
    }
    return;
  }

  // DISCONNECTED: show shell-command buttons active, others dimmed
  if (currentState === State.DISCONNECTED) {
    dlog('RspBut', `refresh DISCONNECTED: ids=${sorted.length}`);
    for (let i = 0; i < sorted.length; i++) {
      const s = effectiveSettings(sorted[i]);
      applyButtonConfig(sorted[i], disconnectedButtonConfig(s), actionSlots.get(sorted[i]));
    }
    return;
  }

  // PROCESSING: show START for slots with disconnectedAction, dim others
  if (currentState === State.PROCESSING) {
    dlog('RspBut', `refresh PROCESSING: ids=${sorted.length} (START + dimmed)`);
    for (let i = 0; i < sorted.length; i++) {
      const s = effectiveSettings(sorted[i]);
      const hasDisconnected = !!s.disconnectedAction?.trim();
      applyButtonConfig(sorted[i], hasDisconnected ? disconnectedButtonConfig(s) : dimButtonConfig(s), actionSlots.get(sorted[i]));
    }
    return;
  }

  // Interactive states: delegate to layoutManager
  const buttons = layoutManager.getButtonLayout(
    currentState,
    currentMode as any,
    currentOptions,
    currentNavigable,
  );

  dlog('RspBut', `refresh: state=${currentState} nav=${currentNavigable} ids=${sorted.length} buttons=[${buttons.map(b => b.title ? `"${b.badge ? b.badge + ' ' : ''}${b.title}${b.subtitle ? ' | ' + b.subtitle : ''}"` : 'DIM').join(', ')}]`);
  for (let i = 0; i < sorted.length; i++) {
    if (i < buttons.length) {
      applyButtonConfig(sorted[i], buttons[i], actionSlots.get(sorted[i]));
    } else {
      applyButtonConfig(sorted[i], { title: '', color: '#1a1a1a', textColor: '#444444', enabled: false }, actionSlots.get(sorted[i]));
    }
  }

  // Fire async Haiku summarization for labels that still overflow after heuristic abbreviation
  for (const btn of buttons) {
    const label = btn.badge ? `${btn.badge} ${btn.title}` : btn.title;
    if (label && labelNeedsHaiku(label)) {
      void requestAbbreviation(label, BUTTON_MAX_CHARS).then((result) => {
        if (result) refreshAllButtons(); // re-render with cached Haiku result
      });
    }
  }
}

function applyButtonConfig(actionId: string, config: ButtonConfig, slotIndex?: number): void {
  if (slotIndex != null) config.slotNumber = slotIndex + 1;
  const svg = renderButton(config);
  const dataUrl = svgToDataUrl(svg);
  const act = streamDeck.actions.getActionById(actionId);
  if (act) {
    void act.setImage(dataUrl).catch((e) => {
      dlog('RspBut', `setImage error: ${e}`);
    });
  }
}

@action({ UUID: 'bound.serendipity.agentdeck.response-button' })
export class ResponseButtonAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    const settings = (ev.payload?.settings ?? {}) as ResponseButtonSettings;
    const rawSlot = settings.slotIndex;
    const slotIndex = rawSlot != null ? Number(rawSlot) : this.autoAssignSlot();
    actionSlots.set(ev.action.id, slotIndex);
    const sorted = getSortedIds();
    const slot = sorted.indexOf(ev.action.id);
    dlog('RspBut', `onWillAppear: id=${ev.action.id} slotIndex=${slotIndex} slot=${slot} total=${sorted.length}`);

    // Only cache user-customised PI settings if they differ from slot defaults
    if (hasUserCustomizations(settings, slotIndex)) {
      userSettingsMap.set(ev.action.id, settings);
    }
    // Persist slot defaults so PI shows actual values (not just placeholders)
    const defaults = (slotIndex >= 0 && slotIndex < DEFAULT_IDLE_SETTINGS.length)
      ? DEFAULT_IDLE_SETTINGS[slotIndex] : {};
    if (settings.slotIndex == null || settings.label == null || settings.action == null) {
      void ev.action.setSettings({
        ...settings,
        slotIndex,
        label: settings.label ?? defaults.label ?? '',
        action: settings.action ?? defaults.action ?? '',
      } as ResponseButtonSettings).catch(() => {});
    }
    // Refresh ALL buttons so every slot gets the correct number after sort
    refreshAllButtons();
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<ResponseButtonSettings>): void {
    const settings = ev.payload.settings;
    const slotIndex = settings.slotIndex != null ? Number(settings.slotIndex) : (actionSlots.get(ev.action.id) ?? -1);
    dlog('RspBut', `onDidReceiveSettings: id=${ev.action.id} slotIndex=${slotIndex} label=${settings.label} action=${settings.action}`);
    // Update slot index if changed
    if (settings.slotIndex != null) {
      actionSlots.set(ev.action.id, slotIndex);
    }
    // Only track as user-custom if values differ from slot defaults
    if (hasUserCustomizations(settings, slotIndex)) {
      userSettingsMap.set(ev.action.id, settings);
    } else {
      userSettingsMap.delete(ev.action.id);
    }
    // Refresh to reflect changes immediately
    if (currentState === State.IDLE || currentState === State.DISCONNECTED) {
      refreshAllButtons();
    }
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    const sorted = getSortedIds();
    const slot = sorted.indexOf(ev.action.id);
    // === Guard A: action ID not in actionSlots ===
    dlog('RspBut', `keyDown ENTRY: id=${ev.action.id} slot=${slot} state=${currentState} ` +
      `override=${!!overrideConfigs} standby=${currentStandby} sorted=${sorted.length}`);
    if (slot < 0) {
      dwarn('RspBut', `keyDown GUARD-A: action ID not in actionSlots! id=${ev.action.id} slots=[${sorted.join(',')}]`);
      return;
    }

    let actionStr: string | undefined;

    // === Guard B: DISCONNECTED or PROCESSING ===
    if (currentState === State.DISCONNECTED || currentState === State.PROCESSING) {
      if (isPickerActive()) {
        // Picker active: button selects project
        dlog('RspBut', `keyDown slot=${slot} → picker select (state=${currentState})`);
        selectByButtonSlot(slot);
        return;
      }
      const s = effectiveSettings(ev.action.id);
      const cmd = s.disconnectedAction?.trim();
      if (!cmd) {
        dlog('RspBut', `keyDown GUARD-B: slot=${slot} state=${currentState} — no disconnectedAction, returning`);
        return;
      }
      dlog('RspBut', `keyDown slot=${slot} → openPicker (state=${currentState})`);
      setPickerBaseDir(s.baseDir ?? '~/Documents');
      void openPicker();
      return;
    }

    if (overrideConfigs) {
      // Expanded mode: use override configs
      const config = slot < overrideConfigs.length ? overrideConfigs[slot] : undefined;
      // === Guard C: override config disabled or no action ===
      if (!config?.enabled || !config.action) {
        dlog('RspBut', `keyDown GUARD-C: slot=${slot} override config disabled/missing (enabled=${config?.enabled} action=${config?.action})`);
        return;
      }
      actionStr = config.action;
    } else if (currentAgentType === 'openclaw' && currentState === State.IDLE) {
      // OpenClaw IDLE: use dynamic preset configs (GO ON, SUMMARIZE, MODEL, GATEWAY)
      const presets = getOpenClawIdlePresets();
      const preset = slot < presets.length ? presets[slot] : DIM_BUTTON;
      if (!preset.enabled || !preset.action) {
        dlog('RspBut', `keyDown GUARD-OC-IDLE: slot=${slot} preset disabled`);
        return;
      }
      actionStr = preset.action;
    } else if (currentAgentType === 'openclaw' && currentState === State.AWAITING_PERMISSION) {
      // OpenClaw Permission: ALLOW / DENY
      const ocButtons: ButtonConfig[] = [
        { title: 'ALLOW', color: '#166534', textColor: '#ffffff', enabled: true, action: 'respond:y' },
        { title: 'DENY', color: '#991b1b', textColor: '#ffffff', enabled: true, action: 'respond:n' },
      ];
      const config = slot < ocButtons.length ? ocButtons[slot] : undefined;
      if (!config?.enabled || !config.action) {
        dlog('RspBut', `keyDown GUARD-OC-PERM: slot=${slot} no action`);
        return;
      }
      actionStr = config.action;
    } else if (currentState === State.IDLE) {
      // Use per-instance PI settings for IDLE
      const s = effectiveSettings(ev.action.id);
      actionStr = `command:${s.action ?? ''}`;
    } else {
      const buttons = layoutManager.getButtonLayout(
        currentState,
        currentMode as any,
        currentOptions,
        currentNavigable,
      );
      // === Guard D: slot out of range or disabled ===
      if (slot >= buttons.length) {
        dlog('RspBut', `keyDown GUARD-D: slot=${slot} >= buttons.length=${buttons.length}`);
        return;
      }
      const config = buttons[slot];
      if (!config.enabled || !config.action) {
        dlog('RspBut', `keyDown GUARD-D: slot=${slot} disabled (enabled=${config.enabled} action=${config.action})`);
        return;
      }
      actionStr = config.action;
    }

    // === Guard E: empty actionStr ===
    if (!actionStr) {
      dlog('RspBut', `keyDown GUARD-E: slot=${slot} actionStr is empty/undefined`);
      return;
    }
    dlog('RspBut', `keyDown slot=${slot} action="${actionStr}"`);

    // Record user action to timeline (OpenClaw mode only)
    if (currentAgentType === 'openclaw') {
      const actionLabel = resolveActionLabel(actionStr);
      if (actionLabel) {
        timelineStore.addEntry({ ts: Date.now(), type: 'user_action', raw: actionLabel });
      }
    }

    if (actionStr === 'expand_options') {
      // Handled by plugin.ts enterExpandedMode — delegate via handleExpandedAction
      handleExpandedAction(actionStr, bridge);
    } else if (actionStr === 'interrupt') {
      bridge.send({ type: 'interrupt' });
    } else if (actionStr.startsWith('respond:')) {
      bridge.send({ type: 'respond', value: actionStr.split(':')[1] });
    } else if (actionStr.startsWith('select_option:')) {
      bridge.send({
        type: 'select_option',
        index: parseInt(actionStr.split(':')[1], 10),
      });
    } else if (actionStr.startsWith('switch_mode:')) {
      bridge.send({
        type: 'switch_mode',
        mode: actionStr.split(':')[1] as 'plan' | 'acceptEdits' | 'default',
      });
    } else if (actionStr === 'action:model_switch') {
      void handleModelSwitch();
    } else if (actionStr.startsWith('open:')) {
      const target = actionStr.substring('open:'.length);
      if (target === 'gateway_web') {
        void openOrFocusBrowserTab(`http://127.0.0.1:${OPENCLAW_GATEWAY_PORT}`).catch((e) => {
          derr('RspBut', `open gateway_web failed: ${e}`);
        });
      }
    } else if (actionStr.startsWith('command:')) {
      const text = actionStr.substring('command:'.length);
      if (text === 'summarize') {
        bridge.send({ type: 'send_prompt', text: 'Summarize current progress concisely' });
      } else {
        bridge.send({ type: 'send_prompt', text });
      }
    }
  }

  /** Auto-assign next available slot index for buttons without explicit slotIndex */
  private autoAssignSlot(): number {
    const used = new Set(actionSlots.values());
    for (let i = 0; i < DEFAULT_IDLE_SETTINGS.length; i++) {
      if (!used.has(i)) return i;
    }
    return DEFAULT_IDLE_SETTINGS.length - 1; // cap at last slot (CLEAR)
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    actionSlots.delete(ev.action.id);
    userSettingsMap.delete(ev.action.id);
  }
}

/** Map action string to a human-readable label for timeline recording */
function resolveActionLabel(actionStr: string): string | null {
  if (actionStr === 'command:continue') return '\u25B7 GO ON \u2014 Send continue prompt';
  if (actionStr === 'command:summarize') return '\u25B7 SUMMARIZE \u2014 Request progress summary';
  if (actionStr === 'open:gateway_web') return '\u25B7 GATEWAY \u2014 Open web UI';
  if (actionStr === 'action:model_switch') {
    const cur = getDefaultModelName() || '?';
    const catalog = getModelCatalog();
    const next = catalog ? getNextModelName(catalog, cur) : '?';
    return `\u25B7 MODEL \u2014 Switch model: ${cur} \u2192 ${next}`;
  }
  if (actionStr.startsWith('respond:')) {
    const val = actionStr.split(':')[1];
    if (val === 'y') return '\u25B7 ALLOW \u2014 Approve tool execution';
    if (val === 'n') return '\u25B7 DENY \u2014 Deny tool execution';
  }
  return null;
}

/** Get next available model name in circular order (skips unavailable) */
function getNextModelName(catalog: import('@agentdeck/shared').ModelCatalogEntry[], current: string): string {
  if (catalog.length === 0) return '';
  const idx = catalog.findIndex(m => m.name === current);
  const start = idx >= 0 ? idx : 0;
  for (let i = 1; i <= catalog.length; i++) {
    const candidate = catalog[(start + i) % catalog.length];
    if (candidate.available && candidate.name !== current) return candidate.name;
  }
  return '';
}

/** Handle model switch: CLI first, prompt fallback */
async function handleModelSwitch(): Promise<void> {
  const catalog = getModelCatalog();
  if (!catalog || catalog.filter(m => m.available).length < 2) {
    dlog('RspBut', 'model_switch: no catalog or <2 available models');
    return;
  }
  const current = getDefaultModelName();
  const next = getNextModelName(catalog, current);
  if (!next || next === current) return;

  modelSwitching = true;
  refreshAllButtons();

  try {
    const bin = resolveOpenClawBin();
    execFileSync(bin, ['models', 'set', next], {
      timeout: 5000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, PATH: augmentedPath() },
    });
    dlog('RspBut', `model_switch CLI success: ${current} -> ${next}`);
  } catch (e) {
    dlog('RspBut', `model_switch CLI failed, using prompt fallback: ${e}`);
    bridge.send({ type: 'send_prompt', text: `use model ${next}` });
  }

  // Refresh catalog immediately to pick up the change
  fetchStandaloneModelCatalog();

  // Update timeline entry with result
  const lastIdx = timelineStore.findLastIndex('user_action');
  if (lastIdx >= 0) {
    timelineStore.updateEntryRaw(lastIdx, `\u25B7 MODEL \u2014 Switched: ${current} \u2192 ${next}`);
  }

  modelSwitching = false;
  refreshAllButtons();
}
