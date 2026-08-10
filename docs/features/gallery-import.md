# Feature: Gallery import

**Status:** `done` (implementation complete; production rollout is gated)
**Last updated:** 2026-08-10
**PRD reference:** [PRD §6.3a Gallery import](../PRD.md#63a-gallery-import--ai-staged-camera-roll-memories)
**Design authority:** [gallery-import design README](../design/gallery-import/README.md) and its pinned Claude handoff. The handoff controls composition, interaction hierarchy, motion, platform manners, accessibility, and state coverage. This document and [the implementation plan](../plans/gallery-import.md) control product/security/operations.

## Overview

An owner or manager can explicitly ask Momora to look through the photos currently permitted on the originating device, group them into events, and stage AI-curated memory suggestions. Momora never changes the camera roll. It uploads downscaled private previews before review so its vision provider can curate suggestions; only final approval uploads and retains full-resolution originals as ordinary private `media` memories. The feature is device-bound, resumable in the foreground, and opt-in behind client and server admission controls.

## User-facing behavior

- Entry points are visible to owners/managers after normal onboarding and paid-access checks. Viewers see an explanatory disabled Settings row; they cannot start, view, or act on a run.
- The consent screen says what is scanned, that small previews go to Momora and its AI partner, that originals are uploaded only after approval, and that nothing is changed in the camera roll. v1 suggests **photos only**—videos are not silently included.
- iOS/Android permission can be full, limited/selected, denied, or blocked. The permitted corpus is snapshotted before the run; choosing more photos applies only to a later run. No location permission is requested and no GPS, filename, raw OS asset ID, face/biometric signal, or identity inference is sent to the server.
- The foreground scanner pages lightweight metadata newest-first, groups dated photos with frozen `gallery-v1`, makes 512px JPEG previews, then uploads/dispatches them in bounded chunks. On iOS it uses Expo Media Library's no-download cloud check before URI resolution, so an iCloud-only original is omitted without initiating a download; Android/default assets are treated as local. It prefers Wi-Fi and offers an explicit cellular override. “Safe to close” means checkpointed resume, not that foreground scanning, local normalization, or original retrieval continues after process death.
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

The authoritative limit snapshot is copied onto each run. The default admission template is 20 chunks/run, 1,000 assets/run, 100 assets/chunk, 60 candidates/run, at most 3 provider attempts/cluster, 10 images/cluster, and 1,500,000 preview bytes/image. The foreground scanner additionally pages at 100, considers at most 2,000 newest assets, groups across a 3-hour gap, and locally caps clusters/assets at 60/10. These are implementation limits, not a claim that every device uploads or receives that many suggestions. Once the candidate cap is full, later valid model groups close as suppressed/no-candidate outcomes instead of failing their chunk or Workflow.

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

`GalleryImportWorkflow` in `cloudflare/memory-illustration-worker` validates private preview bytes/type/dimensions, processes at most ten images per cluster, and calls `gpt-4o-mini` with a schema-constrained multi-image request. One cluster may split into at most three groups and may never merge with another cluster. It stores only scalar Workflow-step outputs: previews, prompts, model responses, semantic descriptions, and captions do not enter Workflow history/logs. Definite retryable provider failures may use the bounded attempt cap; an ambiguous network/timeout/disconnect is quarantined and requires reconciliation/manual retry rather than an automatic possibly-billed replay.

## Client integration

| Layer | Files | Responsibility |
|---|---|---|
| Routes | `app/(app)/gallery-import/{index,progress,review,approve}.tsx` | Entry, progress/resume, deck, and approval screens. |
| Components | `src/components/gallery-import/gallery-import-flow.tsx`, `gallery-import-settings.tsx` | Consent/permission UX, review/composer actions, safe-area/keyboard behavior, owner settings. |
| Hook | `src/hooks/useGalleryImport.ts` | Feature-gated run/caption-settings query/mutations. |
| Services | `src/services/gallery-import.ts`, `gallery-import-runner.ts` | Edge contracts; foreground scan/preview/upload/dispatch and resume. |
| Utilities | `src/utils/gallery-import-{scanner,preview,original,checkpoint,e2e-adapter,flags}.ts` | Permission adapter, deterministic clustering, preview/original conversion, local retention, test adapter, opt-in flag. |

`EXPO_PUBLIC_GALLERY_IMPORT_ENABLED === 'true'` enables client entry points and new-run creation only. It intentionally does **not** revoke a capability-bound admitted run: its resume, dispatch, review, approval, cancellation, and completion calls remain usable after the flag is turned off until terminal state or expiry. The database singleton’s `enabled` field separately controls new server admission without stranding already admitted runs. `EXPO_PUBLIC_E2E_GALLERY_IMPORT_ADAPTER === 'true'` works only in `__DEV__` builds and provides deterministic fixtures; it must never be enabled in a production build.

## Extension guide

**Safe to extend**

- Add a locale through the shared caption-locale registry, preserving owner-only autosave and server BCP-47 validation.
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
| `src/constants/gallery-caption-locales.test.ts` | BCP-47 locale registry/search/normalization. |
| `src/utils/gallery-import-scanner.test.ts` | Permission states, iOS no-download cloud availability detection, deterministic signatures/clusters/caps and paginated scan behavior. |
| `src/utils/gallery-import-checkpoint.test.ts` | Scoped checkpoint, corruption/size handling, cleanup and resume state. |

### Integration tests

| File | Covers |
|---|---|
| `src/services/gallery-import.integration.test.ts` | Feature-gated Edge service request shapes and errors. |
| `src/services/gallery-import-runner.integration.test.ts` | Scan → manifest → preview upload → dispatch/resume sequencing, including terminal reviewing reconciliation, prepare-before-admission resume, unavailable/suppressed pruning, per-asset and five-minute invocation budgets, exhausted-tail suppression, registered retry semantics and late-artifact cleanup. |
| `src/hooks/useGalleryImport.integration.test.tsx` | Client run and owner-only caption-settings wiring. |
| `src/components/gallery-import/gallery-import-flow.integration.test.tsx` | Consent, permissions, device-bound states, bounded review deck, composer validation, safe areas, approval deadlines, outbox relaunch/explicit retry, late-operation idempotency, ambiguous-begin stable-lease recovery, and stale progress-response isolation after unmount. |
| `src/components/gallery-import/gallery-import-settings.integration.test.tsx` | Owner autosave and viewer restrictions. |

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
