# Plan: gallery import — AI-staged memories from the camera roll

> **Superseded as the current plan (2026-08-23).** The capped-run model this
> document describes (60 clusters/run, 2 runs in the first 30 days then
> 1/UTC-month, admission gates) was replaced by a continuous per-family
> library sweep. See [gallery-import-continuous.md](./gallery-import-continuous.md)
> for the current model, seam contracts, and deploy checklist. This document
> remains the historical record of the original architecture/security review
> and Phase 0 feasibility gates, which still apply before a production store
> rollout.

Repo: `/Users/eduardoyi/Coding/Momora2` (Expo SDK 56 + Supabase + Cloudflare
Workers/R2)

Status: **implemented behind client and server admission gates; production
rollout gates remain**. This revision incorporates the adversarial
architecture/security review from 2026-08-09 and the implementation completed
on 2026-08-10. Phase 0 remains mandatory before a production store rollout.

Design authority: [`docs/design/gallery-import/README.md`](../design/gallery-import/README.md)
and its pinned Claude handoff. The handoff controls visual composition,
interaction hierarchy, motion intent, platform manners, and state coverage;
this plan controls architecture, privacy, authorization, and operational
correctness. Approved clarifications in the design README resolve conflicts.

## Goal

Solve the blank-start problem. An eligible parent explicitly starts a camera
roll import. Momora enumerates the permitted photo library on-device, clusters
photos into candidate events, uploads small private previews, and uses a
server-side vision pass to select and caption suggested memories. The parent
reviews a resumable swipe deck and only an explicit final approval creates a
real media memory from the full-size originals.

Product framing: parents are *over-documented and under-storied*. This is
meaning-making over what already exists — "we picked the keepers for you" — not
photo management. Momora **selects, never deletes**; the camera roll is never
modified.

Privacy wording must be exact: before approval, Momora uploads transient,
downscaled previews to its private infrastructure and AI provider for curation.
Approval controls what is added to the family journal and which full-resolution
originals are retained. It does **not** mean that no bytes leave the device
before approval. Product copy, the privacy policy, and App Store/Play data-safety
disclosures must say this plainly.

## Adversarial review outcome

The direction survives, with these corrections promoted to requirements:

- Android whole-library scanning is not an ordinary permission task. Google
  Play restricts `READ_MEDIA_IMAGES` to approved broad-access/core-use cases.
  Ship iOS first unless the Play declaration is approved. A system picker is a
  separate, user-selected batch-import product, not an automatic-scan fallback.
- Preview upload needs a run-bound presigned-PUT authorization path. The current
  `upload-media`/`get-upload-url` key grammar rejects import keys, and the proxy
  buffers the complete body in an Edge Function. Never open a generic
  `{uid}/import/**` upload capability.
- Workflow idempotency can bound provider attempts but cannot recover an AI
  response lost after an ambiguous network outcome. An ambiguous paid call is
  quarantined for reconciliation/manual retry, not automatically replayed.
- Candidate transitions and final memory creation are server-owned and atomic.
  Direct client table updates and the current in-memory media queue are not safe
  enough for a multi-session approval flow.
- Raw OS asset identifiers stay out of Postgres, R2 keys, analytics, logs,
  prompts, and Workflow state. The server sees per-run opaque asset tokens; the
  device retains the token-to-library-ID map.
- Unapproved semantic descriptions are not telemetry. Do not persist an
  `internal_description`, a raw model response, or prompt text. Private job
  input is scrubbed at terminal/expiry states.
- Expiry, cancellation, account/family deletion, membership/role changes,
  entitlement changes, local-file cleanup, and orphaned uploads are core paths.

## Decisions already made

| Decision | Resolution |
|---|---|
| Face recognition / biometrics | **No**, on-device or cloud. |
| Age-based identity inference | **No.** The model never guesses who is pictured. |
| GPS / location | **Not in v1.** Do not request `ACCESS_MEDIA_LOCATION`, upload coordinates, reverse-geocode, or persist GPS. |
| Cluster transforms | Vision may split one cluster into at most 3 groups; it may not merge clusters in v1. Uncertain means keep one group or stage nothing. |
| Quality/dedup | Server-side against transient previews, subject to the Phase 0 implementation spike. No new client pixel-analysis dependency. |
| Durable compute | A third Cloudflare Workflow in `cloudflare/memory-illustration-worker`, following `docs/durable-ai-generation-workflows.md`. |
| Resume | Checkpointed across app sessions; no OS background-processing promise. |
| Memory type | Approved imports are `memory_type='media'`; they never generate illustrations. |
| Skip semantics | Left swipe means recoverable **skip**, never delete/discard. |
| Import role | Family owners/managers only; client hides entry points and every server mutation rechecks the role in the exact family. |
| Caption settings | Family owners only set language/style instructions. Language uses a searchable comprehensive BCP 47/CLDR locale list with regional variants. |
| Family notifications | Batch imported-memory approvals into one digest after **30 minutes with no new approvals**; each new approval restarts the quiet-period timer. |
| Device portability | Candidates are device-bound because originals remain in that device library. Other devices cannot approve them. |
| Cost target | At most **$1 per completed initial import at the chosen default cap**, proven with measured benchmark usage before rollout. |
| Android rollout | **Both iOS and Android are required.** Pursue Play broad-photo-access approval for Android whole-library scanning; Android release is gated on that approval. |
| Initial multi-device allowance | Two family-wide runs during the first 30 days, at most one active run at a time; measured normal monthly admission applies afterward. |
| Review editing boundary | The deck is read-only and asks only Keep/Set aside. Editing caption, date, photos, and tags happens only in the composer. |
| Candidate text model | One caption/content field; no separate user-facing or persisted title. Operational labels derive a bounded excerpt. |
| Permission corpus | Photo access is snapshotted before run creation. Later grants apply to a later run. |
| Import provenance | Persist `gallery_import` creation provenance on the committed memory; never display it. |
| Import corpus scope | **Camera captures only** (2026-08-11 user decision): "We only care about what pictures people take with the phone. We don't care about WhatsApp, iMessage, downloads, etc." Supersedes any earlier pre-filter wording that treated non-camera saves as in scope. Android scopes both scan phases to the device's exact-title `'Camera'` album, falling back to full-library + date-plausibility scanning when no such album resolves. iOS has no camera-source signal and is unchanged (full library; a saved WhatsApp photo only enters the iOS library via an explicit user save). |
| Date-less-photo fallback | **Rejected** (2026-08-11, same decision as above). No date-inference fallback for photos without a plausible capture date (e.g. some WhatsApp/forwarded images); `isPlausibleCaptureTime`'s existing date-plausibility filter is unchanged. |
| Enumeration ceiling / progressive deepening | **2026-08-11.** Raised `GALLERY_IMPORT_MAX_ENUMERATED_ASSETS` 2,000 → 4,000 per scan pass; unchanged `gallery-v1` clustering algorithm and signature hash (the ceiling bounds how much of the corpus one pass reaches, not how a given cluster is formed or hashed). Added a persistent per-user+family progressive-deepening frontier so successive runs walk backward through the whole corpus in bounded bites instead of always re-covering the same newest window; it advances only after a run's chunks are confirmed registered server-side, and resets (never mixes) if the resolved corpus mode changes between runs. |

## Non-goals (v1)

- Face detection/recognition, identity inference, GPS, place names, trip
  synthesis, cluster merging, video candidates, or auto-approval.
- Cross-user event dedup. Two parents can import similar events.
- Cross-device approval or storage of raw library identifiers on the server.
- Android/iOS OS-scheduled background processing.
- Changing or deleting anything in the camera roll.
- Presenting a user-selected Android picker as though it scanned the library.
- Attaching a persistent "voice note" during approval. Existing voice-to-text
  may edit a caption later; no new audio attachment model is part of this plan.

## Phase 0 — mandatory production feasibility, policy, and privacy gates

Complete these before production cohort or store rollout. The implementation
and internal-device builds provide the real reviewable slice needed for the
device spike and Google Play declaration; they are not evidence that the gates
have passed.

1. **Android permission approval.** Build and submit the Google Play broad photo
   access declaration. Automatic enumeration needs broad access; selected-photo
   access cannot enumerate the rest of the library. Request photos only
   (`READ_MEDIA_IMAGES`, not video), ensure the feature is complete and prominent
   in the Play listing, explain why the system Photo Picker cannot perform an
   automatic library-wide cluster/curation pass, supply reviewer credentials
   and exact navigation steps, and provide an Android video showing disclosure,
   grant/deny behavior, scanning, review, and approval. Complete the Data safety
   form and privacy policy consistently. Deactivate/remove obsolete test-track
   bundles that declare a noncompliant permission. Allow several weeks for the
   extended review and plan time for rejection/appeal; approval is not guaranteed.
   Android production rollout remains blocked until approval. References:
   [Google Play policy](https://support.google.com/googleplay/android-developer/answer/14115180)
   and [permission declaration process](https://support.google.com/googleplay/android-developer/answer/9214102).
   Do **not** submit a placeholder binary that declares broad access before the
   review team can exercise the real core flow: the declaration requires review
   instructions and a video demonstrating why the permission is necessary, and
   active internal/closed-track bundles are included in compliance checks. Build
   a thin but genuine end-to-end reviewable slice first, then submit that binary.
2. **Expo SDK 56 device spike.** Install with `npx expo install` in a branch and
   test the SDK-56-compatible `expo-media-library` on supported real devices:
   pagination, access privilege changes, limited libraries, favorites/source
   signals, iCloud/Google Photos placeholders, HEIC/ProRAW, cancellation,
   memory pressure, and force-quit resume. A new native build and permission
   copy/review are required; this cannot ship as an OTA-only feature. Momora's
   EAS `runtimeVersion` uses the `appVersion` policy, so the native build that
   first includes `expo-media-library` must bump `expo.version` (not only Android
   `versionCode`) and publish later gallery OTAs only to that new runtime/channel.
   Otherwise an older binary without the module could accept incompatible JS.
3. **Curation benchmark.** Use consented synthetic/stock family-like fixtures,
   never organic child photos, to freeze clustering algorithm v1, limits,
   perceptual-dedup implementation, model/detail choice, refusal behavior,
   quality rubric, and measured p50/p95 latency/cost. "Adaptive gap" and a
   dated price estimate are not implementation contracts.
4. **Privacy/legal release review.** Approve just-in-time consent, retention
   copy, AI subprocessor/data-retention posture, privacy/store disclosures,
   deletion behavior, and custom caption instructions. Gallery scanning exposes
   much more sensitive family data than one user-picked attachment.
5. **Worker quality-pass spike.** Name and benchmark the Worker-compatible
   decoder/hash implementation. If pHash is not reliable and cheap, use only
   byte hash/basic dimension validation outside the single vision call.

Gate output: a short checked-in decision record with supported platforms,
permission declarations, fixed limits, benchmark method/results, model request
contract, and p50/p95 cost/latency. The corpus itself must be licensed for the
repository or kept in approved private test storage.

## Architecture

```text
ON DEVICE (foreground, resumable)              SERVER (survives app close)
─────────────────────────────────              ───────────────────────────
1. explicit consent + photo permission
2. create import run ────────────────────────▶ authorize family/role/entitlement
3. page lightweight photo metadata
4. deterministic v1 clustering/capping
5. create opaque asset tokens; checkpoint map
6. make 512px previews serially; omit unavailable/corrupt assets
7. register remaining manifest ──────────────▶ validate limits; record assets
8. accepted-only run-bound presigned PUTs to private R2
9. dispatch HEAD-verified chunk ─ HMAC ──────▶ Cloudflare Workflow
                                                fetch private job input/R2 previews
                                                validate + dedup + one vision call
                                                publish complete staged candidates
                                                scrub private input
10. realtime + reconcile ◀──────────────────── staged rows
11. review/edit/skip locally
12. begin approval ──────────────────────────▶ lease stable memory/asset IDs
13. resolve + normalize originals; PUT to R2
14. finalize approval RPC ───────────────────▶ atomic memory/assets/tags/candidate
15. scheduled cleanup/digest                  delete transient/orphaned objects
```

Use separate identities:

- **Run**: one user/device/family import session.
- **Chunk**: one Workflow instance containing a bounded set of clusters.
- **Cluster signature**: best-effort same-device/reinstall dedup, versioned by
  the clustering algorithm.
- **Candidate**: one staged memory group produced from a cluster.
- **Approval lease**: one idempotent finalization attempt with a stable memory
  ID and exact expected R2 keys.

Do not overload one `job_id` to mean all five.

Run creation also returns a high-entropy **run capability** stored only in the
origin device's user-scoped checkpoint; Postgres stores its hash. Candidate
mutations, preview URL signing, dispatch, and approval require both the actor's
JWT and this capability. It is not a substitute for family/role checks—it is the
device-binding proof that prevents another signed-in device from operating a
run whose original-photo mapping it does not possess. Never log or sync it.

## On-device scan and checkpoint

- Add `expo-media-library` as the only expected native dependency, subject to
  the spike. Request photos only, never videos/audio/location.
- Support `all`, `limited`, denied, and non-repromptable permission states.
  Limited access is a valid reduced corpus. Offer the OS permission-management
  surface without nagging or implying that full access is required.
- Snapshot the permitted asset corpus before creating the run. Offering the OS
  "choose more photos" surface is a pre-run action; assets granted after the
  run starts are not silently added to its signatures or manifests.
- Page lightweight metadata newest-first. Do not resolve full local URIs or
  decode images during enumeration. Platform availability of screenshot,
  favorite, edit, source, burst, and album signals must come from the spike;
  missing signals degrade conservatively rather than guessing from filenames.
- Reject missing/implausible capture dates. Sort deterministically. Freeze the
  evaluated time-gap algorithm and its version in code; changing it requires a
  new signature version and benchmark.
- Cap candidates per cluster and clusters per run using Phase 0 values. Spread
  candidates over the event range and include favorites when supported. Each
  staged group must ultimately select 1–10 assets, matching media-memory limits.
- Generate 512px-long-edge JPEG previews at the benchmarked quality in small,
  serial batches with explicit yields and per-image failure isolation. Never
  hold multiple full-resolution decodes in JS memory.
- Process newest chunks first so review can start early. Show actual counts and
  measured progress; do not promise "within one minute" until device data proves
  it.
- Wi-Fi is the default for bulk upload, not a dead end. Show an explicit
  "Use cellular" override and respect offline/expensive-network changes.
- Background native transfers may finish while the app is suspended, but their
  JS task/progress state is not restored after process death. Correctness comes
  from server HEAD/status reconciliation plus the checkpoint, not from an
  in-flight Promise.
- Store a compact, authenticated-user-scoped AsyncStorage checkpoint: run/chunk
  IDs, algorithm version, opaque asset token → OS asset ID mapping, signatures,
  upload flags, approval leases, and deck cursor. Never store image bytes.
  Version the format; serialize mutations with per-key locks; enforce a size
  ceiling and corruption recovery. Purge it on sign-out, account deletion,
  family access loss, run cancellation/expiry, and successful completion.
- Put generated local previews in the cache directory under a run-specific
  folder. Delete each after confirmed PUT and remove abandoned folders on cold
  start. Never rely on a transient `ph://`/`content://` URI surviving; re-resolve
  from the OS asset ID.
- Asset tokens are random per-run UUIDs. A signature is SHA-256 over a canonical
  versioned representation of local asset IDs and capture times; only the digest
  leaves the device. OS ID churn can defeat this best-effort backstop, so the
  plan no longer claims zero duplicate vision calls after reinstall.

## Preview registration and upload authorization

The current upload functions only allow portrait/memory key patterns. Add an
import-specific path; do not broaden `isAllowedUploadKey` globally.

1. `create-gallery-import-run` verifies a non-anonymous JWT, active paid access,
   owner/manager role for the exact non-deleted family, monthly/run admission,
   platform/feature flag, and consent version. It returns the run ID and hard
   limits.
2. `register-gallery-import-chunk` validates a bounded manifest of cluster
   signatures, each token's cluster membership, opaque asset tokens, capture
   timestamps, dimensions/favorite booleans, and expected byte/content-type
   limits. It stores no OS IDs. Existing receipts suppress already-processed
   signatures before any upload or provider admission.
3. `get-gallery-import-upload-url` accepts `{ runId, assetToken, contentType,
   byteLength, sha256 }`, joins the token to the caller-owned active run, checks
   the exact family role/entitlement and not-yet-uploaded key, then signs exactly
   `{uid}/imports/{runId}/{assetToken}.jpg`. The caller cannot choose a key.
   Sign the declared byte hash into immutable object metadata so dispatch can
   verify it by HEAD instead of trusting a client field disconnected from R2.
4. Client PUTs directly to R2. `dispatch-gallery-import-chunk` HEAD-checks every
   declared object (size/type where available), marks the manifest immutable,
   then dispatches. A missing object returns a retryable validation response.

Every endpoint has per-user/family/IP rate limits as appropriate, closed error
codes, and Deno tests. Preview upload admission is separate from ordinary memory
upload billing; never pass a dummy memory UUID through `checkBillingMediaUpload`.

## Durable Workflow and bridge

Add `GalleryImportWorkflow` and a distinct binding/secret. The event contains
only `chunkId`. The Worker obtains private input through a narrow timestamped
HMAC bridge with nonce replay protection; it never holds the Supabase service
role key.

Per cluster:

1. Fetch its bounded preview objects from the existing private R2 binding.
2. Validate real bytes/type/dimensions and apply the benchmarked deterministic
   dedup/quality pass. Keep image bytes inside one Workflow step and return only
   scalar metadata/candidate IDs across step boundaries.
3. Atomically reserve one provider attempt before the call. Use a deterministic
   attempt ID and a private attempt row with `reserved|inflight|completed|
   ambiguous|failed` status, usage, and closed error code.
4. Make one schema-constrained multi-image vision request with an abort signal
   and bounded timeout. Extend `_shared/openai.ts` only after tests prove it
   forwards `options.signal` and validates multiple-image limits.
5. Validate the response completely, then publish candidates via an idempotent
   bridge RPC/upsert keyed by `(chunk_id, cluster_signature,
   split_group_index)`. Publish each candidate as one complete row.
6. Scrub private manifest/prompt material after terminal publication. Retain
   only the minimum usage/status audit fields.

Important retry rule: a definite provider response classified as retryable
(for example a documented 429/5xx) may use a separately reserved retry only
within the run's cap. A network error, timeout, or disconnect without a definite
provider response is ambiguous: mark it `ambiguous`, do not automatically
re-bill, and expose an operator/reconciliation path. Attempt reservation
prevents unbounded retries; it does not prove the provider did no work. If the
selected API later provides documented idempotency/retrieval semantics, adopt
them only with an integration test.

Provider safety/refusal for ordinary child/family imagery is a quiet cluster
skip with a closed reason code. Never echo provider moderation language to the
parent or retry a deterministic refusal.

## Data model and RLS

Create one migration, regenerate `src/types/database.ts`, and update
`docs/TECH_SPEC.md` plus a new `docs/features/gallery-import.md`.

- `gallery_import_runs`: actor, family, run-capability hash, consent/algorithm
  version, status (`scanning|processing|reviewing|completed|cancelled|expired|
  failed`), counters/limits, clocks, expiry. FK family/user with deliberate
  delete behavior.
- `gallery_import_chunks`: run, ordinal, status, deterministic Workflow ID,
  counts, closed error code, clocks. Unique `(run_id, ordinal)`.
- `gallery_import_assets`: run/chunk/cluster signature, opaque token, private
  preview key, capture timestamp, dimensions, favorite flag, byte/hash
  verification, expiry. No OS ID and no public URL.
- `gallery_import_candidates`: run/chunk/family/actor, cluster signature/version,
  split index, status (`staged|posting|approved|skipped|unavailable|expired`),
  caption, memory date, optional closed emotion, confidence, selected
  opaque tokens (1–10, unique, same cluster), `memory_id`, expiry, clocks.
- `gallery_import_cluster_receipts`: actor/family/signature/version and closed
  outcome for best-effort re-run suppression after candidate content is purged.
  No caption, preview key, or description. **Skipped receipts do not expire and
  have no "reconsider" reset**; they survive candidate/preview expiry and are
  deleted only with the owning family/account. Use an algorithm-independent
  candidate fingerprint derived on-device from stable, pseudonymous per-asset
  fingerprints so an algorithm-version change does not intentionally resurface
  the same skipped selection. OS identifier churn can still prevent a perfect
  match after reinstall; document that platform limitation rather than storing
  raw identifiers.
- `gallery_import_provider_attempts`: service-only attempt lease/status/usage;
  no raw prompt/response.
- `gallery_import_approval_leases`: exact candidate, stable memory ID, exact
  expected full-size object keys, state/clocks for idempotent finalize/orphan
  cleanup.
- `gallery_import_digest_windows`: family/actor approval count, first/last
  approval clocks, send/claim state.
- Family settings: `gallery_caption_language` and capped
  `gallery_caption_instructions`, unless Phase 0 selects a dedicated settings
  table.
- `memories.creation_source`: a closed provenance value that includes
  `gallery_import`; it is operational metadata and is never rendered as a
  badge, label, or filter.

RLS/privileges:

- The importer may select their own rows only while still an active member of
  that exact family. Other household members, including the family owner, do
  not see another adult's unapproved previews/captions.
- Tables are not directly insertable/updatable/deletable by clients. Expose
  narrow SECURITY DEFINER RPCs for draft edit, skip, restore, begin approval,
  finalize, cancel, and reset. Each function rejects anonymous sessions,
  resolves family ownership internally, binds every role check to one
  `family_id`, validates allowed columns/transitions, and has restricted grants.
- Service-only attempt/private-input tables have RLS enabled and zero client
  policies. Do not describe this as "owner-select"; owner role and row actor are
  different concepts.
- Add candidates (not private job/attempt tables) to Realtime. Subscribe with
  run/actor filters, reconcile on `SUBSCRIBED`, and refetch on foreground because
  Realtime has no event replay. Complete-row inserts avoid enrichment races.
- Extend private-key read authorization so only the candidate actor can obtain
  signed preview URLs, and require the run capability so another device on the
  same account cannot load them accidentally. Never make import previews
  readable through ordinary family-wide media authorization.
- DB constraints/triggers enforce status transitions, title/caption lengths,
  valid dates, confidence range, unique split groups, token membership, and
  max-three groups/max-ten selected assets. Do not trust JSON schema alone.

## Review and approval state machine

Right swipe means **accept for review**, not "memory already saved". Present
caption/date and optional family-member tags before the final commit. Tags are
unlimited because the result is a media memory. Adding a family member reuses
the existing flow but does not block saving.

Final approval:

1. `begin_gallery_import_approval(candidate_id, run_capability)` rechecks the
   capability, actor, exact-family manager role, active paid entitlement, and
   candidate state/expiry, then returns an idempotent lease with stable
   memory/media IDs and exact allowed keys.
2. Resolve originals by the checkpoint's local OS IDs. An iCloud/cloud-backed
   download gets visible progress and cancellation. If one selected original is
   unavailable, let the user remove/replace it from locally known cluster assets
   or mark the card `unavailable`; do not silently convert an accepted card to a
   normal skip.
3. Normalize originals through the existing EXIF-stripping/preview generation
   path, preserving the ordinary 20 MB/type rules. Upload with bounded
   concurrency against approval-lease-bound presigned URLs. A force-quit leaves
   the server lease and local checkpoint resumable.
4. `finalize_gallery_import_candidate(...)` runs one DB transaction: verify the
   exact lease/objects and current authorization, create the media memory,
   replace ordered assets, apply same-family tags, mark the candidate approved
   with `memory_id`, write the receipt, and extend the digest window. Repeated
   calls return the same memory. Share validation logic with normal creation or
   prove parity with contract tests; do not fork weaker media constraints.
5. Delete transient previews only after committed finalization. The scheduled
   orphan cleaner deletes full-size lease objects that never finalize.

The existing `use-pending-memory-uploads` queue cannot own this path because it
is in-memory and always fires per-memory post-success side effects. Build a
small import approval outbox backed by the same checkpoint instead.

Family and entitlement changes are fail-closed:

- Switching the app's active family never changes the run's pinned `family_id`.
- Demotion/removal or family soft-delete stops dispatch/final approval. Access
  is revoked immediately; service cleanup expires the run.
- A lapsed entitlement may view already-staged cards, consistent with archive
  access, but final approval is a new paid mutation and routes to resubscribe.
  In-flight Workflow calls already admitted may finish staging.

Imported photo memories should not trigger one new emotion-analysis call each.
The curation response may provide a validated closed emotion value, which is
hidden throughout review and copied only when finalization creates the memory;
otherwise leave emotion null. Do not
eagerly warm dozens of share cards—store-through composition remains available
on first share. User-edited captions containing URLs use the normal link-preview
fetch after finalization.

## Expiry, deletion, and storage cleanup

- Default preview/candidate review TTL is 30 days, finalized in Phase 0 and
  shown in UI. Skipped cards remain recoverable only until expiry.
- A scheduled `cleanup-gallery-imports` Edge Function protected by
  `CRON_SECRET` claims bounded cleanup batches through fenced DB RPCs, deletes
  exact R2 keys, acknowledges each deletion, scrubs candidate/private input,
  and leaves compact receipts. A Postgres cron may enqueue/claim work; it cannot
  itself delete R2.
- Cleanup is retryable and partial-failure safe. Expiring a DB row before R2
  acknowledgement must not make its key undiscoverable.
- Run cancellation stops undispatched work, marks active work terminal when
  safe, deletes local cache/checkpoint state, and schedules exact preview/orphan
  deletion. It never touches the camera roll or approved memories.
- Extend family hard-delete preflight/fencing and account deletion to include
  active import Workflows, tables, previews, approval leases, and objects under
  manager-owned prefixes. A family purge cannot assume all family objects use
  the family owner's UID prefix.
- Extend offline/access-revocation cache purges. Signed preview URLs and local
  thumbnails must not remain accessible after family membership is lost.

## Vision contract

Input per cluster after deterministic validation/dedup:

- At most the benchmarked image count/detail, each identified only by opaque
  token.
- Per-image local capture timestamp, cluster range/count, caption locale, and
  owner-authored style instructions delimited as untrusted data.
- No names, family roster, OS IDs, GPS, filenames, device metadata, memory text,
  secrets, or unrelated family data.

Schema-constrained output:

```json
{
  "groups": [{
    "caption": "1–2 sentence draft",
    "selected_asset_tokens": ["opaque-token"],
    "memory_date": "YYYY-MM-DD",
    "emotion": "optional closed Momora emotion or null",
    "confidence": 0.0
  }],
  "skip_reason": "optional closed enum"
}
```

Validate that there are 0–3 groups; tokens are unique, disjoint across groups,
from the supplied cluster, and 1–10 per group; dates are plausible and within
the cluster's local calendar range; strings meet hard caps and contain no
control characters; emotion/skip reason are closed enums; confidence is finite.
Invalid output gets no repair prompt in v1 unless the benchmark explicitly
budgets one.

Prompt rules:

- Prefer meaningful photos with people, variety, and an event arc. Exclude
  documents/screens/receipts and near-duplicates.
- Never invent names, relationships, places, ages, milestones, or occasions.
  Do not guess identity.
- Captions are warm, specific, short, understated drafts—not marketing copy.
- Split only on clear scene/time evidence; uncertainty means one group or none.
- Low confidence and safety/provider refusals stage nothing and record only a
  closed operational reason. Never surface judgmental safety wording.

## Caption settings and prompt-injection boundary

Caption language uses a comprehensive, searchable locale registry based on
standard BCP 47 tags and CLDR display names, including regional variants such as
`en-US`, `en-GB`, `pt-BR`, and `pt-PT`. The owner-facing control is a combobox
pattern: searchable modal/list on mobile, localized language/region labels,
recent/current selection at the top, and full keyboard/screen-reader support.
Store only the canonical BCP 47 tag. Generate the client and server allowlists
from one versioned registry so the UI cannot save a locale the dispatch function
rejects; do not hand-maintain two lists. Search matches localized display name,
English display name, native language name where available, region, and tag.
Language-only choices may coexist with regional choices when CLDR defines both;
the exact tag is passed to the model.

**2026-08-10 amendment (see docs/design/gallery-import/README.md):** the full
241-entry registry above is still what's *accepted* (client `normalizeGalleryCaptionLocale`
and the Edge Function's BCP-47 shape check both key off it, unchanged), but
device testing showed showing all 241 in the picker was overwhelming to scroll.
The picker itself now browses/searches a curated ~48-entry presentation subset
(`curatedGalleryCaptionLocaleTags` in `src/constants/gallery-caption-locales.ts`)
of major world languages plus meaningful regional variants; "do not hand-maintain
two lists" above refers to the accept/validate list, not this presentation
trim. A saved language outside the curated subset still resolves to its real
name (never a bare tag) wherever it's shown, via the full registry, not the
curated one. Display names themselves are also a static hand-authored table,
not CLDR at runtime: Hermes on-device silently echoes the input tag back
instead of throwing when it lacks ICU locale data, so `Intl.DisplayNames` is
an enhancement layered over the static table, never its source of truth.

Custom instructions are owner-only, hard-capped (target 500 characters), and
may shape only language/tone/vocabulary. The server rejects control characters
and validates length. It does not use a brittle keyword blocklist.

Pass instructions in a delimited untrusted block in the user message. System
rules state that they cannot alter selection, safety, facts, schema, confidence,
or tool behavior. Schema enforcement remains mandatory. Do not include secrets
in the prompt. Instructions may themselves contain family PII (for example a
nickname), so never log them and include them in the privacy disclosure. Scrub
the per-chunk copy after terminal processing.

Default the initial family setting to the owner's best matching supported locale
and materialize that canonical tag. Fall back to `en-US` only when there is no
registry match. Do not silently let importing managers' device locales change
the family language.

## UX

- Entry points appear only after child-first onboarding requirements and paid
  entitlement are satisfied: an optional post-onboarding offer plus a persistent
  owner/manager action in Settings/composer.
- Before the OS prompt, explain: what is scanned, that small previews are
  privately uploaded to Momora/its AI provider, the review TTL, that originals
  are retained only on approval, and that the camera roll is never changed.
- Progress states: scanning, preparing previews, waiting for Wi-Fi (with cellular
  override), uploading, processing (safe to close), ready to review, paused,
  expired/cancelled, and needs attention. Show processed/ready counts without
  pretending the final total is known too early.
- Deck cards are read-only and ask only Keep or Set aside. A read-only photo
  preview may show the selected set. Keep opens the composer, where caption,
  date, tags, and the selected photos (limited to assets in that cluster) are
  editable. Any unuploaded alternate preview is generated locally on demand;
  server preview retention does not expand silently.
- Swipe right opens the final review/tag step; swipe left skips. Destructive
  gestures require accessible button equivalents and screen-reader actions.
  Respect reduced-motion settings; no gesture-only functionality.
- Keyboard avoidance and live bottom safe-area insets are mandatory for caption
  editing, tag search, sheets, and pinned actions on iOS/Android.
- Review is resumable and never a forced march. A different device shows
  "Continue on the device that scanned these photos" without exposing previews,
  the originating device name, or exact candidate counts.
- Copy says that v1 suggests photos only, so videos from the same day do not
  appear silently omitted.
- Caption locale and instruction changes autosave with visible pending, saved,
  and error feedback; failed writes remain editable and retryable.

## Notifications, analytics, and downstream effects

Import finalization must not call `notifyFamilyActivityFireAndForget` per memory.
The current notification path is client-triggered, not a DB fan-out, so use an
import-specific server digest:

- Atomic finalization extends one `(family_id, actor_id)` inactivity window.
- A scheduled sender claims windows inactive for the chosen duration and sends
  at most one privacy-filtered digest using existing block/preferences logic,
  e.g. "Eduardo added 58 memories from the camera roll."
- Digest deep-links to the family timeline, not an arbitrary memory, and never
  exposes recipient/delivery counts to the actor.
- Claim/send is idempotent and partial-failure safe. The inactivity duration is
  a product decision below.

Plain-language behavior: the digest is a notification batching timer. If a
parent approves 20 imported memories, the family must not receive 20 alerts.
After each approval Momora waits for a quiet period; another approval restarts
the timer. When the parent has stopped approving for that long, Momora sends one
summary notification for the whole batch. The proposed quiet period is 30
minutes, so a break shorter than 30 minutes remains one notification session.

Update `docs/features/analytics.md` and the typed event catalog. Use closed,
content-free properties only: platform, permission mode, counts, duration
buckets, stage/outcome enums, approval/edit rates, and measured usage/cost.
Never send captions, instructions, filenames, dates precise enough to reveal an
event, preview hashes, raw error messages, or provider safety text. Avoid
emitting the ordinary `memory_saved` event dozens of times unless dashboards
explicitly require it; add aggregate import events with documented semantics.

Verify timeline/calendar pagination after large historical backfills and
Looking-Back package selection/regeneration. Imports sort by `memory_date`, not
approval date. Ensure realtime/cache insertion never pins 60 new rows above the
feed and never mixes active families.

## Cost, admission, and rollout

Do not keep the original `$0.25–0.40` estimate: image tokenization, model price,
cluster count, refusal/repair rate, and detail choice are all unstable. Phase 0
records a versioned cost formula using actual usage fields and a representative
cluster distribution.

Server admission enforces:

- max photos enumerated/candidates/clusters/previews/bytes per run;
- max provider attempts and absolute estimated/actual cost per run;
- max active runs and monthly runs/cost per family;
- two initial family-wide runs during the first 30 days, never concurrently,
  before ordinary monthly admission applies;
- one immutable limit snapshot on each run so deploys do not change it midway;
- no dispatch once the budget is exhausted (already-staged cards remain).

Add a dedicated AI-usage operation and DB constraint migration. Do not force
chat-vision through image-generation request tables unless their semantics and
RPCs are deliberately generalized. Record usage even on refused/ambiguous calls
when the provider reports it.

Roll out behind independent server admission and client entry-point flags:
iOS/Android internal fixture builds → consented beta cohorts → measured go/no-go
→ store rollout. Android production stays gated on Play's broad-photo permission
approval even if its technical beta is ready. Kill switch blocks new runs and
dispatches. In-flight admitted Workflows may finish; users retain review access
until expiry.

## Implementation workstreams

1. Phase 0 spikes/decision record and privacy/store review.
2. Migration: settings, runs/chunks/assets/candidates/receipts/attempts/leases/
   digest windows, constraints/RLS/RPCs/Realtime/schedules; regenerate types.
3. Edge authorization: create/register/upload-url/dispatch/candidate/finalize/
   cleanup/digest endpoints and shared billing/family checks.
4. Cloudflare Workflow, HMAC bridge operations, provider wrapper, usage and
   refusal/ambiguity handling.
5. Client scanner, versioned checkpoint/outbox, local cache cleanup, network and
   permission handling.
6. Review deck, accessible controls, editing/tagging, original recovery,
   approval progress/resume, and role/entitlement states.
7. Notification/analytics/downstream pagination and Looking-Back integration.
8. Tests, `docs/features/gallery-import.md`, feature index, TECH_SPEC contracts,
   privacy/store documentation, rollout runbook.

## Testing

- Unit/Jest: fixed clustering fixtures, signature versioning, prefilter/caps,
  chunking, schema validation, checkpoint migration/corruption/size ceiling,
  permission state machine, network policy, outbox resume, unavailable assets.
- Client integration: scanner → registered/uploaded chunks, realtime reconcile,
  device/family filtering, edit/skip/restore, approval force-quit recovery,
  lapsed/demoted/removed states, no per-memory notification/analysis/share-card
  side effects, cache purge on access loss.
- pgTAP: table privileges/RLS for actor/other member/cross-family/anonymous,
  column immutability, transition RPCs, token/group limits, idempotent run/chunk/
  candidate/finalize, exact-family role checks, entitlement, cleanup fencing,
  receipts reset, digest claim, Realtime publication, family/account cascade.
- Deno: auth/rate/admission for every endpoint, server-chosen key grammar,
  manifest/object verification, forbidden cross-run token/key reuse, billing
  separation, closed errors, cleanup partial failures, notification blocks.
- Worker Vitest: HMAC/nonce, byte validation, dedup implementation, multi-image
  request + abort, schema adversarial outputs, no token/date escape, refusal,
  deterministic retry vs ambiguous quarantine, idempotent upsert, private-input
  scrubbing, usage recording.
- Maestro in a dedicated E2E build with a deterministic media-library adapter:
  happy path, skip/restore/edit/approve, resume after process kill, Wi-Fi/cellular
  choice, and accessibility controls. The adapter must be compile-time E2E-only
  and impossible to enable in production.
- Real-device release checks: iOS full/limited permission changes, iCloud-only
  asset, huge HEIC/ProRAW, low-memory device, interruption, denied/settings
  recovery; Android equivalents only if broad access is approved. Some system
  limited-library flows are manual release checks rather than reliable Maestro
  automation.
- Deletion test: cancel/expire/account delete/family delete during every run and
  approval state, proving DB and exact R2 cleanup without touching approved
  memories or camera-roll assets.

Run `npm test`, `npm run test:edge`, typecheck, lint, Worker tests, pgTAP, and
the applicable Maestro/release matrix before rollout. Update the feature doc's
Testing section with every test file.

## Design exploration still required

Deck composition, transitions, and the broader visual treatment intentionally
remain open for product/design exploration. Behavior, privacy, accessibility,
and state requirements are fixed; the plan does not prescribe a layout.

Model string/detail, algorithm thresholds, limits, and exact price are Phase 0
benchmark outputs, not subjective decisions to make in advance.

## Backlog

- GPS-assisted clustering/place names only after deliberately revising the
  no-location posture and permissions/privacy review. Never persist raw GPS.
- Cluster merging/trip synthesis.
- Video candidates.
- Cross-user similar-event detection.
- Recurring opt-in auto-scan after one-time import proves value and platform
  permission/policy remain acceptable.
- Roster-context tag suggestions only from explicit user-confirmed patterns;
  never infer identity from apparent age or appearance.
- Separate Android "Import selected photos" mode if whole-library access is not
  approved and research shows a manually selected batch still solves the need.
