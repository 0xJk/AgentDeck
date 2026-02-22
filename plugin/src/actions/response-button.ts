import streamDeck, {
  action,
  SingletonAction,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
  DidReceiveSettingsEvent,
} from '@elgato/streamdeck';
import { State, PromptOption } from '@agentdeck/shared';
import { BridgeClient } from '../bridge-client.js';
import { LayoutManager, ButtonConfig } from '../layout-manager.js';
import { renderButton, svgToDataUrl } from '../renderers/button-renderer.js';
import { handleExpandedAction } from '../expanded-actions.js';
import { isPickerActive, selectByButtonSlot, openPicker, setPickerButtonCallback } from '../project-picker.js';
import { dlog, derr } from '../log.js';

import type { JsonValue } from '@elgato/utils';

interface ResponseButtonSettings {
  [key: string]: JsonValue;
  label?: string;
  action?: string;
  disconnectedLabel?: string;
  disconnectedAction?: string;
}

const DEFAULT_IDLE_SETTINGS: ResponseButtonSettings[] = [
  { label: 'GO ON', action: 'continue', disconnectedLabel: 'START', disconnectedAction: 'sdc' },
  { label: 'REVIEW', action: '/review' },
  { label: 'COMMIT', action: '/commit' },
  { label: 'CLEAR', action: '/clear' },
];

/** Per-instance user-customised PI settings (only fields explicitly set by user) */
const userSettingsMap = new Map<string, ResponseButtonSettings>();

/** Compute effective settings for a button: slot defaults + user overrides (disconnected* always from defaults) */
function effectiveSettings(actionId: string): ResponseButtonSettings {
  const sortedIds = getSortedIds();
  const slot = sortedIds.indexOf(actionId);
  const defaults = (slot >= 0 && slot < DEFAULT_IDLE_SETTINGS.length) ? DEFAULT_IDLE_SETTINGS[slot] : {};
  const user = userSettingsMap.get(actionId);
  if (!user) return defaults;
  // User settings override label/action only; disconnected* always from slot defaults
  const { disconnectedLabel: _dl, disconnectedAction: _da, ...piOnly } = user;
  return { ...defaults, ...piOnly };
}

let bridge: BridgeClient;
let layoutManager: LayoutManager;
let currentState = State.DISCONNECTED;
let currentMode = 'default';
let currentOptions: PromptOption[] = [];

// Action ID → column coordinate for physical position sorting
const actionCoords = new Map<string, number>();

/** Return action IDs sorted by physical column position (left → right) */
function getSortedIds(): string[] {
  return [...actionCoords.keys()].sort((a, b) =>
    (actionCoords.get(a) ?? 99) - (actionCoords.get(b) ?? 99)
  );
}

export function initResponseButtons(
  b: BridgeClient,
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
): void {
  currentState = state;
  currentMode = mode;
  currentOptions = options;
  overrideConfigs = expandedConfigs ?? null;
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

function refreshAllButtons(): void {
  const sorted = getSortedIds();

  if (currentState === State.IDLE && !overrideConfigs) {
    // IDLE: use per-instance PI settings
    dlog('RspBut', `refresh IDLE: ids=${sorted.length}`);
    for (let i = 0; i < sorted.length; i++) {
      const s = effectiveSettings(sorted[i]);
      applyButtonConfig(sorted[i], idleButtonConfig(s), i);
    }
    return;
  }

  if (overrideConfigs) {
    // Expanded mode: use externally provided configs for slots 3-5
    dlog('RspBut', `refresh expanded: ids=${sorted.length} configs=${overrideConfigs.length}`);
    for (let i = 0; i < sorted.length; i++) {
      if (i < overrideConfigs.length) {
        applyButtonConfig(sorted[i], overrideConfigs[i], i);
      } else {
        applyButtonConfig(sorted[i], { title: '', color: '#1a1a1a', textColor: '#444444', enabled: false }, i);
      }
    }
    return;
  }

  // DISCONNECTED: show shell-command buttons active, others dimmed
  if (currentState === State.DISCONNECTED) {
    dlog('RspBut', `refresh DISCONNECTED: ids=${sorted.length}`);
    for (let i = 0; i < sorted.length; i++) {
      const s = effectiveSettings(sorted[i]);
      applyButtonConfig(sorted[i], disconnectedButtonConfig(s), i);
    }
    return;
  }

  // PROCESSING: show idle labels dimmed
  if (currentState === State.PROCESSING) {
    dlog('RspBut', `refresh PROCESSING: ids=${sorted.length} (dimmed idle labels)`);
    for (let i = 0; i < sorted.length; i++) {
      const s = effectiveSettings(sorted[i]);
      applyButtonConfig(sorted[i], dimButtonConfig(s), i);
    }
    return;
  }

  // Interactive states: delegate to layoutManager
  const buttons = layoutManager.getButtonLayout(
    currentState,
    currentMode as any,
    currentOptions,
  );

  dlog('RspBut', `refresh: state=${currentState} ids=${sorted.length} buttons=[${buttons.map(b => b.title ? `"${b.badge ? b.badge + ' ' : ''}${b.title}${b.subtitle ? ' | ' + b.subtitle : ''}"` : 'DIM').join(', ')}]`);
  for (let i = 0; i < sorted.length; i++) {
    if (i < buttons.length) {
      applyButtonConfig(sorted[i], buttons[i], i);
    } else {
      applyButtonConfig(sorted[i], { title: '', color: '#1a1a1a', textColor: '#444444', enabled: false }, i);
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
    actionCoords.set(ev.action.id, ev.action.coordinates?.column ?? 99);
    const sorted = getSortedIds();
    const slot = sorted.indexOf(ev.action.id);
    dlog('RspBut', `onWillAppear: id=${ev.action.id} col=${ev.action.coordinates?.column} slot=${slot} total=${sorted.length}`);

    // Only cache user-customised PI settings; defaults are computed dynamically from slot position
    const settings = (ev.payload?.settings ?? {}) as ResponseButtonSettings;
    if (settings.label || settings.action) {
      userSettingsMap.set(ev.action.id, settings);
    }
    // Refresh ALL buttons so every slot gets the correct number after sort
    refreshAllButtons();
    // Sync PI defaults for ALL buttons (slot positions may have shifted)
    this.syncAllPIDefaults();
  }

  /** Persist slot defaults to PI for buttons without user-customised settings */
  private syncAllPIDefaults(): void {
    const sorted = getSortedIds();
    for (let i = 0; i < sorted.length; i++) {
      const id = sorted[i];
      if (userSettingsMap.has(id)) continue;  // User has custom settings
      if (i >= DEFAULT_IDLE_SETTINGS.length) continue;
      const defaults = DEFAULT_IDLE_SETTINGS[i];
      const act = streamDeck.actions.getActionById(id);
      if (act) {
        void act.setSettings(defaults).catch(() => {});
      }
    }
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<ResponseButtonSettings>): void {
    const settings = ev.payload.settings;
    dlog('RspBut', `onDidReceiveSettings: id=${ev.action.id} label=${settings.label} action=${settings.action}`);
    if (settings.label || settings.action) {
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
    if (slot < 0) return;

    let actionStr: string | undefined;

    if (currentState === State.DISCONNECTED) {
      if (isPickerActive()) {
        // Picker active: button selects project
        selectByButtonSlot(slot);
        return;
      }
      const s = effectiveSettings(ev.action.id);
      const cmd = s.disconnectedAction?.trim();
      if (!cmd) {
        dlog('RspBut', `keyDown slot=${slot} DISCONNECTED no cmd`);
        return;
      }
      dlog('RspBut', `keyDown slot=${slot} → openPicker`);
      void openPicker();
      return;
    }

    if (overrideConfigs) {
      // Expanded mode: use override configs
      const config = slot < overrideConfigs.length ? overrideConfigs[slot] : undefined;
      if (!config?.enabled || !config.action) return;
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
      );
      if (slot >= buttons.length) return;
      const config = buttons[slot];
      if (!config.enabled || !config.action) return;
      actionStr = config.action;
    }

    if (!actionStr) return;
    dlog('RspBut', `keyDown slot=${slot} action="${actionStr}"`);

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
    } else if (actionStr.startsWith('command:')) {
      bridge.send({ type: 'send_prompt', text: actionStr.substring('command:'.length) });
    }
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    actionCoords.delete(ev.action.id);
    userSettingsMap.delete(ev.action.id);
  }
}
