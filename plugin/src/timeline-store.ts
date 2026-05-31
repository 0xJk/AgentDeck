/**
 * Timeline event store for OpenClaw mode.
 * Per-bridge instance — bridge produces events, E2/E3 dials consume for rendering.
 *
 * Scroll operates on grouped display (consecutive duplicates collapsed).
 * Past events (max 20 displayed) + scheduled/future events (max 10).
 *
 * Persisted to ~/.agentdeck/timeline-<bridgeId>.json so events survive plugin
 * restarts and stay isolated per bridge. Use getTimelineStore() to access the
 * active store and setTimelineBridge(id) when the active bridge changes.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import type { TimelineEntry as SharedTimelineEntry, TimelineEntryType as SharedType } from '@agentdeck/shared';
import { deduplicateEntry } from '@agentdeck/shared';

// Plugin extends shared TimelineEntry with 'now_marker' (display-only, not persisted/relayed)
export interface TimelineEntry {
  ts: number;
  type: SharedType | 'now_marker';
  raw: string;
  detail?: string;
  approvalId?: string;
  status?: 'pending' | 'approved' | 'denied';
  repeatCount?: number;
  automated?: boolean;
}

/** Convert shared TimelineEntry to plugin TimelineEntry (compatible — just re-type) */
export function fromSharedEntry(e: SharedTimelineEntry): TimelineEntry {
  return { ...e, ...(e.repeatCount ? { repeatCount: e.repeatCount } : {}) };
}

/** Consecutive duplicates collapsed into one display item */
export interface GroupedEntry {
  entry: TimelineEntry;
  count: number;
  firstTs: number;
  lastTs: number;
}

type ChangeListener = () => void;

const MAX_ENTRIES = 100;
const DISPLAY_PAST = 20;
const DISPLAY_SCHEDULED = 10;
const AUTO_TRACK_DELAY = 3000;
const GROUP_WINDOW_MS = 60_000;
const TOOL_GROUP_WINDOW_MS = 10_000;
const SAVE_DEBOUNCE_MS = 500;
const AGENTDECK_DIR = join(homedir(), '.agentdeck');
/** Legacy single-file path (pre per-bridge namespace). Migrated once per bridge. */
const LEGACY_TIMELINE_FILE = join(AGENTDECK_DIR, 'timeline.json');

/** Per-bridge timeline file path. */
function timelineFileFor(bridgeId: string): string {
  return join(AGENTDECK_DIR, `timeline-${bridgeId}.json`);
}

/** Group consecutive entries with same type + raw text within window (60s default, 10s for tool_request).
 *  chat_end entries group by type only (ignoring raw) since each has different duration/tools. */
function groupConsecutive(entries: readonly TimelineEntry[]): GroupedEntry[] {
  const groups: GroupedEntry[] = [];
  for (const entry of entries) {
    const last = groups[groups.length - 1];
    const window = entry.type === 'tool_request' ? TOOL_GROUP_WINDOW_MS : GROUP_WINDOW_MS;
    const rawMatch = entry.type === 'chat_end' || last?.entry.raw === entry.raw;
    if (
      last &&
      last.entry.type === entry.type &&
      rawMatch &&
      Math.abs(entry.ts - last.lastTs) < window
    ) {
      last.count++;
      last.lastTs = entry.ts;
      // For chat_end, keep the latest raw/detail (most enriched version)
      if (entry.type === 'chat_end') {
        last.entry = { ...last.entry, raw: entry.raw, ...(entry.detail ? { detail: entry.detail } : {}) };
      }
    } else {
      groups.push({ entry, count: 1, firstTs: entry.ts, lastTs: entry.ts });
    }
  }
  return groups;
}

export class TimelineStore {
  private entries: TimelineEntry[] = [];
  private _scheduled: TimelineEntry[] = [];
  private _scrollIndex = 0;       // index into grouped display
  private _detailMode = false;
  private _autoTrack = true;
  private listeners: ChangeListener[] = [];
  private autoTrackTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private loaded = false;
  private readonly file: string;

  constructor(bridgeId: string) {
    this.file = timelineFileFor(bridgeId);
  }

  // ===== Persistence =====

  /** One-time legacy migration: rename ~/.agentdeck/timeline.json to the
   *  per-bridge file the first time this bridge loads, but only when the
   *  per-bridge file does NOT already exist (never overwrite). Idempotent. */
  private migrateLegacyIfNeeded(): void {
    try {
      if (existsSync(this.file)) return; // per-bridge file wins — never overwrite
      if (!existsSync(LEGACY_TIMELINE_FILE)) return; // nothing to migrate
      renameSync(LEGACY_TIMELINE_FILE, this.file);
    } catch {
      // Migration best-effort — fall back to fresh state on any error
    }
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.migrateLegacyIfNeeded();
    try {
      const data = readFileSync(this.file, 'utf-8');
      const parsed = JSON.parse(data) as TimelineEntry[];
      if (Array.isArray(parsed)) {
        this.entries = parsed.slice(-MAX_ENTRIES);
      }
    } catch {
      // File doesn't exist or corrupted — start fresh
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        writeFileSync(this.file, JSON.stringify(this.entries), 'utf-8');
      } catch {
        // Ignore write errors
      }
    }, SAVE_DEBOUNCE_MS);
  }

  // ===== Public API =====

  addEntry(entry: TimelineEntry): void {
    this.ensureLoaded();

    const result = deduplicateEntry(entry as SharedTimelineEntry, this.entries as SharedTimelineEntry[]);

    if (result.action === 'skip') return;

    if (result.action === 'merge') {
      const existing = this.entries[result.index];
      existing.repeatCount = (existing.repeatCount || 1) + 1;
      existing.ts = entry.ts;
      if (result.removeChatStartIndex != null) {
        this.entries.splice(result.removeChatStartIndex, 1);
      }
      this.scheduleSave();
      this.notify();
      return;
    }

    // action === 'add' — use cleaned entry from dedup pipeline
    entry = result.entry as TimelineEntry;
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.shift();
    }
    if (this._autoTrack) {
      this.autoTrackToLatestPast();
    } else {
      const groups = this.getGroupedDisplay();
      this._scrollIndex = Math.min(this._scrollIndex, Math.max(0, groups.length - 1));
    }
    this.scheduleSave();
    this.notify();
  }

  /** Upsert: find existing entry with same ts+type (±1s) and replace, or add new */
  upsertEntry(entry: TimelineEntry): void {
    this.ensureLoaded();
    const tolerance = 1000;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].type === entry.type && Math.abs(this.entries[i].ts - entry.ts) < tolerance) {
        this.entries[i] = entry;
        this.scheduleSave();
        this.notify();
        return;
      }
    }
    this.addEntry(entry);
  }

  /** Update an existing entry's raw text (e.g. post-enrichment from history) */
  updateEntryRaw(index: number, newRaw: string): void {
    this.ensureLoaded();
    if (index < 0 || index >= this.entries.length) return;
    this.entries[index].raw = newRaw;
    this.scheduleSave();
    this.notify();
  }

  /** Find index of the last entry matching type, searching backwards */
  findLastIndex(type: TimelineEntry['type']): number {
    this.ensureLoaded();
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].type === type) return i;
    }
    return -1;
  }

  /** Update an existing tool_request entry's status */
  updateEntryStatus(approvalId: string, status: 'approved' | 'denied'): void {
    this.ensureLoaded();
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].approvalId === approvalId) {
        this.entries[i].status = status;
        this.scheduleSave();
        this.notify();
        return;
      }
    }
  }

  /**
   * Merge history entries (e.g. events that occurred while plugin was offline).
   * Runs each entry through the dedup pipeline (clean + exact + semantic dedup).
   */
  mergeHistory(newEntries: TimelineEntry[]): void {
    this.ensureLoaded();
    const existing = new Set(this.entries.map((e) => `${e.ts}:${e.type}:${e.raw}`));
    let changed = false;
    for (const entry of newEntries) {
      const key = `${entry.ts}:${entry.type}:${entry.raw}`;
      if (existing.has(key)) continue;
      const result = deduplicateEntry(entry as SharedTimelineEntry, this.entries as SharedTimelineEntry[]);
      if (result.action === 'skip') continue;
      if (result.action === 'merge') {
        const ex = this.entries[result.index];
        ex.repeatCount = (ex.repeatCount || 1) + 1;
        ex.ts = entry.ts;
        if (result.removeChatStartIndex != null) {
          this.entries.splice(result.removeChatStartIndex, 1);
        }
        changed = true;
        continue;
      }
      this.entries.push(result.entry as TimelineEntry);
      existing.add(key);
      changed = true;
    }
    if (!changed) return;
    this.entries.sort((a, b) => a.ts - b.ts);
    while (this.entries.length > MAX_ENTRIES) {
      this.entries.shift();
    }
    if (this._autoTrack) {
      this.autoTrackToLatestPast();
    }
    this.scheduleSave();
    this.notify();
  }

  /** Timestamp of the newest entry, or 0 if empty. Used for history fetch "since". */
  getLastTimestamp(): number {
    this.ensureLoaded();
    return this.entries.length > 0 ? this.entries[this.entries.length - 1].ts : 0;
  }

  /** Replace scheduled (future) entries */
  setScheduled(entries: TimelineEntry[]): void {
    this._scheduled = entries.slice(0, DISPLAY_SCHEDULED);
    this.notify();
  }

  /** Combined + grouped: past (max 20) + NOW marker + scheduled (max 10) */
  getGroupedDisplay(): GroupedEntry[] {
    this.ensureLoaded();
    const past = this.entries.slice(-DISPLAY_PAST);

    // Determine current active action for NOW marker
    let nowRaw = '';
    let nowStatus: 'pending' | undefined;
    const lastStart = [...past].reverse().find(e => e.type === 'chat_start');
    const lastEnd = [...past].reverse().find(e => e.type === 'chat_end');
    const isActive = lastStart && (!lastEnd || lastStart.ts > lastEnd.ts);
    const pendingTool = [...past].reverse().find(e => e.type === 'tool_request' && e.status === 'pending');

    if (pendingTool) {
      nowRaw = pendingTool.raw;
      nowStatus = 'pending';
    } else if (isActive && lastStart) {
      nowRaw = lastStart.raw;
    }

    const nowMarker: TimelineEntry = { ts: Date.now(), type: 'now_marker', raw: nowRaw, status: nowStatus };
    const combined = this._scheduled.length > 0
      ? [...past, nowMarker, ...this._scheduled]
      : [...past, nowMarker];
    return groupConsecutive(combined);
  }

  scroll(delta: number): void {
    const groups = this.getGroupedDisplay();
    if (groups.length === 0) return;
    this._autoTrack = false;
    this._scrollIndex = Math.max(0, Math.min(groups.length - 1, this._scrollIndex + delta));
    this.resetAutoTrackTimer();
    this.notify();
  }

  jumpToLatest(): void {
    this._autoTrack = true;
    this.autoTrackToLatestPast();
    this.notify();
  }

  toggleDetail(): void {
    this._detailMode = !this._detailMode;
    this.notify();
  }

  getScrollIndex(): number {
    return this._scrollIndex;
  }

  isDetailMode(): boolean {
    return this._detailMode;
  }

  onChange(cb: ChangeListener): void {
    this.listeners.push(cb);
  }

  removeListener(cb: ChangeListener): void {
    const idx = this.listeners.indexOf(cb);
    if (idx !== -1) this.listeners.splice(idx, 1);
  }

  clear(): void {
    this.entries = [];
    this._scheduled = [];
    this._scrollIndex = 0;
    this._detailMode = false;
    this._autoTrack = true;
    if (this.autoTrackTimer) {
      clearTimeout(this.autoTrackTimer);
      this.autoTrackTimer = null;
    }
    this.scheduleSave();
    this.notify();
  }

  private autoTrackToLatestPast(): void {
    const groups = this.getGroupedDisplay();
    let idx = groups.length - 1;
    // Track to the NOW marker if it has active content, otherwise to last past event
    for (let i = groups.length - 1; i >= 0; i--) {
      if (groups[i].entry.type === 'now_marker') {
        if (groups[i].entry.raw) {
          // Active state: track to now_marker
          idx = i;
        } else {
          // IDLE: skip now_marker, track to last past event
          idx = Math.max(0, i - 1);
        }
        break;
      }
      if (groups[i].entry.type !== 'scheduled') { idx = i; break; }
    }
    this._scrollIndex = Math.max(0, idx);
  }

  private notify(): void {
    for (const cb of this.listeners) cb();
  }

  private resetAutoTrackTimer(): void {
    if (this.autoTrackTimer) clearTimeout(this.autoTrackTimer);
    this.autoTrackTimer = setTimeout(() => {
      this.autoTrackTimer = null;
      this.jumpToLatest();
    }, AUTO_TRACK_DELAY);
  }
}

// ===== Per-bridge factory =====

/** Default bridge id used before any bridge is selected. */
const DEFAULT_BRIDGE_ID = 'default';

let activeStore: TimelineStore = new TimelineStore(DEFAULT_BRIDGE_ID);

/** The timeline store for the currently active bridge. */
export function getTimelineStore(): TimelineStore {
  return activeStore;
}

/** Switch the active bridge — creates a fresh, isolated store instance so
 *  history never bleeds across bridges. Triggers a one-time legacy migration
 *  on first load for the new bridge. */
export function setTimelineBridge(bridgeId: string): void {
  activeStore = new TimelineStore(bridgeId);
}

/**
 * Live-binding singleton: a Proxy that always forwards to the *current* active
 * store. Existing call sites (`timelineStore.addEntry(...)`, `.onChange(...)`,
 * etc.) keep working unchanged, and `setTimelineBridge()` transparently swaps
 * the backing instance so per-bridge history stays isolated.
 *
 * NOTE: listeners registered via `timelineStore.onChange()` bind to whichever
 * instance is active at registration time — dials re-register on onWillAppear,
 * and broadcastStateUpdate re-renders after a bridge switch, so the new store's
 * notifications reach the UI.
 */
export const timelineStore: TimelineStore = new Proxy({} as TimelineStore, {
  get(_t, prop, receiver) {
    const value = Reflect.get(activeStore as object, prop, receiver);
    return typeof value === 'function' ? value.bind(activeStore) : value;
  },
  set(_t, prop, value) {
    return Reflect.set(activeStore as object, prop, value);
  },
});
