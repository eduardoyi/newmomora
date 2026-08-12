-- Looking Back: birthday, togetherness, and emotion archive recipes.
--
-- The recipe selector remains database-materialized and metadata-only. Birthday
-- and togetherness subjects are stored explicitly so the client can fail closed
-- when a reported family-member profile or portrait would otherwise leak a name
-- from a package title.

drop function if exists public.get_or_create_looking_back_packages(uuid);
drop function if exists public.return_looking_back_daily_set(uuid, uuid);

alter table public.looking_back_packages
  add column secondary_subject_family_member_id uuid;

alter table public.looking_back_packages
  add constraint looking_back_packages_secondary_subject_family_fkey
    foreign key (secondary_subject_family_member_id, family_id)
    references public.family_members (id, family_id)
    on delete cascade;

alter table public.looking_back_packages
  drop constraint if exists looking_back_packages_package_type_check,
  drop constraint if exists looking_back_packages_member_subject_shape;

alter table public.looking_back_packages
  add constraint looking_back_packages_package_type_check check (package_type in (
    'member_birthday', 'on_this_day', 'one_year_ago', 'member_at_age',
    'members_together', 'around_this_time', 'emotion_archive',
    'month_archive', 'written_archive', 'archive_mix'
  )),
  add constraint looking_back_packages_member_subject_shape check (
    (
      package_type in ('member_at_age', 'member_birthday')
      and subject_family_member_id is not null
      and secondary_subject_family_member_id is null
    )
    or (
      package_type = 'members_together'
      and subject_family_member_id is not null
      and secondary_subject_family_member_id is not null
      and subject_family_member_id < secondary_subject_family_member_id
    )
    or (
      package_type not in ('member_at_age', 'member_birthday', 'members_together')
      and subject_family_member_id is null
      and secondary_subject_family_member_id is null
    )
  );

create index looking_back_packages_family_secondary_subject_idx
  on public.looking_back_packages (family_id, secondary_subject_family_member_id, package_date desc)
  where secondary_subject_family_member_id is not null;

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
  secondary_subject_family_member_id uuid,
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
    p.secondary_subject_family_member_id,
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

create or replace function public.get_or_create_looking_back_packages(p_family_id uuid)
returns table (
  daily_set_id uuid,
  package_id uuid,
  package_date date,
  package_type text,
  subject_family_member_id uuid,
  secondary_subject_family_member_id uuid,
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
  v_archive_mix_available boolean := false;
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

  -- Reserve one slot for broad rediscovery whenever the archive has enough
  -- eligible memories. The reservation is released if de-overlap or cooldown
  -- makes the mixed candidate unusable.
  select count(*) >= 4
  into v_archive_mix_available
  from public.memories m
  where m.family_id = p_family_id
    and m.memory_date <= v_date - 90
    and (
      m.memory_type <> 'media'
      or exists (select 1 from public.memory_media mm where mm.memory_id = m.id)
    )
    and not exists (
      select 1
      from public.looking_back_packages p
      join public.looking_back_package_memories i on i.package_id = p.id
      where p.family_id = p_family_id
        and p.created_at >= transaction_timestamp() - interval '7 days'
        and p.created_at < transaction_timestamp()
        and i.memory_id = m.id
    );

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
    birthday_matches as (
      select
        fm.id as subject_id,
        fm.name,
        o.id as memory_id,
        o.memory_date,
        o.created_at,
        historical_birthday.birthday_year as memory_year,
        md5(p_family_id::text || ':' || v_date::text || ':member_birthday:' || fm.id::text || ':' || o.id::text) as selection_order
      from ordered o
      join public.memory_family_members mfm on mfm.memory_id = o.id
      join public.family_members fm
        on fm.id = mfm.family_member_id
       and fm.family_id = p_family_id
      cross join lateral (
        select birthday_date
        from (
          select make_date(
            extract(year from v_date)::int + offsets.year_offset,
            extract(month from fm.date_of_birth)::int,
            1
          ) + least(
            extract(day from fm.date_of_birth)::int - 1,
            extract(day from (
              make_date(
                extract(year from v_date)::int + offsets.year_offset,
                extract(month from fm.date_of_birth)::int,
                1
              ) + interval '1 month - 1 day'
            ))::int - 1
          )::int as birthday_date
          from (values (-1), (0), (1)) as offsets(year_offset)
        ) birthday_years
        where abs(v_date - birthday_date) <= 3
        limit 1
      ) active_birthday
      cross join lateral (
        select birthday_year, birthday_date
        from (
          select years.birthday_year,
            make_date(
              years.birthday_year,
              extract(month from fm.date_of_birth)::int,
              1
            ) + least(
              extract(day from fm.date_of_birth)::int - 1,
              extract(day from (
                make_date(
                  years.birthday_year,
                  extract(month from fm.date_of_birth)::int,
                  1
                ) + interval '1 month - 1 day'
              ))::int - 1
            )::int as birthday_date
          from generate_series(
            extract(year from o.memory_date)::int - 1,
            extract(year from o.memory_date)::int + 1
          ) as years(birthday_year)
        ) birthday_years
        where o.memory_date between birthday_date - 7 and birthday_date + 7
        order by abs(o.memory_date - birthday_date), birthday_year
        limit 1
      ) historical_birthday
      where fm.date_of_birth is not null
    ),
    birthday_ranked as (
      select b.*,
        row_number() over (
          partition by b.subject_id, b.memory_year
          order by b.selection_order, b.memory_date desc, b.memory_id
        ) as year_position
      from birthday_matches b
    ),
    birthday_candidates as (
      select
        subject_id,
        name,
        array_agg(memory_id order by
          case when year_position = 1 then 0 else 1 end,
          selection_order,
          memory_date desc,
          memory_id
        ) as memory_ids
      from birthday_ranked
      group by subject_id, name
      having count(*) >= 4
         and count(distinct memory_year) >= 2
    ),
    pair_candidates as (
      select
        tag_a.family_member_id as subject_id,
        tag_b.family_member_id as secondary_subject_id,
        pair_a.name || ' & ' || pair_b.name as pair_title,
        array_agg(o.id order by
          md5(p_family_id::text || ':' || v_date::text || ':members_together:' || tag_a.family_member_id::text || ':' || tag_b.family_member_id::text || ':' || o.id::text),
          o.memory_date desc,
          o.created_at desc,
          o.id
        ) as memory_ids
      from ordered o
      join public.memory_family_members tag_a on tag_a.memory_id = o.id
      join public.memory_family_members tag_b
        on tag_b.memory_id = o.id
       and tag_a.family_member_id < tag_b.family_member_id
      join public.family_members pair_a
        on pair_a.id = tag_a.family_member_id
       and pair_a.family_id = p_family_id
      join public.family_members pair_b
        on pair_b.id = tag_b.family_member_id
       and pair_b.family_id = p_family_id
      group by tag_a.family_member_id, tag_b.family_member_id, pair_a.name, pair_b.name
    ),
    emotion_candidates as (
      select
        o.emotion,
        array_agg(o.id order by
          md5(p_family_id::text || ':' || v_date::text || ':emotion_archive:' || o.emotion || ':' || o.id::text),
          o.memory_date desc,
          o.created_at desc,
          o.id
        ) as memory_ids
      from ordered o
      where o.emotion in ('funny', 'mischief')
      group by o.emotion
    ),
    candidate_rows as (
      select 1::int priority, 'member_birthday'::text package_type,
        'member_birthday:' || b.subject_id::text recipe_identity,
        b.subject_id, null::uuid secondary_subject_id,
        'Birthday memories'::text display_kind,
        b.name || '’s birthday, through the years'::text display_title,
        null::text display_subtitle, 'Through the years'::text display_era,
        null::text tint, b.memory_ids
      from birthday_candidates b

      union all
      select 2, 'on_this_day',
        'on_this_day:' || o.memory_date::text,
        null::uuid, null::uuid, 'On this day', 'On this day', null,
        to_char(o.memory_date, 'FMMonth YYYY')::text, null,
        array_agg(o.id order by o.memory_date desc, o.created_at desc, o.id)
      from ordered o
      where extract(month from o.memory_date) = extract(month from v_date)
        and extract(day from o.memory_date) = extract(day from v_date)
        and o.memory_date <= v_date - interval '1 year'
      group by o.memory_date

      union all
      select 3, 'one_year_ago',
        'one_year_ago:' || (v_date - interval '1 year')::date::text,
        null::uuid, null::uuid, 'A year ago', 'A year ago', null,
        to_char((v_date - interval '1 year')::date, 'FMMonth YYYY'), null,
        array_agg(o.id order by o.memory_date desc, o.created_at desc, o.id)
      from ordered o
      where o.memory_date between ((v_date - interval '1 year')::date - 3) and ((v_date - interval '1 year')::date + 3)

      union all
      select 4, 'member_at_age',
        'member_at_age:' || fm.id::text || ':' || extract(year from age(o.memory_date, fm.date_of_birth))::int::text,
        fm.id, null::uuid, 'Looking back',
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

      union all
      select 5, 'members_together',
        'members_together:' || p.subject_id::text || ':' || p.secondary_subject_id::text,
        p.subject_id, p.secondary_subject_id, 'Shared memories',
        'Moments with ' || p.pair_title, null, 'From your archive', null,
        p.memory_ids
      from pair_candidates p

      union all
      select 6, 'around_this_time',
        'around_this_time:' || extract(month from v_date)::text || '-' || extract(day from v_date)::text,
        null::uuid, null::uuid, 'Around this time', 'Around this time', null,
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
        )::int as anniversary_date
      ) anniversary
      where o.memory_date <= v_date - interval '1 year'
        and o.memory_date between anniversary.anniversary_date - 7 and anniversary.anniversary_date + 7

      union all
      select 7, 'emotion_archive',
        'emotion_archive:' || e.emotion,
        null::uuid, null::uuid, 'From your archive',
        case e.emotion when 'funny' then 'The funny ones' else 'Tiny troublemakers' end,
        null, 'From your archive', e.emotion,
        e.memory_ids
      from emotion_candidates e

      union all
      select 8, 'archive_mix', 'archive_mix',
        null::uuid, null::uuid, 'From your archive', 'A little look back', null,
        'From your archive', null,
        array_agg(o.id order by md5(p_family_id::text || ':' || v_date::text || ':archive_mix:' || o.id::text))
      from ordered o

      union all
      select 9, 'month_archive',
        'month_archive:' || date_trunc('month', o.memory_date)::date::text,
        null::uuid, null::uuid, 'From your archive',
        'From ' || to_char(date_trunc('month', o.memory_date), 'FMMonth YYYY'), null,
        to_char(date_trunc('month', o.memory_date), 'FMMonth YYYY'), null,
        array_agg(o.id order by o.memory_date desc, o.created_at desc, o.id)
      from ordered o
      group by date_trunc('month', o.memory_date)

      union all
      select 10, 'written_archive', 'written_archive',
        null::uuid, null::uuid, 'From your archive', 'Small things, written down', null,
        'From your archive', null,
        array_agg(o.id order by o.memory_date desc, o.created_at desc, o.id)
      from ordered o
      where o.memory_type = 'text_only'
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
          (
            c.package_type in ('member_at_age', 'member_birthday')
            and exists (
              select 1
              from public.looking_back_packages previous
              where previous.family_id = p_family_id
                and previous.package_type in ('member_at_age', 'member_birthday')
                and previous.subject_family_member_id = c.subject_id
                and previous.created_at >= transaction_timestamp() - interval '3 days'
                and previous.created_at < transaction_timestamp()
            )
          )
          or (
            c.package_type = 'members_together'
            and exists (
              select 1
              from public.looking_back_packages previous
              where previous.family_id = p_family_id
                and previous.package_type = 'members_together'
                and previous.subject_family_member_id = c.subject_id
                and previous.secondary_subject_family_member_id = c.secondary_subject_id
                and previous.created_at >= transaction_timestamp() - interval '3 days'
                and previous.created_at < transaction_timestamp()
            )
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

    if v_archive_mix_available
       and v_candidate.package_type <> 'archive_mix'
       and v_position >= 3 then
      continue;
    end if;

    if v_candidate.package_type = 'archive_mix' then
      select coalesce(array_agg(normalized.id order by normalized.quota_rank, normalized.candidate_position), '{}'::uuid[])
      into v_final_ids
      from (
        select ranked.id, ranked.candidate_position,
          case
            when ranked.archive_age_band = 'newer' and ranked.band_position <= 4 then 0
            when ranked.archive_age_band = 'medium' and ranked.band_position <= 3 then 0
            when ranked.archive_age_band = 'deep' and ranked.band_position <= 3 then 0
            else 1
          end as quota_rank
        from (
          select available.*,
            row_number() over (
              partition by available.archive_age_band
              order by available.candidate_position
            ) as band_position
          from (
            select m.id, m.memory_date, m.created_at, candidate.candidate_position,
              case
                when m.memory_date > (v_date - interval '18 months')::date then 'newer'
                when m.memory_date > (v_date - interval '36 months')::date then 'medium'
                else 'deep'
              end as archive_age_band
            from unnest(v_candidate.memory_ids) with ordinality as candidate(memory_id, candidate_position)
            join public.memories m on m.id = candidate.memory_id and m.family_id = p_family_id
            where not (m.id = any(v_selected_ids))
          ) available
        ) ranked
        order by quota_rank, candidate_position
        limit 10
      ) normalized;
    else
      select coalesce(array_agg(normalized.id order by normalized.candidate_position), '{}'::uuid[])
      into v_final_ids
      from (
        select m.id, m.memory_date, m.created_at, candidate.candidate_position
        from unnest(v_candidate.memory_ids) with ordinality as candidate(memory_id, candidate_position)
        join public.memories m on m.id = candidate.memory_id and m.family_id = p_family_id
        where not (m.id = any(v_selected_ids))
        order by candidate.candidate_position
        limit 10
      ) normalized;
    end if;

    if cardinality(v_final_ids) < 4 then
      if v_candidate.package_type = 'archive_mix' then
        v_archive_mix_available := false;
      end if;
      continue;
    end if;

    select encode(extensions.digest(
      v_candidate.package_type || ':' || v_candidate.recipe_identity || ':' ||
      array_to_string((select array_agg(x order by x) from unnest(v_final_ids) x), ','),
      'sha256'
    ), 'hex') into v_signature;
    if exists (
      select 1
      from public.looking_back_packages previous
      where previous.family_id = p_family_id
        and previous.signature = v_signature
        and previous.created_at >= transaction_timestamp() - interval '14 days'
        and previous.created_at < transaction_timestamp()
    ) then
      if v_candidate.package_type = 'archive_mix' then
        v_archive_mix_available := false;
      end if;
      continue;
    end if;

    insert into public.looking_back_packages (
      daily_set_id, family_id, package_date, package_type,
      subject_family_member_id, secondary_subject_family_member_id,
      display_kind, display_title, display_subtitle, display_era, tint,
      recipe_identity, signature, position
    ) values (
      v_set.id, p_family_id, v_date, v_candidate.package_type,
      v_candidate.subject_id, v_candidate.secondary_subject_id,
      v_candidate.display_kind, v_candidate.display_title, v_candidate.display_subtitle,
      v_candidate.display_era, v_candidate.tint, v_candidate.recipe_identity,
      v_signature, v_position
    ) returning id into v_package_id;
    insert into public.looking_back_package_memories (package_id, family_id, memory_id, position)
    select v_package_id, p_family_id, memory_id, ordinal - 1
    from unnest(v_final_ids) with ordinality as item(memory_id, ordinal);
    v_selected_ids := v_selected_ids || v_final_ids;
    v_position := v_position + 1;
    if v_candidate.package_type = 'archive_mix' then
      v_archive_mix_available := false;
    end if;
  end loop;

  return query select * from public.return_looking_back_daily_set(v_set.id, v_user_id);
end;
$$;

comment on function public.get_or_create_looking_back_packages(uuid) is
  'Returns or atomically materializes an immutable daily Looking Back set with birthday, togetherness, emotion, age-balanced archive, and legacy recipes under the four-package cap and cooldown rules.';

revoke all on function public.return_looking_back_daily_set(uuid, uuid) from public;
revoke all on function public.get_or_create_looking_back_packages(uuid) from public;
grant execute on function public.get_or_create_looking_back_packages(uuid) to authenticated;
