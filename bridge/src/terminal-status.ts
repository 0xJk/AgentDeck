/**
 * Terminal Status — 3-layer terminal context display.
 *
 * Layer 1: Tab title (OSC 1) — works in all terminals
 *          Visible in tab bar: "● AgentDeck | Edit app.ts"
 * Layer 2: iTerm2 badge (OSC 1337 SetBadgeFormat) — post-it style overlay
 *          Shows project, LLM-summarized context, state, and activity log
 * Layer 3: iTerm2 user variables (OSC 1337 SetUserVar) — for StatusBar
 *
 * Badge sizing controlled via Dynamic Profiles (child profile inheriting
 * from user's current profile with fixed badge dimensions/color).
 * Badge color adapts to macOS dark/light mode.
 */

import { State } from './types.js';
import type { StateSnapshot } from './types.js';
import { summarizeSessionContext, summarizeRound } from './timeline-summarizer.js';
import { debug } from './logger.js';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

// State → icon mapping
const STATE_ICON: Record<string, string> = {
  [State.PROCESSING]: '●',
  [State.IDLE]: '◇',
  [State.AWAITING_PERMISSION]: '⚠',
  [State.AWAITING_OPTION]: '?',
  [State.AWAITING_DIFF]: '△',
  [State.DISCONNECTED]: '✗',
};

// State → label
const STATE_LABEL: Record<string, string> = {
  [State.PROCESSING]: 'Processing',
  [State.IDLE]: 'Idle',
  [State.AWAITING_PERMISSION]: 'Permission',
  [State.AWAITING_OPTION]: 'Select',
  [State.AWAITING_DIFF]: 'Diff review',
  [State.DISCONNECTED]: 'Disconnected',
};

// Tool → short verb for story
const TOOL_VERB: Record<string, string> = {
  Read: 'Read',
  Edit: 'Edit',
  Write: 'Write',
  Bash: 'Run',
  Grep: 'Search',
  Glob: 'Find',
  Agent: 'Agent',
  WebSearch: 'WebSearch',
  WebFetch: 'WebFetch',
};

interface ToolCallRecord {
  tool: string;
  input: string | null;
  time: number;
}

interface Milestone {
  time: number;
  text: string;       // LLM-summarized or heuristic
}

const MAX_MILESTONES = 5;
const MAX_TOOL_HISTORY = 20;
const DEDUP_MS = 2000;
const SUMMARIZE_DEBOUNCE_MS = 5000;
const TOOL_COUNT_TRIGGER = 5;

// Dynamic Profile constants
const DYNAMIC_PROFILE_NAME = 'AgentDeck Postit';
const DYNAMIC_PROFILE_DIR = join(
  homedir(),
  'Library', 'Application Support', 'iTerm2', 'DynamicProfiles',
);
const DYNAMIC_PROFILE_PATH = join(DYNAMIC_PROFILE_DIR, 'agentdeck.json');

// Badge sizing — height scales with line count to maintain readable font
const BADGE_MAX_WIDTH_FRACTION = 0.5;
const BADGE_MAX_HEIGHT_FRACTION = 0.55;

export class TerminalStatus {
  private stdout: NodeJS.WritableStream;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private inTmux: boolean;

  // Badge state
  private lastTool: string | null = null;
  private lastToolTime = 0;
  private lastState: State | null = null;
  private lastSnapshot: StateSnapshot | null = null;
  private originalProfile: string | null = null;
  private profileInstalled = false;

  // Main topic LLM summarization
  private toolHistory: ToolCallRecord[] = [];
  private toolCountSinceLastSummary = 0;
  private llmSummary: string | null = null;
  private summarizeTimer: ReturnType<typeof setTimeout> | null = null;
  private summarizing = false;
  private lastProjectName: string | null = null;

  // Round-based milestones (PROCESSING→IDLE = one round)
  private milestones: Milestone[] = [];
  private roundTools: ToolCallRecord[] = [];  // tools in current processing round
  private roundStartTime = 0;

  // File edit tracking for heuristic fallback
  private fileCounts = new Map<string, number>();

  constructor(stdout: NodeJS.WritableStream) {
    this.stdout = stdout;
    this.inTmux = !!process.env.TMUX;
    this.installDynamicProfile();
  }

  update(snapshot: StateSnapshot): void {
    this.recordActivity(snapshot);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.render(snapshot), 200);
  }

  cleanup(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.summarizeTimer) {
      clearTimeout(this.summarizeTimer);
      this.summarizeTimer = null;
    }
    // Clear tab title + badge + user vars
    this.writeOsc('\x1b]1;\x07');
    this.writeIterm('\x1b]1337;SetBadgeFormat=\x07');
    this.writeIterm(`\x1b]1337;SetUserVar=agentdeck_state=${b64('')}\x07`);
    this.writeIterm(`\x1b]1337;SetUserVar=agentdeck_project=${b64('')}\x07`);
    this.writeIterm(`\x1b]1337;SetUserVar=agentdeck_tool=${b64('')}\x07`);
    this.uninstallDynamicProfile();
  }

  // ===== Dynamic Profile =====

  private installDynamicProfile(): void {
    this.originalProfile = process.env.ITERM_PROFILE || null;
    const parentName = this.originalProfile || 'Default';

    // Detect system dark mode → choose badge text color
    const isDark = detectDarkMode();
    const badgeColor = isDark
      ? { // Soft amber on dark backgrounds
        'Red Component': 1.0,
        'Green Component': 0.8,
        'Blue Component': 0.3,
        'Alpha Component': 0.7,
      }
      : { // Dark slate on light backgrounds
        'Red Component': 0.2,
        'Green Component': 0.25,
        'Blue Component': 0.35,
        'Alpha Component': 0.7,
      };

    const profile: Record<string, unknown> = {
      Name: DYNAMIC_PROFILE_NAME,
      Guid: 'agentdeck-postit-dynamic-profile',
      'Dynamic Profile Parent Name': parentName,
      'Badge Max Width': BADGE_MAX_WIDTH_FRACTION,
      'Badge Max Height': BADGE_MAX_HEIGHT_FRACTION,
      'Badge Top Margin': 10,
      'Badge Right Margin': 10,
      'Badge Color': { ...badgeColor, 'Color Space': 'sRGB' },
    };

    try {
      mkdirSync(DYNAMIC_PROFILE_DIR, { recursive: true });
      writeFileSync(
        DYNAMIC_PROFILE_PATH,
        JSON.stringify({ Profiles: [profile] }, null, 2),
      );
      setTimeout(() => {
        this.writeIterm(`\x1b]1337;SetProfile=${DYNAMIC_PROFILE_NAME}\x07`);
      }, 300);
      this.profileInstalled = true;
      debug('postit', `Dynamic profile installed, parent="${parentName}", dark=${isDark}`);
    } catch (err) {
      debug('postit', `Failed to install dynamic profile: ${err}`);
    }
  }

  private uninstallDynamicProfile(): void {
    if (this.originalProfile) {
      this.writeIterm(`\x1b]1337;SetProfile=${this.originalProfile}\x07`);
    }
    if (this.profileInstalled) {
      try {
        unlinkSync(DYNAMIC_PROFILE_PATH);
        debug('postit', 'Dynamic profile removed');
      } catch {
        // File may already be gone
      }
      this.profileInstalled = false;
    }
  }

  // ===== Activity tracking =====

  private recordActivity(snapshot: StateSnapshot): void {
    const now = Date.now();
    this.lastProjectName = snapshot.projectName ?? 'AgentDeck';

    // Tool call → accumulate for both main topic + current round
    if (snapshot.state === State.PROCESSING && snapshot.currentTool) {
      const toolKey = `${snapshot.currentTool}:${snapshot.toolInput ?? ''}`;
      if (toolKey !== this.lastTool || now - this.lastToolTime > DEDUP_MS) {
        this.lastTool = toolKey;
        this.lastToolTime = now;

        // Track file edits for heuristic fallback
        if (['Edit', 'Write', 'Read'].includes(snapshot.currentTool) && snapshot.toolInput) {
          const fname = snapshot.toolInput.split('/').pop() ?? snapshot.toolInput;
          this.fileCounts.set(fname, (this.fileCounts.get(fname) ?? 0) + 1);
        }

        // Accumulate for main topic LLM summarization
        const inputForLLM = extractLLMInput(snapshot.currentTool, snapshot.toolInput);
        const record = { tool: snapshot.currentTool, input: inputForLLM, time: now };
        this.toolHistory.push(record);
        if (this.toolHistory.length > MAX_TOOL_HISTORY) {
          this.toolHistory = this.toolHistory.slice(-MAX_TOOL_HISTORY);
        }
        this.toolCountSinceLastSummary++;

        if (this.toolCountSinceLastSummary >= TOOL_COUNT_TRIGGER) {
          this.scheduleSummarize();
        }

        // Accumulate for current round milestone
        this.roundTools.push(record);
      }
    }

    // State transitions
    if (snapshot.state !== this.lastState) {
      const prev = this.lastState;
      this.lastState = snapshot.state;

      // Start new round
      if (snapshot.state === State.PROCESSING && prev !== State.PROCESSING) {
        this.roundStartTime = now;
        this.roundTools = [];
      }

      // PROCESSING→IDLE = round complete → create milestone
      if (snapshot.state === State.IDLE && prev === State.PROCESSING) {
        if (this.roundTools.length > 0) {
          this.finalizeRound(now);
          this.scheduleSummarize();
        }
      }
    }
  }

  /** Finalize a processing round into a milestone */
  private finalizeRound(time: number): void {
    const roundTools = [...this.roundTools];
    this.roundTools = [];

    // Immediate heuristic milestone
    const heuristic = this.getRoundHeuristic(roundTools);
    const milestone: Milestone = { time: this.roundStartTime || time, text: heuristic };
    this.milestones.push(milestone);
    if (this.milestones.length > MAX_MILESTONES) {
      this.milestones = this.milestones.slice(-MAX_MILESTONES);
    }

    // Async LLM enhancement
    const idx = this.milestones.length - 1;
    void summarizeRound(
      roundTools.map(tc => ({ tool: tc.tool, input: tc.input })),
    ).then(result => {
      if (result && this.milestones[idx]) {
        this.milestones[idx].text = result;
        if (this.lastSnapshot) this.render(this.lastSnapshot);
      }
    }).catch(() => { /* keep heuristic */ });
  }

  /** Quick heuristic for a round: "Updated X, Y" or "Investigated X" */
  private getRoundHeuristic(tools: ToolCallRecord[]): string {
    const editFiles = new Set<string>();
    let hasSearch = false;
    let hasBash = false;
    for (const tc of tools) {
      if (['Edit', 'Write'].includes(tc.tool) && tc.input) {
        editFiles.add(tc.input.split('/').pop() ?? tc.input);
      }
      if (['Grep', 'Glob'].includes(tc.tool)) hasSearch = true;
      if (tc.tool === 'Bash') hasBash = true;
    }

    if (editFiles.size > 0) {
      const files = Array.from(editFiles).slice(0, 2).join(', ');
      return `Updated ${files}`;
    }
    if (hasBash) return 'Ran commands';
    if (hasSearch) return 'Code search';
    return 'Investigation';
  }

  // ===== LLM Summarization =====

  private scheduleSummarize(): void {
    if (this.summarizeTimer) clearTimeout(this.summarizeTimer);
    this.summarizeTimer = setTimeout(() => {
      this.summarizeTimer = null;
      void this.runSummarize();
    }, SUMMARIZE_DEBOUNCE_MS);
  }

  private async runSummarize(): Promise<void> {
    if (this.summarizing || this.toolHistory.length === 0) return;
    this.summarizing = true;
    this.toolCountSinceLastSummary = 0;

    try {
      const result = await summarizeSessionContext(
        this.toolHistory.map(tc => ({ tool: tc.tool, input: tc.input })),
        this.lastProjectName ?? 'AgentDeck',
      );
      if (result) {
        this.llmSummary = result;
        debug('postit', `LLM summary: ${result}`);
        // Re-render with new summary
        if (this.lastSnapshot) {
          this.render(this.lastSnapshot);
        }
      }
    } catch {
      // Non-blocking — heuristic fallback continues
    } finally {
      this.summarizing = false;
    }
  }

  /** Heuristic fallback: summarize from most-edited files */
  private getHeuristicSummary(): string | null {
    if (this.fileCounts.size === 0) {
      if (this.toolHistory.length > 0) {
        const last = this.toolHistory[this.toolHistory.length - 1];
        const verb = TOOL_VERB[last.tool] ?? last.tool;
        return `${verb} in progress`;
      }
      return null;
    }

    const sorted = Array.from(this.fileCounts.entries()).sort((a, b) => b[1] - a[1]);
    const topFiles = sorted.slice(0, 2).map(([f]) => f).join(', ');
    return `Editing ${topFiles}`;
  }

  // ===== Render =====

  private render(snapshot: StateSnapshot): void {
    this.lastSnapshot = snapshot;
    const icon = STATE_ICON[snapshot.state] ?? '◇';
    const project = snapshot.projectName ?? 'AgentDeck';
    const detail = this.getDetail(snapshot);

    // Layer 1: Tab title
    const title = detail
      ? `${icon} ${project} | ${detail}`
      : `${icon} ${project}`;
    this.writeOsc(`\x1b]1;${title}\x07`);

    // Layer 2: iTerm2 badge
    const badge = this.buildBadge(snapshot, project);
    this.writeIterm(`\x1b]1337;SetBadgeFormat=${b64(badge)}\x07`);

    // Layer 3: iTerm2 user variables
    this.writeIterm(`\x1b]1337;SetUserVar=agentdeck_state=${b64(snapshot.state)}\x07`);
    this.writeIterm(`\x1b]1337;SetUserVar=agentdeck_project=${b64(project)}\x07`);
    this.writeIterm(`\x1b]1337;SetUserVar=agentdeck_tool=${b64(snapshot.currentTool ?? '')}\x07`);
  }

  private buildBadge(snapshot: StateSnapshot, project: string): string {
    // 8 lines: project / model+state / main topic / milestones×5
    const lines: string[] = [];
    const icon = STATE_ICON[snapshot.state] ?? '◇';
    const model = snapshot.modelName ?? '';
    const stateLabel = STATE_LABEL[snapshot.state] ?? snapshot.state;

    // Line 1: project
    lines.push(`📂 ${project}`);

    // Line 2: model + state combined
    if (model) {
      lines.push(`${model} · ${icon} ${stateLabel}`);
    } else {
      lines.push(`${icon} ${stateLabel}`);
    }

    // Line 3: main topic (LLM summary)
    const summary = this.llmSummary ?? this.getHeuristicSummary();
    if (summary) {
      lines.push(summary);
    }

    // Lines 4-8: milestones (LLM-summarized work rounds)
    if (this.milestones.length > 0) {
      for (const ms of this.milestones.slice(-MAX_MILESTONES)) {
        lines.push(`${formatTime(ms.time)}  ${ms.text}`);
      }
    }

    return lines.join('\n');
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

/** Extract meaningful target from tool input */
function extractTarget(tool: string, input: string | null): string | null {
  if (!input) return null;
  if (['Read', 'Edit', 'Write'].includes(tool)) {
    return input.split('/').pop() ?? input;
  }
  if (tool === 'Bash') return truncate(input, 30);
  if (tool === 'Grep' || tool === 'Glob') return truncate(input, 25);
  return truncate(input, 25);
}

/** Extract concise input for LLM context */
function extractLLMInput(tool: string, input: string | null): string | null {
  if (!input) return null;
  if (['Read', 'Edit', 'Write'].includes(tool)) {
    const parts = input.split('/');
    return parts.slice(-3).join('/');
  }
  if (tool === 'Bash') return input.length > 60 ? input.slice(0, 57) + '...' : input;
  if (tool === 'Grep' || tool === 'Glob') return input.length > 40 ? input.slice(0, 37) + '...' : input;
  return input.length > 40 ? input.slice(0, 37) + '...' : input;
}

/** Detect macOS dark mode. Returns true if dark (default assumption). */
function detectDarkMode(): boolean {
  try {
    const result = execSync('defaults read -g AppleInterfaceStyle', {
      encoding: 'utf-8',
      timeout: 1000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return result === 'Dark';
  } catch {
    // Command fails when in light mode (key doesn't exist) — default to dark
    return true;
  }
}

/** Format timestamp as HH:MM */
function formatTime(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}
