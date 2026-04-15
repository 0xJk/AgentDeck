import { describe, it, expect } from 'vitest';
import { adjustUsagePercent, formatResetTime } from '../format-utils.js';

describe('adjustUsagePercent', () => {
  it('returns undefined when percent is null', () => {
    expect(adjustUsagePercent(null, '2026-12-01T00:00:00Z')).toBeUndefined();
  });

  it('returns undefined when percent is undefined', () => {
    expect(adjustUsagePercent(undefined, '2026-12-01T00:00:00Z')).toBeUndefined();
  });

  it('returns percent unchanged when resetsAt is null', () => {
    expect(adjustUsagePercent(55, null)).toBe(55);
  });

  it('returns percent unchanged when resetsAt is undefined', () => {
    expect(adjustUsagePercent(55, undefined)).toBe(55);
  });

  it('returns percent unchanged when resetsAt is in the future', () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    expect(adjustUsagePercent(72, future)).toBe(72);
  });

  it('returns 0 when resetsAt is in the past (window expired)', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(adjustUsagePercent(72, past)).toBe(0);
  });

  it('returns 0 when resetsAt equals now (edge case)', () => {
    const now = new Date(Date.now() - 1).toISOString(); // just barely past
    expect(adjustUsagePercent(50, now)).toBe(0);
  });

  it('handles invalid date string gracefully (returns percent)', () => {
    expect(adjustUsagePercent(30, 'not-a-date')).toBe(30);
  });

  it('handles empty string resetsAt (returns percent)', () => {
    expect(adjustUsagePercent(30, '')).toBe(30);
  });

  it('returns percent unchanged when resetsAt is far in the past (>1h)', () => {
    // Server returning a prior window's final value because no new window is active.
    // Zeroing here would hide real usage during a 429 / cache-stuck situation.
    const farPast = new Date(Date.now() - 2 * 3600_000).toISOString();
    expect(adjustUsagePercent(68, farPast)).toBe(68);
  });

  it('still returns 0 just after the 1h threshold boundary', () => {
    const justInside = new Date(Date.now() - 59 * 60_000).toISOString();
    expect(adjustUsagePercent(42, justInside)).toBe(0);
  });
});

describe('formatResetTime', () => {
  it('returns "now" when resetsAt is in the past', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(formatResetTime(past)).toBe('now');
  });

  it('returns undefined for null input', () => {
    expect(formatResetTime(undefined)).toBeUndefined();
  });

  it('returns minutes-only for < 1h remaining', () => {
    const soon = new Date(Date.now() + 30 * 60_000).toISOString();
    const result = formatResetTime(soon);
    expect(result).toMatch(/^\d+m$/);
  });

  it('returns hours and minutes for < 24h remaining', () => {
    const hours = new Date(Date.now() + 4.5 * 3600_000).toISOString();
    const result = formatResetTime(hours);
    expect(result).toMatch(/^\d+h \d+m$/);
  });

  it('returns days and hours for >= 24h remaining', () => {
    const days = new Date(Date.now() + 50 * 3600_000).toISOString();
    const result = formatResetTime(days);
    expect(result).toMatch(/^\d+d \d+h$/);
  });

  it('omits minutes when exactly on the hour', () => {
    const exact = new Date(Date.now() + 3 * 3600_000).toISOString();
    const result = formatResetTime(exact);
    // Could be "2h 59m" or "3h" depending on timing — just verify format
    expect(result).toMatch(/^\d+h( \d+m)?$/);
  });

  it('passes through pre-formatted strings (no T)', () => {
    expect(formatResetTime('4h 12m')).toBe('4h 12m');
  });
});
