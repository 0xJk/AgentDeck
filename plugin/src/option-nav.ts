import type { PromptOption } from '@agentdeck/shared';
/**
 * Option dial navigation helpers (pure — no Stream Deck SDK deps so it's unit-testable).
 *
 * The remote control drives option selection from the dial; the daemon relays
 * Claude's PTY cursor back. During an active prompt the carousel re-emits
 * prompt_options on every redraw, each echoing the (possibly stale) PTY cursor.
 * Letting that overwrite the local selection got navigation stuck at the last
 * row. So: adopt the PTY cursor only on a genuinely NEW prompt; on a redraw of
 * the same prompt, the user's local dial navigation wins.
 */

/** Stable signature of an option set (by label), to tell a new prompt from a redraw. */
export function optionsSignature(labels: string[]): string {
  return labels.join('');
}

/**
 * Resolve the option dial's selected index when fresh state arrives.
 * @param current     the current local selectedIndex
 * @param cursorIdx   the PTY cursor index relayed from the session (may be stale)
 * @param isNewPrompt true when this is a different prompt (state or options changed)
 * @param optionsLen  number of options now on screen
 */
export function resolveSelectedIndex(
  current: number,
  cursorIdx: number | undefined,
  isNewPrompt: boolean,
  optionsLen: number,
): number {
  if (optionsLen <= 0) return 0;
  if (isNewPrompt) {
    return (cursorIdx !== undefined && cursorIdx >= 0 && cursorIdx < optionsLen) ? cursorIdx : 0;
  }
  // Same prompt redraw — keep the user's local navigation, just clamp into range.
  return Math.min(Math.max(current, 0), optionsLen - 1);
}

/**
 * During an encoder takeover, should the context dial switch question CARDS
 * (left/right) rather than navigate options (up/down)?
 *
 * Card switching applies to ANY card in a multi-QUESTION carousel — including a
 * single-select card that carries no checkbox state. Gating only on multi-select
 * (checked fields) stranded the dial on single-select cards (Bug 1: stuck, can't
 * switch back). A plain single-QUESTION multi-select (no carousel) toggles in
 * place, so the dial navigates instead.
 */
export function shouldSwitchCard(isCarousel: boolean, _isMultiSelect: boolean): boolean {
  return isCarousel;
}

/**
 * Override each option's `checked` with a locally-remembered toggle state.
 *
 * Claude's TUI shows a toggled checkbox only as a one-shot CUP-positioned ☒ glyph
 * overwrite; every full re-render still emits "[ ] label" (unchecked) in the byte
 * stream, so the linear parser can never recover checked state. The plugin therefore
 * owns checked: it remembers the user's toggles (by label, unique per card) and
 * re-applies them over the parser's always-unchecked values on every redraw and
 * card switch. Mirrors the cursor-authority pattern in resolveSelectedIndex.
 */
export function mergeCarouselChecked(options: PromptOption[], remembered: Map<string, boolean>): PromptOption[] {
  return options.map(o =>
    (o.checked !== undefined && remembered.has(o.label))
      ? { ...o, checked: remembered.get(o.label)! }
      : o,
  );
}
