/**
 * Unit test: SessionTimelineRelay — daemon subscribes to sibling session
 * bridges' WebSocket servers and relays timeline events.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import { SessionTimelineRelay } from '../session-timeline-relay.js';
import { BridgeTimelineStore } from '../timeline-store.js';
import type { TimelineEntry } from '../types.js';

// Mock session-registry to control which sessions are "active"
vi.mock('../session-registry.js', () => ({
  listActive: vi.fn(() => []),
}));

import { listActive } from '../session-registry.js';
const mockListActive = vi.mocked(listActive);

function makeEntry(overrides: Partial<TimelineEntry> = {}): TimelineEntry {
  return {
    ts: Date.now(),
    type: 'tool_request',
    raw: 'Read /src/index.ts',
    agentType: 'claude-code',
    ...overrides,
  };
}

describe('SessionTimelineRelay', () => {
  let store: BridgeTimelineStore;
  let relay: SessionTimelineRelay;
  let wss: WebSocketServer | null = null;
  const TEST_PORT = 19200;

  beforeEach(() => {
    store = new BridgeTimelineStore();
    mockListActive.mockReturnValue([]);
  });

  afterEach(() => {
    relay?.stop();
    wss?.close();
    wss = null;
  });

  it('connects to sibling and relays timeline_event', async () => {
    // Start a fake session bridge WS server
    wss = new WebSocketServer({ port: TEST_PORT });
    await new Promise<void>((resolve) => wss!.on('listening', resolve));

    // Simulate a session bridge that broadcasts a timeline event on connect
    const entry = makeEntry({ ts: 1000, raw: 'Edit /foo.ts' });
    wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'timeline_event', entry }));
    });

    // Register the sibling session
    mockListActive.mockReturnValue([
      { id: 'session-1', port: TEST_PORT, pid: process.pid, projectName: 'test', agentType: 'claude-code', startedAt: new Date().toISOString() },
    ]);

    relay = new SessionTimelineRelay(9120, store);

    // Manually trigger sync (don't start polling timer in tests)
    (relay as any).sync();

    // Wait for WS connection + message
    await new Promise((r) => setTimeout(r, 300));

    const history = store.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].raw).toBe('Edit /foo.ts');
    expect(history[0].agentType).toBe('claude-code');
    expect(history[0].projectName).toBe('test');
    expect(history[0].sessionId).toBe('session-1');
  });

  it('relays timeline_history entries', async () => {
    wss = new WebSocketServer({ port: TEST_PORT });
    await new Promise<void>((resolve) => wss!.on('listening', resolve));

    const entries = [
      makeEntry({ ts: 100, raw: 'chat_start', type: 'chat_start' }),
      makeEntry({ ts: 200, raw: 'Read /a.ts' }),
      makeEntry({ ts: 300, raw: 'Completed · 5s', type: 'chat_end' }),
    ];
    wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'timeline_history', entries }));
    });

    mockListActive.mockReturnValue([
      { id: 'session-2', port: TEST_PORT, pid: process.pid, projectName: 'test', agentType: 'claude-code', startedAt: new Date().toISOString() },
    ]);

    relay = new SessionTimelineRelay(9120, store);
    (relay as any).sync();

    await new Promise((r) => setTimeout(r, 300));

    const history = store.getHistory();
    expect(history).toHaveLength(3);
    expect(history[0].type).toBe('chat_start');
    expect(history[0].projectName).toBe('test');
    expect(history[2].type).toBe('chat_end');
    expect(history[2].sessionId).toBe('session-2');
  });

  it('removes subscription when session disappears', async () => {
    wss = new WebSocketServer({ port: TEST_PORT });
    await new Promise<void>((resolve) => wss!.on('listening', resolve));

    mockListActive.mockReturnValue([
      { id: 'session-3', port: TEST_PORT, pid: process.pid, projectName: 'test', agentType: 'claude-code', startedAt: new Date().toISOString() },
    ]);

    relay = new SessionTimelineRelay(9120, store);
    (relay as any).sync();

    await new Promise((r) => setTimeout(r, 200));
    expect((relay as any).subscriptions.size).toBe(1);

    // Session disappears
    mockListActive.mockReturnValue([]);
    (relay as any).sync();

    // Subscription should be removed
    expect((relay as any).subscriptions.size).toBe(0);
  });

  it('ignores daemon sessions', () => {
    mockListActive.mockReturnValue([
      { id: 'daemon-1', port: 9120, pid: process.pid, projectName: 'AgentDeck', agentType: 'daemon', startedAt: new Date().toISOString() },
    ]);

    relay = new SessionTimelineRelay(9120, store);
    (relay as any).sync();

    expect((relay as any).subscriptions.size).toBe(0);
  });

  it('handles upsert timeline events', async () => {
    wss = new WebSocketServer({ port: TEST_PORT });
    await new Promise<void>((resolve) => wss!.on('listening', resolve));

    const entry = makeEntry({ ts: 500, raw: 'Initial summary', type: 'chat_end' });
    const upsertEntry = makeEntry({ ts: 500, raw: 'LLM enriched summary · 3s', type: 'chat_end' });

    wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'timeline_event', entry }));
      setTimeout(() => {
        ws.send(JSON.stringify({ type: 'timeline_event', entry: upsertEntry, upsert: true }));
      }, 50);
    });

    mockListActive.mockReturnValue([
      { id: 'session-4', port: TEST_PORT, pid: process.pid, projectName: 'test', agentType: 'claude-code', startedAt: new Date().toISOString() },
    ]);

    relay = new SessionTimelineRelay(9120, store);
    (relay as any).sync();

    await new Promise((r) => setTimeout(r, 400));

    const history = store.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].raw).toBe('LLM enriched summary · 3s');
    expect(history[0].projectName).toBe('test');
  });
});
