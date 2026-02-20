import streamDeck, {
  action,
  SingletonAction,
  DialRotateEvent,
  DialDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from '@elgato/streamdeck';
import { State } from '@streamdeck-claude/shared';
import { BridgeClient } from '../bridge-client.js';
import { dlog } from '../log.js';

const COMMANDS = ['/compact', '/status', '/cost', '/clear', '/model'];

let bridge: BridgeClient;
let currentState = State.DISCONNECTED;
let selectedIndex = 0;

export function initCommandDial(b: BridgeClient): void {
  bridge = b;
}

export function updateCommandDialState(state: State): void {
  currentState = state;
  refreshCommandDials();
}

function refreshCommandDials(): void {
  const feedback = getCommandFeedback();
  for (const id of CommandDialAction.actionIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) {
      void dial.setFeedback(feedback).catch(() => {});
    }
  }
}

function getCommandFeedback(): Record<string, unknown> {
  const cmd = COMMANDS[selectedIndex];
  const enabled = currentState === State.IDLE;

  return {
    title: 'CMD',
    value: cmd,
    indicator: {
      value: Math.round(((selectedIndex + 1) / COMMANDS.length) * 100),
      bar_fill_c: enabled ? '#6366f1' : '#333333',
    },
  };
}

@action({ UUID: 'bound.serendipity.agentdeck.command-dial' })
export class CommandDialAction extends SingletonAction {
  static actionIds: string[] = [];

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    if (!CommandDialAction.actionIds.includes(ev.action.id)) {
      CommandDialAction.actionIds.push(ev.action.id);
    }
    await (ev.action as any).setFeedback(getCommandFeedback());
  }

  override async onDialRotate(ev: DialRotateEvent): Promise<void> {
    if (ev.payload.ticks > 0) {
      selectedIndex = (selectedIndex + 1) % COMMANDS.length;
    } else {
      selectedIndex = (selectedIndex - 1 + COMMANDS.length) % COMMANDS.length;
    }
    dlog('CmdDial', `rotate: ${COMMANDS[selectedIndex]}`);
    refreshCommandDials();
  }

  override async onDialDown(_ev: DialDownEvent): Promise<void> {
    if (currentState !== State.IDLE) return;
    const cmd = COMMANDS[selectedIndex];
    dlog('CmdDial', `push: execute "${cmd}"`);
    bridge.send({ type: 'send_prompt', text: cmd });
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    const idx = CommandDialAction.actionIds.indexOf(ev.action.id);
    if (idx !== -1) {
      CommandDialAction.actionIds.splice(idx, 1);
    }
  }
}
