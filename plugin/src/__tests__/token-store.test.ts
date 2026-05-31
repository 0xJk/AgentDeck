import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- mock @napi-rs/keyring ----------------------------------------------------
// A fake sync `Entry` whose per-instance behaviour we can steer from each test.
// The mock records every constructor call (service + account) and every method
// invocation so we can assert SERVICE + bridgeId wiring.
//
// Everything the hoisted vi.mock factory touches must itself be hoisted, so the
// shared recorder state + steerable behaviour live in a vi.hoisted() block.

const h = vi.hoisted(() => {
  type FakeEntryBehaviour = {
    getPassword?: () => string | null;
    setPassword?: (token: string) => void;
    deletePassword?: () => boolean;
  };

  const state = {
    entryConstructorCalls: [] as Array<{ service: string; account: string }>,
    setPasswordCalls: [] as Array<{ account: string; token: string }>,
    getPasswordCalls: [] as string[],
    deletePasswordCalls: [] as string[],
    // Default behaviour: empty keychain (missing-entry semantics from the probe).
    behaviour: {} as FakeEntryBehaviour,
  };

  class FakeEntry {
    constructor(
      public readonly service: string,
      public readonly account: string,
    ) {
      state.entryConstructorCalls.push({ service, account });
    }

    setPassword(token: string): void {
      state.setPasswordCalls.push({ account: this.account, token });
      state.behaviour.setPassword?.(token);
    }

    getPassword(): string | null {
      state.getPasswordCalls.push(this.account);
      // Probe contract: missing entry -> null (no throw).
      return state.behaviour.getPassword ? state.behaviour.getPassword() : null;
    }

    deletePassword(): boolean {
      state.deletePasswordCalls.push(this.account);
      // Probe contract: missing entry -> false (no throw).
      return state.behaviour.deletePassword ? state.behaviour.deletePassword() : false;
    }
  }

  return { state, FakeEntry };
});

vi.mock('@napi-rs/keyring', () => ({
  Entry: h.FakeEntry,
}));

// Import AFTER vi.mock so the module under test binds to the fake.
import { saveToken, loadToken, deleteToken } from '../token-store.js';

const SERVICE = 'com.agentdeck.plugin';

beforeEach(() => {
  h.state.entryConstructorCalls.length = 0;
  h.state.setPasswordCalls.length = 0;
  h.state.getPasswordCalls.length = 0;
  h.state.deletePasswordCalls.length = 0;
  h.state.behaviour = {};
});

describe('token-store (test 8: save/load/delete wire SERVICE + bridgeId)', () => {
  it('saveToken constructs Entry(SERVICE, bridgeId) and calls setPassword', async () => {
    await saveToken('M4', 'secret-token');

    expect(h.state.entryConstructorCalls).toContainEqual({ service: SERVICE, account: 'M4' });
    expect(h.state.setPasswordCalls).toContainEqual({ account: 'M4', token: 'secret-token' });
  });

  it('loadToken constructs Entry(SERVICE, bridgeId) and calls getPassword', async () => {
    h.state.behaviour = { getPassword: () => 'stored-token' };

    const result = await loadToken('M1');

    expect(h.state.entryConstructorCalls).toContainEqual({ service: SERVICE, account: 'M1' });
    expect(h.state.getPasswordCalls).toContain('M1');
    expect(result).toBe('stored-token');
  });

  it('deleteToken constructs Entry(SERVICE, bridgeId) and calls deletePassword', async () => {
    h.state.behaviour = { deletePassword: () => true };

    await deleteToken('M4');

    expect(h.state.entryConstructorCalls).toContainEqual({ service: SERVICE, account: 'M4' });
    expect(h.state.deletePasswordCalls).toContain('M4');
  });
});

describe('token-store (test 9: save trims token before setPassword)', () => {
  it('trims surrounding whitespace/newlines before storing', async () => {
    await saveToken('M4', '  tok-with-spaces\n');

    expect(h.state.setPasswordCalls).toContainEqual({ account: 'M4', token: 'tok-with-spaces' });
  });

  it('trims tabs and trailing CR', async () => {
    await saveToken('M1', '\t padded \r');

    expect(h.state.setPasswordCalls).toContainEqual({ account: 'M1', token: 'padded' });
  });
});

describe('token-store (test 10: not-found handling + error re-throw)', () => {
  it('loadToken returns null when getPassword signals not-found (returns null)', async () => {
    h.state.behaviour = { getPassword: () => null };

    const result = await loadToken('absent');

    expect(result).toBeNull();
  });

  it('loadToken returns null when keyring throws a NoEntry error', async () => {
    h.state.behaviour = {
      getPassword: () => {
        const err = Object.assign(new Error('No matching entry found in secure storage'), {
          code: 'NoEntry',
        });
        throw err;
      },
    };

    const result = await loadToken('absent');

    expect(result).toBeNull();
  });

  it('loadToken re-throws non-not-found errors (e.g. keychain access denied)', async () => {
    h.state.behaviour = {
      getPassword: () => {
        throw new Error('User interaction is not allowed (keychain locked)');
      },
    };

    await expect(loadToken('M4')).rejects.toThrow(/keychain locked/);
  });

  it('deleteToken swallows not-found (deletePassword returns false, no throw)', async () => {
    h.state.behaviour = { deletePassword: () => false };

    await expect(deleteToken('absent')).resolves.toBeUndefined();
  });

  it('deleteToken swallows a thrown NoEntry error', async () => {
    h.state.behaviour = {
      deletePassword: () => {
        const err = Object.assign(new Error('no entry found'), { code: 'NoEntry' });
        throw err;
      },
    };

    await expect(deleteToken('absent')).resolves.toBeUndefined();
  });

  it('deleteToken re-throws non-not-found errors', async () => {
    h.state.behaviour = {
      deletePassword: () => {
        throw new Error('User interaction is not allowed (keychain locked)');
      },
    };

    await expect(deleteToken('M4')).rejects.toThrow(/keychain locked/);
  });
});
