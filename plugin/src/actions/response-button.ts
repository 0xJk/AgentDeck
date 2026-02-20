import streamDeck, {
  action,
  SingletonAction,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from '@elgato/streamdeck';
import { State, PromptOption } from '@streamdeck-claude/shared';
import { BridgeClient } from '../bridge-client.js';
import { LayoutManager, ButtonConfig } from '../layout-manager.js';
import { renderButton, svgToDataUrl } from '../renderers/button-renderer.js';
import { dlog } from '../log.js';

let bridge: BridgeClient;
let layoutManager: LayoutManager;
let currentState = State.DISCONNECTED;
let currentMode = 'default';
let currentOptions: PromptOption[] = [];

export function initResponseButtons(
  b: BridgeClient,
  lm: LayoutManager,
): void {
  bridge = b;
  layoutManager = lm;
}

export function updateResponseState(
  state: State,
  mode: string,
  options: PromptOption[],
): void {
  currentState = state;
  currentMode = mode;
  currentOptions = options;
  refreshAllButtons();
}

function refreshAllButtons(): void {
  const buttons = layoutManager.getButtonLayout(
    currentState,
    currentMode as any,
    currentOptions,
  );

  const contexts = ResponseButtonAction.getContexts();
  for (const ctx of contexts) {
    const slot = ctx.slot ?? 0;
    if (slot >= 0 && slot < buttons.length) {
      applyButtonConfig(ctx.context, buttons[slot]);
    }
  }
}

function applyButtonConfig(context: string, config: ButtonConfig): void {
  const svg = renderButton(config);
  const dataUrl = svgToDataUrl(svg);
  const act = streamDeck.actions.getActionById(context);
  if (act) {
    void act.setImage(dataUrl).catch(() => {});
    void act.setTitle(config.title).catch(() => {});
  }
}

type ResponseSettings = {
  slot?: number;
};

interface ContextEntry {
  context: string;
  slot: number;
}

@action({ UUID: 'bound.serendipity.agentdeck.response-button' })
export class ResponseButtonAction extends SingletonAction {
  private static contexts: ContextEntry[] = [];

  static getContexts(): ContextEntry[] {
    return ResponseButtonAction.contexts;
  }

  override async onWillAppear(
    ev: WillAppearEvent,
  ): Promise<void> {
    const settings = (ev.payload.settings ?? {}) as Record<string, any>;
    const slot = settings.slot ?? ResponseButtonAction.contexts.length;

    // Store slot in settings if not set
    if (settings.slot === undefined) {
      await ev.action.setSettings({ slot } as any);
    }

    ResponseButtonAction.contexts.push({
      context: ev.action.id,
      slot,
    });

    // Render initial state
    const buttons = layoutManager.getButtonLayout(
      currentState,
      currentMode as any,
      currentOptions,
    );
    if (slot >= 0 && slot < buttons.length) {
      const svg = renderButton(buttons[slot]);
      await ev.action.setImage(svgToDataUrl(svg));
    }
  }

  override async onKeyDown(
    ev: KeyDownEvent,
  ): Promise<void> {
    const slot = (ev.payload.settings as any)?.slot ?? 0;
    const buttons = layoutManager.getButtonLayout(
      currentState,
      currentMode as any,
      currentOptions,
    );

    if (slot < 0 || slot >= buttons.length) return;

    const config = buttons[slot];
    if (!config.enabled || !config.action) return;

    const actionStr = config.action;
    dlog('RspBut', `keyDown slot=${slot} action="${actionStr}"`);

    if (actionStr === 'interrupt') {
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
    } else if (actionStr.startsWith('template:')) {
      bridge.send({
        type: 'send_prompt',
        text: `__template:${actionStr.split(':')[1]}`,
      });
    }
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    const idx = ResponseButtonAction.contexts.findIndex(
      (c) => c.context === ev.action.id,
    );
    if (idx !== -1) {
      ResponseButtonAction.contexts.splice(idx, 1);
    }
  }
}
