// Order-cycling for the Timeline artwork deck (docs/plans/artwork-scanning-v2.md
// B2), as a pure reducer so it is testable without the gesture handler.
//
// `order` lists the memory's asset indices, front piece first. Swiping the
// front piece off tucks it in at the back: [0, 1, 2, 3] -> [1, 2, 3, 0]. The
// stack draws the first `DECK_VISIBLE_SLOTS` entries; the counter ("n of N")
// still cycles through all N pieces.

import { DECK_VISIBLE_SLOTS } from '@/components/artwork/artwork-layout';

export interface DeckState {
  order: number[];
}

export type DeckAction = { type: 'advance'; count: number };

export function initialDeckOrder(count: number): number[] {
  return Array.from({ length: Math.max(0, count) }, (_, index) => index);
}

/** Keeps an existing order valid when the asset count changes (a piece was
 * added or removed by an edit): drops indices that no longer exist and
 * appends new ones at the back, preserving the rest of the cycle. */
export function reconcileDeckOrder(order: readonly number[], count: number): number[] {
  const kept = order.filter((index) => index >= 0 && index < count);
  if (kept.length === count && new Set(kept).size === count) {
    return kept.length === order.length ? (order as number[]) : kept;
  }
  const seen = new Set(kept);
  const next = [...new Set(kept)];
  for (let index = 0; index < count; index += 1) {
    if (!seen.has(index)) next.push(index);
  }
  return next;
}

export function deckReducer(state: DeckState, action: DeckAction): DeckState {
  const order = reconcileDeckOrder(state.order, action.count);
  if (order.length < 2) {
    return order === state.order ? state : { order };
  }
  return { order: [...order.slice(1), order[0]] };
}

/** The asset indices drawn in the stack, front first. */
export function visibleDeckIndices(order: readonly number[]): number[] {
  return order.slice(0, DECK_VISIBLE_SLOTS);
}

/** 0-based asset index of the front piece (null for an empty deck). */
export function deckFrontIndex(order: readonly number[]): number | null {
  return order.length > 0 ? order[0] : null;
}

export function deckCounterLabel(order: readonly number[]): string {
  return `${(order[0] ?? 0) + 1} of ${order.length}`;
}

/** Pan release: commit when dragged past ~30% of the width, or flung fast in
 * the drag's direction. Returns the exit direction (-1 left, 1 right) or null
 * to spring back. `velocityX` is px/s. */
export const DECK_COMMIT_FRACTION = 0.3;
export const DECK_COMMIT_VELOCITY = 650;
export function deckSwipeCommit(
  translationX: number,
  velocityX: number,
  width: number,
): -1 | 1 | null {
  'worklet';
  const farEnough = Math.abs(translationX) >= width * DECK_COMMIT_FRACTION;
  const fastEnough =
    Math.abs(velocityX) >= DECK_COMMIT_VELOCITY && Math.abs(translationX) >= 12 &&
    (velocityX > 0) === (translationX > 0);
  if (!farEnough && !fastEnough) return null;
  return translationX < 0 || (translationX === 0 && velocityX < 0) ? -1 : 1;
}
