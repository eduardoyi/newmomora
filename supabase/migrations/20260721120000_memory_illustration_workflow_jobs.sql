-- Durable orchestration state for Cloudflare-backed memory illustrations.
-- This table is deliberately private: mobile clients continue to observe the
-- memory row only, while Edge Functions and the workflow bridge use service
-- role credentials after authenticating their caller.

alter table public.memories
  add column if not exists illustration_generation_started_at timestamptz;

update public.memories
set illustration_generation_started_at = coalesce(updated_at, created_at, now())
where illustration_status in ('pending', 'generating')
  and illustration_generation_started_at is null;

create table public.memory_illustration_jobs (
  id uuid primary key,
  workflow_instance_id text not null unique,
  memory_id uuid not null references public.memories on delete cascade,
  family_id uuid not null references public.families on delete cascade,
  attempt_id uuid not null unique,
  request_intent text not null check (request_intent in ('initial', 'recovery', 'manual_regenerate')),
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'superseded')),
  started_at timestamptz not null default now(),
  provider_deadline_at timestamptz not null,
  completed_at timestamptz,
  color_palette text not null,
  safe_scene_description text,
  expression_style text,
  style_description text,
  memory_date date not null,
  emotion text,
  reference_candidates jsonb not null default '[]'::jsonb,
  illustration_prompt text,
  output_key text not null,
  old_illustration_key text,
  primary_attempts smallint not null default 0 check (primary_attempts between 0 and 2),
  fallback_attempts smallint not null default 0 check (fallback_attempts between 0 and 1),
  model text,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index memory_illustration_jobs_one_active_per_memory
  on public.memory_illustration_jobs (memory_id)
  where status in ('queued', 'running');
create index memory_illustration_jobs_memory_started_at_idx
  on public.memory_illustration_jobs (memory_id, started_at desc);
create index memory_illustration_jobs_family_id_idx
  on public.memory_illustration_jobs (family_id);

alter table public.memory_illustration_jobs enable row level security;

-- A job is service-only.  Do not add client policies: the memory row is the
-- intentionally narrow client-visible status surface.

create table public.memory_illustration_workflow_bridge_nonces (
  nonce uuid primary key,
  received_at timestamptz not null default now()
);
create index memory_illustration_workflow_bridge_nonces_received_at_idx
  on public.memory_illustration_workflow_bridge_nonces (received_at);
alter table public.memory_illustration_workflow_bridge_nonces enable row level security;

create trigger set_memory_illustration_jobs_updated_at
  before update on public.memory_illustration_jobs
  for each row execute function public.set_updated_at();

-- The clock is distinct from memories.updated_at, which is also touched by
-- unrelated writes such as link-preview/emotion hydration.  A status-only
-- legacy reset preserves a non-null existing clock; explicit invalidation
-- paths below refresh it before this trigger runs.
create or replace function public.set_memory_illustration_generation_clock()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.memory_type = 'text_illustration'
    and new.illustration_status in ('pending', 'generating') then
    if new.illustration_generation_started_at is null then
      new.illustration_generation_started_at := now();
    end if;
  elsif new.illustration_status in ('ready', 'failed', 'none')
    or new.memory_type <> 'text_illustration' then
    new.illustration_generation_started_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists set_memory_illustration_generation_clock on public.memories;
create trigger set_memory_illustration_generation_clock
  before insert or update of memory_type, illustration_status, illustration_generation_started_at
  on public.memories
  for each row execute function public.set_memory_illustration_generation_clock();

-- Input edits deliberately park a keyless illustrated memory back at pending.
-- Refresh its clock so an old abandoned attempt cannot make the new input look
-- stale immediately.  This replaces the earlier function without changing its
-- attempt-token invalidation semantics.
create or replace function public.invalidate_memory_illustration_attempt_on_input_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.content is distinct from new.content
    or old.memory_date is distinct from new.memory_date
    or old.memory_type is distinct from new.memory_type
    or old.emotion is distinct from new.emotion then
    if old.illustration_generation_attempt_id is not null then
      new.illustration_generation_attempt_id := null;
      if new.illustration_status = old.illustration_status then
        new.illustration_status := case
          when old.illustration_key is not null and old.illustration_generation_id is not null
            then 'ready'
          when new.memory_type <> 'text_illustration' then 'none'
          else 'pending'
        end;
      end if;
      if new.illustration_status = 'pending' then
        new.illustration_generation_started_at := now();
      end if;
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.invalidate_memory_illustration_attempt_on_tag_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.memories
  set
    illustration_generation_attempt_id = null,
    illustration_status = case
      when illustration_generation_attempt_id is null then illustration_status
      when illustration_key is not null and illustration_generation_id is not null then 'ready'
      when memory_type <> 'text_illustration' then 'none'
      else 'pending'
    end,
    illustration_generation_started_at = case
      when illustration_generation_attempt_id is not null
        and illustration_key is null
        and memory_type = 'text_illustration' then now()
      else illustration_generation_started_at
    end
  where id = coalesce(new.memory_id, old.memory_id);
  return coalesce(new, old);
end;
$$;

-- Atomic bridge operations.  Execute is withheld from anon/authenticated;
-- the HMAC-authenticated Edge Function calls these through service role.
create or replace function public.publish_memory_illustration_workflow_job(
  p_job_id uuid,
  p_model text
)
returns table (published boolean, already_published boolean, old_key text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.memory_illustration_jobs%rowtype;
  v_memory public.memories%rowtype;
begin
  select * into v_job from public.memory_illustration_jobs where id = p_job_id for update;
  if not found then raise exception 'workflow job not found'; end if;
  select * into v_memory from public.memories where id = v_job.memory_id for update;
  if not found then raise exception 'memory not found'; end if;

  if v_job.status = 'succeeded'
    and v_memory.illustration_generation_id = v_job.id then
    -- A replay after the DB commit but before R2 cleanup still needs the old
    -- pointer. Keep it on the durable job until a later cleanup policy.
    return query select false, true, v_job.old_illustration_key;
    return;
  end if;

  if v_memory.illustration_generation_attempt_id is distinct from v_job.attempt_id then
    update public.memory_illustration_jobs
    set status = 'superseded', completed_at = now(), safe_scene_description = null,
      reference_candidates = '[]'::jsonb, illustration_prompt = null
    where id = p_job_id;
    return query select false, false, null::text;
    return;
  end if;

  if v_job.illustration_prompt is null then
    raise exception 'workflow prompt was not recorded';
  end if;

  update public.memories
  set illustration_key = v_job.output_key,
      illustration_generation_id = v_job.id,
      illustration_generation_attempt_id = null,
      illustration_generation_started_at = null,
      illustration_prompt = v_job.illustration_prompt,
      illustration_status = 'ready'
  where id = v_job.memory_id;

  update public.memory_illustration_jobs
  set status = 'succeeded', completed_at = now(), model = p_model,
      illustration_prompt = null, safe_scene_description = null,
      reference_candidates = '[]'::jsonb
  where id = p_job_id;

  return query select true, false, v_memory.illustration_key;
end;
$$;

create or replace function public.reserve_memory_illustration_provider_attempt(
  p_job_id uuid,
  p_provider text,
  p_attempt_number smallint
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.memory_illustration_jobs%rowtype;
begin
  if p_provider is null or p_attempt_number is null
    or p_provider not in ('primary', 'fallback') or p_attempt_number < 1
    or (p_provider = 'primary' and p_attempt_number > 2)
    or (p_provider = 'fallback' and p_attempt_number > 1) then
    raise exception 'invalid provider';
  end if;
  select * into v_job from public.memory_illustration_jobs where id = p_job_id for update;
  if not found or v_job.status not in ('queued', 'running') then return false; end if;
  if p_provider = 'primary' then
    if v_job.primary_attempts >= p_attempt_number then return true; end if;
    if v_job.primary_attempts + 1 <> p_attempt_number then return false; end if;
    update public.memory_illustration_jobs set primary_attempts = primary_attempts + 1 where id = p_job_id;
  else
    if v_job.fallback_attempts >= p_attempt_number then return true; end if;
    if v_job.fallback_attempts + 1 <> p_attempt_number then return false; end if;
    update public.memory_illustration_jobs set fallback_attempts = fallback_attempts + 1 where id = p_job_id;
  end if;
  return true;
end;
$$;

create or replace function public.fail_memory_illustration_workflow_job(
  p_job_id uuid,
  p_error_code text
)
returns table (failed boolean, output_key text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.memory_illustration_jobs%rowtype;
  v_memory public.memories%rowtype;
begin
  select * into v_job from public.memory_illustration_jobs where id = p_job_id for update;
  if not found then raise exception 'workflow job not found'; end if;
  if v_job.status in ('failed', 'succeeded', 'superseded') then
    return query select v_job.status = 'failed', v_job.output_key;
    return;
  end if;
  select * into v_memory from public.memories where id = v_job.memory_id for update;
  if not found then raise exception 'memory not found'; end if;

  if v_memory.illustration_generation_attempt_id = v_job.attempt_id then
    update public.memories
    set illustration_generation_attempt_id = null,
        illustration_generation_started_at = null,
        illustration_status = case
          when illustration_key is not null and illustration_generation_id is not null then 'ready'
          else 'failed'
        end
    where id = v_job.memory_id;
  end if;

  update public.memory_illustration_jobs
  set status = case when v_memory.illustration_generation_attempt_id = v_job.attempt_id then 'failed' else 'superseded' end,
      completed_at = now(), error_code = p_error_code,
      safe_scene_description = null, reference_candidates = '[]'::jsonb,
      illustration_prompt = null
  where id = p_job_id;

  return query select true, v_job.output_key;
end;
$$;

revoke all on function public.publish_memory_illustration_workflow_job(uuid, text) from public, anon, authenticated;
revoke all on function public.fail_memory_illustration_workflow_job(uuid, text) from public, anon, authenticated;
revoke all on function public.reserve_memory_illustration_provider_attempt(uuid, text, smallint) from public, anon, authenticated;
grant execute on function public.publish_memory_illustration_workflow_job(uuid, text) to service_role;
grant execute on function public.fail_memory_illustration_workflow_job(uuid, text) to service_role;
grant execute on function public.reserve_memory_illustration_provider_attempt(uuid, text, smallint) to service_role;
