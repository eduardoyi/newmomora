-- Keepsakes overview: add `cards` and `upcoming_films`
-- (docs/plans/keepsakes-redesign.md).
--
-- Re-creates public.keepsakes_overview(uuid) -- same signature, security and
-- grants, EVERY existing key unchanged (including `card_front`, which a
-- deployed app reads) -- with two new keys:
--
--   cards            owner / manager only (`[]` for viewers): every non-deleted
--                    holiday card of the family, newest year first (then
--                    created_at desc):
--                    [{ card_id, year, status: generating|ready|failed,
--                       ordered: bool, front: { image_key, width, height,
--                       layout, orientation, focal, greeting, language,
--                       greeting_text, subline_text, greeting_position } }]
--                    `front` is exactly the card_front rule set (see
--                    keepsake_card_front) minus the card_id / year already on
--                    the entry; `ordered` is holiday_card_summary's rule.
--   upcoming_films   ALL members (`[]` when the family fails the recap gates):
--                    the birthday films due in the next 30 days and the
--                    year-end film in December, with pool progress against the
--                    worker's floors (60 moments / 40 visuals / 3 quarters):
--                    [{ kind: birthday|family_year, member_id, age_year,
--                       film_date, scope_start, scope_end_excl, moments,
--                       visuals, min_moments, min_visuals, quarters,
--                       min_quarters, picture_key }]
--
-- Two new INTERNAL helpers (security definer, no client grant):
--   keepsake_card_front(card_id)                   the card_front logic, moved
--                                                  verbatim out of the RPC
--   keepsake_upcoming_films(family, caller, today) the upcoming-films rules
-- keepsake_pool is untouched: the birthday pool (tagged to the child, in the
-- film's scope) is exactly its p_member_id filter.
--
-- NOT applied automatically -- the owner runs `supabase db push`. Rollback:
-- supabase/rollbacks/20261011120000_keepsakes_overview_cards_upcoming_down.sql
-- (by hand). supabase/tests/keepsakes_overview_test.sql pins every rule.

-- ---------------------------------------------------------------------------
-- 1. keepsake_card_front: one card's actual front (internal)
-- ---------------------------------------------------------------------------

-- The ACTUAL front of one holiday card (the Keepsakes tile / card page
-- preview), as the editor shows it. Mirrors:
--   * supabase/functions/holiday-cards/index.ts  readFrontCandidates (array
--     or { candidates: [...] }, entries with a string mediaId, first 100)
--     and resolveFamilyPhotos (printable jpeg/png/webp memory_media of THIS
--     family; `legacy:` ids and foreign / HEIC / video ids are absent)
--   * supabase/functions/_shared/holiday-card-snapshot.ts  normalizeCardEdits
--     (enum values only, else defaults; text overrides keep any string,
--     including ""), resolveFrontId + buildEditorView (a usable saved pick
--     wins, else the first USABLE candidate in stored order), sizeOf
--   * book-renderer/src/card/geometry.ts  orientationFromImage
-- Anything unresolvable degrades to image_key null with the rest intact.
--
-- The logic is moved here VERBATIM from 20261010120000 (where it lived inline
-- in keepsakes_overview) so `card_front` and `cards[].front` cannot drift.
-- Returns the object card_front has always been (card_id, year, image_key, ...),
-- or NULL for an unknown / soft-deleted card or a family that is gone.
--
-- INTERNAL: security definer, takes the card id on trust, so no client role may
-- execute it; callers (keepsakes_overview) have already checked the role.
create or replace function public.keepsake_card_front(p_card_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_card public.holiday_cards;
  v_edits jsonb;
  v_choices jsonb;
  v_cand_list jsonb;
  v_pick text;
  v_pick_id uuid;
  v_front_id uuid;
  v_front_key text;
  v_front_ratio double precision;
  v_front_cand jsonb;
  v_w integer;
  v_h integer;
  v_cw numeric;
  v_ch numeric;
  v_layout text;
  v_orientation text;
  v_focal jsonb;
  v_fx numeric;
  v_fy numeric;
  v_position text;
begin
  select c.* into v_card
  from public.holiday_cards c
  join public.families f on f.id = c.family_id and f.deleted_at is null
  where c.id = p_card_id and c.deleted_at is null;

  if v_card.id is null then
    return null;
  end if;

  v_edits := case when jsonb_typeof(v_card.edits) = 'object' then v_card.edits else '{}'::jsonb end;
  v_choices := case when jsonb_typeof(v_edits -> 'choices') = 'object' then v_edits -> 'choices' else '{}'::jsonb end;
  v_cand_list := case jsonb_typeof(v_card.front_candidates)
    when 'array' then v_card.front_candidates
    when 'object' then case when jsonb_typeof(v_card.front_candidates -> 'candidates') = 'array'
                            then v_card.front_candidates -> 'candidates' end
  end;
  v_pick := case when jsonb_typeof(v_edits -> 'frontImage') = 'string' then v_edits ->> 'frontImage' end;
  v_pick_id := case when v_pick ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    then v_pick::uuid end;

  with cands as (
    select e.item, e.ord,
           case when (e.item ->> 'mediaId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then (e.item ->> 'mediaId')::uuid end as mid
    from jsonb_array_elements(coalesce(v_cand_list, '[]'::jsonb)) with ordinality as e(item, ord)
    where jsonb_typeof(e.item) = 'object' and jsonb_typeof(e.item -> 'mediaId') = 'string'
    order by e.ord
    limit 100
  ),
  usable as (
    select mm.id, mm.preview_object_key, mm.object_key, mm.aspect_ratio
    from public.memory_media mm
    join public.memories m on m.id = mm.memory_id
    where m.family_id = v_card.family_id
      and lower(mm.content_type) in ('image/jpeg', 'image/png', 'image/webp')
      and (mm.id = v_pick_id or mm.id in (select c.mid from cands c where c.mid is not null))
  )
  select u.id,
         coalesce(nullif(u.preview_object_key, ''), u.object_key),
         u.aspect_ratio,
         (select c.item from cands c where c.mid = u.id order by c.ord limit 1)
  into v_front_id, v_front_key, v_front_ratio, v_front_cand
  from usable u
  order by coalesce(u.id = v_pick_id, false) desc,
           (select min(c.ord) from cands c where c.mid = u.id) asc nulls last
  limit 1;

  -- Pixel size: the candidate entry (both sides > 0), else a placeholder
  -- with the picture's aspect ratio on a 3000 px long side (the editor's
  -- sizeOf), else unknown.
  if v_front_id is not null then
    v_cw := case when jsonb_typeof(v_front_cand -> 'width') = 'number' then (v_front_cand ->> 'width')::numeric end;
    v_ch := case when jsonb_typeof(v_front_cand -> 'height') = 'number' then (v_front_cand ->> 'height')::numeric end;
    if v_cw between 1 and 1000000 and v_ch between 1 and 1000000 then
      v_w := round(v_cw)::integer;
      v_h := round(v_ch)::integer;
    elsif v_front_ratio is not null and v_front_ratio > 0 then
      if v_front_ratio >= 1 then
        v_w := 3000;
        v_h := greatest(1, round(3000 / v_front_ratio))::integer;
      else
        v_w := greatest(1, round(3000 * v_front_ratio))::integer;
        v_h := 3000;
      end if;
    end if;
  end if;

  v_layout := case when v_choices ->> 'layout' in ('full-bleed', 'bordered')
                   then v_choices ->> 'layout' else 'bordered' end;
  v_orientation := case
    when v_choices ->> 'orientation' in ('landscape', 'portrait') then v_choices ->> 'orientation'
    when v_h > v_w then 'portrait'
    else 'landscape'
  end;
  v_position := case
    when v_choices ->> 'greetingPosition' in
      ('top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right')
    then v_choices ->> 'greetingPosition' else 'bottom-left' end;

  v_focal := null;
  if v_front_id is not null then
    v_focal := v_edits -> 'focalPoints' -> (v_front_id::text);
    if jsonb_typeof(v_focal) = 'object'
      and jsonb_typeof(v_focal -> 'x') = 'number' and jsonb_typeof(v_focal -> 'y') = 'number'
    then
      v_fx := (v_focal ->> 'x')::numeric;
      v_fy := (v_focal ->> 'y')::numeric;
      v_focal := jsonb_build_object('x', least(1, greatest(0, v_fx)), 'y', least(1, greatest(0, v_fy)));
    else
      v_focal := null;
    end if;
  end if;

  return jsonb_build_object(
    'card_id', v_card.id,
    'year', v_card.year,
    'image_key', v_front_key,
    'width', v_w,
    'height', v_h,
    'layout', v_layout,
    'orientation', v_orientation,
    'focal', v_focal,
    -- The row is authoritative for greeting + language (edits.choices.greeting is ignored).
    'greeting', v_card.greeting,
    'language', v_card.language,
    'greeting_text', case when jsonb_typeof(v_edits -> 'text' -> 'front.greeting') = 'string'
                          then v_edits -> 'text' ->> 'front.greeting' end,
    -- "" means the parent hid the subline: preserved, not nulled.
    'subline_text', case when jsonb_typeof(v_edits -> 'text' -> 'front.subline') = 'string'
                         then v_edits -> 'text' ->> 'front.subline' end,
    'greeting_position', v_position
  );
end;
$$;
revoke all on function public.keepsake_card_front(uuid) from public, anon, authenticated;

comment on function public.keepsake_card_front(uuid) is
  'INTERNAL (no client grant): one holiday card''s actual front (photo key, size, layout, orientation, focal point, greeting + caption overrides), shared by keepsakes_overview card_front and cards[].front. Mirrors holiday-cards/index.ts + _shared/holiday-card-snapshot.ts -- change them together.';

-- ---------------------------------------------------------------------------
-- 2. keepsake_upcoming_films: the birthday / year-end films that are coming
-- ---------------------------------------------------------------------------

-- The Keepsakes "coming up" tiles: for each Year Film the scheduler will make
-- soon, how far the pool is from the worker's floors. It PROMISES a film, so
-- every rule below is the scheduler's or the worker's, not an approximation:
--
--   Scheduling / scope  year_film_due (20260930120000_year_films_p2.sql), same
--                       expressions:
--     birthday   own child (year_film_is_own_child at the birthday), age_year
--                1..12, birthday = dob + age_year years, DUE (= scope_end_excl
--                = the day the film appears; surface_at is that day 09:00
--                owner-local) = birthday + 2 days, scope_start = dob +
--                (age_year - 1) years. TS twin: birthdayFilmScope /
--                BIRTHDAY_FILM_DAYS_AFTER = 1 (year-film-eligibility.ts).
--     family_year  scope Jan 1 -> Dec 28 (exclusive; the pool is Jan 1..Dec
--                27), made Dec 28 00:30, surfaces Dec 30 09:00 owner-local.
--                TS twin: familyYearScope / FAMILY_FILM_CUTOFF = '12-28'.
--     Neither is ever scheduled when its due date (birthday + 2 / Dec 28) is
--     before year_film_settings.launch_date ("no backfill").
--   Floors              evaluateBirthdayFilm / evaluateFamilyFilm
--                       (year-film-eligibility.ts): moments >= 60 AND visuals
--                       >= 40 AND quartersCovered >= 3 (BIRTHDAY_MIN_POOL,
--                       BIRTHDAY_MIN_VISUALS, FAMILY_MIN_POOL,
--                       FAMILY_MIN_VISUALS, YEAR_MIN_QUARTERS). The quarter
--                       rule applies to BOTH kinds, so both report quarters.
--   Pools               keepsake_pool (the worker's mapFamilyRows pool):
--     birthday   birthdayPool(.., 'exclude') as year-film-context.ts planFilm
--                calls it: memories TAGGED TO THE CHILD in scope, not
--                reported. Untagged memories do NOT count ('exclude'), so
--                keepsake_pool's p_member_id (tagged to that member) is exactly
--                the rule and needs no new mode. The scope used is the film
--                row's own (scope_start .. birthday + 2), not the bare age-year.
--     family_year  familyPool: every pooled memory in scope.
--   Quarters            evaluateMontage + quarterOf: over VISUAL pool memories
--                       whose emotion is not worry / sad (MONTAGE_EXCLUDED_
--                       EMOTIONS; 'weary' still counts), the number of distinct
--                       quarters, quarter = floor(months since the scope
--                       start's MONTH / 3) clamped to 0..3 (month granularity,
--                       days are ignored; the 2 days after a birthday fall in
--                       month 12 and clamp to quarter 3).
--
-- WHICH TILES. Both rules look at year_films rows of this family with the
-- scheduler's own key (family_id, kind, member, scope_start_date, NOT forced
-- -- operator/canary rows never take the slot, year_films_key):
--   * a tile is dropped as soon as a row exists in ANY status except
--     skipped / failed. A queued / curating / preparing / rendering / ready row
--     means the film is made (or being made) and the real film UI takes over
--     (the Timeline / Keepsakes shelf, "Remaking" placeholder). The unique key
--     means the scheduler never inserts a second row, so there is nothing left
--     to promise. A skipped / failed row is terminal and invisible to clients
--     (no ready_at), so the tile stays until its film date passes rather than
--     the shelf going blank on the day of the miss.
--   * birthday: film date within [p_today, p_today + 30] (owner-local).
--   * family_year: December 1 .. December 30 of p_today's year (the film date
--     is Dec 30, so the tile ends the day it should have appeared).
--
-- GATES (year_films_enabled's, minus the >= 10 monthly memories): rollout
-- includes the family (year_film_family_enabled), launch_date is set,
-- billing_write_allowed(owner), the family is live; the "own child" gate is
-- per film: the child itself for a birthday (isFilmChild: role rule at the
-- birthday + under 13, which age_year <= 12 guarantees), and for the year film
-- any member who is an own child AND under 13 on Dec 28 (planFilm's
-- NO_OWN_CHILDREN). The recap's "launch_date <= next 1st" gate is replaced by
-- the exact per-film rule, due date >= launch_date.
--
-- p_today (owner-local) and p_caller (whose personal blocks hide a picture, the
-- timeline rule; null = none) are parameters so pgTAP can pin dates. Counts
-- never take the caller: they must equal the worker's.
--
-- INTERNAL: security definer, takes the family id on trust -- callable only
-- from keepsakes_overview (which has checked membership).
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

-- ---------------------------------------------------------------------------
-- 3. keepsakes_overview
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
