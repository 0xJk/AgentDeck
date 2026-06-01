/**
 * Focus-relay client token resolution for incoming plugin commands.
 *
 * Each plugin WS connection owns a unique ClientToken (minted in
 * onClientConnect, released in onClientDisconnect). Commands injected from a
 * non-WS source — the D200H HID bridge and the agent stdin pipe via
 * WsServer.dispatchCommand() — have no sender, so they need a token too.
 *
 * That token MUST be a single stable symbol. Minting a fresh `Symbol('dispatch')`
 * per call (the old behaviour) meant every routed session_command implicitly
 * focused a brand-new token in SessionFocusRelay, acquiring/refcounting a
 * session WS that was never released — a non-WS sender has no onClientDisconnect
 * to unfocus it. Repeated dispatch leaked unbounded focus entries and pinned
 * session connections open. See plan 002 #5.
 */
import type WebSocket from 'ws';
import type { ClientToken } from './session-focus-relay.js';

/** Stable token for all non-WS command dispatch (D200H HID / agent stdin pipe). */
export const DISPATCH_TOKEN: ClientToken = Symbol('dispatch');

/** Stable fallback for a WS sender with no registered token (should not happen). */
export const UNKNOWN_TOKEN: ClientToken = Symbol('unknown');

/**
 * Resolve the focus-relay client token for an incoming command.
 * - WS sender → that connection's per-client token (or the stable UNKNOWN_TOKEN).
 * - Non-WS dispatch (sender == null) → the stable DISPATCH_TOKEN.
 */
export function resolveCommandToken(
  sender: WebSocket | null,
  // Accepts a Map or WeakMap (daemon-server uses a WeakMap keyed by WS connection).
  clientTokens: { get(key: WebSocket): ClientToken | undefined },
): ClientToken {
  if (!sender) return DISPATCH_TOKEN;
  return clientTokens.get(sender) ?? UNKNOWN_TOKEN;
}
