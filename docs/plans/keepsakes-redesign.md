# Keepsakes tab redesign

Status: plan (hardening). Approved design: Claude Design project
`e0789273-3b61-4dd3-90c5-fe47eaf8d9fa`, file **"Keepsakes Redesign v3.dc.html"**
(https://claude.ai/design/p/e0789273-3b61-4dd3-90c5-fe47eaf8d9fa?file=Keepsakes+Redesign+v3.dc.html).

## Goal

Replace today's Keepsakes tab with the approved v3 layout:

1. A slim **"needs you"** line, shown only when an action is waiting.
2. A **"Make something"** storefront row with native product pages.
3. **"Your keepsakes"**: a library with one shelf per year. It has its own filter, child chips and status badges, and past years fold.

Viewers get **"Family films"**: films only. Nothing priced appears anywhere in the app.

## Owner decisions this plan must honor

- **Roles:** viewers see films only. Owners and managers see everything.
- **Privacy cue:**
  - The line "Books and cards are only visible to owners and managers." sits under "Your keepsakes", and **only when the family has at least one viewer**.
  - Product pages carry "Viewers in your family won't see this {card|book}. Your surprise is safe." (also only when there are viewers).
- **Needs-you banner:**
  - One slim line, only when the user must act. Not dismissable; it clears itself once handled.
  - Examples: "Your holiday card is ready to order", "{Name}'s book couldn't be made".
- **Badges** go on items. Raspberry means waiting on you; lavender means progress.
  - "Being made", "Ready to order", "Ordered", "Shipped · {date}", "Couldn't be made".
  - Delivered items and finished films carry no badge. There is no "New" badge.
- **Storefront:**
  - A horizontal row of neutral product cards. Each card opens its own native product page. No FAB, no drawer, no "Soon" teasers.
  - Holiday cards appear only in season (the existing server switch). In season they lead the row with a wider card and an "Order by Dec 10 for Christmas" pill.
  - Cards use the family's own illustration ("Your card could look like this, with a letter from your year.").
- **No prices in the app.**
  - Product pages carry a "Free to make" block: "Making your {card|book} is included with Momora Plus. Look it over, change anything, and only pay if you decide to print."
  - Avoid the word "generate" in UI copy.
  - Prices stay in the shop, so changing them needs no app update.
- **Library:**
  - One shelf per year, as a horizontal row on a shared baseline. Objects are type-specific:
    - film poster
    - book hardcover (the existing `BookCoverTile`)
    - card front with an envelope peeking out behind it
  - Tilt is at most ±1.5°, with one soft shadow and no tape.
  - The current year is always open. Past years are folded rows ("2024 · 7 keepsakes ˅") that **open in place** when tapped; tapping the year header folds them again.
  - Child chips plus a filter button **attached to the "Your keepsakes" header**. The filter is a sheet with Type (All / Films / Books / Holiday cards) and Year.
- **Next-up recap tile:**
  - It sits at the start of the current year's shelf.
  - Before the minimum: a dashed tile with a progress bar and "{N} more moments this month". Behind it is the **newest moment this month that has a picture** (a ready illustration, an image, or a video poster), faded. Newest is chosen deliberately, so it changes as the month fills.
  - A flat tile only when no moment this month has a picture yet (text-only or audio, or illustrations still being made or failed).
  - After the minimum: a solid tile with a faded picture and "arrives {Nov 1}" in Caveat. Caption: "{Month} recap · arrives Nov 1 · 23 moments so far".
- **Memory Book product page:**
  - Pick the child (chips) and the period. The **two newest periods** show; the rest fold under "See {N} more". A period that already has a book says so.
  - An eligibility line and the "Free to make" block. No price.
- **Viewer page:**
  - Title "Family films". No storefront, no "Your keepsakes" wording, no banner, no order badges.
  - Next-up recap tiles still show. The filter sits in the page header.

## Context (current code, verified)

### Tab screen and body

- **`app/(app)/(tabs)/keepsakes.tsx`:**
  - Header: eyebrow "Keepsakes" and title "Made from your moments.", `testID="keepsakes-header"`.
  - Then `<KeepsakesBody variant="tab" isFocused todayIso />`.
  - `useFocusEffect` fires `trackEvent('keepsakes_opened')`.
- **`src/components/memory-books/memory-books-body.tsx`** (`KeepsakesBody`, about 850 lines).
  - Tab render order (`renderTab`):
    1. `HolidayCardTile`
    2. `KeepsakeYearSection` per year: a "Family films" block, then per-child shelves, plus a first-book tile through `renderShelfExtra`
    3. A pitch block when empty
  - Plus a floating "Create a book" FAB (`memory-books-create`), `ChildPickerSheet`, `MemoryBookFlowHost` (`CreateBookSheet`, `RetryBookSheet`) and `BookToast`.
  - Role: `canGenerate = canEditFamilyContent(role)` (`src/utils/roles.ts`). Viewers get `familyId: null` for the books query.
  - The `variant="stack"` path backs `app/(app)/keepsakes/[memberId].tsx` (one child's keepsakes, reached from the child profile and the `memory-book` push).
- **`src/components/keepsakes/`:**
  - `keepsake-year-section.tsx`
  - `keepsake-film-tile.tsx`: uses `FilmCover` from `src/components/year-films/film-cover.tsx` (9:16, self-signing poster via `useYearFilmPosters`).
  - `upcoming-recap-card.tsx`: "October recap · Nov 1", no progress.
  - `holiday-card-tile.tsx`: `holidayCardTileState()` → `make|generating|ready|failed|ordered|null`; tap opens `HolidayGreetingSheet` or `openShopUrl(holidayCardWebUrl(id))`.
  - `holiday-greeting-sheet.tsx`
- **`src/components/memory-books/`:**
  - `book-cover-tile.tsx`: ready/generating/failed, with washes.
  - `create-book-sheet.tsx`: suggestions plus "More options"; thin state at `MEMORY_BOOK_THIN_THRESHOLD = 30` with gallery import.
  - `child-picker-sheet.tsx`, `retry-book-sheet.tsx`, `book-toast.tsx`.

### Data

- **Year grouping:** `buildKeepsakeYears` in `src/utils/year-films.ts`. Films are filed by `placement_date` year, books by `scope_end_date` (falling back to `created_at`).
- **Films:**
  - `fetchFamilyYearFilms` / `useFamilyYearFilms` (`src/services/year-films.ts`, `src/hooks/useYearFilms.ts`). Kinds: `birthday|family_month|family_year`.
  - `filmDisplayState` handles hidden/remaking/updating.
  - `useYearFilmsEnabled` → RPC `year_films_enabled`. It returns false until the current month already has 10 memories, so today's upcoming card never shows progress below the floor.
- **Books:**
  - `useFamilyMemoryBooks` (family-wide, 4 s polling while generating).
  - `useMemoryBooks` (per child): `generate`, `retryDispatch`, eligibility via `countEligibleMemoriesForScope`.
  - Scope builders in `src/utils/memory-book-scope.ts` (`age_year|calendar_year|everything`); `pickSuggestedScopes`; `buildMemoryBookRows`.
- **Holiday card:** `useHolidayCard` → RPC `holiday_card_summary` (owner/manager only; `enabled` already reflects the season switch and billing).
  - `holiday_card_settings` (service-role only) holds `ship_by_note` and `closes_on`.
- **Orders:**
  - `memory_book_orders` RLS is `requested_by = auth.uid()` only. The app never reads it.
  - `holiday_card_orders` has `shipped_at`; `memory_book_orders` has no `shipped_at`.
  - Book order statuses: `draft|quoted|paid|rendering|submitted|in_production|shipped|delivered|failed|cancelled`.
- **Monthly film floors:** `supabase/functions/_shared/year-film-eligibility.ts`.
  - `MONTHLY_MIN_POOL = 10`, `MONTHLY_MIN_VISUALS = 6`.
  - A visual is a ready illustration, an image, or a video of at least 2 s. Audio isn't one.
  - The pool is the month's memories minus open reports (`year-film-context.ts` L158-205).
  - Owner-local month logic: `year_films_enabled` in `20260930120000_year_films_p2.sql` L601-662 (`year_film_owner_tz`, `year_film_family_enabled`, `launch_date`, `billing_write_allowed`, `year_film_is_own_child`).
- **Picture fields:**
  - `memories.memory_type` (`text_illustration|text_only|media|audio`), `illustration_status`, `illustration_key`.
  - `memory_media` (`object_key`, `preview_object_key`, `content_type`, `duration_ms`, `position`).
  - Signed via `useMediaUrl` / `get-media-url`. Key resolvers live in `src/utils/media-preview.ts`; reference usage is `src/components/memory-stamp.tsx`.
- **Shop handoff:** `openShopUrl` (`src/services/web-handoff.ts`), `memoryBookWebUrl`, `holidayCardWebUrl`.

### Other facts

- **i18n:** none. English strings live in components. That's fine.
- **Theme:** `src/constants/theme.ts` (`colors`, `fonts.display|sans|script`, `radius`, `spacing`).
- **Tests:**
  - `src/screen-tests/keepsakes.integration.test.tsx` (today pinned to 2026-10-15)
  - `src/components/keepsakes/*.test.tsx`
  - Maestro: `.maestro/flows/keepsakes/open-keepsakes.yaml` (asserts "Made from your moments.", taps `memory-books-create`), `.maestro/flows/year-film/open-from-keepsakes.yaml`, `.maestro/flows/sharing/viewer-readonly.yaml` L54-61.

## Steps

### Phase A: server (one migration, deployed before the app)

**A1. Migration `supabase/migrations/20261009120000_keepsakes_overview.sql`.**

`public.keepsakes_overview(p_family_id uuid) returns jsonb`: `stable security definer set search_path = ''`, grant execute to authenticated, revoke from public/anon.

- **Auth:** like `year_films_enabled` (reject anonymous and non-members with 42501). Compute `v_can_edit := public.has_family_role(p_family_id, array['owner','manager'])`. That's the existing helper; there is no `is_family_editor`.
- **The pool must mirror the worker exactly.** That means `year-film-context.ts` `mapFamilyRows` (L156-205), the SQL row loader in `workflow-year-film-bridge/rows.ts` (L105-131), and `year-film-eligibility.ts` (`visualKind`, `hasVideoClip`). A pooled memory is one in the window that is:
  - not under an open or reviewing `content_reports` row targeting the memory;
  - not `onboarding_media_pending`, using **the boolean alone**, exactly like the worker (no `_until` rule);
  - not authored by a user in `year_film_parent_blocked_users(p_family_id)`.
- **Visuals:** a pooled memory is a **visual** per `visualKind`.
  - An `audio`-typed memory is **never** a visual, even with an illustration; `visualKind` returns null first for audio.
  - Otherwise, a visual is one of:
    - a ready illustration with no open or reviewing `memory_illustration` report
    - an image (a `memory_media` image, or a **legacy** `media_key` image with no `memory_media` rows)
    - a video clip (`duration_ms is null or >= 2000`)
- **Picture key:** consistent with the visual. It's the key of the asset that made the memory visual:
  - illustration → `illustration_key`
  - image → `preview_object_key ?? object_key` (or legacy `media_key`)
  - video → its poster `preview_object_key`

  A visual memory whose asset has **no resolvable key** (e.g. a legacy video with no poster) is skipped for the picture; it's never a null that hides older pictures.
- **Helper:** write a SQL helper `public.keepsake_pool(p_family_id, p_start, p_end_excl)` returning per-memory rows (id, memory_date, created_at, `is_visual`, `picture_key`) so the counts and the picture share one definition.
  - It is **internal**: `security definer` + `set search_path = ''`, with `revoke all ... from public, anon, authenticated` and no grant, exactly like `year_film_parent_blocked_users`. It's only callable from `keepsakes_overview`.
  - pgTAP asserts `authenticated` cannot execute it.
  - The caller's personal-block filter is applied in the outer function.
  - Use the existing `(family_id, memory_date desc, created_at desc)` index (`20260715130000_memories_pagination_index.sql`).
- Add a code comment in both `year-film-eligibility.ts` and the migration pointing at each other.
- **Performance:** compute `year_film_owner_tz(p_family_id)` **once** per call. Bound every scan by date:
  - month for the recap
  - calendar year for `year_moments` / `holiday_pool`
  - **a 1-year lookback with `limit 1`** for `preview_key` / `book_preview_keys`, ordered by the index, using a lateral `limit 1` rather than computing a whole pool and taking the max
- **`recap`** (all members): null unless the family passes the same gates as `year_films_enabled` **except** the ≥10 check:
  - `year_film_family_enabled`
  - `launch_date <= next first`
  - `billing_write_allowed`
  - an own child with a date of birth

  Otherwise it returns:
  - `month_start` and `delivers_on` (the next 1st), both owner-local. The app displays the month from `month_start`, **never from the device `todayIso`**.
  - `moments` and `visuals` (counts over the pool)
  - `min_moments` 10, `min_visuals` 6
  - `picture`: `{ key }`, the newest pooled memory with a picture (`memory_date desc, created_at desc`). The key rule mirrors `memory-stamp.tsx`:
    - a ready, unreported illustration → `illustration_key`
    - an image → the first-position image's `preview_object_key ?? object_key`, or the legacy `media_key`
    - a video → its poster/preview key (`resolveVideoPosterKey` rule)
    - null when none

    Memories by authors **the caller** has blocked are excluded from the picture: use the same personal-block source the timeline uses (find it, e.g. a `user_blocks` table or helper).
- **`preview_key`** (owner/manager only): the newest picture key across the whole family, with the same exclusions as the picture. It feeds the storefront card and the card product page, and replaces any client-side preview query.
- **`book_preview_keys`** (owner/manager only): `{ [childId]: key }` for each own child. It's the newest picture among memories tagged to that child, same exclusions. It **replaces `fetchExampleCoverAssetKey`** on the storefront and the book product page. That query is unfiltered against reports and blocks, so it could resurface a reported photo. The stack path keeps its existing query.
- **`has_viewers`** (owner/manager only, else null): any live membership in the family with role `viewer`.
- **`year_moments`** (owner/manager only): the pooled count for the current owner-local calendar year.
- **`holiday_pool`** (owner/manager only): the count for the current owner-local year using the worker's **holiday** pool. That's the `holidayPool` rules in `year-film-eligibility.ts` (L294-330): the monthly pool minus share-sensitive memories and worried/sad/weary emotions. Also `holiday_min_pool` = 20 (`HOLIDAY_MIN_POOL`). The card page uses it to decide whether to promise the QR film.
- **`holiday_ship_by_note`** (owner/manager only): `holiday_card_settings.ship_by_note` when `holiday_card_family_enabled(p_family_id)`, else null.
- **`orders`** (owner/manager only, else `[]`): per item, the single latest row **among paid-or-later rows**, ordered by `created_at desc, id desc`. A newer draft or checkout for a reorder never displaces a shipped row, because drafts aren't in the set.
  - **`memory_book_orders`:** status in `paid|rendering|submitted|in_production|shipped|delivered` **and `refunded_at is null`** → `{product:'book', item_id: book_id, status}`.
  - **`holiday_card_orders`:** status in `paid|submitted|in_production|shipped` (that table has `checkout` but no `delivered`), `card_id is not null`, `refunded_at is null` → `{product:'card', item_id: card_id, status, shipped_at}`.
  - A paid order that later went `failed` (or was refunded) drops out, so its item falls back to its unordered badge. This matches `holiday_card_summary.ordered`; documented, not explained in UI.

  This is family-wide for owners and managers on purpose: the shelf shows family keepsakes, whoever paid. It returns status only, never addresses or prices.

Also: a matching rollback in `supabase/rollbacks/` (drop both functions), and a pgTAP test `supabase/tests/keepsakes_overview_test.sql` covering:
- the auth rejects (anonymous, non-member)
- a viewer gets `recap` but null `has_viewers`, `year_moments`, `holiday_pool`, `ship_by_note`, `preview_key` and `book_preview_keys`, and empty `orders`
- `keepsake_pool` is not executable by `authenticated`
- the holiday pool excludes share-sensitive and sad/worried/weary memories
- orders: refunded rows are excluded; a null `card_id` is skipped; a later draft doesn't displace a shipped row
- an audio memory with an illustration is not a visual; a legacy video without a poster is skipped for the picture
- pool exclusions: a reported memory, an onboarding-pending memory, a blocked author
- a reported illustration counts as a moment but not as a visual or picture
- a NULL-duration video counts as a visual
- a legacy `media_key` image counts as a visual
- audio counts as a moment only
- the newest-picture choice (a later text-only memory doesn't win)
- a null picture when only text/audio memories exist
- orders: draft/quoted/checkout/cancelled/failed are ignored; the latest per item wins

Make the test **date-independent**: insert memories relative to the owner-local `now()` month. This repo has had date-fragile pgTAP before (see `679e048`).

**A2. `src/types/database.ts`.** The RPC doesn't exist on the linked database until the owner runs `db push`, and Docker is often down.
- Now: **hand-add** the `keepsakes_overview` function signature (`Args: { p_family_id: string }; Returns: Json`) in the generator's exact shape.
- After the push: regenerate, and confirm the diff is only this.

Document the RPC in `docs/TECH_SPEC.md` next to the holiday-card RPC section (around L1220).

### Phase B: app data layer

**B1. `src/services/keepsakes.ts`**
- `fetchKeepsakesOverview(familyId)` → typed `KeepsakesOverview` (parse defensively: unknown or missing fields → null or empty). There's no separate client preview query: `preview_key` comes from the RPC.

**B2. `src/hooks/useKeepsakesOverview.ts`**
- A TanStack query using a new `keepsakesOverviewQueryKey(familyId)` added to `src/hooks/queryKeys.ts` (the repo convention).
  - **`staleTime: 30_000`**, with a refetch on screen focus when stale. The app's AppState `focusManager` (`app-providers.tsx`) also refetches on returning from the browser, which is how order badges update after paying on the web.
  - No polling.
- An RPC error yields `overview: null`; the UI degrades and never crashes.
- **Invalidate it** after any of these:
  - `useHolidayCard.create`
  - `useMemoryBooks.generate` / `retryDispatch`
  - memory create/delete/edit
  - reporting a memory or an illustration
  - blocking a user

  Find the existing mutation hooks for each and add the key to their invalidation lists. Push handlers are module-level functions without a `queryClient`, so they're **not** invalidation points; the focus refetch covers them.

**B3. Pure helpers in `src/utils/keepsakes.ts`, unit-tested in `src/utils/keepsakes.test.ts`:**
- **Books are deduplicated first.**
  - Before anything else, run books through the existing per-child row logic (`buildMemoryBookScopeOptions` + `buildMemoryBookRows` / `pickRelevantBook`, as `memory-books-body.tsx` does with `bookRowsById`).
  - Only each scope's *relevant* book becomes a shelf item or banner candidate. A retry creates a fresh row and the old failed row stays as history, so raw rows would resurface a superseded failure forever.
  - Unit test: a failed book then a ready book of the same scope gives one tile and no banner.
- `buildShelfItems({ films, bookRows, cardState, overview, members, role })` → per-year arrays of `ShelfItem` (`kind: 'upcoming-recap'|'film'|'book'|'card'`).
  - Each item has `date`, `memberId|null`, `year`, `badge|null`.
  - Upcoming items come first in the current year, then the rest by date desc.
  - Reuse `filmDisplayState` (hidden films dropped).
  - **Card:** the card is on a shelf only while `holidayCardTileState(summary, todayIso)` is non-null and not `make`. `holiday_card_summary` returns only the newest card, so the card appears from creation until Jan 31 when ordered, as today. Its year is `summary.year`; its date is Dec 1 of that year, for ordering. A card history on past-year shelves is out of scope (documented).
  - **Move `holidayCardTileState`** (and its `COPY` keys that are still needed) from `holiday-card-tile.tsx` into `src/utils/holiday-card-state.ts`, so it survives the tile's removal. Keep its tests.
- **Badge mapping:**
  - **Book** (relevant row): queued/generating → "Being made" (progress); failed → "Couldn't be made" (needs-you). Ready plus an order: paid|rendering|submitted|in_production → "Ordered"; shipped → "Shipped" (no date: `memory_book_orders` has no `shipped_at`); delivered → none.
  - **Card** (`holidayCardTileState`): generating → "Being made"; ready → "Ready to order" (needs-you); failed → "Couldn't be made" (needs-you).
    - Ordered is driven by `summary.ordered`, the same source the state function uses. Then, when the card's order status is `shipped`: "Shipped · {MMM d of shipped_at}". Shipped is terminal for cards, since there's no `delivered`. Otherwise "Ordered".
  - **Films:** none, except the remaking/updating handling inside `KeepsakeFilmTile` (see C1).
- **`pickNeedsYou(...)`:** at most one banner. Priority: card ready → card failed → the most recently updated failed **relevant** book. It returns `{ kind, label, target }`.
  - **Card banners** show only while `summary.enabled`, so they stop when the season closes. "Ready" therefore nags at most until `closes_on`.
  - **Failed-book banners** show only when the failure is less than 30 days old (`updated_at`). After that it's just the badge on the shelf, so an abandoned book doesn't nag forever. There's no book delete path in the app.
- **`applyKeepsakesFilter(items, { memberId|null, type, year })`:**
  - A child chip keeps only items with that `memberId` (books, birthday films). Family-wide items (recaps, year-end, card, upcoming recap) show only under "All".
  - Type filters by kind (upcoming recap counts as Films).
  - Year shows only that year, forced open.
- `yearSummaryLabel(items, role)`: "14 keepsakes" for owners and managers, "12 films" for viewers.
- `splitScopeOptions(options, rows, todayIso)` for the book page → `{ visible, more }`.
  - **`visible`** = the two newest **completed** age-year options (`endDate < todayIso`), **including ones that already have a book**, labeled with their row status ("already made", "being made"). If fewer than 2 exist, fill with Everything.
  - Calendar years and in-progress periods never land in `visible`: claiming them mid-period locks the window, the existing rule behind `pickSuggestedScopes`.
  - **`more`** = everything else, grouped exactly like `CreateBookSheet`'s "More options": Years of life (including the in-progress year, with its caution copy), Calendar years (with the mid-year caution), Everything (if not in `visible`).
  - **Default selection:** the first `visible` option without a book, else the first `visible` option.
  - Unit tests:
    - a newborn: `visible` = [Everything]; "Year one so far" sits under more
    - a 1-year-old: [Year one, Everything]
    - a 6-year-old with Year five and Year four already made: both visible, labeled "already made", default = Everything in `more`, or the first available
    - the current calendar year never in `visible`

### Phase C: UI components (all new files under `src/components/keepsakes/`)

**C1. Shelf objects. Shared baseline:** a row container of fixed height 166 with `alignItems: 'flex-end'`, a caption block under each (title, meta, optional badge).
- **Film poster:** extend `KeepsakeFilmTile` rather than writing a new tile, so its `filmDisplayState` branches survive.
  - remaking → non-pressable `RemakingPlaceholder` with testID `keepsakes-film-{id}-remaking`
  - updating → playable plus an "Updating…" badge
  - Add a `variant: 'shelf'` that renders `FilmCover` at `width 110, height 162`. `FilmCoverProps` already has `height`/`radius`, so FilmCover needs no change.
  - The shelf overlay: the month name in Newsreader, a play glyph and the duration.
  - The caption moves under the object.
  - Press → `yearFilmRoute(id,'keepsakes')`. Keep `testID keepsakes-film-{id}`; Maestro relies on it.
- **Book:** reuse `BookCoverTile` at 146×146 (status/washes intact) inside a pressable that keeps today's `handleTilePress` semantics: ready → shop, failed → retry sheet, generating → disabled.
- **`shelf-holiday-card.tsx`:**
  - The card front: a white frame with an image of the family preview illustration, "Happy holidays" in Newsreader and the family line. Rotated −1.5°.
  - An envelope behind it (a light kraft rect with a flap triangle, rotated +1.5°, peeking top-right).
  - Press → `openShopUrl(holidayCardWebUrl(cardId))`, or the greeting sheet in the `make` state. In practice `make` never appears on the shelf: no card means no shelf item.
- **"All {year} recaps" tile:** when a year has more than 3 monthly recaps, the row ends with a small text tile that opens `keepsakeRecapsRoute(year)`. This keeps the existing recaps grid route, its "Recaps grid" tests and the `year_film_recaps_opened` analytics alive. The row still shows every item; the grid is the tidy view.
- **`upcoming-recap-tile.tsx`** (replaces `upcoming-recap-card.tsx` in the tab):
  - **Locked** (`moments < min || visuals < min_visuals`): dashed border, the faded picture (`useMediaUrl(picture.key)` at opacity 0.3 over `colors.surface`; no picture → flat `colors.surface`), the title "{Month} recap", a progress bar (`moments/min_moments`, capped at 1), and a hint. The hint reads:
    - "{min-moments} more moments this month", or
    - when moments ≥ 10 but visuals < 6: "{n} more with a picture"
  - Caption: "{Month} recap" / "{moments} of 10 moments".
  - **Unlocked:** solid border, the faded picture, "arrives" plus the date in `fonts.script`. Caption: "{Month} recap" / "arrives {Mon d} · {moments} moments so far".
  - The month name and dates come from `overview.recap.month_start` / `delivers_on`, which are owner-local.
  - **Placement:** the tile sits on the shelf of `month_start`'s year, and that year's section is forced open, so it never lands in a folded or wrong year when the device and owner time zones straddle New Year.
  - **Known gap, documented and accepted:** from 00:00 to about 19:00 on the 1st, the tile restarts for the new month (0 of 10) before the previous month's film surfaces. `year_films_enabled` has the same gap today.
- **`keepsake-badge.tsx`:** a pill with a dot. Variants `needsYou` (primaryTint/primaryDark) and `progress` (surface2/ink2).

**C2. `keepsakes-library.tsx` ("Your keepsakes" section)**
- **Header row:** eyebrow "YOUR KEEPSAKES" on the left; on the right, a filter button with an active-count dot. There's no shared IconButton, so use an inline Pressable like `smallIconButton` in `portrait-timeline.tsx`. For owners and managers only; viewers get the filter in the page header instead. Hidden when the library has no items besides an upcoming recap.
- **Filter state:** child, type and year live in the tab component (D1/D2), not the library, so the viewer's header button and the owner's section button drive the same state and sheet.
  - The filter and the open-years set **reset when `familyId` changes**. The tab never unmounts, and switching families is real.
  - A selection whose child or year no longer exists in the items is dropped.
  - When a filter yields nothing, show "Nothing matches this filter" plus a "Reset" button (`keepsakes-filter-empty`).
- **Privacy line:** when `overview.has_viewers`.
- **Child chips:** "All" plus each own child or member with items; hidden when there are fewer than 2.
- **Year sections:**
  - The current year is always open: `year` (Newsreader 24) plus a count, then a horizontal `ScrollView` of shelf items.
  - Past years render as a folded row "{year} · {summary}" with a chevron; tap toggles. State is local (`useState<Set<number>>`), and an open past year shows a fold chevron on its header.
- **Empty library** (owner, no items, recap null): the line "Films show up here on their own. Your first one is on its way."
- **Viewer with no films:** keep the existing `keepsakes-viewer-empty` testID and its copy.
- **Any populated library**, including a viewer with only past-year films, renders `keepsakes-library`. Maestro `viewer-readonly.yaml` waits for `keepsakes-viewer-empty|keepsakes-library`.
- **Loading and error:**
  - Show a spinner until members, films and (owner) books have loaded.
  - Render the storefront and banner only once `useHolidayCard` has settled, so the in-season card doesn't pop in and shift the row.
  - If films or books fail, show an inline error row with "Try again" (`keepsakes-error`) that refetches.
  - If the overview fails, degrade silently: no upcoming tile, no order badges, no privacy line.
- testIDs: `keepsakes-library`, `keepsakes-year-{year}`, `keepsakes-year-toggle-{year}`, `keepsakes-chip-{memberId|all}`, `keepsakes-filter-button`.

**C3. `keepsakes-filter-sheet.tsx`**
- A bottom sheet with Type chips and Year chips (from the years that have items), "Reset" and "Show {n} keepsakes". There's no shared sheet primitive: copy the `Modal` + pan-to-dismiss pattern from `create-book-sheet.tsx`, using `getBottomSheetBottomPadding` / `shouldDismissBottomSheet` from `@/utils/bottom-sheet-dismiss`.
- Viewers get the Year section only, since films are their only type.
- **Keyboard:** no inputs.

**C4. `needs-you-banner.tsx`**
- Slim single line (height 46, primaryTint, primarySoft border, dot, label, chevron); `testID keepsakes-needs-you`.
- Card targets → shop; failed book → open `RetryBookSheet` for that child through the existing `MemoryBookFlowHost` mechanism.

**C5. `make-something-row.tsx` (storefront)**
- A horizontal row of product cards; `testID keepsakes-store-{product}`.
- **Holiday cards:** only when `holidaySummary?.enabled`. In season it comes first, at width 236.
  - It shows the card object with `overview.preview_key` (a wash when null), the title, and the subtitle "Your card could look like this, with a letter from your year."
  - A pill shows `overview.holiday_ship_by_note` verbatim (today: "Order by Dec 10 for Christmas delivery in the US."), allowed to wrap. Hide the pill when null.
- **Memory Book:** always for owners and managers, width 168.
  - It shows the `BookCoverTile` (ready look) with `overview.book_preview_keys[firstOwnChildId]`, or a wash.
  - Title "Memory Book"; subtitle "A year of one child, printed and bound."
- Tap → `router.push(keepsakeProductRoute(product))`; `trackEvent('keepsakes_product_opened', {product})`.

**C6. Product registry: `src/constants/keepsake-products.ts`**
- An array of `{ id: 'holiday-card'|'memory-book', isAvailable(ctx), route }` that the storefront maps over, so future products are one entry plus a page.
- Document this in the feature doc's extension guide.

### Phase D: screens and routes

**D1. Tab screen `app/(app)/(tabs)/keepsakes.tsx`:** it renders the new `KeepsakesTab` component (D2). The **page header moves into `KeepsakesTab`**, so the viewer's header filter button shares state with the sheet.
- Header: title "Keepsakes" for owners and managers, "Family films" for viewers (Newsreader 32; `testID keepsakes-header` kept). Viewers get the filter button in the header row.
- Keep `useFocusEffect`, `keepsakes_opened` and `todayIso` in the screen and pass them down.

**D2. New `src/components/keepsakes/keepsakes-tab.tsx`**
- It replaces `KeepsakesBody variant="tab"` on the tab. `memory-books-body.tsx`'s `variant="tab"` branch (`renderTab`, the FAB) is deleted. `KeepsakesBody` keeps only the stack path for `/keepsakes/[memberId]`, which is unchanged.
- **Owns:**
  - `useFamily`, `useFamilyMembers`, `useFamilyMemoryBooks`, `useFamilyYearFilms`, `useKeepsakesOverview`
  - `useHolidayCard`: **called once here**, along with the focus-refetch effect that `HolidayCardTile` used to own
  - the filter state
  - the year-open state
  - a retry host for failed books
  - the toast
- **Order:** header, needs-you banner, storefront (owner/manager), library.
- **Retry host:** export `MemoryBookFlowHost` from `memory-books-body.tsx`, or move it to its own file, and use it for the banner and shelf "Couldn't be made" retry. It mounts `useMemoryBooks` for one child and renders `RetryBookSheet`.
- **Toast:** a tiny module store, `src/lib/keepsakes-toast.ts`, with `setPendingKeepsakesToast(text)` and `consumePendingKeepsakesToast()`. It's not a route param: the tab never unmounts, so a param could re-show. `KeepsakesTab` consumes it on focus and shows `BookToast`.
- **Dead code, delete** once `tsc` and grep confirm no remaining use:
  - `HolidayCardTile` (its state function moved, see B3)
  - `UpcomingRecapCard`
  - the tab-only pitch / films-intro branch
  - `useYearFilmsEnabled` + `fetchYearFilmsEnabled` app-side (the RPC stays)
  - `ChildPickerSheet` (only reachable with more than 1 shelf, which the one-child stack path never has)
  - `KeepsakeYearSection` **if** the stack path doesn't use it; check before deleting

  Delete their tests with them, and keep the `holidayCardTileState` tests (moved).

**D3. Product page: `app/(app)/keepsakes/holiday-card.tsx`**
- Layout:
  - back button
  - the stage (card object, large)
  - eyebrow "HOLIDAY CARDS · {year}", title "Your family, on this year's card.", body
  - the "Free to make" block
  - the eligibility line "Your {year} has {year_moments} moments, plenty for the letter."
  - the privacy note (if `has_viewers`)
  - facts: "5×7, printed on both sides. Shipped to your door." / "Scan the back to watch a short film made for this card." / "One card per family each year. Order more copies anytime."
  - the ship-by pill
  - a fixed bottom CTA bar
- **Eligibility and the QR promise.** `holiday-cards` create has **no** floor; below the holiday film floor the card ships **without a QR film**. So the page uses `overview.holiday_pool` against `holiday_min_pool` (20):
  - At or above the floor: the line "Your {year} has {year_moments} moments, plenty for the letter.", plus the fact "Scan the back to watch a short film made for this card."
  - Below the floor: "Your {year} has {year_moments} moments so far." The QR fact becomes "Add a few more moments and the back links to a short film of your year."
  - Overview null: show no eligibility line and no QR fact.
- **CTA by state.** The state comes from `holidayCardTileState(summary, todayIso)`, **not** `cardId !== null`. The summary returns the newest card of any year; a never-ordered previous-year card maps to `make` or null.
  - `make` → "Make our {year} card" → `HolidayGreetingSheet` → `create` (existing). The sheet already handles `slot_used`/existing-card confirmations inline. Navigation:
    - Wrap `onCreate` to set a `createdRef` when the outcome is a **new** card.
    - `onClose` fires on every dismissal (cancel, backdrop, error Close, Continue), so it calls `leave()` **only when `createdRef` is true**. A refused create (`subscription_required`, disabled) keeps the user on the page and the sheet shows why.
    - The existing card's Continue opens the shop and leaves the page as is.
    - `leave()` waits for the Modal to finish dismissing (`Modal onDismiss` on iOS, or a short timeout on Android). Popping the stack in the same tick can leave an `overFullScreen` modal stuck.
    - It then calls `router.canGoBack() ? router.back() : router.replace(<keepsakes tab route>)`: a cold-start deep link has no history.
  - `generating|ready|failed|ordered` → "Open your card" → `openShopUrl(holidayCardWebUrl(cardId))`.
  - **Null state:** the page latches the state computed when it **first** settles. A first-load null (out of season, no billing, viewer, deep link) → `leave()`. A state that turns null **later**, e.g. while the sheet shows a refused create, never auto-leaves.
- testIDs: `keepsakes-product-holiday-card`, `holiday-card-product-cta`.

**D4. Product page: `app/(app)/keepsakes/memory-book.tsx` (`?memberId=` optional)**
- Layout: back button, the stage (`BookCoverTile` 200 with `overview.book_preview_keys[childId]`, or a wash), eyebrow, title "A year of {name}, printed and bound.", body, the "Free to make" block.
- **"Who it's for":** chips for own children (the same eligibility as today's shelves: `isOwnChild` or has books).
- **"Which part of {name}'s story":** use the name to avoid guessing pronouns.
  - Options come from `splitScopeOptions` (B3): the 2 `visible` options, newest first, then "See {N} more", which expands the grouped `more` list in place.
  - Each option shows its label and range. Already-made options say "already made" (from `buildMemoryBookRows` statuses).
- **Eligibility line** for the selected option (the counts already exposed by `useMemoryBooks`):
  - "{N} moments in this period." Don't invent page counts.
  - Thin periods (below `MEMORY_BOOK_THIN_THRESHOLD`) are **warned, not blocked**, matching `create-book-sheet.tsx` where `thin` rows stay tappable. Show "Not many moments yet" plus the gallery-import action (reuse the same `onImportPhotos` wiring the stack path passes to `CreateBookSheet`).
- The privacy note (if `has_viewers`) and facts.
- **Per-child hook instance.** The scope-dependent part of the page lives in a child component **keyed by child id** (`<BookScopePicker key={memberId} …/>`), which calls `useMemoryBooks(memberId)`. Its `pendingKeys` and `dispatchErrors` are keyed by scope keys (`everything:null:null` and calendar-year keys are shared across children), so a shared instance would leak state between chips. The existing host does the same with `key={flowMember.id}`.
- **`generate` returns a tri-state:** `'started' | 'exists' | 'error'`. Today it returns `void`, including on a 23505 conflict. Update `useMemoryBooks` and its tests.
- **CTA:**
  - **available** → "Make {name}'s {scope label}" → `await generate(option)`:
    - `started` → `setPendingKeepsakesToast("We're making your {label} book…")` then `leave()`, the same helper as D3
    - `exists` → stay; the row refetches and shows its real status
    - `error` → stay and show the row's `dispatchError` inline
  - **already made and ready** → "Open {name}'s book" → shop.
  - **failed** → "Try again" → **`generate(option)`**. That creates a fresh row, exactly like `MemoryBookFlowHost`'s retry. `retryDispatch` is only for re-dispatching a still-`queued` row.
  - **queued with a `dispatchError`, or queued for more than 10 minutes** → "Try again" → `retryDispatch(option, book.id)`. Otherwise a failed dispatch leaves a permanently disabled "Being made…".
  - **in progress (healthy)** → disabled "Being made…".
- The shelf's "Couldn't be made" tap and the needs-you banner use the same failed→`generate` rule through the exported host.
- **No own children:** the hint "Add your child to make a book" plus a button → `familyRosterRoute`.
- testIDs: `keepsakes-product-memory-book`, `memory-book-product-cta`, `memory-book-scope-{key}`, `memory-book-scope-more`.

**D5. Routes in `src/lib/routes.ts`:** `keepsakeProductRoute('holiday-card'|'memory-book', memberId?)`, plus tests in `src/lib/routes.test.ts`. Both screens are stack screens under `app/(app)/keepsakes/` (no tab bar), matching `[memberId].tsx`.

### Phase E: tests, analytics, docs

**E1. Unit tests:**
- `src/utils/keepsakes.test.ts`: badges, `pickNeedsYou` priority, filter semantics, ordering, year summaries, the newest-first scope order.
- Component tests: `upcoming-recap-tile.test.tsx` (locked with/without picture, the visuals-short hint, unlocked), `needs-you-banner`, `make-something-row` (out of season hides the card).

**E2. `src/screen-tests/keepsakes.integration.test.tsx`:**
- **Rewrite** "Keepsakes tab" (L372), "Holiday card entry" (L587) and "Keepsakes for a brand-new family" (L721-830: films intro, pitch, example cover and the tab FAB flow are all gone) for the new layout.
  - States: owner full, owner films-only, owner brand-new, viewer, viewer with no films (`keepsakes-viewer-empty`).
  - Behaviors: fold/unfold a past year; the filter sheet applying a year; storefront hidden for viewers; the card hidden from the storefront out of season; privacy line gated on `has_viewers`; no "$" anywhere (assert no text matches `/\$\d/`); toast param shown then cleared.
- **Keep** "One child's keepsakes" (stack) unchanged, and "Recaps grid", now reached through the "All {year} recaps" tile.
- Mock `useKeepsakesOverview`.

**E3. New screen tests** for both product pages: CTA states, "See N more", already-made, thin state, out-of-season back-out.

**E4. Maestro:**
- `open-keepsakes.yaml`: assert `keepsakes-header` and `keepsakes-library`, tap `keepsakes-store-memory-book`, assert `keepsakes-product-memory-book`.
- `viewer-readonly.yaml`: wait for `keepsakes-viewer-empty|keepsakes-library` (L54-61), and expect "Family films" and no `keepsakes-store-.*`.
- `open-from-keepsakes.yaml`: it taps the first `keepsakes-film-.*`. Past years are now folded, so add a conditional step: when no film is visible, tap the first `keepsakes-year-toggle-.*`, then tap the film.

**E5. Analytics:**
- Add `keepsakes_product_opened {product: 'holiday-card'|'memory-book'}`, `keepsakes_filter_applied {type: 'all'|'films'|'books'|'cards', has_year: boolean, has_child: boolean}` and `keepsakes_year_toggled {year: number, open: boolean}` to the closed `AnalyticsEventMap` in `src/services/analytics.ts` (`trackEvent` is typed against it). Update `src/services/analytics.test.ts` if it enumerates events.
- Keep `keepsakes_opened`, plus `keepsakes_create_book_tapped`, which the stack path still uses.
- Update `docs/features/analytics.md`.

**E6. Docs:**
- Rewrite `docs/features/keepsakes.md`: layout, roles, the badge table, needs-you priority, the product registry extension guide, the overview RPC.
- Update `docs/TECH_SPEC.md` (the RPC).
- Link this plan.

**E7. Verify:** `npm test`, `npx tsc --noEmit` (Node 20 via nvm), lint, pgTAP for the new test file (Docker is often down; if so, run it against the linked database the same way previous pgTAP runs were done, or note it as pending).

### Deploy order (owner runs)

1. `supabase db push`: the migration. It's additive; old apps don't call it.
2. Publish an OTA for **both** runtimes in use (per memory: 1.4.3 and 1.4.2). No native changes: no new native modules, only `expo-linear-gradient`, `expo-image` and `expo-symbols`, which are already present.

## Risks & mitigations

- **Viewer media signing:** verified that `get-media-url` lets any family member sign their family's illustration and media keys, so viewers can load the recap picture.
- **Floor drift:** the counts in SQL vs the worker (`year-film-eligibility.ts`, `year-film-context.ts`, `rows.ts`). Mitigation:
  - the pool helper mirrors every worker exclusion and visual rule (A1);
  - comments cross-link the SQL and the TS;
  - the constants are returned by the RPC;
  - pgTAP covers each exclusion.

  The remaining worst case is a change after the 1st, e.g. a report filed after the month closes, or a memory deleted or edited. The tile then promised a film that is skipped. Acceptable: the tile disappears once the month rolls over.
- **Privacy of the faded picture:** the picture and `preview_key` exclude reported memories, reported illustrations, onboarding-pending media and blocked authors (family blocks plus the caller's personal blocks for the picture), so a hidden image is never resurfaced.
- **Missing RPC on an old server:** deploy order puts the migration first. The hook treats an RPC error as `overview = null`: the storefront still works, there's no upcoming tile and no badges from orders. The tab must not crash.
- **Book order visibility:** owners and managers now see family book order status regardless of who paid. This is intentional (family keepsakes) but a privacy change versus the `requested_by` RLS. It exposes status only, never addresses or prices.
- **Stack variant regressions:** the shared body file loses its tab branch. Mitigation: the tab moves to `KeepsakesTab`; the stack tests stay green and unchanged.
- **Big diff in one PR:** phase it. A (server) → B (data, pure helpers) → C (components) → D (screens) → E. Each phase compiles and its tests pass.
- **`keepsakes_opened` inflation:** it fires on every focus, including returning from the new product pages. This is existing behavior with the player; left as is, and noted in the analytics doc.
- **Poster crop:** a 110×162 film poster (about 0.68) crops about 17% of a 9:16 poster. Intentional per the design; check it on a device.
- **Card disappears after Jan 31:** `holiday_card_summary` returns only the newest card, so an ordered card leaves the shelf after Jan 31 (today's behavior). Accepted; a past-years card history is out of scope.

## Out of scope

- An upcoming **birthday** film tile and an upcoming year-end tile. The design shows "Tomás turns 3 · Oct 23" as an illustration, but birthday eligibility (a 60/40 pool over the age-year window) needs its own server logic. Follow-up.
- Order tracking pages in the app. Shipped/ordered taps still open the shop.
- Holiday cards from past years on past-year shelves. Only the newest card shows, through Jan 31 when ordered.
- Bridging the 1st-of-month gap before the previous recap surfaces.
- The one-child stack route (`/keepsakes/[memberId]`) and its create sheet. Unchanged; a later pass can point its CTA at the new Memory Book page.
- i18n.
- Changing film generation, floors, or the holiday card season logic.

## Review log

**Round 1 (Sonnet 5.5, completeness and correctness):** 11 findings, all accepted.
- **Pool rules:** the recap pool now mirrors the worker: memory and illustration reports, onboarding-pending, blocked authors, legacy `media_key`, null-duration videos.
- **Orders:** per-table order status sets; the card's "Ordered" comes from `summary.ordered`; books get no shipped date.
- **Books:** deduplicated through `buildMemoryBookRows` before shelves and banners.
- **Toast:** a concrete toast mechanism.
- **Periods:** they respect the never-one-tap calendar-year rule.
- **Recaps grid:** kept through an "All {year} recaps" tile.
- **Film tile:** `KeepsakeFilmTile` is extended (remaking/updating kept); `FilmCover` already supports `height`.
- **Holiday state:** `holidayCardTileState` moved to a util.
- **Plumbing:** the analytics map, the `has_family_role` helper, the `queryKeys` convention, the sheet pattern, dead-code and test lists, Maestro fold handling, lifted filter state, a single `useHolidayCard`, and hand-added types.

**Round 2 (Sonnet 5.5, failure modes):** 17 findings, all accepted. Key fixes:
- **Card page navigation:** never auto-leaves while a refused create is showing; a `createdRef` gate; the leave waits for Modal dismiss; a `canGoBack` fallback.
- **Book page:**
  - failed → `generate`
  - a stuck queued row → `retryDispatch`
  - a tri-state `generate` result
  - a per-child keyed hook instance
- **Scope list:** `visible` = the two newest completed age-years (made ones labeled), not `pickSuggestedScopes`.
- **SQL:** the pool helper is internal (no authenticated grant).
- **Filter state:** resets on family switch, plus a "nothing matches" state.
- **Pool details:** the onboarding boolean alone; audio is never a visual; the picture key follows the visual asset.
- **RPC performance:** bounded scans, `limit 1` laterals, the time zone computed once, `staleTime` 30 s.
- **Card page eligibility:** the holiday-pool count gates the QR-film promise, since create has no floor.
- **Previews:** book and family previews come from the RPC, with report and block filters.
- **Invalidation points:** listed; push handlers excluded.
- **Order edge cases:** refunds, null `card_id`, sort key.
- **Banner limits:** the card only in season; failed books only within 30 days.
- **Time zones:** the tile's year comes from the owner-local `month_start`.
- **Toast:** a module store instead of a route param.
- **States:** loading, error and viewer-library testIDs defined.
