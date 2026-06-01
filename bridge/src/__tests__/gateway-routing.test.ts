/**
 * gatewayShouldHandle — gateway-vs-session command routing priority (plan 002 #2).
 *
 * When the user has focused a REAL session bridge, interactive commands
 * (respond/select_option/send_prompt/…) must route to that session, NOT be
 * swallowed by the OpenClaw gateway (whose handleCommand returns true
 * unconditionally for those types). The gateway only owns interactive commands
 * when no real session is focused.
 */
import { describe, it, expect } from 'vitest';
import { gatewayShouldHandle } from '../gateway-routing.js';

describe('gatewayShouldHandle', () => {
  it('lets the gateway handle interactive commands when no real session is focused', () => {
    expect(gatewayShouldHandle(false, 'respond')).toBe(true);
    expect(gatewayShouldHandle(false, 'select_option')).toBe(true);
    expect(gatewayShouldHandle(false, 'send_prompt')).toBe(true);
  });

  it('blocks the gateway from interactive commands when a real session is focused', () => {
    expect(gatewayShouldHandle(true, 'respond')).toBe(false);
    expect(gatewayShouldHandle(true, 'select_option')).toBe(false);
    expect(gatewayShouldHandle(true, 'send_prompt')).toBe(false);
    expect(gatewayShouldHandle(true, 'interrupt')).toBe(false);
    expect(gatewayShouldHandle(true, 'navigate_option')).toBe(false);
  });

  it('always lets the gateway/daemon handle non-interactive commands', () => {
    // switch_agent, focus_session, query_usage etc. are daemon/gateway concerns
    // regardless of focus — they are not session-routed interactive commands.
    expect(gatewayShouldHandle(true, 'switch_agent')).toBe(true);
    expect(gatewayShouldHandle(true, 'focus_session')).toBe(true);
    expect(gatewayShouldHandle(true, 'query_usage')).toBe(true);
    expect(gatewayShouldHandle(false, 'switch_agent')).toBe(true);
  });
});
