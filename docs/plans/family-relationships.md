# Family relationships — plan

Status: built 2026-09-28 (uncommitted) — pending device QA + prod rollout. Feature doc: docs/features/family-relationships.md. Owner decisions agreed in session; this plan
turns them into steps. Hardened with 2 adversarial review rounds (see §8).

## 1. Goal

Every person in a family's list can carry **who they are to the kids** (role + family
side), every account can say **"this is me"**, and the app proposes both with AI so a
family gets there with ~2 taps and zero required steps. Done =
- the Year Film child selection (`pickChildren` / `isFilmChild`, today exercised by the
  eval scripts; P1 production code will call the same `_shared` functions) excludes
  members marked as non-children (Elena, a niece, marked `cousin`), and
- voice memories resolve "I/me" to the speaker's own member row via the account link.

## 2. Context (current state the plan relies on)

- `public.family_members` (`supabase/migrations/20260524201500_initial_schema.sql:22-37`,
  `family_id` added in `20260711120000_family_sharing.sql`): `name`, `nicknames text[]`,
  `date_of_birth`, `gender`, `additional_info`, `is_user_profile boolean`. `(id, family_id)`
  is already a composite FK target (added in `20260715120000_portrait_timeline.sql`).
- `is_user_profile` is set only by demo seed scripts (`supabase/scripts/seed-demo-account.ts:793`,
  `demo-family-spec.ts:102`), never by app/RPC write paths. Readers: `src/utils/family-members.ts:252`
  (`isFamilyMemberProfileIncomplete` exemption), `src/services/ai.ts:142` + payload builders
  (`new-memory.tsx`, `memory/[id]/edit.tsx`, `gallery-import-approval.tsx`),
  `process-voice-memory/index.ts:391` (server refetches members at :433 via the injected
  `VoiceFamilyLookupClient`), plus ~15 typed test fixtures.
- RLS: members select = any family member; insert/update/delete = owner|manager
  (`family_sharing.sql:462-473`). Anonymous sessions are locked out of tenant tables by
  restrictive policies (`20260729130000_onboarding_anonymous_lockdown.sql`, test
  `supabase/tests/onboarding_anonymous_lockdown.sql`).
- `public.family_memberships` (`family_sharing.sql:25-33`): clients may only
  `update (role)` (`20260822100000_family_activity.sql:82-83`), and only owner/manager on
  non-owner rows (`family_sharing.sql:184-192`). → The "this is me" link needs a
  security-definer RPC.
- Onboarding creates kid members name-only in `commit_onboarding` (latest definition
  `20260801150000_paid_subscription_hardening.sql`, loop ~:455-461).
- "Child" today = DOB < 13 via `classifyChildOrAdult` (`_shared/date-context.ts:97`).
  Year Film: `isFilmChild` (`_shared/year-film-eligibility.ts:176-179`, null DOB → false),
  called from `supabase/scripts/year-film-eval-data.ts` (`pickChildren` ~:337),
  `eval-year-film-script.ts` (~:575), `eval-year-film-audit.ts` (~:395). No production
  Year Film caller exists yet (P1).
- AI: `chatJson` (`_shared/openai.ts:194`) is fixed to `gpt-4o-mini` + `json_object`, priced
  in `_shared/ai-pricing.ts`. Operations: TS union `openai.ts:8-15` + inline check on
  `ai_usage_events.operation` (`20260727120000_ai_usage_limits.sql:106`) + table in
  `docs/features/usage-limits.md:99`. Caps count **image** generations only; chat calls
  are ledger telemetry. Paid-write gate `checkBillingFamilyWrite` (`_shared/billing.ts`).
- Onboarding layout redirects signed-in users with memberships off any route not in
  `POST_AUTH_ONBOARDING_PATHNAMES` (`src/lib/onboarding-routes.ts:18-26`,
  `app/(onboarding)/_layout.tsx:66-72`). Two approval screens end at the timeline:
  `app/(onboarding)/join/waiting.tsx` and `app/(app)/sharing/waiting.tsx:71,77`.
- UI: Family tab `app/(app)/(tabs)/family.tsx` (flat `CastCard` list, content-safety
  hidden profiles), add `app/(app)/add-family-member.tsx`, edit `app/(app)/family/[id]/edit.tsx`,
  detail `app/(app)/family/[id]/index.tsx`; services `src/services/family-members.ts`
  (`Create/UpdateFamilyMemberInput` + `*WithPhoto` variants), utils `src/utils/family-members.ts`.
- Export worker lists `family_members` columns explicitly (`cloudflare/momora-export-worker/src/plan.ts:93`).
- TECH_SPEC §2.1a–§2.1f are taken; next is §2.1g. Edge Function contracts live in §4.
- Owner UX decisions (2026-09-28): roles anchored on the kids; family side worded with the
  parents' names when parents are marked, else "Mom's / Dad's"; AI proposes roles, sides
  and nicknames, never applied silently; "Who's who" card returns whenever there are new
  suggestions; "this is me" per account; no grandparent-name field (nicknames cover it);
  zero required steps anywhere.

## 3. Data model

Role vocabulary (stored value → label): `child` Our child · `parent` Parent ·
`grandparent` Grandparent · `great_grandparent` Great-grandparent · `aunt_uncle`
Aunt/Uncle · `cousin` Cousin · `family_friend` Family friend · `caregiver` Caregiver ·
`pet` Pet · `other` Other. Siblings are implied (two `child`). `null` = not sorted yet.

Family side applies to `grandparent`, `great_grandparent`, `aunt_uncle`, `cousin`. Exactly
one of:
- `side_member_id uuid` — the parent member whose side it is ("Eduardo's side"), or
- `family_side text` in (`maternal`, `paternal`, `both`) — used when no parent is marked
  ("Mom's / Dad's side") and for "Both sides".
Stored neutrally so same-sex parents work.

**Own-child rule** (`isOwnChild`, per member, no family-wide switch): explicit role wins —
`relationship = 'child'` → child; any other non-null role → not a child; `null` → today's
DOB rule (`classifyChildOrAdult(age) === 'child'`). Consequences: an unsorted newborn added
later still counts; the niece stops counting once she's `cousin`; a `child` with no DOB is
still excluded from birthday/chapter films (they need a DOB), same as today.

## 4. Steps

### Step 1 — Migration `supabase/migrations/2026093010xxxx_family_relationships.sql`

1. `family_members`:
   - `relationship text null check (relationship in (…10 values…))`
   - `family_side text null check (family_side in ('maternal','paternal','both'))`
   - `side_member_id uuid null`, composite FK `(side_member_id, family_id)` →
     `family_members (id, family_id) on delete set null (side_member_id)` (PG15+ column
     list, so `family_id` is not nulled); check `side_member_id <> id`.
   - check `not (family_side is not null and side_member_id is not null)`.
   - check side fields only on side roles:
     `(family_side is null and side_member_id is null) or relationship in (<4 side roles>)`.
   - `BEFORE INSERT OR UPDATE` trigger `family_members_normalize_relationship`: clears both
     side fields when the role isn't a side role (so no writer trips the check); rejects a
     newly set `side_member_id` whose member isn't `relationship = 'parent'`.
   - `AFTER UPDATE OF relationship` trigger (security definer): when a member becomes
     `child` or `pet`, null any `family_memberships.family_member_id` pointing at it (an
     account can't be a kid/pet), and dismiss that member's now-stale pending suggestions
     for the changed field (see 1.4 `based_on`).
   - `comment on column is_user_profile` = deprecated (superseded by the membership link).
2. `family_memberships`:
   - `family_member_id uuid null`, composite FK `(family_member_id, family_id)` →
     `family_members (id, family_id) on delete set null (family_member_id)`.
   - `not_in_list boolean not null default false`.
   - unique partial index `(family_member_id) where family_member_id is not null`.
   - Client column grant stays `update (role)`.
3. RPC `public.set_my_family_member(p_family_id uuid, p_member_id uuid, p_not_in_list boolean default false)`
   — security definer, `set search_path = ''`, any role:
   - raises 42501 if `public.is_anonymous_user()` (definer bypasses the RLS-only anonymous
     lockdown; same guard as `mark_family_activity_seen`, `20260822100000_family_activity.sql:393`)
     or if the caller has no membership in `p_family_id`.
   - updates only the caller's own membership row (`user_id = auth.uid()`); link, unlink
     (`p_member_id null`), or `p_not_in_list = true` with `p_member_id null` (sets flag,
     clears link); `p_not_in_list = true` with a member id → error. Linking or unlinking
     resets `not_in_list = false`.
   - validates the member is in `p_family_id`; rejects members that are kids/pets:
     `relationship in ('child','pet')`, or `relationship is null` and DOB age < 13.
   - unique violation → stable error `member_already_linked`.
   - Not billing-gated on purpose: it's account metadata (like leaving a family), not
     family content.
   - `revoke all … from public, anon; grant execute … to authenticated`.
   RPC `public.unlink_family_member_account(p_family_id uuid, p_member_id uuid)` —
   definer, anonymous guard, owner|manager only: clears whichever membership points at
   that member. The recovery path for "someone else already picked this person".
4. Table `public.family_member_suggestions`:
   `id, family_id, family_member_id` (composite FK → `family_members` on delete cascade),
   `field text check in ('relationship','family_side','nickname')`, `value text not null`
   (relationship: role value; family_side: `maternal|paternal|both`, or the sentinel
   `'member'` when `side_member_id` is set; nickname: the nickname),
   `side_member_id uuid null` (composite FK, on delete cascade),
   `based_on text null` (the field's value when suggested — `null` for nicknames),
   `status text check in ('pending','accepted','dismissed') default 'pending'`,
   `created_at, decided_at, decided_by`.
   - unique index on `(family_member_id, field, lower(value), coalesce(side_member_id, '00000000-0000-0000-0000-000000000000'))`
     — dismissed values (any casing) are never re-proposed. Inserts go through a
     service-role-only SQL function `insert_family_member_suggestions(p_family_id, p_rows jsonb)`
     using `on conflict do nothing` (PostgREST upsert can't target an expression index).
   - `revoke all … from anon, authenticated` first (hosted default privileges grant ALL on
     new public tables), then `grant select … to authenticated`. RLS on; select =
     owner|manager of the family; restrictive anonymous-lockdown policy like other tenant
     tables; no client insert/update/delete.
5. RPC `public.resolve_family_member_suggestions(p_family_id uuid, p_accept uuid[], p_dismiss uuid[])`
   — security definer; raises 42501 unless not anonymous **and**
   `has_family_role(p_family_id, ['owner','manager'])` **and** the same billing predicate the
   `Family members: update` policy uses (latest definition in the paid-subscription
   migrations) — otherwise a lapsed family could write `family_members` through the definer
   bypass. One transaction: accepted rows apply to `family_members` (relationship → set;
   family_side → set `family_side` **or** `side_member_id`, clearing the other; nickname →
   append if absent case-insensitively and not used by any other member of the family).
   Compare-and-set: a relationship/side row whose `based_on` no longer matches the member's
   current value is marked dismissed instead of applied (a manual edit wins). Rows marked
   accepted/dismissed with `decided_at/decided_by`; non-pending or other-family ids ignored;
   side rows for a member whose relationship isn't a side role are skipped.
6. `families.relationship_suggested_at timestamptz null` (throttle, Step 3).
7. `commit_onboarding`: `create or replace` from the **current** definition (take
   `pg_get_functiondef` after a fresh `supabase db reset`, not a hand-merge of old files),
   changing only the kid insert to set `relationship = 'child'`.
8. AI usage: `alter table public.ai_usage_events drop constraint ai_usage_events_operation_check,
   add constraint … check (operation in (…, 'relationship_chat')) not valid` then
   `validate constraint` (avoids a long exclusive lock). Verified: no later migration
   redefines the list and `record_ai_usage_event_detailed` doesn't validate family-scoped
   operations. Forward-only: once `relationship_chat` rows exist the old constraint can't
   be restored — a rollback keeps the widened check.
9. No backfill of `relationship` (onboarding kids can't be told from nieces after the
   fact; the per-member DOB fallback keeps existing families unchanged). Existing families
   get AI suggestions (Step 3).

Then: regenerate `src/types/database.ts` (needs local Supabase/Docker; pipe clean per
AGENTS.md); TECH_SPEC **§2.1g** "Family relationships" (columns, table, RPCs, grants) and
**§4** contract for `suggest-family-relationships`; `docs/features/usage-limits.md:99`
gets `relationship_chat`.

### Step 2 — Shared pure logic `supabase/functions/_shared/family-relationships.ts` (+ Deno test)

- `RELATIONSHIPS`, `SIDE_ROLES`, type guards. App mirror `src/utils/family-relationships.ts`
  (labels, grouping) with a jest parity test against the same value list.
- `isOwnChild(member, today)` per §3.
- `sideLabel(member, members)` → "<parent first name>'s side" / "Mom's side" /
  "Dad's side" / "Both sides" / null.

### Step 3 — Edge Function `supabase/functions/suggest-family-relationships/index.ts`

- Auth: JWT; caller owner|manager of `familyId`; `checkBillingFamilyWrite`. No
  `config.toml` entry (user-JWT functions have none).
- Throttle/claim: service-role SQL function `claim_relationship_suggestion_run(p_family_id)`
  — a CTE selects the old value `for update`, then sets `relationship_suggested_at = now()`
  only if it is null, older than 24h, or (older than 1h **and** a `family_members` row was
  created after it). Memories don't bypass the window (`memory_family_members` has no
  timestamp). Returns claimed/old value; not claimed → `{skipped:true}`. Also skipped (no
  model call) when every member already has a relationship and no member or memory
  (`memories.created_at`) is newer than the last run. On OpenAI/validation failure set
  `now() - interval '23 hours'` (retry in ~1h) — never restore, so a persistent failure
  can't loop on every tab focus; a crash before that just waits 24h.
- Input from one service-role SQL function `family_relationship_signals(p_family_id)` (no
  client-side aggregation — PostgREST caps at 1000 rows): members (id, first name,
  nicknames, age in years, gender, current relationship/side), accounts linked to members
  (+ display names), co-tag counts with each own-child member, and up to 40 snippets
  (≤200 chars, newest first, ≤6 per member) of memory text where the member is tagged or
  named — from non-deleted memories not hidden by content reports (same exclusion the
  Year Film uses), text column(s) per memory type pinned in implementation — each labelled
  with its author's linked member when known.
- Model: existing `chatJson` (gpt-4o-mini, `json_object`, already priced) — no new model
  plumbing. Prompt asks for a strict JSON shape; server validates everything. Usage
  recorded as `relationship_chat` (telemetry only; not capped — bounded by the throttle).
- Output per member: `relationship`, `side` (`side_member_id` of a member with
  relationship `parent`, or `maternal|paternal|both`), `nicknames[]`, `confidence 0–1`.
  Validation (exported pure fn, unit-tested): enum values, ids belong to the family,
  drop `confidence < 0.6`, drop values equal to current ones, side only for side roles and
  only pointing at a `parent` member. Nicknames (they feed `matchMemberIdsMentionedInText`,
  `_shared/member-mentions.ts:33-46`, which tags **every** member whose name matches — no
  disambiguation): 2–20 chars, letters/spaces/apostrophes/hyphens only, must appear
  verbatim (case-insensitive) in that member's snippets, not equal to the member's own
  name/nicknames, not equal to **any other member's** name or nickname, not proposed for
  two members in the same run, ≤2 per member per run. Insert via
  `insert_family_member_suggestions` with `based_on` = current value.
- Logs counts only — never names, snippets or model output. Never writes `family_members`.
- Triggered by the app (Step 4); no cron in MVP.

### Step 4 — App

1. `src/utils/family-relationships.ts` (+ jest): labels, side label, grouping order
   (Our kids → Parents → Grandparents → Great-grandparents → Aunts & uncles → Cousins →
   Friends & caregivers → Pets → Other → Not sorted yet).
2. Types/services: add `relationship`, `family_side`, `side_member_id` to
   `CreateFamilyMemberInput`, `UpdateFamilyMemberInput` and the `*WithPhoto` variants
   (`src/utils/family-members.ts`, `src/services/family-members.ts:35-150`) and their
   selects. New `src/services/family-relationships.ts`: `fetchPendingSuggestions`,
   `resolveSuggestions`, `setMyFamilyMember`, `requestRelationshipSuggestions` (errors
   swallowed; on success invalidates the suggestions query).
3. Hooks: `useFamilySuggestions` (owner/manager only), `useMyMembership` (own
   `family_member_id`, `not_in_list`). Invalidate `useFamilyMembers` after resolve/link.
4. Family tab `app/(app)/(tabs)/family.tsx`:
   - Sections by role (headers only when ≥2 groups exist, so an unsorted family looks as today).
   - **Who's who card** on top when (owner/manager and pending suggestions > 0) or (own
     membership unlinked, `not_in_list = false`, and ≥1 linkable member). × hides it until
     a suggestion newer than the last seen one arrives (last-seen `created_at` in
     AsyncStorage per family).
   - On focus (owner/manager): fire `requestRelationshipSuggestions` (server throttles).
5. **Who's who sheet** `app/(app)/family/whos-who.tsx` (modal; route helper in `src/lib/routes.ts`;
   optional `?mode=self&next=timeline`):
   - Part 1 "Which one is you?" (only if unlinked): portrait grid of linkable members
     (same rule as the RPC: not `child`/`pet`, not unsorted-and-under-13; content-safety
     hidden profiles excluded) + "I'm not in the list".
   - Part 2 (owner/manager, not in `mode=self`): one row per member with pending
     suggestions, chips pre-selected; user may change or remove chips. "Looks right":
     (1) for rows the user changed, a normal `updateFamilyMember` with the chosen values;
     then (2) one `resolve_family_member_suggestions` call — unchanged chips → accept,
     removed or overridden chips → dismiss. If (2) fails, suggestions stay pending
     (harmless; card reappears).
   - No TextInput (keyboard rule N/A).
6. Add/Edit person: optional chip row "Who are they to the kids?" + conditional "Whose
   side?" (parents' names + Both, or Mom's/Dad's/Both when no `parent` is marked); non-side
   roles send side fields as null. Verify the keyboard-open layout still reaches Save.
7. Member detail + `CastCard`: subtitle "Grandparent · Eduardo's side" (side label only
   while the referenced member is still `parent`, else omitted); "This is you" badge on the
   viewer's own linked member. Member detail actions: "This is me" (any role, when the
   caller is unlinked or `not_in_list` — the way back after "I'm not in the list") and, for
   owner/manager, "Unlink account" when another account claims the member
   (`unlink_family_member_account`). `isFamilyMemberProfileIncomplete` also exempts the
   caller's linked member (same reason as `is_user_profile`).
8. Joining: both approval screens (`app/(onboarding)/join/waiting.tsx`,
   `app/(app)/sharing/waiting.tsx`) do an explicit members fetch for the approved family id
   (don't rely on `useFamilyMembers`, which follows the active family and may lag), and
   route to `whos-who?mode=self&next=timeline` when ≥1 linkable member exists, else the
   timeline; the existing "Welcome!" alert moves to after that screen. "Skip" goes to the
   timeline. Living under `(app)` avoids the onboarding post-auth redirect.
9. Suggestions whose `based_on` differs from the member's current value are hidden
   client-side (and dismissed server-side on resolve), so a manual edit never resurfaces an
   old guess on the card.

### Step 5 — Consumers

- Year Film: `FilmMemberInput` gains `relationship`; `isFilmChild` = `isOwnChild` **and**
  DOB present **and** still under 13 (today's ceiling — an explicit `child` role does not
  unlock films for teens; owner decision §7.1); update `year-film-eval-data.ts` (`pickChildren` + member select),
  `eval-year-film-script.ts`, `eval-year-film-audit.ts`; add the niece case to
  `year-film-eligibility` tests.
- Voice: `process-voice-memory` self member = caller's `family_memberships.family_member_id`
  for `familyId` (new method on the injected lookup client + test fakes), fallback
  `is_user_profile`.
- Export: add the three columns to `cloudflare/momora-export-worker/src/plan.ts:93` and
  `docs/features/data-export.md` (suggestions not exported — transient AI output).
- Deferred (follow-up, noted in the feature doc): memory-book worker `personType`
  (`cloudflare/memory-book-worker/src/eligibility.ts:78-81` via
  `workflow-memory-book-bridge` select), `date-context.ts:316` memory context, memory-book
  eval scripts, illustration prompts. Memory-book child choice is already per-member
  (`book.child_id`), so it isn't affected by the niece issue.

### Step 6 — Tests

- pgTAP `supabase/tests/family_relationships.sql`: check constraints (incl. side on
  non-side role, both side fields set); viewer links self via RPC but cannot link another
  account, cannot link a member of another family or a kid/pet, cannot
  `update family_memberships set family_member_id` directly; `member_already_linked`;
  deleting a member nulls links/side and cascades suggestions; viewer and anonymous can't
  select suggestions; manager resolve applies relationship/side/nickname (dedupe, clears
  stale side) and marks rows; non-member resolve rejected; `commit_onboarding` kids get
  `child`; `ai_usage_events` accepts `relationship_chat`. Failure-mode cases: anonymous
  caller rejected by all definer RPCs; lapsed (billing-blocked) family can't resolve;
  caller with no membership → 42501; changing a linked member to `child`/`pet` nulls the
  link; changing role clears side via trigger (no 23514); side pointing at a non-parent
  rejected; stale `based_on` row dismissed not applied; "Nana"/"nana" dedupe; nickname
  colliding with another member's name not applied; manager unlink; `not_in_list` reset
  on link. Update `client_table_grants.sql`
  and `onboarding_anonymous_lockdown.sql` for the new table.
- Deno: `family-relationships.test.ts` (`isOwnChild` all branches, side labels),
  suggestion validation tests (incl. nickname collisions, prompt-injected junk values,
  ids from another family), throttle decisions, year-film niece case + a `child` aged 15
  (excluded), voice self-member lookup.
- Quality check before shipping: run the suggestion prompt against the owner's family
  through an allowed eval script (same pattern as `npm run eval:illustration`) and review
  the proposals; gpt-4o-mini is the default only if they're good.
- Jest: utils grouping/labels/parity, services mapping, `isFamilyMemberProfileIncomplete`
  linked exemption; existing fixtures typed with the new nullable fields.
- Maestro `.maestro/flows/family-relationships/whos-who.yaml` (seeded pending suggestions →
  card → "Which one is you?" → "Looks right" → sections + subtitles) and `edit-role.yaml`
  (set Grandparent + side in edit).
- `npm test`, typecheck, lint, `deno test` for `_shared`.

### Step 7 — Docs

- New `docs/features/family-relationships.md` (model, own-child rule, RPCs, AI job, card
  rule, deferred consumers, extension guide: adding a role = check constraint + both enum
  mirrors + labels + grouping).
- `docs/features/family-profiles.md`: link + `is_user_profile` deprecated.
- `docs/plans/year-film.md`: own children = `isOwnChild`.

### Step 8 — Rollout

Migration + Edge Function first (additive; the old app ignores new columns and
`commit_onboarding` keeps its signature), then an EAS update/build with the UI. Rollback =
ship the old app; the schema stays (forward-only, see 1.8). Old app builds never call the
new RPCs, and the triggers only normalize values the old app never sets.

## 5. Risks & mitigations

- **Privacy:** memory snippets go to OpenAI (same posture as emotion/voice features);
  counts-only logs; suggestions visible only to owner/manager.
- **Wrong AI guess applied silently:** impossible by construction — only explicit accept
  writes.
- **Security-definer bypass:** every definer RPC re-checks anonymous, membership/role and
  (for content writes) billing, because RLS doesn't apply inside them.
- **Nicknames mis-tagging memories:** cross-member collision and grounding checks at
  generation **and** accept time (the mention matcher has no disambiguation).
- **Prompt injection via memory text:** only owners/managers write memories; model output
  is treated as untrusted — enum/id/length validation, nothing applied without a human tap.
- **Nagging:** card only for new, still-current suggestions or an unlinked account;
  dismissed values (any casing) never re-proposed; 24h window.
- **Cost:** ≤1 gpt-4o-mini call per family per 24h (≤1/h only when a new member was
  added), skipped when nothing is left to sort. Not capped (chat is telemetry) — the claim
  function is the bound; failures back off ~1h.
- **Link conflicts:** unique index + "Someone else already picked this person — ask a
  family manager", and managers can unlink.
- **Kid/pet linked as an account:** trigger nulls the link when the role changes.
- **`commit_onboarding` drift:** replace from the live definition + pgTAP test.

## 6. Out of scope

Relationships relative to each viewer ("my mom"), a family-tree view, grandparent-name
field, auto-applying AI output, the deferred consumers in Step 5, cron-driven suggestions,
creating a member for yourself from Who's who (use Add person).

## 7. Owner decisions after review (2026-09-28)

1. **Year Film age ceiling:** keep `< 13` for birthday/chapter films, even for an explicit
   "Our child".
2. **Undoing "this is me":** owner/manager can unlink any account from a person
   (`unlink_family_member_account`); each account can always change its own link.

## 8. Review log

- **Round 1 (Sonnet, completeness & correctness).** Caught: a family-wide "role mode"
  switch would drop later-added unsorted kids (→ per-member rule); join screen would be
  bounced by the onboarding redirect and a second approval screen was missed (→ `(app)`
  route from both); memory-book consumer model was wrong (→ deferred); `chatJson` is fixed
  to gpt-4o-mini and chat isn't capped (→ use it, throttle is the bound); expression
  unique index vs upsert; change-a-chip write path; TECH_SPEC §2.1g/§4; anonymous lockdown;
  export columns; `is_user_profile` readers; atomic throttle claim.
- **Round 2 (Sonnet, failure modes).** Caught: definer RPCs bypassed the billing gate and
  anonymous lockdown (→ explicit checks); AI nicknames could collide across members and
  mis-tag memories (→ collision/grounding rules); kid/pet link only checked at link time
  (→ trigger); throttle bypass by any new memory, no tag timestamps, retry loop on failure
  (→ reworked claim + backoff); stale suggestions overwriting manual edits (→ `based_on`
  compare-and-set, case-insensitive dedupe); no recovery from a wrong claim or "not in
  list" (→ manager unlink + "This is me" on detail); explicit `child` would unlock teen
  films (→ keep `< 13`, open question); signals via SQL (1000-row cap, reported memories);
  suggestion sentinel, revoke-first grants, role-change trigger, forward-only rollback.
- Rejected: none. Round 2's `set_my_family_member` billing gate was deliberately not added
  (account metadata, like leaving a family) — flagged here so the owner can overrule.
