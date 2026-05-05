/**
 * Bridge-side timeline store — minimal server-side event buffer.
 * Stores recent timeline entries for relay to Android/plugin clients.
 * No scroll/grouping logic (that's client-side).
 */

import type { TimelineEntry } from './types.js';
import { deduplicateEntry } from '@agentdeck/shared';

type EntryListener = (entry: TimelineEntry, upsert?: boolean) => void;

const MAX_ENTRIES = 200;

export class BridgeTimelineStore {
  private entries: TimelineEntry[] = [];
  private listeners: EntryListener[] = [];

  addEntry(entry: TimelineEntry): void {
    const result = deduplicateEntry(entry, this.entries);

    if (result.action === 'skip') return;

    if (result.action === 'merge') {
      const existing = this.entries[result.index];
      existing.repeatCount = (existing.repeatCount || 1) + 1;
      existing.ts = entry.ts;
      existing.agentType = entry.agentType ?? existing.agentType;
      existing.projectName = entry.projectName ?? existing.projectName;
      existing.sessionId = entry.sessionId ?? existing.sessionId;
      existing.runId = entry.runId ?? existing.runId;
      existing.startedAt = entry.startedAt ?? existing.startedAt;
      existing.endedAt = entry.endedAt ?? existing.endedAt;
      if (result.removeChatStartIndex != null) {
        this.entries.splice(result.removeChatStartIndex, 1);
      }
      for (const cb of this.listeners) cb(existing, true);
      return;
    }

    // action === 'add'
    this.entries.push(result.entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.shift();
    }
    for (const cb of this.listeners) cb(result.entry);
  }

  getHistory(since?: number): TimelineEntry[] {
    if (since) {
      return this.entries.filter((e) => e.ts > since);
    }
    return [...this.entries];
  }

  updateEntryStatus(approvalId: string, status: 'approved' | 'denied'): void {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].approvalId === approvalId) {
        this.entries[i] = { ...this.entries[i], status };
        return;
      }
    }
  }

  /** Update existing entry with same ts+type (1s tolerance), or add new */
  upsertEntry(entry: TimelineEntry): void {
    const tolerance = 1000;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.type === entry.type && Math.abs(e.ts - entry.ts) < tolerance) {
        this.entries[i] = {
          ...e,
          raw: entry.raw,
          ...(entry.detail ? { detail: entry.detail } : {}),
          ...(entry.agentType ? { agentType: entry.agentType } : {}),
          ...(entry.projectName ? { projectName: entry.projectName } : {}),
          ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
          ...(entry.runId ? { runId: entry.runId } : {}),
          ...(entry.startedAt ? { startedAt: entry.startedAt } : {}),
          ...(entry.endedAt ? { endedAt: entry.endedAt } : {}),
        };
        for (const cb of this.listeners) cb(this.entries[i], true);
        return;
      }
    }
    this.addEntry(entry);
  }

  /** Get the most recent entry of a given type */
  getLastEntry(type: string): TimelineEntry | null {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].type === type) return this.entries[i];
    }
    return null;
  }

  onEntry(cb: EntryListener): void {
    this.listeners.push(cb);
  }

  removeListener(cb: EntryListener): void {
    const idx = this.listeners.indexOf(cb);
    if (idx !== -1) this.listeners.splice(idx, 1);
  }
}
