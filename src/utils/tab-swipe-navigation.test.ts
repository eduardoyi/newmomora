import { getAdjacentTabRoute, getTabSwipeDirection } from '@/utils/tab-swipe-navigation';

describe('getAdjacentTabRoute', () => {
  it('returns the next tab in order', () => {
    expect(getAdjacentTabRoute('timeline', 'next')).toBe('calendar');
    expect(getAdjacentTabRoute('calendar', 'next')).toBe('family');
    expect(getAdjacentTabRoute('family', 'next')).toBe('settings');
  });

  it('returns the previous tab in order', () => {
    expect(getAdjacentTabRoute('settings', 'prev')).toBe('family');
    expect(getAdjacentTabRoute('family', 'prev')).toBe('calendar');
    expect(getAdjacentTabRoute('calendar', 'prev')).toBe('timeline');
  });

  it('returns null at the ends of the tab list', () => {
    expect(getAdjacentTabRoute('timeline', 'prev')).toBeNull();
    expect(getAdjacentTabRoute('settings', 'next')).toBeNull();
  });

  it('returns null for unknown routes', () => {
    expect(getAdjacentTabRoute('memory/123', 'next')).toBeNull();
  });
});

describe('getTabSwipeDirection', () => {
  it('detects swipes to the next tab', () => {
    expect(getTabSwipeDirection(-80, 0)).toBe('next');
    expect(getTabSwipeDirection(0, -700)).toBe('next');
  });

  it('detects swipes to the previous tab', () => {
    expect(getTabSwipeDirection(80, 0)).toBe('prev');
    expect(getTabSwipeDirection(0, 700)).toBe('prev');
  });

  it('ignores small movements', () => {
    expect(getTabSwipeDirection(-20, 0)).toBeNull();
    expect(getTabSwipeDirection(20, 0)).toBeNull();
    expect(getTabSwipeDirection(0, 200)).toBeNull();
  });
});
