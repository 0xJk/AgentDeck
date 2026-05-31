/**
 * focus_lost relay test (plan 1b, test 2).
 *
 * When a focused session's bridge WS closes, SessionFocusRelay must fire
 * onFocusLost exactly once per client that was focusing that session, with
 * the correct (token, sessionId).
 *
 * Operates SessionFocusRelay directly against a fake session bridge server —
 * same isolation pattern as session-focus-relay-multi-client.test.ts (mocked
 * registry, ephemeral ws server), no daemon bootstrap.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'net';
import { SessionFocusRelay, type ClientToken } from '../session-focus-relay.js';

// ─── Fake session bridge server ───────────────────────────────────────────────

interface FakeBridge {
  port: number;
  wss: WebSocketServer;
  /** Force-close all server-side sockets so the relay's client WS sees 'close'. */
  killClients: () => void;
  close: () => Promise<void>;
}

async function startFakeBridge(): Promise<FakeBridge> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 });
    wss.on('listening', () => {
      const port = (wss.address() as AddressInfo).port;
      resolve({
        port,
        wss,
        killClients: () => {
          for (const c of wss.clients) c.terminate();
        },
        close: () =>
          new Promise<void>((res) => {
            for (const c of wss.clients) c.terminate();
            wss.close(() => res());
          }),
      });
    });
  });
}

// ─── Registry mock (same pattern as multi-client test) ─────────────────────────

vi.mock('../session-registry.js', () => {
  const sessions: Array<{ id: string; port: number; agentType?: string; projectName: string; pid: number; startedAt: string }> = [];
  return {
    listActive: () => sessions,
    __sessions: sessions,
  };
});

import * as registry from '../session-registry.js';
const mockSessions = (registry as any).__sessions as Array<{ id: string; port: number; agentType?: string; projectName: string; pid: number; startedAt: string }>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeToken(label: string): ClientToken {
  return Symbol(label);
}

async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SessionFocusRelay focus_lost', () => {
  let bridgeA: FakeBridge;

  beforeEach(async () => {
    mockSessions.length = 0;
    bridgeA = await startFakeBridge();
    mockSessions.push(
      { id: 'session-A', port: bridgeA.port, projectName: 'ProjectA', pid: process.pid, startedAt: new Date().toISOString() },
    );
  });

  afterEach(async () => {
    await bridgeA.close();
  });

  it('fires onFocusLost once per client focusing a session when its WS closes', async () => {
    const relay = new SessionFocusRelay();
    const calls: Array<{ token: ClientToken; sessionId: string }> = [];
    relay.setOnFocusLost((token, sessionId) => {
      calls.push({ token, sessionId });
    });

    const tokenA = makeToken('clientA');
    const tokenB = makeToken('clientB');

    // Two clients focus the SAME session (shared, refcounted WS).
    relay.focus(tokenA, 'session-A');
    relay.focus(tokenB, 'session-A');

    // Wait for the single shared WS to actually connect.
    await waitUntil(() => bridgeA.wss.clients.size > 0);
    expect(bridgeA.wss.clients.size).toBe(1);

    // Session dies → server terminates the socket → relay WS sees 'close'.
    bridgeA.killClients();

    // onFocusLost must fire once per focused client.
    await waitUntil(() => calls.length >= 2);
    expect(calls).toHaveLength(2);

    // Each call carries the correct sessionId.
    expect(calls.every((c) => c.sessionId === 'session-A')).toBe(true);

    // Both tokens are represented exactly once (one fire per client).
    const tokens = calls.map((c) => c.token);
    expect(tokens).toContain(tokenA);
    expect(tokens).toContain(tokenB);

    relay.stop();
  });

  it('does not fire onFocusLost for clients focusing a different session', async () => {
    const relay = new SessionFocusRelay();
    const calls: Array<{ token: ClientToken; sessionId: string }> = [];
    relay.setOnFocusLost((token, sessionId) => {
      calls.push({ token, sessionId });
    });

    // Add a second, independent bridge/session.
    const bridgeB = await startFakeBridge();
    mockSessions.push(
      { id: 'session-B', port: bridgeB.port, projectName: 'ProjectB', pid: process.pid, startedAt: new Date().toISOString() },
    );

    const tokenA = makeToken('clientA');
    const tokenB = makeToken('clientB');
    relay.focus(tokenA, 'session-A');
    relay.focus(tokenB, 'session-B');

    await waitUntil(() => bridgeA.wss.clients.size > 0 && bridgeB.wss.clients.size > 0);

    // Only session-A dies.
    bridgeA.killClients();

    await waitUntil(() => calls.length >= 1);
    // Give any erroneous extra fire a chance to land.
    await new Promise((r) => setTimeout(r, 50));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ token: tokenA, sessionId: 'session-A' });

    relay.stop();
    await bridgeB.close();
  });
});
