/**
 * BridgeClient — port provider + backoff behavior.
 *
 * Uses real WebSocket servers to exercise the reconnect path. Time is not
 * mocked; tests rely on the backoff ladder starting at 1000ms but use short
 * waits and observe counters rather than precise timings.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { createServer, type Server } from 'http';

vi.mock('../log.js', () => ({
  dlog: vi.fn(),
  dinfo: vi.fn(),
  dwarn: vi.fn(),
  derr: vi.fn(),
  dtrace: vi.fn(),
}));

import { BridgeClient } from '../bridge-client.js';

interface TestServer {
  port: number;
  httpServer: Server;
  wss: WebSocketServer;
  close: () => Promise<void>;
}

async function createTestServer(): Promise<TestServer> {
  return new Promise((resolve) => {
    const httpServer = createServer();
    const wss = new WebSocketServer({ server: httpServer });
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        httpServer,
        wss,
        close: () => new Promise<void>((res) => {
          wss.clients.forEach((c) => c.close());
          wss.close();
          httpServer.close(() => res());
          setTimeout(res, 200);
        }),
      });
    });
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('BridgeClient — port provider', () => {
  let client: BridgeClient;

  afterEach(() => {
    if (client) client.disconnect();
  });

  it('skips connect when provider returns null', async () => {
    client = new BridgeClient();
    const provider = vi.fn().mockReturnValue(null);
    client.setPortProvider(provider);

    const connectedSpy = vi.fn();
    client.on('connected', connectedSpy);

    client.connect();

    // Give the event loop a tick for the first attempt.
    await wait(50);

    expect(provider).toHaveBeenCalled();
    expect(connectedSpy).not.toHaveBeenCalled();
    expect(client.isConnected()).toBe(false);
  });

  it('connects once provider returns a live port', async () => {
    const server = await createTestServer();
    try {
      client = new BridgeClient();
      // First call: daemon absent. Second: daemon appeared.
      let resolved: number | null = null;
      client.setPortProvider(() => resolved);

      const connectedSpy = vi.fn();
      client.on('connected', connectedSpy);

      client.connect();
      await wait(50);
      expect(connectedSpy).not.toHaveBeenCalled();

      // Simulate daemon appearing. Backoff starts at 1000ms so we need to
      // wait slightly longer than that for the next scheduled attempt.
      resolved = server.port;
      await wait(1200);

      expect(connectedSpy).toHaveBeenCalledTimes(1);
      expect(client.isConnected()).toBe(true);
      expect(client.getPort()).toBe(server.port);
    } finally {
      await server.close();
    }
  }, 10_000);

  it('rebinds to a new port when provider value changes', async () => {
    const first = await createTestServer();
    const second = await createTestServer();
    try {
      client = new BridgeClient();
      let active = first.port;
      client.setPortProvider(() => active);

      const connects: number[] = [];
      client.on('connected', () => connects.push(client.getPort()));

      client.connect();
      await wait(300);
      expect(client.isConnected()).toBe(true);
      expect(client.getPort()).toBe(first.port);

      // Kill the first server — client.close triggers scheduleReconnect.
      await first.close();
      active = second.port;

      // Wait long enough for at least one backoff tick (1000ms) + reconnect.
      await wait(1800);

      expect(client.isConnected()).toBe(true);
      expect(client.getPort()).toBe(second.port);
      expect(connects.length).toBeGreaterThanOrEqual(2);
      expect(connects[connects.length - 1]).toBe(second.port);
    } finally {
      await second.close();
    }
  }, 15_000);
});
