import { describe, expect, it } from 'vitest';
import { computeCenterSlot, computeCenterCluster } from '../center-slot.js';
import type { DeckLayout } from '../session-slot-manager.js';

function layout(columns: number, rows: number, family: string): DeckLayout {
  return { columns, rows, keyCount: columns * rows, family };
}

describe('computeCenterSlot', () => {
  it('SD+ 4x2 → bottom-center', () => {
    expect(computeCenterSlot(layout(4, 2, 'streamdeckplus'))).toBe(6);
  });

  it('SD MK2 5x3 → true geometric center', () => {
    expect(computeCenterSlot(layout(5, 3, 'streamdeck'))).toBe(7);
  });

  it('SD XL 8x4 → middle row, mid column', () => {
    expect(computeCenterSlot(layout(8, 4, 'streamdeckxl'))).toBe(20);
  });

  it('SD Mini 3x2 → bottom-center', () => {
    expect(computeCenterSlot(layout(3, 2, 'streamdeckmini'))).toBe(4);
  });

  it('single key device → slot 0', () => {
    expect(computeCenterSlot(layout(1, 1, 'streamdeck'))).toBe(0);
  });

  it('clamps degenerate zero rows/cols to slot 0', () => {
    expect(computeCenterSlot({ columns: 0, rows: 0, keyCount: 0, family: 'streamdeck' })).toBe(0);
  });
});

describe('computeCenterCluster', () => {
  it('SD+ 4x2 → 2x2 cluster on geometric center (slots 1,2,5,6)', () => {
    const cluster = computeCenterCluster(layout(4, 2, 'streamdeckplus'));
    expect(cluster.slots).toEqual([1, 2, 5, 6]);
    expect(cluster.quadrantFor(1)).toBe('tl');
    expect(cluster.quadrantFor(2)).toBe('tr');
    expect(cluster.quadrantFor(5)).toBe('bl');
    expect(cluster.quadrantFor(6)).toBe('br');
    expect(cluster.quadrantFor(0)).toBe(null);
    expect(cluster.quadrantFor(7)).toBe(null);
  });

  it('SD XL 8x4 → 2x2 cluster on geometric center (slots 11,12,19,20)', () => {
    const cluster = computeCenterCluster(layout(8, 4, 'streamdeckxl'));
    expect(cluster.slots).toEqual([11, 12, 19, 20]);
    expect(cluster.quadrantFor(11)).toBe('tl');
    expect(cluster.quadrantFor(12)).toBe('tr');
    expect(cluster.quadrantFor(19)).toBe('bl');
    expect(cluster.quadrantFor(20)).toBe('br');
  });

  it('SD MK2 5x3 → single full hero on slot 7', () => {
    const cluster = computeCenterCluster(layout(5, 3, 'streamdeck'));
    expect(cluster.slots).toEqual([7]);
    expect(cluster.quadrantFor(7)).toBe('full');
    expect(cluster.quadrantFor(6)).toBe(null);
  });

  it('SD Mini 3x2 (odd cols) → single full hero on slot 4', () => {
    const cluster = computeCenterCluster(layout(3, 2, 'streamdeckmini'));
    expect(cluster.slots).toEqual([4]);
    expect(cluster.quadrantFor(4)).toBe('full');
  });

  it('single-key device → single full hero on slot 0', () => {
    const cluster = computeCenterCluster(layout(1, 1, 'streamdeck'));
    expect(cluster.slots).toEqual([0]);
    expect(cluster.quadrantFor(0)).toBe('full');
  });

  it('degenerate zero dimensions → single hero on slot 0', () => {
    const cluster = computeCenterCluster({ columns: 0, rows: 0, keyCount: 0, family: 'streamdeck' });
    expect(cluster.slots).toEqual([0]);
    expect(cluster.quadrantFor(0)).toBe('full');
  });
});
