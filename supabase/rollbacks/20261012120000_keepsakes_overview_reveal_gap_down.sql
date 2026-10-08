-- ROLLBACK for 20261012120000_keepsakes_overview_reveal_gap.sql.
--
-- Applied BY HAND (psql / the Supabase SQL editor), NEVER by `supabase db push`
-- or `supabase db reset` (it lives outside supabase/rollbacks on purpose).
-- Run it in one transaction; written to be re-runnable (IF EXISTS).
--
-- Restores keepsake_upcoming_films and keepsakes_overview to their
-- 20261011120000 definitions (the tile disappears as soon as a film row exists;
-- no `previous_recap` key) and drops keepsake_previous_recap. Same signatures,
-- so CREATE OR REPLACE swaps the bodies in place; grants are re-asserted below.
-- Roll the app OTA back FIRST (or accept that the app treats an absent
-- `previous_recap` as null).

begin;

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
      -- the next 30 days and has no live film row yet.
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
  'INTERNAL (no client grant): the birthday / year-end Year Films due in the next 30 days / December, with pool progress against the worker''s floors (60 moments, 40 visuals, 3 quarters). Mirrors year_film_due scheduling and evaluateBirthdayFilm / evaluateFamilyFilm -- change them together.';

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
  -- card_front / cards
  v_card_front jsonb := null;
  v_cards jsonb := '[]'::jsonb;
  v_upcoming jsonb;
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

    -- The family's ACTUAL card front (the Keepsakes tile / card page preview):
    -- the SAME card holiday_card_summary returns (newest non-deleted, LIVE
    -- family), built by keepsake_card_front -- the one place the front rules
    -- live (see its comment for the edge code it mirrors).
    select public.keepsake_card_front(c.id) into v_card_front
    from public.holiday_cards c
    where c.family_id = p_family_id and c.deleted_at is null
    order by c.created_at desc, c.id desc
    limit 1;

    -- Every non-deleted card of the family (the "Your cards" shelf), newest
    -- year first. `front` is keepsake_card_front minus the card_id / year
    -- already on the card entry. `ordered` is holiday_card_summary's rule
    -- verbatim (any order in paid | submitted | in_production | shipped --
    -- refunds are NOT excluded there, so they are not here either).
    select coalesce(jsonb_agg(
             jsonb_build_object(
               'card_id', c.id,
               'year', c.year,
               'status', c.status,
               'ordered', exists (
                 select 1 from public.holiday_card_orders o
                 where o.card_id = c.id
                   and o.status in ('paid', 'submitted', 'in_production', 'shipped')
               ),
               'front', public.keepsake_card_front(c.id) - 'card_id' - 'year'
             )
             order by c.year desc, c.created_at desc, c.id desc
           ), '[]'::jsonb)
    into v_cards
    from public.holiday_cards c
    where c.family_id = p_family_id and c.deleted_at is null and v_owner is not null;

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

  -- ---- upcoming films (all members) ---------------------------------------
  v_upcoming := public.keepsake_upcoming_films(p_family_id, v_uid, v_today);

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
    'orders', v_orders,
    'card_front', v_card_front,
    'cards', v_cards,
    'upcoming_films', v_upcoming
  );
end;
$$;
revoke all on function public.keepsakes_overview(uuid) from public, anon, authenticated;
grant execute on function public.keepsakes_overview(uuid) to authenticated;

comment on function public.keepsakes_overview(uuid) is
  'Keepsakes tab overview (docs/plans/keepsakes-redesign.md): recap tile progress + picture, and for owners/managers the privacy/holiday/preview/order extras plus card_front (the newest holiday card''s actual front) and cards (every card with its front and ordered flag). All members get recap and upcoming_films (the birthday / year-end films due in the next 30 days / December, with progress toward their floors).';

-- The new helper is only referenced by the new function body, replaced above.
drop function if exists public.keepsake_previous_recap(uuid, uuid, date, timestamptz);

commit;
