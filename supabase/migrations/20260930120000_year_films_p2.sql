-- Year Film P2 backend amendments (docs/plans/year-film-p2.md Step 1).
--
-- Sections:
--   1. year_film_due: new delivery dates (birthday +2, year-end Dec 28/30)
--   2. year_films.placement_date (where a film sits in the Timeline)
--   3. Client RLS: forced (operator/canary) films are never visible to members
--   4. Drawer event `film_ready` + v2 activity RPCs + notifications_due
--   5. year_films_enabled (member RPC for the "upcoming recap" card)
--   6. Candidate rows + silent history backfill (operator RPCs)
--   7. Poster thumbnail keys in the delete lists (publish, finish cycle)
--
-- Every function is security definer with an empty search_path and fully
-- qualified names, like 20260929120000_year_films.sql.

-- ---------------------------------------------------------------------------
-- 1. year_film_due: owner decisions 2026-09-29
-- ---------------------------------------------------------------------------

-- Same structure and window logic as P1 (the k in (-1, 0) age candidates, the
-- 3-day catch-up, date_trunc months). Only constants change:
--   * birthday films are due birthday + 2 (= scope_end_exclusive, so the scope
--     covers the birthday and the day after it; TS twin:
--     BIRTHDAY_FILM_DAYS_AFTER = 1 in _shared/year-film-eligibility.ts);
--   * the year-end film is due Dec 28 (scope Jan 1 - Dec 27) and surfaces
--     Dec 30 09:00 owner-local (TS twin: FAMILY_FILM_CUTOFF = '12-28').
-- Monthly recaps are unchanged.
-- year_film_candidate_rows (section 6) recomputes the same dates for the
-- history backfill; supabase/tests/year_films.sql sweeps both for parity, so
-- change the two together.
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

  -- Birthday films: due on birthday + 2 days (= scope_end_exclusive).
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
           ((m.date_of_birth + make_interval(years => y.age_year))::date + 2) as due_date
    from (
      select (extract(year from d.local_now)::integer - extract(year from m.date_of_birth)::integer) + k as age_year
      from generate_series(-1, 0) as k
    ) y
    where y.age_year between 1 and 12
  ) b
  where public.year_film_is_own_child(m.relationship, m.date_of_birth, b.due_date - 2)
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

  -- Year-end family film: due Dec 28, scope Jan 1 - Dec 27, surfaces Dec 30.
  insert into public.year_films (family_id, kind, scope_start_date, scope_end_exclusive, surface_at)
  select d.family_id, 'family_year', make_date(x.y, 1, 1), x.due_date,
         (make_date(x.y, 12, 30) + time '09:00') at time zone d.tz
  from public.year_film_due_families(p_now) d
  cross join lateral (
    select extract(year from d.local_now)::integer as y,
           make_date(extract(year from d.local_now)::integer, 12, 28) as due_date
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

-- ---------------------------------------------------------------------------
-- 2. placement_date: the day a film sits on in the Timeline
-- ---------------------------------------------------------------------------

-- birthday     -> the birthday itself (scope_end_exclusive = birthday + 2;
--                 coupled to BIRTHDAY_FILM_DAYS_AFTER = 1, pgTAP asserts it);
-- family_month -> the month's last day (scope_end_exclusive is the 1st);
-- family_year  -> Dec 31 of the film's year.
-- Generated (immutable expressions only) so every row, including future
-- backfills, is placed consistently; the app orders and interleaves on it.
alter table public.year_films
  add column placement_date date generated always as (
    case kind
      when 'birthday' then scope_end_exclusive - 2
      when 'family_month' then scope_end_exclusive - 1
      else make_date(extract(year from scope_start_date)::integer, 12, 31)
    end
  ) stored;

-- The table only has column-level grants: the new column needs its own.
grant select (placement_date) on public.year_films to authenticated;

create index idx_year_films_family_placement
  on public.year_films (family_id, placement_date desc);

-- ---------------------------------------------------------------------------
-- 3. Client RLS: forced films are operator-only
-- ---------------------------------------------------------------------------

-- Canary/operator films (queue_year_film_forced) never show in the app.
drop policy "Year films: select" on public.year_films;
create policy "Year films: select" on public.year_films
  for select
  using (
    public.is_family_member(family_id)
    and video_key is not null
    and not blocked
    and not forced
    and (surface_at <= now() or public.has_family_role(family_id, array['owner', 'manager']))
  );

-- ---------------------------------------------------------------------------
-- 4. Drawer event `film_ready`
-- ---------------------------------------------------------------------------

-- film_ready has no actor (the family's film is not something a person did),
-- and every other kind still needs one: the check ties the two together.
alter table public.family_activity_events
  alter column actor_id drop not null;

alter table public.family_activity_events
  drop constraint family_activity_events_kind_check;
alter table public.family_activity_events
  add constraint family_activity_events_kind_check check (kind in (
    'memory_added', 'memory_commented', 'memory_liked',
    'member_joined', 'member_pending', 'film_ready'));

alter table public.family_activity_events
  add constraint family_activity_events_film_actor_check
  check ((kind = 'film_ready') = (actor_id is null));

-- Ids only, like every other column of this table: the film's title and
-- cover are joined at read time.
alter table public.family_activity_events
  add column film_id uuid references public.year_films on delete cascade;

create index idx_family_activity_events_film
  on public.family_activity_events (film_id) where film_id is not null;

-- v1 RPCs (old app builds, 1.4.x runtimes that have not taken the update):
-- exclude film_ready explicitly so an old client never lists a kind it cannot
-- render or shows an unread dot it cannot clear. Bodies are otherwise
-- identical to 20260927180000_family_activity_illustration_generation.sql
-- (get_family_activity) and 20260822100000_family_activity.sql
-- (get_family_activity_unread); signatures and return types must not change.
create or replace function public.get_family_activity(target_family_id uuid)
returns table (
  id uuid,
  kind text,
  created_at timestamptz,
  actor_id uuid,
  actor_name text,
  actor_is_former boolean,
  memory_id uuid,
  memory_creation_source text,
  memory_excerpt text,
  memory_illustration_key text,
  memory_media_key text,
  memory_media_content_type text,
  memory_media_preview_key text,
  memory_type text,
  memory_emotion text,
  memory_illustration_generation_id uuid,
  comment_id uuid,
  comment_snippet text,
  invite_id uuid
)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if public.is_anonymous_user() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  if not public.is_family_member(target_family_id) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return query
  select
    e.id,
    e.kind,
    e.created_at,
    e.actor_id,
    up.name as actor_name,
    not exists (
      select 1 from public.family_memberships fm
      where fm.family_id = target_family_id and fm.user_id = e.actor_id
    ) as actor_is_former,
    e.memory_id,
    m.creation_source as memory_creation_source,
    left(coalesce(nullif(btrim(m.content), ''), nullif(btrim(m.audio_transcript), '')), 80) as memory_excerpt,
    m.illustration_key as memory_illustration_key,
    m.media_key as memory_media_key,
    m.media_content_type as memory_media_content_type,
    (
      select mm.preview_object_key
      from public.memory_media mm
      where mm.memory_id = m.id and mm.position = 0
    ) as memory_media_preview_key,
    m.memory_type,
    m.emotion as memory_emotion,
    m.illustration_generation_id as memory_illustration_generation_id,
    e.comment_id,
    left(c.content, 120) as comment_snippet,
    e.invite_id
  from public.family_activity_events e
  left join public.user_profiles up on up.id = e.actor_id
  left join public.memories m on m.id = e.memory_id
  left join public.memory_comments c on c.id = e.comment_id
  where e.family_id = target_family_id
    and e.kind <> 'film_ready'
    and e.actor_id <> auth.uid()
    and (
      e.kind <> 'member_pending'
      or public.has_family_role(target_family_id, array['owner', 'manager'])
    )
    -- Recipients who blocked the actor never see that actor's events --
    -- same rule push delivery already applies, see docs/features/
    -- content-reporting.md ("Activity pushes exclude recipients who
    -- blocked the actor").
    and not exists (
      select 1 from public.blocked_family_accounts b
      where b.family_id = target_family_id
        and b.blocker_user_id = auth.uid()
        and b.blocked_user_id = e.actor_id
    )
  order by e.created_at desc, e.id desc
  limit 100;
end;
$$;

revoke all on function public.get_family_activity(uuid) from public, anon, authenticated;
grant execute on function public.get_family_activity(uuid) to authenticated;

create or replace function public.get_family_activity_unread(target_family_id uuid)
returns boolean
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  seen_at timestamptz;
begin
  if public.is_anonymous_user() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  if not public.is_family_member(target_family_id) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  select fm.activity_seen_at into seen_at
  from public.family_memberships fm
  where fm.family_id = target_family_id and fm.user_id = auth.uid();

  return exists (
    select 1
    from public.family_activity_events e
    where e.family_id = target_family_id
      and e.kind <> 'film_ready'
      and e.actor_id <> auth.uid()
      and e.created_at > coalesce(seen_at, '-infinity'::timestamptz)
      and (
        e.kind <> 'member_pending'
        or public.has_family_role(target_family_id, array['owner', 'manager'])
      )
      -- Same block exclusion as get_family_activity above -- a blocked
      -- actor's events must not even flip the unread dot.
      and not exists (
        select 1 from public.blocked_family_accounts b
        where b.family_id = target_family_id
          and b.blocker_user_id = auth.uid()
          and b.blocked_user_id = e.actor_id
      )
  );
end;
$$;

revoke all on function public.get_family_activity_unread(uuid) from public, anon, authenticated;
grant execute on function public.get_family_activity_unread(uuid) to authenticated;

-- v2: the same feed plus film_ready rows. Differences from v1:
--   * `e.actor_id is distinct from auth.uid()` (a NULL actor must not be
--     dropped by `<>`; film_ready is visible to every member);
--   * actor_is_former is false when there is no actor;
--   * the blocked-actor filter tolerates a NULL actor (no row matches);
--   * a film_ready row counts only while its film is still servable
--     (video present, not blocked, not forced, surfaced), so a blocked or
--     deleted film drops out of the drawer and the unread dot server-side;
--   * extra output columns film_id / film_kind / film_member_id /
--     film_age_year / film_scope_start -- ids and dates only, no content.
create or replace function public.get_family_activity_v2(target_family_id uuid)
returns table (
  id uuid,
  kind text,
  created_at timestamptz,
  actor_id uuid,
  actor_name text,
  actor_is_former boolean,
  memory_id uuid,
  memory_creation_source text,
  memory_excerpt text,
  memory_illustration_key text,
  memory_media_key text,
  memory_media_content_type text,
  memory_media_preview_key text,
  memory_type text,
  memory_emotion text,
  memory_illustration_generation_id uuid,
  comment_id uuid,
  comment_snippet text,
  invite_id uuid,
  film_id uuid,
  film_kind text,
  film_member_id uuid,
  film_age_year integer,
  film_scope_start date
)
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  if public.is_anonymous_user() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  if not public.is_family_member(target_family_id) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return query
  select
    e.id,
    e.kind,
    e.created_at,
    e.actor_id,
    up.name as actor_name,
    (
      e.actor_id is not null
      and not exists (
        select 1 from public.family_memberships fm
        where fm.family_id = target_family_id and fm.user_id = e.actor_id
      )
    ) as actor_is_former,
    e.memory_id,
    m.creation_source as memory_creation_source,
    left(coalesce(nullif(btrim(m.content), ''), nullif(btrim(m.audio_transcript), '')), 80) as memory_excerpt,
    m.illustration_key as memory_illustration_key,
    m.media_key as memory_media_key,
    m.media_content_type as memory_media_content_type,
    (
      select mm.preview_object_key
      from public.memory_media mm
      where mm.memory_id = m.id and mm.position = 0
    ) as memory_media_preview_key,
    m.memory_type,
    m.emotion as memory_emotion,
    m.illustration_generation_id as memory_illustration_generation_id,
    e.comment_id,
    left(c.content, 120) as comment_snippet,
    e.invite_id,
    yf.id as film_id,
    yf.kind as film_kind,
    yf.family_member_id as film_member_id,
    yf.age_year as film_age_year,
    yf.scope_start_date as film_scope_start
  from public.family_activity_events e
  left join public.user_profiles up on up.id = e.actor_id
  left join public.memories m on m.id = e.memory_id
  left join public.memory_comments c on c.id = e.comment_id
  left join public.year_films yf on yf.id = e.film_id
  where e.family_id = target_family_id
    and e.actor_id is distinct from auth.uid()
    and (
      e.kind <> 'member_pending'
      or public.has_family_role(target_family_id, array['owner', 'manager'])
    )
    and (
      e.kind <> 'film_ready'
      or (
        yf.id is not null
        and yf.video_key is not null
        and not yf.blocked
        and not yf.forced
        and yf.surface_at <= now()
      )
    )
    -- Recipients who blocked the actor never see that actor's events
    -- (see get_family_activity). A NULL actor (film_ready) matches nothing.
    and not exists (
      select 1 from public.blocked_family_accounts b
      where b.family_id = target_family_id
        and b.blocker_user_id = auth.uid()
        and b.blocked_user_id = e.actor_id
    )
  order by e.created_at desc, e.id desc
  limit 100;
end;
$$;

revoke all on function public.get_family_activity_v2(uuid) from public, anon, authenticated;
grant execute on function public.get_family_activity_v2(uuid) to authenticated;

create or replace function public.get_family_activity_unread_v2(target_family_id uuid)
returns boolean
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  seen_at timestamptz;
begin
  if public.is_anonymous_user() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  if not public.is_family_member(target_family_id) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  select fm.activity_seen_at into seen_at
  from public.family_memberships fm
  where fm.family_id = target_family_id and fm.user_id = auth.uid();

  return exists (
    select 1
    from public.family_activity_events e
    left join public.year_films yf on yf.id = e.film_id
    where e.family_id = target_family_id
      and e.actor_id is distinct from auth.uid()
      and e.created_at > coalesce(seen_at, '-infinity'::timestamptz)
      and (
        e.kind <> 'member_pending'
        or public.has_family_role(target_family_id, array['owner', 'manager'])
      )
      and (
        e.kind <> 'film_ready'
        or (
          yf.id is not null
          and yf.video_key is not null
          and not yf.blocked
          and not yf.forced
          and yf.surface_at <= now()
        )
      )
      -- Same block exclusion as get_family_activity_v2.
      and not exists (
        select 1 from public.blocked_family_accounts b
        where b.family_id = target_family_id
          and b.blocker_user_id = auth.uid()
          and b.blocked_user_id = e.actor_id
      )
  );
end;
$$;

revoke all on function public.get_family_activity_unread_v2(uuid) from public, anon, authenticated;
grant execute on function public.get_family_activity_unread_v2(uuid) to authenticated;

-- One film_ready event per notified film, in the same statement that marks
-- notified_at: the drawer entry exists exactly when the push goes out, never
-- earlier and never twice. Signature and return type are unchanged
-- (create or replace cannot change them). This is plpgsql `returns table`, so
-- the CTEs alias-qualify every column (output names like family_id / kind
-- would otherwise be ambiguous).
create or replace function public.year_film_notifications_due(p_now timestamptz default now())
returns table (film_id uuid, family_id uuid, kind text, family_member_id uuid, age_year integer, language text, scope_start_date date)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with notified as (
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
    returning y.id as n_film_id, y.family_id as n_family_id, y.kind as n_kind,
              y.family_member_id as n_member_id, y.age_year as n_age_year,
              y.language as n_language, y.scope_start_date as n_scope_start
  ),
  events as (
    -- Data-modifying CTEs always run to completion even if the main query
    -- does not read them.
    insert into public.family_activity_events as ev (family_id, kind, film_id)
    select n.n_family_id, 'film_ready', n.n_film_id
    from notified n
    returning ev.id
  )
  select n.n_film_id, n.n_family_id, n.n_kind, n.n_member_id, n.n_age_year, n.n_language, n.n_scope_start
  from notified n;
end;
$$;
revoke all on function public.year_film_notifications_due(timestamptz) from public, anon, authenticated;
grant execute on function public.year_film_notifications_due(timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Owner-local clock helper + year_films_enabled
-- ---------------------------------------------------------------------------

-- The family owner's timezone, with the same rule as year_film_due_families
-- (invalid or missing zones fall back to UTC). Internal: only other definer
-- functions call it.
create or replace function public.year_film_owner_tz(p_family_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when up.timezone is not null and exists (select 1 from pg_timezone_names n where n.name = up.timezone)
      then up.timezone
    else 'UTC'
  end
  from public.families f
  left join public.user_profiles up on up.id = f.owner_id
  where f.id = p_family_id;
$$;
revoke all on function public.year_film_owner_tz(uuid) from public, anon, authenticated;
grant execute on function public.year_film_owner_tz(uuid) to service_role;

-- Drives the Keepsakes "upcoming recap" card. True only when next month's
-- (i.e. this coming 1st's) recap would really be attempted, so the card never
-- promises a film that cannot come:
--   * the rollout includes the family;
--   * launch_date is set and <= the next 1st of the month (family-local);
--   * billing allows films for the owner's family;
--   * the family has an own child;
--   * the current family-local month already has >= 10 memories (the
--     monthly floor).
create or replace function public.year_films_enabled(p_family_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_launch date;
  v_owner uuid;
  v_today date;
  v_month_start date;
  v_next_first date;
begin
  if public.is_anonymous_user() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  if not public.is_family_member(p_family_id) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  if not public.year_film_family_enabled(p_family_id) then
    return false;
  end if;

  select s.launch_date into v_launch from public.year_film_settings s where s.id;
  if v_launch is null then
    return false;
  end if;

  select f.owner_id into v_owner
  from public.families f
  where f.id = p_family_id and f.deleted_at is null;
  if v_owner is null then
    return false;
  end if;

  v_today := (now() at time zone public.year_film_owner_tz(p_family_id))::date;
  v_month_start := date_trunc('month', v_today::timestamp)::date;
  v_next_first := (v_month_start + interval '1 month')::date;

  if v_launch > v_next_first then
    return false;
  end if;

  if not public.billing_write_allowed(p_family_id, v_owner) then
    return false;
  end if;

  return exists (
      select 1 from public.family_members m
      where m.family_id = p_family_id and m.date_of_birth is not null
        and public.year_film_is_own_child(m.relationship, m.date_of_birth, v_today)
    )
    and (
      select count(*) from public.memories mem
      where mem.family_id = p_family_id
        and mem.memory_date >= v_month_start
        and mem.memory_date < v_next_first
    ) >= 10;
end;
$$;
revoke all on function public.year_films_enabled(uuid) from public, anon, authenticated;
grant execute on function public.year_films_enabled(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Candidate rows + history backfill (service role / operator)
-- ---------------------------------------------------------------------------

-- Every film whose due date falls in [p_from, p_to] for one family, using the
-- same constants and rules as year_film_due (own-child rule at the film's own
-- date, age 1-12, monthly memories >= 10 and an own child, years with an own
-- child). Does NOT look at rollout, billing or launch_date: callers decide.
-- year_film_due keeps its own proven logic; pgTAP asserts the two agree.
create or replace function public.year_film_candidate_rows(p_family_id uuid, p_from date, p_to date)
returns table (
  kind text,
  family_member_id uuid,
  age_year integer,
  scope_start_date date,
  scope_end_exclusive date,
  due_date date,
  surface_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  with owner_tz as (
    select public.year_film_owner_tz(p_family_id) as tz
  )
  -- Birthday films: due birthday + 2 (= scope_end_exclusive), delivered 09:00.
  select 'birthday'::text as kind,
         m.id as family_member_id,
         a.age_year as age_year,
         (m.date_of_birth + make_interval(years => a.age_year - 1))::date as scope_start_date,
         b.due_date as scope_end_exclusive,
         b.due_date as due_date,
         (b.due_date + time '09:00') at time zone o.tz as surface_at
  from public.family_members m
  cross join generate_series(1, 12) as a(age_year)
  cross join owner_tz o
  cross join lateral (
    select ((m.date_of_birth + make_interval(years => a.age_year))::date + 2) as due_date
  ) b
  where m.family_id = p_family_id
    and m.date_of_birth is not null
    and b.due_date between p_from and p_to
    and public.year_film_is_own_child(m.relationship, m.date_of_birth, b.due_date - 2)

  union all

  -- Monthly recaps: due on the 1st, scope = previous month, delivered 19:00.
  select 'family_month'::text,
         null::uuid,
         null::integer,
         (x.due_date - interval '1 month')::date,
         x.due_date,
         x.due_date,
         (x.due_date + time '19:00') at time zone o.tz
  from generate_series(date_trunc('month', p_from::timestamp), p_to::timestamp, interval '1 month') as g(month_start)
  cross join owner_tz o
  cross join lateral (select g.month_start::date as due_date) x
  where x.due_date between p_from and p_to
    and exists (
      select 1 from public.family_members m
      where m.family_id = p_family_id and m.date_of_birth is not null
        and public.year_film_is_own_child(m.relationship, m.date_of_birth, x.due_date)
    )
    and (
      select count(*) from public.memories mem
      where mem.family_id = p_family_id
        and mem.memory_date >= (x.due_date - interval '1 month')::date
        and mem.memory_date < x.due_date
    ) >= 10

  union all

  -- Year-end family film: due Dec 28, scope Jan 1 - Dec 27, delivered Dec 30.
  select 'family_year'::text,
         null::uuid,
         null::integer,
         make_date(yr.y, 1, 1),
         make_date(yr.y, 12, 28),
         make_date(yr.y, 12, 28),
         (make_date(yr.y, 12, 30) + time '09:00') at time zone o.tz
  from generate_series(extract(year from p_from)::integer, extract(year from p_to)::integer) as yr(y)
  cross join owner_tz o
  where make_date(yr.y, 12, 28) between p_from and p_to
    and exists (
      select 1 from public.family_members m
      where m.family_id = p_family_id and m.date_of_birth is not null
        and public.year_film_is_own_child(m.relationship, m.date_of_birth, make_date(yr.y, 12, 28))
    );
$$;
revoke all on function public.year_film_candidate_rows(uuid, date, date) from public, anon, authenticated;
grant execute on function public.year_film_candidate_rows(uuid, date, date) to service_role;

-- Families the operator backfill loops over (--all-families).
create or replace function public.year_film_enabled_families()
returns table (family_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select f.id
  from public.families f
  where f.deleted_at is null
    and public.year_film_family_enabled(f.id)
  order by f.created_at, f.id;
$$;
revoke all on function public.year_film_enabled_families() from public, anon, authenticated;
grant execute on function public.year_film_enabled_families() to service_role;

-- Silent history backfill: queues every film whose due date is
--   >= the first day of the month of the family's first memory, and
--   <= least(p_through, family-local today)
-- (the scope must be complete), as ordinary non-forced rows with their
-- historic surface_at and notified_at = now() -- so no push and no drawer
-- event. `on conflict do nothing` makes it idempotent and lets it run next to
-- the scheduler. Thin periods are queued too; the eligibility floors are
-- re-checked at curate time, so they end `skipped` (invisible).
--
-- Requires year_film_family_enabled and billing_write_allowed (the same gates
-- as year_film_due_families) and ignores launch_date. p_dry_run inserts
-- nothing: `inserted` then means "would be inserted" (no row with that film
-- key exists yet). p_only_kind / p_only_scope_start narrow the run to one film
-- key for a smoke subset (operator flag --only <kind>:<scope_start>).
--
-- Note: notified_at is set even when surface_at is still in the future (a
-- film due today whose delivery time is later today), so that film arrives
-- silently too.
create or replace function public.queue_year_film_backfill(
  p_family_id uuid,
  p_through date,
  p_dry_run boolean default true,
  p_only_kind text default null,
  p_only_scope_start date default null
)
returns table (
  kind text,
  family_member_id uuid,
  age_year integer,
  scope_start_date date,
  due_date date,
  inserted boolean
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_owner uuid;
  v_today date;
  v_first date;
  v_to date;
  v_zero constant uuid := '00000000-0000-0000-0000-000000000000';
begin
  if p_through is null then
    raise exception 'p_through is required' using errcode = '22023';
  end if;

  select f.owner_id into v_owner
  from public.families f
  where f.id = p_family_id and f.deleted_at is null;
  if v_owner is null or not public.year_film_family_enabled(p_family_id) then
    raise exception 'Year films are not enabled for this family' using errcode = 'P0001';
  end if;
  if not public.billing_write_allowed(p_family_id, v_owner) then
    raise exception 'Billing does not allow year films for this family' using errcode = 'P0001';
  end if;

  v_today := (now() at time zone public.year_film_owner_tz(p_family_id))::date;
  v_to := least(p_through, v_today);

  select date_trunc('month', min(mem.memory_date)::timestamp)::date into v_first
  from public.memories mem
  where mem.family_id = p_family_id;
  if v_first is null then
    return;
  end if;

  return query
  with cand as (
    select c.*
    from public.year_film_candidate_rows(p_family_id, v_first, v_to) c
    where (p_only_kind is null or c.kind = p_only_kind)
      and (p_only_scope_start is null or c.scope_start_date = p_only_scope_start)
  ),
  ins as (
    insert into public.year_films as yf (
      family_id, kind, family_member_id, age_year,
      scope_start_date, scope_end_exclusive, surface_at, notified_at
    )
    select p_family_id, c.kind, c.family_member_id, c.age_year,
           c.scope_start_date, c.scope_end_exclusive, c.surface_at, now()
    from cand c
    where not p_dry_run
    on conflict do nothing
    returning yf.kind as i_kind, yf.family_member_id as i_member_id, yf.scope_start_date as i_scope_start
  )
  select c.kind, c.family_member_id, c.age_year, c.scope_start_date, c.due_date,
         case
           when p_dry_run then not exists (
             select 1 from public.year_films e
             where e.family_id = p_family_id
               and not e.forced
               and e.kind = c.kind
               and coalesce(e.family_member_id, v_zero) = coalesce(c.family_member_id, v_zero)
               and e.scope_start_date = c.scope_start_date
           )
           else exists (
             select 1 from ins i
             where i.i_kind = c.kind
               and coalesce(i.i_member_id, v_zero) = coalesce(c.family_member_id, v_zero)
               and i.i_scope_start = c.scope_start_date
           )
         end as inserted
  from cand c
  order by c.due_date, c.kind, c.family_member_id;
end;
$$;
revoke all on function public.queue_year_film_backfill(uuid, date, boolean, text, date) from public, anon, authenticated;
grant execute on function public.queue_year_film_backfill(uuid, date, boolean, text, date) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Poster thumbnails in the delete lists
-- ---------------------------------------------------------------------------

-- The render job writes poster_thumb.jpg next to poster.jpg in the attempt
-- directory (no DB column: the key is derived from poster_key). Wherever a
-- poster_key is handed back for deletion, the derived thumb goes with it.
-- Bodies below are otherwise identical to 20260929120000_year_films.sql.
create or replace function public.year_film_poster_thumb_key(p_poster_key text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_poster_key is null then null
    else regexp_replace(p_poster_key, '[^/]+$', 'poster_thumb.jpg')
  end;
$$;
revoke all on function public.year_film_poster_thumb_key(text) from public, anon, authenticated;
grant execute on function public.year_film_poster_thumb_key(text) to service_role;

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
      v_delete := array_remove(array[
        p_film.video_key, p_film.poster_key,
        public.year_film_poster_thumb_key(p_film.poster_key),
        p_film.scenes_key
      ], null);
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

  v_old := array_remove(array[
    v_film.video_key, v_film.poster_key,
    public.year_film_poster_thumb_key(v_film.poster_key),
    v_film.scenes_key
  ], null);
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
