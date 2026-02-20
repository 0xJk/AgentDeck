import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { createServer } from 'net';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { debug } from './logger.js';

const SESSIONS_DIR = join(homedir(), '.agentdeck');
const SESSIONS_FILE = join(SESSIONS_DIR, 'sessions.json');
const BASE_PORT = 9120;
const MAX_PORT = 9129;

export interface SessionEntry {
  id: string;
  port: number;
  pid: number;
  projectName: string;
  tmuxSession?: string;
  startedAt: string;
}

function ensureDir(): void {
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

function readSessions(): SessionEntry[] {
  try {
    const data = readFileSync(SESSIONS_FILE, 'utf-8');
    return JSON.parse(data) as SessionEntry[];
  } catch {
    return [];
  }
}

/** Atomic write: write to temp file then rename to prevent corruption */
function writeSessions(sessions: SessionEntry[]): void {
  ensureDir();
  const tmpFile = join(SESSIONS_DIR, `.sessions.${randomUUID()}.tmp`);
  writeFileSync(tmpFile, JSON.stringify(sessions, null, 2), 'utf-8');
  renameSync(tmpFile, SESSIONS_FILE);
}

/** Check if a PID is alive */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Remove dead sessions (PID no longer alive) */
function pruneDeadSessions(sessions: SessionEntry[]): SessionEntry[] {
  return sessions.filter((s) => isProcessAlive(s.pid));
}

export function register(entry: SessionEntry): void {
  const sessions = pruneDeadSessions(readSessions());
  // Remove any stale entry with same id
  const filtered = sessions.filter((s) => s.id !== entry.id);
  filtered.push(entry);
  writeSessions(filtered);
  debug('SessionRegistry', `Registered session ${entry.id} on port ${entry.port}`);
}

export function deregister(id: string): void {
  const sessions = readSessions();
  const filtered = sessions.filter((s) => s.id !== id);
  writeSessions(filtered);
  debug('SessionRegistry', `Deregistered session ${id}`);
}

export function listActive(): SessionEntry[] {
  const sessions = readSessions();
  const alive = pruneDeadSessions(sessions);
  // Write back pruned list if any were removed
  if (alive.length !== sessions.length) {
    writeSessions(alive);
  }
  return alive;
}

/** Try to bind a TCP server to a port to verify it's actually free */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

export async function findAvailablePort(): Promise<number> {
  const sessions = listActive();
  const usedPorts = new Set(sessions.map((s) => s.port));
  for (let port = BASE_PORT; port <= MAX_PORT; port++) {
    if (!usedPorts.has(port) && await isPortFree(port)) {
      return port;
    }
  }
  // Fall back to base port if all taken
  return BASE_PORT;
}

/** Detect tmux session name if running inside tmux */
export function detectTmuxSession(): string | undefined {
  if (!process.env.TMUX) return undefined;
  try {
    const result = execSync('tmux display-message -p "#S:#I"', {
      encoding: 'utf-8',
      timeout: 2000,
    }).trim();
    return result || undefined;
  } catch {
    return undefined;
  }
}
