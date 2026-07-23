-- Durable orchestration state for Cloudflare-backed character portrait
-- generation. Portrait versions remain the narrow client-visible status
-- surface; job inputs are intentionally service-only and scrubbed once an
-- attempt reaches a terminal state.

create table public.portrait_generation_jobs (
  id uuid primary key,
  workflow_instance_id text not null unique,
  portrait_version_id uuid not null references public.family_member_portrait_versions (id) on delete cascade,
  family_id uuid not null references public.families (id) on delete cascade,
  actor_user_id uuid references auth.users (id) on delete set null,
  attempt_id uuid not null unique,
  request_intent text not null check (request_intent in ('initial', 'recovery', 'manual_regenerate')),
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'superseded')),
  started_at timestamptz not null default now(),
  provider_deadline_at timestamptz not null,
  completed_at timestamptz,
  source_photo_key text,
  style_reference_key text,
  portrait_prompt text,
  output_key text not null,
  old_portrait_key text,
  primary_attempts smallint not null default 0 check (primary_attempts between 0 and 1),
  fallback_attempts smallint not null default 0 check (fallback_attempts between 0 and 1),
  model text,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index portrait_generation_jobs_one_active_per_version
  on public.portrait_generation_jobs (portrait_version_id)
  where status in ('queued', 'running');
create index portrait_generation_jobs_version_started_at_idx
  on public.portrait_generation_jobs (portrait_version_id, started_at desc);
create index portrait_generation_jobs_family_id_idx
  on public.portrait_generation_jobs (family_id);

alter table public.portrait_generation_jobs enable row level security;
-- No policies: clients observe family_member_portrait_versions only.

create table public.portrait_generation_workflow_bridge_nonces (
  nonce uuid primary key,
  received_at timestamptz not null default now()
);
create index portrait_generation_workflow_bridge_nonces_received_at_idx
  on public.portrait_generation_workflow_bridge_nonces (received_at);
alter table public.portrait_generation_workflow_bridge_nonces enable row level security;

create trigger set_portrait_generation_jobs_updated_at
  before update on public.portrait_generation_jobs
  for each row execute function public.set_updated_at();

-- Five minutes is the application lease. The extra thirty seconds protects
-- publication and is also the client/server stale-recovery boundary.
create or replace function public.claim_family_member_portrait_generation(
  target_version_id uuid,
  attempt_token uuid,
  attempt_key text,
  actor_user_id uuid
)
returns public.family_member_portrait_versions
language plpgsql
security definer
set search_path = public
as $$
declare
  version_row public.family_member_portrait_versions%rowtype;
  expected_key text;
  photo_owner text;
  result public.family_member_portrait_versions%rowtype;
begin
  select * into version_row
  from public.family_member_portrait_versions
  where id = target_version_id;
  if not found then raise exception 'Portrait version not found' using errcode = 'P0002'; end if;

  if not exists (
    select 1
    from public.family_memberships membership
    join public.families family on family.id = membership.family_id
    where membership.family_id = version_row.family_id
      and membership.user_id = actor_user_id
      and membership.role in ('owner', 'manager')
      and (family.deleted_at is null or family.owner_id = actor_user_id)
  ) then
    raise exception 'Not authorized for this family' using errcode = '42501';
  end if;
  if version_row.reference_date is null then
    raise exception 'Set a portrait date before generation' using errcode = '22023';
  end if;
  if version_row.deletion_token is not null then
    raise exception 'Portrait version is being deleted' using errcode = '55000';
  end if;

  photo_owner := split_part(version_row.profile_picture_key, '/', 1);
  expected_key := format(
    '%s/family/%s/portraits/%s/portrait/%s.webp',
    photo_owner, version_row.family_member_id, version_row.id, attempt_token
  );
  if attempt_key is distinct from expected_key then
    raise exception 'Invalid portrait attempt key' using errcode = '22023';
  end if;

  update public.family_member_portrait_versions
  set generation_token = attempt_token,
      generation_started_at = now(),
      generation_output_key = attempt_key,
      illustrated_profile_status = case
        when illustrated_profile_key is null then 'generating'
        else 'ready'
      end
  where id = target_version_id
    and deletion_token is null
    and (
      generation_token is null
      or generation_started_at < now() - interval '5 minutes 30 seconds'
    )
  returning * into result;

  if not found then
    raise exception 'Portrait generation already in progress' using errcode = '55000';
  end if;
  return result;
end;
$$;

create or replace function public.supersede_portrait_generation_workflow_jobs(
  p_portrait_version_id uuid,
  p_current_attempt_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_count integer;
begin
  update public.portrait_generation_jobs
  set status = 'superseded',
      completed_at = now(),
      source_photo_key = null,
      style_reference_key = null,
      portrait_prompt = null
  where portrait_version_id = p_portrait_version_id
    and attempt_id <> p_current_attempt_id
    and status in ('queued', 'running');
  get diagnostics updated_count = row_count;
  return updated_count;
end;
$$;

create or replace function public.reserve_portrait_generation_provider_attempt(
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
  v_job public.portrait_generation_jobs%rowtype;
begin
  if p_provider is null or p_attempt_number is null
    or p_provider not in ('primary', 'fallback')
    or p_attempt_number <> 1 then
    raise exception 'invalid provider';
  end if;

  select * into v_job
  from public.portrait_generation_jobs
  where id = p_job_id
  for update;
  if not found or v_job.status not in ('queued', 'running')
    or v_job.provider_deadline_at <= now() then
    return false;
  end if;

  if p_provider = 'primary' then
    -- A reservation is a one-way paid-call permission. A step replay after
    -- an ambiguous provider response must fail closed rather than pay for a
    -- second portrait; deterministic R2 output reuse handles the safe replay
    -- window where upload completed.
    if v_job.primary_attempts >= 1 then return false; end if;
    update public.portrait_generation_jobs
    set primary_attempts = primary_attempts + 1,
        status = 'running'
    where id = p_job_id;
  else
    if v_job.fallback_attempts >= 1 then return false; end if;
    update public.portrait_generation_jobs
    set fallback_attempts = fallback_attempts + 1,
        status = 'running'
    where id = p_job_id;
  end if;
  return true;
end;
$$;

create or replace function public.publish_portrait_generation_workflow_job(
  p_job_id uuid,
  p_model text
)
returns table (published boolean, already_published boolean, old_key text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.portrait_generation_jobs%rowtype;
  v_version public.family_member_portrait_versions%rowtype;
begin
  if p_model not in ('gpt-image-2', 'gpt-image-1.5') then
    raise exception 'invalid model';
  end if;

  select * into v_job
  from public.portrait_generation_jobs
  where id = p_job_id
  for update;
  if not found then raise exception 'workflow job not found'; end if;

  select * into v_version
  from public.family_member_portrait_versions
  where id = v_job.portrait_version_id
  for update;
  if not found then raise exception 'portrait version not found'; end if;

  if v_job.status = 'succeeded'
    and v_version.illustrated_profile_key = v_job.output_key then
    return query select false, true, v_job.old_portrait_key;
    return;
  end if;

  if v_version.generation_token is distinct from v_job.attempt_id
    or v_version.generation_output_key is distinct from v_job.output_key
    or v_version.deletion_token is not null then
    update public.portrait_generation_jobs
    set status = 'superseded', completed_at = now(),
        source_photo_key = null, style_reference_key = null, portrait_prompt = null
    where id = p_job_id;
    return query select false, false, null::text;
    return;
  end if;

  update public.family_member_portrait_versions
  set illustrated_profile_key = v_job.output_key,
      illustrated_profile_status = 'ready',
      generation_token = null,
      generation_started_at = null,
      generation_output_key = null
  where id = v_job.portrait_version_id;

  update public.portrait_generation_jobs
  set status = 'succeeded', completed_at = now(), model = p_model,
      source_photo_key = null, style_reference_key = null, portrait_prompt = null
  where id = p_job_id;

  return query select true, false, v_version.illustrated_profile_key;
end;
$$;

create or replace function public.fail_portrait_generation_workflow_job(
  p_job_id uuid,
  p_error_code text
)
returns table (terminal_status text, output_key text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.portrait_generation_jobs%rowtype;
  v_version public.family_member_portrait_versions%rowtype;
  current_attempt boolean;
begin
  select * into v_job
  from public.portrait_generation_jobs
  where id = p_job_id
  for update;
  if not found then raise exception 'workflow job not found'; end if;
  if v_job.status in ('failed', 'succeeded', 'superseded') then
    return query select v_job.status, v_job.output_key;
    return;
  end if;

  select * into v_version
  from public.family_member_portrait_versions
  where id = v_job.portrait_version_id
  for update;
  if not found then raise exception 'portrait version not found'; end if;

  current_attempt := coalesce(
    v_version.generation_token = v_job.attempt_id
      and v_version.generation_output_key = v_job.output_key,
    false
  );
  if current_attempt then
    update public.family_member_portrait_versions
    set illustrated_profile_status = case
          when illustrated_profile_key is null then 'failed'
          else 'ready'
        end,
        generation_token = null,
        generation_started_at = null,
        generation_output_key = null
    where id = v_job.portrait_version_id;
  end if;

  update public.portrait_generation_jobs
  set status = case when current_attempt then 'failed' else 'superseded' end,
      completed_at = now(), error_code = left(coalesce(p_error_code, 'GENERATION_FAILED'), 100),
      source_photo_key = null, style_reference_key = null, portrait_prompt = null
  where id = p_job_id;

  return query select case when current_attempt then 'failed' else 'superseded' end, v_job.output_key;
end;
$$;

create or replace function public.reconcile_portrait_generation_workflow_job(
  p_job_id uuid,
  p_model text
)
returns table (published boolean, already_published boolean, old_key text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.portrait_generation_jobs%rowtype;
begin
  select * into v_job
  from public.portrait_generation_jobs
  where id = p_job_id
  for update;
  if not found then
    return query select false, false, null::text;
    return;
  end if;
  if v_job.status in ('queued', 'running', 'succeeded') then
    return query
    select * from public.publish_portrait_generation_workflow_job(p_job_id, p_model);
    return;
  end if;
  return query select false, false, null::text;
end;
$$;

revoke all on function public.supersede_portrait_generation_workflow_jobs(uuid, uuid) from public, anon, authenticated;
revoke all on function public.reserve_portrait_generation_provider_attempt(uuid, text, smallint) from public, anon, authenticated;
revoke all on function public.publish_portrait_generation_workflow_job(uuid, text) from public, anon, authenticated;
revoke all on function public.fail_portrait_generation_workflow_job(uuid, text) from public, anon, authenticated;
revoke all on function public.reconcile_portrait_generation_workflow_job(uuid, text) from public, anon, authenticated;
grant execute on function public.supersede_portrait_generation_workflow_jobs(uuid, uuid) to service_role;
grant execute on function public.reserve_portrait_generation_provider_attempt(uuid, text, smallint) to service_role;
grant execute on function public.publish_portrait_generation_workflow_job(uuid, text) to service_role;
grant execute on function public.fail_portrait_generation_workflow_job(uuid, text) to service_role;
grant execute on function public.reconcile_portrait_generation_workflow_job(uuid, text) to service_role;

-- Deleting a member or hard-deleting a family is a multi-system operation:
-- database rows are retained while R2 is enumerated and cleaned, then a
-- cascade removes the rows.  These durable fences close the otherwise
-- possible list -> late Workflow upload -> cascade race.  A family fence is
-- used only by account purge; a member fence is the narrower manual-delete
-- path.  Both are service-only and are released by their exact UUID if R2
-- cleanup cannot complete.
alter table public.families
  add column if not exists deletion_fence_token uuid,
  add column if not exists deletion_fence_started_at timestamptz;

alter table public.family_members
  add column if not exists deletion_fence_token uuid,
  add column if not exists deletion_fence_started_at timestamptz;

create index if not exists families_deletion_fence_idx
  on public.families (id) where deletion_fence_token is not null;
create index if not exists family_members_deletion_fence_idx
  on public.family_members (family_id, id) where deletion_fence_token is not null;

-- These columns are control-plane state, not household-editable profile
-- fields. RLS permits managers to edit family/member rows, so enforce this
-- at the row layer instead of relying on table-level grants alone.
create or replace function public.protect_family_deletion_fence_columns()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- SECURITY DEFINER fence RPCs are called for an authenticated user, so a
  -- request JWT/sub is deliberately still present.  `current_user` is the
  -- execution role here: direct client DML runs as anon/authenticated while
  -- the definer-owned RPC body runs as its privileged owner.
  if current_user in ('anon', 'authenticated') and (
    tg_op = 'INSERT' and (
      new.deletion_fence_token is not null
      or new.deletion_fence_started_at is not null
    )
  or tg_op = 'UPDATE' and (
    new.deletion_fence_token is distinct from old.deletion_fence_token
    or new.deletion_fence_started_at is distinct from old.deletion_fence_started_at
  )) then
    raise exception 'Deletion fence fields are service-managed' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function public.protect_family_member_deletion_fence_columns()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user in ('anon', 'authenticated') and (
    tg_op = 'INSERT' and (
      new.deletion_fence_token is not null
      or new.deletion_fence_started_at is not null
    )
    or tg_op = 'UPDATE' and (
      new.deletion_fence_token is distinct from old.deletion_fence_token
      or new.deletion_fence_started_at is distinct from old.deletion_fence_started_at
    )
  ) then
    raise exception 'Deletion fence fields are service-managed' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_families_deletion_fence_columns on public.families;
create trigger protect_families_deletion_fence_columns
  before insert or update of deletion_fence_token, deletion_fence_started_at
  on public.families
  for each row execute function public.protect_family_deletion_fence_columns();

drop trigger if exists protect_family_members_deletion_fence_columns on public.family_members;
create trigger protect_family_members_deletion_fence_columns
  before insert or update of deletion_fence_token, deletion_fence_started_at
  on public.family_members
  for each row execute function public.protect_family_member_deletion_fence_columns();

-- Claiming a portrait takes share locks on the same family/member rows that a
-- deletion fence updates.  This gives a clean ordering: an already-claimed
-- fresh generation makes deletion defer; a committed fence makes a later
-- claim fail before it can create an R2-producing job.
create or replace function public.claim_family_member_portrait_generation(
  target_version_id uuid,
  attempt_token uuid,
  attempt_key text,
  actor_user_id uuid
)
returns public.family_member_portrait_versions
language plpgsql
security definer
set search_path = public
as $$
declare
  version_row public.family_member_portrait_versions%rowtype;
  expected_key text;
  photo_owner text;
  result public.family_member_portrait_versions%rowtype;
  family_fence uuid;
  member_fence uuid;
begin
  select * into version_row
  from public.family_member_portrait_versions
  where id = target_version_id;
  if not found then raise exception 'Portrait version not found' using errcode = 'P0002'; end if;

  select deletion_fence_token into family_fence
  from public.families
  where id = version_row.family_id
  for share;
  if not found then raise exception 'Family not found' using errcode = 'P0002'; end if;
  if family_fence is not null then
    raise exception 'Family deletion is in progress' using errcode = '55000';
  end if;

  select deletion_fence_token into member_fence
  from public.family_members
  where id = version_row.family_member_id
  for share;
  if not found then raise exception 'Family member not found' using errcode = 'P0002'; end if;
  if member_fence is not null then
    raise exception 'Family member deletion is in progress' using errcode = '55000';
  end if;

  perform 1
  from public.portrait_generation_jobs job
  where job.portrait_version_id = target_version_id
  order by job.id
  for update;
  if exists (
    select 1
    from public.portrait_generation_jobs job
    where job.portrait_version_id = target_version_id
      and job.status in ('queued', 'running')
      and job.upload_token is not null
      and job.upload_started_at >= now() - interval '5 minutes 30 seconds'
  ) then
    raise exception 'Portrait output upload is still active' using errcode = '55000';
  end if;

  -- The initial read is only used to locate the family/member lock rows.
  -- Re-read the publication target after the job locks: a successful
  -- Workflow publish in that gap must make an automatic recovery a no-op,
  -- not a new paid attempt on an already-ready portrait.
  select * into result
  from public.family_member_portrait_versions
  where id = target_version_id
  for update;
  if not found then raise exception 'Portrait version not found' using errcode = 'P0002'; end if;
  if result.generation_token is distinct from version_row.generation_token
    or result.generation_started_at is distinct from version_row.generation_started_at
    or result.generation_output_key is distinct from version_row.generation_output_key
    or result.illustrated_profile_key is distinct from version_row.illustrated_profile_key
    or result.illustrated_profile_status is distinct from version_row.illustrated_profile_status
    or result.deletion_token is distinct from version_row.deletion_token then
    raise exception 'Portrait generation was superseded' using errcode = '55000';
  end if;

  if not exists (
    select 1
    from public.family_memberships membership
    join public.families family on family.id = membership.family_id
    where membership.family_id = version_row.family_id
      and membership.user_id = actor_user_id
      and membership.role in ('owner', 'manager')
      and (family.deleted_at is null or family.owner_id = actor_user_id)
  ) then
    raise exception 'Not authorized for this family' using errcode = '42501';
  end if;
  if version_row.reference_date is null then
    raise exception 'Set a portrait date before generation' using errcode = '22023';
  end if;
  if version_row.deletion_token is not null then
    raise exception 'Portrait version is being deleted' using errcode = '55000';
  end if;

  photo_owner := split_part(version_row.profile_picture_key, '/', 1);
  expected_key := format(
    '%s/family/%s/portraits/%s/portrait/%s.webp',
    photo_owner, version_row.family_member_id, version_row.id, attempt_token
  );
  if attempt_key is distinct from expected_key then
    raise exception 'Invalid portrait attempt key' using errcode = '22023';
  end if;

  update public.family_member_portrait_versions
  set generation_token = attempt_token,
      generation_started_at = now(),
      generation_output_key = attempt_key,
      illustrated_profile_status = case
        when illustrated_profile_key is null then 'generating'
        else 'ready'
      end
  where id = target_version_id
    and deletion_token is null
    and generation_token is not distinct from version_row.generation_token
    and generation_started_at is not distinct from version_row.generation_started_at
    and generation_output_key is not distinct from version_row.generation_output_key
    and illustrated_profile_key is not distinct from version_row.illustrated_profile_key
    and illustrated_profile_status is not distinct from version_row.illustrated_profile_status
    and (
      generation_token is null
      or generation_started_at < now() - interval '5 minutes 30 seconds'
    )
  returning * into result;

  if not found then
    raise exception 'Portrait generation already in progress' using errcode = '55000';
  end if;
  return result;
end;
$$;

-- The legacy rollback path still finalizes through this RPC.  A durable
-- member/family deletion fence owns `deletion_token`, so a late waitUntil
-- completion must lose its CAS instead of publishing bytes after R2 has been
-- enumerated for deletion.
create or replace function public.finish_family_member_portrait_generation(
  target_version_id uuid,
  attempt_token uuid,
  generated_portrait_key text
)
returns public.family_member_portrait_versions
language plpgsql
security definer
set search_path = public
as $$
declare result public.family_member_portrait_versions%rowtype;
begin
  update public.family_member_portrait_versions
  set illustrated_profile_key = generated_portrait_key,
      illustrated_profile_status = 'ready',
      generation_token = null,
      generation_started_at = null,
      generation_output_key = null
  where id = target_version_id
    and generation_token = attempt_token
    and generation_output_key = generated_portrait_key
    and deletion_token is null
  returning * into result;
  if not found then raise exception 'Portrait generation claim lost' using errcode = '55000'; end if;
  return result;
end;
$$;

create or replace function public.fail_family_member_portrait_generation(
  target_version_id uuid,
  attempt_token uuid
)
returns public.family_member_portrait_versions
language plpgsql
security definer
set search_path = public
as $$
declare result public.family_member_portrait_versions%rowtype;
begin
  update public.family_member_portrait_versions
  set illustrated_profile_status = case
        when illustrated_profile_key is null then 'failed'
        else 'ready'
      end,
      generation_token = null,
      generation_started_at = null,
      generation_output_key = null
  where id = target_version_id
    and generation_token = attempt_token
    and deletion_token is null
  returning * into result;
  if not found then raise exception 'Portrait generation claim lost' using errcode = '55000'; end if;
  return result;
end;
$$;

-- Creation is also fenced: without this a new portrait version could be
-- inserted after a member/family cleanup had enumerated its existing R2
-- prefixes.
create or replace function public.create_family_member_portrait_version(
  version_id uuid,
  target_family_member_id uuid,
  portrait_reference_date date,
  portrait_date_source text,
  source_profile_picture_key text
)
returns public.family_member_portrait_versions
language plpgsql
security definer
set search_path = public
as $$
declare
  member_row public.family_members%rowtype;
  result public.family_member_portrait_versions%rowtype;
  expected_key text;
  family_fence uuid;
  member_family_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = 'P0001';
  end if;

  select family_id into member_family_id
  from public.family_members
  where id = target_family_member_id;
  if not found then
    raise exception 'Family member not found' using errcode = 'P0002';
  end if;

  select deletion_fence_token into family_fence
  from public.families
  where id = member_family_id
  for share;
  if not found then
    raise exception 'Family not found' using errcode = 'P0002';
  end if;
  if family_fence is not null then
    raise exception 'Family deletion is in progress' using errcode = '55000';
  end if;

  select * into member_row
  from public.family_members
  where id = target_family_member_id
    and family_id = member_family_id
  for share;
  if not found then
    raise exception 'Family member not found' using errcode = 'P0002';
  end if;
  if member_row.deletion_fence_token is not null then
    raise exception 'Family member deletion is in progress' using errcode = '55000';
  end if;
  if not public.has_family_role(member_row.family_id, array['owner', 'manager']) then
    raise exception 'Not authorized for this family' using errcode = '42501';
  end if;
  if portrait_date_source not in ('exif', 'manual', 'default_today') then
    raise exception 'Invalid portrait date source' using errcode = '22023';
  end if;
  if portrait_reference_date is null
    or portrait_reference_date > public.current_user_local_date()
    or (member_row.date_of_birth is not null and portrait_reference_date < member_row.date_of_birth)
  then
    raise exception 'Portrait date is outside the allowed range' using errcode = '22023';
  end if;

  expected_key := format(
    '%s/family/%s/portraits/%s/photo.jpg',
    auth.uid(), target_family_member_id, version_id
  );
  if source_profile_picture_key is distinct from expected_key then
    raise exception 'Invalid portrait source key' using errcode = '22023';
  end if;

  insert into public.family_member_portrait_versions (
    id, family_id, family_member_id, user_id, reference_date, date_source,
    profile_picture_key
  ) values (
    version_id, member_row.family_id, member_row.id, auth.uid(),
    portrait_reference_date, portrait_date_source, source_profile_picture_key
  ) returning * into result;

  return result;
end;
$$;

-- Keep single-version deletion in the same family -> member -> version lock
-- order as the wider cleanup fences.  The original implementation locked the
-- version first, which could deadlock against a member cleanup holding the
-- member row while waiting to fence that version.
create or replace function public.claim_family_member_portrait_deletion(
  target_version_id uuid,
  delete_token uuid,
  actor_user_id uuid
)
returns public.family_member_portrait_versions
language plpgsql
security definer
set search_path = public
as $$
declare
  version_row public.family_member_portrait_versions%rowtype;
  member_row public.family_members%rowtype;
  total_count integer;
  usable_count integer;
  result public.family_member_portrait_versions%rowtype;
  family_fence uuid;
begin
  select * into version_row
  from public.family_member_portrait_versions
  where id = target_version_id;
  if not found then raise exception 'Portrait version not found' using errcode = 'P0002'; end if;

  select deletion_fence_token into family_fence
  from public.families
  where id = version_row.family_id
  for share;
  if family_fence is not null then
    raise exception 'Family deletion is in progress' using errcode = '55000';
  end if;

  select * into member_row
  from public.family_members
  where id = version_row.family_member_id
  for update;
  if not found then raise exception 'Family member not found' using errcode = 'P0002'; end if;
  if member_row.deletion_fence_token is not null then
    raise exception 'Family member deletion is in progress' using errcode = '55000';
  end if;

  select * into version_row
  from public.family_member_portrait_versions
  where id = target_version_id
  for update;
  if not found then raise exception 'Portrait version not found' using errcode = 'P0002'; end if;
  if not exists (
    select 1
    from public.family_memberships membership
    join public.families family on family.id = membership.family_id
    where membership.family_id = version_row.family_id
      and membership.user_id = actor_user_id
      and membership.role in ('owner', 'manager')
      and (family.deleted_at is null or family.owner_id = actor_user_id)
  ) then
    raise exception 'Not authorized for this family' using errcode = '42501';
  end if;
  if version_row.generation_token is not null then
    raise exception 'Portrait version is generating' using errcode = '55000';
  end if;
  if version_row.deletion_token is not null then
    raise exception 'Portrait deletion already in progress' using errcode = '55000';
  end if;

  select count(*), count(*) filter (
    where illustrated_profile_key is not null and deletion_token is null
  ) into total_count, usable_count
  from public.family_member_portrait_versions
  where family_member_id = version_row.family_member_id
    and deletion_token is null;

  if total_count <= 1 then raise exception 'A family member needs one portrait version' using errcode = '23514'; end if;
  if version_row.illustrated_profile_key is not null and usable_count <= 1 then
    raise exception 'The last usable portrait cannot be deleted' using errcode = '23514';
  end if;

  update public.family_member_portrait_versions
  set deletion_token = delete_token, deletion_started_at = now()
  where id = target_version_id and deletion_token is null
  returning * into result;
  if not found then raise exception 'Portrait deletion already in progress' using errcode = '55000'; end if;
  return result;
end;
$$;

create or replace function public.prevent_memory_illustration_during_family_deletion()
returns trigger
language plpgsql
set search_path = public
as $$
declare family_fence uuid;
begin
  if new.illustration_generation_attempt_id is not null
    and (tg_op = 'INSERT' or new.illustration_generation_attempt_id is distinct from old.illustration_generation_attempt_id) then
    select deletion_fence_token into family_fence
    from public.families
    where id = new.family_id
    for share;
    if family_fence is not null then
      raise exception 'Family deletion is in progress' using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_memory_illustration_during_family_deletion on public.memories;
drop trigger if exists prevent_memory_illustration_during_family_deletion_update on public.memories;
create trigger prevent_memory_illustration_during_family_deletion
  before insert
  on public.memories
  for each row execute function public.prevent_memory_illustration_during_family_deletion();
create trigger prevent_memory_illustration_during_family_deletion_update
  before update of illustration_generation_attempt_id
  on public.memories
  for each row execute function public.prevent_memory_illustration_during_family_deletion();

-- Lock order is deliberate: family/member fence rows -> durable jobs -> their
-- publication rows. Workflow publish uses job -> publication row, so this
-- avoids the inverse job/version and job/memory deadlocks while still making
-- the freshness decision and fence transition one transaction.
create or replace function public.claim_family_member_deletion_fence(
  p_family_member_id uuid,
  p_delete_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  member_row public.family_members%rowtype;
  member_family_id uuid;
  family_fence uuid;
  stale_token uuid;
begin
  select family_id into member_family_id
  from public.family_members
  where id = p_family_member_id;
  if not found then return false; end if;

  select deletion_fence_token into family_fence
  from public.families
  where id = member_family_id
  for share;
  if family_fence is not null then
    raise exception 'Family deletion is in progress' using errcode = '55000';
  end if;

  select * into member_row
  from public.family_members
  where id = p_family_member_id and family_id = member_family_id
  for update;
  if not found then return false; end if;
  if member_row.deletion_fence_token is not null then
    if member_row.deletion_fence_started_at >= now() - interval '10 minutes' then
      raise exception 'Family member deletion already in progress' using errcode = '55000';
    end if;
    stale_token := member_row.deletion_fence_token;
    update public.family_member_portrait_versions
    set deletion_token = null, deletion_started_at = null
    where family_member_id = p_family_member_id and deletion_token = stale_token;
    update public.family_members
    set deletion_fence_token = null, deletion_fence_started_at = null
    where id = p_family_member_id and deletion_fence_token = stale_token;
  end if;

  perform 1
  from public.portrait_generation_jobs job
  join public.family_member_portrait_versions version
    on version.id = job.portrait_version_id
  where version.family_member_id = p_family_member_id
  order by job.id
  for update of job;

  perform 1
  from public.family_member_portrait_versions version
  where version.family_member_id = p_family_member_id
  order by version.id
  for update;

  if exists (
    select 1
    from public.portrait_generation_jobs job
    join public.family_member_portrait_versions version
      on version.id = job.portrait_version_id
    where version.family_member_id = p_family_member_id
      and job.status in ('queued', 'running')
      and (
        job.started_at >= now() - interval '5 minutes 30 seconds'
        or (job.upload_token is not null and job.upload_started_at >= now() - interval '5 minutes 30 seconds')
      )
  ) or exists (
    select 1
    from public.family_member_portrait_versions version
    where version.family_member_id = p_family_member_id
      and version.generation_token is not null
      and version.generation_started_at >= now() - interval '5 minutes 30 seconds'
  ) then
    raise exception 'Fresh portrait generation is still active' using errcode = '55000';
  end if;

  if exists (
    select 1 from public.family_member_portrait_versions
    where family_member_id = p_family_member_id and deletion_token is not null
  ) then
    raise exception 'Portrait deletion already in progress' using errcode = '55000';
  end if;

  update public.family_members
  set deletion_fence_token = p_delete_token,
      deletion_fence_started_at = now()
  where id = p_family_member_id;

  update public.family_member_portrait_versions
  set deletion_token = p_delete_token,
      deletion_started_at = now()
  where family_member_id = p_family_member_id;

  update public.portrait_generation_jobs job
  set status = 'superseded', completed_at = now(),
      source_photo_key = null, style_reference_key = null, portrait_prompt = null,
      upload_token = null, upload_started_at = null
  from public.family_member_portrait_versions version
  where job.portrait_version_id = version.id
    and version.family_member_id = p_family_member_id
    and job.status in ('queued', 'running');

  return true;
end;
$$;

create or replace function public.release_family_member_deletion_fence(
  p_family_member_id uuid,
  p_delete_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare member_row public.family_members%rowtype;
begin
  select * into member_row
  from public.family_members
  where id = p_family_member_id
  for update;
  if not found or member_row.deletion_fence_token is distinct from p_delete_token then
    return false;
  end if;

  update public.family_member_portrait_versions
  set deletion_token = null, deletion_started_at = null
  where family_member_id = p_family_member_id
    and deletion_token = p_delete_token;

  update public.family_members
  set deletion_fence_token = null, deletion_fence_started_at = null
  where id = p_family_member_id
    and deletion_fence_token = p_delete_token;
  return true;
end;
$$;

create or replace function public.claim_family_deletion_fence(
  p_family_id uuid,
  p_delete_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  family_row public.families%rowtype;
  stale_token uuid;
begin
  select * into family_row
  from public.families
  where id = p_family_id
  for update;
  if not found then return false; end if;
  if family_row.deletion_fence_token is not null then
    if family_row.deletion_fence_started_at >= now() - interval '10 minutes' then
      raise exception 'Family deletion already in progress' using errcode = '55000';
    end if;
    stale_token := family_row.deletion_fence_token;
    perform 1
    from public.family_members member
    where member.family_id = p_family_id
    order by member.id
    for update;
    update public.family_member_portrait_versions
    set deletion_token = null, deletion_started_at = null
    where family_id = p_family_id and deletion_token = stale_token;
    update public.family_members
    set deletion_fence_token = null, deletion_fence_started_at = null
    where family_id = p_family_id and deletion_fence_token = stale_token;
    update public.families
    set deletion_fence_token = null, deletion_fence_started_at = null
    where id = p_family_id and deletion_fence_token = stale_token;
    family_row.deletion_fence_token := null;
  end if;

  perform 1
  from public.family_members member
  where member.family_id = p_family_id
  order by member.id
  for update;

  if exists (
    select 1 from public.family_members
    where family_id = p_family_id and deletion_fence_token is not null
  ) then
    raise exception 'Family member deletion already in progress' using errcode = '55000';
  end if;

  perform 1
  from public.portrait_generation_jobs job
  where job.family_id = p_family_id
  order by job.id
  for update;

  perform 1
  from public.memory_illustration_jobs job
  where job.family_id = p_family_id
  order by job.id
  for update;

  perform 1
  from public.family_member_portrait_versions version
  where version.family_id = p_family_id
  order by version.id
  for update;

  perform 1
  from public.memories memory
  where memory.family_id = p_family_id
  order by memory.id
  for update;

  if exists (
    select 1 from public.portrait_generation_jobs
    where family_id = p_family_id
      and status in ('queued', 'running')
      and (
        started_at >= now() - interval '5 minutes 30 seconds'
        or (upload_token is not null and upload_started_at >= now() - interval '5 minutes 30 seconds')
      )
  ) or exists (
    select 1 from public.family_member_portrait_versions
    where family_id = p_family_id
      and generation_token is not null
      and generation_started_at >= now() - interval '5 minutes 30 seconds'
  ) then
    raise exception 'Fresh portrait generation is still active' using errcode = '55000';
  end if;

  if exists (
    select 1 from public.memory_illustration_jobs
    where family_id = p_family_id
      and status in ('queued', 'running')
      and (
        started_at >= now() - interval '5 minutes 30 seconds'
        or (upload_token is not null and upload_started_at >= now() - interval '5 minutes 30 seconds')
      )
  ) or exists (
    select 1 from public.memories
    where family_id = p_family_id
      and illustration_generation_attempt_id is not null
      and illustration_generation_started_at >= now() - interval '5 minutes 30 seconds'
  ) then
    raise exception 'Fresh illustration generation is still active' using errcode = '55000';
  end if;

  if exists (
    select 1 from public.family_member_portrait_versions
    where family_id = p_family_id and deletion_token is not null
  ) then
    raise exception 'Portrait deletion already in progress' using errcode = '55000';
  end if;

  update public.families
  set deletion_fence_token = p_delete_token,
      deletion_fence_started_at = now()
  where id = p_family_id;

  update public.family_members
  set deletion_fence_token = p_delete_token,
      deletion_fence_started_at = now()
  where family_id = p_family_id;

  update public.family_member_portrait_versions
  set deletion_token = p_delete_token,
      deletion_started_at = now()
  where family_id = p_family_id;

  update public.portrait_generation_jobs
  set status = 'superseded', completed_at = now(),
      source_photo_key = null, style_reference_key = null, portrait_prompt = null,
      upload_token = null, upload_started_at = null
  where family_id = p_family_id and status in ('queued', 'running');

  update public.memory_illustration_jobs
  set status = 'superseded', completed_at = now(),
      safe_scene_description = null, reference_candidates = '[]'::jsonb,
      illustration_prompt = null, upload_token = null, upload_started_at = null
  where family_id = p_family_id and status in ('queued', 'running');

  update public.memories
  set illustration_generation_attempt_id = null,
      illustration_generation_started_at = null,
      illustration_status = case
        when illustration_key is not null and illustration_generation_id is not null then 'ready'
        when memory_type = 'text_illustration' then 'pending'
        else 'none'
      end
  where family_id = p_family_id
    and illustration_generation_attempt_id is not null;

  return true;
end;
$$;

create or replace function public.release_family_deletion_fence(
  p_family_id uuid,
  p_delete_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare family_row public.families%rowtype;
begin
  select * into family_row
  from public.families
  where id = p_family_id
  for update;
  if not found or family_row.deletion_fence_token is distinct from p_delete_token then
    return false;
  end if;

  update public.family_member_portrait_versions
  set deletion_token = null, deletion_started_at = null
  where family_id = p_family_id and deletion_token = p_delete_token;

  update public.family_members
  set deletion_fence_token = null, deletion_fence_started_at = null
  where family_id = p_family_id and deletion_fence_token = p_delete_token;

  update public.families
  set deletion_fence_token = null, deletion_fence_started_at = null
  where id = p_family_id and deletion_fence_token = p_delete_token;
  return true;
end;
$$;

-- R2 cleanup is intentionally outside Postgres, so only the final cascade is
-- transactional. Verify every preclaimed owned-family fence before deleting
-- any row; a partial R2 failure therefore leaves all database rows intact for
-- the next cron retry.
create or replace function public.finish_owned_family_deletion_fences(
  p_owner_id uuid,
  p_fences jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  fence record;
  expected_count integer;
  deleted_count integer;
begin
  if coalesce(jsonb_typeof(p_fences), '') <> 'array' then
    raise exception 'Invalid deletion fences' using errcode = '22023';
  end if;

  select count(*) into expected_count
  from jsonb_to_recordset(p_fences) as input(family_id uuid, delete_token uuid);
  if expected_count = 0 then return true; end if;

  for fence in
    select *
    from jsonb_to_recordset(p_fences) as input(family_id uuid, delete_token uuid)
    order by family_id
  loop
    perform 1
    from public.families
    where id = fence.family_id
      and owner_id = p_owner_id
      and deletion_fence_token = fence.delete_token
    for update;
    if not found then return false; end if;
  end loop;

  if exists (
    select 1
    from public.families family
    where family.owner_id = p_owner_id
      and not exists (
        select 1
        from jsonb_to_recordset(p_fences) as input(family_id uuid, delete_token uuid)
        where input.family_id = family.id
      )
  ) then
    return false;
  end if;

  delete from public.families family
  where family.owner_id = p_owner_id
    and exists (
      select 1
      from jsonb_to_recordset(p_fences) as input(family_id uuid, delete_token uuid)
      where input.family_id = family.id
        and input.delete_token = family.deletion_fence_token
    );
  get diagnostics deleted_count = row_count;
  return deleted_count = expected_count;
end;
$$;

revoke all on function public.claim_family_member_deletion_fence(uuid, uuid) from public, anon, authenticated;
revoke all on function public.release_family_member_deletion_fence(uuid, uuid) from public, anon, authenticated;
revoke all on function public.claim_family_deletion_fence(uuid, uuid) from public, anon, authenticated;
revoke all on function public.release_family_deletion_fence(uuid, uuid) from public, anon, authenticated;
revoke all on function public.finish_owned_family_deletion_fences(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.claim_family_member_deletion_fence(uuid, uuid) to service_role;
grant execute on function public.release_family_member_deletion_fence(uuid, uuid) to service_role;
grant execute on function public.claim_family_deletion_fence(uuid, uuid) to service_role;
grant execute on function public.release_family_deletion_fence(uuid, uuid) to service_role;
grant execute on function public.finish_owned_family_deletion_fences(uuid, jsonb) to service_role;

-- An R2 PUT cannot participate in the Postgres transaction that claims a
-- deletion fence.  The exact-token upload lease makes that external side
-- effect visible to deletion/recovery: authorize immediately before PUT,
-- retain the lease when PUT/bridge completion is ambiguous, and clear it
-- only after the PUT has definitely returned.  The conservative 5:30 bound
-- exceeds the no-retry five-minute Workflow step.
alter table public.portrait_generation_jobs
  add column if not exists upload_token uuid,
  add column if not exists upload_started_at timestamptz,
  add column if not exists last_upload_completed_token uuid;

alter table public.memory_illustration_jobs
  add column if not exists upload_token uuid,
  add column if not exists upload_started_at timestamptz,
  add column if not exists last_upload_completed_token uuid;

create index if not exists portrait_generation_jobs_upload_lease_idx
  on public.portrait_generation_jobs (family_id, upload_started_at)
  where upload_token is not null;
create index if not exists memory_illustration_jobs_upload_lease_idx
  on public.memory_illustration_jobs (family_id, upload_started_at)
  where upload_token is not null;

create or replace function public.authorize_portrait_generation_workflow_upload(
  p_job_id uuid,
  p_output_key text
)
returns table (authorized boolean, upload_token uuid, existing_lease boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.portrait_generation_jobs%rowtype;
  v_version public.family_member_portrait_versions%rowtype;
  v_token uuid;
begin
  -- Keep Workflow lock order: durable job, then publication target.
  select * into v_job
  from public.portrait_generation_jobs
  where id = p_job_id
  for update;
  if not found
    or v_job.output_key is distinct from p_output_key
    or v_job.status not in ('queued', 'running') then
    return query select false, null::uuid, false;
    return;
  end if;

  select * into v_version
  from public.family_member_portrait_versions
  where id = v_job.portrait_version_id
  for update;
  if not found
    or v_version.generation_token is distinct from v_job.attempt_id
    or v_version.generation_output_key is distinct from v_job.output_key
    or v_version.deletion_token is not null then
    update public.portrait_generation_jobs
    set status = 'superseded', completed_at = now(),
        source_photo_key = null, style_reference_key = null, portrait_prompt = null,
        upload_token = null, upload_started_at = null
    where id = p_job_id;
    return query select false, null::uuid, false;
    return;
  end if;

  -- A lost authorize response is replay-safe: the same durable Workflow can
  -- HEAD its deterministic object, complete this exact lease, and publish.
  if v_job.upload_token is not null then
    return query select true, v_job.upload_token, true;
    return;
  end if;
  if v_job.last_upload_completed_token is not null then
    return query select true, v_job.last_upload_completed_token, true;
    return;
  end if;
  if v_job.provider_deadline_at <= now() then
    return query select false, null::uuid, false;
    return;
  end if;

  v_token := gen_random_uuid();
  update public.portrait_generation_jobs
  set upload_token = v_token,
      upload_started_at = now(),
      last_upload_completed_token = null
  where id = p_job_id;
  return query select true, v_token, false;
end;
$$;

create or replace function public.record_portrait_generation_workflow_upload_complete(
  p_job_id uuid,
  p_output_key text,
  p_upload_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.portrait_generation_jobs%rowtype;
  v_version public.family_member_portrait_versions%rowtype;
begin
  select * into v_job
  from public.portrait_generation_jobs
  where id = p_job_id
  for update;
  if not found or v_job.output_key is distinct from p_output_key then return false; end if;

  -- Lost bridge responses are safe to replay with the exact token even if a
  -- subsequent publish has already made the job terminal.
  if v_job.last_upload_completed_token = p_upload_token then return true; end if;
  if v_job.status not in ('queued', 'running')
    or v_job.upload_token is distinct from p_upload_token
    or v_job.upload_started_at is null then
    return false;
  end if;

  select * into v_version
  from public.family_member_portrait_versions
  where id = v_job.portrait_version_id
  for update;
  if not found
    or v_version.generation_token is distinct from v_job.attempt_id
    or v_version.generation_output_key is distinct from v_job.output_key
    or v_version.deletion_token is not null then
    return false;
  end if;

  update public.portrait_generation_jobs
  set upload_token = null,
      upload_started_at = null,
      last_upload_completed_token = p_upload_token
  where id = p_job_id
    and upload_token = p_upload_token;
  return found;
end;
$$;

create or replace function public.authorize_memory_illustration_workflow_upload(
  p_job_id uuid,
  p_output_key text
)
returns table (authorized boolean, upload_token uuid, existing_lease boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.memory_illustration_jobs%rowtype;
  v_memory public.memories%rowtype;
  v_family_fence uuid;
  v_token uuid;
begin
  select * into v_job
  from public.memory_illustration_jobs
  where id = p_job_id
  for update;
  if not found
    or v_job.output_key is distinct from p_output_key
    or v_job.status not in ('queued', 'running') then
    return query select false, null::uuid, false;
    return;
  end if;

  select * into v_memory
  from public.memories
  where id = v_job.memory_id
  for update;
  select deletion_fence_token into v_family_fence
  from public.families
  where id = v_job.family_id;
  if not found
    or v_memory.illustration_generation_attempt_id is distinct from v_job.attempt_id
    or v_family_fence is not null then
    update public.memory_illustration_jobs
    set status = 'superseded', completed_at = now(),
        safe_scene_description = null, reference_candidates = '[]'::jsonb,
        illustration_prompt = null, upload_token = null, upload_started_at = null
    where id = p_job_id;
    return query select false, null::uuid, false;
    return;
  end if;

  if v_job.upload_token is not null then
    return query select true, v_job.upload_token, true;
    return;
  end if;
  if v_job.last_upload_completed_token is not null then
    return query select true, v_job.last_upload_completed_token, true;
    return;
  end if;
  if v_job.provider_deadline_at <= now() then
    return query select false, null::uuid, false;
    return;
  end if;

  v_token := gen_random_uuid();
  update public.memory_illustration_jobs
  set upload_token = v_token,
      upload_started_at = now(),
      last_upload_completed_token = null
  where id = p_job_id;
  return query select true, v_token, false;
end;
$$;

create or replace function public.record_memory_illustration_workflow_upload_complete(
  p_job_id uuid,
  p_output_key text,
  p_upload_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.memory_illustration_jobs%rowtype;
  v_memory public.memories%rowtype;
  v_family_fence uuid;
begin
  select * into v_job
  from public.memory_illustration_jobs
  where id = p_job_id
  for update;
  if not found or v_job.output_key is distinct from p_output_key then return false; end if;
  if v_job.last_upload_completed_token = p_upload_token then return true; end if;
  if v_job.status not in ('queued', 'running')
    or v_job.upload_token is distinct from p_upload_token
    or v_job.upload_started_at is null then
    return false;
  end if;

  select * into v_memory
  from public.memories
  where id = v_job.memory_id
  for update;
  select deletion_fence_token into v_family_fence
  from public.families
  where id = v_job.family_id;
  if not found
    or v_memory.illustration_generation_attempt_id is distinct from v_job.attempt_id
    or v_family_fence is not null then
    return false;
  end if;

  update public.memory_illustration_jobs
  set upload_token = null,
      upload_started_at = null,
      last_upload_completed_token = p_upload_token
  where id = p_job_id
    and upload_token = p_upload_token;
  return found;
end;
$$;

-- Publication is allowed only after the exact upload lease was completed.
-- This prevents a caller that merely knows a deterministic output key from
-- bypassing the pre-PUT fence protocol.
create or replace function public.publish_portrait_generation_workflow_job(
  p_job_id uuid,
  p_model text
)
returns table (published boolean, already_published boolean, old_key text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.portrait_generation_jobs%rowtype;
  v_version public.family_member_portrait_versions%rowtype;
begin
  if p_model not in ('gpt-image-2', 'gpt-image-1.5') then
    raise exception 'invalid model';
  end if;
  select * into v_job from public.portrait_generation_jobs where id = p_job_id for update;
  if not found then raise exception 'workflow job not found'; end if;
  select * into v_version from public.family_member_portrait_versions where id = v_job.portrait_version_id for update;
  if not found then raise exception 'portrait version not found'; end if;

  if v_job.status = 'succeeded' and v_version.illustrated_profile_key = v_job.output_key then
    return query select false, true, v_job.old_portrait_key;
    return;
  end if;
  if v_version.generation_token is distinct from v_job.attempt_id
    or v_version.generation_output_key is distinct from v_job.output_key
    or v_version.deletion_token is not null then
    update public.portrait_generation_jobs
    set status = 'superseded', completed_at = now(),
        source_photo_key = null, style_reference_key = null, portrait_prompt = null,
        upload_token = null, upload_started_at = null
    where id = p_job_id;
    return query select false, false, null::text;
    return;
  end if;
  if v_job.upload_token is not null or v_job.upload_started_at is not null
    or v_job.last_upload_completed_token is null then
    raise exception 'portrait upload has not completed' using errcode = '55000';
  end if;

  update public.family_member_portrait_versions
  set illustrated_profile_key = v_job.output_key,
      illustrated_profile_status = 'ready',
      generation_token = null,
      generation_started_at = null,
      generation_output_key = null
  where id = v_job.portrait_version_id;
  update public.portrait_generation_jobs
  set status = 'succeeded', completed_at = now(), model = p_model,
      source_photo_key = null, style_reference_key = null, portrait_prompt = null,
      upload_token = null, upload_started_at = null
  where id = p_job_id;
  return query select true, false, v_version.illustrated_profile_key;
end;
$$;

create or replace function public.fail_portrait_generation_workflow_job(
  p_job_id uuid,
  p_error_code text
)
returns table (terminal_status text, output_key text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.portrait_generation_jobs%rowtype;
  v_version public.family_member_portrait_versions%rowtype;
  current_attempt boolean;
begin
  select * into v_job from public.portrait_generation_jobs where id = p_job_id for update;
  if not found then raise exception 'workflow job not found'; end if;
  if v_job.status in ('failed', 'succeeded', 'superseded') then
    return query select v_job.status, v_job.output_key;
    return;
  end if;
  select * into v_version from public.family_member_portrait_versions where id = v_job.portrait_version_id for update;
  if not found then raise exception 'portrait version not found'; end if;
  current_attempt := coalesce(
    v_version.generation_token = v_job.attempt_id
      and v_version.generation_output_key = v_job.output_key
      and v_version.deletion_token is null,
    false
  );
  if current_attempt then
    update public.family_member_portrait_versions
    set illustrated_profile_status = case when illustrated_profile_key is null then 'failed' else 'ready' end,
        generation_token = null, generation_started_at = null, generation_output_key = null
    where id = v_job.portrait_version_id;
  end if;
  update public.portrait_generation_jobs
  set status = case when current_attempt then 'failed' else 'superseded' end,
      completed_at = now(), error_code = left(coalesce(p_error_code, 'GENERATION_FAILED'), 100),
      source_photo_key = null, style_reference_key = null, portrait_prompt = null,
      upload_token = null, upload_started_at = null
  where id = p_job_id;
  return query select case when current_attempt then 'failed' else 'superseded' end, v_job.output_key;
end;
$$;

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
  v_family_fence uuid;
begin
  select * into v_job from public.memory_illustration_jobs where id = p_job_id for update;
  if not found then raise exception 'workflow job not found'; end if;
  select * into v_memory from public.memories where id = v_job.memory_id for update;
  if not found then raise exception 'memory not found'; end if;
  select deletion_fence_token into v_family_fence from public.families where id = v_job.family_id;

  if v_job.status = 'succeeded' and v_memory.illustration_generation_id = v_job.id then
    return query select false, true, v_job.old_illustration_key;
    return;
  end if;
  if v_memory.illustration_generation_attempt_id is distinct from v_job.attempt_id
    or v_family_fence is not null then
    update public.memory_illustration_jobs
    set status = 'superseded', completed_at = now(), safe_scene_description = null,
      reference_candidates = '[]'::jsonb, illustration_prompt = null,
      upload_token = null, upload_started_at = null
    where id = p_job_id;
    return query select false, false, null::text;
    return;
  end if;
  if v_job.illustration_prompt is null then raise exception 'workflow prompt was not recorded'; end if;
  if v_job.upload_token is not null or v_job.upload_started_at is not null
    or v_job.last_upload_completed_token is null then
    raise exception 'illustration upload has not completed' using errcode = '55000';
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
      reference_candidates = '[]'::jsonb, upload_token = null, upload_started_at = null
  where id = p_job_id;
  return query select true, false, v_memory.illustration_key;
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
  current_attempt boolean;
begin
  select * into v_job from public.memory_illustration_jobs where id = p_job_id for update;
  if not found then raise exception 'workflow job not found'; end if;
  if v_job.status in ('failed', 'succeeded', 'superseded') then
    return query select v_job.status = 'failed', v_job.output_key;
    return;
  end if;
  select * into v_memory from public.memories where id = v_job.memory_id for update;
  if not found then raise exception 'memory not found'; end if;
  current_attempt := v_memory.illustration_generation_attempt_id = v_job.attempt_id;
  if current_attempt then
    update public.memories
    set illustration_generation_attempt_id = null,
        illustration_generation_started_at = null,
        illustration_status = case when illustration_key is not null and illustration_generation_id is not null then 'ready' else 'failed' end
    where id = v_job.memory_id;
  end if;
  update public.memory_illustration_jobs
  set status = case when current_attempt then 'failed' else 'superseded' end,
      completed_at = now(), error_code = p_error_code,
      safe_scene_description = null, reference_candidates = '[]'::jsonb,
      illustration_prompt = null, upload_token = null, upload_started_at = null
  where id = p_job_id;
  return query select current_attempt, v_job.output_key;
end;
$$;

-- Each reservation is a single paid-call permission. A replay with a lost
-- bridge response must fail closed, not issue the same primary/fallback call
-- again. Memory keeps two ordered primary slots and one fallback slot.
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
declare v_job public.memory_illustration_jobs%rowtype;
begin
  if p_provider is null or p_attempt_number is null
    or p_provider not in ('primary', 'fallback') or p_attempt_number < 1
    or (p_provider = 'primary' and p_attempt_number > 2)
    or (p_provider = 'fallback' and p_attempt_number > 1) then
    raise exception 'invalid provider';
  end if;
  select * into v_job from public.memory_illustration_jobs where id = p_job_id for update;
  if not found or v_job.status not in ('queued', 'running')
    or v_job.provider_deadline_at <= now() then
    return false;
  end if;
  if p_provider = 'primary' then
    if v_job.primary_attempts >= p_attempt_number then return false; end if;
    if v_job.primary_attempts + 1 <> p_attempt_number then return false; end if;
    update public.memory_illustration_jobs
    set primary_attempts = primary_attempts + 1, status = 'running'
    where id = p_job_id;
  else
    if v_job.fallback_attempts >= 1 then return false; end if;
    update public.memory_illustration_jobs
    set fallback_attempts = fallback_attempts + 1, status = 'running'
    where id = p_job_id;
  end if;
  return true;
end;
$$;

-- Manual regeneration and stale recovery must not evict a job that has a
-- fresh external upload lease. The caller receives false and leaves the
-- existing memory claim untouched.
create or replace function public.supersede_memory_illustration_workflow_jobs(
  p_memory_id uuid,
  p_current_attempt_id uuid
)
returns table (superseded boolean, output_key text)
language plpgsql
security definer
set search_path = public
as $$
declare v_output_key text;
begin
  perform 1
  from public.memory_illustration_jobs job
  where job.memory_id = p_memory_id
  order by job.id
  for update;
  if exists (
    select 1 from public.memory_illustration_jobs job
    where job.memory_id = p_memory_id
      and job.attempt_id <> p_current_attempt_id
      and job.status in ('queued', 'running')
      and job.upload_token is not null
      and job.upload_started_at >= now() - interval '5 minutes 30 seconds'
  ) then
    return query select false, null::text;
    return;
  end if;
  select job.output_key into v_output_key
  from public.memory_illustration_jobs job
  where job.memory_id = p_memory_id
    and job.attempt_id <> p_current_attempt_id
    and job.status in ('queued', 'running')
  order by job.id
  limit 1;
  update public.memory_illustration_jobs
  set status = 'superseded', completed_at = now(),
      safe_scene_description = null, reference_candidates = '[]'::jsonb,
      illustration_prompt = null, upload_token = null, upload_started_at = null
  where memory_id = p_memory_id
    and attempt_id <> p_current_attempt_id
    and status in ('queued', 'running');
  return query select true, v_output_key;
end;
$$;

-- The memory row is the publication target, so a Cloudflare generation claim
-- locks existing durable jobs first and the memory second. This prevents a
-- stale/manual client claim from replacing an attempt while an upload lease
-- is between authorize and R2 PUT.
create or replace function public.claim_memory_illustration_workflow_generation(
  p_memory_id uuid,
  p_attempt_id uuid,
  p_actor_user_id uuid,
  p_expected_content text,
  p_expected_memory_date date,
  p_expected_memory_type text,
  p_expected_emotion text,
  p_expected_status text,
  p_expected_generation_id uuid,
  p_expected_prior_attempt_id uuid,
  p_expected_illustration_key text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_memory public.memories%rowtype;
begin
  perform 1
  from public.memory_illustration_jobs job
  where job.memory_id = p_memory_id
  order by job.id
  for update;

  select * into v_memory
  from public.memories
  where id = p_memory_id
  for update;
  if not found then return false; end if;
  if not exists (
    select 1
    from public.family_memberships membership
    join public.families family on family.id = membership.family_id
    where membership.family_id = v_memory.family_id
      and membership.user_id = p_actor_user_id
      and membership.role in ('owner', 'manager')
      and (family.deleted_at is null or family.owner_id = p_actor_user_id)
  ) then
    raise exception 'Not authorized for this family' using errcode = '42501';
  end if;
  if v_memory.content is distinct from p_expected_content
    or v_memory.memory_date is distinct from p_expected_memory_date
    or v_memory.memory_type is distinct from p_expected_memory_type
    or v_memory.emotion is distinct from p_expected_emotion
    or v_memory.illustration_status is distinct from p_expected_status
    or v_memory.illustration_generation_id is distinct from p_expected_generation_id
    or v_memory.illustration_generation_attempt_id is distinct from p_expected_prior_attempt_id
    or v_memory.illustration_key is distinct from p_expected_illustration_key then
    return false;
  end if;
  if exists (
    select 1 from public.memory_illustration_jobs job
    where job.memory_id = p_memory_id
      and job.status in ('queued', 'running')
      and job.upload_token is not null
      and job.upload_started_at >= now() - interval '5 minutes 30 seconds'
  ) then
    raise exception 'Illustration output upload is still active' using errcode = '55000';
  end if;

  update public.memories
  set illustration_status = 'generating',
      illustration_generation_started_at = now(),
      illustration_generation_attempt_id = p_attempt_id
  where id = p_memory_id;
  return true;
end;
$$;

create or replace function public.supersede_portrait_generation_workflow_jobs(
  p_portrait_version_id uuid,
  p_current_attempt_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare updated_count integer;
begin
  perform 1
  from public.portrait_generation_jobs job
  where job.portrait_version_id = p_portrait_version_id
  order by job.id
  for update;
  if exists (
    select 1 from public.portrait_generation_jobs job
    where job.portrait_version_id = p_portrait_version_id
      and job.attempt_id <> p_current_attempt_id
      and job.status in ('queued', 'running')
      and job.upload_token is not null
      and job.upload_started_at >= now() - interval '5 minutes 30 seconds'
  ) then
    return 0;
  end if;
  update public.portrait_generation_jobs
  set status = 'superseded', completed_at = now(),
      source_photo_key = null, style_reference_key = null, portrait_prompt = null,
      upload_token = null, upload_started_at = null
  where portrait_version_id = p_portrait_version_id
    and attempt_id <> p_current_attempt_id
    and status in ('queued', 'running');
  get diagnostics updated_count = row_count;
  return updated_count;
end;
$$;

revoke all on function public.authorize_portrait_generation_workflow_upload(uuid, text) from public, anon, authenticated;
revoke all on function public.record_portrait_generation_workflow_upload_complete(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.authorize_memory_illustration_workflow_upload(uuid, text) from public, anon, authenticated;
revoke all on function public.record_memory_illustration_workflow_upload_complete(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.supersede_memory_illustration_workflow_jobs(uuid, uuid) from public, anon, authenticated;
revoke all on function public.claim_memory_illustration_workflow_generation(uuid, uuid, uuid, text, date, text, text, text, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.authorize_portrait_generation_workflow_upload(uuid, text) to service_role;
grant execute on function public.record_portrait_generation_workflow_upload_complete(uuid, text, uuid) to service_role;
grant execute on function public.authorize_memory_illustration_workflow_upload(uuid, text) to service_role;
grant execute on function public.record_memory_illustration_workflow_upload_complete(uuid, text, uuid) to service_role;
grant execute on function public.supersede_memory_illustration_workflow_jobs(uuid, uuid) to service_role;
grant execute on function public.claim_memory_illustration_workflow_generation(uuid, uuid, uuid, text, date, text, text, text, uuid, uuid, text) to service_role;

-- Account deletion has its own operation token. It is distinct from a
-- family R2-cleanup fence: it marks exactly which soft-deleted families a
-- user may restore, and serializes Cancel against the hard-delete cron.
alter table public.user_profiles
  add column if not exists account_deletion_token uuid,
  add column if not exists hard_delete_token uuid,
  add column if not exists hard_delete_started_at timestamptz;
alter table public.families
  add column if not exists account_deletion_token uuid;

create or replace function public.protect_account_deletion_control_columns()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user in ('anon', 'authenticated')
    and (
      new.deleted_at is distinct from old.deleted_at
      or new.scheduled_hard_delete_at is distinct from old.scheduled_hard_delete_at
      or new.account_deletion_token is distinct from old.account_deletion_token
      or new.hard_delete_token is distinct from old.hard_delete_token
      or new.hard_delete_started_at is distinct from old.hard_delete_started_at
    ) then
    raise exception 'Account deletion fields are service-managed' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_account_deletion_control_columns on public.user_profiles;
create trigger protect_account_deletion_control_columns
  before update of deleted_at, scheduled_hard_delete_at, account_deletion_token,
    hard_delete_token, hard_delete_started_at
  on public.user_profiles
  for each row execute function public.protect_account_deletion_control_columns();

create or replace function public.protect_family_deletion_fence_columns()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user in ('anon', 'authenticated') and (
    tg_op = 'INSERT' and (
      new.deletion_fence_token is not null
      or new.deletion_fence_started_at is not null
      or new.account_deletion_token is not null
    )
  or tg_op = 'UPDATE' and (
    new.deletion_fence_token is distinct from old.deletion_fence_token
    or new.deletion_fence_started_at is distinct from old.deletion_fence_started_at
    or new.account_deletion_token is distinct from old.account_deletion_token
  )) then
    raise exception 'Deletion fence fields are service-managed' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function public.protect_family_member_deletion_fence_columns()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user in ('anon', 'authenticated') and (
    tg_op = 'INSERT' and (
      new.deletion_fence_token is not null
      or new.deletion_fence_started_at is not null
    )
    or tg_op = 'UPDATE' and (
      new.deletion_fence_token is distinct from old.deletion_fence_token
      or new.deletion_fence_started_at is distinct from old.deletion_fence_started_at
    )
  ) then
    raise exception 'Deletion fence fields are service-managed' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_families_deletion_fence_columns on public.families;
create trigger protect_families_deletion_fence_columns
  before insert or update of deletion_fence_token, deletion_fence_started_at, account_deletion_token
  on public.families
  for each row execute function public.protect_family_deletion_fence_columns();

drop trigger if exists protect_family_members_deletion_fence_columns on public.family_members;
create trigger protect_family_members_deletion_fence_columns
  before insert or update of deletion_fence_token, deletion_fence_started_at
  on public.family_members
  for each row execute function public.protect_family_member_deletion_fence_columns();

create or replace function public.schedule_account_deletion(
  p_owner_id uuid,
  p_operation_token uuid,
  p_scheduled_hard_delete_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_profile public.user_profiles%rowtype;
begin
  select * into v_profile from public.user_profiles where id = p_owner_id for update;
  if not found then raise exception 'User profile not found' using errcode = 'P0002'; end if;
  if v_profile.hard_delete_token is not null
    and v_profile.hard_delete_started_at >= now() - interval '10 minutes' then
    raise exception 'Hard account deletion is in progress' using errcode = '55000';
  end if;
  if v_profile.deleted_at is not null then
    if v_profile.scheduled_hard_delete_at is null
      or v_profile.scheduled_hard_delete_at <= now() then
      raise exception 'Hard account deletion is in progress' using errcode = '55000';
    end if;
    if v_profile.account_deletion_token is null then
      raise exception 'Account deletion operation is missing its token' using errcode = '55000';
    end if;
    return v_profile.account_deletion_token;
  end if;
  update public.user_profiles
  set deleted_at = now(),
      scheduled_hard_delete_at = p_scheduled_hard_delete_at,
      account_deletion_token = p_operation_token,
      hard_delete_token = null,
      hard_delete_started_at = null
  where id = p_owner_id;
  update public.families
  set deleted_at = now(), account_deletion_token = p_operation_token
  where owner_id = p_owner_id and deleted_at is null;
  return p_operation_token;
end;
$$;

create or replace function public.cancel_account_deletion(
  p_owner_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_profile public.user_profiles%rowtype;
declare v_operation_token uuid;
begin
  select * into v_profile from public.user_profiles where id = p_owner_id for update;
  if not found then return false; end if;
  if v_profile.deleted_at is not null
    and (
      v_profile.scheduled_hard_delete_at is null
      or v_profile.scheduled_hard_delete_at <= now()
    ) then
    return false;
  end if;
  if v_profile.hard_delete_token is not null
    and v_profile.hard_delete_started_at >= now() - interval '10 minutes' then
    return false;
  end if;
  v_operation_token := v_profile.account_deletion_token;
  update public.user_profiles
  set deleted_at = null,
      scheduled_hard_delete_at = null,
      account_deletion_token = null,
      hard_delete_token = null,
      hard_delete_started_at = null
  where id = p_owner_id;
  if v_operation_token is not null then
    update public.families
    set deleted_at = null, account_deletion_token = null
    where owner_id = p_owner_id
      and account_deletion_token = v_operation_token;
  end if;
  return true;
end;
$$;

create or replace function public.claim_account_hard_deletion(
  p_owner_id uuid,
  p_hard_delete_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_profile public.user_profiles%rowtype;
begin
  select * into v_profile from public.user_profiles where id = p_owner_id for update;
  if not found
    or v_profile.deleted_at is null
    or v_profile.scheduled_hard_delete_at is null
    or v_profile.scheduled_hard_delete_at > now() then
    return false;
  end if;
  if v_profile.hard_delete_token is not null
    and v_profile.hard_delete_started_at >= now() - interval '10 minutes' then
    return false;
  end if;
  update public.user_profiles
  set hard_delete_token = p_hard_delete_token,
      hard_delete_started_at = now()
  where id = p_owner_id;
  return true;
end;
$$;

-- The profile must survive an Auth deletion failure so the cron can retry.
-- Let the successful Auth delete own this final cascade rather than deleting
-- the profile first and leaving an account with no control-plane row.
alter table public.user_profiles
  drop constraint if exists user_profiles_id_fkey;
alter table public.user_profiles
  add constraint user_profiles_id_fkey
  foreign key (id) references auth.users(id) on delete cascade;

-- The cron refreshes its exact claim after every external storage operation
-- and immediately before GoTrue deletion. This is a final lost-claim check;
-- a stale/other claim must never delete Auth merely because a PostgREST
-- `delete().eq(...)` happened to return `error: null` for zero rows.
create or replace function public.refresh_account_hard_deletion_claim(
  p_owner_id uuid,
  p_hard_delete_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_profile public.user_profiles%rowtype;
begin
  select * into v_profile from public.user_profiles where id = p_owner_id for update;
  if not found
    or v_profile.hard_delete_token is distinct from p_hard_delete_token
    or v_profile.deleted_at is null
    or v_profile.scheduled_hard_delete_at is null
    or v_profile.scheduled_hard_delete_at > now() then
    return false;
  end if;
  update public.user_profiles
  set hard_delete_started_at = now()
  where id = p_owner_id and hard_delete_token = p_hard_delete_token;
  return found;
end;
$$;

-- Auth deletion can fail transiently after all storage work is done. Releasing
-- only the exact token keeps the profile intact and makes the next cron run
-- eligible immediately, without releasing somebody else's later claim.
create or replace function public.release_account_hard_deletion_claim(
  p_owner_id uuid,
  p_hard_delete_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.user_profiles
  set hard_delete_token = null, hard_delete_started_at = null
  where id = p_owner_id and hard_delete_token = p_hard_delete_token;
  return found;
end;
$$;

revoke all on function public.schedule_account_deletion(uuid, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.cancel_account_deletion(uuid) from public, anon, authenticated;
revoke all on function public.claim_account_hard_deletion(uuid, uuid) from public, anon, authenticated;
revoke all on function public.refresh_account_hard_deletion_claim(uuid, uuid) from public, anon, authenticated;
revoke all on function public.release_account_hard_deletion_claim(uuid, uuid) from public, anon, authenticated;
grant execute on function public.schedule_account_deletion(uuid, uuid, timestamptz) to service_role;
grant execute on function public.cancel_account_deletion(uuid) to service_role;
grant execute on function public.claim_account_hard_deletion(uuid, uuid) to service_role;
grant execute on function public.refresh_account_hard_deletion_claim(uuid, uuid) to service_role;
grant execute on function public.release_account_hard_deletion_claim(uuid, uuid) to service_role;

-- Existing grace-period rows predate the operation token. Backfill one token
-- per profile before the Edge release begins using the new RPCs, then attach
-- that exact token to only the owned families already soft-deleted with it.
-- This deliberately avoids a future cancel restoring arbitrary family rows.
update public.user_profiles
set account_deletion_token = gen_random_uuid()
where deleted_at is not null
  and scheduled_hard_delete_at is not null
  and account_deletion_token is null;

update public.families family
set account_deletion_token = profile.account_deletion_token
from public.user_profiles profile
where family.owner_id = profile.id
  and family.deleted_at is not null
  and family.account_deletion_token is null
  and profile.account_deletion_token is not null
  -- Before operation tokens existed, a family soft-delete can only be
  -- attributed to this account deletion when it happened with the profile
  -- transition. Do not blanket-tag every historical deleted family owned by
  -- this user: cancellation must restore exactly one scheduling operation.
  and family.deleted_at between profile.deleted_at - interval '1 minute'
    and profile.deleted_at + interval '1 minute';
