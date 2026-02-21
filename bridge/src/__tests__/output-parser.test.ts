import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OutputParser } from '../output-parser.js';
import type { PromptOption } from '../types.js';

function createParser(): OutputParser {
  return new OutputParser();
}

/** Arm the parser by feeding an idle prompt (enables spinner detection) */
function armParser(): OutputParser {
  const p = createParser();
  p.feed('❯ \n');
  return p;
}

/** Collect all emissions of a given event */
function collectEvents(parser: OutputParser, event: string): any[] {
  const events: any[] = [];
  parser.on(event, (data: any) => events.push(data));
  return events;
}

describe('OutputParser', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // === Option Parsing: Basic ===

  describe('basic option parsing', () => {
    it('parses clean numbered options with newlines', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      p.feed('  1. Default\n  2. Sonnet\n  3. Haiku\n');
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      const opts: PromptOption[] = events[0].options;
      expect(opts).toHaveLength(3);
      expect(opts[0]).toMatchObject({ index: 0, label: 'Default' });
      expect(opts[1]).toMatchObject({ index: 1, label: 'Sonnet' });
      expect(opts[2]).toMatchObject({ index: 2, label: 'Haiku' });
    });

    it('detects (recommended) marker', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      p.feed('  1. Default (recommended)\n  2. Sonnet\n');
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      expect(events[0].options[0].recommended).toBe(true);
      expect(events[0].options[1].recommended).toBeUndefined();
    });

    it('detects ✔ selected marker', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      p.feed('  1. Default\n❯ 2. Sonnet ✔\n');
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      expect(events[0].options[0].selected).toBeUndefined();
      expect(events[0].options[1].selected).toBe(true);
    });

    it('handles both recommended and selected on different options', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      p.feed('  1. Default (recommended)\n  2. Sonnet\n❯ 3. Haiku ✔\n');
      vi.advanceTimersByTime(200);

      const opts = events[0].options;
      expect(opts[0].recommended).toBe(true);
      expect(opts[0].selected).toBeUndefined();
      expect(opts[2].selected).toBe(true);
      expect(opts[2].recommended).toBeUndefined();
    });

    it('parses full Claude model selector with labels and middle dot', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      p.feed(
        '  1. Default (recommended)  Opus 4.6 \u00B7 Most capable\n' +
        '  2. Sonnet  Sonnet 4.6 \u00B7 Best for everyday\n' +
        '❯ 3. Haiku ✔  Haiku 4.5 \u00B7 Fastest\n',
      );
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      const opts = events[0].options;
      expect(opts).toHaveLength(3);
      expect(opts[0].recommended).toBe(true);
      expect(opts[0].label).toContain('Default');
      expect(opts[2].selected).toBe(true);
      expect(opts[2].label).toContain('Haiku');
    });
  });

  // === ANSI-stripped Options (no spaces) ===

  describe('ANSI-stripped options', () => {
    it('parses concatenated text with · delimiter', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      // Simulates ANSI stripping removing all spaces
      p.feed('1.Default(recommended)Opus4.6\u00B7Mostcapableforcomplexwork\n\n\n2.SonnetSonnet4.6\u00B7Bestforeverydaytasks\n\n\n\u276F3.Haiku\u2714Haiku4.5\u00B7Fastestforquickanswers\n');
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      const opts = events[0].options;
      expect(opts).toHaveLength(3);
      expect(opts[0].recommended).toBe(true);
      expect(opts[0].label).toContain('Default');
      expect(opts[2].selected).toBe(true);
      expect(opts[2].label).toContain('Haiku');
    });

    it('extracts version numbers from · delimited labels', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      p.feed('1.Opus4.6\u00B7Complex\n');
      vi.advanceTimersByTime(200);

      const label = events[0].options[0].label;
      // Should contain "Opus" and version "4.6"
      expect(label).toContain('Opus');
      expect(label).toContain('4.6');
    });
  });

  // === Chunked Input with Debounce (CRITICAL) ===

  describe('chunked input debounce', () => {
    it('does NOT emit immediately on first chunk', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      // Partial chunk with just option 1 (incomplete)
      p.feed('1.Default(rec');

      // No immediate emission
      expect(events).toHaveLength(0);
    });

    it('batches multiple chunks into single emission', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      // Chunk 1: partial data
      p.feed('\n\n1.Default(recommended)Opus4.6\u00B7Most\n');
      expect(events).toHaveLength(0);

      // Chunk 2: more options
      p.feed('2.SonnetSonnet4.6\u00B7Best\n');
      expect(events).toHaveLength(0);

      // Chunk 3: final option
      p.feed('\u276F3.Haiku\u2714Haiku4.5\u00B7Fastest\n');
      expect(events).toHaveLength(0);

      // Advance past debounce (150ms)
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      expect(events[0].options).toHaveLength(3);
    });

    it('resets debounce timer when new chunk with options arrives', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      p.feed('1.First\n');
      // Advance 100ms — not yet fired (150ms debounce)
      vi.advanceTimersByTime(100);
      expect(events).toHaveLength(0);

      // New chunk with more options resets timer
      p.feed('2.Second\n');
      // Advance another 100ms (200ms total from first, 100ms from second)
      vi.advanceTimersByTime(100);
      expect(events).toHaveLength(0);

      // Advance to fire (50ms more — 150ms from second chunk)
      vi.advanceTimersByTime(60);
      expect(events).toHaveLength(1);
      expect(events[0].options).toHaveLength(2);
    });

    it('simulates real /model flow: split across chunks', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      // Chunk 1: like real PTY — contains old context + partial new option
      p.feed('\u276F /model \n\n\n \u23BFSetmodeltohaiku(claude-haiku-4-5-20251001)\n\n\n\n\n\n\u276F /model  \n\n\n');
      vi.advanceTimersByTime(50);
      expect(events).toHaveLength(0);

      // Chunk 2: rest of options
      p.feed('1.Default(recommended)Opus4.6\u00B7Mostcapable\n\n\n2.SonnetSonnet4.6\u00B7Bestforeveryday\n\n\n\u276F3.Haiku\u2714Haiku4.5\u00B7Fastest\n');
      vi.advanceTimersByTime(200);

      expect(events.length).toBeGreaterThanOrEqual(1);
      // Last emission should have all 3 options
      const last = events[events.length - 1];
      expect(last.options).toHaveLength(3);
      expect(last.options[0].label).toContain('Default');
    });
  });

  // === Model ID Date Not Matching ===

  describe('model ID date rejection', () => {
    it('does NOT parse 20251001 from model ID as option number', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      p.feed('\u23BFSetmodeltohaiku(claude-haiku-4-5-20251001)\n\n1.Default\n2.Sonnet\n3.Haiku\n');
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      // Must be exactly 3, not 4 (ghost option from date)
      expect(events[0].options).toHaveLength(3);
      // No option with index >= 3
      expect(events[0].options.every((o: PromptOption) => o.index < 3)).toBe(true);
    });

    it('rejects large numbers that look like dates', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      // "20251001." should not be parsed as option 20251001
      p.feed('version20251001.Released\n1.First\n2.Second\n');
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      expect(events[0].options).toHaveLength(2);
    });
  });

  // === Version Numbers Not Matching ===

  describe('version number rejection', () => {
    it('does NOT parse version "4.6" followed by digit as option', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      // "4.6" followed by digit (e.g. "4.60") — (?!\d) lookahead prevents matching
      p.feed('Opus4.60release\n1.First\n2.Second\n');
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      expect(events[0].options).toHaveLength(2);
      expect(events[0].options[0]).toMatchObject({ index: 0, label: expect.stringContaining('First') });
    });

    it('does NOT parse "6)" from "4.6)" as option 6', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      // "text4.6)something" — the "6)" should NOT be parsed as option 6
      p.feed('text4.6)something\n1.First\n2.Second\n');
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      // Should be exactly 2 options, not 3
      expect(events[0].options).toHaveLength(2);
    });
  });

  // === Stale Buffer Data ===

  describe('stale buffer overwrite', () => {
    it('newer options overwrite older ones with same index', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      // Old options in buffer
      p.feed('1.OldFirst\n2.OldSecond\n');
      vi.advanceTimersByTime(200);
      expect(events).toHaveLength(1);
      events.length = 0;

      // New options (same indices, different labels)
      p.feed('1.NewFirst\n2.NewSecond\n');
      vi.advanceTimersByTime(200);
      expect(events).toHaveLength(1);
      // Map keyed by index — later entries overwrite earlier
      expect(events[0].options[0].label).toContain('New');
      expect(events[0].options[1].label).toContain('New');
    });
  });

  // === Permission Prompts ===

  describe('permission prompts', () => {
    it('detects Yes/No/Always pattern', () => {
      const p = armParser();
      const events = collectEvents(p, 'permission_prompt');

      p.feed('  \u276F Yes, allow once\n    No, deny\n    Always allow\n');

      expect(events).toHaveLength(1);
      expect(events[0].options).toHaveLength(3);
      expect(events[0].options[0]).toMatchObject({ label: 'Yes, allow once', shortcut: 'y' });
      expect(events[0].options[1]).toMatchObject({ label: 'No, deny', shortcut: 'n' });
      expect(events[0].options[2]).toMatchObject({ label: 'Always allow', shortcut: 'a' });
    });

    it('detects (Y)es/(N)o pattern', () => {
      const p = armParser();
      const events = collectEvents(p, 'permission_prompt');

      p.feed('Allow? (Y)es/(N)o\n');

      expect(events).toHaveLength(1);
      expect(events[0].options).toHaveLength(2);
      expect(events[0].options[0].shortcut).toBe('y');
      expect(events[0].options[1].shortcut).toBe('n');
    });

    it('emits immediately with no debounce', () => {
      const p = armParser();
      const events = collectEvents(p, 'permission_prompt');

      p.feed('  \u276F Yes, allow once\n    No, deny\n    Always allow\n');
      // No timer advance — should already be emitted
      expect(events).toHaveLength(1);
    });

    it('sets yes_no_always prompt type', () => {
      const p = armParser();
      const events = collectEvents(p, 'permission_prompt');

      p.feed('  \u276F Yes, allow once\n    No, deny\n    Always allow\n');
      expect(events[0].promptType).toBe('yes_no_always');
    });

    it('sets yes_no prompt type', () => {
      const p = armParser();
      const events = collectEvents(p, 'permission_prompt');

      p.feed('Allow? (Y)es/(N)o\n');
      expect(events[0].promptType).toBe('yes_no');
    });
  });

  // === Diff Prompts ===

  describe('diff prompts', () => {
    it('detects (V)iew/(A)pply/(D)eny pattern', () => {
      const p = armParser();
      const events = collectEvents(p, 'diff_prompt');

      p.feed('(V)iew diff  (A)pply  (D)eny\n');

      expect(events).toHaveLength(1);
      expect(events[0].options).toHaveLength(3);
      expect(events[0].options[0]).toMatchObject({ label: 'View diff', shortcut: 'v' });
      expect(events[0].options[1]).toMatchObject({ label: 'Apply', shortcut: 'a' });
      expect(events[0].options[2]).toMatchObject({ label: 'Deny', shortcut: 'd' });
    });

    it('detects lowercase (a)pply/(d)eny/(v)iew pattern', () => {
      const p = armParser();
      const events = collectEvents(p, 'diff_prompt');

      p.feed('(a)pply  (d)eny  (v)iew\n');

      expect(events).toHaveLength(1);
      expect(events[0].options.length).toBeGreaterThanOrEqual(3);
    });

    it('emits immediately with no debounce', () => {
      const p = armParser();
      const events = collectEvents(p, 'diff_prompt');

      p.feed('(V)iew diff  (A)pply  (D)eny\n');
      // No timer advance needed
      expect(events).toHaveLength(1);
    });
  });

  // === Various Option Counts ===

  describe('various option counts', () => {
    it('handles 1 option', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      p.feed('1.OnlyOne\n');
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      expect(events[0].options).toHaveLength(1);
    });

    it('handles 2 options', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      p.feed('1.Alpha\n2.Beta\n');
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      expect(events[0].options).toHaveLength(2);
    });

    it('handles 5+ options', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      p.feed('1.One\n2.Two\n3.Three\n4.Four\n5.Five\n6.Six\n');
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      expect(events[0].options).toHaveLength(6);
    });

    it('handles bullet-style options', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      p.feed('\u25BA First choice\n\u25B8 Second choice\n');
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      expect(events[0].options).toHaveLength(2);
      expect(events[0].options[0].label).toBe('First choice');
    });
  });

  // === Option Updates ===

  describe('option updates', () => {
    it('emits new options when data changes after first emission', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      // First emission
      p.feed('1.Alpha\n2.Beta\n');
      vi.advanceTimersByTime(200);
      expect(events).toHaveLength(1);

      // Second emission with different data
      p.feed('1.Gamma\n2.Delta\n3.Epsilon\n');
      vi.advanceTimersByTime(200);
      expect(events).toHaveLength(2);
      expect(events[1].options).toHaveLength(3);
    });
  });

  // === Spinner Cancels Option Timer ===

  describe('spinner cancels option timer', () => {
    it('spinner cancels pending option debounce', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      // Feed options — debounce starts
      p.feed('1.First\n2.Second\n');
      expect(events).toHaveLength(0);

      // Spinner arrives before debounce fires
      p.feed('✻');
      vi.advanceTimersByTime(200);

      // Option prompt should NOT have fired
      expect(events).toHaveLength(0);
    });
  });

  // === Idle Cancels Option Timer ===

  describe('idle cancels option timer', () => {
    it('idle prompt cancels pending option debounce', () => {
      const p = armParser();
      const optEvents = collectEvents(p, 'option_prompt');

      // Feed options — debounce starts
      p.feed('1.First\n2.Second\n');
      expect(optEvents).toHaveLength(0);

      // Idle prompt arrives before debounce fires
      p.feed('❯ \n');
      vi.advanceTimersByTime(500);

      // Option prompt should NOT have fired
      expect(optEvents).toHaveLength(0);
    });
  });

  // === Interactive Prompt During Spinner ===

  describe('interactive prompt during spinner', () => {
    it('stops spinner when permission prompt arrives', () => {
      const p = armParser();
      vi.advanceTimersByTime(500); // clear idle timer from boot

      const events: string[] = [];
      p.on('spinner_start', () => events.push('spinner_start'));
      p.on('spinner_stop', () => events.push('spinner_stop'));
      p.on('permission_prompt', () => events.push('permission'));

      p.feed('✳'); // start spinner
      expect(events).toEqual(['spinner_start']);

      // Permission prompt during spinner
      p.feed('  ❯ Yes, allow once\n    No, deny\n    Always allow\n');
      expect(events).toContain('spinner_stop');
      expect(events).toContain('permission');
    });

    it('stops spinner when diff prompt arrives', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events: string[] = [];
      p.on('spinner_start', () => events.push('spinner_start'));
      p.on('spinner_stop', () => events.push('spinner_stop'));
      p.on('diff_prompt', () => events.push('diff'));

      p.feed('✳');
      expect(events).toEqual(['spinner_start']);

      p.feed('(V)iew diff  (A)pply  (D)eny\n');
      expect(events).toContain('spinner_stop');
      expect(events).toContain('diff');
    });

    it('stops spinner when option prompt arrives', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events: string[] = [];
      p.on('spinner_start', () => events.push('spinner_start'));
      p.on('spinner_stop', () => events.push('spinner_stop'));
      p.on('option_prompt', () => events.push('option'));

      p.feed('✳');
      expect(events).toEqual(['spinner_start']);

      p.feed('1. Alpha\n2. Bravo\n');
      vi.advanceTimersByTime(200);
      expect(events).toContain('spinner_stop');
      expect(events).toContain('option');
    });

    it('stops spinner when idle prompt arrives in small chunk', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events: string[] = [];
      p.on('spinner_start', () => events.push('spinner_start'));
      p.on('spinner_stop', () => events.push('spinner_stop'));
      p.on('idle', () => events.push('idle'));

      p.feed('✳');
      expect(events).toEqual(['spinner_start']);

      // Small chunk with idle prompt
      p.feed('❯ \n');
      expect(events).toContain('spinner_stop');

      vi.advanceTimersByTime(400);
      expect(events).toContain('idle');
    });

    it('ignores idle prompt in large chunk during spinner (screen redraw)', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const stops = collectEvents(p, 'spinner_stop');
      p.on('spinner_start', () => {});

      p.feed('✳');

      // Large chunk (>80 non-ws chars) with ❯ — screen redraw, not real idle
      const largeChunk = 'a'.repeat(100) + '❯ \n' + 'b'.repeat(50);
      p.feed(largeChunk);

      // Spinner should NOT have stopped
      expect(stops).toHaveLength(0);
    });
  });

  // === cleanOptionLabel Edge Cases ===

  describe('cleanOptionLabel (via parseOptions)', () => {
    it('deduplicates exact CamelCase matches', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      // "SonnetSonnet4.6·desc" → CamelCase split → ["Sonnet","Sonnet"] → dedup → "Sonnet"
      p.feed('1.SonnetSonnet4.6\u00B7description\n');
      vi.advanceTimersByTime(200);

      const label = events[0].options[0].label;
      expect(label).toContain('Sonnet');
      expect(label).toContain('4.6');
      // Should NOT contain duplicate "Sonnet Sonnet"
      const sonnetCount = (label.match(/Sonnet/gi) || []).length;
      expect(sonnetCount).toBe(1);
    });

    it('preserves labels without · delimiter', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      p.feed('1. Simple label here\n');
      vi.advanceTimersByTime(200);

      expect(events[0].options[0].label).toBe('Simple label here');
    });

    it('removes (recommended) from label text', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      p.feed('1. Default (recommended)\n');
      vi.advanceTimersByTime(200);

      const label = events[0].options[0].label;
      expect(label).not.toContain('recommended');
      expect(label).toContain('Default');
      expect(events[0].options[0].recommended).toBe(true);
    });

    it('removes ✔ from label text', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      p.feed('1. Haiku ✔\n');
      vi.advanceTimersByTime(200);

      const label = events[0].options[0].label;
      expect(label).not.toContain('✔');
      expect(label).toContain('Haiku');
      expect(events[0].options[0].selected).toBe(true);
    });

    it('extracts version from identity before middle dot', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      p.feed('1.HaikuHaiku4.5\u00B7Fastest\n');
      vi.advanceTimersByTime(200);

      const label = events[0].options[0].label;
      expect(label).toContain('Haiku');
      expect(label).toContain('4.5');
    });
  });

  // === Metadata Events ===

  describe('metadata events', () => {
    it('emits project_name from startup banner', () => {
      const p = createParser();
      const events = collectEvents(p, 'project_name');

      p.feed('~/github/MyProject\n');

      expect(events).toHaveLength(1);
      expect(events[0].name).toBe('MyProject');
    });

    it('emits project_name only once (caches)', () => {
      const p = createParser();
      const events = collectEvents(p, 'project_name');

      p.feed('~/github/FirstProject\n');
      p.feed('~/github/SecondProject\n');

      expect(events).toHaveLength(1);
      expect(events[0].name).toBe('FirstProject');
    });

    it('parses absolute path for project_name', () => {
      const p = createParser();
      const events = collectEvents(p, 'project_name');

      p.feed('/Users/dev/projects/my-app\n');

      expect(events).toHaveLength(1);
      expect(events[0].name).toBe('my-app');
    });

    it('emits model_info with model and plan', () => {
      const p = createParser();
      const events = collectEvents(p, 'model_info');

      p.feed('Opus 4.6 \u00B7 Claude Max\n');

      expect(events).toHaveLength(1);
      expect(events[0].model).toContain('Opus');
      expect(events[0].plan).toBe('Claude Max');
    });

    it('emits model_info without plan', () => {
      const p = createParser();
      const events = collectEvents(p, 'model_info');

      p.feed('Sonnet 4.6\n');

      expect(events).toHaveLength(1);
      expect(events[0].model).toContain('Sonnet');
      expect(events[0].plan).toBeNull();
    });

    it('emits model_info only once (caches)', () => {
      const p = createParser();
      const events = collectEvents(p, 'model_info');

      p.feed('Opus 4.6 \u00B7 Claude Max\n');
      p.feed('Sonnet 4.6\n');

      expect(events).toHaveLength(1);
    });

    it('parses ANSI-stripped model_info', () => {
      const p = createParser();
      const events = collectEvents(p, 'model_info');

      p.feed('Opus4.6\u00B7ClaudeMax\n');

      expect(events).toHaveLength(1);
      expect(events[0].plan).toBe('ClaudeMax');
    });

    it('detects API billing plan', () => {
      const p = createParser();
      const events = collectEvents(p, 'model_info');

      p.feed('Opus 4.6 \u00B7 api.anthropic.com\n');

      expect(events).toHaveLength(1);
      expect(events[0].plan).toBe('api.anthropic.com');
    });

    it('emits status_line with duration and tokens', () => {
      const p = createParser();
      const events = collectEvents(p, 'status_line');

      p.feed('1m 30s \u00B7 ↓ 2.5k tokens\n');

      expect(events).toHaveLength(1);
      expect(events[0].durationSec).toBe(90);
      expect(events[0].tokens).toBe(2500);
    });

    it('parses zero-minute status line', () => {
      const p = createParser();
      const events = collectEvents(p, 'status_line');

      p.feed('0m 15s \u00B7 ↓ 0.5k tokens\n');

      expect(events).toHaveLength(1);
      expect(events[0].durationSec).toBe(15);
      expect(events[0].tokens).toBe(500);
    });

    it('emits tool_action from ⏺ pattern', () => {
      const p = createParser();
      const events = collectEvents(p, 'tool_action');

      p.feed('⏺ Read(file.ts)\n');

      expect(events).toHaveLength(1);
      expect(events[0].toolName).toBe('Read');
    });

    it('extracts various tool names', () => {
      const p = createParser();
      const events = collectEvents(p, 'tool_action');

      p.feed('⏺ Write(output.ts)\n');
      expect(events).toHaveLength(1);
      expect(events[0].toolName).toBe('Write');
    });
  });

  // === User Prompt ===

  describe('user prompt', () => {
    it('emits user_prompt after first idle has been seen', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events = collectEvents(p, 'user_prompt');

      p.feed('❯ hello world\n');
      expect(events).toHaveLength(1);
      expect(events[0].text).toBe('hello world');
    });

    it('does NOT emit user_prompt before first idle', () => {
      const p = createParser(); // no idle yet
      const events = collectEvents(p, 'user_prompt');

      p.feed('❯ hello world\n');
      expect(events).toHaveLength(0);
    });

    it('filters out mode banner text', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events = collectEvents(p, 'user_prompt');

      p.feed('❯ ⏸ plan mode on\n');
      expect(events).toHaveLength(0);
    });

    it('filters out numbered option lines', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events = collectEvents(p, 'user_prompt');

      p.feed('❯ 3. Haiku ✔\n');
      expect(events).toHaveLength(0);
    });

    it('filters out keyboard hint text', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events = collectEvents(p, 'user_prompt');

      p.feed('❯ ? for shortcuts\n');
      expect(events).toHaveLength(0);
    });

    it('filters out "esc to interrupt" text', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events = collectEvents(p, 'user_prompt');

      p.feed('❯ esc to interrupt\n');
      expect(events).toHaveLength(0);
    });

    it('filters out autocomplete suggestions', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events = collectEvents(p, 'user_prompt');

      p.feed('❯ Try \u201Crefactor the code\u201D\n');
      expect(events).toHaveLength(0);
    });

    it('filters out box-drawing decorative lines', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events = collectEvents(p, 'user_prompt');

      p.feed('❯ ─────────────\n');
      expect(events).toHaveLength(0);
    });
  });

  // === Usage Info ===

  describe('usage info', () => {
    it('parses usage percentage', () => {
      const p = createParser();
      const events = collectEvents(p, 'usage_info');

      p.feed('75% used\n');

      expect(events).toHaveLength(1);
      expect(events[0].sessionPercent).toBe(75);
    });

    it('parses usage cost', () => {
      const p = createParser();
      const events = collectEvents(p, 'usage_info');

      p.feed('$1.50 / $5.00 spent\n');

      expect(events).toHaveLength(1);
      expect(events[0].costSpent).toBe(1.5);
      expect(events[0].costLimit).toBe(5.0);
    });

    it('parses session percentage with hour limit', () => {
      const p = createParser();
      const events = collectEvents(p, 'usage_info');

      p.feed('80% of 5 hour limit\n');

      expect(events).toHaveLength(1);
      expect(events[0].sessionPercent).toBe(80);
    });

    it('parses reset time with timezone', () => {
      const p = createParser();
      const events = collectEvents(p, 'usage_info');

      p.feed('42% used\nResets 3pm (PST)\n');

      expect(events.length).toBeGreaterThanOrEqual(1);
      const withReset = events.find((e) => e.resetTime);
      if (withReset) {
        expect(withReset.resetTime).toBe('3pm');
        expect(withReset.resetTimezone).toBe('PST');
      }
    });

    it('parses time remaining', () => {
      const p = createParser();
      const events = collectEvents(p, 'usage_info');

      p.feed('30 minutes remaining\n');

      expect(events).toHaveLength(1);
      expect(events[0].timeRemaining).toContain('30');
    });
  });

  // === Spinner Lifecycle ===

  describe('spinner lifecycle', () => {
    it('emits spinner_start on spinner char (after idle seen)', () => {
      const p = armParser();
      const starts = collectEvents(p, 'spinner_start');

      p.feed('✻');

      expect(starts).toHaveLength(1);
    });

    it('does NOT emit spinner_start before first idle', () => {
      const p = createParser(); // no idle prompt fed
      const starts = collectEvents(p, 'spinner_start');

      p.feed('✻');

      expect(starts).toHaveLength(0);
    });

    it('emits spinner_stop after debounce (2000ms)', () => {
      const p = armParser();
      const stops = collectEvents(p, 'spinner_stop');

      p.feed('✻');
      vi.advanceTimersByTime(2100);

      expect(stops).toHaveLength(1);
    });

    it('does NOT emit duplicate spinner_start on repeated chars', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const starts = collectEvents(p, 'spinner_start');

      p.feed('✳');
      p.feed('✢');
      p.feed('✶');

      expect(starts).toHaveLength(1);
    });

    it('resets spinner debounce timer on repeated chars', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events: string[] = [];
      p.on('spinner_start', () => events.push('start'));
      p.on('spinner_stop', () => events.push('stop'));

      p.feed('✳');
      vi.advanceTimersByTime(1500); // 1500ms elapsed
      p.feed('✢'); // resets timer
      vi.advanceTimersByTime(1500); // 3000ms total, 1500 from last
      expect(events).toEqual(['start']); // no stop yet

      vi.advanceTimersByTime(600); // now >2000ms from last char
      expect(events).toEqual(['start', 'stop']);
    });

    it('ignores spinner chars in large text blocks (>80 non-ws)', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const starts = collectEvents(p, 'spinner_start');

      // Large chunk with spinner char embedded
      const largeText = 'a'.repeat(100) + '✳' + 'b'.repeat(100);
      p.feed(largeText);

      expect(starts).toHaveLength(0);
    });

    it('recognizes all spinner characters', () => {
      const spinnerChars = ['✢', '✳', '✶', '✻', '✽'];
      for (const ch of spinnerChars) {
        const p = armParser();
        vi.advanceTimersByTime(500);

        const starts = collectEvents(p, 'spinner_start');
        p.feed(ch);
        expect(starts).toHaveLength(1);
      }
    });
  });

  // === Idle Detection ===

  describe('idle detection', () => {
    it('emits idle after IDLE_DEBOUNCE_MS (300ms)', () => {
      const p = createParser();
      const events = collectEvents(p, 'idle');

      p.feed('❯ \n');
      expect(events).toHaveLength(0); // debounce pending

      vi.advanceTimersByTime(400);
      expect(events).toHaveLength(1);
    });

    it('sets seenFirstIdle on first idle prompt', () => {
      const p = createParser();
      const spinners = collectEvents(p, 'spinner_start');

      // Before idle — spinner disabled
      p.feed('✳');
      expect(spinners).toHaveLength(0);

      // See first idle prompt
      p.feed('❯ \n');
      vi.advanceTimersByTime(400);

      // After idle — spinner enabled
      p.feed('✳');
      expect(spinners).toHaveLength(1);
    });

    it('cancels idle timer when spinner starts', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const events: string[] = [];
      p.on('idle', () => events.push('idle'));
      p.on('spinner_start', () => events.push('spinner'));

      p.feed('❯ \n'); // idle timer starts
      p.feed('✳');    // spinner should cancel idle timer
      vi.advanceTimersByTime(500);

      expect(events).toContain('spinner');
      expect(events).not.toContain('idle');
    });

    it('recognizes > as idle prompt char', () => {
      const p = createParser();
      const events = collectEvents(p, 'idle');

      p.feed('> \n');
      vi.advanceTimersByTime(400);

      expect(events).toHaveLength(1);
    });
  });

  // === Mode Detection ===

  describe('mode detection', () => {
    it('detects plan mode', () => {
      const p = createParser();
      const events = collectEvents(p, 'mode_change');

      p.feed('\u23F8 plan mode on\n');

      expect(events).toHaveLength(1);
      expect(events[0].mode).toBe('plan');
    });

    it('detects accept edits mode', () => {
      const p = createParser();
      const events = collectEvents(p, 'mode_change');

      p.feed('\u23F5\u23F5 accept edits on\n');

      expect(events).toHaveLength(1);
      expect(events[0].mode).toBe('acceptEdits');
    });

    it('detects default mode after Shift+Tab', () => {
      const p = createParser();
      const events = collectEvents(p, 'mode_change');

      p.notifyModeSwitchSent();
      p.feed('? for shortcuts\n');

      expect(events).toHaveLength(1);
      expect(events[0].mode).toBe('default');
    });

    it('detects default mode via idle prompt after Shift+Tab', () => {
      const p = createParser();
      const events = collectEvents(p, 'mode_change');

      p.notifyModeSwitchSent();
      p.feed('❯ \n'); // idle with no mode banner

      expect(events).toHaveLength(1);
      expect(events[0].mode).toBe('default');
    });

    it('emits default mode on Shift+Tab timeout (2s)', () => {
      const p = createParser();
      const events = collectEvents(p, 'mode_change');

      p.notifyModeSwitchSent();
      vi.advanceTimersByTime(2100);

      expect(events).toHaveLength(1);
      expect(events[0].mode).toBe('default');
    });

    it('detects ANSI-stripped plan mode text', () => {
      const p = createParser();
      const events = collectEvents(p, 'mode_change');

      p.feed('\u23F8planmodeon\n');

      expect(events).toHaveLength(1);
      expect(events[0].mode).toBe('plan');
    });

    it('detects ANSI-stripped accept edits text', () => {
      const p = createParser();
      const events = collectEvents(p, 'mode_change');

      p.feed('\u23F5\u23F5accepteditson\n');

      expect(events).toHaveLength(1);
      expect(events[0].mode).toBe('acceptEdits');
    });

    it('clears pending mode switch when mode banner is detected', () => {
      const p = createParser();
      const events = collectEvents(p, 'mode_change');

      p.notifyModeSwitchSent();
      p.feed('\u23F8 plan mode on\n');

      // Should emit plan, not default
      expect(events).toHaveLength(1);
      expect(events[0].mode).toBe('plan');

      // Timeout should not fire another event
      vi.advanceTimersByTime(2100);
      expect(events).toHaveLength(1);
    });
  });

  // === Reset ===

  describe('reset', () => {
    it('clears cached project name and model name', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      p.feed('~/github/TestProject\n');
      p.feed('Opus 4.6\n');

      expect(p.getProjectName()).toBe('TestProject');
      expect(p.getModelName()).toContain('Opus');

      p.reset();

      expect(p.getProjectName()).toBeNull();
      expect(p.getModelName()).toBeNull();
    });

    it('disables spinner detection (clears seenFirstIdle)', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      p.reset();

      const events = collectEvents(p, 'spinner_start');
      p.feed('✳');
      expect(events).toHaveLength(0);
    });

    it('allows re-detection after new idle prompt post-reset', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      p.reset();

      // New idle prompt
      p.feed('❯ \n');
      vi.advanceTimersByTime(400);

      const events = collectEvents(p, 'spinner_start');
      p.feed('✳');
      expect(events).toHaveLength(1);
    });

    it('allows re-detection of project name after reset', () => {
      const p = createParser();
      p.feed('~/github/First\n');
      expect(p.getProjectName()).toBe('First');

      p.reset();
      p.feed('~/github/Second\n');
      expect(p.getProjectName()).toBe('Second');
    });

    it('allows re-detection of model info after reset', () => {
      const p = createParser();
      p.feed('Opus 4.6\n');
      expect(p.getModelName()).toContain('Opus');

      p.reset();
      p.feed('Sonnet 4.6\n');
      expect(p.getModelName()).toContain('Sonnet');
    });
  });

  // === Buffer Management ===

  describe('buffer management', () => {
    it('truncates buffer when exceeding 8192 chars', () => {
      const p = armParser();
      const events = collectEvents(p, 'option_prompt');

      // Fill buffer past 8192
      p.feed('x'.repeat(9000));

      // Options at the tail should still be parseable
      p.feed('\n1. Alpha\n2. Bravo\n');
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
      expect(events[0].options).toHaveLength(2);
    });

    it('keeps the last 4096 chars after truncation', () => {
      const p = createParser();
      // Feed exactly 8193 chars → triggers truncation
      p.feed('a'.repeat(8193));
      // Buffer should now be ~4096 chars

      // Feed option data that should be parseable from truncated buffer
      const events = collectEvents(p, 'option_prompt');
      p.feed('\n1. First\n2. Second\n');
      vi.advanceTimersByTime(200);

      expect(events).toHaveLength(1);
    });
  });

  // === Option Navigation (Cursor Keys) ===

  describe('option navigation', () => {
    it('cursor movement during option selection does NOT trigger idle', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const optEvents = collectEvents(p, 'option_prompt');
      const idleEvents = collectEvents(p, 'idle');

      // Trigger initial options
      p.feed('1.Default\n2.Sonnet\n❯3.Haiku\n');
      vi.advanceTimersByTime(200);
      expect(optEvents.length).toBeGreaterThanOrEqual(1);

      // Simulate cursor wrap: down past last → back to first
      // PTY sends "❯\n" (no space after ❯) — must NOT trigger idle
      p.feed('\n❯\n Haiku\n\n\n\n\n\n\n\n\n\n\n');
      vi.advanceTimersByTime(500);

      expect(idleEvents).toHaveLength(0);
    });

    it('cursor movement does NOT trigger user_prompt', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const userEvents = collectEvents(p, 'user_prompt');

      // Initial options
      p.feed('1.Default\n2.Sonnet\n❯3.Haiku\n');
      vi.advanceTimersByTime(200);

      // Cursor navigation chunk — "❯\n Haiku" must NOT parse as user_prompt "Haiku"
      p.feed('\n❯\n Haiku\n\n\n\n\n\n\n\n\n\n\n');
      vi.advanceTimersByTime(500);

      expect(userEvents).toHaveLength(0);
    });

    it('normal cursor movement between options emits no idle or user_prompt', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const idleEvents = collectEvents(p, 'idle');
      const userEvents = collectEvents(p, 'user_prompt');

      // Initial options
      p.feed('1.Default\n2.Sonnet\n❯3.Haiku\n');
      vi.advanceTimersByTime(200);

      // Cursor moves to Sonnet
      p.feed('\n \n❯Sonnet\n\n\n\n\n\n\n\n\n\n\n');
      vi.advanceTimersByTime(500);

      expect(idleEvents).toHaveLength(0);
      expect(userEvents).toHaveLength(0);
    });

    it('real idle prompt still works after option navigation', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const idleEvents = collectEvents(p, 'idle');

      // Initial options
      p.feed('1.Default\n2.Sonnet\n❯3.Haiku\n');
      vi.advanceTimersByTime(200);

      // Cursor navigation (no idle)
      p.feed('\n❯\n Haiku\n\n\n\n\n\n\n\n\n\n\n');
      vi.advanceTimersByTime(500);
      expect(idleEvents).toHaveLength(0);

      // Real idle prompt: "❯ " (with space) should trigger idle
      p.feed('❯ \n');
      vi.advanceTimersByTime(400);
      expect(idleEvents).toHaveLength(1);
    });

    it('effort/hint text during navigation does not trigger events', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const idleEvents = collectEvents(p, 'idle');
      const userEvents = collectEvents(p, 'user_prompt');

      // Initial options
      p.feed('1.Default\n2.Sonnet\n❯3.Haiku\n');
      vi.advanceTimersByTime(200);

      // Effort hint text that appears during navigation
      p.feed('\n▌ Effort not supported for Haiku\n\n\n\n\n\n\n');
      vi.advanceTimersByTime(500);

      expect(idleEvents).toHaveLength(0);
      expect(userEvents).toHaveLength(0);
    });

    it('IDLE_PROMPT requires space/tab/NBSP after ❯ (not newline)', () => {
      const p = createParser();
      const idleEvents = collectEvents(p, 'idle');

      // "❯\n" (newline immediately after ❯) — NOT an idle prompt
      p.feed('❯\n');
      vi.advanceTimersByTime(400);
      expect(idleEvents).toHaveLength(0);

      // "❯ \n" (space after ❯) — IS an idle prompt
      p.feed('❯ \n');
      vi.advanceTimersByTime(400);
      expect(idleEvents).toHaveLength(1);
    });

    it('USER_PROMPT requires space/tab after ❯ (not newline)', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const userEvents = collectEvents(p, 'user_prompt');

      // "❯\nHaiku" — ❯ followed by newline then text — NOT a user prompt
      p.feed('❯\nHaiku\n');
      expect(userEvents).toHaveLength(0);

      // "❯ Haiku" — ❯ followed by space then text — IS a user prompt
      p.feed('❯ Haiku\n');
      expect(userEvents).toHaveLength(1);
      expect(userEvents[0].text).toBe('Haiku');
    });
  });

  // === Permission reclassification from numbered options ===

  describe('permission reclassification', () => {
    it('reclassifies numbered Yes/No options as permission_prompt', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const permEvents = collectEvents(p, 'permission_prompt');
      const optEvents = collectEvents(p, 'option_prompt');

      // Tool approval prompt (Claude Code v2.1.50+ style)
      p.feed('❯1. Yes\n2. Yes, and don\'t ask again for: tail:*\n3. No\n');
      vi.advanceTimersByTime(200);

      expect(permEvents).toHaveLength(1);
      expect(optEvents).toHaveLength(0);
      expect(permEvents[0].options.length).toBeGreaterThanOrEqual(3);
      // Shortcuts should be inferred
      const labels = permEvents[0].options.map((o: PromptOption) => o.label.toLowerCase());
      expect(labels.some((l: string) => l.startsWith('yes'))).toBe(true);
      expect(labels.some((l: string) => l.startsWith('no'))).toBe(true);
    });

    it('does NOT reclassify regular options as permission', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const permEvents = collectEvents(p, 'permission_prompt');
      const optEvents = collectEvents(p, 'option_prompt');

      // Regular model selection — no Yes/No
      p.feed('1. Default (recommended)\n❯2. Sonnet\n3. Haiku\n');
      vi.advanceTimersByTime(200);

      expect(optEvents).toHaveLength(1);
      expect(permEvents).toHaveLength(0);
    });

    it('infers shortcuts for reclassified permission options', () => {
      const p = armParser();
      vi.advanceTimersByTime(500);

      const permEvents = collectEvents(p, 'permission_prompt');

      p.feed('❯1. Yes\n2. Always allow\n3. No\n');
      vi.advanceTimersByTime(200);

      expect(permEvents).toHaveLength(1);
      const opts = permEvents[0].options as PromptOption[];
      const yesOpt = opts.find(o => /^yes\b/i.test(o.label));
      const noOpt = opts.find(o => /^no\b/i.test(o.label));
      const alwaysOpt = opts.find(o => /^always\b/i.test(o.label));
      expect(yesOpt?.shortcut).toBe('y');
      expect(noOpt?.shortcut).toBe('n');
      expect(alwaysOpt?.shortcut).toBe('a');
    });
  });
});
