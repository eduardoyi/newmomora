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
export const familyActivityQueryKeyBase = 'family-activity' as const;
export const familyActivityUnreadQueryKeyBase = 'family-activity-unread' as const;
export const portraitVersionsQueryKeyBase = 'portrait-versions' as const;
// Looking Back is both family- and account-scoped: the package materialization
// belongs to the family, while reported/blocked visibility and viewed state
// belong to the current account. Keeping both ids in the key prevents a
// family switch or a different account on a shared device from inheriting
// either state.
export const lookingBackQueryKeyBase = 'looking-back' as const;
// Owned by use-family.tsx / useUserProfile.ts respectively -- pulled out to
// this dependency-free module (rather than left as string literals there)
// so lib-level code (src/lib/query-persistence.ts) can reference them
// without importing those hook modules and their heavy transitive chains
// (use-auth.tsx -> lib/supabase.ts's realtime client, in particular).
export const familyMembershipsQueryKeyBase = 'family-memberships' as const;
export const userProfileQueryKeyBase = 'user-profile' as const;

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

export function lookingBackQueryKey(
  userId: string | null | undefined,
  familyId: string | null | undefined,
) {
  return [lookingBackQueryKeyBase, userId, familyId] as const;
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

export function familyActivityQueryKey(familyId: string | null | undefined) {
  return [familyActivityQueryKeyBase, familyId] as const;
}

export function familyActivityUnreadQueryKey(familyId: string | null | undefined) {
  return [familyActivityUnreadQueryKeyBase, familyId] as const;
}
