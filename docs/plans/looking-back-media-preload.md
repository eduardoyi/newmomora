# Looking Back viewer: instant media between frames

## Goal

Advancing to a new frame in the Looking Back package viewer shows the photo/illustration
immediately (no "Loading this photo…" plate) whenever the device has already had a chance
to warm it, and videos start noticeably faster. No server changes.

## Context

Facts the plan relies on (verified 2026-08-12):

- **Signing layer.** All media URLs come from the `get-media-url` Edge Function via
  `getMediaUrls` in `src/services/media.ts`. A client-side coalescer (`media.ts:113`)
  batches same-turn `getMediaUrls` calls into deduped chunks of ≤50 keys
  (`MAX_BATCH_KEYS`, mirrors the server cap), and self-heals omitted keys with bounded
  retries. The coalescer flushes on a microtask because iOS can suspend short timers
  during the first viewer transition; signed URLs expire after 60 min.
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
  keys do not match on the common media→media path, so those frame advances pay a fresh
  Edge Function round trip (typically 300 ms–2 s on device) before the frame leaves its
  `LoadingPlate`, even when the bytes are already on disk. They can already match when the
  current frame is the only keyed frame in the two-frame window (for example media→text
  or a terminal media frame); tests must cover the failing media→media grouping, not assert
  that every possible advance was broken.
- **Videos.** `StoryVideo` (`story-frame.tsx:29-69`) creates its player
  (`createVideoPlayer({ uri, useCaching: true })`) only when the video frame mounts, then
  streams from R2. Only the poster image is warmed today (deliberately — raw video must not
  go through expo-image, comment at `[id].tsx:187`).
- **Package size.** Packages contain 4–10 memories (docs/features/looking-back.md), but a
  media memory can hold 1–10 assets (docs/features/media-memories.md), each contributing up
  to 2 keys per frame. A package can therefore expand to 100 media frames / 200 keys in the
  defensive worst case. A typical package's full key set fits one ≤50-key batch chunk;
  larger sets are chunked into multiple **concurrent** Edge invocations
  (`Promise.all` in `media.ts:245`).
- **Persistence.** The `'media-urls'` query-key base is on the dehydration allow-list
  (`src/lib/query-persistence.tsx:78`) with a cache buster (`PERSISTED_QUERY_CACHE_BUSTER`)
  and 7-day maxAge; persisted entries survive cold starts for offline
  (docs/features/offline.md "Why media-urls is persisted").
- **Player lifecycle rule.** Never release an expo-video player while a mounted view holds
  it; create-once + `replaceAsync` pattern (commit 25ef6be, project memory).
- **Native video preload semantics.** Expo SDK 56 documents that a `VideoPlayer` can fill
  buffers without a `VideoView`, and its intended transition is to attach that **same
  player** to the visible view. `useCaching` is persistent/LRU on iOS and Android, but
  HLS cannot use the cache on iOS. `createVideoPlayer` requires explicit `release()`;
  this plan therefore validates same-player handoff rather than assuming that a second
  player will inherit another player's in-memory buffer. See the
  [Expo SDK 56 video docs](https://docs.expo.dev/versions/v56.0.0/sdk/video/).
- **Video cache identity.** Unlike `expo-image`, the installed `expo-video` API has no
  stable object-key `cacheKey`. A re-signed R2 URL may not hit the previous native video
  cache, so the handoff requires the exact currently signed URI and treats URL refresh as
  a source-replacement/fallback path.
- **Imperative query semantics.** In the installed TanStack Query v5,
  `ensureQueryData(options)` returns any cached data without consulting `staleTime` unless
  `revalidateIfStale: true` is requested. `fetchQuery(options)` returns fresh cached data
  and fetches stale/missing data, which is the behavior this warm-up needs.
- **Imperative image lifetime.** `Image.loadAsync` resolves to an `ImageRef`, a native
  shared object with decoded image memory. Fire-and-forget callers must release that ref
  after the cache fill; warming many frames while retaining refs until GC risks a native
  bitmap spike.
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

### 2. Replace the mismatched prefetch with exact URL warm-up + bounded byte lookahead

Files: `app/(app)/looking-back/[id].tsx`,
`src/hooks/useLookingBackMediaWarmup.ts`

Keep the queue, cancellation and decoded-ref ownership in the dedicated hook; the route
should only provide `frames`, `state.phase`, `state.frameIndex`, and a monotonically
increasing foreground generation from its existing `AppState` listener.

- Delete the current/next `prefetchFrames`/`prefetchKeys`/`prefetchUrls` block
  (`[id].tsx:176-198`) — it is superseded, and its union-key/current-version query is the
  bug (this also fixes the version-mismatch: each frame's keys now sign under ITS OWN
  `memory.updated_at`).
- New warm-up effect/hook that runs as soon as `frames` are built — i.e. during the
  intro/title card, before the user taps Start:
  - **Sign every media frame once:** iterate media-bearing frames in order and call
    `queryClient.fetchQuery(mediaUrlsQueryOptions(frameMediaKeys(frame).queryKeys, frame.memory.updated_at))`
    for every frame **in the same tick** (collect promises; no awaits between issuance).
    Skip frames whose `queryKeys` are empty; calling the current service with `[]` is a
    deliberate server validation error, not a no-op. The batcher coalesces the requests
    into deduped ≤50-key chunks — one Edge invocation for typical packages and concurrent
    chunks for larger ones. `fetchQuery` honors `staleTime`, so fresh entries cost nothing
    while stale persisted signed URLs are renewed. Each entry is **StoryFrame's exact
    future query**, so successfully signed frame mounts have data immediately. Handle every
    `fetchQuery` rejection (for example with a per-frame catch or `allSettled`) so an
    offline warm-up cannot become an unhandled promise rejection. Frame-order issuance
    only *tends to* influence early chunks: the batcher's pending set is module-global
    (`media.ts:132`) and ambient callers (e.g. Timeline thumbs still mounted under the
    viewer route) can share the same-turn flush. Do not build a priority mechanism; the
    load-bearing property is "no new signing call after a completed warm-up", not chunk
    order.
  - Video frames' raw `object_key` is signed as part of their group (it's the frame's
    primary key), so `StoryVideo` mounts with its URL already cached — but it is excluded
    from the byte warm below.
  - **Warm image bytes with a rolling lookahead:** do not decode the whole package at
    once. During the intro, warm the first three media frames; while frame N is active,
    keep the current frame plus the next two media frames queued. This covers normal
    autoplay while bounding waste when a user exits early and bounding the defensive
    100-frame package. Run at most two `Image.loadAsync` operations concurrently and keep
    frame order in the queue. Warming previews-not-originals deliberately narrows the old
    prefetch (which warmed both): StoryFrame renders preview-first and only falls back to
    the original on error, so pre-warming originals is mostly wasted bandwidth.
  - Track in-flight and successfully warmed object keys separately. On success, immediately
    call `imageRef.release()`; the stable `cacheKey` remains the disk-cache identity while
    decoded native memory is not retained by the warm-up. A failed key must leave the
    success set so a later lookahead pass can retry. Swallow failures (offline falls
    through to existing retry/unavailable paths).
  - Give each frames/package generation a run token (or cancellation flag). A superseded
    run may finish its already-issued URL queries, but it must not enqueue more byte loads
    after package reconciliation, access loss, or unmount. Cleanup releases no `ImageRef`
    itself because every successful load releases its ref in the same promise chain.
  - When the foreground generation changes to active, reissue the exact per-frame
    `fetchQuery` calls so a long background interval can renew stale persisted signed URLs;
    do not rely on the frames array changing to trigger this.
- `StoryFrame` keeps its per-frame `useMediaUrls` and retry/self-heal behavior, while
  `ReliableStoryImage` also uses an imperative `Image.loadAsync` confirmation when iOS
  does not replay native image callbacks. Step 3 adds an externally owned video-player
  prop and its lifecycle callbacks. A viewer paused beyond the 50-minute URL freshness
  window may re-sign on resume/mount; normal packages complete in minutes.

### 3. Give the next video a head start with same-player handoff

Files: `src/hooks/useLookingBackVideoPreload.ts` (new manager),
`app/(app)/looking-back/[id].tsx`, and
`src/components/looking-back/story-frame.tsx`

This step is scoped to the sequential Looking Back viewer. Timeline video preloading is a
separate problem because its vertical `FlatList` contains nested horizontal carousels and
currently allows only one visible video player at a time.

- Add a viewer-scoped player manager. While frame N is showing (and during the intro for
  frames 0/1), find the nearest upcoming `video` frame in the next two-frame window. If its
  exact raw-video URL is already present and fresh in the warmed `media-urls` query cache,
  create **one** empty upcoming player with `createVideoPlayer(null)`, install its native
  source listeners, and issue `replaceAsync({ uri, useCaching: true })` for that exact URL.
  Starting empty makes the initial source obey the same native confirmation rule as every
  later replacement; a resolved `replaceAsync` promise alone is never treated as proof that
  the native item is applied.
  Subscribe to that exact query's cache state rather than doing a one-time
  `getQueryData`: accept it only when the query is successful, not invalidated, younger
  than its `staleTime`, and contains the raw object key. This subscription must react when
  asynchronous package signing completes. Configure the player muted and paused, and
  attach no `VideoView` until that frame becomes current. Skip it entirely when the URL is
  not signed yet; the existing URL warm-up owns signing and retry behavior.
- Keep at most one preloaded player in addition to the current visible player. This is a
  maximum of two player instances, not a three-player current/next/next+1 pool. The
  manager must be the sole creator and owner of **all** Looking Back players, including an
  on-demand current-player fallback. Retired-but-not-yet-released players count toward
  the two-player limit; if no slot is available, prioritize the current frame and defer
  the upcoming player until the retired player is safely released. Apply Momora's
  established policy to every manager-owned Looking Back player: an 8-second forward
  buffer on both platforms and a 16 MiB `maxBufferBytes` cap on Android, where that option
  is supported. This prevents the head start from reintroducing the Android memory
  pressure that led to adjacent-player preloading being removed from the media carousel.
- When the frame becomes current, pass the **same `VideoPlayer` object** through
  `StoryFrame` into `StoryVideo` and attach it to the visible `VideoView`. `StoryVideo` must
  accept the manager's player and never create a component-owned fallback. If no manager
  player is available yet, keep the poster/loading state visible until the manager admits
  the current player; a missing preload must never bypass the two-player budget. The
  manager remains the owner of handed-off players; the visible component must not release
  them while its `VideoView` is mounted.
- Assign every attachment a unique lease token. A→B→A navigation may deliver A's old
  detach callback after A has been attached again, so a detach callback may retire only
  its own lease. Never reuse a retiring player until its old native surface is detached;
  release only when the player has no current lease and no preload lease.
- Do not rely on the current one-frame delay alone: the video wrapper currently has a
  300 ms Reanimated `FadeOut`. The default implementation must remove `exiting` from the
  live video wrapper so React cleanup is the native detach boundary. If the visual exit is
  retained, it must instead expose an explicit Reanimated exit-completion callback and wait
  one additional frame before releasing. Route unmount marks attached players retired and
  waits for the same detach handshake; it must not release an attached player immediately.
- Use `replaceAsync` when a manager-owned player needs a new source; never use synchronous
  `replace` in the handoff path. Track `desiredUrl`, `appliedUrl`, and an operation
  generation. Resolve a source replacement only after a matching `sourceChange`/`sourceLoad`
  event, because the `replaceAsync` promise alone does not prove that the native item swap
  is observable yet. A player may only be handed off when its applied URL exactly matches
  the URL used by the current frame. If signing refreshes that URL, replace an unattached
  player asynchronously or discard and recreate it before attachment; keep the poster
  visible during an attached refresh until the matching source renders.
- When `StoryVideo` receives a handed-off player, subscribe to its events before starting
  playback and immediately reconcile `player.status` and `player.duration`. A preloaded
  player may already be `readyToPlay`, so waiting only for a future `statusChange` can leave
  the route paused forever. Reset first-frame state whenever the attachment lease or source
  changes. On iOS, if the detached initial player is already `readyToPlay` but its initial
  source event was not delivered, allow that first source to be admitted from the matching
  ready state; later signed-URL replacements still require exact source confirmation. Treat
  that already-ready handoff as the visual fallback when the surface-scoped first-frame
  callback was emitted before `VideoView` attached.
- Tie the preloaded player to the app lifecycle: release only the detached upcoming player
  when the route backgrounds, while the mounted current player follows the existing pause
  behavior. On foreground, increment the URL warm-up generation and let the manager wait
  for freshly valid query data before recreating the still-relevant upcoming player.
  Release all manager-owned players on route unmount only after their leases detach.
- **Device verification is a hard gate for this step** (see Verification). Measure the
  same-player handoff from player creation → `VideoView` attachment → first-frame render;
  do not infer success from a detached player's `readyToPlay` event or from a second player
  appearing to reuse disk bytes. Ship this step only if startup improves repeatably on both
  iOS and Android and the lifecycle tests pass. Otherwise ship Steps 1–2 without claiming
  faster video startup.

### 4. Tests

- `src/hooks/useMediaUrls.test.ts`: existing assertions stand (API unchanged); add a case
  that `mediaUrlsQueryOptions` produces the same query key / staleTime / gcTime the hook
  uses.
- `src/utils/looking-back-frames.test.ts`: cover `frameMediaKeys` — per-kind
  `queryKeys`/`warmKeys`, preview-else-original selection for photos, raw video exclusion
  from `warmKeys`, hidden-illustration handling.
- `src/hooks/useLookingBackMediaWarmup.test.tsx`: with a real query client and mocked media
  service/image loader, prove every non-empty frame query uses its own version; fresh data
  is reused and stale data fetched; the intro/current lookahead warms only the bounded
  ordered window with concurrency ≤2; raw video keys never reach expo-image; every
  successful `ImageRef` is released; failed loads remain retryable; rejections are handled;
  and a superseded/unmounted run starts no later byte work.
- `src/screen-tests/looking-back-viewer.integration.test.tsx`: replace the old
  "cache-keyed prefetch" assertion with route-to-warm-up wiring (frames, phase and current
  index). This suite mocks `StoryFrame`; it must not duplicate the hook's queue internals.
- **New focused regression test** (e.g.
  `src/components/looking-back/story-frame-cache.integration.test.tsx`): real react-query
  client + mocked `@/services/media`. Run the warm-up against a package's frames, then
  mount the real `StoryFrame` for a later frame and assert it renders its image with
  **zero additional `getMediaUrls` service calls** and no `LoadingPlate` — this is the
  test for the actual bug being fixed.
- `src/components/looking-back/story-frame-video-preload.integration.test.tsx`: compose
  the real video preload controller with the real `StoryFrame`; admit an iOS player whose
  detached ready event precedes attachment, then refresh the signed URL and prove a stale
  `readyToPlay` does not clear the visible loading cover before the matching first frame.
- If Step 3 ships, add focused lifecycle coverage in
  `src/hooks/useLookingBackVideoPreload.test.tsx` and the StoryFrame integration surface:
  one upcoming player maximum; muted and paused before handoff; the exact same player
  object reaches the visible `VideoView`; manager-owned current-player fallback and
  two-player admission; release only after detachment/background/unmount; re-create on
  active; no release of a player held by a mounted `VideoView`; ready-before-mount;
  asynchronous query-cache arrival; duration-only frame changes; signed-URL replacement;
  out-of-order replacements; A→B→A lease reuse; parent/child unmount ordering; and rapid
  navigation cannot double-release.
- `src/services/media.test.ts`: retain the existing batching/error/retry coverage and add
  a regression proving a same-turn batch settles without relying on a native timer callback.
- Full `npm test` as the regression net for the 15 `useMediaUrl(s)` call sites (only the
  internal options extraction touches them).

### 5. Docs

- `docs/features/looking-back.md`: update the media-loading constraint bullet + changelog
  (package-wide URL signing during intro, rolling image-byte lookahead, per-frame signing
  versions, and the video head start only if Step 3 passes its device gate).
- No persistence or offline doc changes needed — query keys and shapes are untouched.

### 6. Verification

- Node 20 (`nvm use 20`): `npm test`, `npx tsc --noEmit`, lint.
- Device check (per the "same drill" workflow — commit only after device confirmation):
  open a package containing photos + videos on a dev build; confirm
  (a) no `LoadingPlate` between warmed frames;
  (b) one `get-media-url` burst at viewer open — one invocation per 50-key chunk, one
  chunk for typical packages (network inspector / Edge logs), allowing only the
  batcher's documented omitted-key self-heal retries — and **no further invocation on
  frame advance after that frame's warm query completed**;
  (c) record current-frame player creation → same-player `VideoView` attachment →
  first-frame-render timings with and without the manager; require a repeatable improvement
  on both iOS and Android before Step 3 ships. Instrument player IDs and create/attach/
  detach/release counts in development diagnostics so the handoff can be audited;
  (d) **sustained autoplay through a package with 2+ videos** — frames auto-advance every
  3.5–9 s, so the one-upcoming-player handoff cycle runs continuously in ordinary playback;
  verify that no more than two players exist at once, watch for handoff/release ordering
  races and decoder exhaustion on a low-end Android device (hard MediaCodec instance
  limits), plus rapid manual back/forward tapping across video frames;
  (e) background/foreground the app mid-package: detached upcoming player released on
  background, mounted current player only paused, relevant upcoming player recreated on
  return, and playback resume behavior unchanged;
  (f) refresh the signed URL between preload and display: the stale player is never
  attached, the replacement uses the current exact URL, and poster/on-demand fallback still
  works;
  (g) after an image warm resolves and its `ImageRef` is released,
  `Image.getCachePathAsync(objectKey)` still resolves and the frame renders offline from
  that stable cache key. This is the native proof that immediate ref release preserves the
  disk warm on both platforms. If it fails, do not retain an unbounded set of refs or ship
  the assumption: keep Step 1's signing fix, and treat a bounded-ref/render-source design
  as a scope check-in.
  Also repeat the native validation in physical iOS and Android release-like builds with
  adjacent video frames, rapid navigation, backgrounding, and a transition from Looking
  Back into Memory Detail. Jest lifecycle tests prove ownership and ordering contracts;
  they cannot prove Android surface safety or cross-player native decoder behavior.

## Risks & mitigations

- **Grouping drift between warm-up and StoryFrame** would silently reintroduce the bug.
  Mitigated structurally: both derive keys from `frameMediaKeys` and query options from
  `mediaUrlsQueryOptions`; the new focused regression test pins the cache-hit behavior.
- **Ambient batch interleaving.** Other screens' `useMediaUrl` calls in the same JavaScript
  turn share the flush and can spread keys across chunks. Harmless beyond chunk-order
  aesthetics; explicitly not worth a priority mechanism.
- **Warm-up bandwidth.** A package has ≤10 memories, but those can expand to 100 media
  frames. Byte warming is therefore a rolling current-plus-two-media-frame window with
  concurrency two, rather than a whole-package decode. Failures are swallowed; offline
  falls through to existing retry/unavailable paths.
- **Player handoff lifecycle.** The manager and `StoryVideo` intentionally share one native
  player. Attachment leases, a real exit-completion signal (or no video exit animation),
  and the existing delayed-release rule prevent the manager from releasing an object while
  an exiting `VideoView` still holds it. If either platform shows a release race, disable
  Step 3 rather than adding a second player at the handoff.
- **Signed-URL video cache identity.** Unlike `expo-image`, `expo-video` has no stable
  object-key `cacheKey` in this API. A re-signed URL may not hit the previous native video
  cache, so the plan only promises same-URL buffer reuse during the active viewer session;
  URL refreshes must fall back safely to poster/on-demand playback.
- **Behavior change: originals no longer pre-warmed for photos.** If a preview 404s,
  StoryFrame falls back to the original with a network fetch — same as today's fallback
  path, minus a rarely-used pre-warm. Accepted to halve warm-up bytes.
- **Signed-URL expiry mid-session.** Unchanged: StoryFrame's bounded refetch/retry
  re-signs just its own group.
- **Imperative population vs. observers.** Entries created by `fetchQuery` have no
  observer until StoryFrame mounts and become GC-eligible after 55 minutes. That is far
  longer than normal package playback, but a viewer left paused for nearly an hour may
  legitimately re-fetch. No change to persistence eligibility (same keys/shapes a mounted
  query would create).

## Out of scope

- Global per-key normalization of the media-URL cache (rejected above; would need its own
  persisted-cache migration).
- Timeline-rail-level byte prefetch (warming packages the user may never open).
- Any change to the `get-media-url` Edge Function or other server code.
- Behavioral changes to other screens.
- Offline download manager / pinning whole packages for offline viewing.
