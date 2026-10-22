# Birthday film on the morning of the birthday

**Status:** implemented locally 2026-10-22 (not deployed) (owner decisions 2026-10-22) · supersedes the "+2 days"
timing in [year-film.md §4.1](year-film.md) and [year-film-p2.md](year-film-p2.md)

## Goal

A child's birthday film is made overnight and delivered at **07:00 owner-local
on the birthday itself** (push + drawer + Timeline/Keepsakes), covering the
age-year that ends that morning. It ends on the "Happy second birthday, Leo."
close with a corner "Momora." wordmark (the greeting-card idea was dropped; see
Owner decisions). Films already made
keep their existing scope and placement.

## Owner decisions (2026-10-22)

- **Morning only.** No second "add the party" re-render. The film covers the
  previous birthday through the **day before** this birthday. A party held
  after the birthday is not in the film; that trade-off is accepted (it reverses
  the 2026-09-27 "party footage is the best ending" decision).
- **07:00** owner-local delivery (was 09:00 on birthday + 2).
- **Ending (final decision, after comparing mockups): no greeting card, no
  sign-off.** The film ends on its close scene, titled with the original line
  "Happy {ordinal} birthday, {Name}." (es "¡Feliz cumpleaños, {Name}!"), with a
  small "Momora." wordmark fading in at the bottom-right corner after the
  confetti and a 2-beat hold so the music fades on the wish. The earlier
  greeting-end-card design (greeting card + "With love, the {Family} family"
  sign-off, close retitled "Look how you've grown") is superseded. Accepted
  trade-off: on TikTok/Reels the bottom-right corner sits under the app's
  buttons/caption, so the wordmark is often hidden on shared films.

## Context (current code)

- **Scheduling (SQL).** `public.year_film_due` (last defined in
  `supabase/migrations/20260930120000_year_films_p2.sql` §1) inserts birthday
  rows with `due_date = birthday + 2`, `scope_end_exclusive = due_date`,
  `surface_at = due_date 09:00` owner tz, own-child check at `due_date - 2`,
  created once `local_now >= due_date 00:30`, catch-up window
  `local_now < due_date + 3`. Hourly pg_cron (`'5 * * * *'`,
  `20260929120100_schedule_year_films_cron.sql`) → `schedule-year-films`.
- **Unique key** `year_films_key (family_id, kind, member, scope_start_date)`
  (`20260929120000_year_films.sql:137`) — `scope_start_date` is unchanged by
  this plan, so the new rule can never duplicate a film the old rule made.
- **History backfill.** `public.year_film_candidate_rows` (same P2 migration
  §6) recomputes the same birthday dates (`+ 2`, 09:00). pgTAP
  (`supabase/tests/year_films.sql`, parity sweep ~L765–832) asserts it equals
  what `year_film_due` inserts, including Feb 29 and Dec 30 birthdays.
- **Placement.** `year_films.placement_date` is a STORED generated column:
  `case kind when 'birthday' then scope_end_exclusive - 2 when 'family_month'
  then scope_end_exclusive - 1 else Dec 31 of scope_start_date's year end`
  (P2 §2). Postgres is 17 (`supabase/config.toml`), so
  `ALTER TABLE … ALTER COLUMN … SET EXPRESSION` is available.
- **Keepsakes "coming up" tiles.** `public.keepsake_upcoming_films` (last
  defined in `20261012120000_keepsakes_overview_reveal_gap.sql` §1) hard-codes
  `film_date = scope_end_excl = birthday + 2`. pgTAP in
  `supabase/tests/keepsakes_overview_test.sql` (~L956–1165) pins those dates.
  Its rollback pattern: `supabase/rollbacks/<migration>_down.sql`.
- **App** derives everything from server data (`film_date`, `surface_at`,
  `placement_date`): `src/utils/keepsakes.ts` ("{Name} turns 4 · arrives …"),
  `src/utils/year-films.ts` (`interleaveFilms`, subtitle). No timing logic in
  the app → **no app change, no OTA**.
- **TS scope / celebration.** `BIRTHDAY_FILM_DAYS_AFTER = 1`
  (`supabase/functions/_shared/year-film-eligibility.ts:144`) drives
  `birthdayFilmScope` (endExclusive = birthday + 2) **and** the celebration
  window in `birthdayCelebration`
  (`supabase/functions/_shared/year-film-script.ts:1182`, `withinDays(m.date,
  date, 1, BIRTHDAY_FILM_DAYS_AFTER)`). At runtime the Worker reads the scope
  from the row; `birthdayFilmScope` is used by tests and
  `supabase/scripts/eval-year-film-script.ts:716`.
  `birthdayCelebration` skips a birthday outside `[scope.start,
  scope.endExclusive)`, so with the new scope **this year's birthday is never a
  celebration**; only re-renders of old (+2) rows can still close on a party.
- **Script.** `buildBirthdayScript` (`year-film-script.ts:1255`): close line =
  `strings.birthdayClose(name, ageYear)` ("Happy second birthday, Leo." /
  "¡Feliz cumpleaños, Leo!") for all three close sources (celebration →
  then_now → portraits); then `scenes.push({ type: 'end_card', grid })`.
  `BirthdayInput` has no `familyName`. The holiday script already emits
  `end_card.greeting` / `end_card.from` (`year-film-script.ts:~2172`) with
  `strings.holidayFrom(familyDisplayName(input.familyName))`; `familyName`
  is loaded in `year-film-context.ts` (`rows.family.name`, ~L210) and passed
  only to the holiday plan (~L391). Birthday plan input built at ~L319–345.
- **Renderer.** `film-renderer/assemble.mjs:1081`: `case 'end_card': r =
  HOLIDAY && s.greeting ? holidayEndCard(s, id) : endCard(s, id)`.
  `holidayEndCard` (L903) uses `C.gold` (only in the holiday palette) and puts
  the wordmark in the bottom-right corner 60 px in — fine for a QR-watched
  card, but **birthday films are shared to social apps**, whose bottom ~420 px
  is a keep-out. The file promises (L78) nothing changes when `HOLIDAY` is
  false *for other films* — the birthday card is a deliberate, scoped change.
  Renderer ships as the Fly image `render/year-film-renderer` (Dockerfile
  bundles `film-renderer/`); the Worker (`cloudflare/year-film-worker`)
  bundles `_shared`.

## Steps

### 1. Migration `supabase/migrations/20261022120000_birthday_film_morning.sql`

Header comment explaining the change, deploy order and rollback file. Recreate
(same signatures, security definer, empty search_path, grants re-applied):

1. **`year_film_due`** — copy the current P2 body verbatim, changing only the
   birthday block: `due_date = birthday` (`(m.date_of_birth +
   make_interval(years => y.age_year))::date`), `scope_end_exclusive =
   due_date`, `surface_at = (due_date + time '07:00') at time zone d.tz`,
   own-child check at `due_date` (was `due_date - 2`). Creation at 00:30 and
   the 3-day catch-up window are unchanged. Monthly and year-end blocks
   byte-identical.
2. **`year_film_candidate_rows`** — same three edits in its birthday branch
   (due = birthday, 07:00, own-child at the birthday).
3. **`placement_date`** — new expression:
   `case kind when 'birthday' then case when scope_end_exclusive -
   scope_start_date >= 367 then scope_end_exclusive - 2 else
   scope_end_exclusive end when 'family_month' then scope_end_exclusive - 1
   else make_date(extract(year from scope_start_date)::integer, 12, 31) end`.
   Old rows span 367–368 days (P2, age-year + 2; the short-lived P1 rule's
   birthday + 3 rows span up to 369) → unchanged placement; new
   rows span 365–366 (incl. a Feb 29 child, e.g. 2027-02-28 → 2028-02-29 =
   366) → placed on the birthday.
   **Do not rely on `SET EXPRESSION`** (PG 17 only; `supabase/config.toml`
   is the *local* version, prod is unverified). Use the portable form:
   `drop index if exists public.idx_year_films_family_placement; alter table
   public.year_films drop column placement_date; alter table
   public.year_films add column placement_date date generated always as
   (<expr>) stored; grant select (placement_date) on public.year_films to
   authenticated; create index idx_year_films_family_placement on
   public.year_films (family_id, placement_date desc);`. Before writing it,
   grep migrations/functions/views/policies for any object depending on
   `placement_date` (the only known reference is a comment in
   `20261005120000_family_holiday_film_share.sql`); a dependent view or
   `begin atomic` function would block the drop. The whole migration is one
   transaction, so any failure rolls everything back. pgTAP asserts the grant
   and the index exist afterwards.
4. **`keepsake_upcoming_films`** — copy the reveal-gap version verbatim;
   birthday branch: `film_date = birthday`, `scope_end_excl = birthday`,
   window/`launch_date` comparisons on `birthday`. Update its header comment.
   The existing-row exclusion matches on `scope_start_date`, unchanged.
   **Readiness fix (same function):** today a tile is dropped once a
   non-forced, non-skipped/failed row has `surface_at <= now()`, but the app
   only shows a film once `ready_at is not null`
   (`20260930180000_year_films_remaking_visibility.sql`). A film still
   queued/rendering/in retry at 07:00 would leave an empty slot. Add `and
   f.ready_at is not null` to the `not exists` exclusion so the tile stays
   ("arrives today") until the film can actually be shown. (The new rule has
   ~6.4 h of slack vs ~8.4 h before, so this matters more now.)
5. Rollback `supabase/rollbacks/20261022120000_birthday_film_morning_down.sql`
   restores **only the three function bodies**. It leaves `placement_date`
   alone: the new expression returns the old value for every old-shape row
   and the right value for new-shape rows, so reverting it would only
   misplace any new-rule film (at birthday − 2) and rewrite the table again.

### 2. pgTAP

- Both files declare fixed counts (`select plan(172)` in `year_films.sql:10`,
  `select plan(217)` in `keepsakes_overview_test.sql:11`): recount after the
  edits.
- `supabase/tests/year_films.sql`: birthday due tests (~L76–100) → due on the
  birthday 00:30 (e.g. Enzo Oct 23 → `2026-10-23 04:20Z` = 0, `04:40Z` = 1),
  scope `2025-10-23 → 2026-10-23`, `surface_at` 07:00 local. Re-derive the
  other probes in that block so each keeps its meaning: the idempotent re-run
  (~L93, was `2026-10-26 04:40`) and the out-of-window probe (~L100, was
  `2026-10-25 05:00`) — Oct 25 is now *inside* the 3-day catch-up, so the
  out-of-window probe moves to ≥ Oct 26 00:00 local. Baby case (~L95–97,
  DOB 2025-03-10): first birthday now due 2026-03-10; pick probe instants
  that still test "inside catch-up = 1" and "a week later = 0".
  Placement asserts (~L464–471) for both an old-shape row
  (scope_end = birthday + 2 → placed on birthday), a P1-shaped row (birthday
  + 3 → unchanged, birthday + 1) and a new-shape row; parity
  sweep labels (Feb 29 birthday now due per Postgres interval
  arithmetic, which clamps Feb 29 + n years to Feb 28 in non-leap years, same
  as TS `addYears` — so the "Feb 29 birthday (due Mar 2)" label at ~L828
  becomes "due Feb 28"; read the expected values off the function, don't
  hand-guess;
  the Dec 30 birthday is now due Dec 30 — relabel the ~L831–832 coverage
  assertion and make it cover a birthday whose catch-up window crosses into
  Jan 1); backfill
  expectations (~L874–904: Feb 29 child row `scope_end_exclusive` and
  `surface_at` 07:00 on the birthday). Add asserts that the column grant and
  index survive SET EXPRESSION.
- `supabase/tests/keepsakes_overview_test.sql`: the member table comment and
  fixtures (~L956–967) are written as `birthday today+k → film today+k+2`;
  re-derive so each case still tests the same boundary (in window / last day
  in / one day out / due today / yesterday), now with film = birthday. Add a
  case "row exists, surface_at passed, `ready_at` null → tile stays" and
  "… `ready_at` set → tile gone". Update
  the "two days after the birthday are in scope" stage-3 case (~L1113–1128)
  to "the day before the birthday is the last day in scope" and the
  `film date = scope_end_excl = birthday + 2` assertion.

### 3. TS shared (`supabase/functions/_shared/`)

> **Superseded in part (2026-10-22):** the sign-off, `birthdayGrown` / `birthdayGreeting` strings, `BirthdayInput.familyName` and `BIRTHDAY_END_CARD_SECONDS` items below were dropped; the close keeps `birthdayClose`, carries `wordmark: true`, and the builder budgets `CLOSE_HOLD_SECONDS` — see Owner decisions (Ending).

- `year-film-eligibility.ts`: `birthdayFilmScope` endExclusive = the birthday
  (`addYears(dateOfBirth, ageYear)`); rename `BIRTHDAY_FILM_DAYS_AFTER` →
  `BIRTHDAY_CELEBRATION_DAYS_AFTER = 1` (now only the celebration window, kept
  so re-renders of old +2 rows still find their party); update doc comments.
  Update `year-film-eligibility.test.ts` (L275 rollover test, constant import).
- `year-film-script.ts`:
  - `birthdayCelebration`: use the renamed constant; refresh its comment.
  - Strings (en ~L291, es ~L320): keep `birthdayTitle`; add
    `birthdayGrown(name)` ("Look how you've grown, {name}." / "¡Cuánto has
    crecido, {name}!" — kept short, see renderer step), `birthdayParty(name)`
    ("What a party, {name}!" / "¡Qué fiesta, {name}!") for the celebration
    source (only reachable on old-row re-renders), `birthdayGreeting(name, n)`
    (en "Happy {ordinal} birthday, {name}" using `ORDINAL_EN_LOWER`, fallback
    `${n}th`; es "¡Feliz cumpleaños, {name}!"). Remove `birthdayClose` if
    nothing else uses it (grep first, incl. tests and the Worker).
  - **Sign-off** `birthdaySignOff(familyName, language)` — the onboarding
    default family name is possessive (`defaultFamilyName` in
    `src/utils/onboarding-copy.ts:45` → "Leo's Family", "Leo & Mia's Family"),
    so `familyDisplayName` alone would give "With love, the Leo's family".
    Rules, in order (trim, case-insensitive, straight and curly apostrophes):
    1. Possessive "X's Family" / "X' Family" → en "With love, X's family"
       (keep X's as written, lowercase "family"); es "Con cariño, la familia
       de X" (X without the possessive).
    2. A recognized surname shape — "The X Family", "X Family", "Familia X",
       "La familia X" (i.e. `familyDisplayName` actually stripped something)
       → en "With love, the X family"; es "Con cariño, la familia X".
    3. Anything else (bare "Yi", "Our Home", empty) → en "With love, your
       family"; es "Con cariño, tu familia".
    4. Length cap: if the resulting sign-off is longer than ~34 characters
       (two Caveat lines at the holiday card's 74 px, `fromH = 170`), use rule
       3 instead — a long family name must never overflow the card.
    Tests for each: a 40-character family name, "Leo's Family", "Leo & Mia's Family", "Leo’s Family"
    (curly), "The Yi Family", "Yi Family", "Familia Rivera Soto", "Yi",
    "Our Home", "", both languages. (The holiday film's `holidayFrom` has the
    same possessive problem — out of scope here; flag to the owner.)
  - `BirthdayInput` gains `familyName: string`.
  - `buildBirthdayScript`: close line = `birthdayParty` for `celebration`,
    `birthdayGrown` for `then_now`/`portraits`; end card =
    `{ type: 'end_card', grid, greeting: birthdayGreeting(name, ageYear), from:
    birthdaySignOff(familyName, language) }`.
  - **Length budget.** `estimateSeconds` counts every `end_card` as 3 s
    (`year-film-script.ts:~1003`) but the greeting card is `nb(9)` beats
    (~4.6 s) vs `nb(6)` (~3 s); the holiday builder does not compensate
    either. Leave `estimateSeconds` alone (holiday trimming must not change)
    and, for the birthday builder only, budget `fitLength(scenes,
    MAX_FILM_SECONDS - BIRTHDAY_END_CARD_SECONDS)` with a named constant
    derived from the beat length (9 × BEAT_SECONDS, rounded up) and a comment.
- `year-film-context.ts`: pass `familyName: data.familyName` into the
  birthday plan input (~L338).
- Tests. `year-film-script.test.ts` ~L311/328/529 build
  `birthdayFilmScope('2022-10-17', 4)` (commented "→ 2026-10-19") and seed
  party memories on/after the birthday, asserting a `celebration` close (e.g.
  the "¡Feliz cumpleaños, Tomás!" line ~L406). Just moving the helper would
  push those memories out of scope and break them. So: switch those tests to
  an **explicit old-shape scope** literal (`{ start: '2025-10-17',
  endExclusive: '2026-10-19' }`) — they become the "old row re-render still
  celebrates" coverage, now expecting the party line; add new-scope tests
  (`birthdayFilmScope` → `2025-10-17 → 2026-10-17`): never a `celebration`
  close, then_now and portraits closes use the "grown" line, end card carries
  greeting + sign-off (en/es, ordinal fallback for n beyond the ordinal
  table), and the birthday length budget. `year-film-eligibility.test.ts`
  ~L275–285: the Feb 29 case (`birthdayFilmScope('2024-02-29', 2)` currently
  ends `2026-03-02`) and the `BIRTHDAY_FILM_DAYS_AFTER` assert. Update
  `cloudflare/year-film-worker/test/stages.test.ts` if it pins birthday
  close/end_card shapes or birthday scopes.
- **Share page: no change.** `workers/memory-viewer/src/film.ts`
  (`readEndCard`) reads `end_card.greeting`, but `film_share_tokens` are only
  created for holiday card films (`20261006120000_holiday_cards.sql`);
  birthday films are shared as a downloaded file (`useYearFilmShare`). If
  birthday films are ever tokenised, revisit `shortenFrom`.
- `supabase/scripts/eval-year-film-script.ts`: passes `familyName` and the new
  scope (compiles against the new `BirthdayInput`).

### 4. Renderer (`film-renderer/assemble.mjs`)

> **Superseded in part (2026-10-22):** no `greetingEndCard` generalisation (`holidayEndCard` stays holiday-only); instead a close with `wordmark` draws a corner "Momora." wordmark and a 2-beat hold. The close-title step-down stays. The opt-in sample is `make-sample.mjs --birthday-close` → `film-data/sample-birthday-close`.

- `end_card`: `s.greeting ? greetingEndCard(s, id) : endCard(s, id)` — rename
  `holidayEndCard` → `greetingEndCard`, holiday output byte-identical.
- Non-holiday branch inside it: rule color `C.gold ?? C.rose` (no new palette
  key, so the default palette is untouched for other scenes); **wordmark in
  the social safe area**: for non-holiday, render the plain end card's
  centered "made with Momora." signature (`film.language` aware) with its
  bottom above y = 1500 (1920 − 420); the greeting + rule + sign-off block is
  centered in the band from 180 px to just above the signature, and the
  greeting's font shrinks (same sizing rule as holiday) and the sign-off is
  clamped to two lines (shrink, never overflow) so the whole block fits — check with a long name in es (e.g. "Valentina", "Maximiliano").
  Holiday keeps the corner wordmark and its exact layout.
- **Close title fit.** `close()` sets the title at 128 px from top 310 with
  photos from ~y 700 (≈15 chars/line). Add a size step-down that only kicks in
  when the line would exceed 3 lines at 128 px, so every line that renders
  fine today renders byte-identical (monthly/year/holiday closes unchanged).
- **Sample.** `film-renderer/sample/make-sample.mjs` output
  (`film-data/sample`) is gitignored and is the renderer's parity/benchmark
  fixture (`bench.sh sample`, PSNR baseline) — don't change it. Add an opt-in
  variant (flag, e.g. `--greeting`, writing `film-data/sample-greeting`) with
  a greeting end card, the "grown" close line and a long es name.
- Verify: the renderer package tests (`render/year-film-renderer/test`),
  render the default sample (unchanged) and the greeting variant locally, and
  capture stills of the close and end card for the owner (no real family
  data). Also render the holiday end card path once to prove it is
  unchanged.

### 5. Docs (same change)

- `docs/features/year-film.md`: Overview (L12), "Dates" bullet (L20–22:
  birthday made 00:30 and delivered 07:00 **on the birthday**, scope through
  the day before), placement (L27), Timeline placement note (L66–67), the
  greeting end card + sign-off rules, changelog row 2026-10-22, Database file
  list (add the new migration).
- `docs/TECH_SPEC.md`: `placement_date` row (~L1051), P2 dates paragraph
  (~L1100), keepsakes upcoming birthday rule (~L1446–1451, ~L1462), and the
  due-dates summary (~L3991–3992) → new migration. Year-end 09:00 stays.
- `docs/features/keepsakes.md` (~L143, L160, L168: "birthday + 2", 09:00 for
  birthdays; year-end stays 09:00 Dec 30).
- `year-film-eligibility.ts` doc comment (~L138–144) reworded with the rename.
- Supersede notes (one line → this plan): `docs/plans/year-film.md` §4.1
  (~L91–96), `year-film-p1.md:13`, `year-film-p2.md` date table (~L32).

### 6. Verify

`npm run test:edge`, `npm run test:db` (needs local Supabase/Docker — if
Docker is down, say so; don't claim pgTAP passed), `npm test`,
`npm run typecheck`, renderer tests, Worker tests
(`cloudflare/year-film-worker`). Security checklist (no secrets in diff).

### 7. Deploy (owner runs prod; in this order)

0. Commit first: `render/year-film-renderer/build.sh` refuses a dirty
   `film-renderer/` / `render/year-film-renderer/` tree and tags the image by
   git sha.
1. Renderer image: `build.sh`, push to
   `registry.fly.io/momora-year-film-renderer:<sha>` (see
   `render/year-film-renderer/README.md` ~L95). Inert until step 2 — an old
   Worker never sends `greeting` on a birthday film.
2. Year-film Worker (`cloudflare/year-film-worker`) deployed with
   `--var FILM_RENDERER_IMAGE:<registry image>:<sha>` (the `wrangler.jsonc`
   value is a placeholder; see `docs/plans/holiday-cards-p1.md` ~L479 for the
   exact form). Skipping the image var is the silent failure mode: the new
   script's greeting reaches the OLD renderer, which draws the plain end card
   (close says "Look how you've grown", no greeting anywhere).
   Between steps 2 and 3 an old-rule (+2) row can render with the new copy —
   harmless.
3. `supabase db push` — new dates. Any birthday whose old due date (+2) is
   still ahead but whose birthday is ≤ 2 days past gets made on the next
   hourly run under the new rule (catch-up window), surfaced immediately with
   the new scope; a film already made under the old rule is untouched (same
   unique key). Edge Functions: none change.

   **Before step 3, a forced canary is mandatory**: `npm run year-film:queue
   -- --family <test family> --forced birthday --member <id> --age-year <n>
   --start <previous birthday> --end <birthday> --apply` (end = the birthday,
   NOT birthday + 2 — the script's header example at
   `supabase/scripts/queue-year-film.ts:12–13` still shows the old shape;
   update it in this change), on a test family with a long es family name and
   a long child name. Confirm the render passes (the renderer's lint/layout
   gate fails a film after 3 attempts and a `failed` film is never
   re-inserted) and the film ends on the "Happy Nth birthday" close with the
   corner wordmark (no end card).
4. Post-deploy check (operator): the first new-rule birthday film row has
   `scope_end_exclusive` = the birthday and `surface_at` = 07:00 local; its
   `film_script` ends on a `close` with `wordmark: true` (no `end_card`); the
   rendered video ends on the wish with the corner wordmark. Runbook: if a birthday film ends `failed`, fix and run `npm run
   year-film:queue -- --requeue <film id> --apply`.

No app build or OTA.

## Risks & mitigations

- **Film not ready by 07:00.** Row at ~00:35–01:05 local, ~15 min render,
  6 h of slack. `year_film_notifications_due` only fires for `status =
  'ready'`, so a late film pushes when ready (≤ 14 days). Busy birthdays share
  `max_concurrent_renders = 12`; fine at current scale.
- **Push at 07:00 is early.** Owner decision; gated on `notify_new_memories`
  like today. Owners in :30/:45 timezones get it at the next :05 tick (as
  today).
- **Generated column change** rewrites `year_films` (small table) and must
  keep old placement exactly — pgTAP asserts both shapes and that grant +
  index survive.
- **Parity drift** between `year_film_due`, `year_film_candidate_rows` and
  `keepsake_upcoming_films` — all three change in one migration; the parity
  sweep and keepsakes tests pin them.
- **Remake of an old film** (edit) now ends on its close with the corner
  wordmark instead of the plain end card — acceptable; its scope/party are
  unchanged.
- **Social safe zone** — the corner wordmark sits inside the bottom 420 px
  that TikTok/Reels cover; accepted by the owner (one-line move in
  `assemble.mjs` if it matters).
- **Copy for Spanish families** — es strings reviewed in tests; ordinal is
  dropped in es as today.
- **Default (possessive) family names** — sign-off rules above; never "the
  Leo's family".
- **One-time overlap.** A child's last old-rule film covered
  `[b(N-1), b(N)+2)`; the first new-rule film starts at `b(N)`, so the two days
  after last year's birthday can appear in both films. Accepted.
- **Timeline order.** A film placed on the birthday sorts above every memory
  dated that day (`interleaveFilms`), including the party logged later that
  day. Accepted (it's the day's gift).
- **A deterministic render failure loses that year's film** (3 attempts then
  `failed`, never re-inserted) — sign-off length cap, renderer clamps,
  mandatory long-name canary, `--requeue` runbook.
- **Last-day memories from other timezones.** The pool is cut at generation
  start (~00:35 owner-local on the birthday); a relative west of the owner
  loses part of their "day before". Accepted.
- **Floors without the party days.** 60 moments / 40 visuals / 3 quarters are
  now judged without the birthday and day after; a borderline family may be
  `skipped` where it previously qualified. Accepted.
- **Stale owner timezone.** `year_film_due_families` falls back to UTC for a
  null/invalid `user_profiles.timezone`; with no +2 slack, such an owner gets
  the film at 00:35 UTC (the eve, in the Americas) and an off-hours push.
  Before relying on it, count owners with a null/UTC timezone (read-only
  query) and report the number to the owner.
- **Deploy-order failure** — renderer image var not passed to the Worker →
  plain end card; covered by the post-deploy check.

## Out of scope

- A second "add the party" re-render, or any post-birthday update.
- Changing monthly recap or year-end timing.
- App UI changes (tiles/cards read server dates already).
- Re-rendering or re-dating films already made.
