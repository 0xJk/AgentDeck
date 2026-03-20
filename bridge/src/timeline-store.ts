/**
 * Bridge-side timeline store — minimal server-side event buffer.
 * Stores recent timeline entries for relay to Android/plugin clients.
 * No scroll/grouping logic (that's client-side).
 */

import type { TimelineEntry } from './types.js';
import { isRepetitiveEntry, cleanRawText, cleanNopMarkers } from '@agentdeck/shared';

type EntryListener = (entry: TimelineEntry, upsert?: boolean) => void;

const MAX_ENTRIES = 200;

export class BridgeTimelineStore {
  private entries: TimelineEntry[] = [];
  private listeners: EntryListener[] = [];

  addEntry(entry: TimelineEntry): void {
    // Clean text artifacts (markdown, NOP markers) at store level
    if (entry.raw) entry = { ...entry, raw: cleanNopMarkers(cleanRawText(entry.raw)) };
    if (entry.detail) entry = { ...entry, detail: cleanNopMarkers(entry.detail) };

    // Dedup: skip if same type + raw within 5 seconds
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (entry.ts - e.ts > 5_000) break;
      if (e.type === entry.type && e.raw === entry.raw) return;
    }

    // Repetitive entry dedup (10min window) — merge into existing entry
    const repIdx = isRepetitiveEntry(entry, this.entries);
    if (repIdx >= 0) {
      const existing = this.entries[repIdx];
      existing.repeatCount = (existing.repeatCount || 1) + 1;
      existing.ts = entry.ts;
      // For chat_end dedup, also remove the paired chat_start if it's also repetitive
      if (entry.type === 'chat_end') {
        for (let j = this.entries.length - 1; j >= 0; j--) {
          const cs = this.entries[j];
          if (cs.type !== 'chat_start') continue;
          if (entry.ts - cs.ts > 3_600_000) break;
          // Only remove if this chat_start is itself repetitive (has a matching earlier one)
          if (isRepetitiveEntry(cs, this.entries.slice(0, j)) >= 0) {
            this.entries.splice(j, 1);
            break;
          }
        }
      }
      for (const cb of this.listeners) cb(existing, true);
      return;
    }

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
