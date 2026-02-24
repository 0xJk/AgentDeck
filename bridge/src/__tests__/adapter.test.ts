import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock node-pty before any imports that use it
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    pid: 12345,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    _pty: '/dev/ttys042',
  })),
}));

// Mock express/http for HookServer
vi.mock('express', () => {
  const app = {
    use: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
  };
  const fn = Object.assign(vi.fn(() => app), {
    json: vi.fn(() => vi.fn()),
  });
  return { default: fn };
});

vi.mock('http', async () => {
  const actual = await vi.importActual<typeof import('http')>('http');
  const mockServer = {
    listen: vi.fn((_port: number, _host: string, cb: () => void) => cb()),
    close: vi.fn((cb: () => void) => cb()),
    on: vi.fn(),
  };
  return {
    ...actual,
    createServer: vi.fn(() => mockServer),
  };
});

// Mock ws for OpenClawAdapter (prevent real WebSocket connections)
vi.mock('ws', () => {
  const MockWebSocket = vi.fn(() => ({
    on: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1, // OPEN
  }));
  (MockWebSocket as any).OPEN = 1;
  (MockWebSocket as any).CLOSED = 3;
  return { default: MockWebSocket };
});

import { createAdapter, ClaudeCodeAdapter, OpenClawAdapter } from '../adapters/index.js';
import type { AgentAdapter, AdapterEvent, PluginCommand } from '../types.js';

describe('createAdapter factory', () => {
  it('creates ClaudeCodeAdapter for "claude-code"', () => {
    const adapter = createAdapter('claude-code');
    expect(adapter).toBeInstanceOf(ClaudeCodeAdapter);
    expect(adapter.capabilities.type).toBe('claude-code');
    expect(adapter.capabilities.displayName).toBe('Claude Code');
  });

  it('creates OpenClawAdapter for "openclaw"', () => {
    const adapter = createAdapter('openclaw');
    expect(adapter).toBeInstanceOf(OpenClawAdapter);
    expect(adapter.capabilities.type).toBe('openclaw');
    expect(adapter.capabilities.displayName).toBe('OpenClaw');
  });

  it('passes gatewayUrl to OpenClawAdapter', () => {
    const adapter = createAdapter('openclaw', 'ws://custom:9999');
    expect(adapter).toBeInstanceOf(OpenClawAdapter);
  });

  it('throws for unknown agent type', () => {
    expect(() => createAdapter('unknown' as any)).toThrow('Unknown agent type');
  });
});

describe('ClaudeCodeAdapter', () => {
  let adapter: ClaudeCodeAdapter;

  beforeEach(() => {
    adapter = new ClaudeCodeAdapter();
  });

  describe('capabilities', () => {
    it('reports all Claude Code capabilities as true', () => {
      const caps = adapter.capabilities;
      expect(caps.hasTerminal).toBe(true);
      expect(caps.hasModeSwitching).toBe(true);
      expect(caps.hasDiffReview).toBe(true);
      expect(caps.hasOptionLists).toBe(true);
      expect(caps.hasNavigablePrompts).toBe(true);
      expect(caps.hasSuggestedPrompts).toBe(true);
      expect(caps.hasApiUsage).toBe(true);
    });
  });

  describe('handleCommand routing', () => {
    it('handles respond → returns true', () => {
      const cmd: PluginCommand = { type: 'respond', value: 'y' };
      expect(adapter.handleCommand(cmd)).toBe(true);
    });

    it('handles switch_mode → returns true', () => {
      const cmd: PluginCommand = { type: 'switch_mode' };
      expect(adapter.handleCommand(cmd)).toBe(true);
    });

    it('handles interrupt → returns true', () => {
      const cmd: PluginCommand = { type: 'interrupt' };
      expect(adapter.handleCommand(cmd)).toBe(true);
    });

    it('handles escape → returns true', () => {
      const cmd: PluginCommand = { type: 'escape' };
      expect(adapter.handleCommand(cmd)).toBe(true);
    });

    it('defers select_option to bridge → returns false', () => {
      const cmd: PluginCommand = { type: 'select_option', index: 0 };
      expect(adapter.handleCommand(cmd)).toBe(false);
    });

    it('defers navigate_option to bridge → returns false', () => {
      const cmd: PluginCommand = { type: 'navigate_option', direction: 'up' };
      expect(adapter.handleCommand(cmd)).toBe(false);
    });

    it('defers send_prompt to bridge → returns false', () => {
      const cmd: PluginCommand = { type: 'send_prompt', text: 'hello' };
      expect(adapter.handleCommand(cmd)).toBe(false);
    });

    it('defers voice to bridge → returns false', () => {
      const cmd: PluginCommand = { type: 'voice', action: 'start' };
      expect(adapter.handleCommand(cmd)).toBe(false);
    });

    it('defers query_usage to bridge → returns false', () => {
      const cmd: PluginCommand = { type: 'query_usage' };
      expect(adapter.handleCommand(cmd)).toBe(false);
    });
  });

  describe('switch_mode debounce', () => {
    it('debounces rapid switch_mode calls (< 100ms apart)', () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const cmd: PluginCommand = { type: 'switch_mode' };
      expect(adapter.handleCommand(cmd)).toBe(true);

      // Call again within 100ms
      vi.spyOn(Date, 'now').mockReturnValue(now + 50);
      expect(adapter.handleCommand(cmd)).toBe(true); // Still returns true (handled = debounced)

      vi.restoreAllMocks();
    });
  });

  describe('lifecycle', () => {
    it('isAlive returns false before start', () => {
      expect(adapter.isAlive()).toBe(false);
    });

    it('getTtyPath returns undefined before start', () => {
      expect(adapter.getTtyPath()).toBeUndefined();
    });

    it('getProjectName returns null before start', () => {
      expect(adapter.getProjectName()).toBeNull();
    });

    it('getHttpServer returns an object', () => {
      // Even before start, the HookServer creates the HTTP server in constructor
      expect(adapter.getHttpServer()).toBeDefined();
    });
  });

  describe('onRawData callback', () => {
    it('can register callback without error', () => {
      const cb = vi.fn();
      expect(() => adapter.onRawData(cb)).not.toThrow();
    });
  });

  describe('onDiag handler', () => {
    it('can register handler without error', () => {
      const handler = vi.fn();
      expect(() => adapter.onDiag(handler)).not.toThrow();
    });
  });
});

describe('OpenClawAdapter', () => {
  let adapter: OpenClawAdapter;

  beforeEach(() => {
    adapter = new OpenClawAdapter('ws://127.0.0.1:18789');
  });

  describe('capabilities', () => {
    it('reports OpenClaw capabilities correctly', () => {
      const caps = adapter.capabilities;
      expect(caps.type).toBe('openclaw');
      expect(caps.displayName).toBe('OpenClaw');
      expect(caps.hasTerminal).toBe(false);
      expect(caps.hasModeSwitching).toBe(false);
      expect(caps.hasDiffReview).toBe(false);
      expect(caps.hasOptionLists).toBe(true);
      expect(caps.hasNavigablePrompts).toBe(false);
      expect(caps.hasSuggestedPrompts).toBe(false);
      expect(caps.hasApiUsage).toBe(false);
    });
  });

  describe('handleCommand routing', () => {
    it('handles respond → returns true (RPC)', () => {
      const cmd: PluginCommand = { type: 'respond', value: 'y' };
      expect(adapter.handleCommand(cmd)).toBe(true);
    });

    it('handles select_option → returns true (RPC)', () => {
      const cmd: PluginCommand = { type: 'select_option', index: 0 };
      expect(adapter.handleCommand(cmd)).toBe(true);
    });

    it('handles navigate_option → returns true (no-op)', () => {
      const cmd: PluginCommand = { type: 'navigate_option', direction: 'up' };
      expect(adapter.handleCommand(cmd)).toBe(true);
    });

    it('handles send_prompt → returns true (RPC)', () => {
      const cmd: PluginCommand = { type: 'send_prompt', text: 'hello' };
      expect(adapter.handleCommand(cmd)).toBe(true);
    });

    it('handles interrupt → returns true (RPC)', () => {
      const cmd: PluginCommand = { type: 'interrupt' };
      expect(adapter.handleCommand(cmd)).toBe(true);
    });

    it('handles escape → returns true (RPC)', () => {
      const cmd: PluginCommand = { type: 'escape' };
      expect(adapter.handleCommand(cmd)).toBe(true);
    });

    it('defers switch_mode → returns false (not supported)', () => {
      const cmd: PluginCommand = { type: 'switch_mode' };
      expect(adapter.handleCommand(cmd)).toBe(false);
    });

    it('defers voice to bridge → returns false', () => {
      const cmd: PluginCommand = { type: 'voice', action: 'start' };
      expect(adapter.handleCommand(cmd)).toBe(false);
    });

    it('defers query_usage to bridge → returns false', () => {
      const cmd: PluginCommand = { type: 'query_usage' };
      expect(adapter.handleCommand(cmd)).toBe(false);
    });
  });

  describe('lifecycle', () => {
    it('isAlive returns false before start', () => {
      expect(adapter.isAlive()).toBe(false);
    });

    it('getTtyPath returns undefined (no PTY)', () => {
      expect(adapter.getTtyPath()).toBeUndefined();
    });

    it('getProjectName returns null before start', () => {
      expect(adapter.getProjectName()).toBeNull();
    });

    it('getHttpServer returns an object', () => {
      expect(adapter.getHttpServer()).toBeDefined();
    });

    it('attachTerminal is a no-op', () => {
      // Should not throw
      const mockStdin = { on: vi.fn() } as any;
      const mockStdout = { write: vi.fn() } as any;
      expect(() => adapter.attachTerminal(mockStdin, mockStdout)).not.toThrow();
    });
  });

  describe('onRawData callback', () => {
    it('can register callback without error', () => {
      const cb = vi.fn();
      expect(() => adapter.onRawData(cb)).not.toThrow();
    });
  });

  describe('onDiag handler', () => {
    it('can register handler without error', () => {
      const handler = vi.fn();
      expect(() => adapter.onDiag(handler)).not.toThrow();
    });
  });
});

describe('OpenClawAdapter gateway protocol', () => {
  let adapter: OpenClawAdapter;
  let events: AdapterEvent[];
  let wsInstance: any;

  beforeEach(async () => {
    // Capture the WS instance created by connectGateway()
    wsInstance = null;
    const WS = (await import('ws')).default;
    (WS as any).mockImplementation(function (this: any) {
      this.on = vi.fn();
      this.send = vi.fn();
      this.close = vi.fn();
      this.readyState = 1;
      wsInstance = this;
    });

    adapter = new OpenClawAdapter('ws://127.0.0.1:18789');
    events = [];
    adapter.on('event', (evt: AdapterEvent) => events.push(evt));

    await adapter.start({ port: 9120 });

    // If wsInstance is still null, connectGateway was never called
    if (!wsInstance) {
      throw new Error('WebSocket was not created — connectGateway() not called');
    }
  });

  afterEach(async () => {
    await adapter.shutdown();
  });

  function getHandler(name: string): ((...args: any[]) => void) | undefined {
    const call = wsInstance.on.mock.calls.find((c: any[]) => c[0] === name);
    return call?.[1];
  }

  function simulateMessage(msg: unknown): void {
    const handler = getHandler('message');
    handler?.(Buffer.from(JSON.stringify(msg)));
  }

  function completeHandshake(): void {
    simulateMessage({
      type: 'event',
      event: 'connect.challenge',
      payload: { nonce: 'test-nonce', ts: Date.now() },
    });
    simulateMessage({
      type: 'res',
      id: 'init-1',
      ok: true,
      payload: {
        protocol: 3,
        server: { version: '0.1.0', connId: 'test' },
        features: { methods: ['chat.send', 'sessions.list'], events: ['chat'] },
      },
    });
  }

  it('sends connect request with correct format on connect.challenge', () => {
    simulateMessage({
      type: 'event',
      event: 'connect.challenge',
      payload: { nonce: 'test-nonce-abc', ts: Date.now() },
    });

    expect(wsInstance.send).toHaveBeenCalled();
    const sent = JSON.parse(wsInstance.send.mock.calls[0][0]);
    expect(sent.type).toBe('req');
    expect(sent.method).toBe('connect');
    expect(sent.id).toBe('init-1');
    expect(sent.params.minProtocol).toBe(3);
    expect(sent.params.maxProtocol).toBe(3);
    expect(sent.params.client.id).toBe('gateway-client');
    expect(sent.params.client.mode).toBe('backend');
    expect(sent.params.client.displayName).toBe('AgentDeck');
    expect(sent.params.role).toBe('operator');
    expect(sent.params.caps).toContain('tool-events');
  });

  it('becomes alive after hello-ok response', () => {
    expect(adapter.isAlive()).toBe(false);

    completeHandshake();

    expect(adapter.isAlive()).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({ source: 'connection', status: 'connected' }),
    );
  });

  it('emits spinner_start on chat delta event', () => {
    completeHandshake();
    events.length = 0;

    simulateMessage({
      type: 'event',
      event: 'chat',
      payload: { runId: 'run-1', sessionKey: 'key-1', seq: 0, state: 'delta' },
    });

    expect(events).toContainEqual(
      expect.objectContaining({ source: 'parser', event: 'spinner_start' }),
    );
  });

  it('emits idle on chat final event', () => {
    completeHandshake();
    events.length = 0;

    simulateMessage({
      type: 'event',
      event: 'chat',
      payload: { runId: 'run-1', sessionKey: 'key-1', seq: 1, state: 'final' },
    });

    expect(events).toContainEqual(
      expect.objectContaining({ source: 'parser', event: 'idle' }),
    );
  });

  it('emits idle on chat aborted event', () => {
    completeHandshake();
    events.length = 0;

    simulateMessage({
      type: 'event',
      event: 'chat',
      payload: { runId: 'run-1', sessionKey: 'key-1', seq: 1, state: 'aborted' },
    });

    expect(events).toContainEqual(
      expect.objectContaining({ source: 'parser', event: 'idle' }),
    );
  });

  it('emits idle on chat error event', () => {
    completeHandshake();
    events.length = 0;

    simulateMessage({
      type: 'event',
      event: 'chat',
      payload: { runId: 'run-1', sessionKey: 'key-1', seq: 1, state: 'error', errorMessage: 'fail' },
    });

    expect(events).toContainEqual(
      expect.objectContaining({ source: 'parser', event: 'idle' }),
    );
  });

  it('emits permission_prompt on exec.approval.requested', () => {
    completeHandshake();
    events.length = 0;

    simulateMessage({
      type: 'event',
      event: 'exec.approval.requested',
      payload: { id: 'approval-1', command: 'rm -rf /tmp/test' },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        source: 'parser',
        event: 'permission_prompt',
        data: expect.objectContaining({
          question: 'rm -rf /tmp/test',
          options: expect.arrayContaining([
            expect.objectContaining({ label: 'Allow' }),
            expect.objectContaining({ label: 'Deny' }),
          ]),
        }),
      }),
    );
  });

  it('sends exec.approval.resolve on respond after approval request', () => {
    completeHandshake();

    simulateMessage({
      type: 'event',
      event: 'exec.approval.requested',
      payload: { id: 'approval-42', command: 'npm install' },
    });

    wsInstance.send.mockClear();

    adapter.handleCommand({ type: 'respond', value: 'y' });

    expect(wsInstance.send).toHaveBeenCalled();
    const sent = JSON.parse(wsInstance.send.mock.calls[0][0]);
    expect(sent.type).toBe('req');
    expect(sent.method).toBe('exec.approval.resolve');
    expect(sent.params.id).toBe('approval-42');
    expect(sent.params.decision).toBe('allow');
  });

  it('sends exec.approval.resolve with deny on respond "n"', () => {
    completeHandshake();

    simulateMessage({
      type: 'event',
      event: 'exec.approval.requested',
      payload: { id: 'approval-99', command: 'dangerous-cmd' },
    });

    wsInstance.send.mockClear();

    adapter.handleCommand({ type: 'respond', value: 'n' });

    const sent = JSON.parse(wsInstance.send.mock.calls[0][0]);
    expect(sent.params.decision).toBe('deny');
  });

  it('sends chat.send on send_prompt with active session', () => {
    completeHandshake();

    // Set session key via chat event
    simulateMessage({
      type: 'event',
      event: 'chat',
      payload: { runId: 'r1', sessionKey: 'agent:main:test', seq: 0, state: 'delta' },
    });

    wsInstance.send.mockClear();

    adapter.handleCommand({ type: 'send_prompt', text: 'hello world' });

    expect(wsInstance.send).toHaveBeenCalled();
    const sent = JSON.parse(wsInstance.send.mock.calls[0][0]);
    expect(sent.type).toBe('req');
    expect(sent.method).toBe('chat.send');
    expect(sent.params.sessionKey).toBe('agent:main:test');
    expect(sent.params.message).toBe('hello world');
    expect(sent.params.idempotencyKey).toBeDefined();
  });

  it('sends chat.abort on interrupt with active session and runId', () => {
    completeHandshake();

    simulateMessage({
      type: 'event',
      event: 'chat',
      payload: { runId: 'run-abc', sessionKey: 'agent:main:test', seq: 0, state: 'delta' },
    });

    wsInstance.send.mockClear();

    adapter.handleCommand({ type: 'interrupt' });

    expect(wsInstance.send).toHaveBeenCalled();
    const sent = JSON.parse(wsInstance.send.mock.calls[0][0]);
    expect(sent.type).toBe('req');
    expect(sent.method).toBe('chat.abort');
    expect(sent.params.sessionKey).toBe('agent:main:test');
    expect(sent.params.runId).toBe('run-abc');
  });

  it('emits SessionEnd on shutdown event', () => {
    completeHandshake();
    events.length = 0;

    simulateMessage({
      type: 'event',
      event: 'shutdown',
      payload: {},
    });

    expect(events).toContainEqual(
      expect.objectContaining({ source: 'hook', event: 'SessionEnd' }),
    );
  });

  it('clears pendingApprovalId on exec.approval.resolved', () => {
    completeHandshake();

    simulateMessage({
      type: 'event',
      event: 'exec.approval.requested',
      payload: { id: 'approval-1', command: 'test' },
    });

    simulateMessage({
      type: 'event',
      event: 'exec.approval.resolved',
      payload: {},
    });

    // Now respond should be a no-op (no pending approval)
    wsInstance.send.mockClear();
    adapter.handleCommand({ type: 'respond', value: 'y' });
    expect(wsInstance.send).not.toHaveBeenCalled();
  });
});
