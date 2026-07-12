# Phase 1 plan (v4, adversarially reviewed x2): pre-fill memory date from photo EXIF capture date

Repo: `/Users/eduardoyi/Coding/Momora2` (Expo SDK 56 + Supabase parent memory journal)

## Goal

When a user attaches photos from the photo library to a new memory, pre-fill the
memory date from the photos' EXIF capture date as a visible, user-overridable
suggestion. The feature must degrade to today's existing default when metadata
is absent, stripped, malformed, or implausible.

No schema changes, backend changes, new permissions, location use, or raw EXIF
persistence are required.

## Acceptance criteria

- A new-memory session starts with today's local calendar date, as it does now.
- Library photos with a valid EXIF capture date suggest the earliest valid
  calendar date across all currently attached photos.
- Videos, camera captures, web picks, and incoming-share attachments do not
  change the date unless another attached library photo has a valid extracted
  date.
- The suggestion is visible and announced as coming from photo metadata.
- Changing the date through the date picker is a user override. No later add,
  remove, reorder, or wholesale replacement of attachments may overwrite it in
  that screen session.
- Before a user override, removing all dated photos restores the session's
  original today value. Reordering alone never changes the suggested date.
- Missing or bad metadata is a no-op, never an error that blocks attachment or
  memory capture.
- Only the derived `YYYY-MM-DD` scalar enters React state. The raw EXIF object,
  including any GPS/device metadata returned by the native picker, is never
  retained on an attachment, logged, or added to any request payload or
  persisted record. (This guarantee covers the EXIF *object surfaced to JS* —
  see "Known pre-existing behavior" below for EXIF embedded in the uploaded
  file binaries, which this feature does not change.)
- The existing edit-memory picker does not request EXIF and never rewrites an
  existing memory date. Phase 1 is create-only.

## Adversarial findings resolved in this revision

1. **The picker is shared by create and edit.** Enabling `exif: true`
   unconditionally would surface metadata to the explicitly out-of-scope edit
   flow. EXIF extraction must be opt-in at the picker component boundary and
   enabled only by `new-memory.tsx`. (The rationale is privacy/scope, not
   performance — see the platform contract note on iCloud latency.)
2. **Regex shape validation alone accepts impossible dates.** Values such as
   `2024:02:31 10:00:00` must be rejected with explicit Gregorian
   year/month/day validation before an ISO string is returned.
3. **The prior future-date wording contradicted itself.** Phase 1 accepts a
   capture calendar date up to and including local `today + 1 day` to tolerate
   camera/device timezone differences; it does not clamp that accepted date.
   Dates after that are ignored. This preserves the literal camera-local date
   and matches the existing client, which does not forbid future memory dates.
4. **Two independent hook states can expose transiently inconsistent output.**
   Store `{ memoryDate, dateSource }` together in one reducer/state object, and
   make the reducer ignore every media action after a user override.
5. **The baseline date should not drift at midnight.** Capture
   `todayIsoDate()` once when the new-memory session mounts. Removing the last
   dated photo restores that session baseline rather than recomputing today.
6. **Unit tests alone do not prove screen wiring or native behavior.** Add a
   new-memory integration test and an EXIF-bearing native-picker E2E/manual
   smoke flow in addition to pure parser/hook tests.
7. **The PRD currently says the memory date defaults to today.** Update it to
   describe the media-specific suggestion so product and implementation do not
   conflict.

## Adversarial findings resolved in v4 (second review round)

1. **A test file under `app/` becomes an Expo Router route and can crash
   release bundles.** The screen integration test moved to
   `src/screen-tests/new-memory.integration.test.tsx` with a relative screen import.
2. **The metadata-hygiene guarantee overreached.** Android's picker copies EXIF
   into the output file and it is uploaded verbatim, so pipeline-wide
   "never uploaded/stored" was false. The guarantee is now scoped to the EXIF
   object surfaced to JS; embedded-EXIF-in-binaries is documented as
   pre-existing behavior with an upload-time-stripping follow-up.
3. **The iCloud-latency rationale was wrong for `quality: 0.85`.** The full
   original (including iCloud download) is fetched on every library pick
   regardless of `exif`; the opt-in is justified by privacy/scope only.
4. **"Update existing picker option assertions" described tests that don't
   exist.** Reworded as new work with first-time happy-path fixtures.
5. **The Maestro date assertion was locale-dependent.** Pin the device locale
   or assert a locale-agnostic substring.

## Confirmed platform contract

- The installed `expo-image-picker@56.0.20` exposes `asset.exif` only when the
  `exif` option is true.
- In this installed SDK, EXIF is a flat top-level object on both platforms:
  iOS starts with the EXIF dictionary and merges TIFF fields into it; Android
  emits flat `ExifInterface` tag names. Do not add speculative nested
  `{ Exif }` / `{ TIFF }` branches.
- Re-check this assumption when upgrading Expo SDK or `expo-image-picker`; keep
  the parser typed as `unknown` and fail closed if the runtime shape changes.
- iCloud latency is NOT attributable to `exif: true` in this version: because
  the picker uses `quality: 0.85`, iOS never takes the fast path
  (`MediaHandler.swift` requires `quality >= 1`), so the full original asset
  data — including an iCloud download for cloud-only assets — is loaded on
  every library pick regardless of the `exif` option. `exif: true` merely
  parses that already-loaded data locally. Do not claim or test a latency
  difference from enabling EXIF.
- The returned object can contain GPS fields. Phase 1 reads only the three date
  keys below and immediately discards the rest. It does not request
  `ACCESS_MEDIA_LOCATION` and does not use location data.

## Known pre-existing behavior (addressed 2026-07-12, was out of scope for Phase 1)

On Android, `quality: 0.85` routes picks through `CompressionImageExporter`,
whose `exportAsync` calls `copyExifData(...)` — copying essentially all EXIF
tags (GPS refs/timestamps, `DateTime*`, Make/Model, MakerNote) from the source
into the output file. That file was then uploaded verbatim (images bypass
client compression in `src/utils/video-compression.ts`, and
`uploadMemoryMediaAssets` in `src/services/memory-posting.ts` uploaded the file
as-is). **Uploaded Android JPEG binaries therefore contained embedded EXIF at
the time this plan was written, with or without this feature.** iOS was
coincidentally clean: the `quality < 1` slow path re-encodes via `UIImage` and
drops metadata.

Consequences for this plan (historical, at time of writing):

- The metadata-hygiene guarantee is scoped to the EXIF object surfaced to JS
  and to this feature's additions (no new metadata fields in state, logs,
  request payloads, or records). It does NOT claim uploaded file binaries are
  metadata-free.
- Documentation updates must not assert pipeline-wide metadata cleanliness.
- ~~Follow-up (separate from Phase 1, worth a ticket): strip EXIF/GPS from
  image binaries at upload time. Relevant to Phase 2's privacy design
  regardless.~~ **Done (2026-07-12):** `uploadMemoryMediaAssets` now re-encodes
  every image asset via `expo-image-manipulator`
  (`src/utils/strip-image-metadata.ts`) immediately before upload, stripping
  EXIF/GPS on both platforms, fail-closed on re-encode failure. This covers
  create, edit, and incoming-share attachments (all funnel through the same
  function). Videos remain out of scope — container-level metadata in
  uploaded MP4/MOV files is not stripped. See
  [docs/features/media-memories.md](../features/media-memories.md) and
  `docs/TECH_SPEC.md` §5.5 for the current guarantee.

## Implementation

### 1. Add pure utility `src/utils/media-capture-date.ts`

Export:

- `extractCaptureDateIso(exif: unknown, todayIso?: string): string | null`
  - Treat non-object/null/array input as unavailable.
  - Try flat string keys in priority order:
    `DateTimeOriginal` -> `DateTimeDigitized` -> `DateTime`.
  - If a higher-priority value is present but invalid, continue to the next
    candidate instead of returning early.
  - Trim whitespace/NUL padding, then strictly parse the standard EXIF form
    `YYYY:MM:DD HH:MM:SS`. Do not parse the raw value with `new Date(...)`.
  - Validate the full Gregorian calendar date, including month length and leap
    years. Reject zero fields, year `< 1900`, and impossible dates.
  - Interpret the result as the camera's calendar date. Do not apply timezone
    conversion; EXIF offset tags are intentionally out of scope.
  - Reject dates later than local `today + 1 calendar day`. Use an injected
    `todayIso` in tests so boundary cases are deterministic. Invalid injected
    values should fail closed rather than weaken validation.
  - Return only `YYYY-MM-DD`.
- `deriveSuggestedMemoryDate(attachments): string | null`
  - Read only `capturedAtIso` values that themselves pass strict ISO calendar
    validation.
  - Return the earliest valid value across all attachments. ISO date strings
    are safe to compare lexicographically only after validation.
  - Return null for an empty list or when no attachment has a valid date.

`DateTime` is a lower-confidence fallback because editors may rewrite it, but
it remains useful for camera files that omit the stronger tags. The visible,
overridable suggestion and strict plausibility checks are the guardrails. File
mtime and picker/import time are not fallbacks.

### 2. Scope EXIF extraction in `src/components/memory-media-picker.tsx`

- Extend `MediaAttachment` with `capturedAtIso?: string`. Do not add an `exif`
  property.
- Add an explicit prop such as `includeCaptureDate?: boolean`, defaulting to
  `false`.
- Pass `exif: includeCaptureDate` to `launchImageLibraryAsync`. This makes the
  default and edit-memory paths explicitly metadata-off.
- For each image result only, call `extractCaptureDateIso(asset.exif)` and copy
  only the returned scalar into `capturedAtIso`.
- Skip extraction for video assets. Web/missing metadata yields `undefined` and
  continues normally.
- Leave `launchCameraAsync` metadata-off. A photo taken inside the composer is
  already represented correctly by the session's today default.
- Never include `capturedAtIso` in the deferred upload payload. It is
  presentation state used only to choose `memoryDate` before save.

### 3. Add `src/hooks/use-suggested-memory-date.ts`

Signature:

```ts
useSuggestedMemoryDate({ attachments }) => {
  memoryDate,
  setMemoryDate,
  dateSource,
}
```

where `dateSource` is `'default' | 'media' | 'user'`.

Rules:

- Capture the session baseline date once on mount with a lazy initializer/ref.
- Keep `memoryDate` and `dateSource` in a single reducer/state object.
- Expose a user-action setter that atomically writes the date and sets source
  to `user`, even if the chosen value equals the current suggestion.
- Derive the current suggestion with `useMemo` and react to the derived ISO
  string, not attachment array identity. A reorder that produces the same
  earliest value should do no work.
- While source is not `user`, a non-null suggestion applies it with source
  `media`; a null suggestion restores the captured session baseline with source
  `default`.
- The reducer must reject media/default actions after source becomes `user`.
  This makes the manual override robust to queued effects and later attachment
  replacement.
- The override lasts until the new-memory screen unmounts. No persistence is
  needed.

### 4. Wire only `app/(app)/new-memory.tsx`

- Replace `useState(todayIsoDate())` with `useSuggestedMemoryDate` and pass
  `attachedMedia`.
- Pass `includeCaptureDate` to the create-screen `MemoryMediaPicker`. Do not
  pass it from `app/(app)/memory/[id]/edit.tsx`.
- When `dateSource === 'media'`, render a muted `From photo` hint beside the
  date pill. Give it a stable test ID such as `new-memory-date-source`.
- Change `datePillWrap` to a row layout with centered alignment and spacing;
  verify narrow screens and dynamic type do not clip the date control or hint.
- Add optional `accessibilityHint` support to `DatePickerField` and pass
  `Suggested from photo date` while the source is `media`.
- Prevent duplicate screen-reader output from the adjacent visible hint (for
  example, hide that Text from the accessibility tree while keeping the hint
  on the date Pressable).
- Keep incoming-share behavior unchanged: its attachments lack
  `capturedAtIso`, so they retain the session default unless the user already
  chose another date.

### 5. Tests in the same PR

#### Pure utility tests: `src/utils/media-capture-date.test.ts`

- Each key and priority/fallback order, including invalid original followed by
  valid digitized/date fallback.
- Flat EXIF object; nested-only input is ignored to detect contract drift.
- Colon-format parsing without Date-string coercion.
- Whitespace/NUL padding behavior.
- Invalid types, null, undefined, arrays, malformed strings, zero fields,
  invalid month/day, non-leap Feb 29, valid leap Feb 29, and year `< 1900`.
- Deterministic `today`, `today + 1` accepted, `today + 2` rejected, including
  month/year/leap-day boundaries.
- Earliest valid date across attachments; non-dated first/dated second;
  invalid `capturedAtIso` ignored; videos/mixed media; empty list.

#### Picker component tests: `src/components/memory-media-picker.test.tsx`

- `includeCaptureDate` passes `exif: true`; default/false passes `exif: false`.
- Image EXIF produces only `capturedAtIso` on the emitted attachment.
- Assert raw EXIF/GPS/device fields are not emitted or logged.
- Video EXIF is ignored, and absent/malformed EXIF still emits a valid
  attachment without a capture date.
- Note: the existing file covers only launch-failure and concurrent-launch
  guards — no test currently asserts `launchImageLibraryAsync` options. The
  option and happy-path assertions above are NEW work requiring first-time
  happy-path fixtures (mocked `fileSize`, valid `mimeType`); budget for
  building them. Keep the existing permission and concurrent-launch regression
  coverage intact.

#### Hook tests: `src/hooks/use-suggested-memory-date.test.tsx`

- Initial session baseline; append with/without EXIF; multiple batches choose
  earliest; remove earliest; remove last dated item restores the original
  baseline.
- Manual override then append, remove, reorder, remove-all, and wholesale
  replacement: user date always survives.
- Reorder with unchanged earliest date does not change output.
- Session baseline stays fixed if the system clock crosses midnight during the
  mounted test.
- Media/default state is internally consistent in every observed render.

#### Screen integration test: `src/screen-tests/new-memory.integration.test.tsx`

**Location is load-bearing: the test MUST NOT live under `app/`.** Expo
Router's route context matches every `.tsx` under `app/` (only `+api`/`+html`/
`+middleware` are excluded, and no router `ignore` is configured), so an
`app/(app)/new-memory.integration.test.tsx` would register a phantom route and
its module-scope `jest.mock`/`describe` would throw when the route module is
evaluated — crashing release bundles at startup. Place it in `src/` (all
existing `*.integration.test.tsx` live there) and import the screen with a
relative path (`../../app/(app)/new-memory`); jest's `moduleNameMapper` only
maps `@/` to `src/`.

Required mocks (nontrivial — budget for them): `usePendingMemoryUploads`
(context provider), `useFamily`, `useFamilyMembers`, `useMemories`,
`useUserProfile`, `@/lib/navigation`, `expo-image-picker`, and
`@react-native-community/datetimepicker` (to drive date changes through
`DatePickerField`). Follow the picker-mock pattern already established in
`src/components/memory-media-picker.test.tsx`.

- Mock the native picker result, not the date hook. Attaching an EXIF-dated
  photo updates the displayed date and shows the source hint.
- Changing the date through `DatePickerField`, then attaching/removing media,
  preserves the user's date and removes the media-source hint.
- An incoming-share replacement without metadata follows the documented
  default/override behavior.
- Saving passes only the final `memoryDate` to the existing posting queue and
  does not add EXIF/capture metadata to the upload payload.

#### Native E2E/manual smoke

- Add a small, non-sensitive JPEG fixture with a known
  `DateTimeOriginal`/`DateTimeDigitized` and document how it was produced.
- Add `.maestro/flows/memories/prefill-date-from-photo.yaml` (or extend the
  existing media-create flow if fixture selection is deterministic) to seed the
  gallery, select that image, assert the displayed known date and `From photo`,
  override the date, and save successfully.
- The date pill renders via `toLocaleDateString` (`src/utils/dates.ts`), so
  "Mar 5, 2024" only appears on an en-US device. Pin the emulator/simulator
  locale in the flow, or assert a locale-agnostic substring (e.g. the year)
  within the `new-memory-date` testID.
- Run on both a supported iOS and Android development build before release.
  Treat this as a native-picker smoke test because gallery seeding/ordering and
  metadata preservation can vary by emulator/OS; keep the screen integration
  test as the deterministic CI regression.

### 6. Documentation

- `docs/PRD.md` §6.3: qualify the today default with the visible,
  user-overridable photo capture-date suggestion.
- `docs/TECH_SPEC.md` §5.5: add the client-only EXIF extraction/fallback step;
  state that the EXIF object surfaced to JS is never retained, logged, or
  added to any request payload or persisted record, and that this feature adds
  no API/schema change. Do NOT claim uploaded binaries are metadata-free —
  Android uploads retain embedded EXIF today (see "Known pre-existing
  behavior"); note that as pre-existing platform behavior with a follow-up
  item for upload-time stripping.
- `docs/features/media-memories.md`:
  - add user behavior and data-flow notes for capture-date prefill;
  - add the util, hook, picker prop, and new-memory integration points to the
    Client integration table;
  - record privacy/fail-open behavior, iCloud latency, flat-shape dependency,
    earliest-date rule, create-only scope, and Phase 2 location extension path;
  - add every new/updated unit, integration, and E2E test to Testing; and
  - add a dated changelog row.
- No schema migration, generated database type update, Supabase function test,
  or Edge Function documentation is needed.

## Verification

Use the repository's existing scripts on Node 20; do not invent narrower script
names:

```bash
npm run typecheck
npm run lint
npm test -- --runInBand
maestro test .maestro/flows/memories/prefill-date-from-photo.yaml
```

Also manually verify on physical/simulated iOS and Android with:

- a normal camera photo with original EXIF;
- an edited/exported photo whose EXIF is missing or rewritten;
- an iCloud-only iOS asset;
- a mixed photo/video selection spanning more than one date;
- limited photo-library permission; and
- an image containing GPS EXIF, confirming no raw metadata appears in React
  state, logs, or JSON request/queue payloads (inspect payloads, not uploaded
  file binaries — Android binaries retain embedded EXIF as pre-existing
  behavior; see "Known pre-existing behavior").

## Explicitly out of scope

- GPS/location extraction, `ACCESS_MEDIA_LOCATION`, maps, or place search
- Video container creation metadata
- Memory edit-screen date suggestion
- Incoming-share EXIF extraction
- Server-side EXIF parsing or validation
- Persisting per-asset capture timestamps
- Changing the single-date memory model for multi-day selections

## Phase 2 extension path

Location work must be designed separately. Do not extend `MediaAttachment` with
raw EXIF. If Phase 2 needs location, extract a minimal typed value at the picker
boundary, review Android scoped-media permission behavior and iOS privacy copy,
define explicit retention/storage semantics, and update PRD/TECH_SPEC/security
documentation before implementation.
