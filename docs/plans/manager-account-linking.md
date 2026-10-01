# Manager-linked "this is me" — plan

Status: draft 2026-10-01. Agreed in session; follows
[invite-for-person](./invite-for-person.md) (shipped 755fb61). Extends
[family-relationships](../features/family-relationships.md).

## 1. Goal

Owners and managers can link an **already-joined account** to a person in the Family list.
Today only the account itself can link itself, via "This is me" or Who's who. A manager can
only *unlink*.

Done means:

- **Members screen:**
  - A row shows the linked person.
  - Owners and managers can "Link to a person…", "Change person…" and "Unlink person" for
    any active member, including the owner and themselves.
- **Person detail:** an eligible person gets "Already on Momora? Link their account", which
  opens a picker of active members who have no link.
- No notification is sent. The linked account sees "This is you" on that person and can
  undo it.

## 2. Decisions (owner, 2026-10-01)

| # | Decision |
|---|---|
| L1 | Scope is joined accounts only. Pending invites stay immutable (invite-for-person D9). |
| L2 | No notification to the linked account. |
| L3 | Owner/manager can link **any active member, including the owner and themselves**. This is identity metadata, not a role change. Viewers can't link anyone else. |
| L4 | Same eligibility rules as everywhere else: `is_linkable_family_member` (no kids or pets), one account per person, same family, not content-safety hidden (client side). |
| L5 | Linking an account that already has a link **replaces** it. The UI only offers this as an explicit "Change person…". Linking clears `not_in_list`. A person linked to a *different* account is never stolen: the server rejects it with `member_already_linked`, and the manager has to "Unlink account" on that person first. |
| L6 | Not billing-gated, same as `set_my_family_member` / `unlink_family_member_account` (account metadata). |

## 3. Backend

New migration `supabase/migrations/20261001150000_link_family_member_account.sql`
adds `public.link_family_member_account(p_family_id uuid, p_user_id uuid, p_member_id uuid) returns void`.

- `security definer`, `search_path = ''`, in the same house style as `set_my_family_member`
  (`20260928120000_family_relationships.sql:138`).
- Checks, in order:
  - `auth.uid()` not null and not anonymous, else `42501 Not authorized`
  - `has_family_role(p_family_id, ['owner','manager'])`, else `42501`
  - the target is an active member of `p_family_id`. If there's no `family_memberships`
    row, raise `22023 account_not_in_family`
  - the person is in the family, else `22023 member_not_in_family`
  - `is_linkable_family_member`, else `22023 member_not_linkable`
- Then `update family_memberships set family_member_id = p_member_id, not_in_list = false where family_id = p_family_id and user_id = p_user_id`.
  A `unique_violation` becomes `23505 member_already_linked`. Linking a person to the account
  that already holds it is a no-op success.
- Error messages equal the tokens. The client matches on message, same as
  `isAlreadyLinkedError` in `src/services/family-relationships.ts`.
- `revoke all … from public, anon, authenticated; grant execute … to authenticated`, plus
  `comment on function`.
- Check whether `family_memberships` has a column-immutability trigger
  (`enforce_membership_immutable_columns` or similar) that blocks `family_member_id` writes
  outside approved paths. `set_my_family_member` works today, so mirror whatever lets it
  through.

Regenerate `src/types/database.ts` from the local DB, piping cleanly. Add the function to
TECH_SPEC next to `set_my_family_member`.

## 4. App

1. **Service and hook.**
   - Add `linkFamilyMemberAccount(familyId, userId, memberId)` to
     `src/services/family-relationships.ts`.
   - Add a mutation to `useFamilyRelationships` that invalidates
     `[familyMembershipLinksQueryKeyBase]` and anything else the existing link/unlink
     mutations invalidate.
   - Unlinking reuses the existing `unlinkFamilyMemberAccount(familyId, memberId)`.
2. **Roles.** Add `canLinkMemberAccount(actorRole, member)` in `src/utils/roles.ts`:
   `canEditFamilyContent(actorRole) && member.is_active_member`. Never hand-roll it.
3. **Person picker sheet.** Add `src/components/link-person-sheet.tsx`, a bottom-sheet Modal
   in the same shape as `MemberActionSheet` / `FamilyRosterSheet`, with stable testIDs.
   It lists eligible people (`isInviteTargetEligible` with the current links, excluding
   hidden people), each with `FamilyMemberAvatar` and the name. For "Change person…" the
   account's *current* person is shown as selected.
4. **Members screen** (`app/(app)/sharing/members.tsx` + `src/components/member-action-sheet.tsx`):
   - A row's value or caption shows the linked person's name (e.g. "Manager · Grandma Ana").
     Match the existing `SettingsRow` props.
   - A row is tappable when `canManageMember || canLinkMemberAccount || hasSafetyActions`.
     That makes the owner's row and your own row tappable for an owner/manager, but their
     sheet only shows link actions.
   - New sheet actions: "Link to a person…" when unlinked (`member-action-link`);
     "Change person…" (`member-action-change-person`) and "Unlink person"
     (`member-action-unlink-person`) when linked. Role/remove actions keep their existing
     `showManagementActions` gate.
   - Error mapping by token:
     - `member_already_linked` → "Someone else already says this is them. Unlink them on
       that person's page first."
     - `member_not_linkable` / `member_not_in_family` / `account_not_in_family` → "That
       didn't work. The list has been refreshed." Invalidate links and members.
5. **Person detail** (`app/(app)/family/[id]/index.tsx`, "Family sharing" block from
   invite-for-person):
   - Add a second row, "Already on Momora? Link their account" (`family-member-link-account`),
     shown only when at least one active member has no link.
   - It opens an account picker (reuse the sheet with an accounts mode, or a sibling
     component) listing the unlinked active members by name and role.
   - The existing invite-row conditions still gate the block.
6. **Viewers:** no change. Their member rows keep today's safety-only sheet.

## 5. Tests

- **pgTAP** `supabase/tests/link_family_member_account.sql`:
  - manager links a viewer; owner links themselves; manager links the owner
  - viewer, non-member and anonymous callers are rejected (42501)
  - target not in the family → `account_not_in_family`; person from another family →
    `member_not_in_family`; child, pet and unsorted under-13 → `member_not_linkable`
  - a person claimed by another account → `member_already_linked`, and the other link is
    unchanged
  - relinking an account replaces its previous link
  - `not_in_list` is cleared
  - same-person relink is a no-op
  - `anon` has no execute
  - Also update `onboarding_anonymous_lockdown.sql` if it enumerates definer RPCs, and keep
    `family_relationships.sql` green.
- **Jest:**
  - `canLinkMemberAccount`
  - the link-person sheet: eligible list, current selection
  - members screen: owner/self rows tappable for owner/manager with link-only actions;
    viewer unchanged; linked caption; link, change and unlink calls; error mapping
  - person detail: account-link row visibility and picker call
- Run tsc, lint, full Jest, the affected pgTAP files and `npm run test:edge` (no Edge
  changes are expected; it's a sanity check).

## 6. Docs

- `docs/features/family-relationships.md`: Member detail + a "Manager linking" bullet, and
  a changelog row.
- `docs/features/family-sharing.md`: Member management section, covering the new sheet
  actions and owner/self rows becoming tappable for link actions.
- `docs/TECH_SPEC.md`: the new function.

## 7. Rollout

The migration ships first; it's additive (a new function only), so it's safe for every
binary. The app then goes out by OTA to runtime 1.4.2 from `main`, the same as 755fb61.
1.4.0 and 1.4.1 aren't touched.

## 8. Out of scope

- Editing pending invites (case 2).
- Notifications.
- Linking from Who's who.
- Bulk linking.
