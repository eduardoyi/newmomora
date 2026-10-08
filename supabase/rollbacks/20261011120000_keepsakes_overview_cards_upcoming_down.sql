-- ROLLBACK for 20261011120000_keepsakes_overview_cards_upcoming.sql.
--
-- Applied BY HAND (psql / the Supabase SQL editor), NEVER by `supabase db push`
-- or `supabase db reset` (it lives outside supabase/rollbacks on purpose).
-- Run it in one transaction; written to be re-runnable (IF EXISTS).
--
-- Restores keepsakes_overview to its 20261010120000 definition (`card_front`
-- inline, no `cards` / `upcoming_films` keys) and drops the two internal
-- helpers. Same signature, so CREATE OR REPLACE swaps the body in place; grants
-- are re-asserted below. Roll the app OTA back FIRST (or accept that the
-- missing keys degrade: the app treats absent `cards` / `upcoming_films` as
-- empty).

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
  -- card_front
  v_card public.holiday_cards;
  v_card_front jsonb := null;
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
    -- family), and the front the editor shows for it. Mirrors:
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
    select * into v_card
    from public.holiday_cards c
    where c.family_id = p_family_id and c.deleted_at is null
    order by c.created_at desc, c.id desc
    limit 1;

    if v_card.id is not null and v_owner is not null then
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
        where m.family_id = p_family_id
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

      v_card_front := jsonb_build_object(
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
    end if;

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
    'orders', v_orders,
    'card_front', v_card_front
  );
end;
$$;
revoke all on function public.keepsakes_overview(uuid) from public, anon, authenticated;
grant execute on function public.keepsakes_overview(uuid) to authenticated;

comment on function public.keepsakes_overview(uuid) is
  'Keepsakes tab overview (docs/plans/keepsakes-redesign.md): recap tile progress + picture, and for owners/managers the privacy/holiday/preview/order extras plus card_front (the newest holiday card''s actual front). Member-only; viewers get recap only.';

-- The helpers are only referenced by the new function body, replaced above.
drop function if exists public.keepsake_upcoming_films(uuid, uuid, date);
drop function if exists public.keepsake_card_front(uuid);

commit;
