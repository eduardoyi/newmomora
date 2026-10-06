-- Holiday Cards: card readiness (owner decision 2026-10-06). A card is NOT shown
-- as editable/orderable until its film is done: the app + shop show "Preparing
-- (~20 min)" and the creator gets a push when it becomes ready.
--
--   1. holiday_cards.ready_notified_at -- the "your card is ready" push dedupe
--      marker (CAS-set by sweep-holiday-card-orders BEFORE it sends). Service
--      role only: deliberately NOT in the P1 column-level SELECT grant.
--   2. holiday_card_readiness(card) -> generating | film | ready | failed
--      (service role; also called from holiday_card_summary, a definer).
--   3. holiday_card_summary recreated with a `readiness` column (body copied
--      from 20261007120000_holiday_cards_p2.sql, otherwise identical).
--
-- NOT applied automatically -- owner runs `supabase db push`. Rollback:
-- supabase/rollbacks/20261008120000_holiday_card_readiness_down.sql (by hand).

-- ---------------------------------------------------------------------------
-- 1. ready_notified_at (service role only)
-- ---------------------------------------------------------------------------

alter table public.holiday_cards
  add column ready_notified_at timestamptz;

comment on column public.holiday_cards.ready_notified_at is
  'When the "your holiday card is ready" push was claimed (sweep-holiday-card-orders, CAS before sending). Service role only; not granted to clients.';

-- ---------------------------------------------------------------------------
-- 2. holiday_card_readiness
-- ---------------------------------------------------------------------------

-- 'generating'  card status generating (letters / front still being made)
-- 'failed'      card status failed
-- 'ready'       card status ready AND any of:
--                 * no film (a card below the film floors was ready in ~2 min)
--                 * the film is published (video + ready_at, not blocked, not ended)
--                 * the film is blocked (content removed/reported: prints without QR)
--                 * the film failed / was skipped / ended without a published
--                   video (prints without QR)
--                 * the card is older than 75 minutes (safety valve: a stuck film
--                   can never hold a card hostage)
-- 'film'        card ready but its film is still being made ("Preparing")
-- NULL          unknown card.
create or replace function public.holiday_card_readiness(p_card_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_card public.holiday_cards;
  v_film public.year_films;
begin
  select * into v_card from public.holiday_cards c where c.id = p_card_id;
  if not found then
    return null;
  end if;
  if v_card.status = 'generating' then
    return 'generating';
  end if;
  if v_card.status = 'failed' then
    return 'failed';
  end if;

  -- status = 'ready' from here on.
  if v_card.film_id is null then
    return 'ready';
  end if;
  if v_card.created_at < now() - interval '75 minutes' then
    return 'ready';
  end if;

  select * into v_film from public.year_films y where y.id = v_card.film_id;
  if not found then
    return 'ready';
  end if;

  if v_film.blocked then
    return 'ready';
  end if;
  if v_film.status in ('failed', 'skipped', 'ended') then
    return 'ready';
  end if;
  if v_film.video_key is not null and v_film.ready_at is not null then
    return 'ready';
  end if;
  return 'film';
end;
$$;
revoke all on function public.holiday_card_readiness(uuid) from public, anon, authenticated;
grant execute on function public.holiday_card_readiness(uuid) to service_role;

-- Cards that are already past their film today must not push after deploy.
update public.holiday_cards c
set ready_notified_at = now()
where c.status = 'ready'
  and c.film_id is not null
  and c.ready_notified_at is null
  and public.holiday_card_readiness(c.id) = 'ready';

-- ---------------------------------------------------------------------------
-- 3. holiday_card_summary (+ readiness)
-- ---------------------------------------------------------------------------

-- The return type changes, so it cannot be CREATE OR REPLACE'd.
drop function public.holiday_card_summary(uuid);

-- Same rules as 20261007120000: one row for the Keepsakes tile, zero rows when
-- the caller is anonymous or not an owner/manager of a LIVE family. New:
-- `readiness` (generating | film | ready | failed; null when no card), so the
-- tile can show "Preparing" while the film renders.
create function public.holiday_card_summary(p_family_id uuid)
returns table (
  enabled boolean,
  card_id uuid,
  year integer,
  status text,
  last_failure_code text,
  ordered boolean,
  language text,
  readiness text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_card public.holiday_cards;
  v_caption text;
  v_enabled boolean;
  v_ordered boolean := false;
  v_readiness text;
begin
  if v_uid is null or public.is_anonymous_user() then
    return;
  end if;

  select f.gallery_caption_language into v_caption
  from public.families f
  where f.id = p_family_id and f.deleted_at is null;
  if not found or not public.has_family_role(p_family_id, array['owner', 'manager']) then
    return;
  end if;

  select * into v_card
  from public.holiday_cards c
  where c.family_id = p_family_id and c.deleted_at is null
  order by c.created_at desc, c.id desc
  limit 1;

  if v_card.id is not null then
    select exists (
      select 1 from public.holiday_card_orders o
      where o.card_id = v_card.id
        and o.status in ('paid', 'submitted', 'in_production', 'shipped')
    ) into v_ordered;
    v_readiness := public.holiday_card_readiness(v_card.id);
  end if;

  v_enabled := public.holiday_card_family_enabled(p_family_id)
    and public.billing_write_allowed(p_family_id, v_uid);

  return query select
    v_enabled,
    v_card.id,
    v_card.year,
    v_card.status,
    v_card.last_failure_code,
    v_ordered,
    -- Mirrors cardLanguageFor (supabase/functions/holiday-cards/index.ts).
    case when lower(regexp_replace(coalesce(v_caption, ''), '^\s+', '')) like 'es%' then 'es' else 'en' end,
    v_readiness;
end;
$$;
revoke all on function public.holiday_card_summary(uuid) from public, anon, authenticated;
grant execute on function public.holiday_card_summary(uuid) to authenticated;
