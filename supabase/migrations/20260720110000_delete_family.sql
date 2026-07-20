-- Owner-initiated family deletion (soft delete), exposed as a
-- security-definer RPC so an owner can retire one of several families they
-- belong to (see docs/features/family-sharing.md: a user may own up to 5
-- families) from inside the app, not just via full account deletion.
--
-- Mirrors delete-user-account's per-family cleanup
-- (`softDeleteOwnedFamiliesAndNotify` in
-- supabase/functions/delete-user-account/index.ts): the only side effect is
-- `families.deleted_at = now()`. That single column flip is already
-- sufficient to cut off the rest of the family's surface area, so there is
-- no separate invite-revocation step here:
--   * `is_family_member`/`has_family_role` (20260711120000_family_sharing.sql
--     §4) both require `f.deleted_at is null or f.owner_id = auth.uid()`, so
--     every non-owner loses membership/role visibility (and therefore RLS
--     access to family_invites, memories, family_members, ...) the moment
--     this flips.
--   * redeem-family-invite explicitly rejects `family.deleted_at` truthy
--     with the same generic `invalid_code` error used for expired/revoked
--     codes, so pending invites for this family stop working without being
--     individually updated.
-- Unlike account deletion, this RPC does not push a "you lost access"
-- notification -- MVP scope; other members discover the loss via the
-- existing justLostAccess flow (src/hooks/use-family.tsx) next time they
-- load.
create or replace function public.delete_family(fam uuid)
returns public.families
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  target_owner_id uuid;
  updated_family public.families;
begin
  if current_user_id is null then
    raise exception 'Unauthorized' using errcode = '28000';
  end if;

  select owner_id into target_owner_id
  from public.families
  where id = fam
    and deleted_at is null;

  if target_owner_id is null then
    raise exception 'Family not found' using errcode = 'P0002';
  end if;

  if target_owner_id <> current_user_id then
    raise exception 'Only the family owner can delete this family' using errcode = '42501';
  end if;

  update public.families
  set deleted_at = now()
  where id = fam
  returning * into updated_family;

  return updated_family;
end;
$$;
