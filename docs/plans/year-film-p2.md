# Year Film P2 — App surfaces (+ backend amendments, family backfill)

**Status:** plan, 2026-09-29 (light-hardened, see §10)
**Parent:** [year-film.md](year-film.md) §8 · backend: [year-film-p1.md](year-film-p1.md) ·
feature doc: [docs/features/year-film.md](../features/year-film.md)

## 1. Goal

Families can find, watch, share and edit their films in the app, and every
enabled family (in practice today: the owner's,
`e6b0c7a2-f403-4c84-94f5-720bf94073ee`) has its whole film history on launch
day. **No calendar deadline:** everything launches when the work is ready
(owner, 2026-09-29).

Done means:
- every ready film has a permanent, dated card in the Timeline, a home in the
  Keepsakes tab (grouped by year) and on its child's keepsakes page, a push,
  and an entry in the notifications drawer;
- a full-screen player with scene progress and share;
- the backend amendments below are deployed, and the owner's family's past
  birthday, monthly and year films are rendered and visible;
- it ships by EAS Update (no new native modules).

Steps 1–10 plus the edit sheet (§8, Step 11). With no deadline, the earlier
P2A/P2B split is gone. The edit sheet can still land last, but it ships in the
same release.

## 2. Owner decisions (2026-09-29)

| Area | Decision |
|---|---|
| Birthday film | Made 00:30 and delivered 09:00 **2 days after** the birthday; covers through the day after the birthday |
| Monthly recap | Unchanged: made 00:30 on the 1st, delivered 19:00 |
| Year-end film | Made **Dec 28** (scope Jan 1 – Dec 27), delivered **Dec 30 09:00** |
| Discovery | Push + a **notifications-drawer entry** (new activity kind) + a "New" marker on the card until watched |
| Timeline | **Permanent in-feed cards**, backdated: birthday film = the latest item of the birthday; monthly recap = caps its month; year-end film = caps its year (above December's recap). A small film marker in Calendar view. **No temporary top-of-feed card.** |
| Keepsakes tab | **Grouped by year**, newest first. Each year: *Family films* (year-end, last 3 monthly recaps, "See all {year} recaps"), then each child's shelf (birthday films + books). Items file under the year they **end**. Everyone (viewers too) sees films; books stay owner/manager-only. |
| Upcoming | Only **next month's recap** ("October recap · Nov 1") |
| Child keepsakes page | That child's birthday films (top) + books |
| Cover | The **first scene, settled** ("Nuestro 2026" + photo pile; "Recuerdos de tu tercer año, Enzo" + portraits) |
| Backfill | The owner's family gets every past film now |

## 3. Context — what exists (verified 2026-09-29)

**Backend (P1, deployed; canary mode, `launch_date` NULL):**
- `supabase/migrations/20260929120000_year_films.sql`:
  - `year_films`: unique key `(family_id, kind, member, scope_start_date) where not forced`.
  - Client column grant: `id, family_id, kind, family_member_id, age_year, scope_*, scope_label, language, status, blocked, stale, duration_ms, edits_version, surface_at, ready_at, created_at`. Keys and scripts are never granted.
  - RLS select: member, video present, not blocked, and surfaced (owners/managers earlier). **It does not exclude `forced`.**
  - `year_film_views (film_id, user_id, first_viewed_at, completed_at)`: own-row RLS.
  - `year_film_due` (~L522): birthday due = birthday + 3 = `scope_end_exclusive`; year due Dec 12, surface Dec 15.
  - `year_film_notifications_due` (~L776): marks `notified_at`, returns rows. It only covers `surface_at` within 14 days and excludes forced films.
- `_shared/year-film-eligibility.ts`:
  - `BIRTHDAY_FILM_DAYS_AFTER = 2`;
  - `birthdayFilmScope` ends at birthday + days-after + 1;
  - `FAMILY_FILM_CUTOFF = '12-12'`;
  - floors: monthly 10, birthday and family 60.
- `schedule-year-films`:
  - `DISPATCH_BATCH = 20` per hourly run;
  - push copy in `filmPushCopy`;
  - route data `{ route: 'year-film', familyId, filmId }`.
- `get-year-film-url`: JWT; returns presigned `videoUrl`, `posterUrl` and `scenesUrl` (15 min) for **one** film; 409 if blocked.
- Render job `render/year-film-renderer/src/job.mjs` `posterTime()` picks the **close** scene (else the title scene at 65%, else 80%). Posters are 1080×1920 JPEG.

**App:**
- **Timeline** `app/(app)/(tabs)/timeline.tsx` (1428 lines):
  - one `Animated.FlatList` of `TimelineRow = controls | memory | month` (`rows`, ~L785);
  - memories come from `useMemories` (keyset pages, `memory_date desc, created_at desc`) and an anchored mode for month jumps;
  - `MeasuredCell` reports `{y, height, date}` for the sticky row's month label;
  - the Calendar view is `calendar-month-grid.tsx`.
- **Keepsakes** `app/(app)/(tabs)/keepsakes.tsx`:
  - header, then a films slot comment (~L44), then `MemoryBooksBody` (`src/components/memory-books/memory-books-body.tsx`, 658 lines: shelves, pitch, create/retry flow host);
  - the child route is `app/(app)/keepsakes/[memberId].tsx`;
  - books come from `useFamilyMemoryBooks` (`scope_start_date`/`scope_end_date` per book).
- **Activity drawer:**
  - `family_activity_events`: `actor_id NOT NULL`; kind check has 5 kinds; ids-only rows.
  - `get_family_activity` (latest: `20260927180000_…`) filters `e.actor_id <> auth.uid()`, blocked actors, and `member_pending` for non-managers.
  - `get_family_activity_unread` (`20260822100000_…` ~L339) and `mark_family_activity_seen`.
  - Client: `src/services/family-activity.ts` (`FamilyActivityKind` union), `src/components/family-activity-row.tsx`, `family-activity-sheet.tsx`, `timeline-activity-bell.tsx`.
- **Push:** `src/hooks/useNotifications.ts` routes `approvals | timeline | new-memory | memory | memory-book`. `year-film` is typed server-side only.
- `expo-video`, `expo-sharing` and `expo-file-system` are installed, so there are no new native modules and this ships by EAS Update.
- UI copy is English-only (no i18n); films speak the journal's language.

## 4. Steps

### Step 1 — Migration `…_year_films_p2.sql` + pgTAP

1. **Dates.** Recreate `year_film_due` **keeping its structure and window logic** (the `k in (-1,0)` age candidates, the 3-day catch-up, `date_trunc` months). Change only the constants below; the backfill in 6 is a separate function, checked for parity by pgTAP.
   - birthday due = birthday **+ 2** (= `scope_end_exclusive`, so scope ends the day after the birthday);
   - the own-child check uses `due_date - 2`;
   - year-end: due **Dec 28** (`scope_end_exclusive` Dec 28), `surface_at` **Dec 30 09:00** owner-local.

   **Matching TS and tests** (all must change together):
   - `BIRTHDAY_FILM_DAYS_AFTER = 1` and `FAMILY_FILM_CUTOFF = '12-28'`, with the `birthdayFilmScope`/`familyYearScope` doc comments.
   - `year-film-eligibility.test.ts:269`; `year-film-script.test.ts` ~L304, L522-523, L578.
   - `supabase/tests/year_films.sql` (the Oct-26 asserts ~L86-95, the Dec-12 asserts ~L118-121, `plan(n)`).
   - `supabase/scripts/eval-year-film-audit.ts:430` (hardcoded `-12-12`).

   Note: `BIRTHDAY_FILM_DAYS_AFTER` also drives `year-film-script.ts:1105` (which memories count as the birthday celebration). Going 2→1 is intended: the party must fall on the day or the day after.

   The Worker reads scope from the row, but it **bundles `_shared`** (`stages.ts` imports `year-film-script`/`-context`/`-eligibility`), so the `BIRTHDAY_FILM_DAYS_AFTER` change reaches curation only after a **Worker redeploy**. Year-end load: the render window shrinks from ~3 days to ~2.4 days (Dec 28 00:30 → Dec 30 09:00). That's trivial at canary/early scale, and P3 revisits `max_concurrent_renders` against `year-film.md` §11 before `mode = all`.
2. **Placement.** A stored generated column `placement_date date`:
   - `birthday` → `scope_end_exclusive - 2` (the birthday);
   - `family_month` → `scope_end_exclusive - 1` (the month's last day);
   - `family_year` → `make_date(extract(year from scope_start_date)::int, 12, 31)` (the cast is needed; `extract` returns numeric).
   Add its own `grant select (placement_date)` to `authenticated` (the table only has column grants), and an index `(family_id, placement_date desc)`. `make_date`/date arithmetic are immutable, so a generated column is fine. The birthday offset is coupled to `BIRTHDAY_FILM_DAYS_AFTER` (comment + a pgTAP assert on a birthday row).
3. **Client RLS excludes forced films:** add `and not forced` to "Year films: select". Canary films are operator-only, so they never show in the app.
4. **Drawer event `film_ready`:**
   - `family_activity_events`: `actor_id` drops NOT NULL, with `check ((kind = 'film_ready') = (actor_id is null))`; add `film_id uuid references public.year_films on delete cascade`; the kind check adds `film_ready`.
   - **New RPC names** `get_family_activity_v2` and `get_family_activity_unread_v2` (the same bodies plus films). The v1 functions add an **explicit** `e.kind <> 'film_ready'`, so old app builds (1.4.x runtimes that haven't taken the update) never list an unknown kind or show a dot they can't clear. The new client calls v2.
   - In both:
     - `e.actor_id is distinct from auth.uid()` (the old `<>` drops NULL actors);
     - `actor_is_former` is `false` when `actor_id is null`;
     - the blocked-actor `not exists` tolerates a NULL actor;
     - a `film_ready` row counts only if its film is still servable (`video_key is not null`, `not blocked`, `not forced`, `surface_at <= now()`).
   - v2 adds output columns `film_id, film_kind, film_member_id, film_age_year, film_scope_start`, which carry no content. The prune job has no actor predicate and needs no change.
   - `year_film_notifications_due` inserts one `film_ready` event per notified film in the same statement (a CTE over the `update … returning`). The event exists exactly when the push goes out, never earlier.
     - It's plpgsql `returns table (film_id, family_id, kind, …)`, so every column in the CTE is alias-qualified (or `#variable_conflict use_column`). The signature stays identical, because `create or replace` can't change a return type.
     - pgTAP calls it with a real ready film and asserts both the returned row and the event.
5. **Member RPC** `year_films_enabled(p_family_id) returns boolean` (definer; member check; `year_film_family_enabled` + at least one own child). It drives the upcoming-recap card.
6. **Shared scope math + backfill.**
   1. A new SQL function `year_film_candidate_rows(p_family_id, p_from date, p_to date)` returns `(kind, member, age_year, scope_start, scope_end_exclusive, due_date, surface_at)` for every due date in `[p_from, p_to]`, using the same constants as `year_film_due`.
      - It's used by the backfill only; `year_film_due` keeps its own proven logic.
      - **A pgTAP parity sweep** asserts that, for a fixed family and each day across the probe dates, the candidates with `due_date = local today` equal what `year_film_due` inserts. The probe dates cover DST switch days, owner timezones UTC−11 and UTC+14, Dec 27 → Jan 2, month ends, and a Feb 29 birthday.
   2. Backfill RPC `queue_year_film_backfill(p_family_id uuid, p_through date, p_dry_run boolean) returns table (kind, member_id, age_year, scope_start, due_date, inserted boolean)` (service_role only). It covers every due date `<= least(p_through, family-local today)`, because the scope must be complete, and `>=` the month of the family's first memory:
      - own-child birthdays (age 1–12);
      - months with ≥ 10 memories;
      - complete years with an own child.
   3. Row values:
      - non-forced;
      - `surface_at` = the kind's historic delivery time (birthday+2 09:00, the 1st at 19:00, Dec 30 09:00, owner-local);
      - `notified_at = now()`, so there's no push and no drawer event;
      - `on conflict do nothing`.
   4. It requires `year_film_family_enabled` **and** `billing_write_allowed(family_id, owner_id)` (the same gates as `year_film_due_families`), and ignores `launch_date`. A dry run inserts nothing and returns the list.
   5. The hourly scheduler then dispatches them in 20s; floors are re-checked at curate, so thin periods end `skipped` (invisible).
   6. `queue-year-film.ts` gains:
      - `--backfill --through YYYY-MM-DD [--only <kind>:<scope_start>] [--apply]`, printing the returned table, with `--all-families` (in place of `--family`) looping every enabled family for launch day;
      - `--requeue-all --family <id>` (resets `last_failure_code` and `skip_reason` too);
      - `--delete-backfilled --family <id>` (non-forced rows with `notified_at` set by the backfill, and their R2 prefixes);
      - R2 prefix deletion for `--delete-forced`.
      So a bad backfill can be redone, and the backfill can start with a smoke subset (Step 10).
7. **pgTAP** (`supabase/tests/year_films.sql` + activity suite):
   - new due dates (birthday +2, Dec 28/Dec 30 incl. owner timezone);
   - `placement_date` per kind;
   - a forced row is invisible to members;
   - `film_ready` is inserted once per notification, visible to all members incl. the "actor", hidden once the film is blocked, and not counted as unread after `mark_family_activity_seen`;
   - backfill: idempotent, no events or pushes, skips months under 10.
   Regenerate `src/types/database.ts`; update TECH_SPEC §2.1h, §4.27 and the activity section.

### Step 2 — Cover frame (render job)

`posterTime()` → the **first scene, settled**: `first.start + max(first.duration * 0.5, min(first.duration * 0.85, first.duration - 0.35))`. That's after entrance animations and before the seam transition; the `max` guards very short first scenes.

The job also writes **`poster_thumb.jpg`** (360×640, `-q:v 4`) next to `poster.jpg` in the attempt directory. Its key is derived from `poster_key`, so there's no new column. Lists sign the thumb; only the player uses the full poster. Doing this now matters, because every backfilled film renders with this image and posters aren't regenerated later.

- Unit tests over the timeline shapes: birthday `cold_open`, monthly/family `title`.
- The e2e asserts the poster differs from frame 0 and isn't background-flat.
- Verify visually on the Enzo Y4, Sep 2026 and family 2026 compositions (extract the frame locally from `film-renderer` renders).
- Rebuild the image (build.sh, clean tree), push, and redeploy the Worker with the new `FILM_RENDERER_IMAGE`.

### Step 3 — Poster batch signing

Extend `get-year-film-url` to accept `{ filmIds: string[] }` (≤ 50 per call; the client chunks) and return `{ posters: { [filmId]: url } }`:
- the same per-film role/blocked checks;
- **surfaced only**: `surface_at <= now()` for everyone in both modes. There's no owner early preview in the app; operators preview downloads;
- **not forced**;
- it signs the derived **thumb** key; the TTL is **60 min** (the video stays 15 min). It's short because a block must stop serving quickly: the old objects stay in R2 until the re-render publishes, and `ready_at` doesn't change on a block;
- unknown or forbidden ids are omitted, not errors.

Single-film mode keeps its checks and also refuses forced films. Deno tests cover allowed, blocked, forced, unsurfaced and foreign ids, and the cap. TECH_SPEC §4.29 documents the batch mode.

Client:
- `src/services/year-films.ts`: `fetchFamilyYearFilms`, `fetchYearFilmViews`, `markYearFilmViewed`, `markYearFilmCompleted`, `getYearFilmPlayback`, `getYearFilmPosters`.
- `useYearFilmPosters(ids)`: React Query keyed **per film id** (a batch fetcher behind it, chunked at 50), so a growing list doesn't re-sign everything. Stale time under the TTL; refetch on image error, like `useMediaUrls`.
- Images use a stable **`cacheKey = film-thumb:{id}:{ready_at}`**, because the presigned URL changes every fetch and a re-render changes `ready_at`.
- A film that disappears from `useFamilyYearFilms` (blocked, deleted) drops its tile immediately; the films query refetches on focus, push and drawer open.

### Step 4 — Data hook + pure placement

- `useFamilyYearFilms(familyId)`:
  - selects the granted columns + `placement_date`, `order placement_date desc`;
  - filters client-side to `surface_at <= now` as a belt, since RLS lets owners/managers see earlier and permanent surfaces must not;
  - invalidates on focus and on a `film_ready` push/drawer event.
- `useYearFilmViews(familyId)` (`year_film_views` own rows) feeds "New". Playback writes:
  - `insert … on conflict do nothing` (supabase `upsert` with `ignoreDuplicates: true`; a merging upsert would need UPDATE on `film_id`/`user_id`, which isn't granted);
  - then `update({ completed_at })` at the end;
  - then invalidate the query.
- `src/utils/year-films.ts` (pure, unit-tested):
  - **`filmTitle(film, members)`**: "Enzo's Year Four", "September recap", "Your 2026". It uses the English ordinal words and falls back to "A birthday film" if the member is gone.
  - **`interleaveFilms(memories, films, { hasNewer, hasOlder, anchorDate })`**: a film with placement date *d* goes **before** the first loaded memory with `memory_date <= d` (so it's the day's latest item, and newest-first puts it on top of that day). Tie-break: year above month above birthday on the same day.
    - A film sorting **above** every loaded memory is inserted when `!hasNewer`, **or when anchored and `d <= anchorDate`**. Every unloaded newer memory has `memory_date > anchorDate`, so nothing can belong above it. This is exactly the jump case: `getMonthAnchorDate` is the month's last day, where the recap sits.
    - One sorting **below** every loaded memory is inserted only when `!hasOlder`.
    - This way anchored and paged windows never show a film out of order.
  - **`isNewFilm(film, viewedIds, now)`**: not viewed and `surface_at` within 14 days, so backfilled films are never "New".
  - **`buildKeepsakeYears(films, books, members, today)`**: `[{ year, familyFilms: { yearEnd, recaps (all, desc) }, children: [{ member, films, books }] }]`, newest year first.
    - A film files under `year(placement_date)`.
    - A book files under `year(scope_end_date)`. A book with no scope dates (the "everything" scope) files under `year(created_at)`.
    - The current year always exists, so the create tiles and the upcoming card have a home.
    - Children follow the existing shelf rule (`isOwnChild` or has a book).

### Step 5 — Timeline

1. `TimelineRow` gains `{ kind: 'film'; film }`, and `rows` uses `interleaveFilms` in List view. `keyExtractor` returns `film:{id}`.
2. `MeasuredCell` reports `date = placement_date`. Viewability ignores film rows for video autoplay.
3. `src/components/year-films/film-card.tsx`:
   - a cover thumbnail (9:16, ~88pt wide, rounded) with a play glyph;
   - the title and a subtitle ("1 minute · Oct 2025 – Oct 2026" / "September 2026");
   - a "New" pill (`isNewFilm`);
   - it opens the player.
   Monthly and year films use the same card; no expiry.
4. **Calendar view:** `calendar-month-grid` shows a small film dot on a day with a film (birthday, month-end, Dec 31) from the same film list.
   - A day with a film is **pressable even with no memories**; today `if (!summary)` renders an inert day (`calendar-month-grid.tsx` L40), and recaps often land on memory-less month-ends.
   - The tap reuses the existing day-tap path (switch to List, anchored at that day).
5. **Jump alignment:**
   - Today the jump aligns the first memory with `memory_date <= anchorDate` (`timeline.tsx` ~L978-984). With films, `alignTargetId` is computed from the **merged `rows`**: the first row (film or memory) dated `<= anchorDate`. Otherwise a day or month jump scrolls the card out of view, which is exactly the recap-caps-its-month case.
   - The films query is **prefetched at Timeline mount** (it's small), and anchored rendering and alignment wait until it has settled. Otherwise a late film insert above the aligned memory gets held off-screen by `maintainVisibleContentPosition`.
6. **Integration tests:**
   - anchored month jump and pull-to-refresh with films;
   - a film above the loaded window appears when the newer page lands;
   - a jump to a month whose recap caps it shows the recap card at the top;
   - a Calendar tap on a film-only day.

### Step 6 — Player `app/(app)/year-film/[id].tsx`

1. **Loading:** `getYearFilmPlayback(id)` gives the video, poster and scenes URLs. Show the poster while buffering.
2. **Playback:** full screen with `expo-video`, sound on, `contentFit: contain`, and a dark plum letterbox.
   - **Audio:** on open, call `pauseAllAudioPlayback()` (the repo's `audio-playback-coordinator`) and set a playback audio mode that **plays with the iOS silent switch on**. A dictation or audio-memory session can leave a recording category behind. Device-check with the ringer off on iOS, and on Android.
   - The player is **created once**, and sources change only through `replaceAsync`. Never use `useVideoPlayer` with a changing source, and never release the player while a mounted `VideoView` holds it (the shared-object release rule, commit 25ef6be; pattern in `memory-media-carousel.tsx` / `full-screen-media-viewer.tsx`).
3. **Overlay:**
   - a segmented progress bar from `scenes.json` (the `story-progress.tsx` look);
   - tap right/left = next/previous scene (seek); hold = pause;
   - mute toggle; close ×.
4. **On error:** refetch URLs once on a player error (TTL expiry). A 409 or 404 shows "This film isn't available right now."
5. **Views:** upsert `year_film_views` on first play; set `completed_at` at the end.
6. **Completion overlay:** Replay · **Share**.
7. **Share:** download the MP4 to cache with `expo-file-system/legacy` `createDownloadResumable` (as the repo uses legacy everywhere, e.g. `src/utils/local-files.ts`), with a progress label since films are 35–65 MB and a cancel. Then `Sharing.shareAsync(uri, { mimeType: 'video/mp4', UTI: 'public.mpeg-4' })`, then delete the file on every exit path. It downloads into a `film-share/` cache prefix that's swept on app start, for kills mid-download.
8. **Routes:**
   - `yearFilmRoute(id)` in `src/lib/routes.ts`.
   - `useNotifications`: add `year-film` to `RECOGNIZED_PUSH_ROUTES` and the client `PushRouteData` (`filmId`); this also widens the `notification_opened` `target` type in `analytics.ts`.
   - Add `routeToYearFilm`, following `routeToMemoryBooks`: switch the active family to the push's `familyId` first, and fall back to the Timeline if the recipient is no longer a member or the film is unavailable. It handles warm and cold start; Back goes to Timeline on cold start.
9. **Accessibility:** the screen reader label names the film. Reduce Motion shows a one-line motion warning before play.

### Step 7 — Keepsakes

`MemoryBooksBody` owns the tab's ScrollView, the CTA overlay and the toast, and the films slot in `keepsakes.tsx` sits **outside** that ScrollView. So the body is **restructured** into one scroll that renders films and books together (`KeepsakesBody`). `MemoryBookFlowHost`, the create/retry sheets, the toast and the CTA overlay are kept intact.

1. **Layout:** `KeepsakeYearSection` per `buildKeepsakeYears` year, newest first:
   - *Family films*: the year-end tile (large cover), then the latest 3 recaps (small covers) and, if there are more, "See all {year} recaps" → `app/(app)/keepsakes/recaps/[year].tsx` (a grid);
   - then each child: a shelf of birthday-film covers + that year's book tiles. Test ids become `keepsakes-year-{year}` and `keepsakes-shelf-{year}-{memberId}`.
2. **Upcoming:** on top of the current year's Family films, a dashed "{Month} recap · {1st}" card. `year_films_enabled` returns true only when the film would really be attempted:
   - the rollout includes the family;
   - `launch_date` is set and `<=` the next 1st;
   - billing allows;
   - there's an own child;
   - the current month already has ≥ 10 memories.
   Otherwise the card isn't shown, so it never promises a recap that can't come.
3. **Books inside the years:**
   - The create tile ("Create {name}'s first book") sits on the **current year's** child shelf.
   - The family-level pitch shows only when there are **no books and no films**, below the year sections.
   - The CTA overlay and the "N books" count keep today's rules.
4. **Viewers:** the `variant === 'tab' && !canGenerate` early return (`memory-books-body.tsx` ~L299-303) becomes **films-only**: viewers see the year sections with films and no book UI. `keepsakes-viewer-empty` shows only when there are no films either. Update `keepsakes.integration.test.tsx` (~L211-223 shelf ids, ~L262-266 viewer) and `.maestro/flows/sharing/viewer-readonly.yaml` (L54-59) deliberately.
5. **Child page** `keepsakes/[memberId]`: birthday films (all years, newest first) above the existing books body. Viewers see films there too.
6. **Polling:** unchanged for books. Films need none; they arrive by focus refetch, push or drawer.

### Step 8 — Notifications drawer

- `src/services/family-activity.ts`:
  - call `get_family_activity_v2`;
  - `FamilyActivityKind` adds `film_ready`;
  - `FamilyActivityRpcRow` widens `actor_id` to nullable and adds the `film_*` columns;
  - `FamilyActivityEvent.actorId: string | null`, plus `filmId` etc.;
  - `mapFamilyActivityRow` gives film rows no actor name;
  - `buildFamilyActivityCopy` adds the `film_ready` case: "{filmTitle} is ready". Its `never` guard forces this.
- `groupEventsWithinSection`: film rows are never grouped and are skipped by actor grouping.
- `family-activity-row.tsx`: a cover thumbnail (`useYearFilmPosters`) instead of the actor avatar.
- `family-activity-sheet.tsx`: `handleRowPress` gets a `film_ready` case and an `onOpenFilm(filmId)` prop, wired by the host in `timeline.tsx` (~L1201).
- The bell's unread **boolean** includes `film_ready` via the RPC. Blocked, deleted or forced films drop out server-side.

### Step 9 — Analytics

Events (added to the typed event map in `src/services/analytics.ts` and to docs/features/analytics.md):
- `year_film_opened { kind, source: timeline|keepsakes|push|drawer|calendar }`
- `year_film_completed { kind, duration_s }`
- `year_film_share_tapped { kind }`, `year_film_shared { kind }` (share sheet returned)
- `year_film_recaps_opened { year }`

No film text or names.

### Step 10 — Rollout, backfill, docs, tests

**Deploy order:**
1. Migration.
2. `schedule-year-films` and `get-year-film-url`.
3. Image (Step 2) + Worker.

**Canary cleanup:** delete forced rows `6ebcdf65…` and `2ef7f3e6…`, and remove their R2 prefixes plus the leftover `17922d5f…` prefix. Extend `year-film:queue --delete-forced` to delete each forced film's `{ownerId}/year-films/{id}/` prefix.

**Prerequisites:**
- Docker up (pgTAP, `supabase gen types` piped cleanly into `src/types/database.ts`, `build.sh`).
- The owner runs `supabase db push`, function deploys, image push and `wrangler deploy`.
- Claude runs the tests and the operator commands.

**Backfill (launch step)** — the history arrives **silently** (owner, 2026-09-29): no push, no drawer entry. It runs for the owner's family first as the pre-launch test data, then for **every enabled family on launch day**, via `--backfill --all-families`, which loops the enabled families.

Hard precondition: the migration, the new Worker (which bundles the `_shared` date constants) and the new image (settled cover + thumb) are live, and one new-image render's `poster.jpg`/`poster_thumb.jpg` has been checked. Backfilled covers are permanent.
- **Dry run:** `npm run year-film:queue -- --family e6b0c7a2-… --backfill --through <today>`. The returned table lists every film key, including the latest complete month's recap.
- **Smoke subset first:** `--only family_month:2026-09-01` and one birthday, with `--apply`. The owner checks them (cover, film).
- **Then the rest** with `--apply`.
- Kick the scheduler.
- Expect roughly 30–40 films at 20 per hourly run with 4 concurrent renders: a few hours, about $2–4 of AI and about 2 GB of R2.
- Watch through the operator list; re-kick as needed.

**Device test:** on the owner's phone against real backfilled films (Timeline placement, Keepsakes years, player, share, drawer via a forced `film_ready` in local dev).

**EAS Update:** publish to 1.4.0 and 1.4.1 production (per [[project-ota-releases]]), and to 1.4.2 too if that build has reached the stores (`app.json` is already 1.4.2; runtime policy `appVersion`).

**Film title before the family switch:** `filmTitle` in the player uses the **film's own family's** members (the film row carries `family_id`), not the active family's, so a push opened before the switch completes still titles correctly.

**Launch (order, no dates):**
1. The app update is live.
2. **Close the gap:** run the backfill `--through <launch day − 1>` for every enabled family. `year_film_due` catches up only 3 days and needs `due_date >= launch_date`, so this backfill is what guarantees no film due between the last backfill and launch is lost.
3. Set `launch_date = <launch day>`, and `mode` as decided (`canary` for the owner, `all` at P3).
4. From then on the scheduler makes every new film.
5. Pre-flight query before flipping: films due in the next 10 days for enabled families.

**Docs:**
- `docs/features/year-film.md`: surfaces, placement rules, backfill, changelog;
- `keepsakes.md`: year grouping, films;
- `family-activity.md`: `film_ready`;
- `year-film.md` §8 superseded by this plan;
- TECH_SPEC.

**Tests:**
- unit: the pure utils in Step 4, `posterTime`, `filmPushCopy` dates;
- integration: `timeline-films`, keepsakes years, player (mocked `expo-video`), drawer row, `useNotifications` route;
- Deno: `get-year-film-url` batch;
- pgTAP: as in Step 1;
- Maestro: `year-film/open-from-keepsakes.yaml` (open → plays → share sheet appears).

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Interleaving breaks anchored/paged Timeline windows (films out of order, `maintainVisibleContentPosition` jumps) | Pure `interleaveFilms` with the `hasNewer/hasOlder` rule; film rows are ordinary rows (no index-1 special row); run the month-jump integration suite with films; verify on Android |
| 35–65 MB films stream poorly on cellular | Poster shown while buffering; `expo-video` progressive playback from presigned R2. **Follow-up** (not in P2): a lower-bitrate share/stream rendition (CRF/bitrate in the render job) once real-network data exists |
| Share download of 60 MB fails midway | Progress + cancel; clean the temp file on any exit; a retry keeps the same URL until it expires, then refetches |
| Presigned URL expires during a long pause | Refetch playback URLs once on player error; resume at the last position |
| Drawer `film_ready` with a NULL actor slips through the `<>` actor filters | All three functions switch to `is distinct from`; pgTAP asserts that every member sees it |
| Changing due dates mid-canary double-inserts a film | The unique key is on `scope_start_date`, which the change doesn't alter; `launch_date` stays NULL until ship day, after the backfill; pgTAP covers the new window |
| Old app builds meet the new drawer kind | The v1 activity and unread functions explicitly exclude `film_ready`; only v2 callers see it |
| A bad backfill (wrong cover, prompt regression) is permanent | Smoke subset first; `--requeue-all` / `--delete-backfilled` redo it; hard precondition on the new Worker + image |
| The `year_film_due` date change silently skips films | Structure kept, constants only; the pgTAP parity sweep over DST/tz/year-end/Feb 29 |
| Lists download full-size posters | A 360×640 `poster_thumb.jpg` for lists; full poster only in the player |
| The film is silent with the iOS ringer off, or other audio plays under it | Playback audio mode + `pauseAllAudioPlayback()` on open; device check |
| A film due before launch is lost (3-day catch-up) | The launch runbook backfills `--through` launch day − 1 before setting `launch_date` |
| The backfill floods the queue or AI spend | One family only; dispatch 20/h, 4 renders; the operator watches cost via the ledger; `--through` bounds it |
| The keepsakes refactor regresses the book flow | Keep `MemoryBookFlowHost`, the sheets, the toast and the CTA intact; the book-flow cases of the keepsakes suite keep passing, with only the shelf test ids and viewer cases deliberately updated, plus new year cases |
| Posters change for already-rendered films | No production films exist beyond the canary (deleted); backfilled films render with the new image |

## 6. Out of scope

- "Print this year".
- Spanish UI copy.
- A low-bitrate rendition.
- A non-silent "history is ready" announcement (the owner chose silent).
- `mode = all` and launch comms (P3).
- Web viewer or share links.
- Films in the export beyond P1.

## 7. Owner answers (2026-09-29)

1. **Timing:** no dates. The backfill, the app update and scheduled films launch when the work is ready. The edit sheet is in the same release.
2. **History:** arrives silently.
3. **At launch:** every enabled family gets its history (in practice the owner is the only user today).

## 8. Step 11 — Edit sheet

**Status (2026-09-30):** built locally. Migration `20260930150000_year_film_edit_options.sql` (not deployed), app sheet + player wiring, bundled bed previews; `hideNames` not built (no render support). See [docs/features/year-film.md](../features/year-film.md) "Edit sheet".

- Definer RPC `get_year_film_edit_options(p_film_id)` (owner/manager): the montage frames (memory id, date, thumbnail key → signed), up to 3 quote candidates (text + hash), the current bed, and 3 bed previews.
- A keyboard-free sheet from the player's completion overlay: toggle frames, pick the quote, pick the music (5 s previews). Save → `save_year_film_edits` → "Remaking your film… (a few minutes)".
- The previous version plays until the new one publishes (except removals, which block immediately, per the P1 rule).

## 9. Order of work

1. Backend (Steps 1–3): migration + TS dates, cover + thumb, batch signing; deploy (owner); canary cleanup.
2. Owner-family backfill (smoke subset, then the rest) as real test data.
3. App (Steps 4–9, 11); device pass (owner); fixes.
4. Launch runbook (Step 10): OTA → backfill through launch day − 1 → `launch_date`.

## 10. Review log

**Round 1 (Sonnet, completeness and correctness), 12 findings.** All applied except where noted:
- **Backfill gap:** `--through` would have dropped the September recap, and `launch_date` Oct 2 would have blocked it. Now the backfill is inclusive and bounded by the family's local today, and `launch_date` waits for ship day.
- **Keepsakes:** the viewer gate becomes films-only; the body is restructured into one scroll; the tests and Maestro are updated deliberately.
- **Calendar:** film-only days are pressable, and jumps align to the film row.
- **Views:** insert-ignore for `year_film_views` (a merging upsert lacks the grant); a views query feeds "New".
- **Backfill tooling:** the script flag, a dry run returning rows, the billing gate, and shared scope math with `year_film_due`.
- **Drawer:** the client changes are listed; `actor_is_former` is false for a NULL actor; the `get_family_activity_v2` name protects old builds; the prune claim is dropped; unread is a boolean.
- **Push:** the recognized routes and the client type are updated, and the family switches before opening.
- **Player:** create-once + `replaceAsync`; legacy `createDownloadResumable`; the typed analytics map.
- **Posters:** stable `cacheKey`, a 6 h poster TTL, 50 per call chunked.
- **Dates:** the full TS/test/doc edit list; the `DAYS_AFTER` script side effect is stated; the year-end load note.
- **Environment:** prerequisites and who runs what.
- **Small items:** the book year for unbounded books; an honest upcoming-card gate; surfaced-only in the app (no owner early preview); batch signing refuses forced films; the short-first-scene guard.

**Round 2 (Sonnet, failure modes), 11 findings, all applied:**
- **Jumps:** the anchored `interleaveFilms` rule (`d <= anchorDate`) makes a month or day jump show its recap; `alignTargetId` comes from the merged rows; the films query is prefetched and alignment waits for it.
- **Scheduler:** `year_film_due` keeps its structure (constants only); the backfill has its own candidate function with a pgTAP parity sweep.
- **Redo tools:** `--requeue-all`, `--delete-backfilled`, `--only` for a smoke subset.
- **Backfill precondition:** the new Worker (bundles `_shared`) and the new image must be live, with a checked poster.
- **Thumbs:** `poster_thumb.jpg` for lists.
- **TTL:** the poster TTL is 60 min, and the list drops blocked films on refetch.
- **Unread:** `get_family_activity_unread_v2`; v1 explicitly excludes `film_ready`.
- **`notifications_due` CTE:** alias-qualified, same signature, pgTAP.
- **Audio:** audio mode + pause other audio.
- **`launch_date`:** a pre-flight check (the hard-stop date was later replaced by the launch runbook, since the owner set no dates).
- **Minor:** the `extract ::int` cast; `billing_write_allowed(family, owner)`; poster query keyed per film; the share cache sweep; the title from the film's own family; OTA to 1.4.2 if shipped.
