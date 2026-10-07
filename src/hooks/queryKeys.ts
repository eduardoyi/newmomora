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
// Family relationships (docs/features/family-relationships.md): pending AI
// suggestions (owner/manager only) and every account's "this is me" link.
export const familySuggestionsQueryKeyBase = 'family-suggestions' as const;
export const familyMembershipLinksQueryKeyBase = 'family-membership-links' as const;
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
export const galleryImportQueryKeyBase = 'gallery-import' as const;
export const galleryCaptionSettingsQueryKeyBase = 'gallery-caption-settings' as const;
// Server-authoritative run status and candidate previews for the Timeline
// entry point (glyph + drawer). Deliberately separate from
// galleryImportQueryKeyBase's inert query (see useGalleryImport.ts) -- these
// two are keyed by runId, not familyId, and are NEVER added to the
// query-persistence allow-list: candidates carry short-lived signed preview
// URLs that must not survive a cold start on disk.
export const galleryImportRunStatusQueryKeyBase = 'gallery-import-run-status' as const;
export const galleryImportCandidatesQueryKeyBase = 'gallery-import-candidates' as const;
// Memory Book in-app scope picker (docs/plans/memory-book.md §"5a.5"). Keyed
// by child, not just family, since the picker/status list is per-child (the
// entry point lives on that child's profile screen).
export const memoryBooksQueryKeyBase = 'memory-books' as const;
export const memoryBookEligibilityQueryKeyBase = 'memory-book-eligibility' as const;
// Year Films (docs/plans/year-film-p2.md Step 3-4). None of these are on the
// query-persistence allow-list: posters are short-lived signed URLs and the
// film list is cheap to refetch.
export const yearFilmsQueryKeyBase = 'year-films' as const;
export const yearFilmViewsQueryKeyBase = 'year-film-views' as const;
export const yearFilmPosterQueryKeyBase = 'year-film-poster' as const;
export const yearFilmsEnabledQueryKeyBase = 'year-films-enabled' as const;
export const holidayCardQueryKeyBase = 'holiday-card' as const;
// Keepsakes tab `keepsakes_overview` RPC (docs/plans/keepsakes-redesign.md B2).
// Not on the query-persistence allow-list: it carries storage keys for pictures.
export const keepsakesOverviewQueryKeyBase = 'keepsakes-overview' as const;

export function memoriesQueryKey(familyId: string | null | undefined) {
  return [memoriesQueryKeyBase, familyId] as const;
}

export interface MemorySearchKeyInput {
  query: string;
  memberIds: string[];
  emotion: string | null;
}

function memberIdsKey(memberIds: string[]): string {
  // Selection order doesn't change the result set.
  return [...memberIds].sort().join(',');
}

export function memoriesSearchQueryKey(familyId: string | null | undefined, search: MemorySearchKeyInput) {
  return [memoriesSearchQueryKeyBase, familyId, search.query, memberIdsKey(search.memberIds), search.emotion] as const;
}

export function memorySearchFacetsQueryKey(familyId: string | null | undefined, search: MemorySearchKeyInput) {
  return [memoriesSearchQueryKeyBase, familyId, 'facets', search.query, memberIdsKey(search.memberIds), search.emotion] as const;
}

// Date-anchored Timeline (docs/plans/timeline-calendar-keepsakes.md A2).
// Nested under the memories base on purpose: isMemoriesListQueryKey matches
// it, so patchMemoryInCaches / removeMemoryFromListCaches / the generation
// poll cover it with no extra wiring. memoryBelongsToListKey rejects it, so
// new memories are NOT prepended into an anchored list, and
// shouldDehydrateQuery excludes it, so an anchor never survives a restart.
export const ANCHORED_MEMORIES_KEY_SEGMENT = 'anchored' as const;

export function anchoredMemoriesQueryKey(familyId: string | null | undefined, anchorDate: string) {
  return [memoriesQueryKeyBase, familyId, ANCHORED_MEMORIES_KEY_SEGMENT, anchorDate] as const;
}

// Timeline month picker's per-month counts. Its own base on purpose -- NOT
// under calendar-memories, whose readers (patchMemoryInCaches, the generation
// poll) treat every array under that base as memory rows. Not persisted.
export const memoryMonthCountsQueryKeyBase = 'memory-month-counts' as const;

export function memoryMonthCountsQueryKey(familyId: string | null | undefined) {
  return [memoryMonthCountsQueryKeyBase, familyId] as const;
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

export function familySuggestionsQueryKey(familyId: string | null | undefined) {
  return [familySuggestionsQueryKeyBase, familyId] as const;
}

export function familyMembershipLinksQueryKey(familyId: string | null | undefined) {
  return [familyMembershipLinksQueryKeyBase, familyId] as const;
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

export function galleryImportQueryKey(
  userId: string | null | undefined,
  familyId: string | null | undefined,
  runId?: string | null,
) {
  return [galleryImportQueryKeyBase, userId, familyId, runId ?? 'active'] as const;
}

export function galleryCaptionSettingsQueryKey(
  userId: string | null | undefined,
  familyId: string | null | undefined,
) {
  return [galleryCaptionSettingsQueryKeyBase, userId, familyId] as const;
}

export function galleryImportRunStatusQueryKey(runId: string | null | undefined) {
  return [galleryImportRunStatusQueryKeyBase, runId ?? 'none'] as const;
}

export function galleryImportCandidatesQueryKey(runId: string | null | undefined) {
  return [galleryImportCandidatesQueryKeyBase, runId ?? 'none'] as const;
}

export function familyActivityQueryKey(familyId: string | null | undefined) {
  return [familyActivityQueryKeyBase, familyId] as const;
}

export function familyActivityUnreadQueryKey(familyId: string | null | undefined) {
  return [familyActivityUnreadQueryKeyBase, familyId] as const;
}

export function memoryBooksQueryKey(familyId: string | null | undefined, childId: string | undefined) {
  return [memoryBooksQueryKeyBase, familyId, childId] as const;
}

// All of a family's books (Keepsakes). Nested under the same base as the
// per-child key, so invalidating [memoryBooksQueryKeyBase, familyId] covers
// both.
export function familyMemoryBooksQueryKey(familyId: string | null | undefined) {
  return [memoryBooksQueryKeyBase, familyId, 'family'] as const;
}

export function memoryBookEligibilityQueryKey(
  familyId: string | null | undefined,
  childId: string | undefined,
  dateOfBirth: string | null | undefined,
  // Scope options (and so the counts) depend on "today" -- a tab left
  // mounted across midnight must not reuse yesterday's counts.
  todayIso?: string | null,
) {
  return [memoryBookEligibilityQueryKeyBase, familyId, childId, dateOfBirth ?? null, todayIso ?? null] as const;
}

/** A family's surfaced films (Timeline, Keepsakes, drawer). */
export function yearFilmsQueryKey(familyId: string | null | undefined) {
  return [yearFilmsQueryKeyBase, familyId] as const;
}

/** The caller's own view rows ("New" marker); per user so a shared device
 * never inherits another account's viewed state. */
export function yearFilmViewsQueryKey(userId: string | null | undefined) {
  return [yearFilmViewsQueryKeyBase, userId] as const;
}

/** One film's signed list-thumbnail URL. Per film id so a growing list does
 * not re-sign everything. */
export function yearFilmPosterQueryKey(filmId: string) {
  return [yearFilmPosterQueryKeyBase, filmId] as const;
}

export function yearFilmsEnabledQueryKey(familyId: string | null | undefined) {
  return [yearFilmsEnabledQueryKeyBase, familyId] as const;
}

/** The Keepsakes holiday-card tile's `holiday_card_summary` row. */
export function holidayCardQueryKey(familyId: string | null | undefined) {
  return [holidayCardQueryKeyBase, familyId] as const;
}

/** The Keepsakes tab's `keepsakes_overview` row (recap progress, previews, order statuses). */
export function keepsakesOverviewQueryKey(familyId: string | null | undefined) {
  return [keepsakesOverviewQueryKeyBase, familyId] as const;
}

/** The edit sheet's options for one film. Under the films base key so
 * `invalidateYearFilms` (with or without a family) refreshes it too. */
export function yearFilmEditOptionsQueryKey(filmId: string | null | undefined) {
  return [yearFilmsQueryKeyBase, 'edit-options', filmId] as const;
}

/** The memories behind an edit sheet's moments (thumbnail lookup). */
export function yearFilmEditFramesQueryKey(familyId: string | null | undefined, memoryIdsSignature: string) {
  return [yearFilmsQueryKeyBase, 'edit-frames', familyId, memoryIdsSignature] as const;
}
