-- Looking Back: make archive package titles specific and warm.
--
-- Daily sets are normally immutable, but display copy is safe to backfill so
-- an already-materialized set does not keep the old generic title after this
-- migration. Future sets use the same templates in the materialization RPC.

update public.looking_back_packages
set display_title = 'A little look back'
where package_type = 'archive_mix';

update public.looking_back_packages
set display_title = 'From ' || display_era
where package_type = 'month_archive';

update public.looking_back_packages p
set display_title = 'From ' || fm.name || '''s first year'
from public.family_members fm
where p.package_type = 'member_at_age'
  and split_part(p.recipe_identity, ':', 3) = '0'
  and p.subject_family_member_id = fm.id
  and p.family_id = fm.family_id;

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
        null, 'From your archive', 'From ' || to_char(date_trunc('month', o.memory_date), 'FMMonth YYYY'), null,
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
      -- Identity intentionally remains stable across days. The deterministic
      -- day seed still varies the chosen ids; a stable identity makes the
      -- three-day soft variety penalty meaningful rather than dead code.
      select 7, 'archive_mix', 'archive_mix', null,
        'From your archive', 'A little look back', null, 'From your archive', null,
        array_agg(o.id order by md5(p_family_id::text || ':' || v_date::text || ':' || o.id::text))
      from ordered o

      union all
      select 3, 'member_at_age',
        'member_at_age:' || fm.id::text || ':' || extract(year from age(o.memory_date, fm.date_of_birth))::int::text,
        fm.id, 'Looking back',
        case
          when extract(year from age(o.memory_date, fm.date_of_birth))::int = 0
            then 'From ' || fm.name || '''s first year'
          else fm.name || ' at ' || extract(year from age(o.memory_date, fm.date_of_birth))::int::text
        end,
        null, 'From your archive', null,
        array_agg(o.id order by o.memory_date desc, o.created_at desc, o.id)
      from ordered o
      join public.memory_family_members mfm on mfm.memory_id = o.id
      join public.family_members fm on fm.id = mfm.family_member_id and fm.family_id = p_family_id
      where fm.date_of_birth is not null
        and extract(year from age(o.memory_date, fm.date_of_birth)) between 0 and 17
      group by fm.id, fm.name, extract(year from age(o.memory_date, fm.date_of_birth))
    ),
    candidate_penalties as (
      select c.*,
        exists (
          select 1
          from public.looking_back_packages previous
          where previous.family_id = p_family_id
            and previous.recipe_identity = c.recipe_identity
            and previous.created_at >= transaction_timestamp() - interval '3 days'
            and previous.created_at < transaction_timestamp()
        ) as has_recent_recipe,
        (
          c.package_type = 'member_at_age'
          and exists (
            select 1
            from public.looking_back_packages previous
            where previous.family_id = p_family_id
              and previous.package_type = 'member_at_age'
              and previous.subject_family_member_id = c.subject_id
              and previous.created_at >= transaction_timestamp() - interval '3 days'
              and previous.created_at < transaction_timestamp()
          )
        ) as has_recent_subject
      from candidate_rows c
      where cardinality(c.memory_ids) >= 4
    ),
    ranked_candidates as (
      select p.*,
        row_number() over (
          partition by p.package_type
          order by
            p.has_recent_subject asc,
            p.has_recent_recipe asc,
            md5(p_family_id::text || ':' || v_date::text || ':' || p.recipe_identity)
        ) as package_type_rank
      from candidate_penalties p
    )
    select *
    from ranked_candidates
    where package_type_rank = 1
    order by
      priority asc,
      has_recent_subject asc,
      has_recent_recipe asc,
      md5(p_family_id::text || ':' || v_date::text || ':' || recipe_identity)
  loop
    exit when v_position >= 4;
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

comment on function public.get_or_create_looking_back_packages(uuid) is
  'Returns or atomically materializes an immutable daily Looking Back set with at most one package per recipe type and a soft three-day age-subject rotation.';
