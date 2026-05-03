import { describe, expect, it } from 'vitest';
import { computeCenterSlot } from '../center-slot.js';
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
