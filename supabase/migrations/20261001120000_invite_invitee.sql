-- Invites for a person (docs/plans/invite-for-person.md, §4.1).
--
-- An invite can say who it is for: a typed name (`invitee_name`, a snapshot)
-- and/or a person from the family list (`family_member_id`). On approval the
-- redeemer's account is linked to that person ("this is me") server-side,
-- best-effort (resolve-family-invite calls apply_invite_member_link).
--
-- Sections:
--   1. family_invites: invitee_name / family_member_id + FK + index + grants
--   2. is_linkable_family_member helper (definer callers only)
--   3. create_family_invite: new optional args (drop + recreate)
--   4. apply_invite_member_link (service_role only)

-- ---------------------------------------------------------------------------
-- 1. family_invites columns
-- ---------------------------------------------------------------------------

alter table public.family_invites
  add column invitee_name text,
  add column family_member_id uuid;

alter table public.family_invites
  add constraint family_invites_invitee_name_check
    check (invitee_name is null or char_length(invitee_name) between 1 and 60),
  -- (family_member_id, family_id) -> (id, family_id): the person must be in
  -- the invite's own family. Deleting the person only nulls the link column,
  -- never family_id (the invite survives as a plain invite).
  add constraint family_invites_family_member_fkey
    foreign key (family_member_id, family_id)
    references public.family_members (id, family_id)
    on delete set null (family_member_id);

-- Keeps the FK's `on delete set null` from scanning the table when a person
-- is deleted.
create index family_invites_family_member_id_idx
  on public.family_invites (family_member_id)
  where family_member_id is not null;

-- D9: the new columns are immutable from the client. The only client write
-- to family_invites is revokeFamilyInvite (`update({ status })`); narrowing
-- the table-level UPDATE to that one column stops a manager retargeting an
-- invite at another person after creation. (Revoking table-level UPDATE also
-- drops any column-level UPDATE grants, so the grant below is the full set.)
revoke update on table public.family_invites from authenticated;
grant update (status) on table public.family_invites to authenticated;

comment on column public.family_invites.invitee_name is
  'Optional label for who the invite is for (snapshot: not kept in sync with later renames). Shown in Pending invites / Approvals and, via the anonymous preview endpoint, on the join screen. 1-60 chars. Written only by create_family_invite; the client column grant is update (status) only.';
comment on column public.family_invites.family_member_id is
  'Optional family_members row this invite is for. On approval resolve-family-invite links the redeemer''s membership to it via apply_invite_member_link (best-effort). Never returned by the anonymous preview. Nulled if the person is deleted. Written only by create_family_invite.';

-- ---------------------------------------------------------------------------
-- 2. is_linkable_family_member
-- ---------------------------------------------------------------------------

-- SYNC: the same linkability rule lives inline in set_my_family_member
-- (20260928120000_family_relationships.sql) and client-side in
-- isLinkableMember (src/utils/family-relationships.ts). Kids and pets can't
-- be an account: explicit role child/pet, or (unsorted) under 13. Per
-- docs/plans/invite-for-person.md D10, set_my_family_member is deliberately
-- NOT refactored onto this helper (its not-found vs. not-linkable error
-- branches are shipped semantics). If the rule changes, change all three.
create or replace function public.is_linkable_family_member(p_member_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      -- coalesce: an unsorted member has relationship null, and
      -- `null in (...)` is null, which would otherwise poison the `not`.
      select not (
        coalesce(m.relationship in ('child', 'pet'), false)
        or (
          m.relationship is null
          and m.date_of_birth is not null
          and date_part('year', age(current_date, m.date_of_birth)) < 13
        )
      )
      from public.family_members m
      where m.id = p_member_id
    ),
    false
  );
$$;

-- A definer bypasses RLS, so a client could otherwise probe child/pet/age for
-- any uuid. Only the definer callers (create_family_invite,
-- apply_invite_member_link) use it.
revoke all on function public.is_linkable_family_member(uuid) from public, anon, authenticated;

comment on function public.is_linkable_family_member(uuid) is
  'True when the family member can be an account (not child/pet, not unsorted under 13). False for a missing row. Internal helper for definer functions only: no client grant. Same rule as set_my_family_member and client isLinkableMember -- keep in sync.';

-- ---------------------------------------------------------------------------
-- 3. create_family_invite with optional invitee
-- ---------------------------------------------------------------------------

-- Dropped, not overloaded: a 2-arg overload next to the defaulted 4-arg one
-- would make a `{ fam, invite_role }` call ambiguous (PostgREST PGRST203).
-- Old clients' 2-arg calls resolve to the new function via the defaults.
drop function public.create_family_invite(uuid, text);

-- Body otherwise identical to the paid-subscriptions version
-- (20260801120000_paid_subscriptions.sql): anon guard, role check,
-- has_family_role, billing gate, code loop. p_ prefix on the new params
-- avoids plpgsql ambiguity with the invitee_name column.
-- Error *messages* equal the tokens because the client's mapSupabaseError
-- keeps only message + code (not hint).
create or replace function public.create_family_invite(
  fam uuid,
  invite_role text,
  p_invitee_name text default null,
  p_invitee_member_id uuid default null
)
returns public.family_invites
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  new_code text;
  new_invite public.family_invites;
  attempt integer := 0;
  v_name text := nullif(btrim(p_invitee_name), '');
  v_member_name text;
begin
  if current_user_id is null or public.is_anonymous_user() then raise exception 'Unauthorized' using errcode = '42501'; end if;
  if invite_role not in ('manager', 'viewer') then raise exception 'Invalid invite role' using errcode = '22023'; end if;
  if not public.has_family_role(fam, array['owner', 'manager']) then raise exception 'Not authorized' using errcode = '42501'; end if;
  perform public.assert_billing_write_access(fam, current_user_id, 'invite');

  if v_name is not null and char_length(v_name) > 60 then
    raise exception 'invitee_name_too_long'
      using errcode = '22023', hint = 'invitee_name_too_long';
  end if;

  if p_invitee_member_id is not null then
    select m.name into v_member_name
    from public.family_members m
    where m.id = p_invitee_member_id and m.family_id = fam;

    if not found then
      raise exception 'member_not_in_family'
        using errcode = '22023', hint = 'member_not_in_family';
    end if;

    if not public.is_linkable_family_member(p_invitee_member_id) then
      raise exception 'member_not_linkable'
        using errcode = '22023', hint = 'member_not_linkable';
    end if;

    -- Already claimed by an account (the unique index guarantees at most one).
    if exists (
      select 1 from public.family_memberships fm
      where fm.family_id = fam and fm.family_member_id = p_invitee_member_id
    ) then
      raise exception 'member_already_linked'
        using errcode = '23505', hint = 'member_already_linked';
    end if;

    -- family_members.name has no length limit: truncate so the default can't
    -- violate the invitee_name check.
    if v_name is null then
      v_name := nullif(left(btrim(v_member_name), 60), '');
    end if;
  end if;

  loop
    attempt := attempt + 1;
    select string_agg(word, '-') into new_code from (
      select word from public.invite_code_words order by random() limit 3
    ) picked;
    begin
      insert into public.family_invites (family_id, code, role, invited_by, invitee_name, family_member_id)
      values (fam, new_code, invite_role, current_user_id, v_name, p_invitee_member_id)
      returning * into new_invite;
      return new_invite;
    exception when unique_violation then
      if attempt >= 10 then raise exception 'Could not generate a unique invite code' using errcode = 'P0001'; end if;
    end;
  end loop;
end;
$$;

revoke all on function public.create_family_invite(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.create_family_invite(uuid, text, text, uuid) to authenticated;

comment on function public.create_family_invite(uuid, text, text, uuid) is
  'Owner/manager creates an invite code (billing-gated). Optional p_invitee_name (trimmed, blank -> null, max 60) and p_invitee_member_id (must be in fam, linkable, unclaimed; defaults the name to the person''s name, truncated to 60). Errors: 42501 unauthorized; 22023 Invalid invite role / invitee_name_too_long / member_not_in_family / member_not_linkable; 23505 member_already_linked (message = token).';

-- ---------------------------------------------------------------------------
-- 4. apply_invite_member_link (service role only)
-- ---------------------------------------------------------------------------

-- Called by resolve-family-invite on approval, best-effort (D5: approval never
-- fails because of the link). Re-checks everything at approval time, because
-- the person may have been claimed, reclassified as a child/pet, or deleted
-- since the invite was created. Never overwrites an existing link or an
-- explicit "I'm not in the list" (both possible only on the 23505
-- already-a-member path). Returns whether the account is linked to the
-- invite's person afterwards.
create or replace function public.apply_invite_member_link(p_invite_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invite public.family_invites;
  v_rows integer;
begin
  select * into v_invite
  from public.family_invites i
  where i.id = p_invite_id;

  if not found
     or v_invite.status not in ('redeemed', 'approved')
     or v_invite.redeemed_by is null
     or v_invite.family_member_id is null then
    return false;
  end if;

  if not public.is_linkable_family_member(v_invite.family_member_id) then
    return false;
  end if;

  begin
    update public.family_memberships
    set family_member_id = v_invite.family_member_id
    where family_id = v_invite.family_id
      and user_id = v_invite.redeemed_by
      and family_member_id is null
      and not_in_list = false;
    get diagnostics v_rows = row_count;
  exception when unique_violation then
    -- Another account claimed this person first.
    return false;
  end;

  if v_rows > 0 then
    return true;
  end if;

  -- Idempotent retry: a resolve that failed after linking and is approved
  -- again finds the account already linked to this very person, which is the
  -- desired end state, so report it as linked.
  return exists (
    select 1 from public.family_memberships fm
    where fm.family_id = v_invite.family_id
      and fm.user_id = v_invite.redeemed_by
      and fm.family_member_id = v_invite.family_member_id
  );
end;
$$;

revoke all on function public.apply_invite_member_link(uuid) from public, anon, authenticated;
grant execute on function public.apply_invite_member_link(uuid) to service_role;

comment on function public.apply_invite_member_link(uuid) is
  'Service role only (resolve-family-invite). Links the redeemer''s membership to the invite''s family_member_id when the invite is redeemed/approved, the person is still linkable and unclaimed, and the membership has no link and is not flagged not_in_list. Returns true when the account ends up linked to the invite''s person (including an idempotent retry), false when the link was skipped; never raises for a skipped link.';
