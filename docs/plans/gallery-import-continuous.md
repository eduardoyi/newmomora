# Gallery import — continuous model + reliability + simplification

**Status:** implemented 2026-08-23, pending owner device pass + deploy
**Owner decisions (2026-08-23):** continuous model; reliability first; activity bell is the timeline re-entry point (dot + ephemeral row); remove the header glyph/drawer; simplify copy/visuals; same drill (Sonnet implements, Claude reviews, commit only after the owner's device pass).
**Audit this plan answers:** artifact "Gallery Import Audit" (2026-08-23). Summary of verified root causes:

- `countPendingGalleryClusters` selects a non-existent `id` column → `pendingClusters` is always `null` in prod → deck "more coming" forever, run can never be completed from the deck.
- Cap stack: 60 newest clusters/run, 60 candidates/run, 2 runs in the family's first 30 days then 1/UTC-month (cancelled/failed count). Newest-first slice means deepening never reaches older photos for active families.
- `gallery-import-pipeline.ts` `.catch` drops `runId` → runner marked active forever, progress screen frozen, no auto-resume.
- 5-minute wall-clock prep budget includes upload time; exhausted tail chunks written as `dispatched, clusters: []` (silently dropped).
- No AppState/launch resume; drawer routes to the deck at the first candidate; the deck never resumes.
- Worker ambiguous attempts never reconciled; one cluster failure fails the whole chunk; bridge maps every RPC error to a non-retryable 409.
- Progress/deck UI discards the numbers it has; reassurance copy on up to 13 surfaces; four different "N left" formulas; hardcoded "30 days".

## Product model (what the user experiences)

1. The user consents once ("Look through my photos"). From then on Momora keeps producing suggestions **in the background while the app is in the foreground**, walking the library from newest to oldest in windows, until the library is covered. The user never starts a "run" again.
2. The deck keeps refilling. The user swipes as much or as little as they like, leaves, and comes back later. Progress (cursor, kept, set aside) persists.
3. Re-entry lives on the timeline **activity bell**: a dot while suggestions are ready and unseen; an ephemeral "N photo suggestions ready" row at the top of the events sheet that opens the deck and disappears when nothing is ready. Settings keeps a row that reflects the same state.
4. Server fair-use: at most `daily_cluster_limit` (300) clusters per family per rolling 24 h. When hit, the device pauses the sweep until the window frees and the UI says "Momora will keep looking tomorrow" — never an error.
5. Review period extends on activity (any swipe/approval/registration bumps `expires_at` to now + 30 days). Expiry warns 3 days out via the Settings row + activity row copy.
6. "Stop" on the progress screen splits into **Stop looking for more** (keeps the cards, stops extending windows) and **Stop and clear** (today's cancel).

## Internal model

- **One server run per library sweep.** The run stays `processing`/`reviewing` for as long as the sweep lasts. Chunks keep registering during `reviewing` (already true since the 2026-08-11 migration).
- **Windows.** A window = one scan pass producing ≤ `GALLERY_IMPORT_WINDOW_CLUSTERS` (60) clusters, chunked `GALLERY_IMPORT_CLUSTERS_PER_CHUNK` (4) clusters per chunk (chunk ordinals continue across windows). A new window is planned only when every existing chunk is `dispatched` or `abandoned` **and** the backlog (server `readyCandidates` + `pendingClusters` + locally planned clusters) is below `GALLERY_IMPORT_TARGET_BACKLOG` (120) **and** the frontier says more history exists **and** `autoContinue` is on **and** no fair-use pause is active.
- **Contiguous frontier.** Within a window: Phase A (newer than `coveredThroughNewestMs`) clusters are taken **oldest-first** up to the window size; the remaining window is filled from Phase B (older than `oldestCoveredMs`) **newest-first**. A first-ever scan (no frontier) is newest-first. This keeps the covered range contiguous; the current newest-first slice over A+B leaves unregistered mid-range clusters inside the merged range (lost forever).
- **Budget = pause, never drop.** The per-pass preparation deadline only stops starting new native work; a chunk that was not fully prepared stays `planned` (or `registered` if already admitted) and the next driver pass continues it. Upload time is not counted against the preparation deadline.
- **Driver.** A single app-root driver (`src/services/gallery-import-driver.ts`, mounted via `useGalleryImportDriver()` in `app/(app)/_layout.tsx`) is the only thing that calls the runner: on launch, on AppState → active, on NetInfo reachability change, on explicit kicks (consent, cellular confirm, retry), and on a 60 s tick while a run has work. Screens only observe (live-progress bus + driver state).
- **"Coming" truth** = server `pendingClusters` + locally planned/failed (retryable) clusters + `moreHistory` (frontier not complete and `autoContinue`). Computed in one place: `deriveGalleryImportComingIndicator(run, checkpoint, frontier)`.
- **Done** = run terminal, or (`reviewing` ∧ server pending 0 ∧ local planned 0 ∧ no more history). Only then does the deck offer Finish (which calls `complete_gallery_import_run`); otherwise "Go to my journal" is plain navigation.
- **Checkpoint growth is bounded** by pruning `assetByToken`/`uploadedAssetTokens`/`clusterSignatures` for chunks the server reports terminal, keeping only tokens within the 3-hour day-pool of any live (staged/skipped) candidate's selected tokens (`liveCandidateAssetTokens` from get-run).

## Seams (contracts every implementer must honor)

S1. `get-gallery-import-run` response (Edge `clientRun`) adds:
```ts
pendingClusters: number | null          // FIXED: count of cluster_results state='pending' for the run
chunks: Array<{ ordinal: number; status: 'registered'|'uploading'|'dispatched'|'processing'|'completed'|'failed'|'cancelled'|'expired' }>
liveCandidateAssetTokens: string[]      // selected tokens of candidates with status in ('staged','skipped')
fairUse: { pausedUntil: string | null } // ISO when the family's daily cluster limit frees, else null
```
S2. `register-gallery-import-chunk` may fail with `{ code: 'fair_use', retryAfterSeconds: number }` (HTTP 429). Client treats as pause, not error.
S3. `dispatch-gallery-import-chunk` body accepts optional `unavailableAssetTokens: string[]` (assets admitted at registration that the device can no longer produce a preview for). Server marks them unavailable, drops them from the chunk manifest, suppresses clusters left empty, and dispatches the rest. A chunk with nothing left is closed `completed` with all clusters `skipped/invalid_preview`.
S4. Worker dispatch payload `{ chunkId: string; attempt?: number }`. Workflow instance id is `gallery:${chunkId}` for attempt ≤ 1, `gallery:${chunkId}:${attempt}` otherwise. Edge passes `attempt = chunks.dispatch_attempts` (new column, incremented by `mark_gallery_chunk_dispatched`).
S5. Bridge new op `fail_gallery_cluster` → RPC `fail_gallery_cluster(p_chunk_id, p_cluster_signature, p_closed_error_code)` (cluster result `failed`; chunk/run completion logic unchanged).
S6. Bridge error mapping: Postgres `40P01` (deadlock), `57014` (statement timeout), `08xxx` (connection), `53xxx` (resources), and any non-`P0001`/`22023`/`42501`/`28000` error → HTTP 503 `bridge_unavailable` (retryable). `P0001`/`22023`/`42501`/`28000` → 409 `bridge_rejected` (non-retryable) as today.
S7. `reserve_gallery_attempt`: an existing attempt row in state `ambiguous` for the requested ordinal returns `denied` (consumed), so a re-dispatched workflow moves to the next ordinal instead of looping on `already_reserved`.
S8. Client types (`src/services/gallery-import.ts`): `GalleryImportRun` gains the S1 fields. `src/utils/gallery-import-checkpoint.ts`: `GalleryImportCheckpointChunk.status` gains `'abandoned'`; chunk gains `attempts?: number`; checkpoint gains `pausedUntil?: string`, `allowCellular?: boolean`. `src/utils/gallery-import-frontier.ts`: `GalleryImportFrontier` gains `autoContinue: boolean` (default true when missing).
S9. `src/utils/gallery-import-deck.ts`: `deriveGalleryImportComingIndicator(run, checkpoint, frontier)` returns `{ kind: 'none' } | { kind: 'count'; count: number; moreHistory: boolean } | { kind: 'unknown'; moreHistory: boolean }`.
S10. Driver state (`src/services/gallery-import-driver.ts`): `subscribeGalleryImportDriver(listener)` → `{ phase: 'idle'|'scanning'|'preparing'|'uploading'|'dispatching'|'waiting_wifi'|'paused_fair_use'|'error'|'done'; runId: string|null; pausedUntil: string|null; lastError: string|null; isActive: boolean }`; `kickGalleryImportDriver(reason: string, opts?: { allowCellular?: boolean })`; `setGalleryImportAutoContinue(userId, familyId, value)`.

## Workstreams

Wave 1 runs I1, I2, I3, I4b in parallel (disjoint files). Wave 2 runs I4a after I3. I5 after everything.

---

### I1 — Server: SQL migration + Edge Functions + Deno tests + pgTAP

Files: `supabase/migrations/20260823100000_gallery_import_continuous.sql` (new), `supabase/functions/_shared/gallery-import.ts`, `supabase/functions/_shared/gallery-import.test.ts`, `supabase/functions/workflow-gallery-import-bridge/index.ts` (+ test), `supabase/functions/cleanup-gallery-imports/index.ts` (+ test), `supabase/functions/register-gallery-import-chunk/index.ts` and `dispatch-gallery-import-chunk/index.ts` only if the shared handler signature changes, `supabase/tests/gallery_import_continuous.sql` (new pgTAP), `src/types/database.ts` (regenerate or hand-edit consistently), `docs/TECH_SPEC.md` (gallery section).

1. **Fix `countPendingGalleryClusters`** (`_shared/gallery-import.ts:160-172`): select `chunk_id` (exists) instead of `id`. Add a Deno test that asserts the select string never references a column absent from `Database['public']['Tables']['gallery_import_cluster_results']['Row']` (type-level or a string assertion against the generated types).
2. **Migration — admission/limits.**
   - Widen `gallery_import_admission_settings.limit_template` check ranges: `maxChunksPerRun` 1–5000, `maxAssetsPerRun` 1–100000, `maxCandidatesPerRun` 1–10000. Set the default **and update the singleton row** to `{"maxChunksPerRun":2000,"maxAssetsPerRun":50000,"maxAssetsPerChunk":100,"maxCandidatesPerRun":5000,"maxProviderAttemptsPerCluster":3,"maxImagesPerCluster":10,"maxPreviewBytes":1500000}` (the touch trigger bumps `policy_epoch`; that's fine — existing runs keep their own snapshot).
   - Add `daily_cluster_limit smallint not null default 300 check (between 20 and 5000)` to the settings table.
   - `create_gallery_import_run_internal`: remove the initial-window and monthly checks entirely; keep billing, role, `enabled`, and the one-active-run check. Keep the `normal_monthly_run_limit`/`initial_*` columns (no longer read).
   - `register_gallery_import_chunk`: before inserting, count cluster_results created in the last 24 h for the family (`cluster_results` join chunks join runs on `family_id`, `created_at > now() - interval '24 hours'`); if `count + p_cluster_count > daily_cluster_limit`, raise `'Gallery import daily limit reached'` with `errcode = 'P0002'` and `hint = <ISO timestamp when the oldest counted row leaves the window>`. Edge maps `P0002` → HTTP 429 `{ code: 'fair_use', retryAfterSeconds }` (S2).
   - Chunk granularity: `register_gallery_import_chunk` currently requires `p_cluster_count between 1 and least(1000,p_asset_count)` — keep.
3. **Migration — TTL extension.** New internal fn `gallery_import_touch_run(p_run_id)`: if run status in ('scanning','processing','reviewing'), set `expires_at = greatest(expires_at, now() + review_ttl)` on the run and propagate to `gallery_import_assets.expires_at` and any other per-row expiry column cleanup consults (audit `get_gallery_import_cleanup_objects`, `claim_gallery_import_cleanup`, the assets cleanup index). Call it from `register_gallery_import_chunk`, `set_gallery_import_candidate_skip`, `begin_gallery_import_approval`, `finalize_gallery_import_candidate`, `get_gallery_import_candidates`. Candidate rows: if they carry their own expiry, touch them too. Document the rule in TECH_SPEC: "review window is 30 days from last activity".
4. **Migration — completion/publish guards.**
   - `complete_gallery_import_run`: additionally raise `'Gallery import still has work in flight'` (P0001) if any chunk is in ('registered','uploading','dispatched','processing').
   - `publish_gallery_candidates` and `publish_gallery_cluster_result`: refuse (P0001) when the run is `completed` as well as cancelled/expired/failed.
   - `register_gallery_import_assets` (foundation.sql:551-554): only flip the run to `reviewing` when no other chunk is non-terminal (mirror publish/fail).
5. **Migration — asset unavailability (S3).** Add `gallery_import_assets.unavailable_at timestamptz`. New RPC `mark_gallery_import_assets_unavailable(p_run_id, p_capability, p_chunk_id, p_asset_tokens uuid[])`: only for assets in that chunk with `preview_uploaded_at is null`; sets `unavailable_at`; recomputes the chunk's `asset_count`/`cluster_count`; for clusters left with zero available assets, publishes the cluster result as `skipped/invalid_preview` (via the same path `publish_gallery_cluster_result` uses, or an internal helper) and writes no receipt. The dispatch HEAD verification and `get_gallery_chunk_input` must exclude unavailable assets. If a chunk has no available assets left, close it `completed` without dispatching. Keep the preview-manifest protection trigger intact.
6. **Migration — reconciliation (S4, S7).** Add `gallery_import_chunks.dispatch_attempts smallint not null default 0`; `mark_gallery_chunk_dispatched` increments it and allows `dispatched`/`processing` → `dispatched` re-marking (update `enforce_gallery_import_transitions` accordingly). New RPC `claim_stale_gallery_chunks(p_limit)`: chunks in ('dispatched','processing') with `dispatched_at < now() - interval '20 minutes'`, run non-terminal and not expired, `dispatch_attempts < 3` → returns ids (and bumps nothing; the Edge re-dispatch path calls `mark_gallery_chunk_dispatched`). Chunks at `dispatch_attempts >= 3` and stale → `fail_gallery_chunk(id, 'GALLERY_RECONCILE_EXHAUSTED')`. `reserve_gallery_attempt`: treat an existing `ambiguous` row as `denied` (S7). New RPC `fail_gallery_cluster` (S5).
7. **Edge `_shared/gallery-import.ts`.** `clientRun` returns S1 fields (`chunks` via one select on `gallery_import_chunks` ordered by ordinal; `liveCandidateAssetTokens` via one select on candidates `status in ('staged','skipped')` returning `selected_asset_tokens` or equivalent column; `fairUse.pausedUntil` via the same 24 h count as step 2 — compute in SQL through a small RPC `get_gallery_import_fair_use(p_family_id)` returning `{ used, limit, resets_at }`). `dispatchGalleryImportChunk` accepts `unavailableAssetTokens` (S3) and passes `attempt` (S4) to the Worker. Add `redispatchStaleGalleryChunks(context)` used by the cleanup cron. Limits mapping (`:194-196`): `maxClusters` stays derived from `maxCandidatesPerRun`; client ignores it for windowing (I3).
8. **Bridge** (`workflow-gallery-import-bridge/index.ts`): add `fail_gallery_cluster` op (S5); error mapping per S6.
9. **Cleanup cron** (`cleanup-gallery-imports/index.ts`): after expiry work, call `redispatchStaleGalleryChunks` (claims via step 6 RPC, re-marks dispatched, calls the Worker with `attempt`). Content-free logging only (counts).
10. **Tests.** Deno: the column-name guard (step 1), S1 shape, fair-use 429 mapping, S3 pass-through, S6 mapping, redispatch loop. pgTAP `supabase/tests/gallery_import_continuous.sql`: monthly limit removed (3 runs in a month allowed sequentially after completion), daily cluster limit raises P0002, touch extends `expires_at`, complete refuses with in-flight chunks, publish refuses into completed, unavailable-asset flow, ambiguous reservation → denied, stale chunk claim. Run `npm run test:edge`; `npm run test:db` only if local Supabase is up (state which ran).
11. **Types/docs.** Regenerate `src/types/database.ts` if tooling is available (the repo memory notes a corrupted-regeneration incident — hand-edit the affected `Functions`/`Tables` entries consistently if regeneration is not possible, and say so). Update TECH_SPEC gallery section for every new/changed RPC and the admission change.

Do **not** deploy anything. Report the exact deploy commands needed (migration push, `supabase functions deploy … --use-api`).

---

### I2 — Worker (`cloudflare/memory-illustration-worker`)

Files: `src/gallery-workflow.ts`, `src/gallery-bridge.ts`, `src/bridge.ts`, `src/index.ts`, `src/types.ts`, `test/gallery-*.test.ts`.

1. **Dispatch payload/instance id (S4):** accept `{ chunkId, attempt? }`; instance id `gallery:${chunkId}` when `attempt` ≤ 1 or absent, `gallery:${chunkId}:${attempt}` otherwise. Keep `isDuplicateWorkflowError` but also match the Cloudflare "instance already exists" error code/message precisely if the SDK exposes one.
2. **Per-cluster steps.** Restructure `GalleryImportWorkflow.run` so `getGalleryChunkInput` is one step, then each cluster is its own `step.do(`cluster ${signature}`, { retries: { limit: 0 }, timeout: '4 minutes', sensitive: 'output' })`. A non-ambiguous cluster failure (`VISION_REJECTED`, `GALLERY_ATTEMPT_CAP_EXHAUSTED`, non-preview R2 error, invalid cluster input, step timeout) → call the new bridge op `fail_gallery_cluster` (S5) for that cluster and continue with the next cluster. Only `INVALID_GALLERY_CHUNK_INPUT` (whole-chunk) still calls `fail_gallery_chunk`. An ambiguous error still rethrows the workflow (reconciliation re-dispatches; S7 makes the next ordinal reservable). After all clusters: scrub step as today.
3. **Bridge retry policy:** `bridgeRetry` retries on `BridgeError.retryable` **and** on plain network errors (`TypeError`/`fetch` failures, `AbortError`), with backoff 1 s / 3 s / 9 s (3 attempts). Classify HTTP 503/502/504/429/408 as retryable (should already be); 409 stays non-retryable.
4. **Bridge client:** add `failGalleryCluster(env, { chunkId, clusterSignature, errorCode })` in `src/gallery-bridge.ts` (HMAC-signed like the others).
5. **Tests:** update `gallery-workflow.integration.test.ts` for per-cluster isolation (one cluster fails, others publish; chunk completes), ambiguous rethrow unchanged, attempt-suffixed instance id, retry on network error. Run `npm test -- gallery` in the worker dir.

Do **not** deploy. Report `wrangler deploy` as the command.

---

### I3 — Client core: continuous runner + driver + checkpoint/frontier/scanner + services

Files: `src/constants/gallery-import.ts`, `src/services/gallery-import.ts` (+ integration test), `src/services/gallery-import-runner.ts` (+ integration test), `src/services/gallery-import-driver.ts` (new, + test), `src/hooks/useGalleryImportDriver.ts` (new), `app/(app)/_layout.tsx` (mount the hook only), `src/utils/gallery-import-checkpoint.ts` (+ test), `src/utils/gallery-import-frontier.ts` (+ test), `src/utils/gallery-import-scanner.ts` (+ test), `src/utils/gallery-import-pipeline.ts` (+ test), `src/utils/gallery-import-live-progress.ts`, `src/utils/gallery-import-pending-start.ts`, `src/utils/gallery-import-deck.ts` (+ test), `src/utils/gallery-import-progress-stage.ts` (+ test), `src/utils/gallery-import-entry-state.ts` (+ test), `src/hooks/useGalleryImport.ts` (+ test), `src/utils/gallery-import-e2e-adapter.ts` (fixtures for the new S1 fields).

Not yours: any `src/components/gallery-import/*.tsx`, `app/(app)/(tabs)/timeline.tsx`, `app/(app)/gallery-import/*.tsx` (I4a consumes your APIs afterwards; keep the existing exports compiling — `startGalleryImportRunner`, `resumeGalleryImportRunner`, `beginGalleryImportPipeline`, `useGalleryImportEntryStatus` — even if their internals change).

1. **Constants:** add `GALLERY_IMPORT_WINDOW_CLUSTERS = 60` (replaces the meaning of `GALLERY_IMPORT_MAX_CLUSTERS_PER_RUN`; keep the old name as an alias), `GALLERY_IMPORT_CLUSTERS_PER_CHUNK = 4`, `GALLERY_IMPORT_TARGET_BACKLOG = 120`, `GALLERY_IMPORT_DRIVER_TICK_MS = 60_000`, `GALLERY_IMPORT_EDGE_TIMEOUT_MS = 45_000`, `GALLERY_IMPORT_CHUNK_MAX_ATTEMPTS = 3`; raise `GALLERY_IMPORT_CHECKPOINT_MAX_BYTES` to `1_500_000`.
2. **Services (`gallery-import.ts`):** every `invokeGalleryImport` races `supabase.functions.invoke` against `GALLERY_IMPORT_EDGE_TIMEOUT_MS` (use an `AbortController` via `signal` if this supabase-js version supports it — check `node_modules/@supabase/functions-js` — else a timeout race that returns `{ error: { code: 'timeout' } }`). Map HTTP 429 + `code: 'fair_use'` into `GalleryImportServiceError` with `retryAfterSeconds` (S2). `GalleryImportRun` gains S1 fields. `dispatchGalleryImportChunk` accepts `unavailableAssetTokens` (S3). E2E fixtures updated.
3. **Checkpoint/frontier types (S8):** `'abandoned'` chunk status, `attempts`, `pausedUntil`, `allowCellular`; frontier `autoContinue` (default true on load when absent). Add `pruneGalleryImportCheckpoint(checkpoint, run)` implementing the bounded-growth rule from "Internal model" (keeps tokens within ±3 h of any `liveCandidateAssetTokens` capture time; drops entries for chunks whose server status is terminal; prunes `clusterSignatures` for dispatched chunks; never drops tokens referenced by `approvalOutbox`). Unit-test it.
4. **Scanner windowing:** `scanGallerySnapshot` gains `targetClusterCount` (= window) and stops enumerating once `targetClusterCount + 1` complete groups exist in the current phase (a group is complete when the next-older asset is > gap away, or the phase ended). Implement the contiguous ordering rule: with a frontier, Phase A groups oldest-first up to the window, then Phase B groups newest-first for the remainder; no frontier → newest-first. `clusterGalleryAssets` gets an `order: 'newest_first' | 'oldest_first'` option used per phase; the combined result preserves the phase order. Keep `gallery-v1` signatures unchanged (signature hashes one group's assets — ordering of groups does not affect it; assert in a test). `reachedLibraryEnd` semantics unchanged. Fix `completedLibrary`: only true when Phase B (or the single pass) was not truncated **and** every group it produced was admitted into the window (i.e. the scan did not stop early because the window was full).
5. **Runner rewrite (`gallery-import-runner.ts`).** Replace the two monoliths with:
   - `startGalleryImportRunner(input)` → scan first window, Wi-Fi gate, create run, checkpoint (chunks `planned`, 4 clusters each), `onRunStarted`, then `await processGalleryImportChunks(...)`. Keep its return shape.
   - `resumeGalleryImportRunner(input)` → reconcile remote (terminal → clear; `reviewing` label sync), Wi-Fi gate only when upload work remains (`allowCellular` from input **or** checkpoint), then `await processGalleryImportChunks(...)`, then `await maybeExtendGalleryImportPlan(...)` and, if it added chunks, process them too (loop until no extension or pass deadline).
   - `processGalleryImportChunks({ userId, familyId, runId, adapter, onProgress, passDeadlineAtMs })`: for each chunk in ('planned','failed','registered','uploaded') with `attempts < GALLERY_IMPORT_CHUNK_MAX_ATTEMPTS` in ordinal order: prepare missing previews (per-asset 30 s deadline; the **pass deadline** only prevents *starting* new native work — when reached, return `{ reason: 'pass_deadline' }` with the chunk left in its current status, never closed); register (omit unprepared assets before admission; after admission an unpreparable asset goes into `unavailableAssetTokens` for dispatch, S3); upload (90 s + retry as today; a failure marks the chunk `failed`, increments `attempts`, and **continues to the next chunk**); dispatch (pass `unavailableAssetTokens`). `attempts >= 3` → `abandoned` (terminal locally; excluded from "coming"; counted for the UI as "couldn't send"). Register refused with `fair_use` → set `checkpoint.pausedUntil`, return `{ reason: 'fair_use' }`. Upload time never consumes the preparation deadline. Delete the "close as dispatched with empty clusters" paths; a chunk whose *every* asset is unavailable before admission is marked `abandoned` with `attempts = 3` (not `dispatched`).
   - `maybeExtendGalleryImportPlan({...})`: conditions from "Internal model"; reads `run` via `getGalleryImportRun` for backlog; scans the next window with the frontier; appends chunks with continuing ordinals; merges new assets into `assetByToken`; saves; returns the number of chunks added. Call `pruneGalleryImportCheckpoint` with the fresh run before saving.
   - `maybeAdvanceGalleryImportFrontier`: gate on "no chunk in planned/failed/registered/uploaded" (abandoned counts as settled — document the accepted mid-range loss), compute coverage from registered chunks only.
   - Cancel awareness: every `updateGalleryImportCheckpoint` returning `null` (checkpoint gone) aborts the pass with `{ reason: 'cancelled' }`.
   - Keep all existing content-free error messages; add `GalleryImportFairUsePausedError(pausedUntil)`.
6. **Pipeline fix:** `beginGalleryImportPipeline` keeps `runId` through `.catch` (capture it from `onRunStarted` into a local) and always calls `markGalleryImportRunnerInactive` in `.finally`. Test: failure after `onRunStarted` marks inactive.
7. **Driver (S10):** `src/services/gallery-import-driver.ts` — module singleton. `kickGalleryImportDriver(reason, opts)` is single-flight per (userId, familyId): loads latest checkpoint; if none → idle; if `pausedUntil` in the future → `paused_fair_use`; if `status === 'paused'` (Wi-Fi) and not on Wi-Fi and no `allowCellular` → `waiting_wifi` (but **do** re-check NetInfo every kick so Wi-Fi regain resumes automatically); else `resumeGalleryImportRunner` with `onProgress → publishGalleryImportLiveProgress`. Errors → `phase: 'error', lastError` (content-free), exponential backoff (30 s → 5 min) before the next automatic kick; a manual kick resets backoff. Subscribes to `AppState` (`active` → kick), `NetInfo.addEventListener` (reachable/wifi change → kick), and a `setInterval(GALLERY_IMPORT_DRIVER_TICK_MS)` while a checkpoint has unsettled chunks or `moreHistory`. `useGalleryImportDriver()` (in `src/hooks/useGalleryImportDriver.ts`) wires user/family ids, mounts listeners once, kicks on mount and whenever family changes; mounted in `app/(app)/_layout.tsx`. `setGalleryImportAutoContinue` persists to the frontier. Also migrate `gallery-import-progress.tsx`'s responsibilities conceptually — but do not edit that file; I4a will delete its resume effect and read the driver.
8. **Deck/stage derivations:** implement S9 in `gallery-import-deck.ts` (server pending + local planned/failed clusters not abandoned + moreHistory). `gallery-import-progress-stage.ts`: add `localPlannedClusters`, `abandonedChunks`, `driverPhase`, `pausedUntil`, `moreHistory` inputs; never return `empty` while local chunks are unsettled; surface `hasTransientError` even when the server is `reviewing`; new stages `pausedFairUse` and `doneLookingMoreHistory` as needed (keep the union minimal — I4a renders). `gallery-import-entry-state.ts`: `processing` when local chunks are unsettled even if the server is `reviewing` with 0 ready; expose `readyCount`.
9. **Hook:** `useGalleryImportEntryStatus` also returns driver state and `comingIndicator`; poll `getGalleryImportRun` every 15 s while a run is non-terminal (today's `staleTime` is fine, add `refetchInterval`).
10. **Tests:** extend the runner integration test for: window extension when backlog is low; no extension when backlog is high; contiguous ordering (A oldest-first then B newest-first); pass deadline leaves chunks `planned`; upload failure → `failed` + continue; 3 failures → `abandoned`; fair-use → `pausedUntil`; unavailable-after-admission → S3; cancel mid-pass aborts; frontier advances only on settled chunks. Driver unit tests with mocked AppState/NetInfo. Run `npx jest src/services src/utils src/hooks --runInBand` and `npx tsc --noEmit`.

---

### I4b — Copy & visual simplification (files independent of I3/I4a)

Files: `src/components/gallery-import/gallery-import-trust.tsx` (+ test), `gallery-import-empty.tsx` (+ test), `gallery-import-exception.tsx` (+ test), `gallery-import-review-sheets.tsx` (+ test), `gallery-import-caption-settings.tsx` (+ test), `gallery-import-approval.tsx` (+ integration test), `import-invite-card.tsx`, `gallery-import-shared.tsx` (+ test; only if a shared primitive needs a prop — do not remove exports others use).

Principle: **each reassurance once per flow, on the trust screen.** Every other surface is eyebrow · title · ≤ 1 line · buttons. No boxed explainer that exists only to explain another element. Keep testIDs stable where tests reference them; update tests for removed copy.

1. **Trust explainer:** three one-line rows, no numbered cards/pills/badges/links: "Your phone reads dates and groups photos. Nothing is changed." / "Small previews go to Momora to write draft captions. No faces, no location." / "Only what you keep is saved. The rest clears on its own." One "Details" link opening a single merged sheet (≤ 5 short bullets: what a preview is, where it goes, how long, what is never sent, you can stop any time). Remove the "no face recognition" box, the shield reassure row, and one of the duplicate exits (keep top-bar "Not now"; drop "Cancel"). Remove `REVIEW_DAYS_FALLBACK` and any "30 days" literal — the merged sheet says "clears on its own".
2. **Permission outcomes:** pill · title · one line · two buttons; drop the shield lines.
3. **Empty outcomes:** eyebrow · title · one line · buttons; drop the script card and shield lines; drop "not a judgement".
4. **Exception screens:** pill · title · one sentence · buttons; keep only `lapsed`'s dynamic count note. Delete dead `removed`, `quietSkips` kinds and `GalleryImportNotice` if no non-test caller (grep first).
5. **Review sheets:** set-aside sheet → title · rows · one footer line "Won't be suggested again." (no "30 days"); photo chooser → drop the privacy note box and the browse hint.
6. **Caption settings:** drop the can/cannot trust card and the example-draft card; keep language row, instructions box with placeholder, example pills, one hint line ("Momora won't invent names or change which photos were chosen."), footnote.
7. **Approval composer:** collapse stage strings to "Saving photo i of n…" / "Finishing…"; footer says only "Saves on DATE."; kept-confirmation → "Kept" · "It is in your journal now." · card · buttons; drop the digest box and the body duplicate. **"N left" must read `run.readyCandidates`** (check what `GalleryImportApproval` receives; if it only has the deck cursor, compute from the `useGalleryImport` run query — do not count set-aside cards).
8. **Invite card:** eyebrow "From your photos" · title · CTA · ✕; drop body, shield, videos note.
9. **Copy sweep tests:** the existing banned-word sweeps must still pass; add assertions that "camera roll" appears on the trust screen only (within your files).

Run `npx jest src/components/gallery-import --runInBand` and `npx tsc --noEmit`.

---

### I4a — Client UI: entry points, progress/deck wiring, activity bell (after I3)

Files: `app/(app)/(tabs)/timeline.tsx` (+ integration test), `app/(app)/(tabs)/settings.tsx` (only if the block signature changes), `src/components/gallery-import/gallery-import-settings.tsx` (+ test), `gallery-import-entry.tsx` (+ test), `gallery-import-progress.tsx` (+ test), `gallery-import-review.tsx` (+ test), `gallery-import-deck-card.tsx`, `src/components/family-activity-sheet.tsx` (+ test), `src/components/family-activity-row.tsx`, `src/components/timeline-activity-bell.tsx` (+ test), `src/utils/gallery-import-bell-seen.ts` (new), delete `import-drawer.tsx`, `import-glyph.tsx` and their tests, `docs/features/family-activity.md` (extension note), `app/(app)/gallery-import/*.tsx` if params change.

1. **Timeline:** remove `TimelineImportGlyph`/drawer. Render `TimelineGalleryImportInvite` when `visibleMemories.length <= 1` and `canEdit` and not dismissed (both the empty-state branch and as the list header's first item when there is exactly one memory). Bell `unread = hasUnreadActivity || galleryBellUnread`.
2. **Bell dot semantics:** `galleryBellUnread = readyCount > 0 && !seen(runId, readyCount)`; `seen` stored in AsyncStorage (`gallery-import-bell-seen:<userId>:<familyId>` = `{ runId, readyCount }`) and written when the sheet opens. Readiness comes from `useGalleryImportEntryStatus` (I3 exposes `readyCount`, `comingIndicator`, driver phase).
3. **Activity sheet ephemeral row:** `FamilyActivitySheet` gains `galleryImport?: { readyCount: number; comingIndicator: …; phase: …; onOpen: () => void }`. When `readyCount > 0` or the sweep is active, render one pinned row above the sections (and above the empty state) styled like `FamilyActivityRow` with a "Review" pill: copy "**12 photo suggestions** ready to review" / "Momora is still looking through your photos" (0 ready, active) / "Momora will keep looking tomorrow" (fair-use pause) / "Needs Wi‑Fi to keep going" (Wi‑Fi wait). Tap → close → `router.push('/(app)/gallery-import/review')` when ready > 0, else `/progress`. Not an event kind, not grouped, not persisted — document in `docs/features/family-activity.md` extension guide.
4. **Settings row as status hub:** caption and destination by state: ready > 0 → "12 ready to review" → review; sweep active → "Looking through your photos · N ready" → progress; Wi‑Fi wait / fair-use pause → matching caption → progress; expiring (≤ 3 days) → "Suggestions clear in 3 days" → review; no run → "Look through your photos" → entry. Fix the viewer caption bug.
5. **Entry screen:** if a checkpoint exists, route by state (review when ready > 0 else progress) instead of always progress; single exit ("Not now"); copy per I4b principle (title · one line · illustration · CTA); "Pick up where you left off" label only when ready > 0.
6. **Progress screen — number-led, one layout:** delete the workbench, 4-row checklist, safe card, privacy link row and sheet, the `paused` stage, the dead `ready` hints. Remove this screen's own resume effect and cellular-confirm resume — it now only **observes** (`subscribeGalleryImportDriver`, live-progress bus, run poll) and **kicks** (`kickGalleryImportDriver('retry')`, cellular → `kickGalleryImportDriver('cellular', { allowCellular: true })` which also persists `allowCellular` on the checkpoint). Layout: eyebrow = stage; title = the one number ("312 photos read" / "40 of 128 previews sent" / "3 of 9 batches written · 12 ready" / "12 ready to review"); one bar (indeterminate only while scanning); a pill "Keep Momora open" (scanning/preparing) or "Safe to close" (everything else); footer "Review 12" whenever `readyCount > 0`; secondary "Stop looking for more" (→ `setGalleryImportAutoContinue(false)`, copy "Momora will finish what it has and stop there.") and "Stop and clear" (today's cancel, sheet trimmed to title · "Drafts clear. Kept memories stay." · two buttons). Fair-use stage: "Momora will keep looking tomorrow" + "Review 12". Cellular sheet: title · "About N MB of previews." · two buttons. Show abandoned-chunk count as one muted line ("N batches couldn't be sent") only when > 0.
7. **Review deck:** `comingIndicator` per S9 (server pending + local + moreHistory). Between-batches state copy: "N more being written" / "More on the way — Momora is still looking through your photos" (moreHistory). Done state only when `kind === 'none'`; Finish calls `completeGalleryImportRun`; handle the server's "work in flight" error by showing between-batches. Remove hardcoded "30 days" (use `reviewDaysLeft` or drop the number). Drop the permanent footer hint and the ledger duplicate; rest point: eyebrow · title · "N more ready." · buttons, no boxed reassurance. Unify every "N left" to `run.readyCandidates`.
8. **Delete** `import-drawer.tsx`, `import-glyph.tsx`, their tests, and `useGalleryImportEntryStatus` consumers that only served them (keep the hook — Settings and the bell use it).
9. Tests: timeline integration (no glyph; invite at 0 and 1 memories; bell dot from gallery readiness; sheet pinned row + navigation), settings row states, progress stages incl. fair-use/abandoned, deck done gating, entry routing. `npx jest src/components app --runInBand`, `npx tsc --noEmit`, `npm run lint`.

---

### I5 — Docs (after all)

`docs/features/gallery-import.md` (rewrite "User-facing behavior", "Exact launch limits" → "Continuous sweep and fair use", architecture note on the driver, changelog entry; remove the "reviewing is terminal for admission" sentences), `docs/TECH_SPEC.md` (if I1 did not already), `docs/plans/gallery-import.md` (status pointer to this plan), `docs/features/family-activity.md` (ephemeral row), this file's status.

## Verification (orchestrator)

- `npx tsc --noEmit`, `npm run lint`, `npm test -- --runInBand` (full), `npm run test:edge`, worker `npm test`, `npm run test:db` if local Supabase is available.
- Seam checks: S1 fields used by I3 match I1's `clientRun`; S3/S4 body shapes match on both sides; S9 consumed identically by progress and deck; the driver is mounted exactly once.
- Deploy (after the owner's go): see the checklist below.

## Deviations from plan

Ground truth is the code; these are the places implementers departed from
this plan's exact wording, and why.

- **Edge round-trip timeout via the `invoke` `timeout` option, not a manual
  `AbortController` race.** S8/I3 step 2 speculated about checking whether
  the installed `@supabase/functions-js` version supports a `signal`. It
  does not need to: `gallery-import.ts`'s `invokeGalleryImport` passes
  `GALLERY_IMPORT_EDGE_TIMEOUT_MS` (45s) as `supabase.functions.invoke`'s own
  `timeout` option and maps a timeout to `{ error: { code: 'timeout' } }`
  itself — no custom race needed.
- **`moreHistory` is a required field on `GalleryImportComingIndicator`'s
  non-`'none'` variants**, tightened after the fact once every production
  caller (the review deck, the progress screen, `useGalleryImportEntryStatus`)
  passed `checkpoint`/`frontier` through — S9 originally sketched it as
  optional-ish; the shipped type has no way to construct a `'count'`/`'unknown'`
  variant without deciding the value.
- **Abandoned chunks count as accepted coverage, not zero coverage**, in
  `maybeAdvanceGalleryImportFrontier`. The plan's "Internal model" implied an
  abandoned chunk simply contributes nothing; the shipped code advances the
  frontier past an abandoned chunk's capture-time range anyway (documented in
  the function's own comment) — the alternative made the frontier stick at
  the same boundary forever, since the next `maybeExtendGalleryImportPlan`
  pass would re-scan and re-abandon the identical window in an infinite loop.
  This is the same "accepted coverage hole" the plan's Risks section already
  named; the code just makes explicit that abandoning *does* still advance
  the frontier.
- **Transient error codes include `'upload_timeout'`, not just the Edge's own
  `'timeout'`.** `GALLERY_TRANSIENT_ERROR_CODES` in `gallery-import-runner.ts`
  also excludes the raw preview PUT's `media.ts`-sourced `'upload_timeout'`
  code from a chunk's attempt budget — S8/I3 step 5's `errorCountsAsAttempt`
  language only called out the Edge timeout explicitly.
- **Phase A enumerates ascending, not merely "admits oldest-first."** I3 step
  4 described Phase A as admitting its oldest groups first; the shipped
  scanner also flips the native `getPhotoPage` query itself to ascending
  order for Phase A (`ascending: true`), not just the post-hoc admission
  order — a descending enumeration that was then admitted oldest-first would
  still leave a truncated catch-up pass with an un-enumerated band adjacent
  to the frontier that never gets re-scanned; ascending enumeration means a
  truncation only ever leaves a gap at the newest end, which the next Phase A
  naturally reaches.
- **`reserve_gallery_attempt`'s fall-through was a real, separately-fixed
  bug**, not just a design choice. S7 described the desired behavior
  ("an existing attempt row in state `ambiguous` ... returns `denied`"); the
  migration's comment on `reserve_gallery_attempt` documents that the
  *previous* function body had this exact case already correct in its
  `return query` call but then fell through into an unconditional `insert`
  anyway (plpgsql's `RETURN QUERY` does not exit the function), raising a
  duplicate-key error instead of ever returning to the caller. The fix added
  an explicit `return;` after every `return query`.
- **`fail_gallery_cluster`'s error code is recorded server-side as a state
  transition, not persisted as a stored value.** S5 specified the RPC
  signature including `p_closed_error_code`; the shipped function validates
  and accepts the code but the `gallery_import_cluster_results` row it
  writes only records `state='failed'` — the closed code itself is not
  stored in a column (it exists only in `console.warn`-free bridge logging
  ahead of the call, kept content-free). A future need to query "why did
  this cluster fail" server-side would need a follow-up migration to add a
  column.
- **The daily fair-use cap is family-wide, not per-device or per-actor** —
  `register_gallery_import_chunk`'s count joins through
  `gallery_import_runs.family_id`, matching S2's intent but worth stating
  explicitly since a multi-owner/manager family shares one 300-cluster/24h
  budget across every device sweeping that family's photos.
- **`gallery_import_touch_run` is throttled to at most once per day of
  activity**, not "every activity." I1 step 3 said "on every chunk
  registration, candidate skip/undo, approval begin/finalize, and candidate
  read" without specifying a throttle; the shipped function only performs
  the `UPDATE` (and its cascade to assets/candidates) when the run's current
  `expires_at` is more than a day short of `now() + review_ttl` — otherwise
  it is a single cheap no-op `UPDATE ... WHERE` that touches zero rows. This
  was necessary because `get_gallery_import_candidates` alone is polled by
  the review deck every ~9 seconds; without the throttle, every poll would
  rewrite every live asset/candidate row for the run.
- **The fair-use hint (and `get_gallery_import_fair_use`'s `resets_at`) use
  k-th-row precision, not the single oldest row.** Both `register_gallery_import_chunk`
  and `get_gallery_import_fair_use` compute the reset instant as the
  `(used + p_cluster_count - limit)`-th oldest counted row's `created_at +
  24h`, not `min(created_at) + 24h` of the whole rolling window — a
  multi-cluster chunk needs more than one row to age out before it actually
  fits, and retrying at the single-oldest-row instant would still be
  refused and the client would thrash.
- **Settings' "expiring" state reuses the existing `GALLERY_IMPORT_EXPIRING_SOON_DAYS`
  (4-day) threshold** rather than introducing a new continuous-model-specific
  number — I4a step 4 didn't specify a value; the shipped
  `deriveGalleryImportSettingsRow` imports the same constant
  `gallery-import-entry-state.ts` already defined for the pre-continuous
  design.
- **`getGalleryChunkInput` stays a plain `await`, never a `step.do`.** I2
  step 2 described restructuring the Workflow so `getGalleryChunkInput` "is
  one step, then each cluster is its own `step.do(...)`" — the shipped code
  isolates each cluster as its own step exactly as specified, but keeps the
  chunk-input fetch as a plain (non-step) call, with a comment explaining
  why: a step's return value is persisted in Workflow history for replay,
  and the chunk input carries preview keys, caption instructions, and
  cluster signatures that must never enter that history. `bridgeRetry`
  already bounds its retries and the fetch is naturally idempotent
  (`get_gallery_chunk_input` only returns still-pending clusters).
- **`DeckLedger` was removed entirely**, not merely trimmed. I4b's "review
  sheets"/"approval composer" items described dropping specific boxes
  ("the digest box and the body duplicate"); in the shipped code the ledger
  concept itself (a running tally component distinct from the deck's own
  cursor) no longer exists anywhere in `src/components/gallery-import/`.

## Deploy checklist

Not yet executed — this is the exact sequence for when the owner's device
pass clears.

1. **Migration:** `supabase db push` (or the project's equivalent migration
   command) to apply `supabase/migrations/20260823100000_gallery_import_continuous.sql`.
2. **Edge Functions:** deploy every gallery-import function with `--use-api`
   (19 functions — enumerate fresh with `ls supabase/functions | grep gallery`
   rather than trusting this list to stay current):
   `begin-gallery-import-approval`, `cancel-gallery-import-run`,
   `cleanup-gallery-imports`, `complete-gallery-import-run`,
   `create-gallery-import-run`, `dispatch-gallery-import-chunk`,
   `finalize-gallery-import-candidate`, `get-gallery-caption-settings`,
   `get-gallery-import-approval-upload-url`, `get-gallery-import-candidates`,
   `get-gallery-import-run`, `get-gallery-import-upload-url`,
   `record-gallery-import-approval-upload`, `register-gallery-import-chunk`,
   `send-gallery-import-digests`, `set-gallery-import-candidate-skip`,
   `update-gallery-caption-settings`, `update-gallery-import-candidate`,
   `workflow-gallery-import-bridge`.
3. **Worker:** `wrangler deploy` from `cloudflare/memory-illustration-worker`
   (ships the per-cluster-step Workflow restructuring, the attempt-suffixed
   instance id, and the network-error-retryable bridge classification).
4. **Reset the test account's state:**
   `npm run reset:gallery-import -- --user <test> --confirm`.
5. **Clear device storage** for the test build (AsyncStorage checkpoint +
   frontier + bell-seen + invite-dismissal keys) so the device starts from a
   genuinely fresh state, not a stale pre-continuous checkpoint shape.
6. **Smoke test** per the audit's scenario list (artifact "Gallery Import
   Audit," 2026-08-23): consent → first window → deck refills across windows
   → activity bell dot/row → Settings status hub → fair-use pause copy (force
   the daily cap in staging) → "Stop looking for more" vs. "Stop and clear" →
   app-kill-and-relaunch resume via the driver (no manual re-open of the
   progress screen needed) → measure real `gallery_import_provider_attempts`
   volume against the 300/family/24h guess.

## Risks / accepted limitations

- Abandoned chunks inside a window leave a coverage hole (documented; the frontier treats them as settled). A later "re-look at gaps" is out of scope.
- iOS iCloud-only originals are still omitted (no lower-res rendition path in expo-media-library); S3 makes them non-blocking on resume. Untested on iOS.
- The daily fair-use cap is a product guess (300 clusters/family/day ≈ $0.2/day worst case at gpt-4o-mini prices); measure from `gallery_import_provider_attempts` during the smoke test.
- Widening `limit_template` bumps `policy_epoch`; in-flight runs keep their own snapshot.

## Device smoke test — 2026-08-23 (owner's Pixel 9a, dev build 1.3.0 / build 42, real library)

Deployed first: migration, all 19 gallery Edge functions (`--use-api`), Worker. Test-account server state reset; fresh install had no local checkpoint.

Verified on device:
- Timeline: bell only (no glyph/drawer); invite card hidden (family has many memories). Bell dot appears when suggestions are ready and unseen; ephemeral row pinned in the activity sheet ("Momora is still looking…" → "N photo suggestions ready" → Review → deck).
- Settings row reflects live state ("Looking through your photos · N ready" → "Look through your photos" when no checkpoint).
- Entry → trust (3 lines + Details) → OS prompt → progress screen (number-led, "Safe to close" pill, "Stop looking for more").
- Leaving the progress screen mid-upload: uploads continued (3 → 98 → 238 of 348) driven by the app-root driver; backgrounding the app 20 s and returning resumed cleanly.
- Second and third windows were planned automatically once the first settled (348 → 602 → 45 chunks); backlog gate (105 ready + 16 pending ≥ 120) correctly paused further extension.
- Deck: 29+ cards streamed in with "more coming"; set aside, keep → composer (4-photo cluster) → Kept screen with real "Next suggestion · 105 left"; 4 memories created with `creation_source='gallery_import'`.
- Hourly reconciliation cron (19:00 UTC) re-dispatched 6 chunks stuck from the dispatch outage below, with attempt-suffixed Workflow ids.

Bugs found and fixed during the session (all in the tree, tests green):
1. Workflow instance id `gallery:<chunkId>` is invalid (Cloudflare allows `[A-Za-z0-9_-]` only) → every dispatch 502'd. Now `gallery-<chunkId>[-<attempt>]` on both sides.
2. `get-gallery-import-candidates` used `.in(opaque_token, [...])` over every live candidate's tokens; past ~100 candidates the PostgREST URL overflowed, the error was swallowed, and every candidate lost its preview URLs ("None of these photos could be shown"). Now queries by run and matches in memory.
3. Settings row showed "Looking through your photos · 0 ready" with no run: `comingIndicator` is now `'none'` when there is no checkpoint; row derivation guards on the checkpoint.
4. Settings/Timeline hooks went stale while mounted under the tab bar: `useGalleryImportEntryStatus` re-reads the checkpoint on driver run/phase transitions; the start pipeline kicks the driver on `onRunStarted`.
5. Approval screen: `refresh` was keyed on the outbox object identity, which the driver's checkpoint writes churn; a mid-save refresh captured the transient `approving` status and orphan recovery issued a second `begin` after finalization ("not available" shown for a successful save). Now keyed on primitives, skipped while in flight and after a save.
6. Review deck under the composer re-read the checkpoint, saw the composer's outbox item, and fired its redirect/replace from underneath the live save; redirects are now gated on the deck being focused. The deck also re-reads the checkpoint on focus and during its poll (it previously dead-locked on a stale outbox item with the candidate poll gated off).
7. `useRunCheckpoint.refresh()` flipped `isLoading` on every re-read (deck remounted every 9 s); now silent after the first load.
8. Driver loads the runner/scanner lazily so the app-root layout no longer pulls `expo-media-library` into web bundles (the gallery *routes* still do — pre-existing on this branch).
9. Progress "N batches couldn't be sent" counts only never-registered chunks.
10. Deck strip pluralization ("from 1 photo that day").

Not yet exercised on device: fair-use pause (300/day not reached: 180 clusters), Wi-Fi-off pause/regain, airplane mode mid-run, "Stop looking for more", expiry warning. Untested on iOS.

### 2026-08-23 follow-up: one sweep per device
A second family device could not start its own sweep: runs are device-bound and the old partial unique index allowed one active run per family, which under the continuous model stays `reviewing` indefinitely ("Momora has reached its limit for now" on the iPhone). Migration `20260823210000_gallery_import_run_per_device.sql` replaces the unique index with a cap of 4 concurrently active runs per family in `create_gallery_import_run_internal`; the family-wide daily cluster cap remains the cost fence.

## Device smoke test, part 2 — 2026-08-23/24 (Android follow-ups + iPhone 12, dev build 1.3.0/46, real library)

Owner-reported issues fixed after part 1 (all with regression tests):
1. Double-dismiss: the deck's 9 s candidates poll raced a set-aside; a stale response resurrected the dismissed card. Fixed with a mutation-sequence guard in `gallery-import-review.tsx` (`mutationSeqRef`).
2. Low-res explanation: deck footer now reads "Small previews here. Kept photos save at full size."; composer footer says "Saves on DATE, at full size."
3. Pink-placeholder hero: a front card with no/expired preview URL now triggers one quiet re-sign per candidate (`onHeroUnavailable` + missing-hero effect).
4. Near-duplicate selections: worker prompt gained a hard near-duplicates rule (pick ONE per look-alike set; default 1–4 photos per group). Applies to newly processed clusters only.
5. "Stop looking for more" now persists via the frontier (`autoContinue`) across relaunches and gained a "Keep looking" undo that kicks the driver.
6. The deck's "more coming" pill opens the progress screen (previously unreachable with cards ready).
7. Expiry warning ordering: "N ready · clear in D days" wins over the plain ready caption in the Settings row and the activity-sheet row.
8. Fair-use pause: the driver re-checks the server on every kick while locally paused and clears the pause the moment the window frees (`clearGalleryImportCheckpointPause`).
9. Per-device runs: migration `20260823210000` (see follow-up note above) — a second family device can start its own sweep.
10. iOS "app within an app": every back-to-journal exit was a `replace` from inside a modal, nesting a new tab navigator in the sheet; all 18 exits now use `exitGalleryImportToTimeline()` (dismissAll + navigate).
11. Pluralization: "from 1 photo that day".

iPhone 12 session (same family, second device): per-device admission ✅; fair-use pause surfaced instantly (family-wide window shared with the Android sweep) and auto-un-paused ~1 min after the cap was restored ✅; sweep streamed 24 chunks while the owner reviewed (56 set aside, 1 kept via the PhotoKit originals approval path) ✅; between-batches → new-batch loop ✅; Wi-Fi off/on, airplane mode, background/foreground, and Stop-looking/Keep-looking all exercised by the owner — everything recovered on its own ✅.

Expiry-warning caveat (accepted): `gallery_import_touch_run` extends the TTL on any candidates read, so the "clears in N days" warning is only reachable after ~29 days without opening the deck; the rendering paths are unit-tested.

## Phase-0 cost benchmark — measured 2026-08-23 (real libraries, gpt-4o-mini)

Two full-device sweeps in one day (Pixel 9a camera album + iPhone 12 library):
295 clusters, 1,444 photos previewed, 272 provider attempts (269 completed,
2 failed, 1 ambiguous), 199 candidates staged. Token usage from
`gallery_import_provider_attempts.usage`: 4.35M input + 28K output tokens →
**$0.67 total** ≈ **$0.0023/cluster ≈ $0.00046/photo ≈ $0.0034/candidate**.
A typical initial sweep is therefore ~$0.30–0.35 per device library and near
zero at steady state; the 300-cluster/day family cap bounds worst-case spend
at ~$0.68/family/day. R2 preview storage/ops are fractions of a cent
(transient ~200 MB per sweep). Cost clears the Phase-0 gate by a wide margin
at the $12.99/mo price point.

## Release prep — 2026-08-23/24

- Release worktree `../Momora2-release`, branch `release/1.3.0` at 2c91936 +
  two release-only commits (production env flag `EXPO_PUBLIC_GALLERY_IMPORT_ENABLED=true`
  in eas.json; `.easignore` trimming the upload). Cherry-pick both onto
  `codex/gallery-import` before or with the main merge so branches agree.
- Production EAS builds started (Android versionCode 44, iOS via stored
  distribution cert). Version 1.3.0, `appVersionSource: remote`.
- Server rollout lever: `gallery_import_admission_settings.enabled` (already
  on for the shared project). Client flag now baked into production builds.

### Google Play — Photos and Video Permissions declaration (draft answers)

Play Console → App content → Photo and video permissions.

- **Permission requested:** `READ_MEDIA_IMAGES` only (expo-media-library
  `granularPermissions: ["photo"]`; no videos, no ACCESS_MEDIA_LOCATION).
- **Core feature:** "Find memories in your photos" — the app's primary
  content-creation flow. Momora is a private family memory journal; the
  feature scans the user's photo library on-device, groups photos into
  events, and suggests journal entries the parent explicitly reviews and
  approves one by one. Broad access is required because the feature's core
  value is looking across the whole library (including older photos) to
  find moments worth keeping; the Android Photo Picker cannot provide
  recurring, whole-library discovery.
- **One-time vs recurring:** recurring, user-initiated; the user consents in
  an in-app explainer BEFORE the OS permission prompt and can stop at any
  time ("Stop looking for more" / "Stop and clear").
- **Data handling:** photo files are read on-device; 512 px JPEG previews of
  candidate photos are uploaded transiently to the developer's private
  storage solely to generate caption suggestions, then deleted automatically
  (30-day cap, sooner on stop/finish). Full-resolution photos are uploaded
  only for suggestions the user explicitly approves, into their private
  family journal. No location data (EXIF GPS stripped / not requested), no
  face recognition, no ads, no sale or sharing of photo data.
- **Demo video:** record Settings → "Find memories in your photos" → trust
  explainer → OS prompt → progress → review deck → keep → journal entry.
  (To be recorded on the production build.)

### App Store (iOS) notes
- `NSPhotoLibraryUsageDescription` already present ("privately suggest
  family memories from photos you choose to let it review").
- No additional Apple declaration required; normal review. App Privacy
  labels already declare Photos under user content collection — verify the
  label mentions "Photos" linked to the user before submitting.
