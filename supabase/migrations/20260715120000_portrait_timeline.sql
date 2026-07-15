-- Age-aware family-member portrait history.

-- Member deletion now goes through delete-family-member so R2 cleanup is
-- completed before the row (and its portrait-version rows) can cascade.
drop policy if exists "Family members: delete" on public.family_members;

alter table public.family_members
  add constraint family_members_id_family_id_key unique (id, family_id);

create table public.family_member_portrait_versions (
  id uuid primary key,
  family_id uuid not null,
  family_member_id uuid not null,
  user_id uuid references auth.users (id) on delete set null,
  reference_date date,
  date_source text not null
    check (date_source in ('exif', 'manual', 'default_today', 'legacy_unknown')),
  profile_picture_key text not null unique,
  illustrated_profile_key text,
  illustrated_profile_status text not null default 'pending'
    check (illustrated_profile_status in ('pending', 'generating', 'ready', 'failed')),
  generation_token uuid,
  generation_started_at timestamptz,
  generation_output_key text,
  deletion_token uuid,
  deletion_started_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint family_member_portrait_versions_member_family_fkey
    foreign key (family_member_id, family_id)
    references public.family_members (id, family_id)
    on delete cascade,
  constraint family_member_portrait_versions_date_shape check (
    (date_source = 'legacy_unknown' and reference_date is null)
    or (date_source <> 'legacy_unknown' and reference_date is not null)
  ),
  constraint family_member_portrait_versions_ready_shape check (
    (illustrated_profile_status = 'ready') = (illustrated_profile_key is not null)
  ),
  constraint family_member_portrait_versions_generation_shape check (
    (generation_token is null and generation_started_at is null and generation_output_key is null)
    or (generation_token is not null and generation_started_at is not null and generation_output_key is not null)
  ),
  constraint family_member_portrait_versions_deletion_shape check (
    (deletion_token is null and deletion_started_at is null)
    or (deletion_token is not null and deletion_started_at is not null)
  )
);

create unique index family_member_portrait_versions_one_legacy_unknown
  on public.family_member_portrait_versions (family_member_id)
  where reference_date is null;

create index family_member_portrait_versions_selection
  on public.family_member_portrait_versions
    (family_member_id, reference_date desc, created_at desc, id desc)
  where illustrated_profile_key is not null and deletion_token is null;

create index family_member_portrait_versions_family
  on public.family_member_portrait_versions (family_id, family_member_id);

alter table public.family_member_portrait_versions enable row level security;

create policy "Portrait versions: select"
  on public.family_member_portrait_versions for select
  using (public.is_family_member(family_id));

create trigger set_family_member_portrait_versions_updated_at
  before update on public.family_member_portrait_versions
  for each row execute function public.set_updated_at();

create or replace function public.current_user_local_date()
returns date
language sql
stable
security definer
set search_path = public
as $$
  select (now() at time zone coalesce(
    (select timezone from public.user_profiles where id = auth.uid()),
    'UTC'
  ))::date
$$;

revoke all on function public.current_user_local_date() from public;
grant execute on function public.current_user_local_date() to authenticated;

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
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = 'P0001';
  end if;

  select * into member_row
  from public.family_members
  where id = target_family_member_id;

  if not found then
    raise exception 'Family member not found' using errcode = 'P0002';
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

create or replace function public.update_family_member_portrait_version_date(
  target_version_id uuid,
  portrait_reference_date date
)
returns public.family_member_portrait_versions
language plpgsql
security definer
set search_path = public
as $$
declare
  version_row public.family_member_portrait_versions%rowtype;
  member_dob date;
  result public.family_member_portrait_versions%rowtype;
begin
  select * into version_row
  from public.family_member_portrait_versions
  where id = target_version_id;

  if not found then
    raise exception 'Portrait version not found' using errcode = 'P0002';
  end if;
  select date_of_birth into member_dob
  from public.family_members
  where id = version_row.family_member_id;
  if not public.has_family_role(version_row.family_id, array['owner', 'manager']) then
    raise exception 'Not authorized for this family' using errcode = '42501';
  end if;
  if version_row.generation_token is not null or version_row.deletion_token is not null then
    raise exception 'Portrait version is busy' using errcode = '55000';
  end if;
  if portrait_reference_date is null
    or portrait_reference_date > public.current_user_local_date()
    or (member_dob is not null and portrait_reference_date < member_dob)
  then
    raise exception 'Portrait date is outside the allowed range' using errcode = '22023';
  end if;

  update public.family_member_portrait_versions
  set reference_date = portrait_reference_date, date_source = 'manual'
  where id = target_version_id
  returning * into result;
  return result;
end;
$$;

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
  select * into version_row from public.family_member_portrait_versions where id = target_version_id;
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
      or generation_started_at < now() - interval '15 minutes'
    )
  returning * into result;

  if not found then
    raise exception 'Portrait generation already in progress' using errcode = '55000';
  end if;
  return result;
end;
$$;

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
  set illustrated_profile_status = case when illustrated_profile_key is null then 'failed' else 'ready' end,
      generation_token = null,
      generation_started_at = null,
      generation_output_key = null
  where id = target_version_id
    and generation_token = attempt_token
  returning * into result;
  if not found then raise exception 'Portrait generation claim lost' using errcode = '55000'; end if;
  return result;
end;
$$;

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
  total_count integer;
  usable_count integer;
  result public.family_member_portrait_versions%rowtype;
begin
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

  -- Serialize all version deletions for one person, not just attempts to
  -- delete the same version row. Otherwise two managers can each observe
  -- two usable rows and concurrently claim both.
  perform 1 from public.family_members
  where id = version_row.family_member_id
  for update;

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
  where id = target_version_id
    and deletion_token is null
  returning * into result;
  if not found then raise exception 'Portrait deletion already in progress' using errcode = '55000'; end if;
  return result;
end;
$$;

create or replace function public.finish_family_member_portrait_deletion(
  target_version_id uuid,
  delete_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare deleted_count integer;
begin
  delete from public.family_member_portrait_versions
  where id = target_version_id
    and deletion_token = delete_token;
  get diagnostics deleted_count = row_count;
  return deleted_count = 1;
end;
$$;

create or replace function public.enforce_family_member_dob_portrait_dates()
returns trigger
language plpgsql
as $$
begin
  if new.date_of_birth is not null
    and new.date_of_birth is distinct from old.date_of_birth
    and exists (
      select 1 from public.family_member_portrait_versions pv
      where pv.family_member_id = old.id
        and pv.reference_date < new.date_of_birth
    )
  then
    raise exception 'Date of birth cannot be after a portrait date' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger family_members_dob_portrait_dates
  before update of date_of_birth on public.family_members
  for each row execute function public.enforce_family_member_dob_portrait_dates();

create or replace function public.enforce_legacy_family_portrait_cutoff()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is not null and tg_op = 'INSERT' and (
    new.profile_picture_key is not null
    or new.illustrated_profile_key is not null
    or new.illustrated_profile_status <> 'pending'
  ) then
    raise exception 'Legacy family portrait fields are read-only' using errcode = 'P0001';
  end if;
  if auth.uid() is not null and tg_op = 'UPDATE' and (
      new.profile_picture_key is distinct from old.profile_picture_key
      or new.illustrated_profile_key is distinct from old.illustrated_profile_key
      or new.illustrated_profile_status is distinct from old.illustrated_profile_status
    ) then
    raise exception 'Legacy family portrait fields are read-only' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger family_members_legacy_portrait_insert_cutoff
  before insert on public.family_members
  for each row execute function public.enforce_legacy_family_portrait_cutoff();

create trigger family_members_legacy_portrait_cutoff
  before update of profile_picture_key, illustrated_profile_key, illustrated_profile_status
  on public.family_members
  for each row execute function public.enforce_legacy_family_portrait_cutoff();

create or replace function public.enforce_portrait_version_immutable_columns()
returns trigger
language plpgsql
as $$
begin
  if new.id is distinct from old.id
    or new.family_id is distinct from old.family_id
    or new.family_member_id is distinct from old.family_member_id
    or new.profile_picture_key is distinct from old.profile_picture_key
    or new.created_at is distinct from old.created_at
  then
    raise exception 'Portrait version identity fields cannot be changed' using errcode = 'P0001';
  end if;
  if new.user_id is not null and new.user_id is distinct from old.user_id then
    raise exception 'Portrait creator attribution cannot be changed' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger family_member_portrait_versions_immutable_columns
  before update on public.family_member_portrait_versions
  for each row execute function public.enforce_portrait_version_immutable_columns();

revoke all on function public.create_family_member_portrait_version(uuid, uuid, date, text, text) from public;
revoke all on function public.update_family_member_portrait_version_date(uuid, date) from public;
revoke all on function public.claim_family_member_portrait_generation(uuid, uuid, text, uuid) from public;
revoke all on function public.finish_family_member_portrait_generation(uuid, uuid, text) from public;
revoke all on function public.fail_family_member_portrait_generation(uuid, uuid) from public;
revoke all on function public.claim_family_member_portrait_deletion(uuid, uuid, uuid) from public;
revoke all on function public.finish_family_member_portrait_deletion(uuid, uuid) from public;

grant execute on function public.create_family_member_portrait_version(uuid, uuid, date, text, text) to authenticated;
grant execute on function public.update_family_member_portrait_version_date(uuid, date) to authenticated;
grant execute on function public.claim_family_member_portrait_generation(uuid, uuid, text, uuid) to service_role;
grant execute on function public.finish_family_member_portrait_generation(uuid, uuid, text) to service_role;
grant execute on function public.fail_family_member_portrait_generation(uuid, uuid) to service_role;
grant execute on function public.claim_family_member_portrait_deletion(uuid, uuid, uuid) to service_role;
grant execute on function public.finish_family_member_portrait_deletion(uuid, uuid) to service_role;
