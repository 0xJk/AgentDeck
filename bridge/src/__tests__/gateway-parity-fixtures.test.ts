/**
 * Gateway parity fixtures — validate that every JSON frame under
 * `tests/parity/gateway-frames/` conforms to the `GatewayFrame` union defined
 * in `shared/src/gateway-protocol.ts`.
 *
 * These fixtures are the contract the Node and Swift adapters share. A Swift
 * counterpart (`apple/AgentDeckTests/GatewayParityTests.swift`) will decode
 * the same files with `JSONDecoder` and assert the same invariants.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { GatewayFrame } from '@agentdeck/shared';

const FIXTURE_DIR = join(__dirname, '../../../tests/parity/gateway-frames');

function loadFixtures(): Array<{ name: string; frame: unknown }> {
  const names = readdirSync(FIXTURE_DIR).filter((n) => n.endsWith('.json'));
  return names.map((name) => ({
    name,
    frame: JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf-8')) as unknown,
  }));
}

describe('Gateway parity fixtures', () => {
  const fixtures = loadFixtures();

  it('fixture set is non-empty', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it.each(fixtures)('$name carries a valid frame discriminator', ({ frame }) => {
    expect(frame).toBeTypeOf('object');
    const f = frame as { type?: string };
    expect(['req', 'res', 'event']).toContain(f.type);
  });

  it.each(fixtures)('$name conforms to its frame shape', ({ frame }) => {
    const f = frame as GatewayFrame;
    switch (f.type) {
      case 'req': {
        expect(typeof f.id).toBe('string');
        expect(typeof f.method).toBe('string');
        expect(f.params).toBeTypeOf('object');
        break;
      }
      case 'res': {
        expect(typeof f.id).toBe('string');
        expect(typeof f.ok).toBe('boolean');
        if (f.ok) {
          expect(f.payload).toBeDefined();
        } else {
          expect(f.error).toBeDefined();
          expect(typeof f.error?.code).toBe('string');
          expect(typeof f.error?.message).toBe('string');
        }
        break;
      }
      case 'event': {
        expect(typeof f.event).toBe('string');
        expect(f.payload).toBeTypeOf('object');
        break;
      }
    }
  });

  it('chat-final fixture carries the final-state fields the adapter depends on', () => {
    const fixture = fixtures.find((f) => f.name === 'chat-final-with-tools.json');
    expect(fixture).toBeDefined();
    const f = fixture!.frame as GatewayFrame;
    expect(f.type).toBe('event');
    if (f.type !== 'event') return;
    expect(f.event).toBe('chat');
    const p = f.payload as { state?: string; response?: string; tools?: unknown[]; modelId?: string };
    expect(p.state).toBe('final');
    expect(typeof p.response).toBe('string');
    expect(Array.isArray(p.tools)).toBe(true);
    expect(typeof p.modelId).toBe('string');
  });

  it('exec.approval.requested fixture exposes options for the user prompt', () => {
    const fixture = fixtures.find((f) => f.name === 'exec-approval-requested.json');
    expect(fixture).toBeDefined();
    const f = fixture!.frame as GatewayFrame;
    expect(f.type).toBe('event');
    if (f.type !== 'event') return;
    expect(f.event).toBe('exec.approval.requested');
    const p = f.payload as { id?: string; options?: Array<{ key: string; label: string }> };
    expect(typeof p.id).toBe('string');
    expect(Array.isArray(p.options)).toBe(true);
    expect(p.options!.length).toBeGreaterThanOrEqual(2);
    for (const opt of p.options!) {
      expect(typeof opt.key).toBe('string');
      expect(typeof opt.label).toBe('string');
    }
  });
});
