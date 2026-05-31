/**
 * Timeline store tests.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { join } from 'path';
import { homedir } from 'os';

// fs is mocked so tests never touch the real ~/.agentdeck directory.
vi.mock('fs', () => ({
  readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(() => false),
}));

import { TimelineStore, getTimelineStore, setTimelineBridge } from '../timeline-store.js';
import type { GroupedEntry } from '../timeline-store.js';
import * as fs from 'fs';

const dir = join(homedir(), '.agentdeck');
const legacyFile = join(dir, 'timeline.json');

describe('TimelineStore', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('ENOENT'); });
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });

  // ===== Test 18: per-bridge constructor path =====
  it('test 18: writes to timeline-<bridgeId>.json on save', () => {
    vi.useFakeTimers();
    const store = new TimelineStore('alpha');
    const expectedPath = join(dir, 'timeline-alpha.json');

    store.addEntry({ ts: Date.now(), type: 'chat_start', raw: 'hi' });
    vi.advanceTimersByTime(1000);

    expect(fs.writeFileSync).toHaveBeenCalledWith(expectedPath, expect.any(String), 'utf-8');
    vi.useRealTimers();
  });

  it('test 18: reads from timeline-<bridgeId>.json on load', () => {
    const expectedPath = join(dir, 'timeline-beta.json');
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation((...args: unknown[]) => {
      const p = args[0] as string;
      if (p === expectedPath) {
        return JSON.stringify([{ ts: 1000, type: 'chat_start', raw: 'loaded' }]);
      }
      throw new Error('ENOENT');
    });

    const store = new TimelineStore('beta');
    const display = store.getGroupedDisplay();
    const hasLoaded = display.some((g: GroupedEntry) => g.entry.raw === 'loaded');
    expect(hasLoaded).toBe(true);
  });

  // ===== Test 19: one-time legacy migration =====
  it('test 19: migrates legacy timeline.json to per-bridge file on first creation', () => {
    const perBridge = join(dir, 'timeline-mybridge.json');
    // legacy exists, per-bridge does NOT
    (fs.existsSync as ReturnType<typeof vi.fn>).mockImplementation((...args: unknown[]) => (args[0] as string) === legacyFile);

    const store = new TimelineStore('mybridge');
    // load triggers migration
    store.getGroupedDisplay();

    expect(fs.renameSync).toHaveBeenCalledWith(legacyFile, perBridge);
  });

  it('test 19: does NOT migrate when per-bridge file already exists (never overwrite)', () => {
    const perBridge = join(dir, 'timeline-mybridge.json');
    // both legacy and per-bridge exist
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const store = new TimelineStore('mybridge');
    store.getGroupedDisplay();

    expect(fs.renameSync).not.toHaveBeenCalled();
  });

  it('test 19: does NOT migrate when legacy file is absent', () => {
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const store = new TimelineStore('mybridge');
    store.getGroupedDisplay();

    expect(fs.renameSync).not.toHaveBeenCalled();
  });

  // ===== Test 20: setTimelineBridge swaps instances (no history bleed) =====
  it('test 20: setTimelineBridge swaps the active store instance', () => {
    setTimelineBridge('one');
    const a = getTimelineStore();
    setTimelineBridge('two');
    const b = getTimelineStore();
    expect(a).not.toBe(b);
  });

  it('test 20: history does not bleed across bridges', () => {
    setTimelineBridge('one');
    const a = getTimelineStore();
    a.addEntry({ ts: Date.now(), type: 'chat_start', raw: 'only-on-one' });

    setTimelineBridge('two');
    const b = getTimelineStore();
    const bHasOnesEntry = b.getGroupedDisplay().some((g: GroupedEntry) => g.entry.raw === 'only-on-one');
    expect(bHasOnesEntry).toBe(false);
  });

  it('test 20: switching back to a bridge returns a fresh instance (new per task spec)', () => {
    setTimelineBridge('one');
    const first = getTimelineStore();
    setTimelineBridge('two');
    setTimelineBridge('one');
    const again = getTimelineStore();
    // factory creates a new instance per bridge switch
    expect(again).not.toBe(first);
  });
});
