# Year Film P1 — production backend

Status: planned 2026-09-28, hardened 2026-09-29 (2 review rounds, §11), built 2026-09-29 (not deployed; results and deviations in year-film.md §10 "P1 build results").
Parent plan: [year-film.md](year-film.md) (§7 architecture, §10 stages). P1 is
the backend only; the app (Timeline card, viewer, share, edit sheet,
Keepsakes) is P2. Deadline: P1 + P2 in production by ~Dec 5 (family films
render Dec 12, surface Dec 15).

## 1. Goal

A production pipeline that, with no human in the loop, turns a family's
journal into the three film kinds exactly as the F1–F3 dogfood pipeline does
locally — **birthday** (3 days after, scope through birthday+2), **monthly**
(the 1st, previous month) and **year-end family** (Dec 12, scope Jan 1–Dec 11)
— stores the MP4 + poster privately, never serves content the family removed,
edited out or reported, and is safe to canary on Eduardo's family only.

**P1 gate** (year-film.md §10), on production, canary family only:
(a) a birthday film end to end, (b) an edit re-render (`removedMemoryIds`),
(c) memory-deletion invalidation — once on a ready film and once *during* a
render, (d) a forced-scope family film, (e) renderer parity — the Fly render
of a fixed F3 `film.json` + assets vs a **local amd64 container render of the
same inputs** (same image): mean PSNR ≥ 45 dB, worst frame ≥ 38 dB, same
duration; plus an owner visual review against the laptop F3 MP4.

## 2. Context — what exists (verified 2026-09-29)

- **Pure production logic, already shared** (relative `.ts` imports only, no
  Deno APIs or enums → Worker- and Node-strip-types-safe):
  `supabase/functions/_shared/year-film-eligibility.ts` (scopes
  `{start, endExclusive}`, pools, `isFilmChild` = own child by role + DOB +
  under 13), `year-film-script.ts` (`build*Script`, `*VisionCandidates`,
  `checkKey` = `previewKey ?? key`, `shareSensitiveIds`), `year-film-quotes.ts`
  (`QUOTE_MODEL` gpt-6-sol), `year-film-vision.ts` (`CLAIM_CHECK_MODEL`
  gpt-6-sol, `FRAME_CHECK_MODEL` gpt-6-luna, `FRAME_CHECK_BATCH` 16,
  positional `parseFrameCheckResponse`), `year-film-voice.ts`,
  `year-film-trim.ts`, `year-film-i18n.ts`.
- **Eval orchestration P1 productionizes** (Deno, local, macOS):
  - `supabase/scripts/eval-year-film-script.ts`: load → quote pick → claim
    checks (images made 512px JPEG by ffmpeg `toVisionImage` — works for
    originals, previews and video frame 0) → build; language resolved after
    the quote pick (`languageFor`).
  - `supabase/scripts/eval-year-film-assets.ts`: `uses()` / `stillKey()`
    usage mapping; stills (`sips` HEIC) ≤1920px; burst clips = liveliest 2.5s
    with ranked fallbacks; verified clips = first 3s; sound = up to 3 voiced
    ≤6s windows + audio-model check; frame check of stills and mid-window clip
    frames against 512px reference portraits with "prefer_other_window"
    re-cuts; writes `film.json`.
  - `supabase/scripts/year-film-eval-data.ts`: reports are per viewer there.
- **Media keys live under the uploader's uid, not the owner's:**
  `get-upload-url` (`assertUserOwnedKey`, "Uploads are always written under
  the caller's own uid"); `hard-delete-expired-accounts` L26-31 (family media
  "can live under other members' `{uid}/` prefixes"). Previews are 1280px and
  absent for photos ≤1280px and legacy photos; legacy videos have no poster
  (`docs/features/media-memories.md`).
- **Media saves delete and re-insert rows:** `replace_memory_media_assets`
  (`20260815120000_fix_retained_foreign_media_preview_keys.sql` L57/L73),
  called on edits that pass `mediaAssets` (`src/services/memories.ts`
  ~L1598); tags too (~L944-957).
- **Renderer workspace:** `film-renderer/assemble.mjs` (bed picked by slug
  hash / calendar month, `--bed` override; internal poster helper for
  stills only — no film poster or scene list output), `render.mjs`, beds +
  `beds.json`, `sample/make-sample.mjs`. No `hideNames` anywhere.
- **Render image (F5):** `render/year-film-renderer/` — Dockerfile (Node 22,
  Chrome for Testing 152, Debian ffmpeg 5.1, `hyperframes@0.8.80`,
  `ENTRYPOINT ["/app/bench.sh"]`, `CMD ["sample"]`), **no `package.json`**,
  `build.sh` (named context `filmrenderer`; stages tracked + untracked
  non-ignored files), README deploy = local build + `docker push
  registry.fly.io/momora-year-film-renderer:<tag>`. Fly app exists, **no
  machines**. No `libheif`. Laptop ffmpeg 8.1.1.
- **Precedents:** playbook `docs/durable-ai-generation-workflows.md`
  (invariants, signed hops, nonce ledger, ID-only step outputs, no R2
  lifecycle rules); `generate-memory-book`, `workflow-memory-book-bridge`,
  `cloudflare/memory-book-worker` (+ `wrangler.jsonc` `limits.cpu_ms` after a
  CPU-limit incident); `render/memory-book-renderer` (`@aws-sdk/client-s3`,
  own `package.json`, CI matrix); cron
  `20260713170000_schedule_daily_reminders_cron.sql`; owner timezone
  `20260812120000_looking_back_themed_recipes.sql` ~L123-160;
  `supabase/config.toml` `verify_jwt = false` entries; `.github/workflows/ci.yml`
  `workers` matrix; `billing_write_allowed(family, actor)`;
  `_shared/expo-push.ts` `PushRouteData` (sync with
  `src/hooks/useNotifications.ts` `RECOGNIZED_PUSH_ROUTES`; unknown route =
  no-op); AI ledger `record_ai_usage_event_detailed` (`ai_call_id` text
  unique, `usage_request_id` FK to image requests, `audio_seconds` only);
  `_shared/ai-pricing.ts` lacks gpt-6/gpt-audio; `content_reports`
  (`status in ('open','reviewing','resolved')`; targets `memory`,
  `memory_illustration` + `target_version_id`, `family_member_profile`,
  `family_member_portrait`, …); `delete-portrait-version`,
  `delete-family-member` (own keys only); definer trigger precedent
  `invalidate_memory_illustration_attempt_on_tag_change`;
  `claim_family_deletion_fence` + `hard-delete-expired-accounts` (defers for
  in-flight portrait/illustration generation, L206-213; sweeps `{ownerId}/`);
  `families.deleted_at` soft delete; export worker `plan.ts`.

## 3. Decisions

1. **Worker:** new `cloudflare/year-film-worker` (own deploy, secrets,
   `limits.cpu_ms`, CI matrix entry), importing the `_shared` year-film modules.
2. **Fly: one-off machines via the Machines API**, not an HTTP service (renders
   outlive requests; `auto_stop_machines` could stop a machine mid-render; F5
   proved one-off machines; no public endpoint). Per machine: deterministic
   `name` (`{attemptId}-{mode}` → a replayed create gets a conflict and looks
   the machine up), `auto_destroy`, restart `no`, `init.cmd` = mode (the
   Dockerfile ENTRYPOINT becomes a job runner; `bench.sh` runs via explicit
   cmd), image pinned by **git-sha tag**, region/size fallback list
   (`iad`→`ord`→`ewr`; render 8x → 4x) on capacity errors, and the job wraps
   its work in a hard `timeout` so a hung Chrome can't run forever. Machine ids
   are stored on the row. The Worker holds a Fly token scoped to this app.
3. **R2 credentials: per machine, least privilege.** The Worker mints
   temporary R2 credentials inside the step that creates each machine (never
   persisted), TTL = machine timeout + 10 min: a **read-only credential
   scoped to the exact source `objects`** (keys returned by the bridge — media
   lives under many uploaders' prefixes) and a **read-write credential scoped
   to the attempt prefix**. The render machine gets only the latter. If the
   temp-credential API can't express this, fall back to bucket-wide Fly
   secrets as a documented, accepted risk (book-renderer parity) — decided in
   Step 6 by test.
4. **Three machine modes:** `thumbs` → `prepare` → `render`.
   - `thumbs` (small size, seconds): 512px JPEGs for the claim-check
     candidates (originals, previews, or video frame 0 — the eval's
     `toVisionImage`), so claim checks keep eval parity and cost (the Worker
     can't resize, and previews are 1280px or missing).
   - `prepare` (small size): stills ≤1920px with EXIF orientation (HEIC via
     `heif-convert`), clip measurements, ranked windows, **all** candidate
     cuts, and every check input (512px JPEG per still, clip window and
     reference portrait; 16 kHz mono WAV per voice window) → `prep.json`.
   - `render` (performance-8x): `film.json` + prepared files → `assemble.mjs`
     (bed from `film.json`) → `hyperframes check` → `hyperframes render` →
     `film.mp4` + `poster.jpg` (from the close scene) + `scenes.json`
     (scene starts/durations from the assembler's timeline).
   - Checks run in the Worker on prepared JPEG/WAV only.
5. **Verdict cache:** `ai_checks` keyed per frame by
   `sha(kind, model, promptVersion, assetKey, window?, referenceVersionIds)`;
   batches are split back into per-frame entries; **persisted per batch**
   through the bridge so a step retry never repays finished calls.
6. **Quote candidates and language are sticky:** the first curate stores
   `quote_candidates` (`{memoryId, textHash, quote}`) and `language`;
   re-renders reuse them, filtered by exclusions; `quoteIndex` edits
   reference `{memoryId, textHash}`.
7. **Re-renders rebuild from the database with a frozen pool:**
   `pool_cutoff_at` (first curate) excludes later memories; removed, edited
   or reported content drops out naturally.
8. **Edits in P1:** `removedMemoryIds`, quote choice, `musicBedId`
   (allow-list). `hideNames` → P2.
9. **Scheduling in two layers:** SQL decides what is due; the Workflow applies
   the real floors (TS eligibility). Pushes come from the hourly job.
10. **Rollout flag** `year_film_settings(mode off|canary|all,
    canary_family_ids, launch_date, max_concurrent_renders)`. `mode = off`
    also makes the bridge refuse work ops (in-flight runs stop at their next
    call). `all` only after the P2 app build has meaningful adoption (old
    apps ignore the `year-film` push route).
11. **Invalidation covers in-flight attempts** (epoch CAS) and is
    family-wide for reports (`status in ('open','reviewing')`). Per-viewer
    blocks: out of scope (§10 Q1).

## 4. State machine

`queued → curating → preparing → rendering → ready`, terminal `skipped` /
`failed`; flags `blocked` (never serve the current video) and `stale`
(re-render wanted, current video OK).

- **One row per scheduled film key forever:** unique `(family_id, kind,
  coalesce(family_member_id, zero), scope_start_date)` **where not
  `forced`**. `year_film_due` ignores forced rows and inserts only when no
  row exists. Forced (canary/operator) rows are separate and deleted at the
  end of the canary (checklist + pgTAP).
- **Attempts:** new `attempt_id` per dispatch; ≤ 3 attempts per render
  cycle, spaced by `next_attempt_at` (+1h, +6h) so a short OpenAI/Fly outage
  doesn't burn them.
- **Cycle end:** failure/skip with a published, non-blocked video → back to
  `ready` (old film serves, `stale` cleared, `last_failure_code` kept);
  otherwise `failed` / `skipped`. A `blocked` row never returns to serving —
  its old objects are deleted and keys nulled. An ops alert (Sentry) fires on
  every `failed`.
- **Skipped re-check:** a `skipped` row is re-evaluated once more within its
  3-day catch-up window if new memories arrived in scope (the parent posts
  on the 1st).
- **Epoch:** `content_epoch` bumped by every invalidation trigger on matching
  rows (any status). Curate records `curated_epoch`. Publish CAS requires
  `attempt_id`, `edits_version`, `content_epoch = curated_epoch`, and
  re-verifies in the same transaction (plain reads, no row locks on
  `memories` — avoids deadlocks with deletes) that every referenced memory,
  asset key, member and portrait version still exists without an open or
  reviewing report, and that quoted memories' text hashes still match.
  `heartbeat` returns `epoch_changed` / `superseded` / `disabled` so the
  Workflow aborts early (destroying its machine) instead of rendering to a
  lost CAS.
- **Heartbeat/recovery:** every bridge op and poll iteration refreshes
  `heartbeat_at`, including between model calls in curate; recovery acts
  only when `heartbeat_at` is older than 20 min and `next_attempt_at` has
  passed. A superseded Workflow is told at its next op.
- **Edits that remove content** set `blocked` (not just `stale`) until the new
  film publishes; if the cycle then fails, the row stays blocked.

## 5. Data model

Migration `supabase/migrations/2026MMDD_year_films.sql`:

- **`year_films`**: `id`, `family_id`, `kind`, `family_member_id`
  (composite fk, cascade; required iff birthday), `forced`,
  `scope_start_date`, `scope_end_exclusive`, `scope_label`, `language`,
  `status`, `blocked`, `stale`, `skip_reason`, `film_script`, `edits`,
  `edits_version`, `music_bed_id`, `quote_candidates`, `ai_checks`,
  `pool_cutoff_at`, `referenced_memory_ids uuid[]`,
  `referenced_asset_keys text[]`, `referenced_member_ids uuid[]`,
  `referenced_portrait_version_ids uuid[]`, `quoted_memory_text_hashes jsonb`
  (all GIN/stamped at **curate**), `content_epoch`, `curated_epoch`,
  `video_key`, `poster_key`, `scenes_key`, `duration_ms`, `attempt_id`,
  `attempt_count`, `next_attempt_at`, `workflow_instance_id`, `machine_ids
  jsonb`, `generation_started_at`, `heartbeat_at`, `render_slot_at`,
  `requeue_after`, `last_failure_code`, `cleanup_needed`, `surface_at`,
  `notified_at`, `created_at`, `ready_at`.
- **`year_film_views`**, **`year_film_render_requests`** (fair use:
  5/film/day, 20/family/day for edits), **`year_film_settings`**,
  **`year_film_bridge_nonces`**.
- **Client access:** column-level `select` grant on safe columns only (`id`,
  `family_id`, `kind`, `family_member_id`, scope fields, `status`,
  `blocked`, `stale`, `duration_ms`, `surface_at`, `ready_at`,
  `edits_version`) — never `film_script`, `ai_checks`, quotes, keys or
  machine/attempt fields; owners/managers read edit-sheet data through a
  definer RPC in P2. RLS: members where `surface_at <= now()`, not
  `blocked`, video present; owners/managers also earlier (canary preview).
  Revoke-first grants, anonymous lockdown.
- **Client RPC** `save_year_film_edits(p_film_id, p_edits)`: definer,
  anonymous/role/billing checks, shape validation (`removedMemoryIds` ⊆
  `referenced_memory_ids`; quote choice ∈ `quote_candidates`; `musicBedId` ∈
  allow-list parity-tested with `beds.json`), fair-use caps, bumps
  `edits_version`, `stale` (+ `blocked` if removing), CAS `ready → queued`.
- **Service-role RPCs:** `year_film_due`, `claim_year_film_dispatch`,
  `year_film_claim_render_slot` (DB-side cap on fresh `render_slot_at`),
  `publish_year_film`, `end_year_film_cycle`, `year_film_notifications_due`,
  `year_films_needing_cleanup`.
- **Invalidation triggers** (definer, fixed `search_path`, `set local
  lock_timeout`, fast no-op when no row matches or `mode = off`):
  - `memories` after delete (statement-level, transition table) → memory ids;
  - `memories` after update of `content`/`audio_transcript`/`description`
    when the memory is quoted (text hash changed) → **blocked** + requeue;
  - `memory_media`: a **deferred constraint trigger** (fires at commit) that
    invalidates only if the deleted `object_key` no longer exists in
    `memory_media` — so `replace_memory_media_assets`' delete+reinsert of
    unchanged assets is a no-op — matching `referenced_asset_keys`;
  - `content_reports` after insert (`memory`, `memory_illustration`,
    `family_member_profile`, `family_member_portrait`);
  - `family_member_portrait_versions` and `family_members` after delete.
  Matching rows: bump epoch, set `blocked` + `stale`, `requeue_after = now()
  + 15 min` (debounces bursts of deletes into one re-render); the scheduler
  moves them to `queued`. Tag changes don't invalidate (they change
  selection, not removed content).
- **Families:** everything filters `families.deleted_at is null`.
- **Deletion fence:** `claim_family_deletion_fence` also waits for in-flight
  film attempts (fresh heartbeat), like portraits/illustrations.
- **AI ledger:** operations `year_film_quote`, `year_film_vision`,
  `year_film_audio` (constraint swap `not valid` + `validate`);
  `ai_call_id = uuid_v5(attemptId, checkKey)`; `usage_request_id` null;
  gpt-6-sol/luna rates in `ai-pricing.ts` (new pricing version); gpt-audio
  via `audio_seconds`, unpriced until confirmed.
- Regenerate types; TECH_SPEC §2 + §4.

## 6. Steps

### Step 1 — Migration + pgTAP
§5 in full. `supabase/tests/year_films.sql`: RLS + column grants (no
`film_script` for clients), surface gate, canary preview, anonymous; unique
key incl. forced rows; CAS (stale attempt / edits_version / epoch); publish
re-verification (deleted memory, removed asset key, reported illustration,
edited quote); cycle-end rules; edits RPC (role, billing, shape, caps,
removal → blocked); triggers: delete as `authenticated` succeeds, bulk family
deletion, delete during an attempt, `replace_memory_media_assets` with
unchanged assets = no invalidation and with a removed asset = invalidation,
quote text edit, reports (`open` and `reviewing`), portrait/member deletes,
`mode = off` no-op; `year_film_due` with fixed clocks (timezones, DST,
Feb 29, launch cutoff, 3-day catch-up, `>=` 00:30, under-13, own child,
billing, soft-deleted family, rollout, idempotency, forced rows ignored);
attempt spacing; skipped re-check; render-slot cap; deletion fence. Update
`client_table_grants.sql`, `onboarding_anonymous_lockdown.sql`.

### Step 2 — Shared pure modules (Deno tests)
- `_shared/year-film-assets.ts`: `uses()` / `stillKey()` mapping (incl.
  `pairKey`, alternates), thumbs/prepare manifest types, window choice after
  verdicts, `film.json` shaping; the eval script imports it; **golden test**
  with recorded verdicts + measurements (synthetic ids, in-repo fixtures).
- `_shared/year-film-context.ts`: bridge payload → builder inputs (family-wide
  reports, `pool_cutoff_at`, exclusions, sticky quotes/language).
- `_shared/year-film-checks.ts`: per-frame cache keys, batch split/merge.
- `_shared/year-film-beds.ts`: allow-list + default pick (slug = film id),
  parity-tested against `beds.json` **and** against `assemble.mjs`'s
  `pickBed` for the same slugs; the Worker stores the pick as
  `music_bed_id`, and `assemble.mjs` uses `film.json`'s bed when present.
- Builders gain `excludeMemoryIds` and a fixed quote input.

### Step 3 — Scheduler `schedule-year-films` (Edge Function, hourly)
Cron migration; `config.toml` `verify_jwt = false`. Per run:
1. `year_film_due(now)` (rollout, billing, not soft-deleted, `>=` 00:30
   owner-local, 3-day catch-up, `>= launch_date`; birthday via the SQL twin
   of `isFilmChild` at the birthday; monthly with a SQL pre-filter on
   `MONTHLY_MIN_POOL`; family Dec 12).
2. Move rows with passed `requeue_after` / `next_attempt_at` to `queued`;
   `claim_year_film_dispatch(limit)` → signed POST to `/dispatch`.
3. Recovery on stale heartbeat (supersede + re-dispatch, or end the cycle).
4. Cleanup (`year_films_needing_cleanup`): for rows with `cleanup_needed`,
   list `{ownerId}/year-films/{filmId}/` and delete every attempt directory
   except the published one; delete blocked leftovers.
5. Notifications at `surface_at` (route `year-film`, `notify_new_memories`,
   rollout) → `notified_at`; re-renders never re-notify.

### Step 4 — Bridge `workflow-year-film-bridge` (Edge Function, HMAC)
`config.toml` `verify_jwt = false`. Ops: `load_film_context` (incl. explicit
source keys), `save_curation`, `save_checks` (per batch), `record_usage`,
`heartbeat` (→ ok / epoch_changed / superseded / disabled),
`record_machine`, `set_status`, `claim_render_slot`, `publish`, `end_cycle`,
`reconcile`. HMAC + nonce ledger + raw-body verify; `attempt_id` validated
on every op; `mode = off` refuses work ops. Logs: ids/codes only.

### Step 5 — Worker `cloudflare/year-film-worker` (+ CI)
`/dispatch` (HMAC) → `YearFilmWorkflow` (instance id = attempt id). Rules:
step outputs are ids/metadata only; deadlines and iteration counters live in
step results (never `Date.now()` at run-body level); every step has explicit
`timeout` + `retries`; paid calls persist verdicts per batch.
1. **context:** load context, floors (else `end_cycle skipped`), candidate
   lists → returns ids/counts.
2. **thumbs:** machine (`thumbs`) for claim candidates → poll.
3. **quote:** quote pick (or sticky candidates) → `save_curation` partial.
4. **claims:** claim checks per batch → `save_checks` per batch, heartbeat
   between calls.
5. **build:** build script → `save_curation` (script, referenced ids/keys,
   hashes, bed, `curated_epoch`) → R2 `script.json`.
6. **prepare:** machine (`prepare`) → poll `status.json` **and** the machine
   state (`GET /machines/{id}`: destroyed without status = crash) with
   `step.sleep(30s)`, heartbeat each poll, deadline in step state (20 min —
   measured in the canary for a family year), destroy on timeout.
7. **checks:** frame + voice checks per batch (cached) → `film.json`.
8. **render slot:** `claim_render_slot`; `step.sleep(5 min)` retries, capped
   at 72 (6h) → `end_cycle render_queue_timeout` (retryable next attempt).
9. **render:** machine (`render`) → same polling (30 min deadline).
10. **publish:** CAS; loss → delete new objects; success → delete previous
    attempt's objects and `prep/`. Lost response → `reconcile`.
Any abort (epoch/superseded/disabled/failure) → destroy machine, mark
`cleanup_needed`, `end_cycle` with a closed `FailureCode`.

### Step 6 — Render image job modes (`render/year-film-renderer`)
- `package.json` + lockfile (`@aws-sdk/client-s3`); `src/job.mjs`
  (`thumbs|prepare|render`, hard `timeout`, reads `job.json`, writes
  `status.json` with conditional puts, no key/content logging); tests in CI.
- `film-renderer/assemble.mjs`: bed from `film.json`; emit `timeline.json`;
  the job derives `poster.jpg` (close scene) and `scenes.json` from it.
- Dockerfile: `npm ci`, `libheif-examples`, ENTRYPOINT = job runner;
  `bench.sh` kept (explicit cmd).
- `build.sh`: stage `supabase/functions/_shared/year-film-*.ts` + imports;
  **refuse a dirty tree**; tag = git sha. Node runs the TS with
  `--experimental-strip-types` (verified by the sample run in the image).
- Sample fixture gains an EXIF-rotated JPEG, a HEIC still, a rotated video
  and a posterless legacy video.
- Temp-credential scoping test (Decision 3).
- Deploy (owner-run): `./build.sh` → `fly auth docker` → `docker push
  registry.fly.io/momora-year-film-renderer:<sha>` → Worker env
  `FILM_RENDERER_IMAGE`.

### Step 7 — `get-year-film-url` (Edge Function, JWT)
Any member; `ready`, not `blocked`, `surface_at <= now` (owner/manager may
preview earlier); short-TTL presigned URLs for video/poster/scenes.

### Step 8 — Export, deletion, push
- Export worker: ready, non-blocked films' `film.mp4` + metadata
  (`plan.ts`, manifest, `docs/features/data-export.md`).
- Film outputs under `{ownerId}/year-films/{filmId}/{attemptId}/` →
  account deletion covered by the owner-prefix sweep; the extended deletion
  fence (§5) prevents late writes after the sweep.
- `delete-family-member`: delete the member's birthday films' prefixes
  before the cascade.
- `expo-push.ts` route `year-film` (`filmId`); P2 adds it to
  `useNotifications.ts` / `RECOGNIZED_PUSH_ROUTES`.

### Step 9 — Canary + operator tooling, docs
- `supabase/scripts/queue-year-film.ts` (service role via `--env-file`):
  `--forced` scope films (gate d; marked `forced`, deleted at canary end),
  `--requeue <filmId>`, `--parity <film-data dir>` (gate e).
- `eval-year-film-script.ts --from-film <id>`: storyboard of a production row.
- `docs/features/year-film.md`, TECH_SPEC §2/§4, `year-film.md` §10
  `### P1 results`.

### Step 10 — Tests
pgTAP (Step 1); Deno: shared modules + golden test, scheduler
(due/requeue/dispatch/recovery/cleanup/notify with fakes), bridge (HMAC,
replay, op validation, supersession, `mode = off`, CAS); Worker (vitest:
replay after partial batches doesn't repay; duplicate machine create →
lookup; machine crash without status → end cycle; timeout destroys machine;
render-slot cap timeout; epoch change aborts early; publish lost →
reconcile; CAS loss deletes new objects); render job (unit + container run
of the sample in all three modes).

## 7. Rollout

1. Migration (flag `off`) → deploy bridge, scheduler, `get-year-film-url`,
   `delete-family-member`, `hard-delete-expired-accounts` (fence), export
   worker.
2. Build + push the image; deploy the Worker with secrets.
3. Flag `canary` (Eduardo's family, `launch_date` = go-live); cron on.
4. Gate (e) parity → (d) forced family film → (a) next real birthday
   (Enzo's Year Four due Oct 26 if live; else a forced copy) → (b) edit →
   (c) deletions (ready and mid-render). Measure prepare/render time and
   disk for a family year.
5. Delete forced rows; record `### P1 results`.
Rollback: flag `off` — scheduling, dispatch and push stop, and the bridge
refuses in-flight work at the next op.

## 8. Risks & mitigations

- **Removed/edited/reported content ships or keeps serving** → epoch CAS,
  full publish re-verification, deferred media trigger, quote-hash check,
  `blocked` on removal edits and invalidations, blocked-object deletion.
- **Cost** → per-batch verdict persistence, one row per key, spaced attempts,
  debounced invalidation re-renders, early abort on epoch change, floors
  before paid calls, render-slot cap, fair-use caps.
- **Dec 12 spike / Fly capacity** → slots, region/size fallback, 3-day gap,
  a 10-render canary burst.
- **Machine lifecycle** (crash, hang, duplicate create) → machine-state
  polling, hard timeouts, deterministic names, destroy on abort.
- **Credentials** → per-machine, object-scoped temp creds, never persisted.
- **Delete paths** → triggers are fast no-ops by default, `lock_timeout`, no
  locks on `memories` in publish.
- **Linux media differences** → fixtures, container-vs-container parity,
  owner visual review.
- **PII** → ID-only step outputs, column grants, logs ids/codes only.

## 9. Out of scope

P2+: app surfaces, app push handling, analytics, `hideNames`, "Remake with
new moments", adult birthdays, per-viewer renders.

## 10. Open questions (owner)

1. ~~Per-viewer blocks~~ — **decided 2026-09-29: parent blocks count.** An
   account blocked by an owner/manager has its memories left out of every
   film of the family (curate-time filter, invalidation trigger on the new
   block, publish re-check). A viewer's block stays personal (their feed
   only): a film is one video for the whole family.
2. ~~gpt-audio-1.5 price~~ — **resolved 2026-09-29:** $32/$64 audio,
   $2.50/$10 text per 1M tokens (priced in `ai-pricing.ts`, ≈ $0.003 per
   voice check). gpt-audio-mini (≈ ⅓ the price) is an option only if an A/B
   on the dogfood sound excerpts shows it judges as well.

## 11. Review log

- **Round 1 (Sonnet, completeness & correctness).** Caught: publish raced
  invalidation → epoch CAS + curate-time stamping + publish re-verify;
  failed films respawned hourly / failed re-renders took down good films →
  one row per key + cycle-end rules; edits had no consumer → frozen-pool
  rebuild, builder inputs, bed allow-list, `hideNames` to P2; missing wiring
  (config.toml, CI, renderer package.json/entrypoint) and a wrong deploy
  command; check images for stills/references; lease vs runtime and racy
  machine counting → heartbeat, supersession, DB slots; R2 lifecycle can't
  wildcard; scheduler semantics; incomplete invalidation; invented parity
  threshold; orphans on member deletion; ledger idempotency; golden test;
  bucket-wide credentials.
- **Round 2 (Sonnet, failure modes).** Caught: media lives under uploaders'
  prefixes and one temp credential can't mix permissions → object-scoped
  read + attempt-scoped write, minted per machine; forced canary rows would
  steal the real Dec 12 key → `forced` rows outside the key; every media save
  deletes+reinserts rows → deferred trigger on truly removed keys, plus
  quote-text edits; machine lifecycle holes (entrypoint vs `init.cmd`,
  crash without status, no hard timeout, duplicate create, capacity);
  Workflow replay (deadlines in step state, split curate, per-batch
  persistence, step timeouts, `cpu_ms`, capped slot wait); removal edits
  kept serving after a failed re-render → `blocked`; claim checks can't
  resize in the Worker → `thumbs` machine; uncapped invalidation re-renders
  and no real kill switch → debounce, early abort, bridge refuses when off;
  orphaned attempt dirs and the deletion fence; sticky quotes/language;
  publish re-verify of all kinds and `reviewing` reports; permanent
  failed/skipped → spaced attempts, skipped re-check, alerts; RLS exposed
  `film_script` → column grants; no poster/scenes output yet.
- Rejected: none.
