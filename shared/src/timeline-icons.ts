/**
 * Shared icon-key system for timeline entries.
 *
 * Each platform maps the abstract key to its native form:
 *   - Apple: SF Symbols (`checkmark.circle.fill`, etc.)
 *   - Android tablet: Material Icons (`Icons.Filled.CheckCircle`)
 *   - Android e-ink: ASCII bracket markers (`[OK]`, `[T ]`) — high black coverage,
 *     no thin glyph strokes that ghost on partial refresh.
 *
 * This is the single source of truth. If you add a new key, add the platform
 * mapping in the same commit (apple TimelineStripView.swift,
 * android TimelineStrip.kt + EinkTimelinePanel.kt).
 */

import type { TimelineEntry, TimelineEntryType } from './timeline.js';

export type TimelineIconKey =
  | 'success'   // chat completed, tool resolved
  | 'error'     // any error
  | 'running'   // active turn / chat in progress
  | 'awaiting'  // waiting on user (pending tool, chat_start without completion)
  | 'tool'      // tool execution
  | 'model'     // model call/response
  | 'user'      // user action / prompt
  | 'task'      // task hierarchy header
  | 'scheduled' // scheduled work
  | 'memory';   // memory recall

/**
 * Map a timeline entry to its semantic icon key.
 * Looks at both the entry type and (for tool_request) the approval status.
 */
export function timelineIconKey(entry: Pick<TimelineEntry, 'type' | 'status'>): TimelineIconKey {
  switch (entry.type) {
    case 'task_start':
    case 'task_end':
      return 'task';
    case 'chat_start':
      return 'running';
    case 'chat_end':
    case 'chat_response':
    case 'model_response':
      return 'success';
    case 'model_call':
      return 'model';
    case 'tool_request':
      if (entry.status === 'approved') return 'success';
      if (entry.status === 'denied') return 'error';
      return 'awaiting';
    case 'tool_resolved':
      return 'success';
    case 'tool_exec':
      return 'tool';
    case 'error':
      return 'error';
    case 'user_action':
      return 'user';
    case 'scheduled':
      return 'scheduled';
    case 'memory_recall':
      return 'memory';
    case 'eval_result':
      return entry.status === 'denied' ? 'error' : 'success';
    default:
      return 'running';
  }
}

/** All known icon keys, in stable order (used for tests/registries). */
export const TIMELINE_ICON_KEYS: readonly TimelineIconKey[] = [
  'success', 'error', 'running', 'awaiting',
  'tool', 'model', 'user', 'task',
  'scheduled', 'memory',
] as const;

/**
 * True when `entry` is a `task_start` whose matching `task_end` (same `taskId`)
 * has not yet appeared among `siblings`. Lets clients render in-flight task
 * hierarchy markers with the rotating "running" treatment instead of the
 * static `task` icon. Mirrored in Apple `isInFlightTask` and Android
 * `isInFlightTask`.
 */
export function isInFlightTask(
  entry: Pick<TimelineEntry, 'type' | 'taskId'>,
  siblings: ReadonlyArray<Pick<TimelineEntry, 'type' | 'taskId'>>,
): boolean {
  if (entry.type !== 'task_start') return false;
  if (!entry.taskId) return false;
  for (const s of siblings) {
    if (s.type === 'task_end' && s.taskId === entry.taskId) return false;
  }
  return true;
}

/**
 * True when a turn row should rotate its leading icon. Combines the static
 * `running` icon-key (chat_start, unknown types) with the in-flight
 * task-hierarchy signal so an open `task_start` also spins until its
 * `task_end` arrives. `siblings` should be the entries the row sees in its
 * group/list — passing `[]` falls back to icon-key only.
 */
export function isRotatingEntry(
  entry: Pick<TimelineEntry, 'type' | 'status' | 'taskId'>,
  siblings: ReadonlyArray<Pick<TimelineEntry, 'type' | 'taskId'>>,
): boolean {
  if (timelineIconKey(entry) === 'running') return true;
  return isInFlightTask(entry, siblings);
}

/**
 * E-ink ASCII glyphs — bracket-padded so total width is constant (4 chars)
 * for column alignment on monospace bitmap fonts.
 */
export const EINK_ICON_GLYPHS: Record<TimelineIconKey, string> = {
  success:   '[OK]',
  error:     '[!!]',
  running:   '[..]',
  awaiting:  '[??]',
  tool:      '[T ]',
  model:     '[M ]',
  user:      '[U ]',
  task:      '[==]',
  scheduled: '[S ]',
  memory:    '[~ ]',
};

/**
 * Whether a timeline entry type carries a content body worth showing in the
 * detail pane. task_start/task_end are hierarchy markers — their `raw` is the
 * task summary, no extra detail expected.
 */
export function entryHasDetailBody(type: TimelineEntryType): boolean {
  return type !== 'task_start' && type !== 'task_end';
}
