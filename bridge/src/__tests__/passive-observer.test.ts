import { describe, expect, it } from 'vitest';
import {
  parseClaudeTranscript,
  parseCodexRollout,
  parseLsofRollouts,
  parseProcessTable,
} from '../passive-observer.js';

function jsonl(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n');
}

describe('passive-observer parsers', () => {
  it('parses ps output without depending on fixed command columns', () => {
    const rows = parseProcessTable([
      ' 123 1 20480 /opt/homebrew/bin/codex --model gpt-5.4',
      ' 456 123 1024 /bin/zsh -lc claude',
      'not a process row',
    ].join('\n'));

    expect(rows).toEqual([
      {
        pid: 123,
        ppid: 1,
        rssKb: 20480,
        command: '/opt/homebrew/bin/codex --model gpt-5.4',
      },
      {
        pid: 456,
        ppid: 123,
        rssKb: 1024,
        command: '/bin/zsh -lc claude',
      },
    ]);
  });

  it('summarizes Claude transcripts and redacts tool secrets', () => {
    const summary = parseClaudeTranscript(jsonl([
      {
        type: 'user',
        timestamp: '2026-04-26T01:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'fix it' }] },
      },
      {
        type: 'assistant',
        timestamp: '2026-04-26T01:00:01.000Z',
        message: {
          model: 'claude-sonnet-4-5',
          usage: {
            input_tokens: 100_000,
            output_tokens: 1_000,
            cache_read_input_tokens: 50_000,
            cache_creation_input_tokens: 250,
          },
          content: [
            {
              type: 'tool_use',
              name: 'Bash',
              input: { command: 'curl -H "Authorization: Bearer token-123" https://example.test' },
            },
          ],
        },
      },
    ]));

    expect(summary.modelName).toBe('claude-sonnet-4-5');
    expect(summary.state).toBe('processing');
    expect(summary.totalTokens).toBe(151_250);
    expect(Math.round(summary.contextPercent ?? 0)).toBe(75);
    expect(summary.currentTask).toContain('[REDACTED]');
    expect(summary.currentTask).not.toContain('token-123');
  });

  it('summarizes Codex rollout metadata, context, and pending tool calls', () => {
    const summary = parseCodexRollout(jsonl([
      {
        type: 'session_meta',
        payload: {
          id: 'codex-session-1',
          cwd: '/Users/example/github/AgentDeck',
          timestamp: '2026-04-26T01:00:00.000Z',
        },
      },
      {
        type: 'turn_context',
        payload: { model: 'gpt-5.4', effort: 'high', model_context_window: 200_000 },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 200_000,
            total_token_usage: { input_tokens: 1000, output_tokens: 200, cached_input_tokens: 300 },
            last_token_usage: { input_tokens: 20_000, cached_input_tokens: 10_000 },
          },
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'call-1',
          name: 'exec_command',
          arguments: JSON.stringify({ cmd: 'pnpm typecheck' }),
        },
      },
    ]));

    expect(summary).toEqual(expect.objectContaining({
      sessionId: 'codex-session-1',
      cwd: '/Users/example/github/AgentDeck',
      modelName: 'gpt-5.4 high',
      effort: 'high',
      state: 'processing',
      currentTask: 'exec_command pnpm typecheck',
      totalTokens: 1500,
    }));
    expect(Math.round(summary.contextPercent ?? 0)).toBe(15);
  });

  it('maps lsof field output to Codex rollout files by pid', () => {
    const rollouts = parseLsofRollouts([
      'p123',
      'n/Users/example/.codex/sessions/2026/04/26/rollout-abc.jsonl',
      'p456',
      'n/Users/example/.codex/config.toml',
      'n/Users/example/.codex/sessions/2026/04/26/rollout-def.jsonl',
    ].join('\n'));

    expect(rollouts.get(123)).toBe('/Users/example/.codex/sessions/2026/04/26/rollout-abc.jsonl');
    expect(rollouts.get(456)).toBe('/Users/example/.codex/sessions/2026/04/26/rollout-def.jsonl');
  });
});
