import streamDeck, {
  action,
  SingletonAction,
  DialRotateEvent,
  DialDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
  DidReceiveSettingsEvent,
} from '@elgato/streamdeck';
import { State } from '@agentdeck/shared';
import { BridgeClient } from '../bridge-client.js';
import { isEncoderTakeoverActive } from '../encoder-takeover.js';
import { handleTakeoverPush, handleTakeoverRotate } from './option-dial.js';
import { encoderRegistry } from '../encoder-registry.js';
import { dlog } from '../log.js';

import type { JsonValue } from '@elgato/utils';

interface CommandDialSettings {
  [key: string]: JsonValue;
  commandList?: string;
}

const DEFAULT_COMMANDS = ['/compact', '/status', '/usage', '/clear', '/model'];
let commands = [...DEFAULT_COMMANDS];

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
  if (isEncoderTakeoverActive()) return;
  const feedback = getCommandFeedback();
  for (const id of encoderRegistry.commandIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) {
      void dial.setFeedback(feedback).catch(() => {});
    }
  }
}

function getCommandFeedback(): Record<string, unknown> {
  const cmd = commands[selectedIndex];
  const enabled = currentState === State.IDLE;

  return {
    title: 'CMD',
    value: cmd,
    indicator: {
      value: Math.round(((selectedIndex + 1) / commands.length) * 100),
      bar_fill_c: enabled ? '#6366f1' : '#333333',
    },
  };
}

@action({ UUID: 'bound.serendipity.agentdeck.command-dial' })
export class CommandDialAction extends SingletonAction {
  static get actionIds(): string[] { return encoderRegistry.commandIds; }

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    if (!encoderRegistry.commandIds.includes(ev.action.id)) {
      encoderRegistry.commandIds.push(ev.action.id);
    }
    // Load saved settings; persist defaults if empty so PI shows actual values
    const settings = (ev.payload?.settings ?? {}) as CommandDialSettings;
    if (settings.commandList?.trim()) {
      const parsed = settings.commandList.split('\n').map(s => s.trim()).filter(Boolean);
      if (parsed.length > 0) {
        commands = parsed;
        if (selectedIndex >= commands.length) selectedIndex = 0;
      }
    } else {
      const defaults: CommandDialSettings = { commandList: DEFAULT_COMMANDS.join('\n') };
      void ev.action.setSettings(defaults).catch(() => {});
    }
    await (ev.action as any).setFeedback(getCommandFeedback());
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<CommandDialSettings>): void {
    const list = ev.payload.settings.commandList;
    dlog('CmdDial', `onDidReceiveSettings: commandList=${list}`);
    if (list?.trim()) {
      const parsed = list.split('\n').map(s => s.trim()).filter(Boolean);
      if (parsed.length > 0) {
        commands = parsed;
        if (selectedIndex >= commands.length) selectedIndex = 0;
        refreshCommandDials();
      }
    }
  }

  override async onDialRotate(ev: DialRotateEvent): Promise<void> {
    if (isEncoderTakeoverActive()) { handleTakeoverRotate(ev.payload.ticks); return; }
    if (ev.payload.ticks > 0) {
      selectedIndex = (selectedIndex + 1) % commands.length;
    } else {
      selectedIndex = (selectedIndex - 1 + commands.length) % commands.length;
    }
    dlog('CmdDial', `rotate: ${commands[selectedIndex]}`);
    refreshCommandDials();
  }

  override async onDialDown(_ev: DialDownEvent): Promise<void> {
    if (isEncoderTakeoverActive()) { handleTakeoverPush(); return; }
    if (currentState !== State.IDLE) return;
    const cmd = commands[selectedIndex];
    dlog('CmdDial', `push: execute "${cmd}"`);
    bridge.send({ type: 'send_prompt', text: cmd });
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    const idx = encoderRegistry.commandIds.indexOf(ev.action.id);
    if (idx !== -1) {
      encoderRegistry.commandIds.splice(idx, 1);
    }
  }
}
