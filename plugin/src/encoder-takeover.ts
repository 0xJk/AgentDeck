import streamDeck from '@elgato/streamdeck';
import { State, PromptOption } from '@agentdeck/shared';
import { encoderRegistry, resetEncoderLayouts, isVoiceTextTakeoverActive, setVoiceTextTakeover, fireTakeoverExit, setRefreshTakeoverCallback } from './encoder-registry.js';
import { svgToDataUrl } from './renderers/button-renderer.js';
import {
  renderContextPanel,
  renderFocusPanel,
  renderListPanel,
  renderDetailPanel,
  renderWideOptionList,
} from './renderers/option-renderer.js';
import { dlog } from './log.js';

const PIXMAP_LAYOUT = 'layouts/option-pixmap-layout.json';

// Register cross-module callback (breaks circular dep with option-dial)
setRefreshTakeoverCallback((state, options, selectedIndex, question, currentTool, toolInput) => refreshEncoderTakeover(state, options, selectedIndex, question, currentTool, toolInput));

let active = false;
let generation = 0;

// Wide scroll state for option list (E2-E4)
let wideScrollY = 0;
let wideMaxScroll = 0;
let wideLineHeight = 22;

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
  if (encoderRegistry.itermIds.length > 0) groups.push(encoderRegistry.itermIds);
  if (encoderRegistry.voiceIds.length > 0) groups.push(encoderRegistry.voiceIds);
  return groups;
}

/** Flatten all encoder IDs from all groups. */
function getAllIds(): string[] {
  return [
    ...encoderRegistry.utilityIds,
    ...encoderRegistry.optionIds,
    ...encoderRegistry.itermIds,
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
  resetWideScroll();
  const groups = getActiveGroups();
  dlog('Takeover', `enter ${groups.length} groups (util=${encoderRegistry.utilityIds.length} opt=${encoderRegistry.optionIds.length} iterm=${encoderRegistry.itermIds.length} voice=${encoderRegistry.voiceIds.length})`);

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

/** Auto-scroll so selectedIndex is visible in wide canvas */
function autoScrollToIndex(selectedIndex: number): void {
  const itemTop = selectedIndex * wideLineHeight;
  const itemBottom = itemTop + wideLineHeight;
  const visibleH = 100; // panel height

  if (itemTop < wideScrollY) {
    wideScrollY = itemTop;
  } else if (itemBottom > wideScrollY + visibleH) {
    wideScrollY = itemBottom - visibleH;
  }
  wideScrollY = Math.max(0, Math.min(wideScrollY, wideMaxScroll));
}

/** Reset wide scroll state (called on new takeover entry) */
export function resetWideScroll(): void {
  wideScrollY = 0;
  wideMaxScroll = 0;
}

/**
 * Refresh all taken-over encoder LCDs with SVG pixmap rendering.
 * E1 = context panel, E2-E4 = wide option list canvas.
 * Falls back to single-panel focus view when only 1 group is active.
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

  const isPermission = state === State.AWAITING_PERMISSION;
  const isDiff = state === State.AWAITING_DIFF;
  const isPermOrDiff = isPermission || isDiff;

  const groups = getActiveGroups();

  dlog('Takeover', `refresh ${groups.length} groups idx=${selectedIndex}/${options.length}`);

  if (groups.length <= 1) {
    // Single encoder: show focus panel only
    const svg = renderFocusPanel({
      opt, selectedIndex, total: options.length,
      isPermOrDiff, state, currentTool, fourEnc: false,
    });
    if (groups[0]) setCanvasFeedback(groups[0], svg);
    return;
  }

  // E1 = context panel (first group)
  const contextSvg = renderContextPanel({
    state, selectedIndex, total: options.length,
    question, currentTool,
  });
  setCanvasFeedback(groups[0], contextSvg);

  // E2-E4 = wide option list (remaining groups)
  const wideGroups = groups.slice(1);
  autoScrollToIndex(selectedIndex);

  const result = renderWideOptionList(
    options, selectedIndex, isPermOrDiff, state,
    wideGroups.length, wideScrollY,
  );

  wideMaxScroll = result.maxScrollY;
  wideLineHeight = result.lineHeight;

  for (let i = 0; i < wideGroups.length; i++) {
    setCanvasFeedback(wideGroups[i], result.panels[i]);
  }
}
