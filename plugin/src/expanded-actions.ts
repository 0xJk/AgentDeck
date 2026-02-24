import type { AgentLink } from './agent-link.js';

let expandCallback: (() => void) | null = null;

/**
 * Register the expand mode callback (called from plugin.ts to avoid circular deps).
 */
export function setExpandCallback(cb: () => void): void {
  expandCallback = cb;
}

/**
 * Common handler for actions from expanded mode and override buttons.
 * Called by buttons that are temporarily overridden to show option actions.
 */
export function handleExpandedAction(actionStr: string, bridge: AgentLink): void {
  if (actionStr === 'expand_options') {
    expandCallback?.();
    return;
  }
  if (actionStr.startsWith('select_option:')) {
    bridge.send({
      type: 'select_option',
      index: parseInt(actionStr.split(':')[1], 10),
    });
  } else if (actionStr.startsWith('respond:')) {
    bridge.send({ type: 'respond', value: actionStr.split(':')[1] });
  }
}
