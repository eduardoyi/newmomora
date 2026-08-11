# Looking Back viewer: instant media between frames

## Goal

Advancing to a new frame in the Looking Back package viewer shows the photo/illustration
immediately (no "Loading this photo…" plate) whenever the device has already had a chance
to warm it, and videos start noticeably faster. No server changes.

## Context

Facts the plan relies on (verified 2026-08-10):

- **Signing layer.** All media URLs come from the `get-media-url` Edge Function via
  `getMediaUrls` in `src/services/media.ts`. A client-side coalescer (`media.ts:113`)
  batches every `getMediaUrls` call made within a 25 ms window into deduped chunks of
  ≤50 keys (`MAX_BATCH_KEYS`, mirrors the server cap), and self-heals omitted keys with
  bounded retries. Signed URLs expire after 60 min.
- **React-query layer.** `useMediaUrls(keys, cacheVersion)` in `src/hooks/useMediaUrls.ts`
  creates ONE query per call keyed on `['media-urls', sortedKeys.join('|'), cacheVersion]`,
  `staleTime` 50 min, `gcTime` 55 min. `cacheVersion` is the owning row's `updated_at`
  (URL-freshness bust on edits; bytes never change under a key). Two calls share a cache
  entry only when their key *grouping* and version match exactly.
- **Byte layer.** expo-image disk cache is pinned to the stable R2 object key via
  `mediaImageSource(url, objectKey)` (`src/utils/media-image-source.ts`), so bytes cached
  once are reusable across screens and across URL re-signs. Object keys are never reused
  or overwritten (invariant documented in `useMediaUrls.ts` and `media-image-source.ts`).
- **The viewer today.** `app/(app)/looking-back/[id].tsx:176-198` prefetches images for the
  current + next frame with `Image.loadAsync(mediaImageSource(url, key))` — bytes land in
  the right cache slot. But the prefetch query uses the UNION of both frames' keys with the
  CURRENT frame's `memory.updated_at`, while `StoryFrame`
  (`src/components/looking-back/story-frame.tsx:202-211`) queries its OWN key subset
  (primary + preview + video poster) with its OWN frame's `memory.updated_at`. The query
  keys can never match, so **every frame advance pays a fresh Edge Function round trip**
  (typically 300 ms–2 s on device) before the frame leaves its `LoadingPlate`, even when
  the bytes are already on disk.
- **Videos.** `StoryVideo` (`story-frame.tsx:29-69`) creates its player
  (`createVideoPlayer({ uri, useCaching: true })`) only when the video frame mounts, then
  streams from R2. Only the poster image is warmed today (deliberately — raw video must not
  go through expo-image, comment at `[id].tsx:187`).
- **Package size.** Packages contain 4–10 memories (docs/features/looking-back.md), but a
  media memory can hold 1–10 assets (docs/features/media-memories.md), each contributing up
  to 2 keys per frame. A typical package's full key set fits one ≤50-key batch chunk; a
  worst-case multi-asset package can exceed 50 keys, in which case the batcher silently
  chunks into multiple sequential Edge invocations (`media.ts:245`).
- **Persistence.** The `'media-urls'` query-key base is on the dehydration allow-list
  (`src/lib/query-persistence.tsx:78`) with a cache buster (`PERSISTED_QUERY_CACHE_BUSTER`)
  and 7-day maxAge; persisted entries survive cold starts for offline
  (docs/features/offline.md "Why media-urls is persisted").
- **Player lifecycle rule.** Never release an expo-video player while a mounted view holds
  it; create-once + `replaceAsync` pattern (commit 25ef6be, project memory).
- **Call sites.** 15 non-test files consume `useMediaUrl`/`useMediaUrls` (timeline cards,
  memory detail, carousel, portraits, onboarding reveal, Looking Back, calendar,
  full-screen viewer, avatars). Single-key callers (timeline thumb → memory detail)
  already share cache entries because they pass the same key + same `updated_at`; only
  multi-key groupings fragment.

### Alternative considered and rejected: global per-key cache normalization

An earlier draft refactored `useMediaUrls` internals to per-key `useQueries` entries so
that *any* grouping shares per-key cache slots. Review killed it for this task:

- The per-key query key `['media-urls', key, version]` is **byte-identical to the query
  key existing single-key callers persist today**, but with a different data shape
  (`string` vs `Record<key, url>`). Hydrating old persisted entries under the new reader
  silently corrupts every single-key image lookup for up to 50 min after an OTA update —
  avoidable only by bumping `PERSISTED_QUERY_CACHE_BUSTER` (discarding the offline cache
  that persistence exists to protect) or by keeping the Record shape everywhere.
- It forces re-deriving placeholder retention, combined `refetch` identity/timing,
  errored-key semantics, and a full test rewrite under 15 production call sites — all to
  make one screen's lookups hit.

The viewer-scoped design below achieves the identical user-visible outcome with none of
that surface. If cross-screen per-key dedup is ever wanted, ship it as its own change with
an explicit persisted-cache migration story.

## Steps

### 1. Extract shared query plumbing (no behavior change)

Files: `src/hooks/useMediaUrls.ts`, `src/components/looking-back/story-frame.tsx`,
`src/utils/looking-back-frames.ts`

- In `useMediaUrls.ts`, export `mediaUrlsQueryOptions(keys, cacheVersion)` returning the
  exact `{ queryKey, queryFn, staleTime, gcTime }` the hook builds today, and make
  `useMediaUrls` consume it. Public API, query keys, data shapes, and all 15 call sites
  unchanged; persistence untouched.
- Extract a `frameMediaKeys(frame)` helper (natural home: `looking-back-frames.ts`)
  returning, for a `LookingBackFrame`:
  - `queryKeys`: the exact deduped key list StoryFrame queries today
    (`illustration_key` for illustration frames; `object_key` + `preview_object_key` for
    photo/video frames — mirror `story-frame.tsx:202-210` exactly), and
  - `warmKeys`: the subset safe to byte-warm through expo-image — photo
    `preview_object_key` when present else `object_key`, illustration key, video
    `preview_object_key` (poster). **Never a raw video `object_key`.**
- Switch `StoryFrame` to derive its keys via `frameMediaKeys(frame).queryKeys`. Warm-up
  and StoryFrame now share one source of truth, so their query groupings can never drift.

### 2. Replace the current/next prefetch with a whole-package warm-up

File: `app/(app)/looking-back/[id].tsx` (hook may live inline or as
`src/hooks/useLookingBackMediaWarmup.ts`)

- Delete the current/next `prefetchFrames`/`prefetchKeys`/`prefetchUrls` block
  (`[id].tsx:176-198`) — it is superseded, and its union-key/current-version query is the
  bug (this also fixes the version-mismatch: each frame's keys now sign under ITS OWN
  `memory.updated_at`).
- New warm-up effect that runs as soon as `frames` are built — i.e. during the intro/title
  card, before the user taps Start:
  - **Sign everything once:** iterate frames in order and call
    `queryClient.ensureQueryData(mediaUrlsQueryOptions(frameMediaKeys(frame).queryKeys, frame.memory.updated_at))`
    for every frame **in the same tick** (collect promises; no awaits between issuance).
    The batcher coalesces all of it into deduped ≤50-key chunks — one Edge invocation for
    typical packages. `ensureQueryData` respects `staleTime`, so already-fresh entries cost
    nothing, and each entry is **StoryFrame's exact future query**, so every subsequent
    frame mount is a cache hit with `isLoading` false. Frame-order issuance means the
    first chunk *tends to* cover the earliest frames, but this is **best-effort only**:
    the batcher's pending set is module-global (`media.ts:132`) and ambient callers (e.g.
    Timeline thumbs still mounted under the viewer route) firing within the same 25 ms
    window share the flush. Do not build a priority mechanism; the load-bearing property
    is "no per-frame invocation on advance", not chunk order.
  - Video frames' raw `object_key` is signed as part of their group (it's the frame's
    primary key), so `StoryVideo` mounts with its URL already cached — but it is excluded
    from the byte warm below.
  - **Warm image bytes:** as each frame's `ensureQueryData` promise resolves, call
    `void Image.loadAsync(mediaImageSource(url, key)).catch(() => {})` for each of that
    frame's `warmKeys` with a resolved URL. Warming previews-not-originals deliberately
    narrows the old prefetch (which warmed both): StoryFrame renders preview-first and
    only falls back to the original on error, so pre-warming originals is mostly wasted
    bandwidth. Guard with a per-key "already warmed" ref set so re-renders don't re-issue
    `loadAsync`; swallow failures (offline falls through to existing retry/unavailable
    paths).
- `StoryFrame` behavior is otherwise untouched: its per-frame `useMediaUrls` call now hits
  the warmed cache, and its `refetch`-based retry/self-heal (`MissingMediaRetry`,
  `ReliableStoryImage`) keeps working unchanged — including the signed-URL-expiry edge
  (session > 60 min re-signs just that frame's group).

### 3. Give the next video a head start

Files: `app/(app)/looking-back/[id].tsx` (small hook, e.g. `useUpcomingVideoWarmup`)

- While frame N is showing (and during the intro for frames 0/1), if the upcoming frame in
  the two-frame window is a `video` frame whose URL is already in the warmed cache, create
  ONE detached warm-up player: `createVideoPlayer({ uri, useCaching: true })`, muted, never
  played, no `VideoView` ever attached. Release it when the window moves past that frame or
  on unmount — safe under the shared-object release rule precisely because no mounted view
  ever holds it.
- Tie the warm player to the app lifecycle: release it in the same `AppState` listener that
  already pauses playback on backgrounding (`[id].tsx:256-265`) — a detached player must
  not keep a decoder session and network fetch alive in the background. Re-warm (if still
  relevant) on return to `'active'`.
- When the frame becomes current, `StoryVideo` creates its own player with the same URI and
  `useCaching: true`; expo-video's cache serves the already-buffered head, cutting time to
  `readyToPlay`.
- At most one warm player alive at a time; skip entirely when the URL isn't signed yet.
- **Device verification is a hard gate for this step** (see Verification). If cache reuse
  between two player instances does not measurably help on iOS/Android dev builds, fall
  back to lifting player creation into the viewer and passing the pre-created player to
  `StoryVideo` as a prop (create-once pattern per commit 25ef6be) — and treat that as a
  scope check-in, not a silent pivot. The rest of the plan does not depend on this step.

### 4. Tests

- `src/hooks/useMediaUrls.test.ts`: existing assertions stand (API unchanged); add a case
  that `mediaUrlsQueryOptions` produces the same query key / staleTime / gcTime the hook
  uses.
- `src/utils/looking-back-frames.test.ts`: cover `frameMediaKeys` — per-kind
  `queryKeys`/`warmKeys`, preview-else-original selection for photos, raw video exclusion
  from `warmKeys`, hidden-illustration handling.
- `src/screen-tests/looking-back-viewer.integration.test.tsx`: update the existing
  "cache-keyed prefetch" scenario to the package-wide warm-up: all `warmKeys` warmed via
  `Image.loadAsync` with `cacheKey` = object key; raw video keys never handed to
  expo-image; per-frame versions used. Note this suite mocks both `StoryFrame` and
  `useMediaUrls` outright (lines ~53/63), so it asserts warm-up inputs, not cache-hit
  behavior.
- **New focused regression test** (e.g.
  `src/components/looking-back/story-frame-cache.integration.test.tsx`): real react-query
  client + mocked `@/services/media`. Run the warm-up against a package's frames, then
  mount the real `StoryFrame` for a later frame and assert it renders its image with
  **zero additional `getMediaUrls` service calls** and no `LoadingPlate` — this is the
  test for the actual bug being fixed.
- `src/services/media.test.ts`: unchanged (batcher untouched).
- Full `npm test` as the regression net for the 15 `useMediaUrl(s)` call sites (only the
  internal options extraction touches them).

### 5. Docs

- `docs/features/looking-back.md`: update the media-loading constraint bullet + changelog
  (package-wide warm-up during intro, per-frame signing versions, video head start).
- No persistence or offline doc changes needed — query keys and shapes are untouched.

### 6. Verification

- Node 20 (`nvm use 20`): `npm test`, `npx tsc --noEmit`, lint.
- Device check (per the "same drill" workflow — commit only after device confirmation):
  open a package containing photos + videos on a dev build; confirm
  (a) no `LoadingPlate` between warmed frames;
  (b) one `get-media-url` burst at viewer open — one invocation per 50-key chunk, one
  chunk for typical packages (network inspector / Edge logs) — and **no further
  invocations on frame advance**;
  (c) video `readyToPlay` is subjectively faster with the warm player than without
  (toggle the hook to compare);
  (d) **sustained autoplay through a package with 2+ videos** — frames auto-advance every
  3.5–9 s, so the warm-player create/release cycle runs continuously in ordinary playback;
  watch for create/release ordering races and decoder exhaustion on a low-end Android
  device (hard MediaCodec instance limits), plus rapid manual back/forward tapping across
  video frames;
  (e) background/foreground the app mid-package: warm player released on background,
  playback resume behavior unchanged.

## Risks & mitigations

- **Grouping drift between warm-up and StoryFrame** would silently reintroduce the bug.
  Mitigated structurally: both derive keys from `frameMediaKeys` and query options from
  `mediaUrlsQueryOptions`; the new focused regression test pins the cache-hit behavior.
- **Ambient batch interleaving.** Other screens' `useMediaUrl` calls in the same 25 ms
  window share the flush and can spread keys across chunks. Harmless beyond chunk-order
  aesthetics; explicitly not worth a priority mechanism.
- **Warm-up bandwidth.** ≤10 memories per package, previews (not originals) warmed — the
  added transfer approximates what viewing the package downloads anyway, just earlier.
  Failures are swallowed; offline falls through to existing retry/unavailable paths.
- **expo-video cache reuse between player instances is unverified.** Hard device gate in
  Step 3 with a documented fallback (pass the pre-created player down). Steps 1–2 land
  independently.
- **Behavior change: originals no longer pre-warmed for photos.** If a preview 404s,
  StoryFrame falls back to the original with a network fetch — same as today's fallback
  path, minus a rarely-used pre-warm. Accepted to halve warm-up bytes.
- **Signed-URL expiry mid-session.** Unchanged: StoryFrame's bounded refetch/retry
  re-signs just its own group.
- **`ensureQueryData` population vs. observers.** Entries created by `ensureQueryData`
  have no observer until StoryFrame mounts; with `gcTime` 55 min they cannot be
  garbage-collected mid-session. No change to persistence eligibility (same keys/shapes a
  mounted query would create).

## Out of scope

- Global per-key normalization of the media-URL cache (rejected above; would need its own
  persisted-cache migration).
- Timeline-rail-level byte prefetch (warming packages the user may never open).
- Any change to the `get-media-url` Edge Function or other server code.
- Behavioral changes to other screens.
- Offline download manager / pinning whole packages for offline viewing.
