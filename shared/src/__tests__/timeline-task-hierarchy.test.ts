import { describe, it, expect } from 'vitest';
import {
  deduplicateEntry,
  type TimelineEntry,
  type TaskBoundarySignal,
} from '../timeline.js';
import {
  timelineIconKey,
  EINK_ICON_GLYPHS,
  isInFlightTask,
  isRotatingEntry,
} from '../timeline-icons.js';
import { parseTimelineMarkdown, parseInlineSpans } from '../timeline-markdown.js';
import { prepareMarkdownDetail, cleanDetailText } from '../timeline.js';

// ============================================================
// Task hierarchy entries bypass dedup
// ============================================================
describe('deduplicateEntry — task hierarchy', () => {
  const baseEntry = (over: Partial<TimelineEntry> = {}): TimelineEntry => ({
    ts: 1_000_000,
    type: 'task_start',
    raw: 'Task 1',
    sessionId: 'sess',
    runId: 'run',
    taskId: 'task-a',
    ...over,
  });

  it('always adds task_start even with identical raw within 8s', () => {
    const existing = [baseEntry({ ts: 1_000_000 })];
    const next = baseEntry({ ts: 1_000_500, taskId: 'task-b' });
    const result = deduplicateEntry(next, existing);
    expect(result.action).toBe('add');
  });

  it('always adds task_end with same boundarySignal back-to-back', () => {
    const existing: TimelineEntry[] = [
      baseEntry({ type: 'task_end', boundarySignal: 'todo_complete' as TaskBoundarySignal }),
    ];
    const next = baseEntry({
      ts: 1_001_000,
      type: 'task_end',
      boundarySignal: 'todo_complete' as TaskBoundarySignal,
      taskId: 'task-b',
    });
    const result = deduplicateEntry(next, existing);
    expect(result.action).toBe('add');
  });

  it('still dedupes ordinary chat_start within 8s', () => {
    const existing: TimelineEntry[] = [
      { ts: 1_000_000, type: 'chat_start', raw: 'hello' },
    ];
    const next: TimelineEntry = { ts: 1_002_000, type: 'chat_start', raw: 'hello' };
    const result = deduplicateEntry(next, existing);
    expect(result.action).toBe('skip');
  });
});

// ============================================================
// timelineIconKey
// ============================================================
describe('timelineIconKey', () => {
  it('maps task entries to "task"', () => {
    expect(timelineIconKey({ type: 'task_start' })).toBe('task');
    expect(timelineIconKey({ type: 'task_end' })).toBe('task');
  });

  it('maps tool_request status to success/error/awaiting', () => {
    expect(timelineIconKey({ type: 'tool_request', status: 'approved' })).toBe('success');
    expect(timelineIconKey({ type: 'tool_request', status: 'denied' })).toBe('error');
    expect(timelineIconKey({ type: 'tool_request', status: 'pending' })).toBe('awaiting');
    expect(timelineIconKey({ type: 'tool_request' })).toBe('awaiting');
  });

  it('chat_start in flight is "running"; chat_end is "success"', () => {
    expect(timelineIconKey({ type: 'chat_start' })).toBe('running');
    expect(timelineIconKey({ type: 'chat_end' })).toBe('success');
    expect(timelineIconKey({ type: 'chat_response' })).toBe('success');
  });

  it('error → error; user_action → user; memory_recall → memory', () => {
    expect(timelineIconKey({ type: 'error' })).toBe('error');
    expect(timelineIconKey({ type: 'user_action' })).toBe('user');
    expect(timelineIconKey({ type: 'memory_recall' })).toBe('memory');
  });

  it('every key has an e-ink glyph of constant 4-char width', () => {
    for (const glyph of Object.values(EINK_ICON_GLYPHS)) {
      expect(glyph.length).toBe(4);
    }
  });
});

// ============================================================
// isInFlightTask + isRotatingEntry — sibling-aware in-flight signal
// ============================================================
describe('isInFlightTask', () => {
  const taskStart = (taskId?: string) =>
    ({ type: 'task_start', taskId } as Pick<TimelineEntry, 'type' | 'taskId'>);
  const taskEnd = (taskId?: string) =>
    ({ type: 'task_end', taskId } as Pick<TimelineEntry, 'type' | 'taskId'>);

  it('task_start without matching task_end is in flight', () => {
    expect(isInFlightTask(taskStart('a'), [])).toBe(true);
    expect(isInFlightTask(taskStart('a'), [taskStart('a')])).toBe(true);
  });

  it('task_start whose task_end (same taskId) appeared is finished', () => {
    expect(isInFlightTask(taskStart('a'), [taskEnd('a')])).toBe(false);
  });

  it('mismatched taskId on task_end does not close it', () => {
    expect(isInFlightTask(taskStart('a'), [taskEnd('b')])).toBe(true);
  });

  it('task_start without taskId is never considered in flight', () => {
    expect(isInFlightTask(taskStart(undefined), [])).toBe(false);
  });

  it('non-task_start entries are never in flight', () => {
    expect(isInFlightTask({ type: 'chat_start' } as any, [])).toBe(false);
    expect(isInFlightTask({ type: 'task_end', taskId: 'a' } as any, [])).toBe(false);
  });
});

describe('isRotatingEntry', () => {
  it('chat_start always rotates (icon-key running)', () => {
    expect(isRotatingEntry({ type: 'chat_start' }, [])).toBe(true);
  });

  it('orphan task_start rotates via in-flight predicate', () => {
    expect(
      isRotatingEntry({ type: 'task_start', taskId: 'a' }, [{ type: 'task_start', taskId: 'a' }]),
    ).toBe(true);
  });

  it('closed task_start does not rotate', () => {
    expect(
      isRotatingEntry({ type: 'task_start', taskId: 'a' }, [{ type: 'task_end', taskId: 'a' }]),
    ).toBe(false);
  });

  it('static rows do not rotate', () => {
    expect(isRotatingEntry({ type: 'tool_exec' }, [])).toBe(false);
    expect(isRotatingEntry({ type: 'model_call' }, [])).toBe(false);
    expect(isRotatingEntry({ type: 'chat_end' }, [])).toBe(false);
    expect(isRotatingEntry({ type: 'tool_request', status: 'pending' }, [])).toBe(false);
  });

  it('eval_result and task_end never rotate', () => {
    expect(isRotatingEntry({ type: 'eval_result' }, [])).toBe(false);
    expect(isRotatingEntry({ type: 'task_end', taskId: 'a' }, [])).toBe(false);
  });
});

// ============================================================
// parseTimelineMarkdown — parity targets for the Apple/Android ports
// ============================================================
describe('parseTimelineMarkdown', () => {
  it('returns single text line for plain text', () => {
    expect(parseTimelineMarkdown('hello')).toEqual([{ kind: 'text', content: 'hello' }]);
  });

  it('parses headings 1-6 with required space', () => {
    expect(parseTimelineMarkdown('# Title')).toEqual([
      { kind: 'heading', level: 1, content: 'Title' },
    ]);
    expect(parseTimelineMarkdown('### Section')).toEqual([
      { kind: 'heading', level: 3, content: 'Section' },
    ]);
    expect(parseTimelineMarkdown('#### Sub')).toEqual([
      { kind: 'heading', level: 4, content: 'Sub' },
    ]);
    expect(parseTimelineMarkdown('##### Tiny')).toEqual([
      { kind: 'heading', level: 5, content: 'Tiny' },
    ]);
    expect(parseTimelineMarkdown('###### Smallest')).toEqual([
      { kind: 'heading', level: 6, content: 'Smallest' },
    ]);
    // 7+ hashes falls to text
    expect(parseTimelineMarkdown('####### too deep')[0].kind).toBe('text');
    // missing space is text
    expect(parseTimelineMarkdown('#NoSpace')[0].kind).toBe('text');
  });

  it('parses bullets and numbered lists', () => {
    expect(parseTimelineMarkdown('- item')).toEqual([{ kind: 'bullet', content: 'item' }]);
    expect(parseTimelineMarkdown('* star')).toEqual([{ kind: 'bullet', content: 'star' }]);
    expect(parseTimelineMarkdown('1. first\n2) second')).toEqual([
      { kind: 'numbered', marker: '1.', content: 'first' },
      { kind: 'numbered', marker: '2)', content: 'second' },
    ]);
  });

  it('handles code fence — verbatim lines, not interpreted', () => {
    const out = parseTimelineMarkdown('text\n```\n# not heading\n- not bullet\n```\nback');
    expect(out).toEqual([
      { kind: 'text', content: 'text' },
      { kind: 'code', content: '# not heading' },
      { kind: 'code', content: '- not bullet' },
      { kind: 'text', content: 'back' },
    ]);
  });

  it('blank line → blank kind', () => {
    expect(parseTimelineMarkdown('a\n\nb')).toEqual([
      { kind: 'text', content: 'a' },
      { kind: 'blank' },
      { kind: 'text', content: 'b' },
    ]);
  });

  it('parses tables with header separator', () => {
    const md = '| col1 | col2 |\n|------|------|\n| a    | b    |\n| c    | d    |';
    const out = parseTimelineMarkdown(md);
    expect(out.length).toBe(1);
    expect(out[0].kind).toBe('table');
    if (out[0].kind === 'table') {
      expect(out[0].hasHeader).toBe(true);
      expect(out[0].rows).toEqual([
        ['col1', 'col2'],
        ['a', 'b'],
        ['c', 'd'],
      ]);
    }
  });

  it('parses tables without separator (no header)', () => {
    const md = '| a | b |\n| c | d |';
    const out = parseTimelineMarkdown(md);
    expect(out.length).toBe(1);
    expect(out[0].kind).toBe('table');
    if (out[0].kind === 'table') {
      expect(out[0].hasHeader).toBe(false);
      expect(out[0].rows).toEqual([
        ['a', 'b'],
        ['c', 'd'],
      ]);
    }
  });

  it('table block ends at first non-table line', () => {
    const md = '| a | b |\n| c | d |\n\nback to text';
    const out = parseTimelineMarkdown(md);
    expect(out.length).toBe(3);
    expect(out[0].kind).toBe('table');
    expect(out[1].kind).toBe('blank');
    expect(out[2]).toEqual({ kind: 'text', content: 'back to text' });
  });

  it('quote lines parse', () => {
    expect(parseTimelineMarkdown('> quoted')).toEqual([{ kind: 'quote', content: 'quoted' }]);
  });
});

// ============================================================
// parseInlineSpans — bold / italic / code / link tokenizer
// ============================================================
describe('parseInlineSpans', () => {
  it('returns empty for empty string', () => {
    expect(parseInlineSpans('')).toEqual([]);
  });

  it('returns single plain span for plain text', () => {
    expect(parseInlineSpans('just text')).toEqual([{ kind: 'plain', text: 'just text' }]);
  });

  it('parses **bold**', () => {
    expect(parseInlineSpans('a **bold** b')).toEqual([
      { kind: 'plain', text: 'a ' },
      { kind: 'bold', text: 'bold' },
      { kind: 'plain', text: ' b' },
    ]);
  });

  it('parses *italic* (single star)', () => {
    expect(parseInlineSpans('a *italic* b')).toEqual([
      { kind: 'plain', text: 'a ' },
      { kind: 'italic', text: 'italic' },
      { kind: 'plain', text: ' b' },
    ]);
  });

  it('parses `code` inline', () => {
    expect(parseInlineSpans('use `npm install`')).toEqual([
      { kind: 'plain', text: 'use ' },
      { kind: 'code', text: 'npm install' },
    ]);
  });

  it('parses [text](url) link', () => {
    expect(parseInlineSpans('see [docs](https://example.com)')).toEqual([
      { kind: 'plain', text: 'see ' },
      { kind: 'link', text: 'docs', href: 'https://example.com' },
    ]);
  });

  it('unclosed ** falls back to plain', () => {
    expect(parseInlineSpans('hello **world without close')).toEqual([
      { kind: 'plain', text: 'hello **world without close' },
    ]);
  });

  it('multiple spans in one line', () => {
    expect(parseInlineSpans('**Bold** and *italic* and `code`.')).toEqual([
      { kind: 'bold', text: 'Bold' },
      { kind: 'plain', text: ' and ' },
      { kind: 'italic', text: 'italic' },
      { kind: 'plain', text: ' and ' },
      { kind: 'code', text: 'code' },
      { kind: 'plain', text: '.' },
    ]);
  });

  it('first-match-wins: ** consumed before * (no double-italic split)', () => {
    expect(parseInlineSpans('**bold**')).toEqual([{ kind: 'bold', text: 'bold' }]);
  });
});

// ============================================================
// prepareMarkdownDetail vs cleanDetailText — bridge emit-path regression
// ============================================================
describe('prepareMarkdownDetail', () => {
  it('preserves markdown markers (chat-response detail goes to client)', () => {
    const input = '## 정리\n\n**bold** and *italic* and `code`\n\n| a | b |\n|---|---|\n| 1 | 2 |';
    const out = prepareMarkdownDetail(input);
    // All markers must survive so client parseTimelineMarkdown / parseInlineSpans can render them.
    expect(out).toContain('## 정리');
    expect(out).toContain('**bold**');
    expect(out).toContain('*italic*');
    expect(out).toContain('`code`');
    expect(out).toContain('| a | b |');
    expect(out).toContain('|---|---|');
  });

  it('still filters system JSON blobs', () => {
    expect(prepareMarkdownDetail('{"connectionId":"abc","stateVersion":1}')).toBe('');
    expect(prepareMarkdownDetail('{"error":"boom"}')).toBe('boom');
  });

  it('collapses 3+ blank lines but keeps double-blank paragraph break', () => {
    const out = prepareMarkdownDetail('a\n\n\n\nb');
    expect(out).toBe('a\n\nb');
  });

  it('contrasts with cleanDetailText which strips markdown (non-chat path)', () => {
    const md = '## 정리\n\n**bold**';
    expect(cleanDetailText(md)).not.toContain('##');
    expect(cleanDetailText(md)).not.toContain('**');
    expect(prepareMarkdownDetail(md)).toContain('##');
    expect(prepareMarkdownDetail(md)).toContain('**');
  });
});
