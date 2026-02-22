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
const OPTION_NUMBERED = /^\s*❯?\s*\d{1,2}[.)]\s*.+/m;
const OPTION_BULLET = /^\s*[►▸●○]\s+.+/m;

// Claude Code uses ❯ as its prompt char. May have \u00A0 (nbsp) or spaces around it.
// v2.1.49+: autocomplete suggestions appear on the same line (e.g. "❯ Try "refactor..."")
// so we can't require end-of-line. Just check for ❯ at start of line.
const IDLE_PROMPT = /^[❯>][ \t\u00A0]/m;

// Status line: "✳Finagling… (1m 0s · ↓ 1.9k tokens)"
const STATUS_LINE = /(\d+m\s*\d+s)\s*·\s*↓\s*([\d.]+)k?\s*tokens/;

// Project dir from Claude startup banner: "~/github/ProjectName"
const PROJECT_DIR = /[~\/][\w.\-\/]+\/(\w[\w.\-]*)\s*$/m;

// Tool action: "⏺ ToolName(description)" — capture args inside parens
const TOOL_ACTION = /⏺\s+(\w+)\(([^)]*)\)/;

// User prompt echo: "❯ some text" — text the user typed
// Require at least one word character to avoid matching box-drawing lines (─────)
const USER_PROMPT = /^❯[ \t]+(\S.*\w.*\S|\w.*)$/m;

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
const OPTION_DEBOUNCE_MS = 150;
const SUGGESTION_DEBOUNCE_MS = 500;

// Ghost text: ANSI segment extractor — captures one or more consecutive SGR sequences
// followed by visible text. Handles stacked escapes like \x1b[38;2;r;g;bm\x1b[3mtext
const ANSI_TEXT_RE = /((?:\x1b\[[\d;]+m)+)([^\x1b\n\r]+)/g;

/**
 * Check if any SGR parameter string in a list indicates gray foreground.
 * Each element is from a separate \x1b[params;m escape in a stacked sequence.
 * Also handles combined SGR codes (e.g. "2;90" = dim + bright black).
 */
function hasGrayForeground(paramsList: string[]): boolean {
  for (const params of paramsList) {
    const nums = params.split(';').map(Number);
    for (let i = 0; i < nums.length; i++) {
      // SGR 90 (bright black)
      if (nums[i] === 90) return true;
      // 256-color foreground: 38;5;N (grays 230-255)
      if (nums[i] === 38 && nums[i + 1] === 5) {
        const n = nums[i + 2];
        if (n >= 230 && n <= 255) return true;
        i += 2;
        continue;
      }
      // 24-bit foreground: 38;2;R;G;B (near-gray, mid-brightness)
      if (nums[i] === 38 && nums[i + 1] === 2) {
        const r = nums[i + 2], g = nums[i + 3], b = nums[i + 4];
        if (r != null && g != null && b != null) {
          const max = Math.max(r, g, b), min = Math.min(r, g, b);
          if ((max - min) <= 30 && max >= 60 && max <= 210) return true;
        }
        i += 4;
        continue;
      }
    }
  }
  return false;
}

/** Check if a gray ANSI text segment is Claude Code UI chrome (not a ghost text suggestion) */
function isUiChrome(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  return (
    /^Tip:|Did you know/i.test(t) ||
    /ctrl[\+\-]|shift[\+\-]|⌘|⌥|⌃/i.test(t) ||
    /^\(\d+[mhs]/i.test(t) ||
    /\(thought\s+for\s/i.test(t) ||
    /^[?]\s|for\s+shortcuts|esc\s+to|enter\s+to/i.test(t) ||
    /to\s+(expand|cycle|confirm|exit|edit\s+in)/i.test(t)
  );
}

export class OutputParser extends EventEmitter {
  private buffer = '';
  private spinnerActive = false;
  private spinnerTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private optionTimer: ReturnType<typeof setTimeout> | null = null;
  private projectName: string | null = null;
  private modelName: string | null = null;
  // Don't trigger spinner until we've seen the first idle prompt
  // This prevents Claude's startup banner (which contains ✻) from falsely triggering PROCESSING
  private seenFirstIdle = false;
  // Track pending mode switch: after Shift+Tab, wait for mode confirmation or idle
  private pendingModeSwitch = false;
  private modeSwitchTimer: ReturnType<typeof setTimeout> | null = null;
  // Ghost text suggestion detection
  private suggestedPromptTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSuggestedPrompt: string | null = null;
  // Cursor-only redraw detection for navigable option lists
  private lastNavigableEmit = false;
  private lastCursorIndex = 0;
  private pendingAnsi = '';
  // Cooldown after emitting permission/diff prompt — suppresses false idle
  // from user prompt echo (❯ text) in the same PTY batch
  private interactiveCooldown: ReturnType<typeof setTimeout> | null = null;

  feed(rawData: string): void {
    const data = this.pendingAnsi + rawData;
    this.pendingAnsi = '';

    // Check for incomplete ANSI escape sequence at end of chunk
    const lastEsc = data.lastIndexOf('\x1b');
    if (lastEsc !== -1 && lastEsc >= data.length - 20) {
      const tail = data.slice(lastEsc);
      // CSI sequence: \x1b[ ... <final byte 0x40-0x7e> — incomplete if no final byte yet
      // OSC sequence: \x1b] ... (terminated by ST or BEL) — incomplete if no terminator
      // Bare ESC: just \x1b with nothing after
      if (/^\x1b\[[\d;:]*$/.test(tail) || /^\x1b$/.test(tail) || /^\x1b\](?:(?!\x1b\\|\x07).)*$/.test(tail)) {
        this.pendingAnsi = tail;
        const complete = data.slice(0, lastEsc);
        if (complete.length === 0) return;
        return this.processFeed(complete);
      }
    }
    this.processFeed(data);
  }

  private processFeed(rawData: string): void {
    // Detect ghost text from raw ANSI before stripping
    this.detectGhostText(rawData);

    // Replace cursor-forward sequences (e.g. \x1b[1C) with spaces before stripping ANSI,
    // so word spacing is preserved (Claude Code TUI uses cursor movement instead of spaces)
    const spaced = rawData.replace(/\x1b\[\d*C/g, ' ');
    const clean = stripAnsi(spaced);
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

  /** Detect ghost text (dim/gray ANSI-styled autocomplete suggestions) from raw PTY data */
  private detectGhostText(rawData: string): void {
    if (!this.seenFirstIdle) return;

    // Strategy 1 (high confidence): "Try ..." visible in clean text on the prompt line.
    // Claude Code renders ghost text as `❯ Try "command"` — detectable without ANSI parsing.
    // This handles the most common case and has zero false positives.
    const clean = stripAnsi(rawData);
    const tryLineMatch = clean.match(/^[❯>][ \t\u00A0]+Try\s+["\u201C](.+)["\u201D]/m);
    if (tryLineMatch) {
      debug('Parser', `ghostText strategy1 HIT: "${tryLineMatch[1].trim()}"`);
      this.scheduleSuggestion(tryLineMatch[1].trim());
      return;
    }

    // Strategy 2 (ANSI gray): gray segments on the line containing ❯.
    // Split by newlines; PTY may use \r to rewrite current line — split on \n only.
    let promptLineRaw = rawData.split('\n').find(line => /[❯>][ \t\u00A0]/.test(stripAnsi(line)));

    // Strategy 3 (cross-chunk): ghost text may arrive in a separate PTY chunk from ❯.
    // If no ❯-line in current chunk and no \n (same terminal line continuation),
    // check if the buffer's last visible line starts with ❯.
    if (!promptLineRaw && !rawData.includes('\n')) {
      const rawLastLine = this.buffer.split('\n').pop() ?? '';
      const visibleLastLine = rawLastLine.split('\r').pop() ?? '';
      if (/^[❯>][ \t\u00A0]/.test(visibleLastLine)) {
        promptLineRaw = rawData;
        debug('Parser', 'ghostText strategy3: cross-chunk ❯-line continuation');
      }
    }

    if (!promptLineRaw) {
      const hasPromptChar = clean.includes('❯') || clean.includes('>');
      if (hasPromptChar && clean.length < 200) {
        const escaped = rawData.replace(/\x1b/g, '\\e').replace(/[\n\r]/g, '\\n').slice(0, 300);
        debug('Parser', `ghostText: prompt char found but no ❯-line match. raw=${escaped}`);
      }
      return;
    }

    // Extract gray text segments, filtering out UI chrome (tips, shortcut hints, status)
    ANSI_TEXT_RE.lastIndex = 0;
    const segments: string[] = [];
    for (const m of promptLineRaw.matchAll(ANSI_TEXT_RE)) {
      const ansiBlock = m[1];
      const text = m[2];
      // Extract all SGR param strings from stacked ANSI escapes
      const sgrParams = [...ansiBlock.matchAll(/\x1b\[([\d;]+)m/g)].map(pm => pm[1]);
      if (hasGrayForeground(sgrParams)) {
        const trimmed = text.trim();
        if (trimmed && !isUiChrome(trimmed)) {
          segments.push(text); // preserve original spacing for join
        }
      }
    }
    if (segments.length === 0) {
      const escaped = promptLineRaw.replace(/\x1b/g, '\\e').replace(/[\n\r]/g, '\\n').slice(0, 300);
      debug('Parser', `ghostText: ❯-line found but no usable gray segments. raw=${escaped}`);
      return;
    }

    debug('Parser', `ghostText strategy2 HIT: segments=${segments.length} "${segments.join('').trim().slice(0, 60)}"`);
    this.scheduleSuggestion(segments.join('').trim());
  }

  /** Validate and debounce a candidate suggestion text */
  private scheduleSuggestion(text: string): void {
    if (!text || text.length < 3 || text.length > 200) return;

    // Reject pure numbers (e.g. diff line numbers like "65")
    if (/^\d+$/.test(text)) return;

    // Must contain at least one word sequence of 2+ characters (not just symbols/spaces)
    // \p{L} matches Unicode letters including CJK (Korean, Japanese, Chinese)
    if (!/\w{2,}/u.test(text) && !/\p{L}{2,}/u.test(text)) return;

    // Filter out UI chrome fragments (defense-in-depth, also filtered at segment level)
    if (/^[?]$|^esc\b|^shift\b|^ctrl\b|^enter\b|for\s+shortcuts/i.test(text)) return;
    if (/^Tip:|Did you know/i.test(text)) return;
    if (/ctrl[\+\-]|shift[\+\-]/i.test(text)) return;
    if (/^\(\d+[mhs]/i.test(text)) return;
    if (/\(thought\s+for\s/i.test(text)) return;
    if (/to\s+(expand|cycle|confirm|exit|edit\s+in)/i.test(text)) return;

    // Filter out file paths (e.g. "/Users/foo/project" from PTY screen redraws)
    if (/^[~/]/.test(text) && /\//.test(text)) return;

    // Skip if same as last suggestion
    if (text === this.lastSuggestedPrompt) return;

    // Debounce: rapid PTY updates may send partial ghost text
    if (this.suggestedPromptTimer) clearTimeout(this.suggestedPromptTimer);
    this.suggestedPromptTimer = setTimeout(() => {
      this.suggestedPromptTimer = null;
      this.lastSuggestedPrompt = text;
      debug('Parser', `EMIT suggested_prompt: "${text.slice(0, 60)}"`);
      this.emit('suggested_prompt', { text });
    }, SUGGESTION_DEBOUNCE_MS);
  }

  /** Clear any pending or active suggestion */
  private clearSuggestion(): void {
    if (this.suggestedPromptTimer) {
      clearTimeout(this.suggestedPromptTimer);
      this.suggestedPromptTimer = null;
    }
    if (this.lastSuggestedPrompt !== null) {
      this.lastSuggestedPrompt = null;
      this.emit('suggested_prompt', { text: null });
    }
  }

  private detectPatterns(chunk: string): void {
    // --- Always extract metadata ---
    this.parseStatusLine(chunk);
    this.parseToolAction(chunk);
    this.parseProjectName(chunk);
    // Skip model parsing when chunk contains numbered options — option labels
    // like "Opus 4.6" match MODEL_INFO and overwrite the real model name
    if (!OPTION_NUMBERED.test(chunk)) {
      this.parseModelInfo(chunk);
    }
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
          this.clearSuggestion();
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
        // Cancel idle & option timers — we're processing now
        this.resetIdleTimer();
        this.resetOptionTimer();
        return;
      }
    }

    // While spinner is active, don't match other interactive patterns
    if (this.spinnerActive) return;

    // --- Diff prompt ---
    if (DIFF_PROMPT.test(chunk)) {
      debug('Parser', 'EMIT diff_prompt');
      this.lastNavigableEmit = false;
      this.resetIdleTimer();
      this.resetOptionTimer();
      const parsed = this.parseDiffOptions(chunk);
      const options = parsed.length > 0 ? parsed : [
        { index: 0, label: 'View diff', shortcut: 'v' },
        { index: 1, label: 'Apply', shortcut: 'a' },
        { index: 2, label: 'Deny', shortcut: 'd' },
      ];
      this.emit('diff_prompt', { options });
      this.startInteractiveCooldown();
      return;
    }

    // --- Permission: "Yes, allow once" / "No, deny" / "Always allow" ---
    if (YES_NO_ALWAYS.test(chunk)) {
      debug('Parser', 'EMIT permission_prompt (yes_no_always)');
      this.lastNavigableEmit = false;
      this.resetIdleTimer();
      this.resetOptionTimer();
      const parsed = this.parsePermissionOptions(chunk);
      const options = parsed.length > 0 ? parsed : [
        { index: 0, label: 'Yes, allow once', shortcut: 'y' },
        { index: 1, label: 'No, deny', shortcut: 'n' },
        { index: 2, label: 'Always allow', shortcut: 'a' },
      ];
      this.emit('permission_prompt', { options, promptType: 'yes_no_always' });
      this.startInteractiveCooldown();
      return;
    }

    // --- Permission: (Y)es / (N)o ---
    if (PERMISSION_YN.test(chunk)) {
      debug('Parser', 'EMIT permission_prompt (yes_no)');
      this.lastNavigableEmit = false;
      this.resetIdleTimer();
      this.resetOptionTimer();
      this.emit('permission_prompt', {
        options: [
          { index: 0, label: 'Yes', shortcut: 'y' },
          { index: 1, label: 'No', shortcut: 'n' },
        ],
        promptType: 'yes_no',
      });
      this.startInteractiveCooldown();
      return;
    }

    // --- Option list (debounced — PTY chunks may split option data) ---
    // Guard: real interactive option prompts arrive in small TUI redraws (<200 non-ws chars).
    // Large chunks (≥200) are Claude's response text which may contain numbered lists
    // (e.g. "1. First approach\n2. Second approach") — these are NOT interactive options.
    // Exception: ❯ cursor before a numbered option is a definitive TUI indicator —
    // Claude response text never contains "❯ 1." so this bypasses the size guard safely.
    const chunkNonWs = chunk.replace(/\s/g, '').length;
    const hasNavigableCursor = /^\s*❯\s*\d{1,2}[.)]/m.test(chunk);
    if ((OPTION_NUMBERED.test(chunk) || OPTION_BULLET.test(chunk)) && (hasNavigableCursor || chunkNonWs < 200)) {
      debug('Parser', 'option pattern detected — starting/resetting debounce');
      this.resetIdleTimer();
      this.resetOptionTimer();
      this.optionTimer = setTimeout(() => {
        this.optionTimer = null;
        const parsed = this.parseOptions(this.buffer.slice(-1000));
        if (parsed.options.length > 0) {
          // Check if this looks like a permission prompt (Yes/No style from tool approval)
          if (this.looksLikePermission(parsed.options) && !this.isCursorSelectionUI()) {
            const options = parsed.options.map(opt => ({
              ...opt,
              shortcut: opt.shortcut || this.inferShortcut(opt.label),
            }));
            debug('Parser', `EMIT permission_prompt (${options.length} options, navigable=${parsed.navigable}, cursor=${parsed.cursorIndex}, reclassified from numbered, debounced)`);
            this.lastNavigableEmit = parsed.navigable;
            this.lastCursorIndex = parsed.cursorIndex;
            this.emit('permission_prompt', { options, promptType: 'yes_no_always', navigable: parsed.navigable, cursorIndex: parsed.cursorIndex });
          } else {
            this.lastNavigableEmit = parsed.navigable;
            this.lastCursorIndex = parsed.cursorIndex;
            debug('Parser', `EMIT option_prompt (${parsed.options.length} options, navigable=${parsed.navigable}, cursor=${parsed.cursorIndex}, debounced)`);
            this.emit('option_prompt', {
              options: parsed.options,
              navigable: parsed.navigable,
              cursorIndex: parsed.cursorIndex,
            });
          }
        }
      }, OPTION_DEBOUNCE_MS);
      return;
    }

    // --- Cursor-only redraw detection (navigable option state) ---
    // ink's minimal redraw: only moves ❯ character. Chunk lacks digits, so
    // OPTION_NUMBERED won't match. Re-parse buffer tail to detect cursor change.
    if (this.lastNavigableEmit && chunk.includes('❯') && !hasIdlePrompt) {
      debug('Parser', 'cursor-only redraw detected — debouncing buffer re-parse');
      this.resetIdleTimer();
      this.resetOptionTimer();
      this.optionTimer = setTimeout(() => {
        this.optionTimer = null;
        const parsed = this.parseOptions(this.buffer.slice(-1000));
        if (parsed.navigable && parsed.cursorIndex !== this.lastCursorIndex) {
          this.lastCursorIndex = parsed.cursorIndex;
          debug('Parser', `EMIT cursor_update: cursorIndex=${parsed.cursorIndex}`);
          this.emit('cursor_update', { cursorIndex: parsed.cursorIndex });
        }
      }, OPTION_DEBOUNCE_MS);
      return;
    }

    // --- Idle prompt ---
    if (hasIdlePrompt) {
      // If option timer is already pending, don't let idle override it.
      // Screen redraws can contain both option prompts and ❯ in rapid succession.
      if (this.optionTimer) {
        debug('Parser', 'idle prompt ignored — option debounce pending');
        return;
      }
      // After permission/diff emit, suppress false idle from user prompt echo
      // (❯ text) in the same PTY batch (arrives within ~10ms).
      if (this.interactiveCooldown) {
        debug('Parser', 'idle prompt ignored — interactive cooldown active');
        return;
      }
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
      this.resetOptionTimer();
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
      const toolArgs = match[2]?.trim() || null;
      debug('Parser', `tool_action: ${match[1]}${toolArgs ? `(${toolArgs.slice(0, 60)})` : ''}`);
      this.emit('tool_action', { toolName: match[1], toolArgs });
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
    const match = chunk.match(MODEL_INFO);
    if (match && match[1]) {
      const newModel = match[1].trim();
      const plan = match[2]?.trim();
      if (newModel !== this.modelName) {
        this.modelName = newModel;
        debug('Parser', `model_info: ${this.modelName}${plan ? ` (${plan})` : ''}`);
        this.emit('model_info', { model: this.modelName, plan: plan || null });
      }
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
        !/^Try\s+["\u201C\u201D].+["\u201C\u201D]/i.test(text) && // autocomplete suggestion "Try \u201Crefactor...\u201D"
        !/^\d+[.)]\s/.test(text) &&                  // numbered option lines ("3. Haiku ✔ ...")
        !/Enter\s*to\s*confirm/i.test(text) &&       // "Enter to confirm · Esc to exit"
        !/Esc\s*to\s*exit/i.test(text)               // option selector hint
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
      if (this.modeSwitchTimer) { clearTimeout(this.modeSwitchTimer); this.modeSwitchTimer = null; }
      debug('Parser', 'EMIT mode_change: plan');
      this.emit('mode_change', { mode: 'plan' });
    } else if (MODE_ACCEPT.test(chunk)) {
      this.pendingModeSwitch = false;
      if (this.modeSwitchTimer) { clearTimeout(this.modeSwitchTimer); this.modeSwitchTimer = null; }
      debug('Parser', 'EMIT mode_change: acceptEdits');
      this.emit('mode_change', { mode: 'acceptEdits' });
    } else if (MODE_DEFAULT.test(chunk)) {
      this.pendingModeSwitch = false;
      if (this.modeSwitchTimer) { clearTimeout(this.modeSwitchTimer); this.modeSwitchTimer = null; }
      debug('Parser', 'EMIT mode_change: default');
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
    if (/^always\b/.test(lower)) return 'a';
    if (/don['\u2019]t\s+ask\s+again/.test(lower)) return 'a';
    if (/allow\s+all\s+sessions/.test(lower)) return 'a';
    if (/^yes\b/.test(lower)) return 'y';
    if (/^no\b/.test(lower) || /^deny\b/.test(lower)) return 'n';
    if (/^view\b/.test(lower)) return 'v';
    if (/^apply\b/.test(lower)) return 'a';
    return lower.charAt(0);
  }

  /** Check if the current buffer indicates a cursor-navigable selection UI (Enter to confirm) */
  private isCursorSelectionUI(): boolean {
    const tail = this.buffer.slice(-500);
    return /Enter\s*to\s*confirm/i.test(tail);
  }

  /** Check if numbered options look like a permission prompt (Yes/No/Always style) */
  private looksLikePermission(options: PromptOption[]): boolean {
    const labels = options.map(o => o.label.toLowerCase());
    const hasYes = labels.some(l => /^yes\b/.test(l));
    const hasNo = labels.some(l => /^no\b/.test(l));
    return hasYes && hasNo;
  }

  private parseOptions(text: string): { options: PromptOption[]; navigable: boolean; cursorIndex: number } {
    // ANSI cursor movement removal can leave numbered options concatenated without newlines.
    // Insert a newline before number patterns that aren't preceded by one.
    // (?!\d) prevents matching version numbers like "4.6" in "Opus 4.6"
    const normalized = text.replace(/([^\n\d.])((?:\s*)❯?\s*\d{1,2}[.)](?!\d))/g, '$1\n$2');

    // Backward scan: restrict to the last contiguous block of option lines.
    // This prevents stale numbered list items (e.g. "5. Deploy") from earlier in the
    // buffer being included as ghost options when a real option prompt follows.
    const optLineRe = /^\s*❯?\s*\d{1,2}[.)]\s*.+|^\s*[►▸●○]\s+.+/;
    const allLines = normalized.split('\n');
    let blockEnd = allLines.length;
    // Skip trailing non-option lines (footer like "ctrl-g to edit in VS Code")
    while (blockEnd > 0 && !optLineRe.test(allLines[blockEnd - 1])) {
      blockEnd--;
    }
    // Collect contiguous option lines (tolerate blank lines within the block)
    let blockStart = blockEnd;
    let foundOption = false;
    while (blockStart > 0) {
      const line = allLines[blockStart - 1];
      if (optLineRe.test(line)) {
        blockStart--;
        foundOption = true;
      } else if (line.trim() === '') {
        // Blank line — tolerate within block, keep scanning
        blockStart--;
      } else {
        // Non-blank, non-option line = block boundary
        break;
      }
    }
    const lines = foundOption ? allLines.slice(blockStart, blockEnd) : allLines;

    let navigable = false;
    let cursorIndex = 0;

    // Use a Map keyed by index so later (newer) lines overwrite earlier (stale) ones
    const byIndex = new Map<number, PromptOption>();
    for (const line of lines) {
      const hasCursor = /^\s*❯/.test(line);
      const nm = line.match(/^\s*❯?\s*(\d{1,2})[.)]\s*(.+)/);
      if (nm) {
        const idx = parseInt(nm[1], 10) - 1;
        if (hasCursor) {
          navigable = true;
          cursorIndex = idx;
        }
        const raw = nm[2].trim();
        const recommended = /\(recommended\)/i.test(raw);
        const selected = /✔/.test(raw);
        const label = this.cleanOptionLabel(raw);
        debug('Parser', `option[${idx}]: "${label}"${recommended ? ' ★' : ''}${selected ? ' ✓' : ''}${hasCursor ? ' ❯' : ''}`);
        const opt: PromptOption = { index: idx, label };
        if (recommended) opt.recommended = true;
        if (selected) opt.selected = true;
        byIndex.set(idx, opt);
        continue;
      }
      const bm = line.match(/^\s*([►▸●○])\s+(.+)/);
      if (bm) {
        const idx = byIndex.size;
        byIndex.set(idx, { index: idx, label: bm[2].trim() });
      }
    }
    const sorted = Array.from(byIndex.values()).sort((a, b) => a.index - b.index);

    // Filter to contiguous run starting from index 0 to discard ghost options
    // from stale buffer content (e.g. idx=98 from previous numbered lists)
    const contiguous: PromptOption[] = [];
    for (const opt of sorted) {
      if (opt.index === contiguous.length) {
        contiguous.push(opt);
      }
    }
    const finalOptions = contiguous.length >= 2 ? contiguous : sorted;
    return { options: finalOptions, navigable, cursorIndex };
  }

  /**
   * Clean an option label from TUI text that may have spaces stripped by ANSI cursor positioning.
   * Uses · (U+00B7 middle dot) as a reliable delimiter — it survives ANSI stripping.
   */
  private cleanOptionLabel(raw: string): string {
    let text = stripAnsi(raw)
      .replace(/\s*\(recommended\)/i, '')
      .replace(/✔/g, ' ')
      .trim();

    // · (middle dot) separates identity from description in Claude Code TUI
    const dotIdx = text.indexOf('\u00B7');
    if (dotIdx > 0) {
      const identity = text.slice(0, dotIdx).trim();

      // Extract version number (e.g. "4.6")
      const versionMatch = identity.match(/(\d+\.\d+)/);
      const version = versionMatch ? versionMatch[1] : null;
      let clean = identity.replace(/\d+\.\d+\S*/g, '').trim();

      // Split words: use spaces if present, else CamelCase boundaries
      let parts: string[];
      if (/\s/.test(clean)) {
        parts = clean.split(/\s+/).filter(Boolean);
      } else if (clean.length > 1) {
        parts = clean.split(/(?<=[a-z])(?=[A-Z])/).filter(Boolean);
      } else {
        parts = [clean];
      }

      // Deduplicate exact and fuzzy matches (e.g. "SonnetSonnet" → "Sonnet", "SonnetSonnt" → "Sonnet")
      const isFuzzyMatch = (a: string, b: string): boolean => {
        const al = a.toLowerCase(), bl = b.toLowerCase();
        if (al === bl) return true;
        const [shorter, longer] = al.length <= bl.length ? [al, bl] : [bl, al];
        return longer.length - shorter.length <= 2 && longer.startsWith(shorter.slice(0, -1));
      };
      const deduped: string[] = [];
      for (const p of parts) {
        const matchIdx = deduped.findIndex(existing => isFuzzyMatch(existing, p));
        if (matchIdx === -1) {
          deduped.push(p);
        } else if (p.length > deduped[matchIdx].length) {
          // Keep the longer/more complete variant
          deduped[matchIdx] = p;
        }
      }

      const name = deduped[0] || clean || identity;
      const extra = deduped.slice(1);
      if (version) extra.push(version);

      // Double space separates main from subtitle for processLabel()
      return extra.length > 0 ? `${name}  ${extra.join(' ')}` : name;
    }

    // No · — normal text with spaces preserved
    return text;
  }

  private resetSpinnerTimer(): void {
    if (this.spinnerTimer) { clearTimeout(this.spinnerTimer); this.spinnerTimer = null; }
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  private resetOptionTimer(): void {
    if (this.optionTimer) { clearTimeout(this.optionTimer); this.optionTimer = null; }
  }

  /** Brief cooldown after permission/diff emit — prevents false idle from PTY batch echo */
  private startInteractiveCooldown(): void {
    if (this.interactiveCooldown) clearTimeout(this.interactiveCooldown);
    this.interactiveCooldown = setTimeout(() => {
      this.interactiveCooldown = null;
    }, 200);
  }

  private resetInteractiveCooldown(): void {
    if (this.interactiveCooldown) { clearTimeout(this.interactiveCooldown); this.interactiveCooldown = null; }
  }

  getProjectName(): string | null { return this.projectName; }
  getModelName(): string | null { return this.modelName; }

  reset(): void {
    this.buffer = '';
    this.pendingAnsi = '';
    this.spinnerActive = false;
    this.seenFirstIdle = false;
    this.pendingModeSwitch = false;
    this.projectName = null;
    this.modelName = null;
    this.lastSuggestedPrompt = null;
    this.lastNavigableEmit = false;
    this.lastCursorIndex = 0;
    this.resetSpinnerTimer();
    this.resetIdleTimer();
    this.resetOptionTimer();
    this.resetInteractiveCooldown();
    if (this.modeSwitchTimer) {
      clearTimeout(this.modeSwitchTimer);
      this.modeSwitchTimer = null;
    }
    if (this.suggestedPromptTimer) {
      clearTimeout(this.suggestedPromptTimer);
      this.suggestedPromptTimer = null;
    }
  }
}
