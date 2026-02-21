import streamDeck, {
  action,
  SingletonAction,
  DialRotateEvent,
  DialDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from '@elgato/streamdeck';
import { State, PromptOption } from '@agentdeck/shared';
import { BridgeClient } from '../bridge-client.js';
import { isEncoderTakeoverActive, refreshEncoderTakeover } from '../encoder-takeover.js';
import { encoderRegistry } from '../encoder-registry.js';
import { dlog } from '../log.js';

let bridge: BridgeClient;
let currentState = State.DISCONNECTED;
let currentOptions: PromptOption[] = [];
let selectedIndex = 0;
let navigable = false;
let currentQuestion: string | undefined;
let currentTool: string | undefined;
let rotateDebounceTimer: ReturnType<typeof setTimeout> | null = null;

export function initOptionDial(b: BridgeClient): void {
  bridge = b;
}

export function updateOptionDialState(
  state: State,
  options: PromptOption[],
  question?: string,
  tool?: string,
  nav?: boolean,
  cursorIdx?: number,
): void {
  currentState = state;
  currentOptions = options;
  currentQuestion = question;
  currentTool = tool;
  navigable = nav ?? false;

  if (isInteractive() && options.length > 0) {
    // Sync cursor from PTY if provided, otherwise reset to 0 on new prompt
    if (cursorIdx !== undefined && cursorIdx >= 0 && cursorIdx < options.length) {
      selectedIndex = cursorIdx;
    } else if (state !== currentState || options !== currentOptions) {
      // New options set — only reset if we're entering a new prompt
      selectedIndex = 0;
    }
    dlog('OptDial', `options received: ${options.length} items, nav=${navigable}, cursor=${selectedIndex}`);
  }
  refreshOptionDials();
}

/** Get the current selected index (used by plugin.ts for takeover refresh) */
export function getSelectedIndex(): number {
  return selectedIndex;
}

function isInteractive(): boolean {
  return (
    currentState === State.AWAITING_OPTION ||
    currentState === State.AWAITING_PERMISSION ||
    currentState === State.AWAITING_DIFF
  );
}

function refreshOptionDials(): void {
  // When takeover is active, delegate to encoder-takeover for all 3 encoders
  if (isEncoderTakeoverActive()) {
    refreshEncoderTakeover(
      currentState,
      currentOptions,
      selectedIndex,
      currentQuestion,
      currentTool,
    );
    return;
  }

  // Fallback: $B1 layout on E1 only
  for (const id of encoderRegistry.optionIds) {
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
    } else if (
      (currentState === State.AWAITING_PERMISSION || currentState === State.AWAITING_DIFF) &&
      currentOptions.length > 0
    ) {
      const opt = currentOptions[selectedIndex];
      void dial
        .setFeedback({
          title: currentState === State.AWAITING_DIFF ? 'DIFF' : 'PERMISSION',
          value: truncate(opt?.label ?? '', 30),
          indicator: {
            value: Math.round(
              ((selectedIndex + 1) / currentOptions.length) * 100,
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

/**
 * Takeover delegation: any encoder can confirm the current selection.
 * Called by other dials when they receive a push during encoder takeover.
 */
export function handleTakeoverPush(): void {
  if (currentState === State.AWAITING_OPTION && currentOptions.length > 0) {
    dlog('OptDial', `takeoverPush: select_option idx=${selectedIndex} "${currentOptions[selectedIndex]?.label}"`);
    bridge.send({ type: 'select_option', index: selectedIndex });
  } else if (
    (currentState === State.AWAITING_PERMISSION || currentState === State.AWAITING_DIFF) &&
    currentOptions.length > 0
  ) {
    const opt = currentOptions[selectedIndex];
    if (opt?.shortcut) {
      dlog('OptDial', `takeoverPush: respond "${opt.label}" (${opt.shortcut})`);
      bridge.send({ type: 'respond', value: opt.shortcut });
    }
  }
}

/**
 * Takeover delegation: any encoder can navigate options.
 * Called by other dials when they receive rotation during encoder takeover.
 */
export function handleTakeoverRotate(ticks: number): void {
  if (!isInteractive() || currentOptions.length === 0) return;

  if (ticks > 0) {
    selectedIndex = (selectedIndex + 1) % currentOptions.length;
  } else {
    selectedIndex = (selectedIndex - 1 + currentOptions.length) % currentOptions.length;
  }

  if (navigable) {
    const dir = ticks > 0 ? 'down' : 'up';
    bridge.send({ type: 'navigate_option', direction: dir });
  }

  dlog('OptDial', `takeoverRotate: idx=${selectedIndex}/${currentOptions.length}`);
  if (rotateDebounceTimer) clearTimeout(rotateDebounceTimer);
  rotateDebounceTimer = setTimeout(() => {
    rotateDebounceTimer = null;
    refreshOptionDials();
  }, 16);
}

@action({ UUID: 'bound.serendipity.agentdeck.option-dial' })
export class OptionDialAction extends SingletonAction {
  static get actionIds(): string[] { return encoderRegistry.optionIds; }

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    if (!encoderRegistry.optionIds.includes(ev.action.id)) {
      encoderRegistry.optionIds.push(ev.action.id);
    }
    await (ev.action as any).setFeedback({
      title: 'OPTIONS',
      value: '--',
      indicator: { value: 0, bar_fill_c: '#2563eb' },
    });
  }

  override async onDialRotate(ev: DialRotateEvent): Promise<void> {
    if (!isInteractive() || currentOptions.length === 0) return;

    // Update local index immediately for responsive LCD
    if (ev.payload.ticks > 0) {
      selectedIndex = (selectedIndex + 1) % currentOptions.length;
    } else {
      selectedIndex = (selectedIndex - 1 + currentOptions.length) % currentOptions.length;
    }

    // Navigable prompt: also send arrow key to terminal
    if (navigable) {
      const dir = ev.payload.ticks > 0 ? 'down' : 'up';
      bridge.send({ type: 'navigate_option', direction: dir });
    }

    dlog('OptDial', `rotate: idx=${selectedIndex}/${currentOptions.length} "${currentOptions[selectedIndex]?.label}" nav=${navigable}`);

    // Debounced LCD refresh (16ms) to avoid excessive setFeedback during fast rotation
    if (rotateDebounceTimer) clearTimeout(rotateDebounceTimer);
    rotateDebounceTimer = setTimeout(() => {
      rotateDebounceTimer = null;
      refreshOptionDials();
    }, 16);
  }

  override async onDialDown(_ev: DialDownEvent): Promise<void> {
    if (currentState === State.AWAITING_OPTION && currentOptions.length > 0) {
      dlog('OptDial', `push: select_option idx=${selectedIndex} "${currentOptions[selectedIndex]?.label}"`);
      bridge.send({ type: 'select_option', index: selectedIndex });
    } else if (
      (currentState === State.AWAITING_PERMISSION || currentState === State.AWAITING_DIFF) &&
      currentOptions.length > 0
    ) {
      const opt = currentOptions[selectedIndex];
      if (opt?.shortcut) {
        dlog('OptDial', `push: respond "${opt.label}" (${opt.shortcut})`);
        bridge.send({ type: 'respond', value: opt.shortcut });
      }
    }
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    const idx = encoderRegistry.optionIds.indexOf(ev.action.id);
    if (idx !== -1) {
      encoderRegistry.optionIds.splice(idx, 1);
    }
  }
}
