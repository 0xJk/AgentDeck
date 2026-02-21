import streamDeck, {
  action,
  SingletonAction,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from '@elgato/streamdeck';
import { State, PermissionMode } from '@agentdeck/shared';
import { BridgeClient } from '../bridge-client.js';
import { renderButton, svgToDataUrl } from '../renderers/button-renderer.js';
import { ButtonConfig } from '../layout-manager.js';
import { handleExpandedAction } from '../expanded-actions.js';
import { dlog } from '../log.js';

const SIZE = 144;

let bridge: BridgeClient;
let currentState = State.DISCONNECTED;
let currentMode = PermissionMode.DEFAULT;
let overrideConfig: ButtonConfig | null = null;

const actionIds: string[] = [];

export function initModeButton(b: BridgeClient): void {
  bridge = b;
}

export function updateModeButton(state: State, mode: PermissionMode): void {
  currentState = state;
  currentMode = mode;
  refreshAll();
}

export function overrideModeButton(config: ButtonConfig | null): void {
  overrideConfig = config;
  refreshAll();
}

function refreshAll(): void {
  const dataUrl = overrideConfig
    ? svgToDataUrl(renderButton(overrideConfig))
    : svgToDataUrl(renderModeSvg());
  for (const id of actionIds) {
    const act = streamDeck.actions.getActionById(id);
    if (act) {
      void act.setImage(dataUrl).catch(() => {});
    }
  }
}

function renderModeSvg(): string {
  const { label, bgColor, textColor, dimmed } = getModeVisual();
  const opacity = dimmed ? '0.4' : '1';

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
    `<rect width="${SIZE}" height="${SIZE}" rx="12" fill="${bgColor}"/>`,
    `<text x="72" y="56" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" font-weight="600" fill="${textColor}" opacity="0.6">MODE</text>`,
    `<text x="72" y="96" text-anchor="middle" font-family="Arial,sans-serif" font-size="28" font-weight="bold" fill="${textColor}" opacity="${opacity}">${escXml(label)}</text>`,
    `</svg>`,
  ].join('');
}

function getModeVisual(): {
  label: string;
  bgColor: string;
  textColor: string;
  dimmed: boolean;
} {
  const dimmed = currentState !== State.IDLE;

  switch (currentMode) {
    case PermissionMode.PLAN:
      return {
        label: 'PLAN',
        bgColor: dimmed ? '#1a1a1a' : '#7c3aed',
        textColor: '#ffffff',
        dimmed,
      };
    case PermissionMode.ACCEPT_EDITS:
      return {
        label: 'ACCEPT',
        bgColor: dimmed ? '#1a1a1a' : '#2563eb',
        textColor: '#ffffff',
        dimmed,
      };
    default:
      return {
        label: 'DEFAULT',
        bgColor: dimmed ? '#1a1a1a' : '#2a2a2a',
        textColor: dimmed ? '#666666' : '#ffffff',
        dimmed,
      };
  }
}

function escXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

@action({ UUID: 'bound.serendipity.agentdeck.mode-button' })
export class ModeButtonAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    if (!actionIds.includes(ev.action.id)) {
      actionIds.push(ev.action.id);
    }
    const svg = renderModeSvg();
    await ev.action.setImage(svgToDataUrl(svg));
  }

  override async onKeyDown(_ev: KeyDownEvent): Promise<void> {
    if (overrideConfig?.action) {
      dlog('ModeBut', `keyDown: override action="${overrideConfig.action}"`);
      handleExpandedAction(overrideConfig.action, bridge);
      return;
    }
    if (currentState !== State.IDLE) return;
    dlog('ModeBut', `keyDown: switch_mode (current=${currentMode})`);
    bridge.send({ type: 'switch_mode' });
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    const idx = actionIds.indexOf(ev.action.id);
    if (idx !== -1) actionIds.splice(idx, 1);
  }
}
