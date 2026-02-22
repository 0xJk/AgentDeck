import { describe, it, expect, vi, beforeEach } from 'vitest';
import { measureTextWidth, wrapTextByWidth, isWide } from '../renderers/text-utils.js';
import { renderButton, labelNeedsHaiku, BUTTON_MAX_CHARS } from '../renderers/button-renderer.js';

// Mock label-summarizer to avoid real API calls
vi.mock('../label-summarizer.js', () => ({
  getCachedLabel: vi.fn(() => null),
  requestAbbreviation: vi.fn(async () => null),
}));

import { getCachedLabel } from '../label-summarizer.js';
const mockedGetCachedLabel = vi.mocked(getCachedLabel);

describe('text-utils: CJK width measurement', () => {
  it('Latin text is ~0.55em per char', () => {
    const w = measureTextWidth('Hello', 20);
    expect(w).toBeCloseTo(20 * 0.55 * 5, 0);
  });

  it('Korean text is 1em per char (double-width)', () => {
    const w = measureTextWidth('안녕하세요', 20);
    expect(w).toBe(20 * 5); // 5 chars × 1em
  });

  it('mixed text measures correctly', () => {
    const w = measureTextWidth('Hi 안녕', 20);
    // H(11) + i(11) + space(11) + 안(20) + 녕(20) = 73
    expect(w).toBeCloseTo(11 + 11 + 11 + 20 + 20, 0);
  });

  it('isWide detects Hangul, CJK, fullwidth', () => {
    expect(isWide('한'.charCodeAt(0))).toBe(true);
    expect(isWide('漢'.charCodeAt(0))).toBe(true);
    expect(isWide('A'.charCodeAt(0))).toBe(false);
    expect(isWide('1'.charCodeAt(0))).toBe(false);
  });
});

describe('text-utils: wrapTextByWidth', () => {
  it('short text returns single line', () => {
    const lines = wrapTextByWidth('Yes', 124, 20);
    expect(lines).toEqual(['Yes']);
  });

  it('long Latin text wraps to multiple lines', () => {
    const lines = wrapTextByWidth('Yes I trust this folder completely', 124, 20);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(measureTextWidth(line, 20)).toBeLessThanOrEqual(124 + 20); // allow slight overshoot from word
    }
  });

  it('Korean text wraps at correct pixel width', () => {
    // 6 Korean chars at 20px = 120px, fits in 124px
    // 7 Korean chars = 140px, should wrap
    const lines = wrapTextByWidth('가나다라마바사아자차', 124, 20);
    expect(lines.length).toBeGreaterThan(1);
  });
});

describe('button-renderer: abbreviation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetCachedLabel.mockReturnValue(null);
  });

  it('short label renders without abbreviation indicator', () => {
    const svg = renderButton({
      title: 'Yes',
      color: '#166534',
      textColor: '#ffffff',
      enabled: true,
    });
    expect(svg).toContain('Yes');
    expect(svg).not.toContain('opacity="0.3">~</text>');
  });

  it('"Yes, I trust this folder" fits with wrapping (no abbreviation needed)', () => {
    const svg = renderButton({
      title: 'Yes, I trust this folder',
      color: '#166534',
      textColor: '#ffffff',
      enabled: true,
    });
    // At 20px font, this wraps into 2 lines and fits without abbreviation
    expect(svg).toContain('this folder');
    expect(svg).not.toContain('opacity="0.3">~</text>');
  });

  it('"Yes, allow and don\'t ask again" wraps into 3 lines', () => {
    const svg = renderButton({
      title: "Yes, allow and don't ask again",
      color: '#166534',
      textColor: '#ffffff',
      enabled: true,
    });
    // Fits in 3 lines at 20px, no abbreviation needed
    expect(svg).toContain('ask again');
  });

  it('very long label triggers abbreviation with ~ indicator', () => {
    const svg = renderButton({
      title: 'This is an extremely long option label that definitely overflows',
      color: '#166534',
      textColor: '#ffffff',
      enabled: true,
    });
    expect(svg).toContain('opacity="0.3">~</text>');
  });

  it('short permission labels like "No" render unchanged', () => {
    const svg = renderButton({
      title: 'No',
      color: '#991b1b',
      textColor: '#ffffff',
      enabled: true,
    });
    expect(svg).toContain('>No<');
    expect(svg).not.toContain('opacity="0.3">~</text>');
  });

  it('labelNeedsHaiku returns false for short labels', () => {
    expect(labelNeedsHaiku('Yes')).toBe(false);
    expect(labelNeedsHaiku('No')).toBe(false);
  });

  it('labelNeedsHaiku returns false when heuristic abbreviation fits', () => {
    expect(labelNeedsHaiku('Yes, I trust this folder')).toBe(false); // → "Trust folder" fits
  });

  it('labelNeedsHaiku returns true for very long unknown labels', () => {
    const longLabel = 'This is an extremely long option label that cannot be abbreviated by any known pattern';
    expect(labelNeedsHaiku(longLabel)).toBe(true);
  });

  it('labelNeedsHaiku returns false when Haiku cache has result', () => {
    const longLabel = 'This is an extremely long option label that cannot be abbreviated by any known pattern';
    mockedGetCachedLabel.mockReturnValue('Long option');
    expect(labelNeedsHaiku(longLabel)).toBe(false);
  });

  it('BUTTON_MAX_CHARS is reasonable', () => {
    expect(BUTTON_MAX_CHARS).toBeGreaterThan(10);
    expect(BUTTON_MAX_CHARS).toBeLessThan(50);
  });
});

describe('button-renderer: CJK labels', () => {
  it('Korean label does not overflow (produces valid SVG)', () => {
    const svg = renderButton({
      title: '이 폴더를 신뢰합니다',
      color: '#166534',
      textColor: '#ffffff',
      enabled: true,
    });
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
    // Should render something meaningful
    expect(svg).toContain('font-size=');
  });

  it('mixed CJK/Latin label renders', () => {
    const svg = renderButton({
      title: 'Allow 실행',
      color: '#166534',
      textColor: '#ffffff',
      enabled: true,
    });
    expect(svg).toContain('Allow');
  });
});
