import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readLastTurn } from '../apme/claude-transcript-reader.js';

// Picks the most recent user→assistant turn out of a Claude Code JSONL
// transcript. These fixtures mirror the structure Claude Code writes to
// `~/.claude/projects/<project>/<session>.jsonl`: one JSON object per line
// with `message.role` + `message.content` (array of blocks).

function fixture(records: unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

describe('readLastTurn', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'transcript-test-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function writeTranscript(content: string): string {
    const path = join(dir, 'session.jsonl');
    writeFileSync(path, content);
    return path;
  }

  it('extracts assistant text and user prompt from a text-only turn', () => {
    const path = writeTranscript(fixture([
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'what is 2+2?' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '4' }] } },
    ]));
    const out = readLastTurn(path);
    expect(out).not.toBeNull();
    expect(out!.userPrompt).toBe('what is 2+2?');
    expect(out!.assistantText).toBe('4');
    expect(out!.toolUseCount).toBe(0);
    expect(out!.hasAssistantText).toBe(true);
  });

  it('flags tool-only turns (tool_use blocks, no text blocks)', () => {
    const path = writeTranscript(fixture([
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'read the file' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } },
        { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls' } },
      ] } },
    ]));
    const out = readLastTurn(path);
    expect(out).not.toBeNull();
    expect(out!.assistantText).toBe('');
    expect(out!.toolUseCount).toBe(2);
    expect(out!.hasAssistantText).toBe(false);
  });

  it('concatenates text across multiple assistant records for one turn', () => {
    // After a tool_use/tool_result round-trip, Claude emits a second assistant
    // entry. Both text blocks should join into `assistantText`.
    const path = writeTranscript(fixture([
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'summarise' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'text', text: 'let me read it' },
        { type: 'tool_use', id: 't1', name: 'Read', input: {} },
      ] } },
      { type: 'user', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'file contents' },
      ] } },
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'text', text: 'the file is short.' },
      ] } },
    ]));
    const out = readLastTurn(path);
    expect(out).not.toBeNull();
    // The most recent `user` role entry is the tool_result one, so the last
    // turn begins AFTER it — only the final assistant entry counts.
    expect(out!.assistantText).toBe('the file is short.');
    expect(out!.userPrompt).toBe(''); // tool_result has no text block
  });

  it('picks the LAST user prompt when multiple turns are in the file', () => {
    const path = writeTranscript(fixture([
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'first question' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'second question' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'second answer' }] } },
    ]));
    const out = readLastTurn(path);
    expect(out!.userPrompt).toBe('second question');
    expect(out!.assistantText).toBe('second answer');
  });

  it('returns null for missing file', () => {
    expect(readLastTurn(join(dir, 'nonexistent.jsonl'))).toBeNull();
  });

  it('skips malformed lines and continues parsing', () => {
    const path = writeTranscript([
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
      'this-is-not-json',
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'world' }] } }),
    ].join('\n') + '\n');
    const out = readLastTurn(path);
    expect(out!.userPrompt).toBe('hello');
    expect(out!.assistantText).toBe('world');
  });

  it('accepts legacy string content on both roles', () => {
    const path = writeTranscript(fixture([
      { type: 'user', message: { role: 'user', content: 'legacy prompt' } },
      { type: 'assistant', message: { role: 'assistant', content: 'legacy answer' } },
    ]));
    const out = readLastTurn(path);
    expect(out!.userPrompt).toBe('legacy prompt');
    expect(out!.assistantText).toBe('legacy answer');
  });
});
