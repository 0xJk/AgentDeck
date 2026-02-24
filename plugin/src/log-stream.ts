/**
 * Log stream parser for OpenClaw — spawns `openclaw logs --follow --json`
 * and converts structured log lines into TimelineEntry events.
 *
 * Defensive parsing: unrecognized log lines are silently ignored.
 * Dedup: tool_exec entries are skipped if a matching tool_request was
 * recently added via the Gateway WebSocket (within 5 seconds).
 */

import { spawn, type ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import { augmentedPath, resolveOpenClawBin } from '@agentdeck/shared';
import { timelineStore, type TimelineEntry } from './timeline-store.js';
import { dlog, dwarn } from './log.js';

const TAG = 'LogStream';

/** Parse a single JSON log line into a TimelineEntry, or null if unrecognized. */
function parseLogLine(json: unknown): TimelineEntry | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;

  const msg = obj.msg as string | undefined;
  const component = obj.component as string | undefined;
  const action = obj.action as string | undefined;
  const model = obj.model as string | undefined;
  const tool = obj.tool as string | undefined;
  const tokens = obj.tokens as number | undefined;
  const rawTs = (obj.ts as number) || (obj.timestamp as number) || (obj.time as number);
  const ts = rawTs || Date.now();

  // Model inference start
  if (model && (action === 'start' || action === 'request' || msg?.includes('inference start') || msg?.includes('model request'))) {
    return { ts, type: 'model_call', raw: model };
  }

  // Model inference complete
  if (model && (action === 'complete' || action === 'done' || action === 'response' || msg?.includes('inference complete') || msg?.includes('model response'))) {
    // If content is present, emit as chat_response for timeline display
    const content = obj.content as string | undefined;
    if (content && content.length > 10) {
      return {
        ts, type: 'chat_response' as const,
        raw: content.length > 200 ? content.slice(0, 197) + '...' : content,
      };
    }
    const parts = [model];
    if (tokens) parts.push(`${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}K` : tokens} tok`);
    const duration = obj.duration as number | undefined;
    if (duration) parts.push(`${(duration / 1000).toFixed(1)}s`);
    return { ts, type: 'model_response', raw: parts.join(' \u00b7 ') };
  }

  // Memory / recall / search
  if (component === 'memory' || action === 'recall' || action === 'search' ||
      msg?.includes('memory search') || msg?.includes('memory recall')) {
    const query = (obj.query as string) || msg || 'memory search';
    return { ts, type: 'memory_recall', raw: query };
  }

  // Tool execution (non-approval tools, internal operations)
  if (tool || (component === 'tool' && action)) {
    const toolName = tool || action || 'tool';
    const detail = (obj.detail as string) || (obj.command as string) || '';
    return { ts, type: 'tool_exec', raw: detail ? `${toolName}: ${detail}` : toolName };
  }

  // Unrecognized — silently skip
  return null;
}

export class LogStream {
  private proc: ChildProcess | null = null;
  private running = false;
  /** Recent tool_request raw texts for dedup against log-based tool_exec */
  private recentToolRequests = new Map<string, number>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.running) return;

    const bin = resolveOpenClawBin();
    dlog(TAG, `Starting log stream: ${bin} logs --follow --json`);

    try {
      this.proc = spawn(bin, ['logs', '--follow', '--json'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, PATH: augmentedPath() },
      });
    } catch (err) {
      dwarn(TAG, `Failed to spawn openclaw logs: ${err}`);
      return;
    }

    this.running = true;

    if (this.proc.stdout) {
      const rl = createInterface({ input: this.proc.stdout });
      rl.on('line', (line) => {
        try {
          const parsed = JSON.parse(line);
          const entry = parseLogLine(parsed);
          if (!entry) return;

          // Dedup: skip tool_exec if a matching tool_request was seen recently
          if (entry.type === 'tool_exec' && this.isDuplicateToolExec(entry.raw)) {
            return;
          }

          timelineStore.addEntry(entry);
        } catch {
          // Not valid JSON — ignore
        }
      });

      rl.on('close', () => {
        dlog(TAG, 'Log stream closed');
        this.running = false;
      });
    }

    this.proc.on('error', (err) => {
      dwarn(TAG, `Log stream error: ${err.message}`);
      this.running = false;
    });

    this.proc.on('exit', (code) => {
      dlog(TAG, `Log stream exited (code=${code})`);
      this.running = false;
      this.proc = null;
    });

    // Periodic cleanup of stale dedup entries
    this.cleanupTimer = setInterval(() => this.cleanupRecentRequests(), 10_000);
  }

  stop(): void {
    if (this.proc) {
      dlog(TAG, 'Stopping log stream');
      this.proc.kill('SIGTERM');
      this.proc = null;
    }
    this.running = false;
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.recentToolRequests.clear();
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Track a tool_request from the WS Gateway to avoid duplicating it
   * when the same tool appears in the log stream.
   */
  trackToolRequest(raw: string): void {
    this.recentToolRequests.set(raw, Date.now());
  }

  private isDuplicateToolExec(raw: string): boolean {
    const ts = this.recentToolRequests.get(raw);
    if (!ts) return false;
    // Consider duplicate if within 5 seconds
    if (Date.now() - ts < 5_000) return true;
    this.recentToolRequests.delete(raw);
    return false;
  }

  private cleanupRecentRequests(): void {
    const cutoff = Date.now() - 10_000;
    for (const [key, ts] of this.recentToolRequests) {
      if (ts < cutoff) this.recentToolRequests.delete(key);
    }
  }
}

export const logStream = new LogStream();
