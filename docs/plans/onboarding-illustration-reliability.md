# Plan: Onboarding illustration reliability

**Status:** planned (not yet implemented) — revised after adversarial reviews #1 and #2
**Date:** 2026-07-20

## Problem

During onboarding, a user creates the first family member (which fires portrait
generation in the background, ~30–90s) and is immediately prompted to capture
their first memory. That memory's illustration reliably fails with the
"Illustration failed" overlay. Two independent root causes, both converging on
the `NO_PORTRAITS` error in `supabase/functions/generate-illustration/index.ts`
(readyMembers empty → 400 → `finally` block sets `illustration_status =
'failed'`):

1. **No tags:** the client saves illustrated memories with zero tagged members.
   The server's name-mention fallback (`_shared/illustration-members.ts`) only
   helps if the text mentions a member's name/nickname. Otherwise:
   `memberIds = []` → `NO_PORTRAITS`.
2. **Portrait not ready (the onboarding-guaranteed case):** the portrait
   versions query filters `illustrated_profile_key IS NOT NULL` and
   `resolvePortraitVersionAtDate` requires `illustrated_profile_status ===
   'ready'`. A still-generating portrait is invisible → `NO_PORTRAITS`.
   Nothing waits, and nothing re-triggers the memory illustration when the
   portrait completes. The only recovery is the manual regenerate button on the
   memory detail screen.

## Key design decisions (agreed)

- **No new DB status value, no migration.** The existing
  `memories.illustration_status` check constraint allows `'pending'`. Deferral
  reuses `'pending'`; the client's shared poll
  (`src/hooks/useGenerationStatusPolling.ts`) already treats
  `pending`/`generating` as in-flight and renders the generating shimmer, so a
  deferred memory never shows the "failed" overlay.
- **Server-side retrigger** (not client-only): onboarding users background the
  app; the portrait function's background task is the durable place to resume
  from.
- **Client backstop is the EXISTING recovery mechanism, not a new one.**
  `src/utils/memories.ts` already has `needsIllustrationRecovery` /
  `isIllustrationPendingTooLong` (`pending` older than
  `ILLUSTRATION_GENERATION_STALE_MS` = 3 min), wired into `useMemories.ts`
  (list effect ~line 515 and detail effect ~line 699, gated by
  `canEditFamilyContent`), calling `retryMemoryIllustration`
  (`src/services/memories.ts:1230`). Once deferral parks memories at
  `pending`, this mechanism retries them. **Pacing caveat (review #2):** only
  the detail screen has a true timer (3s `refetchInterval`,
  `useMemories.ts:~681-695`); the list effect re-runs only when the `memories`
  array identity changes, and a parked `pending` row emits no realtime events
  while the shared poll idles under live realtime. So list-view recovery is
  event-driven, not clock-driven — the server-side retrigger (2b) plus the
  deferral self-retrigger (2a) are the primary paths, the client loop is a
  backstop. We must NOT build a parallel rescue in
  `useGenerationStatusPolling.ts`.
- **Deferral is key-aware (review #2).** The current `finally` in
  `generate-illustration` maps a failed run back to `'ready'` when the memory
  already has an illustration (`index.ts:596-598`). Deferral must preserve
  that: only a memory with **no** `illustration_key` parks at `'pending'`. A
  memory with a retained illustration (e.g. regenerate after retagging to a
  member whose portrait is still generating) keeps `'ready'` — the old
  illustration stays visible instead of an unbounded shimmer.
- **Defer only when `readyMembers.length === 0`.** Partial-ready multi-member
  memories keep today's behavior (generate with the subset). Waiting for *all*
  portraits is a possible follow-up, out of scope here.
- **Retrigger on portrait success, failure, AND claim-lost exit.** On success,
  deferred memories generate. On failure/claim-lost, re-invoking
  `generate-illustration` finds no fresh in-flight portrait and no ready
  portrait → `NO_PORTRAITS` → the memory resolves to `failed` (correct final
  state; no stuck shimmer).

---

## Workstream 1 — Auto-tag the sole family member (client only)

**Files:** `app/(app)/new-memory.tsx` (+ possibly a small helper in
`src/utils/auto-memory-tags.ts`), screen test in `src/screen-tests/`.

When the family has exactly one member, seed that member as tagged when the
new-memory screen mounts, so onboarding users can't save an untagged memory.

### Behavior

- Seed `selectedMemberIds = [soleMember.id]` via the existing
  `initializeTags()` from `useAutoMemoryTags` when ALL of:
  - the members query has resolved — `useFamilyMembers` exposes `isLoading`;
    gate on that, not on `members.length` alone — and exactly 1 member exists;
  - draft restore has finished (`isDraftRestoreReady`) and did NOT apply a
    draft with tags — **ordering matters**: the restore effect only applies a
    draft to an *empty* form (`formIsEmpty` check at
    `new-memory.tsx:167-173`). Seeding before restore resolves would make
    `selectedMemberIds` non-empty and silently discard the draft. Seed strictly
    after restore settles.
  - `selectedMemberIds` is still empty and the user hasn't untagged anything
    (suppressed list empty);
  - seeding has not already happened this mount (a `hasSeededRef`).
- **Voice results must not wipe the seed (review #1 blocker).**
  `applyVoiceResult` (`useAutoMemoryTags.ts:91-96`) *overwrites*
  `selectedMemberIds` with the voice pipeline's `mentionedMemberIds`, which
  has no sole-member fallback — a parent saying "she took her first steps
  today" (no name) would reset tags to `[]` and reintroduce the exact bug.
  Fix: in the `VoiceSpeakItModal` `onResult` handler in `new-memory.tsx`
  (line ~488), when `result.mentionedMemberIds` is empty and exactly one
  member exists, substitute `[soleMember.id]` before calling
  `applyVoiceResult`. (Do it at the call site, not inside the hook — the hook
  is also used elsewhere and shouldn't grow member-count policy.)
- The seeded tag is a normal tag: user can untag it (the toggle's suppression
  mechanic then prevents the mention-matcher from re-adding it; the seed
  effect must also not re-run thanks to `hasSeededRef`).
- **The untouched seed must not persist as a draft (review #2).**
  `isEmptyDraft` (`src/utils/new-memory-draft.ts:43-45`) treats a tags-only
  draft as non-empty, so mount-seed → back out would write a
  `{taggedMemberIds:[sole]}` draft. That stale draft later restores a
  member-1-only tag even after a second member is added, and it lets the
  "auto-selected on mount" test pass via draft-restore instead of the seed.
  Fix: the draft-save effect must treat the state as empty (clear, don't
  save) when content and media are empty and `selectedMemberIds` equals
  exactly the seeded value (track the seeded id in a ref).
- Applies to all memory types (tags matter for media memories too).
- Incoming-share prefill behaves as today; the one-shot seed happens
  independently (share prefill sets media/content, not tags).

### Tests

- Screen test (follow existing `src/screen-tests/` patterns): one member →
  chip auto-selected on mount; two members → nothing auto-selected; saved
  draft with different tags → draft wins, no double-tag; untagging the seeded
  member does not re-seed; **voice result with empty `mentionedMemberIds` and
  a sole member keeps the sole member tagged** (and with two members, keeps
  today's overwrite semantics); **seeding alone writes no draft** (mount with
  one member, unmount without typing → no stored draft).
- If seeding logic is extracted into a pure helper, unit-test it in
  `src/utils/auto-memory-tags.test.ts` style.

---

## Workstream 2 — Defer illustration until portraits are ready

### 2a. `generate-illustration`: defer instead of fail

**File:** `supabase/functions/generate-illustration/index.ts`, new shared
helper in `supabase/functions/_shared/` (e.g. `portrait-readiness.ts`),
existing test file `generate-illustration/index.test.ts`.

- Load portrait versions for the resolved `memberIds` **without** the
  `.not('illustrated_profile_key', 'is', null)` filter (that filter currently
  hides in-flight versions — the `family_member_portrait_versions_ready_shape`
  check constraint guarantees the key is NULL for any non-`ready` status).
  Keep `resolvePortraitVersionAtDate` unchanged — it already requires `ready`.
- New decision, only in the `readyMembers.length === 0` branch:
  - If at least one resolved member has a **fresh in-flight** portrait
    version (definition below) → this is a deferral: return a distinct error
    (`errorResponse('Character portraits are still generating', 409,
    'PORTRAITS_NOT_READY')`) via a `deferredForPortraits` flag consulted in
    `finally`:
    - memory has **no** `illustration_key` → reset `illustration_status` to
      `'pending'`, clear `illustration_generation_attempt_id`;
    - memory **has** a retained `illustration_key` → keep today's `'ready'`
      restore (key-aware decision above); still return `PORTRAITS_NOT_READY`
      so explicit-action call sites can message the user.
  - Otherwise → today's `NO_PORTRAITS` failure path, unchanged.
- **Fresh in-flight definition** (review #2 — prevents deferring forever
  behind a dead or deletion-claimed attempt). A portrait version counts as
  fresh in-flight only if ALL of:
  - `illustrated_profile_status IN ('pending','generating')`;
  - `deletion_token IS NULL` (a deletion-claimed keyless row will be removed,
    never completed — and the deletion-claim UPDATE bumps `updated_at`, so
    `updated_at` alone would misread it as fresh);
  - recency: for claimed rows (`generation_token IS NOT NULL`), use
    `generation_started_at` within the RPC's own 15-minute reclaim window
    (`claim_family_member_portrait_generation` reclaims after
    `generation_started_at < now() - interval '15 minutes'` — migration
    `20260715120000:251-252`); for unclaimed `pending` rows (creation →
    client fire-and-forget invoke can be lost, `useFamilyMembers.ts:31-43`),
    use a ~5-minute `created_at` grace.
  Select these columns in the (now unfiltered) portrait-versions query. Add a
  small `_shared` helper mirroring the `_shared/illustration-status.ts` style,
  unit-tested.
- **Post-reset self-retrigger (review #2 — closes the lost-retrigger race).**
  While this invocation holds the CAS claim, the memory reads
  `'generating'`, so a portrait completing in that window either misses it in
  the 2b candidate query (`illustration_status = 'pending'`) or gets 409
  `GENERATION_IN_PROGRESS` — and the portrait's background task then exits
  permanently. Fix: in the deferral path, *after* the `finally` reset lands
  (no-key case only), re-read the resolved members' portrait versions once;
  if any is now `ready` (or all went terminal), fire ONE self-retrigger —
  same HTTP invoke pattern as 2b, wrapped in `EdgeRuntime.waitUntil`,
  forwarding this request's own `Authorization` header — before/while
  returning the 409. Structure the code so the re-check runs after the status
  reset, not before.
- Note: the memory row was CAS'd to `'generating'` at start; deferral resets
  to `'pending'`. Concurrent/duplicate invocations remain safe under the
  existing CAS/attempt-id scheme (the optimistic start-UPDATE rejects the
  loser with 409 before any image-API call — verified).

### 2b. `generate-portrait-illustration`: retrigger dependent memories

**File:** `supabase/functions/generate-portrait-illustration/index.ts`.

In `completeGeneration()` (the `EdgeRuntime.waitUntil` background task),
retrigger at **all three** exit paths:

1. after the finish RPC succeeds (or reconciliation confirms commit);
2. after the failure RPC in the catch path;
3. the **claim-lost bare `return`** inside the finish-error reconciliation
   branch (index.ts:331-338) — this path bypasses both success and catch;
   treat it as failure-equivalent for retrigger purposes (review #1 finding).

Factor the retrigger into one local `async function
retriggerPendingIllustrations(): Promise<void>` called from those paths; it
must catch and log all errors, never throw (it must not affect portrait
commit/cleanup, which happens before it).

- Query candidate memories: `family_id = version.family_id`, `memory_type =
  'text_illustration'`, `illustration_status = 'pending'`, **`created_at <
  now() - interval '30 seconds'`** (review #2: excludes brand-new memories
  whose client pipeline is still inside emotion analysis — without this, the
  retrigger can win the CAS with `emotion` still null and silently produce a
  default-tender-palette illustration, or lose to the emotion write and waste
  a limit-3 slot; do NOT filter on `emotion IS NOT NULL` instead — a deferred
  memory whose emotion analysis failed legitimately has null emotion),
  ordered by `created_at desc`, **limit 3**. Family-wide on purpose (no tag
  join): it also covers untagged memories that rely on the name-mention
  fallback.
  - The limit bounds the waitUntil budget. Known tradeoff: with >3 deferred
    memories, older ones are starved of the server retrigger and fall back to
    the client recovery mechanism (bounded to paged-in memories; see WS2d) —
    acceptable, since >1 deferred memory is already outside the onboarding
    shape this fixes.
  - Race note: a *brand-new* memory sits at `'pending'` briefly before its own
    client pipeline flips it to `'generating'`. Double-invocation is safe: the
    server CAS returns `GENERATION_IN_PROGRESS`/`GENERATION_SUPERSEDED` to the
    loser.
- Invoke `generate-illustration` for each candidate **via HTTP**
  (`${SUPABASE_URL}/functions/v1/generate-illustration`, POST `{memoryId}`),
  forwarding the **original request's `Authorization` header** (plus
  `apikey`/`Content-Type` as the platform requires — match how the client SDK
  calls functions). `req` is in scope inside `completeGeneration`'s closure;
  the user JWT (~1h lifetime) comfortably covers the window; the portrait
  caller passed the same-family manager check that `generate-illustration`
  enforces. `SUPABASE_URL` is available via `Deno.env.get('SUPABASE_URL')`
  (already used by `_shared/supabase-admin.ts`).
  Run the (≤3) invocations in **parallel** with `Promise.allSettled` so total
  added background time is bounded by one illustration run (~150s), not the
  sum. Log per-memory failures.
  - Emotion/palette: deferred memories already ran `analyze-emotion` in the
    original client pipeline; `generate-illustration` falls back to
    `EMOTION_PALETTES[memory.emotion]`, so no `colorPalette` param is needed.

### 2c. Client service: treat deferral as non-failure

**File:** `src/services/memories.ts` (no `src/services/ai.ts` change needed —
`invokeEdgeFunction` already surfaces the server's `code` field, so
`PORTRAITS_NOT_READY` arrives as `error.code`).

- In `runMemoryIllustrationPipeline`, when `generateMemoryIllustration`
  returns `code === 'PORTRAITS_NOT_READY'`, return `null` (success-shaped —
  the memory is intentionally parked at `pending`) instead of warning and
  propagating an error. Silent is correct for the fire-and-forget create
  pipeline and the automatic recovery loop.
- **Explicit-action call sites are NOT silent (review #2).** The detail
  screen's regenerate/retry (`regenerateMemoryIllustration`,
  `src/services/memories.ts:~1280`, surfaced via the mutation in
  `useMemories.ts:~347-362` and the button in
  `app/(app)/memory/[id]/index.tsx`) must surface `PORTRAITS_NOT_READY`
  distinctly — a non-error notice (Alert/toast per existing screen patterns):
  "Character portraits are still generating — the illustration will finish
  automatically." Keep the mutation non-failing (no red error state); just
  don't let an explicit tap dissolve into silence.

### 2d. Client backstop: verify the EXISTING recovery loop, build nothing new

**Files:** none expected beyond tests; possibly a comment update in
`src/hooks/useMemories.ts`.

The existing mechanism (`needsIllustrationRecovery` →
`retryMemoryIllustration` → `runMemoryIllustrationPipeline`) already covers
deferred-`pending` memories once 2a+2c land. Implementer must verify, and
cover with tests, this interaction:

- A deferred memory (`pending`, `updated_at` > 3 min) gets retried when the
  recovery effect next evaluates it; if portraits are still not ready, the
  retry defers again benignly (2c), `updated_at` bumps, and the next attempt
  is ≥3 min later. **Pacing (review #2):** on the detail screen this is
  genuinely clock-driven (3s `refetchInterval`); on lists the effect re-runs
  only when the `memories` cache identity changes — do not describe or test
  it as a timer there.
- `retryMemoryIllustration` for a `pending` memory calls the full pipeline
  (including emotion re-analysis). That re-analysis is redundant for deferred
  memories — and note `analyze-emotion`'s cooldown is 5s in-memory per
  isolate, so it provides NO cross-cycle protection (review #2 corrected
  this): each recovery retry really does re-run a full emotion analysis and
  may rewrite `memory.emotion`. Accepted: portraits usually finish in
  30–90s, so typically ≤1 extra call, and the pipeline proceeds even when
  analysis fails. **Do not** restructure this in this change; note it as a
  possible follow-up optimization.
- **Type-toggle trap (review #2, test + doc only):** re-enabling illustration
  on a memory whose status is `'pending'` sets `shouldStartIllustration =
  false` (`src/services/memories.ts:~1136-1140`) on the assumption a pipeline
  is in flight. Deferral makes `'pending'` a parked state lasting minutes, so
  toggle-off/on during that window relies on the retrigger/recovery paths.
  Add one test documenting this behavior and a line in
  `docs/features/memories.md`; no code change.
- Known coverage bounds (already documented in the A7 comment at
  `useMemories.ts:510`): recovery only walks paged-in memories and only runs
  for users with edit rights. Acceptable for the backstop role.
- **Do NOT add a rescue to `useGenerationStatusPolling.ts`** — it would
  duplicate this mechanism, and that hook's `refetchInterval` is disabled
  while realtime is live, making it a worse home anyway.

### Tests (WS2)

- **Edge function tests**: note the existing `generate-illustration` tests
  inject external deps (`chatJson`, image/R2 ops) via
  `GenerateIllustrationDependencies`, but Supabase queries are exercised by
  mocking global `fetch` — the new deferral paths (portrait-version SELECT
  without the key filter, the `finally` UPDATE to `pending`) must be covered
  at the fetch-mock layer, not via DI.
  - tagged member, portrait in-flight & fresh, memory has no key → 409
    `PORTRAITS_NOT_READY`, memory reset to `pending`, attempt id cleared;
  - same but memory has a retained `illustration_key` → 409
    `PORTRAITS_NOT_READY`, memory restored to `ready` (key-aware);
  - tagged member, portrait in-flight but stale (old `generation_started_at`,
    or unclaimed `pending` past the `created_at` grace) → `NO_PORTRAITS`,
    memory `failed`;
  - portrait version with `deletion_token` set does NOT count as in-flight;
  - deferral path where the post-reset re-check finds a now-`ready` portrait
    → exactly one self-retrigger invocation fired;
  - no members resolvable → unchanged `NO_PORTRAITS` / `failed`;
  - portrait function: finish-success, catch-failure, AND claim-lost paths
    all trigger ≤3 pending-memory invocations with forwarded auth header;
    candidate query excludes memories younger than 30s; retrigger errors
    don't break portrait commit/cleanup.
- **Unit:** portrait-staleness helper; deferral-decision helper.
- **Client:** `runMemoryIllustrationPipeline` deferral short-circuit; the
  existing recovery loop retrying a deferred-`pending` memory (extend the
  existing `useMemories` recovery tests if present).
- Integration tests (`*.integration.test.ts`) require local Supabase/Docker —
  write them following existing patterns, but note they may not be runnable in
  this environment; unit + edge-function tests are the enforced gate.

---

## Workstream 3 — UX copy + docs (folded into WS2's PR where touching same files)

- `src/components/memory-card.tsx`: failed overlay copy → "Illustration failed
  — tap to retry" (tapping a card already opens the detail screen, which has
  the regenerate action). No new states: after WS2, `failed` only appears for
  genuine dead ends.
- Detail screen: the `PORTRAITS_NOT_READY` notice on explicit
  regenerate/retry (see 2c) — "Character portraits are still generating — the
  illustration will finish automatically."
- Docs, same PR as the code per repo convention:
  - `docs/features/memories.md`: illustration pipeline section — deferral
    semantics, `PORTRAITS_NOT_READY`, retrigger, the existing recovery loop's
    backstop role, and how future agents should extend it.
  - `docs/TECH_SPEC.md`: `generate-illustration` contract gains the 409
    `PORTRAITS_NOT_READY` response; `generate-portrait-illustration` gains the
    retrigger side effect.
  - `docs/features/family-profiles.md`: note the portrait-completion
    retrigger, if that doc describes the portrait pipeline.

---

## Explicitly out of scope

- New `illustration_status` values / migrations / type regen.
- Waiting for *all* tagged members' portraits in partial-ready situations.
- Push/queue infrastructure (pg_cron, queues) for retrigger durability beyond
  the waitUntil task + existing client recovery.
- Any change to the emotion-analysis flow (including the redundant re-analysis
  in the recovery path — follow-up only).
- Restructuring `useGenerationStatusPolling`.

## Sequencing & verification

1. **WS1** — independent, ships first. `npm test` + `tsc` (Node 20 via nvm).
2. **WS2a + 2c** — server defer + client non-failure handling (deployable
   alone: worst case memories park at `pending` until the retrigger lands, and
   the existing client recovery already retries them — but do not ship to prod
   without 2b in the same release).
3. **WS2b + 2d-verification + WS3** — retrigger, recovery-interaction tests,
   copy, docs.

Each step: `npm test`, `npx tsc --noEmit`, lint if configured; edge function
tests via the repo's existing deno test setup. No commits until changes are
verified on device (per project workflow).
