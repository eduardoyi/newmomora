-- ROLLBACK for 20261007120000_holiday_cards_p2.sql.
--
-- Applied BY HAND (psql / the Supabase SQL editor), NEVER by `supabase db push`
-- or `supabase db reset` (it lives outside supabase/migrations on purpose).
-- Run it in one transaction; it is written to be re-runnable (IF EXISTS).
--
-- Restores save_holiday_card_edits to the definition in force immediately
-- before the migration (20261006120000_holiday_cards.sql), and drops
-- everything the migration ADDED:
--   * holiday_card_settings (the rollout switch -- the switch, kill switch and
--     hold list are LOST; note them first) and its three gate functions
--   * holiday_card_summary
--   * holiday_cards.checkout_order_id / checkout_claimed_at, the claim /
--     release RPCs and the one-checkout-per-card unique index
--   * web_handoff_codes (pending handoff codes are discarded) and its RPCs
-- Roll the app OTA, the shop and the Edge Functions back FIRST (they call
-- these functions); see docs/plans/holiday-cards-p2.md Step 8.

begin;

-- 1. Restore the P1 save_holiday_card_edits body (no claim / card_ordered checks).
create or replace function public.save_holiday_card_edits(
  p_card_id uuid,
  p_expected_version integer,
  p_edits jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_card public.holiday_cards;
begin
  select * into v_card from public.holiday_cards c where c.id = p_card_id for update;
  if not found or v_card.deleted_at is not null then
    raise exception 'holiday_card_not_found' using errcode = 'P0002', hint = 'holiday_card_not_found';
  end if;
  if p_edits is null or jsonb_typeof(p_edits) <> 'object' then
    raise exception 'invalid_edits' using errcode = '22023', hint = 'invalid_edits';
  end if;
  if exists (
    select 1 from public.holiday_card_orders o
    where o.card_id = p_card_id and o.status = 'checkout'
  ) then
    raise exception 'holiday_card_checkout_open' using errcode = '55000', hint = 'holiday_card_checkout_open';
  end if;
  if v_card.edits_version is distinct from p_expected_version then
    raise exception 'edits_version_mismatch' using errcode = '40001', hint = 'edits_version_mismatch';
  end if;

  update public.holiday_cards
  set edits = p_edits, edits_version = edits_version + 1
  where id = p_card_id;
  return v_card.edits_version + 1;
end;
$$;
revoke all on function public.save_holiday_card_edits(uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.save_holiday_card_edits(uuid, integer, jsonb) to service_role;

-- 2. Handoff
drop function if exists public.claim_web_handoff(text);
drop function if exists public.create_web_handoff(uuid, text);
drop table if exists public.web_handoff_codes;

-- 3. Card-level checkout claim
drop function if exists public.release_holiday_card_checkout(uuid);
drop function if exists public.claim_holiday_card_checkout(uuid, integer);
drop index if exists public.holiday_card_orders_one_checkout_per_card;
alter table public.holiday_cards
  drop column if exists checkout_order_id,
  drop column if exists checkout_claimed_at;

-- 4. Summary + settings
drop function if exists public.holiday_card_summary(uuid);
drop function if exists public.holiday_card_hold_confirm(uuid);
drop function if exists public.holiday_card_orders_enabled();
drop function if exists public.holiday_card_family_enabled(uuid);
drop table if exists public.holiday_card_settings;

commit;
