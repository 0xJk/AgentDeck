import type { DeckLayout } from './session-slot-manager.js';
import type { ClusterQuadrant } from './renderers/session-slot-renderer.js';

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

/**
 * 'full' = the slot is the only hero key (single-slot layout).
 * tl/tr/bl/br = the slot covers one of four quadrants of a 2×2 cluster hero.
 */
export type CenterSlotRole = 'full' | ClusterQuadrant;

export interface CenterCluster {
  /** Slots that compose the OFFLINE hero. 1 entry for odd grids, 4 for even×even. */
  slots: number[];
  /** Cluster role for a slot, or null if the slot is outside the hero. */
  quadrantFor(slot: number): CenterSlotRole | null;
}

/**
 * Center cluster for the OFFLINE hero. Even×even decks (SD+ 4×2, SD XL 8×4)
 * spread the hero across the geometric-center 2×2 keys so the card sits at
 * the true visual center. Everything else falls back to a single-slot hero.
 */
export function computeCenterCluster(layout: DeckLayout): CenterCluster {
  const cols = Math.max(1, layout.columns | 0);
  const rows = Math.max(1, layout.rows | 0);
  const evenCols = cols >= 2 && cols % 2 === 0;
  const evenRows = rows >= 2 && rows % 2 === 0;

  if (evenCols && evenRows) {
    const leftCol = cols / 2 - 1;
    const rightCol = cols / 2;
    const topRow = rows / 2 - 1;
    const bottomRow = rows / 2;
    const tl = topRow * cols + leftCol;
    const tr = topRow * cols + rightCol;
    const bl = bottomRow * cols + leftCol;
    const br = bottomRow * cols + rightCol;
    const roles = new Map<number, CenterSlotRole>([
      [tl, 'tl'],
      [tr, 'tr'],
      [bl, 'bl'],
      [br, 'br'],
    ]);
    return {
      slots: [tl, tr, bl, br],
      quadrantFor(slot) {
        return roles.get(slot) ?? null;
      },
    };
  }

  const center = computeCenterSlot(layout);
  return {
    slots: [center],
    quadrantFor(slot) {
      return slot === center ? 'full' : null;
    },
  };
}
