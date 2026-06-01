/**
 * Gateway-vs-session command routing priority.
 *
 * The daemon proxies an OpenClaw gateway AND relays to real session bridges
 * (Claude Code / Codex / OpenCode) that the plugin can focus. The OpenClaw
 * adapter's handleCommand() returns true unconditionally for interactive
 * commands (respond/select_option/send_prompt/…), so checking the gateway first
 * would let it swallow commands meant for a focused session.
 *
 * Rule: when the user has focused a REAL session bridge, interactive commands
 * belong to that session and the gateway must not preempt them. The gateway
 * only owns interactive commands when no real session is focused. Non-interactive
 * commands (switch_agent, focus_session, query_usage, …) are always left for the
 * gateway/daemon to handle.
 *
 * See plan 002 #2.
 */
import { isRoutedCommand } from './session-focus-relay.js';

/**
 * Should the gateway be allowed to handle this command?
 *
 * @param realSessionFocused true when the user has focused an actual session
 *   bridge (userFocusedSessionId is a real session id, not null and not the
 *   'openclaw-gateway' virtual session).
 * @param cmdType the PluginCommand type.
 */
export function gatewayShouldHandle(realSessionFocused: boolean, cmdType: string): boolean {
  if (realSessionFocused && isRoutedCommand(cmdType)) return false;
  return true;
}
