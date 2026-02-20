import streamDeck, {
  action,
  SingletonAction,
  DialRotateEvent,
  DialDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from '@elgato/streamdeck';
import { State, PromptOption } from '@streamdeck-claude/shared';
import { BridgeClient } from '../bridge-client.js';
import { dlog } from '../log.js';

let bridge: BridgeClient;
let currentState = State.DISCONNECTED;
let currentOptions: PromptOption[] = [];
let selectedIndex = 0;

// Permission mode options for dial navigation
const PERMISSION_OPTIONS: PromptOption[] = [
  { index: 0, label: 'Yes', shortcut: 'y' },
  { index: 1, label: 'No', shortcut: 'n' },
  { index: 2, label: 'Always', shortcut: 'a' },
];
let permissionIndex = 0;

export function initOptionDial(b: BridgeClient): void {
  bridge = b;
}

export function updateOptionDialState(
  state: State,
  options: PromptOption[],
): void {
  currentState = state;
  currentOptions = options;
  if (state === State.AWAITING_OPTION) {
    selectedIndex = 0;
    dlog('OptDial', `options received: ${options.length} items`);
  }
  if (state === State.AWAITING_PERMISSION) {
    permissionIndex = 0;
  }
  refreshOptionDials();
}

function refreshOptionDials(): void {
  for (const id of OptionDialAction.actionIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (!dial) continue;

    if (currentState === State.AWAITING_OPTION && currentOptions.length > 0) {
      const opt = currentOptions[selectedIndex];
      void dial
        .setFeedback({
          title: `OPT ${selectedIndex + 1}/${currentOptions.length}`,
          value: truncate(opt?.label ?? '', 30),
          indicator: {
            value: Math.round(
              ((selectedIndex + 1) / currentOptions.length) * 100,
            ),
            bar_fill_c: '#2563eb',
          },
        })
        .catch(() => {});
    } else if (currentState === State.AWAITING_PERMISSION) {
      const opt = PERMISSION_OPTIONS[permissionIndex];
      void dial
        .setFeedback({
          title: 'PERMISSION',
          value: opt?.label ?? '',
          indicator: {
            value: Math.round(
              ((permissionIndex + 1) / PERMISSION_OPTIONS.length) * 100,
            ),
            bar_fill_c: '#f87171',
          },
        })
        .catch(() => {});
    } else {
      const idleText =
        currentState === State.IDLE ? 'Ready'
        : currentState === State.PROCESSING ? 'Working...'
        : currentState === State.DISCONNECTED ? 'Offline'
        : '--';
      void dial
        .setFeedback({
          title: 'OPTIONS',
          value: idleText,
          indicator: { value: 0, bar_fill_c: '#2563eb' },
        })
        .catch(() => {});
    }
  }
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.substring(0, max - 1) + '\u2026' : str;
}

@action({ UUID: 'bound.serendipity.agentdeck.option-dial' })
export class OptionDialAction extends SingletonAction {
  static actionIds: string[] = [];

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    if (!OptionDialAction.actionIds.includes(ev.action.id)) {
      OptionDialAction.actionIds.push(ev.action.id);
    }
    await (ev.action as any).setFeedback({
      title: 'OPTIONS',
      value: '--',
      indicator: { value: 0, bar_fill_c: '#2563eb' },
    });
  }

  override async onDialRotate(ev: DialRotateEvent): Promise<void> {
    if (currentState === State.AWAITING_OPTION && currentOptions.length > 0) {
      if (ev.payload.ticks > 0) {
        selectedIndex = Math.min(selectedIndex + 1, currentOptions.length - 1);
      } else {
        selectedIndex = Math.max(selectedIndex - 1, 0);
      }
      dlog('OptDial', `rotate: idx=${selectedIndex}/${currentOptions.length} "${currentOptions[selectedIndex]?.label}"`);
      refreshOptionDials();
    } else if (currentState === State.AWAITING_PERMISSION) {
      if (ev.payload.ticks > 0) {
        permissionIndex = (permissionIndex + 1) % PERMISSION_OPTIONS.length;
      } else {
        permissionIndex = (permissionIndex - 1 + PERMISSION_OPTIONS.length) % PERMISSION_OPTIONS.length;
      }
      refreshOptionDials();
    }
  }

  override async onDialDown(_ev: DialDownEvent): Promise<void> {
    if (currentState === State.AWAITING_OPTION && currentOptions.length > 0) {
      dlog('OptDial', `push: select_option idx=${selectedIndex} "${currentOptions[selectedIndex]?.label}"`);
      bridge.send({ type: 'select_option', index: selectedIndex });
    } else if (currentState === State.AWAITING_PERMISSION) {
      const opt = PERMISSION_OPTIONS[permissionIndex];
      if (opt?.shortcut) {
        dlog('OptDial', `push: respond "${opt.label}" (${opt.shortcut})`);
        bridge.send({ type: 'respond', value: opt.shortcut });
      }
    }
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    const idx = OptionDialAction.actionIds.indexOf(ev.action.id);
    if (idx !== -1) {
      OptionDialAction.actionIds.splice(idx, 1);
    }
  }
}
