-- Keepsakes overview: close the reveal gap
-- (docs/features/keepsakes.md "Upcoming tiles").
--
-- A Year Film's year_films row is created early (~00:30 owner-local on its due
-- day) but the film only APPEARS at surface_at (09:00 for birthday / year-end
-- films, 19:00 on the 1st for monthly recaps); the app hides an unsurfaced film
-- from everyone (fetchFamilyYearFilms). So on the due day:
--   (1) the birthday / year-end tile vanished as soon as the row existed,
--       leaving an empty slot until the reveal, and
--   (2) on the 1st the recap tile restarted for the new month ("0 of 10") while
--       last month's recap had not appeared yet.
-- The tile now stays until the film actually appears ("arrives today"), then
-- hands straight over to the real film.
--
-- Re-creates (same signatures, security and grants; EVERY existing key unchanged
-- in shape):
--   keepsake_upcoming_films(family, caller, today)  a birthday / year-end entry
--                    is excluded only when a matching non-skipped / non-failed,
--                    non-forced row exists AND its surface_at <= now(). A row
--                    that exists but has not surfaced keeps the tile.
--   keepsakes_overview(family)                       gains a top-level
--                    `previous_recap` (all members): last month's recap tile on
--                    the 1st until it surfaces, the same object shape as
--                    `recap` (month_start, delivers_on, moments, visuals,
--                    min_moments, min_visuals, picture_key), or null.
-- New INTERNAL helper (security definer, no client grant):
--   keepsake_previous_recap(family, caller, today, now)  the previous_recap
--                    rules, with the dates pinned for pgTAP.
--
-- NOT applied automatically -- the owner runs `supabase db push`. Rollback:
-- supabase/rollbacks/20261012120000_keepsakes_overview_reveal_gap_down.sql
-- (by hand). supabase/tests/keepsakes_overview_test.sql pins every rule.

-- ---------------------------------------------------------------------------
-- 1. keepsake_upcoming_films: a tile stays until its film has surfaced
-- ---------------------------------------------------------------------------

-- Unchanged from 20261011120000 (see its header for the full rule set: windows,
-- scope, floors, pools, quarters, gates) EXCEPT the film-row exclusion:
--   * a tile is dropped only when a non-forced row of the scheduler's key
--     exists in a status other than skipped / failed AND it has SURFACED
--     (surface_at <= now(), the same instant the app starts listing the film).
--     A row that exists but has not surfaced keeps the tile, so the slot never
--     goes empty between row creation (~00:30) and the reveal (09:00). A
--     skipped / failed row is terminal and invisible to clients, so the tile
--     stays until its film date passes (today's behaviour).
--   * the film date (birthday + 2 / Dec 30) is inside the windows [today,
--     today + 30] / Dec 1..30, so the tile is on the shelf on the due day.
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

-- ---------------------------------------------------------------------------
-- 2. keepsake_previous_recap: last month's recap on the 1st, until it surfaces
-- ---------------------------------------------------------------------------

-- The monthly recap row (year_film_due) is created at 00:30 owner-local on the
-- 1st, scope = the PREVIOUS month, but the film only surfaces at 19:00
-- (surface_at); the app hides an unsurfaced film from everyone. Meanwhile
-- keepsakes_overview.recap has already restarted for the NEW month ("0 of 10"),
-- so without this the family sees the previous month's recap vanish for the
-- day. previous_recap is that month's tile, kept until the film appears.
--
-- Non-null only when ALL hold (p_today / p_now are parameters so pgTAP can pin
-- them; p_today is owner-local, p_now an instant):
--   * the recap gates: rollout includes the family, launch_date is set and
--     <= p_today (the scheduler's due_date >= launch_date, due_date = the 1st),
--     billing allows films for the owner, the family is live, and an own child
--     with a date of birth exists at p_today (year_film_due's own-child rule);
--   * p_today is the 1st of the month;
--   * the previous month's scheduler key (family, 'family_month', no member,
--     scope_start_date = previous month's 1st, NOT forced -- year_films_key)
--     has NO row that has surfaced (surface_at <= p_now: the real film UI has
--     taken over) and NO skipped / failed row (terminal and invisible to
--     clients: the recap is not coming, so it is not promised);
--   * EITHER that row exists and has not surfaced yet (the film is on its way)
--     OR no row exists yet (00:00-00:30, or the scheduler has not run) and the
--     previous month's pool already meets BOTH monthly floors (10 moments, 6
--     visuals -- MONTHLY_MIN_POOL / MONTHLY_MIN_VISUALS), so the row is about
--     to be created and the worker will not skip it.
-- Shape = keepsakes_overview.recap: month_start (previous month's 1st),
-- delivers_on (p_today: it arrives today), counts and picture over the previous
-- month's pool (keepsake_pool, same rules as `recap`; the picture skips authors
-- p_caller hid, counts never take the caller).
--
-- INTERNAL: security definer, takes the family id on trust -- callable only
-- from keepsakes_overview (which has checked membership).
create or replace function public.keepsake_previous_recap(
  p_family_id uuid,
  p_caller uuid,
  p_today date,
  p_now timestamptz
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
  v_prev_start date;
  v_status text;
  v_surface timestamptz;
  v_has_row boolean;
  v_moments integer;
  v_visuals integer;
  v_picture text;
begin
  if extract(day from p_today) <> 1 then
    return null;
  end if;
  v_prev_start := (p_today - interval '1 month')::date;

  select s.launch_date into v_launch from public.year_film_settings s where s.id;
  select f.owner_id into v_owner
  from public.families f
  where f.id = p_family_id and f.deleted_at is null;

  if v_launch is null
    or v_owner is null
    or v_launch > p_today
    or not public.year_film_family_enabled(p_family_id)
    or not public.billing_write_allowed(p_family_id, v_owner)
    or not exists (
      select 1 from public.family_members m
      where m.family_id = p_family_id and m.date_of_birth is not null
        and public.year_film_is_own_child(m.relationship, m.date_of_birth, p_today)
    )
  then
    return null;
  end if;

  select f.status, f.surface_at into v_status, v_surface
  from public.year_films f
  where f.family_id = p_family_id
    and f.kind = 'family_month'
    and f.family_member_id is null
    and f.scope_start_date = v_prev_start
    and not f.forced;
  v_has_row := found;

  -- Surfaced (the real film UI has taken over) or terminal: nothing to promise.
  if v_has_row and (v_status in ('skipped', 'failed') or v_surface <= p_now) then
    return null;
  end if;

  select count(*)::integer, (count(*) filter (where p.is_visual))::integer
  into v_moments, v_visuals
  from public.keepsake_pool(p_family_id, v_prev_start, p_today) p;

  -- No row yet: only promise it when the worker's floors are already met.
  if not v_has_row and (v_moments < 10 or v_visuals < 6) then
    return null;
  end if;

  select p.picture_key into v_picture
  from public.keepsake_pool(p_family_id, v_prev_start, p_today, p_caller, null, true, 1) p;

  return jsonb_build_object(
    'month_start', v_prev_start,
    'delivers_on', p_today,
    'moments', v_moments,
    'visuals', v_visuals,
    -- MONTHLY_MIN_POOL / MONTHLY_MIN_VISUALS (year-film-eligibility.ts).
    'min_moments', 10,
    'min_visuals', 6,
    'picture_key', v_picture
  );
end;
$$;
revoke all on function public.keepsake_previous_recap(uuid, uuid, date, timestamptz) from public, anon, authenticated;

comment on function public.keepsake_previous_recap(uuid, uuid, date, timestamptz) is
  'INTERNAL (no client grant): last month''s recap tile on the 1st of the month until the film surfaces (19:00 owner-local), so the tile does not vanish while the new month''s recap restarts. Mirrors year_film_due (monthly) scheduling and the recap floors -- change them together.';

-- ---------------------------------------------------------------------------
-- 3. keepsakes_overview
-- ---------------------------------------------------------------------------

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
  v_previous_recap jsonb;
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

  -- ---- previous recap (all members): last month's recap on the 1st until it
  -- surfaces (19:00 owner-local). Its row is created ~00:30, but the film
  -- only appears at surface_at, and `recap` already restarted for the new month.
  v_previous_recap := public.keepsake_previous_recap(p_family_id, v_uid, v_today, now());

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
    'upcoming_films', v_upcoming,
    'previous_recap', v_previous_recap
  );
end;
$$;
revoke all on function public.keepsakes_overview(uuid) from public, anon, authenticated;
grant execute on function public.keepsakes_overview(uuid) to authenticated;

comment on function public.keepsakes_overview(uuid) is
  'Keepsakes tab overview (docs/plans/keepsakes-redesign.md): recap tile progress + picture, and for owners/managers the privacy/holiday/preview/order extras plus card_front (the newest holiday card''s actual front) and cards (every card with its front and ordered flag). All members get recap, previous_recap (last month''s recap on the 1st until it surfaces) and upcoming_films (the birthday / year-end films due in the next 30 days / December, kept until they surface, with progress toward their floors).';
