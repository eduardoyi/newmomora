# Invites for a person — plan

Status: built 2026-09-30, pending device QA. Agreed in session; hardened with light
adversarial review (see §10). Extends
[family-sharing](../features/family-sharing.md) and
[family-relationships](../features/family-relationships.md).

## 1. Goal

An invite can optionally say **who it's for**, either a typed name or a person from the
family list. Done =

- **Pending invites** and **Approvals** show who each invite is for ("Grandma Ana"), not
  just a code. Approvals shows "Invited as Grandma Ana" next to the redeemer's real
  name and email, so a mismatch is easy to spot.
- The **join flow** greets the invitee by name ("Hi Ana — Eduardo invited you…") and
  prefills the display-name step. The prefill stays editable.
- An invite tied to a family person **links the account to that person on approval**
  ("this is me" is set automatically), so the invitee skips "Are you in the family?".
- The **person detail** screen has an "Invite {name} to Momora" entry point that opens
  the invite screen with that person already picked.
- Zero new required steps. Leaving the field blank behaves exactly like today.

## 2. Context (current state this plan relies on)

- `family_invites` (`20260711120000_family_sharing.sql:35`): no invitee columns.
  Clients have table-level `select, update` (`20260731110000_grant_authenticated_client_table_access.sql:31`),
  and RLS scopes rows to manager+ (update policy: `20260801170000_paid_subscription_sol_hardening.sql:105`).
  The only client write is `revokeFamilyInvite` (`update({ status })`). No trigger
  guards other columns. `pending-invites.tsx` / `approvals.tsx` read
  `select('*')` through `fetchFamilyInvites` (`src/services/invites.ts`), so new
  columns reach them without any service change.
- `create_family_invite(fam uuid, invite_role text)`: latest body is in
  `20260801120000_paid_subscriptions.sql:1001` (anon guard, role check, billing gate,
  code loop). The client calls it with named args `{ fam, invite_role }`.
- "This is me" = `family_memberships.family_member_id` (`20260928120000_family_relationships.sql:112`),
  with a composite FK to `family_members (id, family_id)` (`on delete set null`), a unique
  partial index (one account per person), and the check `not (not_in_list and
  family_member_id is not null)`. Only written by definer RPCs and the trigger that
  unlinks a member who becomes a child or pet (`family_relationships.sql:335`).
  The linkability rule (not `child`/`pet`, and not unsorted under 13) is inlined in
  `set_my_family_member` and mirrored client-side in `isLinkableMember`
  (`src/utils/family-relationships.ts:129`).
- Approval: `resolve-family-invite` (service client) inserts the membership (23505 =
  already a member, continue), sets `active_family_id`, then flips the invite to `approved`.
- Preview: `preview-family-invite` (accepts anonymous callers, rate-limited per code)
  returns `{ familyName, inviterName }`. A second copy of that response type lives
  client-side (`src/services/onboarding-join.ts:38`). The join flow stores `inviterName`
  in the device join draft (`JoinDraft`). Its guard `isJoinDraftShape` accepts only
  `undefined | string` per field, and a failed guard makes `getJoinDraft()` return `{}`,
  which wipes the whole draft. `join/name.tsx` prefills
  from `draft.displayName` and writes the **global** `user_profiles.name`.
- Both waiting screens (`app/(onboarding)/join/waiting.tsx:101`,
  `app/(app)/sharing/waiting.tsx:74`) route to `whosWhoSelfRoute` whenever
  `familyHasLinkableMember(newFamilyId)`.
- Person detail (`app/(app)/family/[id]/index.tsx:415-452`) already has the "You" and
  "Account" blocks with `useFamilyRelationships` (`myMemberId`, `claimedByOthers`) and
  `canEdit`.
- Share copy: `buildInviteShareMessage(code, familyName)` in `src/utils/invites.ts`.

## 3. Decisions

| # | Decision |
|---|---|
| D1 | One optional field, **"Who's this for?"**: a name input plus a chip row of linkable, unclaimed family people. Tapping a chip links that person and fills the name, which stays editable. Tapping the selected chip again unlinks it but keeps the text. |
| D2 | `invitee_name` is a snapshot. It isn't kept in sync with later renames of the person. When a person is picked and the name is left blank, the server defaults it to `family_members.name`. |
| D3 | The invitee name is returned by the **anonymous preview endpoint**. That's accepted: it's rate-limited per code, and the endpoint already reveals the family and inviter names. The invite's `family_member_id` is never returned. |
| D4 | The name prefill applies **only to the new-signup join path**. The signed-in redeem path (`sharing/redeem.tsx`) never touches an existing `user_profiles.name`. |
| D5 | The link is applied **at approval, server-side, best-effort**. Approval never fails because of the link. The link is skipped if the person is no longer linkable, was claimed by another account, or was deleted, or if the redeemer already has a link in this family (never overwrite). |
| D6 | The picker and the server use the same eligibility rule: linkable, and not already claimed by an account. Creating an invite for a claimed or unlinkable person is rejected. Multiple pending invites for the same person are allowed, and the first approval wins the link. |
| D7 | Person detail entry point: shown to owner/manager when the person is linkable, unclaimed, and not hidden by content safety. If a live invite exists for them, the row changes: **pending and unexpired** shows "Invite sent · expires in N days" and opens Pending invites; **redeemed** (waiting for approval) shows "Waiting for your approval" and opens Approvals. |
| D9 | The new invite columns are **immutable from the client**. Table-level `update` on `family_invites` is narrowed to `update (status)`, the only column the client writes, so a manager can't retarget an invite at another person after creation. |
| D10 | `set_my_family_member` is **not refactored**. The new `is_linkable_family_member` helper is used only by the new code. Both SQL copies of the rule carry a comment pointing at each other and at `isLinkableMember`. This keeps a shipped RPC's error semantics (separate not-found vs. not-linkable branches) untouched. |
| D8 | Analytics: `invite_created` gains `has_invitee_name` and `for_family_member` (booleans only, no names). No memory or person content is logged anywhere (Edge Functions log ids and error codes only). |

## 4. Backend

### 4.1 Migration `supabase/migrations/20261001120000_invite_invitee.sql`

1. `alter table public.family_invites`
   - `add column invitee_name text` with `check (invitee_name is null or char_length(invitee_name) between 1 and 60)`
   - `add column family_member_id uuid` with FK `(family_member_id, family_id) references public.family_members (id, family_id) on delete set null (family_member_id)`
   - index on `(family_member_id) where family_member_id is not null` (so the FK's
     `on delete set null` doesn't scan the table when a person is deleted)
   - column grants (D9): `revoke update on public.family_invites from authenticated;
     grant update (status) on public.family_invites to authenticated;`
2. New helper `public.is_linkable_family_member(p_member_id uuid) returns boolean`
   (`stable`, `security definer`, `search_path = ''`): the same rule as
   `set_my_family_member`. Returns false for a missing row. `revoke all … from public,
   anon, authenticated` (as a definer it bypasses RLS and would otherwise reveal
   child/pet/age for any uuid). Only the definer callers below use it. Per D10, leave
   `set_my_family_member` as is and add cross-reference comments.
3. `drop function public.create_family_invite(uuid, text);` then recreate as
   `create_family_invite(fam uuid, invite_role text, p_invitee_name text default null, p_invitee_member_id uuid default null)`
   (the `p_` prefix avoids plpgsql ambiguity with the new `invitee_name` column),
   keeping the existing body (anon guard, role, `has_family_role`, billing gate, code
   loop) plus:
   - `p_invitee_name`: trim, empty → null, and length > 60 → `22023 invitee_name_too_long`.
     (Error *messages* equal these tokens, because the client's `mapSupabaseError`
     keeps only `message` + `code`, not `hint`. Same convention as
     `isAlreadyLinkedError` in `src/services/family-relationships.ts`.)
   - `p_invitee_member_id` (when not null): it must belong to `fam` (else `22023 member_not_in_family`)
     and pass `is_linkable_family_member` (else `22023 member_not_linkable`), and no
     `family_memberships` row may already link it (else `23505 member_already_linked`).
     If the name is null, default it to `left(trim(member.name), 60)`.
     (`family_members.name` has no length limit, so a raw default could violate the check.)
   - Insert both columns.
   - Re-apply `revoke all … from public, anon, authenticated; grant execute … to authenticated`
     on the **new** signature.
   - Dropping (not overloading) keeps PostgREST unambiguous. Old clients' `{ fam, invite_role }`
     calls resolve to the new function via the defaults.
4. New `public.apply_invite_member_link(p_invite_id uuid) returns boolean`
   (`security definer`, `search_path = ''`, **execute granted to `service_role` only**).
   It reads the invite (must be `redeemed` or `approved`, with `redeemed_by` and
   `family_member_id` set), then re-checks `is_linkable_family_member`. It then runs
   `update family_memberships set family_member_id = <member> where family_id = <fam> and user_id = <redeemer> and family_member_id is null and not_in_list = false`.
   An existing link or an explicit "I'm not in the list" is never overridden. Both are
   possible only on the 23505 already-a-member path.
   A `unique_violation` returns false. The function returns whether a row was linked.
5. Comments on the new columns and functions (house style).

### 4.2 `preview-family-invite`

Select `invitee_name` along with the invite, and add `inviteeName: string | null` to
the Edge copy of `PreviewFamilyInviteResponse` **and** the client copy in
`src/services/onboarding-join.ts:38`. Nothing else changes: same validity window and the
same generic error.

### 4.3 `resolve-family-invite`

On approve: after the membership insert (including the 23505 path) and before the status
flip, call `apply_invite_member_link` whenever the invite has a `family_member_id`. Any
error is logged as `resolve-family-invite member link failed <code>` and then ignored
(D5). Add `family_member_id` to the invite select.

`ResolveFamilyInviteResponse` gains an optional `linked?: boolean`: present only when
the invite targeted a person, and true only when the RPC returned true. That way a
skipped or failed link is never silent to the approver (§5.4). Old clients ignore the
field.

Reject is unchanged. Known trade-off, pre-existing for the membership insert: if the
status flip fails after the membership insert and link, the row stays `redeemed`, and a
later Reject leaves that account a member, now also linked. Document this in the feature
doc and don't add compensation.

### 4.4 Types + spec

Regenerate `src/types/database.ts` (watch for the known corruption quirk noted in
memory). Update `docs/TECH_SPEC.md` with the `family_invites` columns, the new RPC
signature and helper functions, and the preview response.

## 5. App

1. **Service/util.** `createFamilyInvite(familyId, role, { inviteeName, inviteeMemberId })`
   passes the new named args only when they're set.
   `buildInviteShareMessage(code, familyName, inviteeName?)` makes the opening line
   "Hi {name}! I'm journaling…" (unchanged when no name is given).
   Add one shared predicate, `isInviteTargetEligible(member, links, userId, isHidden)`
   in `src/utils/family-relationships.ts`: `isLinkableMember`, not linked to **any**
   account (including the caller's own), not content-safety hidden. The picker, person
   detail and Approvals all use it; none of them hand-roll the check.
   Add `liveInviteForMember(invites, memberId, now)`, a pure helper over cached
   `useFamilyInvites` data. Precedence: a `redeemed` invite first, else the newest
   unexpired `pending` one, else null.
2. **Invite screen** (`app/(app)/sharing/invite.tsx`):
   - Optional `memberId` route param (`sharingInviteForMemberRoute(memberId)` in `src/lib/routes.ts`).
   - New "Who's this for? (optional)" section above the role cards. It has a `TextInput`
     (testID `sharing-invite-name-input`, `autoCapitalize="words"`, maxLength 60) and a
     horizontal chip row of eligible people (avatar + name, testID
     `sharing-invite-person-<id>`). Eligible = `isInviteTargetEligible`. The chip row is
     hidden when nobody is eligible.
   - A `memberId` param preselects that chip and fills the name. If the person turns out
     to be ineligible, the param is ignored silently. Chip-fill uses
     `member.name.trim().slice(0, 60)`, because `maxLength` only limits typing, not
     programmatic values.
   - The screen already uses `KeyboardAwareFormScreen`. Verify that the create button
     stays reachable with the keyboard open (CLAUDE.md keyboard rule).
   - Map server errors by `message` token (codes collide: several are 22023).
     `member_already_linked` → "Someone in the family already says this is them."
     `member_not_linkable` / `member_not_in_family` → "That person can't be invited
     anymore. Pick someone else or type a name." Both clear the chip.
     `invitee_name_too_long` and code `23514` (defensive) → "That name is a bit long."
     Raw tokens never reach the
     screen; anything unmapped falls back to today's handling.
   - Invalidate the invites query as today.
3. **Pending invites:** the primary label is `invitee_name` when present, with the code
   below it as secondary text. Without a name, the layout is exactly today's. "Share
   again" (`pending-invites.tsx:53`) passes `invite.invitee_name` to
   `buildInviteShareMessage` too.
4. **Approvals:** under the redeemer's name and email, add "Invited as {invitee_name}"
   when present. Add "Will be linked to {person} in the family" only when
   `family_member_id` resolves to a current person who passes `isInviteTargetEligible`.
   Refetch the links query when the screen mounts so the answer isn't stale. Otherwise,
   omit the line. On approve, also invalidate `familyMembershipLinksQueryKeyBase`
   (approval now changes links), alongside today's invites and member-profile
   invalidations. When the response has `linked === false`, show a non-blocking note:
   "Approved. We couldn't link them to {person}; they can pick themselves when they open
   the app."
5. **Person detail** (`family/[id]/index.tsx`): a new "Family sharing" block following
   D7's visibility rule, with the live invite from `liveInviteForMember`. Call
   `useFamilyInvites` with `enabled: canEdit`, so viewers never fire the query. The row
   is one of:
   - "Invite {name} to Momora" / caption "They'll see every memory once you approve
     them" → invite route with `memberId`
   - "Invite sent · {formatInviteExpiry}" → Pending invites
   - "Waiting for your approval" → Approvals

   testIDs: `family-member-invite` / `family-member-invite-pending` / `family-member-invite-approval`.
6. **Join flow:** add `inviteeName?: string` to `JoinDraft`. Make `isJoinDraftShape`
   also tolerate `null` for it, so a bad field never wipes the draft. `join/found.tsx`
   always writes `inviteeName: data.inviteeName ?? undefined` on success, and
   `inviteeName: undefined` on the degraded and error branches. That way it never
   persists a `null`, and a stale name from a previously entered code never survives.
   When a name is present, the subtitle opens with "Hi {name} —". `join/name.tsx`
   prefills from `draft.displayName ?? draft.inviteeName`: a name the user typed
   themselves always beats the inviter's label.
7. **Waiting screens (both):** after approval, before the `familyHasLinkableMember`
   check, call `fetchMembershipLinks(newFamilyId)` (`src/services/family-relationships.ts`,
   the read behind `useFamilyRelationships`) and find the row for the signed-in user's id.
   Confirm that each screen has the user id; take it from `useAuth` if not. If the user
   is already linked, skip Who's who and show the existing welcome. A failed read falls
   through to today's behaviour. Extract that decision into one small helper both
   screens call, so they can't drift.
8. **Analytics** per D8.

## 6. Tests

- **pgTAP** `supabase/tests/family_invite_invitee.sql`:
  - old 2-arg call still works
  - name trimmed, blank → null, >60 rejected
  - member default name truncated to 60
  - name defaults from the member
  - member from another family, child, pet, and unsorted under-13 are rejected
  - an already-claimed member is rejected
  - viewer and anonymous callers are rejected
  - member delete sets `family_invites.family_member_id` null
  - `apply_invite_member_link` links the member, skips a claimed one, skips one that is
    no longer linkable, never overwrites an existing link, and is idempotent on retry
  - `authenticated` cannot execute `apply_invite_member_link`
  - `anon` / `authenticated` cannot execute `is_linkable_family_member`
  - `authenticated` can `update (status)` but not `invitee_name` / `family_member_id`
    (`has_column_privilege`)
- **Existing pgTAP updates:**
  - `onboarding_anonymous_lockdown.sql:353` asserts on the `(uuid,text)` signature,
    which no longer exists after the drop. Change it to `(uuid,text,text,uuid)`.
  - `client_table_grants.sql:11` asserts table-level `UPDATE` on `family_invites`.
    Change it to `SELECT` table + `has_column_privilege(..., 'status', 'UPDATE')`.
  - Keep each file's `plan()` count in sync. `family_relationships.sql` must stay green
    unchanged.
  - `apply_invite_member_link` leaves a `not_in_list = true` membership untouched
- **Edge (Deno):**
  - preview returns `inviteeName` or null
  - resolve calls the link RPC only when `family_member_id` is set
  - approval still returns `approved` when the link RPC errors, with `linked: false`;
    `linked` is absent when the invite had no person
  - the reject path never calls it
- **Jest:**
  - `invites.test.ts` covers the share message with and without a name (including Share again)
  - `JoinDraft` guard with `inviteeName: null` keeps the rest of the draft
  - approvals "Will be linked" hidden when the person was claimed after invite creation
  - `sharing.invite.test.tsx` covers name typing, chip select/deselect, `memberId`
    preselect, ineligible param ignored, and args passed to the service
  - pending-invites and approvals labels
  - person-detail row visibility matrix (viewer, child, claimed, hidden, pending invite,
    redeemed invite, expired invite)
  - `JoinDraft` guard
  - found/name prefill
  - the waiting-screen helper (linked → skip, unlinked + linkable → Who's who)
- **Maestro:** extend `.maestro/flows/sharing/01-owner-create-invite.yaml` to type a
  name and assert it on Pending invites. Add a short flow from person detail →
  "Invite … to Momora" → chip preselected.
- Run `npm test`, `npx tsc --noEmit`, lint, `supabase test db`, and the Edge tests
  (Node 20 via nvm).

## 7. Docs

- `docs/features/family-sharing.md`: invite/redeem/approve behaviour, new columns, and
  the anonymous-preview exposure note (D3).
- `docs/features/family-relationships.md`: under "Joining", invite-time linking and the
  skip rule. Under "Member detail", the invite entry point.
- `docs/TECH_SPEC.md` per §4.4. Add a changelog row to both feature docs.

## 8. Rollout

1. **Backend first.** `supabase db push` (the migration), then deploy
   `preview-family-invite` and `resolve-family-invite` (the function depends on the
   migration's RPC). Both stay backward compatible with every shipped binary:
   - Old clients create invites without names. The extra args have defaults.
   - Old clients ignore `inviteeName` in the preview response.
   - Narrowing the grant to `update (status)` is safe because every shipped client only
     writes `status` (revoke).
   - 1.4.0/1.4.1 already carry family relationships (OTA 09-28). If the invitee is on
     one of those, the server-side link still applies and their client may still show
     Who's who in self mode, displaying the existing link.
   - Before publishing the OTA, confirm in production that `apply_invite_member_link`
     and the 4-arg `create_family_invite` exist (`select … from pg_proc`).
   - **Rollback order:** republish the previous EAS group for 1.4.2 first, then revert the
     DB (recreate the 2-arg function, re-widen the grant). Reverting the DB first would
     break named invites on the new client (PGRST202). Old and new signatures can't
     coexist: a 2-arg overload next to the defaulted 4-arg one makes `{ fam, invite_role }`
     ambiguous (PGRST203).
   - Linking on approval happens server-side for any client version. On an old binary
     the invitee may still see Who's who in self mode, which is harmless: it shows their
     existing link.
2. **App via OTA, runtime 1.4.2 only**, once the 1.4.2 store builds are live. `main`
   already carries 1.4.2's native changes, so this is a normal `eas update` from `main`
   with app.json at 1.4.2. Before publishing, run
   `git diff <1.4.2 build commit>..HEAD -- package.json app.json` to confirm there are
   no native drifts.
   - Do **not** backport to 1.4.0/1.4.1. Those users get the feature by updating, and
     until then they simply create unnamed invites.
   - Until the store builds are approved, QA runs on a dev build against production.
3. Device QA (both platforms):
   - invite with a typed name
   - invite from person detail
   - redeem as a new signup (prefill shows)
   - approve (link applied, Who's who skipped)
   - approve after someone else claimed the person (approval still succeeds, no link)

## 9. Out of scope

- Showing "Invited" badges in the Family tab list. Person detail covers it.
- Editing an invite's name or person after creation. Revoke and re-invite instead.
- Using the person's nickname ("Abuela") as the default name. `name` is used; the field
  is editable.
- Per-family display names (existing known divergence, `docs/features/onboarding.md`).

## 10. Review log

- **Round 1 (Sonnet, completeness/correctness):**
  - Accepted and fixed:
    - dropped signature breaks `onboarding_anonymous_lockdown.sql:353`
    - new definer helper needed explicit revokes
    - new columns were client-updatable → D9 column grant
    - `JoinDraft` guard wipes the draft on `null`
    - client copy of the preview response type
    - Share again caller
    - approvals "Will be linked" could lie, plus the stale links cache
    - D7 ignored redeemed invites
    - error mapping can't use `hint`
  - Resolved differently: the `set_my_family_member` refactor was dropped (D10) rather
    than guarded with extra tests.
- **Round 2 (Sonnet, failure modes):**
  - Accepted and fixed:
    - over-60 member names broke the server default and chip-fill → truncate both, map 23514
    - silent link loss → `linked` flag + approver note
    - rollback order / pg_proc pre-check
    - Approvals eligibility missed the approver's own link → one shared `isInviteTargetEligible`
    - stale `inviteeName` on degraded preview
    - `not_in_list` override
    - multi-invite precedence + `enabled: canEdit`
    - reject-after-partial-failure trade-off documented
    - `p_` param names
  - Rejected:
    - "keep the 2-arg function as a wrapper" (causes PGRST203 ambiguity)
    - "invitee name should beat an earlier typed `displayName`" (the user's own input wins)
