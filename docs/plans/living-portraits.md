# Living portraits (animated character portraits)

**Status:** in progress (2026-11-05) · **Owner decision:** build, backfill, ship via OTA

## Goal

Every ready character portrait gets a quiet "living portrait" loop, like the moving
portraits in Harry Potter: a soft breath, a slight head tilt, one blink, the smile
warming and settling. No hands, no waving. The still portrait is unchanged and stays
the reference for memory illustrations and every small avatar; the loop is an extra
layer derived from it.

Spike results (2026-11-05, `npm run eval:portrait -- --member-id <id> --sprite --grid 3x3`):
one `/v1/images/edits` call with the still as the ONLY reference image returns a
3×3 frame sheet at 1536×1536 (512px cells). 4/4 real portraits kept likeness,
outfit, style and a clean grid. ~10–13s, ~$0.072 per sheet (2073 output / 1291 input
tokens). Crossfaded playback looked bad (ghosted double heads) — **hard cuts only**:
frame 1 held 800ms, then 150ms per frame, looping forever.

## Product rules

- Loops **continuously** on: the member profile header (`app/(app)/family/[id]/index.tsx`),
  the onboarding reveal (`app/(onboarding)/reveal.tsx`), and the Family tab cast cards
  (`src/components/cast-card.tsx` via `FamilyProfilePortraitPhoto`). Nowhere else
  (no tag chips, card footers, pickers, lists).
- The still always renders first and stays underneath; the sheet overlays it only once
  loaded. Reduce Motion on → no overlay (still only). App backgrounded → animation paused.
- Never shown when the portrait itself is hidden by content safety (overlay only exists
  where the still renders).
- Only shown when the sheet was made from the **currently published** still
  (`motion_source_key === illustrated_profile_key`). A regenerated still hides the
  old loop until a new one is published.
- Generation is automatic and silent: a still publishing `ready` starts motion. Failure
  never surfaces an error; the person keeps the still.
- One automatic retry: up to 2 generation attempts per claim (retry on a retryable
  provider error or a failed QA check; moderation/non-retryable → fail immediately).
- QA check before publishing: a gpt-4o-mini vision call (~$0.001) confirms all 9
  panels show the same person as the still, equal panels, no text/borders/labels,
  stable framing. Fail → retry (counts toward the 2 attempts).
- Cost is telemetry only, **not capped** (does not consume a family's portrait/illustration
  fair-use pools) — same pattern as the Holiday Card judge operations.

## Contracts (all implementers code against these exactly)

### DB — migration `supabase/migrations/20261105150000_portrait_motion.sql`

New columns on `public.family_member_portrait_versions` (all nullable unless noted):

| Column | Type | Meaning |
|---|---|---|
| `motion_status` | text check in (`pending`,`ready`,`failed`) | null = never attempted |
| `motion_key` | text | published sheet object key (CHARACTER_PORTRAITS / R2) |
| `motion_source_key` | text | `illustrated_profile_key` the current claim / published sheet derives from |
| `motion_token` | uuid | current claim token (CAS fence) |
| `motion_attempts` | smallint not null default 0 | claims made (diagnostic) |
| `motion_columns` | smallint check 1..4 | grid columns of `motion_key` |
| `motion_rows` | smallint check 1..4 | grid rows of `motion_key` |
| `motion_started_at` | timestamptz | claim time (stale after 15 min) |
| `motion_updated_at` | timestamptz | last motion state change |

Shape check: `(motion_status = 'ready') = (motion_key is not null)`; ready ⇒ columns/rows not null.
Clients must not be able to write motion columns: add a BEFORE UPDATE guard like
`protect_ai_usage_portrait_columns` (raise 42501 when `current_user`/`auth.role()` is
anon/authenticated and any motion_* column changes). Table already has table-level
`grant select ... to authenticated` and is in `supabase_realtime` (20261105120000).

Object key (built in SQL, `.webp`):
`<owner>/family/<member_id>/portraits/<version_id>/motion/<motion_token>.webp` where
`<owner>` is the first path segment of the version's `profile_picture_key`.

RPCs (security definer, `set search_path = public`, execute granted to `service_role` only,
revoked from public/anon/authenticated):

1. `claim_portrait_motion(p_version_id uuid, p_force boolean default false)` returns
   `table(outcome text, motion_token uuid, source_key text, output_key text, stale_motion_key text)`.
   Locks the row. outcome:
   - `not_eligible` unless status `ready`, `illustrated_profile_key` not null, `deletion_token`
     null, member/family not in deletion (mirror the fences in `claim_family_member_portrait_deletion`).
   - `already_ready` if `motion_status='ready'` and `motion_source_key = illustrated_profile_key` (unless p_force).
   - `in_flight` if `motion_status='pending'` and source matches and `motion_started_at > now() - 15 min`.
   - `already_failed` if `motion_status='failed'` and source matches (unless p_force).
   - else `claimed`: new token, `motion_status='pending'`, `motion_source_key = illustrated_profile_key`,
     `motion_started_at = now()`, `motion_attempts + 1`. If an existing `motion_key` was made from a
     different source, null it (and columns/rows) and return it as `stale_motion_key` so the caller
     deletes the object.
2. `publish_portrait_motion(p_version_id uuid, p_motion_token uuid, p_output_key text, p_columns smallint, p_rows smallint)`
   returns `table(published boolean, old_motion_key text)`. CAS: token matches, status `pending`,
   `illustrated_profile_key = motion_source_key`, `deletion_token` null, output key equals the
   deterministic key for that token. On success: `ready`, set key/columns/rows, return the previous
   `motion_key` (if any, ≠ output). Otherwise `published=false` (caller deletes its output).
3. `fail_portrait_motion(p_version_id uuid, p_motion_token uuid, p_error_code text)` returns boolean:
   if token matches and status `pending` → `failed`, `motion_updated_at=now()`; keeps nothing else.

Usage ledger: add telemetry-only operations `portrait_motion` (image) and `portrait_motion_check`
(vision) to whatever check/allowlist governs `operation` (follow how `holiday_card_front_judge`
was added in `20261006120000_holiday_cards.sql`) and make sure cap/quota computations ignore them.

### Supabase bridge — `supabase/functions/workflow-portrait-bridge/index.ts`

Same HMAC + nonce handling as today; `body.jobId` stays a required UUID. New operations:

| operation | request (besides `operation`, `jobId`) | response |
|---|---|---|
| `motion_start` | `jobId` = portrait **job** id | `{ started: true, versionId, motionToken }` or `{ started: false, outcome }`. Resolves `portrait_generation_jobs.portrait_version_id`, calls `claim_portrait_motion(version, false)`; deletes `stale_motion_key` from R2 (best-effort) when returned. |
| `motion_get_input` | `jobId` = version id, `motionToken` | `{ sourceKey, outputKey, prompt, checkPrompt, columns: 3, rows: 3, size: '1536x1536', model: 'gpt-image-2.6-flare', quality: 'medium', complexity: 'medium' }`; 409 `MOTION_SUPERSEDED` if the token is not the current pending claim. |
| `motion_record_usage` | `jobId` = version id, `motionToken`, `aiCallId` (`motion:<token>:<attempt>` or `motion-check:<token>:<attempt>`), `aiOperation`: `'image'|'check'` (not `operation`, which is the bridge operation; falls back to the aiCallId prefix), `model`, `success`, `usage`, pricing fields as `record_usage` | `{ recorded: true }` — writes via `record_ai_usage_event_detailed` with the version's family and `user_id` as actor, operation `portrait_motion` / `portrait_motion_check`. |
| `motion_publish` | `jobId` = version id, `motionToken`, `outputKey`, `columns`, `rows` | `{ published, oldMotionKey }` |
| `motion_fail` | `jobId` = version id, `motionToken`, `errorCode` (≤100 chars) | `{ failed }` |

Prompts live server-side in `supabase/functions/_shared/prompts.ts`:
`buildPortraitMotionPrompt(columns, rows)` (port of `livingSpritePrompt` in
`supabase/scripts/eval-portrait.ts`, verbatim wording) and `PORTRAIT_MOTION_CHECK_PROMPT`
(asks for JSON `{"same_person": bool, "equal_panels": bool, "no_text_or_borders": bool, "stable_framing": bool}`
given image 1 = reference still, image 2 = the sheet; no PII, no names).

### Worker — `cloudflare/memory-illustration-worker`

- New `src/portrait-motion-workflow.ts` `PortraitMotionWorkflow` (payload `{ versionId, motionToken }`),
  binding `PORTRAIT_MOTION_WORKFLOW`, class exported + Sentry-instrumented in `src/index.ts`, added to
  BOTH workflow lists in `wrangler.jsonc`; regenerate `worker-configuration.d.ts` the way the repo does.
- New route `POST /dispatch/portrait-motion` signed with `PORTRAIT_DISPATCH_SIGNING_SECRET` (same
  verification as `/dispatch/portrait`), instance id `motion-<motionToken>`, duplicate = idempotent 202.
- Steps: `generate motion sheet` (retries 0, timeout 6 min, `sensitive: 'output'`): bridge
  `motion_get_input` → load still bytes from `CHARACTER_PORTRAITS` → up to 2 attempts of
  [`/v1/images/edits` with only the still, given size/quality/complexity, `output_format=png`;
  record usage best-effort; QA vision call (gpt-4o-mini, still + sheet downscaled to ≤768px via
  the IMAGES binding) record usage best-effort] → convert the passing sheet to WebP (IMAGES binding,
  quality 85) → `CHARACTER_PORTRAITS.put(outputKey)`. Then `publish motion` (bridge retries): if
  `published=false` delete output; if `oldMotionKey` delete it. Any failure → `motion_fail` + delete
  output if uploaded. Never throws past the workflow in a way that retries a paid call.
- `PortraitGenerationWorkflow`: after a successful `ready` publication (end of `run`, after
  `retriggerDependentMemories`), best-effort step `start portrait motion`: bridge `motion_start` →
  if started, `this.env.PORTRAIT_MOTION_WORKFLOW.create({ id: 'motion-' + token, params })`
  (duplicate-tolerant). Wrapped in try/catch; never changes the returned status.

### Backfill

- Edge Function `supabase/functions/portrait-motion-backfill/index.ts` (`verify_jwt = false` in
  `supabase/config.toml`; auth = `x-cron-secret` via `_shared/cron.ts` OR
  `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>` exact match). Body `{ limit?: 1..25 (default 10), dryRun?: boolean }`.
  Picks each member's **current** portrait version (mirror `src/utils/portrait-versions.ts`'s
  resolver for today: ready, not deleting, latest `reference_date` ≤ today, then newest), keeps those
  with no ready motion for their current still and not `already_failed`/`in_flight`, claims each, and
  dispatches `{ versionId, motionToken }` to the worker URL derived from `CLOUDFLARE_PORTRAIT_WORKFLOW_URL`
  (replace path `/dispatch/portrait` → `/dispatch/portrait-motion`) signed with
  `CLOUDFLARE_PORTRAIT_DISPATCH_SECRET` (same HMAC as `dispatchPortraitWorkflow`). Returns
  `{ eligible, claimed, dispatched, failed }` counts only (no names/keys).
- Script `supabase/scripts/backfill-portrait-motion.ts` (`npm run backfill:portrait-motion -- [--dry-run] [--batch 10] [--pause 45]`):
  loops calling the function until `eligible = 0`, pausing between batches, then prints totals.

### Deletion and URL coverage

Add `motion_key` wherever portrait version object keys are collected or authorized:
`_shared/family-access.ts` (`resolveReferencedStorageKeys`) + the storage key parser in
`_shared/storage-keys.ts` (recognize `/portraits/<version>/motion/<token>.webp` as a portrait-version kind),
`delete-portrait-version`, `delete-family-member`, `hard-delete-expired-accounts` (collect + referenced checks).

### App

- `FamilyMemberPortraitVersion` gains optional `motion_status`, `motion_key`, `motion_source_key`,
  `motion_columns`, `motion_rows` (optional: persisted caches predate them; read defensively).
- `src/utils/portrait-motion.ts` `getPortraitMotion(version)` → `{ key, columns, rows } | null` per the rule above.
- `src/components/living-portrait-overlay.tsx`: absolute-fill overlay over an existing still. Signs
  `motion.key` with `useMediaUrl`, renders an expo-image of size `columns*width × rows*height` inside an
  `overflow: hidden` box, hidden until `onLoad`; Reanimated drives discrete frame steps on the UI thread
  (frame 0 for 800ms, then 150ms per frame, repeat forever, no interpolation between frames).
  Reduce Motion → renders null. Pauses on AppState background.
- Wire into the three surfaces only. `FamilyProfilePortraitPhoto` gets an opt-in `animated` prop
  (overlay only when it is showing the ready illustrated portrait, not the local photo/generating state);
  the Family tab's `CastCard` passes it.
- `usePortraitVersionsRealtime`: a `motion_status` change to `ready` (or a `motion_key` change) must
  trigger the same refetch as a terminal still transition.

## Rollout

1. Migration → regenerate types.
2. Deploy `workflow-portrait-bridge`, `get-media-url`, `delete-portrait-version`, `delete-family-member`,
   `hard-delete-expired-accounts`, `portrait-motion-backfill` (`--use-api`).
3. Worker `npm run deploy:dry-run` then `npx wrangler deploy --env=""`.
4. Verify one live portrait end to end, then backfill in batches.
5. Commit, push, OTA (1.5.1 + 1.5.0).

## Tests

Deno (bridge ops, backfill function auth/selection, storage key parser, deletion collectors), worker
vitest (motion workflow: QA retry, non-retryable stop, superseded publish deletes output, live trigger
best-effort), pgTAP for the three RPCs (cannot run locally without Docker — write it anyway), jest
(`getPortraitMotion`, overlay frame math / reduce motion / still-first, the three surfaces).
