import { describe, it, expect } from 'vitest';
import type { BridgeEvent, FocusLostEvent } from '../protocol.js';

describe('FocusLostEvent', () => {
  it('is assignable to BridgeEvent', () => {
    // Type-level assertion: a FocusLostEvent literal must be a valid BridgeEvent.
    const event: BridgeEvent = {
      type: 'focus_lost',
      sessionId: 'session-123',
    };
    expect(event.type).toBe('focus_lost');
  });

  it('round-trips through JSON', () => {
    const event: FocusLostEvent = {
      type: 'focus_lost',
      sessionId: 'session-abc',
    };

    const parsed = JSON.parse(JSON.stringify(event)) as FocusLostEvent;

    expect(parsed).toEqual(event);
    expect(parsed.type).toBe('focus_lost');
    expect(parsed.sessionId).toBe('session-abc');

    // Parsed value is still a valid BridgeEvent at the type level.
    const asBridgeEvent: BridgeEvent = parsed;
    expect(asBridgeEvent.type).toBe('focus_lost');
  });
});
