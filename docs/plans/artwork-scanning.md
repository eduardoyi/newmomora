# Artwork scanning ("Artworks")

**Status:** implemented on branch `artwork-scanning` (worktree `~/Coding/Momora2-artwork`, uncommitted) 2026-10-10. Pending: Phase 0 device spike + medium eval, Android native compile, merge with audio-trim, then the rollout gates. Nothing deployed.

## Goal

A parent can tap a new **Scan** button in the new-memory composer, scan 1–10
of their child's drawings using the platform's native document scanner (edges
auto-detected and perspective-corrected), and save them as a `media` memory
flagged as **artwork**. The memory renders inside a drawn picture frame and mat
on the Timeline card and on the memory detail screen. An AI-suggested
**medium** chip (crayon, watercolor…) takes the emotion chip's place. Everything
else reuses the existing composer: tagging = artist, caption = title (optional),
tagged-member age = age at creation, memory date = scan date (today; editable).

## Product decisions (owner-approved 2026-10-10 — do not re-litigate)

1. Entry point: a scan button in the composer toolbar next to the mic and the
   attach-media button. No separate flow or screen.
2. Artist = existing family tagging. Title = existing optional caption, shown
   as normal caption text (not quoted). Age at creation = the existing
   tagged-member age row on detail (`formatTaggedMemberAge`), not a new label.
3. AI-suggested medium = a new axis on the existing `analyze-memory` pass (same
   async, best-effort model as emotion). Not user-editable in v1 (emotion isn't
   either). On artwork memories the medium chip **replaces** the emotion chip
   (Timeline footer and detail meta footer). Emotion is still computed and
   stored (books/films/gradient use it).
4. Memory date = scan date (composer default "today"); no capture-date prefill.
5. No mixing: an artwork memory contains only scanned images — no library
   photos, no videos, no kept audio clip. A regular media memory can't get
   scans added.
6. Batch scanning: one scan session → one memory with up to 10 pieces
   (`MAX_MEMORY_MEDIA_ASSETS`), shown as a carousel inside one frame.
7. Frame + mat drawn in code (no bitmap), on Timeline card + detail only. The
   full-screen viewer shows the bare scan. Every other surface (calendar
   stamp, family profile grid, widget, share card, books, film, holiday cards,
   Looking Back, search) treats artwork as a normal photo memory in v1.
8. Android gallery import inside the scanner is disabled (parity with iOS).
9. Frame rendering ships via OTA to every live runtime at publish time. The scan
   button only appears on binaries that include the native scanner.
10. No dedicated frame design pass; build it directly.

## Preconditions

- **In-flight audio trim/import work must land first.** As of 2026-10-10 the
  working tree holds uncommitted work from another session
  (`docs/plans/audio-trim-import.md`):
  - `supabase/migrations/20261013120000_memory_media_waveform.sql` redefines
    `replace_memory_media_assets` and adds `memory_media.waveform`
  - edits to `src/types/database.ts`, `src/services/memories.ts`,
    `src/services/memory-posting.ts`, `src/hooks/use-pending-memory-uploads.tsx`,
    `src/services/ai.ts`, `src/utils/memories.ts`
  - `modules/momora-audio/`

  This plan touches several of the same files. Implementation starts only
  after that work is committed (or on a worktree branched after it). The
  artwork migration sorts after `20261013120000`. It does **not** redefine
  `replace_memory_media_assets` (see 1.1), so it has no dependency on that
  function's body.
- **Owner decision 2026-10-10:** build all phases now on a separate branch in
  a git worktree off `main`, without the audio-trim working-tree changes, and
  merge with audio-trim later (expect conflicts in the shared files above;
  resolve them in favour of audio-trim's structure, then re-apply artwork).
  Still name the artwork migration with a timestamp after `20261013120000`.
  Nothing ships (no prod migration, no function deploy, no OTA, no store
  build) until audio-trim has landed and the merge is resolved and
  device-verified.
- **Store build:** the scanner joins audio-trim's 1.5.0 build if it is
  device-verified before 1.5.0 is cut; otherwise it goes in the next version.
- Line numbers below are approximate (that diff shifts them). Anchor on
  function names.

## Context (current code the plan relies on)

- **Memory types:** `MemoryType = 'text_illustration' | 'text_only' | 'media' | 'audio'`
  (`src/utils/memories.ts:24`), `deriveMemoryType` (`:394`),
  `MAX_MEMORY_MEDIA_ASSETS = 10` (`:48`). Composers hard-code `10`.
  DB invariant `memories_type_invariants`, latest in
  `supabase/migrations/20260819120000_audio_memories.sql:49-68`.
- **Full-row fetches are `select('*')`** (`src/services/memories.ts`:
  `fetchMemoriesPage`, `fetchMemoryById`, `fetchMemoriesInDateRange`,
  `fetchMemoriesPageForMember`, `fetchMemoriesByIds`), so new `memories`
  columns reach `MemoryWithTags` after type regen.
  **Partial-row cache patch paths do NOT carry new columns automatically:**
  - `fetchMemoryGenerationStatuses` selects only illustration fields,
    `emotion` and `updated_at`; it is consumed by `applyStatusPatches` in
    `src/hooks/useGenerationStatusPolling.ts`.
  - `useMemoriesRealtime` patches a whitelist (illustration fields, `emotion`,
    `updated_at`, `link_previews`, `content`).
  - After posting, `use-pending-memory-uploads.tsx` calls
    `setMemoryEmotionInCache` (emotion only) and invalidates the list with
    `refetchType: 'none'`.
  So analysis results only reach Timeline cards through those patches.
- **Column-level grants:** `20260801170000_paid_subscription_sol_hardening.sql:230-235`
  revoked table-level insert/update on `memories` and re-granted specific
  columns to `authenticated` (audio later added
  `grant insert/update (audio_transcript)`). Any new client-inserted column
  needs its own `grant insert`.
- **Composer:** `app/(app)/new-memory.tsx` (`NewMemoryScreen`), edit
  `app/(app)/memory/[id]/edit.tsx`, shared body
  `src/components/memory-composer-form.tsx` (toolbar at lines 313–338: mic,
  then caller-supplied `toolbarMediaButton`, then `toolbarTrailingSlot`).
  Attachment type `MediaAttachment` (`src/components/memory-media-picker.tsx:29-43`).
  New-memory state `attachedMedia` + `appendMedia` (slices to 10); the AI toggle
  hides when `hasMediaRegion` (`new-memory.tsx:714`). Voice modal
  `captureMode={isAudio ? 'keepOnly' : 'fork'}` (`:883`), modes
  `'dictate' | 'fork' | 'keepOnly'` (`src/components/voice-speak-it-modal.tsx:72`).
  `TYPE_CONFIGS` badge keys in new-memory (:77–84) and edit (:41–48).
  The composer form is also used by `src/components/gallery-import/gallery-import-approval.tsx`.
- **Save path (new):** the media branch of `handleSave` (`new-memory.tsx:633-670`)
  calls `enqueuePendingMemoryUpload` →
  `src/hooks/use-pending-memory-uploads.tsx` `runUpload` → `postMediaMemory`
  (`src/services/memory-posting.ts:458`) = `uploadMemoryMediaAssets` (:225) +
  `createMediaMemory` (`src/services/memories.ts:1304`, hard-codes
  `memory_type: 'media'`) → `continueCreateMemoryWithMedia` →
  `replace_memory_media_assets` RPC (latest
  `20260820100000_audio_memory_media_rpc.sql`). After posting:
  `runMediaPhotoEmotionAnalysis` (image assets present).
- **Save path (edit):** `useMemoryMutations().updateMemory`
  (`src/hooks/useMemories.ts:279-345`) → `uploadMemoryMediaAssets` →
  `updateMemory` (`src/services/memories.ts:1426`; rejects media↔non-media
  conversions at :1447–1475). Re-runs photo analysis when the caption or media
  changed.
- **Upload processing:** originals are **never resized**, only re-encoded by
  `stripImageMetadataForUpload` (`src/utils/strip-image-metadata.ts`, JPEG
  q 0.92). A derived 1280px preview comes from `createImagePreviewForUpload`
  (`src/utils/create-image-preview.ts`). `aspect_ratio` comes from the stripped
  output dimensions. Validation is in `src/utils/media-validation.ts` (20 MB
  image cap, jpeg/png/heic/webp).
- **Analysis:** `supabase/functions/_shared/analyze-memory-core.ts`.
  `MemoryForAnalysis` (:51) has no variant field. The handler selects
  `id, family_id, content, memory_type, memory_date, media_key, media_content_type, audio_transcript, updated_at`
  (`supabase/functions/analyze-emotion/index.ts:211`). There is one
  `chatJsonWithVisionMulti` call (`_shared/openai.ts`, up to 4 images at
  `detail: 'low'`), parsed by `parseMemoryAnalysisModelOutput` (:373), prompt
  `buildMemoryAnalysisSystemPrompt` (:571), CAS write
  `updateMemoryAnalysisIfSnapshotMatches` (:772, matched on `updated_at`).
  The client sees results via `src/utils/media-emotion-polling.ts` and refetches.
- **Rendering:** `src/components/memory-card.tsx`: `SpreadCard` (:228), media
  branch → `MediaVisual` (:188) → `MemoryMediaCarousel`, `CardFooter`
  (:90–118: emotion chip, else Photo/Video/Media badge). Carousel
  `src/components/memory-media-carousel.tsx` (container ratio = first asset's
  `aspect_ratio`). Detail `app/(app)/memory/[id]/index.tsx`:
  `MemoryDetailFramed` (:213; `framedCard` / `framedMediaWrap` styles),
  `MemoryMetaFooter` (:184–210, emotion chip), tagged member row with ages
  (:167–177). The Timeline view does not use `getItemLayout`; the calendar view
  does, but renders `memory-stamp.tsx`, not `MemoryCard`.
- **Native-module gating pattern:** `requireOptionalNativeModule` from
  `expo-modules-core` (`src/utils/voice-input.ts`,
  `modules/momora-widget/src/MomoraWidget.ts:27` with a capabilities object).
  Local Expo modules live in `modules/` (`modules/momora-widget` is the
  template). OTA uses `runtimeVersion: appVersion`; see `docs/features/eas-update.md`.
- **Analytics:** `src/services/analytics.ts` typed `AnalyticsEventMap` (:64),
  `memory_saved` (:106).
- **Tests:** Jest screen tests `src/screen-tests/new-memory.integration.test.tsx`,
  `edit-memory.integration.test.tsx`, `memory-detail.integration.test.tsx`,
  `timeline.integration.test.tsx`; component tests `memory-card.test.tsx`,
  `memory-media-carousel.test.tsx`, `memory-media-picker.test.tsx`; service
  tests `memory-posting.test.ts`, `use-pending-memory-uploads.test.tsx`; Deno
  `supabase/functions/_shared/analyze-memory-core.test.ts`,
  `analyze-emotion/index.test.ts`; pgTAP under `supabase/tests/`; Maestro
  `.maestro/flows/memories/create-media-memory.yaml`.
- **Repo is public:** no real family drawings in fixtures. Eval inputs live
  outside the repo.

### Scanner choice: local Expo module, not `react-native-document-scanner-plugin`

We inspected the source of `react-native-document-scanner-plugin` 2.0.4. It
hard-codes ML Kit `SCANNER_MODE_FULL` with no option for gallery import or
filters. Its JS entry calls `TurboModuleRegistry.getEnforcing('DocumentScanner')`
at import time, which crashes OTA bundles on old binaries if imported
statically. It also registers a new `activityResultRegistry` launcher on every
call and never unregisters it. Our needs are small (one async `scan` call),
so we write `modules/momora-artwork-scanner` following the `momora-widget`
template:

- **Android:** `play-services-mlkit-document-scanner` with
  `GmsDocumentScannerOptions.Builder().setScannerMode(SCANNER_MODE_BASE)`
  (crop/rotate/reorder only — no filters, no "clean" eraser that could erase
  marks), `setGalleryImportAllowed(false)`, `setPageLimit(remaining)`, and
  `setResultFormats(RESULT_FORMAT_JPEG)`. No CAMERA permission is needed
  (Play services hosts the UI). First use may download the ML Kit module, so
  failure must surface inline.
- **iOS:** `VNDocumentCameraViewController` presented from
  `appContext.utilities.currentViewController()`. `isSupported` is exposed as
  `isAvailable()`. It has no page-limit API, so JS truncates to the remaining
  slots and shows an inline notice. It writes each page as JPEG (q 0.95) to the
  caches dir. The existing `NSCameraUsageDescription` (expo-image-picker
  plugin) covers permission.
- **Return shape:** `{ status: 'success' | 'cancel', pages: [{ uri, width, height }] }`.
  Errors reject with code `scanner_unavailable` | `scanner_failed`.

## Steps

### Phase 0 — Spike (gate for everything else)

**0.1 Native module skeleton + device test.** Build `modules/momora-artwork-scanner`
(see Scanner choice) in a dev build, plus a temporary dev-only trigger (a
`__DEV__` button in the composer is fine and is removed in Phase 3).
Scan 10–15 real drawings on iPhone and Android: crayon, marker, watercolor,
pencil, and construction paper; on a white table and on a dark surface;
landscape, portrait, and one oversized sheet. Record in
`docs/plans/artwork-scanning-spike.md`:
- edge-detection hit rate and manual-corner usability
- colour fidelity on iOS under VisionKit's default "Color" filter vs "Photo"
  (we can't set it programmatically; decide whether a "switch to Photo" tip is
  needed)
- output pixel dimensions and file size per platform: must be ≥ 2000 px long
  edge for print, ≤ 20 MB, and pass `validateMediaFileCheap`
- that the files survive `stripImageMetadataForUpload` with an unchanged
  ratio, and that the extra JPEG generation (scanner q0.95 → strip q0.92) is
  visually fine
- lifecycle: background/foreground mid-scan, rotation, Android "Don't keep
  activities", iOS camera permission denied, Android offline first use (ML
  Kit module download), and where ML Kit writes its output (persistent vs
  cache)

**0.2 Medium eval.** Add `supabase/scripts/eval-artwork-medium.ts` and an npm
script `eval:artwork-medium`. It takes a local folder of scans (path arg,
never committed) plus a `labels.json` of ground-truth mediums. It runs the
Phase 1 prompt additions in three arms: (a) today's path, i.e.
`prepareVisionImageFromBytes` caps every image at `MAX_EMOTION_VISION_EDGE = 768`
(`_shared/image-limits.ts`) and sends `detail: 'low'`; (b) 768 + `'high'`;
(c) an artwork-only 1280 edge cap + `'high'`. Texture cues (wax vs pencil)
may be lost to the 768 cap rather than to `detail`. Add an optional
`detail?: 'low' | 'high'` to `chatJsonWithVisionMulti`'s options (default
`'low'`, so behaviour is unchanged) so the eval reuses the real helper (1280 preview) and prints an accuracy and cost
table. Ship `'low'` unless `'high'` is clearly better (≥ 15 pts) at
acceptable cost (include per-call cost in the table). If (b) or (c) wins,
thread `detail` and a per-call edge cap for artwork only.

**Gate:** if either scanner mangles kids' art badly enough that parents would
be better off with a plain photo, stop and report to the owner before Phase 1.

### Phase 1 — Backend (deploy first; harmless to old clients)

**1.1 Migration** `supabase/migrations/2026101XXXXXXX_artwork_memories.sql`:
- `alter table memories add column media_variant text` (nullable),
  `add column artwork_medium text` (nullable).
- `check (media_variant is null or (media_variant = 'artwork' and memory_type = 'media'))`.
- `check (artwork_medium is null or coalesce(media_variant = 'artwork', false))`.
  The coalesce is required: with a NULL variant the bare comparison is NULL,
  which a CHECK treats as passing. Don't add
  an `in (<vocabulary>)` DB check. Vocabulary drift (a new medium deployed
  before a migration, or a normalizer bug) would then fail the single
  analysis CAS UPDATE, and with it emotion/topics/milestones for every
  artwork memory. No other analysis column has a DB vocabulary check.
  `normalizeArtworkMedium` plus the sync test enforce the vocabulary.
- `grant insert (media_variant) on public.memories to authenticated;`.
  Grant no update on either column: `media_variant` is then immutable for
  clients without a trigger, and `artwork_medium` is written only by the
  service-role analysis path.
- **Images-only enforcement as a trigger, not an RPC redefinition:** add a
  `BEFORE INSERT OR UPDATE OF content_type, memory_id` trigger on
  `public.memory_media` (`security invoker`, `set search_path = public`) that
  raises `check_violation` with message `artwork_media_must_be_image` when the
  parent memory has `media_variant = 'artwork'` and `new.content_type not like 'image/%'`.
  This covers every writer: the RPC, plus direct table writes, since
  `memory_media` keeps RLS-gated table grants. It is immune to future
  redefinitions of `replace_memory_media_assets`, which has been redefined
  7+ times. It also stops old app versions adding videos to an artwork
  memory from their edit screen.
  - The client maps that error to a friendly message in `updateMemory`'s
    error handling.
  - Name the file with a timestamp after `20261013120000`.
- Vocabulary (code-enforced; stored lowercase, display as-is): `crayon`, `marker`,
  `colored pencil`, `pencil`, `watercolor`, `paint`, `chalk`, `pastel`,
  `collage`, `mixed media`.
- `get_family_activity_v2` (explicit column list) — **no change** in v1:
  activity rows render artwork as photo. Note it in the feature doc.

**1.2 Regenerate types:** `npm exec supabase -- gen types typescript --local > src/types/database.ts`
(needs local Supabase running; see memory: Docker is often down — start it).
If it fails, stop; do not hand-edit.

**1.3 pgTAP** `supabase/tests/artwork_memories.sql`:
- the variant check rejects artwork on text/audio
- medium requires artwork (any string allowed; vocabulary is code-side)
- the `memory_media` trigger rejects a video row on an artwork memory (via
  `replace_memory_media_assets` and via a direct insert) while accepting
  images; regular media memories still accept video
- insert of `media_variant = 'artwork'` **as the `authenticated` role**
  succeeds
- `has_column_privilege('authenticated','public.memories','media_variant','UPDATE')`
  and the same for `artwork_medium` are both false

**1.4 Shared vocabulary:** `supabase/functions/_shared/artwork-medium.ts`
(`ARTWORK_MEDIUMS` const tuple + `normalizeArtworkMedium`) mirrored in
`src/utils/artwork-medium.ts`. Put it in `src/utils`, not `src/constants`,
because `test:edge`'s `--allow-read` list includes `src/utils` but not
`src/constants`. Add a Deno sync test, in the style of the existing topic
doc-sync tests, asserting that the two lists match.

**1.5 analyze-memory medium axis** (`_shared/analyze-memory-core.ts`):
- Add `mediaVariant: string | null` to `MemoryForAnalysis`. The handler
  (`analyze-emotion/index.ts:211`) adds `media_variant` to its select and maps it.
- `buildMemoryAnalysisSystemPrompt` gains `{ isArtwork }`. Only when true it
  appends: "The images are scans of a child's artwork. Add `medium`: exactly
  one of [...]; use `mixed media` when pieces differ or materials combine."
  Non-artwork prompts stay byte-identical (assert in test).
- Only the first `MAX_ANALYSIS_IMAGES = 4` pieces are seen, so for a larger
  batch the medium reflects pieces 1–4. Document this in the feature doc.
- **Depicted content is not a family event (artwork mode).** Without this,
  a "Disney castle" drawing would feed the holiday-card letter's trips
  (`holiday-card-digest.ts` `namedTrips` reads capitalized `labels` +
  `TRIP_TOPICS`), the book's travel spreads, and the film script
  (`year-film-context.ts`). So:
  - The artwork prompt states that the images show what the child drew, not
    where the family was or what it did.
  - Post-processing in `runMemoryAnalysis` for artwork, before the CAS write:
    - `topics` forced to `['arts-crafts']` ("Little artist",
      `memory-topics.ts`), discarding model topics. Keep `topic_details`
      only for `arts-crafts`.
    - `labels` lowercased, so no capitalized place name passes `namedTrips`'
      `^\p{Lu}` filter, and prefixed with `artwork` and the medium.
    - `description` prefixed "a child's <medium|artwork> drawing of …".
    - Milestones unchanged: they are explicit-text-only, so a caption can
      still state one.
  - Deno tests: artwork topics are exactly `['arts-crafts']`, labels
    lowercase, a non-artwork photo path is unchanged. The eval (0.2) includes
    two drawings of places/trips to check the prompt.
- `parseMemoryAnalysisModelOutput` parses `medium` via
  `normalizeArtworkMedium`. It is tolerant: case, whitespace, plurals
  (`crayons`), spelling variants (`water color`, `colouring pencil`, `felt tip`
  → marker, `oil pastel` → pastel) via a small synonym map; unknown → null.
- `MemoryAnalysisResult` and `MemoryAnalysisWriteResult` gain
  `artworkMedium: string | null`. `updateMemoryAnalysisIfSnapshotMatches`
  includes the `artwork_medium` key **only when the memory is artwork AND the
  parsed medium is non-null**. Otherwise it omits the key, so the check
  constraint never fires for non-artwork rows and a flaky re-analysis on edit
  never erases a good medium.
- `supabase/scripts/backfill-memory-analysis.ts` also calls `runMemoryAnalysis`
  and the shared write helper. Update its select to include `media_variant` so
  a backfill never nulls or skips the medium.
- Deno tests in `analyze-memory-core.test.ts`, `analyze-emotion/index.test.ts`
  and `analyze-memory/index.test.ts`. Cover: key omitted for non-artwork,
  omitted for an artwork null parse, written for artwork non-null; synonym
  normalization.

**1.6 Deploy, in this order:** (1) apply the migration to prod; (2) deploy
`analyze-emotion` and `analyze-memory` (both names). The functions select
`media_variant`, so they must not go out before the column exists.

**1.7 Analyze response carries the medium:** the `analyze-emotion` /
`analyze-memory` success response gains an optional `artworkMedium: string | null`.
The field is additive, so older clients ignore it. Update the response type in
the handler and its Deno test.

### Phase 2 — Rendering + edit guard (OTA to 1.4.2 / 1.4.3)

**2.1 `src/components/artwork-frame.tsx`:** `ArtworkFrame({ children, style, testID })`,
pure Views:
- outer frame band (~10 px, warm wood tone from theme tokens; add tokens to
  `src/constants/theme.ts`)
- a 1 px inner bevel highlight
- a cream mat (padding ≈ 7% of width, via `onLayout`, or a fixed 14 px on
  card / 20 px on detail)
- a hairline inner shadow line at the mat opening
- a soft outer shadow

The child keeps its own aspect-ratio layout, so the frame adds only fixed
padding. Unit test with snapshot/structure assertions.

**2.2 Helpers** in `src/utils/memories.ts`:
- `isArtworkMemory(memory)` returns `memory.memory_type === 'media' && memory.media_variant === 'artwork'`.
- `formatArtworkMedium`.

**2.3 Timeline card** (`memory-card.tsx`):
- In `SpreadCard`'s media branch, wrap `MediaVisual` in `ArtworkFrame` when
  `isArtworkMemory`. This is a new style variant: the frame sits inset on the
  card background instead of full-bleed.
- `CardFooter`: for artwork, show `MediumChip` (neutral style, label = medium)
  when `artwork_medium` is set, else an "Artwork" badge (reuse `mediaBadge`
  style). Never the emotion chip.
- Update the KEEP IN SYNC comment to note that share cards intentionally
  render artwork as a photo.

**2.4 Detail** (`app/(app)/memory/[id]/index.tsx`): in `MemoryDetailFramed`,
when artwork, render the carousel inside `ArtworkFrame` instead of the
`framedCard` / `framedMediaWrap` chrome, and show the medium chip / "Artwork"
badge in `MemoryMetaFooter` in place of the emotion chip. Keep the emotion
gradient background. The full-screen viewer is unchanged.

**2.5 Edit guard (OTA-safe):** in `edit.tsx`, derive `isArtwork` from
`isArtworkMemory(memory)`, never from attachment `source`.
- When `isArtwork`, do not render `MemoryMediaPicker`.
- On OTA-only binaries, render a disabled scan-icon placeholder (not the
  photo icon) with `accessibilityHint` "Update the app to scan more artwork".
  Phase 3 replaces it with the live scan button when the module is present.
- The edit `TYPE_CONFIGS` gains `media_artwork` ("Artwork"), and `typeKey`
  branches on `isArtwork` before the photo/video checks. Mirror both in
  new-memory.
- Replace the hard-coded `10` in edit's `appendMedia` and `remainingSlots`
  with `MAX_MEMORY_MEDIA_ASSETS`. Old binaries then can
never add library photos/videos to an artwork memory once they get this OTA,
and the Phase 1.1 `memory_media` trigger blocks videos for those that don't.

**2.5b Analysis results reach the caches** (otherwise the Timeline keeps the
"Artwork" fallback badge after analysis lands):
- `fetchMemoryGenerationStatuses` select and `MemoryGenerationStatusRow` add
  `artwork_medium`. `applyStatusPatches` (`useGenerationStatusPolling.ts`)
  includes it in its `changed` check and its patch.
- `useMemoriesRealtime`'s patch whitelist adds `artwork_medium`.
- Widen `analyzeMemoryEmotion`'s return type in `src/services/ai.ts` to
  include `artworkMedium?: string | null` (from the 1.7 response field).
- In `src/services/memories.ts`, next to `runMediaPhotoEmotionAnalysis`
  (which calls `analyzeEmotionWithRetry`), add `runMediaPhotoAnalysis`
  returning `{ emotion, artworkMedium } | null`. Keep
  `runMediaPhotoEmotionAnalysis` and its `string | null` return unchanged.
- Patch with the existing `patchMemoryInCaches` (`src/hooks/memory-cache.ts`)
  using `{ emotion, ...(artworkMedium ? { artwork_medium: artworkMedium } : {}) }`.
  No new cache helper.
- Switch all **three** callers to the new pair, with tolerant handling of
  `undefined` results:
  1. the media branch of `use-pending-memory-uploads.tsx`
  2. the edit mutation's re-analysis in `useMemories.ts`
  3. the emotion-recovery effect in `useMemories.ts` (~line 795–815, calls
     `analyze(memory.id).then(setMemoryEmotionInCache)`)
- Update Jest mocks of `@/services/memories` that stub
  `runMediaPhotoEmotionAnalysis` to also stub `runMediaPhotoAnalysis`:
  - `use-pending-memory-uploads.test.tsx`
  - `useMemories.integration.test.tsx`
  - `memories.integration.test.ts`
  - `src/screen-tests/onboarding.code-returning-owner.integration.test.tsx`
- Also verify `src/utils/media-emotion-polling.ts`'s stop condition: polling
  stops once emotion exists. Since emotion and medium land in the same CAS
  write, that is fine; assert it in a test.

**2.6 Tests:**
- `memory-card.test.tsx`: frame present only for artwork; medium chip
  replaces emotion; "Artwork" fallback badge.
- `memory-detail.integration.test.tsx`: frame + chip.
- `edit-memory.integration.test.tsx`: no media picker on artwork.
- `useGenerationStatusPolling` / `useMemoriesRealtime` tests: an
  `artwork_medium` patch lands in list caches.
- `use-pending-memory-uploads.test.tsx`: the analysis result patches the
  medium.

**2.7 Ship:** EAS update to **every live runtime at publish time** (likely
1.5.0 + 1.4.3 + 1.4.2, since audio-trim ships 1.5.0 first) per
`docs/features/eas-update.md` and the per-runtime procedure. **Gate:** this OTA
carries main's whole JS bundle, including audio-trim's composer and waveform
changes. Do not publish until audio-trim's older-binary OTA QA row has passed
(see `docs/plans/audio-trim-import.md`), or its JS has already been OTA'd. **Hard gate:** confirm the Phase 1 migration is
applied in prod first (query `information_schema.columns` for
`artwork_medium`). `fetchMemoryGenerationStatuses` now selects that column,
so publishing before the migration makes PostgREST 400 the illustration and
emotion poll for every user. Never drop the columns after this OTA ships.

### Phase 3 — Capture (store build)

**3.1 Finalize `modules/momora-artwork-scanner`:** remove the spike trigger.
Native lifecycle requirements:
- **iOS:** the module holds a strong reference to the
  `VNDocumentCameraViewController` delegate and the pending promise until a
  delegate callback fires (the delegate is weak). It rejects
  `scanner_failed` if presentation fails (no current VC). Only one scan is in
  flight at a time; a second call rejects with `scanner_busy`.
- **Android:** use the module's `appContext` activity-result API (the
  `registerForActivityResult` pattern in expo-modules-core), not an ad-hoc
  `activityResultRegistry.register` per call. If the host activity is
  destroyed mid-scan, the promise rejects or is dropped. The JS guard (3.3)
  recovers.
- **Both:** the native side returns its own output URIs. JS immediately moves
  them into `documentDirectory/artwork-scans/<claimEpochMs>-<uuid>.jpg`
  (**not** caches, which the OS can purge while a failed upload waits for
  Retry). Mirror `src/utils/audio-clip-custody.ts`: name-timestamp sweep,
  because copied files keep unreliable mtimes, plus an
  `isInsideArtworkScansDirectory` guard. Generalize that helper if it falls
  out cleanly; otherwise add `src/utils/artwork-scan-custody.ts`.
- **Android process death:** the spike's "Don't keep activities" test decides.
  If results are lost, add `getPendingScanResult()` with composer-mount
  recovery, mirroring the `ImagePicker.getPendingResultAsync` usage in
  `app/(app)/add-family-member.tsx`. Constraint: expo-modules-core's
  `AppContextActivityResultRegistry` needs a `Serializable` contract input, so
  fetch the ML Kit `IntentSender` first (async `getStartScanIntent`), stash it
  on the module, and pass a Serializable token.
JS wrapper `src/services/artwork-scanner.ts`:
- `isArtworkScannerAvailable()` uses `requireOptionalNativeModule('MomoraArtworkScanner')`
  and, on iOS, `isAvailable()`.
- `scanArtwork({ remainingSlots })` returns `{ status, pages }`, truncating to
  `remainingSlots`, and maps pages to `MediaAttachment` with
  `contentType: 'image/jpeg'`, `aspectRatio` from width/height,
  `sizeBytes` via `getLocalFileSizeBytes` (`src/utils/local-files.ts`), `source: 'scan'`, and no `capturedAtIso`.
- Each page passes through `validateMediaFileCheap`.
- Register the module in `app.json` if it needs a plugin (Expo autolinking of
  `modules/` normally suffices; mirror how `momora-widget` is wired).

**3.2 `MediaAttachment` gains `source?: 'library' | 'camera' | 'share' | 'scan'`**
(only `'scan'` is read).

**3.3 `src/components/artwork-scan-button.tsx`:** a compact 46×46 toolbar
button matching `MemoryMediaPicker`'s `compactBtn`, with icon
`doc.viewfinder` / `document_scanner`, testID prefix `*-scan-artwork`, and
accessibility label "Scan artwork".
- **Re-entry guard:** reset on unmount, and on AppState returning to `active`
  with no result after a short grace period (covers lost Android activity
  results and iOS hangs).
- **Camera permission (iOS):** pre-check with `getOrRequestNativePermission`
  (as `MemoryMediaPicker` does) and show the same "open Settings" copy on
  denial. VisionKit would otherwise show a dead scanner.
- **iOS page cap:** always show an inline hint before launch ("Scan up to N
  pieces"). Pages beyond the cap are dropped with a notice.
- Failures render inline, the same way as the media picker.

**3.4 New-memory wiring** (`new-memory.tsx`):
- `hasArtwork = attachedMedia.some(a => a.source === 'scan')`.
- Pass a fragment of [media picker, scan button] as `toolbarMediaButton`. The
  scan button is hidden when unavailable.
- Media picker disabled when `hasArtwork`. Scan button disabled when
  `isAudio || (attachedMedia.length > 0 && !hasArtwork) || attachedMedia.length >= MAX_MEMORY_MEDIA_ASSETS`.
- Voice modal `captureMode = isAudio ? 'keepOnly' : hasArtwork ? 'dictate' : 'fork'`,
  so the mic can still dictate the caption but can't keep a sound on artwork.
- `typeKey` → `media_artwork`.
- The media branch of `handleSave` passes `mediaVariant: hasArtwork ? 'artwork' : undefined`
  into `enqueuePendingMemoryUpload`.
- `memory_saved` gains `is_artwork: boolean`, set at all three fire sites
  (audio, media, text: `false` for audio/text). A new event
  `artwork_scan_result { status: 'success'|'cancel'|'error', page_count }`.
- Swap the hard-coded `10` for `MAX_MEMORY_MEDIA_ASSETS` in the touched lines.
- **Re-anchor on audio-trim's composer.** Audio-trim P4/P5 reshape
  `new-memory.tsx` (`applyKeptClip`, refs-based mutual-exclusion re-check at
  completion, discriminated `prepareSharedMedia` result, an `isAudio` guard
  in `handleIncomingSharePrepared`, an attach menu with a sound option).
  Re-read the composer as it is when Phase 3 starts and follow its patterns:
  - **Incoming share while scans are attached:** use audio's *refuse* pattern
    ("This memory is artwork. Save it first, then share photos."), not a
    replace-confirm. Test it.
  - **When a scan resolves**, re-check `isAudio` and existing non-scan media
    via refs (not stale closures) before appending; if either now holds,
    discard the pages (and delete their files) with an inline notice.
  - The attach menu's sound option is hidden or disabled when scans are
    attached, and the `isAudio` toolbar branch (the inert icon) also gets the
    disabled scan button. Test both.
- **Scan file cleanup:** delete `artwork-scans/` files for removed tiles, on
  composer discard/unmount without save, and after a successful post or
  discard in `use-pending-memory-uploads.tsx`. Only delete paths inside
  `artwork-scans/`. Add a best-effort sweep on app start of files whose
  name timestamp is more than 7 days old, skipping any URI still referenced by
  a pending upload.
- **Toolbar width:** verify mic + photo + scan + AI-toggle row fits at 375 pt
  width; if not, the AI toggle row wraps or shortens its label (check
  `toolbarTrailingSlot` layout).

**3.5 Queue + service:**
- `PostMediaMemoryInput` (`memory-posting.ts`) gains
  `mediaVariant?: 'artwork'`, threaded through `postMediaMemory` →
  `createMediaMemory` (inserts `media_variant`) via
  `CreateMediaMemoryInput` (`src/utils/memories.ts`).
- The insert-conflict retry path (`resolveMediaMemoryInsertConflict` /
  `continueCreateMediaMemory`) re-reads the existing row, so it needs no
  variant. Add a test that a retried artwork post keeps `media_variant`.
- The pending card preview is unchanged.
- `runMediaPhotoEmotionAnalysis` is unchanged; it fires because the assets are
  images.

**3.6 Edit wiring:** for artwork memories (`isArtworkMemory`), the live scan
button replaces the 2.5 placeholder and appends scanned pages. They upload through the existing synchronous
edit path. `updateMemory` must not send `media_variant` (immutable).

**3.7 Gallery import approval:** unchanged. It doesn't pass a scan button, so
verify the form renders correctly without it.

**3.8 Tests:**
- `artwork-scanner.test.ts`: mocked module, availability false, truncation,
  cancel, error.
- `artwork-scan-button.test.tsx`
- `new-memory.integration.test.tsx`: scan → preview → photo button disabled →
  save enqueues `mediaVariant: 'artwork'`; picker-first disables scan; audio
  disables scan; dictate mode with artwork.
- `memory-posting.test.ts`: variant threaded into insert.
- Maestro `.maestro/flows/memories/create-artwork-memory.android.yaml`: drive
  the ML Kit scanner on the emulator's virtual camera (capture → done) →
  frame visible on Timeline. If ML Kit can't run on the emulator, run the flow
  on a physical Android device and record that in TESTING.md. On iOS
  (simulator unsupported), add an assertion that the scan button is absent.

**3.8b Data export:** `cloudflare/momora-export-worker/src/plan.ts` uses an
explicit memories column list. Add `media_variant, artwork_medium`, and in
`src/layout.ts` write an "Artwork: <medium>" line to `memory.txt` and the
manifest for artwork memories. Update the worker's tests. **Deploy the worker
only after the Phase 1 migration is in prod**, because its explicit select
names the new columns and PostgREST would 400 every export before then.

**3.9 Docs** (same PR):
- `docs/features/artwork.md` (from `_template.md`, with an extension guide:
  adding surfaces, frame styles, a medium edit)
- `media-memories.md` cross-link
- `TECH_SPEC.md` §2.1 columns, §2.4 trigger, §2.5 constraints, §4.2 analysis
  axis
- `docs/features/analytics.md` events
- `TESTING.md` if Maestro has a device caveat

**3.10 Ship:** in a store build with a new app version, and therefore a new
runtime under the `appVersion` policy. **Decide up front**: if Phase 3 is
device-verified before audio-trim's 1.5.0 build is cut, the scanner rides in
1.5.0. Otherwise it goes in the next version (1.5.1/1.6.0). Never ship the scanner under an
existing runtime's version. That binary will also carry any other pending
native modules (e.g. `modules/momora-audio`); coordinate with that work.
**Release gate:** the Phase 2 OTA must have been live on all older runtimes
for several days before the store build is released, so most old-runtime family
members already have the edit guard. Update `NSCameraUsageDescription`
(`app.json` expo-image-picker plugin `cameraPermission`) to mention scanning
children's artwork.

## Rollback

- **App:** republish the previous OTA group per runtime. Rendering is inert
  without artwork rows.
- **Edge Functions:** redeploy the previous `analyze-emotion` /
  `analyze-memory`. The response field is additive.
- **DB:** leave the columns, grants and the `memory_media` trigger in place
  (all nullable or harmless). Never drop `artwork_medium` while any OTA
  selecting it is live. If the trigger misbehaves,
  `drop trigger ... on memory_media` is a safe hotfix.
- **Store build:** the scan button can be hidden remotely only via OTA. Keep
  `isArtworkScannerAvailable()` as the single gate so a JS-only kill switch
  is a one-line OTA.

## Verification per phase

`npm run typecheck`, `npm run lint`, `npm test`, `npm run test:edge`, and
`npm run test:db` (local Supabase). Device check on iOS + Android before
committing Phase 3 (per the owner's drill: commit only after device
confirmation).

## Risks & mitigations

- **Scanner hurts art fidelity:** VisionKit's default colour enhancement can
  wash out light crayon, and edge detection struggles on a white table. The
  Phase 0 gate measures this; mitigations are inline tips ("place on a darker
  surface", "choose Photo filter").
- **OTA on old binaries:** the scanner JS must never statically import a
  native module. `requireOptionalNativeModule` returns null, so the button is
  hidden. Rendering code depends only on new columns, which are just
  `undefined` on rows the client already has.
- **Old binaries that don't take the OTA can edit an artwork memory** and add
  library photos. The `memory_media` trigger blocks videos but not photos, so a stray
  photo would sit inside the frame. This is acceptable and rare (OTA reaches
  both live runtimes).
- **Analysis CAS write with `artwork_medium` on non-artwork rows** would
  violate the check. Mitigation: only include the key for artwork (step 1.5,
  tested).
- **Backfill script** could drop the medium if it doesn't select the variant
  (step 1.5).
- **First-use ML Kit module download / no Play services** (Huawei): the
  error is surfaced inline and the button stays.
- **A force-quit mid-upload loses the scans** (the pending queue is in-memory
  only; scans, unlike library picks, exist nowhere else). This is accepted for
  v1 and documented in the feature doc; queue persistence is already on the
  backlog. The 7-day sweep prevents orphaned scan files accumulating.
- **Medium never retried:** a null parse leaves the "Artwork" badge for good,
  because emotion polling stops once emotion exists (`media-emotion-polling.ts`).
  Accepted for v1 (the tolerant normalizer makes it rare); the badge is a
  fine fallback. Documented in the feature doc.
- **Scanner lifecycle** (iOS weak delegate, Android activity death): handled
  in 3.1 and 3.3 and exercised in the Phase 0 checklist.
- **iOS has no page limit:** truncate + notice.
- **Print resolution:** the spike measures it; originals are never resized.
- **PII:** no memory content or medium in logs; eval images stay outside the
  public repo.

## Out of scope (v1)

- Frame/medium on calendar, profile grid, widget, share card, family activity,
  books, film, holiday cards, Kindle frame, Looking Back
- User-editable medium; multiple frame styles
- Converting an existing photo memory to artwork; importing old photos of
  drawings
- Per-piece titles; splitting a batch into separate memories
- "Bring it to life" animation
- An art book product
