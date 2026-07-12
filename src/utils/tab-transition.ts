export function getTabTransitionKey(routeKey: string, isActive: boolean): string {
  return `${routeKey}-${isActive ? 'active' : 'inactive'}`;
}

export function getTabTransitionStartProgress(isActive: boolean): 0 | 1 {
  return isActive ? 0 : 1;
}
