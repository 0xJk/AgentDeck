/**
 * Bridge-side timeline store — minimal server-side event buffer.
 * Stores recent timeline entries for relay to Android/plugin clients.
 * No scroll/grouping logic (that's client-side).
 */

import type { TimelineEntry } from './types.js';

type EntryListener = (entry: TimelineEntry) => void;

const MAX_ENTRIES = 200;

export class BridgeTimelineStore {
  private entries: TimelineEntry[] = [];
  private listeners: EntryListener[] = [];

  addEntry(entry: TimelineEntry): void {
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.shift();
    }
    for (const cb of this.listeners) cb(entry);
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
        this.entries[i] = { ...e, raw: entry.raw, ...(entry.detail ? { detail: entry.detail } : {}) };
        for (const cb of this.listeners) cb(this.entries[i]);
        return;
      }
    }
    this.addEntry(entry);
  }

  onEntry(cb: EntryListener): void {
    this.listeners.push(cb);
  }

  removeListener(cb: EntryListener): void {
    const idx = this.listeners.indexOf(cb);
    if (idx !== -1) this.listeners.splice(idx, 1);
  }
}
