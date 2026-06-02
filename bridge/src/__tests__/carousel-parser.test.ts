import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { OutputParser } from '../output-parser.js';
import type { PromptOption } from '../types.js';

/**
 * Multi-QUESTION AskUserQuestion carousel parsing.
 *
 * Ground truth reconstructed from the REAL broken capture
 * /tmp/carousel-investigation/diag-broken.json (pty_chunk previews, ts 910060..911035),
 * re-inserting \x1b before each CSI introducer. The carousel mixes question types:
 *   - 功能选择 / 结果处理 = MULTI-select  ("[ ]" ASCII checkboxes)
 *   - 测试方式           = SINGLE-select (bare labels; cursor = accent fg only)
 * Cards are the Unicode ☐/☒ tab row; the active option fg is accent 38;2;177;185;249;
 * descriptions are gray 38;2;153;153;153 and MUST be excluded.
 */

const ESC = '\x1b';
/**
 * Re-insert ESC before CSI sequences (digits/; + final letter), leaving literal
 * ASCII checkboxes "[ ]"/"[x]"/"[X]" alone — the negative lookahead prevents the
 * checkbox's "x"/"X" from being mistaken for a CSI final byte.
 */
function reinsert(s: string): string {
  return s.replace(/\[(?![ xX]\])(\d*(?:;\d+)*[A-Za-z])/g, (_m, g1) => ESC + '[' + g1);
}

// --- Real reconstructed card renders ---
const CARD_SINGLE = reinsert(
  '[14B[18A←  ☐ 功能选择 [48;2;177;185;249m[38;2;0;0;0m ☐ 测试方式 [2C[2B[49m[38;2;255;255;255m[1m更倾向于哪种测试方式？[22m[39m[K[5C[2B[38;2;177;185;249m快速测试[39m[K[2C[1B   [38;2;153;153;153m简单场景，快速验证[5C[1B[39m完整流程[K[2C[1B[38;2;153;153;153mEnter to select · Tab/Arrow keys to navigate · Esc to cancel[39m[14A',
);
const CARD_MULTI_RESULT = reinsert(
  '[14B[14C[18A ☐ 测试方式 [48;2;177;185;249m[38;2;0;0;0m ☐ 结果处理 [2B[49m[38;2;255;255;255m[1m是否需要记录测试结果？[22m[39m[K[5C[2B[ ] [38;2;177;185;249m打印输出[2C[1B[38;2;153;153;153m在对话中显示结果[39m[K[5C[1B[ ] 保存到文件[2C[1B[38;2;153;153;153mEnter to select · Tab/Arrow keys to navigate · Esc to cancel[39m[14A',
);
// 功能选择 — option-1 弹出选择框 rendered ABOVE the title via CUU (the off-by-one source)
const CARD_MULTI_FUNC = reinsert(
  '[14B[18A[38;2;153;153;153m← [48;2;177;185;249m[38;2;0;0;0m ☐ 功能选择 [39m[49m ☐ 测试方式 [2C[2B[38;2;255;255;255m[1m想测试哪些Claude Code功能？[5C[2B[22m[39m[ ] [38;2;177;185;249m弹出选择框[2C[1B[38;2;153;153;153m测试单选和多选[2C[1B[39m───────────[2C[1B[39m6.[6GChat[11Gabout[17Gthis[2B[38;2;153;153;153mEnter to select · Tab/Arrow keys to navigate · Esc to cancel[39m[14A',
);

function createParser(): OutputParser {
  return new OutputParser();
}
function collect(p: OutputParser, event: string): any[] {
  const evs: any[] = [];
  p.on(event, (d: any) => evs.push(d));
  return evs;
}
/** Arm the parser (first idle prompt enables interactive detection). */
function arm(p: OutputParser): void {
  p.feed('❯ \n');
  vi.advanceTimersByTime(400);
}

describe('multi-question carousel parser', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('parses a SINGLE-select carousel card (bare labels, gray descriptions excluded)', () => {
    const p = createParser();
    const events = collect(p, 'option_prompt');
    arm(p);
    p.feed(CARD_SINGLE);
    vi.advanceTimersByTime(400);

    const last = events.at(-1);
    expect(last).toBeDefined();
    expect(last.isCarousel).toBe(true);
    expect(last.multiSelect).toBe(false);
    const labels = last.options.map((o: PromptOption) => o.label);
    expect(labels).toEqual(['快速测试', '完整流程']);
    // gray description must NOT leak in as an option
    expect(labels.some((l: string) => l.includes('简单场景'))).toBe(false);
  });

  it('parses a MULTI-select carousel card with checkboxes (gray descriptions excluded)', () => {
    const p = createParser();
    const events = collect(p, 'option_prompt');
    arm(p);
    p.feed(CARD_MULTI_RESULT);
    vi.advanceTimersByTime(400);

    const last = events.at(-1);
    expect(last).toBeDefined();
    expect(last.isCarousel).toBe(true);
    expect(last.multiSelect).toBe(true);
    const labels = last.options.map((o: PromptOption) => o.label);
    expect(labels).toEqual(['打印输出', '保存到文件']);
    expect(last.options.every((o: PromptOption) => o.checked === false)).toBe(true);
    expect(labels.some((l: string) => l.includes('在对话中显示'))).toBe(false);
  });

  it('recovers the first checkbox option rendered ABOVE the question title (off-by-one)', () => {
    const p = createParser();
    const events = collect(p, 'option_prompt');
    arm(p);
    p.feed(CARD_MULTI_FUNC);
    vi.advanceTimersByTime(400);

    const last = events.at(-1);
    expect(last).toBeDefined();
    expect(last.multiSelect).toBe(true);
    const labels = last.options.map((o: PromptOption) => o.label);
    expect(labels).toContain('弹出选择框');           // the formerly-dropped option-1
    expect(labels).toContain('Chat about this');     // numbered escape hatch
    expect(labels.some((l: string) => l.includes('测试单选和多选'))).toBe(false); // gray desc excluded
  });

  it('re-emits the new question on a card switch (does not stay stuck on the first)', () => {
    const p = createParser();
    const events = collect(p, 'option_prompt');
    arm(p);
    p.feed(CARD_MULTI_FUNC);          // Q1 功能选择 (multi)
    vi.advanceTimersByTime(400);
    p.feed(CARD_SINGLE);              // switch → Q2 测试方式 (single)
    vi.advanceTimersByTime(400);

    const last = events.at(-1);
    const labels = last.options.map((o: PromptOption) => o.label);
    expect(labels).toEqual(['快速测试', '完整流程']);   // shows Q2, not stale Q1
    expect(last.multiSelect).toBe(false);
    expect(last.isCarousel).toBe(true);
  });

  it('forwards a checkbox toggle (checked flip) even when the redraw is a subset', () => {
    const p = createParser();
    const events = collect(p, 'option_prompt');
    arm(p);
    p.feed(CARD_MULTI_RESULT);        // 打印输出[ ] 保存到文件[ ]
    vi.advanceTimersByTime(400);
    const before = events.length;

    // toggle 打印输出 → [x] (minimal redraw of the same card with the flipped checkbox)
    const TOGGLED = reinsert(
      '[14B[14C[18A ☐ 测试方式 [48;2;177;185;249m[38;2;0;0;0m ☐ 结果处理 [2B[49m[38;2;255;255;255m[1m是否需要记录测试结果？[22m[39m[K[5C[2B[x] [38;2;177;185;249m打印输出[2C[1B[38;2;153;153;153m在对话中显示结果[39m[K[5C[1B[ ] 保存到文件[2C[1B[38;2;153;153;153mEnter to select · Tab/Arrow keys to navigate · Esc to cancel[39m[14A',
    );
    p.feed(TOGGLED);
    vi.advanceTimersByTime(400);

    expect(events.length).toBeGreaterThan(before); // a NEW emit, not suppressed
    const last = events.at(-1);
    const printOut = last.options.find((o: PromptOption) => o.label === '打印输出');
    expect(printOut?.checked).toBe(true);
  });

  it('replays the REAL broken card-switch capture without collapsing to "Chat about this"', () => {
    // Real base64-encoded PTY chunks reconstructed from diag-broken.json
    // (ts 910051..911035): switch through 测试方式 (single) → 结果处理 (multi) →
    // back → 功能选择 (multi). Before the fix this collapsed to 1 option
    // multiSelect=false; now each card surfaces its own options.
    const file = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'carousel-cardswitch.chunks.jsonl');
    const chunks = readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map(l => Buffer.from(JSON.parse(l).b64, 'base64').toString('utf8'));
    const p = createParser();
    const events = collect(p, 'option_prompt');
    arm(p);
    for (const c of chunks) { p.feed(c); vi.advanceTimersByTime(250); }

    // Every carousel emit must keep isCarousel=true (never collapse the carousel signal).
    expect(events.length).toBeGreaterThan(0);
    expect(events.every(e => e.isCarousel === true)).toBe(true);
    // The single-select card surfaced its real options (the core bug-2 fix).
    const single = events.find(e => e.options.some((o: PromptOption) => o.label === '快速测试'));
    expect(single).toBeDefined();
    expect(single.multiSelect).toBe(false);
    expect(single.options.map((o: PromptOption) => o.label)).toEqual(['快速测试', '完整流程']);
    // A multi-select card surfaced 弹出选择框 (the off-by-one recovery), not just "Chat about this".
    const func = events.find(e => e.options.some((o: PromptOption) => o.label === '弹出选择框'));
    expect(func).toBeDefined();
    expect(func.multiSelect).toBe(true);
  });

  it('isCarousel=false for a plain single-question numbered multi-select (no card row)', () => {
    const p = createParser();
    const events = collect(p, 'option_prompt');
    arm(p);
    p.feed('1. [ ] Alpha\n2. [ ] Beta\n3. [x] Gamma\n');
    vi.advanceTimersByTime(400);

    const last = events.at(-1);
    expect(last).toBeDefined();
    expect(last.isCarousel).toBe(false);
    expect(last.multiSelect).toBe(true);
  });
});
