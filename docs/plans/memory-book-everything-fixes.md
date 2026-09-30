# Memory Book — Everything-scope incident fixes

Status: **Phase 0 DONE — deployed + live-verified 2026-10-01** (Phases 1–3 next) · Owner: Eduardo · Opened 2026-09-30
Related: [memory-book.md](memory-book.md) (§4 scope table, §10.3 open
question now RESOLVED below), [../features/memory-book-generation.md](../features/memory-book-generation.md).

## 1. Incident summary

The owner's first `everything`-scope book (Enzo, 2022-10 → 2026-09, 776
in-window memories, book `e235d685`, since deleted) rendered with:

- a blank "minimal" cover (zero cover/hero candidates);
- ~85 photo/video memories printed as caption-only pages (media missing);
- memories tagged only to other family members (e.g. Adriana) included;
- no Firsts section and no birthday titles;
- 2022–2024 entirely absent (book starts January 2025);
- section headers at the physical top edge with the eyebrow clipped;
- "Cómo cambiaste en doce meses" portrait title over a 4-year span,
  17 portraits across ~6 pages;
- merged "enero–junio 2025" sections, English cross-year labels.

`book_document` counts proved the root cause: `taggedToChild: 0`,
`imageCount: 0`, zero memories with assets / tags / milestones /
engagement, versus the same pipeline's 2026 calendar book (83 with
assets, 110 tagged, 7 milestones, 85 with engagement).

### Root cause (data)

`supabase/functions/workflow-memory-book-bridge/index.ts`
(`load_generation_context`) passes **every** in-window memory id to five
PostgREST GETs via `.in('memory_id', memoryIds)` (media, tags,
milestones, likes, comments). 776 UUIDs ≈ 29 KB of query string, beyond
the gateway's URL limit; the error is never checked (`media =
mediaResult.data ?? []`), so every sub-query silently returned `[]`.
Downstream: no photos → photo-only memories unprintable, captioned ones
become text pages; no tags → every memory treated as untagged-eligible;
no engagement → trim ties broken by date order, earliest cut first.

Also latent in the same function: the main `memories` query and the
sub-queries are unpaged against `max_rows = 1000`, and `familyMembers` /
`portraitVersions` / `family` errors are unchecked.

**This is not Everything-specific**: any scope with roughly 400+
in-window memories hits the URL limit. Current year books (~150–300)
sit under it.

### Root causes (layout)

- `book-renderer/src/templates/TextPage.tsx:31` renders `<SectionHeader>`
  (absolute, top:0/left:0) without the `SafeArea` wrapper every other
  header-capable template uses → header at the bleed origin, eyebrow
  trimmed. Hits any book whose section opens on a text page.
- `cloudflare/memory-book-worker/src/backbone.ts` merges months until a
  section has ≥3 printable memories, with no span cap.
- `book-renderer/src/templates/common/formatDate.ts` `localizeMonthLabel`
  doesn't match cross-year ranges → English labels in es books.
- `book-renderer/src/templates/furniture.ts` hard-codes single-year
  strings (portrait title/kicker, closing headline).
- No time-proportional page allocation; eval-only spread pacing never
  ported to the worker; trim tie-break is date order.

## 2. Immediate mitigations (DONE 2026-09-30)

- Server kill switch: `generate-memory-book` `PAUSED_SCOPE_KINDS =
  {'everything'}` → row parked `failed`/`SCOPE_PAUSED`, 409. Deployed,
  commit d0b2190. Ready books unaffected.
- Owner cleanup: deleted `687bb3d1` (old Enzo Y1 + 18 draft/cancelled
  orders), `582e57ab` (Enzo 2026 + cancelled canary order), `e235d685`.

## 3. Owner decisions (2026-10-01, all defaults accepted)

| # | Decision |
|---|---|
| D1 | Everything = **one volume**, hard cap 122pp, more selective; page budget split across the child's age-years **proportional to eligible-memory count** (with a small per-year floor). Resolves memory-book.md §10.3 (no multi-volume). |
| D2 | Everything window starts at `max(child DOB, first eligible memory)`, not the family's earliest memory. |
| D3 | Everything books are organised as **one chapter per age-year** ("Tu primer año" / "Year One"…); backbone sections inside a chapter span **at most one quarter** (3 months). |
| D4 | Portrait spread samples ~1 portrait per 6 months, **max 2 spreads (6 portraits)**; title/kicker derived from scope (single-year keeps "doce meses"). |
| D5 | Firsts section capped for Everything (target ≤ 1 spread's worth; keep the highest-confidence / earliest-per-milestone entries). |
| D6 | Closing headline scope-aware ("Hasta el año que viene" only for year scopes). |

## 4. Phases

### Phase 0 — generation context integrity (ALL books; ship first)

Goal: every Memory Book read path loads complete data for any window size,
and any load failure fails the book loudly instead of printing it.

Note on the threshold: the real gateway URL limit is unmeasured. The
year-film bridge proves 200-id chunks work in production; a ~250-memory
year book may already be close. Treat every unbounded `.in(ids)` as a bug.

0.1 **Shared paging/chunking helpers.** *[IMPLEMENTED — code-complete, not yet deployed]* Extract `fetchAll` (1000-row pages)
    and `byMemoryIds` (id chunks + per-chunk paging) from
    `supabase/functions/workflow-year-film-bridge/index.ts` into
    `supabase/functions/_shared/paged-query.ts`; the film bridge imports
    them (pure refactor, its tests stay green). Chunk size is a parameter:
    the film bridge keeps 200, Memory Book uses 150. `fetchAll` also
    dedupes by a caller-supplied key (offset paging under concurrent
    inserts can repeat a row across a page boundary).
    Every paged query needs a **stable, existing** sort key:
    memories `memory_date, id`; memory_media `id`; memory_family_members
    `memory_id, family_member_id`; memory_milestones `id`; memory_likes
    `memory_id, user_id` (composite PK, no `id` column); memory_comments
    `id`. Helper errors throw (never `?? []`).
0.2 **Bridge `load_generation_context`** *[IMPLEMENTED — code-complete, not yet deployed]* (`workflow-memory-book-bridge`):
    - main `memories` query paged via `fetchAll`;
    - media / tags / milestones / likes / comments via `byMemoryIds`,
      sequential chunks (no fan-out; ~6 chunks × 5 tables for 800
      memories is fine inside the raised step timeout, see 0.5);
    - **error classes** (every 5xx is retried 3× in-call × 4 step
      attempts by the worker, `bridge.ts:54-80` + `BRIDGE_STEP_RETRIES`,
      so deterministic failures must NOT be 5xx): a real PostgREST/network
      error → retryable 500 `context_load_failed`; a deterministic
      data-invalid condition (null child, reconciliation mismatch after
      the one in-bridge retry below) → non-retryable 422
      `context_invalid` (the worker's non-retryable BridgeError path →
      NonRetryableError → `CONTEXT_LOAD_FAILED`, no retry storm, no lease
      overrun of `MEMORY_BOOK_LEASE_MS`);
    - **every** query checks its error: child lookup, family, familyMembers,
      portraitVersions, language-evidence sample, and the `everything`
      earliest/latest queries (today an error there becomes the
      EMPTY_WINDOW_SENTINEL → misleading `NO_ELIGIBLE_MEMORIES`);
    - `child` null for an `age_year` book (or any book with `child_id`)
      → 422 `context_invalid`, never "every memory eligible".
0.3 **Count reconciliation tripwire (bridge side).** *[IMPLEMENTED — code-complete, not yet deployed]* BEFORE the loads,
    take head-only exact counts that don't depend on an id list, for the
    same resolved window: `memories` (family + window), `memory_media` /
    `memory_family_members` / `memory_milestones` via a `memories!inner`
    embed filtered on family + window (milestones with the same
    `status <> 'dismissed'` filter as the load). After loading, fail only
    when **loaded < expected-before** (concurrent inserts between count and
    load can only raise the loaded side; deletions in that gap are rare —
    on a shortfall, re-count + reload once in-bridge, then 422
    `context_invalid`). Replaces the earlier "zero tags" heuristic, which
    false-positives on families that don't tag (untagged memories are
    first-class, `eligibility.ts:34-38`). Implementer traps:
    `memory_family_members` has no `id` column (select `memory_id`);
    verify the `memories!inner` embed resolves to a single FK (PGRST201).
    Counts only in logs, never content.
0.4 **Other unbounded `.in()` sites.** *[IMPLEMENTED — code-complete, not yet deployed]*
    - Bridge `handleEnsureShareTokens` (`.in('memory_id', memoryIds)`
      over every referenced media/audio memory): chunk + page via
      `byMemoryIds`; bulk insert unchanged (duplicate active tokens are
      prevented by the unique active index — a retried step must treat
      that conflict as success, verify it does). *Finding: it did NOT
      (a 23505 returned 500). Now a read → insert-missing loop of up to 3
      passes re-reads on 23505; duplicate input ids are deduped.*
    - `memory-book-edits` `picker_pool` (`memberMemoryIds` = the child's
      tags across ALL time — the lookup is itself unpaged against
      `max_rows`, then passed straight to `.in()`; breaks for Enzo today):
      replace both with a nested inner embed filter, e.g.
      `memories!inner(memory_date, family_id,
      memory_family_members!inner(family_member_id))` filtered on the
      nested column, keeping the existing global order/cursor semantics
      (NOT chunk+merge — that breaks ordering and the offset cursor;
      mind the PostgREST embed-ordering gotcha in
      memory-book-generation.md).
    - `memory-book-edits` `resolveScopeWindow`: check errors on the
      everything earliest/latest queries.
    - Sweep: `rg "\.in\('memory_id'" supabase/functions` and list any other
      Memory-Book path with an unbounded id list in the implementation
      report (fix if Memory-Book-owned; flag otherwise).
0.5 **Worker** *[IMPLEMENTED — code-complete, not yet deployed]* (`cloudflare/memory-book-worker/src/workflow.ts`):
    - load step timeout 30s → 120s; the "build manifest and publish" step
      (now chunked ensureShareTokens + large publish) 30s → 120s too;
    - size guard **inside** the load step callback, before returning
      (a result over the ~1 MiB step-output cap fails inside the runtime
      before post-step code runs): `new TextEncoder().encode(
      JSON.stringify(ctx)).length` (UTF-8 bytes); log the number only;
      above 900 KB throw `NonRetryableError('CONTEXT_TOO_LARGE: …')` →
      new FailureCode `CONTEXT_TOO_LARGE`. If the Everything run in 0.8
      lands > 600 KB, slim the payload (`topic_details` is carried on
      `MemoryFeature` but unused downstream — verify, then drop it from
      the bridge select);
    - robust `errorCode`: set `this.name` in every custom error class
      constructor (today all are `name === 'Error'`), map on `name` and a
      `CODE:` message prefix in addition to `instanceof`, and map the
      runtime's step-timeout error explicitly (today → UNKNOWN_ERROR).
      Tests use plain `Error` objects with the right name/message.
0.6 **Tests.** *[IMPLEMENTED — code-complete, not yet deployed]*
    - Extend the bridge test stub (`workflow-memory-book-bridge/
      index.test.ts` `createStubClient`): `.range(from,to)` slicing,
      recording each `.in()` argument length, per-table `{error}`
      injection, head-count responses. Then: >1000 memories paged; every
      `.in()` ≤150 ids; each errored query → 500 (never empty success);
      persistent count shortfall → 422 (after exactly one reload);
      age_year with null child → 422; existing tests updated and green;
      deterministic failures return 422 (not 500).
    - `_shared/paged-query.ts` unit tests; film bridge tests unchanged.
    - memory-book-edits picker_pool with >150 member memories (the
      stub is filter-blind — assert the query shape/embeds it receives).
    - Worker: size guard, errorCode mapping by name.
0.7 **Owner-only pause bypass.** *[IMPLEMENTED — code-complete, not yet deployed]* `generate-memory-book` reads
    `MEMORY_BOOK_PAUSED_SCOPE_FAMILY_ALLOWLIST` (comma-separated family
    ids; unset/empty = nobody) and skips the pause for those families.
    Tests: allowlisted family dispatches; others still 409; malformed
    value = nobody.
0.8 **Deploy + verify live (owner-authorised, self-cleaning).** *[DONE 2026-10-01]*
    Result: deployed bridge + memory-book-edits + generate-memory-book,
    allowlist secret set (owner family), worker version 98b8b073
    (year-film bridge NOT redeployed — behaviour-identical refactor,
    deferred to its next deploy to avoid touching Year Film on launch day).
    Everything throwaway vs ground truth: eligible 601/601, 175 other-member
    memories excluded, 490 memories with assets (ground truth 492 counts any
    media incl. audio; 0 media-type memories without assets), 12 with
    milestones, 96 with engagement, 3 cover candidates + cover key, selected
    memories span 2022–2026 (45/138/110/187/121 = ground truth). Year Two:
    103/103 with assets + tags. picker_pool memberId=Enzo 597/597 items,
    unfiltered 758/758, 0 dupes, 0 out-of-order. Cleanup: 188 verification
    share tokens revoked (active back to 339), both books deleted. Context
    byte size not captured (worker logs not retained) — Everything run
    passed the 900 KB guard, so slimming stays optional.
    a. Deploy order: `supabase functions deploy
       workflow-memory-book-bridge` (response shape unchanged → safe with
       the old worker), `memory-book-edits`, `generate-memory-book`;
       `supabase secrets set MEMORY_BOOK_PAUSED_SCOPE_FAMILY_ALLOWLIST=
       e6b0c7a2-f403-4c84-94f5-720bf94073ee`; then the worker
       (`wrangler deploy --env=""` in cloudflare/memory-book-worker).
       Film bridge redeploys too (helper refactor) — re-run its tests
       first.
    b. Ground truth (read-only, counts only) for the owner family.
    c. Generate a throwaway **Enzo Year Two** book (age_year; no book
       exists for that scope) and a throwaway **Enzo Everything** book
       (allowlist). Compare manifest/outline counts (memories with
       assets / tags / milestones / engagement, cover candidates, year
       spread of selected memories) with ground truth; record the context
       byte size log. Everything layout is still wrong (Phase 2) — only
       data completeness is judged.
    d. Live `picker_pool` call with `memberId` = Enzo against one of the
       throwaway books (proves the new embed; the stub can't).
    e. Cleanup: snapshot the family's active `media_share_tokens` ids
       BEFORE step c; afterwards revoke (set `revoked_at`) every token
       created by the verification runs, then delete both throwaway book
       rows. (Deleting a book does not revoke its tokens; they are live
       public viewer links.)
    f. Limitations, stated: Enzo's ~776 memories are under 1000, so
       main-query paging is proven by unit tests only; the Year Two book
       is likely under the URL limit anyway — it's a ground-truth
       regression check, the Everything run is the discriminating one.
    g. Rollback: the new bridge adds failure modes to EVERY book
       (422/500 on shortfall). If year-book generations start failing
       after deploy, redeploy the previous bridge from `git show
       HEAD~:…` (response shape unchanged, old worker compatible) and
       investigate; the worker change is independently revertible.
0.9 **Docs, same change.** *[IMPLEMENTED — code-complete, not yet deployed]* memory-book-generation.md (bridge paging/
    chunking + count reconciliation, new failure codes, allowlist env,
    changelog row); TECH_SPEC bridge error semantics + new env var;
    update the `PAUSED_SCOPE_KINDS` comment to mention the allowlist.

### Phase 1 — layout fixes for all books

Status 2026-10-01: 1.1, 1.2, 1.3, 1.4-tooling code-complete (not deployed; 1.4's
decision — whether to design pooling — still waits on Phase 0 regenerated data).

1.1 [DONE] `TextPage.tsx`: wrap `<SectionHeader>` in `<SafeArea isSpread={false}>`
    like FlexGrid/AnchorMedia. Parity rule: preview (memory-book-web) and
    the Fly print worker redeploy together. Verify with page.pdf rasters
    (not DOM) per the print-verification principle.
1.2 [DONE — tool: `book-renderer/scripts/audit-layout.mts`; 0 section headers on text pages in all 3 books] Audit the three remaining books (Enzo Y1, Mara Y1, Enzo Y3) for
    sections opening on a text page → tells us whether any printed copy
    is affected.
1.3 [DONE] `localizeMonthLabel`: handle cross-year ranges ("December 2025 –
    January 2026" → "diciembre 2025 – enero 2026").
1.4 [TOOL DONE — audit reports lone-short-caption pages; 0 in all 3 existing books; re-run on a regenerated dense book] After Phase 0 data is correct, measure how many lone-short-caption
    pages remain in a regenerated dense book before designing any
    pooling change (don't design against the corrupted sample).

### Phase 2 — multi-year rules (Everything only; D1–D6)

2.1 D2 window start (bridge `everything` branch: DOB-aware; the
    `memory-book-edits` `resolveScopeWindow` duplicate must agree — share
    one helper). "First eligible memory" needs the child's tags BEFORE the
    window exists: resolve it with its own query (earliest memory tagged
    to the child OR untagged, via an inner/left embed on
    `memory_family_members`), and the 0.3 reconciliation must use the
    same resolved window.
2.2 D3 chapters + quarter-capped backbone merge (`backbone.ts`), chapter
    divider template/furniture (es/en), age-year boundaries from DOB.
2.3 D1 proportional per-age-year budget in the fitter's cap demotion;
    trim tie-break spreads cuts across time (round-robin by
    chapter/month) instead of date order.
2.4 Port eval `paceThemedSpreads` + spread budget to the worker
    (`reading-order.ts`), so themed spreads can't crowd out chronology.
2.5 D4 portrait sampling + scope-aware title/kicker (`furniture.ts`,
    fitter `buildThroughTheYearsPage`).
2.6 D5 Firsts cap for multi-year scopes.
2.7 D6 scope-aware closing headline; outline prompt drops "this year"
    framing for non-year scopes (`_shared/memory-book-outline.ts`).
2.8 Tests per item + fitter integrity audit (0 violations) on both dogfood
    Everything books.

### Phase 3 — dogfood validation → re-enable

3.1 Generate Everything for Enzo (4y) and Mara (2y) via the Phase 0.7
    owner allowlist (pause stays on for everyone else).
3.2 Owner page-by-page review rounds (same format as V3 rounds).
3.3 Remove `everything` from `PAUSED_SCOPE_KINDS`; redeploy.
3.4 OTA: only needed if Phase 2 runs long — hide Everything from the
    create sheet meanwhile (owner call).

## 5. Out of scope

Multi-volume books; custom-range scope; any change to already-ready
books (they keep their documents; owners can regenerate).
