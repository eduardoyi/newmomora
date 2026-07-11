import type { Href } from 'expo-router';

export const addFamilyMemberRoute = '/(app)/add-family-member' as Href;
export const newMemoryRoute = '/(app)/new-memory' as Href;
export const timelineRoute = '/(app)/(tabs)/timeline' as Href;
export const noFamilyRoute = '/(app)/no-family' as Href;

export function memoryDetailRoute(memoryId: string): Href {
  return `/(app)/memory/${memoryId}` as Href;
}

export function editMemoryRoute(memoryId: string): Href {
  return `/(app)/memory/${memoryId}/edit` as Href;
}

export function familyMemberRoute(memberId: string): Href {
  return `/(app)/family/${memberId}` as Href;
}

export function editFamilyMemberRoute(memberId: string): Href {
  return `/(app)/family/${memberId}/edit` as Href;
}
