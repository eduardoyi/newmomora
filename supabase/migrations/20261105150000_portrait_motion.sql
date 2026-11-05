-- Living portraits (docs/plans/living-portraits.md): an optional animated
-- "frame sheet" derived from a version's published still. All state lives on
-- the portrait version row; the still (illustrated_profile_key) is untouched.
--
--   1. motion_* columns + shape checks
--   2. client write guard (motion state is server managed)
--   3. claim / publish / fail RPCs (service_role only)
--   4. telemetry-only usage operations portrait_motion / portrait_motion_check
--
-- Usage caps are computed from ai_image_generation_requests (illustration /
-- portrait reservations), never from ai_usage_events, so the two new ledger
-- operations are telemetry only and cannot consume a family's fair-use pools
-- (same pattern as the holiday_card_* operations).

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------

alter table public.family_member_portrait_versions
  add column motion_status text,
  add column motion_key text,
  add column motion_source_key text,
  add column motion_token uuid,
  add column motion_attempts smallint not null default 0,
  add column motion_columns smallint,
  add column motion_rows smallint,
  add column motion_started_at timestamptz,
  add column motion_updated_at timestamptz;

alter table public.family_member_portrait_versions
  add constraint family_member_portrait_versions_motion_status_check
    check (motion_status in ('pending', 'ready', 'failed')),
  add constraint family_member_portrait_versions_motion_columns_check
    check (motion_columns between 1 and 4),
  add constraint family_member_portrait_versions_motion_rows_check
    check (motion_rows between 1 and 4),
  -- A sheet exists exactly when the motion is ready, and a ready sheet always
  -- knows its grid. (coalesce: a null status must not make the check vacuous.)
  add constraint family_member_portrait_versions_motion_ready_shape
    check (
      coalesce(motion_status = 'ready', false) = (motion_key is not null)
      and (motion_status is distinct from 'ready'
        or (motion_columns is not null and motion_rows is not null))
    );

-- ---------------------------------------------------------------------------
-- 2. Client write guard
-- ---------------------------------------------------------------------------

-- Mirrors protect_ai_usage_portrait_columns: the table has no client UPDATE
-- grant today, but a future grant or policy must never let a client forge a
-- motion pointer (which get-media-url would then presign).
create or replace function public.protect_portrait_motion_columns()
returns trigger language plpgsql set search_path = public as $$
begin
  if (current_user in ('anon', 'authenticated') or auth.role() in ('anon', 'authenticated')) and (
    new.motion_status is distinct from old.motion_status
    or new.motion_key is distinct from old.motion_key
    or new.motion_source_key is distinct from old.motion_source_key
    or new.motion_token is distinct from old.motion_token
    or new.motion_attempts is distinct from old.motion_attempts
    or new.motion_columns is distinct from old.motion_columns
    or new.motion_rows is distinct from old.motion_rows
    or new.motion_started_at is distinct from old.motion_started_at
    or new.motion_updated_at is distinct from old.motion_updated_at
  ) then
    raise exception 'Portrait motion state is server managed' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.protect_portrait_motion_columns() from public, anon, authenticated;

drop trigger if exists aaa_protect_portrait_motion_columns on public.family_member_portrait_versions;
create trigger aaa_protect_portrait_motion_columns before update on public.family_member_portrait_versions
for each row execute function public.protect_portrait_motion_columns();

-- ---------------------------------------------------------------------------
-- 3. RPCs
-- ---------------------------------------------------------------------------

-- Deterministic sheet key for one claim. <owner> is the first path segment of
-- the version's source photo key (the uploader), exactly like the still's
-- attempt key, so the existing `{uid}/family/...` prefix rules and the
-- portrait-version prefix deletion sweeps cover it.
create or replace function public.portrait_motion_output_key(
  p_profile_picture_key text,
  p_family_member_id uuid,
  p_version_id uuid,
  p_motion_token uuid
)
returns text
language sql
immutable
set search_path = public
as $$
  select format(
    '%s/family/%s/portraits/%s/motion/%s.webp',
    split_part(p_profile_picture_key, '/', 1), p_family_member_id, p_version_id, p_motion_token
  )
$$;
revoke all on function public.portrait_motion_output_key(text, uuid, uuid, uuid) from public, anon, authenticated;

-- Outcomes: not_eligible | already_ready | in_flight | already_failed | claimed.
-- Lock order matches claim_family_member_portrait_generation: family (share)
-- -> member (share) -> version (update), so a family/member deletion fence
-- either completes first (not_eligible) or waits for this claim.
--
-- A `claimed` row always has motion_key = null (a non-ready row cannot hold a
-- sheet); any previous sheet is returned as stale_motion_key so the caller can
-- delete the object. That covers a sheet made from a since-replaced still and
-- a forced regeneration of a ready one.
create or replace function public.claim_portrait_motion(
  p_version_id uuid,
  p_force boolean default false
)
returns table (
  outcome text,
  motion_token uuid,
  source_key text,
  output_key text,
  stale_motion_key text
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_version public.family_member_portrait_versions%rowtype;
  v_locked public.family_member_portrait_versions%rowtype;
  v_family_fence uuid;
  v_family_deleted_at timestamptz;
  v_member_fence uuid;
  v_token uuid := gen_random_uuid();
  v_output_key text;
  v_stale text;
begin
  select * into v_version
  from public.family_member_portrait_versions
  where id = p_version_id;
  if not found then
    return query select 'not_eligible'::text, null::uuid, null::text, null::text, null::text;
    return;
  end if;

  select f.deletion_fence_token, f.deleted_at into v_family_fence, v_family_deleted_at
  from public.families f
  where f.id = v_version.family_id
  for share;
  if not found or v_family_fence is not null or v_family_deleted_at is not null then
    return query select 'not_eligible'::text, null::uuid, null::text, null::text, null::text;
    return;
  end if;

  select m.deletion_fence_token into v_member_fence
  from public.family_members m
  where m.id = v_version.family_member_id
  for share;
  if not found or v_member_fence is not null then
    return query select 'not_eligible'::text, null::uuid, null::text, null::text, null::text;
    return;
  end if;

  select * into v_locked
  from public.family_member_portrait_versions
  where id = p_version_id
  for update;
  if not found
    or v_locked.illustrated_profile_status <> 'ready'
    or v_locked.illustrated_profile_key is null
    or v_locked.deletion_token is not null then
    return query select 'not_eligible'::text, null::uuid, null::text, null::text, null::text;
    return;
  end if;

  if not p_force
    and v_locked.motion_status = 'ready'
    and v_locked.motion_source_key is not distinct from v_locked.illustrated_profile_key then
    return query select 'already_ready'::text, null::uuid, null::text, null::text, null::text;
    return;
  end if;
  if v_locked.motion_status = 'pending'
    and v_locked.motion_source_key is not distinct from v_locked.illustrated_profile_key
    and v_locked.motion_started_at > now() - interval '15 minutes' then
    return query select 'in_flight'::text, null::uuid, null::text, null::text, null::text;
    return;
  end if;
  if not p_force
    and v_locked.motion_status = 'failed'
    and v_locked.motion_source_key is not distinct from v_locked.illustrated_profile_key then
    return query select 'already_failed'::text, null::uuid, null::text, null::text, null::text;
    return;
  end if;

  v_stale := v_locked.motion_key;
  v_output_key := public.portrait_motion_output_key(
    v_locked.profile_picture_key, v_locked.family_member_id, v_locked.id, v_token
  );
  update public.family_member_portrait_versions
  set motion_status = 'pending',
      motion_key = null,
      motion_columns = null,
      motion_rows = null,
      motion_source_key = v_locked.illustrated_profile_key,
      motion_token = v_token,
      motion_attempts = v_locked.motion_attempts + 1,
      motion_started_at = now(),
      motion_updated_at = now()
  where id = p_version_id;

  return query select 'claimed'::text, v_token, v_locked.illustrated_profile_key, v_output_key, v_stale;
end;
$$;

-- Compare-and-set publication. published=false means the caller must delete
-- its uploaded object (superseded by a newer claim, a regenerated still, a
-- deletion, or a different key). old_motion_key is the sheet this replaces
-- (defensive: a pending row never holds one, see claim_portrait_motion).
create or replace function public.publish_portrait_motion(
  p_version_id uuid,
  p_motion_token uuid,
  p_output_key text,
  p_columns smallint,
  p_rows smallint
)
returns table (published boolean, old_motion_key text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version public.family_member_portrait_versions%rowtype;
begin
  if p_columns is null or p_rows is null or p_columns not between 1 and 4 or p_rows not between 1 and 4 then
    raise exception 'invalid motion grid' using errcode = '22023';
  end if;

  select * into v_version
  from public.family_member_portrait_versions
  where id = p_version_id
  for update;
  if not found
    or v_version.motion_token is distinct from p_motion_token
    or v_version.motion_status is distinct from 'pending'
    or v_version.illustrated_profile_key is null
    or v_version.illustrated_profile_key is distinct from v_version.motion_source_key
    or v_version.deletion_token is not null
    or p_output_key is distinct from public.portrait_motion_output_key(
      v_version.profile_picture_key, v_version.family_member_id, v_version.id, p_motion_token
    ) then
    return query select false, null::text;
    return;
  end if;

  update public.family_member_portrait_versions
  set motion_status = 'ready',
      motion_key = p_output_key,
      motion_columns = p_columns,
      motion_rows = p_rows,
      motion_updated_at = now()
  where id = p_version_id;

  return query select true,
    case when v_version.motion_key is distinct from p_output_key then v_version.motion_key end;
end;
$$;

create or replace function public.fail_portrait_motion(
  p_version_id uuid,
  p_motion_token uuid,
  p_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  -- p_error_code is accepted for the bridge contract/diagnostics only; no
  -- column stores it (the Worker logs it).
  update public.family_member_portrait_versions
  set motion_status = 'failed',
      motion_updated_at = now()
  where id = p_version_id
    and motion_token = p_motion_token
    and motion_status = 'pending';
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

revoke all on function public.claim_portrait_motion(uuid, boolean) from public, anon, authenticated;
revoke all on function public.publish_portrait_motion(uuid, uuid, text, smallint, smallint) from public, anon, authenticated;
revoke all on function public.fail_portrait_motion(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_portrait_motion(uuid, boolean) to service_role;
grant execute on function public.publish_portrait_motion(uuid, uuid, text, smallint, smallint) to service_role;
grant execute on function public.fail_portrait_motion(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 4. AI ledger operations (telemetry only, never capped)
-- ---------------------------------------------------------------------------

-- Existing list (20261006120000_holiday_cards.sql) + the two motion
-- operations. Same add-not-valid-then-validate dance as the previous
-- widenings.
alter table public.ai_usage_events
  drop constraint ai_usage_events_operation_check;

alter table public.ai_usage_events
  add constraint ai_usage_events_operation_check
  check (operation in (
    'illustration', 'portrait', 'safety_chat', 'emotion_chat', 'emotion_vision',
    'transcription', 'voice_cleanup', 'relationship_chat',
    'year_film_quote', 'year_film_vision', 'year_film_audio',
    'holiday_card_front_judge', 'holiday_card_voice', 'holiday_card_details',
    'holiday_card_editor', 'holiday_card_writer', 'holiday_card_quote_check',
    'portrait_motion', 'portrait_motion_check'
  )) not valid;

alter table public.ai_usage_events
  validate constraint ai_usage_events_operation_check;
