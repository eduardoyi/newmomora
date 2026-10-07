-- Keepsakes tab redesign, Phase A (docs/plans/keepsakes-redesign.md A1).
--
-- One member RPC, public.keepsakes_overview(p_family_id) returning jsonb, feeds
-- the whole Keepsakes tab in a single round trip:
--
--   recap               the "next-up recap" tile: owner-local month, delivery
--                       date, moments / visuals counts against the monthly
--                       floors, and the newest pooled picture (all members;
--                       null when the family would not get a recap)
--   has_viewers         privacy line gate (owner/manager only)
--   year_moments        pooled count for the owner-local calendar year
--   holiday_pool        the holiday-card film's pool for that year
--   holiday_min_pool    HOLIDAY_MIN_POOL (20), so the card page can decide
--                       whether to promise the QR film
--   holiday_ship_by_note  holiday_card_settings.ship_by_note while in season
--   preview_key         newest family picture (storefront card + card page)
--   book_preview_keys   { childId: newest picture tagged to that child }
--   orders              paid-or-later book / card order status per item
--
-- Everything except `recap` is null / empty for viewers: films are the only
-- keepsake they see and nothing priced or privacy-relevant leaves the server.
--
-- THE POOL MUST MIRROR THE FILM WORKER. The counts here promise a film, so
-- they use the worker's definition, kept in two places that must agree:
--   * supabase/functions/_shared/year-film-context.ts   mapFamilyRows
--   * supabase/functions/workflow-year-film-bridge/rows.ts   loadFamilyRows
--   * supabase/functions/_shared/year-film-eligibility.ts   visualKind /
--     hasVideoClip / holidayPool / MONTHLY_MIN_* / HOLIDAY_MIN_POOL
--   * supabase/functions/_shared/year-film-script.ts   shareSensitiveIds
-- A change to any pool rule there needs the same change in keepsake_pool
-- below (and vice versa). year-film-eligibility.ts carries a pointer back
-- here. supabase/tests/keepsakes_overview_test.sql pins every rule.
--
-- NOT applied automatically -- the owner runs `supabase db push`. Rollback:
-- supabase/rollbacks/20261009120000_keepsakes_overview_down.sql (by hand).

-- ---------------------------------------------------------------------------
-- 1. keepsake_pool: the shared per-memory pool (internal)
-- ---------------------------------------------------------------------------

-- One row per POOLED memory in [p_start, p_end_excl). A pooled memory is one
-- the worker would keep (mapFamilyRows), i.e. NOT:
--   * under an open or reviewing content_reports row targeting the memory
--     (every family report counts -- films are family-wide);
--   * onboarding_media_pending (the boolean alone, no `_until` rule, exactly
--     like the worker);
--   * authored by an account an owner/manager blocked
--     (year_film_parent_blocked_users). A memory with no author stays.
--
-- is_visual mirrors visualKind(): never for audio-typed memories (even with an
-- illustration); otherwise a ready illustration with no open/reviewing
-- memory_illustration report, an image (memory_media rows, or the legacy
-- single-asset media_key when the memory has no usable memory_media rows), or
-- a video clip (duration null or >= 2000 ms).
--
-- picture_key is the key of the asset that makes the memory visual, in
-- visualKind's order (illustration, then video poster, then image):
--   illustration -> illustration_key
--   video        -> the first clip's poster (memory_media.preview_object_key)
--   image        -> the first-position image's preview_object_key ?? object_key
--                   (or the legacy media_key)
-- A visual memory with no resolvable key (a legacy video, or a video without
-- a poster) has picture_key null: callers asking for a picture skip it, it
-- never hides an older memory that has one.
--
-- in_holiday_pool (only when p_with_holiday, else null) mirrors holidayPool():
-- the pool minus share-sensitive memories (shareSensitiveIds, WITHOUT the
-- publicAudience extras -- that is what the floor check uses) and
-- worry/sad/weary moments.
--
-- Optional narrowing, all applied BEFORE order/limit so a `limit` stops early
-- on the (family_id, memory_date desc, created_at desc) index:
--   p_caller        also hide authors that account personally blocked (the
--                   timeline's rule, blocked_family_accounts by blocker). The
--                   counts never pass it: they must equal the worker's.
--   p_member_id     only memories tagged to that family member
--   p_picture_only  only memories with a resolvable picture_key
--   p_limit         newest first (memory_date, created_at, id), null = all
--
-- INTERNAL: security definer, callable only from keepsakes_overview. It takes
-- the family id on trust, so no client role may execute it.
create or replace function public.keepsake_pool(
  p_family_id uuid,
  p_start date,
  p_end_excl date,
  p_caller uuid default null,
  p_member_id uuid default null,
  p_picture_only boolean default false,
  p_limit integer default null,
  p_with_holiday boolean default false
)
returns table (
  memory_id uuid,
  user_id uuid,
  memory_date date,
  created_at timestamptz,
  memory_type text,
  is_visual boolean,
  picture_key text,
  in_holiday_pool boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  with blocked as (
    select public.year_film_parent_blocked_users(p_family_id) as ids
  ),
  personal as (
    select b.blocked_user_id
    from public.blocked_family_accounts b
    where p_caller is not null
      and b.family_id = p_family_id
      and b.blocker_user_id = p_caller
  ),
  rep as materialized (
    select r.target_type, r.target_id
    from public.content_reports r
    where r.family_id = p_family_id
      and r.status in ('open', 'reviewing')
      and r.target_type in ('memory', 'memory_illustration')
  ),
  base as (
    select
      m.id,
      m.user_id,
      m.memory_date,
      m.created_at,
      m.memory_type,
      m.emotion,
      m.topics,
      m.content,
      (m.illustration_status = 'ready'
        and nullif(m.illustration_key, '') is not null
        and not exists (
          select 1 from rep
          where rep.target_type = 'memory_illustration' and rep.target_id = m.id
        )) as illustration_ready,
      m.illustration_key,
      -- Assets: memory_media rows win; the legacy single asset only counts
      -- when there are none with a usable kind (worker: assets.length === 0).
      case when a.n_assets > 0 then a.has_image
           else coalesce(nullif(m.media_key, '') is not null and m.media_content_type like 'image/%', false)
      end as has_image,
      case when a.n_assets > 0 then a.has_clip
           else coalesce(nullif(m.media_key, '') is not null and m.media_content_type like 'video/%', false)
      end as has_clip,
      case when a.n_assets > 0 then a.image_key
           when m.media_content_type like 'image/%' then nullif(m.media_key, '')
      end as image_key,
      case when a.n_assets > 0 then a.poster_key end as poster_key
    from public.memories m
    left join lateral (
      select
        count(*) filter (where mm.content_type ~ '^(image|video|audio)/') as n_assets,
        coalesce(bool_or(mm.content_type like 'image/%'), false) as has_image,
        coalesce(bool_or(mm.content_type like 'video/%'
          and (mm.duration_ms is null or mm.duration_ms >= 2000)), false) as has_clip,
        (array_agg(coalesce(nullif(mm.preview_object_key, ''), nullif(mm.object_key, ''))
          order by mm.position, mm.id)
          filter (where mm.content_type like 'image/%'))[1] as image_key,
        (array_agg(nullif(mm.preview_object_key, '')
          order by mm.position, mm.id)
          filter (where mm.content_type like 'video/%'
            and (mm.duration_ms is null or mm.duration_ms >= 2000)
            and nullif(mm.preview_object_key, '') is not null))[1] as poster_key
      from public.memory_media mm
      where mm.memory_id = m.id
    ) a on true
    where m.family_id = p_family_id
      and m.memory_date >= p_start
      and m.memory_date < p_end_excl
      and not m.onboarding_media_pending
      and not exists (
        select 1 from rep where rep.target_type = 'memory' and rep.target_id = m.id
      )
      and (m.user_id is null or not exists (select 1 from blocked bl where m.user_id = any (bl.ids)))
      and (m.user_id is null or not exists (select 1 from personal p where p.blocked_user_id = m.user_id))
      and (p_member_id is null or exists (
        select 1 from public.memory_family_members t
        where t.memory_id = m.id and t.family_member_id = p_member_id
      ))
  ),
  shaped as (
    select
      b.id as memory_id,
      b.user_id,
      b.memory_date,
      b.created_at,
      b.memory_type,
      (b.memory_type <> 'audio' and (b.illustration_ready or b.has_clip or b.has_image)) as is_visual,
      case
        when b.memory_type = 'audio' then null
        else coalesce(
          case when b.illustration_ready then b.illustration_key end,
          b.poster_key,
          b.image_key
        )
      end as picture_key,
      case
        when not p_with_holiday then null
        else not (
            coalesce(b.emotion in ('worry', 'sad', 'weary'), false)
            -- shareSensitiveIds: topics, milestones, text.
            or coalesce(b.topics && array['bath', 'doctor-dentist', 'tough-days']::text[], false)
            or exists (
              select 1 from public.memory_milestones ms
              where ms.memory_id = b.id
                and ms.status <> 'dismissed'
                and ms.milestone_id in ('potty-trained', 'first-bath', 'first-dentist', 'last-bottle')
            )
            -- SHARE_SENSITIVE_TEXT (year-film-script.ts), ported from JS:
            -- \p{L} -> an explicit letter class, case-insensitive (~*).
            or (b.content is not null and b.content ~* (
              '(?<![A-Za-zÀ-ÖØ-öø-ÿ])('
              || 'pip[iíÍ]|pup[uúÚ]|poceta|pa[ñÑn]al(es)?|caca|orinal|inodoro|potty|poop|pee'
              || '|diapers?|nappy|nappies|toilet|v[oóÓ]mit[A-Za-zÀ-ÖØ-öø-ÿ0-9_]*|fiebre|fever'
              || '|hospital|urgencias|desnud[A-Za-zÀ-ÖØ-öø-ÿ0-9_]*|naked'
              || ')(?![A-Za-zÀ-ÖØ-öø-ÿ])'
            ))
          )
      end as in_holiday_pool
    from base b
  )
  select s.memory_id, s.user_id, s.memory_date, s.created_at, s.memory_type,
         s.is_visual, s.picture_key, s.in_holiday_pool
  from shaped s
  where not p_picture_only or s.picture_key is not null
  order by s.memory_date desc, s.created_at desc, s.memory_id desc
  limit p_limit;
$$;
revoke all on function public.keepsake_pool(uuid, date, date, uuid, uuid, boolean, integer, boolean)
  from public, anon, authenticated;

comment on function public.keepsake_pool(uuid, date, date, uuid, uuid, boolean, integer, boolean) is
  'INTERNAL (no client grant): the Year Film worker''s memory pool + visual / picture rules, shared by keepsakes_overview. Mirrors year-film-context.ts mapFamilyRows and year-film-eligibility.ts visualKind/holidayPool -- change them together.';

-- ---------------------------------------------------------------------------
-- 2. keepsakes_overview
-- ---------------------------------------------------------------------------

-- Gates for `recap` are year_films_enabled's, MINUS the >= 10 memories check
-- (the tile shows progress toward it): rollout includes the family,
-- launch_date <= the next 1st, billing allows films for the owner, and the
-- family has an own child with a date of birth. All dates are owner-local (the
-- family owner's timezone, computed once), exactly like the scheduler.
create or replace function public.keepsakes_overview(p_family_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_can_edit boolean;
  v_owner uuid;
  v_launch date;
  v_tz text;
  v_today date;
  v_month_start date;
  v_next_first date;
  v_year_start date;
  v_next_year_start date;
  v_lookback_start date;
  v_recap jsonb := null;
  v_moments integer;
  v_visuals integer;
  v_picture text;
  v_has_viewers boolean := null;
  v_year_moments integer := null;
  v_holiday_pool integer := null;
  v_ship_by text := null;
  v_preview text := null;
  v_book_previews jsonb := null;
  v_orders jsonb := '[]'::jsonb;
  v_child uuid;
  v_key text;
begin
  if public.is_anonymous_user() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  if not public.is_family_member(p_family_id) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  v_can_edit := public.has_family_role(p_family_id, array['owner', 'manager']);

  -- Owner-local clock, computed ONCE per call (year_film_owner_tz joins
  -- families + user_profiles + pg_timezone_names).
  v_tz := coalesce(public.year_film_owner_tz(p_family_id), 'UTC');
  v_today := (now() at time zone v_tz)::date;
  v_month_start := date_trunc('month', v_today::timestamp)::date;
  v_next_first := (v_month_start + interval '1 month')::date;
  v_year_start := date_trunc('year', v_today::timestamp)::date;
  v_next_year_start := (v_year_start + interval '1 year')::date;
  -- Previews look back one year (a bounded start on the index; no upper
  -- bound, so a future-dated memory or a device ahead of the owner's
  -- timezone cannot hide the newest picture).
  v_lookback_start := (v_today - interval '1 year')::date;

  -- ---- recap (all members) -------------------------------------------------
  select s.launch_date into v_launch from public.year_film_settings s where s.id;
  select f.owner_id into v_owner
  from public.families f
  where f.id = p_family_id and f.deleted_at is null;

  if v_launch is not null
    and v_owner is not null
    and v_launch <= v_next_first
    and public.year_film_family_enabled(p_family_id)
    and public.billing_write_allowed(p_family_id, v_owner)
    and exists (
      select 1 from public.family_members m
      where m.family_id = p_family_id and m.date_of_birth is not null
        and public.year_film_is_own_child(m.relationship, m.date_of_birth, v_today)
    )
  then
    select count(*)::integer, (count(*) filter (where p.is_visual))::integer
    into v_moments, v_visuals
    from public.keepsake_pool(p_family_id, v_month_start, v_next_first) p;

    -- Newest pooled memory with a picture, not authored by anyone the CALLER
    -- hid (timeline rule). Early-stops on the memories index.
    select p.picture_key into v_picture
    from public.keepsake_pool(p_family_id, v_month_start, v_next_first, v_uid, null, true, 1) p;

    v_recap := jsonb_build_object(
      'month_start', v_month_start,
      'delivers_on', v_next_first,
      'moments', v_moments,
      'visuals', v_visuals,
      -- MONTHLY_MIN_POOL / MONTHLY_MIN_VISUALS (year-film-eligibility.ts).
      'min_moments', 10,
      'min_visuals', 6,
      'picture_key', v_picture
    );
  end if;

  -- ---- owner / manager extras ----------------------------------------------
  if v_can_edit then
    v_has_viewers := exists (
      select 1 from public.family_memberships fm
      where fm.family_id = p_family_id and fm.role = 'viewer'
    );

    -- Current owner-local calendar year: the pooled count, and the holiday
    -- card film's pool (the floor the card page checks before promising a QR).
    select count(*)::integer, (count(*) filter (where p.in_holiday_pool))::integer
    into v_year_moments, v_holiday_pool
    from public.keepsake_pool(p_family_id, v_year_start, v_next_year_start, null, null, false, null, true) p;

    if public.holiday_card_family_enabled(p_family_id) then
      select nullif(btrim(s.ship_by_note), '') into v_ship_by
      from public.holiday_card_settings s where s.id;
    end if;

    -- Newest picture across the family (storefront card + card page).
    select p.picture_key into v_preview
    from public.keepsake_pool(p_family_id, v_lookback_start, date '9999-12-31', v_uid, null, true, 1) p;

    -- Newest picture tagged to each own child (Memory Book cover). Children
    -- without a picture are omitted.
    v_book_previews := '{}'::jsonb;
    for v_child in
      select m.id
      from public.family_members m
      where m.family_id = p_family_id
        and public.year_film_is_own_child(m.relationship, m.date_of_birth, v_today)
      order by m.created_at, m.id
    loop
      select p.picture_key into v_key
      from public.keepsake_pool(p_family_id, v_lookback_start, date '9999-12-31', v_uid, v_child, true, 1) p;
      if v_key is not null then
        v_book_previews := v_book_previews || jsonb_build_object(v_child::text, v_key);
      end if;
    end loop;

    -- Order status per item: the single latest PAID-OR-LATER, non-refunded
    -- row (created_at desc, id desc). A newer draft/quote/checkout for a
    -- reorder is not in the set, so it never displaces a shipped row; a paid
    -- order that later failed (or was refunded) drops out. Status only --
    -- never addresses or prices. Family-wide on purpose: the shelf shows
    -- family keepsakes whoever paid (memory_book_orders' own RLS is
    -- buyer-only, so this definer read is the only path).
    select coalesce(jsonb_agg(x.item order by x.product, x.item_id), '[]'::jsonb)
    into v_orders
    from (
      select 'book'::text as product, b.book_id as item_id,
             jsonb_build_object(
               'product', 'book', 'item_id', b.book_id, 'status', b.status, 'shipped_at', null
             ) as item
      from (
        select distinct on (o.book_id) o.book_id, o.status
        from public.memory_book_orders o
        where o.family_id = p_family_id
          and o.status in ('paid', 'rendering', 'submitted', 'in_production', 'shipped', 'delivered')
          and o.refunded_at is null
        order by o.book_id, o.created_at desc, o.id desc
      ) b
      union all
      select 'card'::text, c.card_id,
             jsonb_build_object(
               'product', 'card', 'item_id', c.card_id, 'status', c.status, 'shipped_at', c.shipped_at
             )
      from (
        select distinct on (o.card_id) o.card_id, o.status, o.shipped_at
        from public.holiday_card_orders o
        where o.family_id = p_family_id
          and o.card_id is not null
          and o.status in ('paid', 'submitted', 'in_production', 'shipped')
          and o.refunded_at is null
        order by o.card_id, o.created_at desc, o.id desc
      ) c
    ) x;
  end if;

  return jsonb_build_object(
    'recap', v_recap,
    'has_viewers', v_has_viewers,
    'year_moments', v_year_moments,
    'holiday_pool', v_holiday_pool,
    -- HOLIDAY_MIN_POOL (year-film-eligibility.ts).
    'holiday_min_pool', case when v_can_edit then 20 else null end,
    'holiday_ship_by_note', v_ship_by,
    'preview_key', v_preview,
    'book_preview_keys', v_book_previews,
    'orders', v_orders
  );
end;
$$;
revoke all on function public.keepsakes_overview(uuid) from public, anon, authenticated;
grant execute on function public.keepsakes_overview(uuid) to authenticated;

comment on function public.keepsakes_overview(uuid) is
  'Keepsakes tab overview (docs/plans/keepsakes-redesign.md): recap tile progress + picture, and for owners/managers the privacy/holiday/preview/order extras. Member-only; viewers get recap only.';
