import streamDeck, {
  action,
  SingletonAction,
  DialRotateEvent,
  DialDownEvent,
  DialUpEvent,
  WillAppearEvent,
  WillDisappearEvent,
  DidReceiveSettingsEvent,
  TouchTapEvent,
} from '@elgato/streamdeck';
import { State } from '@agentdeck/shared';
import { isEncoderTakeoverActive } from '../encoder-takeover.js';
import { handleTakeoverPush, handleTakeoverRotate } from './option-dial.js';
import { encoderRegistry } from '../encoder-registry.js';
import { createModes, modeDots, type UtilityMode } from '../utility-modes/index.js';
import { dlog, dinfo, dwarn } from '../log.js';

import type { JsonValue } from '@elgato/utils';

interface UtilityDialSettings {
  [key: string]: JsonValue;
  enabledModes?: string | string[];
}

const DEFAULT_MODES = ['volume'];

/** Normalize enabledModes (string or string[]) to comma-separated string. */
function normalizeEnabledModes(val: string | string[] | undefined): string {
  if (Array.isArray(val)) return val.length > 0 ? val.join(',') : DEFAULT_MODES.join(',');
  if (typeof val === 'string' && val.trim()) return val;
  return DEFAULT_MODES.join(',');
}

const DEFAULT_LAYOUT = 'layouts/utility-layout.json';

const LONG_PRESS_MS = 500;

let currentState = State.DISCONNECTED;
let modes: UtilityMode[] = [];
let activeIndex = 0;
let settings: UtilityDialSettings = {};
let currentLayout = DEFAULT_LAYOUT;
let dialDownTime = 0;

function rebuildModes(): void {
  // Deactivate all existing modes (full cleanup — stops timer etc.)
  for (const m of modes) m.onDeactivate?.();

  modes = createModes(normalizeEnabledModes(settings.enabledModes), {
    refresh: refreshUtilityDials,
  });
  activeIndex = 0;
  dinfo('UtilDial', `rebuildModes: ${modes.length} modes [${modes.map(m => m.id).join(',')}]`);
  if (modes.length > 0) {
    // Activate first mode, then refresh LCD when system values are fetched
    const first = modes[0];
    if (first.onActivate) {
      void first.onActivate().then(() => refreshUtilityDials()).catch((e) => {
        dwarn('UtilDial', `onActivate error: ${e}`);
      });
    }
  }
}

export function initUtilityDial(): void {
  dinfo('UtilDial', 'initUtilityDial called');
  rebuildModes();
}

export function updateUtilityDialState(state: State): void {
  currentState = state;
  // After encoder takeover exit, layout was changed — force re-apply on next refresh
  currentLayout = '';
  refreshUtilityDials();
}

export function refreshUtilityDials(): void {
  if (isEncoderTakeoverActive()) return;
  if (modes.length === 0) return;

  const mode = modes[activeIndex];
  const targetLayout = mode.layout || DEFAULT_LAYOUT;

  // Switch layout when mode changes (e.g. media ↔ volume)
  if (targetLayout !== currentLayout) {
    currentLayout = targetLayout;
    for (const id of encoderRegistry.utilityIds) {
      const dial = streamDeck.actions.getActionById(id) as any;
      if (dial) void dial.setFeedbackLayout(targetLayout).catch(() => {});
    }
  }

  const feedback = mode.getFeedback();
  const dots = modeDots(activeIndex, modes.length);

  // Generic payload: wrap primitives in { value }, pass objects through
  const payload: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(feedback)) {
    if (val === null || val === undefined) continue;
    if (typeof val === 'object') {
      payload[key] = val;
    } else {
      payload[key] = { value: val };
    }
  }
  payload['mode-dots'] = { value: dots };

  for (const id of encoderRegistry.utilityIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) void dial.setFeedback(payload).catch(() => {});
  }
}

@action({ UUID: 'bound.serendipity.agentdeck.utility-dial' })
export class UtilityDialAction extends SingletonAction {
  static get actionIds(): string[] { return encoderRegistry.utilityIds; }

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    dinfo('UtilDial', `onWillAppear: id=${ev.action.id} controller=${ev.payload.controller}`);
    if (!encoderRegistry.utilityIds.includes(ev.action.id)) {
      encoderRegistry.utilityIds.push(ev.action.id);
    }

    // Load settings
    const s = (ev.payload?.settings ?? {}) as UtilityDialSettings;
    if (s.enabledModes) {
      // Migrate legacy comma-string to array so PI checkbox-list shows correctly
      if (typeof s.enabledModes === 'string') {
        s.enabledModes = s.enabledModes.split(',').map(x => x.trim()).filter(Boolean);
        void ev.action.setSettings(s as Record<string, JsonValue>).catch(() => {});
      }
      settings = s;
    } else {
      // Persist defaults so PI checkbox-list shows them checked
      settings = { enabledModes: [...DEFAULT_MODES] };
      void ev.action.setSettings(settings as Record<string, JsonValue>).catch(() => {});
    }
    rebuildModes();
    refreshUtilityDials();
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<UtilityDialSettings>): void {
    dlog('UtilDial', `onDidReceiveSettings: ${JSON.stringify(ev.payload.settings)}`);
    settings = ev.payload.settings;
    rebuildModes();
    refreshUtilityDials();
  }

  override async onTouchTap(ev: TouchTapEvent): Promise<void> {
    dlog('UtilDial', `onTouchTap: takeover=${isEncoderTakeoverActive()} modes=${modes.length} hold=${ev.payload.hold}`);
    if (isEncoderTakeoverActive()) return;
    if (modes.length <= 1) return;

    // Don't call onDeactivate — modes survive mode-switch.
    // Timer keeps its interval running; onActivate handles resume if needed.
    activeIndex = (activeIndex + 1) % modes.length;

    // Activate new mode (reads system state)
    const next = modes[activeIndex];
    dlog('UtilDial', `touch: mode=${next.id} idx=${activeIndex}`);

    if (next.onActivate) {
      void next.onActivate().then(() => refreshUtilityDials()).catch((e) => {
        dwarn('UtilDial', `onActivate error: ${e}`);
      });
    }
    // Immediate refresh with local state (optimistic)
    refreshUtilityDials();
  }

  override async onDialRotate(ev: DialRotateEvent): Promise<void> {
    dlog('UtilDial', `onDialRotate: takeover=${isEncoderTakeoverActive()} modes=${modes.length} ticks=${ev.payload.ticks}`);
    if (isEncoderTakeoverActive()) { handleTakeoverRotate(ev.payload.ticks); return; }
    if (modes.length === 0) return;

    await modes[activeIndex].onRotate(ev.payload.ticks);
    dlog('UtilDial', `rotate done: mode=${modes[activeIndex].id}`);
    refreshUtilityDials();
  }

  override async onDialDown(ev: DialDownEvent): Promise<void> {
    dlog('UtilDial', `onDialDown: takeover=${isEncoderTakeoverActive()} modes=${modes.length}`);
    if (isEncoderTakeoverActive()) { handleTakeoverPush(); return; }
    dialDownTime = Date.now();
  }

  override async onDialUp(_ev: DialUpEvent): Promise<void> {
    if (isEncoderTakeoverActive()) return;
    if (modes.length === 0) return;

    const mode = modes[activeIndex];
    const elapsed = Date.now() - dialDownTime;

    if (elapsed >= LONG_PRESS_MS && mode.onLongPush) {
      dlog('UtilDial', `longPush (${elapsed}ms): mode=${mode.id}`);
      await mode.onLongPush();
    } else {
      dlog('UtilDial', `push (${elapsed}ms): mode=${mode.id}`);
      await mode.onPush();
    }
    refreshUtilityDials();
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    dinfo('UtilDial', `onWillDisappear: id=${ev.action.id}`);
    const idx = encoderRegistry.utilityIds.indexOf(ev.action.id);
    if (idx !== -1) {
      encoderRegistry.utilityIds.splice(idx, 1);
    }
    // Full cleanup — deactivate all modes (stops timers etc.)
    for (const m of modes) m.onDeactivate?.();
  }
}
