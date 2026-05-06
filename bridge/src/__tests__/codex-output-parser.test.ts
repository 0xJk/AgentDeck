import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CodexOutputParser } from '../codex-output-parser.js';

describe('CodexOutputParser', () => {
  let parser: CodexOutputParser;

  beforeEach(() => {
    parser = new CodexOutputParser();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('idle detection', () => {
    it('emits idle on ❯ prompt with source=prompt', () => {
      const handler = vi.fn();
      parser.on('idle', handler);

      // First feed to set seenFirstIdle
      parser.feed('❯ ');
      vi.advanceTimersByTime(300);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0]).toEqual({ source: 'prompt' });
    });

    it('emits idle on > prompt', () => {
      const handler = vi.fn();
      parser.on('idle', handler);

      parser.feed('> ');
      vi.advanceTimersByTime(300);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0]).toEqual({ source: 'prompt' });
    });

    it('debounces rapid idle signals', () => {
      const handler = vi.fn();
      parser.on('idle', handler);

      parser.feed('> ');
      parser.feed('> ');
      parser.feed('> ');
      vi.advanceTimersByTime(300);
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('spinner detection', () => {
    it('emits spinner_start on braille spinner chars after first idle', () => {
      const startHandler = vi.fn();
      parser.on('spinner_start', startHandler);

      // Establish first idle
      parser.feed('> ');
      vi.advanceTimersByTime(300);

      // Now spinner
      parser.feed('⠋ Thinking...');
      vi.advanceTimersByTime(100);
      expect(startHandler).toHaveBeenCalledTimes(1);
    });

    it('does not emit spinner_start before first idle', () => {
      const startHandler = vi.fn();
      parser.on('spinner_start', startHandler);

      parser.feed('⠋ Loading...');
      vi.advanceTimersByTime(2000);
      expect(startHandler).not.toHaveBeenCalled();
    });

    it('emits spinner_stop + idle on timeout with source=timeout', () => {
      const stopHandler = vi.fn();
      const idleHandler = vi.fn();
      parser.on('spinner_stop', stopHandler);
      parser.on('idle', idleHandler);

      // First idle
      parser.feed('> ');
      vi.advanceTimersByTime(300);
      idleHandler.mockClear();

      // Start spinner
      parser.feed('⠙ Working...');
      vi.advanceTimersByTime(100);

      // Wait for timeout
      vi.advanceTimersByTime(2000);
      expect(stopHandler).toHaveBeenCalledTimes(1);
      expect(idleHandler).toHaveBeenCalledTimes(1);
      // Synthetic timeout idle is distinct from prompt-driven idle so the
      // bridge can ignore it (mid-turn tool execution looks like timeout).
      expect(idleHandler.mock.calls[0][0]).toEqual({ source: 'timeout' });
    });

    it('emits spinner_stop when idle prompt appears', () => {
      const stopHandler = vi.fn();
      parser.on('spinner_stop', stopHandler);

      // First idle → spinner → idle
      parser.feed('> ');
      vi.advanceTimersByTime(300);

      parser.feed('⠹ Processing...');
      vi.advanceTimersByTime(100);

      parser.feed('> ');
      expect(stopHandler).toHaveBeenCalledTimes(1);
    });

    it('detects "Thinking" text as processing', () => {
      const startHandler = vi.fn();
      parser.on('spinner_start', startHandler);

      parser.feed('> ');
      vi.advanceTimersByTime(300);

      parser.feed('Thinking about your request...');
      vi.advanceTimersByTime(100);
      expect(startHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe('permission prompt detection', () => {
    it('emits permission_prompt on Allow/Deny pattern', () => {
      const handler = vi.fn();
      parser.on('permission_prompt', handler);

      parser.feed('> ');
      vi.advanceTimersByTime(300);

      parser.feed('Allow this command? Allow  Deny');
      vi.advanceTimersByTime(150);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].options).toContain('Deny');
    });

    it('emits permission_prompt on y/n pattern', () => {
      const handler = vi.fn();
      parser.on('permission_prompt', handler);

      parser.feed('Run this command? (y)es / (n)o');
      vi.advanceTimersByTime(150);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].options).toContain('Yes');
      expect(handler.mock.calls[0][0].options).toContain('No');
    });

    it('stops spinner when approval detected', () => {
      const stopHandler = vi.fn();
      parser.on('spinner_stop', stopHandler);

      // First idle → spinner → approval
      parser.feed('> ');
      vi.advanceTimersByTime(300);

      parser.feed('⠋ Working...');
      vi.advanceTimersByTime(100);

      parser.feed('Allow once  Always allow  Deny');
      expect(stopHandler).toHaveBeenCalledTimes(1);
    });

    it('extracts Allow once / Always allow options', () => {
      const handler = vi.fn();
      parser.on('permission_prompt', handler);

      parser.feed('Allow once  Always allow  Deny');
      vi.advanceTimersByTime(150);
      const opts = handler.mock.calls[0][0].options;
      expect(opts).toContain('Allow once');
      expect(opts).toContain('Always allow');
      expect(opts).toContain('Deny');
    });
  });

  describe('tool action detection', () => {
    it('detects Running: command pattern', () => {
      const handler = vi.fn();
      parser.on('tool_action', handler);

      parser.feed('Running: ls -la /tmp');
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ tool: 'shell', args: 'ls -la /tmp' }),
      );
    });

    it('detects file operation patterns', () => {
      const handler = vi.fn();
      parser.on('tool_action', handler);

      parser.feed('Reading src/index.ts');
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ tool: 'reading', args: 'src/index.ts' }),
      );
    });

    it('detects Editing file pattern', () => {
      const handler = vi.fn();
      parser.on('tool_action', handler);

      parser.feed('Editing package.json');
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ tool: 'editing', args: 'package.json' }),
      );
    });

    it('dedups repeated emits of the same (tool, args) within window', () => {
      const handler = vi.fn();
      parser.on('tool_action', handler);

      // Same command fed 4 times in quick succession — Ink TUI redraws the
      // "Running:" line into multiple PTY chunks.
      parser.feed('Running: ls -la /tmp');
      parser.feed('Running: ls -la /tmp');
      vi.advanceTimersByTime(100);
      parser.feed('Running: ls -la /tmp');
      parser.feed('Running: ls -la /tmp');
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('emits a different command immediately', () => {
      const handler = vi.fn();
      parser.on('tool_action', handler);

      parser.feed('Running: ls -la /tmp');
      parser.feed('Running: grep foo bar.txt');
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('re-emits the same command after the dedup window elapses', () => {
      const handler = vi.fn();
      parser.on('tool_action', handler);

      parser.feed('Running: ls -la /tmp');
      vi.advanceTimersByTime(5_000);
      parser.feed('Running: ls -la /tmp');
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('re-emits the same command after a turn boundary (idle resets dedup)', () => {
      const handler = vi.fn();
      parser.on('tool_action', handler);

      // Establish first idle so spinner gating is open.
      parser.feed('> ');
      vi.advanceTimersByTime(300);

      parser.feed('Running: ls -la /tmp');
      expect(handler).toHaveBeenCalledTimes(1);

      // New turn cycle: spinner → idle → next prompt running same command.
      parser.feed('⠋ Working...');
      vi.advanceTimersByTime(100);
      parser.feed('> ');
      vi.advanceTimersByTime(300);

      parser.feed('Running: ls -la /tmp');
      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  describe('model info detection', () => {
    it('detects gpt model name', () => {
      const handler = vi.fn();
      parser.on('model_info', handler);

      parser.feed('using gpt-5.3-codex');
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-5.3-codex' }),
      );
    });

    it('detects o-series model', () => {
      const handler = vi.fn();
      parser.on('model_info', handler);

      parser.feed('model: o3');
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'o3' }),
      );
    });

    it('does not re-emit same model', () => {
      const handler = vi.fn();
      parser.on('model_info', handler);

      parser.feed('model: o3');
      parser.feed('model: o3');
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('project name detection', () => {
    it('detects working directory', () => {
      const handler = vi.fn();
      parser.on('project_name', handler);

      parser.feed('Working directory: /Users/dev/my-project');
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'my-project' }),
      );
      expect(parser.getProjectName()).toBe('my-project');
    });

    it('detects project from path', () => {
      const handler = vi.fn();
      parser.on('project_name', handler);

      parser.feed('~/github/AgentDeck');
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'AgentDeck' }),
      );
    });

    it('only detects project name once', () => {
      const handler = vi.fn();
      parser.on('project_name', handler);

      parser.feed('Working in /Users/dev/project-a');
      parser.feed('Working in /Users/dev/project-b');
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('buffer management', () => {
    it('truncates buffer at 8192 chars', () => {
      const longData = 'x'.repeat(9000);
      parser.feed(longData);
      // Should not throw — internal buffer is managed
    });

    it('handles incomplete ANSI sequences', () => {
      // Incomplete CSI sequence
      parser.feed('some text \x1b[');
      parser.feed('32m green \x1b[0m');
      // Should not throw
    });
  });

  describe('getProjectName', () => {
    it('returns null when no project detected', () => {
      expect(parser.getProjectName()).toBeNull();
    });
  });
});
