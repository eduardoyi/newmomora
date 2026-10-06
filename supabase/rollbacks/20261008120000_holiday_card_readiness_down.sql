-- ROLLBACK for 20261008120000_holiday_card_readiness.sql.
--
-- Applied BY HAND (psql / the Supabase SQL editor), NEVER by `supabase db push`
-- or `supabase db reset` (it lives outside supabase/migrations on purpose).
-- Run it in one transaction; written to be re-runnable (IF EXISTS).
--
-- Restores holiday_card_summary to the definition of 20261007120000_holiday_cards_p2.sql
-- (no `readiness` column) and drops holiday_card_readiness and
-- holiday_cards.ready_notified_at (the "card ready" push dedupe markers are lost).
-- Roll the Edge Functions (holiday-cards `get`, sweep-holiday-card-orders), the
-- shop and the app OTA back FIRST: they read `readiness` / call the RPC.

begin;

drop function if exists public.holiday_card_summary(uuid);

create function public.holiday_card_summary(p_family_id uuid)
returns table (
  enabled boolean,
  card_id uuid,
  year integer,
  status text,
  last_failure_code text,
  ordered boolean,
  language text
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
    case when lower(regexp_replace(coalesce(v_caption, ''), '^\s+', '')) like 'es%' then 'es' else 'en' end;
end;
$$;
revoke all on function public.holiday_card_summary(uuid) from public, anon, authenticated;
grant execute on function public.holiday_card_summary(uuid) to authenticated;

drop function if exists public.holiday_card_readiness(uuid);
alter table public.holiday_cards drop column if exists ready_notified_at;

commit;
