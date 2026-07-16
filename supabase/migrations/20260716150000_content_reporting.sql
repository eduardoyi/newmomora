-- Private in-app reporting and reporter-local household account hiding.
-- Reports intentionally retain identifiers/metadata only: never content,
-- child names, image keys/URLs, or snapshots of the reported target.

alter table public.memories
  add column illustration_generation_id uuid,
  add column illustration_generation_attempt_id uuid;

-- Existing ready illustrations become one immutable logical generation. New
-- writes use generation-specific object keys so this id always identifies the
-- exact bytes that were current when a report was filed.
update public.memories
set illustration_generation_id = gen_random_uuid()
where illustration_status = 'ready'
  and illustration_key is not null
  and illustration_generation_id is null;

-- A generator owns only the illustration inputs it read. Relevant memory or
-- tag edits invalidate the attempt token, while unrelated writes such as link
-- preview hydration do not supersede generation.
create function public.invalidate_memory_illustration_attempt_on_input_change()
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
    end if;
  end if;
  return new;
end;
$$;

create trigger invalidate_memory_illustration_attempt_on_input_change
  before update of content, memory_date, memory_type, emotion on public.memories
  for each row execute function public.invalidate_memory_illustration_attempt_on_input_change();

create function public.invalidate_memory_illustration_attempt_on_tag_change()
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
    end
  where id = coalesce(new.memory_id, old.memory_id)
  ;
  return coalesce(new, old);
end;
$$;

create trigger invalidate_memory_illustration_attempt_on_tag_change
  after insert or update or delete on public.memory_family_members
  for each row execute function public.invalidate_memory_illustration_attempt_on_tag_change();

create table public.content_reports (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families on delete cascade,
  reporter_user_id uuid references auth.users on delete set null,
  target_type text not null check (target_type in (
    'memory',
    'memory_illustration',
    'comment',
    'household_member',
    'family_member_profile',
    'family_member_portrait'
  )),
  target_id uuid not null,
  target_version_id uuid,
  -- Operator-only account attribution. This is deliberately absent from the
  -- reporter RPC and survives target-row deletion (until the auth user itself
  -- is deleted, when it is anonymized).
  target_user_id uuid references auth.users on delete set null,
  reason text not null check (reason in (
    'unsafe_or_sexual',
    'harassment_or_abuse',
    'privacy',
    'misleading_ai_depiction',
    'other'
  )),
  note text check (note is null or char_length(note) between 1 and 500),
  status text not null default 'open' check (status in ('open', 'reviewing', 'resolved')),
  resolution text check (resolution is null or resolution in (
    'dismissed',
    'content_removed',
    'account_suspended',
    'other_action'
  )),
  resolved_at timestamptz,
  resolved_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (target_type = 'memory_illustration' and target_version_id is not null)
    or
    (target_type <> 'memory_illustration' and target_version_id is null)
  ),
  check (
    (status = 'resolved' and resolution is not null and resolved_at is not null)
    or
    (status <> 'resolved' and resolution is null and resolved_at is null and resolved_by is null)
  )
);

create index idx_content_reports_operator_queue
  on public.content_reports (status, created_at);
create index idx_content_reports_reporter_family
  on public.content_reports (reporter_user_id, family_id, created_at desc);
create unique index one_active_report_per_reporter_target
  on public.content_reports (reporter_user_id, target_type, target_id)
  where reporter_user_id is not null
    and target_type <> 'memory_illustration'
    and status in ('open', 'reviewing');
create unique index one_active_report_per_reporter_illustration_generation
  on public.content_reports (reporter_user_id, target_type, target_id, target_version_id)
  where reporter_user_id is not null
    and target_type = 'memory_illustration'
    and status in ('open', 'reviewing');

create trigger set_content_reports_updated_at
  before update on public.content_reports
  for each row execute function public.set_updated_at();

create function public.clear_orphaned_report_note()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.reporter_user_id is not null and new.reporter_user_id is null then
    new.note := null;
  end if;
  return new;
end;
$$;

create trigger clear_content_report_note_on_reporter_delete
  before update of reporter_user_id on public.content_reports
  for each row execute function public.clear_orphaned_report_note();

alter table public.content_reports enable row level security;

revoke all on public.content_reports from anon, authenticated;

create table public.blocked_family_accounts (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families on delete cascade,
  blocker_user_id uuid not null references auth.users on delete cascade,
  blocked_membership_id uuid references public.family_memberships on delete set null,
  blocked_user_id uuid not null references auth.users on delete cascade,
  created_at timestamptz not null default now(),
  check (blocker_user_id <> blocked_user_id),
  unique (blocker_user_id, family_id, blocked_user_id)
);

create index idx_blocked_family_accounts_blocker
  on public.blocked_family_accounts (blocker_user_id, family_id);

alter table public.blocked_family_accounts enable row level security;

create policy "Users can view only their own hidden accounts"
  on public.blocked_family_accounts for select
  using (
    blocker_user_id = auth.uid()
    and public.is_family_member(family_id)
    and exists (select 1 from public.families f where f.id = family_id and f.deleted_at is null)
  );

revoke all on public.blocked_family_accounts from anon, authenticated;
grant select on public.blocked_family_accounts to authenticated;

-- Replace the family-profile RPC so active rows expose their concrete
-- membership id. The id is the trust anchor for report/block requests;
-- former creators deliberately return null because they are no longer a
-- reportable active household account (an existing block can still be
-- removed by its own block-row id).
drop function public.get_family_member_profiles(uuid);

create function public.get_family_member_profiles(fam uuid)
returns table (
  membership_id uuid,
  user_id uuid,
  name text,
  role text,
  is_active_member boolean,
  created_at timestamptz
)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not public.is_family_member(fam) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return query
  select
    fm.id as membership_id,
    up.id as user_id,
    up.name,
    fm.role,
    true as is_active_member,
    fm.created_at
  from public.family_memberships fm
  join public.user_profiles up on up.id = fm.user_id
  where fm.family_id = fam

  union

  select
    null::uuid as membership_id,
    up.id as user_id,
    up.name,
    null::text as role,
    false as is_active_member,
    min(src.created_at) as created_at
  from (
    select m.user_id, m.created_at from public.memories m
    where m.family_id = fam and m.user_id is not null
    union all
    select fam_m.user_id, fam_m.created_at from public.family_members fam_m
    where fam_m.family_id = fam and fam_m.user_id is not null
    union all
    select c.user_id, c.created_at
    from public.memory_comments c
    join public.memories cm on cm.id = c.memory_id
    where cm.family_id = fam
    union all
    select b.blocked_user_id, b.created_at
    from public.blocked_family_accounts b
    where b.family_id = fam and b.blocker_user_id = auth.uid()
  ) src
  join public.user_profiles up on up.id = src.user_id
  where src.user_id not in (
    select fm2.user_id from public.family_memberships fm2 where fm2.family_id = fam
  )
  group by up.id, up.name;
end;
$$;

revoke all on function public.get_family_member_profiles(uuid) from public;
grant execute on function public.get_family_member_profiles(uuid) to authenticated;

create function public.get_my_open_content_reports(p_family_id uuid)
returns table (
  id uuid,
  family_id uuid,
  target_type text,
  target_id uuid,
  target_version_id uuid,
  status text,
  created_at timestamptz
)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.family_memberships fm
    join public.families f on f.id = fm.family_id and f.deleted_at is null
    where fm.family_id = p_family_id and fm.user_id = auth.uid()
  ) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return query
  select
    r.id,
    r.family_id,
    r.target_type,
    r.target_id,
    r.target_version_id,
    r.status,
    r.created_at
  from public.content_reports r
  where r.reporter_user_id = auth.uid()
    and r.family_id = p_family_id
    and r.status in ('open', 'reviewing')
  order by r.created_at desc;
end;
$$;

revoke all on function public.get_my_open_content_reports(uuid) from public;
grant execute on function public.get_my_open_content_reports(uuid) to authenticated;

create function public.create_content_report(
  p_target_type text,
  p_target_id uuid,
  p_reason text,
  p_note text default null,
  p_target_version_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_id uuid := auth.uid();
  resolved_family_id uuid;
  resolved_target_version_id uuid;
  resolved_target_user_id uuid;
  normalized_note text := nullif(trim(p_note), '');
  recent_report_count integer;
  report_id uuid;
begin
  if caller_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if p_target_type not in (
    'memory',
    'memory_illustration',
    'comment',
    'household_member',
    'family_member_profile',
    'family_member_portrait'
  ) then
    raise exception 'Unsupported report target' using errcode = '22023';
  end if;

  if p_reason not in (
    'unsafe_or_sexual',
    'harassment_or_abuse',
    'privacy',
    'misleading_ai_depiction',
    'other'
  ) then
    raise exception 'Invalid report reason' using errcode = '22023';
  end if;

  if p_reason = 'misleading_ai_depiction'
    and p_target_type not in ('memory_illustration', 'family_member_portrait') then
    raise exception 'Invalid reason for this report target' using errcode = '22023';
  end if;

  if (p_target_type = 'memory_illustration' and p_target_version_id is null)
    or (p_target_type <> 'memory_illustration' and p_target_version_id is not null) then
    raise exception 'Report target is unavailable' using errcode = 'P0002';
  end if;

  if normalized_note is not null and char_length(normalized_note) > 500 then
    raise exception 'Report note must be 500 characters or fewer' using errcode = '22023';
  end if;

  -- Exhaustive target resolution. No family id supplied by the client is
  -- trusted; the concrete target row is always the source of tenancy.
  case p_target_type
    when 'memory' then
      select m.family_id, m.user_id
      into resolved_family_id, resolved_target_user_id
      from public.memories m
      where m.id = p_target_id;

    when 'memory_illustration' then
      select m.family_id, m.illustration_generation_id, m.user_id
      into resolved_family_id, resolved_target_version_id, resolved_target_user_id
      from public.memories m
      where m.id = p_target_id
        and m.memory_type = 'text_illustration'
        and m.illustration_status = 'ready'
        and m.illustration_key is not null
        and m.illustration_generation_id = p_target_version_id;

    when 'comment' then
      select m.family_id, c.user_id
      into resolved_family_id, resolved_target_user_id
      from public.memory_comments c
      join public.memories m on m.id = c.memory_id
      where c.id = p_target_id;

    when 'household_member' then
      select fm.family_id, fm.user_id
      into resolved_family_id, resolved_target_user_id
      from public.family_memberships fm
      where fm.id = p_target_id and fm.user_id <> caller_id;

    when 'family_member_profile' then
      select fm.family_id, fm.user_id
      into resolved_family_id, resolved_target_user_id
      from public.family_members fm
      where fm.id = p_target_id;

    when 'family_member_portrait' then
      select pv.family_id, coalesce(pv.user_id, fm.user_id)
      into resolved_family_id, resolved_target_user_id
      from public.family_member_portrait_versions pv
      join public.family_members fm on fm.id = pv.family_member_id
      where pv.id = p_target_id
        and pv.illustrated_profile_status = 'ready'
        and pv.illustrated_profile_key is not null
        and pv.deletion_token is null;
  end case;

  -- Deleted/non-generated/unsupported combinations are intentionally
  -- indistinguishable so the endpoint cannot be used as a target oracle.
  if resolved_family_id is null
    or not exists (
      select 1
      from public.family_memberships fm
      join public.families f on f.id = fm.family_id and f.deleted_at is null
      where fm.family_id = resolved_family_id and fm.user_id = caller_id
    ) then
    raise exception 'Report target is unavailable' using errcode = 'P0002';
  end if;

  -- Serialize the duplicate/rate-limit check for this reporter. Without the
  -- transaction-scoped lock, concurrent reports for different targets could
  -- all observe nine recent rows and exceed the hourly cap.
  perform pg_advisory_xact_lock(hashtextextended(caller_id::text, 0));

  select r.id into report_id
  from public.content_reports r
    where r.reporter_user_id = caller_id
      and r.target_type = p_target_type
      and r.target_id = p_target_id
      and r.target_version_id is not distinct from resolved_target_version_id
      and r.status in ('open', 'reviewing')
  limit 1;

  if report_id is not null then
    return report_id;
  end if;

  select count(*) into recent_report_count
  from public.content_reports r
  where r.reporter_user_id = caller_id
    and r.created_at > now() - interval '1 hour';

  if recent_report_count >= 10 then
    raise exception 'Report limit reached. Try again later' using errcode = 'P0001';
  end if;

  insert into public.content_reports (
    family_id,
    reporter_user_id,
    target_type,
    target_id,
    target_version_id,
    target_user_id,
    reason,
    note
  ) values (
    resolved_family_id,
    caller_id,
    p_target_type,
    p_target_id,
    resolved_target_version_id,
    resolved_target_user_id,
    p_reason,
    normalized_note
  )
  returning id into report_id;

  return report_id;
exception
  when unique_violation then
    select r.id into report_id
    from public.content_reports r
    where r.reporter_user_id = caller_id
      and r.target_type = p_target_type
      and r.target_id = p_target_id
      and r.target_version_id is not distinct from resolved_target_version_id
      and r.status in ('open', 'reviewing')
    limit 1;
    if report_id is not null then
      return report_id;
    end if;
    raise;
end;
$$;

revoke all on function public.create_content_report(text, uuid, text, text, uuid) from public;
grant execute on function public.create_content_report(text, uuid, text, text, uuid) to authenticated;

create function public.set_family_account_block(
  p_should_block boolean,
  p_membership_id uuid default null,
  p_block_id uuid default null
)
returns public.blocked_family_accounts
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_id uuid := auth.uid();
  target_family_id uuid;
  target_user_id uuid;
  result public.blocked_family_accounts;
begin
  if caller_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if p_should_block then
    if p_membership_id is null or p_block_id is not null then
      raise exception 'An active household membership is required' using errcode = '22023';
    end if;

    select fm.family_id, fm.user_id
    into target_family_id, target_user_id
    from public.family_memberships fm
    where fm.id = p_membership_id and fm.user_id <> caller_id;

    if target_family_id is null or not exists (
      select 1
      from public.family_memberships caller_membership
      join public.families f
        on f.id = caller_membership.family_id and f.deleted_at is null
      where caller_membership.family_id = target_family_id
        and caller_membership.user_id = caller_id
    ) then
      raise exception 'Account is unavailable' using errcode = 'P0002';
    end if;

    insert into public.blocked_family_accounts (
      family_id,
      blocker_user_id,
      blocked_membership_id,
      blocked_user_id
    ) values (
      target_family_id,
      caller_id,
      p_membership_id,
      target_user_id
    )
    on conflict (blocker_user_id, family_id, blocked_user_id)
    do update set blocked_membership_id = excluded.blocked_membership_id
    returning * into result;
  else
    if p_block_id is null or p_membership_id is not null then
      raise exception 'A hidden-account id is required' using errcode = '22023';
    end if;

    delete from public.blocked_family_accounts b
    using public.families f
    where b.id = p_block_id
      and b.blocker_user_id = caller_id
      and f.id = b.family_id
      and f.deleted_at is null
      and exists (
        select 1 from public.family_memberships caller_membership
        where caller_membership.family_id = b.family_id
          and caller_membership.user_id = caller_id
      )
    returning * into result;

    if result.id is null then
      raise exception 'Account is unavailable' using errcode = 'P0002';
    end if;
  end if;

  return result;
end;
$$;

revoke all on function public.set_family_account_block(boolean, uuid, uuid) from public;
grant execute on function public.set_family_account_block(boolean, uuid, uuid) to authenticated;
