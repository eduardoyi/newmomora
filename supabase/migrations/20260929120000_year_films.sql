-- Year Film P1 backend (docs/plans/year-film-p1.md §4–§5).
--
-- Films (birthday / monthly / year-end family) are scheduled here, curated
-- and rendered by cloudflare/year-film-worker (+ Fly machines), and published
-- back through workflow-year-film-bridge with a compare-and-set. Every status
-- change is service-role; clients read a safe column subset and edit only
-- through save_year_film_edits.
--
-- Sections:
--   1. year_film_settings (rollout flag) + year_film_family_enabled
--   2. year_films + views + render requests + bridge nonces, RLS, grants
--   3. text hash + invalidation (epoch) + triggers
--   4. scheduler RPCs: due, requeue, dispatch claim, recovery, notifications,
--      cleanup
--   5. Workflow RPCs: heartbeat, curation, checks, status, machines, render
--      slot, publish, end of cycle
--   6. client RPC save_year_film_edits; operator RPC queue_year_film_forced
--   7. ai_usage_events operations
--   8. claim_family_deletion_fence waits for in-flight film attempts
--
-- Definer functions re-check what RLS would have (anonymous, role, billing).

-- ---------------------------------------------------------------------------
-- 1. Rollout flag
-- ---------------------------------------------------------------------------

create table public.year_film_settings (
  id boolean primary key default true check (id),
  mode text not null default 'off' check (mode in ('off', 'canary', 'all')),
  canary_family_ids uuid[] not null default '{}',
  -- No backfill: a film whose due date is before launch_date is never
  -- scheduled (year-film.md §7.1 "first run").
  launch_date date,
  max_concurrent_renders integer not null default 4 check (max_concurrent_renders between 1 and 100),
  updated_at timestamptz not null default now()
);

insert into public.year_film_settings (id) values (true);

alter table public.year_film_settings enable row level security;
revoke all on table public.year_film_settings from anon, authenticated;

comment on table public.year_film_settings is
  'Year Film rollout flag (docs/plans/year-film-p1.md Decision 10): off | canary (canary_family_ids only) | all. Service role only.';

create or replace function public.year_film_family_enabled(p_family_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.year_film_settings s
    join public.families f on f.id = p_family_id and f.deleted_at is null
    where s.mode = 'all'
       or (s.mode = 'canary' and p_family_id = any (s.canary_family_ids))
  );
$$;

revoke all on function public.year_film_family_enabled(uuid) from public, anon, authenticated;
grant execute on function public.year_film_family_enabled(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------

create table public.year_films (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id) on delete cascade,
  kind text not null check (kind in ('birthday', 'family_month', 'family_year')),
  family_member_id uuid,
  age_year integer check (age_year between 1 and 12),
  -- Operator/canary films (queue_year_film_forced) live outside the
  -- one-row-per-film key so they can never take a real film's slot.
  forced boolean not null default false,
  scope_start_date date not null,
  scope_end_exclusive date not null,
  scope_label text,
  language text check (language in ('en', 'es')),
  status text not null default 'queued'
    check (status in ('queued', 'curating', 'preparing', 'rendering', 'ready', 'skipped', 'failed')),
  -- blocked: the current video must never be served (removed/reported/edited-
  -- out content). stale: a re-render is wanted; the current video is fine.
  blocked boolean not null default false,
  stale boolean not null default false,
  skip_reason text,
  film_script jsonb,
  edits jsonb not null default '{}'::jsonb,
  edits_version integer not null default 0,
  music_bed_id text,
  quote_candidates jsonb,
  ai_checks jsonb not null default '{}'::jsonb,
  pool_cutoff_at timestamptz,
  referenced_memory_ids uuid[] not null default '{}',
  referenced_asset_keys text[] not null default '{}',
  referenced_member_ids uuid[] not null default '{}',
  referenced_portrait_version_ids uuid[] not null default '{}',
  quoted_memory_text_hashes jsonb not null default '{}'::jsonb,
  content_epoch integer not null default 0,
  curated_epoch integer,
  video_key text,
  poster_key text,
  scenes_key text,
  duration_ms integer,
  attempt_id uuid,
  attempt_count integer not null default 0,
  next_attempt_at timestamptz,
  workflow_instance_id text,
  machine_ids jsonb not null default '{}'::jsonb,
  generation_started_at timestamptz,
  heartbeat_at timestamptz,
  render_slot_at timestamptz,
  requeue_after timestamptz,
  last_failure_code text,
  cleanup_needed boolean not null default false,
  surface_at timestamptz not null,
  notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ready_at timestamptz,
  constraint year_films_member_fkey
    foreign key (family_member_id, family_id)
    references public.family_members (id, family_id) on delete cascade,
  constraint year_films_birthday_member_check
    check ((kind = 'birthday') = (family_member_id is not null)),
  constraint year_films_birthday_age_check
    check ((kind = 'birthday') = (age_year is not null)),
  constraint year_films_scope_check check (scope_end_exclusive > scope_start_date),
  constraint year_films_video_check
    check ((video_key is null) = (poster_key is null))
);

-- One row per scheduled film key forever: a failing or skipped film is never
-- re-inserted by the hourly scheduler (plan §4).
create unique index year_films_key
  on public.year_films (
    family_id, kind,
    coalesce(family_member_id, '00000000-0000-0000-0000-000000000000'::uuid),
    scope_start_date
  )
  where not forced;

create index idx_year_films_family on public.year_films (family_id, surface_at desc);
create index idx_year_films_status on public.year_films (status, next_attempt_at);
create index idx_year_films_requeue on public.year_films (requeue_after) where requeue_after is not null;
create index idx_year_films_cleanup on public.year_films (id) where cleanup_needed;
create index idx_year_films_ref_memories on public.year_films using gin (referenced_memory_ids);
create index idx_year_films_ref_assets on public.year_films using gin (referenced_asset_keys);
create index idx_year_films_ref_members on public.year_films using gin (referenced_member_ids);
create index idx_year_films_ref_portraits on public.year_films using gin (referenced_portrait_version_ids);
create index idx_year_films_quoted on public.year_films using gin (quoted_memory_text_hashes);

comment on table public.year_films is
  'Year Films (docs/plans/year-film-p1.md). Status/keys/scripts are service-role only; clients read a safe column subset (column grants) and edit via save_year_film_edits.';

alter table public.year_films enable row level security;
revoke all on table public.year_films from anon, authenticated;
-- Column-level read: never film_script, quotes, checks, keys or attempt state.
grant select (
  id, family_id, kind, family_member_id, age_year, scope_start_date,
  scope_end_exclusive, scope_label, language, status, blocked, stale,
  duration_ms, edits_version, surface_at, ready_at, created_at
) on public.year_films to authenticated;

-- Members see a film once it has a servable video and has surfaced;
-- owners/managers may see it earlier (canary preview).
create policy "Year films: select" on public.year_films
  for select
  using (
    public.is_family_member(family_id)
    and video_key is not null
    and not blocked
    and (surface_at <= now() or public.has_family_role(family_id, array['owner', 'manager']))
  );

create policy "Year films: deny anonymous" on public.year_films
  as restrictive for all to authenticated
  using (not public.is_anonymous_user())
  with check (not public.is_anonymous_user());

create table public.year_film_views (
  film_id uuid not null references public.year_films (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  first_viewed_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (film_id, user_id)
);

alter table public.year_film_views enable row level security;
revoke all on table public.year_film_views from anon, authenticated;
grant select, insert on table public.year_film_views to authenticated;
grant update (completed_at) on table public.year_film_views to authenticated;

create policy "Year film views: own select" on public.year_film_views
  for select using (user_id = auth.uid());
create policy "Year film views: own insert" on public.year_film_views
  for insert with check (
    user_id = auth.uid()
    and exists (select 1 from public.year_films f where f.id = film_id)
  );
create policy "Year film views: own update" on public.year_film_views
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "Year film views: deny anonymous" on public.year_film_views
  as restrictive for all to authenticated
  using (not public.is_anonymous_user())
  with check (not public.is_anonymous_user());

-- Fair-use ledger for edit re-renders (year-film.md §7.7).
create table public.year_film_render_requests (
  id uuid primary key default gen_random_uuid(),
  film_id uuid not null references public.year_films (id) on delete cascade,
  family_id uuid not null references public.families (id) on delete cascade,
  requested_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index idx_year_film_render_requests_film on public.year_film_render_requests (film_id, created_at);
create index idx_year_film_render_requests_family on public.year_film_render_requests (family_id, created_at);
alter table public.year_film_render_requests enable row level security;
revoke all on table public.year_film_render_requests from anon, authenticated;

-- Bridge replay ledger (durable-ai-generation-workflows.md "two signed hops").
create table public.year_film_bridge_nonces (
  nonce uuid primary key,
  created_at timestamptz not null default now()
);
alter table public.year_film_bridge_nonces enable row level security;
revoke all on table public.year_film_bridge_nonces from anon, authenticated;

create or replace function public.record_year_film_bridge_nonce(p_nonce uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.year_film_bridge_nonces where created_at < now() - interval '1 day';
  insert into public.year_film_bridge_nonces (nonce) values (p_nonce);
  return true;
exception when unique_violation then
  return false;
end;
$$;
revoke all on function public.record_year_film_bridge_nonce(uuid) from public, anon, authenticated;
grant execute on function public.record_year_film_bridge_nonce(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Invalidation
-- ---------------------------------------------------------------------------

-- The text a quote can come from. The bridge returns this hash per memory and
-- the Worker stores it for quoted memories; an edit that changes it blocks
-- the film. (Deno twin: _shared/year-film-context.ts yearFilmTextHash.)
create or replace function public.year_film_text_hash(p_content text, p_transcript text, p_description text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(
    sha256(convert_to(
      coalesce(p_content, '') || chr(31) || coalesce(p_transcript, '') || chr(31) || coalesce(p_description, ''),
      'UTF8'
    )),
    'hex'
  );
$$;

-- Marks films as needing a fresh build. Always bumps content_epoch (an
-- in-flight attempt then loses its publish CAS / heartbeat); p_block also
-- stops serving the current video. The scheduler requeues after the
-- debounce (requeue_after) so a burst of deletes renders once.
create or replace function public.year_film_invalidate(p_film_ids uuid[], p_block boolean)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_film_ids is null or cardinality(p_film_ids) = 0 then
    return 0;
  end if;
  set local lock_timeout = '5s';
  update public.year_films
  set content_epoch = content_epoch + 1,
      blocked = blocked or p_block,
      stale = true,
      requeue_after = coalesce(requeue_after, now() + interval '15 minutes'),
      updated_at = now()
  where id = any (p_film_ids)
    and (video_key is not null or status in ('queued', 'curating', 'preparing', 'rendering'));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.year_film_invalidate(uuid[], boolean) from public, anon, authenticated;
grant execute on function public.year_film_invalidate(uuid[], boolean) to service_role;

-- memories: deleted (statement-level, bulk-safe).
create or replace function public.year_films_on_memories_deleted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.year_film_invalidate(
    array(
      select f.id from public.year_films f
      where f.referenced_memory_ids && array(select o.id from old_rows o)
    ),
    true
  );
  return null;
end;
$$;
revoke all on function public.year_films_on_memories_deleted() from public, anon, authenticated;
create trigger year_films_on_memories_deleted
  after delete on public.memories
  referencing old table as old_rows
  for each statement execute function public.year_films_on_memories_deleted();

-- memories: quoted text changed (row-level; cheap GIN `?` probe).
create or replace function public.year_films_on_memory_text_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash text := public.year_film_text_hash(new.content, new.audio_transcript, new.description);
begin
  perform public.year_film_invalidate(
    array(
      select f.id from public.year_films f
      where f.quoted_memory_text_hashes ? new.id::text
        and f.quoted_memory_text_hashes ->> new.id::text is distinct from v_hash
    ),
    true
  );
  return null;
end;
$$;
revoke all on function public.year_films_on_memory_text_changed() from public, anon, authenticated;
create trigger year_films_on_memory_text_changed
  after update of content, audio_transcript, description on public.memories
  for each row
  when (
    old.content is distinct from new.content
    or old.audio_transcript is distinct from new.audio_transcript
    or old.description is distinct from new.description
  )
  execute function public.year_films_on_memory_text_changed();

-- memory_media: deferred to commit and only when the key is truly gone --
-- replace_memory_media_assets deletes and re-inserts unchanged rows on every
-- media save, which must not invalidate anything.
create or replace function public.year_films_on_memory_media_deleted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_gone text[];
begin
  v_gone := array(
    select k from unnest(array[old.object_key, old.preview_object_key]) as k
    where k is not null
      and not exists (
        select 1 from public.memory_media m
        where m.object_key = k or m.preview_object_key = k
      )
  );
  if cardinality(v_gone) > 0 then
    perform public.year_film_invalidate(
      array(select f.id from public.year_films f where f.referenced_asset_keys && v_gone),
      true
    );
  end if;
  return null;
end;
$$;
revoke all on function public.year_films_on_memory_media_deleted() from public, anon, authenticated;
create constraint trigger year_films_on_memory_media_deleted
  after delete on public.memory_media
  deferrable initially deferred
  for each row execute function public.year_films_on_memory_media_deleted();

-- content_reports: family-wide for films (any new report).
create or replace function public.year_films_on_content_reported()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.target_type in ('memory', 'memory_illustration') then
    perform public.year_film_invalidate(
      array(select f.id from public.year_films f where f.referenced_memory_ids @> array[new.target_id]),
      true
    );
  elsif new.target_type = 'family_member_profile' then
    perform public.year_film_invalidate(
      array(select f.id from public.year_films f where f.referenced_member_ids @> array[new.target_id]),
      true
    );
  elsif new.target_type = 'family_member_portrait' then
    perform public.year_film_invalidate(
      array(select f.id from public.year_films f where f.referenced_portrait_version_ids @> array[new.target_id]),
      true
    );
  end if;
  return null;
end;
$$;
revoke all on function public.year_films_on_content_reported() from public, anon, authenticated;
create trigger year_films_on_content_reported
  after insert on public.content_reports
  for each row execute function public.year_films_on_content_reported();

-- Portrait versions and family members: deleted (statement-level).
create or replace function public.year_films_on_portrait_versions_deleted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.year_film_invalidate(
    array(
      select f.id from public.year_films f
      where f.referenced_portrait_version_ids && array(select o.id from old_rows o)
    ),
    true
  );
  return null;
end;
$$;
revoke all on function public.year_films_on_portrait_versions_deleted() from public, anon, authenticated;
create trigger year_films_on_portrait_versions_deleted
  after delete on public.family_member_portrait_versions
  referencing old table as old_rows
  for each statement execute function public.year_films_on_portrait_versions_deleted();

create or replace function public.year_films_on_family_members_deleted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.year_film_invalidate(
    array(
      select f.id from public.year_films f
      where f.referenced_member_ids && array(select o.id from old_rows o)
    ),
    true
  );
  return null;
end;
$$;
revoke all on function public.year_films_on_family_members_deleted() from public, anon, authenticated;
create trigger year_films_on_family_members_deleted
  after delete on public.family_members
  referencing old table as old_rows
  for each statement execute function public.year_films_on_family_members_deleted();

-- ---------------------------------------------------------------------------
-- 4. Scheduler RPCs (service role, called by schedule-year-films)
-- ---------------------------------------------------------------------------

-- Own child for scheduling: the SQL twin of isFilmChild's role rule
-- (_shared/family-relationships.ts isOwnChild): explicit role wins, unsorted
-- falls back to DOB < 13 at p_on. The under-13 film ceiling is applied by
-- the caller at the film's own date.
create or replace function public.year_film_is_own_child(p_relationship text, p_dob date, p_on date)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when p_relationship = 'child' then true
    when p_relationship is not null then false
    else p_dob is not null and date_part('year', age(p_on, p_dob)) < 13
  end;
$$;

-- Families that can get films now, with the owner's timezone and local
-- time (the Looking Back timezone pattern, invalid zones fall back to UTC).
create or replace function public.year_film_due_families(p_now timestamptz)
returns table (family_id uuid, tz text, local_now timestamp)
language sql
stable
security definer
set search_path = ''
as $$
  select f.id, z.tz, p_now at time zone z.tz
  from public.year_film_settings s
  join public.families f on f.deleted_at is null
  left join public.user_profiles up on up.id = f.owner_id
  cross join lateral (
    select case
      when up.timezone is not null and exists (select 1 from pg_timezone_names n where n.name = up.timezone)
        then up.timezone
      else 'UTC'
    end as tz
  ) z
  where s.id
    and (s.mode = 'all' or (s.mode = 'canary' and f.id = any (s.canary_family_ids)))
    and public.billing_write_allowed(f.id, f.owner_id);
$$;
revoke all on function public.year_film_due_families(timestamptz) from public, anon, authenticated;
grant execute on function public.year_film_due_families(timestamptz) to service_role;

-- Inserts every film that is due at p_now (plan Step 3.1). Due = owner-local
-- time >= 00:30 on the due date, within a 3-day catch-up window, and the due
-- date >= launch_date. Idempotent (unique key; forced rows ignored).
create or replace function public.year_film_due(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings public.year_film_settings;
  v_inserted integer := 0;
  v_rows integer;
begin
  select * into v_settings from public.year_film_settings where id;
  if v_settings.mode = 'off' or v_settings.launch_date is null then
    return 0;
  end if;

  -- Birthday films: due on birthday + 3 days (= scope_end_exclusive).
  insert into public.year_films (
    family_id, kind, family_member_id, age_year, scope_start_date, scope_end_exclusive, surface_at
  )
  select d.family_id, 'birthday', m.id, b.age_year,
         (m.date_of_birth + make_interval(years => b.age_year - 1))::date,
         b.due_date,
         (b.due_date + time '09:00') at time zone d.tz
  from public.year_film_due_families(p_now) d
  join public.family_members m on m.family_id = d.family_id and m.date_of_birth is not null
  cross join lateral (
    select y.age_year,
           ((m.date_of_birth + make_interval(years => y.age_year))::date + 3) as due_date
    from (
      select (extract(year from d.local_now)::integer - extract(year from m.date_of_birth)::integer) + k as age_year
      from generate_series(-1, 0) as k
    ) y
    where y.age_year between 1 and 12
  ) b
  where public.year_film_is_own_child(m.relationship, m.date_of_birth, b.due_date - 3)
    and b.due_date >= v_settings.launch_date
    and d.local_now >= (b.due_date + time '00:30')
    and d.local_now < (b.due_date + 3)::timestamp
  on conflict do nothing;
  get diagnostics v_rows = row_count;
  v_inserted := v_inserted + v_rows;

  -- Monthly recaps: due on the 1st, scope = previous month; cheap SQL
  -- pre-filter (MONTHLY_MIN_POOL = 10 memories) and at least one own child.
  insert into public.year_films (family_id, kind, scope_start_date, scope_end_exclusive, surface_at)
  select d.family_id, 'family_month', (x.due_date - interval '1 month')::date, x.due_date,
         (x.due_date + time '19:00') at time zone d.tz
  from public.year_film_due_families(p_now) d
  cross join lateral (select date_trunc('month', d.local_now)::date as due_date) x
  where x.due_date >= v_settings.launch_date
    and d.local_now >= (x.due_date + time '00:30')
    and d.local_now < (x.due_date + 3)::timestamp
    and exists (
      select 1 from public.family_members m
      where m.family_id = d.family_id and m.date_of_birth is not null
        and public.year_film_is_own_child(m.relationship, m.date_of_birth, x.due_date)
    )
    and (
      select count(*) from public.memories mem
      where mem.family_id = d.family_id
        and mem.memory_date >= (x.due_date - interval '1 month')::date
        and mem.memory_date < x.due_date
    ) >= 10
  on conflict do nothing;
  get diagnostics v_rows = row_count;
  v_inserted := v_inserted + v_rows;

  -- Year-end family film: due Dec 12, scope Jan 1 – Dec 11, surfaces Dec 15.
  insert into public.year_films (family_id, kind, scope_start_date, scope_end_exclusive, surface_at)
  select d.family_id, 'family_year', make_date(x.y, 1, 1), x.due_date,
         (make_date(x.y, 12, 15) + time '09:00') at time zone d.tz
  from public.year_film_due_families(p_now) d
  cross join lateral (
    select extract(year from d.local_now)::integer as y,
           make_date(extract(year from d.local_now)::integer, 12, 12) as due_date
  ) x
  where x.due_date >= v_settings.launch_date
    and d.local_now >= (x.due_date + time '00:30')
    and d.local_now < (x.due_date + 3)::timestamp
    and exists (
      select 1 from public.family_members m
      where m.family_id = d.family_id and m.date_of_birth is not null
        and public.year_film_is_own_child(m.relationship, m.date_of_birth, x.due_date)
    )
  on conflict do nothing;
  get diagnostics v_rows = row_count;
  v_inserted := v_inserted + v_rows;

  return v_inserted;
end;
$$;
revoke all on function public.year_film_due(timestamptz) from public, anon, authenticated;
grant execute on function public.year_film_due(timestamptz) to service_role;

-- Debounced invalidations and spaced retries become dispatchable again.
create or replace function public.year_film_promote_requeues(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.year_films
  set status = 'queued', attempt_count = 0, requeue_after = null,
      next_attempt_at = null, attempt_id = null, skip_reason = null, updated_at = now()
  where requeue_after is not null
    and requeue_after <= p_now
    and status in ('ready', 'skipped', 'failed');
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.year_film_promote_requeues(timestamptz) from public, anon, authenticated;
grant execute on function public.year_film_promote_requeues(timestamptz) to service_role;

-- Claims up to p_limit queued films for dispatch (CAS queued -> curating).
create or replace function public.claim_year_film_dispatch(p_limit integer, p_now timestamptz default now())
returns table (film_id uuid, attempt_id uuid, family_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with picked as (
    select f.id
    from public.year_films f
    where f.status = 'queued'
      and (f.next_attempt_at is null or f.next_attempt_at <= p_now)
      and (f.requeue_after is null or f.requeue_after <= p_now)
      and public.year_film_family_enabled(f.family_id)
    order by f.surface_at, f.created_at
    limit greatest(p_limit, 0)
    for update skip locked
  )
  update public.year_films y
  set status = 'curating',
      attempt_id = gen_random_uuid(),
      attempt_count = y.attempt_count + 1,
      requeue_after = null,
      generation_started_at = p_now,
      heartbeat_at = p_now,
      render_slot_at = null,
      machine_ids = '{}'::jsonb,
      updated_at = now()
  from picked
  where y.id = picked.id
  returning y.id, y.attempt_id, y.family_id;
end;
$$;
revoke all on function public.claim_year_film_dispatch(integer, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_year_film_dispatch(integer, timestamptz) to service_role;

-- Internal: ends a render cycle (plan §4 "Cycle end"). Returns the object
-- keys the caller must delete (a blocked row's old video).
create or replace function public.year_film_finish_cycle(
  p_film public.year_films,
  p_outcome text,
  p_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_delete text[] := '{}';
  v_status text;
begin
  if p_film.requeue_after is not null then
    -- A pending invalidation: start a fresh cycle after the debounce.
    update public.year_films
    set status = 'queued', attempt_count = 0, attempt_id = null,
        next_attempt_at = p_film.requeue_after, requeue_after = null,
        last_failure_code = coalesce(p_code, last_failure_code),
        cleanup_needed = true, render_slot_at = null, updated_at = now()
    where id = p_film.id;
    return jsonb_build_object('status', 'queued', 'delete_keys', '[]'::jsonb);
  end if;

  if p_film.video_key is not null and not p_film.blocked then
    v_status := 'ready';
    update public.year_films
    set status = 'ready', stale = false, attempt_id = null,
        last_failure_code = p_code, cleanup_needed = true,
        render_slot_at = null, updated_at = now()
    where id = p_film.id;
  else
    v_status := case when p_outcome = 'skipped' then 'skipped' else 'failed' end;
    if p_film.video_key is not null then
      v_delete := array_remove(array[p_film.video_key, p_film.poster_key, p_film.scenes_key], null);
    end if;
    update public.year_films
    set status = v_status,
        skip_reason = case when p_outcome = 'skipped' then p_code else skip_reason end,
        last_failure_code = case when p_outcome = 'skipped' then last_failure_code else p_code end,
        video_key = case when p_film.video_key is not null then null else video_key end,
        poster_key = case when p_film.video_key is not null then null else poster_key end,
        scenes_key = case when p_film.video_key is not null then null else scenes_key end,
        duration_ms = case when p_film.video_key is not null then null else duration_ms end,
        attempt_id = null, cleanup_needed = true, render_slot_at = null, updated_at = now()
    where id = p_film.id;
  end if;
  return jsonb_build_object('status', v_status, 'delete_keys', to_jsonb(v_delete));
end;
$$;
revoke all on function public.year_film_finish_cycle(public.year_films, text, text) from public, anon, authenticated;

-- Stale heartbeats (>20 min): retry with spacing, or end the cycle.
create or replace function public.year_film_recover(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_film public.year_films;
  v_retried integer := 0;
  v_ended integer := 0;
  v_delete jsonb := '[]'::jsonb;
  v_result jsonb;
begin
  for v_film in
    select * from public.year_films
    where status in ('curating', 'preparing', 'rendering')
      and heartbeat_at < p_now - interval '20 minutes'
    for update skip locked
  loop
    if v_film.attempt_count < 3 then
      update public.year_films
      set status = 'queued', attempt_id = null, render_slot_at = null,
          next_attempt_at = p_now + case when v_film.attempt_count <= 1 then interval '1 hour' else interval '6 hours' end,
          last_failure_code = 'HEARTBEAT_LOST', cleanup_needed = true, updated_at = now()
      where id = v_film.id;
      v_retried := v_retried + 1;
    else
      v_result := public.year_film_finish_cycle(v_film, 'failed', 'HEARTBEAT_LOST');
      v_delete := v_delete || (v_result -> 'delete_keys');
      v_ended := v_ended + 1;
    end if;
  end loop;
  return jsonb_build_object('retried', v_retried, 'ended', v_ended, 'delete_keys', v_delete);
end;
$$;
revoke all on function public.year_film_recover(timestamptz) from public, anon, authenticated;
grant execute on function public.year_film_recover(timestamptz) to service_role;

-- Films to announce now; marked notified in the same statement (at most once).
create or replace function public.year_film_notifications_due(p_now timestamptz default now())
returns table (film_id uuid, family_id uuid, kind text, family_member_id uuid, age_year integer, language text, scope_start_date date)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  update public.year_films y
  set notified_at = p_now, updated_at = now()
  where y.status = 'ready'
    and not y.blocked
    and y.video_key is not null
    and y.notified_at is null
    and not y.forced
    and y.surface_at <= p_now
    and y.surface_at > p_now - interval '14 days'
    and public.year_film_family_enabled(y.family_id)
  returning y.id, y.family_id, y.kind, y.family_member_id, y.age_year, y.language, y.scope_start_date;
end;
$$;
revoke all on function public.year_film_notifications_due(timestamptz) from public, anon, authenticated;
grant execute on function public.year_film_notifications_due(timestamptz) to service_role;

-- Rows whose attempt directories need sweeping (non-current attempts,
-- blocked leftovers). The caller lists {ownerId}/year-films/{id}/ and keeps
-- only the directory holding video_key.
create or replace function public.year_films_needing_cleanup(p_limit integer)
returns table (film_id uuid, owner_id uuid, video_key text)
language sql
stable
security definer
set search_path = ''
as $$
  select y.id, f.owner_id, y.video_key
  from public.year_films y
  join public.families f on f.id = y.family_id
  where y.cleanup_needed
    and y.status not in ('curating', 'preparing', 'rendering')
  order by y.updated_at
  limit greatest(p_limit, 0);
$$;
revoke all on function public.year_films_needing_cleanup(integer) from public, anon, authenticated;
grant execute on function public.year_films_needing_cleanup(integer) to service_role;

create or replace function public.mark_year_film_cleaned(p_film_id uuid, p_video_key text)
returns boolean
language sql
security definer
set search_path = ''
as $$
  update public.year_films
  set cleanup_needed = false, updated_at = now()
  where id = p_film_id
    and video_key is not distinct from p_video_key
    and status not in ('curating', 'preparing', 'rendering')
  returning true;
$$;
revoke all on function public.mark_year_film_cleaned(uuid, text) from public, anon, authenticated;
grant execute on function public.mark_year_film_cleaned(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Workflow RPCs (service role, called by workflow-year-film-bridge)
-- ---------------------------------------------------------------------------

-- ok | superseded | epoch_changed | disabled. p_epoch is the epoch the
-- attempt curated against (null before curation).
create or replace function public.year_film_heartbeat(p_film_id uuid, p_attempt_id uuid, p_epoch integer)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_film public.year_films;
begin
  select * into v_film from public.year_films where id = p_film_id for update;
  if not found or v_film.attempt_id is distinct from p_attempt_id
     or v_film.status not in ('curating', 'preparing', 'rendering') then
    return 'superseded';
  end if;
  if not public.year_film_family_enabled(v_film.family_id) then
    return 'disabled';
  end if;
  if p_epoch is not null and v_film.content_epoch <> p_epoch then
    return 'epoch_changed';
  end if;
  update public.year_films set heartbeat_at = now() where id = p_film_id;
  return 'ok';
end;
$$;
revoke all on function public.year_film_heartbeat(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.year_film_heartbeat(uuid, uuid, integer) to service_role;

-- Stores the curation of this attempt. p_payload keys: epoch (the
-- content_epoch the context was loaded at), language, scope_label,
-- music_bed_id, quote_candidates, film_script, referenced_memory_ids,
-- referenced_asset_keys, referenced_member_ids,
-- referenced_portrait_version_ids, quoted_memory_text_hashes.
-- Sticky fields (language, bed, quote candidates, pool cut-off) are only
-- set the first time.
create or replace function public.year_film_save_curation(p_film_id uuid, p_attempt_id uuid, p_payload jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_film public.year_films;
begin
  select * into v_film from public.year_films where id = p_film_id for update;
  if not found or v_film.attempt_id is distinct from p_attempt_id or v_film.status <> 'curating' then
    return 'superseded';
  end if;
  if v_film.content_epoch <> (p_payload ->> 'epoch')::integer then
    return 'epoch_changed';
  end if;
  update public.year_films
  set language = coalesce(language, p_payload ->> 'language'),
      scope_label = coalesce(p_payload ->> 'scope_label', scope_label),
      music_bed_id = coalesce(music_bed_id, p_payload ->> 'music_bed_id'),
      quote_candidates = coalesce(quote_candidates, p_payload -> 'quote_candidates'),
      pool_cutoff_at = coalesce(pool_cutoff_at, generation_started_at),
      film_script = p_payload -> 'film_script',
      referenced_memory_ids = coalesce(array(select jsonb_array_elements_text(p_payload -> 'referenced_memory_ids'))::uuid[], '{}'),
      referenced_asset_keys = coalesce(array(select jsonb_array_elements_text(p_payload -> 'referenced_asset_keys')), '{}'),
      referenced_member_ids = coalesce(array(select jsonb_array_elements_text(p_payload -> 'referenced_member_ids'))::uuid[], '{}'),
      referenced_portrait_version_ids = coalesce(array(select jsonb_array_elements_text(p_payload -> 'referenced_portrait_version_ids'))::uuid[], '{}'),
      quoted_memory_text_hashes = coalesce(p_payload -> 'quoted_memory_text_hashes', '{}'::jsonb),
      curated_epoch = (p_payload ->> 'epoch')::integer,
      heartbeat_at = now(),
      updated_at = now()
  where id = p_film_id;
  return 'ok';
end;
$$;
revoke all on function public.year_film_save_curation(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.year_film_save_curation(uuid, uuid, jsonb) to service_role;

-- Merges per-frame verdicts (persisted per batch so retries never repay).
create or replace function public.year_film_save_checks(p_film_id uuid, p_attempt_id uuid, p_checks jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if jsonb_typeof(p_checks) <> 'object' then
    raise exception 'p_checks must be an object' using errcode = '22023';
  end if;
  update public.year_films
  set ai_checks = ai_checks || p_checks, heartbeat_at = now(), updated_at = now()
  where id = p_film_id and attempt_id = p_attempt_id
    and status in ('curating', 'preparing', 'rendering');
  return case when found then 'ok' else 'superseded' end;
end;
$$;
revoke all on function public.year_film_save_checks(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.year_film_save_checks(uuid, uuid, jsonb) to service_role;

create or replace function public.year_film_set_status(p_film_id uuid, p_attempt_id uuid, p_status text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status not in ('preparing') then
    raise exception 'unsupported status transition' using errcode = '22023';
  end if;
  update public.year_films
  set status = p_status, heartbeat_at = now(), updated_at = now()
  where id = p_film_id and attempt_id = p_attempt_id and status = 'curating';
  return case when found then 'ok' else 'superseded' end;
end;
$$;
revoke all on function public.year_film_set_status(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.year_film_set_status(uuid, uuid, text) to service_role;

create or replace function public.year_film_record_machine(p_film_id uuid, p_attempt_id uuid, p_mode text, p_machine_id text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_mode not in ('thumbs', 'prepare', 'render') then
    raise exception 'unknown machine mode' using errcode = '22023';
  end if;
  update public.year_films
  set machine_ids = machine_ids || jsonb_build_object(p_mode, p_machine_id), heartbeat_at = now(), updated_at = now()
  where id = p_film_id and attempt_id = p_attempt_id;
  return case when found then 'ok' else 'superseded' end;
end;
$$;
revoke all on function public.year_film_record_machine(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.year_film_record_machine(uuid, uuid, text, text) to service_role;

-- DB-side render concurrency cap: true = this attempt holds a slot and the
-- row is now 'rendering'.
create or replace function public.year_film_claim_render_slot(p_film_id uuid, p_attempt_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max integer;
  v_active integer;
begin
  select max_concurrent_renders into v_max from public.year_film_settings where id for update;
  if exists (
    select 1 from public.year_films
    where id = p_film_id and attempt_id = p_attempt_id and status = 'rendering'
  ) then
    return 'ok';
  end if;
  if not exists (
    select 1 from public.year_films
    where id = p_film_id and attempt_id = p_attempt_id and status = 'preparing'
  ) then
    return 'superseded';
  end if;
  select count(*) into v_active
  from public.year_films
  where status = 'rendering' and render_slot_at > now() - interval '40 minutes';
  if v_active >= v_max then
    update public.year_films set heartbeat_at = now() where id = p_film_id;
    return 'full';
  end if;
  update public.year_films
  set status = 'rendering', render_slot_at = now(), heartbeat_at = now(), updated_at = now()
  where id = p_film_id;
  return 'ok';
end;
$$;
revoke all on function public.year_film_claim_render_slot(uuid, uuid) from public, anon, authenticated;
grant execute on function public.year_film_claim_render_slot(uuid, uuid) to service_role;

-- Publish CAS (plan §4 "Epoch"): attempt, edits_version and content epoch
-- must all still match, and every referenced item must still exist with no
-- open/reviewing report and unchanged quoted text. Plain reads only (no row
-- locks on memories: a concurrent delete waits on this film row via its
-- trigger, never the other way round).
create or replace function public.publish_year_film(
  p_film_id uuid,
  p_attempt_id uuid,
  p_edits_version integer,
  p_video_key text,
  p_poster_key text,
  p_scenes_key text,
  p_duration_ms integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_film public.year_films;
  v_old text[];
  v_ok boolean;
  v_result jsonb;
begin
  select * into v_film from public.year_films where id = p_film_id for update;
  if not found or v_film.attempt_id is distinct from p_attempt_id or v_film.status <> 'rendering' then
    return jsonb_build_object('ok', false, 'reason', 'superseded');
  end if;
  if v_film.edits_version <> p_edits_version then
    return jsonb_build_object('ok', false, 'reason', 'edits_changed');
  end if;

  v_ok := v_film.curated_epoch is not null and v_film.content_epoch = v_film.curated_epoch
    -- every referenced memory still exists and isn't reported
    and (select count(*) from public.memories m where m.id = any (v_film.referenced_memory_ids))
        = cardinality(v_film.referenced_memory_ids)
    and not exists (
      select 1 from public.content_reports r
      where r.status in ('open', 'reviewing')
        and (
          (r.target_type in ('memory', 'memory_illustration') and r.target_id = any (v_film.referenced_memory_ids))
          or (r.target_type = 'family_member_profile' and r.target_id = any (v_film.referenced_member_ids))
          or (r.target_type = 'family_member_portrait' and r.target_id = any (v_film.referenced_portrait_version_ids))
        )
    )
    -- members and portrait versions still exist
    and (select count(*) from public.family_members m where m.id = any (v_film.referenced_member_ids))
        = cardinality(v_film.referenced_member_ids)
    and (select count(*) from public.family_member_portrait_versions v where v.id = any (v_film.referenced_portrait_version_ids))
        = cardinality(v_film.referenced_portrait_version_ids)
    -- every asset key is still attached somewhere in the family
    and not exists (
      select 1 from unnest(v_film.referenced_asset_keys) as k
      where not exists (
        select 1 from public.memory_media mm
        join public.memories mem on mem.id = mm.memory_id and mem.family_id = v_film.family_id
        where mm.object_key = k or mm.preview_object_key = k
      )
      and not exists (
        select 1 from public.memories mem
        where mem.family_id = v_film.family_id and mem.illustration_key = k
      )
      and not exists (
        select 1 from public.family_member_portrait_versions v
        where v.family_id = v_film.family_id and (v.illustrated_profile_key = k or v.profile_picture_key = k)
      )
    )
    -- nothing by an account a parent blocked
    and not exists (
      select 1 from public.memories mem
      where mem.id = any (v_film.referenced_memory_ids)
        and mem.user_id = any (public.year_film_parent_blocked_users(v_film.family_id))
    )
    -- quoted text unchanged
    and not exists (
      select 1 from jsonb_each_text(v_film.quoted_memory_text_hashes) as q(memory_id, hash)
      join public.memories mem on mem.id = q.memory_id::uuid
      where public.year_film_text_hash(mem.content, mem.audio_transcript, mem.description) <> q.hash
    );

  if not v_ok then
    -- Content moved under this attempt: start over (fresh curate).
    update public.year_films
    set content_epoch = content_epoch + 1,
        requeue_after = coalesce(requeue_after, now())
    where id = p_film_id
    returning * into v_film;
    v_result := public.year_film_finish_cycle(v_film, 'failed', 'CONTENT_CHANGED');
    return jsonb_build_object('ok', false, 'reason', 'content_changed', 'delete_keys', v_result -> 'delete_keys');
  end if;

  v_old := array_remove(array[v_film.video_key, v_film.poster_key, v_film.scenes_key], null);
  update public.year_films
  set status = 'ready', blocked = false, stale = false,
      video_key = p_video_key, poster_key = p_poster_key, scenes_key = p_scenes_key,
      duration_ms = p_duration_ms, ready_at = now(), attempt_id = null,
      render_slot_at = null, last_failure_code = null, cleanup_needed = true,
      updated_at = now()
  where id = p_film_id;
  return jsonb_build_object('ok', true, 'delete_keys', to_jsonb(v_old));
end;
$$;
revoke all on function public.publish_year_film(uuid, uuid, integer, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.publish_year_film(uuid, uuid, integer, text, text, text, integer) to service_role;

-- The Workflow gives up on this attempt. p_outcome: failed | skipped |
-- aborted (epoch changed / superseded / disabled: never burns an attempt).
create or replace function public.year_film_end_cycle(p_film_id uuid, p_attempt_id uuid, p_outcome text, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_film public.year_films;
begin
  if p_outcome not in ('failed', 'skipped', 'aborted') then
    raise exception 'unknown outcome' using errcode = '22023';
  end if;
  select * into v_film from public.year_films where id = p_film_id for update;
  if not found or v_film.attempt_id is distinct from p_attempt_id
     or v_film.status not in ('curating', 'preparing', 'rendering') then
    return jsonb_build_object('status', 'superseded', 'delete_keys', '[]'::jsonb);
  end if;

  if p_outcome = 'aborted' then
    update public.year_films
    set status = 'queued', attempt_id = null, render_slot_at = null,
        attempt_count = greatest(attempt_count - 1, 0),
        next_attempt_at = coalesce(requeue_after, now()), requeue_after = null,
        cleanup_needed = true, updated_at = now()
    where id = p_film_id;
    return jsonb_build_object('status', 'queued', 'delete_keys', '[]'::jsonb);
  end if;

  if p_outcome = 'failed' and v_film.attempt_count < 3 and v_film.requeue_after is null then
    update public.year_films
    set status = 'queued', attempt_id = null, render_slot_at = null,
        next_attempt_at = now() + case when v_film.attempt_count <= 1 then interval '1 hour' else interval '6 hours' end,
        last_failure_code = p_code, cleanup_needed = true, updated_at = now()
    where id = p_film_id;
    return jsonb_build_object('status', 'queued', 'delete_keys', '[]'::jsonb);
  end if;

  return public.year_film_finish_cycle(v_film, p_outcome, p_code);
end;
$$;
revoke all on function public.year_film_end_cycle(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.year_film_end_cycle(uuid, uuid, text, text) to service_role;

-- A skipped monthly/birthday film gets one re-check inside its catch-up
-- window when memories arrived in scope after the skip (the parent posts on
-- the 1st). Service role, called by the scheduler.
create or replace function public.year_film_recheck_skipped(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.year_films y
  set status = 'queued', attempt_count = 0, skip_reason = null,
      next_attempt_at = null, updated_at = now(),
      -- one re-check only: remember it in last_failure_code
      last_failure_code = 'SKIPPED_RECHECK'
  where y.status = 'skipped'
    and y.video_key is null
    and not y.forced
    and y.last_failure_code is distinct from 'SKIPPED_RECHECK'
    and y.updated_at < p_now - interval '6 hours'
    -- inside the 3-day catch-up window (+1 day of timezone slack)
    and p_now < ((y.scope_end_exclusive + 4)::timestamp at time zone 'UTC')
    and exists (
      select 1 from public.memories m
      where m.family_id = y.family_id
        and m.memory_date >= y.scope_start_date and m.memory_date < y.scope_end_exclusive
        and m.created_at > y.updated_at
    );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.year_film_recheck_skipped(timestamptz) from public, anon, authenticated;
grant execute on function public.year_film_recheck_skipped(timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Client edits + operator forced films
-- ---------------------------------------------------------------------------

create or replace function public.year_film_bed_ids()
returns text[]
language sql
immutable
set search_path = ''
as $$
  -- Mirrors film-renderer/composition/assets/audio/beds/beds.json
  -- (parity-tested in _shared/year-film-beds.test.ts).
  select array[
    'bells-and-claps', 'bright-pop', 'bubbly-synth', 'celebration-pop', 'groovy-keys',
    'pizzicato-bop', 'playful-marimba', 'playful-piano', 'sparkle-pop', 'tender-piano'
  ];
$$;

-- p_edits: { removedMemoryIds?: uuid[], quote?: {memoryId, textHash} | null,
-- musicBedId?: text }. Owner/manager; billing; fair use (5/film/day,
-- 20/family/day); CAS ready -> queued. Removing content blocks the current
-- video until the new film publishes.
create or replace function public.save_year_film_edits(p_film_id uuid, p_edits jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_film public.year_films;
  v_removed uuid[];
  v_quote jsonb;
  v_bed text;
  v_removing boolean;
  v_merged jsonb;
begin
  if v_uid is null or public.is_anonymous_user() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  select * into v_film from public.year_films where id = p_film_id for update;
  if not found or not public.has_family_role(v_film.family_id, array['owner', 'manager']) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if not public.billing_write_allowed_for_current_user(v_film.family_id) then
    raise exception 'Subscription required' using errcode = '42501';
  end if;
  if v_film.status <> 'ready' or v_film.video_key is null then
    raise exception 'film_not_editable' using errcode = '55000', hint = 'film_not_editable';
  end if;
  if jsonb_typeof(p_edits) <> 'object' then
    raise exception 'invalid_edits' using errcode = '22023', hint = 'invalid_edits';
  end if;

  v_removed := coalesce(array(select jsonb_array_elements_text(coalesce(p_edits -> 'removedMemoryIds', '[]'::jsonb)))::uuid[], '{}');
  if not (v_removed <@ v_film.referenced_memory_ids) then
    raise exception 'invalid_edits' using errcode = '22023', hint = 'removed_memory_not_in_film';
  end if;
  v_quote := p_edits -> 'quote';
  if v_quote is not null and jsonb_typeof(v_quote) <> 'null' and not exists (
    select 1 from jsonb_array_elements(coalesce(v_film.quote_candidates, '[]'::jsonb)) c
    where c ->> 'memoryId' = v_quote ->> 'memoryId' and c ->> 'textHash' = v_quote ->> 'textHash'
  ) then
    raise exception 'invalid_edits' using errcode = '22023', hint = 'quote_not_a_candidate';
  end if;
  v_bed := p_edits ->> 'musicBedId';
  if v_bed is not null and not (v_bed = any (public.year_film_bed_ids())) then
    raise exception 'invalid_edits' using errcode = '22023', hint = 'unknown_music_bed';
  end if;

  if (select count(*) from public.year_film_render_requests
      where film_id = p_film_id and created_at > now() - interval '1 day') >= 5
     or (select count(*) from public.year_film_render_requests
         where family_id = v_film.family_id and created_at > now() - interval '1 day') >= 20 then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited');
  end if;

  v_removing := cardinality(array(
    select unnest(v_removed)
    except
    select jsonb_array_elements_text(coalesce(v_film.edits -> 'removedMemoryIds', '[]'::jsonb))::uuid
  )) > 0;

  v_merged := v_film.edits
    || jsonb_build_object('removedMemoryIds', to_jsonb(v_removed))
    || case when p_edits ? 'quote' then jsonb_build_object('quote', v_quote) else '{}'::jsonb end
    || case when v_bed is not null then jsonb_build_object('musicBedId', v_bed) else '{}'::jsonb end;

  insert into public.year_film_render_requests (film_id, family_id, requested_by)
  values (p_film_id, v_film.family_id, v_uid);

  update public.year_films
  set edits = v_merged,
      edits_version = edits_version + 1,
      music_bed_id = coalesce(v_bed, music_bed_id),
      stale = true,
      blocked = blocked or v_removing,
      status = 'queued', attempt_count = 0, attempt_id = null,
      next_attempt_at = null, requeue_after = null, updated_at = now()
  where id = p_film_id;

  return jsonb_build_object('ok', true, 'edits_version', v_film.edits_version + 1);
end;
$$;
revoke all on function public.save_year_film_edits(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.save_year_film_edits(uuid, jsonb) to authenticated;

create or replace function public.queue_year_film_forced(
  p_family_id uuid,
  p_kind text,
  p_member_id uuid,
  p_age_year integer,
  p_scope_start date,
  p_scope_end_exclusive date,
  p_surface_at timestamptz
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  insert into public.year_films (
    family_id, kind, family_member_id, age_year, forced,
    scope_start_date, scope_end_exclusive, surface_at
  ) values (
    p_family_id, p_kind, p_member_id, p_age_year, true,
    p_scope_start, p_scope_end_exclusive, p_surface_at
  )
  returning id;
$$;
revoke all on function public.queue_year_film_forced(uuid, text, uuid, integer, date, date, timestamptz) from public, anon, authenticated;
grant execute on function public.queue_year_film_forced(uuid, text, uuid, integer, date, date, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- 7. AI ledger operations
-- ---------------------------------------------------------------------------

alter table public.ai_usage_events
  drop constraint ai_usage_events_operation_check;

alter table public.ai_usage_events
  add constraint ai_usage_events_operation_check
  check (operation in (
    'illustration', 'portrait', 'safety_chat', 'emotion_chat', 'emotion_vision',
    'transcription', 'voice_cleanup', 'relationship_chat',
    'year_film_quote', 'year_film_vision', 'year_film_audio'
  )) not valid;

alter table public.ai_usage_events
  validate constraint ai_usage_events_operation_check;

-- ---------------------------------------------------------------------------
-- 8. claim_family_deletion_fence: also wait for in-flight film attempts
--    (definition taken from the live database; only the year_films check is
--    new).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.claim_family_deletion_fence(p_family_id uuid, p_delete_token uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- Year Film P1: a running film attempt could write film/poster objects
  -- after the deletion sweep; wait for it like portraits/illustrations.
  if exists (
    select 1 from public.year_films
    where family_id = p_family_id
      and status in ('curating', 'preparing', 'rendering')
      and heartbeat_at >= now() - interval '20 minutes'
  ) then
    raise exception 'Fresh year film generation is still active' using errcode = '55000';
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
$function$;

-- ---------------------------------------------------------------------------
-- 9. Member deletion: the R2 prefixes of a child's birthday films, so
--    delete-family-member removes their objects before the cascade deletes
--    the rows (plan Step 8). Service role.
-- ---------------------------------------------------------------------------

create or replace function public.year_film_member_prefixes(p_member_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(f.owner_id::text || '/year-films/' || y.id::text || '/'), '{}')
  from public.year_films y
  join public.families f on f.id = y.family_id
  where y.family_member_id = p_member_id;
$$;
revoke all on function public.year_film_member_prefixes(uuid) from public, anon, authenticated;
grant execute on function public.year_film_member_prefixes(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 10. Parent blocks (owner decision 2026-09-29): an account blocked by an
--     owner or manager has its memories left out of every film of that
--     family. A viewer's block stays personal (their own feed only) — a film
--     is one video for the whole family.
-- ---------------------------------------------------------------------------

create or replace function public.year_film_parent_blocked_users(p_family_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct b.blocked_user_id), '{}')
  from public.blocked_family_accounts b
  join public.family_memberships m
    on m.family_id = b.family_id and m.user_id = b.blocker_user_id and m.role in ('owner', 'manager')
  where b.family_id = p_family_id;
$$;
revoke all on function public.year_film_parent_blocked_users(uuid) from public, anon, authenticated;
grant execute on function public.year_film_parent_blocked_users(uuid) to service_role;

-- A new parent block re-makes the films that show that account's memories.
create or replace function public.year_films_on_account_blocked()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.family_memberships m
    where m.family_id = new.family_id and m.user_id = new.blocker_user_id and m.role in ('owner', 'manager')
  ) then
    return null;
  end if;
  perform public.year_film_invalidate(
    array(
      select f.id from public.year_films f
      where f.family_id = new.family_id
        and f.referenced_memory_ids && array(
          select mem.id from public.memories mem
          where mem.family_id = new.family_id and mem.user_id = new.blocked_user_id
        )
    ),
    true
  );
  return null;
end;
$$;
revoke all on function public.year_films_on_account_blocked() from public, anon, authenticated;
create trigger year_films_on_account_blocked
  after insert on public.blocked_family_accounts
  for each row execute function public.year_films_on_account_blocked();
