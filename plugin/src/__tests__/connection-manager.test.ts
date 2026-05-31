import { describe, it, expect, vi, beforeEach } from 'vitest';
import { State, PermissionMode, OPENCLAW_CAPABILITIES } from '@agentdeck/shared';
import type { StateUpdateEvent, PluginCommand } from '@agentdeck/shared';

// ---- Mocks ----

// Capture the args BridgeClient was constructed with so state-machine tests can
// assert host/port/token wiring.
const bridgeCtorCalls: Array<{ host?: string; port?: number; token?: string } | undefined> = [];

// Mock BridgeClient
vi.mock('../bridge-client.js', async () => {
  const { EventEmitter } = await import('events');

  class MockBridgeClient extends EventEmitter {
    _connected = false;
    _host: string;
    _port: number;
    _token: string;
    _portProvider: (() => number | null) | null = null;
    connect = vi.fn((port?: number) => {
      if (port != null) this._port = port;
    });
    reconnectTo = vi.fn((port: number) => {
      this._port = port;
    });
    disconnect = vi.fn(() => {
      this._connected = false;
      this.emit('disconnected');
    });
    setPortProvider(provider: (() => number | null) | null) {
      this._portProvider = provider;
    }
    send = vi.fn();
    isConnected() { return this._connected; }
    getCapabilities() { return null; }
    getHost() { return this._host; }
    getPort() { return this._port; }
    isRemote() { return this._host !== 'localhost' && this._host !== '127.0.0.1'; }

    constructor(opts?: { host?: string; port?: number; token?: string }) {
      super();
      bridgeCtorCalls.push(opts);
      this._host = opts?.host ?? 'localhost';
      this._port = opts?.port ?? 9120;
      this._token = opts?.token ?? '';
    }

    // Test helpers
    _simulateConnect() {
      this._connected = true;
      this.emit('connected');
    }
    _simulateDisconnect() {
      this._connected = false;
      this.emit('disconnected');
    }
    _simulateClose(code: number, reason = '') {
      this._connected = false;
      this.emit('close', { code, reason });
    }
    _simulateStateUpdate(ev: StateUpdateEvent) {
      this.emit('state_update', ev);
    }
    _simulateEvent(name: string, ev: unknown) {
      this.emit(name, ev);
    }
  }
  return { BridgeClient: MockBridgeClient };
});

// Mock token-store
const loadTokenMock = vi.fn<(id: string) => Promise<string | null>>();
const deleteTokenMock = vi.fn<(id: string) => Promise<void>>();
vi.mock('../token-store.js', () => ({
  loadToken: (id: string) => loadTokenMock(id),
  deleteToken: (id: string) => deleteTokenMock(id),
  saveToken: vi.fn(),
}));

// Mock bridge-settings
interface TestSettings {
  pairedBridges: Array<{ id: string; host: string; port: number }>;
  activeBridgeId: string | null;
}
const getGlobalSettingsMock = vi.fn<() => Promise<TestSettings>>();
vi.mock('../bridge-settings.js', () => ({
  getGlobalSettings: () => getGlobalSettingsMock(),
  setGlobalSettings: vi.fn(),
  onDidReceiveGlobalSettings: vi.fn(() => ({ dispose: vi.fn() })),
  findBridge: (settings: TestSettings, id: string | null) =>
    id == null ? null : settings.pairedBridges.find((b) => b.id === id) ?? null,
  emptySettings: () => ({ pairedBridges: [], activeBridgeId: null }),
}));

// Mock logger
vi.mock('../log.js', () => ({
  dlog: vi.fn(),
  dinfo: vi.fn(),
  dwarn: vi.fn(),
  derr: vi.fn(),
  dtrace: vi.fn(),
}));

import { ConnectionManager } from '../connection-manager.js';

// Helper to access internal mock
function getBridge(cm: ConnectionManager): any {
  return (cm as any).bridge;
}

function getState(cm: ConnectionManager): string {
  return (cm as any).state;
}

function makeStateUpdate(state: State, agent?: 'openclaw' | 'claude-code'): StateUpdateEvent {
  return {
    type: 'state_update',
    state,
    permissionMode: PermissionMode.DEFAULT,
    ...(agent === 'openclaw' ? {
      agentType: 'openclaw',
      agentCapabilities: OPENCLAW_CAPABILITIES,
    } : {}),
  };
}

/** Drive start() and let its async settings read settle. */
async function startAndSettle(cm: ConnectionManager): Promise<void> {
  // start() is async and awaits the full getGlobalSettings -> loadToken ->
  // new BridgeClient -> connect chain, so awaiting it directly is sufficient.
  await cm.start();
}

describe('ConnectionManager', () => {
  let cm: ConnectionManager;

  beforeEach(() => {
    bridgeCtorCalls.length = 0;
    loadTokenMock.mockReset();
    deleteTokenMock.mockReset();
    getGlobalSettingsMock.mockReset();
    // Default: one paired+active remote bridge with a valid token.
    getGlobalSettingsMock.mockResolvedValue({
      pairedBridges: [{ id: 'M4', host: '192.168.1.5', port: 9120 }],
      activeBridgeId: 'M4',
    });
    loadTokenMock.mockResolvedValue('valid-token');
    deleteTokenMock.mockResolvedValue(undefined);
    cm = new ConnectionManager();
  });

  it('starts disconnected and idle', () => {
    expect(cm.isConnected()).toBe(false);
    expect(cm.getCapabilities()).toBeNull();
    expect(getState(cm)).toBe('idle');
  });

  it('start() with no active bridge id => unconfigured, no BridgeClient', async () => {
    getGlobalSettingsMock.mockResolvedValue({ pairedBridges: [], activeBridgeId: null });
    await startAndSettle(cm);
    expect(getState(cm)).toBe('unconfigured');
    expect(bridgeCtorCalls).toHaveLength(0);
  });

  it('start() with active bridge constructs BridgeClient(host,port,token) and connects', async () => {
    await startAndSettle(cm);
    expect(loadTokenMock).toHaveBeenCalledWith('M4');
    expect(bridgeCtorCalls[0]).toEqual({ host: '192.168.1.5', port: 9120, token: 'valid-token' });
    expect(getBridge(cm).connect).toHaveBeenCalled();
    expect(getState(cm)).toBe('connecting');
  });

  it('emits connected when bridge connects', async () => {
    const events: string[] = [];
    cm.on('connected', () => events.push('connected'));
    await startAndSettle(cm);
    getBridge(cm)._simulateConnect();
    expect(cm.isConnected()).toBe(true);
    expect(events).toContain('connected');
    expect(getState(cm)).toBe('connected');
  });

  it('emits disconnected when bridge disconnects', async () => {
    const events: string[] = [];
    cm.on('disconnected', () => events.push('disconnected'));
    await startAndSettle(cm);
    getBridge(cm)._simulateConnect();
    getBridge(cm)._simulateDisconnect();
    expect(events).toContain('disconnected');
  });

  it('forwards state_update from bridge', async () => {
    const received: StateUpdateEvent[] = [];
    cm.on('state_update', (ev: StateUpdateEvent) => received.push(ev));
    await startAndSettle(cm);
    getBridge(cm)._simulateConnect();
    getBridge(cm)._simulateStateUpdate(makeStateUpdate(State.IDLE, 'openclaw'));
    expect(received).toHaveLength(1);
    expect(received[0].state).toBe(State.IDLE);
  });

  it('send() delegates to bridge', async () => {
    await startAndSettle(cm);
    getBridge(cm)._simulateConnect();
    const cmd: PluginCommand = { type: 'interrupt' };
    cm.send(cmd);
    expect(getBridge(cm).send).toHaveBeenCalledWith(cmd);
  });

  it('send() drops command when not connected', () => {
    const cmd: PluginCommand = { type: 'interrupt' };
    cm.send(cmd);
    // No bridge constructed yet (start not called) — nothing to send to.
    expect(bridgeCtorCalls).toHaveLength(0);
  });

  // ===== Test 11: connected -> close 4001 -> deleteToken -> pairing =====

  it('connected -> onClose 4001 -> deletes token -> state pairing', async () => {
    await startAndSettle(cm);
    getBridge(cm)._simulateConnect();
    expect(getState(cm)).toBe('connected');

    getBridge(cm)._simulateClose(4001, 'Unauthorized');
    // Allow the async deleteToken -> setState chain to settle.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(deleteTokenMock).toHaveBeenCalledWith('M4');
    expect(getState(cm)).toBe('pairing');
  });

  it('non-4001 close does NOT delete the token or move to pairing', async () => {
    await startAndSettle(cm);
    getBridge(cm)._simulateConnect();
    getBridge(cm)._simulateClose(1006, 'abnormal');
    await Promise.resolve();
    expect(deleteTokenMock).not.toHaveBeenCalled();
    expect(getState(cm)).not.toBe('pairing');
  });

  // ===== Test 12: keyring throw -> keychain_error, no retry =====

  it('start(): loadToken throwing => keychain_error, no BridgeClient, no retry', async () => {
    loadTokenMock.mockRejectedValue(new Error('keychain locked'));
    await startAndSettle(cm);
    expect(getState(cm)).toBe('keychain_error');
    expect(bridgeCtorCalls).toHaveLength(0);
    // No reconnect/connect attempt was made.
    expect(loadTokenMock).toHaveBeenCalledTimes(1);
  });

  // ===== Test 13: focus_lost -> clear focus, stay connected =====

  it('focus_lost event clears local focus but stays connected', async () => {
    await startAndSettle(cm);
    getBridge(cm)._simulateConnect();
    expect(getState(cm)).toBe('connected');

    const seen: unknown[] = [];
    cm.on('focus_lost', (ev) => seen.push(ev));

    getBridge(cm)._simulateEvent('focus_lost', { type: 'focus_lost', sessionId: 's1' });

    // Still connected.
    expect(getState(cm)).toBe('connected');
    expect(cm.isConnected()).toBe(true);
    // Local focus cleared.
    expect((cm as any).focusedSessionId).toBeNull();
    // Forwarded for UI.
    expect(seen).toHaveLength(1);
  });

  // ===== isRemoteActiveBridge =====

  it('isRemoteActiveBridge true for a remote host', async () => {
    await startAndSettle(cm);
    expect(cm.isRemoteActiveBridge()).toBe(true);
  });

  it('isRemoteActiveBridge false for localhost', async () => {
    getGlobalSettingsMock.mockResolvedValue({
      pairedBridges: [{ id: 'local', host: 'localhost', port: 9120 }],
      activeBridgeId: 'local',
    });
    loadTokenMock.mockResolvedValue('');
    await startAndSettle(cm);
    expect(cm.isRemoteActiveBridge()).toBe(false);
  });

  it('isRemoteActiveBridge false with no active bridge', () => {
    expect(cm.isRemoteActiveBridge()).toBe(false);
  });

  // ===== switch active bridge =====

  it('switchActiveBridge disconnects old client and connects a new one', async () => {
    await startAndSettle(cm);
    getBridge(cm)._simulateConnect();
    const oldBridge = getBridge(cm);

    getGlobalSettingsMock.mockResolvedValue({
      pairedBridges: [
        { id: 'M4', host: '192.168.1.5', port: 9120 },
        { id: 'M1', host: '192.168.1.6', port: 9120 },
      ],
      activeBridgeId: 'M1',
    });
    loadTokenMock.mockResolvedValue('m1-token');

    await cm.switchActiveBridge('M1');

    expect(oldBridge.disconnect).toHaveBeenCalled();
    const newBridge = getBridge(cm);
    expect(newBridge).not.toBe(oldBridge);
    expect(bridgeCtorCalls[bridgeCtorCalls.length - 1]).toEqual({
      host: '192.168.1.6',
      port: 9120,
      token: 'm1-token',
    });
    expect(newBridge.connect).toHaveBeenCalled();
  });

  // ===== Agent Switching =====

  describe('switchToOpenClaw()', () => {
    it('sends switch_agent command to bridge', async () => {
      await startAndSettle(cm);
      getBridge(cm)._simulateConnect();
      cm.switchToOpenClaw();
      expect(getBridge(cm).send).toHaveBeenCalledWith({
        type: 'switch_agent',
        agent: 'openclaw',
      });
    });
  });

  describe('switchToClaude()', () => {
    it('sends switch_agent command to bridge', async () => {
      await startAndSettle(cm);
      getBridge(cm)._simulateConnect();
      cm.switchToClaude();
      expect(getBridge(cm).send).toHaveBeenCalledWith({
        type: 'switch_agent',
        agent: 'claude-code',
      });
    });
  });

  // ===== Gateway Availability =====

  describe('isGatewayAvailable()', () => {
    it('returns false by default', () => {
      expect(cm.isGatewayAvailable()).toBe(false);
    });

    it('returns true when bridge reports gateway available', () => {
      cm.setBridgeGatewayAvailable(true);
      expect(cm.isGatewayAvailable()).toBe(true);
    });

    it('returns false when bridge reports gateway unavailable', () => {
      cm.setBridgeGatewayAvailable(true);
      cm.setBridgeGatewayAvailable(false);
      expect(cm.isGatewayAvailable()).toBe(false);
    });
  });
});
