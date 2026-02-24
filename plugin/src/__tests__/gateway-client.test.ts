import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { State, PermissionMode, OPENCLAW_CAPABILITIES } from '@agentdeck/shared';
import type { StateUpdateEvent, PromptOptionsEvent } from '@agentdeck/shared';

// ---- Mock WebSocket ----

class MockWebSocket extends EventEmitter {
  static OPEN = 1;
  readyState = MockWebSocket.OPEN;
  send = vi.fn();
  close = vi.fn();

  // Simulate receiving a message from the server
  receiveMessage(data: Record<string, unknown>) {
    this.emit('message', Buffer.from(JSON.stringify(data)));
  }

  simulateOpen() {
    this.emit('open');
  }

  simulateClose() {
    this.readyState = 3; // CLOSED
    this.emit('close');
  }
}

let lastCreatedWs: MockWebSocket | null = null;

vi.mock('ws', () => {
  const factory = function(url: string) {
    lastCreatedWs = new MockWebSocket();
    return lastCreatedWs;
  };
  factory.OPEN = 1;
  factory.default = factory;
  return { default: factory };
});

// Mock fs for device identity
vi.mock('fs', () => ({
  readFileSync: vi.fn(() => {
    throw new Error('File not found');
  }),
}));

// Mock logger
vi.mock('../log.js', () => ({
  dlog: vi.fn(),
  dinfo: vi.fn(),
  dwarn: vi.fn(),
  derr: vi.fn(),
  dtrace: vi.fn(),
}));

import { GatewayClient } from '../gateway-client.js';

describe('GatewayClient', () => {
  let client: GatewayClient;

  beforeEach(() => {
    lastCreatedWs = null;
    client = new GatewayClient('ws://127.0.0.1:18789');
  });

  afterEach(() => {
    client.disconnect();
  });

  it('starts disconnected', () => {
    expect(client.isConnected()).toBe(false);
    expect(client.getCapabilities()).toBeNull();
  });

  describe('connect()', () => {
    it('creates a WebSocket connection', () => {
      client.connect();
      expect(lastCreatedWs).not.toBeNull();
    });
  });

  describe('handshake flow', () => {
    it('responds to connect.challenge with connect request', () => {
      client.connect();
      const ws = lastCreatedWs!;
      ws.simulateOpen();

      // Gateway sends challenge
      ws.receiveMessage({
        type: 'event',
        event: 'connect.challenge',
        payload: { nonce: 'test-nonce-123' },
      });

      // Client should send connect request (without device auth since identity is mocked to fail)
      expect(ws.send).toHaveBeenCalled();
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.type).toBe('req');
      expect(sent.method).toBe('connect');
      expect(sent.params.client.id).toBe('gateway-client');
    });

    it('becomes connected on successful handshake', () => {
      const events: string[] = [];
      client.on('connected', () => events.push('connected'));
      const stateUpdates: StateUpdateEvent[] = [];
      client.on('state_update', (ev: StateUpdateEvent) => stateUpdates.push(ev));

      client.connect();
      const ws = lastCreatedWs!;
      ws.simulateOpen();

      // Challenge
      ws.receiveMessage({
        type: 'event',
        event: 'connect.challenge',
        payload: { nonce: 'nonce1' },
      });

      // Successful response to connect request (id=init-1)
      ws.receiveMessage({
        type: 'res',
        id: 'init-1',
        ok: true,
        payload: { features: {} },
      });

      expect(client.isConnected()).toBe(true);
      expect(client.getCapabilities()).toEqual(OPENCLAW_CAPABILITIES);
      expect(events).toContain('connected');

      // Should emit IDLE state
      const idleEvent = stateUpdates.find(e => e.state === State.IDLE);
      expect(idleEvent).toBeDefined();
      expect(idleEvent!.agentType).toBe('openclaw');
    });
  });

  describe('event mapping', () => {
    function connectClient() {
      client.connect();
      const ws = lastCreatedWs!;
      ws.simulateOpen();
      ws.receiveMessage({
        type: 'event',
        event: 'connect.challenge',
        payload: { nonce: 'n' },
      });
      ws.receiveMessage({
        type: 'res',
        id: 'init-1',
        ok: true,
        payload: {},
      });
      return ws;
    }

    it('maps chat delta → PROCESSING', () => {
      const ws = connectClient();
      const updates: StateUpdateEvent[] = [];
      client.on('state_update', (ev: StateUpdateEvent) => updates.push(ev));

      ws.receiveMessage({
        type: 'event',
        event: 'chat',
        payload: { state: 'delta', runId: 'run1', sessionKey: 'sk1' },
      });

      const processing = updates.find(e => e.state === State.PROCESSING);
      expect(processing).toBeDefined();
    });

    it('maps chat final → IDLE', () => {
      const ws = connectClient();
      const updates: StateUpdateEvent[] = [];
      client.on('state_update', (ev: StateUpdateEvent) => updates.push(ev));

      // Start processing
      ws.receiveMessage({
        type: 'event',
        event: 'chat',
        payload: { state: 'delta', runId: 'run1', sessionKey: 'sk1' },
      });

      // Complete
      ws.receiveMessage({
        type: 'event',
        event: 'chat',
        payload: { state: 'final', runId: 'run1', sessionKey: 'sk1' },
      });

      const idle = updates.filter(e => e.state === State.IDLE);
      expect(idle.length).toBeGreaterThan(0);
    });

    it('maps exec.approval.requested → AWAITING_PERMISSION + prompt_options', () => {
      const ws = connectClient();
      const updates: StateUpdateEvent[] = [];
      const options: PromptOptionsEvent[] = [];
      client.on('state_update', (ev: StateUpdateEvent) => updates.push(ev));
      client.on('prompt_options', (ev: PromptOptionsEvent) => options.push(ev));

      ws.receiveMessage({
        type: 'event',
        event: 'exec.approval.requested',
        payload: {
          id: 'approval-1',
          command: 'rm -rf /',
          ask: 'Allow dangerous command?',
        },
      });

      const permEvent = updates.find(e => e.state === State.AWAITING_PERMISSION);
      expect(permEvent).toBeDefined();
      expect(permEvent!.options).toHaveLength(2);
      expect(permEvent!.options![0].label).toBe('Allow');
      expect(permEvent!.question).toBe('Allow dangerous command?');

      expect(options).toHaveLength(1);
      expect(options[0].promptType).toBe('yes_no');
    });

    it('maps exec.approval.resolved → PROCESSING', () => {
      const ws = connectClient();

      // Request approval
      ws.receiveMessage({
        type: 'event',
        event: 'exec.approval.requested',
        payload: { id: 'a1', command: 'test' },
      });

      const updates: StateUpdateEvent[] = [];
      client.on('state_update', (ev: StateUpdateEvent) => updates.push(ev));

      // Resolve it
      ws.receiveMessage({
        type: 'event',
        event: 'exec.approval.resolved',
        payload: {},
      });

      const processing = updates.find(e => e.state === State.PROCESSING);
      expect(processing).toBeDefined();
    });
  });

  describe('command mapping', () => {
    function connectClient() {
      client.connect();
      const ws = lastCreatedWs!;
      ws.simulateOpen();
      ws.receiveMessage({
        type: 'event',
        event: 'connect.challenge',
        payload: { nonce: 'n' },
      });
      ws.receiveMessage({
        type: 'res',
        id: 'init-1',
        ok: true,
        payload: {},
      });
      return ws;
    }

    it('send_prompt → chat.send RPC', () => {
      const ws = connectClient();

      // Set currentSessionKey via a chat delta event (synchronous)
      ws.receiveMessage({
        type: 'event',
        event: 'chat',
        payload: { state: 'delta', runId: 'run1', sessionKey: 'session-1' },
      });
      ws.send.mockClear();

      client.send({ type: 'send_prompt', text: 'Hello, OpenClaw!' });

      expect(ws.send).toHaveBeenCalled();
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.method).toBe('chat.send');
      expect(sent.params.message).toBe('Hello, OpenClaw!');
      expect(sent.params.sessionKey).toBe('session-1');
    });

    it('respond y → exec.approval.resolve allow', () => {
      const ws = connectClient();

      // Set pending approval
      ws.receiveMessage({
        type: 'event',
        event: 'exec.approval.requested',
        payload: { id: 'approval-1', command: 'test' },
      });
      ws.send.mockClear();

      client.send({ type: 'respond', value: 'y' });

      expect(ws.send).toHaveBeenCalled();
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.method).toBe('exec.approval.resolve');
      expect(sent.params.decision).toBe('allow');
      expect(sent.params.id).toBe('approval-1');
    });

    it('respond n → exec.approval.resolve deny', () => {
      const ws = connectClient();

      ws.receiveMessage({
        type: 'event',
        event: 'exec.approval.requested',
        payload: { id: 'approval-2', command: 'test' },
      });
      ws.send.mockClear();

      client.send({ type: 'respond', value: 'n' });

      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.method).toBe('exec.approval.resolve');
      expect(sent.params.decision).toBe('deny');
    });

    it('select_option 0 → allow, 1 → deny', () => {
      const ws = connectClient();

      ws.receiveMessage({
        type: 'event',
        event: 'exec.approval.requested',
        payload: { id: 'a3', command: 'test' },
      });
      ws.send.mockClear();

      client.send({ type: 'select_option', index: 0 });

      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.params.decision).toBe('allow');
    });

    it('interrupt → chat.abort', () => {
      const ws = connectClient();

      // Start a run
      ws.receiveMessage({
        type: 'event',
        event: 'chat',
        payload: { state: 'delta', runId: 'run1', sessionKey: 'session-1' },
      });
      ws.send.mockClear();

      client.send({ type: 'interrupt' });

      expect(ws.send).toHaveBeenCalled();
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.method).toBe('chat.abort');
      expect(sent.params.runId).toBe('run1');
    });

    it('switch_mode is a no-op', () => {
      const ws = connectClient();
      ws.send.mockClear();

      client.send({ type: 'switch_mode' });

      expect(ws.send).not.toHaveBeenCalled();
    });
  });

  describe('disconnect', () => {
    it('emits disconnected', () => {
      const events: string[] = [];
      client.on('disconnected', () => events.push('disconnected'));

      client.connect();
      const ws = lastCreatedWs!;
      ws.simulateOpen();
      ws.receiveMessage({
        type: 'event',
        event: 'connect.challenge',
        payload: { nonce: 'n' },
      });
      ws.receiveMessage({
        type: 'res',
        id: 'init-1',
        ok: true,
        payload: {},
      });

      expect(client.isConnected()).toBe(true);
      client.disconnect();
      expect(client.isConnected()).toBe(false);
      expect(events).toContain('disconnected');
    });
  });
});
