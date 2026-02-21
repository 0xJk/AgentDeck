import streamDeck, {
  action,
  SingletonAction,
  DialRotateEvent,
  DialDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from '@elgato/streamdeck';
import { State } from '@agentdeck/shared';
import { isEncoderTakeoverActive } from '../encoder-takeover.js';
import { handleTakeoverPush, handleTakeoverRotate } from './option-dial.js';
import { encoderRegistry } from '../encoder-registry.js';

let currentState = State.DISCONNECTED;

export function updateContextDialState(state: State): void {
  currentState = state;
  refreshContextDials();
}

function refreshContextDials(): void {
  if (isEncoderTakeoverActive()) return;
  const feedback = getContextFeedback();
  for (const id of encoderRegistry.contextIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) {
      void dial.setFeedback(feedback).catch(() => {});
    }
  }
}

function getContextFeedback(): Record<string, unknown> {
  const stateText =
    currentState === State.IDLE ? 'Ready'
    : currentState === State.PROCESSING ? 'Working...'
    : currentState === State.DISCONNECTED ? 'Offline'
    : '--';
  return {
    title: 'INFO',
    value: stateText,
    indicator: { value: 0 },
  };
}

@action({ UUID: 'bound.serendipity.agentdeck.context-dial' })
export class ContextDialAction extends SingletonAction {
  static get actionIds(): string[] { return encoderRegistry.contextIds; }

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    if (!encoderRegistry.contextIds.includes(ev.action.id)) {
      encoderRegistry.contextIds.push(ev.action.id);
    }
    await (ev.action as any).setFeedback(getContextFeedback());
  }

  override async onDialRotate(ev: DialRotateEvent): Promise<void> {
    if (isEncoderTakeoverActive()) { handleTakeoverRotate(ev.payload.ticks); return; }
  }

  override async onDialDown(_ev: DialDownEvent): Promise<void> {
    if (isEncoderTakeoverActive()) { handleTakeoverPush(); return; }
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    const idx = encoderRegistry.contextIds.indexOf(ev.action.id);
    if (idx !== -1) {
      encoderRegistry.contextIds.splice(idx, 1);
    }
  }
}
