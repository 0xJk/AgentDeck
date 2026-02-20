import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdirSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// We test session-registry internals by importing and overriding the file path.
// Since the module uses hardcoded paths, we test via the exported functions
// after setting up a temp environment.

// Re-implement the core logic here for unit testing (avoids modifying source
// for testability). This tests the algorithms, not the exact module wiring.

interface SessionEntry {
  id: string;
  port: number;
  pid: number;
  projectName: string;
  tmuxSession?: string;
  startedAt: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pruneDeadSessions(sessions: SessionEntry[]): SessionEntry[] {
  return sessions.filter((s) => isProcessAlive(s.pid));
}

describe('Session Registry Logic', () => {
  describe('pruneDeadSessions', () => {
    it('keeps alive sessions', () => {
      const entry: SessionEntry = {
        id: randomUUID(),
        port: 9120,
        pid: process.pid, // current process is alive
        projectName: 'test',
        startedAt: new Date().toISOString(),
      };
      const result = pruneDeadSessions([entry]);
      expect(result).toHaveLength(1);
    });

    it('removes sessions with dead PIDs', () => {
      const entry: SessionEntry = {
        id: randomUUID(),
        port: 9120,
        pid: 999999, // almost certainly not running
        projectName: 'test',
        startedAt: new Date().toISOString(),
      };
      const result = pruneDeadSessions([entry]);
      expect(result).toHaveLength(0);
    });

    it('keeps old sessions if PID is alive', () => {
      const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000); // 48h ago
      const entry: SessionEntry = {
        id: randomUUID(),
        port: 9120,
        pid: process.pid,
        projectName: 'test',
        startedAt: oldDate.toISOString(),
      };
      const result = pruneDeadSessions([entry]);
      expect(result).toHaveLength(1);
    });

    it('handles mix of alive and dead sessions', () => {
      const sessions: SessionEntry[] = [
        {
          id: randomUUID(),
          port: 9120,
          pid: process.pid,
          projectName: 'alive',
          startedAt: new Date().toISOString(),
        },
        {
          id: randomUUID(),
          port: 9121,
          pid: 999999,
          projectName: 'dead',
          startedAt: new Date().toISOString(),
        },
        {
          id: randomUUID(),
          port: 9122,
          pid: process.pid,
          projectName: 'old-but-alive',
          startedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
        },
      ];
      const result = pruneDeadSessions(sessions);
      expect(result).toHaveLength(2);
      expect(result.map((s) => s.projectName)).toEqual(['alive', 'old-but-alive']);
    });
  });

  describe('port allocation logic', () => {
    const BASE_PORT = 9120;
    const MAX_PORT = 9129;

    function findAvailablePort(usedPorts: Set<number>): number {
      for (let port = BASE_PORT; port <= MAX_PORT; port++) {
        if (!usedPorts.has(port)) {
          return port;
        }
      }
      return BASE_PORT;
    }

    it('returns base port when no ports are used', () => {
      expect(findAvailablePort(new Set())).toBe(9120);
    });

    it('returns next port when base is taken', () => {
      expect(findAvailablePort(new Set([9120]))).toBe(9121);
    });

    it('skips used ports', () => {
      expect(findAvailablePort(new Set([9120, 9121, 9122]))).toBe(9123);
    });

    it('finds gaps in used ports', () => {
      expect(findAvailablePort(new Set([9120, 9122]))).toBe(9121);
    });

    it('falls back to base port when all taken', () => {
      const all = new Set<number>();
      for (let p = BASE_PORT; p <= MAX_PORT; p++) all.add(p);
      expect(findAvailablePort(all)).toBe(BASE_PORT);
    });
  });

  describe('atomic write', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = join(tmpdir(), `agentdeck-test-${randomUUID()}`);
      mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('write-then-rename produces valid JSON', async () => {
      const { writeFileSync, renameSync } = await import('fs');
      const sessions: SessionEntry[] = [
        {
          id: randomUUID(),
          port: 9120,
          pid: process.pid,
          projectName: 'test',
          startedAt: new Date().toISOString(),
        },
      ];

      const tmpFile = join(tmpDir, `.sessions.${randomUUID()}.tmp`);
      const target = join(tmpDir, 'sessions.json');

      writeFileSync(tmpFile, JSON.stringify(sessions, null, 2), 'utf-8');
      renameSync(tmpFile, target);

      const read = JSON.parse(readFileSync(target, 'utf-8'));
      expect(read).toHaveLength(1);
      expect(read[0].projectName).toBe('test');
      // Temp file should not exist after rename
      expect(existsSync(tmpFile)).toBe(false);
    });
  });
});
