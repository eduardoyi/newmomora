import { getTabTransitionKey, getTabTransitionStartProgress } from './tab-transition';

describe('getTabTransitionKey', () => {
  it('changes keys when a tab changes selection state', () => {
    expect(getTabTransitionKey('timeline-key', true)).toBe('timeline-key-active');
    expect(getTabTransitionKey('timeline-key', false)).toBe('timeline-key-inactive');
  });

  it('starts each transition from the opposite visual state', () => {
    expect(getTabTransitionStartProgress(true)).toBe(0);
    expect(getTabTransitionStartProgress(false)).toBe(1);
  });
});
