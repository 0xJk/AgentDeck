import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

import { computeSetupRequired } from '../bridge-settings.js';

describe('detectSetupState (test 14) — driven by pairedBridges.length', () => {
  it('setupRequired = true when there are no paired bridges', () => {
    expect(computeSetupRequired({ pairedBridges: [], activeBridgeId: null })).toBe(true);
  });

  it('setupRequired = false when at least one bridge is paired', () => {
    expect(
      computeSetupRequired({
        pairedBridges: [{ id: 'M4', host: '192.168.1.5', port: 9120 }],
        activeBridgeId: null,
      }),
    ).toBe(false);
  });

  it('setupRequired is purely a function of pairedBridges.length (>0 => false)', () => {
    const result = computeSetupRequired({
      pairedBridges: [
        { id: 'M4', host: '192.168.1.5', port: 9120 },
        { id: 'M1', host: '192.168.1.6', port: 9120 },
      ],
      activeBridgeId: 'M4',
    });
    expect(result).toBe(false);
  });

  it('plugin.ts detectSetupState no longer probes the local machine', () => {
    // The remote-only topology means setup is driven entirely by pairedBridges.
    // Assert the source no longer reads ~/.agentdeck, runs `which agentdeck`,
    // or calls existsSync/execSync inside detectSetupState (plan 001 §2f).
    const src = readFileSync(join(__dirname, '..', 'plugin.ts'), 'utf-8');
    const fn = src.slice(
      src.indexOf('function detectSetupState'),
      src.indexOf('function propagateSetupRequired'),
    );
    expect(fn).not.toMatch(/\.agentdeck/);
    expect(fn).not.toMatch(/which agentdeck/);
    expect(fn).not.toMatch(/existsSync/);
    expect(fn).not.toMatch(/execSync/);
    // It must instead compute from globalSettings / pairedBridges.
    expect(fn.includes('computeSetupRequired') || fn.includes('pairedBridges')).toBe(true);
  });
});
