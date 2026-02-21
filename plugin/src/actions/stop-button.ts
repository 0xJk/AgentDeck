import streamDeck, {
  action,
  SingletonAction,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from '@elgato/streamdeck';
import { State, PromptOption } from '@agentdeck/shared';
import { BridgeClient } from '../bridge-client.js';
import { renderButton, svgToDataUrl } from '../renderers/button-renderer.js';
import { ButtonConfig } from '../layout-manager.js';
import { handleExpandedAction } from '../expanded-actions.js';
import { dlog } from '../log.js';

let bridge: BridgeClient;
let currentState = State.DISCONNECTED;
let overrideConfig: ButtonConfig | null = null;

const actionIds: string[] = [];

export function initStopButton(b: BridgeClient): void {
  bridge = b;
}

export function updateStopState(state: State, options?: PromptOption[]): void {
  currentState = state;
  // overrideConfig is set externally by overrideStopButton
  refreshStopButtons();
}

export function overrideStopButton(config: ButtonConfig | null): void {
  overrideConfig = config;
  refreshStopButtons();
}

function isAwaiting(state: State): boolean {
  return (
    state === State.AWAITING_PERMISSION ||
    state === State.AWAITING_OPTION ||
    state === State.AWAITING_DIFF
  );
}

function getButtonConfig(state: State): ButtonConfig {
  if (state === State.PROCESSING) {
    return { title: 'STOP', color: '#cc0000', textColor: '#ffffff', enabled: true };
  }
  if (isAwaiting(state)) {
    return { title: 'ESC', color: '#b45309', textColor: '#ffffff', enabled: true };
  }
  if (state === State.IDLE) {
    // Dim ESC — clears typed text if any, harmless if empty
    return { title: 'ESC', color: '#3d2607', textColor: '#a0855a', enabled: true };
  }
  return { title: 'STOP', color: '#3a1111', textColor: '#666666', enabled: false };
}

function refreshStopButtons(): void {
  const cfg = overrideConfig ?? getButtonConfig(currentState);
  const svg = renderButton(cfg);
  const dataUrl = svgToDataUrl(svg);

  for (const id of actionIds) {
    const act = streamDeck.actions.getActionById(id);
    if (act) {
      void act.setImage(dataUrl).catch(() => {});
    }
  }
}

@action({ UUID: 'bound.serendipity.agentdeck.stop-button' })
export class StopButtonAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    if (!actionIds.includes(ev.action.id)) {
      actionIds.push(ev.action.id);
    }
    const cfg = overrideConfig ?? getButtonConfig(currentState);
    const svg = renderButton(cfg);
    await ev.action.setImage(svgToDataUrl(svg));
  }

  override async onKeyDown(_ev: KeyDownEvent): Promise<void> {
    if (overrideConfig?.action) {
      dlog('StpBut', `keyDown: override action="${overrideConfig.action}"`);
      handleExpandedAction(overrideConfig.action, bridge);
      return;
    }
    if (isAwaiting(currentState) || currentState === State.IDLE) {
      dlog('StpBut', `keyDown: escape (state=${currentState})`);
      bridge.send({ type: 'escape' });
    } else {
      dlog('StpBut', `keyDown: interrupt (state=${currentState})`);
      bridge.send({ type: 'interrupt' });
    }
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    const idx = actionIds.indexOf(ev.action.id);
    if (idx !== -1) actionIds.splice(idx, 1);
  }
}
