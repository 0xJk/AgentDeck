import streamDeck from '@elgato/streamdeck';
import { State, PromptOption } from '@agentdeck/shared';
import { processLabel, colorForOption } from './layout-manager.js';
import { encoderRegistry } from './encoder-registry.js';
import { dlog } from './log.js';

let active = false;
let generation = 0;

export function isEncoderTakeoverActive(): boolean {
  return active;
}

/** True when Utility Dial is placed → 4-encoder takeover layout. */
function has4Encoders(): boolean {
  return encoderRegistry.utilityIds.length > 0;
}

/**
 * Take over AgentDeck encoder LCDs for unified option display.
 *
 * 4-encoder mode (utilityIds present):
 *   E1 utilityIds  → Context view (question/hint)
 *   E2 optionIds   → Focus view  (selected option detail)
 *   E3 commandIds  → List page 1 (rows 1-5)
 *   E4 voiceIds    → List page 2 (rows 6-10)
 *
 * 3-encoder mode (no utilityIds):
 *   E2 optionIds   → Focus view
 *   E3 commandIds  → List view (+ contextIds for page 2)
 *   E4 voiceIds    → Context view
 */
export async function enterEncoderTakeover(): Promise<void> {
  const gen = ++generation;
  active = true;
  const fourEnc = has4Encoders();
  dlog('Takeover', `enter 4enc=${fourEnc} (util=${encoderRegistry.utilityIds.length} opt=${encoderRegistry.optionIds.length} cmd=${encoderRegistry.commandIds.length} voice=${encoderRegistry.voiceIds.length} ctx=${encoderRegistry.contextIds.length})`);

  const promises: Promise<void>[] = [];

  // Option dial → Focus layout (same in both modes)
  for (const id of encoderRegistry.optionIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) {
      promises.push(
        dial.setFeedbackLayout('layouts/option-focus-layout.json').catch(() => {}),
      );
    }
  }

  // Command dial → List layout (same in both modes)
  for (const id of encoderRegistry.commandIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) {
      promises.push(
        dial.setFeedbackLayout('layouts/option-list-layout.json').catch(() => {}),
      );
    }
  }

  if (fourEnc) {
    // 4-encoder: utility → Context, voice → List page 2
    for (const id of encoderRegistry.utilityIds) {
      const dial = streamDeck.actions.getActionById(id) as any;
      if (dial) {
        promises.push(
          dial.setFeedbackLayout('layouts/option-context-layout.json').catch(() => {}),
        );
      }
    }
    for (const id of encoderRegistry.voiceIds) {
      const dial = streamDeck.actions.getActionById(id) as any;
      if (dial) {
        promises.push(
          dial.setFeedbackLayout('layouts/option-list-layout.json').catch(() => {}),
        );
      }
    }
  } else {
    // 3-encoder: voice → Context, contextIds → List page 2 (optional)
    for (const id of encoderRegistry.voiceIds) {
      const dial = streamDeck.actions.getActionById(id) as any;
      if (dial) {
        promises.push(
          dial.setFeedbackLayout('layouts/option-context-layout.json').catch(() => {}),
        );
      }
    }
    for (const id of encoderRegistry.contextIds) {
      const dial = streamDeck.actions.getActionById(id) as any;
      if (dial) {
        promises.push(
          dial.setFeedbackLayout('layouts/option-list-layout.json').catch(() => {}),
        );
      }
    }
  }

  await Promise.all(promises);

  if (gen !== generation) {
    dlog('Takeover', 'enter aborted — generation changed');
    return;
  }
}

/**
 * Release all encoder LCDs back to their original layouts.
 */
export async function exitEncoderTakeover(): Promise<void> {
  const gen = ++generation;
  active = false;
  dlog('Takeover', 'exit');

  const promises: Promise<void>[] = [];

  // Utility dial → restore utility layout
  for (const id of encoderRegistry.utilityIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) {
      promises.push(
        dial.setFeedbackLayout('layouts/utility-layout.json').catch(() => {}),
      );
    }
  }

  // Option dial → restore $B1
  for (const id of encoderRegistry.optionIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) {
      promises.push(dial.setFeedbackLayout('$B1').catch(() => {}));
    }
  }

  // Command dial → restore $B1
  for (const id of encoderRegistry.commandIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) {
      promises.push(dial.setFeedbackLayout('$B1').catch(() => {}));
    }
  }

  // Voice dial → restore voice layout
  for (const id of encoderRegistry.voiceIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) {
      promises.push(
        dial.setFeedbackLayout('layouts/voice-layout.json').catch(() => {}),
      );
    }
  }

  // Context dial → restore $B1
  for (const id of encoderRegistry.contextIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) {
      promises.push(dial.setFeedbackLayout('$B1').catch(() => {}));
    }
  }

  await Promise.all(promises);

  if (gen !== generation) {
    dlog('Takeover', 'exit aborted — generation changed');
  }
}

/**
 * Refresh all taken-over encoder LCDs with current option state.
 * Accent bar at y=92 spans all sections for visual continuity.
 *
 * 4-enc: utilityIds=Context | optionIds=Focus | commandIds=List p1 | voiceIds=List p2
 * 3-enc: optionIds=Focus | commandIds=List (+ contextIds=List p2) | voiceIds=Context
 */
export function refreshEncoderTakeover(
  state: State,
  options: PromptOption[],
  selectedIndex: number,
  question?: string,
  currentTool?: string,
): void {
  if (!active || options.length === 0) return;

  const opt = options[selectedIndex];
  if (!opt) return;

  const isPermission = state === State.AWAITING_PERMISSION;
  const isDiff = state === State.AWAITING_DIFF;
  const isPermOrDiff = isPermission || isDiff;

  // Unified accent bar across all sections
  const progressValue = Math.round(((selectedIndex + 1) / options.length) * 100);
  const barColor = isPermission ? '#dc2626' : isDiff ? '#f59e0b' : '#2563eb';

  const fourEnc = has4Encoders();

  // === Focus View → optionIds (always E2) ===
  refreshFocusView(opt, selectedIndex, options.length, isPermOrDiff, progressValue, barColor);

  // === List View ===
  if (fourEnc) {
    // 4-enc: commandIds=List p1, voiceIds=List p2
    refreshListView4(options, selectedIndex, isPermOrDiff, progressValue, barColor);
  } else {
    // 3-enc: commandIds=List (+ contextIds=page 2)
    const hasSecondPage = encoderRegistry.contextIds.length > 0;
    refreshListView3(options, selectedIndex, isPermOrDiff, progressValue, barColor, hasSecondPage);
  }

  // === Context View ===
  const contextTargetIds = fourEnc ? encoderRegistry.utilityIds : encoderRegistry.voiceIds;
  refreshContextView(state, options.length, question, currentTool, progressValue, barColor, contextTargetIds);
}

function refreshFocusView(
  opt: PromptOption, selectedIndex: number, total: number,
  isPermOrDiff: boolean, progressValue: number, barColor: string,
): void {
  const label = processLabel(opt.label);
  const colors = isPermOrDiff
    ? colorForOption(opt)
    : opt.recommended
      ? { color: '#1e4d2b', textColor: '#86efac' }
      : { color: '#1e3a5f', textColor: '#93c5fd' };

  const badge = opt.recommended ? '\u2605 Recommended'
    : opt.selected ? '\u2713 Selected'
    : '';

  const feedback: Record<string, unknown> = {
    'opt-index': { value: `${selectedIndex + 1}/${total}` },
    'opt-name': {
      value: label.main,
      color: colors.textColor,
      background: colors.color,
    },
    'opt-sub': { value: label.sub || '' },
    'opt-badge': badge
      ? { value: badge, enabled: true }
      : { value: '', enabled: false },
    'accent-bar': { value: progressValue, bar_fill_c: barColor },
  };

  for (const id of encoderRegistry.optionIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) void dial.setFeedback(feedback).catch(() => {});
  }
}

/**
 * 4-encoder list view: commandIds=page 1, voiceIds=page 2
 */
function refreshListView4(
  options: PromptOption[], selectedIndex: number,
  isPermOrDiff: boolean, progressValue: number, barColor: string,
): void {
  const ROWS_PER_PANEL = 5;
  const TOTAL_ROWS = ROWS_PER_PANEL * 2;

  let windowStart = 0;
  if (options.length > TOTAL_ROWS) {
    windowStart = Math.max(0, selectedIndex - Math.floor(TOTAL_ROWS / 2));
    windowStart = Math.min(windowStart, options.length - TOTAL_ROWS);
  }
  const allRows = buildListRows(options, windowStart, TOTAL_ROWS, selectedIndex, isPermOrDiff);

  // Page 1 → commandIds (E3)
  const page1: Record<string, unknown> = {
    'accent-bar': { value: progressValue, bar_fill_c: barColor },
  };
  for (let i = 0; i < ROWS_PER_PANEL; i++) {
    page1[`row${i}`] = allRows[i];
  }
  for (const id of encoderRegistry.commandIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) void dial.setFeedback(page1).catch(() => {});
  }

  // Page 2 → voiceIds (E4)
  const page2: Record<string, unknown> = {
    'accent-bar': { value: progressValue, bar_fill_c: barColor },
  };
  for (let i = 0; i < ROWS_PER_PANEL; i++) {
    page2[`row${i}`] = allRows[ROWS_PER_PANEL + i];
  }
  for (const id of encoderRegistry.voiceIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) void dial.setFeedback(page2).catch(() => {});
  }
}

/**
 * 3-encoder list view: commandIds=page 1, contextIds=page 2 (optional)
 */
function refreshListView3(
  options: PromptOption[], selectedIndex: number,
  isPermOrDiff: boolean, progressValue: number, barColor: string,
  hasSecondPage: boolean,
): void {
  const ROWS_PER_PANEL = 5;

  if (hasSecondPage) {
    const TOTAL_ROWS = ROWS_PER_PANEL * 2;
    let windowStart = 0;
    if (options.length > TOTAL_ROWS) {
      windowStart = Math.max(0, selectedIndex - Math.floor(TOTAL_ROWS / 2));
      windowStart = Math.min(windowStart, options.length - TOTAL_ROWS);
    }
    const allRows = buildListRows(options, windowStart, TOTAL_ROWS, selectedIndex, isPermOrDiff);

    // Page 1 → commandIds
    const page1: Record<string, unknown> = {
      'accent-bar': { value: progressValue, bar_fill_c: barColor },
    };
    for (let i = 0; i < ROWS_PER_PANEL; i++) {
      page1[`row${i}`] = allRows[i];
    }
    for (const id of encoderRegistry.commandIds) {
      const dial = streamDeck.actions.getActionById(id) as any;
      if (dial) void dial.setFeedback(page1).catch(() => {});
    }

    // Page 2 → contextIds
    const page2: Record<string, unknown> = {
      'accent-bar': { value: progressValue, bar_fill_c: barColor },
    };
    for (let i = 0; i < ROWS_PER_PANEL; i++) {
      page2[`row${i}`] = allRows[ROWS_PER_PANEL + i];
    }
    for (const id of encoderRegistry.contextIds) {
      const dial = streamDeck.actions.getActionById(id) as any;
      if (dial) void dial.setFeedback(page2).catch(() => {});
    }
  } else {
    // Single list: commandIds only
    let windowStart = 0;
    if (options.length > ROWS_PER_PANEL) {
      windowStart = Math.max(0, selectedIndex - Math.floor(ROWS_PER_PANEL / 2));
      windowStart = Math.min(windowStart, options.length - ROWS_PER_PANEL);
    }
    const rows = buildListRows(options, windowStart, ROWS_PER_PANEL, selectedIndex, isPermOrDiff);

    const feedback: Record<string, unknown> = {
      'accent-bar': { value: progressValue, bar_fill_c: barColor },
    };
    for (let i = 0; i < ROWS_PER_PANEL; i++) {
      feedback[`row${i}`] = rows[i];
    }
    for (const id of encoderRegistry.commandIds) {
      const dial = streamDeck.actions.getActionById(id) as any;
      if (dial) void dial.setFeedback(feedback).catch(() => {});
    }
  }
}

function buildListRows(
  options: PromptOption[], windowStart: number, totalRows: number,
  selectedIndex: number, isPermOrDiff: boolean,
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];

  for (let row = 0; row < totalRows; row++) {
    const optIdx = windowStart + row;
    if (optIdx < options.length) {
      const rowOpt = options[optIdx];
      const isSelected = optIdx === selectedIndex;
      const prefix = isSelected ? '\u25B6 ' : '  ';
      const num = `${optIdx + 1}.`;
      const rowLabel = processLabel(rowOpt.label);
      let text = `${prefix}${num} ${rowLabel.main}`;
      if (rowOpt.recommended) text += ' \u2605';
      if (rowOpt.selected) text += ' \u2713';

      const rowColors = isPermOrDiff ? colorForOption(rowOpt) : null;

      rows.push({
        value: text,
        font: isSelected ? { size: 12, weight: 700 } : { size: 12 },
        color: isSelected ? '#ffffff' : '#94a3b8',
        background: isSelected
          ? (rowColors?.color ?? '#2563eb')
          : (rowColors ? `${rowColors.color}44` : undefined),
      });
    } else {
      rows.push({ value: '' });
    }
  }

  return rows;
}

function refreshContextView(
  state: State, total: number,
  question: string | undefined, currentTool: string | undefined,
  progressValue: number, barColor: string,
  targetIds: string[],
): void {
  const isPermission = state === State.AWAITING_PERMISSION;
  const isDiff = state === State.AWAITING_DIFF;

  const ctxLabel = isPermission ? 'PERMISSION'
    : isDiff ? 'DIFF REVIEW'
    : 'SELECT';

  let ctxQuestion = question || '';
  if (!ctxQuestion) {
    if (isPermission && currentTool) {
      ctxQuestion = `Allow ${currentTool}?`;
    } else {
      ctxQuestion = `Choose option (${total} available)`;
    }
  }

  const feedback: Record<string, unknown> = {
    'ctx-label': { value: ctxLabel },
    'ctx-question': { value: ctxQuestion },
    'ctx-hint': { value: '\u21BB rotate  \u23CE select' },
    'accent-bar': { value: progressValue, bar_fill_c: barColor },
  };

  for (const id of targetIds) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) void dial.setFeedback(feedback).catch(() => {});
  }
}
