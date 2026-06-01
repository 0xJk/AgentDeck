/**
 * Unit tests for isIgnorableProcessError — the classifier that decides whether an
 * uncaught exception / unhandled rejection is a non-fatal transient (mDNS conflict,
 * client-disconnect stream error) that the daemon should swallow instead of crashing.
 */
import { describe, it, expect } from 'vitest';
import { isIgnorableProcessError } from '../bridge-core.js';

describe('isIgnorableProcessError', () => {
  it('ignores mDNS name-conflict errors', () => {
    expect(isIgnorableProcessError(new Error('Service name is already in use on the network'))).toBe(true);
  });

  it('ignores mDNS multicast bind errors (EADDRNOTAVAIL on port 5353)', () => {
    expect(isIgnorableProcessError(new Error('bind EADDRNOTAVAIL 0.0.0.0:5353'))).toBe(true);
  });

  it('ignores client-disconnect stream errors by code', () => {
    for (const code of ['EPIPE', 'ECONNRESET', 'ENOTCONN', 'ENXIO', 'EIO', 'EBADF']) {
      const err = Object.assign(new Error(`socket ${code}`), { code });
      expect(isIgnorableProcessError(err), code).toBe(true);
    }
  });

  it('ignores write-after-end stream errors by message', () => {
    expect(isIgnorableProcessError(new Error('ERR_STREAM_DESTROYED: Cannot call write after a stream was destroyed'))).toBe(true);
    expect(isIgnorableProcessError(new Error('write after end'))).toBe(true);
    expect(isIgnorableProcessError(new Error('This socket has been ended by the other party'))).toBe(true);
  });

  it('does NOT ignore generic application errors', () => {
    expect(isIgnorableProcessError(new Error('something genuinely broke'))).toBe(false);
    expect(isIgnorableProcessError(new TypeError('x is not a function'))).toBe(false);
  });

  it('does NOT ignore a generic EADDRNOTAVAIL that is not the mDNS port', () => {
    // Only the mDNS multicast port (5353) is transient; other bind failures are real.
    expect(isIgnorableProcessError(new Error('bind EADDRNOTAVAIL 0.0.0.0:9120'))).toBe(false);
  });

  it('handles non-Error values without throwing', () => {
    expect(isIgnorableProcessError(undefined)).toBe(false);
    expect(isIgnorableProcessError(null)).toBe(false);
    expect(isIgnorableProcessError('a string')).toBe(false);
  });
});
