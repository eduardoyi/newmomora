-- Follow-up to the already deployed image-only candidate scope.
-- Child assets are authoritative when present; legacy summary fields are fallback only.

create or replace function public.get_widget_memory_candidates(p_family_id uuid)
returns table (
  memory_id uuid,
  memory_date date,
  age_band text,
  family_date date,
  timezone_name text,
  next_day_boundary timestamptz
)
language plpgsql
security invoker
stable
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := auth.uid();
  v_timezone text;
  v_family_date date;
  v_next_day_boundary timestamptz;
begin
  if v_user_id is null or public.is_anonymous_user() then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if p_family_id is null or not public.is_family_member(p_family_id) then
    raise exception 'Not authorized for this family' using errcode = '42501';
  end if;

  v_timezone := public.get_widget_family_timezone(p_family_id);
  v_family_date := (transaction_timestamp() at time zone v_timezone)::date;
  v_next_day_boundary := ((v_family_date + 1)::timestamp at time zone v_timezone);

  return query
  with my_open_reports as materialized (
    select report.target_type, report.target_id, report.target_version_id
    from public.get_my_open_content_reports(p_family_id) report
  ),
  reported_memory_ids as materialized (
    select report.target_id
    from my_open_reports report
    where report.target_type = 'memory'
  ),
  reported_illustrations as materialized (
    select report.target_id, report.target_version_id
    from my_open_reports report
    where report.target_type = 'memory_illustration'
  ),
  blocked_users as materialized (
    select blocked.blocked_user_id
    from public.blocked_family_accounts blocked
    where blocked.family_id = p_family_id
      and blocked.blocker_user_id = v_user_id
  ),
  eligible as (
    select
      m.id,
      m.memory_date,
      case
        when m.memory_date > v_family_date - 90 then 'recent'
        when m.memory_date > (v_family_date - interval '18 months')::date then 'medium'
        when m.memory_date > (v_family_date - interval '36 months')::date then 'old'
        else 'deep'
      end::text as age_band,
      md5(
        'widget:' || p_family_id::text || ':' || v_family_date::text || ':' || m.id::text
      ) as stable_order
    from public.memories m
    where m.family_id = p_family_id
      -- An in-progress gallery/onboarding media row is not a saved memory.
      and m.onboarding_media_pending is not true
      -- Widget cards have an image source only. A media memory qualifies when
      -- any asset is a photo, including a mixed photo/video carousel. The
      -- legacy summary columns cover pre-migration single-asset rows; the
      -- child table covers current multi-asset rows.
      and (
        (
          m.memory_type = 'media'
          and (
            (
              m.media_key is not null
              and m.media_content_type in (
                'image/jpeg',
                'image/png',
                'image/heic',
                'image/heif',
                'image/webp'
              )
              -- The summary columns are the legacy single-asset fallback.
              -- Once child assets exist, their rows are authoritative so a
              -- stale image summary cannot make a video-only carousel pass.
              and not exists (
                select 1
                from public.memory_media mm
                where mm.memory_id = m.id
              )
            )
            or exists (
              select 1
              from public.memory_media mm
              where mm.memory_id = m.id
                and mm.content_type in (
                  'image/jpeg',
                  'image/png',
                  'image/heic',
                  'image/heif',
                  'image/webp'
                )
            )
          )
        )
        or (
          m.memory_type = 'text_illustration'
          and m.illustration_status = 'ready'
          and m.illustration_key is not null
          -- Illustration reports are generation-specific. A report for an
          -- older generation must not hide a newly generated illustration;
          -- an active report for the current generation excludes the memory
          -- persistently before the 40-row cap.
          and not exists (
            select 1
            from reported_illustrations report
            where report.target_id = m.id
              and report.target_version_id is not distinct from m.illustration_generation_id
          )
        )
      )
      -- A whole-memory report is authoritative for this reporter.
      and not exists (
        select 1 from reported_memory_ids report where report.target_id = m.id
      )
      -- blocked_family_accounts has a reporter-local RLS policy. Keeping the
      -- predicate in this invoker query removes blocked authors before the
      -- 40-row cap instead of relying only on client filtering.
      and not exists (
        select 1 from blocked_users blocked where blocked.blocked_user_id = m.user_id
      )
  ),
  band_ranked as (
    select
      e.*,
      row_number() over (
        partition by e.age_band
        order by e.stable_order, e.id
      ) as band_position
    from eligible e
  ),
  band_quota as (
    select b.*
    from band_ranked b
    where b.band_position <= 10
  ),
  backfill as (
    select b.*
    from band_ranked b
    where b.band_position > 10
      and not exists (
        select 1
        from band_quota q
        where q.id = b.id
      )
    order by b.stable_order, b.id
    limit greatest(0, 40 - (select count(*) from band_quota))
  ),
  chosen as (
    select q.id, q.memory_date, q.age_band, q.stable_order from band_quota q
    union all
    select b.id, b.memory_date, b.age_band, b.stable_order from backfill b
  ),
  response_rows as (
    select c.id, c.memory_date, c.age_band, c.stable_order
    from chosen c
    union all
    -- Preserve timezone/date metadata for an empty eligible set without
    -- inventing a memory candidate. The client ignores this null-id sentinel.
    select null::uuid, null::date, null::text, null::text
    where not exists (select 1 from chosen)
  )
  select
    c.id,
    c.memory_date,
    c.age_band,
    v_family_date,
    v_timezone,
    v_next_day_boundary
  from response_rows c
  order by c.stable_order nulls first, c.id nulls first;
end;
$$;

revoke all on function public.get_widget_memory_candidates(uuid) from public, anon, authenticated;
grant execute on function public.get_widget_memory_candidates(uuid) to authenticated;
