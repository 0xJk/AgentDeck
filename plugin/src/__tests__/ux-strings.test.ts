import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Plan section 2f / test 15: remote-friendly UX copy.
// In a remote Stream Deck context the desktop app is not the entry point —
// setup copy must guide the user to the Property Inspector (PI), never tell
// them to "install", "launch", or "Open AgentDeck".

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(resolve(here, '..', rel), 'utf8');

const utilityRenderer = read('renderers/utility-renderer.ts');
const responseRenderer = read('renderers/response-renderer.ts');
const sessionSlotButton = read('actions/session-slot-button.ts');

const allSources: Array<[string, string]> = [
  ['utility-renderer.ts', utilityRenderer],
  ['response-renderer.ts', responseRenderer],
  ['session-slot-button.ts', sessionSlotButton],
];

describe('remote-friendly UX copy (plan 2f / test 15)', () => {
  it('contains no desktop-centric "Open AgentDeck" copy', () => {
    for (const [name, src] of allSources) {
      expect(src, `${name} should not say "Open AgentDeck"`).not.toContain('Open AgentDeck');
    }
  });

  it('contains no "Push START" setup copy', () => {
    for (const [name, src] of allSources) {
      expect(src, `${name} should not say "Push START"`).not.toContain('Push START');
    }
  });

  it('contains no standalone "INSTALL" setup copy', () => {
    for (const [name, src] of allSources) {
      expect(src, `${name} should not contain INSTALL setup copy`).not.toContain('INSTALL');
    }
  });

  it('never instructs the user to install or launch', () => {
    for (const [name, src] of allSources) {
      expect(src.toLowerCase(), `${name} should not mention "install"`).not.toContain('install');
      expect(src.toLowerCase(), `${name} should not mention "launch"`).not.toContain('launch');
    }
  });

  it('points the setup utility tile at the Property Inspector', () => {
    expect(utilityRenderer).toContain('Open PI');
  });

  it('points the no-bridge response tile at the Property Inspector', () => {
    expect(responseRenderer).toContain('NO BRIDGE');
    expect(responseRenderer).toContain('Open PI');
  });

  it('points the offline session slot subtitle at the Property Inspector', () => {
    expect(sessionSlotButton).toContain('Open PI to pair');
  });
});
