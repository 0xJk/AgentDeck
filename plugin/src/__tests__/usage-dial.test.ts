import { describe, it, expect } from 'vitest';
import { resolveUsageDisplayMode } from '../renderers/usage-dial-renderer.js';

describe('resolveUsageDisplayMode', () => {
  it('offline only when the daemon WS is disconnected', () => {
    expect(resolveUsageDisplayMode(false, true, false, 42)).toBe('offline');
    expect(resolveUsageDisplayMode(false, false, false, null)).toBe('offline');
  });

  it('waiting when daemon connected but no usage payload yet', () => {
    expect(resolveUsageDisplayMode(true, false, false, null)).toBe('waiting');
  });

  it('unavailable when daemon connected + data received but stale or no 5h percent', () => {
    expect(resolveUsageDisplayMode(true, true, true, 42)).toBe('unavailable');   // stale
    expect(resolveUsageDisplayMode(true, true, false, null)).toBe('unavailable'); // no 5h
    expect(resolveUsageDisplayMode(true, true, false, undefined)).toBe('unavailable');
  });

  it('data when daemon connected, data received, fresh, and 5h present', () => {
    expect(resolveUsageDisplayMode(true, true, false, 0)).toBe('data');   // 0% is valid data
    expect(resolveUsageDisplayMode(true, true, false, 87)).toBe('data');
  });

  it('REGRESSION: connected daemon shows usage regardless of session state (not offline)', () => {
    // The home view has no focused session, but usage is daemon-global. As long as the
    // daemon WS is up and data is flowing, the dial must NOT read "offline".
    expect(resolveUsageDisplayMode(true, true, false, 12)).not.toBe('offline');
  });
});
