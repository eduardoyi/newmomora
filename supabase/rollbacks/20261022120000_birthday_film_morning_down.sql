-- ROLLBACK for 20261022120000_birthday_film_morning.sql.
--
-- Applied BY HAND (psql / the Supabase SQL editor), NEVER by `supabase db push`
-- or `supabase db reset` (it lives outside supabase/rollbacks on purpose).
-- Run it in one transaction; written to be re-runnable (CREATE OR REPLACE).
--
-- Restores ONLY the three function bodies to their previous definitions:
--   year_film_due, year_film_candidate_rows  (20260930120000_year_films_p2.sql:
--       birthday films due birthday + 2, delivered 09:00)
--   keepsake_upcoming_films                  (20261012120000: birthday film
--       date = birthday + 2, tile dropped once a live row has surfaced, with
--       no readiness condition)
-- Same signatures, so CREATE OR REPLACE swaps the bodies in place; grants are
-- re-asserted below.
--
-- It deliberately leaves year_films.placement_date ALONE. The new expression
-- returns the old value for every old-shape row (scope spans >= 367 days ->
-- scope_end_exclusive - 2) and the right value for new-shape rows (placed on
-- the birthday); reverting it would only misplace any film made under the new
-- rule (at birthday - 2) and rewrite the table a second time. Rows already
-- made under the new rule (scope_end_exclusive = the birthday) keep their
-- scope and surface_at; after the rollback the scheduler no longer creates
-- more of them. Roll the Worker / renderer back separately if needed.

begin;

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

create or replace function public.keepsake_upcoming_films(
  p_family_id uuid,
  p_caller uuid,
  p_today date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_launch date;
  v_year integer := extract(year from p_today)::integer;
  v_out jsonb := '[]'::jsonb;
  v_rec record;
  v_moments integer;
  v_visuals integer;
  v_quarters integer;
  v_picture text;
begin
  select s.launch_date into v_launch from public.year_film_settings s where s.id;
  select f.owner_id into v_owner
  from public.families f
  where f.id = p_family_id and f.deleted_at is null;

  if v_launch is null
    or v_owner is null
    or not public.year_film_family_enabled(p_family_id)
    or not public.billing_write_allowed(p_family_id, v_owner)
  then
    return '[]'::jsonb;
  end if;

  for v_rec in
    select c.*
    from (
      -- Birthday films: every (own child, age 1..12) whose film date falls in
      -- the next 30 days and has no SURFACED live film row yet (a row that
      -- exists but has not surfaced keeps the tile: reveal gap).
      select 'birthday'::text as kind,
             b.member_id,
             b.age_year,
             (b.birthday + 2) as film_date,
             b.scope_start,
             (b.birthday + 2) as scope_end_excl,
             b.member_created
      from (
        select m.id as member_id, m.created_at as member_created, m.relationship, m.date_of_birth,
               y.age_year,
               (m.date_of_birth + make_interval(years => y.age_year))::date as birthday,
               (m.date_of_birth + make_interval(years => y.age_year - 1))::date as scope_start
        from public.family_members m
        cross join generate_series(1, 12) as y(age_year)
        where m.family_id = p_family_id and m.date_of_birth is not null
      ) b
      where (b.birthday + 2) between p_today and p_today + 30
        and public.year_film_is_own_child(b.relationship, b.date_of_birth, b.birthday)
        and (b.birthday + 2) >= v_launch
        and not exists (
          select 1 from public.year_films f
          where f.family_id = p_family_id
            and f.kind = 'birthday'
            and f.family_member_id = b.member_id
            and f.scope_start_date = b.scope_start
            and not f.forced
            and f.status not in ('skipped', 'failed')
            and f.surface_at <= now()
        )
      union all
      -- The year-end film: December 1..30, scope Jan 1 -> Dec 28, film date
      -- (surface) Dec 30.
      select 'family_year'::text,
             null::uuid,
             null::integer,
             make_date(v_year, 12, 30),
             make_date(v_year, 1, 1),
             make_date(v_year, 12, 28),
             null::timestamptz
      where p_today between make_date(v_year, 12, 1) and make_date(v_year, 12, 30)
        and make_date(v_year, 12, 28) >= v_launch
        and exists (
          select 1 from public.family_members m
          where m.family_id = p_family_id and m.date_of_birth is not null
            and public.year_film_is_own_child(m.relationship, m.date_of_birth, make_date(v_year, 12, 28))
            and date_part('year', age(make_date(v_year, 12, 28), m.date_of_birth)) < 13
        )
        and not exists (
          select 1 from public.year_films f
          where f.family_id = p_family_id
            and f.kind = 'family_year'
            and f.family_member_id is null
            and f.scope_start_date = make_date(v_year, 1, 1)
            and not f.forced
            and f.status not in ('skipped', 'failed')
            and f.surface_at <= now()
        )
    ) c
    order by c.film_date, c.kind, c.member_created, c.member_id
  loop
    -- One pass over the pool: moments, visuals and the quarters the montage
    -- covers (visual, emotion not worry / sad).
    select count(*)::integer,
           (count(*) filter (where p.is_visual))::integer,
           (count(distinct least(3, greatest(0,
             ((extract(year from p.memory_date)::integer - extract(year from v_rec.scope_start)::integer) * 12
               + extract(month from p.memory_date)::integer - extract(month from v_rec.scope_start)::integer) / 3
           ))) filter (where p.is_visual and not coalesce(e.emotion in ('worry', 'sad'), false)))::integer
    into v_moments, v_visuals, v_quarters
    from public.keepsake_pool(p_family_id, v_rec.scope_start, v_rec.scope_end_excl, null, v_rec.member_id) p
    join public.memories e on e.id = p.memory_id;

    -- Newest pooled picture in the scope, not authored by anyone the CALLER
    -- hid (the same rule as recap.picture_key).
    select p.picture_key into v_picture
    from public.keepsake_pool(
      p_family_id, v_rec.scope_start, v_rec.scope_end_excl, p_caller, v_rec.member_id, true, 1
    ) p;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'kind', v_rec.kind,
      'member_id', v_rec.member_id,
      'age_year', v_rec.age_year,
      'film_date', v_rec.film_date,
      'scope_start', v_rec.scope_start,
      'scope_end_excl', v_rec.scope_end_excl,
      'moments', v_moments,
      'visuals', v_visuals,
      -- BIRTHDAY_MIN_POOL / FAMILY_MIN_POOL = 60, BIRTHDAY_MIN_VISUALS /
      -- FAMILY_MIN_VISUALS = 40, YEAR_MIN_QUARTERS = 3 (year-film-eligibility.ts).
      'min_moments', 60,
      'min_visuals', 40,
      'quarters', v_quarters,
      'min_quarters', 3,
      'picture_key', v_picture
    ));
  end loop;

  return v_out;
end;
$$;
revoke all on function public.keepsake_upcoming_films(uuid, uuid, date) from public, anon, authenticated;

comment on function public.keepsake_upcoming_films(uuid, uuid, date) is
  'INTERNAL (no client grant): the birthday / year-end Year Films due in the next 30 days / December (a tile stays until its film row has SURFACED), with pool progress against the worker''s floors (60 moments, 40 visuals, 3 quarters). Mirrors year_film_due scheduling and evaluateBirthdayFilm / evaluateFamilyFilm -- change them together.';

commit;
