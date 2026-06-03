/**
 * Option dial selection-index resolution (interaction follow-up bug).
 *
 * Bug: rotating to the last option ("Chat about this") and back got stuck — the
 * carousel re-emits prompt_options constantly, each echoing a stale PTY
 * cursorIndex that overwrote the user's local navigation. Fix: on a redraw of
 * the SAME prompt, local navigation is authoritative; only adopt the PTY cursor
 * on a genuinely new prompt.
 */
import { describe, it, expect } from 'vitest';
import { resolveSelectedIndex, optionsSignature } from '../option-nav.js';

describe('resolveSelectedIndex', () => {
  it('adopts the PTY cursor on a new prompt', () => {
    expect(resolveSelectedIndex(0, 2, true, 5)).toBe(2);
  });

  it('defaults to 0 on a new prompt with no/invalid cursor', () => {
    expect(resolveSelectedIndex(3, undefined, true, 5)).toBe(0);
    expect(resolveSelectedIndex(3, 9, true, 5)).toBe(0); // out of range
    expect(resolveSelectedIndex(3, -1, true, 5)).toBe(0);
  });

  it('keeps the local index on a redraw of the same prompt (ignores stale cursor)', () => {
    // User navigated up to 3; carousel redraw echoes stale cursor=4 → must NOT pull back.
    expect(resolveSelectedIndex(3, 4, false, 5)).toBe(3);
    // The exact stuck case: at the bottom, navigate up to 3, stale cursor still 4.
    expect(resolveSelectedIndex(3, 4, false, 5)).toBe(3);
  });

  it('clamps the local index into range on same-prompt redraw', () => {
    expect(resolveSelectedIndex(9, 0, false, 5)).toBe(4);
    expect(resolveSelectedIndex(-2, 0, false, 5)).toBe(0);
  });

  it('returns 0 when there are no options', () => {
    expect(resolveSelectedIndex(3, 1, false, 0)).toBe(0);
  });
});

describe('optionsSignature', () => {
  it('is equal for the same labels and differs when labels change', () => {
    expect(optionsSignature(['A', 'B', 'C'])).toBe(optionsSignature(['A', 'B', 'C']));
    expect(optionsSignature(['A', 'B'])).not.toBe(optionsSignature(['A', 'B', 'C']));
    expect(optionsSignature(['A', 'B'])).not.toBe(optionsSignature(['A', 'X']));
  });
});

import { shouldSwitchCard } from '../option-nav.js';

describe('shouldSwitchCard (carousel dial routing)', () => {
  it('switches question cards when in a carousel even if the current card is single-select', () => {
    // Bug 1: a single-select card has no checked fields → isMultiSelect false,
    // but the context dial must still switch cards because we are in a carousel.
    expect(shouldSwitchCard(true, false)).toBe(true);
  });
  it('switches cards for a multi-select carousel card', () => {
    expect(shouldSwitchCard(true, true)).toBe(true);
  });
  it('does NOT switch cards for a plain single-question multi-select (no carousel)', () => {
    // A single-question multi-select toggles in place; the dial navigates options.
    expect(shouldSwitchCard(false, true)).toBe(false);
  });
  it('does NOT switch cards for a plain numbered single-select', () => {
    expect(shouldSwitchCard(false, false)).toBe(false);
  });
});

import { mergeCarouselChecked } from '../option-nav.js';
import type { PromptOption } from '@agentdeck/shared';

describe('mergeCarouselChecked (plugin owns multi-select checked state)', () => {
  it('overrides parser checked with the locally-remembered toggle state', () => {
    // The PTY only ever reports [ ] (unchecked) for an option whose ☒ was painted
    // via a CUP overwrite the linear parser cannot see. The plugin remembers the
    // user's toggle and must keep showing it on every redraw.
    const opts: PromptOption[] = [
      { index: 0, label: '继续测试', checked: false },
      { index: 1, label: '停止测试', checked: false },
    ];
    const remembered = new Map([['继续测试', true]]);
    const merged = mergeCarouselChecked(opts, remembered);
    expect(merged[0].checked).toBe(true);   // remembered toggle wins
    expect(merged[1].checked).toBe(false);  // untouched
  });
  it('leaves options without a remembered entry unchanged', () => {
    const opts: PromptOption[] = [{ index: 0, label: 'A', checked: false }];
    expect(mergeCarouselChecked(opts, new Map())[0].checked).toBe(false);
  });
  it('does not add checked to single-select options (checked undefined)', () => {
    const opts: PromptOption[] = [{ index: 0, label: 'macOS' }];
    const merged = mergeCarouselChecked(opts, new Map([['macOS', true]]));
    expect(merged[0].checked).toBeUndefined();
  });
});
