-- ROLLBACK for 20261010120000_keepsakes_overview_card_front.sql.
--
-- Applied BY HAND (psql / the Supabase SQL editor), NEVER by `supabase db push`
-- or `supabase db reset` (it lives outside supabase/migrations on purpose).
-- Run it in one transaction.
--
-- Restores keepsakes_overview to its 20261009120000 definition (no `card_front`
-- key). Same signature, so CREATE OR REPLACE swaps the body in place; grants are
-- re-asserted below. Roll the app OTA back FIRST (or accept that the card
-- preview falls back to the generic card front: the app treats a missing
-- `card_front` as null).

begin;

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

commit;
