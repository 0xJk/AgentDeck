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
    scanLatestPort: (() => number | undefined) | null = null;

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

// Mock GatewayClient
vi.mock('../gateway-client.js', async () => {
  const { EventEmitter } = await import('events');
  const { OPENCLAW_CAPABILITIES: caps } = await import('@agentdeck/shared');

  class MockGatewayClient extends EventEmitter {
    _connected = false;

    connect() {}
    pause() { this._connected = false; }
    resume() {}
    disconnect() {
      this._connected = false;
      this.emit('disconnected');
    }
    send = vi.fn();
    isConnected() { return this._connected; }
    getCapabilities() { return this._connected ? caps : null; }

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
  return { GatewayClient: MockGatewayClient };
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

// Helper to access internal mocks
function getBridge(cm: ConnectionManager): any {
  return (cm as any).bridge;
}
function getGateway(cm: ConnectionManager): any {
  return (cm as any).gateway;
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

  it('start() begins both bridge and gateway connections', () => {
    const bridge = getBridge(cm);
    const gateway = getGateway(cm);
    const bridgeConnect = vi.spyOn(bridge, 'connect');
    const gatewayConnect = vi.spyOn(gateway, 'connect');

    cm.start(9125);

    expect(bridgeConnect).toHaveBeenCalledWith(9125);
    expect(gatewayConnect).toHaveBeenCalled();
  });

  it('activates bridge when bridge connects first', () => {
    const events: string[] = [];
    cm.on('connected', () => events.push('connected'));

    cm.start();
    getBridge(cm)._simulateConnect();

    expect(cm.isConnected()).toBe(true);
    expect(events).toContain('connected');
  });

  it('activates gateway when only gateway connects', () => {
    const events: string[] = [];
    cm.on('connected', () => events.push('connected'));

    cm.start();
    getGateway(cm)._simulateConnect();

    expect(cm.isConnected()).toBe(true);
    expect(events).toContain('connected');
  });

  it('pauses gateway when bridge connects later', () => {
    cm.start();

    // Gateway connects first
    getGateway(cm)._simulateConnect();
    expect(cm.isConnected()).toBe(true);

    const pauseSpy = vi.spyOn(getGateway(cm), 'pause');

    // Bridge connects — should take priority
    getBridge(cm)._simulateConnect();
    expect(cm.isConnected()).toBe(true);
    expect(pauseSpy).toHaveBeenCalled();
  });

  it('falls back to gateway when bridge disconnects', () => {
    cm.start();

    // Bridge connects
    getBridge(cm)._simulateConnect();

    const gateway = getGateway(cm);
    const resumeSpy = vi.spyOn(gateway, 'resume');

    // Manually set gateway as connected for the fallback check
    gateway._connected = true;

    // Bridge disconnects
    getBridge(cm)._simulateDisconnect();

    expect(resumeSpy).toHaveBeenCalled();
    expect(cm.isConnected()).toBe(true);
  });

  it('emits disconnected when both are down', () => {
    const events: string[] = [];
    cm.on('disconnected', () => events.push('disconnected'));

    cm.start();

    // Gateway connects then disconnects
    getGateway(cm)._simulateConnect();
    getGateway(cm)._simulateDisconnect();

    expect(events).toContain('disconnected');
  });

  it('forwards state_update from active link only', () => {
    const received: StateUpdateEvent[] = [];
    cm.on('state_update', (ev: StateUpdateEvent) => received.push(ev));

    cm.start();

    // Gateway connects and becomes active
    getGateway(cm)._simulateConnect();

    // Gateway sends state update — should be forwarded
    const gwEvent = makeStateUpdate(State.IDLE, 'openclaw');
    getGateway(cm)._simulateStateUpdate(gwEvent);
    expect(received).toHaveLength(1);
    expect(received[0].state).toBe(State.IDLE);

    // Bridge sends state update while not active — should NOT be forwarded
    const brEvent = makeStateUpdate(State.PROCESSING);
    getBridge(cm)._simulateStateUpdate(brEvent);
    expect(received).toHaveLength(1); // still 1
  });

  it('send() delegates to active link', () => {
    cm.start();
    getGateway(cm)._simulateConnect();

    const cmd: PluginCommand = { type: 'interrupt' };
    cm.send(cmd);

    expect(getGateway(cm).send).toHaveBeenCalledWith(cmd);
    expect(getBridge(cm).send).not.toHaveBeenCalled();
  });

  it('send() delegates to bridge after switch', () => {
    cm.start();
    getGateway(cm)._simulateConnect();
    getBridge(cm)._simulateConnect();

    const cmd: PluginCommand = { type: 'interrupt' };
    cm.send(cmd);

    expect(getBridge(cm).send).toHaveBeenCalledWith(cmd);
  });

  it('reconnectBridgeTo delegates to bridge', () => {
    const reconnectSpy = vi.spyOn(getBridge(cm), 'reconnectTo');
    cm.reconnectBridgeTo(9125);
    expect(reconnectSpy).toHaveBeenCalledWith(9125);
  });

  it('getBridgePort returns bridge port', () => {
    expect(cm.getBridgePort()).toBe(9120);
  });

  it('scanLatestPort setter delegates to bridge', () => {
    const fn = () => 9130;
    cm.scanLatestPort = fn;
    expect(getBridge(cm).scanLatestPort).toBe(fn);
  });

  // ===== Agent Selection API =====

  describe('activateGateway()', () => {
    it('sets activeLink to gateway and emits active_agent_changed', () => {
      const events: string[] = [];
      cm.on('active_agent_changed', (type: string) => events.push(type));

      cm.start();
      getGateway(cm)._simulateConnect();
      getBridge(cm)._simulateConnect(); // bridge takes priority automatically

      // Now explicitly activate gateway
      cm.activateGateway();

      expect(cm.getActiveAgentType()).toBe('openclaw');
      expect(events).toContain('openclaw');
    });

    it('prevents bridge from auto-switching when user selected gateway', () => {
      cm.start();
      getGateway(cm)._simulateConnect();
      cm.activateGateway();

      // Bridge connects but should NOT take priority
      getBridge(cm)._simulateConnect();

      expect(cm.getActiveAgentType()).toBe('openclaw');
    });
  });

  describe('activateBridge()', () => {
    it('sets activeLink to bridge and pauses gateway', () => {
      const events: string[] = [];
      cm.on('active_agent_changed', (type: string) => events.push(type));

      cm.start();
      getGateway(cm)._simulateConnect();
      const pauseSpy = vi.spyOn(getGateway(cm), 'pause');

      cm.activateBridge();

      expect(cm.getActiveAgentType()).toBe('claude-code');
      expect(pauseSpy).toHaveBeenCalled();
      expect(events).toContain('claude-code');
    });
  });

  describe('isStandby()', () => {
    it('returns true when auto + no bridge + gateway connected', () => {
      cm.start();
      getGateway(cm)._simulateConnect();

      // auto mode, no bridge, gateway connected → standby
      expect(cm.isStandby()).toBe(true);
    });

    it('returns false when user explicitly selected gateway', () => {
      cm.start();
      getGateway(cm)._simulateConnect();
      cm.activateGateway();

      expect(cm.isStandby()).toBe(false);
    });

    it('returns false when bridge is connected', () => {
      cm.start();
      getGateway(cm)._simulateConnect();
      getBridge(cm)._simulateConnect();

      expect(cm.isStandby()).toBe(false);
    });
  });

  describe('bridge disconnect + userSelection reset', () => {
    it('resets userSelection from bridge to auto on disconnect', () => {
      cm.start();
      getBridge(cm)._simulateConnect();
      cm.activateBridge();

      expect(cm.getUserSelection()).toBe('bridge');

      getBridge(cm)._simulateDisconnect();

      expect(cm.getUserSelection()).toBe('auto');
    });

    it('falls back to gateway after bridge disconnect (was userSelection=bridge)', () => {
      cm.start();
      getBridge(cm)._simulateConnect();
      cm.activateBridge();

      // Gateway becomes available
      getGateway(cm)._connected = true;

      getBridge(cm)._simulateDisconnect();

      expect(cm.getActiveAgentType()).toBe('openclaw');
      expect(cm.isStandby()).toBe(true); // auto + no bridge + gw connected
    });
  });

  describe('gateway disconnect + userSelection reset', () => {
    it('resets userSelection from gateway to auto on disconnect', () => {
      cm.start();
      getGateway(cm)._simulateConnect();
      cm.activateGateway();

      expect(cm.getUserSelection()).toBe('gateway');

      getGateway(cm)._simulateDisconnect();

      expect(cm.getUserSelection()).toBe('auto');
    });
  });

  describe('getActiveAgentType()', () => {
    it('returns null when no link active', () => {
      expect(cm.getActiveAgentType()).toBeNull();
    });

    it('returns claude-code when bridge is active', () => {
      cm.start();
      getBridge(cm)._simulateConnect();
      expect(cm.getActiveAgentType()).toBe('claude-code');
    });

    it('returns openclaw when gateway is active', () => {
      cm.start();
      getGateway(cm)._simulateConnect();
      expect(cm.getActiveAgentType()).toBe('openclaw');
    });
  });

  describe('isGatewayAvailable()', () => {
    it('returns true when gateway connected', () => {
      cm.start();
      getGateway(cm)._simulateConnect();
      expect(cm.isGatewayAvailable()).toBe(true);
    });

    it('returns true when gateway was previously connected (paused)', () => {
      cm.start();
      getGateway(cm)._simulateConnect(); // sets gatewayEverConnected
      getBridge(cm)._simulateConnect(); // pauses gateway
      // Gateway is now paused (not connected), but was previously connected
      expect(getGateway(cm).isConnected()).toBe(false);
      expect(cm.isGatewayAvailable()).toBe(true);
    });

    it('returns false when gateway never connected', () => {
      expect(cm.isGatewayAvailable()).toBe(false);
    });
  });

  describe('activateGateway() + reconnect', () => {
    it('activates gateway on reconnect even when bridge is connected', () => {
      const events: string[] = [];
      cm.on('connected', () => events.push('connected'));

      cm.start();
      getBridge(cm)._simulateConnect();
      getGateway(cm)._simulateConnect(); // paused by bridge

      cm.activateGateway();

      // Simulate gateway reconnecting after resume
      getGateway(cm)._connected = true;
      getGateway(cm).emit('connected');

      // Should emit connected even though bridge is also connected
      expect(events.length).toBeGreaterThanOrEqual(2); // bridge + gateway reconnect
      expect(cm.getActiveAgentType()).toBe('openclaw');
    });
  });

  describe('resetToAuto()', () => {
    it('re-evaluates with bridge priority', () => {
      cm.start();
      getBridge(cm)._simulateConnect();
      getGateway(cm)._simulateConnect();
      cm.activateGateway(); // explicitly gateway

      cm.resetToAuto();

      // Bridge should take priority in auto mode
      expect(cm.getActiveAgentType()).toBe('claude-code');
      expect(cm.getUserSelection()).toBe('auto');
    });
  });
});
