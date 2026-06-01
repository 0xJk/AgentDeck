import streamDeck from '@elgato/streamdeck';
import { State, PromptOption } from '@agentdeck/shared';
import { encoderRegistry, resetEncoderLayouts, isVoiceTextTakeoverActive, setVoiceTextTakeover, fireTakeoverExit, setRefreshTakeoverCallback } from './encoder-registry.js';
import { svgToDataUrl } from './renderers/button-renderer.js';
import {
  renderContextPanel,
  renderFocusPanel,
  renderListPanel,
  renderDetailPanel,
} from './renderers/option-renderer.js';
import { dlog } from './log.js';

const PIXMAP_LAYOUT = 'layouts/option-pixmap-layout.json';

// Register cross-module callback (breaks circular dep with option-dial)
setRefreshTakeoverCallback((state, options, selectedIndex, question, currentTool, toolInput) => refreshEncoderTakeover(state, options, selectedIndex, question, currentTool, toolInput));

let active = false;
let generation = 0;

export function isEncoderTakeoverActive(): boolean {
  return active;
}

/**
 * Collect all active encoder groups in physical left-to-right order.
 * Each group is an array of action IDs (typically 1 per encoder slot).
 */
function getActiveGroups(): string[][] {
  const groups: string[][] = [];
  if (encoderRegistry.utilityIds.length > 0) groups.push(encoderRegistry.utilityIds);
  if (encoderRegistry.optionIds.length > 0) groups.push(encoderRegistry.optionIds);
  if (encoderRegistry.usageIds.length > 0) groups.push(encoderRegistry.usageIds);
  if (encoderRegistry.voiceIds.length > 0) groups.push(encoderRegistry.voiceIds);
  return groups;
}

/** Flatten all encoder IDs from all groups. */
function getAllIds(): string[] {
  return [
    ...encoderRegistry.utilityIds,
    ...encoderRegistry.optionIds,
    ...encoderRegistry.usageIds,
    ...encoderRegistry.voiceIds,
  ];
}

/** Set SVG pixmap canvas feedback on an array of action IDs. */
function setCanvasFeedback(ids: string[], svg: string): void {
  const feedback = { canvas: svgToDataUrl(svg) };
  for (const id of ids) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) void dial.setFeedback(feedback).catch(() => {});
  }
}

/**
 * Take over all encoder LCDs for unified option display (SVG pixmap).
 * Dynamically uses however many encoder groups are active.
 */
export async function enterEncoderTakeover(): Promise<void> {
  // Voice text takeover must yield to option takeover (higher priority)
  if (isVoiceTextTakeoverActive()) {
    setVoiceTextTakeover(false);
    dlog('Takeover', 'exited voice text takeover (option takeover priority)');
  }
  const gen = ++generation;
  active = true;
  const groups = getActiveGroups();
  dlog('Takeover', `enter ${groups.length} groups (util=${encoderRegistry.utilityIds.length} opt=${encoderRegistry.optionIds.length} usage=${encoderRegistry.usageIds.length} voice=${encoderRegistry.voiceIds.length})`);

  const promises: Promise<void>[] = [];
  for (const id of getAllIds()) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) {
      promises.push(dial.setFeedbackLayout(PIXMAP_LAYOUT).catch(() => {}));
    }
  }

  await Promise.all(promises);

  if (gen !== generation) {
    dlog('Takeover', 'enter aborted — generation changed');
  }
}

/**
 * Release all encoder LCDs back to their normal layouts.
 */
export async function exitEncoderTakeover(): Promise<void> {
  const gen = ++generation;
  active = false;
  dlog('Takeover', 'exit');

  resetEncoderLayouts();
  fireTakeoverExit();

  const promises: Promise<void>[] = [];
  for (const id of getAllIds()) {
    const dial = streamDeck.actions.getActionById(id) as any;
    if (dial) {
      promises.push(dial.setFeedbackLayout('layouts/voice-layout.json').catch(() => {}));
    }
  }

  await Promise.all(promises);

  if (gen !== generation) {
    dlog('Takeover', 'exit aborted — generation changed');
  }
}

/**
 * Refresh all taken-over encoder LCDs with SVG pixmap rendering.
 *
 * Each dial gets a SELF-CONTAINED 200px panel — we never span one logical
 * canvas across the physically-separate dial LCDs (that produced the bezel
 * seams / 断层). The option list lives on ONE dial as a vertically-windowed
 * list centered on the selection (renderListPanel), so no row is ever clipped
 * (fixes 显示不全). Remaining dials show purpose-built context/focus/detail.
 *
 * Panel assignment by dial index:
 *   0 = context (SELECT k/N + question + tool)
 *   1 = windowed option list (the primary interactive surface)
 *   2 = focus (the currently-selected option, large/legible)
 *   3 = detail (full label, word-wrapped, + tool args for permission/diff)
 * Fewer than 4 active groups simply use the leading panels.
 */
export function refreshEncoderTakeover(
  state: State,
  options: PromptOption[],
  selectedIndex: number,
  question?: string,
  currentTool?: string,
  toolInput?: string,
): void {
  if (!active || options.length === 0) return;

  const opt = options[selectedIndex];
  if (!opt) return;

  const isPermOrDiff = state === State.AWAITING_PERMISSION || state === State.AWAITING_DIFF;
  const groups = getActiveGroups();
  const total = options.length;

  dlog('Takeover', `refresh ${groups.length} groups idx=${selectedIndex}/${total}`);

  if (groups.length <= 1) {
    // Single encoder: the windowed list is the most useful self-contained view.
    if (groups[0]) setCanvasFeedback(groups[0], renderListPanel({ options, selectedIndex, isPermOrDiff, state }));
    return;
  }

  const panels = [
    renderContextPanel({ state, selectedIndex, total, question, currentTool }),
    renderListPanel({ options, selectedIndex, isPermOrDiff, state }),
    renderFocusPanel({ opt, selectedIndex, total, isPermOrDiff, state, currentTool, fourEnc: groups.length >= 4 }),
    renderDetailPanel({ opt, isPermOrDiff, state, selectedIndex, total, toolInput, question }),
  ];

  for (let i = 0; i < groups.length; i++) {
    setCanvasFeedback(groups[i], panels[Math.min(i, panels.length - 1)]);
  }
}
