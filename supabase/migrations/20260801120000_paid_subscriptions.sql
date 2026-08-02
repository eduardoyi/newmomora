-- Momora paid subscriptions.
--
-- RevenueCat is the store-facing source of truth, but the application never
-- gates writes from the mobile client alone.  This migration keeps a small,
-- normalized entitlement ledger in Supabase, queues webhook facts durably,
-- and makes the family owner the billing principal for every family they own.

alter table public.families
  add column if not exists billing_grace_until timestamptz;

alter table public.memories
  add column if not exists onboarding_attributed boolean not null default false;

update public.families
set billing_grace_until = coalesce(
  billing_grace_until,
  greatest(created_at + interval '30 days', transaction_timestamp() + interval '30 days')
)
where billing_grace_until is null;

alter table public.memories
  drop constraint if exists memories_type_invariants,
  add constraint memories_type_invariants check (
    (memory_type = 'text_illustration' and content is not null and media_key is null)
    or (memory_type = 'text_only' and content is not null and media_key is null)
    or (memory_type = 'media' and media_key is not null and media_content_type is not null and illustration_status = 'none')
    or (memory_type = 'media' and onboarding_attributed = true and media_key is null and media_content_type is null and illustration_status = 'none')
  );

create table public.billing_settings (
  singleton boolean primary key default true check (singleton),
  enforcement_mode text not null default 'all_families'
    check (enforcement_mode in ('off', 'new_families', 'all_families')),
  allow_sandbox_access boolean not null default false,
  new_family_cutover_at timestamptz not null default transaction_timestamp(),
  owner_ai_requests_per_day integer not null default 20 check (owner_ai_requests_per_day > 0),
  owner_ai_requests_per_month integer not null default 100 check (owner_ai_requests_per_month > 0),
  min_supported_app_version text not null default '1.2.0',
  apple_grace_days integer not null default 16 check (apple_grace_days between 0 and 30),
  google_grace_days integer not null default 14 check (google_grace_days between 0 and 30),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users on delete set null
);

insert into public.billing_settings (singleton)
values (true)
on conflict (singleton) do nothing;

create table public.billing_products (
  store text not null check (store in ('app_store', 'play_store')),
  product_id text not null,
  entitlement_id text not null default 'momora_plus',
  period_type text not null check (period_type in ('monthly', 'annual')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (store, product_id)
);

insert into public.billing_products (store, product_id, period_type)
values
  ('app_store', 'momora_annual_v1', 'annual'),
  ('app_store', 'momora_monthly_v1', 'monthly'),
  ('play_store', 'momora:annual', 'annual'),
  ('play_store', 'momora:monthly', 'monthly')
on conflict (store, product_id) do update
set entitlement_id = excluded.entitlement_id,
    period_type = excluded.period_type,
    active = true;

create table public.owner_entitlements (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users on delete cascade,
  app_user_id text not null,
  environment text not null check (environment in ('production', 'sandbox')),
  store text not null check (store in ('app_store', 'play_store')),
  product_id text not null,
  entitlement_id text not null,
  period_type text not null check (period_type in ('monthly', 'annual', 'unknown')),
  status text not null check (status in ('active', 'trial', 'grace', 'expired', 'refunded', 'paused')),
  purchased_at timestamptz,
  expires_at timestamptz,
  grace_until timestamptz,
  will_renew boolean not null default false,
  original_transaction_id text,
  transaction_id text,
  management_url text,
  last_event_id text,
  last_event_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_user_id, environment, store, product_id)
);

create index owner_entitlements_owner_status_idx
  on public.owner_entitlements (owner_user_id, environment, status, expires_at);

create table public.billing_owner_locks (
  owner_user_id uuid primary key references auth.users on delete cascade,
  created_at timestamptz not null default now()
);

create table public.billing_webhook_events (
  event_id text primary key,
  store text not null check (store in ('app_store', 'play_store', 'unknown')),
  environment text not null check (environment in ('production', 'sandbox', 'unknown')),
  event_type text not null,
  event_at timestamptz not null default now(),
  app_user_id text,
  owner_user_id uuid references auth.users on delete set null,
  product_id text,
  entitlement_id text,
  period_type text,
  purchased_at timestamptz,
  expires_at timestamptz,
  grace_until timestamptz,
  will_renew boolean,
  original_transaction_id text,
  transaction_id text,
  management_url text,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'processed', 'dead_letter')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error text,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index billing_webhook_events_ready_idx
  on public.billing_webhook_events (status, next_attempt_at, created_at);

create table public.billing_dead_letters (
  id uuid primary key default gen_random_uuid(),
  event_id text unique,
  reason text not null,
  store text,
  environment text,
  event_type text,
  app_user_id text,
  product_id text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table public.billing_trial_reminder_outbox (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users on delete cascade,
  entitlement_id uuid not null references public.owner_entitlements on delete cascade,
  channel text not null check (channel in ('email', 'push')),
  due_at timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  claim_token uuid,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (entitlement_id, channel)
);

create table public.onboarding_commits (
  commit_id uuid primary key,
  user_id uuid not null references auth.users on delete cascade,
  family_id uuid not null references public.families on delete cascade,
  memory_id uuid references public.memories on delete set null,
  is_new_family boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.billing_settings enable row level security;
alter table public.billing_products enable row level security;
alter table public.owner_entitlements enable row level security;
alter table public.billing_owner_locks enable row level security;
alter table public.billing_webhook_events enable row level security;
alter table public.billing_dead_letters enable row level security;
alter table public.billing_trial_reminder_outbox enable row level security;
alter table public.onboarding_commits enable row level security;

revoke all on public.billing_settings from anon, authenticated;
revoke all on public.billing_products from anon, authenticated;
revoke all on public.owner_entitlements from anon, authenticated;
revoke all on public.billing_owner_locks from anon, authenticated;
revoke all on public.billing_webhook_events from anon, authenticated;
revoke all on public.billing_dead_letters from anon, authenticated;
revoke all on public.billing_trial_reminder_outbox from anon, authenticated;
revoke all on public.onboarding_commits from anon, authenticated;

create or replace function public.billing_mode_applies(p_family_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select case
    when s.enforcement_mode = 'off' then false
    when s.enforcement_mode = 'new_families'
      and f.created_at < s.new_family_cutover_at then false
    else true
  end
  from public.families f
  cross join public.billing_settings s
  where f.id = p_family_id and s.singleton;
$$;

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
    from public.owner_entitlements e
    cross join public.billing_settings s
    where e.owner_user_id = p_owner_user_id
      and s.singleton
      and (
        e.environment = 'production'
        or (e.environment = 'sandbox' and s.allow_sandbox_access)
      )
      and e.status in ('active', 'trial', 'grace')
      and (
        e.expires_at is null
        or e.expires_at > p_now
        or (e.grace_until is not null and e.grace_until > p_now)
      )
  );
$$;

create or replace function public.billing_write_allowed(
  p_family_id uuid,
  p_actor_user_id uuid
)
returns boolean
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_owner_id uuid;
  v_grace_until timestamptz;
begin
  select owner_id, billing_grace_until
  into v_owner_id, v_grace_until
  from public.families
  where id = p_family_id and deleted_at is null;

  if v_owner_id is null then
    return false;
  end if;

  if not exists (
    select 1 from public.family_memberships
    where family_id = p_family_id
      and user_id = p_actor_user_id
      and role in ('owner', 'manager')
  ) then
    return false;
  end if;

  if not public.billing_mode_applies(p_family_id) then
    return true;
  end if;

  return public.owner_has_billing_access(v_owner_id)
    or (v_grace_until is not null and v_grace_until > transaction_timestamp());
end;
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
    and (
      e.environment = 'production'
      or (e.environment = 'sandbox' and v_allow_sandbox)
    )
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
  v_has_access := public.owner_has_billing_access(v_owner_id);
  v_applies := public.billing_mode_applies(p_family_id);

  if not v_applies then
    v_reason := 'legacy_grace';
  elsif v_has_access then
    v_reason := coalesce(v_entitlement.status, 'active');
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
    'has_ever_had_access', v_has_ever_had_access,
    'trial_eligible', not v_has_ever_had_access,
    'access_reason', v_reason,
    'period_type', nullif(v_entitlement.period_type, 'unknown'),
    'expires_at', v_entitlement.expires_at,
    'grace_until', case
      when v_entitlement.grace_until is not null
        and v_entitlement.grace_until > transaction_timestamp()
      then v_entitlement.grace_until
      else v_grace_until
    end,
    'will_renew', coalesce(v_entitlement.will_renew, false),
    'management_url', v_entitlement.management_url,
    'enforcement_mode', v_mode,
    'sandbox_access_enabled', coalesce(v_allow_sandbox, false),
    'new_family_cutover_at', v_cutover,
    'min_supported_app_version', v_min_version
  );
end;
$$;

create or replace function public.assert_billing_write_access(
  p_family_id uuid,
  p_actor_user_id uuid,
  p_operation text default 'write'
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.billing_write_allowed(p_family_id, p_actor_user_id) then
    raise exception 'Subscription required for this family write' using
      errcode = 'P0001',
      detail = p_operation;
  end if;
  return true;
end;
$$;

create or replace function public.billing_owner_ai_limit_scope(
  p_family_id uuid,
  p_now timestamptz default transaction_timestamp()
)
returns text
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_owner_id uuid;
  v_day date := (p_now at time zone 'UTC')::date;
  v_month date := date_trunc('month', p_now at time zone 'UTC')::date;
  v_daily_limit integer;
  v_monthly_limit integer;
  v_daily_count integer;
  v_monthly_count integer;
begin
  if not public.billing_mode_applies(p_family_id) then
    return null;
  end if;

  select owner_id into v_owner_id from public.families where id = p_family_id;
  if v_owner_id is null then return null; end if;

  select owner_ai_requests_per_day, owner_ai_requests_per_month
  into v_daily_limit, v_monthly_limit
  from public.billing_settings where singleton;

  select count(*) into v_monthly_count
  from public.ai_image_generation_admissions a
  join public.ai_image_generation_requests r on r.id = a.request_id
  join public.families f on f.id = r.family_id
  left join public.memories m on r.target_kind = 'memory' and m.id = r.target_id
  where f.owner_id = v_owner_id
    and a.utc_month = v_month
    and (a.state = 'consumed' or (a.state = 'active' and a.reserved_until > p_now))
    and coalesce(m.onboarding_attributed, false) = false;

  if v_monthly_count >= v_monthly_limit then
    return 'monthly';
  end if;

  select count(*) into v_daily_count
  from public.ai_image_generation_admissions a
  join public.ai_image_generation_requests r on r.id = a.request_id
  join public.families f on f.id = r.family_id
  left join public.memories m on r.target_kind = 'memory' and m.id = r.target_id
  where f.owner_id = v_owner_id
    and a.utc_day = v_day
    and (a.state = 'consumed' or (a.state = 'active' and a.reserved_until > p_now))
    and coalesce(m.onboarding_attributed, false) = false;

  if v_daily_count >= v_daily_limit then
    return 'daily';
  end if;

  return null;
end;
$$;

create or replace function public.billing_ai_generation_check(
  p_family_id uuid,
  p_actor_user_id uuid,
  p_target_kind text,
  p_target_id uuid,
  p_request_intent text
)
returns table (allowed boolean, scope text, retry_after_iso timestamptz, error_code text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id uuid;
  v_scope text;
  v_now timestamptz := transaction_timestamp();
begin
  if not public.billing_write_allowed(p_family_id, p_actor_user_id) then
    return query select false, null::text, null::timestamptz, 'SUBSCRIPTION_REQUIRED';
    return;
  end if;

  select owner_id into v_owner_id from public.families where id = p_family_id;
  if v_owner_id is null then
    return query select false, null::text, null::timestamptz, 'FAMILY_NOT_FOUND';
    return;
  end if;

  insert into public.billing_owner_locks (owner_user_id)
  values (v_owner_id)
  on conflict (owner_user_id) do nothing;
  perform 1 from public.billing_owner_locks where owner_user_id = v_owner_id for update;

  -- The first text illustration is part of the paid onboarding hand-off and
  -- is explicitly exempt from the owner fair-use pool.  Its generation still
  -- requires active access because this function checks billing first.
  if p_target_kind = 'memory' and exists (
    select 1 from public.memories
    where id = p_target_id and onboarding_attributed
  ) then
    return query select true, null::text, null::timestamptz, null::text;
    return;
  end if;

  v_scope := public.billing_owner_ai_limit_scope(p_family_id, v_now);
  if v_scope is not null then
    return query select false,
      v_scope,
      case v_scope
        when 'daily' then ((v_now at time zone 'UTC')::date + 1)::timestamp at time zone 'UTC'
        else (date_trunc('month', v_now at time zone 'UTC') + interval '1 month')::timestamp at time zone 'UTC'
      end,
      'OWNER_AI_LIMIT_REACHED';
    return;
  end if;

  return query select true, null::text, null::timestamptz, null::text;
end;
$$;

create or replace function public.enqueue_billing_trial_reminders(
  p_now timestamptz default transaction_timestamp()
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
  e public.owner_entitlements%rowtype;
begin
  for e in
    select * from public.owner_entitlements
    where environment = 'production'
      and status in ('active', 'trial')
      and expires_at is not null
      and expires_at between p_now + interval '47 hours' and p_now + interval '49 hours'
  loop
    insert into public.billing_trial_reminder_outbox (owner_user_id, entitlement_id, channel, due_at)
    values (e.owner_user_id, e.id, 'email', e.expires_at - interval '48 hours'),
           (e.owner_user_id, e.id, 'push', e.expires_at - interval '48 hours')
    on conflict (entitlement_id, channel) do nothing;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create or replace function public.expire_billing_entitlements(
  p_now timestamptz default transaction_timestamp()
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer;
begin
  update public.owner_entitlements
  set status = case
      when grace_until is not null and grace_until > p_now then 'grace'
      else 'expired'
    end,
    updated_at = p_now
  where environment = 'production'
    and status in ('active', 'trial', 'grace', 'paused')
    and expires_at is not null
    and expires_at <= p_now
    and (grace_until is null or grace_until <= p_now);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.queue_billing_webhook_event(
  p_event_id text,
  p_store text,
  p_environment text,
  p_event_type text,
  p_event_at timestamptz,
  p_app_user_id text,
  p_product_id text,
  p_entitlement_id text,
  p_period_type text,
  p_purchased_at timestamptz,
  p_expires_at timestamptz,
  p_grace_until timestamptz,
  p_will_renew boolean,
  p_original_transaction_id text,
  p_transaction_id text,
  p_management_url text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id uuid;
  v_reason text;
  v_known_product boolean;
begin
  if p_event_id is null or length(trim(p_event_id)) = 0 then
    raise exception 'event id is required' using errcode = '22023';
  end if;

  if p_app_user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    v_owner_id := p_app_user_id::uuid;
  end if;

  v_known_product := exists (
    select 1 from public.billing_products
    where store = p_store and product_id = p_product_id and active
  );

  if v_owner_id is null then
    v_reason := 'unknown_account';
  elsif not exists (select 1 from auth.users where id = v_owner_id) then
    v_reason := 'unknown_account';
  elsif p_environment not in ('production', 'sandbox') then
    v_reason := 'unknown_environment';
  elsif not v_known_product then
    v_reason := 'unsupported_product';
  elsif p_event_type not in (
    'TEST', 'INITIAL_PURCHASE', 'NON_RENEWING_PURCHASE', 'RENEWAL',
    'CANCELLATION', 'UNCANCELLATION', 'BILLING_ISSUE', 'SUBSCRIBER_ALIAS',
    'SUBSCRIPTION_PAUSED', 'SUBSCRIPTION_EXTENDED', 'EXPIRATION', 'PRODUCT_CHANGE',
    'TRANSFER', 'REFUND', 'REFUND_REVERSED', 'TEMPORARY_ENTITLEMENT_GRANT',
    'VIRTUAL_CURRENCY_TRANSACTION', 'INVOICE_ISSUANCE'
  ) then
    v_reason := 'unsupported_event';
  end if;

  if v_reason is not null then
    insert into public.billing_dead_letters (event_id, reason, store, environment, event_type, app_user_id, product_id)
    values (p_event_id, v_reason, p_store, p_environment, p_event_type, p_app_user_id, p_product_id)
    on conflict (event_id) do nothing;
    insert into public.billing_webhook_events (
      event_id, store, environment, event_type, event_at, app_user_id, owner_user_id,
      product_id, entitlement_id, period_type, status, last_error
    ) values (
      p_event_id, coalesce(p_store, 'unknown'), coalesce(p_environment, 'unknown'),
      coalesce(p_event_type, 'unknown'), coalesce(p_event_at, transaction_timestamp()), p_app_user_id, v_owner_id, p_product_id,
      p_entitlement_id, p_period_type, 'dead_letter', v_reason
    ) on conflict (event_id) do nothing;
    return jsonb_build_object('status', 'dead_letter', 'reason', v_reason);
  end if;

  insert into public.billing_webhook_events (
    event_id, store, environment, event_type, event_at, app_user_id, owner_user_id,
    product_id, entitlement_id, period_type, purchased_at, expires_at, grace_until,
    will_renew, original_transaction_id, transaction_id, management_url
  ) values (
    p_event_id, p_store, p_environment, p_event_type, coalesce(p_event_at, transaction_timestamp()), p_app_user_id, v_owner_id,
    p_product_id, coalesce(p_entitlement_id, 'momora_plus'), p_period_type,
    p_purchased_at, p_expires_at, p_grace_until, p_will_renew,
    p_original_transaction_id, p_transaction_id, p_management_url
  ) on conflict (event_id) do nothing;

  return jsonb_build_object('status', 'queued');
end;
$$;

create or replace function public.apply_billing_webhook_event(p_event_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.billing_webhook_events%rowtype;
  v_status text;
  v_period text;
begin
  select * into e from public.billing_webhook_events where event_id = p_event_id for update;
  if not found then return jsonb_build_object('status', 'missing'); end if;
  if e.status = 'processed' then return jsonb_build_object('status', 'processed'); end if;
  if e.status = 'dead_letter' then return jsonb_build_object('status', 'dead_letter'); end if;
  if e.owner_user_id is null then
    update public.billing_webhook_events
    set status = 'dead_letter', last_error = 'unknown_account', updated_at = now()
    where event_id = p_event_id;
    return jsonb_build_object('status', 'dead_letter', 'reason', 'unknown_account');
  end if;

  insert into public.billing_owner_locks (owner_user_id) values (e.owner_user_id)
  on conflict (owner_user_id) do nothing;
  perform 1 from public.billing_owner_locks where owner_user_id = e.owner_user_id for update;

  v_status := case
    when e.event_type in ('EXPIRATION', 'REFUND') then 'expired'
    when e.event_type = 'REFUND_REVERSED' then 'active'
    when e.event_type in ('BILLING_ISSUE', 'SUBSCRIPTION_PAUSED') then 'grace'
    else case when lower(coalesce(e.period_type, '')) in ('trial', 'intro') then 'trial' else 'active' end
  end;
  v_period := case
    when e.product_id in ('momora_annual_v1', 'momora:annual') then 'annual'
    when e.product_id in ('momora_monthly_v1', 'momora:monthly') then 'monthly'
    else 'unknown'
  end;

  insert into public.owner_entitlements (
    owner_user_id, app_user_id, environment, store, product_id, entitlement_id,
    period_type, status, purchased_at, expires_at, grace_until, will_renew,
    original_transaction_id, transaction_id, management_url, last_event_id, last_event_at
  ) values (
    e.owner_user_id, coalesce(e.app_user_id, e.owner_user_id::text), e.environment,
    case when e.store = 'play_store' then 'play_store' else 'app_store' end,
    e.product_id, coalesce(e.entitlement_id, 'momora_plus'), v_period, v_status,
    e.purchased_at, e.expires_at, e.grace_until, coalesce(e.will_renew, false),
    e.original_transaction_id, e.transaction_id, e.management_url, e.event_id, e.event_at
  ) on conflict (owner_user_id, environment, store, product_id) do update set
    app_user_id = excluded.app_user_id,
    entitlement_id = excluded.entitlement_id,
    period_type = excluded.period_type,
    status = excluded.status,
    purchased_at = coalesce(excluded.purchased_at, owner_entitlements.purchased_at),
    expires_at = excluded.expires_at,
    grace_until = excluded.grace_until,
    will_renew = excluded.will_renew,
    original_transaction_id = coalesce(excluded.original_transaction_id, owner_entitlements.original_transaction_id),
    transaction_id = coalesce(excluded.transaction_id, owner_entitlements.transaction_id),
    management_url = coalesce(excluded.management_url, owner_entitlements.management_url),
    last_event_id = excluded.last_event_id,
    last_event_at = excluded.last_event_at,
    updated_at = now()
  where excluded.last_event_at >= owner_entitlements.last_event_at;

  update public.billing_webhook_events
  set status = 'processed', processed_at = now(), updated_at = now(), last_error = null
  where event_id = p_event_id;

  return jsonb_build_object('status', 'processed');
end;
$$;

create or replace function public.reconcile_billing_snapshot(
  p_owner_user_id uuid,
  p_environment text,
  p_entitlements jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  v_store text;
  v_product_id text;
  v_status text;
  v_period text;
begin
  if p_owner_user_id is null or p_environment not in ('production', 'sandbox') then
    raise exception 'Invalid billing snapshot' using errcode = '22023';
  end if;

  insert into public.billing_owner_locks (owner_user_id) values (p_owner_user_id)
  on conflict (owner_user_id) do nothing;
  perform 1 from public.billing_owner_locks where owner_user_id = p_owner_user_id for update;

  if jsonb_typeof(p_entitlements) <> 'array' then
    raise exception 'Billing snapshot must be an array' using errcode = '22023';
  end if;

  update public.owner_entitlements
  set status = 'expired', updated_at = now()
  where owner_user_id = p_owner_user_id
    and environment = p_environment
    and status in ('active', 'trial', 'grace');

  for item in select value from jsonb_array_elements(p_entitlements)
  loop
    v_product_id := item->>'product_id';
    v_store := case when item->>'store' in ('play_store', 'PLAY_STORE') then 'play_store' else 'app_store' end;
    if not exists (select 1 from public.billing_products where store = v_store and product_id = v_product_id and active) then
      continue;
    end if;
    v_status := case when lower(coalesce(item->>'period_type', '')) in ('trial', 'intro') then 'trial' else 'active' end;
    v_period := case when v_product_id in ('momora_annual_v1', 'momora:annual') then 'annual' else 'monthly' end;
    insert into public.owner_entitlements (
      owner_user_id, app_user_id, environment, store, product_id, entitlement_id,
      period_type, status, purchased_at, expires_at, grace_until, will_renew,
      original_transaction_id, transaction_id, management_url, last_event_id, last_event_at
    ) values (
      p_owner_user_id, p_owner_user_id::text, p_environment, v_store, v_product_id,
      coalesce(item->>'entitlement_id', 'momora_plus'), v_period, v_status,
      nullif(item->>'purchased_at', '')::timestamptz,
      nullif(item->>'expires_at', '')::timestamptz,
      nullif(item->>'grace_until', '')::timestamptz,
      coalesce((item->>'will_renew')::boolean, false),
      item->>'original_transaction_id', item->>'transaction_id', item->>'management_url',
      'reconcile:' || p_owner_user_id::text, now()
    ) on conflict (owner_user_id, environment, store, product_id) do update set
      entitlement_id = excluded.entitlement_id,
      period_type = excluded.period_type,
      status = excluded.status,
      purchased_at = excluded.purchased_at,
      expires_at = excluded.expires_at,
      grace_until = excluded.grace_until,
      will_renew = excluded.will_renew,
      original_transaction_id = excluded.original_transaction_id,
      transaction_id = excluded.transaction_id,
      management_url = excluded.management_url,
      last_event_id = excluded.last_event_id,
      last_event_at = excluded.last_event_at,
      updated_at = now();
  end loop;
  return true;
end;
$$;

-- The client can read only the computed status.  Ledger, queue and dead-letter
-- tables remain service-role-only.
revoke all on function public.get_family_billing_status(uuid) from public, anon;
grant execute on function public.get_family_billing_status(uuid) to authenticated;
revoke all on function public.queue_billing_webhook_event(text,text,text,text,timestamptz,text,text,text,text,timestamptz,timestamptz,timestamptz,boolean,text,text,text) from public, anon, authenticated;
grant execute on function public.queue_billing_webhook_event(text,text,text,text,timestamptz,text,text,text,text,timestamptz,timestamptz,timestamptz,boolean,text,text,text) to service_role;
revoke all on function public.apply_billing_webhook_event(text) from public, anon, authenticated;
grant execute on function public.apply_billing_webhook_event(text) to service_role;
revoke all on function public.reconcile_billing_snapshot(uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.reconcile_billing_snapshot(uuid,text,jsonb) to service_role;
revoke all on function public.expire_billing_entitlements(timestamptz) from public, anon, authenticated;
grant execute on function public.expire_billing_entitlements(timestamptz) to service_role;
revoke all on function public.enqueue_billing_trial_reminders(timestamptz) from public, anon, authenticated;
grant execute on function public.enqueue_billing_trial_reminders(timestamptz) to service_role;
revoke all on function public.billing_ai_generation_check(uuid,uuid,text,uuid,text) from public, anon, authenticated;
grant execute on function public.billing_ai_generation_check(uuid,uuid,text,uuid,text) to service_role;

-- First family + first capture commit.  R2 is intentionally outside this
-- transaction: media captures get a pending media memory row and the existing
-- background upload queue fills it after the caller has a real membership.
create or replace function public.commit_onboarding(
  p_commit_id uuid,
  p_family_name text,
  p_kid_names jsonb,
  p_capture jsonb,
  p_tagged_kid_indexes jsonb,
  p_memory_date date default current_date
)
returns public.onboarding_commits
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  existing_commit public.onboarding_commits;
  new_family public.families;
  new_memory public.memories;
  kid_record jsonb;
  kid_index integer := 0;
  tag_index integer;
  tag_member_id uuid;
  capture_text text;
  capture_has_media boolean;
  result public.onboarding_commits;
begin
  if current_user_id is null or public.is_anonymous_user() then
    raise exception 'A permanent account is required' using errcode = '42501';
  end if;
  if p_commit_id is null then
    raise exception 'Onboarding commit id is required' using errcode = '22023';
  end if;

  select * into existing_commit
  from public.onboarding_commits
  where commit_id = p_commit_id and user_id = current_user_id;
  if found then return existing_commit; end if;

  if jsonb_typeof(p_kid_names) <> 'array' or jsonb_array_length(p_kid_names) < 1 then
    raise exception 'At least one family member is required' using errcode = '22023';
  end if;
  if jsonb_array_length(p_kid_names) > 20 then
    raise exception 'Too many family members' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from jsonb_array_elements(p_kid_names) as kid(value)
    where nullif(trim(kid.value #>> '{}'), '') is not null
  ) then
    raise exception 'At least one family member is required' using errcode = '22023';
  end if;

  insert into public.families (owner_id, name, billing_grace_until)
  values (current_user_id, coalesce(nullif(trim(p_family_name), ''), 'Our Family'), null)
  returning * into new_family;

  insert into public.family_memberships (family_id, user_id, role)
  values (new_family.id, current_user_id, 'owner');

  update public.user_profiles
  set active_family_id = coalesce(active_family_id, new_family.id)
  where id = current_user_id;

  for kid_record in select value from jsonb_array_elements(p_kid_names)
  loop
    if nullif(trim(kid_record #>> '{}'), '') is not null then
      insert into public.family_members (family_id, user_id, name, date_of_birth)
      values (new_family.id, current_user_id, trim(kid_record #>> '{}'), null);
    end if;
    kid_index := kid_index + 1;
  end loop;

  select nullif(trim(coalesce(p_capture->>'text', '')), ''),
         coalesce((p_capture->>'hasMedia')::boolean, false)
  into capture_text, capture_has_media;

  if not capture_has_media
     and jsonb_typeof(p_tagged_kid_indexes) = 'array'
     and jsonb_array_length(p_tagged_kid_indexes) > 6 then
    raise exception 'Illustrated memories can tag at most 6 family members' using errcode = '22023';
  end if;

  if p_capture is not null and (capture_has_media or capture_text is not null) then
    insert into public.memories (
      user_id, family_id, content, memory_date, memory_type, illustration_status,
      onboarding_attributed
    ) values (
      current_user_id, new_family.id, capture_text, p_memory_date,
      case when capture_has_media then 'media' else 'text_illustration' end,
      case when capture_has_media then 'none' else 'pending' end,
      true
    ) returning * into new_memory;

    if jsonb_typeof(p_tagged_kid_indexes) = 'array' then
      for tag_index in select (value #>> '{}')::integer from jsonb_array_elements(p_tagged_kid_indexes)
      loop
        select id into tag_member_id
        from public.family_members
        where family_id = new_family.id
        order by created_at
        offset tag_index limit 1;
        if tag_member_id is not null then
          insert into public.memory_family_members (memory_id, family_member_id)
          values (new_memory.id, tag_member_id)
          on conflict do nothing;
        end if;
      end loop;
    end if;

    if not exists (select 1 from public.memory_family_members where memory_id = new_memory.id) then
      select id into tag_member_id from public.family_members
      where family_id = new_family.id order by created_at limit 1;
      if tag_member_id is not null then
        insert into public.memory_family_members (memory_id, family_member_id)
        values (new_memory.id, tag_member_id);
      end if;
    end if;
  end if;

  insert into public.onboarding_commits (commit_id, user_id, family_id, memory_id, is_new_family)
  values (p_commit_id, current_user_id, new_family.id, new_memory.id, true)
  returning * into result;
  return result;
end;
$$;

revoke all on function public.commit_onboarding(uuid,text,jsonb,jsonb,jsonb,date) from public, anon;
grant execute on function public.commit_onboarding(uuid,text,jsonb,jsonb,jsonb,date) to authenticated;

-- Recreate the family creator with the subscription-aware multi-family rule.
create or replace function public.create_family(name text)
returns public.families
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  owned_count integer;
  new_family public.families;
begin
  if current_user_id is null then raise exception 'Unauthorized' using errcode = '28000'; end if;
  if public.is_anonymous_user() then raise exception 'Anonymous accounts cannot create a family' using errcode = '42501'; end if;
  if name is null or trim(name) = '' then raise exception 'Family name is required' using errcode = '22023'; end if;

  select count(*) into owned_count from public.families
  where owner_id = current_user_id and deleted_at is null;
  if owned_count >= 5 then raise exception 'Maximum 5 owned families' using errcode = 'P0001'; end if;
  if owned_count > 0 and exists (
    select 1 from public.billing_settings where singleton and enforcement_mode <> 'off'
  ) and not public.owner_has_billing_access(current_user_id) then
    raise exception 'Subscription required to create another family' using errcode = 'P0001';
  end if;

  insert into public.families (owner_id, name, billing_grace_until)
  values (current_user_id, trim(name), null)
  returning * into new_family;
  insert into public.family_memberships (family_id, user_id, role)
  values (new_family.id, current_user_id, 'owner');
  update public.user_profiles set active_family_id = coalesce(active_family_id, new_family.id)
  where id = current_user_id;
  return new_family;
end;
$$;

revoke all on function public.create_family(text) from public, anon, authenticated;
grant execute on function public.create_family(text) to authenticated;

-- The existing invite RPC is redefined only to add the paid-family gate;
-- code generation and rate limiting remain unchanged in the earlier version.
create or replace function public.create_family_invite(fam uuid, invite_role text)
returns public.family_invites
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  new_code text;
  new_invite public.family_invites;
  attempt integer := 0;
begin
  if current_user_id is null or public.is_anonymous_user() then raise exception 'Unauthorized' using errcode = '42501'; end if;
  if invite_role not in ('manager', 'viewer') then raise exception 'Invalid invite role' using errcode = '22023'; end if;
  if not public.has_family_role(fam, array['owner', 'manager']) then raise exception 'Not authorized' using errcode = '42501'; end if;
  perform public.assert_billing_write_access(fam, current_user_id, 'invite');
  loop
    attempt := attempt + 1;
    select string_agg(word, '-') into new_code from (
      select word from public.invite_code_words order by random() limit 3
    ) picked;
    begin
      insert into public.family_invites (family_id, code, role, invited_by)
      values (fam, new_code, invite_role, current_user_id)
      returning * into new_invite;
      return new_invite;
    exception when unique_violation then
      if attempt >= 10 then raise exception 'Could not generate a unique invite code' using errcode = 'P0001'; end if;
    end;
  end loop;
end;
$$;

revoke all on function public.create_family_invite(uuid,text) from public, anon, authenticated;
grant execute on function public.create_family_invite(uuid,text) to authenticated;

-- Paid writes are RLS-enforced.  Onboarding rows are created by the definer
-- RPC above and may be finalized by the normal media queue after purchase.
drop policy if exists "Families: update" on public.families;
create policy "Families: update" on public.families for update
  using (public.has_family_role(id, array['owner', 'manager']) and public.billing_write_allowed(id, auth.uid()))
  with check (public.has_family_role(id, array['owner', 'manager']) and public.billing_write_allowed(id, auth.uid()));

drop policy if exists "Family memberships: update" on public.family_memberships;
create policy "Family memberships: update" on public.family_memberships for update
  using (public.has_family_role(family_id, array['owner', 'manager']) and role <> 'owner' and public.billing_write_allowed(family_id, auth.uid()))
  with check (public.has_family_role(family_id, array['owner', 'manager']) and role <> 'owner' and public.billing_write_allowed(family_id, auth.uid()));

drop policy if exists "Family memberships: delete" on public.family_memberships;
create policy "Family memberships: delete" on public.family_memberships for delete
  using (
    (public.has_family_role(family_id, array['owner', 'manager']) and role <> 'owner' and public.billing_write_allowed(family_id, auth.uid()))
    or (user_id = auth.uid() and role <> 'owner')
  );

drop policy if exists "Family invites: update" on public.family_invites;
create policy "Family invites: update" on public.family_invites for update
  using (public.has_family_role(family_id, array['owner', 'manager']) and public.billing_write_allowed(family_id, auth.uid()))
  with check (public.has_family_role(family_id, array['owner', 'manager']) and public.billing_write_allowed(family_id, auth.uid()));

drop policy if exists "Family members: insert" on public.family_members;
create policy "Family members: insert" on public.family_members for insert
  with check (public.has_family_role(family_id, array['owner', 'manager']) and public.billing_write_allowed(family_id, auth.uid()));

drop policy if exists "Family members: update" on public.family_members;
create policy "Family members: update" on public.family_members for update
  using (public.has_family_role(family_id, array['owner', 'manager']) and public.billing_write_allowed(family_id, auth.uid()))
  with check (public.has_family_role(family_id, array['owner', 'manager']) and public.billing_write_allowed(family_id, auth.uid()));

drop policy if exists "Family members: delete" on public.family_members;
create policy "Family members: delete" on public.family_members for delete
  using (public.has_family_role(family_id, array['owner', 'manager']) and public.billing_write_allowed(family_id, auth.uid()));

drop policy if exists "Memories: insert" on public.memories;
create policy "Memories: insert" on public.memories for insert
  with check (
    user_id = auth.uid()
    and public.has_family_role(family_id, array['owner', 'manager'])
    and public.billing_write_allowed(family_id, auth.uid())
  );

drop policy if exists "Memories: update" on public.memories;
create policy "Memories: update" on public.memories for update
  using (public.has_family_role(family_id, array['owner', 'manager']) and public.billing_write_allowed(family_id, auth.uid()))
  with check (public.has_family_role(family_id, array['owner', 'manager']) and public.billing_write_allowed(family_id, auth.uid()));

drop policy if exists "Memories: delete" on public.memories;
create policy "Memories: delete" on public.memories for delete
  using (public.has_family_role(family_id, array['owner', 'manager']) and public.billing_write_allowed(family_id, auth.uid()));

drop policy if exists "Memory tags: insert" on public.memory_family_members;
create policy "Memory tags: insert" on public.memory_family_members for insert
  with check (
    exists (
    select 1 from public.memories m
      where m.id = memory_id
        and public.has_family_role(m.family_id, array['owner', 'manager'])
        and (public.billing_write_allowed(m.family_id, auth.uid()) or m.onboarding_attributed)
    )
    and exists (
      select 1 from public.family_members fm
      join public.memories m on m.id = memory_id
      where fm.id = family_member_id and fm.family_id = m.family_id
    )
  );

drop policy if exists "Memory tags: delete" on public.memory_family_members;
create policy "Memory tags: delete" on public.memory_family_members for delete
  using (exists (
    select 1 from public.memories m
    where m.id = memory_id
      and public.has_family_role(m.family_id, array['owner', 'manager'])
      and (public.billing_write_allowed(m.family_id, auth.uid()) or m.onboarding_attributed)
  ));

drop policy if exists "Memory media: insert" on public.memory_media;
create policy "Memory media: insert" on public.memory_media for insert
  with check (exists (
    select 1 from public.memories m
    where m.id = memory_id
      and public.has_family_role(m.family_id, array['owner', 'manager'])
      and (public.billing_write_allowed(m.family_id, auth.uid()) or m.onboarding_attributed)
  ));

drop policy if exists "Memory media: update" on public.memory_media;
create policy "Memory media: update" on public.memory_media for update
  using (exists (
    select 1 from public.memories m
    where m.id = memory_id and public.has_family_role(m.family_id, array['owner', 'manager'])
      and (public.billing_write_allowed(m.family_id, auth.uid()) or m.onboarding_attributed)
  ))
  with check (exists (
    select 1 from public.memories m
    where m.id = memory_id and public.has_family_role(m.family_id, array['owner', 'manager'])
      and (public.billing_write_allowed(m.family_id, auth.uid()) or m.onboarding_attributed)
  ));

drop policy if exists "Memory media: delete" on public.memory_media;
create policy "Memory media: delete" on public.memory_media for delete
  using (exists (
    select 1 from public.memories m
    where m.id = memory_id and public.has_family_role(m.family_id, array['owner', 'manager'])
      and (public.billing_write_allowed(m.family_id, auth.uid()) or m.onboarding_attributed)
  ));

-- Engagement writes are also mutations on a paid journal; reads remain free
-- so a lapsed owner can still view, export, or delete account data.
drop policy if exists "Memory likes: insert own" on public.memory_likes;
create policy "Memory likes: insert own" on public.memory_likes for insert
  with check (
    user_id = auth.uid() and exists (
      select 1 from public.memories m where m.id = memory_id
        and public.is_family_member(m.family_id) and public.billing_write_allowed(m.family_id, auth.uid())
    )
  );
drop policy if exists "Memory comments: insert own" on public.memory_comments;
create policy "Memory comments: insert own" on public.memory_comments for insert
  with check (
    user_id = auth.uid() and exists (
      select 1 from public.memories m where m.id = memory_id
        and public.is_family_member(m.family_id) and public.billing_write_allowed(m.family_id, auth.uid())
    )
  );

-- Restore the metadata-preserving media RPC with the billing check.  It is
-- invoker-rights so its inserts/deletes continue to pass through RLS.
create or replace function public.replace_memory_media_assets(target_memory_id uuid, assets jsonb)
returns void language plpgsql set search_path = public as $$
declare
  current_user_id uuid := auth.uid();
  target_family_id uuid;
  target_onboarding_attributed boolean;
  asset_count integer;
  asset jsonb;
  asset_index integer;
  asset_key text;
  asset_content_type text;
  asset_duration_ms integer;
  asset_aspect_ratio double precision;
  asset_preview_object_key text;
  caller_prefix text;
  first_key text;
  first_content_type text;
  existing_keys text[];
  existing_aspect_ratios jsonb;
  existing_preview_object_keys jsonb;
begin
  if current_user_id is null then raise exception 'Unauthorized' using errcode = '28000'; end if;
  if public.is_anonymous_user() then raise exception 'Anonymous accounts cannot modify memory media' using errcode = '42501'; end if;
  if jsonb_typeof(assets) <> 'array' then raise exception 'assets must be an array' using errcode = '22023'; end if;
  asset_count := jsonb_array_length(assets);
  if asset_count < 1 or asset_count > 10 then raise exception 'Media memories require 1 to 10 assets' using errcode = '22023'; end if;

  select m.family_id, m.onboarding_attributed into target_family_id, target_onboarding_attributed
  from public.memories m where m.id = target_memory_id and m.memory_type = 'media';
  if target_family_id is null then raise exception 'Memory not found' using errcode = 'P0002'; end if;
  if not public.has_family_role(target_family_id, array['owner', 'manager']) then raise exception 'Not authorized' using errcode = '42501'; end if;
  if not public.billing_write_allowed(target_family_id, current_user_id) and not target_onboarding_attributed then
    raise exception 'Subscription required for media writes' using errcode = 'P0001';
  end if;

  caller_prefix := current_user_id::text || '/memories/' || target_memory_id::text;
  select coalesce(array_agg(object_key), '{}'),
    coalesce(jsonb_object_agg(object_key, aspect_ratio), '{}'::jsonb),
    coalesce(jsonb_object_agg(object_key, preview_object_key), '{}'::jsonb)
  into existing_keys, existing_aspect_ratios, existing_preview_object_keys
  from public.memory_media where memory_id = target_memory_id;
  delete from public.memory_media where memory_id = target_memory_id;

  for asset, asset_index in select value, ordinality - 1 from jsonb_array_elements(assets) with ordinality loop
    asset_key := asset->>'objectKey';
    asset_content_type := asset->>'contentType';
    asset_duration_ms := round(nullif(asset->>'durationMs', '')::numeric)::integer;
    asset_aspect_ratio := coalesce(nullif(asset->>'aspectRatio', '')::double precision, nullif(existing_aspect_ratios->>asset_key, 'null')::double precision);
    asset_preview_object_key := coalesce(nullif(asset->>'previewObjectKey', ''), nullif(existing_preview_object_keys->>asset_key, 'null'));
    if asset_key is null or asset_content_type is null then raise exception 'Each media asset requires objectKey and contentType' using errcode = '22023'; end if;
    if asset_aspect_ratio is not null and not (asset_aspect_ratio between 0.1 and 10) then raise exception 'Invalid media aspect ratio' using errcode = '22023'; end if;
    if asset_content_type not in ('image/jpeg','image/png','image/heic','image/heif','image/webp','video/mp4','video/quicktime') then raise exception 'Unsupported media content type' using errcode = '22023'; end if;
    if not (asset_key = any(existing_keys) or asset_key ~ ('^' || caller_prefix || '/media/[A-Za-z0-9_-]{1,128}[.](jpg|jpeg|png|heic|heif|webp|mp4|mov)$') or asset_key ~ ('^' || caller_prefix || '/media[.](jpg|jpeg|png|heic|heif|webp|mp4|mov)$')) then raise exception 'Invalid media object key' using errcode = '22023'; end if;
    if asset_preview_object_key is not null and not (asset_preview_object_key ~ ('^' || caller_prefix || '/media/[A-Za-z0-9_-]{1,128}[.](jpg|jpeg|png|heic|heif|webp|mp4|mov)$')) then raise exception 'Invalid preview object key' using errcode = '22023'; end if;
    insert into public.memory_media (memory_id, object_key, content_type, duration_ms, aspect_ratio, preview_object_key, position)
    values (target_memory_id, asset_key, asset_content_type, asset_duration_ms, asset_aspect_ratio, asset_preview_object_key, asset_index);
    if asset_index = 0 then first_key := asset_key; first_content_type := asset_content_type; end if;
  end loop;

  update public.memories set media_key = first_key, media_content_type = first_content_type,
    onboarding_attributed = false, updated_at = now() where id = target_memory_id;
end;
$$;

revoke all on function public.replace_memory_media_assets(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.replace_memory_media_assets(uuid,jsonb) to authenticated;

-- Cron/service functions have no client grants.
revoke all on function public.billing_mode_applies(uuid) from public, anon, authenticated;
revoke all on function public.owner_has_billing_access(uuid,timestamptz) from public, anon, authenticated;
revoke all on function public.billing_write_allowed(uuid,uuid) from public, anon, authenticated;
revoke all on function public.assert_billing_write_access(uuid,uuid,text) from public, anon, authenticated;
revoke all on function public.billing_owner_ai_limit_scope(uuid,timestamptz) from public, anon, authenticated;

create or replace function public.claim_billing_webhook_events(p_limit integer default 100)
returns setof public.billing_webhook_events
language sql
security definer
set search_path = public
as $$
  with candidates as (
    select event_id
    from public.billing_webhook_events
    where (
      status = 'pending' and next_attempt_at <= transaction_timestamp()
    ) or (
      status = 'processing' and updated_at < transaction_timestamp() - interval '10 minutes'
    )
    order by created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 100), 500))
  )
  update public.billing_webhook_events e
  set status = 'processing', attempts = e.attempts + 1, updated_at = transaction_timestamp()
  from candidates c
  where e.event_id = c.event_id
  returning e.*;
$$;

create or replace function public.claim_billing_trial_reminders(p_limit integer default 100)
returns table (id uuid, owner_user_id uuid, channel text, claim_token uuid)
language sql
security definer
set search_path = public
as $$
  with candidates as (
    select o.id
    from public.billing_trial_reminder_outbox o
    where (
      o.status = 'pending' and o.due_at <= transaction_timestamp()
    ) or (
      o.status = 'sending' and o.updated_at < transaction_timestamp() - interval '10 minutes'
    )
    order by o.due_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 100), 500))
  ), claimed as (
    update public.billing_trial_reminder_outbox o
    set status = 'sending', claim_token = gen_random_uuid(), attempts = o.attempts + 1,
        updated_at = transaction_timestamp()
    from candidates c
    where o.id = c.id
    returning o.id, o.owner_user_id, o.channel, o.claim_token
  )
  select * from claimed;
$$;

create or replace function public.mark_billing_trial_reminder_sent(p_id uuid, p_claim_token uuid)
returns boolean language sql security definer set search_path = public as $$
  update public.billing_trial_reminder_outbox
  set status = 'sent', sent_at = transaction_timestamp(), updated_at = transaction_timestamp()
  where id = p_id and claim_token = p_claim_token and status = 'sending'
  returning true;
$$;

create or replace function public.release_billing_trial_reminder(
  p_id uuid,
  p_claim_token uuid,
  p_error text
)
returns boolean language sql security definer set search_path = public as $$
  update public.billing_trial_reminder_outbox
  set status = case when attempts >= 3 then 'failed' else 'pending' end,
      claim_token = null, last_error = left(coalesce(p_error, 'delivery_failed'), 240),
      due_at = case when attempts >= 3 then due_at else transaction_timestamp() + interval '30 minutes' end,
      updated_at = transaction_timestamp()
  where id = p_id and claim_token = p_claim_token and status = 'sending'
  returning true;
$$;

revoke all on function public.claim_billing_webhook_events(integer) from public, anon, authenticated;
grant execute on function public.claim_billing_webhook_events(integer) to service_role;
revoke all on function public.claim_billing_trial_reminders(integer) from public, anon, authenticated;
grant execute on function public.claim_billing_trial_reminders(integer) to service_role;
revoke all on function public.mark_billing_trial_reminder_sent(uuid,uuid) from public, anon, authenticated;
grant execute on function public.mark_billing_trial_reminder_sent(uuid,uuid) to service_role;
revoke all on function public.release_billing_trial_reminder(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.release_billing_trial_reminder(uuid,uuid,text) to service_role;
