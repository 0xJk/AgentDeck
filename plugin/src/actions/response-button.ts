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
import { dlog } from '../log.js';

import type { JsonValue } from '@elgato/utils';

interface ResponseButtonSettings {
  [key: string]: JsonValue;
  label?: string;
  action?: string;
}

const DEFAULT_IDLE_SETTINGS: ResponseButtonSettings[] = [
  { label: 'GO ON', action: 'continue' },
  { label: 'REVIEW', action: '/review' },
  { label: 'COMMIT', action: '/commit' },
  { label: 'CLEAR', action: '/clear' },
];

/** Per-instance IDLE settings cache */
const idleSettingsMap = new Map<string, ResponseButtonSettings>();

let bridge: BridgeClient;
let layoutManager: LayoutManager;
let currentState = State.DISCONNECTED;
let currentMode = 'default';
let currentOptions: PromptOption[] = [];

// Action IDs in arrival order (stable across refreshes — slot numbers shown on buttons)
const actionIds: string[] = [];

export function initResponseButtons(
  b: BridgeClient,
  lm: LayoutManager,
): void {
  bridge = b;
  layoutManager = lm;
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

function refreshAllButtons(): void {
  if (currentState === State.IDLE && !overrideConfigs) {
    // IDLE: use per-instance PI settings
    dlog('RspBut', `refresh IDLE: ids=${actionIds.length}`);
    for (let i = 0; i < actionIds.length; i++) {
      const s = idleSettingsMap.get(actionIds[i]) ?? DEFAULT_IDLE_SETTINGS[i] ?? {};
      applyButtonConfig(actionIds[i], idleButtonConfig(s), i);
    }
    return;
  }

  if (overrideConfigs) {
    // Expanded mode: use externally provided configs for slots 3-5
    dlog('RspBut', `refresh expanded: ids=${actionIds.length} configs=${overrideConfigs.length}`);
    for (let i = 0; i < actionIds.length; i++) {
      if (i < overrideConfigs.length) {
        applyButtonConfig(actionIds[i], overrideConfigs[i], i);
      } else {
        applyButtonConfig(actionIds[i], { title: '', color: '#1a1a1a', textColor: '#444444', enabled: false }, i);
      }
    }
    return;
  }

  // DISCONNECTED / PROCESSING: show idle labels dimmed
  if (currentState === State.DISCONNECTED || currentState === State.PROCESSING) {
    dlog('RspBut', `refresh ${currentState}: ids=${actionIds.length} (dimmed idle labels)`);
    for (let i = 0; i < actionIds.length; i++) {
      const s = idleSettingsMap.get(actionIds[i]) ?? DEFAULT_IDLE_SETTINGS[i] ?? {};
      applyButtonConfig(actionIds[i], dimButtonConfig(s), i);
    }
    return;
  }

  // Interactive states: delegate to layoutManager
  const buttons = layoutManager.getButtonLayout(
    currentState,
    currentMode as any,
    currentOptions,
  );

  dlog('RspBut', `refresh: state=${currentState} ids=${actionIds.length} buttons=[${buttons.map(b => b.title ? `"${b.badge ? b.badge + ' ' : ''}${b.title}${b.subtitle ? ' | ' + b.subtitle : ''}"` : 'DIM').join(', ')}]`);
  for (let i = 0; i < actionIds.length; i++) {
    if (i < buttons.length) {
      applyButtonConfig(actionIds[i], buttons[i], i);
    } else {
      applyButtonConfig(actionIds[i], { title: '', color: '#1a1a1a', textColor: '#444444', enabled: false }, i);
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
    if (!actionIds.includes(ev.action.id)) {
      actionIds.push(ev.action.id);
    }
    const slot = actionIds.indexOf(ev.action.id);
    dlog('RspBut', `onWillAppear: id=${ev.action.id} slot=${slot} total=${actionIds.length}`);

    // Persist slot defaults if settings are empty, so PI shows actual values
    const settings = (ev.payload?.settings ?? {}) as ResponseButtonSettings;
    if (settings.label || settings.action) {
      idleSettingsMap.set(ev.action.id, settings);
    } else if (slot >= 0 && slot < DEFAULT_IDLE_SETTINGS.length) {
      const defaults = DEFAULT_IDLE_SETTINGS[slot];
      idleSettingsMap.set(ev.action.id, defaults);
      void ev.action.setSettings(defaults).catch(() => {});
    }

    const s = idleSettingsMap.get(ev.action.id) ?? DEFAULT_IDLE_SETTINGS[slot] ?? {};
    let config: ButtonConfig;

    if (currentState === State.IDLE) {
      config = idleButtonConfig(s);
    } else if (currentState === State.DISCONNECTED || currentState === State.PROCESSING) {
      config = dimButtonConfig(s);
    } else {
      const buttons = layoutManager.getButtonLayout(
        currentState,
        currentMode as any,
        currentOptions,
      );
      config = (slot >= 0 && slot < buttons.length)
        ? buttons[slot]
        : { title: '', color: '#1a1a1a', textColor: '#444444', enabled: false };
    }
    config.slotNumber = slot + 1;
    await ev.action.setImage(svgToDataUrl(renderButton(config)));
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<ResponseButtonSettings>): void {
    const settings = ev.payload.settings;
    dlog('RspBut', `onDidReceiveSettings: id=${ev.action.id} label=${settings.label} action=${settings.action}`);
    idleSettingsMap.set(ev.action.id, settings);
    // Refresh to reflect changes immediately if IDLE
    if (currentState === State.IDLE) {
      refreshAllButtons();
    }
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    const slot = actionIds.indexOf(ev.action.id);
    if (slot < 0) return;

    let actionStr: string | undefined;

    if (overrideConfigs) {
      // Expanded mode: use override configs
      const config = slot < overrideConfigs.length ? overrideConfigs[slot] : undefined;
      if (!config?.enabled || !config.action) return;
      actionStr = config.action;
    } else if (currentState === State.IDLE) {
      // Use per-instance PI settings for IDLE
      const s = idleSettingsMap.get(ev.action.id) ?? DEFAULT_IDLE_SETTINGS[slot] ?? {};
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
    const idx = actionIds.indexOf(ev.action.id);
    if (idx !== -1) {
      actionIds.splice(idx, 1);
    }
  }
}
