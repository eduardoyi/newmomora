-- Looking Back: durable, deterministic daily archive packages.
--
-- This is intentionally database-materialized rather than an Edge Function:
-- package selection is small, private, deterministic and needs an atomic
-- family/day cooldown boundary.  No memory content or object key is returned
-- by either client-callable RPC below.

create or replace function public.looking_back_timezone_is_valid(p_timezone text)
returns boolean
language sql
stable
set search_path = pg_catalog
as $$
  select exists (select 1 from pg_timezone_names where name = p_timezone);
$$;

create table public.looking_back_daily_sets (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  package_date date not null,
  timezone_name text not null,
  refresh_after timestamptz not null,
  created_at timestamptz not null default now(),
  constraint looking_back_daily_sets_timezone_valid check (public.looking_back_timezone_is_valid(timezone_name)),
  constraint looking_back_daily_sets_refresh_after check (refresh_after > created_at),
  -- A timezone move backwards can legitimately revisit a displayed local date
  -- after its old immutable interval has expired. Keep both historical rows;
  -- active-interval lookup selects only the current one.
  constraint looking_back_daily_sets_family_date_refresh_key unique (family_id, package_date, refresh_after),
  constraint looking_back_daily_sets_id_family_date_key unique (id, family_id, package_date)
);

create index looking_back_daily_sets_family_date_idx
  on public.looking_back_daily_sets (family_id, package_date desc);

create table public.looking_back_packages (
  id uuid primary key default gen_random_uuid(),
  daily_set_id uuid not null,
  family_id uuid not null references public.families(id) on delete cascade,
  package_date date not null,
  package_type text not null check (package_type in (
    'on_this_day', 'one_year_ago', 'around_this_time', 'member_at_age',
    'month_archive', 'written_archive', 'archive_mix'
  )),
  subject_family_member_id uuid,
  display_kind text not null,
  display_title text not null,
  display_subtitle text,
  display_era text not null,
  tint text check (tint is null or tint in (
    'joy', 'funny', 'calm', 'wonder', 'tender', 'mischief', 'pride',
    'bittersweet', 'worry', 'weary', 'sad'
  )),
  recipe_identity text not null,
  signature text not null check (signature ~ '^[0-9a-f]{64}$'),
  position smallint not null check (position between 0 and 3),
  created_at timestamptz not null default now(),
  constraint looking_back_packages_daily_set_family_date_fkey
    foreign key (daily_set_id, family_id, package_date)
    references public.looking_back_daily_sets (id, family_id, package_date)
    on delete cascade,
  constraint looking_back_packages_subject_family_fkey
    foreign key (subject_family_member_id, family_id)
    references public.family_members (id, family_id)
    -- A deleted child/profile must not be held hostage by up to 45 days of
    -- archive metadata. Removing it also removes its derived package, items,
    -- and personal view rows through the package's existing cascades.
    on delete cascade,
  constraint looking_back_packages_member_subject_shape check (
    (package_type = 'member_at_age') = (subject_family_member_id is not null)
  ),
  constraint looking_back_packages_daily_set_position_key unique (daily_set_id, position),
  -- A backwards timezone change can create a second immutable interval for
  -- the same displayed local date. Signatures are deliberately unique only
  -- inside an interval; the 14-day selection query below is the cross-date
  -- and cross-interval cooldown boundary.
  constraint looking_back_packages_daily_set_signature_key unique (daily_set_id, signature),
  constraint looking_back_packages_id_family_key unique (id, family_id)
);

create index looking_back_packages_family_recipe_date_idx
  on public.looking_back_packages (family_id, recipe_identity, package_date desc);
create index looking_back_packages_family_signature_date_idx
  on public.looking_back_packages (family_id, signature, package_date desc);

-- `memories` predates composite tenancy keys.  This unique key lets the item
-- table enforce that a package cannot ever bind a memory from another family.
alter table public.memories
  add constraint memories_id_family_id_key unique (id, family_id);

create table public.looking_back_package_memories (
  package_id uuid not null,
  family_id uuid not null,
  memory_id uuid not null,
  position smallint not null check (position between 0 and 9),
  created_at timestamptz not null default now(),
  primary key (package_id, memory_id),
  constraint looking_back_package_memories_package_family_fkey
    foreign key (package_id, family_id)
    references public.looking_back_packages (id, family_id)
    on delete cascade,
  constraint looking_back_package_memories_memory_family_fkey
    foreign key (memory_id, family_id)
    references public.memories (id, family_id)
    on delete cascade,
  constraint looking_back_package_memories_package_position_key unique (package_id, position)
);

create index looking_back_package_memories_family_memory_created_idx
  on public.looking_back_package_memories (family_id, memory_id, created_at desc);

create table public.looking_back_package_views (
  package_id uuid not null references public.looking_back_packages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  first_viewed_at timestamptz not null default now(),
  last_viewed_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (package_id, user_id),
  constraint looking_back_package_views_timestamp_order check (
    last_viewed_at >= first_viewed_at
    and (completed_at is null or completed_at >= first_viewed_at)
  )
);

alter table public.looking_back_daily_sets enable row level security;
alter table public.looking_back_packages enable row level security;
alter table public.looking_back_package_memories enable row level security;
alter table public.looking_back_package_views enable row level security;

create policy "Looking Back daily sets: select" on public.looking_back_daily_sets
  for select using (public.is_family_member(family_id));
create policy "Looking Back packages: select" on public.looking_back_packages
  for select using (public.is_family_member(family_id));
create policy "Looking Back package memories: select" on public.looking_back_package_memories
  for select using (public.is_family_member(family_id));
create policy "Looking Back package views: select own" on public.looking_back_package_views
  for select using (
    user_id = auth.uid()
    and exists (
      select 1 from public.looking_back_packages p
      where p.id = package_id and public.is_family_member(p.family_id)
    )
  );

revoke all on table
  public.looking_back_daily_sets,
  public.looking_back_packages,
  public.looking_back_package_memories,
  public.looking_back_package_views
from anon;
revoke all on table
  public.looking_back_daily_sets,
  public.looking_back_packages,
  public.looking_back_package_memories,
  public.looking_back_package_views
from authenticated;
grant select on table
  public.looking_back_daily_sets,
  public.looking_back_packages,
  public.looking_back_package_memories,
  public.looking_back_package_views
to authenticated;

-- Return an existing immutable set, including its empty-set sentinel.
create or replace function public.return_looking_back_daily_set(
  p_daily_set_id uuid,
  p_user_id uuid
)
returns table (
  daily_set_id uuid,
  package_id uuid,
  package_date date,
  package_type text,
  subject_family_member_id uuid,
  display_kind text,
  display_title text,
  display_subtitle text,
  display_era text,
  tint text,
  "position" smallint,
  memory_ids uuid[],
  first_viewed_at timestamptz,
  last_viewed_at timestamptz,
  completed_at timestamptz,
  refresh_after timestamptz
)
language sql
security definer
stable
set search_path = public
as $$
  select
    s.id, p.id, s.package_date, p.package_type, p.subject_family_member_id,
    p.display_kind, p.display_title, p.display_subtitle, p.display_era, p.tint,
    p.position,
    coalesce(array_agg(i.memory_id order by i.position) filter (where i.memory_id is not null), '{}'::uuid[]),
    v.first_viewed_at, v.last_viewed_at, v.completed_at, s.refresh_after
  from public.looking_back_daily_sets s
  left join public.looking_back_packages p on p.daily_set_id = s.id
  left join public.looking_back_package_memories i on i.package_id = p.id
  left join public.looking_back_package_views v on v.package_id = p.id and v.user_id = p_user_id
  where s.id = p_daily_set_id
  group by s.id, p.id, v.package_id, v.user_id
  order by p.position nulls first;
$$;

-- Materialize up to four deterministic package candidates.  All caller input
-- is an exact family id; the function resolves timezone, day and cooldowns
-- itself and serializes the family/day decision with an advisory xact lock.
create or replace function public.get_or_create_looking_back_packages(p_family_id uuid)
returns table (
  daily_set_id uuid,
  package_id uuid,
  package_date date,
  package_type text,
  subject_family_member_id uuid,
  display_kind text,
  display_title text,
  display_subtitle text,
  display_era text,
  tint text,
  "position" smallint,
  memory_ids uuid[],
  first_viewed_at timestamptz,
  last_viewed_at timestamptz,
  completed_at timestamptz,
  refresh_after timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_timezone text := 'UTC';
  v_date date;
  v_refresh_after timestamptz;
  v_set public.looking_back_daily_sets%rowtype;
  v_candidate record;
  v_selected_ids uuid[] := '{}'::uuid[];
  v_final_ids uuid[];
  v_signature text;
  v_position smallint := 0;
  v_package_id uuid;
begin
  if v_user_id is null or public.is_anonymous_user() then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_family_id is null or not public.is_family_member(p_family_id) then
    raise exception 'Not authorized for this family' using errcode = '42501';
  end if;

  -- A family key (rather than only the date) first serializes a timezone
  -- change with creation.  The date suffix fulfils the per-day lock boundary
  -- and makes this safe if family-level selection is ever parallelized.
  perform pg_advisory_xact_lock(hashtextextended('looking-back:' || p_family_id::text, 0));

  select s.* into v_set
  from public.looking_back_daily_sets s
  where s.family_id = p_family_id
    and s.created_at <= transaction_timestamp()
    and s.refresh_after > transaction_timestamp()
  order by s.created_at desc
  limit 1;
  if found then
    return query select * from public.return_looking_back_daily_set(v_set.id, v_user_id);
    return;
  end if;

  select coalesce(up.timezone, 'UTC') into v_timezone
  from public.families f
  left join public.user_profiles up on up.id = f.owner_id
  where f.id = p_family_id;
  if not exists (select 1 from pg_timezone_names where name = v_timezone) then
    v_timezone := 'UTC';
  end if;
  v_date := (transaction_timestamp() at time zone v_timezone)::date;
  v_refresh_after := ((v_date + 1)::timestamp at time zone v_timezone);
  perform pg_advisory_xact_lock(hashtextextended(
    'looking-back:' || p_family_id::text || ':' || v_date::text, 0
  ));

  select s.* into v_set
  from public.looking_back_daily_sets s
  where s.family_id = p_family_id
    and s.package_date = v_date
    and s.refresh_after > transaction_timestamp()
  limit 1;
  if found then
    return query select * from public.return_looking_back_daily_set(v_set.id, v_user_id);
    return;
  end if;

  -- Retention is deliberately opportunistic: no content, assets, or other
  -- families are touched, and FKs cascade all dependent package/view rows.
  delete from public.looking_back_daily_sets s
  where s.family_id = p_family_id
    and s.created_at < transaction_timestamp() - interval '45 days';

  insert into public.looking_back_daily_sets (
    family_id, package_date, timezone_name, refresh_after
  ) values (
    p_family_id, v_date, v_timezone, v_refresh_after
  ) returning * into v_set;

  for v_candidate in
    with recent_memory_ids as (
      select distinct i.memory_id
      from public.looking_back_packages p
      join public.looking_back_package_memories i on i.package_id = p.id
      where p.family_id = p_family_id
        and p.created_at >= transaction_timestamp() - interval '7 days'
        and p.created_at < transaction_timestamp()
    ),
    eligible as (
      select m.id, m.memory_date, m.created_at, m.memory_type, m.emotion
      from public.memories m
      where m.family_id = p_family_id
        and m.memory_date <= v_date - 90
        and (
          m.memory_type <> 'media'
          or exists (select 1 from public.memory_media mm where mm.memory_id = m.id)
        )
        and not exists (select 1 from recent_memory_ids r where r.memory_id = m.id)
    ),
    ordered as (
      select e.*, row_number() over (order by e.memory_date desc, e.created_at desc, e.id) as recency_position
      from eligible e
    ),
    candidate_rows as (
      select 1::int priority, 'on_this_day'::text package_type,
        ('on_this_day:' || o.memory_date::text) recipe_identity,
        null::uuid subject_id, 'On this day'::text display_kind,
        'On this day'::text display_title, null::text display_subtitle,
        to_char(o.memory_date, 'FMMonth YYYY')::text display_era, null::text tint,
        array_agg(o.id order by o.memory_date desc, o.created_at desc, o.id) memory_ids
      from ordered o
      where extract(month from o.memory_date) = extract(month from v_date)
        and extract(day from o.memory_date) = extract(day from v_date)
        and o.memory_date <= v_date - interval '1 year'
      group by o.memory_date

      union all
      select 2, 'one_year_ago', 'one_year_ago:' || (v_date - interval '1 year')::date::text,
        null, 'A year ago', 'A year ago', null,
        to_char((v_date - interval '1 year')::date, 'FMMonth YYYY'), null,
        array_agg(o.id order by o.memory_date desc, o.created_at desc, o.id)
      from ordered o
      where o.memory_date between ((v_date - interval '1 year')::date - 3) and ((v_date - interval '1 year')::date + 3)

      union all
      select 4, 'around_this_time', 'around_this_time:' || extract(month from v_date)::text || '-' || extract(day from v_date)::text,
        null, 'Around this time', 'Around this time', null,
        'From your archive', null,
        array_agg(o.id order by o.memory_date desc, o.created_at desc, o.id)
      from ordered o
      -- Compute the current month/day in every candidate's own year. This
      -- covers the entire archive in one pass (not just three years), handles
      -- Feb 29 by clamping non-leap years to Feb 28, and avoids a years × rows
      -- join on a large archive.
      cross join lateral (
        select make_date(
          extract(year from o.memory_date)::int,
          extract(month from v_date)::int,
          1
        ) + least(
          extract(day from v_date)::int - 1,
          extract(day from (
            make_date(extract(year from o.memory_date)::int, extract(month from v_date)::int, 1)
            + interval '1 month - 1 day'
          ))::int - 1
        ) as anniversary_date
      ) anniversary
      where o.memory_date <= v_date - interval '1 year'
        and o.memory_date between anniversary.anniversary_date - 7 and anniversary.anniversary_date + 7

      union all
      select 5, 'month_archive', 'month_archive:' || date_trunc('month', o.memory_date)::date::text,
        null, 'From your archive', 'From your archive', null,
        to_char(date_trunc('month', o.memory_date), 'FMMonth YYYY'), null,
        array_agg(o.id order by o.memory_date desc, o.created_at desc, o.id)
      from ordered o
      group by date_trunc('month', o.memory_date)

      union all
      select 6, 'written_archive', 'written_archive', null,
        'From your archive', 'Small things, written down', null, 'From your archive', null,
        array_agg(o.id order by o.memory_date desc, o.created_at desc, o.id)
      from ordered o where o.memory_type = 'text_only'

      union all
      -- Identity intentionally remains stable across days.  The deterministic
      -- day seed still varies the chosen ids; a stable identity makes the
      -- three-day soft variety penalty meaningful rather than dead code.
      select 7, 'archive_mix', 'archive_mix', null,
        'From your archive', 'From your archive', null, 'From your archive', null,
        array_agg(o.id order by md5(p_family_id::text || ':' || v_date::text || ':' || o.id::text))
      from ordered o

      union all
      select 3, 'member_at_age',
        'member_at_age:' || fm.id::text || ':' || extract(year from age(o.memory_date, fm.date_of_birth))::int::text,
        fm.id, 'Looking back', fm.name || ' at ' || extract(year from age(o.memory_date, fm.date_of_birth))::int::text,
        null, 'From your archive', null,
        array_agg(o.id order by o.memory_date desc, o.created_at desc, o.id)
      from ordered o
      join public.memory_family_members mfm on mfm.memory_id = o.id
      join public.family_members fm on fm.id = mfm.family_member_id and fm.family_id = p_family_id
      where fm.date_of_birth is not null
        and extract(year from age(o.memory_date, fm.date_of_birth)) between 0 and 17
      group by fm.id, fm.name, extract(year from age(o.memory_date, fm.date_of_birth))
    ),
    candidates as (
      select c.*, coalesce((
        select true from public.looking_back_packages previous
        where previous.family_id = p_family_id
          and previous.recipe_identity = c.recipe_identity
          and previous.created_at >= transaction_timestamp() - interval '3 days'
          and previous.created_at < transaction_timestamp()
        limit 1
      ), false) as has_recent_recipe
      from candidate_rows c
      where cardinality(c.memory_ids) >= 4
    )
    select * from candidates
    order by priority asc, has_recent_recipe asc, recipe_identity asc
  loop
    exit when v_position >= 4;
    -- De-overlap happens before the final signature.  It is intentionally
    -- repeated per chosen candidate so same-day selection cannot leak IDs.
    select coalesce(array_agg(id order by memory_date desc, created_at desc, id), '{}'::uuid[])
    into v_final_ids
    from (
      select m.id, m.memory_date, m.created_at
      from public.memories m
      where m.family_id = p_family_id
        and m.id = any(v_candidate.memory_ids)
        and not (m.id = any(v_selected_ids))
      order by m.memory_date desc, m.created_at desc, m.id
      limit 10
    ) normalized;
    if cardinality(v_final_ids) < 4 then
      continue;
    end if;
    select encode(extensions.digest(
      v_candidate.package_type || ':' || v_candidate.recipe_identity || ':' ||
      array_to_string((select array_agg(x order by x) from unnest(v_final_ids) x), ','),
      'sha256'
    ), 'hex') into v_signature;
    if exists (
      select 1 from public.looking_back_packages previous
      where previous.family_id = p_family_id
        and previous.signature = v_signature
        and previous.created_at >= transaction_timestamp() - interval '14 days'
        and previous.created_at < transaction_timestamp()
    ) then
      continue;
    end if;
    insert into public.looking_back_packages (
      daily_set_id, family_id, package_date, package_type, subject_family_member_id,
      display_kind, display_title, display_subtitle, display_era, tint,
      recipe_identity, signature, position
    ) values (
      v_set.id, p_family_id, v_date, v_candidate.package_type, v_candidate.subject_id,
      v_candidate.display_kind, v_candidate.display_title, v_candidate.display_subtitle,
      v_candidate.display_era, v_candidate.tint, v_candidate.recipe_identity,
      v_signature, v_position
    ) returning id into v_package_id;
    insert into public.looking_back_package_memories (package_id, family_id, memory_id, position)
    select v_package_id, p_family_id, memory_id, ordinal - 1
    from unnest(v_final_ids) with ordinality as item(memory_id, ordinal);
    v_selected_ids := v_selected_ids || v_final_ids;
    v_position := v_position + 1;
  end loop;

  return query select * from public.return_looking_back_daily_set(v_set.id, v_user_id);
end;
$$;

create or replace function public.mark_looking_back_package_viewed(
  p_package_id uuid,
  p_completed boolean default false
)
returns public.looking_back_package_views
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_result public.looking_back_package_views%rowtype;
begin
  if v_user_id is null or public.is_anonymous_user() then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.looking_back_packages p
    where p.id = p_package_id and public.is_family_member(p.family_id)
  ) then
    raise exception 'Package not found' using errcode = 'P0002';
  end if;

  insert into public.looking_back_package_views (
    package_id, user_id, first_viewed_at, last_viewed_at, completed_at
  ) values (
    p_package_id, v_user_id, transaction_timestamp(), transaction_timestamp(),
    case when p_completed then transaction_timestamp() else null end
  )
  on conflict (package_id, user_id) do update
  set last_viewed_at = greatest(
        public.looking_back_package_views.last_viewed_at,
        excluded.last_viewed_at
      ),
      completed_at = coalesce(
        public.looking_back_package_views.completed_at,
        excluded.completed_at
      )
  returning * into v_result;
  return v_result;
end;
$$;

revoke all on function public.looking_back_timezone_is_valid(text) from public;
revoke all on function public.return_looking_back_daily_set(uuid, uuid) from public;
revoke all on function public.get_or_create_looking_back_packages(uuid) from public;
revoke all on function public.mark_looking_back_package_viewed(uuid, boolean) from public;
grant execute on function public.get_or_create_looking_back_packages(uuid) to authenticated;
grant execute on function public.mark_looking_back_package_viewed(uuid, boolean) to authenticated;
