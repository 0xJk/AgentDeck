import { describe, it, expect, vi, beforeEach } from 'vitest';
import { State, PermissionMode, OPENCLAW_CAPABILITIES } from '@agentdeck/shared';
import type { StateUpdateEvent, PluginCommand } from '@agentdeck/shared';

// ---- Mocks ----

// Mock BridgeClient
vi.mock('../bridge-client.js', async () => {
  const { EventEmitter } = await import('events');

  class MockBridgeClient extends EventEmitter {
    _connected = false;
    _port = 9120;
    _portProvider: (() => number | null) | null = null;

    connect(port?: number) {
      if (port != null) this._port = port;
    }
    reconnectTo(port: number) {
      this._port = port;
    }
    disconnect() {
      this._connected = false;
      this.emit('disconnected');
    }
    setPortProvider(provider: (() => number | null) | null) {
      this._portProvider = provider;
    }
    send = vi.fn();
    isConnected() { return this._connected; }
    getCapabilities() { return null; }
    getPort() { return this._port; }

    // Test helpers
    _simulateConnect() {
      this._connected = true;
      this.emit('connected');
    }
    _simulateDisconnect() {
      this._connected = false;
      this.emit('disconnected');
    }
    _simulateStateUpdate(ev: StateUpdateEvent) {
      this.emit('state_update', ev);
    }
  }
  return { BridgeClient: MockBridgeClient };
});

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

describe('ConnectionManager', () => {
  let cm: ConnectionManager;

  beforeEach(() => {
    cm = new ConnectionManager();
  });

  it('starts disconnected', () => {
    expect(cm.isConnected()).toBe(false);
    expect(cm.getCapabilities()).toBeNull();
  });

  it('start() begins bridge connection to daemon', () => {
    const bridge = getBridge(cm);
    const bridgeConnect = vi.spyOn(bridge, 'connect');

    cm.start();

    expect(bridgeConnect).toHaveBeenCalled();
  });

  it('start() installs a port provider so daemon.json is re-read every attempt', () => {
    const bridge = getBridge(cm);
    cm.start();
    // Provider is wired — BridgeClient will invoke it per attempt.
    // We only verify the wire-up; the actual fs read is exercised in integration tests.
    expect(typeof bridge._portProvider).toBe('function');
  });

  it('emits connected when bridge connects', () => {
    const events: string[] = [];
    cm.on('connected', () => events.push('connected'));

    cm.start();
    getBridge(cm)._simulateConnect();

    expect(cm.isConnected()).toBe(true);
    expect(events).toContain('connected');
  });

  it('emits disconnected when bridge disconnects', () => {
    const events: string[] = [];
    cm.on('disconnected', () => events.push('disconnected'));

    cm.start();
    getBridge(cm)._simulateConnect();
    getBridge(cm)._simulateDisconnect();

    expect(events).toContain('disconnected');
  });

  it('forwards state_update from bridge', () => {
    const received: StateUpdateEvent[] = [];
    cm.on('state_update', (ev: StateUpdateEvent) => received.push(ev));

    cm.start();
    getBridge(cm)._simulateConnect();

    const ev = makeStateUpdate(State.IDLE, 'openclaw');
    getBridge(cm)._simulateStateUpdate(ev);

    expect(received).toHaveLength(1);
    expect(received[0].state).toBe(State.IDLE);
  });

  it('send() delegates to bridge', () => {
    cm.start();
    getBridge(cm)._simulateConnect();

    const cmd: PluginCommand = { type: 'interrupt' };
    cm.send(cmd);

    expect(getBridge(cm).send).toHaveBeenCalledWith(cmd);
  });

  it('send() drops command when not connected', () => {
    const cmd: PluginCommand = { type: 'interrupt' };
    cm.send(cmd);

    expect(getBridge(cm).send).not.toHaveBeenCalled();
  });

  it('getBridgePort returns bridge port', () => {
    expect(cm.getBridgePort()).toBe(9120);
  });

  // ===== Agent Switching =====

  describe('switchToOpenClaw()', () => {
    it('sends switch_agent command to bridge', () => {
      cm.start();
      getBridge(cm)._simulateConnect();

      cm.switchToOpenClaw();

      expect(getBridge(cm).send).toHaveBeenCalledWith({
        type: 'switch_agent',
        agent: 'openclaw',
      });
    });
  });

  describe('switchToClaude()', () => {
    it('sends switch_agent command to bridge', () => {
      cm.start();
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
