-- Holiday Cards P2, Step 1: the database (docs/plans/holiday-cards-p2.md §4).
--
-- Adds, on top of 20261006120000_holiday_cards.sql (live):
--   1. holiday_card_settings -- the server switch (off | canary | all + closing
--      date), the ordering kill switch, the shop's ship-by note and the held-
--      canary list; + holiday_card_family_enabled / holiday_card_orders_enabled
--      / holiday_card_hold_confirm (service role).
--   2. holiday_card_summary -- the caller-facing row behind the Keepsakes tile.
--   3. Card-level checkout claim: holiday_cards.checkout_order_id /
--      checkout_claimed_at, claim_holiday_card_checkout /
--      release_holiday_card_checkout, one open 'checkout' order per card.
--   4. save_holiday_card_edits replaced: refuses under a fresh claim and once
--      the card has a paid order ('card_ordered').
--   5. web_handoff_codes + create_web_handoff / claim_web_handoff -- the
--      app -> shop sign-in handoff (cards AND Memory Books).
--
-- The new holiday_cards columns are deliberately NOT in the P1 column-level
-- SELECT grant (clients never read the claim). The settings table and the
-- handoff table are RLS-on with every client privilege revoked.
--
-- NOT applied automatically -- owner runs `supabase db push`. Rollback:
-- supabase/rollbacks/20261007120000_holiday_cards_p2_down.sql (applied by hand).

-- ---------------------------------------------------------------------------
-- 1. holiday_card_settings (the server switch) + service-role gates
-- ---------------------------------------------------------------------------

create table public.holiday_card_settings (
  id boolean primary key default true check (id),
  mode text not null default 'off' check (mode in ('off', 'canary', 'all')),
  canary_family_ids uuid[] not null default '{}',
  -- UTC calendar date; null = open. Existing cards stay reachable after it.
  closes_on date,
  -- Ordering kill switch (create_draft / quote / create_checkout).
  orders_enabled boolean not null default true,
  -- Optional checkout note, e.g. "Order by Dec 10 for Christmas delivery".
  ship_by_note text,
  -- Held canary: paid orders of these families are never confirmed at Gelato.
  hold_confirm_family_ids uuid[] not null default '{}',
  updated_at timestamptz not null default now()
);

-- The row ships in canary mode with empty lists: nobody is enabled until the
-- owner adds a family (docs/plans/holiday-cards-p2.md §6).
insert into public.holiday_card_settings (id, mode) values (true, 'canary');

create trigger set_holiday_card_settings_updated_at
  before update on public.holiday_card_settings
  for each row execute function public.set_updated_at();

alter table public.holiday_card_settings enable row level security;
revoke all on table public.holiday_card_settings from anon, authenticated;

comment on table public.holiday_card_settings is
  'Holiday card rollout switch (docs/plans/holiday-cards-p2.md §4): mode off | canary | all, closes_on, orders_enabled kill switch, ship_by_note, hold_confirm_family_ids (held canary). Single row. Service role only.';
comment on column public.holiday_card_settings.hold_confirm_family_ids is
  'Held canary: a paid order of a listed family is never confirmed at Gelato (failure_reason HELD_FOR_CANARY); the owner refunds it in Stripe. Empty this list before launch.';

-- Live family AND (all OR canary-listed) AND not past closes_on (UTC).
create or replace function public.holiday_card_family_enabled(p_family_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.holiday_card_settings s
    join public.families f on f.id = p_family_id and f.deleted_at is null
    where (
        s.mode = 'all'
        or (s.mode = 'canary' and p_family_id = any (s.canary_family_ids))
      )
      and (s.closes_on is null or (now() at time zone 'utc')::date <= s.closes_on)
  );
$$;
revoke all on function public.holiday_card_family_enabled(uuid) from public, anon, authenticated;
grant execute on function public.holiday_card_family_enabled(uuid) to service_role;

create or replace function public.holiday_card_orders_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select s.orders_enabled from public.holiday_card_settings s where s.id), false);
$$;
revoke all on function public.holiday_card_orders_enabled() from public, anon, authenticated;
grant execute on function public.holiday_card_orders_enabled() to service_role;

create or replace function public.holiday_card_hold_confirm(p_family_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select p_family_id = any (s.hold_confirm_family_ids) from public.holiday_card_settings s where s.id),
    false
  );
$$;
revoke all on function public.holiday_card_hold_confirm(uuid) from public, anon, authenticated;
grant execute on function public.holiday_card_hold_confirm(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Card-level checkout claim columns (service role only; NOT in the P1
--    column-level SELECT grant on purpose)
-- ---------------------------------------------------------------------------

alter table public.holiday_cards
  add column checkout_order_id uuid,
  add column checkout_claimed_at timestamptz;

comment on column public.holiday_cards.checkout_order_id is
  'Order holding the card-level checkout claim (claim_holiday_card_checkout). Service role only; not granted to clients.';
comment on column public.holiday_cards.checkout_claimed_at is
  'When the claim was taken/refreshed. A claim older than 10 minutes is stale (ignored by claim and save). Service role only.';

-- Backstop for the claim RPC: at most one open 'checkout' order per card.
create unique index holiday_card_orders_one_checkout_per_card
  on public.holiday_card_orders (card_id)
  where status = 'checkout';

-- ---------------------------------------------------------------------------
-- 3. holiday_card_summary (authenticated; owner/manager of a live family)
-- ---------------------------------------------------------------------------

-- One row for the Keepsakes tile: the switch (gated by billing), the newest
-- non-deleted card of ANY year (card fields null when none) and the card
-- language. Zero rows when the caller is anonymous or not an owner/manager of
-- a LIVE family (has_family_role alone lets a deleted family's owner through).
-- `ordered` spans every buyer (the card locks for the whole family).
create or replace function public.holiday_card_summary(p_family_id uuid)
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
    -- Mirrors cardLanguageFor (supabase/functions/holiday-cards/index.ts).
    case when lower(regexp_replace(coalesce(v_caption, ''), '^\s+', '')) like 'es%' then 'es' else 'en' end;
end;
$$;
revoke all on function public.holiday_card_summary(uuid) from public, anon, authenticated;
grant execute on function public.holiday_card_summary(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Card-level checkout claim RPCs (service role only)
-- ---------------------------------------------------------------------------

-- Serializes the version pin, one-open-checkout-per-card and the edit lock
-- under the card-row lock. Raises:
--   P0002 'card_not_found'              order missing / has no card / card deleted
--   40001 'CARD_CHANGED'                edits_version <> p_expected_version
--   55000 'CHECKOUT_OPEN_ELSEWHERE'     another order of the card is in 'checkout',
--                                       or another order holds a claim < 10 min old
-- On success sets the claim (re-claiming by the same order refreshes the
-- timestamp) and returns the re-read card row. Reorders of an already-ordered
-- card are allowed (only the EDIT path refuses ordered cards).
create or replace function public.claim_holiday_card_checkout(
  p_order_id uuid,
  p_expected_version integer
)
returns setof public.holiday_cards
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_card_id uuid;
  v_card public.holiday_cards;
begin
  select o.card_id into v_card_id from public.holiday_card_orders o where o.id = p_order_id;
  if v_card_id is null then
    raise exception 'card_not_found' using errcode = 'P0002', hint = 'card_not_found';
  end if;

  select * into v_card from public.holiday_cards c where c.id = v_card_id for update;
  if not found or v_card.deleted_at is not null then
    raise exception 'card_not_found' using errcode = 'P0002', hint = 'card_not_found';
  end if;

  if v_card.edits_version is distinct from p_expected_version then
    raise exception 'CARD_CHANGED' using errcode = '40001', hint = 'CARD_CHANGED';
  end if;

  if exists (
      select 1 from public.holiday_card_orders o
      where o.card_id = v_card.id and o.status = 'checkout' and o.id <> p_order_id
    )
    or (
      v_card.checkout_order_id is not null
      and v_card.checkout_order_id <> p_order_id
      and v_card.checkout_claimed_at > now() - interval '10 minutes'
    ) then
    raise exception 'CHECKOUT_OPEN_ELSEWHERE' using errcode = '55000', hint = 'CHECKOUT_OPEN_ELSEWHERE';
  end if;

  update public.holiday_cards
  set checkout_order_id = p_order_id, checkout_claimed_at = now()
  where id = v_card.id;

  return query select * from public.holiday_cards c where c.id = v_card.id;
end;
$$;
revoke all on function public.claim_holiday_card_checkout(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_holiday_card_checkout(uuid, integer) to service_role;

-- Clears the claim only if it belongs to p_order_id (a stale release can never
-- clear another order's claim). Idempotent.
create or replace function public.release_holiday_card_checkout(p_order_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.holiday_cards
  set checkout_order_id = null, checkout_claimed_at = null
  where checkout_order_id = p_order_id;
$$;
revoke all on function public.release_holiday_card_checkout(uuid) from public, anon, authenticated;
grant execute on function public.release_holiday_card_checkout(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5. save_holiday_card_edits (replaced)
-- ---------------------------------------------------------------------------

-- Body of 20261006120000_holiday_cards.sql plus, under the same card-row lock:
--   55000 'holiday_card_checkout_open'  also when a FRESH claim (< 10 min) is held
--   P0001 'card_ordered'                an order of the card is paid | submitted |
--                                       in_production | shipped (failed/cancelled
--                                       never lock)
-- Check order: not found, invalid edits, checkout open (order or claim),
-- ordered, then the version CAS. Returns the new edits_version.
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
  ) or (
    v_card.checkout_order_id is not null
    and v_card.checkout_claimed_at > now() - interval '10 minutes'
  ) then
    raise exception 'holiday_card_checkout_open' using errcode = '55000', hint = 'holiday_card_checkout_open';
  end if;
  if exists (
    select 1 from public.holiday_card_orders o
    where o.card_id = p_card_id
      and o.status in ('paid', 'submitted', 'in_production', 'shipped')
  ) then
    raise exception 'card_ordered' using errcode = 'P0001', hint = 'card_ordered';
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

-- ---------------------------------------------------------------------------
-- 6. web_handoff_codes (app -> shop sign-in handoff)
-- ---------------------------------------------------------------------------

create table public.web_handoff_codes (
  -- sha256 of a 32-byte random code (base64url). The code itself is never stored.
  code_hash text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);

create index web_handoff_codes_user_created_idx on public.web_handoff_codes (user_id, created_at);
create index web_handoff_codes_expires_idx on public.web_handoff_codes (expires_at);

alter table public.web_handoff_codes enable row level security;
revoke all on table public.web_handoff_codes from anon, authenticated;

comment on table public.web_handoff_codes is
  'Single-use, 2-minute app -> shop sign-in codes, stored hashed (docs/plans/holiday-cards-p2.md Step 2b). Service role only (create_web_handoff / claim_web_handoff).';

-- Mints the row; returns its expiry. Purges rows (any user) expired > 1 day,
-- then rate limits to 10 rows per user per 10 minutes:
--   P0001 'rate_limited' (hint 'rate_limited').
-- A per-user advisory lock makes the count-then-insert race-free.
create or replace function public.create_web_handoff(p_user_id uuid, p_code_hash text)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expires timestamptz := now() + interval '2 minutes';
begin
  delete from public.web_handoff_codes where expires_at < now() - interval '1 day';

  perform pg_advisory_xact_lock(hashtextextended('web_handoff:' || p_user_id::text, 0));
  if (
    select count(*) from public.web_handoff_codes w
    where w.user_id = p_user_id and w.created_at > now() - interval '10 minutes'
  ) >= 10 then
    raise exception 'rate_limited' using errcode = 'P0001', hint = 'rate_limited';
  end if;

  insert into public.web_handoff_codes (code_hash, user_id, expires_at)
  values (p_code_hash, p_user_id, v_expires);
  return v_expires;
end;
$$;
revoke all on function public.create_web_handoff(uuid, text) from public, anon, authenticated;
grant execute on function public.create_web_handoff(uuid, text) to service_role;

-- Single winner, DB clock: returns the user id, or NULL when the code is
-- unknown, used or expired.
create or replace function public.claim_web_handoff(p_code_hash text)
returns uuid
language sql
security definer
set search_path = ''
as $$
  update public.web_handoff_codes
  set used_at = now()
  where code_hash = p_code_hash
    and used_at is null
    and expires_at > now()
  returning user_id;
$$;
revoke all on function public.claim_web_handoff(text) from public, anon, authenticated;
grant execute on function public.claim_web_handoff(text) to service_role;
