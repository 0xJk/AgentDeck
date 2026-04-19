/**
 * Terminal Status — lightweight terminal context display.
 *
 * Layer 1: Tab title (OSC 1)                — "{project} · {model}"
 * Layer 2: iTerm2 badge (OSC 1337 SetBadgeFormat) — post-it style, 2 lines
 * Layer 3: iTerm2 user variables (OSC 1337 SetUserVar) — agentdeck_project/_model
 *
 * Badge sizing is pinned via a Dynamic Profile that inherits from the user's
 * current profile; color adapts to macOS dark/light mode.
 */

import type { StateSnapshot } from './types.js';
import { debug } from './logger.js';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

const DYNAMIC_PROFILE_NAME = 'AgentDeck Postit';
const DYNAMIC_PROFILE_DIR = join(
  homedir(),
  'Library', 'Application Support', 'iTerm2', 'DynamicProfiles',
);
const DYNAMIC_PROFILE_PATH = join(DYNAMIC_PROFILE_DIR, 'agentdeck.json');

const BADGE_MAX_WIDTH_FRACTION = 0.5;
const BADGE_MAX_HEIGHT_FRACTION = 0.1;

export class TerminalStatus {
  private stdout: NodeJS.WritableStream;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private inTmux: boolean;
  private originalProfile: string | null = null;
  private profileInstalled = false;

  constructor(stdout: NodeJS.WritableStream) {
    this.stdout = stdout;
    this.inTmux = !!process.env.TMUX;
    this.installDynamicProfile();
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
    this.writeOsc('\x1b]1;\x07');
    this.writeIterm('\x1b]1337;SetBadgeFormat=\x07');
    this.writeIterm(`\x1b]1337;SetUserVar=agentdeck_project=${b64('')}\x07`);
    this.writeIterm(`\x1b]1337;SetUserVar=agentdeck_model=${b64('')}\x07`);
    this.uninstallDynamicProfile();
  }

  // ===== Dynamic Profile =====

  private installDynamicProfile(): void {
    this.originalProfile = process.env.ITERM_PROFILE || null;
    const parentName = this.originalProfile || 'Default';

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

  // ===== Render =====

  private render(snapshot: StateSnapshot): void {
    const project = snapshot.projectName ?? 'AgentDeck';
    const model = snapshot.modelName ?? '';

    const title = model ? `${project} · ${model}` : project;
    this.writeOsc(`\x1b]1;${title}\x07`);

    this.writeIterm(`\x1b]1337;SetBadgeFormat=${b64(this.buildBadge(project, model))}\x07`);

    this.writeIterm(`\x1b]1337;SetUserVar=agentdeck_project=${b64(project)}\x07`);
    this.writeIterm(`\x1b]1337;SetUserVar=agentdeck_model=${b64(model)}\x07`);
  }

  private buildBadge(project: string, model: string): string {
    const lines: string[] = [`📂 ${project}`];
    if (model) lines.push(model);
    // Pad to 3 lines with braille blank — keeps badge height stable when model is absent.
    while (lines.length < 3) lines.push('\u2800');
    return lines.join('\n');
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
