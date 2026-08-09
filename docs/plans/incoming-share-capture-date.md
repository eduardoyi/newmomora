# Plan: capture-date suggestion for incoming-share media

Repo: `/Users/eduardoyi/Coding/Momora2` (Expo SDK 56 + Supabase parent memory journal)

Extends [media-exif-capture-date-prefill.md](media-exif-capture-date-prefill.md),
which explicitly scoped out "Incoming-share EXIF extraction". This plan closes
that gap for both photos and videos shared into Momora from the OS share sheet.

## Goal

When a user shares photos or videos into Momora from the gallery (or any app),
the new-memory date pill should pre-fill from the media's capture date — the
same visible, user-overridable suggestion the in-app library picker already
provides — instead of always defaulting to today.

No new dependencies, native modules, permissions, schema, or backend changes.
JS-bundle-only; shippable via `eas update` to compatible binaries that already
contain the current `expo-sharing` share extension and `expo-file-system`
native modules. This does not make incoming sharing itself OTA-installable on
an older binary.

## Adversarial review findings (2026-08-09)

This revision closes the following gaps in the original draft:

1. **The PRD also contradicted the proposed behavior.** Its earlier wording
   excluded incoming shared media from capture-date suggestions. Updating it is
   required in the same PR, not just `TECH_SPEC`/the media feature doc.
2. **The original HEIF sketch could return a plausible date for the wrong
   image.** A HEIF can contain multiple image and metadata items. This plan
   initially avoided guessing by accepting only one `Exif` item; the second
   pass below closes the remaining ownership gap with explicit `pitm`/`iref`
   association parsing.
3. **HEIF version-dependent fields were underspecified.** `iinf` entry-count,
   `infe` item-ID/type, `iloc` item-ID, construction-method, extent-index, and
   nibble-sized offset fields now have explicit supported versions and
   fail-closed rules. `data_reference_index != 0` is rejected.
4. **"Read the EXIF payload" was too broad and potentially unbounded.** The
   parser now uses exact, range-checked positioned reads for TIFF structures
   and date strings. It never loads an arbitrary HEIF Exif item wholesale.
   JPEG keeps a one-read fast path but has explicit segment/byte/read budgets.
5. **The batch-concurrency proposal conflicted with "validate first."** Images
   are cheap-validated before extraction. For videos, duration and capture
   date may run concurrently because duration is itself required for
   validation, but ordered result assembly preserves today's first-error,
   all-or-nothing behavior. Concurrency is bounded instead of an unqualified
   ten-way `Promise.all`.
6. **The wiring test stopped one layer short.** The screen suite mocks
   `useIncomingMemoryShare`, so it cannot prove that the hook injects the real
   image/video extractors. The hook integration suite must cover that seam.
7. **The parser is processing untrusted share bytes.** All offsets, lengths,
   box sizes, IFD counts, additions, and multiplications must be finite safe
   integers and remain inside both the containing range and `reader.size`.
   Short reads, overflow, cycles/repeated offsets, excessive nesting/work, and
   unsupported shapes all return `null`.
8. **The latency target needed an escape hatch.** Metadata is a suggestion,
   never worth making capture feel stuck. Device measurement now records batch
   wall time and per-item distribution; the second pass below turns that
   escape hatch into a required absolute deadline rather than a conditional
   follow-up.

### Second-pass findings (2026-08-09)

9. **Exactly one HEIF `Exif` item is not enough to prove it belongs to the
   displayed image.** A file may contain several image items, and even a sole
   Exif item can describe a non-primary image. The parser must resolve `pitm`
   and the `iref` `cdsc` association and accept exactly one Exif item associated
   with the primary image. It must not infer ownership from item order or item
   count.
10. **The same-filename corruption exists on iOS too.** The installed iOS
    share extension copies URL-backed shares into the app-group container
    under `url.lastPathComponent`, deleting an existing destination first.
    Android similarly copies into cache under the provider display name. In a
    batch, duplicate names can therefore produce duplicate `contentUri` values
    that both point at the last bytes written. This plan adds a JS fail-closed
    duplicate-URI guard; recovering both originals would require a native
    expo-sharing fix that writes UUID-qualified destinations.
11. **Optional metadata work needs a hard wait bound, not only a performance
    target.** A never-settling native read would otherwise leave the composer
    on “Preparing shared media…” forever. Optional image/video capture-date
    work now shares one absolute 750 ms batch deadline. When it expires, the
    attachment continues without `capturedAtIso`; required video-duration
    validation remains unchanged.
12. **The HEIF field-width rule was too permissive.** ISO-BMFF `iloc` field
    widths used here are `0`, `4`, or `8` bytes, not arbitrary nibble values up
    to eight. Reserved bits must be zero, selected extents must have an
    explicit non-zero length, and duplicate item/location records fail closed.
13. **`mif1`/`msf1` alone do not identify HEVC-backed HEIC.** AVIF files also
    advertise `mif1`. Format sniffing now requires an HEVC-family brand and
    rejects an explicit `avif`/`avis` brand, keeping the stated AVIF exclusion
    true.
14. **A JPEG can contain multiple EXIF-signature APP1 segments.** Taking the
    first would recreate the same plausible-but-wrong metadata risk as taking
    the first HEIF Exif item. Scan through SOS within budget and accept exactly
    one `Exif\0\0` APP1 segment; zero or multiple is a no-op.
15. **The native-share seam needs a native-flow regression.** Unit, hook, and
    screen tests cannot prove that bytes survive the gallery share sheet. The
    existing Android Maestro share flow must use the known-date EXIF fixture
    and assert the date/hint; iOS remains a documented manual pass because the
    OS share sheet is not reliably automatable in the current suite.

## Why the gap exists

The picker path gets a parsed `asset.exif` object from `expo-image-picker`
(`exif: true`) and parses video containers directly from the picked file
(`src/utils/video-capture-date.ts`). The share path
(`src/hooks/use-incoming-memory-share.ts` →
`src/utils/prepare-shared-media.ts`) receives only bare
`{ contentUri, mime type, size }` payloads from `expo-sharing` — there is no
EXIF object, and nothing reads the shared files' metadata. Attachments are
built without `capturedAtIso`, so `useSuggestedMemoryDate` never fires a
`media` suggestion.

Closing the gap means reading capture dates from the shared files' bytes:

- **Videos:** already solved — `extractVideoCaptureDateIso(fileUri)` takes a
  bare URI and does positioned reads. Wire-up only.
- **Photos:** needs a new pure-JS parser that reads EXIF date tags from JPEG
  and HEIC file bytes (no `expo-image-picker` in this flow to do it for us).

## Acceptance criteria

- Sharing gallery photos/videos with a valid capture date into Momora
  pre-fills the date pill with the earliest valid date across all shared
  items, with `dateSource === 'media'` and the "From media" hint.
- The suggestion is user-overridable with identical semantics to the picker
  path: once the user picks a date, no later attachment change rewrites it
  (this already holds — `useSuggestedMemoryDate` is untouched).
- Mixed batches work: a shared dated photo + undated screenshot suggests the
  photo's date; a shared photo + picker-attached photo compete on the same
  earliest-date rule.
- Missing, stripped, malformed, or implausible metadata is a silent no-op —
  the date stays at the session baseline (today), exactly like current
  behavior, and no error ever surfaces.
- **Latency budget (measurable, not circular):** a photo-only share batch
  currently resolves the "Preparing shared media…" state near-instantly
  (no async work per photo today). Extraction must keep it that way:
  target ≤ 50 ms median and ≤ 100 ms p95 added per image, and ≤ 750 ms added
  wall time for a 10-photo batch on the named mid-tier smoke-test device
  (normally one 64 KB positioned read + in-memory parse). Record the device,
  OS, release/dev build type, five warm runs, median, p95, and batch wall time
  in the implementation addendum. Independently of those targets, optional
  metadata extraction stops being awaited at one absolute 750 ms deadline
  measured from the start of the batch; items not resolved by then continue
  without a suggestion. If the target is missed in ordinary (non-timeout)
  runs, tighten the scan budget and re-test before shipping. Videos
  already tolerate the required duration probe;
  capture-date extraction must not extend the video path beyond it (see
  Concurrency below).
- If the first ten supported payloads contain the same non-empty
  `contentUri` more than once, reject the batch with a specific retry/attach-
  from-Momora message rather than attach two references to possibly
  overwritten bytes. This intentionally also rejects sharing the exact same
  file twice; silent corruption is worse than that rare false positive.
- Only the derived `YYYY-MM-DD` scalar enters React state. No raw EXIF/TIFF
  fields (GPS, device, MakerNote), box contents, or intermediate buffers are
  retained past the extractor call, logged, or added to any request/queue
  payload. Same guarantee wording as the picker feature.
- Validation semantics are identical to the picker path: strict Gregorian
  validation, priority `DateTimeOriginal > DateTimeDigitized > DateTime`,
  year floor, `today + 1 day` future tolerance — because the new byte parser
  delegates final validation to the existing tested extractor (see below).

## Confirmed contracts (verified in-repo, 2026-08-09)

- The installed `expo-sharing@56.0.22`'s
  `UriBasedResolvedSharePayload` provides `contentUri`,
  `contentType` (`'image' | 'video' | ...`), `contentMimeType`, and
  `contentSize`. No capture-date field exists on the payload.
- `prepareSharedMedia` already takes injected dependencies
  (`createId`, `getVideoDurationMs`) — the extension point for extractors.
- Shared attachments land in the same `attachedMedia` state in
  `app/(app)/new-memory.tsx` that `useSuggestedMemoryDate` consumes, so no
  screen or hook changes are needed once `capturedAtIso` is populated.
- `extractVideoCaptureDateIso` (video) and `extractCaptureDateIso` (photo
  EXIF-object validation) are shipped, tested, and fail-closed.
- **URI schemes (verified in expo-sharing native source, 2026-08-09):**
  Android's `ResolvingShareIntentDataParser.kt` always copies each shared
  item into `context.cacheDir` and returns a plain `file://` URI — no
  `content://` ever reaches JS, so Android needs no special handling. iOS
  (`SharingRecords.swift`) returns a `file://` URI into the **app-group
  container**. The installed Expo Modules Core explicitly includes entitled
  app-group directories in its iOS filesystem permission scopes, so legacy
  file reads are expected to work there, but this exact path has not been
  exercised in Momora (the picker flow reads app cache; the share duration
  probe uses a different native module). **Device-verify early, before
  building Slices B/C on top:** `getInfoAsync` + positioned
  `readAsStringAsync` against a real iOS share payload URI. Mitigation if
  blocked: copy to a unique file under `cacheDirectory` before parsing and
  use that same copied URI for the attachment, or fail closed to today's
  date. Do not copy only for parsing and leave upload pointed at a potentially
  inaccessible original.
- **Known pre-existing expo-sharing bug (both platforms):** Android copies to
  `context.cacheDir/<provider display name>` and iOS copies URL-backed items
  to `<app-group>/<lastPathComponent>`, replacing an existing file. Two
  same-named items in one share can therefore collapse to the same
  `contentUri` and last-written bytes. Recovery is not possible after JS
  receives the payloads, but this plan can and does detect duplicate resolved
  URIs and reject the batch. A complete fix belongs upstream/in a native patch:
  UUID-qualify every copied filename on both platforms.

## Implementation

### 1. Extract the shared byte-access layer: `src/utils/byte-reader.ts`

Move (pure relocation, no behavior change) from
`src/utils/video-capture-date.ts`:

- `ByteReader` interface
- `createInMemoryByteReader` (test fixture support)
- `base64ToBytes` (manual decoder — Hermes has no reliable `atob`/`Buffer`)
- `createFileByteReader` (the `expo-file-system/legacy` positioned reader)

`video-capture-date.ts` imports from the new module and keeps re-exporting
`ByteReader`/`createInMemoryByteReader` so its existing tests and any callers
compile unchanged. Rationale: the image parser needs identical positioned-read
plumbing; duplicating ~120 lines of byte plumbing (as was done for calendar
helpers) is not justified here because this layer has no validation-semantics
coupling to the shipped photo path. The image entry point must reject a reader
whose `size` is not a positive safe integer before parsing. Keep the low-level
`ByteReader.read` contract permissive for video compatibility; image-specific
exact-read/range enforcement belongs in the new parser.

### 2. New pure parser: `src/utils/image-exif-capture-date.ts`

Exports (mirroring the video module's shape):

- `extractImageCaptureDateFromReader(reader: ByteReader, todayIso?: string): Promise<string | null>` — testable core
- `extractImageCaptureDateIso(fileUri: string, todayIso?: string): Promise<string | null>` — production entry point, fail-closed to `null` on any error, never throws

Behavior:

1. **Format sniffing by magic bytes**, never by mime type or extension:
   - `FF D8` → JPEG
   - A bounded top-level ISO-BMFF walk finds one declared `ftyp` box whose
     major/compatible list contains an HEVC-family brand (`heic`, `heix`,
     `hevc`, `hevx`, `heim`, or `heis`) and does not contain explicit AVIF
     brands (`avif`/`avis`) → HEIC/HEIF. `mif1`/`msf1` may also be present but
     are not sufficient on their own. Parse the box length and 4-byte brand
     entries exactly; do not substring-search arbitrary head bytes.
   - Anything else (PNG, WebP, GIF, unknown) → `null`. PNG `eXIf` chunks are
     explicitly out of scope — vanishingly rare for camera captures.
2. **Read strategy — one bulk head read, not per-segment round-trips.** The
   video parser's one-`readAsStringAsync`-per-atom pattern is wrong for
   images: each positioned read is an awaited native bridge call, and a
   camera JPEG can carry a dozen APP segments (JFIF + multi-chunk ICC
   profiles) before EXIF. Instead, read a fixed head window (64 KB) into
   memory with a single positioned read and parse everything from that
   buffer. Wrap the file reader in a small read-through head cache so TIFF
   reads inside that window do not cross the native bridge again. If marker
   walking proves that another segment header or the selected APP1 payload
   lies beyond the first window, allow exact positioned reads only within a
   fixed total scan-byte/read-count budget (suggested: 512 KB and 16 native
   reads); otherwise return `null`. This preserves the one-read common case
   without making "further reads" an unbounded loophole.
3. **JPEG path:** walk marker segments from offset 2 through the first `SOS`
   (`FF DA`). Validate every segment's declared length, tolerate legal fill
   bytes/restart/standalone markers as appropriate, and count APP1 segments
   whose payload begins `Exif\0\0`. Accept exactly one such segment; zero or
   multiple returns `null`. Do not stop at the first plausible EXIF block.
   Cap the segment scan (e.g. 64 segments) — same bounded-work philosophy as
   the video parser's `MAX_ATOMS_SCANNED`.
4. **HEIC path:** implement a small image-local, parent-aware ISO-BMFF walker;
   do not move/share the current video atom walker in this PR. A child box must
   stay inside its containing box, and `size === 0` extends only to that
   containing range (not automatically to file EOF). Support standard 8-byte
   and `largesize` 16-byte headers with safe-integer arithmetic, exact reads,
   and explicit box-count/nesting/read-byte budgets. Parse exactly one
   top-level `meta`, require its full-box version to be 0, then resolve:
   - `pitm` version 0/1 → primary item ID (16-/32-bit);
   - `iinf` version 0/1 → bounded `infe` children. Only `infe` versions 2/3
     carry `item_type` (`item_ID` is 16-/32-bit); require the selected Exif
     item's `item_protection_index === 0` and a NUL-terminated item name inside
     its box;
   - `iref` version 0/1 → bounded reference child boxes with 16-/32-bit IDs.
     Select exactly one `item_type === 'Exif'` item whose `cdsc` reference
     includes the `pitm` primary ID. No association, a reference to a missing
     item, duplicate reference records, or more than one associated Exif item
     returns `null`; and
   - `iloc` version 0/1/2 → exactly one location record for that selected item
     (16-bit item IDs in 0/1, 32-bit in 2).

   For `iloc`, parse the declared `offset_size`, `length_size`,
   `base_offset_size`, and (v1/v2) `index_size`, accepting only spec-shaped
   widths `0`, `4`, or `8` bytes and consuming `extent_index` when present.
   Reject non-zero reserved construction-method bits. Support
   `construction_method === 0` only, require `data_reference_index === 0`,
   require exactly one extent with an explicit non-zero length, and reject
   every integer not safely representable in JS. Resolve the payload start as
   `base_offset + extent_offset` with checked arithmetic and file containment.

   The Exif item begins with a 4-byte big-endian
   `exif_tiff_header_offset` field whose **numeric value is the authoritative
   skip count**: `tiff_header_start = payload_start + 4 +
   exif_tiff_header_offset`. Read the value and add it — do NOT skip a
   hardcoded amount or use `Exif\0\0` signature detection (that signature is
   JPEG-specific). Fail closed unless the computed bytes are a valid TIFF
   header inside the selected extent. Do not read the entire Exif item: expose
   an extent-bounded reader and fetch only the offset field, TIFF/IFD
   structures, and selected date strings.
5. **TIFF/IFD parse (shared by both paths):** read byte order (`II`/`MM`),
   validate magic `42`, read the first-IFD offset from the TIFF header (do not
   assume IFD0 starts at byte 8), walk IFD0 entries for tag `0x0132` (`DateTime`) and
   the `0x8769` ExifIFD pointer; walk ExifIFD for `0x9003`
   (`DateTimeOriginal`) and `0x9004` (`DateTimeDigitized`). Require the
   ExifIFD pointer to have the expected LONG/count-1 shape. Handle TIFF's
   inline-value-versus-offset rule correctly; all TIFF offsets are relative
   to the computed TIFF header. Read only ASCII (type 2) values of plausible
   non-zero length (≤ 32 bytes); ignore every other tag — GPS IFD (`0x8825`),
   thumbnail IFD chains, MakerNote, and interoperability IFD are never
   followed. Cap entries per IFD and total entries/reads; visit IFD0 and its
   one ExifIFD only, so cyclic pointers cannot cause a walk.
6. **Untrusted-byte invariants:** centralize exact-read and checked-range
   helpers. Never treat a missing byte as zero. Every requested structure
   must be fully present; every computed value must be a non-negative safe
   integer; `start + length` and `count * entrySize` must be checked before
   use; every child range must remain within its declared parent as well as
   the file; counts must agree with the number of complete children parsed;
   and duplicate IDs/records are rejected. Parser budget exhaustion is
   indistinguishable from missing metadata and returns `null`.
7. **Delegate all date validation to the shipped extractor:** assemble a
   plain record from the (up to three) raw tag strings —
   `{ DateTimeOriginal?, DateTimeDigitized?, DateTime? }` — and return
   `extractCaptureDateIso(record, todayIso)` from
   `src/utils/media-capture-date.ts`. This keeps priority order, strict
   `YYYY:MM:DD HH:MM:SS` parsing, Gregorian validation, NUL trimming, year
   floor, and the `today + 1` tolerance single-sourced in already-tested
   code, and means this module never needs its own calendar logic.

Privacy: the only values that survive the function call are the three date
tag strings (handed to the validator) and the returned scalar. GPS/device
tags are never read, decoded, or logged.

### 3. Wire extraction into `src/utils/prepare-shared-media.ts`

- Extend `PrepareSharedMediaDependencies` with:
  - `getImageCaptureDateIso: (uri: string) => Promise<string | null>`
  - `getVideoCaptureDateIso: (uri: string) => Promise<string | null>`
- Split the existing validation into a cheap MIME/size phase and the required
  video-duration phase inside `media-validation.ts`, preserving every shipped
  error string and keeping `validateMediaFile` as the public composed
  validator. Slice to the first ten supported payloads, then preflight the
  cheap phase for all of them in payload order before starting any worker;
  return the first cheap error. Next reject duplicate non-empty `contentUri`
  values, still before any duration/metadata work, with a specific message
  explaining that Momora could not distinguish same-named shared files and
  that the user can attach them from inside Momora instead. This ordering
  preserves existing validation precedence and prevents unsupported or
  oversized untrusted payloads from consuming parser/native work. Images that
  pass can then run optional EXIF extraction. Videos start the required
  duration probe and optional
  capture-date probe together; await both, run duration validation, and only
  then construct an attachment. Use the extractor
  matching `payload.contentType` (the `'image' | 'video'` enum on the resolved
  payload). **Naming hazard:** the loop already declares a local
  `const contentType` holding the MIME string
  (`payload.contentMimeType ?? payload.mimeType ?? ''`) — do not select the
  extractor off that local; use `payload.contentType` explicitly.
- **Concurrency and existing error semantics:** process at most 3 items at a
  time (a small worker pool or equivalent), not an unbounded fan-out. Within
  each video item, duration and capture-date reads run concurrently. Store
  results by original payload index, then assemble in order. The first
  validation failure in payload order must still return
  `{ attachments: [], errorMessage }`, matching today's all-or-nothing
  behavior; do not leak partially prepared attachments or let completion
  order choose the error. It is acceptable that already-started best-effort
  metadata work finishes after another item proves invalid, but no new work
  should be scheduled once a definitive validation failure is known.
- **One absolute optional-metadata deadline:** capture `deadlineAt = now +
  750ms` once per `prepareSharedMedia` call. Each image/video date probe races
  against the remaining time; once expired, workers skip starting new date
  probes and unresolved probes settle to `null`. This is a batch deadline,
  not 750 ms per worker wave. The timer does not cancel an already-running
  native read, but the UI stops awaiting it and no late result mutates an
  attachment. Required video-duration probes are not timed out or weakened by
  this feature.
- An extractor returning `null` (or the injected function rejecting — guard
  with try/catch per item), timing out, or resolving after the deadline
  produces an attachment without `capturedAtIso`, never an error for the
  batch.

### 4. Wire real extractors in `src/hooks/use-incoming-memory-share.ts`

Pass `extractImageCaptureDateIso` and `extractVideoCaptureDateIso` into
`prepareSharedMedia` alongside the existing `getSharedVideoDurationMs`.

No date-state changes are needed in `use-suggested-memory-date.ts`: shared
attachments flow into `attachedMedia` and the hook already derives the
earliest date and preserves user overrides. `new-memory.tsx` uses the settled
"From media" visible/accessibility copy for both picker and incoming-share
suggestions.

## Tests (same PR)

### Unit: `src/utils/image-exif-capture-date.test.ts`

Follow the synthesized-fixture style of `video-capture-date.test.ts`
(byte-level fixture builders + `createInMemoryByteReader`):

- JPEG: APP1-with-EXIF happy path for each date tag and the priority order;
  APP0-before-APP1; no APP1; APP1 without `Exif\0\0`; EXIF present but no
  date tags; two EXIF-signature APP1 segments fail closed; legal standalone
  markers/fill bytes; truncated segment; segment-count budget exhaustion;
  `SOS` reached without EXIF; APP1 beyond the 64 KB head cache; total-byte
  and native-read budget exhaustion.
- TIFF: both byte orders (`II`, `MM`); bad magic; ExifIFD pointer out of
  range; non-8 first-IFD offset respected; wrong ExifIFD pointer type/count;
  inline ASCII versus offset ASCII;
  non-ASCII tag type ignored; zero/oversized ASCII length ignored;
  NUL-padded values (validated via the delegated extractor); entry-count
  budget; truncated exact reads; unsafe-integer/range-addition overflow.
- HEIC: minimal synthesized `ftyp`+`meta`(`pitm`+`iinf`+`iref`+`iloc`)+Exif
  item tree for versions 0/1/2 of `iloc`, `pitm`/`iref` versions 0/1, `infe`
  versions 2/3, and both 16/32-bit item IDs; HEVC major/compatible-brand
  recognition; `mif1`-only and explicit AVIF brands rejected; missing or
  unsupported-version `meta`; missing `pitm`; Exif associated to the primary
  image; sole Exif associated only to a non-primary image rejected; multiple
  Exif items with exactly one primary association selects that item; missing,
  duplicate, ambiguous, dangling, and truncated `cdsc` references fail closed;
  unsupported `pitm`/`iref`/`infe`/`iinf` versions; non-zero selected-item
  protection index; unterminated item name; count/child mismatch; unsupported
  or reserved-bit-set `construction_method`; non-zero
  `data_reference_index`; duplicate `iloc` item IDs; only `0`/`4`/`8` field
  widths accepted; declared `extent_index`; zero/implicit extent length and
  `extent_count > 1` fail closed;
  `exif_tiff_header_offset` handling (non-zero offset value respected);
  truncated item; child box escaping its parent; nested `size === 0` bounded
  to its parent; out-of-file extents; unsafe iloc integers;
  box-count/read/byte budget exhaustion.
- Format sniffing: PNG/WebP/garbage/empty file → `null`; mime type is never
  consulted; invalid/non-safe reader sizes fail closed.
- Date-validation delegation: an implausible-but-well-formed date (e.g.
  future beyond `today + 1`) returns `null` via injected `todayIso` —
  proving delegation rather than re-implementing validation here.
- GPS-bearing fixture: wrap the reader with a read-range spy and assert the
  result is only the date scalar and the GPS IFD byte range is never read.

### Unit: `src/utils/prepare-shared-media.test.ts` (extend)

- Image payloads call `getImageCaptureDateIso`, video payloads call
  `getVideoCaptureDateIso`; the returned ISO lands on `capturedAtIso`.
- `null` and rejected extractor promises still emit valid attachments
  without `capturedAtIso` and no batch error.
- Cheap MIME/size validation runs before duration or metadata probes; invalid
  payloads call neither. The split validation helpers preserve every existing
  message (also extend `src/utils/media-validation.test.ts`).
- Duplicate `contentUri` in the selected first-ten batch returns the specific
  collision error and starts no probes; the same URI outside the selected ten
  does not affect the batch.
- The worker pool never exceeds three active items, results remain in payload
  order, and an earlier-index validation error wins even when a later-index
  error resolves first. Once a definitive error is known, no additional item
  is scheduled.
- With fake timers and a never-settling extractor, the one 750 ms batch
  deadline releases every valid attachment without `capturedAtIso` (not 750 ms
  per worker wave); a result settling after the deadline cannot modify output.
- Existing validation/limit/error-message tests stay green with the new
  required dependencies added to fixtures.

### Unit: `src/utils/video-capture-date.test.ts` (unchanged)

Must pass without edits after the byte-reader extraction — that is the
regression proof for step 1.

### Hook integration: `src/hooks/use-incoming-memory-share.integration.test.tsx` (extend)

- Mock the image/video extractor modules at their filesystem boundary and
  assert the hook passes them through `prepareSharedMedia`: image and video
  dates land on the attachments delivered to `onPrepared`.
- An extractor rejection is swallowed per item, still delivers the valid
  attachment without `capturedAtIso`, clears the native payload once, and
  does not surface the hook's generic "Could not open" error.
- The duplicate-URI guard delivers no attachments plus its specific actionable
  message and still clears the native payload once.
- Keep the existing resolved-share/clear-intent coverage. This suite is the
  proof that production wiring exists; the screen suite below mocks this hook.

### Screen integration: `src/screen-tests/new-memory.integration.test.tsx` (extend)

The file already covers incoming-share flows. Add:

- Invoke the mocked hook's captured `onPrepared` callback with an attachment
  containing `capturedAtIso` → the date pill shows it with the media-source
  hint. Do not describe this as mocking the extractor; extractor injection is
  covered by the hook integration suite above.
- Shared dated media + user override → override survives (reuses existing
  override machinery assertions).
- Extractor returning `null` → today's baseline, no hint (current behavior
  preserved).
- Save path: `capturedAtIso` still never appears in the posting payload
  (extend the existing "no exif in payload" assertion to the share path).
- Update the now-stale inline comment at
  `src/screen-tests/new-memory.integration.test.tsx:320` ("incoming-share
  extraction is out of scope") — its premise is falsified by this plan.

### Native E2E: `.maestro/flows/memories/share-gallery-media.android.yaml`

- Replace the undated profile fixture with
  `.maestro/assets/capture-date-fixture.jpg` (known
  `DateTimeOriginal=2024:03:05`). Keep Momora running while Google Photos
  shares back into it, then assert the attachment, a `2024` date-pill label,
  and the "From media" hint before saving. This is the warm-resume path that
  previously created a second blank `MainActivity`.
- Keep this native flow tagged Android and document it as a release smoke if
  the target Google Photos/emulator image strips EXIF while importing. The
  hook and screen integration tests remain the deterministic CI regressions.

### Device verification (manual smoke, both platforms)

The Android flow above exercises one OS-share path, but share providers and
iOS share-sheet automation remain variable, so also complete this documented
manual pass on iOS + Android release/dev-client builds:

- Share 1 photo taken N days ago from the system gallery → date pre-fills.
- Share a HEIC (iOS Photos default) and a JPEG → both pre-fill.
- Share a photo+video batch spanning dates → earliest wins.
- Share a WhatsApp-saved / metadata-stripped image → stays today, no error.
- **iOS first, before Slices B/C:** confirm `expo-file-system/legacy`
  `getInfoAsync` + positioned `readAsStringAsync` work against a real iOS
  share payload URI (app-group container — see Confirmed contracts). If
  blocked, implement the cache-copy fallback and re-verify.
- Time a 10-photo share batch against the latency budget above; record the
  named device/OS/build and five warm-run median, p95, and batch wall time in
  this plan's implementation addendum.
- On both platforms, share two identically-named photos with different dates;
  confirm the duplicate-URI guard rejects the batch rather than attaching
  duplicate/last-written bytes. Then verify that two differently named files
  still prepare normally.
- Confirm no memory-content or metadata logging (PII rule).

## Documentation (same PR)

- This plan doc: record findings/addenda as implementation proceeds.
- `docs/PRD.md` §6.3: replace the current sentence that explicitly excludes
  videos and incoming shared media. State that supported library-picked and
  incoming-shared photos/videos may supply the same visible, overridable
  earliest capture-date suggestion; camera captures and web picks do not.
- [media-exif-capture-date-prefill.md](media-exif-capture-date-prefill.md):
  strike "Incoming-share EXIF extraction" from Explicitly out of scope with a
  dated **Done** note linking here (same pattern as the video addendum).
- `docs/features/media-memories.md`: this file had two load-bearing sentences
  that excluded incoming capture dates; correct them rather than merely
  appending new text. Also update the module/integration table (~lines
  174–190) that frames `capturedAtIso` as picker-only. Then extend the
  capture-date section with the incoming-share path, new modules,
  integration points, privacy posture, and a dated changelog row; list all
  new/updated tests in Testing.
- `docs/TECH_SPEC.md` §5.5: one line noting client-side capture-date
  extraction now also covers incoming-share media; no API/schema change.

## Verification

```bash
npm run typecheck
npm run lint
npm test -- --runInBand
maestro test .maestro/flows/memories/share-gallery-media.android.yaml
```

(Node 20 via nvm. No Edge Functions touched, so no `npm run test:edge`.)
Then the manual device smoke above; commit only after device confirmation.

## Explicitly out of scope

- PNG `eXIf` / WebP `EXIF` chunk parsing
- AVIF (`avif`/`avis` ftyp brands) — also ISO-BMFF but not a realistic
  Photos-app share source; sniffing treats it as unrecognized → `null`
- GPS/location extraction of any kind (GPS IFD is never followed)
- Text/URL share payloads (unchanged: rejected with the existing message)
- Persisting per-asset capture timestamps
- Memory edit-screen date suggestion (still out of scope from Phase 1)
- Changing the video-duration probe (`getSharedVideoDurationMs`) — duration
  and capture date remain independent reads

## Sequencing / effort

These are implementation checkpoints inside one feature release, not
independently documented releases. Do not ship an intermediate slice while
the PRD/feature doc claim both photo and video support. If Slice A is released
separately, narrow that release's acceptance criteria and documentation to
shared videos, then expand them only when B/C actually ship.

1. **Slice A — shared videos (small):** steps 1 (partial: only if the byte
   reader move is done here; otherwise none), 3, 4 for video only + tests.
   Can be validated on its own, subject to the documentation rule above.
2. **Slice B — JPEG (medium):** byte-reader extraction + JPEG/TIFF parser +
   wiring + tests.
3. **Slice C — HEIC (medium-large, fiddly):** parent-aware HEIF box walk +
   `pitm`/`iref` association + `iloc` + reuse of the TIFF parser + tests.
   Required for the primary iOS Photos flow; the feature is not "done" for
   the gallery-share use case without it.

Rough total: 4–6 days for the bounded JPEG/TIFF/HEIF parser, adversarial
fixtures, wiring, documentation, and two-platform device measurements. The
code changes are OTA-safe only for compatible installed binaries that already
contain the current share extension and filesystem native modules; they are
pure TS over the already-bundled `expo-file-system/legacy` API.

## Implementation addendum (2026-08-09)

Implemented in the same feature change:

- `src/utils/byte-reader.ts` centralizes positioned file reads for image and
  video metadata; `src/utils/image-exif-capture-date.ts` adds bounded JPEG and
  HEIC EXIF extraction that returns only a validated date scalar.
- `src/utils/prepare-shared-media.ts` now cheap-validates selected payloads,
  verifies each provider copy exists at the reported byte size, rejects
  duplicate selected `contentUri` values, limits preparation to three workers,
  preserves payload-order errors, and applies one 750 ms deadline to optional
  date extraction.
- `src/hooks/use-incoming-memory-share.ts` injects the production image/video
  extractors and refreshes Expo's hook state after native clearing so a later
  share of the same URI is processed; the composer and date-state hook consume
  the resulting presentation-only `capturedAtIso` scalar. Memory hint and
  accessibility copy is consistently **"From media"**.
- Unit/integration coverage spans parser validation, shared-media preflight and
  deadline behavior, production hook wiring/error clearing, and composer
  baseline/override/no-posting-metadata behavior. The Android Maestro flow
  uses `.maestro/assets/capture-date-fixture.jpg` and asserts the date/hint.
- Final independent checks: `npm run typecheck` passed; `npm run lint` exited
  0 with only pre-existing repository warnings (none in feature files); full
  Jest passed (180 suites / 1,708 tests); Edge tests passed (728 pass / 0 fail
  / 1 ignored); secret scan and `git diff --check` were clean.

**2026-08-09 Android device finding:** a production Pixel 9a reproduced the
blank screen. Android showed the normal launcher task and a second gallery
`ACTION_SEND` document task, each containing `MainActivity`; the share activity
rendered only an empty native `FrameLayout`, and React Native reported focus
while its context was not ready. The installed manifest had
`launchMode="standard"`, and Google Photos supplied
`NEW_DOCUMENT | MULTIPLE_TASK`. `plugins/withAndroidLaunchMode.js` now uses the
RevenueCat-supported `singleTop` mode plus `documentLaunchMode="never"`, which
overrides those gallery flags and reuses the one React activity. This is a
native manifest change and therefore requires a new Android binary; the OTA
published earlier that day cannot fix the installed launch mode.

On that same production binary, a controlled cold share of
`.maestro/assets/capture-date-fixture.jpg` through Google Photos succeeded:
the composer showed one attachment and **Mar 5, 2024 · From media**. Google
Photos also displayed the fixture as March 5 before sharing. This proves the
published parser/wiring path for a known valid JPEG; it does not prove that the
user's original gallery item retained a supported capture-date field.

**Release gates still open:** rebuild Android with the corrected manifest,
then rerun the Google Photos warm-resume and cold-start smokes (including
repeated same-photo sharing) and the full JPEG/HEIC/video/stripped/duplicate-name
matrix. The connected device
was PIN-locked after the diagnostic process restart, so capture-date behavior
for the user's exact gallery item could not yet be inspected. iOS manual
coverage and the five-run 10-photo timing measurements (device, OS, build,
median, p95, and wall time) also remain required. Provider import behavior may
strip EXIF, so the native flow is a release smoke, not reliable CI; this does
not yet claim complete production-device verification.

## Settled decisions

1. **Hint copy:** use **"From media"** for visible and accessibility copy in
   both picker and incoming-share paths.
2. **Same-name collision behavior:** reject selected payloads with duplicate
   `contentUri` values using the actionable attach-from-Momora message; do not
   risk attaching overwritten bytes.
3. **Correctness/responsiveness over best-effort coverage:** require the real
   HEIF `pitm`/`iref` association and stop awaiting optional metadata at the
   single 750 ms batch deadline. Non-conforming or slow media falls back to
   today's baseline rather than delaying the composer.
