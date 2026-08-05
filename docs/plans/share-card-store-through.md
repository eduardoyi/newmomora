# Share Cards: Store-Through Cache Plan

**Status:** Implemented (W1 schema/coverage, W2 function store-through + warm mode, W3 client warm hooks + docs) — all gates (tsc, npm test, test:edge) green
**Date:** 2026-08-05
**Context:** docs/features/memory-sharing.md documents the diagnosis: per-attempt
compose success plateaus ~50-70% under Supabase edge resource policing (546
WORKER_RESOURCE_LIMIT); resvg (~850ms CPU at 1080px) is the irreducible floor; a
trivial function on the same project passes 15/15. Decision: absorb compose
failures server-side behind a stored-card cache; sharing reads become cheap and
reliable.

## Design

- **Store-through, not mass pre-render.** `compose-share-card` gains a cache:
  stored card exists + fresh → stream it (near-zero CPU; immune to policing).
  Miss → compose as today → on success `putObjectBytes` the PNG + record the key
  (service-role client for the write) → stream. Client behavior/contract
  unchanged (still PNG bytes; still one retry on 546 for the cold path).
- **Proactive warm:** new `warm: true` mode (compose+store only, 204 response,
  no streaming). Client fires-and-forgets it after memory create/edit and after
  the media queue posts — mirroring `notifyFamilyActivityFireAndForget`. Warm
  failures are invisible; the next share attempt or warm call retries.
- **Keys (never overwrite in place — cacheKey invariant):**
  `{ownerUserId}/memories/{memoryId}/share-card/{designVersion}-{generationId}.png`
  where ownerUserId = the memory's creator (matches existing prefix authz),
  designVersion = exported const bumped on any layout change, generationId =
  fresh uuid per compose. Per-ASSET cards for media memories (column on
  memory_media), per-MEMORY card for text/illustrated (column on memories).
- **Staleness:** DB trigger clears `share_card_key` on UPDATE of
  content/memory_date/emotion (memories) and on memory_media replacement (the
  replace RPC already rewrites rows; new rows start null). Function also treats
  a key whose designVersion ≠ current as a miss (and deletes the stale object
  best-effort after storing the new one).

## Workstreams (sequential)

**W1 — Schema + storage plumbing (the drill checklist, every box):**
- Migration: `memories.share_card_key text null`, `memory_media.share_card_key
  text null`; trigger(s) clearing on relevant updates. No client grants (only
  the service-role function writes these columns). Types (database.ts,
  generated style), TECH_SPEC schema section.
- `_shared/storage-keys.ts`: new share-card key pattern (+ tests). NOTE the
  asset-id char class already permits the `{designVersion}-{generationId}`
  name; add an explicit sub-pattern anyway so parseStorageKey classifies it.
- `_shared/family-access.ts` `resolveReferencedStorageKeys`: admit both new
  columns (needed so delete-storage-object can clean them).
- `hard-delete-expired-accounts`: `resolveReferencedKeys` + 
  `collectFamilyStorageKeys` admit both columns (live cards must never be
  orphan-swept; owner-deletion cleanup must include them).
- Client `deleteMemoryStorageKeys` + media-replacement cleanup paths include
  share_card_key(s). Edge tests for admission + sweep safety (the C2 lesson).

**W2 — Function store-through (+ warm mode):**
- Cache check via the single nested select (add share_card_key columns to
  SHARE_CARD_MEMORY_SELECT); designVersion validation; hit → `getObjectBytes` →
  stream with existing headers + `Server-Timing: cache;desc=hit`.
- Miss → existing compose → `putObjectBytes` + service-role column update
  (`.is('share_card_key', null)` NOT required — last-write-wins is fine, but
  delete the previously stored object if the column held a stale key) → stream.
- `warm` mode: same flow, ends after store with 204; rate-limit exempt-ish
  (separate, looser bucket — warms are system-initiated) but still authed +
  role-checked (a viewer with sharing disabled can still WARM? No: warms come
  from creators/editors post-create; keep the same 403 rules, harmless).
- Failure semantics unchanged for cold path. Store/column-update failures are
  non-fatal: log id-only, still stream the composed PNG (share succeeds even
  if caching fails).
- Deno tests: hit path, miss-then-store, stale-version miss + old-object
  delete, warm 204, store-failure still streams, column update payloads.
- Batched design tweak (Eduardo, 2026-08-05): wordmark on the card 20%
  smaller and at 80% opacity — subtler. This is a layout change: bump
  DESIGN_VERSION (which is exactly what the version-in-key machinery is for;
  stored cards regenerate lazily). Snapshot updates.

**W3 — Client warm hooks + docs:**
- `warmShareCardFireAndForget(memoryId)` in the share-card service; called
  after text/illustrated create success, after media queue post success (the
  queue's post-create step), and after memory edit. Never awaited on the save
  path; failures swallowed (mirror notifyFamilyActivityFireAndForget).
- For media memories warm the COVER asset only (position 0) — warming all 10
  carousel pages per post is wasteful; non-cover pages stay cold-path (rare
  shares, retry still exists).
- Jest tests for the hook call sites; docs: memory-sharing.md (architecture
  update, storage/deletion coverage, warm semantics), TECH_SPEC function
  contract, feature doc changelog.

## Verification

Gates per workstream (tsc, npm test, test:edge). Post-deploy: measurement
script extended or reused — expect warm-path shares ~100% success with
`total;dur` under ~500ms; cold path unchanged (~50-70% per attempt, retried,
then cached). Device: share the same memory twice — second share must be
near-instant; edit the memory → share → new card reflects the edit.

## Rollout

W1 migration push → deploy function → EAS update to production (client gained
warm hooks) → measure → commit/push (commits may be per-workstream).
