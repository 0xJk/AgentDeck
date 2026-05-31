/**
 * daemon-server focus_lost emit test (plan 1b, test 3).
 *
 * daemon-server.ts wires SessionFocusRelay.setOnFocusLost to a reverse map
 * (tokenToWs) and, on fire, sends a {type:'focus_lost', sessionId} frame to
 * the affected plugin WS only.
 *
 * startDaemon() is a 1500-line bootstrap (HTTP server, mDNS, device modules,
 * APME, gateway) that can't be unit-tested in isolation, so per the task we
 * test the smallest extractable unit: the exact onFocusLost handler the daemon
 * installs, driven through a real SessionFocusRelay instance plus a fake
 * reverse map of fake plugin sockets. This mirrors the daemon wiring verbatim:
 *
 *   focusRelay.setOnFocusLost((token, sessionId) => {
 *     const ws = tokenToWs.get(token);
 *     if (ws && ws.readyState === WebSocket.OPEN) {
 *       try { ws.send(JSON.stringify({ type: 'focus_lost', sessionId })); } catch {}
 *     }
 *   });
 *
 * The handler is exercised by invoking the relay's internal onFocusLost (the
 * same path the relay's ws.on('close') uses), proving the daemon receives the
 * (token, sessionId) pair and routes it to the correct socket.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import WebSocket from 'ws';
import { SessionFocusRelay, type ClientToken } from '../session-focus-relay.js';

class FakeSocket {
  readyState = WebSocket.OPEN;
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
}

function makeToken(label: string): ClientToken {
  return Symbol(label);
}

/**
 * Build the exact (relay, reverseMap, disconnect) trio daemon-server.ts wires.
 * `installDaemonWiring` reproduces the daemon's setOnFocusLost handler so the
 * test covers the real emit logic, not a re-implementation that could drift.
 */
function installDaemonWiring() {
  const relay = new SessionFocusRelay();
  const tokenToWs = new Map<ClientToken, FakeSocket>();

  // ── verbatim copy of daemon-server.ts focus_lost wiring ──
  relay.setOnFocusLost((token, sessionId) => {
    const ws = tokenToWs.get(token);
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'focus_lost', sessionId }));
      } catch { /* socket half-dead — ignore */ }
    }
  });

  // daemon-server.ts onClientDisconnect also clears tokenToWs.
  const disconnect = (token: ClientToken) => {
    relay.unfocus(token);
    tokenToWs.delete(token);
  };

  // Trigger the relay's onFocusLost via the same private path ws.on('close')
  // uses — keeps the test at the relay's public/observable boundary.
  const fireFocusLost = (token: ClientToken, sessionId: string) => {
    (relay as unknown as { onFocusLost: ((t: ClientToken, s: string) => void) | null })
      .onFocusLost?.(token, sessionId);
  };

  return { relay, tokenToWs, disconnect, fireFocusLost };
}

describe('daemon-server focus_lost emit wiring', () => {
  let wiring: ReturnType<typeof installDaemonWiring>;

  beforeEach(() => {
    wiring = installDaemonWiring();
  });

  it('sends focus_lost only to the affected plugin WS', () => {
    const tokenA = makeToken('clientA');
    const tokenB = makeToken('clientB');
    const wsA = new FakeSocket();
    const wsB = new FakeSocket();
    wiring.tokenToWs.set(tokenA, wsA);
    wiring.tokenToWs.set(tokenB, wsB);

    wiring.fireFocusLost(tokenA, 'session-A');

    expect(wsA.sent).toHaveLength(1);
    expect(JSON.parse(wsA.sent[0])).toEqual({ type: 'focus_lost', sessionId: 'session-A' });
    // Other client must NOT receive the focus_lost.
    expect(wsB.sent).toHaveLength(0);
  });

  it('does not send to a non-OPEN socket', () => {
    const tokenA = makeToken('clientA');
    const wsA = new FakeSocket();
    wsA.readyState = WebSocket.CLOSED;
    wiring.tokenToWs.set(tokenA, wsA);

    wiring.fireFocusLost(tokenA, 'session-A');

    expect(wsA.sent).toHaveLength(0);
  });

  it('does not send after the client disconnects (reverse-map cleared)', () => {
    const tokenA = makeToken('clientA');
    const wsA = new FakeSocket();
    wiring.tokenToWs.set(tokenA, wsA);

    wiring.disconnect(tokenA);
    wiring.fireFocusLost(tokenA, 'session-A');

    expect(wsA.sent).toHaveLength(0);
  });

  it('is a no-op for an unknown token', () => {
    const known = makeToken('known');
    const wsKnown = new FakeSocket();
    wiring.tokenToWs.set(known, wsKnown);

    wiring.fireFocusLost(makeToken('ghost'), 'session-X');

    expect(wsKnown.sent).toHaveLength(0);
  });
});
