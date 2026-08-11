# Feature: Gallery import

**Status:** `done` (implementation complete; production rollout is gated)
**Last updated:** 2026-08-10
**PRD reference:** [PRD §6.3a Gallery import](../PRD.md#63a-gallery-import--ai-staged-camera-roll-memories)
**Design authority:** [gallery-import design README](../design/gallery-import/README.md) and its pinned Claude handoff. The handoff controls composition, interaction hierarchy, motion, platform manners, accessibility, and state coverage. This document and [the implementation plan](../plans/gallery-import.md) control product/security/operations.

## Overview

An owner or manager can explicitly ask Momora to look through the photos currently permitted on the originating device, group them into events, and stage AI-curated memory suggestions. Momora never changes the camera roll. It uploads downscaled private previews before review so its vision provider can curate suggestions; only final approval uploads and retains full-resolution originals as ordinary private `media` memories. The feature is device-bound, resumable in the foreground, and opt-in behind client and server admission controls.

## User-facing behavior

- Entry points are visible to owners/managers after normal onboarding and paid-access checks. Viewers see an explanatory disabled Settings row; they cannot start, view, or act on a run.
- Before the OS ever asks for photo permission, a trust explainer (`GalleryImportTrustExplainer`) states in plain terms what happens: the phone does the looking, small previews go to Momora and its AI partner, and only what is kept is saved — with two detail sheets ("What a preview is", "What is kept, and for how long") for a parent who wants the honest specifics. "Not now" is a real, equal option, never disabled to nudge a decision.
- The consent screen says what is scanned, that small previews go to Momora and its AI partner, that originals are uploaded only after approval, and that nothing is changed in the camera roll. v1 suggests **photos only**—videos are not silently included.
- iOS/Android permission can be full, limited/selected, denied, or blocked. Each of the three non-full outcomes is a dedicated full screen (`GalleryImportPermissionOutcome`) rather than inline error text: limited shows a "Look through these"/"Choose more photos" choice, denied explains the device Settings path with no scan attempted, blocked opens Settings directly since the OS will not ask again. The permitted corpus is snapshotted before the run; choosing more photos applies only to a later run. No location permission is requested and no GPS, filename, raw OS asset ID, face/biometric signal, or identity inference is sent to the server.
- The foreground scanner pages lightweight metadata newest-first, groups dated photos with frozen `gallery-v1`, makes 512px JPEG previews, then uploads/dispatches them in bounded chunks. On iOS it also reads each asset's `mediaSubtypes` (one `Asset.getMediaSubtypes()` call per photo, failure-isolated) and drops screenshots before clustering; Android has no subtype signal in this SDK and admits conservatively (no filtering) instead of guessing. On iOS it uses Expo Media Library's no-download cloud check before URI resolution, so an iCloud-only original is omitted without initiating a download; Android/default assets are treated as local. It prefers Wi-Fi and offers an explicit cellular override, confirmed through a sheet (not a bounce back to the entry screen) that resumes the runner in place once cellular is allowed. “Safe to close” means checkpointed resume, not that foreground scanning, local normalization, or original retrieval continues after process death — the progress screen's copy says exactly that ("Safe to close Momora. Your place is saved.") and never claims background continuation.
- **Camera-captures-only corpus (2026-08-11 product decision).** "We only care about what pictures people take with the phone" — WhatsApp/iMessage/downloads saves are out of scope. On Android, the scanner resolves the exact-title `'Camera'` album (`MediaLibrary.Album.get('Camera')`, the DCIM camera bucket as a de-facto OEM standard) once at scan start and scopes every query to it via the class-based `Query`'s `.album()` filter — exact-title match only in v1; rare OEM variants that split captures across multiple album titles are not handled. If no `'Camera'` album resolves, or the native Album API itself fails, the scanner falls back to today's full-library + date-plausibility scan; either way the pass records which mode ran (`GalleryCorpusMode`: `'camera_album' | 'full_library_fallback'`), surfaced (data only, no UI) through `GalleryScanSnapshot.corpusMode` and `startGalleryImportRunner`'s checkpoint bookkeeping. **iOS has no camera-source signal at all** and deliberately keeps the full library — a WhatsApp photo only enters the iOS library if the user explicitly saved it, an explicit action, not an automatic sync — so iOS always reports `'full_library_fallback'`; this is corpus-mode bookkeeping, not a behavioral regression. The date-less-photo fallback some WhatsApp/forwarded photos would need was considered and **rejected** (2026-08-11): `isPlausibleCaptureTime` stays exactly as it was, no new date-inference path.
- The progress screen shows a real, staged view of the run — an eyebrow/title/body per stage, a determinate progress bar once a real total is known (indeterminate only while it genuinely isn't), a 4-step checklist, and a "Safe to close"/"Please keep Momora open" card that is honest per stage. The user is moved onto this screen as soon as a run exists (`onRunStarted`), not kept on the entry screen for the whole scan/prepare/upload pass; live counts are published through `src/utils/gallery-import-live-progress.ts` so the screen that started the run and the screen showing it can be different mounted components.
- A run that finds nothing gets one of three distinct calm screens (never a generic error): nothing stood out among readable photos, no dated photos on this device at all, or nothing yet from a limited-access grant (with a path to choose more photos). A run that stops for a reason outside the user's control — a lapsed subscription, a demoted role, a reached run cap, offline, a transient hiccup, or an unrecoverable failure — gets its own distinct copy instead of the old single ambiguous "Your family access or import eligibility changed" message.
- Suggestions appear in a read-only deck. Keep proceeds to a composer where caption, date, tags, and the selected photos can be edited; Set aside is a recoverable in-run skip. No card is auto-approved or automatically resurfaced in a future run. Another device is told to continue on the device that scanned the photos, without previews, device name, or counts.
- Approval is checkpointed before original upload. Relaunching with an uploading/finalizing outbox returns directly to that locked composer and resumes once; a failed outbox waits for an explicit retry that reuses its lease. If the server committed `begin-gallery-import-approval` but the client timed out before checkpointing its response, the server's `approving` candidate routes back to the composer, idempotently recovers the stable lease, and does not create or edit a second memory.
- A locked approval recovery has no editable inputs, so its pinned safe-area footer deliberately bypasses keyboard translation. This keeps Retry saving in the native accessibility frame while the normal editable composer retains keyboard-sticky behavior.
- Final approval creates one `memory_type='media'` memory with `creation_source='gallery_import'`, its selected original assets, optional tags, and (when supplied by curation) its emotion. It never generates an illustration. Normal photo limits still apply: 1–10 assets; originals may be JPEG/PNG/HEIC/HEIF/WebP and are limited to 20 MiB each.
- Family members receive one generic timeline digest after **30 minutes of no new gallery approvals**. Every new approval restarts that quiet period. The notification intentionally omits candidate/memory IDs and counts.

## Architecture

```mermaid
sequenceDiagram
  participant D as Origin device
  participant E as Supabase Edge Functions
  participant R as Private Cloudflare R2
  participant W as GalleryImportWorkflow
  participant O as OpenAI gpt-4o-mini

  D->>D: Permission snapshot, metadata scan, cluster, checkpoint
  D->>E: Create admitted run
  E-->>D: Run capability and immutable limits
  D->>D: Serially make previews; omit unavailable/corrupt assets
  D->>E: Register bounded chunk manifest
  E-->>D: Required accepted tokens/suppressed clusters
  D->>E: Request PUT URLs only for accepted previews
  D->>R: PUT transient 512px JPEG previews
  D->>E: HEAD-verified dispatch
  E->>W: HMAC-authenticated chunkId only
  W->>E: Timestamped HMAC bridge: private chunk input
  W->>R: Read/validate previews
  W->>O: One bounded vision request per cluster
  W->>E: Idempotently publish complete candidate rows, scrub input
  D->>E: Capability-bound review actions / approval lease
  D->>R: PUT originals only after approval
  D->>E: HEAD-verified atomic finalization
```

The device alone keeps the opaque-token → OS-library-ID mapping in an authenticated, user/family/run-scoped AsyncStorage checkpoint. Postgres, R2 keys, analytics, logs, prompts, and Workflow state never receive raw OS identifiers. The run capability is high-entropy, stored only in that checkpoint, and hashed server-side; it is required alongside the caller JWT and exact-family role check for run/candidate/approval operations.

## Data model

| Table / prefix | Role and retention |
|---|---|
| `memories.creation_source` | Server-owned provenance: `manual`, `onboarding`, or non-displayed `gallery_import`. |
| `families.gallery_caption_language`, `gallery_caption_instructions` | Owner-only BCP 47 caption locale and sanitized optional instructions (≤500 chars). |
| `gallery_import_admission_settings` | Singleton launch/admission/TTL/quiet-period and immutable per-run-limit source. `enabled` is the server kill switch. |
| `gallery_import_runs`, `chunks`, `assets`, `cluster_results` | Device-bound run, immutable manifest, preview receipts, and terminal cluster ledger. Review TTL defaults to 30 days (constrained to 1–90 days); a due completed run becomes `expired` only when fenced cleanup claims its transient objects. |
| `gallery_import_candidates`, `cluster_receipts` | Staged drafts and best-effort future suppression, without raw photo IDs or visual fingerprints. Candidate caption is replaced on expiry. |
| `gallery_import_provider_attempts` | Private attempt/usage/error audit. A network/timeout outcome is `ambiguous` and is not automatically replayed. |
| `gallery_import_approval_leases` | Stable memory ID and exact original keys for idempotent approval/finalization. |
| `gallery_import_digest_windows` | Per family/actor 30-minute quiet-period aggregation. After a sent window resets to zero, the next approval restores both timestamps and starts a fresh quiet period while preserving any active claim fence. |
| `gallery_import_workflow_bridge_nonces` | 10-minute HMAC replay protection. |
| `{userId}/gallery-import/{runId}/previews/{assetToken}.jpg` | Private transient preview; deleted by fenced cancel/expiry cleanup. |
| `{userId}/memories/{memoryId}/media/{assetId}.{ext}` | Private approved original; retained as normal journal media until its memory/account/family is deleted. |

All gallery tables use RLS with no direct client table policies. Client reads and mutations go through capability-bound security-definer RPCs and authenticated Edge Functions. Approval finalization is the only route that writes gallery provenance/originals into normal memory tables. Family/account cascade and cleanup delete unapproved server objects but never touch the device library or already-approved journal media.

### Exact launch limits

The authoritative limit snapshot is copied onto each run. The default admission template is 20 chunks/run, 1,000 assets/run, 100 assets/chunk, 60 candidates/run, at most 3 provider attempts/cluster, 10 images/cluster, and 1,500,000 preview bytes/image. The foreground scanner additionally pages at 100, considers at most 4,000 assets per scan pass (`GALLERY_IMPORT_MAX_ENUMERATED_ASSETS`, raised from 2,000 with progressive deepening; unchanged `gallery-v1` algorithm/signatures), groups across a 3-hour gap, and locally caps clusters/assets at 60/10. These are implementation limits, not a claim that every device uploads or receives that many suggestions. Once the candidate cap is full, later valid model groups close as suppressed/no-candidate outcomes instead of failing their chunk or Workflow.

Progressive deepening (`src/utils/gallery-import-frontier.ts`) lets successive runs walk backward through the whole library instead of always re-covering the same newest 4,000-asset window: a per-user+family AsyncStorage record (`GalleryImportFrontier`) tracks the newest and oldest `captureAtMs` fully covered so far, a sticky `completedLibrary` flag, and the `corpusMode` (camera-album vs. full-library) those bounds were built under. Each scan spends its one budget on Phase A (catch up on anything newer than last covered) then Phase B (deepen older than the stored frontier), querying the native store directly by `creationTime` rather than re-paging the already-covered middle range. The frontier advances only after a run's chunks are confirmed **registered** server-side (never at scan time), using only the actually-accepted/registered coverage — a crash before registration leaves it untouched, and overlap is tolerated gracefully (Math.max/Math.min merge; true duplicate-cluster suppression stays a server-side receipts concern). If a run's resolved corpus mode differs from the stored frontier's (the Android camera album appeared/disappeared between runs), the frontier **resets** rather than mixing bounds across corpora — both `scanGallerySnapshot` (ignores mismatched bounds before windowing) and `mergeGalleryImportFrontierCoverage` (discards the stale record before merging) independently guard this. `startGalleryImportRunner`'s return payload exposes `moreHistoryToScan: boolean` (data only, no UI yet) for a future "there are older photos to look through" affordance.

Initial admission permits two family-wide device-bound runs in the first 30 days and one active family run at a time; normal admission then allows one run per UTC calendar month. Server admission freezes the snapshot so a setting change cannot alter an in-progress run. Turning admission off stops new runs while already admitted scanning, dispatch, review, and approval remain available until terminal state or expiry.

## API, RPCs, Edge Functions, and Worker

All user endpoints require a non-anonymous JWT, paid write access where mutation requires it, owner/manager authorization for the specified live family, and the run capability where a run/candidate is involved. Closed error codes are returned; no content-bearing values are logged.

| Endpoint | Call order / responsibility |
|---|---|
| `create-gallery-import-run` | Creates an admitted run from `familyId`, algorithm/consent versions, and permission mode; returns server limits and a one-time run capability. |
| `register-gallery-import-chunk` | Validates the bounded cluster/token/date/dimension/favorite manifest after locally unavailable/corrupt assets are omitted, then returns required `acceptedAssetTokens` and `suppressedClusterSignatures` before upload. |
| `get-gallery-import-upload-url` | Server chooses the exact preview key and returns a short-lived PUT URL with signed JPEG metadata headers including hash, bytes, and dimensions. |
| `dispatch-gallery-import-chunk` | HEAD-verifies every preview/metadata receipt, freezes the chunk, then HMAC-dispatches only `chunkId` to the Worker. |
| `get-gallery-import-run`, `get-gallery-import-candidates` | Capability-bound status/candidate reads; candidate preview URLs are private, short-lived (5 minutes). |
| `set-gallery-import-candidate-skip`, `update-gallery-import-candidate` | In-run skip/undo and composer edits. Edited assets must be selected from that candidate’s cluster; caption is 1–1,000 chars and a candidate has 1–10 assets. The Worker’s vision draft cap is 480 characters. |
| `begin-gallery-import-approval` | Rechecks access and reserves a stable memory ID, lease, and exact original-key manifest. |
| `get-gallery-import-approval-upload-url`, `record-gallery-import-approval-upload`, `finalize-gallery-import-candidate` | Resolve originals locally; server-chosen PUT URL; R2 HEAD/receipt; then one atomic RPC to create memory/media/tags/provenance, receipts, and digest window. |
| `cancel-gallery-import-run`, `complete-gallery-import-run` | Capability-bound terminal controls. Cancellation/expiry clears local checkpoint/cache and fenced cleanup deletes unapproved objects. |
| `get-gallery-caption-settings`, `update-gallery-caption-settings` | Owner-only caption locale/instruction retrieval and autosave. |
| `cleanup-gallery-imports` | Cron-secret-only hourly cleanup and bridge-nonce pruning. Any due run, including a completed run, becomes `expired` as the deletion fence; object delete failures keep that fence open for retry. Finalized original media, memories, and approved receipts remain excluded/preserved. |
| `send-gallery-import-digests` | Cron-secret-only, every five minutes; claims windows quiet for 30 minutes and sends one privacy-filtered timeline digest using notification preferences/block rules. |
| `workflow-gallery-import-bridge` | Narrow timestamped HMAC bridge with nonce protection for Worker input, attempt leasing/usage, publication, failure, and scrub operations. It does not expose a Supabase service-role key to Cloudflare. |

`GalleryImportWorkflow` in `cloudflare/memory-illustration-worker` drops assets that duplicate an earlier asset's expected byte hash within a cluster (exact-hash only, not perceptual dedup), validates private preview bytes/type/dimensions, processes at most ten images per cluster, and calls `gpt-4o-mini` with a schema-constrained multi-image request. The prompt instructs the model to prefer meaningful people photos, select for variety across the cluster's arc, exclude screenshots/screens/documents/receipts/food-only shots, stage a single-photo cluster only when it clearly stands alone, and return zero groups ("silence beats a bad card") for a mundane/utilitarian cluster or when uncertain. One cluster may split into at most three groups and may never merge with another cluster. A closed `DEFAULT_GALLERY_MIN_CONFIDENCE` (0.6) gate then drops any returned group below that score before publication; a cluster whose groups are all dropped this way publishes as a `low_confidence` skip instead of staging a weak card. It stores only scalar Workflow-step outputs: previews, prompts, model responses, semantic descriptions, and captions do not enter Workflow history/logs. Definite retryable provider failures may use the bounded attempt cap; an ambiguous network/timeout/disconnect is quarantined and requires reconciliation/manual retry rather than an automatic possibly-billed replay.

## Client integration

| Layer | Files | Responsibility |
|---|---|---|
| Routes | `app/(app)/gallery-import/{index,progress,review,approve,settings}.tsx` | Entry, progress/resume, deck, approval, and (family-owner-only) caption settings screens. |
| Components | `src/components/gallery-import/gallery-import-{entry,progress,review,approval,shared}.tsx`, `gallery-import-{trust,empty,exception}.tsx`, `gallery-import-settings.tsx`, `gallery-import-caption-settings.tsx` | Entry/progress (redesigned per the fix plan: trust explainer gating, staged progress, real counts) and review (the read-only deck); `trust` (pre-permission explainer + permission outcomes), `empty` (nothing-found outcomes), `exception` (calm full-screen states + inline notice) are new; `shared` holds chrome both phases reuse (top bar, sheet, pill, reassure line, progress bar, icon set, and the two generic terminal notices) plus the original Header/PrimaryButton/SecondaryButton review/approval still depend on. **`gallery-import-settings.tsx`** is now just the Settings-tab row (human-readable selected-language caption, pushes the settings route for an owner, disabled/no-navigation for anyone else); **`gallery-import-caption-settings.tsx`** is the pushed screen itself — language row + searchable locale picker (curated list, "Current"/"Recently used"/alphabetical sections, keyboard-safe bottom sheet sized by `computeGalleryCaptionLocalePickerSheetMetrics`) plus the instructions field/trust card/example draft, still with the owner-only 500ms-debounced autosave. **`gallery-import-approval.tsx` is now a thin wrapper around `src/components/memory-composer-form.tsx`** — the same shared form `app/(app)/new-memory.tsx` and `app/(app)/memory/[id]/edit.tsx` render, extended with gallery-import-only slots (from-the-photos date pill, AI-draft hint/restore, day-pool Add tile, per-tile unavailable state, footer reassurance line) rather than a parallel form; see that file's header comment for the extraction boundary. |
| Hook | `src/hooks/useGalleryImport.ts` | Feature-gated run/caption-settings query/mutations. |
| Services | `src/services/gallery-import.ts`, `gallery-import-runner.ts` | Edge contracts; foreground scan/preview/upload/dispatch and resume (`resumeGalleryImportRunner` accepts an `allowCellular` flag so the cellular-confirm sheet can resume in place; `onRunStarted` lets a caller navigate to the progress screen as soon as a run id exists). |
| Utilities | `src/utils/gallery-import-{scanner,preview,original,checkpoint,frontier,e2e-adapter,flags,live-progress,progress-stage}.ts` | Permission adapter, deterministic clustering, preview/original conversion, local retention, test adapter, opt-in flag; `frontier` is the per-user+family progressive-deepening record described above; `live-progress` is an in-memory pub/sub bus so the progress screen can render the runner's live counts even when a different screen started it; `progress-stage` is the pure function that decides which of the eleven designed stages/exception/empty outcome to show from real checkpoint/server/billing/family/network state. |

`EXPO_PUBLIC_GALLERY_IMPORT_ENABLED === 'true'` enables client entry points and new-run creation only. It intentionally does **not** revoke a capability-bound admitted run: its resume, dispatch, review, approval, cancellation, and completion calls remain usable after the flag is turned off until terminal state or expiry. The database singleton’s `enabled` field separately controls new server admission without stranding already admitted runs. `EXPO_PUBLIC_E2E_GALLERY_IMPORT_ADAPTER === 'true'` works only in `__DEV__` builds and provides deterministic fixtures; it must never be enabled in a production build.

## Extension guide

**Safe to extend**

- The day-pool photo chooser is wired: `GalleryImportApproval`'s `onAddPhotos?: (context: GalleryImportAddPhotosContext) => void` seam (`src/components/gallery-import/gallery-import-approval.tsx`) hands the current selection context to the route (`app/(app)/gallery-import/approve.tsx`), which opens `GalleryImportPhotoChooser` (`src/components/gallery-import/gallery-import-review-sheets.tsx`) in select mode over the candidate's reconstructed cluster pool (`buildGalleryImportDayPool` in `src/utils/gallery-import-deck.ts`). The pool is limited to server-admitted cluster assets — anything else would fail `update-gallery-import-candidate`'s cluster check. From the read-only review deck the same sheet opens in browse mode.
- Add a locale through the shared caption-locale registry (`src/constants/gallery-caption-locales.ts`), preserving owner-only autosave and server BCP-47 validation. Two lists live there: `galleryCaptionLocaleTags` (241 entries — the full accepted/validated set; `normalizeGalleryCaptionLocale` and the Edge Function's BCP-47 shape check both key off this, unchanged by curation) and `curatedGalleryCaptionLocaleTags` (48 entries — 2026-08-10 product decision; presentation-only, what the picker actually browses/searches). Adding a language: give it a real `{ en, native }` pair in `GALLERY_CAPTION_LOCALE_NAMES` (never rely on `Intl.DisplayNames` as the source of truth — Hermes on-device silently echoes the input tag back instead of throwing when it lacks ICU data for a locale, unlike Jest's full-ICU Node runtime); add it to `curatedGalleryCaptionLocaleTags` only if it should actually appear in the picker.
- Add aggregate, scalar, content-free analytics only through the typed catalog in `src/services/analytics.ts` and [analytics.md](./analytics.md).
- Tune admission only through the server settings and a new benchmark/decision record; preserve immutable run snapshots and the client/server caps.

**Do not change without coordinated contract/privacy review**

- Do not use a generic upload URL or accept client-chosen import keys. Preview and original PUTs must stay run/lease-bound and be HEAD-verified.
- Do not persist OS asset IDs, file names, GPS, face/identity results, prompts, model output, image-derived descriptions, or unapproved preview bytes outside their private short-lived path.
- Do not treat limited/selected access as full-library access, silently add later-granted photos, or claim work continues after app process death.
- Device-local availability detection, URI resolution, and serial preview conversion share a 30-second per-photo deadline and a five-minute absolute preparation budget per fresh/resume pass; each attempt receives the smaller remaining duration. The budget begins immediately before chunk preparation, after metadata scan/admission/checkpoint save for a fresh run or remote reconciliation for resume. Once exhausted, no additional native asset work starts. Fresh runs and force-quit checkpoints that have not registered a chunk omit cloud-only/timed-out/unavailable photos before manifest admission, and close exhausted empty plans without server admission so later unregistered chunks can close immediately. If a photo was already server-admitted, resume stops with a content-free retryable error instead of silently changing the immutable manifest. Each preparation attempt has a unique device-local cache filename, so late native completion is deleted without touching a newer retry; these local keys never enter manifests, uploads, or checkpoints.
- Resume reconciles server state before constructing a media adapter. If the run is already `reviewing`, admission is terminal: no availability check, URI resolution, preview generation, registration, upload, or dispatch is attempted. Remaining unadmitted local plans are closed and cleared; admitted chunk receipts, `assetByToken`, review progress, and approval outbox state are retained. The transition is idempotent on relaunch.
- Original resolution, upload URL requests, PUTs, receipts, and finalization use a 30-second per-step deadline and a two-minute foreground approval budget per attempt. Approval deliberately skips discovery's local-only cloud preflight: keeping a memory is an explicit request for PhotoKit to retrieve its selected iCloud originals, while the deadline keeps that foreground download bounded. Missing/deleted originals still fail, and a late iCloud retrieval can make the explicit retry succeed. The composer shows content-free per-photo progress. A timeout leaves the stable lease/outbox retryable; automatic recovery runs once, while a failed attempt requires an explicit retry. Finalization and local outbox removal are idempotent, including a late result from an earlier timed-out native operation.
- Approval diagnostics expose only the current content-free stage—preparing, requesting a secure upload, uploading, confirming, or finalizing—and a test-addressable error. A `recorded:false` receipt is a failed confirmation, never treated as permission to finalize.
- Native presigned PUTs use Expo FileSystem's foreground URLSession. This keeps iOS PhotoKit full-size file URLs in the app process that resolved them and matches the product promise that uploads pause rather than continue after the app closes.
- Do not auto-approve, use a per-memory notification fan-out, make candidates cross-device, include video/GPS/face recognition, or replay an ambiguous provider call.
- Changing the algorithm/signature/caps/vision model/retention needs migration and Worker/Deno/client/pgTAP coverage plus updates to this doc, TECH_SPEC, privacy/store copy, and the rollout record.

## Dependencies

- Depends on: family roles, paid access, R2 presigning, private media storage, Expo Media Library, Cloudflare Worker/Workflows, OpenAI vision, notifications, analytics, and account/family deletion.
- Used by: timeline/calendar media memories, family notification delivery, data retention/cleanup, and release/store declarations.

## Testing

### Unit tests

| File | Covers |
|---|---|
| `src/constants/gallery-caption-locales.test.ts` | BCP-47 locale registry/search/normalization; static-name coverage for every registry tag (regression trap simulating a Hermes-like `Intl.DisplayNames` that's missing or echoes the input back); curated-subset size/dedup/full-registry-name-parity/validation-still-accepts-outside-curated coverage. |
| `src/utils/gallery-import-scanner.test.ts` | Permission states, iOS no-download cloud availability detection, deterministic signatures/clusters/caps, paginated scan behavior, progressive deepening's two-phase (catch-up/deepen) windowed scan and `reachedLibraryEnd` reporting, Android camera-album resolution (found/not-found/API-failure/iOS-omitted) and album-scoped querying, and `corpusMode` resolution including ignoring a mismatched-mode frontier. |
| `src/utils/gallery-import-checkpoint.test.ts` | Scoped checkpoint, corruption/size handling, cleanup and resume state. |
| `src/utils/gallery-import-frontier.test.ts` | Frontier storage round-trip/scoping/corruption handling (including a rejected/unknown `corpusMode`) and the pure coverage-merge function (monotonic extension, overlap tolerance, sticky `completedLibrary`, and resetting rather than mixing bounds across a corpus-mode change). |
| `src/utils/gallery-import-progress-stage.test.ts` | Pure stage/exception/empty derivation: signal priority (lapsed over demoted over offline over live progress over server status), real-count rendering, and the zero-ready/untouched-deck "nothing stood out" vs. "ready" distinction. |
| `src/utils/gallery-import-live-progress.test.ts` | The runner-progress pub/sub bus: subscribe/publish/retained-latest-snapshot, per-run isolation, and the active-run flag two concurrent callers (entry's start pipeline and the progress screen's own resume) use to avoid a double resume. |

### Integration tests

| File | Covers |
|---|---|
| `src/services/gallery-import.integration.test.ts` | Feature-gated Edge service request shapes and errors. |
| `src/services/gallery-import-runner.integration.test.ts` | Scan → manifest → preview upload → dispatch/resume sequencing, including terminal reviewing reconciliation, prepare-before-admission resume, unavailable/suppressed pruning, per-asset and five-minute invocation budgets, exhausted-tail suppression, registered retry semantics, late-artifact cleanup, `onRunStarted` firing as soon as a run id exists (before any preview work), the distinguishable empty-library error, the `allowCellular` gate on a resume with pending uploads (including that an all-dispatched resume is never gated on network state), and progressive deepening (frontier advances only once registration settles on both start/resume, stays untouched across a mid-run throw, is threaded into the next scan, `moreHistoryToScan`/`completedLibrary`, overlap tolerance, and resetting rather than mixing bounds when a run's resolved corpus mode differs from the stored frontier's). |
| `src/hooks/useGalleryImport.integration.test.tsx` | Client run and owner-only caption-settings wiring. |
| `src/components/gallery-import/gallery-import-entry.integration.test.tsx` | Trust explainer gating (only for a never-asked/askable permission; an already-established limited grant proceeds directly), the permission-outcome screens per status, moving on as soon as `onRunStarted` fires, the emptyLibrary/capped/lapsed outcomes, the fresh-start cellular offer, and a copy sweep for banned words. |
| `src/components/gallery-import/gallery-import-progress.integration.test.tsx` | The restyled device-bound screen with the wrongDevice action, expired/cancelled folded into the staged view, the partial-failure stage vs. the distinct errorFinal exception, lapsed/demoted distinguished from a generic failure (and never evaluated against a since-switched active family), offline, the nothing-stood-out/limitedNothing empty outcomes, the cellular-confirm sheet resuming in place without bouncing to entry, the stop-confirm sheet using the real cancel service instead of a native Alert, stale progress-response isolation after unmount, the real ready count in the title, and a copy sweep for banned words plus the old "checkpointed"/"does not promise" register. |
| `src/components/gallery-import/gallery-import-trust.test.tsx` | The explainer's three trust cards and two detail sheets, iOS/Android continue copy, and the three permission-outcome screens' distinct copy/actions with Close kept distinct from the labeled secondary action. |
| `src/components/gallery-import/gallery-import-empty.test.tsx` | The three empty-outcome screens' distinct copy and default kind-scoped testIDs. |
| `src/components/gallery-import/gallery-import-exception.test.tsx` | Every exception kind renders; a real ready-count/review-days-left note is used when supplied and never fabricated when absent; the inline notice component. |
| `src/components/gallery-import/gallery-import-review.integration.test.tsx` | Bounded, read-only review deck: set-aside/restore, deterministic queue advance, and outbox relaunch redirects. |
| `src/components/gallery-import/gallery-import-approval.integration.test.tsx` | The approve step as the memory composer: date-picker/tag-picker/voice reuse, restore-draft, per-tile and all-unavailable photo states, caption/date validation, approval deadlines, outbox relaunch/explicit retry, late-operation idempotency, ambiguous-begin stable-lease recovery, and the kept-confirmation's next/stop navigation. |
| `src/components/gallery-import/gallery-import-settings.integration.test.tsx` | Settings-tab row: human-readable selected-language caption, owner navigates to the caption settings route, viewer/non-owner-manager get the disabled row with no navigation. |
| `src/components/gallery-import/gallery-import-caption-settings.test.tsx` | Pushed caption settings screen: human-readable label, searchable curated locale picker, recents recording, curated-count line, instructions counter/example pills, owner-only autosave debounce/error/retry, non-owner lockout, and the keyboard/sheet-sizing regressions (`getGalleryCaptionLocalePickerKeyboardAvoidingBehavior`, `computeGalleryCaptionLocalePickerSheetMetrics`). |

### Database, Edge Function, and Worker tests

| File | Covers |
|---|---|
| `supabase/tests/gallery_import_foundation.sql` | RLS/privileges, exact-family role/capability checks, immutable manifests, transitions, finalization, receipts, and cleanup/digest fences. |
| `supabase/functions/_shared/gallery-import.test.ts` | JWT/input validation, presigned-key grammar, R2 HEAD verification, dispatch and approval orchestration. |
| `supabase/functions/workflow-gallery-import-bridge/index.test.ts` | HMAC timestamp/nonce bridge and private Worker operations. |
| `supabase/functions/cleanup-gallery-imports/index.test.ts` | Cron authentication, fenced transient-object cleanup, and nonce pruning. |
| `supabase/functions/send-gallery-import-digests/index.test.ts` | Cron authentication, SQL-owned quiet-window claims, privacy-filtered generic recipient selection, no-recipient completion, and retry behavior for pre-delivery lookup failures. |
| `cloudflare/memory-illustration-worker/test/gallery-preview-validation.test.ts` | Byte/type/dimension/hash validation. |
| `cloudflare/memory-illustration-worker/test/gallery-vision.test.ts` | Schema-constrained vision response, refusal/retry/ambiguous handling. |
| `cloudflare/memory-illustration-worker/test/gallery-workflow.integration.test.ts` | Attempt leases, idempotent publication, scrub and Workflow error behavior. |

The small `supabase/functions/<gallery-endpoint>/index.ts` files intentionally delegate to the shared handler; shared-handler coverage is the Deno contract coverage for all listed user endpoints. Cron-only cleanup and digest behavior has direct Deno coverage in the files listed above.

### E2E (Maestro)

| Flow | Scenario |
|---|---|
| `.maestro/flows/gallery-import/happy-skip-restore-approve.yaml` | Opt in, deterministic media-library fixture, skip/restore, edit, and approve. |
| `.maestro/flows/gallery-import/resume-after-relaunch.yaml` | Run checkpoint/resume after app relaunch. |

### Run this feature’s tests

```bash
npm test -- --runInBand --testPathPattern=gallery-import
npm run test:edge
npm run test:db
cd cloudflare/memory-illustration-worker && npm test -- gallery
maestro test .maestro/flows/gallery-import/
```

Run `npm run typecheck`, `npm run lint`, and the applicable real-device permission/release matrix before rollout. The repository has no gallery-specific test script, so paths above are deliberate commands, not implied npm scripts.

## Operational release gates

Implementation status does **not** mean deployment, native builds, privacy review, Apple/Google declarations, Google Play broad-photo-access approval, or store approval is complete. Before production, complete the Phase 0 device/quality/privacy benchmarks in [the plan](../plans/gallery-import.md#phase-0--mandatory-feasibility-policy-and-privacy-gates), deploy and verify the migration/functions/Worker/secrets/cron jobs in isolated staging, and execute the staged rollout/rollback checklist in [release readiness](../release-readiness.md). Android whole-library scanning remains blocked until Google Play approves the `READ_MEDIA_IMAGES` Photo and Video Permissions declaration for this real core flow.

## Changelog

| Date | Change |
|---|---|
| 2026-08-11 | Camera-captures-only corpus (product decision): Android now scopes both frontier phases to the exact-title `'Camera'` album (`MediaLibrary.Album.get`/`Query.album()`), falling back to full-library + date-plausibility when no album resolves; iOS is unchanged (no camera-source signal). The date-less-photo/WhatsApp fallback was considered and rejected — `isPlausibleCaptureTime` is untouched. `GalleryScanSnapshot.corpusMode` and the frontier's stored `corpusMode` guard against mixing coverage across a corpus-mode change (reset, not merge) if the album appears/disappears between runs. |
| 2026-08-11 | Captions now start with a capital letter (worker prompt change; needs a Worker redeploy). Raised `GALLERY_IMPORT_MAX_ENUMERATED_ASSETS` 2,000 → 4,000 per scan pass (unchanged `gallery-v1` algorithm/signatures) and added progressive deepening (`src/utils/gallery-import-frontier.ts`): a persistent per-user+family frontier lets successive runs walk backward through the whole library in bounded bites via a two-phase (catch-up + deepen) windowed scan, advancing only after a run's chunks are confirmed registered server-side. |
| 2026-08-10 | Fixed a critical device-tested bug where the progress screen never left "Writing the drafts" even after the server run reached `reviewing`: `deriveGalleryImportProgressOutcome` checked a stale, permanently-retained `live.stage === 'dispatching'` snapshot before ever consulting the polled server status, which always wins now once it has moved past `processing`. The ~8s poll also syncs the local checkpoint's own status field so the Timeline glyph/drawer and a later resume agree with what this screen showed. Also: deduped "Safe to close Momora. Your place is saved." between the heading and body, removed a stray "title and" (captions are the only field), reserved fixed-height title/body blocks so stage transitions no longer shift the layout, removed all "AI partner"/"AI service" mentions per product decision, and added an explicit safe-area bottom inset to the trust explainer's and entry screen's trailing footer caption (buttons already had enough height to clear a gesture-nav bar; the thin caption line beneath them did not). |
| 2026-08-10 | Entry/progress presentation rebuilt per the design authority: a trust explainer now gates the OS permission prompt, limited/denied/blocked are full outcome screens, the progress screen shows the eleven designed stages with real (never fixture) counts and a designed Stop-confirm sheet instead of a native Alert, the Wi-Fi→cellular choice resumes the runner in place via a new `allowCellular` flag instead of bouncing through the entry screen, three distinct empty outcomes and six distinct exception states replace one ambiguous "Your family access or import eligibility changed" message, and the user moves onto the progress screen as soon as a run exists instead of staying parked on the entry screen for the whole scan/prepare/upload pass. `removed` (full family-membership loss) is defined for design completeness but not reachable from the progress screen: a checkpoint only loads under the *active* family's storage key, so having one loaded already guarantees membership. |
| 2026-08-10 | Curation pipeline hardening: the vision prompt no longer presupposes a cluster is an event, adds explicit exclusion/variety/singleton rules and a "silence beats a bad card" instruction; the Workflow now gates published groups on a `DEFAULT_GALLERY_MIN_CONFIDENCE` (0.6) threshold with a `low_confidence` skip when every group is dropped, and dedupes exact-hash-duplicate assets within a cluster before the vision call; the on-device scanner drops iOS screenshot-subtype assets before clustering. |
| 2026-08-10 | Fixed digest-window reuse after a successful send so the next approval restores both quiet-period timestamps and can schedule a new 30-minute family digest. |
| 2026-08-10 | Guarded progress polling across unmounts so a late response cannot update a stale screen or overwrite a later terminal state. |
| 2026-08-10 | Forced native presigned PUTs onto Expo's foreground URLSession so iOS PhotoKit original URLs remain accessible to the uploader. |
| 2026-08-10 | Added content-free approval URL/PUT/receipt stage diagnostics and fail-closed handling for an unconfirmed upload receipt. |
| 2026-08-10 | Locked approval recovery now uses a measured, non-translated safe-area footer so its retry action retains a finite native accessibility frame. |
| 2026-08-10 | Approval now permits bounded PhotoKit retrieval of explicitly selected iCloud originals instead of applying discovery's local-only preflight. |
| 2026-08-10 | Approval now has bounded foreground original/upload/finalization steps, relaunch-safe outbox routing, explicit same-lease retry, and stable-lease recovery for an ambiguous timed-out begin transition. |
| 2026-08-10 | Server `reviewing` is now terminal for admission: resume performs one idempotent local checkpoint reconciliation and starts no further media or server mutation work. |
| 2026-08-10 | Added Expo's no-download iOS cloud-original preflight before URI resolution; cloud-only assets are omitted promptly without starting iCloud retrieval, while registered receipts remain retryable. |
| 2026-08-10 | Added a five-minute absolute native preparation budget per start/resume invocation; exhausted unregistered tails start no more native work, while registered assets remain retryable. |
| 2026-08-10 | Resume now prepares unregistered planned chunks before server admission, omitting unavailable assets and locally closing empty plans while retaining strict retries for already-admitted assets. |
| 2026-08-10 | Bounded native URI resolution and preview generation to 30 seconds per photo so iCloud/ProRAW assets cannot indefinitely strand a foreground run; attempt-scoped local filenames make late-output cleanup retry-safe. |
| 2026-08-10 | Completed runs now enter fenced expiry cleanup after the review TTL; transient previews are deleted while approved originals and receipt/memory records remain retained. |
| 2026-08-10 | Initial implementation documentation and rollout contract. |
