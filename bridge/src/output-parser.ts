import stripAnsi from 'strip-ansi';
import { EventEmitter } from 'events';
import type { PromptOption } from './types.js';
import { debug } from './logger.js';

// Spinner animation characters (Claude Code specific — confirmed from PTY debug output)
// Note: · (U+00B7) removed — appears in status text "1m 0s · ↓ 1.9k tokens"
// Note: braille chars (⠋⠙⠹…) are used by other CLIs (npm, etc.), NOT Claude Code
const SPINNER_CHARS = /[✢✳✶✻✽]/;

const YES_NO_ALWAYS = /Yes,\s*allow once|No,\s*deny|Always allow/i;
const PERMISSION_YN = /\(Y\)es.*\/\(N\)o|\(y\/n\)/i;
const DIFF_PROMPT = /\(V\)iew diff.*\(A\)pply.*\(D\)eny|\(a\)pply.*\(d\)eny.*\(v\)iew/i;
// ANSI stripping can remove spaces (e.g. "❯3.Haiku" instead of "❯ 3. Haiku")
const OPTION_NUMBERED = /^\s*❯?\s*\d+[.)]\s*.+/m;
const OPTION_BULLET = /^\s*[►▸●○]\s+.+/m;

// Claude Code uses ❯ as its prompt char. May have \u00A0 (nbsp) or spaces around it.
// v2.1.49+: autocomplete suggestions appear on the same line (e.g. "❯ Try "refactor..."")
// so we can't require end-of-line. Just check for ❯ at start of line.
const IDLE_PROMPT = /^[❯>][\s\u00A0]/m;

// Status line: "✳Finagling… (1m 0s · ↓ 1.9k tokens)"
const STATUS_LINE = /(\d+m\s*\d+s)\s*·\s*↓\s*([\d.]+)k?\s*tokens/;

// Project dir from Claude startup banner: "~/github/ProjectName"
const PROJECT_DIR = /[~\/][\w.\-\/]+\/(\w[\w.\-]*)\s*$/m;

// Tool action: "⏺ ToolName(description)"
const TOOL_ACTION = /⏺\s+(\w+)\(/;

// User prompt echo: "❯ some text" — text the user typed
// Require at least one word character to avoid matching box-drawing lines (─────)
const USER_PROMPT = /^❯\s+(\S.*\w.*\S|\w.*)$/m;

// /usage command output patterns
const USAGE_PERCENT = /(\d+)%\s*used/;
const USAGE_COST = /\$([0-9.]+)\s*\/\s*\$([0-9.]+)\s*spent/;
const USAGE_RESET_TIME = /Resets?\s+(\d+[ap]m)\s*\(([^)]+)\)/;
const USAGE_RESET_DATE = /Resets?\s+((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d+)\s*\(([^)]+)\)/;
// Additional usage patterns for improved parsing
const USAGE_SESSION_PERCENT = /(\d+)%\s*(?:of\s+)?(?:(?:5|3)\s*hour|session)\s*(?:limit)?/i;
const USAGE_TIME_REMAINING = /(\d+)\s*(?:min(?:utes?)?|hr|hours?)\s*(?:remaining|left)/i;

// Mode switch detection — ANSI stripping can remove inter-word spaces
// e.g. "⏵⏵ accept edits on" → "⏵⏵accepteditson"
const MODE_PLAN = /⏸\s*plan\s*mode\s*on/i;
const MODE_ACCEPT = /⏵⏵?\s*accept\s*edits?\s*on/i;
const MODE_DEFAULT = /\?\s*for\s*shortcuts/;

// Model info line: "Sonnet 4.6 · Claude Max" or "Claude 4 Sonnet (id) · api.anthropic.com"
// ANSI stripping can remove inter-word spaces (e.g. "Opus4.6·ClaudeMax")
const MODEL_INFO = /((?:Opus|Sonnet|Haiku)\s*[\d.]+|Claude\s*[\d.]+\s*(?:Opus|Sonnet|Haiku))(?:\s*(?:\([^)]+\))?\s*[·•]\s*(.+))?/i;

const SPINNER_DEBOUNCE_MS = 2000;
const IDLE_DEBOUNCE_MS = 300;

export class OutputParser extends EventEmitter {
  private buffer = '';
  private spinnerActive = false;
  private spinnerTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private projectName: string | null = null;
  private modelName: string | null = null;
  // Don't trigger spinner until we've seen the first idle prompt
  // This prevents Claude's startup banner (which contains ✻) from falsely triggering PROCESSING
  private seenFirstIdle = false;
  // Track pending mode switch: after Shift+Tab, wait for mode confirmation or idle
  private pendingModeSwitch = false;
  private modeSwitchTimer: ReturnType<typeof setTimeout> | null = null;

  feed(rawData: string): void {
    const clean = stripAnsi(rawData);
    this.buffer += clean;

    if (this.buffer.length > 8192) {
      this.buffer = this.buffer.slice(-4096);
    }

    const preview = clean.replace(/[\n\r]/g, '\\n').replace(/[\x00-\x1f]/g, '?').slice(0, 100);
    if (preview.trim().length > 0) {
      debug('Parser', `feed(${clean.length}): "${preview}"`);
    }

    this.detectPatterns(clean);
  }

  private detectPatterns(chunk: string): void {
    // --- Always extract metadata ---
    this.parseStatusLine(chunk);
    this.parseToolAction(chunk);
    this.parseProjectName(chunk);
    this.parseModelInfo(chunk);
    this.parseUserPrompt(chunk);
    this.parseUsageInfo(chunk);
    this.parseModeSwitchLine(chunk);

    // --- Pre-scan: idle prompt & interactive content detection ---
    const hasIdlePrompt = IDLE_PROMPT.test(chunk);
    const hasInteractive =
      DIFF_PROMPT.test(chunk) || YES_NO_ALWAYS.test(chunk) ||
      PERMISSION_YN.test(chunk) ||
      OPTION_NUMBERED.test(chunk) || OPTION_BULLET.test(chunk);

    // --- Spinner + prompt handling ---
    if (this.spinnerActive) {
      if (hasInteractive) {
        // Interactive prompt arrived during spinner (e.g. "❯ 1. Yes")
        // Stop spinner but DON'T emit idle — fall through to prompt detection
        debug('Parser', 'interactive prompt during spinner — stopping spinner');
        this.resetSpinnerTimer();
        this.spinnerActive = false;
        this.seenFirstIdle = true;
        this.emit('spinner_stop');
        // Fall through to prompt detection below
      } else if (hasIdlePrompt) {
        // Idle prompt during spinner — but ignore if chunk is large (screen redraw).
        // Real idle prompts come in small chunks; screen redraws include ❯ in 200+ char chunks.
        const nonWs = chunk.replace(/\s/g, '').length;
        if (nonWs < 80) {
          debug('Parser', 'idle prompt during spinner — stopping spinner, emitting idle');
          this.resetSpinnerTimer();
          this.spinnerActive = false;
          this.seenFirstIdle = true;
          this.emit('spinner_stop');
          this.resetIdleTimer();
          this.idleTimer = setTimeout(() => {
            debug('Parser', 'EMIT idle');
            this.emit('idle');
          }, IDLE_DEBOUNCE_MS);
          return;
        }
        // Large chunk with ❯ — screen redraw, ignore idle signal
        debug('Parser', `idle prompt in large chunk (${nonWs} non-ws) during spinner — ignoring`);
        return;
      }
    }

    // --- Spinner detection (only after first idle prompt seen) ---
    if (this.seenFirstIdle && SPINNER_CHARS.test(chunk)) {
      // Only treat as spinner if chunk is relatively short (< 80 chars of non-whitespace)
      // This prevents matching spinner chars in large text blocks (responses, banners)
      const nonWs = chunk.replace(/\s/g, '').length;
      if (nonWs < 80) {
        if (!this.spinnerActive) {
          this.spinnerActive = true;
          debug('Parser', 'EMIT spinner_start');
          this.emit('spinner_start');
        }
        this.resetSpinnerTimer();
        this.spinnerTimer = setTimeout(() => {
          if (this.spinnerActive) {
            this.spinnerActive = false;
            debug('Parser', 'EMIT spinner_stop (debounced)');
            this.emit('spinner_stop');
          }
        }, SPINNER_DEBOUNCE_MS);
        // Cancel idle timer — we're processing now
        this.resetIdleTimer();
        return;
      }
    }

    // While spinner is active, don't match other interactive patterns
    if (this.spinnerActive) return;

    // --- Diff prompt ---
    if (DIFF_PROMPT.test(chunk)) {
      debug('Parser', 'EMIT diff_prompt');
      this.resetIdleTimer();
      const parsed = this.parseDiffOptions(chunk);
      const options = parsed.length > 0 ? parsed : [
        { index: 0, label: 'View diff', shortcut: 'v' },
        { index: 1, label: 'Apply', shortcut: 'a' },
        { index: 2, label: 'Deny', shortcut: 'd' },
      ];
      this.emit('diff_prompt', { options });
      return;
    }

    // --- Permission: "Yes, allow once" / "No, deny" / "Always allow" ---
    if (YES_NO_ALWAYS.test(chunk)) {
      debug('Parser', 'EMIT permission_prompt (yes_no_always)');
      this.resetIdleTimer();
      const parsed = this.parsePermissionOptions(chunk);
      const options = parsed.length > 0 ? parsed : [
        { index: 0, label: 'Yes, allow once', shortcut: 'y' },
        { index: 1, label: 'No, deny', shortcut: 'n' },
        { index: 2, label: 'Always allow', shortcut: 'a' },
      ];
      this.emit('permission_prompt', { options, promptType: 'yes_no_always' });
      return;
    }

    // --- Permission: (Y)es / (N)o ---
    if (PERMISSION_YN.test(chunk)) {
      debug('Parser', 'EMIT permission_prompt (yes_no)');
      this.resetIdleTimer();
      this.emit('permission_prompt', {
        options: [
          { index: 0, label: 'Yes', shortcut: 'y' },
          { index: 1, label: 'No', shortcut: 'n' },
        ],
        promptType: 'yes_no',
      });
      return;
    }

    // --- Option list ---
    if (OPTION_NUMBERED.test(chunk) || OPTION_BULLET.test(chunk)) {
      // Use buffer (already includes chunk) to capture all option lines
      // even if they arrived across multiple PTY chunks
      const options = this.parseOptions(this.buffer.slice(-1000));
      if (options.length > 0) {
        debug('Parser', `EMIT option_prompt (${options.length} options)`);
        this.resetIdleTimer();
        this.emit('option_prompt', { options });
        return;
      }
    }

    // --- Idle prompt ---
    if (hasIdlePrompt) {
      if (!this.seenFirstIdle) {
        this.seenFirstIdle = true;
        debug('Parser', 'first idle prompt seen — spinner detection now armed');
      }
      // If we had a pending mode switch and saw idle without a mode pattern,
      // that means the mode cycled back to default
      if (this.pendingModeSwitch) {
        this.pendingModeSwitch = false;
        debug('Parser', 'EMIT mode_change: default (idle after Shift+Tab, no mode banner)');
        this.emit('mode_change', { mode: 'default' });
      }
      debug('Parser', 'idle prompt detected');
      this.resetIdleTimer();
      this.idleTimer = setTimeout(() => {
        debug('Parser', 'EMIT idle');
        this.emit('idle');
      }, IDLE_DEBOUNCE_MS);
      return;
    }

    // --- IMPORTANT: Do NOT cancel idle timer for arbitrary chunks ---
    // Keyboard echo characters (h, e, l, l, o) and status line updates
    // arrive while Claude is idle. Cancelling the timer would prevent
    // the idle event from ever firing.
    // Only spinner detection and interactive prompts (above) cancel the idle timer.
  }

  private parseStatusLine(chunk: string): void {
    const match = chunk.match(STATUS_LINE);
    if (match) {
      const dm = match[1].match(/(\d+)m\s*(\d+)s/);
      if (dm) {
        const sec = parseInt(dm[1], 10) * 60 + parseInt(dm[2], 10);
        const tokens = Math.round(parseFloat(match[2]) * 1000);
        this.emit('status_line', { durationSec: sec, tokens });
      }
    }
  }

  private parseToolAction(chunk: string): void {
    const match = chunk.match(TOOL_ACTION);
    if (match) {
      debug('Parser', `tool_action: ${match[1]}`);
      this.emit('tool_action', { toolName: match[1] });
    }
  }

  private parseProjectName(chunk: string): void {
    if (this.projectName) return;
    const match = chunk.match(PROJECT_DIR);
    if (match && match[1]) {
      this.projectName = match[1];
      debug('Parser', `project_name: ${this.projectName}`);
      this.emit('project_name', { name: this.projectName });
    }
  }

  private parseModelInfo(chunk: string): void {
    if (this.modelName) return;
    const match = chunk.match(MODEL_INFO);
    if (match && match[1]) {
      this.modelName = match[1].trim();
      const plan = match[2]?.trim();
      debug('Parser', `model_info: ${this.modelName}${plan ? ` (${plan})` : ''}`);
      this.emit('model_info', { model: this.modelName, plan: plan || null });
    }
  }

  private parseUserPrompt(chunk: string): void {
    // Don't match prompts before first idle — startup banner contains "❯ Try ..." suggestions
    if (!this.seenFirstIdle) return;
    const match = chunk.match(USER_PROMPT);
    if (match && match[1]) {
      const text = match[1].trim();
      // Filter out common false positives from Claude Code's TUI
      if (
        text.length > 0 &&
        text.length < 500 &&
        !/^[─━═┄┅┈┉\-_=.·•\s]+$/.test(text) && // box-drawing / decorative lines
        !/for\s+shortcuts/i.test(text) &&          // "? for shortcuts" hint
        !/mode\s*on\b/i.test(text) &&              // "⏸ plan mode on" or "planmodeon"
        !/accept\s*edits?\s*on\b/i.test(text) &&  // "⏵⏵ accept edits on" or "accepteditson"
        !/shift\+tab\s*to\s*cycle/i.test(text) && // mode switcher hint
        !/esc\s*to\s*interrupt/i.test(text) &&      // "esc to interrupt"
        !/ctrl\+[a-z]\s+to\b/i.test(text) &&       // "ctrl+g to edit in VS Code"
        !/^⏵|^⏸|^⏺/.test(text) &&                 // UI indicator chars
        !/^Try\s+[""].+[""]/i.test(text)             // autocomplete suggestion "Try "refactor...""
      ) {
        debug('Parser', `user_prompt: "${text.slice(0, 50)}"`);
        this.emit('user_prompt', { text });
      }
    }
  }

  private parseUsageInfo(chunk: string): void {
    // Parse /usage command output for plan usage data
    const pctMatch = chunk.match(USAGE_PERCENT);
    const costMatch = chunk.match(USAGE_COST);
    const sessionPctMatch = chunk.match(USAGE_SESSION_PERCENT);
    const timeRemainingMatch = chunk.match(USAGE_TIME_REMAINING);

    if (pctMatch || costMatch || sessionPctMatch || timeRemainingMatch) {
      const info: Record<string, unknown> = {};

      if (pctMatch) {
        info.sessionPercent = parseInt(pctMatch[1], 10);
      } else if (sessionPctMatch) {
        info.sessionPercent = parseInt(sessionPctMatch[1], 10);
      }
      if (costMatch) {
        info.costSpent = parseFloat(costMatch[1]);
        info.costLimit = parseFloat(costMatch[2]);
      }
      if (timeRemainingMatch) {
        info.timeRemaining = timeRemainingMatch[0];
      }

      const resetTimeMatch = chunk.match(USAGE_RESET_TIME);
      if (resetTimeMatch) {
        info.resetTime = resetTimeMatch[1];
        info.resetTimezone = resetTimeMatch[2];
      }

      const resetDateMatch = chunk.match(USAGE_RESET_DATE);
      if (resetDateMatch) {
        info.resetDate = resetDateMatch[1];
      }

      debug('Parser', `usage_info: ${JSON.stringify(info)}`);
      this.emit('usage_info', info);
    }
  }

  private parseModeSwitchLine(chunk: string): void {
    if (MODE_PLAN.test(chunk)) {
      this.pendingModeSwitch = false;
      debug('Parser', 'EMIT mode_change: plan');
      this.emit('mode_change', { mode: 'plan' });
    } else if (MODE_ACCEPT.test(chunk)) {
      this.pendingModeSwitch = false;
      debug('Parser', 'EMIT mode_change: acceptEdits');
      this.emit('mode_change', { mode: 'acceptEdits' });
    } else if (this.pendingModeSwitch && MODE_DEFAULT.test(chunk)) {
      this.pendingModeSwitch = false;
      debug('Parser', 'EMIT mode_change: default (default banner detected)');
      this.emit('mode_change', { mode: 'default' });
    }
  }

  /** Call this when Shift+Tab is sent, to arm the pending mode switch detection */
  notifyModeSwitchSent(): void {
    this.pendingModeSwitch = true;
    if (this.modeSwitchTimer) clearTimeout(this.modeSwitchTimer);
    this.modeSwitchTimer = setTimeout(() => {
      if (this.pendingModeSwitch) {
        this.pendingModeSwitch = false;
        debug('Parser', 'EMIT mode_change: default (timeout — no mode banner detected)');
        this.emit('mode_change', { mode: 'default' });
      }
      this.modeSwitchTimer = null;
    }, 2000);
  }

  /** Extract permission option labels from cursor-selection UI lines */
  private parsePermissionOptions(_chunk: string): PromptOption[] {
    // buffer already includes chunk (appended in feed() before detectPatterns)
    const text = this.buffer.slice(-500);
    const options: PromptOption[] = [];

    for (const line of text.split('\n')) {
      // Cursor selection lines: "  ❯ Yes, allow once" or "    No, deny"
      const m = line.match(/^\s*❯?\s+(Yes[,\s].+|No[,\s].+|Always\s+.+)$/i);
      if (m) {
        const label = m[1].trim();
        if (!options.some(o => o.label === label)) {
          options.push({
            index: options.length,
            label,
            shortcut: this.inferShortcut(label),
          });
        }
      }
    }

    return options;
  }

  /** Extract diff option labels from inline (X)word patterns */
  private parseDiffOptions(_chunk: string): PromptOption[] {
    // buffer already includes chunk (appended in feed() before detectPatterns)
    const text = this.buffer.slice(-500);
    const options: PromptOption[] = [];

    // Match "(V)iew diff", "(A)pply", "(D)eny" patterns
    const re = /\(([A-Za-z])\)(\w+)(?:\s+(\w+))?/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const shortcut = m[1].toLowerCase();
      const word = m[1].toUpperCase() + m[2];
      const label = m[3] ? `${word} ${m[3]}` : word;
      if (!options.some(o => o.shortcut === shortcut)) {
        options.push({ index: options.length, label: label.trim(), shortcut });
      }
    }

    return options;
  }

  /** Infer keyboard shortcut from option label text */
  private inferShortcut(label: string): string {
    const lower = label.toLowerCase();
    if (/^yes\b/.test(lower)) return 'y';
    if (/^no\b/.test(lower) || /^deny\b/.test(lower)) return 'n';
    if (/^always\b/.test(lower)) return 'a';
    if (/^view\b/.test(lower)) return 'v';
    if (/^apply\b/.test(lower)) return 'a';
    return lower.charAt(0);
  }

  private parseOptions(text: string): PromptOption[] {
    // Use a Map keyed by index so later (newer) lines overwrite earlier (stale) ones
    const byIndex = new Map<number, PromptOption>();
    for (const line of text.split('\n')) {
      const nm = line.match(/^\s*❯?\s*(\d+)[.)]\s*(.+)/);
      if (nm) {
        const idx = parseInt(nm[1], 10) - 1;
        byIndex.set(idx, { index: idx, label: nm[2].trim() });
        continue;
      }
      const bm = line.match(/^\s*([►▸●○])\s+(.+)/);
      if (bm) {
        const idx = byIndex.size;
        byIndex.set(idx, { index: idx, label: bm[2].trim() });
      }
    }
    return Array.from(byIndex.values());
  }

  private resetSpinnerTimer(): void {
    if (this.spinnerTimer) { clearTimeout(this.spinnerTimer); this.spinnerTimer = null; }
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  getProjectName(): string | null { return this.projectName; }
  getModelName(): string | null { return this.modelName; }

  reset(): void {
    this.buffer = '';
    this.spinnerActive = false;
    this.seenFirstIdle = false;
    this.pendingModeSwitch = false;
    this.projectName = null;
    this.modelName = null;
    this.resetSpinnerTimer();
    this.resetIdleTimer();
    if (this.modeSwitchTimer) {
      clearTimeout(this.modeSwitchTimer);
      this.modeSwitchTimer = null;
    }
  }
}
