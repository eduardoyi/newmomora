-- Supabase CLI 2.110's fresh local bootstrap does not grant DML privileges
-- on application tables to the `authenticated` role. RLS policies alone do
-- not grant table access, so a normal signed-in user receives 42501 before a
-- policy can permit their own family row. Make the client-facing surface
-- explicit instead of relying on bootstrap defaults that differ by CLI age.
--
-- Deliberately do not grant anything on usage/ledger, workflow, rate-limit,
-- report-operator, or other internal tables. Those remain service-only or
-- RPC-only. The unauthenticated `anon` role has no direct table access; an
-- anonymous onboarding session uses `authenticated` and is still denied by
-- the restrictive anonymous RLS policies from 20260729130000.

revoke all on table
  public.user_profiles,
  public.families,
  public.family_memberships,
  public.family_members,
  public.memories,
  public.memory_family_members,
  public.memory_media,
  public.memory_likes,
  public.memory_comments,
  public.family_invites,
  public.family_member_portrait_versions
from anon;

grant select, update on table public.user_profiles to authenticated;

grant select, update, delete on table public.families to authenticated;
grant select, update, delete on table public.family_memberships to authenticated;
grant select, update on table public.family_invites to authenticated;

grant select, insert, update, delete on table public.family_members to authenticated;
grant select, insert, update, delete on table public.memories to authenticated;
grant select, insert, delete on table public.memory_family_members to authenticated;
grant select, insert, update, delete on table public.memory_media to authenticated;
grant select, insert, delete on table public.memory_likes to authenticated;
grant select, insert, delete on table public.memory_comments to authenticated;

grant select on table public.family_member_portrait_versions to authenticated;
