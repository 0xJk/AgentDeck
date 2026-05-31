// Voice dial remote routing tests (plan 001 section 2g; tests 16 and 17).
//
// Test 16: a remote active bridge always relays the transcription over the
// bridge via send_prompt, regardless of session state or capabilities, and
// never pastes into the local foreground app.
// Test 17: a local bridge keeps the original behavior (paste when not IDLE and
// a terminal exists; send_prompt otherwise).
//
// routeVoiceText is the extracted, behavior-equivalent core of onVtUp's
// delivery branch. The paste indirection is mocked so the test can assert it is
// NOT called on the remote path.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../utility-modes/paste.js', () => ({
  pasteText: vi.fn(),
}));

import { State } from '@agentdeck/shared';
import type { AgentCapabilities } from '@agentdeck/shared';
import { routeVoiceText } from '../actions/voice-routing.js';
import type { AgentLink } from '../agent-link.js';
import { pasteText } from '../utility-modes/paste.js';

const CLAUDE_CAPS = { hasTerminal: true } as unknown as AgentCapabilities;
const OC_CAPS = { hasTerminal: false } as unknown as AgentCapabilities;

interface BridgeDouble {
  sent: unknown[];
}

function makeBridge(opts: { isRemote: boolean; caps: AgentCapabilities | null }): AgentLink & BridgeDouble {
  const sent: unknown[] = [];
  const double = {
    sent,
    send: (msg: unknown) => { sent.push(msg); },
    isConnected: () => true,
    getCapabilities: () => opts.caps,
    isRemoteActiveBridge: () => opts.isRemote,
    disconnect: () => {},
  };
  return double as unknown as AgentLink & BridgeDouble;
}

describe('voice-dial remote routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('test 16: remote bridge plus PROCESSING sends prompt and never pastes', () => {
    const bridge = makeBridge({ isRemote: true, caps: CLAUDE_CAPS });
    routeVoiceText(bridge, 'hello world', State.PROCESSING);
    expect(bridge.sent).toEqual([{ type: 'send_prompt', text: 'hello world' }]);
    expect(pasteText).not.toHaveBeenCalled();
  });

  it('test 16b: remote bridge ignores state and hasTerminal', () => {
    const bridge = makeBridge({ isRemote: true, caps: CLAUDE_CAPS });
    routeVoiceText(bridge, 'a', State.IDLE);
    routeVoiceText(bridge, 'b', State.AWAITING_PERMISSION);
    routeVoiceText(bridge, 'c', State.AWAITING_OPTION);
    expect(bridge.sent).toEqual([
      { type: 'send_prompt', text: 'a' },
      { type: 'send_prompt', text: 'b' },
      { type: 'send_prompt', text: 'c' },
    ]);
    expect(pasteText).not.toHaveBeenCalled();
  });

  it('test 17: local bridge plus not IDLE plus terminal pastes locally', () => {
    const bridge = makeBridge({ isRemote: false, caps: CLAUDE_CAPS });
    routeVoiceText(bridge, 'paste me', State.PROCESSING);
    expect(bridge.sent).toEqual([]);
    expect(pasteText).toHaveBeenCalledWith('paste me');
  });

  it('test 17b: local bridge plus IDLE sends prompt', () => {
    const bridge = makeBridge({ isRemote: false, caps: CLAUDE_CAPS });
    routeVoiceText(bridge, 'prompt me', State.IDLE);
    expect(bridge.sent).toEqual([{ type: 'send_prompt', text: 'prompt me' }]);
    expect(pasteText).not.toHaveBeenCalled();
  });

  it('test 17c: local bridge plus no terminal sends prompt regardless of state', () => {
    const bridge = makeBridge({ isRemote: false, caps: OC_CAPS });
    routeVoiceText(bridge, 'no term', State.PROCESSING);
    expect(bridge.sent).toEqual([{ type: 'send_prompt', text: 'no term' }]);
    expect(pasteText).not.toHaveBeenCalled();
  });
});
