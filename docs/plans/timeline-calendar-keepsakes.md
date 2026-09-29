# Timeline + Calendar merge, Keepsakes tab (Plan)

**Status:** Phase A shipped 2026-09-28 (5f70380); Phases B and C implemented 2026-09-29 (awaiting device check). Plan hardened (2 review rounds).
**Date:** 2026-09-28
**Owner decisions:** 2026-09-28 discussion (see §2)
**Feature docs to update in the same PRs:** `docs/features/calendar.md` (becomes the
calendar *view* of Timeline), `docs/features/memories.md` (Timeline date anchor),
`docs/features/memory-book-generation.md` (shelf entry point moves),
new `docs/features/keepsakes.md`.

## 1. Goal

The four tabs become **Timeline · Keepsakes · Family · Settings**.

- **Timeline** gains a view switcher (**List** / **Calendar**). The calendar view
  is a tiled month grid with a thumbnail per day; tapping a day shows the list
  view starting at that date. The Timeline also gets the calendar's pinned
  "month label → jump to month" header and a "Back to today" button.
- The **Calendar tab is removed**. Its day-per-row ribbon is replaced by the grid.
- **Keepsakes** is a new tab that holds the family's Memory Books (moved from the
  child profile) and, once Year Film P2 ships, its films.

Done means: every capability of the old Calendar tab (see any date, jump to any
month, get back to today) is reachable from Timeline; books are created, viewed
and retried from Keepsakes; the child profile keeps only a link to that
child's keepsakes.

## 2. Locked decisions (2026-09-28)

| Decision | Choice |
|---|---|
| Calendar | Merged into Timeline as a switchable view, not a tab |
| Calendar view | Tiled month grid, one thumbnail per day, "+N" badge for extra memories |
| Tap a day | Switches to List view anchored at that date |
| Month jump | Pinned month header + picker sheet moves to Timeline (both views) |
| Looking Back | **Stays on Timeline** (not a keepsake) |
| Keepsakes empty state | **One family-level pitch** (reuses the book pitch copy), not one per child |
| Child profile | Books row removed; replaced by a **"See {name}'s keepsakes"** link into the tab, filtered to that child |
| Interim shelf rule | Member has a book, or has a DOB and is < 13 (confirmed 2026-09-28) |
| Keepsakes tab icon | Gift (SF `gift` / Material `redeem`, verify Android render) (confirmed 2026-09-28) |
| Film surfaces | Films live in Keepsakes; the Year Film plan's "child profile → Films row" and "Timeline overflow → Films" are dropped (§8 of `year-film.md` updated) |

## 3. Context (current code)

- Tabs: `app/(app)/(tabs)/_layout.tsx` — `timeline`, `calendar`, `family`,
  `settings`. Icons/labels in `TAB_META` in `src/components/floating-tab-bar.tsx`
  (fallback glyph switch at ~L73). Nothing outside the tab bar navigates to
  `calendar` (grep for the route finds no other callers). `.maestro/flows/check-icons.yaml`
  taps the tab icons.
- **Timeline list** (`app/(app)/(tabs)/timeline.tsx`, 787 lines) is a FlatList over
  `useMemories` (`src/hooks/useMemories.ts` ~L443): a **forward-only**
  `useInfiniteQuery` keyed `memoriesQueryKey(familyId)` =
  `['memories', familyId]`, paged with `fetchMemoriesPage`
  (`src/services/memories.ts` ~L458), keyset cursor `{memoryDate, createdAt}`
  descending (`buildKeysetOrFilter` ~L373). The header holds the Looking Back
  rail, the "Recently" section, and the activity bell (`timeline-top-sections`).
  `refreshFirstPage` trims to page 1 and refetches; foreground reconcile is gated
  on "near top".
- **Cache patching** (`src/hooks/memory-cache.ts`): `isMemoriesListQueryKey`
  matches any `['memories', familyId, …]` key except `detail`.
  `patchMemoryInCaches` / `removeMemoryFromListCaches` apply to all list keys;
  `prependMemoryToListCaches` only inserts into keys that
  `memoryBelongsToListKey` accepts (the base key, and `['memories', f, 'member', id]`).
  Calendar range caches (`['calendar-memories', …]`, plain arrays) are patched and
  invalidated separately; `useGenerationStatusPolling` also reads them.
- **Calendar tab** (`app/(app)/(tabs)/calendar.tsx`, 1039 lines; spec in
  `docs/features/calendar.md`): week ribbon + fixed header (month label = picker
  trigger via `CalendarMonthPickerSheet`, Today button). Data:
  `useCalendarMemoriesInRange` / `useOldestMemoryDate`
  (`src/hooks/useCalendarMemories.ts`), which call `fetchMemoriesInDateRange` /
  `fetchOldestMemoryDate`. Pure helpers in `src/utils/calendar.ts`
  (`getCalendarMonthOptions`, `getVisibleMonthLabel`, `formatMonthBreakLabel`, …).
  `MemoryStamp` (~L78) picks the thumbnail via `resolvePreferredCoverKey` /
  `resolveVideoPosterKey` (`src/utils/media-preview.ts`) and handles
  content-safety hidden memories.
- **Memory Books shelf** (`app/(app)/family/[id]/memory-books.tsx`, 550 lines) is
  single-child: `useMemoryBooks({ familyId, childId, dateOfBirth })`,
  `pickSuggestedScopes`, `CreateBookSheet`, `RetryBookSheet`, `BookCoverTile`,
  `BookToast`. Viewers see existing books only (`canGenerate`). Empty state
  (`testID="memory-books-empty"`, ~L254) is the pitch: eyebrow "KEEPSAKES",
  "A year of {name}, printed and bound.", layflat bullets, "Create a book" CTA.
  Entry point: `SettingsBlock title="Keepsakes"` row on the profile
  (`app/(app)/family/[id]/index.tsx` ~L361), shown only to owner/manager
  (`canEdit`) and for **any** member (no child check). Route helper
  `memoryBooksRoute` in `src/lib/routes.ts` ~L152.
- **Who is a child:** `family_members` has `date_of_birth`, `relationship`,
  `family_side`, but no "own kid" flag. `classifyChildOrAdult` (<13) lives in
  `supabase/functions/_shared/date-context.ts` (server only). "Own children"
  depends on the unbuilt family-relationships work (`docs/plans/family-relationships.md`).
- **Year Film** (`docs/plans/year-film.md` §8): Timeline card + push +
  child-profile Films row + Timeline-overflow Films list; completion "Print this
  year" opens the book scope picker. P2 (app) must be in production by ~Dec 5.

## 4. Steps

Three shippable phases. The Calendar tab is removed only in Phase C, after
Timeline can do everything it did.

### Phase A — Timeline date anchor + pinned header (ships alone)

**A1. Anchored fetch (service)** in `src/services/memories.ts`:
- Extend `MemoriesPage` (~L364) with optional `prevCursor?: MemoriesPageCursor | null`.
  Existing producers (`fetchMemoriesPage`, `fetchMemoriesPageForMember`, the
  `{ memories: [], nextCursor: null }` fallbacks in `useMemories`) leave it
  `undefined`; nothing in `memory-cache.ts` reads it, so page-shaped patches
  are unaffected.
- `fetchMemoriesPage` gains an optional `startDate` (`memory_date <= startDate`)
  for the first anchored page.
- New `fetchMemoriesPageNewer(familyId, { cursor, limit })`: ascending order,
  keyset `memory_date > d OR (= d AND created_at > c)`, results **re-sorted
  descending**; `prevCursor` = key of the newest row **when the page is full**
  (a short page means we've reached today).
- The **first anchored page's** `prevCursor` is not about page fullness: set it
  to the key of its newest row whenever `anchorDate < today` (newer rows may
  exist). If a `fetchMemoriesPageNewer` call then returns 0 rows, it returns
  `prevCursor: null` and paging up stops.
Unit tests for both keyset filters (date boundary, same-day `created_at` tie,
empty newer page).

**A2. One hook, optional anchor.** Don't add a parallel hook. The recovery
effects (illustration/emotion backfill), the foreground and reconnect reconcile,
and the `useGenerationStatusPolling` mount all live inside `useMemories`
(`useMemories.ts` ~L443–700), so extend it: `useMemories({ anchorDate?,
shouldReconcileOnForeground })`.
- `anchorDate == null` → exactly today's behavior and key `['memories', familyId]`.
- `anchorDate != null` → key `['memories', familyId, 'anchored', anchorDate]`.
  **Page params are tagged**, `{ dir: 'anchor' | 'older' | 'newer', cursor? }`,
  and the queryFn dispatches on `pageParam.dir`, never on react-query's
  `direction`. React-query refetches an infinite query by replaying
  `pageParams[0]` and then chaining `getNextPageParam` forward. After a
  `fetchPreviousPage`, `pageParams[0]` is a *newer* cursor, and untagged it
  would be misread as an older one. `initialPageParam = { dir: 'anchor' }` →
  `fetchMemoriesPage({ startDate })`; `getNextPageParam` → `{ dir: 'older',
  cursor: nextCursor }`; `getPreviousPageParam` → `{ dir: 'newer', cursor:
  prevCursor }`. Every page carries correct `nextCursor` and `prevCursor`
  (a newer page's `nextCursor` is its oldest row), so the forward replay chains
  contiguously.
- **Refresh while anchored** doesn't replay pages. It trims the anchored cache
  to its anchor page (a `trimListCacheToFirstPage` variant keyed on the anchored
  key, with the page param reset to `{ dir: 'anchor' }`) and then refetches, the
  same shape as `refreshFirstPage`. `invalidateMemoryQueries` uses
  `refetchType: 'none'` for the `memories` prefix, so invalidation only marks it
  stale. The next refetch goes through this path.
- Recovery effects run over whichever list is shown (they key off loaded
  memories, and that's the right set). The foreground/reconnect reconcile and
  `refreshFirstPage` (`trimListCacheToFirstPage` only knows the base key) are
  **disabled while anchored**. Pull-to-refresh in anchored mode refetches the
  anchored query (few pages).
- Only one list query is mounted at a time, so there are no background base-feed
  loads while anchored. When you return to today, the base cache is still there
  (5-min `staleTime`), so it shows instantly.
- The key sits under the `memories` prefix, so `patchMemoryInCaches` and
  `removeMemoryFromListCaches` cover it. `memoryBelongsToListKey` returns
  `false` for it, so **new memories are not inserted** into an anchored list;
  "Back to today" is always visible in anchored mode. Document in `memories.md`.
- **Persistence:** `PERSISTABLE_QUERY_KEY_BASES` (`src/lib/query-persistence.tsx`
  ~L56) includes `memories`. Exclude `queryKey[2] === 'anchored'` in
  `shouldDehydrateQuery` (~L91) so anchors aren't restored on cold start.
  Anchored `gcTime` 60s.
- **Anchor rule:** the list starts at the newest memory on or before
  `anchorDate`.

**A3. Timeline screen wiring** (`timeline.tsx`):
- State `anchorDate: string | null`, fed to `useMemories`.
- Anchored mode hides the Looking Back rail, the "Recently" section, the gallery
  invite and `StreakDots` (all "now" content). Streak dots read
  `visibleMemories`, which would show the wrong week while anchored.
- FlatList: `maintainVisibleContentPosition={{ minIndexForVisible: 0 }}` +
  `onStartReached` → `fetchPreviousPage`, so newer pages prepend without a jump.
  **Verify on Android.** Fallback: a "Load newer" button as the first row.
- Changing anchor or returning to today → scroll to offset 0. No
  `scrollToIndex`, no height model.
- **Anchor clears automatically** (→ today's feed) when: a memory is created by
  this user (the create/upload success path already prepends to the base list,
  so clearing the anchor makes it visible), the Timeline tab is re-pressed
  while focused, or the app returns from background after >30 min. It is
  **not** cleared by opening a memory and coming back.

**A4. Header layout (explicit).** Today the title row (`TimelineTitle`: "Your
moments.", search button, activity bell) and `StreakDots` sit inside the list's
`ListHeaderComponent` (~L386). The same title appears in the error, hidden-only
and empty branches via `TimelineTitleWithStreak` (~L480–530). New layout:
- **Pinned bar** `src/components/timeline/timeline-header-bar.tsx`, a sibling
  *above* the FlatList/grid (the calendar's fixed-bar pattern), SafeArea top
  edge, rendered in **every** branch (loading, error, empty, hidden-only, list,
  grid). Left: month label (the picker trigger). Center/right: view switcher
  (Phase B), search button, activity bell. Contextual "Today" button. The
  **search button and bell move here** and leave `TimelineTitle`, so there's
  one of each.
- The scrolling list header keeps the large "Your moments." title, streak dots
  (not anchored), Looking Back, Recently and the pending-uploads banner. The
  `SafeAreaView edges={['top']}` moves from the list header to the pinned bar.
- In the empty/no-memories branches the month label and switcher are disabled
  (nothing to jump to), and search and the bell still work.
- **Month label (list view):** the topmost visible card's `memory_date`, always
  with the year ("March 2026"). The Timeline already uses
  `onViewableItemsChanged` (60% `viewAreaCoveragePercentThreshold`, ~L66/L308)
  for video autoplay, and RN forbids changing those props on the fly. So switch
  both to `viewabilityConfigCallbackPairs` (stable ref): the existing 60%
  autoplay pair plus a label pair (`itemVisiblePercentThreshold: 15`, the
  calendar's value) that takes the minimum visible index.
- **Month picker:** reuse `CalendarMonthPickerSheet` and `getCalendarMonthOptions`,
  with **per-month counts now required** (not optional). Fetch with one
  `select memory_date` for the family (dates only, paginated past the 1000-row
  default), grouped client-side into a `Record<'YYYY-MM', number>`. It gets its
  **own key base** `memory-month-counts` (not under `calendar-memories`: both
  `patchMemoryInCaches` and `useGenerationStatusPolling` treat every array under
  that base as memory rows). It's not persisted, fetched when the picker opens
  (plus prefetch on first Timeline focus), `staleTime` 5 min, and invalidated
  only on create/delete/date-edit, not on illustration or emotion updates. Rows show "March · 23"; empty months are shown greyed and
  disabled, so a pick always lands in the chosen month.
- Picking a month → `anchorDate` = last day of that month (current month →
  `null`). No "nothing on this day" note for picker jumps. For calendar-day taps
  it can't happen either, since empty tiles aren't tappable (B3), so the note is
  dropped entirely.
- "Today" is visible when `anchorDate !== null` or the list has scrolled past the
  first screen. Tap → `anchorDate = null` + offset 0.

**A5. Tests.** Unit: keyset helpers, first-page `prevCursor` rule, month-count
grouping, month-label derivation. Integration (`useMemories` with an anchor):
older and newer paging, **prepend a newer page then `refetch()` keeps order +
anchor row**, patch/delete hit the anchored cache, prepend doesn't, anchor
clears on create,
reconcile is skipped while anchored, the anchored key isn't dehydrated. Screen
test: port `src/screen-tests/calendar.month-jump.test.tsx` to the Timeline
(picker → anchored list → Today). Maestro `timeline/jump-to-month.yaml`.

**A — as built (2026-09-28), deviations from the steps above:**
- Anchor clearing on "create" is wired to the **FAB press** (clear, then open
  the new-memory screen) rather than to create success. Other entry points
  (share sheet, widget, notification) don't clear it, and their memory shows
  once the user taps Today.
- The month picker doesn't use `useOldestMemoryDate`. Its range comes from
  the month counts (oldest month with a memory → max(current month, newest
  month)), so future-dated memories are covered in Phase A already.
- `fetchMemoriesPage` also takes `inclusive` (for resuming after an empty
  newer page). The first anchored page is a separate
  `fetchAnchoredMemoriesPage` (page + a one-row newer-exists check).
- Analytics event added now (`timeline_jumped`); the Phase C events come
  with C.
- **Still to verify on device:** `maintainVisibleContentPosition` when newer
  pages prepend (Android especially). The fallback "Load newer" row isn't
  built.

### Phase B — Calendar view inside Timeline

**B1. View switcher** in the pinned bar: segmented "List | Calendar"
(icons + labels, accessible). State in `timeline.tsx`, persisted in AsyncStorage
key `timeline.view` (per device, shared across families; try/catch; default
List).

**B2. Month grid** `src/components/timeline/calendar-month-grid.tsx`:
- A FlatList of **months**, newest first, from **max(current month, newest
  memory's month)** back to `useOldestMemoryDate`. Future-dated memories (the
  date is unvalidated; bad EXIF from imports) stay reachable. Future days with a
  memory are tappable, and future days without one are dimmed. The picker uses
  the same range. Each item = month title + 7-column Monday-start grid.
  Month height (4–6 week rows) follows from date math, so `getItemLayout` is
  exact and the picker's `scrollToIndex` needs no correction pass.
- **Extract `MemoryStamp`** from `calendar.tsx` (~L78–180) to
  `src/components/memory-stamp.tsx` with all its branches: illustration, photo
  cover (`resolvePreferredCoverKey`), video poster (`resolveVideoPosterKey`),
  **audio** (`SoundTile` + `seedFromKey`), text glyph, and content-safety hidden
  ("Show"). Sized down for tiles.
- Per day, reuse the ribbon's selection: filter out blocked users' memories
  (`isUserBlocked`, calendar.tsx ~L350), pick the first visible memory by
  `created_at` (~L354–364), and "+N" = the count of the **other visible**
  memories that day (blocked excluded, reported/hidden counted, since they still
  render as a hidden stamp in the list).
- Data: `useCalendarMemoriesInRange` over visible months ± 1. Existing
  `calendar-memories` patching/invalidation and generation polling keep
  working. **Row cap:** `fetchMemoriesInDateRange` has no `.limit()` and
  PostgREST caps at 1000 rows. Heavy gallery-import families can exceed that in
  3 months, so the grid uses a **new lightweight range fetch**
  (`fetchMemoryStampsInDateRange`: only the columns a stamp needs + preview
  media keys, paginated) rather than the fully-enriched
  `fetchMemoriesInDateRange`. It still caches under `calendar-memories` as
  memory-shaped rows so patching and polling keep working. Verify the patched
  fields are present.
- Today outlined.
- The pinned label tracks the top visible month. The picker scrolls the grid
  (not an anchor) while in Calendar view.
- Accessibility: tiles labelled "March 3, 2 memories". Empty tiles are not
  buttons.
- **Viewers:** no create affordances in the grid, the same as the ribbon
  (`calendar.role-gating.test.tsx`).

**Mounting:** only the active view is mounted (List *or* grid), so the polls and
range fetches never run twice. Switching to Calendar opens the grid at the
month shown in the pinned label, and switching back to List keeps the current
`anchorDate`, so each view opens where the other left off without keeping
scroll state.

**B3. Tap a day** (tiles with ≥1 memory only) → `anchorDate = that day`,
view = List. The ribbon's "+ capture today" row is dropped (the FAB covers it).

**B4. Tests.** Unit: grid math (leading blanks, 4/5/6-row months, local dates
across DST). Component: tile states (single/many/text/audio/hidden/blocked).
Port `calendar.audio-stamp.test.tsx` → `memory-stamp` test and
`calendar.role-gating.test.tsx` → grid role gating. Maestro
`timeline/calendar-view.yaml`: switch → tap a day → that memory is first.

**B — as built (2026-09-29), deviations from the steps above:**
- The grid uses `fetchMemoriesInDateRange` itself, now paginated past 1000
  rows, rather than a separate `fetchMemoryStampsInDateRange`. The existing
  fetch was already light (`*` + media + preview tags, no engagement), so a
  second fetcher would only have duplicated it. The Calendar tab benefits too.
- The grid's month range comes from the month-picker options (month counts),
  not `useOldestMemoryDate`.
- The switcher is icon-only (List / CalendarDays from lucide, with
  accessibility labels). Labels didn't fit a 375pt bar next to the month
  label, Today, search and the bell.
- Tapping a day switches to List for the session but doesn't overwrite the
  saved view preference.
- Tests: `calendar.audio-stamp` / `calendar.role-gating` stay in place until
  C deletes the tab. Their grid equivalents live in `memory-stamp.test.tsx`
  and `calendar-month-grid.test.tsx`.

### Phase C — Keepsakes tab, remove Calendar tab

**C1. Tabs + removal checklist.** Ships as a JS-only EAS Update. The tab
icon uses `expo-symbols`, which is already in the native build. **Verify the
Material `redeem` glyph renders** on the current production Android build
before choosing it (the fallback glyph covers failure). Don't bundle this with
the uncommitted native-affecting Sentry/metro changes in the working tree. The
tab rename, `floating-tab-bar.test.tsx` and both Maestro flows land in **one
commit**.

- `_layout.tsx`: replace `calendar` with `keepsakes`
  (`app/(app)/(tabs)/keepsakes.tsx`). `TAB_META.keepsakes`: SF Symbol `gift`,
  Material `redeem`, and a fallback glyph.
- Delete `app/(app)/(tabs)/calendar.tsx` and the three
  `src/screen-tests/calendar.*.test.tsx` (already ported in A5 and B4).
- `floating-tab-bar.test.tsx` (hard-codes `calendar` / `tab-calendar` at
  ~L23, L51, L65, L67) → `keepsakes`.
- Maestro: `check-icons.yaml`; `sharing/viewer-readonly.yaml` L40–45 (taps
  "Calendar", asserts no FAB) → switch to the Timeline Calendar view and assert
  no FAB there.
- `NewMemorySource` `'fab_calendar'` (`src/lib/routes.ts` L12,
  `src/services/analytics.ts` L110): keep the union member for historical data,
  and stop emitting it.
- `src/utils/calendar.ts` ribbon-only helpers (week building, jump correction)
  are deleted along with their tests. Month options and labels stay.

**C2. One family-level books hook.** Replace per-child `useMemoryBooks`
instances with `useFamilyMemoryBooks(familyId)`: **one** `memory_books` query
for the family, **one** 4s poll (only while something is in progress **and** the
screen is focused), and per-child rows derived with `select` and
`buildMemoryBookScopeOptions(dob, todayIso)`. Shelf membership and shelf
contents then come from the same cache and can't disagree. Per-scope
**eligibility counts** and the example-cover query move into the create flow
and load when the sheet opens for a chosen child, not per shelf on render.
`todayIso` is passed in by the screen, recomputed on focus, and **included in
the eligibility query key**. `generate`/retry invalidate the family key.
`useMemoryBooks.integration.test.tsx` is ported.

**Who gets a shelf (interim rule):** a member with ≥1 book, **or** with
`date_of_birth` set and age < 13 (port `classifyChildOrAdult` to
`src/utils/age.ts`). Adults and members with no DOB get no shelf until they have
a book. The profile link (C5) still lets an owner create one for them, so
today's reach is preserved. Swap the age rule for the family-relationships
"own kids" signal when it lands, the same rule Year Film needs.

**C3. Shelf component split.** From `memory-books.tsx`, extract a presentational
`src/components/memory-books/child-book-shelf.tsx` (title + `BookCoverTile`
row + "first book" tile; tile press → callbacks). The **screen** owns the single
`CreateBookSheet`, `RetryBookSheet`, `BookToast` and bottom CTA. Offsets are
recomputed for a tab screen: `CTA_BOTTOM_CLEARANCE` and the toast
`bottomOffset` must clear the floating tab bar on Keepsakes, while the stack
route (C5) keeps today's values.

**C4. Keepsakes screen** (`keepsakes.tsx`):
- **Films section:** an empty slot until Year Film P2 (P2 adds upcoming-film
  cards).
- **Books section** (owner/manager only, see below): one `ChildBookShelf` per
  shelf member. A member with no books shows a compact "Create {name}'s first
  book" tile.
- **Empty state (no books anywhere):** the **one family pitch**, the existing
  copy with the headline generalized ("Your family's years, printed and
  bound."), bullets unchanged, CTA "Create a book". The CTA opens a **child
  picker** when >1 shelf member exists, then the create sheet; the picker is
  skipped for one child. With **zero** shelf members, the CTA routes to Family
  with a hint to add a birthday.
- **Viewers:** today viewers **cannot reach books at all**. The profile row is
  `canEdit`-only, per the 2026-09-15 owner decision (comment at
  `family/[id]/index.tsx` ~L354). Keep that: Keepsakes shows viewers films only
  (once P2 lands) and otherwise a short "Books and films your family makes will
  show up here." Opening books to viewers is a separate decision (RLS already
  allows select).

**C5. Child profile link.**
- New stack screen `app/(app)/keepsakes/[memberId].tsx` renders one shelf plus
  the screen-level sheets/CTA/toast (C3) with a back header. Register it in
  `app/(app)/_layout.tsx`, **remove** the `family/[id]/memory-books`
  `Stack.Screen` (~L175), and delete that file.
- `memoryBooksRoute(memberId)` in `src/lib/routes.ts` now returns
  `/(app)/keepsakes/${memberId}`. Update the `useNotifications.test.ts`
  assertions (~L158, L292, L306, L332). The push payload carries a route
  *kind* + ids (`supabase/functions/_shared/expo-push.ts`), so there's no server
  change, and old-JS devices keep resolving to their old route. **Verify** that
  a cold-start notification tap into `keepsakes/[memberId]` gets a working back
  button (no tab parent in history), the same way `useNotifications.ts`
  ~L237/L254 handles the existing route.
- The profile row "See {name}'s keepsakes" replaces the "Memory Books" row
  (`family/[id]/index.tsx` ~L361), with the same `canEdit` gate as today.

**C6. Analytics.** Add to `AnalyticsEventMap` (`src/services/analytics.ts`
~L58): `timeline_view_switched {view}`, `timeline_jumped {source:
'month_picker'|'calendar_day'|'today'}`, `keepsakes_opened`,
`keepsakes_create_book_tapped {children_count}`. Follow
`docs/plans/analytics-tracking.md`.

**C7. Docs.** `docs/features/calendar.md` (the grid view; the ribbon is noted as
superseded), new `docs/features/keepsakes.md`, `docs/features/README.md` index,
`memory-book-generation.md` (entry point), `memories.md` (anchored mode),
`app/AGENTS.md` L10 (tab list), root `AGENTS.md` (~L109, L267). PRD L409/L709
already say "month grid". Only the "tab" wording changes.

**C — as built (2026-09-29), deviations from the steps above:**
- **Shelf rule** uses `isOwnChild` (ported to `src/utils/family-relationships.ts`
  from the Edge helper) plus "has a book", not the interim DOB < 13 rule.
  The family-relationships work landed first (da58fa4), and this is the swap
  the rule anticipated.
- **One family query, lazy per-child flow:** shelves use `useFamilyMemoryBooks`
  with the shared pure `buildMemoryBookRows`. The existing `useMemoryBooks`
  wasn't rewritten. It now runs only inside `MemoryBookFlowHost` (mounted when
  a create/retry starts, for that child), takes `todayIso` from the caller
  (part of the eligibility key), and invalidates the family key after every
  write.
- **One shared body** (`MemoryBooksBody`, variants `tab`/`stack`) instead of a
  separate presentational `ChildBookShelf`. The tab and the one-child route
  render the same component.
- **Removed as dead code** with the tab: `useOldestMemoryDate` /
  `fetchOldestMemoryDate` and all the ribbon helpers in `src/utils/calendar.ts`
  (it keeps only two shared types).
- **Viewer route:** the one-child route still shows existing books
  read-only, as the old screen did (viewers can't reach it from the profile).
  The tab hides books from viewers.
- **Tab icon:** SF `gift` / `gift.fill`, Material `redeem`, fallback glyph ❖.
  Still verify `redeem` renders on the production Android build.
- **Not done:** removing `'fab_calendar'` from the analytics unions (kept for
  historical data, as planned); the Films section (Year Film P2).

**Follow-up — sticky control row (2026-09-29, owner request after device test):**
the pinned top bar (A4/B1) is replaced by one sticky row where "Recently" was:
the month label (the picker trigger), Today, and the List/Calendar switcher,
plus the weekday letters in Calendar view.
- Everything above the row (the title with search + bell, This week, Looking
  Back) scrolls away in both views. Only what's below the row switches.
- A jump (picker or day tap) hides the top content; Today brings it back.
- Implemented as one FlatList: `[control row, ...memories | ...months]`, with
  `stickyHeaderIndices` and the measured header feeding Calendar's
  `getItemLayout`. See memories.md, "Sticky control row + jump to a month".
- Device fixes, same day (Android):
  - The row is an overlay driven by the native scroll value, because touches
    never reached a native sticky header.
  - The month label reads the card under the row from geometry (viewability
    flickered between months).
  - Newer pages load 5 screens ahead, with no pull-to-refresh until the
    newest memory is loaded.
  - The top content returns once the anchored list reaches the newest memory.
  - Spacing is the same in both views.

### Phase D — Year Film plan alignment (docs now, code in Film P2)

Update `docs/plans/year-film.md` §8 (done in this change): films live in
Keepsakes; drop child-profile Films row and Timeline-overflow Films list;
"Print this year" opens Keepsakes' create-book flow preset to the age-year;
P2 scope row updated.

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Bidirectional list jumps when newer pages prepend | `maintainVisibleContentPosition`; fallback "Load newer" button if Android misbehaves (A3) |
| Anchored mode silently loses recovery/polling side effects | One hook with an optional anchor (A2), not a parallel hook |
| Tab screen never unmounts → stale "today" in book scopes, background polling | `todayIso` from caller, recomputed on focus; poll gated on focus (C3) |
| New memory missing from an anchored list | Deliberate (A2); "Back to today" always visible in anchored mode |
| Cache drift between anchored and normal lists | Anchored key lives under `memories` prefix, so patch/remove/invalidate cover it; short `gcTime` |
| Losing calendar function mid-rollout | Tab removed only in Phase C, after A+B ship |
| Grid thumbnails heavy on scroll | Preview keys (`resolvePreferredCoverKey`), windowed range fetch, FlatList windowing |
| Anchored refetch replays a newer cursor as an older one | Tagged page params + trim-to-anchor refresh (A2); integration test prepends then refetches |
| New memory invisible after jumping back | Anchor auto-clears on create, tab re-press, long background (A3) |
| N shelves × (poll + eligibility queries) on an always-mounted tab | One family books query and poll, focus-gated; eligibility on sheet open (C2) |
| Wrong kids get shelves (nieces) | Interim <13 rule + "has a book" + profile link; replaced by family-relationships signal |
| Keepsakes feels empty for viewers | Viewer-specific empty state; films fill it once P2 lands. Books stay owner/manager (09-15 decision) |
| Year Film P2 deadline (~Dec 5) now depends on Keepsakes | Phase C scheduled before P2; Films section is a slot, not a dependency |

## 6. Out of scope

- Films UI itself (Year Film P2).
- Looking Back changes.
- Shareable book links for non-members, and showing books to viewers.
- A date scrubber / fast-scroll handle on the Timeline (possible later).
- The family-relationships "own kids" model (separate plan).
