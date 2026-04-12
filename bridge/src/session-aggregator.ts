import { listActive as listActiveSessions, type SessionEntry } from './session-registry.js';
import type { AgentType } from './types.js';
import { sortSessions } from '@agentdeck/shared';

export interface EnrichedSession {
  id: string;
  port: number;
  projectName: string;
  agentType?: AgentType;
  alive: boolean;
  state?: string;
  modelName?: string;
  startedAt?: string;
}

/** Cache last-known sibling state to avoid propagating undefined on transient fetch failures */
const siblingStateCache = new Map<string, { state: string; modelName?: string }>();

/** Clear cache entry when a session is removed (call from session-registry cleanup) */
export function clearSiblingStateCache(sessionId: string): void {
  siblingStateCache.delete(sessionId);
}

/**
 * Enrich sibling sessions with state from their /health endpoint.
 * For the own session (matched by ownSessionId), uses ownState directly.
 * On fetch failure, falls back to last-known cached state to prevent
 * transient undefined propagation to all clients.
 */
export async function enrichSessionsWithState(
  sessions: SessionEntry[],
  ownSessionId: string,
  ownState: string,
  ownModelName?: string,
): Promise<EnrichedSession[]> {
  return Promise.all(sessions.map(async (s) => {
    const base: EnrichedSession = {
      id: s.id,
      port: s.port,
      projectName: s.projectName,
      agentType: s.agentType as AgentType | undefined,
      alive: true,
      startedAt: s.startedAt,
    };
    if (s.id === ownSessionId) return { ...base, state: ownState, modelName: ownModelName };
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/health`, { signal: AbortSignal.timeout(2000) });
      const data = await res.json() as { state?: string; modelName?: string };
      if (data.state) {
        siblingStateCache.set(s.id, { state: data.state, modelName: data.modelName });
      }
      return { ...base, state: data.state, modelName: data.modelName };
    } catch {
      const cached = siblingStateCache.get(s.id);
      if (cached) return { ...base, state: cached.state, modelName: cached.modelName };
      return base;
    }
  }));
}

/**
 * Build an enriched sessions list for multi-session display.
 */
export async function buildEnrichedSessionsList(
  ownSessionId: string,
  ownState: string,
  ownModelName?: string,
): Promise<EnrichedSession[]> {
  const siblings = listActiveSessions().filter(s => s.agentType !== 'daemon' && s.id !== ownSessionId);
  const enriched = await enrichSessionsWithState(siblings, ownSessionId, ownState, ownModelName);
  return sortSessions(enriched);
}
