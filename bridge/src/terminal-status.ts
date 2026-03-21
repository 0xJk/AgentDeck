/**
 * Terminal Status — updates tab title and iTerm2 user variables
 * to reflect the current agent session state.
 *
 * Layer 1: Tab title (OSC 1) — works in all terminals
 *          Visible in tab bar: "● AgentDeck | Edit app.ts"
 * Layer 3: iTerm2 user variables (OSC 1337 SetUserVar) — for StatusBar
 */

import { State } from './types.js';
import type { StateSnapshot } from './types.js';

// State → icon mapping
const STATE_ICON: Record<string, string> = {
  [State.PROCESSING]: '●',
  [State.IDLE]: '◇',
  [State.AWAITING_PERMISSION]: '⚠',
  [State.AWAITING_OPTION]: '?',
  [State.AWAITING_DIFF]: '△',
  [State.DISCONNECTED]: '✗',
};

export class TerminalStatus {
  private stdout: NodeJS.WritableStream;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private inTmux: boolean;

  constructor(stdout: NodeJS.WritableStream) {
    this.stdout = stdout;
    this.inTmux = !!process.env.TMUX;
  }

  update(snapshot: StateSnapshot): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.render(snapshot), 200);
  }

  cleanup(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    // Clear tab title + user vars
    this.writeOsc('\x1b]1;\x07');
    this.writeIterm(`\x1b]1337;SetUserVar=agentdeck_state=${b64('')}\x07`);
    this.writeIterm(`\x1b]1337;SetUserVar=agentdeck_project=${b64('')}\x07`);
    this.writeIterm(`\x1b]1337;SetUserVar=agentdeck_tool=${b64('')}\x07`);
  }

  // ===== Render =====

  private render(snapshot: StateSnapshot): void {
    const icon = STATE_ICON[snapshot.state] ?? '◇';
    const project = snapshot.projectName ?? 'AgentDeck';
    const detail = this.getDetail(snapshot);

    // Layer 1: Tab title — visible in tab bar across all terminals
    const title = detail
      ? `${icon} ${project} | ${detail}`
      : `${icon} ${project}`;
    this.writeOsc(`\x1b]1;${title}\x07`);

    // Layer 3: iTerm2 user variables — for StatusBar integration
    this.writeIterm(`\x1b]1337;SetUserVar=agentdeck_state=${b64(snapshot.state)}\x07`);
    this.writeIterm(`\x1b]1337;SetUserVar=agentdeck_project=${b64(project)}\x07`);
    this.writeIterm(`\x1b]1337;SetUserVar=agentdeck_tool=${b64(snapshot.currentTool ?? '')}\x07`);
  }

  private getDetail(snapshot: StateSnapshot): string | null {
    switch (snapshot.state) {
      case State.PROCESSING: {
        if (snapshot.currentTool) {
          const input = truncate(snapshot.toolInput, 40);
          return input ? `${snapshot.currentTool} ${input}` : snapshot.currentTool;
        }
        return null;
      }
      case State.IDLE:
        return snapshot.modelName ?? null;
      case State.AWAITING_PERMISSION:
      case State.AWAITING_OPTION:
      case State.AWAITING_DIFF:
        return truncate(snapshot.question, 50) ?? snapshot.state;
      default:
        return null;
    }
  }

  private writeOsc(seq: string): void {
    this.stdout.write(seq);
  }

  private writeIterm(seq: string): void {
    if (this.inTmux) {
      this.stdout.write(`\x1bPtmux;\x1b${seq}\x1b\\`);
    } else {
      this.stdout.write(seq);
    }
  }
}

function b64(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64');
}

function truncate(s: string | null, max: number): string | null {
  if (!s) return null;
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
