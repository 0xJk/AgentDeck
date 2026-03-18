import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { createServer } from 'net';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import http from 'http';
import { debug } from './logger.js';

const SESSIONS_DIR = join(homedir(), '.agentdeck');
const SESSIONS_FILE = join(SESSIONS_DIR, 'sessions.json');
const DAEMON_FILE = join(SESSIONS_DIR, 'daemon.json');
export const DAEMON_DEFAULT_PORT = 9120;
const BASE_PORT = 9120;
const MAX_PORT = 9139;

export interface DaemonInfo {
  port: number;
  pid: number;
  startedAt: string;
}

export interface SessionEntry {
  id: string;
  port: number;
  pid: number;
  projectName: string;
  agentType?: string;
  tmuxSession?: string;
  tty?: string;
  parentTty?: string;
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

/** Find an existing live daemon session, if any */
export function findExistingDaemon(): SessionEntry | null {
  const sessions = listActive(); // prunes dead PIDs
  return sessions.find((s) => s.agentType === 'daemon') ?? null;
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
  // All ports exhausted — throw instead of silently colliding
  throw new Error(`All AgentDeck ports (${BASE_PORT}–${MAX_PORT}) are in use. Stop an existing session first.`);
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

// ===== daemon.json — daemon port discovery =====

/** Write daemon.json so clients can discover the daemon port */
export function writeDaemonInfo(info: DaemonInfo): void {
  ensureDir();
  const tmpFile = join(SESSIONS_DIR, `.daemon.${randomUUID()}.tmp`);
  writeFileSync(tmpFile, JSON.stringify(info, null, 2), 'utf-8');
  renameSync(tmpFile, DAEMON_FILE);
  debug('SessionRegistry', `Wrote daemon.json: port=${info.port} pid=${info.pid}`);
}

/** Remove daemon.json on shutdown */
export function removeDaemonInfo(): void {
  try {
    unlinkSync(DAEMON_FILE);
    debug('SessionRegistry', 'Removed daemon.json');
  } catch {
    // Already gone — fine
  }
}

/** Read daemon.json, validate PID is alive, return info or null */
export function readDaemonInfo(): DaemonInfo | null {
  try {
    const data = readFileSync(DAEMON_FILE, 'utf-8');
    const info = JSON.parse(data) as DaemonInfo;
    if (info.pid && isProcessAlive(info.pid)) {
      return info;
    }
    // Stale daemon.json — remove it
    removeDaemonInfo();
    return null;
  } catch {
    return null;
  }
}

/**
 * Probe a port's /health endpoint to check if a daemon is already running there.
 * Returns the health JSON if it's a daemon, null otherwise.
 * Timeout: 2s.
 */
export function probeDaemonHealth(port: number): Promise<{ mode?: string; pid?: number } | null> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve(json);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/**
 * Find the daemon port for client connections.
 * Priority: daemon.json (fast) → sessions.json fallback.
 */
export function findDaemonPort(): number | null {
  // 1. daemon.json — authoritative, includes fallback port
  const info = readDaemonInfo();
  if (info) return info.port;

  // 2. sessions.json — legacy fallback
  const daemon = findExistingDaemon();
  if (daemon) return daemon.port;

  return null;
}
