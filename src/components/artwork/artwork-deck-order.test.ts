import {
  DECK_COMMIT_VELOCITY,
  deckCounterLabel,
  deckFrontIndex,
  deckReducer,
  deckSwipeCommit,
  initialDeckOrder,
  reconcileDeckOrder,
  visibleDeckIndices,
} from '@/components/artwork/artwork-deck-order';

describe('deck order cycling', () => {
  it('starts in asset order', () => {
    expect(initialDeckOrder(4)).toEqual([0, 1, 2, 3]);
    expect(initialDeckOrder(0)).toEqual([]);
  });

  it('tucks the front piece in at the back on advance', () => {
    let state = { order: initialDeckOrder(4) };
    state = deckReducer(state, { type: 'advance', count: 4 });
    expect(state.order).toEqual([1, 2, 3, 0]);
    state = deckReducer(state, { type: 'advance', count: 4 });
    expect(state.order).toEqual([2, 3, 0, 1]);
  });

  it('comes back to the start after N advances', () => {
    let state = { order: initialDeckOrder(3) };
    for (let i = 0; i < 3; i += 1) state = deckReducer(state, { type: 'advance', count: 3 });
    expect(state.order).toEqual([0, 1, 2]);
  });

  it('does nothing for a single piece or an empty deck', () => {
    const one = { order: [0] };
    expect(deckReducer(one, { type: 'advance', count: 1 })).toBe(one);
    const none = { order: [] as number[] };
    expect(deckReducer(none, { type: 'advance', count: 0 })).toBe(none);
  });

  it('draws only the first three pieces but the counter still spans all N', () => {
    const order = [4, 0, 1, 2, 3, 5];
    expect(visibleDeckIndices(order)).toEqual([4, 0, 1]);
    expect(deckCounterLabel(order)).toBe('5 of 6');
    expect(deckFrontIndex(order)).toBe(4);
    expect(deckCounterLabel(initialDeckOrder(2))).toBe('1 of 2');
  });

  it('draws two pieces for a pair', () => {
    expect(visibleDeckIndices(initialDeckOrder(2))).toEqual([0, 1]);
  });

  it('reports no front for an empty deck', () => {
    expect(deckFrontIndex([])).toBeNull();
  });

  describe('reconcileDeckOrder', () => {
    it('returns the same array when it is already valid', () => {
      const order = [1, 2, 0];
      expect(reconcileDeckOrder(order, 3)).toBe(order);
    });

    it('drops removed pieces and keeps the rest of the cycle', () => {
      expect(reconcileDeckOrder([2, 3, 0, 1], 3)).toEqual([2, 0, 1]);
    });

    it('appends added pieces at the back', () => {
      expect(reconcileDeckOrder([1, 0], 4)).toEqual([1, 0, 2, 3]);
    });

    it('advances from a reconciled order', () => {
      expect(deckReducer({ order: [1, 0] }, { type: 'advance', count: 3 }).order).toEqual([0, 2, 1]);
    });
  });
});

describe('deckSwipeCommit', () => {
  it('commits past ~30% of the width, in the drag direction', () => {
    expect(deckSwipeCommit(-120, 0, 358)).toBe(-1);
    expect(deckSwipeCommit(120, 0, 358)).toBe(1);
  });

  it('springs back for a short, slow drag', () => {
    expect(deckSwipeCommit(-60, -100, 358)).toBeNull();
    expect(deckSwipeCommit(0, 0, 358)).toBeNull();
  });

  it('commits a short but fast fling in its direction', () => {
    expect(deckSwipeCommit(-40, -(DECK_COMMIT_VELOCITY + 100), 358)).toBe(-1);
    expect(deckSwipeCommit(40, DECK_COMMIT_VELOCITY + 100, 358)).toBe(1);
  });

  it('ignores a fast fling against the drag direction', () => {
    expect(deckSwipeCommit(-40, DECK_COMMIT_VELOCITY + 100, 358)).toBeNull();
  });
});
