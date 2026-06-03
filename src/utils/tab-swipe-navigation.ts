export const TAB_ROUTES = ['timeline', 'calendar', 'family', 'settings'] as const;

export type TabRouteName = (typeof TAB_ROUTES)[number];

export function getAdjacentTabRoute(
  currentRoute: string,
  direction: 'next' | 'prev',
): TabRouteName | null {
  const index = TAB_ROUTES.indexOf(currentRoute as TabRouteName);
  if (index === -1) {
    return null;
  }

  const nextIndex = direction === 'next' ? index + 1 : index - 1;
  if (nextIndex < 0 || nextIndex >= TAB_ROUTES.length) {
    return null;
  }

  return TAB_ROUTES[nextIndex];
}

export function getTabSwipeDirection(
  translationX: number,
  velocityX: number,
  translationThreshold = 60,
  velocityThreshold = 500,
): 'next' | 'prev' | null {
  if (translationX <= -translationThreshold || velocityX <= -velocityThreshold) {
    return 'next';
  }

  if (translationX >= translationThreshold || velocityX >= velocityThreshold) {
    return 'prev';
  }

  return null;
}
