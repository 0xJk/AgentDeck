import streamDeck, {
  action,
  SingletonAction,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from '@elgato/streamdeck';
import { State } from '@streamdeck-claude/shared';
import { BridgeClient } from '../bridge-client.js';
import { renderButton, svgToDataUrl } from '../renderers/button-renderer.js';
import { dlog } from '../log.js';

let bridge: BridgeClient;
let currentState = State.DISCONNECTED;

const actionIds: string[] = [];

export function initStopButton(b: BridgeClient): void {
  bridge = b;
}

export function updateStopState(state: State): void {
  currentState = state;
  refreshStopButtons();
}

function refreshStopButtons(): void {
  const isActive =
    currentState === State.PROCESSING ||
    currentState === State.AWAITING_PERMISSION ||
    currentState === State.AWAITING_OPTION ||
    currentState === State.AWAITING_DIFF;

  const svg = renderButton({
    title: 'STOP',
    color: isActive ? '#cc0000' : '#3a1111',
    textColor: isActive ? '#ffffff' : '#666666',
    enabled: isActive,
  });
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
    const isActive =
      currentState === State.PROCESSING ||
      currentState === State.AWAITING_PERMISSION ||
      currentState === State.AWAITING_OPTION ||
      currentState === State.AWAITING_DIFF;

    const svg = renderButton({
      title: 'STOP',
      color: isActive ? '#cc0000' : '#3a1111',
      textColor: isActive ? '#ffffff' : '#666666',
      enabled: isActive,
    });
    await ev.action.setImage(svgToDataUrl(svg));
  }

  override async onKeyDown(_ev: KeyDownEvent): Promise<void> {
    dlog('StpBut', `keyDown: interrupt (state=${currentState})`);
    bridge.send({ type: 'interrupt' });
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    const idx = actionIds.indexOf(ev.action.id);
    if (idx !== -1) actionIds.splice(idx, 1);
  }
}
