-- Holiday Cards P1, Step 1: the database (docs/plans/holiday-cards-p1.md §2-§4).
--
-- A parent (owner/manager) creates ONE holiday card per family per year; the
-- server picks front-photo candidates, renders the card's holiday film on
-- demand (a forced family_holiday year_films row), mints the public QR link
-- (film_share_tokens) and writes letters. Ordering lives in a separate table
-- (holiday_card_orders) so the live book flow stays untouched.
--
-- Owner decisions 2026-10-06 baked in here: US/CA only; ONE card per family
-- per year, counting a soft-deleted card (delete + create must not be a free
-- rewrite); NO letter regenerations, NO film refreshes, NO illustrated front
-- (so no counter columns for any of them); the greeting is fixed at creation;
-- the card film is card-only (never in Keepsakes/Timeline).
--
-- Sections:
--   1. holiday_cards (+ column grants, RLS)
--   2. holiday_card_orders (+ column grants, RLS)
--   3. year_films: terminal 'ended' status, card-film SELECT branch,
--      year_film_invalidate skips ended, save_year_film_edits refuses forced
--   4. Card RPCs (service role): create / save edits / generation attempt /
--      create film / end film; claim_year_film_by_id
--   5. ai_usage_events operations
--   6. claim_family_deletion_fence: waits for card generation + unfetched paid
--      orders
--   7. pg_cron schedule for sweep-holiday-card-orders
--
-- The generation Workflow runs in the existing year-film worker and signs
-- through the existing workflow-year-film-bridge, so there is NO new nonce
-- table (year_film_bridge_nonces is reused).
--
-- NOT applied automatically -- owner runs `supabase db push`. Rollback:
-- supabase/rollbacks/20261006120000_holiday_cards_down.sql (applied by hand).

-- ---------------------------------------------------------------------------
-- 1. holiday_cards
-- ---------------------------------------------------------------------------

create table public.holiday_cards (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id) on delete cascade,
  -- Nullable-on-delete like memory_book_orders.requested_by: a departed
  -- account must not block or cascade through a card record.
  created_by uuid references auth.users (id) on delete set null,
  year integer not null check (year between 2020 and 2100),
  status text not null default 'generating'
    check (status in ('generating', 'ready', 'failed')),
  -- Same two languages as year_films.language (the film is written in it).
  language text not null default 'en' check (language in ('en', 'es')),
  locale text,
  -- The card's film. SET NULL: a film row is never deleted by the card flow
  -- (it is `ended`), but the link must never block a cascade.
  film_id uuid references public.year_films (id) on delete set null,
  -- Minted in the same transaction as the film (create_holiday_card_film);
  -- film_share_tokens.token is the source of truth for revocation.
  share_token text check (share_token is null or share_token ~ '^[A-Za-z0-9]{22}$'),
  -- Single source of the greeting: baked into the film's end card, fixed at
  -- creation (no refreshes), shown read-only in the editor.
  greeting text not null check (greeting in ('christmas', 'holidays', 'new-year')),
  -- Ranked media ids + verdict summary (no free text).
  front_candidates jsonb,
  -- Letter variants: tone + text + soft flags.
  letters jsonb,
  qr_caption text,
  signature text,
  -- Facts + evidence ids the writer used. Service role only (never granted).
  editor_facts jsonb,
  -- CardEdits + optimistic concurrency (memory_book_edits is last-write-wins).
  edits jsonb not null default '{}'::jsonb,
  edits_version integer not null default 0 check (edits_version >= 0),
  -- System retries of generation, capped by increment_holiday_card_generation_attempt.
  generation_attempts integer not null default 0 check (generation_attempts >= 0),
  last_failure_code text,
  -- Generation lease (service role only): Workflow instance, attempt CAS id
  -- and the heartbeat claim_family_deletion_fence / the sweep read.
  workflow_instance_id text,
  attempt_id uuid,
  heartbeat_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint holiday_cards_edits_is_object check (jsonb_typeof(edits) = 'object')
);

-- One card per family per year, INCLUDING soft-deleted rows: deleting a card
-- does not free the slot.
create unique index holiday_cards_family_year_key on public.holiday_cards (family_id, year);
create unique index holiday_cards_film_id_key on public.holiday_cards (film_id) where film_id is not null;
create unique index holiday_cards_share_token_key on public.holiday_cards (share_token) where share_token is not null;
create index holiday_cards_generating_idx on public.holiday_cards (heartbeat_at) where status = 'generating';

create trigger set_holiday_cards_updated_at
  before update on public.holiday_cards
  for each row execute function public.set_updated_at();

comment on table public.holiday_cards is
  'One holiday card per family per year (docs/plans/holiday-cards-p1.md). Owners/managers read a safe column subset; every write is service role (create_holiday_card / save_holiday_card_edits / the generation Workflow). film_state is derived on read from year_films, never stored.';
comment on column public.holiday_cards.year is
  'Card year. Unique per family INCLUDING soft-deleted rows (deleting does not free the slot).';
comment on column public.holiday_cards.greeting is
  'christmas | holidays | new-year. Single source: fixed at creation, baked into the film end card.';
comment on column public.holiday_cards.editor_facts is
  'Facts + evidence ids from the letter editor. Not granted to clients.';
comment on column public.holiday_cards.edits_version is
  'Compare-and-set counter for save_holiday_card_edits.';
comment on column public.holiday_cards.heartbeat_at is
  'Generation lease heartbeat (service role). claim_family_deletion_fence waits while status = generating and this is under 20 minutes old.';

alter table public.holiday_cards enable row level security;

revoke all on table public.holiday_cards from anon, authenticated;
-- Column-level read (the year_films pattern): never editor_facts or the lease.
grant select (
  id, family_id, created_by, year, status, language, locale, film_id, share_token,
  greeting, front_candidates, letters, qr_caption, signature, edits, edits_version,
  generation_attempts, last_failure_code, created_at, updated_at, deleted_at
) on public.holiday_cards to authenticated;

create policy "Holiday cards: select" on public.holiday_cards
  for select
  using (
    public.has_family_role(family_id, array['owner', 'manager'])
    and deleted_at is null
  );

create policy "Holiday cards: deny anonymous" on public.holiday_cards
  as restrictive for all to authenticated
  using (not public.is_anonymous_user())
  with check (not public.is_anonymous_user());

-- ---------------------------------------------------------------------------
-- 2. holiday_card_orders
-- ---------------------------------------------------------------------------

create table public.holiday_card_orders (
  id uuid primary key default gen_random_uuid(),
  -- SET NULL, not RESTRICT/CASCADE: an order is a purchase record that must
  -- survive a card deletion, and RESTRICT would trip family deletion.
  card_id uuid references public.holiday_cards (id) on delete set null,
  family_id uuid not null references public.families (id) on delete cascade,
  requested_by uuid references auth.users (id) on delete set null,
  status text not null default 'draft'
    check (status in (
      'draft', 'quoted', 'checkout', 'paid', 'submitted', 'in_production',
      'shipped', 'failed', 'cancelled'
    )),
  -- Set by the quote op (never by a client write); free text so the product
  -- map stays data-driven (docs/plans/holiday-cards-p1.md §2 Markets).
  region text,
  format text,
  product_uid text,
  file_layout text,
  -- Number of 10-card packs (quantity = packs * 10); validated by the quote op.
  packs integer check (packs is null or packs > 0),
  currency text,
  price_cents integer check (price_cents is null or price_cents >= 0),
  -- Internal (margin): never granted to clients.
  gelato_cost_cents integer check (gelato_cost_cents is null or gelato_cost_cents >= 0),
  shipping_address jsonb,
  -- Frozen at create_checkout: what prints can't change after a quote.
  card_snapshot jsonb,
  snapshot_hash text,
  -- Rendered print files: keys + sha256. Service role only.
  print_files jsonb,
  -- The Gelato draft id, created at checkout; gelato_status is Gelato's own.
  gelato_order_id text,
  gelato_status text,
  tracking_number text,
  tracking_url text,
  carrier text,
  shipped_at timestamptz,
  stripe_session_id text unique,
  stripe_payment_intent_id text,
  refunded_at timestamptz,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint holiday_card_orders_shipping_address_is_object check (
    shipping_address is null or jsonb_typeof(shipping_address) = 'object'
  ),
  constraint holiday_card_orders_card_snapshot_is_object check (
    card_snapshot is null or jsonb_typeof(card_snapshot) = 'object'
  ),
  constraint holiday_card_orders_failed_has_reason check (
    status <> 'failed' or failure_reason is not null
  ),
  -- Everything past 'draft' carries the quote bundle (written together by
  -- the quote op); 'failed' and 'cancelled' can happen at any point.
  constraint holiday_card_orders_quoted_has_quote check (
    status not in ('quoted', 'checkout', 'paid', 'submitted', 'in_production', 'shipped')
    or (price_cents is not null and packs is not null and shipping_address is not null)
  ),
  -- The snapshot is frozen when the Checkout session is created.
  constraint holiday_card_orders_checkout_has_snapshot check (
    status not in ('checkout', 'paid', 'submitted', 'in_production', 'shipped')
    or (card_snapshot is not null and snapshot_hash is not null)
  )
);

create index holiday_card_orders_family_id_idx on public.holiday_card_orders (family_id);
create index holiday_card_orders_card_id_idx on public.holiday_card_orders (card_id);
create index holiday_card_orders_requested_by_idx on public.holiday_card_orders (requested_by);
create index holiday_card_orders_payment_intent_idx on public.holiday_card_orders (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;
-- Sweep surface: orders that still need Stripe/Gelato attention.
create index holiday_card_orders_active_status_idx on public.holiday_card_orders (status)
  where status in ('quoted', 'checkout', 'paid', 'submitted', 'in_production');

create trigger set_holiday_card_orders_updated_at
  before update on public.holiday_card_orders
  for each row execute function public.set_updated_at();

comment on table public.holiday_card_orders is
  'One row per holiday-card purchase attempt (docs/plans/holiday-cards-p1.md §4). Client INSERTs a bare draft (owner/manager, buyer = self); every other field and transition is service role. SELECT is buyer-only (the row carries a home address and Stripe ids) -- other managers learn about an open checkout only through the card''s has_open_checkout flag.';
comment on column public.holiday_card_orders.gelato_cost_cents is
  'Internal Gelato cost; not granted to clients.';
comment on column public.holiday_card_orders.print_files is
  'Print-file keys + sha256 under print-orders/<orderId>/; not granted to clients.';
comment on column public.holiday_card_orders.gelato_order_id is
  'Gelato draft id, created at checkout (before payment); confirmed with one PATCH after payment.';
comment on column public.holiday_card_orders.packs is
  'Number of 10-card packs (quantity = packs * 10).';

alter table public.holiday_card_orders enable row level security;

-- Buyer only, like memory_book_orders: the row holds the buyer's address and
-- Stripe ids, which the rest of the family must not see.
create policy "Holiday card orders: select" on public.holiday_card_orders
  for select using (requested_by = auth.uid());

-- Bare draft only (memory_book_orders' WITH CHECK pattern): an owner/manager
-- of the family claiming themselves as buyer, card_id verified to belong to
-- the same family (cross-family lesson), every server field null/default.
create policy "Holiday card orders: insert" on public.holiday_card_orders
  for insert
  with check (
    requested_by = auth.uid()
    and public.has_family_role(family_id, array['owner', 'manager'])
    and exists (
      select 1 from public.holiday_cards c
      where c.id = card_id
        and c.family_id = holiday_card_orders.family_id
        and c.deleted_at is null
    )
    and status = 'draft'
    and region is null
    and format is null
    and product_uid is null
    and file_layout is null
    and packs is null
    and currency is null
    and price_cents is null
    and gelato_cost_cents is null
    and shipping_address is null
    and card_snapshot is null
    and snapshot_hash is null
    and print_files is null
    and gelato_order_id is null
    and gelato_status is null
    and tracking_number is null
    and tracking_url is null
    and carrier is null
    and shipped_at is null
    and stripe_session_id is null
    and stripe_payment_intent_id is null
    and refunded_at is null
    and failure_reason is null
  );

create policy "Holiday card orders: deny anonymous" on public.holiday_card_orders
  as restrictive for all to authenticated
  using (not public.is_anonymous_user())
  with check (not public.is_anonymous_user());

-- No client UPDATE or DELETE policy at all (service role only). Unlike the
-- book table the grants are column-level: gelato_cost_cents (margin) and
-- print_files stay unreadable even to the buyer, and a client insert can only
-- name its own identity columns -- a second, independent block on top of the
-- WITH CHECK above.
revoke all on table public.holiday_card_orders from anon, authenticated;
grant select (
  id, card_id, family_id, requested_by, status, region, format, product_uid,
  file_layout, packs, currency, price_cents, shipping_address, card_snapshot,
  snapshot_hash, gelato_order_id, gelato_status, tracking_number, tracking_url,
  carrier, shipped_at, stripe_session_id, stripe_payment_intent_id, refunded_at,
  failure_reason, created_at, updated_at
) on public.holiday_card_orders to authenticated;
grant insert (id, card_id, family_id, requested_by) on public.holiday_card_orders to authenticated;

-- ---------------------------------------------------------------------------
-- 3. year_films: ended, card-film SELECT branch, forced films not editable
-- ---------------------------------------------------------------------------

-- 3a. Terminal `ended` status (used only when a card is deleted:
-- end_holiday_card_film). A status value is the least invasive representation:
-- every scheduler/recovery function already filters by an explicit status
-- list that does not contain it --
--   claim_year_film_dispatch        status = 'queued'
--   year_film_promote_requeues      status in ('ready', 'skipped', 'failed')
--   year_film_recover               status in ('curating', 'preparing', 'rendering')
--   year_film_recheck_skipped       status = 'skipped'
--   heartbeat / save_curation / save_checks / set_status / claim_render_slot /
--   publish_year_film / year_film_end_cycle   require an in-flight status AND
--                                   a matching attempt_id (cleared on end)
-- so an ended film is skipped everywhere without touching them. Only
-- year_film_invalidate gets an explicit guard (3c), because it keys on
-- video_key rather than status.
alter table public.year_films
  drop constraint year_films_status_check;
alter table public.year_films
  add constraint year_films_status_check
  check (status in ('queued', 'curating', 'preparing', 'rendering', 'ready', 'skipped', 'failed', 'ended'));

-- 3b. Card-film SELECT branch. The first branch is the live policy from
-- 20260930180000_year_films_remaking_visibility.sql, unchanged. The new branch
-- lets owners/managers read a film referenced by a non-deleted card of their
-- family. The subquery runs under the caller's own holiday_cards RLS (same
-- role rule), column grants still hide keys/scripts, and the app keeps
-- filtering family_holiday out of Keepsakes/Timeline (YEAR_FILM_KINDS).
drop policy "Year films: select" on public.year_films;
create policy "Year films: select" on public.year_films
  for select
  using (
    (
      public.is_family_member(family_id)
      and ready_at is not null
      and not forced
      and (surface_at <= now() or public.has_family_role(family_id, array['owner', 'manager']))
    )
    or exists (
      select 1
      from public.holiday_cards c
      where c.film_id = year_films.id
        and c.deleted_at is null
        and public.has_family_role(c.family_id, array['owner', 'manager'])
    )
  );

-- 3c. year_film_invalidate: body identical to 20260929120000_year_films.sql
-- plus `status <> 'ended'` (an ended film must never be re-queued by a
-- late invalidation, whatever its keys).
create or replace function public.year_film_invalidate(p_film_ids uuid[], p_block boolean)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_film_ids is null or cardinality(p_film_ids) = 0 then
    return 0;
  end if;
  set local lock_timeout = '5s';
  update public.year_films
  set content_epoch = content_epoch + 1,
      blocked = blocked or p_block,
      stale = true,
      requeue_after = coalesce(requeue_after, now() + interval '15 minutes'),
      updated_at = now()
  where id = any (p_film_ids)
    and status <> 'ended'
    and (video_key is not null or status in ('queued', 'curating', 'preparing', 'rendering'));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.year_film_invalidate(uuid[], boolean) from public, anon, authenticated;
grant execute on function public.year_film_invalidate(uuid[], boolean) to service_role;

-- 3d. save_year_film_edits: forced (operator / holiday-card) films are not
-- editable by clients. Card owners/managers can now READ their card film
-- (3b), so without this guard a manager could queue a re-render of it
-- ("no film refreshes", owner 2026-10-06) and burn the daily render budget.
-- Body identical to 20260930150000_year_film_edit_options.sql except the
-- `or v_film.forced` in the first guard; same refusal as
-- get_year_film_edit_options (42501, so a forced film's existence isn't
-- confirmed to a caller).
create or replace function public.save_year_film_edits(p_film_id uuid, p_edits jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_film public.year_films;
  v_removed uuid[];
  v_previously_removed uuid[];
  v_quote jsonb;
  v_bed text;
  v_removing boolean;
  v_merged jsonb;
begin
  if v_uid is null or public.is_anonymous_user() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  select * into v_film from public.year_films where id = p_film_id for update;
  if not found or v_film.forced or not public.has_family_role(v_film.family_id, array['owner', 'manager']) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if not public.billing_write_allowed_for_current_user(v_film.family_id) then
    raise exception 'Subscription required' using errcode = '42501';
  end if;
  if v_film.status <> 'ready' or v_film.video_key is null then
    raise exception 'film_not_editable' using errcode = '55000', hint = 'film_not_editable';
  end if;
  if jsonb_typeof(p_edits) <> 'object' then
    raise exception 'invalid_edits' using errcode = '22023', hint = 'invalid_edits';
  end if;

  v_previously_removed := coalesce(
    array(select jsonb_array_elements_text(coalesce(v_film.edits -> 'removedMemoryIds', '[]'::jsonb)))::uuid[],
    '{}'
  );
  v_removed := coalesce(array(select jsonb_array_elements_text(coalesce(p_edits -> 'removedMemoryIds', '[]'::jsonb)))::uuid[], '{}');
  if not (v_removed <@ (v_film.referenced_memory_ids || v_previously_removed)) then
    raise exception 'invalid_edits' using errcode = '22023', hint = 'removed_memory_not_in_film';
  end if;
  v_quote := p_edits -> 'quote';
  if v_quote is not null and jsonb_typeof(v_quote) <> 'null' and not exists (
    select 1 from jsonb_array_elements(coalesce(v_film.quote_candidates, '[]'::jsonb)) c
    where c ->> 'memoryId' = v_quote ->> 'memoryId' and c ->> 'textHash' = v_quote ->> 'textHash'
  ) then
    raise exception 'invalid_edits' using errcode = '22023', hint = 'quote_not_a_candidate';
  end if;
  v_bed := p_edits ->> 'musicBedId';
  if v_bed is not null and not (v_bed = any (public.year_film_bed_ids())) then
    raise exception 'invalid_edits' using errcode = '22023', hint = 'unknown_music_bed';
  end if;

  if (select count(*) from public.year_film_render_requests
      where film_id = p_film_id and created_at > now() - interval '1 day') >= 5
     or (select count(*) from public.year_film_render_requests
         where family_id = v_film.family_id and created_at > now() - interval '1 day') >= 20 then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited');
  end if;

  v_removing := cardinality(array(
    select unnest(v_removed)
    except
    select unnest(v_previously_removed)
  )) > 0;

  v_merged := v_film.edits
    || jsonb_build_object('removedMemoryIds', to_jsonb(v_removed))
    || case when p_edits ? 'quote' then jsonb_build_object('quote', v_quote) else '{}'::jsonb end
    || case when v_bed is not null then jsonb_build_object('musicBedId', v_bed) else '{}'::jsonb end;

  insert into public.year_film_render_requests (film_id, family_id, requested_by)
  values (p_film_id, v_film.family_id, v_uid);

  update public.year_films
  set edits = v_merged,
      edits_version = edits_version + 1,
      music_bed_id = coalesce(v_bed, music_bed_id),
      stale = true,
      blocked = blocked or v_removing,
      status = 'queued', attempt_count = 0, attempt_id = null,
      next_attempt_at = null, requeue_after = null, updated_at = now()
  where id = p_film_id;

  return jsonb_build_object('ok', true, 'edits_version', v_film.edits_version + 1);
end;
$$;
revoke all on function public.save_year_film_edits(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.save_year_film_edits(uuid, jsonb) to authenticated;


-- ---------------------------------------------------------------------------
-- 4. Card RPCs (service role only; called by the holiday-cards Edge Function,
--    the generation Workflow's bridge ops and the sweep)
-- ---------------------------------------------------------------------------

-- 22-char base62 token, same alphabet/length as the application-side
-- generator and the film_share_tokens_token_format check. Rejection sampling
-- (bytes >= 248 are dropped) keeps it unbiased. Internal: only the definer
-- functions below call it.
create or replace function public.holiday_card_new_share_token()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_alphabet constant text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  v_token text := '';
  v_bytes bytea;
  v_byte integer;
begin
  while length(v_token) < 22 loop
    v_bytes := extensions.gen_random_bytes(32);
    for i in 0..31 loop
      v_byte := get_byte(v_bytes, i);
      if v_byte < 248 and length(v_token) < 22 then
        v_token := v_token || substr(v_alphabet, (v_byte % 62) + 1, 1);
      end if;
    end loop;
  end loop;
  return v_token;
end;
$$;
revoke all on function public.holiday_card_new_share_token() from public, anon, authenticated;

-- Creates the family's card for p_year, or returns the existing one (a double
-- tap / retry is idempotent: the unique (family_id, year) index decides, so
-- concurrent calls insert exactly one row). The caller must be an
-- owner/manager of a live family (re-checked here; the Edge Function also
-- checks billing and the region guess). A fresh row is status 'generating'
-- with generation_attempts = 0 -- the Edge Function claims the dispatch with
-- increment_holiday_card_generation_attempt, which is the real double-dispatch
-- guard. If the slot is taken by a SOFT-DELETED card the year stays used:
-- raises 23505 'holiday_card_slot_used' (hint 'holiday_card_slot_used').
create or replace function public.create_holiday_card(
  p_family_id uuid,
  p_user_id uuid,
  p_year integer,
  p_greeting text,
  p_language text,
  p_locale text
)
returns public.holiday_cards
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_card public.holiday_cards;
begin
  if not exists (
    select 1
    from public.family_memberships m
    join public.families f on f.id = m.family_id and f.deleted_at is null
    where m.family_id = p_family_id and m.user_id = p_user_id
      and m.role in ('owner', 'manager')
  ) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  insert into public.holiday_cards (family_id, created_by, year, greeting, language, locale)
  values (p_family_id, p_user_id, p_year, p_greeting, p_language, p_locale)
  on conflict (family_id, year) do nothing
  returning * into v_card;

  if not found then
    select * into v_card
    from public.holiday_cards c
    where c.family_id = p_family_id and c.year = p_year;
    if v_card.deleted_at is not null then
      raise exception 'holiday_card_slot_used' using errcode = '23505', hint = 'holiday_card_slot_used';
    end if;
  end if;
  return v_card;
end;
$$;
revoke all on function public.create_holiday_card(uuid, uuid, integer, text, text, text) from public, anon, authenticated;
grant execute on function public.create_holiday_card(uuid, uuid, integer, text, text, text) to service_role;

-- Optimistic-concurrency save of the card's CardEdits (the whole object is
-- replaced; the Edge Function runs the trust checks first). Raises:
--   P0002 'holiday_card_not_found'       no such live card
--   55000 'holiday_card_checkout_open'   an order of this card is in 'checkout'
--                                        (the snapshot is frozen there)
--   40001 'edits_version_mismatch'       p_expected_version is stale
--   22023 'invalid_edits'                p_edits is not a JSON object
-- Returns the new edits_version.
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

-- Atomic, capped bump of generation_attempts on a live card. Returns the new
-- count, or NULL when the cap is reached (or the card is gone/deleted) -- NULL
-- means "do not dispatch".
create or replace function public.increment_holiday_card_generation_attempt(
  p_card_id uuid,
  p_cap integer
)
returns integer
language sql
security definer
set search_path = ''
as $$
  update public.holiday_cards
  set generation_attempts = generation_attempts + 1
  where id = p_card_id
    and deleted_at is null
    and generation_attempts < p_cap
  returning generation_attempts;
$$;
revoke all on function public.increment_holiday_card_generation_attempt(uuid, integer) from public, anon, authenticated;
grant execute on function public.increment_holiday_card_generation_attempt(uuid, integer) to service_role;

-- Creates the card's film -- ONE transaction: lock the card, no-op when a film
-- is already linked (retries and the stuck-generation sweep can never create a
-- second film or change a token), else insert the forced family_holiday row
-- (status 'queued'; edits = { greeting, preferredCloseMedia } -- what
-- stages.ts load() reads), mint the share token and link both on the card.
-- p_scope_end is EXCLUSIVE (year_films.scope_end_exclusive). p_greeting must
-- equal the card's own greeting (single source). Returns (film_id, token);
-- for an existing film, its id and the card's token. Raises P0002
-- 'holiday_card_not_found' for a missing/deleted card.
create or replace function public.create_holiday_card_film(
  p_card_id uuid,
  p_scope_start date,
  p_scope_end date,
  p_greeting text,
  p_close_media uuid[]
)
returns table (film_id uuid, token text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_card public.holiday_cards;
  v_film_id uuid;
  v_token text;
begin
  select * into v_card from public.holiday_cards c where c.id = p_card_id for update;
  if not found or v_card.deleted_at is not null then
    raise exception 'holiday_card_not_found' using errcode = 'P0002', hint = 'holiday_card_not_found';
  end if;

  if v_card.film_id is not null then
    return query select v_card.film_id, v_card.share_token;
    return;
  end if;

  if p_greeting is distinct from v_card.greeting then
    raise exception 'greeting_mismatch' using errcode = '22023', hint = 'greeting_mismatch';
  end if;

  insert into public.year_films (
    family_id, kind, forced, scope_start_date, scope_end_exclusive, surface_at, language, edits
  ) values (
    v_card.family_id, 'family_holiday', true, p_scope_start, p_scope_end, now(), v_card.language,
    jsonb_build_object('greeting', p_greeting, 'preferredCloseMedia', to_jsonb(coalesce(p_close_media, '{}'::uuid[])))
  )
  returning id into v_film_id;

  v_token := public.holiday_card_new_share_token();
  insert into public.film_share_tokens (token, film_id) values (v_token, v_film_id);

  update public.holiday_cards
  set film_id = v_film_id, share_token = v_token
  where id = p_card_id;

  return query select v_film_id, v_token;
end;
$$;
revoke all on function public.create_holiday_card_film(uuid, date, date, text, uuid[]) from public, anon, authenticated;
grant execute on function public.create_holiday_card_film(uuid, date, date, text, uuid[]) to service_role;

-- Ends the card's film (used when a card is deleted): terminal status
-- 'ended', attempt_id cleared (an in-flight render is superseded and its
-- publish CAS fails), video/poster/scenes keys nulled so the existing cleanup
-- (year_films_needing_cleanup, cleanup_needed) releases the artifacts, and the
-- share token revoked (public page 410). Soft-deletes nothing else (the Edge
-- Function soft-deletes the card). Only ever touches the card's own forced
-- family_holiday film. Returns { ended, film_id, delete_keys } -- delete_keys
-- are the object keys the caller may delete right away; idempotent.
create or replace function public.end_holiday_card_film(p_card_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_card public.holiday_cards;
  v_film public.year_films;
  v_delete text[];
begin
  select * into v_card from public.holiday_cards c where c.id = p_card_id for update;
  if not found then
    raise exception 'holiday_card_not_found' using errcode = 'P0002', hint = 'holiday_card_not_found';
  end if;
  if v_card.film_id is null then
    return jsonb_build_object('ended', false, 'film_id', null, 'delete_keys', '[]'::jsonb);
  end if;

  select * into v_film from public.year_films y where y.id = v_card.film_id for update;
  if not found then
    return jsonb_build_object('ended', false, 'film_id', null, 'delete_keys', '[]'::jsonb);
  end if;
  if not (v_film.forced and v_film.kind = 'family_holiday') then
    raise exception 'not_a_card_film' using errcode = '22023', hint = 'not_a_card_film';
  end if;

  update public.film_share_tokens t
  set revoked_at = now()
  where t.film_id = v_film.id and t.revoked_at is null;

  if v_film.status = 'ended' then
    return jsonb_build_object('ended', true, 'film_id', v_film.id, 'delete_keys', '[]'::jsonb);
  end if;

  v_delete := array_remove(array[
    v_film.video_key, v_film.poster_key,
    public.year_film_poster_thumb_key(v_film.poster_key),
    v_film.scenes_key
  ], null);

  update public.year_films
  set status = 'ended',
      attempt_id = null,
      video_key = null, poster_key = null, scenes_key = null, duration_ms = null,
      requeue_after = null, next_attempt_at = null, render_slot_at = null,
      stale = false, cleanup_needed = true, updated_at = now()
  where id = v_film.id;

  return jsonb_build_object('ended', true, 'film_id', v_film.id, 'delete_keys', to_jsonb(v_delete));
end;
$$;
revoke all on function public.end_holiday_card_film(uuid) from public, anon, authenticated;
grant execute on function public.end_holiday_card_film(uuid) to service_role;

-- On-demand twin of claim_year_film_dispatch: the same CAS queued -> curating
-- (new attempt_id, attempt_count + 1, heartbeat, machine ids cleared, the same
-- next_attempt_at / requeue_after spacing and the year_film_family_enabled
-- rollout gate), but for ONE row and only when it is forced + queued. Returns
-- the claimed row; ZERO ROWS is a normal outcome (the hourly cron claimed it
-- first, the rollout excludes the family, the film is ended/in flight/spaced).
create or replace function public.claim_year_film_by_id(p_film_id uuid)
returns table (film_id uuid, attempt_id uuid, family_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with picked as (
    select f.id
    from public.year_films f
    where f.id = p_film_id
      and f.forced
      and f.status = 'queued'
      and (f.next_attempt_at is null or f.next_attempt_at <= now())
      and (f.requeue_after is null or f.requeue_after <= now())
      and public.year_film_family_enabled(f.family_id)
    for update skip locked
  )
  update public.year_films y
  set status = 'curating',
      attempt_id = gen_random_uuid(),
      attempt_count = y.attempt_count + 1,
      requeue_after = null,
      generation_started_at = now(),
      heartbeat_at = now(),
      render_slot_at = null,
      machine_ids = '{}'::jsonb,
      updated_at = now()
  from picked
  where y.id = picked.id
  returning y.id, y.attempt_id, y.family_id;
end;
$$;
revoke all on function public.claim_year_film_by_id(uuid) from public, anon, authenticated;
grant execute on function public.claim_year_film_by_id(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5. AI ledger operations
-- ---------------------------------------------------------------------------

-- Existing list (20260929120000_year_films.sql) + the six card operations.
-- Same add-not-valid-then-validate dance as the previous widenings.
alter table public.ai_usage_events
  drop constraint ai_usage_events_operation_check;

alter table public.ai_usage_events
  add constraint ai_usage_events_operation_check
  check (operation in (
    'illustration', 'portrait', 'safety_chat', 'emotion_chat', 'emotion_vision',
    'transcription', 'voice_cleanup', 'relationship_chat',
    'year_film_quote', 'year_film_vision', 'year_film_audio',
    'holiday_card_front_judge', 'holiday_card_voice', 'holiday_card_details',
    'holiday_card_editor', 'holiday_card_writer', 'holiday_card_quote_check'
  )) not valid;

alter table public.ai_usage_events
  validate constraint ai_usage_events_operation_check;

-- ---------------------------------------------------------------------------
-- 6. claim_family_deletion_fence
-- ---------------------------------------------------------------------------

-- DRIFT RISK: this is a copy of the definition last written by
-- 20260929120000_year_films.sql (itself "taken from the live database"). The
-- production function may have been changed since by hand. BEFORE `supabase db
-- push`, compare production's `pg_get_functiondef('public.claim_family_
-- deletion_fence(uuid, uuid)'::regprocedure)` with that migration and fold in
-- any difference; otherwise this replace silently reverts it.
--
-- New here (everything else is verbatim):
--   * the family's holiday cards and card orders are row-locked like the other
--     fenced tables;
--   * refuses while a card is 'generating' with a fresh heartbeat (20 minutes,
--     the same window as year films) -- the Workflow could still write
--     objects after the deletion sweep;
--   * refuses while a card order is 'paid'/'submitted' and Gelato has not yet
--     reported the files fetched (gelato_status passed or later, or a terminal
--     failed/canceled): the print files must outlive that fetch.
--     in_production / shipped never block (nothing ever sets 'delivered').
--     Orders with refunded_at or failure_reason set are parked for a human and
--     never block either.
CREATE OR REPLACE FUNCTION public.claim_family_deletion_fence(p_family_id uuid, p_delete_token uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  family_row public.families%rowtype;
  stale_token uuid;
begin
  select * into family_row
  from public.families
  where id = p_family_id
  for update;
  if not found then return false; end if;
  if family_row.deletion_fence_token is not null then
    if family_row.deletion_fence_started_at >= now() - interval '10 minutes' then
      raise exception 'Family deletion already in progress' using errcode = '55000';
    end if;
    stale_token := family_row.deletion_fence_token;
    perform 1
    from public.family_members member
    where member.family_id = p_family_id
    order by member.id
    for update;
    update public.family_member_portrait_versions
    set deletion_token = null, deletion_started_at = null
    where family_id = p_family_id and deletion_token = stale_token;
    update public.family_members
    set deletion_fence_token = null, deletion_fence_started_at = null
    where family_id = p_family_id and deletion_fence_token = stale_token;
    update public.families
    set deletion_fence_token = null, deletion_fence_started_at = null
    where id = p_family_id and deletion_fence_token = stale_token;
    family_row.deletion_fence_token := null;
  end if;

  perform 1
  from public.family_members member
  where member.family_id = p_family_id
  order by member.id
  for update;

  if exists (
    select 1 from public.family_members
    where family_id = p_family_id and deletion_fence_token is not null
  ) then
    raise exception 'Family member deletion already in progress' using errcode = '55000';
  end if;

  perform 1
  from public.portrait_generation_jobs job
  where job.family_id = p_family_id
  order by job.id
  for update;

  perform 1
  from public.memory_illustration_jobs job
  where job.family_id = p_family_id
  order by job.id
  for update;

  perform 1
  from public.family_member_portrait_versions version
  where version.family_id = p_family_id
  order by version.id
  for update;

  perform 1
  from public.memories memory
  where memory.family_id = p_family_id
  order by memory.id
  for update;

  -- Holiday cards: card and order rows are fenced like the rest.
  perform 1
  from public.holiday_cards card
  where card.family_id = p_family_id
  order by card.id
  for update;

  perform 1
  from public.holiday_card_orders card_order
  where card_order.family_id = p_family_id
  order by card_order.id
  for update;

  if exists (
    select 1 from public.portrait_generation_jobs
    where family_id = p_family_id
      and status in ('queued', 'running')
      and (
        started_at >= now() - interval '5 minutes 30 seconds'
        or (upload_token is not null and upload_started_at >= now() - interval '5 minutes 30 seconds')
      )
  ) or exists (
    select 1 from public.family_member_portrait_versions
    where family_id = p_family_id
      and generation_token is not null
      and generation_started_at >= now() - interval '5 minutes 30 seconds'
  ) then
    raise exception 'Fresh portrait generation is still active' using errcode = '55000';
  end if;

  if exists (
    select 1 from public.memory_illustration_jobs
    where family_id = p_family_id
      and status in ('queued', 'running')
      and (
        started_at >= now() - interval '5 minutes 30 seconds'
        or (upload_token is not null and upload_started_at >= now() - interval '5 minutes 30 seconds')
      )
  ) or exists (
    select 1 from public.memories
    where family_id = p_family_id
      and illustration_generation_attempt_id is not null
      and illustration_generation_started_at >= now() - interval '5 minutes 30 seconds'
  ) then
    raise exception 'Fresh illustration generation is still active' using errcode = '55000';
  end if;

  -- Year Film P1: a running film attempt could write film/poster objects
  -- after the deletion sweep; wait for it like portraits/illustrations.
  if exists (
    select 1 from public.year_films
    where family_id = p_family_id
      and status in ('curating', 'preparing', 'rendering')
      and heartbeat_at >= now() - interval '20 minutes'
  ) then
    raise exception 'Fresh year film generation is still active' using errcode = '55000';
  end if;

  -- Holiday Cards P1: card generation (front picks / film row / letters) also
  -- writes after a deletion sweep, so wait for a fresh heartbeat like films.
  if exists (
    select 1 from public.holiday_cards
    where family_id = p_family_id
      and status = 'generating'
      and heartbeat_at >= now() - interval '20 minutes'
  ) then
    raise exception 'Fresh holiday card generation is still active' using errcode = '55000';
  end if;

  -- Holiday Cards P1: a paid/submitted order whose print files Gelato has not
  -- fetched yet needs them to survive. Once Gelato reports passed (or later,
  -- or a terminal failed/canceled) they are no longer needed; in_production
  -- and shipped orders never block.
  if exists (
    select 1 from public.holiday_card_orders
    where family_id = p_family_id
      and status in ('paid', 'submitted')
      -- Orders parked for a human (webhook mismatch -> failure_reason, or
      -- refunded) will never be fetched, so they must not block forever.
      and refunded_at is null
      and failure_reason is null
      and (
        gelato_status is null
        or gelato_status <> all (array['passed', 'printed', 'shipped', 'delivered', 'failed', 'canceled', 'cancelled'])
      )
  ) then
    raise exception 'A holiday card order is still waiting for Gelato to fetch its files' using errcode = '55000';
  end if;

  if exists (
    select 1 from public.family_member_portrait_versions
    where family_id = p_family_id and deletion_token is not null
  ) then
    raise exception 'Portrait deletion already in progress' using errcode = '55000';
  end if;

  update public.families
  set deletion_fence_token = p_delete_token,
      deletion_fence_started_at = now()
  where id = p_family_id;

  update public.family_members
  set deletion_fence_token = p_delete_token,
      deletion_fence_started_at = now()
  where family_id = p_family_id;

  update public.family_member_portrait_versions
  set deletion_token = p_delete_token,
      deletion_started_at = now()
  where family_id = p_family_id;

  update public.portrait_generation_jobs
  set status = 'superseded', completed_at = now(),
      source_photo_key = null, style_reference_key = null, portrait_prompt = null,
      upload_token = null, upload_started_at = null
  where family_id = p_family_id and status in ('queued', 'running');

  update public.memory_illustration_jobs
  set status = 'superseded', completed_at = now(),
      safe_scene_description = null, reference_candidates = '[]'::jsonb,
      illustration_prompt = null, upload_token = null, upload_started_at = null
  where family_id = p_family_id and status in ('queued', 'running');

  update public.memories
  set illustration_generation_attempt_id = null,
      illustration_generation_started_at = null,
      illustration_status = case
        when illustration_key is not null and illustration_generation_id is not null then 'ready'
        when memory_type = 'text_illustration' then 'pending'
        else 'none'
      end
  where family_id = p_family_id
    and illustration_generation_attempt_id is not null;

  return true;
end;
$function$;


-- ---------------------------------------------------------------------------
-- 7. Schedule sweep-holiday-card-orders
-- ---------------------------------------------------------------------------

-- Every 10 minutes (pattern of 20260909100000_schedule_memory_book_orders_
-- sweep.sql): confirms paid orders at Gelato (PATCH-if-draft), polls
-- submitted/in_production orders, ages quoted/checkout orders, recovers cards
-- stuck in generating. Idempotent and cheap when idle. Same Vault secrets
-- (project_url, cron_secret); until the Edge Function is deployed each run
-- fails visibly in cron.job_run_details.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'invoke-sweep-holiday-card-orders',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := (
      select decrypted_secret from vault.decrypted_secrets where name = 'project_url'
    ) || '/functions/v1/sweep-holiday-card-orders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (
        select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
