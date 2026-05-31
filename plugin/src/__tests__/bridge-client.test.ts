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

// ---- Plan 001 §2a: host/port/token constructor + close-code ----

describe('BridgeClient — host/port/token URL (test 5)', () => {
  let client: BridgeClient;

  afterEach(() => {
    if (client) client.disconnect();
  });

  // The URL is computed lazily in attemptConnect via buildUrl(). We assert the
  // private helper rather than spin a real server per case.
  function buildUrl(c: BridgeClient): string {
    return (c as unknown as { buildUrl(): string }).buildUrl();
  }

  it('builds ws://host:port?token with encodeURIComponent on the token', () => {
    client = new BridgeClient({ host: '192.168.1.5', port: 9120, token: 'a b/c?d&e' });
    expect(buildUrl(client)).toBe(
      `ws://192.168.1.5:9120?token=${encodeURIComponent('a b/c?d&e')}`,
    );
  });

  it('defaults host to localhost', () => {
    client = new BridgeClient({ port: 9120 });
    expect(buildUrl(client)).toBe('ws://localhost:9120');
  });

  it('omits the token query param for localhost with empty token', () => {
    client = new BridgeClient({ host: 'localhost', port: 9120, token: '' });
    expect(buildUrl(client)).toBe('ws://localhost:9120');
  });

  it('omits the token query param for 127.0.0.1 with empty token', () => {
    client = new BridgeClient({ host: '127.0.0.1', port: 9120 });
    expect(buildUrl(client)).toBe('ws://127.0.0.1:9120');
  });

  it('still appends a token for localhost when a token is provided', () => {
    client = new BridgeClient({ host: 'localhost', port: 9120, token: 'tok' });
    expect(buildUrl(client)).toBe('ws://localhost:9120?token=tok');
  });
});

describe("BridgeClient — close event carries {code, reason} (test 6)", () => {
  let client: BridgeClient;

  afterEach(() => {
    if (client) client.disconnect();
  });

  it("emits 'close' with the WS close code and reason", async () => {
    const server = await createTestServer();
    try {
      server.wss.on('connection', (ws) => {
        // Close with a custom code + reason once the client connects.
        setTimeout(() => ws.close(4002, 'bye'), 20);
      });

      client = new BridgeClient({ host: '127.0.0.1', port: server.port });
      const closes: Array<{ code: number; reason: string }> = [];
      client.on('close', (info: { code: number; reason: string }) => closes.push(info));

      client.connect();
      await wait(400);

      expect(closes.length).toBeGreaterThanOrEqual(1);
      expect(closes[0].code).toBe(4002);
      expect(closes[0].reason).toBe('bye');
    } finally {
      await server.close();
    }
  }, 10_000);
});

describe('BridgeClient — close code 4001 stops reconnect (test 7)', () => {
  let client: BridgeClient;

  afterEach(() => {
    if (client) client.disconnect();
  });

  it('does NOT schedule a reconnect when the daemon closes with 4001', async () => {
    const server = await createTestServer();
    try {
      server.wss.on('connection', (ws) => {
        setTimeout(() => ws.close(4001, 'Unauthorized'), 20);
      });

      client = new BridgeClient({ host: '127.0.0.1', port: server.port });
      const scheduleSpy = vi.spyOn(
        client as unknown as { scheduleReconnect(gen: number): void },
        'scheduleReconnect',
      );
      const closes: Array<{ code: number }> = [];
      client.on('close', (info: { code: number }) => closes.push(info));

      client.connect();
      await wait(400);

      expect(closes.some((c) => c.code === 4001)).toBe(true);
      expect(scheduleSpy).not.toHaveBeenCalled();
      // No pending reconnect timer remains armed.
      expect(
        (client as unknown as { reconnectTimeout: unknown }).reconnectTimeout,
      ).toBeNull();
    } finally {
      await server.close();
    }
  }, 10_000);

  it('still schedules a reconnect for a non-4001 close', async () => {
    const server = await createTestServer();
    try {
      server.wss.on('connection', (ws) => {
        // 4002 is a valid application close code (1006 is reserved and cannot
        // be sent explicitly). Any non-4001 code must still trigger reconnect.
        setTimeout(() => ws.close(4002, 'transient'), 20);
      });

      client = new BridgeClient({ host: '127.0.0.1', port: server.port });
      const scheduleSpy = vi.spyOn(
        client as unknown as { scheduleReconnect(gen: number): void },
        'scheduleReconnect',
      );

      client.connect();
      await wait(400);

      expect(scheduleSpy).toHaveBeenCalled();
    } finally {
      await server.close();
    }
  }, 10_000);
});
