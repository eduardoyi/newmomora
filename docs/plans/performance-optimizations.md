# Performance Optimizations Plan

**Status:** Reviewed (3 adversarial rounds: Sonnet ×2, Fable ×1) — ready for implementation
**Date:** 2026-07-15
**Owner:** Eduardo + Claude

## 1. Context

A performance audit (2026-07-15) found the runtime cost of the app concentrated in a
few places. The strengths we must NOT regress: batched/coalesced signed-URL fetching
(`src/services/media.ts` — 25ms coalescing window, 50-key chunks, TTL-aware cache),
batched enrichment (tags/media/engagement chunked at 100, engagement via a single
`get_memory_engagement(uuid[])` RPC), correct DB indexes
(`idx_memories_family_id_memory_date`), a fully virtualized calendar, cache-patching
mutations (`patchMemoryInCaches`), and the `useMemoryMutations` split that keeps
mutation-only screens from subscribing to the timeline.

The problems:

- **P1** — `fetchMemories()` (`src/services/memories.ts:304`) has no limit/pagination;
  the full library (~700 rows) + 3 enrichment round-trips re-runs on every tab focus
  (`timeline.tsx:99-103` `useFocusEffect(refetch)` bypasses `staleTime`), every 3s
  while any illustration is pending (`useMemories.ts:431-442` `refetchInterval`), and
  whenever the member-profile screen mounts (`app/(app)/family/[id]/index.tsx` calls
  `useMemories()` unfiltered).
- **P2** — Timeline `FlatList` (`timeline.tsx:194-221`) has no windowing props;
  `MemoryCard` is un-memoized; `renderItem` allocates fresh closures per row per render.
- **P3** — Memory photos are re-encoded on upload (EXIF strip,
  `src/utils/strip-image-metadata.ts:64` — empty actions array) but never resized; no
  derived thumbnail exists. Full-res originals (multi-MB) are downloaded into 56×56
  calendar stamps and timeline cards.
- **P4** — Illustration/emotion status is discovered by polling in 3 hooks; Supabase
  Realtime is unused for data.
- **P5 (minor)** — `select('*')` on list queries drags heavy columns (`link_previews`
  JSON etc.); `useMediaUrls` has `staleTime` 50min but default `gcTime` 5min (early
  eviction); `searchMemories` uses `ILIKE %term%` which cannot use the existing GIN
  FTS index `idx_memories_content_search`.

## 2. Goals / Non-goals

**Goals:** timeline cost scales with what's on screen, not library size; eliminate
redundant refetches; cut media bandwidth for list views; replace poll loops with push.

**Non-goals:** no visual/UX redesign; no changes to the illustration/voice pipelines
themselves; no read-time image-resizing infrastructure (Cloudflare worker) in this
pass — rejected in favor of client-generated preview variants to keep everything in
this repo; originals are NEVER downscaled (keepsake product — full quality must be
preserved for future export/print features).

## 3. Workstreams

Ordered by dependency. A → B → E are the core path; C and D are independent of each
other but both depend on A's cache-shape changes being settled.

---

### Workstream A — Paginate the timeline + refetch hygiene

**A0. Extract the cache helpers into a shared module.** `patchMemoryInCaches`,
`findMemoryInListCache`, `setMemoryIllustrationPendingInCache`,
`setMemoryEmotionInCache`, `invalidateMemoryQueries`, and `isMemoriesListQueryKey`
are currently module-private to `src/hooks/useMemories.ts` (none are exported), yet
A5 and D2 need them from new files. Move them to a new `src/hooks/memory-cache.ts`
(exported) and have `useMemories.ts` import from there. This is a prerequisite for
A5/D2 and keeps the InfiniteData-shape logic in exactly one place — do NOT
reimplement shape detection in the new hooks.

**There is already one rogue reimplementation that MUST be folded in:**
`patchMemoryEngagement` in `src/hooks/useMemoryEngagement.ts:38-61` inlines its own
copy of the list-key predicate and an `Array.isArray(current).map(...)` patch. Left
alone, every optimistic like/comment-count patch silently no-ops once list caches
become `InfiniteData` — and with A4b's no-refetch model the wrong count persists
indefinitely. Rewrite it on top of the shared `patchMemoryInCaches`, with a test
against an `InfiniteData` fixture.

**A1. Keyset-paginated fetch.** Add to `src/services/memories.ts`:

```ts
export interface MemoriesPageCursor { memoryDate: string; createdAt: string }
export interface MemoriesPage {
  memories: MemoryWithTags[];
  nextCursor: MemoriesPageCursor | null;
}
export async function fetchMemoriesPage(opts: {
  cursor?: MemoriesPageCursor; limit: number;
}): Promise<{ data: MemoriesPage | null; error: ServiceError | null }>
```

Keyset predicate (matches the existing sort `memory_date desc, created_at desc` and
the `idx_memories_family_id_memory_date` index):

```ts
query = query.or(
  `memory_date.lt.${cursor.memoryDate},` +
  `and(memory_date.eq.${cursor.memoryDate},created_at.lt.${cursor.createdAt})`
);
```

`nextCursor` = last row's `(memory_date, created_at)`; `null` when
`rows.length < limit`. Enrichment (tags/media/engagement) runs per page exactly as
today. Page size: **40**.

Note: `idx_memories_family_id_memory_date` covers `(family_id, memory_date desc)`
only — the `created_at` tie-break inside a same-date group is not index-covered.
Same-day row counts are small so this is fine functionally, but add a migration
extending the index to `(family_id, memory_date desc, created_at desc)` in this
workstream (cheap, and pagination now leans on this ordering permanently).

**A2. `useMemories` → `useInfiniteQuery`.** In `src/hooks/useMemories.ts`:
- Query key becomes `memoriesQueryKey(familyId)` (no search segment) and data shape
  becomes `InfiniteData<MemoriesPage>`.
- **Search moves to its own query key base** (`'memories-search'` in
  `src/hooks/queryKeys.ts`) and its own plain `useQuery` (non-infinite, array data).
  This removes the cache-shape hazard of mixing `InfiniteData` and flat arrays under
  the same `memoriesQueryKeyBase` prefix that `isMemoriesListQueryKey` and
  `patchMemoryInCaches` match on. Search results are transient and excluded from
  cache patching by construction. (Note: search currently has no reachable UI —
  `timeline.tsx:95` has no setter — so this branch is exercised only by tests until
  the search feature ships.)
- Expose `memories` as a flattened, **id-deduplicated** array (`useMemo`) — dedup
  guards against a row shifting pages between fetches.
- Expose `fetchNextPage`, `hasNextPage`, `isFetchingNextPage` from the hook.
- Keep `staleTime: 5min`. **Remove the list-level `refetchInterval` entirely** —
  replaced by A5's narrow poll.

**A3. Cache helpers must handle the new shape.** `patchMemoryInCaches` (line 119) and
`findMemoryInListCache` (line 80) currently assume `MemoryWithTags[]`. Update both to
detect and map over `InfiniteData.pages[].memories`. Calendar caches keep their
array shape — the calendar query is untouched. The `Array.isArray` guards that
protect the calendar's `'oldest-date'` string entry must be preserved.
`invalidateMemoryQueries` is redesigned in A4b — do not leave it refetching (v5
refetches every loaded page of an invalidated infinite query).

**A4. Remove the focus refetch.** Delete the `useFocusEffect` block at
`timeline.tsx:99-103`. Freshness is covered by `staleTime` + A3b's cache patching +
pull-to-refresh. **Pull-to-refresh must trim to page 1**, not `refetch()` all loaded
pages — `useInfiniteQuery.refetch()` sequentially refetches every loaded page (N×
the enrichment round-trips). Implementation: `setQueryData` on the timeline key
(**`exact` targeting — don't touch A6's member-profile query nested under the same
prefix**) trimming `pages`/`pageParams` to the first entry, then `refetch()` — now a
single-page refetch. Do NOT use `resetQueries`: it clears data and flips the query
to `isLoading`, which swaps the pulled list for the full-screen spinner branch
(`timeline.tsx:153`) mid-gesture. The user is at the top of the list when pulling,
so dropping deeper pages is correct UX.

**A4a. Foreground/freshness strategy (explicit, because the app wires
`focusManager` to AppState — `src/components/app-providers.tsx:11-21` — and the
query client does not override `refetchOnWindowFocus`).** Left at the default, every
app foreground would refetch ALL loaded pages of a stale infinite query (v5
refetches pages sequentially) — reintroducing the cost A4/A4b eliminate. Disabling
it naively instead removes the only reconciliation backstop (tab screens never
unmount, so "next mount" never comes). Decision: set
`refetchOnWindowFocus: false` on the infinite list queries, and add an app-foreground
handler (AppState listener or focusManager subscription) that, when the timeline
query is stale, runs the same trim-to-page-1 refresh as pull-to-refresh. Resulting
multi-user freshness guarantees — document these in `docs/features/memories.md`:
generation status is live (A5/D2); new/deleted memories are live (D2 INSERT/DELETE);
another member's content edits, retags, and engagement reconcile on app foreground
(after staleTime) or pull-to-refresh, not mid-session. Engagement counts also
refresh via the detail screen's own queries when opened.

**Do NOT use react-query's `maxPages`.** On a forward-only infinite query (no
`getPreviousPageParam`), v5's `maxPages` evicts from the FRONT of `pages`
(`addToEnd` slices index 0) — i.e. it drops the NEWEST page and trims `pageParams`
in lockstep, so later refetches resume from a stale mid-list cursor and permanently
hide the newest memories (verified in `@tanstack/query-core` 5.100.14,
`infiniteQueryBehavior`/`addToEnd`). Retained pages are naturally bounded by library
size and reset on pull-to-refresh; leave them uncapped.

**A4b. Mutation cache strategy — invalidation must NOT refetch all pages.** In
react-query v5, `invalidateQueries` against an infinite query refetches EVERY loaded
page sequentially (each with its 3 enrichment calls), and v5 removed `refetchPage`.
With `invalidateMemoryQueries` called by all five mutations (`useMemories.ts:244,
323, 349, 367, 384`) plus D2's realtime INSERT/DELETE handler, a user with 5 loaded
pages would pay 5× today's cost per mutation — a regression. Redesign:
- `invalidateMemoryQueries` invalidates the memories-list base with
  `refetchType: 'none'` (marks stale as a reconciliation backstop; next natural
  mount/reset refetches). Calendar invalidation stays as-is (array-shaped, windowed,
  cheap).
- Each mutation then patches the list caches directly with data it already has:
  **create** → prepend the returned `MemoryWithTags` to page 1 of the timeline cache
  (new helper `prependMemoryToListCaches` in `memory-cache.ts`; also prepend to the
  member query's page 1 when the memory tags that member); **update** → the returned
  row through `patchMemoryInCaches`; **delete** → new `removeMemoryFromListCaches`
  helper; **retry/regenerate** → already patch to pending (unchanged).
- Realtime INSERT (D2): fetch the single new memory via `fetchMemoryById` (enriched)
  and prepend; DELETE → `removeMemoryFromListCaches`.

**Prepend must be sorted, not literal.** Timeline order is
`(memory_date desc, created_at desc)` and media memories are routinely backdated
(EXIF capture-date prefill, `use-suggested-memory-date.ts`). With no reconciling
refetch, a literal unshift misorders backdated rows until pull-to-refresh.
`prependMemoryToListCaches` inserts at sort position within loaded pages; if the row
sorts past the loaded window and `hasNextPage`, drop it (it'll appear when its page
loads).

**The media-create path does NOT go through these mutations.** Media memories are
created by `postMediaMemory` (`src/services/memory-posting.ts:196-234` — row
inserted AFTER upload completes) from the background queue
(`src/hooks/use-pending-memory-uploads.tsx`), which today reconciles via three raw
default-refetchType `invalidateQueries([memoriesQueryKeyBase])` calls (~lines
102-103, 115-116, 122-125). Post-A2 those would refetch every loaded page per media
post (the exact regression A4b prevents); converting them blindly to
`refetchType: 'none'` would instead make the posted memory never appear (the pending
card is removed at ~line 126 with nothing behind it). Required: `postMediaMemory`
already returns an enriched `MemoryWithTags` — wire the queue's post-create step to
`prependMemoryToListCaches` (sorted), and convert its three invalidations to
`refetchType: 'none'` backstops.

**Link previews need their own patch path.** `fireLinkPreviewFetch`
(`useMemories.ts:110-117`) and the queue's equivalent reconcile via
invalidation today; A5 polls status columns only and D2 patches generation fields
only, so under `refetchType: 'none'` a posted URL would render its domain fallback
forever. Fix: after `fetchLinkPreviews` resolves, fetch the row's `link_previews`
(or return it from the edge function response if it already does — verify) and
`patchMemoryInCaches` it. D2's UPDATE handler should also admit `link_previews` and
`content` in its patched-fields set.

Tests: each mutation's cache result asserted against an `InfiniteData` fixture
without any page-2+ refetch occurring (spy on the queryFn); sorted-insert cases
(backdated row lands mid-list; older-than-window row dropped); media-queue post
appears in cache without full refetch; link-preview patch lands.

**A5. Narrow generation-status poll.** New service fn:

```ts
// select only: id, illustration_status, illustration-key column(s),
// emotion, updated_at  (exact column names from src/types/database.ts)
export async function fetchMemoryGenerationStatuses(ids: string[])
```

New hook `useGenerationStatusPolling()` in a new file
`src/hooks/useGenerationStatusPolling.ts`. It takes NO memories param — it is a
single shared react-query query keyed `['generation-status', familyId]`, so timeline
and calendar mounting it concurrently dedupe to ONE poll loop (both tab screens stay
mounted in the `Tabs` navigator — independent per-hook timers would double-poll,
which is what today's two `refetchInterval`s already do; don't reproduce that):
- Its `refetchInterval` callback re-derives pending ids each tick by reading the
  list + calendar caches via `queryClient` (union of rows with
  `illustration_status ∈ {pending, generating}` → 3s; else rows matching
  `memoriesNeedEmotionPolling` → 5s; else `false` = idle). Reuse the predicates in
  `src/utils/media-emotion-polling.ts` unchanged.
- The queryFn fetches statuses for ONLY the pending ids; diffs against cache; applies
  `patchMemoryInCaches` per changed row.
- **Wake-from-idle mechanism (subtle — get this right):** react-query re-evaluates a
  `refetchInterval` callback only on the poll query's own update or on observer
  `setOptions` (i.e. a re-render of the mounting component). The poll hook therefore
  MUST be mounted from components that re-render when list caches change
  (`useMemories` / `useCalendarMemoriesInRange` hosts — they do), NOT solely from a
  static layout-level component, or an idle poll never wakes when a new pending
  memory appears. Add an explicit wake-from-idle test (create pending memory →
  poll starts), not just the stops-when-done test.
- When a status transitions to `ready`: also
  `queryClient.invalidateQueries({ queryKey: ['media-urls'] })` and invalidate
  calendar (mirrors the transition handling in `useMemory`, useMemories.ts:667-678).
- Mounted from `useMemories` and `useCalendarMemoriesInRange` (in
  `src/hooks/useCalendarMemories.ts`), replacing their `refetchInterval`s. The
  **detail hook (`useMemory`) keeps its existing `refetchInterval`** — it refetches
  a single row; cheap and self-contained.

**A6. Member-profile filtered query.** New service
`fetchMemoriesPageForMember(memberId, { cursor, limit })` — same keyset shape, inner
join on `memory_family_members` (`.select('..., memory_family_members!inner(family_member_id)')
.eq('memory_family_members.family_member_id', memberId)`). New hook
`useMemberMemories(memberId)` (infinite). **Query key MUST stay under the list-cache
predicate**: use `[...memoriesQueryKey(familyId), 'member', memberId]` — this keeps
`queryKey[0] === memoriesQueryKeyBase`, `queryKey[1] === familyId`, and
`queryKey[2] !== 'detail'`, so `isMemoriesListQueryKey` still matches it and status
patches from A5/D2/mutations keep reaching the member-profile screen (they do today
via the shared unfiltered query; losing that would be a live-update regression).
Its data is `InfiniteData<MemoriesPage>`, the same shape A3 teaches the patch helpers.
Update `app/(app)/family/[id]/index.tsx` to use it instead of `useMemories()`. This
also stops the profile screen from running the recovery/backfill effects over the
whole library.

**A7. Recovery + emotion-backfill effects** (useMemories.ts:456-548) now iterate the
flattened loaded pages. Accepted behavior change: backfill only touches memories the
user has actually paged to (bounded work per session instead of whole-library sweeps).
Known consequence to document in `docs/features/memories.md`: a memory stuck
`pending`/`generating` deep in history only self-heals when its page is loaded or its
detail screen is opened (the detail hook's recovery still covers it). A server-side
periodic sweep is the durable fix — out of scope here; note it as a follow-up.

**A8. Streak dots** (`timeline.tsx` `StreakDots`) computes from loaded memories; page 1
(40 rows) covers the current week in practice. Accepted tradeoff — document inline.

**Tests:** unit tests for `fetchMemoriesPage` cursor/or-predicate construction and
dedup; hook tests for `useMemories` infinite shape + `patchMemoryInCaches` on
`InfiniteData`; existing timeline screen-tests updated (no focus refetch; infinite
props). Poll hook test: pending → patch → stops when none pending.

---

### Workstream B — Timeline list rendering

**B1. Memoize `MemoryCard`** (`src/components/memory-card.tsx:276`): wrap export in
`React.memo`. Change the press-callback contract so props stay stable: `onPress` and
`onOpenComments` receive the memory id — `onPress: (memoryId: string) => void` — and
the card calls `onPress(memory.id)`. Call sites: `timeline.tsx:211` and
`memory-card.test.tsx` are the only renderers today (the member-profile screen uses
its own `MemoryThumb` row, not `MemoryCard`) — re-grep before assuming.

**B2. Timeline `FlatList` config** (`timeline.tsx:194`): mirror the calendar's proven
settings — `initialNumToRender={6}`, `maxToRenderPerBatch={6}`, `windowSize={7}`,
`removeClippedSubviews`. Add `onEndReached={fetchNextPage}` with
`onEndReachedThreshold={0.5}` and a `ListFooterComponent` spinner while
`isFetchingNextPage`. No `getItemLayout` (variable card heights).

**B3. Stable render callbacks**: hoist `renderItem` and press handlers into
`useCallback`; hoist `ListHeaderComponent` into a memoized element (it currently
recreates JSX per render).

**Tests:** screen-test that scrolling to end triggers `fetchNextPage`; memo test that
re-rendering the list with an unrelated state change does not re-render cards
(react-test-renderer render-count probe, matching existing test conventions).

---

### Workstream C — Preview image variants (bandwidth)

Originals stay untouched (privacy strip only). Add a derived preview.

**C1. Migration + types + RPC.** Add `preview_object_key text NULL` to
`memory_media`. Update `replace_memory_media_assets` RPC to accept/persist it **with
the same ownership validation as `object_key`**: the RPC already regex-checks every
asset key against `caller_prefix = current_user_id/memories/target_memory_id`
(`20260713150000_media_aspect_ratios.sql`) — apply the identical check to
`preview_object_key` (when non-null) so garbage/foreign keys can't be persisted.
Regenerate `src/types/database.ts`. Update `docs/TECH_SPEC.md` (per repo rule:
migration + types + TECH_SPEC in the same change).

**C2. Storage-key authorization plumbing (CRITICAL — the feature does not work, and
account deletion destroys live data, without this).** Storage keys are authorized by
being *referenced in the DB*, and every referencing lookup is hardcoded to
`object_key` today:
- `supabase/functions/_shared/family-access.ts` — `resolveReferencedStorageKeys`
  (`memory_media` select at ~line 196) must also select and admit
  `preview_object_key`. Without this, `get-media-url` 400s on every preview key
  (feature dead) and `delete-storage-object` refuses to delete previews (leak).
- `supabase/functions/hard-delete-expired-accounts/index.ts` — BOTH
  `resolveReferencedKeys` (`memory_media` select at ~line 160; treats any
  unreferenced object under a user prefix as orphan garbage and DELETES it — live
  previews of surviving memories would be destroyed on the first non-owner account
  hard-delete) AND `collectFamilyStorageKeys` (~lines 21-80; owner-deletion cleanup
  must include preview keys or they leak).
- Grep the edge functions for every other `from('memory_media').select(` to catch
  stragglers; add `preview_object_key` to each.
Tests for this step are mandatory: an edge-function test asserting a referenced
preview key is admitted by `resolveReferencedStorageKeys`, and a hard-delete test
asserting live preview objects are NOT collected as orphans.

**C3. Client-side preview generation.** New util `createImagePreviewForUpload` in
`src/utils/` : `manipulateAsync(uri, [{ resize: ... }], { compress: 0.8,
format: JPEG })` — resize by the LONGEST edge to ≤1280 (pass `width` for landscape,
`height` for portrait; expo-image-manipulator auto-computes the other dimension).
**Do NOT probe dimensions with an extra manipulate call**: the EXIF-strip step
computes `result.width/height` but currently discards them
(`strip-image-metadata.ts:66-76` returns only fileUri/contentType/aspectRatio) —
extend its return type to include width/height and reuse them here, so the total
cost is exactly one extra manipulate + one extra upload per photo.
**No-upscale guard:** if the longest edge is already ≤ 1280, skip preview generation
entirely (`preview_object_key = null`; the original-fallback path covers rendering).
Runs on the already-stripped file, so previews carry no EXIF either. Videos: skip
(they already have compression + thumbnails).

**C4. Upload path.** `uploadMemoryMediaAssets` (`src/services/memory-posting.ts`)
uploads the preview alongside the original. **Key naming: `-preview` suffix on the
asset id — a `previews/` path prefix is NOT viable**:
`MEMORY_MEDIA_ASSET_EXTENSION_PATTERN` in
`supabase/functions/_shared/storage-keys.ts` forbids `/` in the asset-id group, so
`upload-media` would 400 on a prefixed key. Verify `{assetId}-preview.jpg` passes
that pattern (the char class allows `-`) and add a test pinning it. Record
`preview_object_key` on the row. Preview upload failure must NOT fail the memory —
fall back to `preview_object_key = null` (fail-open; the original renders).

**C5. Deletion coverage.** Every path that deletes media objects must delete the
preview too. Concrete set (verify by grep, don't trust this list blindly):
`deleteStorageKeys` in `src/services/memories.ts` (~line 218 — note it only
`console.warn`s on failure, so silent leaks are invisible; keep that behavior but
cover previews), media replacement via `replace_memory_media_assets`, memory delete,
and the account-deletion paths already covered in C2.

**C6. Consumers.** List-view surfaces request the preview key when present, falling
back to the original: `MemoryCard` media, calendar `MemoryStamp`
(`app/(app)/(tabs)/calendar.tsx:43`), **and `MemoryThumb` in `app/(app)/family/[id]/index.tsx`
(~line 37 — full-res original into a small profile-row thumb today; A6 already
touches this file)**. Full-screen viewer and detail carousel keep the original. No
backfill for existing rows in this pass (fallback covers them); note a follow-up
backfill script as optional.

**C7. `useMediaUrls` gcTime.** Set `gcTime: 55 * 60 * 1000` on the media-urls query
(staleTime 50min < gcTime 55min < 60min R2 expiry).

**Tests:** util unit test (dimension math, format), upload-path test (preview
recorded; failure falls back to null), deletion-coverage test, consumer tests
(preview preferred, original fallback).

---

### Workstream D — Supabase Realtime for generation status

**D1. Migration:** `alter publication supabase_realtime add table public.memories;`
No existing migration or `supabase/config.toml` section touches publications —
verify against the database itself (`select * from pg_publication_tables where
pubname = 'supabase_realtime'`) in local and prod, not against config.toml. Default
REPLICA IDENTITY is fine for UPDATE payloads of owned columns.

**D2. Hook `useMemoriesRealtime(familyId)`** mounted once at the `(app)` layout or
family-provider level:
- `supabase.channel(...).on('postgres_changes', { event: 'UPDATE', schema: 'public',
  table: 'memories', filter: `family_id=eq.${familyId}` }, handler)`.
- Handler patches ONLY generation-relevant fields (`illustration_status`,
  illustration key columns, `emotion`, `updated_at`) via `patchMemoryInCaches`;
  `ready` transitions additionally invalidate `['media-urls']` + calendar (same as
  A5). INSERT → fetch the single enriched row (`fetchMemoryById`) and prepend via
  A4b's `prependMemoryToListCaches` (skip if the row is already in cache — the
  creating device already prepended it in its mutation); DELETE →
  `removeMemoryFromListCaches`. Do NOT call `invalidateMemoryQueries` with a
  refetching type from here (see A4b — it would refetch every loaded page).
- Verify RLS behavior: postgres_changes authorizes rows against RLS using the
  client's JWT; confirm `supabase.realtime.setAuth` is wired on token refresh
  (supabase-js v2 handles this — verify our client setup doesn't opt out).
- Resubscribe on familyId change; clean up channel on unmount.
- **Reconcile on every `SUBSCRIBED` transition — initial AND rejoin.** Realtime does
  not replay events missed while disconnected (iOS suspends the socket on
  background). Without this, an illustration that completed while backgrounded stays
  `pending` in cache, and A7's recovery then re-pins it to pending in a loop
  (`useMemories.ts:478-485` patches pending unconditionally on retry success). On
  each `SUBSCRIBED`, force one tick of A5's status query for the locally-pending
  ids.
- **INSERT events race the tag/media inserts** (`createMemory` writes the row, THEN
  tags — `memories.ts:633-650`; media RPC likewise). The INSERT-triggered
  `fetchMemoryById` can return empty `taggedMembers`/`mediaAssets` with nothing to
  repair them later. Delay the fetch (~1-2s) and/or retry once if tags/media come
  back empty on a memory type that requires them.

**D3. Poll suppression.** When the channel status is `SUBSCRIBED`, A5's poll hook
disables itself. **The shared state MUST be reactive — a plain ref cannot work**:
`refetchInterval` callbacks only re-evaluate on the poll query's own update or an
observer re-render, so flipping a non-reactive ref on `CHANNEL_ERROR` would leave
the poll idle exactly when realtime is down. Use React context or
`useSyncExternalStore` so suppression changes re-render the poll hook's hosts. Poll
resumes on `CHANNEL_ERROR`/`TIMED_OUT`; test both directions.

**Tests:** hook test with a mocked channel (patch on UPDATE payload, invalidate on
INSERT, fallback flag flips on channel error). Integration: existing illustration
screen-tests still pass with realtime mocked out.

---

### Workstream E — Query shaping + search

**E1. Explicit column list for list queries.** Audit fields actually consumed by
`MemoryCard`, calendar stamps, and enrichment attach fns; define
`const MEMORY_LIST_COLUMNS = '...'` in `src/services/memories.ts`; use it in
`fetchMemoriesPage`, `fetchMemoriesInDateRange`, member/search variants. Keep
`select('*')` ONLY in `fetchMemoryById`. Honest scoping: `MemoryCard` DOES consume
`link_previews` (`memory-card.tsx:193,251` via `toLinkPreviewMap`), so the column
originally cited as the heavy offender stays in the list columns for the timeline.
The realizable win is whatever columns the audit shows are genuinely unread by list
consumers (and a possibly smaller column set for the calendar query, which renders
stamps, not cards). If the audit finds the cut isn't worth a second type surface,
record that finding in the plan and skip E1 rather than forcing it.

**E1 audit outcome (implemented 2026-07-15): skipped.** The `memories` table
(`src/types/database.ts`) has 15 columns: `id`, `user_id`, `family_id`,
`content`, `memory_date`, `memory_type`, `emotion`, `illustration_key`,
`illustration_status`, `illustration_prompt`, `media_key`,
`media_content_type`, `link_previews`, `created_at`, `updated_at`. Every one
of them is read by at least one list consumer (`MemoryCard`, calendar
`MemoryStamp`, member-profile `MemoryThumb`, `media-emotion-polling.ts`'s
`isEmotionAnalyzable`/`shouldPollForEmotion`, or the poll/patch machinery in
`memory-cache.ts`/`useGenerationStatusPolling.ts`) **except**
`illustration_prompt`, which only the `generate-illustration` edge function
writes and reads server-side — no client list or detail consumer ever reads
it (confirmed by grep; it appears only in type defs and test fixtures).
Excluding that single column from `MEMORY_LIST_COLUMNS` would require a
second type surface (an `Omit<Memory, 'illustration_prompt'>` variant of
`Memory`/`MemoryWithTags` threaded through every list consumer, since
`MemoryWithTags` extends the full `Memory` row type) or a type-unsafe cast —
for one non-heavy text column, that isn't worth it per this section's own
escape hatch. Decision: list queries (`fetchMemoriesPage`,
`fetchMemoriesPageForMember`, `fetchMemoriesInDateRange`, `searchMemories`)
keep `select('*')`; the stricter §4 grep gate (`select('*')` allow-listed to
only `fetchMemoryById`/`createMemory`/`createMediaMemory`) does not apply
since E1 itself was skipped by design, not forced.

**E1b. Retire `fetchMemories()`.** After A2, the unpaginated `fetchMemories()` has
exactly one remaining caller: `searchMemories`'s empty-query fallback
(`memories.ts:434`). The new search hook (A2) only runs when the trimmed query is
non-empty, so delete the fallback and delete `fetchMemories()` outright. Note:
`select('*')` also appears in `fetchMediaForMemories` (`memory_media` table — small
rows, fine), and in `createMemory`/`createMediaMemory` insert-returning selects
(single rows, fine) — these are explicitly allowed to stay (see §4 gate).

**E2. Search limit.** `.limit(100)` on `searchMemories`.

**E3. FTS search.** Replace the `content.ilike` arm with
`.textSearch('content', trimmed, { type: 'websearch', config: 'english' })` to use
`idx_memories_content_search` (verify the index's tsvector config is `english` in
`supabase/migrations/*initial_schema.sql` and match it). The `emotion.ilike` arm:
keep it by running the FTS query and, if the trimmed term matches a known emotion
label, OR-merging a second cheap `.eq('emotion', ...)`-style query client-side —
emotion values are short enum-like labels (see `src/utils/` emotion helpers). If
PostgREST `.or()` with `wfts` proves workable, prefer the single-query form.

**Tests:** search service test (FTS call shape, escaping, limit), plus the E1 column
audit encoded as a type-level check (selected columns satisfy what
`MemoryWithTags` consumers require — if types are generated per-column this falls out
of `tsc`).

---

## 4. Sequencing & verification

Order: **A → B → E → C → D**. (B needs A's `fetchNextPage`; E touches the fns A
creates; C and D are independent of each other; D last since A5's poll is its
fallback and must exist first.)

Per-workstream gate (run with Node 20 — `nvm use 20`; add a `.nvmrc` with `20` in
workstream A so the requirement is codified in-repo instead of by convention):
1. `npx tsc --noEmit`
2. `npm test` (unit + integration + screen-tests)
3. Grep gate (post-E): `select('*')` on the `memories` TABLE appears only in
   `fetchMemoryById`, `createMemory`, and `createMediaMemory` (single-row
   fetch/insert-returning). `fetchMediaForMemories`' `select('*')` on `memory_media`
   is allowed. The gate is an allow-list check, not a zero-hit grep.
4. Maestro e2e (per docs/TESTING.md): run the existing timeline-affected flows
   (e.g. `.maestro/flows/sharing/04-second-account-sees-timeline.yaml` — the removed
   focus refetch changes its assumptions) and add/update flows for timeline
   infinite scroll + pull-to-refresh
5. Manual smoke via dev client where feasible: timeline scroll + post-memory flow

Docs in the same PR as the code (repo rule): update `docs/features/memories.md`
(pagination, preview variants, realtime) and `docs/TECH_SPEC.md` (schema/RPC changes,
realtime publication).

## 5. Risks

- **Cache-shape migration (A3) is the highest-risk change** — `patchMemoryInCaches`
  is called from mutations, recovery, backfill, poll, and realtime paths. Mitigate
  with dedicated unit tests on `InfiniteData` before wiring consumers.
- Keyset `.or()` predicate must be verified against PostgREST timestamp
  serialization (ISO strings with `+00:00` need URL-safe encoding — supabase-js
  handles this, but test with a real timestamp fixture).
- `removeClippedSubviews` on iOS can blank cells with transforms/videos — verify the
  video card behavior; drop the prop on iOS if it misbehaves (calendar already ships
  it, so precedent exists).
- Realtime on RLS tables requires the publication migration to be applied in prod;
  poll fallback (D3) covers the gap if it's missed.
- Preview uploads add per-post latency (one extra manipulate + one extra upload per
  photo, given C3 reuses the strip step's dimensions); it's on the background queue
  path (`use-pending-memory-uploads`), so posting UX is unchanged.
- The mutation cache strategy (A4b) trades "always consistent via refetch" for
  "patched + stale-marked backstop"; a bug in a patch helper shows up as a stale
  list rather than a crash. The `InfiniteData` fixtures + queryFn spies in A4b's
  tests are the guard.

## 6. Out of scope

Read-time image resizing (Cloudflare worker), backfilling previews for existing
media, exposing search UI (separate feature), web app perf.
