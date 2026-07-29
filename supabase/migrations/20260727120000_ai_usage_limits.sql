-- Fair-use image request admission and AI usage observability.
--
-- This migration intentionally keeps enforcement disabled.  Deploying it is
-- therefore safe for existing clients: old generation jobs are stamped as
-- grandfathered and the new RPCs return `enforcement_bypassed` until an
-- operator enables the singleton setting after all producers understand v2.

create table public.ai_usage_settings (
  singleton boolean primary key default true check (singleton),
  enforcement_enabled boolean not null default false,
  enforcement_activated_at timestamptz,
  quota_policy_epoch integer not null default 1 check (quota_policy_epoch > 0),
  alert_policy_version integer not null default 1 check (alert_policy_version > 0),
  manual_regenerations_per_memory_per_day integer not null default 5 check (manual_regenerations_per_memory_per_day > 0),
  image_requests_per_family_per_day integer not null default 20 check (image_requests_per_family_per_day > 0),
  image_requests_per_family_per_month integer not null default 100 check (image_requests_per_family_per_month > 0),
  family_request_alert_fraction numeric(4,3) not null default 0.600 check (family_request_alert_fraction > 0 and family_request_alert_fraction <= 1),
  family_monthly_spend_alert_usd numeric(12,6) not null default 5 check (family_monthly_spend_alert_usd >= 0),
  global_fallback_alert_fraction numeric(4,3) not null default 0.200 check (global_fallback_alert_fraction > 0 and global_fallback_alert_fraction <= 1),
  global_fallback_alert_min_calls integer not null default 20 check (global_fallback_alert_min_calls > 0),
  observability_gap_alert_minutes integer not null default 10 check (observability_gap_alert_minutes > 0),
  family_unpriced_alert_min_calls integer not null default 5 check (family_unpriced_alert_min_calls > 0),
  global_unpriced_alert_fraction numeric(4,3) not null default 0.100 check (global_unpriced_alert_fraction > 0 and global_unpriced_alert_fraction <= 1),
  global_unpriced_alert_min_calls integer not null default 20 check (global_unpriced_alert_min_calls > 0),
  max_alert_outbox_attempts integer not null default 3 check (max_alert_outbox_attempts > 0),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users on delete set null
);
insert into public.ai_usage_settings (singleton) values (true) on conflict (singleton) do nothing;

create table public.ai_family_usage_locks (
  family_id uuid primary key references public.families(id) on delete cascade,
  created_at timestamptz not null default now()
);
insert into public.ai_family_usage_locks (family_id)
select id from public.families on conflict (family_id) do nothing;

create or replace function public.create_family_usage_lock()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.ai_family_usage_locks (family_id) values (new.id)
  on conflict (family_id) do nothing;
  return new;
end;
$$;
drop trigger if exists create_family_usage_lock on public.families;
create trigger create_family_usage_lock after insert on public.families
for each row execute function public.create_family_usage_lock();

create table public.ai_image_generation_requests (
  id uuid primary key,
  family_id uuid not null references public.families(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  target_kind text not null check (target_kind in ('memory', 'portrait_version')),
  target_id uuid not null,
  request_intent text not null check (request_intent in ('initial', 'recovery', 'manual_regenerate')),
  enforcement_epoch integer not null,
  protocol_version smallint not null default 2 check (protocol_version = 2),
  state text not null default 'reserved' check (state in ('reserved', 'consumed', 'cancelled')),
  created_at timestamptz not null default transaction_timestamp(),
  consumed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  provider_attempt_count smallint not null default 0 check (provider_attempt_count >= 0),
  check ((state = 'consumed') = (consumed_at is not null)),
  check ((state = 'cancelled') = (cancelled_at is not null))
);
create index ai_image_generation_requests_family_target_idx
  on public.ai_image_generation_requests (family_id, target_kind, target_id, created_at desc);

create table public.ai_image_generation_admissions (
  id bigserial primary key,
  request_id uuid not null references public.ai_image_generation_requests(id) on delete cascade,
  admission_ordinal integer not null check (admission_ordinal > 0),
  utc_day date not null,
  utc_month date not null check (utc_month = date_trunc('month', utc_month)::date),
  state text not null check (state in ('active', 'released', 'expired', 'consumed')),
  admitted_at timestamptz not null default transaction_timestamp(),
  reserved_until timestamptz not null,
  finalized_at timestamptz,
  unique (request_id, admission_ordinal),
  check ((state in ('active', 'consumed')) or finalized_at is not null)
);
create unique index ai_image_generation_admissions_one_active_request
  on public.ai_image_generation_admissions (request_id) where state = 'active';
create index ai_image_generation_admissions_usage_idx
  on public.ai_image_generation_admissions (utc_month, utc_day, state, reserved_until);

create table public.ai_provider_attempts (
  id bigserial primary key,
  request_id uuid not null references public.ai_image_generation_requests(id) on delete cascade,
  provider text not null check (provider in ('primary', 'fallback')),
  attempt_number smallint not null check (attempt_number > 0),
  reserved_at timestamptz not null default transaction_timestamp(),
  unique (request_id, provider, attempt_number)
);

create table public.ai_usage_events (
  id uuid primary key default gen_random_uuid(),
  ai_call_id text not null unique,
  usage_request_id uuid references public.ai_image_generation_requests(id) on delete set null,
  family_id uuid not null references public.families(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  operation text not null check (operation in ('illustration', 'portrait', 'safety_chat', 'emotion_chat', 'emotion_vision', 'transcription', 'voice_cleanup')),
  model text not null,
  request_intent text,
  provider text,
  success boolean not null,
  provider_usage jsonb not null default '{}'::jsonb,
  input_text_tokens integer, input_image_tokens integer, cached_input_tokens integer,
  output_text_tokens integer, output_image_tokens integer, audio_seconds numeric,
  pricing_version text, cost_basis text not null default 'unpriced'
    check (cost_basis in ('provider_usage', 'request_shape_estimate', 'unpriced')),
  billing_status text not null default 'unknown',
  cost_is_complete boolean not null default false,
  estimated_cost_usd numeric(12,6),
  created_at timestamptz not null default transaction_timestamp(),
  check (jsonb_typeof(provider_usage) = 'object')
);
create index ai_usage_events_family_month_idx on public.ai_usage_events (family_id, created_at desc);
create index ai_usage_events_request_idx on public.ai_usage_events (usage_request_id) where usage_request_id is not null;

create table public.ai_usage_limit_notices (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  actor_user_id uuid not null references auth.users(id) on delete cascade,
  target_kind text not null check (target_kind in ('memory', 'portrait_version')),
  target_id uuid not null,
  scope text not null check (scope in ('memory', 'daily', 'monthly')),
  retry_after timestamptz not null,
  quota_policy_epoch integer not null,
  created_at timestamptz not null default transaction_timestamp(),
  dismissed_at timestamptz,
  unique (actor_user_id, family_id, target_kind, target_id, scope, quota_policy_epoch, retry_after)
);

create table public.ai_usage_monthly_rollups (
  family_id uuid not null references public.families(id) on delete cascade,
  month date not null check (month = date_trunc('month', month)::date),
  operation text not null,
  model text not null,
  calls integer not null default 0, failed_calls integer not null default 0,
  estimated_cost_usd numeric(12,6) not null default 0,
  unpriced_calls integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (family_id, month, operation, model)
);

create or replace function public.rollup_ai_usage_event()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into public.ai_usage_monthly_rollups(family_id,month,operation,model,calls,failed_calls,estimated_cost_usd,unpriced_calls)
  values(new.family_id,date_trunc('month',new.created_at at time zone 'UTC')::date,new.operation,new.model,1,case when new.success then 0 else 1 end,coalesce(new.estimated_cost_usd,0),case when new.cost_basis='unpriced' then 1 else 0 end)
  on conflict(family_id,month,operation,model) do update set calls=ai_usage_monthly_rollups.calls+1,failed_calls=ai_usage_monthly_rollups.failed_calls+excluded.failed_calls,estimated_cost_usd=ai_usage_monthly_rollups.estimated_cost_usd+excluded.estimated_cost_usd,unpriced_calls=ai_usage_monthly_rollups.unpriced_calls+excluded.unpriced_calls,updated_at=transaction_timestamp();
  return new;
end;
$$;
create trigger rollup_ai_usage_event after insert on public.ai_usage_events for each row execute function public.rollup_ai_usage_event();

create table public.ai_usage_alert_outbox (
  id uuid primary key default gen_random_uuid(),
  environment_id text not null,
  kind text not null check (kind in ('request', 'spend', 'fallback', 'observability_gap', 'unpriced', 'digest')),
  family_id uuid references public.families(id) on delete cascade,
  period_start timestamptz not null,
  policy_version integer not null,
  idempotency_key text not null unique,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'delivery_unknown')),
  attempts integer not null default 0,
  claim_token uuid,
  claim_started_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.memories
  add column if not exists usage_limit_scope text check (usage_limit_scope in ('memory', 'daily', 'monthly')),
  add column if not exists usage_limit_retry_after timestamptz,
  add column if not exists usage_limit_epoch integer,
  add column if not exists usage_preparation_request_id uuid references public.ai_image_generation_requests(id) on delete set null,
  add column if not exists usage_preparation_token uuid,
  add column if not exists usage_preparation_ordinal integer,
  add column if not exists usage_preparation_deadline_at timestamptz,
  add column if not exists usage_preparation_input_updated_at timestamptz;
alter table public.family_member_portrait_versions
  add column if not exists usage_limit_scope text check (usage_limit_scope in ('memory', 'daily', 'monthly')),
  add column if not exists usage_limit_retry_after timestamptz,
  add column if not exists usage_limit_epoch integer,
  add column if not exists usage_preparation_request_id uuid references public.ai_image_generation_requests(id) on delete set null,
  add column if not exists usage_preparation_token uuid,
  add column if not exists usage_preparation_ordinal integer,
  add column if not exists usage_preparation_deadline_at timestamptz,
  add column if not exists usage_preparation_input_updated_at timestamptz;

alter table public.memory_illustration_jobs
  add column if not exists usage_request_id uuid references public.ai_image_generation_requests(id) on delete set null,
  add column if not exists usage_enforcement_required boolean not null default false,
  add column if not exists usage_enforcement_epoch integer,
  add column if not exists usage_protocol_version smallint not null default 1 check (usage_protocol_version in (1, 2));
alter table public.portrait_generation_jobs
  add column if not exists usage_request_id uuid references public.ai_image_generation_requests(id) on delete set null,
  add column if not exists usage_enforcement_required boolean not null default false,
  add column if not exists usage_enforcement_epoch integer,
  add column if not exists usage_protocol_version smallint not null default 1 check (usage_protocol_version in (1, 2));

-- The mobile role may continue to edit memories, but it must never forge or
-- clear server-owned admission/notice state.  Service-role RPCs are the only
-- writers of these fields.
create or replace function public.protect_ai_usage_memory_columns()
returns trigger language plpgsql set search_path = public as $$
begin
  if (current_user in ('anon', 'authenticated') or auth.role() in ('anon', 'authenticated')) and (
    new.usage_limit_scope is distinct from old.usage_limit_scope or
    new.usage_limit_retry_after is distinct from old.usage_limit_retry_after or
    new.usage_limit_epoch is distinct from old.usage_limit_epoch or
    new.usage_preparation_request_id is distinct from old.usage_preparation_request_id or
    new.usage_preparation_token is distinct from old.usage_preparation_token or
    new.usage_preparation_ordinal is distinct from old.usage_preparation_ordinal or
    new.usage_preparation_deadline_at is distinct from old.usage_preparation_deadline_at or
    new.usage_preparation_input_updated_at is distinct from old.usage_preparation_input_updated_at
  ) then raise exception 'AI usage state is server managed' using errcode = '42501'; end if;
  return new;
end;
$$;
drop trigger if exists protect_ai_usage_memory_columns on public.memories;
drop trigger if exists aaa_protect_ai_usage_memory_columns on public.memories;
-- PostgreSQL executes same-kind triggers alphabetically.  This guard must run
-- before `cancel_*`, which legitimately clears a reservation after an input
-- edit made by an authenticated user.
create trigger aaa_protect_ai_usage_memory_columns before update on public.memories
for each row execute function public.protect_ai_usage_memory_columns();

create or replace function public.protect_ai_usage_portrait_columns()
returns trigger language plpgsql set search_path=public as $$
begin
  if (current_user in ('anon', 'authenticated') or auth.role() in ('anon','authenticated')) and (
    new.usage_limit_scope is distinct from old.usage_limit_scope or new.usage_limit_retry_after is distinct from old.usage_limit_retry_after
    or new.usage_limit_epoch is distinct from old.usage_limit_epoch or new.usage_preparation_request_id is distinct from old.usage_preparation_request_id
    or new.usage_preparation_token is distinct from old.usage_preparation_token or new.usage_preparation_ordinal is distinct from old.usage_preparation_ordinal
    or new.usage_preparation_deadline_at is distinct from old.usage_preparation_deadline_at or new.usage_preparation_input_updated_at is distinct from old.usage_preparation_input_updated_at
  ) then raise exception 'AI usage state is server managed' using errcode='42501'; end if;
  return new;
end;
$$;
drop trigger if exists aaa_protect_ai_usage_portrait_columns on public.family_member_portrait_versions;
create trigger aaa_protect_ai_usage_portrait_columns before update on public.family_member_portrait_versions
for each row execute function public.protect_ai_usage_portrait_columns();

create or replace function public.cancel_ai_usage_for_memory_input_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.usage_preparation_request_id is not null
    and coalesce(current_setting('app.ai_usage_internal', true), '') <> 'true' and (
    new.content is distinct from old.content or new.memory_date is distinct from old.memory_date
    or new.memory_type is distinct from old.memory_type or new.emotion is distinct from old.emotion
  ) then
    update public.ai_image_generation_admissions set state='released', finalized_at=transaction_timestamp()
      where request_id=old.usage_preparation_request_id and state='active';
    update public.ai_image_generation_requests set state='cancelled',cancelled_at=transaction_timestamp(),cancel_reason='generation_input_changed'
      where id=old.usage_preparation_request_id and state='reserved';
    new.usage_preparation_request_id:=null; new.usage_preparation_token:=null;
    new.usage_preparation_ordinal:=null; new.usage_preparation_deadline_at:=null;
    new.usage_preparation_input_updated_at:=null;
  end if;
  return new;
end;
$$;
drop trigger if exists cancel_ai_usage_for_memory_input_change on public.memories;
create trigger cancel_ai_usage_for_memory_input_change before update on public.memories
for each row execute function public.cancel_ai_usage_for_memory_input_change();

create or replace function public.cancel_ai_usage_for_memory_tag_change()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_memory_id uuid:=coalesce(new.memory_id,old.memory_id); v_request uuid;
begin
  select usage_preparation_request_id into v_request from public.memories where id=v_memory_id for update;
  if v_request is null then return coalesce(new,old); end if;
  update public.ai_image_generation_admissions set state='released',finalized_at=transaction_timestamp() where request_id=v_request and state='active';
  update public.ai_image_generation_requests set state='cancelled',cancelled_at=transaction_timestamp(),cancel_reason='generation_tags_changed' where id=v_request and state='reserved';
  perform set_config('app.ai_usage_internal','true',true);
  update public.memories set usage_preparation_request_id=null,usage_preparation_token=null,usage_preparation_ordinal=null,usage_preparation_deadline_at=null,usage_preparation_input_updated_at=null where id=v_memory_id and usage_preparation_request_id=v_request;
  return coalesce(new,old);
end;
$$;
drop trigger if exists cancel_ai_usage_for_memory_tag_change on public.memory_family_members;
create trigger cancel_ai_usage_for_memory_tag_change after insert or update or delete on public.memory_family_members
for each row execute function public.cancel_ai_usage_for_memory_tag_change();

create or replace function public.cancel_ai_usage_for_portrait_input_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.usage_preparation_request_id is not null and (
    new.profile_picture_key is distinct from old.profile_picture_key or new.reference_date is distinct from old.reference_date
  ) then
    update public.ai_image_generation_admissions set state='released', finalized_at=transaction_timestamp()
      where request_id=old.usage_preparation_request_id and state='active';
    update public.ai_image_generation_requests set state='cancelled',cancelled_at=transaction_timestamp(),cancel_reason='generation_input_changed'
      where id=old.usage_preparation_request_id and state='reserved';
    new.usage_preparation_request_id:=null; new.usage_preparation_token:=null;
    new.usage_preparation_ordinal:=null; new.usage_preparation_deadline_at:=null;
    new.usage_preparation_input_updated_at:=null;
  end if;
  return new;
end;
$$;
drop trigger if exists cancel_ai_usage_for_portrait_input_change on public.family_member_portrait_versions;
create trigger cancel_ai_usage_for_portrait_input_change before update on public.family_member_portrait_versions
for each row execute function public.cancel_ai_usage_for_portrait_input_change();

create or replace function public.ai_usage_is_active(p_settings public.ai_usage_settings)
returns boolean language sql stable security definer set search_path = public as $$
  select p_settings.enforcement_enabled
    and p_settings.enforcement_activated_at is not null
    and p_settings.enforcement_activated_at <= transaction_timestamp()
$$;

create or replace function public.bump_ai_usage_policy_epoch()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.enforcement_enabled is distinct from old.enforcement_enabled
    or new.enforcement_activated_at is distinct from old.enforcement_activated_at
    or new.manual_regenerations_per_memory_per_day is distinct from old.manual_regenerations_per_memory_per_day
    or new.image_requests_per_family_per_day is distinct from old.image_requests_per_family_per_day
    or new.image_requests_per_family_per_month is distinct from old.image_requests_per_family_per_month then
    new.quota_policy_epoch:=old.quota_policy_epoch+1;
  end if;
  if new.family_request_alert_fraction is distinct from old.family_request_alert_fraction
    or new.family_monthly_spend_alert_usd is distinct from old.family_monthly_spend_alert_usd
    or new.global_fallback_alert_fraction is distinct from old.global_fallback_alert_fraction
    or new.global_fallback_alert_min_calls is distinct from old.global_fallback_alert_min_calls
    or new.observability_gap_alert_minutes is distinct from old.observability_gap_alert_minutes
    or new.family_unpriced_alert_min_calls is distinct from old.family_unpriced_alert_min_calls
    or new.global_unpriced_alert_fraction is distinct from old.global_unpriced_alert_fraction
    or new.global_unpriced_alert_min_calls is distinct from old.global_unpriced_alert_min_calls
    or new.max_alert_outbox_attempts is distinct from old.max_alert_outbox_attempts then
    new.alert_policy_version:=old.alert_policy_version+1;
  end if;
  new.updated_at:=transaction_timestamp();
  return new;
end;
$$;
create trigger bump_ai_usage_policy_epoch before update on public.ai_usage_settings
for each row execute function public.bump_ai_usage_policy_epoch();

create or replace function public.ai_usage_retry_after(p_scope text, p_now timestamptz)
returns timestamptz language sql immutable as $$
  select case p_scope
    when 'monthly' then date_trunc('month', p_now at time zone 'UTC') + interval '1 month'
    when 'daily' then date_trunc('day', p_now at time zone 'UTC') + interval '1 day'
    else date_trunc('day', p_now at time zone 'UTC') + interval '1 day'
  end at time zone 'UTC'
$$;

create or replace function public.ai_usage_stamp_job()
returns trigger language plpgsql security definer set search_path = public as $$
declare s public.ai_usage_settings%rowtype;
begin
  select * into s from public.ai_usage_settings where singleton for share;
  if public.ai_usage_is_active(s) then
    if new.usage_request_id is null or new.usage_protocol_version <> 2 then
      -- A v1 producer may have begun preparation just before the scheduled
      -- activation boundary and only stamp its durable job afterwards.  Keep
      -- that handoff user-safe for one promoted-preparation lease (5 minutes).
      -- Job tables are service-only; every later v1 stamp fails closed.
      if new.usage_request_id is null and new.usage_protocol_version = 1
        and s.enforcement_activated_at is not null
        and transaction_timestamp() <= s.enforcement_activated_at + interval '5 minutes' then
        new.usage_enforcement_required := false;
        new.usage_enforcement_epoch := s.quota_policy_epoch;
        return new;
      end if;
      raise exception 'v2 usage request is required while enforcement is active' using errcode = '55000';
    end if;
    if tg_table_name='memory_illustration_jobs' then
      if not exists (
        select 1 from public.ai_image_generation_requests r where r.id=new.usage_request_id and r.family_id=new.family_id and r.target_kind='memory' and r.target_id=new.memory_id
      ) then raise exception 'usage request does not match memory job target' using errcode='55000'; end if;
    elsif tg_table_name='portrait_generation_jobs' then
      if not exists (
        select 1 from public.ai_image_generation_requests r where r.id=new.usage_request_id and r.family_id=new.family_id and r.target_kind='portrait_version' and r.target_id=new.portrait_version_id
      ) then raise exception 'usage request does not match portrait job target' using errcode='55000'; end if;
    end if;
    new.usage_enforcement_required := true;
    new.usage_enforcement_epoch := s.quota_policy_epoch;
  else
    new.usage_enforcement_required := false;
    new.usage_enforcement_epoch := s.quota_policy_epoch;
  end if;
  return new;
end;
$$;
drop trigger if exists stamp_memory_illustration_job_usage on public.memory_illustration_jobs;
create trigger stamp_memory_illustration_job_usage before insert on public.memory_illustration_jobs
for each row execute function public.ai_usage_stamp_job();
drop trigger if exists stamp_portrait_generation_job_usage on public.portrait_generation_jobs;
create trigger stamp_portrait_generation_job_usage before insert on public.portrait_generation_jobs
for each row execute function public.ai_usage_stamp_job();

create or replace function public.ai_usage_reject(
  p_family_id uuid, p_actor_id uuid, p_target_kind text, p_target_id uuid,
  p_scope text, p_epoch integer, p_now timestamptz
) returns timestamptz language plpgsql security definer set search_path = public as $$
declare v_retry timestamptz;
begin
  v_retry := public.ai_usage_retry_after(p_scope, p_now);
  insert into public.ai_usage_limit_notices (family_id, actor_user_id, target_kind, target_id, scope, retry_after, quota_policy_epoch)
  values (p_family_id, p_actor_id, p_target_kind, p_target_id, p_scope, v_retry, p_epoch)
  on conflict do nothing;
  return v_retry;
end;
$$;

-- Counts current holds and consumed admissions.  This intentionally does not
-- filter by epoch: changing a cap must never reset a family's current usage.
create or replace function public.ai_usage_limit_scope(
  p_family_id uuid, p_target_kind text, p_target_id uuid, p_intent text,
  p_settings public.ai_usage_settings, p_now timestamptz
) returns text language plpgsql security definer set search_path = public as $$
declare v_day date := (p_now at time zone 'UTC')::date;
declare v_month date := date_trunc('month', p_now at time zone 'UTC')::date;
begin
  if (
    select count(*) from public.ai_image_generation_admissions a
    join public.ai_image_generation_requests r on r.id = a.request_id
    where r.family_id = p_family_id and a.utc_month = v_month
      and (a.state = 'consumed' or (a.state = 'active' and a.reserved_until > p_now))
  ) >= p_settings.image_requests_per_family_per_month then return 'monthly'; end if;
  if (
    select count(*) from public.ai_image_generation_admissions a
    join public.ai_image_generation_requests r on r.id = a.request_id
    where r.family_id = p_family_id and a.utc_day = v_day
      and (a.state = 'consumed' or (a.state = 'active' and a.reserved_until > p_now))
  ) >= p_settings.image_requests_per_family_per_day then return 'daily'; end if;
  if p_target_kind = 'memory' and p_intent = 'manual_regenerate' and (
    select count(*) from public.ai_image_generation_admissions a
    join public.ai_image_generation_requests r on r.id = a.request_id
    where r.family_id = p_family_id and r.target_kind = p_target_kind and r.target_id = p_target_id
      and r.request_intent = 'manual_regenerate' and a.utc_day = v_day
      and (a.state = 'consumed' or (a.state = 'active' and a.reserved_until > p_now))
  ) >= p_settings.manual_regenerations_per_memory_per_day then return 'memory'; end if;
  return null;
end;
$$;

-- The begin functions are service-only: the Edge Function passes the verified
-- JWT subject as p_actor_user_id, so clients cannot forge a family selection.
create or replace function public.begin_memory_illustration_usage(
  p_memory_id uuid, p_request_intent text, p_request_id uuid, p_actor_user_id uuid
) returns table (outcome text, request_id uuid, preparation_token uuid, preparation_ordinal integer,
                 preparation_deadline_at timestamptz, preparation_input_updated_at timestamptz, scope text, retry_after_iso timestamptz, existing_job_id uuid)
language plpgsql security definer set search_path = public as $$
declare m public.memories%rowtype; s public.ai_usage_settings%rowtype; now_ts timestamptz := transaction_timestamp();
declare existing public.ai_image_generation_requests%rowtype; v_scope text; v_ordinal integer; v_queued_request uuid;
begin
  if p_request_intent not in ('initial','recovery','manual_regenerate') then raise exception 'invalid request intent' using errcode = '22023'; end if;
  -- Locate without taking the entity lock; the canonical admission order is
  -- family key-share -> family usage lock -> entity.
  select * into m from public.memories where id = p_memory_id;
  if not found then raise exception 'Memory not found' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.family_memberships fm where fm.family_id = m.family_id and fm.user_id = p_actor_user_id and fm.role in ('owner','manager')) then
    raise exception 'Not authorized for this family' using errcode = '42501'; end if;
  select * into s from public.ai_usage_settings where singleton for share;
  if not public.ai_usage_is_active(s) then return query select 'enforcement_bypassed', null::uuid, null::uuid, null::integer, null::timestamptz, null::timestamptz, null::text, null::timestamptz, null::uuid; return; end if;
  perform 1 from public.families where id = m.family_id for key share;
  perform 1 from public.ai_family_usage_locks where family_id = m.family_id for update;
  if not found then raise exception 'Family usage lock missing' using errcode = '55000'; end if;
  -- Membership can change while this call waits for the family lock.  Check
  -- again before exposing a queued job or admitting paid work.
  if not exists (select 1 from public.family_memberships fm where fm.family_id = m.family_id and fm.user_id = p_actor_user_id and fm.role in ('owner','manager')) then
    raise exception 'Not authorized for this family' using errcode = '42501';
  end if;
  select usage_request_id,id into v_queued_request,existing_job_id from public.memory_illustration_jobs
    where memory_id=p_memory_id and status in ('queued','running') order by started_at desc limit 1 for update;
  if found then return query select 'already_queued',v_queued_request,null::uuid,null::integer,null::timestamptz,null::timestamptz,null::text,null::timestamptz,existing_job_id; return; end if;
  select * into m from public.memories where id = p_memory_id for update;
  if not found then raise exception 'Memory not found' using errcode = 'P0002'; end if;
  if m.usage_preparation_request_id is not null and m.usage_preparation_deadline_at > now_ts then
    return query select 'already_preparing', m.usage_preparation_request_id, null::uuid, m.usage_preparation_ordinal, m.usage_preparation_deadline_at, m.usage_preparation_input_updated_at, null::text, null::timestamptz, null::uuid; return;
  end if;
  if m.usage_preparation_request_id is not null then
    select * into existing from public.ai_image_generation_requests where id = m.usage_preparation_request_id for update;
    if found and existing.state = 'reserved' then
      update public.ai_image_generation_admissions set state = 'expired', finalized_at = now_ts where request_id = existing.id and state = 'active';
    end if;
  end if;
  v_scope := public.ai_usage_limit_scope(m.family_id, 'memory', m.id, p_request_intent, s, now_ts);
  if v_scope is not null then
    update public.memories set usage_limit_scope = v_scope, usage_limit_retry_after = public.ai_usage_reject(m.family_id,p_actor_user_id,'memory',m.id,v_scope,s.quota_policy_epoch,now_ts), usage_limit_epoch=s.quota_policy_epoch where id=m.id;
    return query select 'limit_rejected', null::uuid, null::uuid, null::integer, null::timestamptz, null::timestamptz, v_scope, public.ai_usage_retry_after(v_scope,now_ts), null::uuid; return;
  end if;
  if existing.id is null or existing.state <> 'reserved' then
    insert into public.ai_image_generation_requests(id,family_id,actor_user_id,target_kind,target_id,request_intent,enforcement_epoch)
    values(p_request_id,m.family_id,p_actor_user_id,'memory',m.id,p_request_intent,s.quota_policy_epoch) returning * into existing;
    v_ordinal := 1;
  else
    v_ordinal := coalesce((select max(admission_ordinal) + 1 from public.ai_image_generation_admissions where request_id=existing.id),1);
  end if;
  insert into public.ai_image_generation_admissions(request_id,admission_ordinal,utc_day,utc_month,state,reserved_until)
  values(existing.id,v_ordinal,(now_ts at time zone 'UTC')::date,date_trunc('month',now_ts at time zone 'UTC')::date,'active',now_ts+interval '2 minutes');
  update public.memories set usage_preparation_request_id=existing.id, usage_preparation_token=gen_random_uuid(), usage_preparation_ordinal=v_ordinal, usage_preparation_deadline_at=now_ts+interval '2 minutes', usage_preparation_input_updated_at=m.updated_at, usage_limit_scope=null, usage_limit_retry_after=null, usage_limit_epoch=null where id=m.id
  returning usage_preparation_token into preparation_token;
  return query select case when v_ordinal=1 then 'admitted_new' else 'admitted_recovered' end, existing.id, preparation_token, v_ordinal, now_ts+interval '2 minutes', m.updated_at, null::text, null::timestamptz, null::uuid;
end;
$$;

create or replace function public.begin_portrait_generation_usage(
  p_portrait_version_id uuid, p_request_intent text, p_request_id uuid, p_actor_user_id uuid
) returns table (outcome text, request_id uuid, preparation_token uuid, preparation_ordinal integer,
                 preparation_deadline_at timestamptz, preparation_input_updated_at timestamptz, scope text, retry_after_iso timestamptz, existing_job_id uuid)
language plpgsql security definer set search_path = public as $$
declare v public.family_member_portrait_versions%rowtype; s public.ai_usage_settings%rowtype; now_ts timestamptz := transaction_timestamp();
declare existing public.ai_image_generation_requests%rowtype; v_scope text; v_ordinal integer; v_queued_request uuid;
begin
  if p_request_intent not in ('initial','recovery','manual_regenerate') then raise exception 'invalid request intent' using errcode = '22023'; end if;
  -- As above, do not lock the entity before the shared family admission lock.
  select * into v from public.family_member_portrait_versions where id=p_portrait_version_id;
  if not found then raise exception 'Portrait version not found' using errcode='P0002'; end if;
  if not exists (select 1 from public.family_memberships fm where fm.family_id=v.family_id and fm.user_id=p_actor_user_id and fm.role in ('owner','manager')) then raise exception 'Not authorized for this family' using errcode='42501'; end if;
  select * into s from public.ai_usage_settings where singleton for share;
  if not public.ai_usage_is_active(s) then return query select 'enforcement_bypassed',null::uuid,null::uuid,null::integer,null::timestamptz,null::timestamptz,null::text,null::timestamptz,null::uuid; return; end if;
  perform 1 from public.families where id=v.family_id for key share;
  perform 1 from public.ai_family_usage_locks where family_id=v.family_id for update;
  if not found then raise exception 'Family usage lock missing' using errcode='55000'; end if;
  -- Do not let a caller retain authority acquired before waiting on the
  -- family lock: they may have been demoted or removed in the meantime.
  if not exists (select 1 from public.family_memberships fm where fm.family_id=v.family_id and fm.user_id=p_actor_user_id and fm.role in ('owner','manager')) then
    raise exception 'Not authorized for this family' using errcode='42501';
  end if;
  select usage_request_id,id into v_queued_request,existing_job_id from public.portrait_generation_jobs
    where portrait_version_id=p_portrait_version_id and status in ('queued','running') order by started_at desc limit 1 for update;
  if found then return query select 'already_queued',v_queued_request,null::uuid,null::integer,null::timestamptz,null::timestamptz,null::text,null::timestamptz,existing_job_id; return; end if;
  select * into v from public.family_member_portrait_versions where id=p_portrait_version_id for update;
  if not found then raise exception 'Portrait version not found' using errcode='P0002'; end if;
  if v.usage_preparation_request_id is not null and v.usage_preparation_deadline_at > now_ts then return query select 'already_preparing',v.usage_preparation_request_id,null::uuid,v.usage_preparation_ordinal,v.usage_preparation_deadline_at,v.usage_preparation_input_updated_at,null::text,null::timestamptz,null::uuid; return; end if;
  if v.usage_preparation_request_id is not null then
    select * into existing from public.ai_image_generation_requests where id=v.usage_preparation_request_id for update;
    if found and existing.state='reserved' then update public.ai_image_generation_admissions set state='expired',finalized_at=now_ts where request_id=existing.id and state='active'; end if;
  end if;
  v_scope:=public.ai_usage_limit_scope(v.family_id,'portrait_version',v.id,p_request_intent,s,now_ts);
  if v_scope is not null then
    update public.family_member_portrait_versions set usage_limit_scope=v_scope,usage_limit_retry_after=public.ai_usage_reject(v.family_id,p_actor_user_id,'portrait_version',v.id,v_scope,s.quota_policy_epoch,now_ts),usage_limit_epoch=s.quota_policy_epoch where id=v.id;
    return query select 'limit_rejected',null::uuid,null::uuid,null::integer,null::timestamptz,null::timestamptz,v_scope,public.ai_usage_retry_after(v_scope,now_ts),null::uuid; return;
  end if;
  if existing.id is null or existing.state <> 'reserved' then insert into public.ai_image_generation_requests(id,family_id,actor_user_id,target_kind,target_id,request_intent,enforcement_epoch) values(p_request_id,v.family_id,p_actor_user_id,'portrait_version',v.id,p_request_intent,s.quota_policy_epoch) returning * into existing; v_ordinal:=1;
  else v_ordinal:=coalesce((select max(admission_ordinal)+1 from public.ai_image_generation_admissions where request_id=existing.id),1); end if;
  insert into public.ai_image_generation_admissions(request_id,admission_ordinal,utc_day,utc_month,state,reserved_until) values(existing.id,v_ordinal,(now_ts at time zone 'UTC')::date,date_trunc('month',now_ts at time zone 'UTC')::date,'active',now_ts+interval '2 minutes');
  update public.family_member_portrait_versions set usage_preparation_request_id=existing.id,usage_preparation_token=gen_random_uuid(),usage_preparation_ordinal=v_ordinal,usage_preparation_deadline_at=now_ts+interval '2 minutes',usage_preparation_input_updated_at=v.updated_at,usage_limit_scope=null,usage_limit_retry_after=null,usage_limit_epoch=null where id=v.id returning usage_preparation_token into preparation_token;
  return query select case when v_ordinal=1 then 'admitted_new' else 'admitted_recovered' end,existing.id,preparation_token,v_ordinal,now_ts+interval '2 minutes',v.updated_at,null::text,null::timestamptz,null::uuid;
end;
$$;

create or replace function public.release_ai_image_preparation(
  p_request_id uuid, p_preparation_token uuid, p_reason text default 'preparation_failed'
) returns boolean language plpgsql security definer set search_path = public as $$
declare r public.ai_image_generation_requests%rowtype;
begin
  -- This compatibility RPC is service-role-only.  V1 producers use it
  -- directly; v2 callers use the fenced overload below.
  select * into r from public.ai_image_generation_requests where id=p_request_id for update;
  if not found or r.state <> 'reserved' then return false; end if;
  if r.target_kind='memory' then
    update public.memories set usage_preparation_request_id=null,usage_preparation_token=null,usage_preparation_ordinal=null,usage_preparation_deadline_at=null,usage_preparation_input_updated_at=null
    where id=r.target_id and usage_preparation_request_id=p_request_id and usage_preparation_token=p_preparation_token;
  else
    update public.family_member_portrait_versions set usage_preparation_request_id=null,usage_preparation_token=null,usage_preparation_ordinal=null,usage_preparation_deadline_at=null,usage_preparation_input_updated_at=null
    where id=r.target_id and usage_preparation_request_id=p_request_id and usage_preparation_token=p_preparation_token;
  end if;
  if not found then return false; end if;
  update public.ai_image_generation_admissions set state='released',finalized_at=transaction_timestamp() where request_id=p_request_id and state='active';
  update public.ai_image_generation_requests set state='cancelled',cancelled_at=transaction_timestamp(),cancel_reason=p_reason where id=p_request_id;
  return true;
end;
$$;

create or replace function public.promote_ai_image_preparation(
  p_request_id uuid, p_preparation_token uuid, p_job_id uuid default null
) returns boolean language plpgsql security definer set search_path = public as $$
declare r public.ai_image_generation_requests%rowtype; now_ts timestamptz:=transaction_timestamp();
begin
  -- As above, the compatibility overload remains service-role-only for V1.
  select * into r from public.ai_image_generation_requests where id=p_request_id for update;
  if not found or r.state <> 'reserved' then return false; end if;
  if r.target_kind='memory' then
    update public.memories set usage_preparation_deadline_at=now_ts+interval '5 minutes'
    where id=r.target_id and usage_preparation_request_id=p_request_id and usage_preparation_token=p_preparation_token and usage_preparation_deadline_at>=now_ts;
  else
    update public.family_member_portrait_versions set usage_preparation_deadline_at=now_ts+interval '5 minutes'
    where id=r.target_id and usage_preparation_request_id=p_request_id and usage_preparation_token=p_preparation_token and usage_preparation_deadline_at>=now_ts;
  end if;
  if not found then return false; end if;
  update public.ai_image_generation_admissions set reserved_until=now_ts+interval '5 minutes' where request_id=p_request_id and state='active';
  return true;
end;
$$;

create or replace function public.reserve_ai_image_provider_attempt_v2(
  p_request_id uuid, p_provider text, p_attempt_number smallint
) returns table (outcome text, protocol_version smallint, scope text, retry_after_iso timestamptz)
language plpgsql security definer set search_path=public as $$
declare r public.ai_image_generation_requests%rowtype; s public.ai_usage_settings%rowtype; a public.ai_image_generation_admissions%rowtype;
declare now_ts timestamptz:=transaction_timestamp(); v_scope text; v_day date; v_month date;
begin
  -- Compatibility overload: direct request-only authorization is permitted
  -- only before activation. Bound job/legacy wrappers set this transaction
  -- flag after validating their target and lease.
  if p_provider not in ('primary','fallback') or p_attempt_number < 1
    or (p_provider='primary' and p_attempt_number > 2)
    or (p_provider='fallback' and p_attempt_number > 1) then
    raise exception 'invalid provider attempt' using errcode='22023';
  end if;
  -- Follow the shared admission order.  A request is read once only to find
  -- its family, then re-read under the family usage lock.
  select * into r from public.ai_image_generation_requests where id=p_request_id;
  if not found then return query select 'denied',2::smallint,'daily'::text,null::timestamptz; return; end if;
  perform 1 from public.families where id=r.family_id for key share;
  perform 1 from public.ai_family_usage_locks where family_id=r.family_id for update;
  if not found then return query select 'denied',2::smallint,null::text,null::timestamptz; return; end if;
  select * into r from public.ai_image_generation_requests where id=p_request_id for update;
  if not found then return query select 'denied',2::smallint,null::text,null::timestamptz; return; end if;
  select * into s from public.ai_usage_settings where singleton for share;
  if public.ai_usage_is_active(s) and coalesce(current_setting('app.ai_usage_bound',true),'') <> 'true' then
    return query select 'denied',2::smallint,null::text,null::timestamptz; return;
  end if;
  -- Rollback safety: disabling enforcement must not strand already-dispatched
  -- v2 work.  It still uses an idempotent provider slot, but does not consume
  -- a quota admission while enforcement is off.
  if not public.ai_usage_is_active(s) then
    if exists(select 1 from public.ai_provider_attempts where request_id=p_request_id and provider=p_provider and attempt_number=p_attempt_number) then
      return query select 'already_reserved',2::smallint,null::text,null::timestamptz; return;
    end if;
    insert into public.ai_provider_attempts(request_id,provider,attempt_number) values(p_request_id,p_provider,p_attempt_number);
    update public.ai_image_generation_requests set provider_attempt_count=provider_attempt_count+1 where id=p_request_id;
    return query select 'reserved_now',2::smallint,null::text,null::timestamptz; return;
  end if;
  if exists(select 1 from public.ai_provider_attempts where request_id=p_request_id and provider=p_provider and attempt_number=p_attempt_number) then return query select 'already_reserved',2::smallint,null::text,null::timestamptz; return; end if;
  if r.state='cancelled' then return query select 'denied',2::smallint,null::text,null::timestamptz; return; end if;
  if r.state='consumed' then
    insert into public.ai_provider_attempts(request_id,provider,attempt_number) values(p_request_id,p_provider,p_attempt_number);
    update public.ai_image_generation_requests set provider_attempt_count=provider_attempt_count+1 where id=p_request_id;
    return query select 'reserved_now',2::smallint,null::text,null::timestamptz; return;
  end if;
  select * into a from public.ai_image_generation_admissions where request_id=p_request_id and state='active' for update;
  if not found or a.reserved_until <= now_ts then
    if found then update public.ai_image_generation_admissions set state='expired',finalized_at=now_ts where id=a.id; end if;
    update public.ai_image_generation_requests set state='cancelled',cancelled_at=now_ts,cancel_reason='provider_reservation_expired' where id=p_request_id;
    return query select 'denied',2::smallint,null::text,null::timestamptz; return;
  end if;
  v_day:=(now_ts at time zone 'UTC')::date; v_month:=date_trunc('month',now_ts at time zone 'UTC')::date;
  if a.utc_day<>v_day or a.utc_month<>v_month then
    update public.ai_image_generation_admissions set state='released',finalized_at=now_ts where id=a.id;
    v_scope:=public.ai_usage_limit_scope(r.family_id,r.target_kind,r.target_id,r.request_intent,s,now_ts);
    if v_scope is not null then
      update public.ai_image_generation_requests set state='cancelled',cancelled_at=now_ts,cancel_reason='provider_time_limit' where id=p_request_id;
      perform public.ai_usage_reject(r.family_id,r.actor_user_id,r.target_kind,r.target_id,v_scope,s.quota_policy_epoch,now_ts);
      if r.target_kind='memory' then
        update public.memories set usage_limit_scope=v_scope, usage_limit_retry_after=public.ai_usage_retry_after(v_scope,now_ts), usage_limit_epoch=s.quota_policy_epoch
          where id=r.target_id and usage_preparation_request_id=p_request_id;
      else
        update public.family_member_portrait_versions set usage_limit_scope=v_scope, usage_limit_retry_after=public.ai_usage_retry_after(v_scope,now_ts), usage_limit_epoch=s.quota_policy_epoch
          where id=r.target_id and usage_preparation_request_id=p_request_id;
      end if;
      return query select 'denied',2::smallint,v_scope,public.ai_usage_retry_after(v_scope,now_ts); return;
    end if;
    insert into public.ai_image_generation_admissions(request_id,admission_ordinal,utc_day,utc_month,state,reserved_until,finalized_at)
    values(p_request_id,a.admission_ordinal+1,v_day,v_month,'consumed',now_ts,now_ts);
  else
    update public.ai_image_generation_admissions set state='consumed',finalized_at=now_ts,reserved_until=now_ts where id=a.id;
  end if;
  update public.ai_image_generation_requests set state='consumed',consumed_at=now_ts,provider_attempt_count=provider_attempt_count+1 where id=p_request_id;
  insert into public.ai_provider_attempts(request_id,provider,attempt_number) values(p_request_id,p_provider,p_attempt_number);
  return query select 'reserved_now',2::smallint,null::text,null::timestamptz;
end;
$$;

-- Fenced variants used by v2 producers.  They preserve the entity -> request
-- cleanup order and make a recovered preparation lease unable to mutate the
-- replacement claim.
create or replace function public.release_ai_image_preparation(
  p_request_id uuid, p_preparation_token uuid, p_preparation_ordinal integer,
  p_preparation_input_updated_at timestamptz, p_reason text
) returns boolean language plpgsql security definer set search_path=public as $$
declare r public.ai_image_generation_requests%rowtype;
begin
  select * into r from public.ai_image_generation_requests where id=p_request_id;
  if not found then return false; end if;
  if r.target_kind='memory' then
    perform 1 from public.memories where id=r.target_id and usage_preparation_request_id=p_request_id
      and usage_preparation_token=p_preparation_token and usage_preparation_ordinal=p_preparation_ordinal
      and usage_preparation_input_updated_at is not distinct from p_preparation_input_updated_at for update;
  else
    perform 1 from public.family_member_portrait_versions where id=r.target_id and usage_preparation_request_id=p_request_id
      and usage_preparation_token=p_preparation_token and usage_preparation_ordinal=p_preparation_ordinal
      and usage_preparation_input_updated_at is not distinct from p_preparation_input_updated_at for update;
  end if;
  if not found then return false; end if;
  select * into r from public.ai_image_generation_requests where id=p_request_id for update;
  if not found or r.state<>'reserved' then return false; end if;
  perform set_config('app.ai_usage_bound','true',true);
  return public.release_ai_image_preparation(p_request_id,p_preparation_token,p_reason);
end;
$$;

create or replace function public.promote_ai_image_preparation(
  p_request_id uuid, p_preparation_token uuid, p_preparation_ordinal integer,
  p_preparation_input_updated_at timestamptz, p_job_id uuid default null
) returns boolean language plpgsql security definer set search_path=public as $$
declare r public.ai_image_generation_requests%rowtype; v_ok boolean;
begin
  select * into r from public.ai_image_generation_requests where id=p_request_id;
  if not found then return false; end if;
  if r.target_kind='memory' then
    perform 1 from public.memories where id=r.target_id and usage_preparation_request_id=p_request_id
      and usage_preparation_token=p_preparation_token and usage_preparation_ordinal=p_preparation_ordinal
      and usage_preparation_input_updated_at is not distinct from p_preparation_input_updated_at for update;
    if p_job_id is not null then select exists(select 1 from public.memory_illustration_jobs where id=p_job_id and memory_id=r.target_id and usage_request_id=p_request_id and usage_protocol_version=2) into v_ok; else v_ok:=true; end if;
  else
    perform 1 from public.family_member_portrait_versions where id=r.target_id and usage_preparation_request_id=p_request_id
      and usage_preparation_token=p_preparation_token and usage_preparation_ordinal=p_preparation_ordinal
      and usage_preparation_input_updated_at is not distinct from p_preparation_input_updated_at for update;
    if p_job_id is not null then select exists(select 1 from public.portrait_generation_jobs where id=p_job_id and portrait_version_id=r.target_id and usage_request_id=p_request_id and usage_protocol_version=2) into v_ok; else v_ok:=true; end if;
  end if;
  if not found or not v_ok then return false; end if;
  select * into r from public.ai_image_generation_requests where id=p_request_id for update;
  if not found or r.state<>'reserved' then return false; end if;
  perform set_config('app.ai_usage_bound','true',true);
  return public.promote_ai_image_preparation(p_request_id,p_preparation_token,p_job_id);
end;
$$;

create or replace function public.record_ai_memory_preparation_emotion(
  p_request_id uuid, p_preparation_token uuid, p_preparation_ordinal integer,
  p_preparation_input_updated_at timestamptz, p_emotion text
) returns boolean language plpgsql security definer set search_path=public as $$
declare v_updated boolean;
begin
  if p_emotion is null or length(trim(p_emotion))=0 then return false; end if;
  perform 1 from public.memories where usage_preparation_request_id=p_request_id and usage_preparation_token=p_preparation_token
    and usage_preparation_ordinal=p_preparation_ordinal
    and usage_preparation_input_updated_at is not distinct from p_preparation_input_updated_at for update;
  if not found then return false; end if;
  perform set_config('app.ai_usage_internal','true',true);
  update public.memories set emotion=p_emotion
    where usage_preparation_request_id=p_request_id and usage_preparation_token=p_preparation_token
      and usage_preparation_ordinal=p_preparation_ordinal
      and usage_preparation_input_updated_at is not distinct from p_preparation_input_updated_at;
  v_updated:=found;
  -- Do not leak the trigger bypass into a caller that batches RPCs in one
  -- transaction; it is only needed for this server-owned update.
  perform set_config('app.ai_usage_internal','',true);
  return v_updated;
end;
$$;

create or replace function public.reserve_legacy_ai_image_provider_attempt_v2(
  p_request_id uuid, p_target_kind text, p_target_id uuid, p_preparation_token uuid,
  p_preparation_ordinal integer, p_preparation_input_updated_at timestamptz,
  p_provider text, p_attempt_number smallint
) returns table (outcome text, protocol_version smallint, scope text, retry_after_iso timestamptz)
language plpgsql security definer set search_path=public as $$
declare r public.ai_image_generation_requests%rowtype;
begin
  select * into r from public.ai_image_generation_requests where id=p_request_id;
  if not found or r.target_kind<>p_target_kind or r.target_id<>p_target_id then return query select 'denied',2::smallint,null::text,null::timestamptz; return; end if;
  if p_target_kind='memory' then
    perform 1 from public.memories where id=p_target_id and usage_preparation_request_id=p_request_id and usage_preparation_token=p_preparation_token
      and usage_preparation_ordinal=p_preparation_ordinal and usage_preparation_input_updated_at is not distinct from p_preparation_input_updated_at for update;
  elsif p_target_kind='portrait_version' then
    perform 1 from public.family_member_portrait_versions where id=p_target_id and usage_preparation_request_id=p_request_id and usage_preparation_token=p_preparation_token
      and usage_preparation_ordinal=p_preparation_ordinal and usage_preparation_input_updated_at is not distinct from p_preparation_input_updated_at for update;
  else return query select 'denied',2::smallint,null::text,null::timestamptz; return;
  end if;
  if not found then return query select 'denied',2::smallint,null::text,null::timestamptz; return; end if;
  -- Legacy v2 callers are still fenced by a preparation lease, but they must
  -- obey the same paid-provider order as durable-job callers.
  if (p_provider='primary' and p_attempt_number=2 and not exists(select 1 from public.ai_provider_attempts where request_id=p_request_id and provider='primary' and attempt_number=1))
    or (p_provider='fallback' and not exists(select 1 from public.ai_provider_attempts where request_id=p_request_id and provider='primary' and attempt_number=1)) then
    return query select 'denied',2::smallint,null::text,null::timestamptz; return;
  end if;
  perform set_config('app.ai_usage_bound','true',true);
  return query select * from public.reserve_ai_image_provider_attempt_v2(p_request_id,p_provider,p_attempt_number);
  perform set_config('app.ai_usage_bound','',true);
  return;
end;
$$;

-- V2 bridge entry point.  It binds provider authorization to the durable job
-- before delegating to the request-level state transition above.  The older
-- three-argument function remains only for grandfathered v1 jobs and is not
-- granted to clients.
create or replace function public.reserve_ai_image_provider_attempt_v2(
  p_request_id uuid, p_job_kind text, p_job_id uuid, p_provider text, p_attempt_number smallint
) returns table (outcome text, protocol_version smallint, scope text, retry_after_iso timestamptz)
language plpgsql security definer set search_path=public as $$
declare v_family uuid; v_target uuid; v_request uuid; v_protocol smallint; v_status text; v_deadline timestamptz;
begin
  if p_job_kind not in ('memory','portrait') then raise exception 'invalid job kind' using errcode='22023'; end if;
  -- Locate family first without a lock, then establish the global order.
  if p_job_kind='memory' then
    select family_id,memory_id,usage_request_id,usage_protocol_version,status,provider_deadline_at
      into v_family,v_target,v_request,v_protocol,v_status,v_deadline from public.memory_illustration_jobs where id=p_job_id;
  else
    select family_id,portrait_version_id,usage_request_id,usage_protocol_version,status,provider_deadline_at
      into v_family,v_target,v_request,v_protocol,v_status,v_deadline from public.portrait_generation_jobs where id=p_job_id;
  end if;
  if not found or v_request is distinct from p_request_id or v_protocol <> 2 then
    return query select 'denied',2::smallint,null::text,null::timestamptz; return;
  end if;
  perform 1 from public.families where id=v_family for key share;
  perform 1 from public.ai_family_usage_locks where family_id=v_family for update;
  if not found then return query select 'denied',2::smallint,null::text,null::timestamptz; return; end if;
  if p_job_kind='memory' then
    select usage_request_id,usage_protocol_version,status,provider_deadline_at into v_request,v_protocol,v_status,v_deadline
      from public.memory_illustration_jobs where id=p_job_id for update;
    perform 1 from public.memories where id=v_target for update;
  else
    select usage_request_id,usage_protocol_version,status,provider_deadline_at into v_request,v_protocol,v_status,v_deadline
      from public.portrait_generation_jobs where id=p_job_id for update;
    perform 1 from public.family_member_portrait_versions where id=v_target for update;
  end if;
  if not found or v_request is distinct from p_request_id or v_protocol <> 2 or v_status not in ('queued','running') or v_deadline <= transaction_timestamp() then
    return query select 'denied',2::smallint,null::text,null::timestamptz; return;
  end if;
  -- Preserve provider order: a retry needs its prior primary slot, and a
  -- fallback cannot be the first paid call for a request.
  if (p_provider='primary' and p_attempt_number=2 and not exists(select 1 from public.ai_provider_attempts where request_id=p_request_id and provider='primary' and attempt_number=1))
    or (p_provider='fallback' and not exists(select 1 from public.ai_provider_attempts where request_id=p_request_id and provider='primary' and attempt_number=1)) then
    return query select 'denied',2::smallint,null::text,null::timestamptz; return;
  end if;
  perform set_config('app.ai_usage_bound','true',true);
  return query select * from public.reserve_ai_image_provider_attempt_v2(p_request_id,p_provider,p_attempt_number);
  perform set_config('app.ai_usage_bound','',true);
  return;
end;
$$;

create or replace function public.record_ai_usage_event_detailed(
  p_ai_call_id text, p_usage_request_id uuid, p_family_id uuid, p_actor_user_id uuid,
  p_operation text, p_model text, p_success boolean, p_provider_usage jsonb default '{}'::jsonb,
  p_estimated_cost_usd numeric default null, p_cost_basis text default 'unpriced', p_billing_status text default 'unknown', p_cost_is_complete boolean default false, p_pricing_version text default null
) returns boolean language plpgsql security definer set search_path=public as $$
declare v_usage jsonb;
begin
  if p_provider_usage is null or jsonb_typeof(p_provider_usage) <> 'object' then raise exception 'provider usage must be an object' using errcode='22023'; end if;
  -- Persist an exact numeric allowlist, never an opaque provider response.
  v_usage:=jsonb_strip_nulls(jsonb_build_object(
    'input_text_tokens',case when coalesce(p_provider_usage->>'input_text_tokens','') ~ '^[0-9]+$' then (p_provider_usage->>'input_text_tokens')::integer end,
    'input_image_tokens',case when coalesce(p_provider_usage->>'input_image_tokens','') ~ '^[0-9]+$' then (p_provider_usage->>'input_image_tokens')::integer end,
    'cached_input_tokens',case when coalesce(p_provider_usage->>'cached_input_tokens','') ~ '^[0-9]+$' then (p_provider_usage->>'cached_input_tokens')::integer end,
    'output_text_tokens',case when coalesce(p_provider_usage->>'output_text_tokens','') ~ '^[0-9]+$' then (p_provider_usage->>'output_text_tokens')::integer end,
    'output_image_tokens',case when coalesce(p_provider_usage->>'output_image_tokens','') ~ '^[0-9]+$' then (p_provider_usage->>'output_image_tokens')::integer end,
    'audio_seconds',case when coalesce(p_provider_usage->>'audio_seconds','') ~ '^[0-9]+(\\.[0-9]+)?$' then (p_provider_usage->>'audio_seconds')::numeric end,
    'provider',case when p_provider_usage->>'provider' in ('primary','fallback') then p_provider_usage->>'provider' end
  ));
  insert into public.ai_usage_events(ai_call_id,usage_request_id,family_id,actor_user_id,operation,model,provider,success,provider_usage,input_text_tokens,input_image_tokens,cached_input_tokens,output_text_tokens,output_image_tokens,audio_seconds,estimated_cost_usd,cost_basis,billing_status,cost_is_complete,pricing_version)
  values(p_ai_call_id,p_usage_request_id,p_family_id,p_actor_user_id,p_operation,p_model,nullif(v_usage->>'provider',''),p_success,v_usage,
    (v_usage->>'input_text_tokens')::integer,(v_usage->>'input_image_tokens')::integer,(v_usage->>'cached_input_tokens')::integer,(v_usage->>'output_text_tokens')::integer,(v_usage->>'output_image_tokens')::integer,(v_usage->>'audio_seconds')::numeric,p_estimated_cost_usd,p_cost_basis,p_billing_status,p_cost_is_complete,p_pricing_version)
  on conflict(ai_call_id) do nothing;
  return true;
end;
$$;

-- Canonical deterministic Worker contract.  ai_call_id is deliberately text
-- because `request:provider:attempt` is stable across Worker replay.

create or replace function public.record_ai_usage_event(
  p_ai_call_id text, p_usage_request_id uuid, p_job_kind text, p_job_id uuid,
  p_provider text, p_attempt_number smallint, p_operation text, p_model text,
  p_provider_usage jsonb, p_success boolean, p_billing_status text,
  p_pricing_version text, p_cost_basis text, p_cost_is_complete boolean,
  p_estimated_cost_usd numeric, p_input_text_tokens integer, p_input_image_tokens integer,
  p_cached_input_tokens integer, p_output_text_tokens integer, p_output_image_tokens integer,
  p_audio_seconds numeric
) returns boolean language plpgsql security definer set search_path=public as $$
declare r public.ai_image_generation_requests%rowtype; v_usage jsonb; v_job_ok boolean;
begin
  if p_usage_request_id is null then return true; end if;
  if p_provider not in ('primary','fallback') or p_attempt_number < 1 or p_ai_call_id is distinct from format('%s:%s:%s',p_usage_request_id,p_provider,p_attempt_number) then
    raise exception 'invalid deterministic usage event identity' using errcode='22023';
  end if;
  if p_job_kind='memory' then select exists(select 1 from public.memory_illustration_jobs where id=p_job_id and usage_request_id=p_usage_request_id and usage_protocol_version=2) into v_job_ok;
  elsif p_job_kind='portrait' then select exists(select 1 from public.portrait_generation_jobs where id=p_job_id and usage_request_id=p_usage_request_id and usage_protocol_version=2) into v_job_ok;
  else v_job_ok:=false; end if;
  if not v_job_ok or not exists(select 1 from public.ai_provider_attempts where request_id=p_usage_request_id and provider=p_provider and attempt_number=p_attempt_number) then
    raise exception 'usage event is not linked to a reserved provider attempt' using errcode='22023';
  end if;
  if p_cost_basis not in ('provider_usage','request_shape_estimate','unpriced') or p_billing_status not in ('known','unknown')
    or p_estimated_cost_usd < 0 or p_estimated_cost_usd > 10000
    or coalesce(p_input_text_tokens,0)<0 or coalesce(p_input_image_tokens,0)<0 or coalesce(p_cached_input_tokens,0)<0
    or coalesce(p_output_text_tokens,0)<0 or coalesce(p_output_image_tokens,0)<0 or coalesce(p_audio_seconds,0)<0 then
    raise exception 'invalid usage cost dimensions' using errcode='22023';
  end if;
  select * into r from public.ai_image_generation_requests where id=p_usage_request_id;
  if not found then return false; end if;
  v_usage:=jsonb_strip_nulls(jsonb_build_object('provider',p_provider,'input_text_tokens',p_input_text_tokens,'input_image_tokens',p_input_image_tokens,'cached_input_tokens',p_cached_input_tokens,'output_text_tokens',p_output_text_tokens,'output_image_tokens',p_output_image_tokens,'audio_seconds',p_audio_seconds));
  return public.record_ai_usage_event_detailed(p_ai_call_id,p_usage_request_id,r.family_id,r.actor_user_id,p_operation,coalesce(p_model,'unknown'),p_success,v_usage,p_estimated_cost_usd,p_cost_basis,p_billing_status,p_cost_is_complete,p_pricing_version);
end;
$$;

create or replace view public.family_ai_costs_monthly as
select family_id, month, operation, model, calls, failed_calls,
  estimated_cost_usd, unpriced_calls
from public.ai_usage_monthly_rollups;

create or replace view public.ai_usage_observability_gaps as
select r.id as usage_request_id, r.family_id, r.target_kind, r.target_id, r.consumed_at
from public.ai_image_generation_requests r
cross join public.ai_usage_settings s
where s.singleton and r.state = 'consumed'
  and r.consumed_at < transaction_timestamp() - make_interval(mins => s.observability_gap_alert_minutes)
  and not exists (
    select 1 from public.ai_usage_events e
    where e.usage_request_id = r.id and e.operation in ('illustration', 'portrait')
  );

-- Cloudflare bridge shape.  The request carries the attribution, so bridge
-- callers cannot select a different family or actor.  Keep the wider helper
-- above for Edge-only non-image calls such as transcription and emotion.
create or replace function public.record_ai_usage_event_legacy(
  p_ai_call_id uuid, p_usage_request_id uuid, p_operation text, p_model text,
  p_provider_usage jsonb, p_success boolean, p_billing_status text
) returns boolean language plpgsql security definer set search_path=public as $$
declare r public.ai_image_generation_requests%rowtype;
begin
  if p_usage_request_id is null then return true; end if;
  select * into r from public.ai_image_generation_requests where id=p_usage_request_id;
  if not found then return false; end if;
  return public.record_ai_usage_event_detailed(
    p_ai_call_id::text, p_usage_request_id, r.family_id, r.actor_user_id,
    p_operation, coalesce(p_model, 'unknown'), p_success, p_provider_usage, null, 'unpriced',
    p_billing_status, false, null
  );
end;
$$;

create or replace function public.get_my_ai_usage_limit_notices()
returns setof public.ai_usage_limit_notices language sql security definer stable set search_path=public as $$
  select n.* from public.ai_usage_limit_notices n join public.ai_usage_settings s on s.singleton
  where n.actor_user_id=auth.uid() and public.is_family_member(n.family_id) and n.dismissed_at is null and n.retry_after>transaction_timestamp()
    and n.quota_policy_epoch=s.quota_policy_epoch and public.ai_usage_is_active(s)
  order by n.created_at desc
$$;

-- Called by the scheduled maintenance path.  Retention is deliberately
-- family-scoped through cascading FKs; this routine never retains a cost
-- aggregate after full family deletion.
create or replace function public.purge_expired_ai_usage_data(p_now timestamptz default transaction_timestamp())
returns table (events_deleted integer, requests_deleted integer, notices_deleted integer, outbox_deleted integer, rollups_deleted integer)
language plpgsql security definer set search_path=public as $$
begin
  delete from public.ai_usage_events where created_at < p_now - interval '90 days';
  get diagnostics events_deleted = row_count;
  delete from public.ai_image_generation_requests
    where created_at < p_now - interval '90 days'
      and state in ('consumed','cancelled');
  get diagnostics requests_deleted = row_count;
  delete from public.ai_usage_limit_notices
    where dismissed_at is not null and dismissed_at < p_now - interval '7 days'
       or (dismissed_at is null and retry_after < p_now - interval '7 days');
  get diagnostics notices_deleted = row_count;
  delete from public.ai_usage_alert_outbox
    where status in ('sent','failed','delivery_unknown') and updated_at < p_now - interval '90 days';
  get diagnostics outbox_deleted = row_count;
  delete from public.ai_usage_monthly_rollups
    where month < (date_trunc('month', p_now at time zone 'UTC') - interval '13 months')::date;
  get diagnostics rollups_deleted = row_count;
  return next;
end;
$$;

-- Alert enqueueing is SQL-owned so repeated crons cannot create duplicate
-- notifications.  The outbox payload contains aggregates/IDs only.
create or replace function public.enqueue_ai_usage_alerts(p_environment_id text, p_now timestamptz default transaction_timestamp())
returns setof public.ai_usage_alert_outbox
language plpgsql security definer set search_path=public as $$
declare s public.ai_usage_settings%rowtype; v_month date := date_trunc('month', p_now at time zone 'UTC')::date;
declare f record; v_request_count integer; v_cost numeric; v_unpriced integer; v_threshold integer;
declare v_fallback integer; v_images integer; v_global_unpriced integer;
begin
  if p_environment_id is null or length(trim(p_environment_id)) = 0 then raise exception 'environment id required' using errcode='22023'; end if;
  select * into s from public.ai_usage_settings where singleton for share;
  v_threshold := ceil(s.image_requests_per_family_per_month * s.family_request_alert_fraction);
  for f in select id from public.families where deleted_at is null loop
    select count(*) into v_request_count from public.ai_image_generation_requests
      where family_id=f.id and state='consumed' and consumed_at >= (v_month::timestamp at time zone 'UTC');
    if v_request_count >= v_threshold then
      insert into public.ai_usage_alert_outbox(environment_id,kind,family_id,period_start,policy_version,idempotency_key,payload)
      values(p_environment_id,'request',f.id,v_month::timestamp at time zone 'UTC',s.alert_policy_version,
        format('%s:request:%s:%s:%s',p_environment_id,f.id,v_month,s.alert_policy_version),
        jsonb_build_object('consumedRequests',v_request_count,'threshold',v_threshold,'monthlyCap',s.image_requests_per_family_per_month)) on conflict(idempotency_key) do nothing;
    end if;
    select coalesce(sum(estimated_cost_usd),0), count(*) filter(where cost_basis='unpriced') into v_cost,v_unpriced
      from public.ai_usage_events where family_id=f.id and created_at >= (v_month::timestamp at time zone 'UTC');
    if v_cost >= s.family_monthly_spend_alert_usd then
      insert into public.ai_usage_alert_outbox(environment_id,kind,family_id,period_start,policy_version,idempotency_key,payload)
      values(p_environment_id,'spend',f.id,v_month::timestamp at time zone 'UTC',s.alert_policy_version,
        format('%s:spend:%s:%s:%s',p_environment_id,f.id,v_month,s.alert_policy_version),jsonb_build_object('estimatedCostUsd',v_cost)) on conflict(idempotency_key) do nothing;
    end if;
    if v_unpriced >= s.family_unpriced_alert_min_calls then
      insert into public.ai_usage_alert_outbox(environment_id,kind,family_id,period_start,policy_version,idempotency_key,payload)
      values(p_environment_id,'unpriced',f.id,v_month::timestamp at time zone 'UTC',s.alert_policy_version,
        format('%s:unpriced:%s:%s:%s',p_environment_id,f.id,v_month,s.alert_policy_version),jsonb_build_object('unpricedCalls',v_unpriced)) on conflict(idempotency_key) do nothing;
    end if;
    if exists (
      select 1 from public.ai_image_generation_requests r
      where r.family_id=f.id and r.state='consumed' and r.consumed_at < p_now-make_interval(mins => s.observability_gap_alert_minutes)
        and not exists (select 1 from public.ai_usage_events e where e.usage_request_id=r.id and e.operation in ('illustration','portrait'))
    ) then
      insert into public.ai_usage_alert_outbox(environment_id,kind,family_id,period_start,policy_version,idempotency_key,payload)
      values(p_environment_id,'observability_gap',f.id,date_trunc('day',p_now),s.alert_policy_version,
        format('%s:gap:%s:%s:%s',p_environment_id,f.id,(p_now at time zone 'UTC')::date,s.alert_policy_version),jsonb_build_object('gapAfterMinutes',s.observability_gap_alert_minutes)) on conflict(idempotency_key) do nothing;
    end if;
  end loop;
  select count(*) filter(where provider_usage->>'provider'='fallback'), count(*) filter(where cost_basis='unpriced'), count(*) into v_fallback,v_global_unpriced,v_images
    from public.ai_usage_events where operation in ('illustration','portrait') and created_at >= p_now-interval '24 hours';
  if v_images >= s.global_fallback_alert_min_calls and v_fallback::numeric / v_images > s.global_fallback_alert_fraction then
    insert into public.ai_usage_alert_outbox(environment_id,kind,period_start,policy_version,idempotency_key,payload)
    values(p_environment_id,'fallback',date_trunc('day',p_now),s.alert_policy_version,
      format('%s:fallback:%s:%s',p_environment_id,(p_now at time zone 'UTC')::date,s.alert_policy_version),jsonb_build_object('fallbackCalls',v_fallback,'imageCalls',v_images)) on conflict(idempotency_key) do nothing;
  end if;
  if v_images >= s.global_unpriced_alert_min_calls
    and v_global_unpriced::numeric / nullif(v_images,0) > s.global_unpriced_alert_fraction then
    insert into public.ai_usage_alert_outbox(environment_id,kind,period_start,policy_version,idempotency_key,payload)
    values(p_environment_id,'unpriced',date_trunc('day',p_now),s.alert_policy_version,
      format('%s:unpriced-global:%s:%s',p_environment_id,(p_now at time zone 'UTC')::date,s.alert_policy_version),
      jsonb_build_object('unpricedCalls',v_global_unpriced,'imageCalls',v_images,'threshold',s.global_unpriced_alert_fraction)) on conflict(idempotency_key) do nothing;
  end if;
  return query select * from public.ai_usage_alert_outbox
    where environment_id=p_environment_id and (status='pending' or (status='failed' and attempts < s.max_alert_outbox_attempts))
    order by created_at;
end;
$$;

create or replace function public.claim_ai_usage_alert_outbox(p_id uuid)
returns table (claimed boolean, claim_token uuid, payload jsonb)
language plpgsql security definer set search_path=public as $$
declare v_token uuid:=gen_random_uuid();
begin
  update public.ai_usage_alert_outbox set status='sending',claim_token=v_token,claim_started_at=transaction_timestamp(),attempts=attempts+1,updated_at=transaction_timestamp()
    where id=p_id
      and attempts < (select max_alert_outbox_attempts from public.ai_usage_settings where singleton)
      and (status='pending' or status='failed'
        or (status='sending' and claim_started_at < transaction_timestamp()-interval '10 minutes'))
    returning true, v_token, ai_usage_alert_outbox.payload into claimed,claim_token,payload;
  if not found then return query select false,null::uuid,null::jsonb; else return next; end if;
end;
$$;

create or replace function public.mark_ai_usage_alert_outbox_sent(p_id uuid, p_token uuid)
returns boolean language plpgsql security definer set search_path=public as $$
begin
  update public.ai_usage_alert_outbox set status='sent',sent_at=transaction_timestamp(),updated_at=transaction_timestamp()
    where id=p_id and status='sending' and claim_token=p_token;
  return found;
end;
$$;

-- A request that may already have reached the mail provider must never be
-- retried automatically.  It stays terminal for manual investigation.
create or replace function public.mark_ai_usage_alert_outbox_delivery_unknown(p_id uuid, p_token uuid)
returns boolean language plpgsql security definer set search_path=public as $$
begin
  update public.ai_usage_alert_outbox set status='delivery_unknown',updated_at=transaction_timestamp()
    where id=p_id and status='sending' and claim_token=p_token;
  return found;
end;
$$;

create or replace function public.release_ai_usage_alert_outbox(p_id uuid, p_token uuid)
returns boolean language plpgsql security definer set search_path=public as $$
begin
  update public.ai_usage_alert_outbox set status='failed',updated_at=transaction_timestamp()
    where id=p_id and status='sending' and claim_token=p_token;
  return found;
end;
$$;

-- Private auxiliary tables are intentionally policy-free.  Only the narrow
-- notice reader is granted to authenticated callers; all write/bridge RPCs
-- are service-role only.
alter table public.ai_usage_settings enable row level security;
alter table public.ai_family_usage_locks enable row level security;
alter table public.ai_image_generation_requests enable row level security;
alter table public.ai_image_generation_admissions enable row level security;
alter table public.ai_provider_attempts enable row level security;
alter table public.ai_usage_events enable row level security;
alter table public.ai_usage_limit_notices enable row level security;
alter table public.ai_usage_monthly_rollups enable row level security;
alter table public.ai_usage_alert_outbox enable row level security;
revoke all on public.family_ai_costs_monthly, public.ai_usage_observability_gaps from public, anon, authenticated;

-- Existing tables keep their separately-declared grants; grant only the
-- explicit client read surface added here.
revoke all on function public.ai_usage_reject(uuid,uuid,text,uuid,text,integer,timestamptz), public.ai_usage_limit_scope(uuid,text,uuid,text,public.ai_usage_settings,timestamptz), public.ai_usage_stamp_job(), public.ai_usage_is_active(public.ai_usage_settings), public.create_family_usage_lock(), public.cancel_ai_usage_for_memory_input_change(), public.cancel_ai_usage_for_memory_tag_change(), public.cancel_ai_usage_for_portrait_input_change(), public.protect_ai_usage_memory_columns(), public.protect_ai_usage_portrait_columns() from public,anon,authenticated;
revoke all on function public.begin_memory_illustration_usage(uuid,text,uuid,uuid) from public,anon,authenticated;
revoke all on function public.begin_portrait_generation_usage(uuid,text,uuid,uuid) from public,anon,authenticated;
revoke all on function public.release_ai_image_preparation(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.promote_ai_image_preparation(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.reserve_ai_image_provider_attempt_v2(uuid,text,smallint) from public,anon,authenticated;
revoke all on function public.reserve_ai_image_provider_attempt_v2(uuid,text,uuid,text,smallint) from public,anon,authenticated;
revoke all on function public.reserve_legacy_ai_image_provider_attempt_v2(uuid,text,uuid,uuid,integer,timestamptz,text,smallint) from public,anon,authenticated;
revoke all on function public.release_ai_image_preparation(uuid,uuid,integer,timestamptz,text) from public,anon,authenticated;
revoke all on function public.promote_ai_image_preparation(uuid,uuid,integer,timestamptz,uuid) from public,anon,authenticated;
revoke all on function public.record_ai_memory_preparation_emotion(uuid,uuid,integer,timestamptz,text) from public,anon,authenticated;
revoke all on function public.record_ai_usage_event_detailed(text,uuid,uuid,uuid,text,text,boolean,jsonb,numeric,text,text,boolean,text) from public,anon,authenticated;
revoke all on function public.record_ai_usage_event_legacy(uuid,uuid,text,text,jsonb,boolean,text) from public,anon,authenticated;
revoke all on function public.record_ai_usage_event(text,uuid,text,uuid,text,smallint,text,text,jsonb,boolean,text,text,text,boolean,numeric,integer,integer,integer,integer,integer,numeric) from public,anon,authenticated;
revoke all on function public.purge_expired_ai_usage_data(timestamptz) from public,anon,authenticated;
revoke all on function public.enqueue_ai_usage_alerts(text,timestamptz) from public,anon,authenticated;
revoke all on function public.claim_ai_usage_alert_outbox(uuid) from public,anon,authenticated;
revoke all on function public.mark_ai_usage_alert_outbox_sent(uuid,uuid) from public,anon,authenticated;
revoke all on function public.mark_ai_usage_alert_outbox_delivery_unknown(uuid,uuid) from public,anon,authenticated;
revoke all on function public.release_ai_usage_alert_outbox(uuid,uuid) from public,anon,authenticated;
grant execute on function public.begin_memory_illustration_usage(uuid,text,uuid,uuid), public.begin_portrait_generation_usage(uuid,text,uuid,uuid), public.release_ai_image_preparation(uuid,uuid,text), public.release_ai_image_preparation(uuid,uuid,integer,timestamptz,text), public.promote_ai_image_preparation(uuid,uuid,uuid), public.promote_ai_image_preparation(uuid,uuid,integer,timestamptz,uuid), public.reserve_ai_image_provider_attempt_v2(uuid,text,smallint), public.reserve_ai_image_provider_attempt_v2(uuid,text,uuid,text,smallint), public.reserve_legacy_ai_image_provider_attempt_v2(uuid,text,uuid,uuid,integer,timestamptz,text,smallint), public.record_ai_memory_preparation_emotion(uuid,uuid,integer,timestamptz,text), public.record_ai_usage_event_detailed(text,uuid,uuid,uuid,text,text,boolean,jsonb,numeric,text,text,boolean,text), public.record_ai_usage_event_legacy(uuid,uuid,text,text,jsonb,boolean,text), public.record_ai_usage_event(text,uuid,text,uuid,text,smallint,text,text,jsonb,boolean,text,text,text,boolean,numeric,integer,integer,integer,integer,integer,numeric), public.purge_expired_ai_usage_data(timestamptz), public.enqueue_ai_usage_alerts(text,timestamptz), public.claim_ai_usage_alert_outbox(uuid), public.mark_ai_usage_alert_outbox_sent(uuid,uuid), public.mark_ai_usage_alert_outbox_delivery_unknown(uuid,uuid), public.release_ai_usage_alert_outbox(uuid,uuid) to service_role;
revoke all on function public.get_my_ai_usage_limit_notices() from public,anon;
grant execute on function public.get_my_ai_usage_limit_notices() to authenticated;
