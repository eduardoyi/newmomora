-- WP-SEC item 5 (docs/plans/onboarding-implementation.md, "WP-SEC --
-- Anonymous authorization lockdown"): a scheduled cleanup for abandoned
-- anonymous Auth users, added alongside 20260729130000's lockdown rather
-- than deferred to the "cleanup cron" follow-up. On review, the owner's
-- item 1-6 list is the enumerated pre-condition for
-- `enable_anonymous_sign_ins = true`, and cleanup was not part of the
-- carve-out (only IP/device limits and Turnstile were) -- usage-limits.md
-- deferring cleanup *scheduling* from ITS OWN package's scope does not
-- remove it from this one.
--
-- "Abandoned" = an anonymous Auth user (`is_anonymous = true`) whose
-- `auth.users.created_at` is older than a conservative TTL and who has
-- never done anything that would give them real content. Two things make
-- this safe and cheap, both already true after 20260729130000:
--   * `handle_new_user` never creates a `user_profiles` row for an
--     anonymous user, so there is nothing to cascade except the AI-usage
--     ledger's own `on delete set null` FKs (already tested in
--     supabase/tests/usage_limits_onboarding.sql).
--   * The RESTRICTIVE anonymous-deny RLS + the guarded SECURITY DEFINER
--     RPCs mean an anonymous user can never legitimately own a family or
--     hold a family_memberships row.
--
-- The second point is exactly the kind of invariant a maintenance cron must
-- never quietly trust -- if it were ever violated (a lockdown regression),
-- deleting that Auth row would CASCADE DELETE a real family
-- (`families.owner_id references auth.users on delete cascade`). So the
-- candidate query below excludes anyone with any real membership/ownership
-- row outright, as an independent safety net alongside the Edge Function's
-- own second look (getUserById + a fresh membership/ownership check)
-- immediately before every delete -- see
-- supabase/functions/cleanup-abandoned-anonymous-users/index.ts. If that
-- second look ever finds one, the function skips and logs loudly rather
-- than deleting.
create or replace function public.get_abandoned_anonymous_auth_user_ids(p_older_than timestamptz)
returns table (
  id uuid,
  created_at timestamptz
)
language sql
security definer
stable
set search_path = public
as $$
  select au.id, au.created_at
  from auth.users au
  where au.is_anonymous is true
    and au.created_at < p_older_than
    and not exists (
      select 1 from public.family_memberships fm where fm.user_id = au.id
    )
    and not exists (
      select 1 from public.families f where f.owner_id = au.id
    )
  order by au.created_at
$$;

revoke all on function public.get_abandoned_anonymous_auth_user_ids(timestamptz) from public, anon, authenticated;
grant execute on function public.get_abandoned_anonymous_auth_user_ids(timestamptz) to service_role;
