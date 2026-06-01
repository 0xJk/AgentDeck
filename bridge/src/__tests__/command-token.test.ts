/**
 * resolveCommandToken — the focus-relay client token for an incoming command.
 *
 * Regression guard for plan 002 #5: non-WS dispatch (D200H HID / agent stdin
 * pipe, sender == null) MUST resolve to a single stable token. The old code
 * minted `Symbol('dispatch')` on every call, so each session_command implicitly
 * focused a brand-new token → a focus-relay entry + session-WS refcount that was
 * never released (no onClientDisconnect for a non-WS sender). Repeated dispatch
 * leaked unbounded entries and pinned session WS connections open forever.
 */
import { describe, it, expect } from 'vitest';
import WebSocket from 'ws';
import { resolveCommandToken, DISPATCH_TOKEN } from '../command-token.js';
import type { ClientToken } from '../session-focus-relay.js';

describe('resolveCommandToken', () => {
  it('returns the stable DISPATCH_TOKEN for non-WS dispatch (sender == null)', () => {
    const clientTokens = new Map<WebSocket, ClientToken>();
    expect(resolveCommandToken(null, clientTokens)).toBe(DISPATCH_TOKEN);
  });

  it('returns the SAME token across repeated non-WS dispatches (no per-call mint)', () => {
    const clientTokens = new Map<WebSocket, ClientToken>();
    const first = resolveCommandToken(null, clientTokens);
    const second = resolveCommandToken(null, clientTokens);
    const third = resolveCommandToken(null, clientTokens);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('returns the per-connection token for a registered WS sender', () => {
    const ws = {} as WebSocket;
    const token: ClientToken = Symbol('plugin-client');
    const clientTokens = new Map<WebSocket, ClientToken>([[ws, token]]);
    expect(resolveCommandToken(ws, clientTokens)).toBe(token);
  });

  it('returns a stable fallback for an unregistered WS sender (still no per-call mint)', () => {
    const ws = {} as WebSocket;
    const clientTokens = new Map<WebSocket, ClientToken>();
    const a = resolveCommandToken(ws, clientTokens);
    const b = resolveCommandToken(ws, clientTokens);
    expect(a).toBe(b);
    // And it must not collide with the non-WS dispatch token.
    expect(a).not.toBe(DISPATCH_TOKEN);
  });
});
