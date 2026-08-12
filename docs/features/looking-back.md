# Feature: Looking Back

**Status:** `in-progress`
**Last updated:** 2026-08-12
**PRD reference:** [Journey C](../PRD.md#journey-c--revisit), [§6.5](../PRD.md#65-memory-organization)

## Overview

Looking Back gives each household a quiet, daily rail of deterministic archive
packages. A package opens into the approved story-like viewer; it is a
read-only way to revisit four to ten older memories, never a streak or capture
prompt.

## User-facing behavior

- The Timeline shows the warm-plate **Looking back** rail only when at least
  one safety-visible package still has four memories.
- The top of a populated Timeline is ordered as date/title, **This week**,
  **Looking back**, then **Recently** and the normal memory feed.
- Packages are stable for one family-local day. Viewed state is personal.
- Package titles are recipe-specific: birthday packages use
  `[Name]’s birthday, through the years`, pair packages use `Moments with [X] &
  [Y]`, emotion packages use `The funny ones` or `Tiny troublemakers`, age-zero
  packages use `From [Name]'s first year`, month packages use `From [Month YYYY]`,
  and mixed archive packages use `A little look back`.
- The viewer opens with a title card and an explicit **Start** button. Starting
  begins the memory carousel unpaused; memory frames then auto-advance and
  support tap navigation, hold pause, Open memory, completion and replay.
- Opening memory detail pauses at the current frame and resumes on Back. A
  package opened again from the Timeline always begins from its intro.
- Screen readers use explicit controls and no automatic advance. Reduce Motion
  keeps state/timing while replacing movement with fades.
- Package retrieval is optional: empty, unavailable or unauthorized results
  leave the normal Timeline intact.

## Architecture

```mermaid
flowchart LR
  T[Timeline rail] --> H[useLookingBackPackages]
  H --> R[get_or_create_looking_back_packages]
  R --> P[Daily package tables]
  H --> V[Viewer route]
  V --> C[Session checkpoint]
  V --> D[Memory detail]
  V --> O[Personal view outbox]
```

The server materializes daily package metadata only. The client fetches the
referenced memories through normal RLS, filters local content-safety state and
turns multi-asset media memories into consecutive viewer frames.

## Data model

| Table | Role |
|---|---|
| `looking_back_daily_sets` | Immutable family-local daily sentinel, including empty days |
| `looking_back_packages` | Package recipe/display metadata |
| `looking_back_package_memories` | Ordered memory membership |
| `looking_back_package_views` | Account-specific opened/completed timestamps |

All family-owned rows use `is_family_member(family_id)` RLS. Direct writes are
not granted; view state is written through the RPC.

## API & Edge Functions

| Function | Input | Output | Auth |
|---|---|---|---|
| `get_or_create_looking_back_packages` | `p_family_id` | Stable package metadata / empty sentinel | Exact family membership |
| `mark_looking_back_package_viewed` | package id, completion flag | Own view timestamps | Exact package-family membership |

There is no Edge Function, AI call, cron or new storage bucket.

## Client integration

| Layer | Files | Responsibility |
|---|---|---|
| Hook/service | `src/hooks/useLookingBackPackages.ts`, `src/services/looking-back.ts` | RLS-safe daily data, outbox and cache merge |
| Timeline | `app/(app)/(tabs)/timeline.tsx`, `src/components/looking-back/package-*.tsx` | Rail and warm-plate cards |
| Viewer | `app/(app)/looking-back/[id].tsx`, `src/components/looking-back/story-*.tsx` | Playback, media frames, accessibility, detail round trip |
| Media warm-up | `src/hooks/useLookingBackMediaWarmup.ts`, `src/hooks/useLookingBackVideoPreload.ts`, `src/hooks/useMediaUrls.ts`, `src/utils/looking-back-frames.ts` | Package-wide per-frame URL signing, bounded image-byte lookahead, and viewer-scoped same-player video handoff |
| Session | `src/hooks/useLookingBackSession.tsx` | Ephemeral checkpoint that survives native-stack remount |

### How to invoke from another feature

1. Use `lookingBackPackageRoute(packageId)`; never put memory content or a
   playback state in route parameters.
2. Before navigating to a detail route from the viewer, persist a session
   checkpoint.
3. Invalidate the Looking Back query after memory deletion/update; do not
   mutate a materialized daily set after a same-day memory create.

## Constraints & gotchas

- Package sizes are 4–10 memories, four packages maximum, and cooldowns are
  enforced by the materialization RPC.
- Birthday packages appear on a member's birthday with a three-day grace
  window. They select memories tagged with that member within ±7 days of the
  birthday anniversary in prior years (including the adjacent anniversary year
  when the window crosses December/January), require at least four memories
  across two years, choose one memory per available year before filling the
  package, and outrank the generic `on_this_day` recipe.
- Pair packages require both subjects to be tagged on each memory. They select
  one unordered family-member pair per daily set, allow additional tags, and
  use deterministic archive sampling with the normal 90-day eligibility and
  cooldown rules.
- `emotion_archive` is one rotating thematic slot. Its candidates are exact
  existing emotion labels (`funny` or `mischief`), so it produces either `The
  funny ones` or `Tiny troublemakers`, never both in the same daily set.
- When at least four eligible memories remain, one daily slot is reserved for
  `archive_mix` before the lower-priority month/written fallbacks. Its first
  ten candidates use deterministic age-band quotas: up to four newer
  historical memories (90 days–18 months), three medium memories (18–36
  months), and three deep-archive memories (36+ months). Missing bands are
  backfilled from the remaining eligible archive rather than making the rail
  empty.
- A daily set contains at most one package per recipe type. When multiple
  `member_at_age` candidates qualify, a member not featured by that recipe in
  the preceding three days ranks first; this is a soft preference, not a
  requirement that every household have multiple members.
- Viewer photos prefer the generated display preview, retry transient signed
  URL/image failures twice, then fall back to the original before showing the
  unavailable plate. Photo readiness accepts a successful mounted-image load,
  an imperative `Image.loadAsync` cache confirmation, or a native display
  callback, which covers iOS cache paths that do not replay the display
  callback. Videos retain their stored first-frame poster (or a runtime
  thumbnail for legacy rows) under a loading indicator until the player renders
  its first frame or an already-ready detached handoff is attached.
- The viewer signs every media frame during the intro with StoryFrame's exact
  key grouping and owning-memory `updated_at` version. It warms the first three
  media frames during the intro, then the current plus next two media frames
  while playing, with at most two image loads in flight. Only previews (or a
  photo original without a preview), illustrations, and video posters enter
  the byte warm; raw video objects never go through `expo-image`. Successful
  `ImageRef`s are released immediately after the cache fill. The viewer-scoped
  video manager owns both the visible player and at most one upcoming player,
  uses the exact fresh signed URL, and hands the same native player to the
  visible `VideoView`; its production release remains gated on repeatable
  physical iOS/Android evidence for native surface and decoder safety.
- The client must not expose reported content through a package cover or
  viewer. A hidden illustration falls back to text.
- The personal pending-view AsyncStorage outbox is durable across offline
  refetches and must be cleared at sign-out/family access loss.
- The approved handoff archive and visual checklist live in
  [`docs/design/looking-back`](../design/looking-back/README.md).

## Testing

### Unit tests

| File | Covers |
|---|---|
| `src/utils/looking-back-frames.test.ts` | Text/video dwell bounds; hidden-illustration cover exclusion; later-photo selection after an unpostered video; and legacy video text-plate fallback. |
| `src/hooks/useLookingBackPlayback.test.ts` | Pause/reason ownership, progress, explicit unpaused intro start, final-frame tap completion, completion/replay, checkpoint clamping, stable-frame reconciliation, and an immediate pause/checkpoint mid-frame regression. |
| `src/hooks/useLookingBackSession.test.tsx` | Frozen snapshot tombstones, access-loss cleanup, and stable frame identity through a detail-style reconciliation |
| `src/components/looking-back/package-card.test.tsx` | Text and revisited-card treatment, delayed press/open behavior, later-photo cover selection, and legacy raw-video text fallback. |
| `src/components/looking-back/cover-artwork.test.tsx` | Signed safe-illustration cover rendering and emotion-print fallback after an illustration report. |
| `src/components/looking-back/story-frame.test.tsx` | Video `readyToPlay`, ready-before-mount visual handoff, stored-poster loading treatment and authoritative duration correction; preview-first photos; display/load readiness; bounded signed-URL/image retry with original fallback; single-surface image fade; and calm unavailable fallback. |
| `src/hooks/useLookingBackVideoPreload.test.tsx` | Exact fresh-query admission, asynchronous signing, initial ready-state source fallback, one-upcoming/two-player admission, same-player intro handoff, muted/paused configuration, duration-only frame stability, signed-URL replacement ordering, background release, and lease-safe A→B→A/unmount cleanup. |
| `src/hooks/useMediaUrls.test.ts` | Stable query key/freshness options shared by mounted and imperative media-URL callers. |
| `src/hooks/useLookingBackMediaWarmup.test.tsx` | Per-frame URL versions, fresh/stale query behavior, ordered three-frame lookahead, two-load concurrency, raw-video exclusion, reference release, retryable failures, handled rejections, and superseded-run cancellation. |
| `src/components/looking-back/story-progress.test.tsx` | Equal-width slide segments regardless of dwell time, with memory-level accessible progress units. |

### Integration tests

| File | Scenarios |
|---|---|
| `src/services/looking-back.integration.test.ts` | Empty sentinel and malformed/authorization RPC handling, row ordering, idempotent view completion, and pending-view outbox merge, acknowledgement, expiry, and bounds. |
| `src/hooks/useLookingBackPackages.integration.test.tsx` | Account/family cache isolation, safety and four-memory threshold filtering, historical portrait/profile safety, optional-rail failures, refresh/online/offline reconciliation, and viewed/completed optimistic outbox behavior. |
| `src/screen-tests/looking-back-timeline.integration.test.tsx` | Date/title → This week → Looking back → Recently ordering, `Revisited today`, fresh-session reset before snapshot/route navigation, and rail omission when no package is eligible. |
| `src/screen-tests/looking-back-viewer.integration.test.tsx` | Route-mounted explicit Start flow, warm-up hook wiring, unpaused media readiness, video readiness/viewed marking, frozen-snapshot report/block reconciliation, fail-closed safety and deep-link states, checkpoint/background/access loss, detail pause/resume, close-once paths, package-name completion copy, screen-reader controls, pause/caption/tap navigation, and video metadata. |
| `src/components/looking-back/story-frame-cache.integration.test.tsx` | Regression coverage for a warmed later frame, a first visible photo mounted concurrently with package signing, and a first photo whose native callbacks are omitted but imperative image loading completes, verifying no extra URL signing or permanently stuck LoadingPlate. |
| `src/components/looking-back/story-frame-video-preload.integration.test.tsx` | Composes the real video preload controller with StoryFrame to verify the iOS ready-before-attachment handoff and exact signed-URL refresh boundary. |
| `src/components/offline-banner.test.tsx` | Offline and two-second back-online clearance signal used by the full-screen viewer |

### Database and performance tests

| File | Covers |
|---|---|
| `supabase/tests/looking_back_packages.sql` | Materialization, empty sentinel stability, birthday windows/titles/year spread, pair matching/titles/subject integrity, funny/mischief emotion recipes, age-balanced archive-mix quotas, missing-band backfill, slot reservation/release, package-cap safety, same-day age-band refilling, cooldowns, one-package-per-recipe daily variety, subject rotation, current emotion vocabulary, timezone/DST/leap-day behavior, RLS/RPC authorization, direct-write denial, cascades, and same-family composite FKs |
| `supabase/tests/looking_back_packages_concurrency.sh` | Guarded isolated-only test using two independent `psql` sessions: advisory-lock waiting, one sentinel, and stable package order |
| `supabase/tests/looking_back_packages_benchmark.sh` | Guarded isolated-only 10,000-memory `EXPLAIN (ANALYZE, BUFFERS)` benchmark; run with the explicit local opt-in shown in its header |
| `supabase/scripts/run-looking-back-maestro.sh` | Guarded seed/run/cleanup harness for a fixed synthetic account, real local-only media bytes, and exact four-memory/five-frame mixed package; rejects hosted URLs and the default local ports |
| `supabase/scripts/looking-back-maestro-storage.ts` | Fixed-key local R2 helper that uploads/verifies and exactly deletes one repo WebP plus a generated JPEG and MP4 |

On the isolated local schema (2026-08-08, JIT disabled), the benchmark measured
**274.281 ms / 5,475 shared-buffer hits** for first materialization and
**1.620 ms / 70 hits** for an existing frozen-set retrieval. These are local
baselines, not production SLOs.

### E2E (Maestro)

| Flow | Scenario |
|---|---|
| `.maestro/flows/looking-back/package-viewer.yaml` | Executable dev-build flow: logs in as the synthetic fixture account, opens the fixed package, explicitly starts it, verifies hold-without-advance, same-frame detail round-trip, real illustration/photo/video frame testIDs, ordered `1 of 2` photo / `2 of 2` video chapter markers, exact five-frame completion, replay, close, and `Revisited today`. |

The fixture runner only accepts an explicitly opted-in `127.0.0.1` Supabase
stack on nondefault API and Postgres ports. It refuses the CLI defaults
(`54321`/`54322`), hosted URLs, mismatched `.env.local` client configuration,
non-loopback `supabase/.env.local` R2 endpoints, and collisions with its fixed
fixture IDs. The seeded account is
`looking-back-maestro@example.test`; its password is supplied at runtime and
is never printed. It also seeds a synthetic entitlement inside that isolated
database so normal post-login routing reaches the Timeline.

The public upload URL endpoint intentionally does not accept generated-memory
illustration keys. The harness therefore uses the production R2 byte helpers
through `looking-back-maestro-storage.ts`, guarded by a second explicit R2
opt-in and an exact loopback endpoint. It uploads a non-personal onboarding
WebP as the ready illustration, a JPEG generated from the app icon as the
photo, and a 320×320, one-second H.264 MP4 generated from the same icon (matching
the seeded `aspect_ratio = 1.0` and `duration_ms = 1000`). Setup verifies
all three stored byte lengths and then fetches all three through the
authenticated local `get-media-url` path. Cleanup authenticates the fixed
account when its rows exist, deletes only the three fixed R2 keys, and only
then removes DB/Auth rows. If object cleanup fails, rows remain so cleanup can
be retried; neither tokens, credentials nor presigned URLs are printed.

Start an isolated Supabase stack and its `get-media-url` Edge Function on custom
ports, plus a loopback R2-compatible object store. Put the client URL and anon
key in `.env.local`, put the matching local R2 credentials/endpoint in
`supabase/.env.local`, restart Metro/the installed dev build against that
environment, then run the full seed → Maestro → cleanup lifecycle (cleanup also
runs on a test failure):

```bash
LOOKING_BACK_E2E_ALLOW_ISOLATED=1 \
LOOKING_BACK_E2E_R2_ALLOW_ISOLATED=1 \
LOOKING_BACK_TEST_DB_URL=postgresql://postgres:postgres@127.0.0.1:55422/postgres \
EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:55421 \
EXPO_PUBLIC_SUPABASE_ANON_KEY='<matching isolated anon key>' \
LOOKING_BACK_E2E_PASSWORD='<synthetic local password>' \
  bash supabase/scripts/run-looking-back-maestro.sh run
```

For fixture inspection, replace `run` with `seed`. It prints a machine-readable
`TEST_EMAIL`, `LOOKING_BACK_PACKAGE_ID`, `LOOKING_BACK_MEMORY_COUNT`,
`LOOKING_BACK_FRAME_COUNT`, and first-frame text (but no credentials). The
four-memory/five-frame fixture contains text, a ready illustration, an ordered
photo-plus-video media chapter, and a long-text fallback. Always clean an
inspected fixture with:

```bash
LOOKING_BACK_E2E_ALLOW_ISOLATED=1 \
LOOKING_BACK_E2E_R2_ALLOW_ISOLATED=1 \
LOOKING_BACK_TEST_DB_URL=postgresql://postgres:postgres@127.0.0.1:55422/postgres \
EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:55421 \
EXPO_PUBLIC_SUPABASE_ANON_KEY='<matching isolated anon key>' \
LOOKING_BACK_E2E_PASSWORD='<same synthetic local password>' \
  bash supabase/scripts/run-looking-back-maestro.sh cleanup
```

## Changelog

| Date | Change |
|---|---|
| 2026-08-12 | Balanced `archive_mix` across newer historical, medium, and deep archive bands with deterministic 4/3/3 quotas, reserved one daily slot when viable, and covered the fallback/slot behavior in pgTAP |
| 2026-08-12 | Added birthday-through-the-years, member-pair, and rotating funny/mischief archive recipes with name-safe subject metadata and database coverage |
| 2026-08-12 | Added a viewer-scoped `expo-video` manager for one-upcoming same-player handoff, exact signed-source replacement, two-player admission, and lease-safe detach/release; physical iOS/Android validation remains the production gate |
| 2026-08-12 | Hardened first-open media readiness for iOS: already-ready detached players can complete the initial handoff when native source events are omitted, and imperative image loading covers cache paths that omit display callbacks |
| 2026-08-11 | Viewer-scoped media warm-up now signs every frame with its own URL-cache version, shares exact frame key grouping with StoryFrame, and uses a bounded two-concurrent rolling image lookahead; raw videos remain excluded from expo-image and the detached-player experiment stays gated on device evidence |
| 2026-08-09 | Added first-year age-zero titles, month-specific archive titles, and `A little look back` for mixed archive packages; kept completion copy grammatical for titles beginning with `From` |
| 2026-08-08 | Replaced the passive intro instruction with explicit unpaused Start; added bounded preview/original image recovery and video-poster loading treatment; changed completion copy to name the package; and limited daily selection to one package per recipe with soft age-subject rotation |
| 2026-08-08 | Removed the nested Timeline header bottom safe-area inset that created an oversized Android gap before the first Recent memory |
| 2026-08-08 | Android stabilization: Timeline section order, preview-backed photo recovery, reliable intro/detail pause ownership, single media fade, fresh reopen, final-frame completion, equal-width progress, and simplified completion copy |
| 2026-08-08 | Initial implementation in progress |
