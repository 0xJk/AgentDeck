/**
 * Voice transcription routing (plan 001 §2g).
 *
 * Isolated from voice-dial.ts so it can be unit-tested without pulling in the
 * heavy renderer/recording module graph (those embed emoji + Unicode-property
 * regexes that the test mock-transform pipeline cannot re-parse). voice-dial.ts
 * re-exports routeVoiceText so existing imports keep working.
 */
import { State } from '@agentdeck/shared';
import type { AgentLink } from '../agent-link.js';
import { dlog } from '../log.js';
import { pasteText } from '../utility-modes/paste.js';

/**
 * Route a confirmed voice transcription to the right destination.
 *
 * Remote active bridge: ALWAYS relay over the bridge via send_prompt, regardless
 * of session state or capabilities — there is no local terminal to paste into
 * (the daemon runs on another machine). Never paste locally.
 *
 * Local bridge: original behavior —
 *   - OpenClaw / no-terminal: always send via Gateway (state-independent)
 *   - Claude Code IDLE: send via PTY
 *   - otherwise (PROCESSING / awaiting): paste into the local focused terminal.
 *
 * Precondition: caller has already verified `link.isConnected()`.
 */
export function routeVoiceText(link: AgentLink, text: string, state: State): void {
  if (link.isRemoteActiveBridge && link.isRemoteActiveBridge()) {
    // Remote daemon: always relay, never touch the local foreground app.
    dlog('VoiceDial', `vtSendRemote: "${text.slice(0, 60)}"`);
    link.send({ type: 'send_prompt', text });
    return;
  }

  const caps = link.getCapabilities();
  if (caps && !caps.hasTerminal) {
    // OpenClaw: no terminal -> always send via Gateway (state-independent)
    dlog('VoiceDial', `vtSendOC: "${text.slice(0, 60)}"`);
    link.send({ type: 'send_prompt', text });
  } else if (state === State.IDLE) {
    // Claude Code: IDLE -> send via PTY
    dlog('VoiceDial', `vtSend: "${text.slice(0, 60)}"`);
    link.send({ type: 'send_prompt', text });
  } else {
    dlog('VoiceDial', `vtPaste: "${text.slice(0, 60)}"`);
    pasteText(text);
  }
}
