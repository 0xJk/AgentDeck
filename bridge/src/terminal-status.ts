/**
 * Terminal Status — 3-layer terminal context display.
 *
 * Layer 1: Tab title (OSC 1) — works in all terminals
 *          Visible in tab bar: "● AgentDeck | Edit app.ts"
 * Layer 2: iTerm2 badge (OSC 1337 SetBadgeFormat) — post-it style overlay
 *          Dark translucent overlay with project, state, and activity log
 * Layer 3: iTerm2 user variables (OSC 1337 SetUserVar) — for StatusBar
 *
 * Badge sizing controlled via Dynamic Profiles (child profile inheriting
 * from user's current profile with fixed badge dimensions/color).
 */

import { State } from './types.js';
import type { StateSnapshot } from './types.js';
import { debug } from './logger.js';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// State → icon mapping
const STATE_ICON: Record<string, string> = {
  [State.PROCESSING]: '●',
  [State.IDLE]: '◇',
  [State.AWAITING_PERMISSION]: '⚠',
  [State.AWAITING_OPTION]: '?',
  [State.AWAITING_DIFF]: '△',
  [State.DISCONNECTED]: '✗',
};

// State → Korean label
const STATE_LABEL: Record<string, string> = {
  [State.PROCESSING]: '처리 중',
  [State.IDLE]: '대기',
  [State.AWAITING_PERMISSION]: '권한 대기',
  [State.AWAITING_OPTION]: '선택 대기',
  [State.AWAITING_DIFF]: 'diff 확인',
  [State.DISCONNECTED]: '연결 끊김',
};

// Tool → short verb for story
const TOOL_VERB: Record<string, string> = {
  Read: '읽기',
  Edit: '수정',
  Write: '생성',
  Bash: '실행',
  Grep: '검색',
  Glob: '탐색',
  Agent: '에이전트',
  WebSearch: '웹검색',
  WebFetch: '웹조회',
};

interface StoryEntry {
  time: number;
  text: string;
}

const MAX_STORY = 6;
const DEDUP_MS = 2000;

// Dynamic Profile constants
const DYNAMIC_PROFILE_NAME = 'AgentDeck Postit';
const DYNAMIC_PROFILE_DIR = join(
  homedir(),
  'Library', 'Application Support', 'iTerm2', 'DynamicProfiles',
);
const DYNAMIC_PROFILE_PATH = join(DYNAMIC_PROFILE_DIR, 'agentdeck.json');

// Badge sizing — larger than before for readability
const BADGE_MAX_WIDTH_FRACTION = 0.5;
const BADGE_MAX_HEIGHT_FRACTION = 0.12;

export class TerminalStatus {
  private stdout: NodeJS.WritableStream;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private inTmux: boolean;

  // Badge state
  private story: StoryEntry[] = [];
  private lastTool: string | null = null;
  private lastToolTime = 0;
  private lastState: State | null = null;
  private heuristicSummary: string | null = null;
  private originalProfile: string | null = null;
  private profileInstalled = false;

  // File edit tracking for heuristic summary
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

    const profile: Record<string, unknown> = {
      Name: DYNAMIC_PROFILE_NAME,
      Guid: 'agentdeck-postit-dynamic-profile',
      'Dynamic Profile Parent Name': parentName,
      'Badge Max Width': BADGE_MAX_WIDTH_FRACTION,
      'Badge Max Height': BADGE_MAX_HEIGHT_FRACTION,
      'Badge Top Margin': 10,
      'Badge Right Margin': 10,
      // Dark translucent — blends with terminal dark themes
      'Badge Color': {
        'Red Component': 0.1,
        'Green Component': 0.12,
        'Blue Component': 0.18,
        'Alpha Component': 0.6,
        'Color Space': 'sRGB',
      },
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
      debug('postit', `Dynamic profile installed, parent="${parentName}"`);
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

    // Tool call → story entry (dedup same tool within 2s)
    if (snapshot.state === State.PROCESSING && snapshot.currentTool) {
      const toolKey = `${snapshot.currentTool}:${snapshot.toolInput ?? ''}`;
      if (toolKey !== this.lastTool || now - this.lastToolTime > DEDUP_MS) {
        const verb = TOOL_VERB[snapshot.currentTool] ?? snapshot.currentTool;
        const target = extractTarget(snapshot.currentTool, snapshot.toolInput);
        const text = target ? `${verb} ${target}` : verb;
        this.pushStory(now, text);
        this.lastTool = toolKey;
        this.lastToolTime = now;

        // Track file edits for heuristic summary
        if (['Edit', 'Write', 'Read'].includes(snapshot.currentTool) && snapshot.toolInput) {
          const fname = snapshot.toolInput.split('/').pop() ?? snapshot.toolInput;
          this.fileCounts.set(fname, (this.fileCounts.get(fname) ?? 0) + 1);
        }
      }
    }

    // State transitions
    if (snapshot.state !== this.lastState) {
      const prev = this.lastState;
      this.lastState = snapshot.state;

      if (snapshot.state === State.AWAITING_PERMISSION) {
        const q = truncate(snapshot.question, 30);
        this.pushStory(now, q ? `⚠ ${q}` : '⚠ 권한 요청');
      } else if (snapshot.state === State.IDLE && prev === State.PROCESSING) {
        // Generate heuristic summary on PROCESSING→IDLE
        this.heuristicSummary = this.getHeuristicSummary();
      }
    }
  }

  private pushStory(time: number, text: string): void {
    this.story.push({ time, text });
    if (this.story.length > MAX_STORY) {
      this.story = this.story.slice(-MAX_STORY);
    }
  }

  /** Heuristic summary from most-edited files — 0 cost, instant */
  private getHeuristicSummary(): string | null {
    if (this.fileCounts.size === 0) return null;

    const sorted = [...this.fileCounts.entries()].sort((a, b) => b[1] - a[1]);
    const topFiles = sorted.slice(0, 2).map(([f]) => f).join(', ');
    return `${topFiles} 작업`;
  }

  // ===== Render =====

  private render(snapshot: StateSnapshot): void {
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
    const lines: string[] = [];
    const icon = STATE_ICON[snapshot.state] ?? '◇';
    const model = snapshot.modelName ?? '';

    // Line 1: project + model
    lines.push(model ? `${project} · ${model}` : project);

    // Line 2: state + current detail
    const stateLabel = STATE_LABEL[snapshot.state] ?? snapshot.state;
    if (snapshot.state === State.PROCESSING && snapshot.currentTool) {
      const target = extractTarget(snapshot.currentTool, snapshot.toolInput);
      const toolDetail = target
        ? `${snapshot.currentTool} ${target}`
        : snapshot.currentTool;
      lines.push(`${icon} ${stateLabel}: ${toolDetail}`);
    } else if (snapshot.state === State.AWAITING_PERMISSION || snapshot.state === State.AWAITING_OPTION) {
      const q = truncate(snapshot.question, 28);
      lines.push(`${icon} ${q ?? stateLabel}`);
    } else if (snapshot.state === State.IDLE && this.heuristicSummary) {
      lines.push(`${icon} ${this.heuristicSummary}`);
    } else {
      lines.push(`${icon} ${stateLabel}`);
    }

    // Activity log — only when PROCESSING or have story entries
    if (this.story.length > 0) {
      lines.push('');
      const recent = this.story.slice(-3);
      for (const entry of recent) {
        lines.push(`${formatTime(entry.time)}  ${entry.text}`);
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

/** Format timestamp as HH:MM */
function formatTime(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}
