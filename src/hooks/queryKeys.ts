// Family-scoped query keys. Every list/detail query for family-owned content
// is keyed by familyId so that switching the active family (FamilyProvider's
// `setActiveFamily`) gets its own cache entry instead of momentarily showing
// the previous family's data. Invalidation after mutations uses the base
// string alone (React Query prefix-matches array keys), which invalidates
// every family variant at once -- simpler and safe since stale entries for
// other families just refetch lazily next time they're viewed.

export const memoriesQueryKeyBase = 'memories' as const;
// Search results are a separate, transient (non-infinite) query -- keeping
// them out from under memoriesQueryKeyBase avoids mixing InfiniteData and
// flat-array shapes under the same prefix that isMemoriesListQueryKey /
// patchMemoryInCaches match on (see docs/plans/performance-optimizations.md
// Workstream A2).
export const memoriesSearchQueryKeyBase = 'memories-search' as const;
export const calendarMemoriesQueryKeyBase = 'calendar-memories' as const;
export const familyMembersQueryKeyBase = 'family-members' as const;
export const familyMemberProfilesQueryKeyBase = 'family-member-profiles' as const;
export const familyInvitesQueryKeyBase = 'family-invites' as const;
export const memoryCommentsQueryKeyBase = 'memory-comments' as const;
export const portraitVersionsQueryKeyBase = 'portrait-versions' as const;

export function memoriesQueryKey(familyId: string | null | undefined) {
  return [memoriesQueryKeyBase, familyId] as const;
}

export function memoriesSearchQueryKey(
  familyId: string | null | undefined,
  searchQuery: string,
) {
  return [memoriesSearchQueryKeyBase, familyId, searchQuery] as const;
}

export function memoryDetailQueryKey(familyId: string | null | undefined, memoryId: string | undefined) {
  return [memoriesQueryKeyBase, familyId, 'detail', memoryId] as const;
}

export function calendarMemoriesQueryKey(familyId: string | null | undefined) {
  return [calendarMemoriesQueryKeyBase, familyId] as const;
}

export function familyMembersQueryKey(familyId: string | null | undefined) {
  return [familyMembersQueryKeyBase, familyId] as const;
}

export function portraitVersionsQueryKey(familyId: string | null | undefined) {
  return [portraitVersionsQueryKeyBase, familyId] as const;
}

export function familyMemberProfilesQueryKey(
  userId: string | null | undefined,
  familyId: string | null | undefined,
) {
  return [familyMemberProfilesQueryKeyBase, userId, familyId] as const;
}

export function familyInvitesQueryKey(familyId: string | null | undefined) {
  return [familyInvitesQueryKeyBase, familyId] as const;
}

export function memoryCommentsQueryKey(
  familyId: string | null | undefined,
  memoryId: string | undefined,
) {
  return [memoryCommentsQueryKeyBase, familyId, memoryId] as const;
}
