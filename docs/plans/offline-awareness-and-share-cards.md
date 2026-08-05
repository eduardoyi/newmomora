# Offline Awareness + Memory Share Cards Plan

**Status:** Hardened (3 adversarial rounds: Sonnet correctness, Sonnet failure-modes, Fable holistic) — ready for execution; S0 spike gates workstream S
**Date:** 2026-07-17
**Owner:** Eduardo + Claude
**Build prerequisite:** SATISFIED — app build 1.2.0 already includes the native
modules (`expo-sharing`, `@react-native-community/netinfo`, `react-native-purchases`).
JS-only deps still to add: `@tanstack/react-query-persist-client`,
`@tanstack/query-async-storage-persister`.

Two workstreams. Mostly independent, with ONE real dependency: S4's offline
error handling and share-icon disabled state reuse O1's `useIsOnline` +
messaging pattern — so **O1 is a shared prerequisite for S4** (if S runs
first/parallel, S4 ships a generic network-error toast and picks up the O
integration afterward — declare which at execution time). They also share
`docs/TECH_SPEC.md`. Otherwise parallelizable with file-ownership boundaries.

---

## Decisions already locked (do not relitigate in review)

- Offline: banner + cached reads; expo-image `cacheKey` = R2 object key.
- Share cards: composed SERVER-SIDE (satori + resvg in an Edge Function), streamed
  back (never stored in R2); shared as an image via the native share sheet
  (`expo-sharing`).
- Shareable: text-only, illustrated, and photo memories. Videos NEVER (a mixed
  carousel shares only the currently visible page; if that page is a video, the
  share affordance is disabled).
- Entry points: share icon inside the card next to the comment icon, on BOTH the
  timeline card and the memory detail screen. NOT on the full-screen viewer.
- Card design: simplified in-app card per memory type — no engagement icons, no
  attribution, no emotion chip; the "Momora." wordmark sits where the emotion chip
  would be. Memory date included. Tagged members shown as small portrait circles
  (like the timeline card) WITHOUT name chips.
- Full caption, no truncation: fixed 1080px width, canvas grows as tall as needed
  (bounded in practice — `validateMemoryContent` caps content at 5000 chars →
  worst case ≈ 6000px tall).
- Media aspect ratio preserved exactly like the detail card (persisted
  `aspect_ratio` per asset).
- Permissions: owner/manager always share; viewers share by default, controllable
  via a NEW family-level setting (Settings → Family) editable by owner/manager.
  Enforced server-side, not just hidden client-side.
- Filename: `momora-<mon>-<d>-<yyyy>.png` (e.g. `momora-jun-8-2026.png`).

---

## Workstream O — Offline awareness

**O1. Connectivity foundation.** New `src/lib/connectivity.ts`:
- NetInfo listener → `onlineManager.setOnline(state.isConnected === true &&
  state.isInternetReachable !== false)`; started once from
  `src/components/app-providers.tsx` (alongside the existing focusManager wiring).
- `useIsOnline()` hook via `useSyncExternalStore` over `onlineManager` (subscribe
  API exists) — no separate store.
- Unit tests with a mocked NetInfo module.

**O2. Offline banner.** New `src/components/offline-banner.tsx`, **mounted
around the `(app)` Stack** (not just the tabs) so the pushed memory-detail
screen is covered too. Modal screens (`new-memory`, edit — `presentation:
'modal'` visually covers a layout-level banner on iOS) rely on inline errors
instead (O6/S4 provide them) — this scope is explicit, not an accident:
- Offline: slim banner, theme tokens, copy like "You're offline — showing what's
  saved." On reconnect: brief "Back online" state (~2s) then hide.
- `accessibilityLiveRegion`/`AccessibilityInfo.announce` so screen readers hear
  transitions. No layout jump — check how the fixed calendar header and timeline
  SafeArea interact with an inserted banner (banner renders above both tabs'
  content; verify both screens).

**O3. Reconnect refetch strategy.** react-query refetches stale queries on
reconnect by default (`refetchOnReconnect: true`) — on the infinite timeline that
refetches EVERY loaded page (same v5 behavior we defused for focus in the perf
work). Set `refetchOnReconnect: false` on the infinite list queries
(`useMemories`, `useMemberMemories`) and extend the existing app-foreground
trim-to-page-1 handler in `useMemories` to also fire on offline→online transition
(subscribe to `onlineManager`) when stale. Calendar/detail queries keep defaults
(cheap, windowed).

**O4. Cache persistence (cold-start offline reads).** Add JS deps
`@tanstack/react-query-persist-client` + `@tanstack/query-async-storage-persister`.
- **Persist size discipline (Android hard constraint):** the async-storage
  persister stores the entire dehydrated client under ONE AsyncStorage key, and
  Android throws "Row too big to fit into CursorWindow" on reads over ~2MB —
  writes succeed, restores fail, and heavy users (the feature's target audience)
  silently lose offline cold-start. A deep-scrolled timeline persists every
  loaded page of `select('*')` rows + enrichment. Required: a custom
  `serialize` that trims each InfiniteData entry to its FIRST page before
  persisting (functionally free — restored data is stale-but-visible and O3's
  trim-refresh reconciles from page 1 anyway; this also stops re-serializing a
  giant cache on the JS thread every throttle window during realtime/poll
  patches). Also required: a restore-failure test (corrupt/oversized payload →
  clean empty start, never a crash loop).
- **Persist `media-urls` AFTER ALL** (reverses the earlier exclusion — round-3
  finding): expo-image only consults its disk cache when given a source; on an
  offline cold start an excluded media-urls cache means `useMediaUrl` returns
  undefined and every image renders a placeholder even though O5's cacheKeys
  have the bytes on disk — the two halves of the workstream would cancel out.
  An EXPIRED persisted URL is harmless: with `cacheKey` set, disk-cache hits
  never touch the network, and on a miss it fails identically to having no URL.
  Persist it; exclude only generation-status, memories-search, and auth/session
  queries.
- Swap `QueryClientProvider` → `PersistQueryClientProvider` in app-providers with:
  `maxAge` 7 days; `buster` constant (bump on any cache-shape change — the
  InfiniteData migration is the cautionary tale); `dehydrateOptions.
  shouldDehydrateQuery` allow-list: memories lists (InfiniteData, first page
  only via the custom serialize above), memory detail, calendar ranges +
  oldest-date, family members, portrait versions, family/user profile, AND
  `media-urls` (see above — expired URLs are harmless with cacheKey).
  EXCLUDE: generation-status, memories-search, any auth/session queries.
- Persisted data is keyed inside the query keys by familyId, so family switching
  is naturally scoped. PURGE the persisted cache on: sign-out, account deletion,
  and leaving/being removed from a family — find the existing central sign-out
  path (auth service/hook) and family-leave flows; add
  `clearPersistedQueryCache()` there. A device handed to another user must never
  cold-boot into the previous family's memories.
- Restore semantics: hydrated data is stale-but-visible; normal staleness rules
  then apply (foreground/reconnect trim-refresh reconciles).
- **Restore gate:** app-providers holds children on the splash until restore
  completes (`useIsRestoring()` / PersistQueryClientProvider `onSuccess` gate) —
  restore from AsyncStorage is fast (<100ms typical); this removes the
  empty-state flash risk instead of "verifying" it. Note the family-membership
  query is a second async gate (`useMemories` is `enabled` on familyId) — it's
  on the persist allow-list, so cold-start offline resolves it from cache too.
- **Recovery/backfill effects must not run on restored data.** The illustration
  recovery effect (`useMemories.ts` ~542) is time-based
  (`needsIllustrationRecovery`) — a 7-day-old restored row stuck at
  `generating` looks stale even if the server finished long ago, and the current
  code unconditionally re-patches the cache to `pending` after
  `retryMemoryIllustration` returns non-error EVEN when the service no-opped on
  an already-`ready` row — a "finished illustration flashes back to pending"
  bug that persistence turns from a rare race into a routine cold-start event.
  Two required changes: (a) gate the recovery AND emotion-backfill effects on
  `query.isFetchedAfterMount` (only evaluate rows that came from a real network
  read this mount, never from hydration alone), and (b) make
  `retryMemoryIllustration` report whether it actually dispatched a retry, and
  only patch pending-in-cache when it did. Tests for both.
- Tests: dehydrate filter (included/excluded keys), purge-on-signout, buster
  invalidation, restore gate (no empty-state flash), recovery-not-run-on-hydrated-data.

**O5. expo-image cacheKey.** Signed URLs rotate hourly, and expo-image caches by
URI, so cached bytes are orphaned on every re-sign — offline (and cache hit-rate
generally) improves by keying the cache on the stable object key. Add a small
helper (e.g. `mediaImageSource(url, objectKey)` returning
`{ uri, cacheKey: objectKey }`) and apply at every expo-image site that renders
R2 media: memory-card visuals, media carousel, calendar `MemoryStamp`,
member-profile `MemoryThumb`, family avatars/portraits, full-screen viewer.
Triage criterion for the ~23 files importing `expo-image`: a site gets
`cacheKey` if and only if its `uri` is an R2 signed URL (i.e. sourced from
`useMediaUrl(s)`/`getMediaUrl`); sites rendering local `file://` URIs
(onboarding capture/reveal, pending-upload cards, pickers) must NOT get one.
Verify `recyclingKey` interplay in lists (carousel already uses recyclingKey?
check). Tests where components have them; visual smoke on device.
Note (verified in rounds 2+3): illustration regeneration, portrait versions,
and media edits all mint FRESH object keys per attempt, so `cacheKey =
objectKey` can never pin stale bytes in current flows — keep it that way (add
a constraint note in the feature doc: never overwrite media in place under a
reused key). **Also fix the stale comment at `src/hooks/useMediaUrls.ts:5-8`
in the same change** — it claims regenerated illustrations reuse the same R2
key, which is false today and directly contradicts this invariant; left
standing, a future agent may "restore" in-place overwrites believing it's the
established pattern.

**O6. Offline mutation UX.**
- **networkMode decision (load-bearing — wiring onlineManager flips a hidden
  default):** react-query v5 mutations default to `networkMode: 'online'`; today
  nothing sets `onlineManager`, so mutations never pause. The moment O1 wires
  NetInfo, EVERY `useMutation` in the app (useMemories, useMemoryEngagement,
  useUserProfile, usePortraitVersions, useMemberManagement, useContentSafety,
  use-billing, useFamilyMembers, useFamilyInvites) would silently switch to
  pause-and-replay: `mutateAsync` hangs offline, then fires later — spinners
  never resolve, posts fire after the user gave up. Decision: set
  `networkMode: 'always'` as the MUTATION default in `src/lib/query-client.ts`
  (queries keep `'online'` semantics — pausing queries offline is exactly what
  we want). Mutations then fail fast with a network error, matching the UX
  below. Add a test pinning the default.
- new-memory Save while offline: friendly inline error ("You're offline — your
  draft is safe; try again when you're back"). Draft autosave already protects
  the content; no queuing of text posts in this pass.
- Pending media-upload queue: auto-retry on reconnect is REAL state-machine
  work, not a subscribe-and-call-retry: the queue's `failed` state
  (`use-pending-memory-uploads.tsx`) carries no failure cause, and
  content-safety rejections / validation / usage-limit failures land in the
  same state — blind auto-retry would re-fire doomed posts and double-count
  `memory_save_failed` analytics. Required: tag failures with a cause at
  failure time (minimum: `isNetworkFailure: boolean` derived from the error),
  auto-retry ONLY network-caused failures, once per reconnect. Manual
  Retry/Discard unchanged. Tests: network failure retries once; safety-rejected
  item does NOT auto-retry.

**O7. Background machinery.**
- `useGenerationStatusPolling`: `refetchInterval` callback returns `false` while
  offline (read `onlineManager.isOnline()`); the existing wake mechanism (hosts
  re-render on cache patches, and the banner/connectivity hook re-renders hosts
  on reconnect) must be verified to wake the poll — add a reconnect-wake test.
- Realtime: supabase-js reconnects the socket itself; verify our channel's
  `SUBSCRIBED`-reconcile (already built) fires after an offline gap — that's the
  catch-up path. No new code expected; add/extend a test if the seam allows.

**O8. Docs.** New `docs/features/offline.md` (template-conformant): behaviors,
what is/isn't available offline, purge rules, cacheKey rationale, extension guide.

---

## Workstream S — Memory share cards

**S0. GATING SPIKE — CPU-cap feasibility (do this FIRST, before any S work).**
Supabase Edge Functions enforce a per-request **CPU-time cap (~2s)** — the
binding constraint for a pure-CPU compose, and the plan's worst case (5000-char
caption → ~1080×6000px canvas ≈ 26MB RGBA fill + PNG deflate in resvg-wasm,
which runs 3-5× slower than native, + satori shaping + photo decode) plausibly
exceeds it — failing precisely on the longest, most-loved memories. Deploy a
stub function composing the TRUE worst case (5000-char caption + photo + 6
portraits + emoji) to real infrastructure and measure; this same deploy verifies
the vendored WASM rides `--use-api`. **SPIKE COMPLETE — DECISION MADE (Eduardo, 2026-07-17): reduced raster scale.**
Measured (two rounds, realistic assets): failures are `WORKER_RESOURCE_LIMIT`
(memory) tracking PIXEL COUNT, not caption length or photo bytes; ~87.5%
per-attempt success at ≤~2.5M px, 37.5% at 5.5M px; no warm isolates ever
observed. Locked mitigation: cards whose 1080-wide layout exceeds ~2.5M total
pixels render the identical layout at 720px width (full caption always — the
no-truncation lock holds); client auto-retries ONCE on HTTP 546 (~98%+
effective success); residual single-attempt failures are an infra ceiling —
flag to Supabase support if share volume makes it matter.

**S1. Migration + types + spec.** `families.viewer_sharing_enabled boolean NOT
NULL DEFAULT true`. Regenerate/hand-write `src/types/database.ts` (match generated
style; Docker likely down). Update `docs/TECH_SPEC.md` (schema + new function
contract) in the same change. RLS: column rides existing families row policies
(members can SELECT; UPDATE policy already restricts to owner/manager).
**Grant layer (do not skip): the subscription-hardening migration
(`20260801170000_paid_subscription_sol_hardening.sql:227-229`) REVOKED
table-level UPDATE on `families` and granted column-level `update (name)` only —
RLS alone will not make the toggle writable.** The migration must also
`grant update (viewer_sharing_enabled) on public.families to authenticated;`
(column-level, consistent with the existing pattern), and the integration test
must exercise the actual UPDATE (grant + RLS), not just the policy.

**S2. Settings toggle.** Settings → Family section: "Viewers can share memories"
switch, visible/editable for owner/manager only (follow the existing family
rename/manage patterns in `app/(app)/(tabs)/settings.tsx` + family service/hook).
Optimistic update + rollback like neighboring toggles. Tests — including the
billing-lockout case: the families UPDATE policy requires
`billing_write_allowed_for_current_user`
(`20260801170000_paid_subscription_sol_hardening.sql:83-87`), so a
lapsed-subscription owner CANNOT flip this toggle; the settings row's error
handling must expect that (consistent with family rename).

**S3. Edge Function `compose-share-card`.**
- Deno + satori (JSX→SVG) + `@resvg/resvg-wasm` (SVG→PNG). **Vendoring
  mechanism (CORRECTED by the S0 spike — the original `Deno.readFile` approach
  does NOT work):** under `--use-api` deploys, local files outside the executing
  module graph are archived but never mounted — `Deno.readFile` 404s on
  everything (even `index.ts`), `readDirSync` is blocklisted, and
  `fetch(import.meta.url)` fails. The ONLY proven channel is the module graph
  itself: base64-encode each binary asset (resvg `.wasm`, each font TTF, the
  NotoEmoji subset) into its own `.ts` module (`export const X_B64 = '...'`)
  and statically import them; decode + `initWasm` once at module scope. The
  spike's working implementation is at
  `supabase/functions/compose-share-card-spike/` — reference it. Vendor
  font TTFs under `supabase/functions/_shared/fonts/` (Newsreader regular+medium, Plus Jakarta
  Sans regular+semibold/bold — match `src/constants/theme.ts` `fonts` usage on the
  card; add Caveat ONLY if the simplified card uses the script font). Licensing:
  all Google Fonts (OFL) — fine to vendor.
- Auth: user JWT → memory lookup → member of memory's family (reuse
  `_shared/family-access.ts` helpers). Role check: viewer + family's
  `viewer_sharing_enabled = false` → 403. Non-members → 404/403 as per existing
  conventions.
- **Rate limiting (repo convention — follow `analyze-emotion`'s "run too
  recently" 429 `rate_limited` pattern):** per-user cooldown (e.g. a handful of
  composes per minute) — this is the most CPU-expensive user-triggered endpoint
  in the project and must not be hammerable. Client maps 429 to a friendly
  toast. Row in the Deno test matrix.
- **Logging discipline (AGENTS.md high-risk rule — log ids and status codes
  ONLY):** the raw caption flows through satori, whose layout errors can embed
  text-node content in `error.message`. Wrap compose in a catch-all that logs
  `memoryId` + a status/code, NEVER the error message verbatim on layout paths.
  Test: layout-failure path asserts the logged string contains no caption text.
- **Reject `audio` and unknown memory types explicitly** (audio is specced but
  unshipped — docs/features/audio-memories.md); extension guide notes what a
  shareable audio card would need.
- Input `{ memoryId, mediaAssetId? }`: for media memories, `mediaAssetId` is
  REQUIRED and must belong to the memory; reject video content types
  (`isVideoContentType` equivalent server-side). For photo assets load the
  PREVIEW variant (`preview_object_key`, fall back to `object_key` for legacy
  rows). Illustrated memories load `illustration_key`. Text-only loads no media.
- Layout: replicate the simplified in-app card at 1080px width: image block height
  = 1080 / `aspect_ratio` (fallback when `aspect_ratio` is null — legacy rows: decode intrinsic
  dimensions via `npm:image-size` on the fetched bytes; pure-JS, Deno-compatible
  — name the dependency, don't hand-roll header parsing); full caption below in the
  card's text style (no truncation); memory date formatted like the app card;
  tagged-member portrait circles (small, overlapping row like the timeline card,
  from `illustrated_profile_key`/portrait-version keys — resolve via the same
  member portrait logic the card uses, simplified: current portrait only); the
  "Momora." wordmark (Newsreader medium text + primary-colored period — replicate
  `src/components/wordmark.tsx`, it is text, not an SVG asset) in the emotion-chip
  slot. Rounded corners + card background per theme tokens; loud cross-reference
  comments in BOTH `memory-card.tsx` and the function's layout file ("keep in
  sync").
- Text-only memories use the quote-style card variant; media/illustrated use the
  spread variant (mirror `SpreadCard`/`QuoteCard` split in `memory-card.tsx`).
- Emoji in captions: satori does not rasterize color emoji from system fonts.
  **Decision (privacy-driven, review round 3): vendor a monochrome NotoEmoji
  subset TTF** rather than fetching twemoji SVGs at compose time — the CDN fetch
  would leak caption-derived data (emoji codepoints per request) to a
  third-party's logs, the only place in the pipeline where memory-derived
  content would leave Supabase/R2/OpenAI. Monochrome emoji on the card is the
  accepted tradeoff; documented in the feature doc's privacy section. DO NOT
  ship tofu boxes silently.
- Output: `image/png` response streamed to the caller. No R2 writes anywhere
  (keeps this function entirely out of the storage-authorization/deletion
  machinery). Content-Disposition filename `momora-<mon>-<d>-<yyyy>.png`
  (pretty name); **the client's temp file adds a short memory-id fragment**
  (`momora-jun-8-2026-<id6>.png`) so two same-date shares can't clobber each
  other mid-share in `cacheDirectory`.
- Cold-start cost: satori + resvg-wasm init once per isolate (module scope);
  compose target < ~1.5s warm.
- Deno tests: authz matrix (owner/manager/viewer×toggle/non-member), video
  rejection, asset-ownership rejection, aspect math, layout snapshot of the SVG
  string for each memory type (cheap, catches drift), filename header.

**S4. Client share flow.**
- Share icon (SF Symbol / Material equivalent via existing icon approach) added
  to `MemoryEngagementBar` next to the comment icon, behind a new optional prop so
  ONLY timeline cards + detail screen render it (bar is also used elsewhere —
  verify call sites; full-screen viewer must not show it).
- Visibility/enabled rules: hidden entirely when role is viewer AND family
  `viewer_sharing_enabled` is false. Exposing the flag is a SERVICE-layer change,
  not just a hook read: `useFamily()`'s `family` object is currently `{ id,
  name }` and `fetchMyFamilyMemberships` (`src/services/family.ts`) doesn't
  select the column — extend the select, the membership types, and the hook's
  exposed shape (plus its tests); disabled (dimmed) when the current carousel page is a
  video; normal otherwise. **Current-page tracking is NET-NEW work on both
  surfaces** — today `memory-media-carousel.tsx` keeps `activeIndex` as local
  state surfaced only via tap (`onPress(activeIndex)`); neither
  `memory-card.tsx` nor the detail screen receives page changes. Add an
  `onActiveIndexChange` callback **driven from the carousel's existing
  `handleScrollEnd` path** (it already unifies `onMomentumScrollEnd` +
  `onScrollEndDrag` → `setActiveIndex`, `memory-media-carousel.tsx` ~487 — hook
  there, or the lifted index lags drags that end without momentum; never
  per-frame `onScroll`), lift the index in both parents, and pass the current
  page's `mediaAssetId` to the share handler. Own sub-task + tests
  (page change updates the shared asset; video page disables the icon).
- Tap flow: icon shows a spinner state → **raw `fetch()` to the function URL**
  (`${SUPABASE_URL}/functions/v1/compose-share-card`, manual `Authorization:
  Bearer <session access token>` + `apikey` headers) — do NOT use
  `supabase.functions.invoke`: the installed `@supabase/functions-js` has no
  binary branch for `image/png` and falls through to `response.text()`, which
  destroys the bytes (verified in its FunctionsClient source; even
  `application/octet-stream` only yields a Blob, which RN can't hand to the
  filesystem without extra hops). From the fetch: `response.arrayBuffer()` →
  base64 → `writeAsStringAsync(cacheDirectory + filename, b64, {encoding:
  Base64})` using **`expo-file-system/legacy`** (the default `expo-file-system`
  export in SDK 56 has NO `cacheDirectory` — every existing file-write in this
  repo already imports `/legacy`; follow them) → `Sharing.shareAsync(fileUri,
  { mimeType: 'image/png' })`. Errors: offline → reuse O's messaging pattern
  (toast/inline); **403 specifically → "Sharing is currently off for this
  family" AND invalidate the family-membership query** (the viewer's cached
  `viewer_sharing_enabled` can be stale — persisted up to 7 days — so the icon
  must actually disappear after the server says no); other server errors →
  non-blocking generic toast. Clean up the temp file
  opportunistically (best-effort delete after share resolves; cacheDirectory is
  OS-managed anyway).
- Note: `Share` (RN built-in) is NOT used — `expo-sharing` is required for
  cross-platform file sharing (Android).
- Tests: engagement-bar prop gating, visibility matrix, video-page disabled,
  current-page asset id passed, share flow with mocked function/FS/Sharing,
  filename formatting util unit test.

**S5. Docs.** New `docs/features/memory-sharing.md` (behaviors, permission
matrix, card layout contract + keep-in-sync warning, function contract, privacy
section incl. the vendored-emoji rationale, extension guide). Update
`docs/features/likes-and-comments.md` (engagement bar gained an icon), TECH_SPEC
(S1), **and the scope statements in AGENTS.md + PRD §7** ("no social sharing /
watermarked exports" is now shipped scope — left stale, future agents will read
share cards as a scope violation).

---

## Sequencing & verification

O and S are independent; within O: O1 → O2/O3/O6/O7, O4 after O3, O5 anytime.
Within S: S1 → S2/S3 → S4 → S5.

Per-workstream gate (Node 20 via `.nvmrc`): `npx tsc --noEmit`, `npm test`,
`npm run test:edge` (S3 + any function touches), lint on touched files. Device
smoke: airplane-mode pass for O (banner, cached timeline, cold-start restore,
reconnect recovery); share pass for S (each memory type, carousel current-page,
video disabled, viewer toggle both states — needs two test accounts).

Deploy steps (after user device-testing, with explicit user go-ahead): S1
migration `supabase db push`; S3 function `supabase functions deploy
compose-share-card --use-api`.

## Risks

- PersistQueryClientProvider changes provider topology — the restore gate must
  not flash empty states (verify `isRestoring` handling on timeline/calendar).
- Persisted caches can contain rows the user no longer has access to (role
  changed while offline) — acceptable: server refetch reconciles on reconnect;
  purge rules cover the hard cases (sign-out/leave).
- satori fidelity: fonts/letter-spacing/line-height won't be pixel-identical to
  RN — acceptance bar is "unmistakably the same card", not pixel parity.
- Very long captions produce tall PNGs (bounded ≈6000px) — messaging apps
  downscale; acceptable, documented.
- `MemoryEngagementBar` is shared UI — the new icon must not disturb existing
  layouts/tests where it's hidden.
