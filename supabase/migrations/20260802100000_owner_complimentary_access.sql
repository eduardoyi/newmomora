-- Owner-wide complimentary access.
--
-- This is intentionally separate from RevenueCat's entitlement ledger:
-- store reconciliation is allowed to replace owner_entitlements, while a
-- complimentary grant is an operator-owned Momora policy decision.

create table public.owner_complimentary_access (
  owner_user_id uuid primary key references auth.users on delete cascade,
  expires_at timestamptz,
  note text,
  created_at timestamptz not null default now()
);

-- Complimentary access is server/operator metadata.  There are no client
-- policies and no client table privileges; the security-definer billing
-- helpers below are the only application access path.
alter table public.owner_complimentary_access enable row level security;
revoke all on public.owner_complimentary_access from public, anon, authenticated;

create or replace function public.owner_has_billing_access(
  p_owner_user_id uuid,
  p_now timestamptz default transaction_timestamp()
)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.owner_complimentary_access c
    where c.owner_user_id = p_owner_user_id
      and (c.expires_at is null or c.expires_at > p_now)
  )
  or exists (
    select 1
    from public.owner_entitlements e
    cross join public.billing_settings s
    where e.owner_user_id = p_owner_user_id
      and s.singleton
      and (e.environment = 'production' or (e.environment = 'sandbox' and s.allow_sandbox_access))
      and e.status in ('active', 'trial', 'grace')
      and e.expires_at is not null
      and (e.expires_at > p_now or (e.grace_until is not null and e.grace_until > p_now))
  );
$$;

create or replace function public.get_family_billing_status(p_family_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_owner_id uuid;
  v_grace_until timestamptz;
  v_mode text;
  v_cutover timestamptz;
  v_min_version text;
  v_allow_sandbox boolean;
  v_entitlement public.owner_entitlements%rowtype;
  v_has_ever_had_access boolean;
  v_has_complimentary_access boolean;
  v_has_paid_access boolean;
  v_has_access boolean;
  v_applies boolean;
  v_reason text;
begin
  if auth.uid() is null then
    raise exception 'Unauthorized' using errcode = '28000';
  end if;

  select f.owner_id, f.billing_grace_until
  into v_owner_id, v_grace_until
  from public.families f
  join public.family_memberships fm on fm.family_id = f.id
  where f.id = p_family_id
    and fm.user_id = auth.uid()
    and f.deleted_at is null;

  if v_owner_id is null then
    raise exception 'Family not found' using errcode = 'P0002';
  end if;

  select enforcement_mode, new_family_cutover_at, min_supported_app_version, allow_sandbox_access
  into v_mode, v_cutover, v_min_version, v_allow_sandbox
  from public.billing_settings
  where singleton;

  select e.* into v_entitlement
  from public.owner_entitlements e
  where e.owner_user_id = v_owner_id
    and (e.environment = 'production' or (e.environment = 'sandbox' and v_allow_sandbox))
  order by
    case when e.status in ('active', 'trial', 'grace') then 0 else 1 end,
    e.expires_at desc nulls last,
    e.updated_at desc
  limit 1;

  v_has_ever_had_access := exists (
    select 1 from public.owner_entitlements
    where owner_user_id = v_owner_id
      and (environment = 'production' or (environment = 'sandbox' and v_allow_sandbox))
  );
  v_has_complimentary_access := exists (
    select 1
    from public.owner_complimentary_access
    where owner_user_id = v_owner_id
      and (expires_at is null or expires_at > transaction_timestamp())
  );
  v_has_paid_access := exists (
    select 1
    from public.owner_entitlements e
    where e.owner_user_id = v_owner_id
      and (e.environment = 'production' or (e.environment = 'sandbox' and v_allow_sandbox))
      and e.status in ('active', 'trial', 'grace')
      and e.expires_at is not null
      and (e.expires_at > transaction_timestamp()
        or (e.grace_until is not null and e.grace_until > transaction_timestamp()))
  );
  v_has_access := public.owner_has_billing_access(v_owner_id);
  v_applies := public.billing_mode_applies(p_family_id);

  if v_has_paid_access then
    v_reason := coalesce(v_entitlement.status, 'active');
  elsif v_has_complimentary_access then
    v_reason := 'complimentary';
  elsif not v_applies then
    v_reason := 'legacy_grace';
  elsif v_grace_until is not null and v_grace_until > transaction_timestamp() then
    v_reason := 'billing_grace';
  else
    v_reason := 'expired';
  end if;

  return jsonb_build_object(
    'family_id', p_family_id,
    'owner_user_id', v_owner_id,
    'has_write_access', (not v_applies) or v_has_access
      or (v_grace_until is not null and v_grace_until > transaction_timestamp()),
    -- This field continues to describe store entitlement history.  A
    -- complimentary grant is represented explicitly by access_reason and
    -- must not be mistaken for a RevenueCat subscription or trial.
    'has_ever_had_access', v_has_ever_had_access,
    'trial_eligible', not v_has_ever_had_access,
    'access_reason', v_reason,
    'period_type', case when v_has_complimentary_access and not v_has_paid_access then null else nullif(v_entitlement.period_type, 'unknown') end,
    'expires_at', case when v_has_complimentary_access and not v_has_paid_access then null else v_entitlement.expires_at end,
    'grace_until', case
      when v_has_complimentary_access and not v_has_paid_access then null
      when v_entitlement.grace_until is not null
        and v_entitlement.grace_until > transaction_timestamp()
      then v_entitlement.grace_until
      else v_grace_until
    end,
    'will_renew', case when v_has_complimentary_access and not v_has_paid_access then false else coalesce(v_entitlement.will_renew, false) end,
    'management_url', case when v_has_complimentary_access and not v_has_paid_access then null else v_entitlement.management_url end,
    'enforcement_mode', v_mode,
    'sandbox_access_enabled', coalesce(v_allow_sandbox, false),
    'new_family_cutover_at', v_cutover,
    'min_supported_app_version', v_min_version
  );
end;
$$;

revoke all on function public.owner_has_billing_access(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.get_family_billing_status(uuid) from public, anon;
grant execute on function public.get_family_billing_status(uuid) to authenticated;
