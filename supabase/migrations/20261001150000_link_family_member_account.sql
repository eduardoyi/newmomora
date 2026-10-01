-- Manager-linked "this is me" (docs/plans/manager-account-linking.md, §3).
--
-- An owner/manager can link an already-joined account to a person in the
-- Family list (today only the account itself can, via set_my_family_member /
-- Who's who; a manager could only unlink). Identity metadata, not a role
-- change: any active member of the family can be linked, including the owner
-- and the caller. Additive: one new function, no table or grant changes.
--
-- family_memberships has an immutable-columns trigger
-- (enforce_membership_immutable_columns), but it only guards user_id and
-- family_id, so writing family_member_id / not_in_list needs no extra handling.

create or replace function public.link_family_member_account(
  p_family_id uuid,
  p_user_id uuid,
  p_member_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Definers bypass the RLS-only anonymous lockdown (same guard as
  -- set_my_family_member / unlink_family_member_account).
  if auth.uid() is null or public.is_anonymous_user() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  if not public.has_family_role(p_family_id, array['owner', 'manager']) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  -- The target account must be an active member of THIS family (a removed
  -- member has no family_memberships row).
  if not exists (
    select 1
    from public.family_memberships fm
    where fm.family_id = p_family_id and fm.user_id = p_user_id
  ) then
    raise exception 'account_not_in_family'
      using errcode = '22023',
            hint = 'account_not_in_family';
  end if;

  if not exists (
    select 1
    from public.family_members m
    where m.id = p_member_id and m.family_id = p_family_id
  ) then
    raise exception 'member_not_in_family'
      using errcode = '22023',
            hint = 'member_not_in_family';
  end if;

  -- Kids and pets can't be an account (same rule as set_my_family_member).
  if not public.is_linkable_family_member(p_member_id) then
    raise exception 'member_not_linkable'
      using errcode = '22023',
            hint = 'member_not_linkable';
  end if;

  begin
    -- Replaces any previous link of this account and clears "not in the
    -- list". Linking a person to the account that already holds them is a
    -- no-op success; a person held by a DIFFERENT account trips the
    -- one-account-per-person unique index (never stolen).
    update public.family_memberships
    set family_member_id = p_member_id,
        not_in_list = false
    where family_id = p_family_id and user_id = p_user_id;
  exception when unique_violation then
    raise exception 'member_already_linked'
      using errcode = '23505',
            hint = 'member_already_linked';
  end;
end;
$$;

revoke all on function public.link_family_member_account(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.link_family_member_account(uuid, uuid, uuid) to authenticated;

comment on function public.link_family_member_account(uuid, uuid, uuid) is
  'Owner/manager links an active member''s account to a family person ("this is me", set for them): replaces any previous link and clears not_in_list. Any active member, including the owner and the caller. Never steals a person held by another account. Not billing-gated: account metadata. Errors (message equals token): 42501 Not authorized; 22023 account_not_in_family / member_not_in_family / member_not_linkable; 23505 member_already_linked.';
