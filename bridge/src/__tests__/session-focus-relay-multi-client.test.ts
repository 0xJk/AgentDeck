/**
 * Multi-client focus isolation test for SessionFocusRelay.
 *
 * Tests two failure modes of the original single-global-focus design:
 *   1. Race: 100ms setTimeout may fire before the session bridge WS is OPEN
 *   2. Cross-client interference: client B's focus_session steals client A's
 *      focus, so A's subsequent session_command lands on the wrong bridge.
 *
 * The test operates SessionFocusRelay directly (not via daemon-server) so it
 * stays isolated to the relay class and its registry mock — no full daemon
 * bootstrap needed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import type { AddressInfo } from 'net';
import { SessionFocusRelay } from '../session-focus-relay.js';

// ─── Fake session bridge server ───────────────────────────────────────────────

interface FakeBridge {
  port: number;
  received: string[];
  wss: WebSocketServer;
  close: () => Promise<void>;
}

async function startFakeBridge(): Promise<FakeBridge> {
  return new Promise((resolve) => {
    const received: string[] = [];
    const wss = new WebSocketServer({ port: 0 });
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        received.push(data.toString());
      });
    });
    wss.on('listening', () => {
      const port = (wss.address() as AddressInfo).port;
      resolve({
        port,
        received,
        wss,
        close: () =>
          new Promise<void>((res) => {
            for (const c of wss.clients) c.terminate();
            wss.close(() => res());
          }),
      });
    });
  });
}

// ─── Registry mock ────────────────────────────────────────────────────────────

/**
 * session-focus-relay.ts calls listActive() from session-registry at the
 * module level via a static import.  We mock the whole module so the relay
 * uses our in-memory registry instead of touching ~/.agentdeck/sessions.json.
 */
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

/** Create a unique Symbol acting as a per-WS-connection client token */
type ClientToken = symbol;

function makeToken(label: string): ClientToken {
  return Symbol(label);
}

/**
 * Wait for a condition with a timeout, polling every 10ms.
 * Throws if condition never becomes true within timeoutMs.
 */
async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SessionFocusRelay multi-client isolation', () => {
  let bridgeA: FakeBridge;
  let bridgeB: FakeBridge;

  beforeEach(async () => {
    // Clear mock registry
    mockSessions.length = 0;

    // Start two fake session bridges on ephemeral ports
    bridgeA = await startFakeBridge();
    bridgeB = await startFakeBridge();

    // Register them in the mock registry
    mockSessions.push(
      { id: 'session-A', port: bridgeA.port, projectName: 'ProjectA', pid: process.pid, startedAt: new Date().toISOString() },
      { id: 'session-B', port: bridgeB.port, projectName: 'ProjectB', pid: process.pid, startedAt: new Date().toISOString() },
    );
  });

  afterEach(async () => {
    await bridgeA.close();
    await bridgeB.close();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Failure mode 1 — RACE: setTimeout(100) vs WS open
  //
  // With the current code, focus() starts an async WS connect, then
  // setTimeout(..., 100) fires routeCommand.  If the bridge is slow to
  // accept the connection (which is common in test environments or under
  // load), routeCommand sees ws.readyState !== OPEN and silently drops
  // the command.
  //
  // After the fix, routeCommand(token, cmd) awaits an openPromise so it
  // never loses the command regardless of WS open timing.
  // ──────────────────────────────────────────────────────────────────────────
  it('FAIL (race): command is silently dropped when WS is not yet OPEN at 100ms', async () => {
    const relay = new SessionFocusRelay();
    const tokenA = makeToken('clientA');

    // Use new API: focus(token, sessionId)
    relay.focus(tokenA, 'session-A');

    // Immediately try to route — WS definitely not OPEN yet (connect is async)
    const result = await relay.routeCommand(tokenA, { type: 'respond', value: 'y' } as any);

    // After fix: result should be true and bridgeA.received should have 1 message.
    // Against old code this assertion FAILS because routeCommand returns false when
    // the WS isn't open yet.
    expect(result).toBe(true);
    await waitUntil(() => bridgeA.received.length > 0);
    expect(bridgeA.received).toHaveLength(1);
    expect(JSON.parse(bridgeA.received[0])).toMatchObject({ type: 'respond', value: 'y' });

    relay.stop();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Failure mode 2 — CROSS-CLIENT INTERFERENCE
  //
  // With the current single-focus design:
  //   - clientA focuses session-A
  //   - clientB focuses session-B (steals the global focus)
  //   - clientA's session_command routes to the currently focused session
  //     which is now session-B → command lands on the WRONG bridge.
  //
  // After the fix each token maintains its own focus entry, so clientA's
  // command always lands on session-A and clientB's on session-B.
  // ──────────────────────────────────────────────────────────────────────────
  it('FAIL (cross-client): clientB focus steals clientA focus under old design', async () => {
    const relay = new SessionFocusRelay();
    const tokenA = makeToken('clientA');
    const tokenB = makeToken('clientB');

    // clientA focuses session-A, clientB focuses session-B
    relay.focus(tokenA, 'session-A');
    relay.focus(tokenB, 'session-B');

    // Wait for both WS connections to open
    await waitUntil(() => bridgeA.wss.clients.size > 0 && bridgeB.wss.clients.size > 0);

    // Route commands from each client
    const resultA = await relay.routeCommand(tokenA, { type: 'respond', value: 'y' } as any);
    const resultB = await relay.routeCommand(tokenB, { type: 'respond', value: 'n' } as any);

    expect(resultA).toBe(true);
    expect(resultB).toBe(true);

    // Wait for messages to arrive
    await waitUntil(() => bridgeA.received.length > 0 && bridgeB.received.length > 0);

    // clientA's "y" must land on bridgeA (session-A), NOT bridgeB
    expect(bridgeA.received).toHaveLength(1);
    expect(JSON.parse(bridgeA.received[0])).toMatchObject({ type: 'respond', value: 'y' });

    // clientB's "n" must land on bridgeB (session-B), NOT bridgeA
    expect(bridgeB.received).toHaveLength(1);
    expect(JSON.parse(bridgeB.received[0])).toMatchObject({ type: 'respond', value: 'n' });

    relay.stop();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Refcount: two clients focusing the same session share one WS connection.
  // When the first client unfocuses the refcount drops to 1; when the second
  // unfocuses the WS should close (refcount → 0).
  // ──────────────────────────────────────────────────────────────────────────
  it('refcount: two clients on same session share one WS; closes when both unfocus', async () => {
    const relay = new SessionFocusRelay();
    const tokenA = makeToken('clientA');
    const tokenB = makeToken('clientB');

    relay.focus(tokenA, 'session-A');
    relay.focus(tokenB, 'session-A'); // same session

    // Wait for the shared WS to open
    await waitUntil(() => bridgeA.wss.clients.size > 0);

    // Only 1 WS connection from relay to bridgeA despite 2 clients
    expect(bridgeA.wss.clients.size).toBe(1);

    // unfocus clientA — refcount drops to 1, WS must stay open
    relay.unfocus(tokenA);
    await new Promise((r) => setTimeout(r, 50));
    expect(bridgeA.wss.clients.size).toBe(1);

    // unfocus clientB — refcount drops to 0, WS must close
    relay.unfocus(tokenB);
    await waitUntil(() => bridgeA.wss.clients.size === 0);
    expect(bridgeA.wss.clients.size).toBe(0);

    relay.stop();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Implicit focus: session_command without prior focus_session should
  // transparently focus the target session for that client then route.
  // ──────────────────────────────────────────────────────────────────────────
  it('implicit focus: routeCommand with sessionId arg focuses then routes', async () => {
    const relay = new SessionFocusRelay();
    const tokenA = makeToken('clientA');

    // No prior focus call — pass sessionId as part of the command or override
    // The new API supports: routeCommand(token, cmd, sessionId?) for implicit focus.
    const result = await relay.routeCommand(tokenA, { type: 'respond', value: 'hello' } as any, 'session-A');

    expect(result).toBe(true);
    await waitUntil(() => bridgeA.received.length > 0);
    expect(JSON.parse(bridgeA.received[0])).toMatchObject({ type: 'respond', value: 'hello' });

    relay.stop();
  });
});
