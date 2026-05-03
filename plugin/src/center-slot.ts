import type { DeckLayout } from './session-slot-manager.js';

/**
 * Geometric center slot for a Stream Deck device — used as the "OFFLINE / Open
 * AgentDeck" hero key when the daemon is not reachable. All other keys render
 * as empty tiles so the deck reads as one clear recovery action.
 */
export function computeCenterSlot(layout: DeckLayout): number {
  const cols = Math.max(1, layout.columns | 0);
  const rows = Math.max(1, layout.rows | 0);
  return Math.floor(rows / 2) * cols + Math.floor(cols / 2);
}
