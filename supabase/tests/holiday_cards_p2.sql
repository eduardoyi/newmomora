begin;

-- Holiday Cards P2, Step 1 (20261007120000_holiday_cards_p2.sql,
-- docs/plans/holiday-cards-p2.md §4): holiday_card_settings + the gate
-- functions, holiday_card_summary, the card-level checkout claim, the replaced
-- save_holiday_card_edits and the web handoff codes. FICTIONAL data only
-- (public repo).
select plan(104);

-- ---------------------------------------------------------------------------
-- Fixtures (postgres role; assertions switch to authenticated where needed)
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, is_anonymous) values
  ('fd000000-0000-4000-8000-000000000001', 'p2-owner@example.test', false),
  ('fd000000-0000-4000-8000-000000000002', 'p2-manager@example.test', false),
  ('fd000000-0000-4000-8000-000000000003', 'p2-viewer@example.test', false),
  ('fd000000-0000-4000-8000-000000000004', 'p2-outsider@example.test', false),
  ('fd000000-0000-4000-8000-000000000005', 'p2-anon@example.test', true);

insert into public.families (id, name, owner_id, gallery_caption_language) values
  ('fd100000-0000-4000-8000-000000000001', 'P2 card family', 'fd000000-0000-4000-8000-000000000001', 'en-US'),
  ('fd100000-0000-4000-8000-000000000002', 'P2 other family', 'fd000000-0000-4000-8000-000000000004', 'es-MX'),
  ('fd100000-0000-4000-8000-000000000003', 'P2 deleted family', 'fd000000-0000-4000-8000-000000000001', 'en-US');
update public.families set deleted_at = now() where id = 'fd100000-0000-4000-8000-000000000003';

insert into public.family_memberships (family_id, user_id, role) values
  ('fd100000-0000-4000-8000-000000000001', 'fd000000-0000-4000-8000-000000000001', 'owner'),
  ('fd100000-0000-4000-8000-000000000001', 'fd000000-0000-4000-8000-000000000002', 'manager'),
  ('fd100000-0000-4000-8000-000000000001', 'fd000000-0000-4000-8000-000000000003', 'viewer'),
  ('fd100000-0000-4000-8000-000000000001', 'fd000000-0000-4000-8000-000000000005', 'viewer'),
  ('fd100000-0000-4000-8000-000000000002', 'fd000000-0000-4000-8000-000000000004', 'owner'),
  ('fd100000-0000-4000-8000-000000000003', 'fd000000-0000-4000-8000-000000000001', 'owner');

-- Only family A's owner has billing access; family B's owner has none.
insert into public.owner_entitlements (
  owner_user_id, app_user_id, environment, store, product_id, entitlement_id,
  period_type, status, expires_at, will_renew
) values (
  'fd000000-0000-4000-8000-000000000001', 'fd000000-0000-4000-8000-000000000001',
  'production', 'app_store', 'momora_annual_v1', 'momora_plus', 'annual', 'active',
  transaction_timestamp() + interval '400 days', true
);

-- ---------------------------------------------------------------------------
-- 1. Settings table, seeded row, grants
-- ---------------------------------------------------------------------------

select is(
  (select row(mode, canary_family_ids, closes_on, orders_enabled, ship_by_note, hold_confirm_family_ids)::text
   from public.holiday_card_settings),
  '(canary,{},,t,,{})',
  'the seeded row is canary with empty lists, no closing date, orders enabled'
);
select is((select count(*)::int from public.holiday_card_settings), 1, 'there is exactly one settings row');
select throws_ok($$insert into public.holiday_card_settings (id) values (false)$$, '23514', null,
  'a second settings row cannot be inserted (id must be true)');
select throws_ok($$update public.holiday_card_settings set mode = 'everyone'$$, '23514', null,
  'mode is off | canary | all');
select ok(not has_table_privilege('anon', 'public.holiday_card_settings', 'SELECT, INSERT, UPDATE, DELETE')
  and not has_table_privilege('authenticated', 'public.holiday_card_settings', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE'),
  'clients have no access to the settings table');
select ok((select relrowsecurity from pg_class where oid = 'public.holiday_card_settings'::regclass),
  'row level security is on for the settings table');

-- ---------------------------------------------------------------------------
-- 2. holiday_card_family_enabled / orders_enabled / hold_confirm
-- ---------------------------------------------------------------------------

select is(public.holiday_card_family_enabled('fd100000-0000-4000-8000-000000000001'), false,
  'canary with an empty list enables nobody');

update public.holiday_card_settings set canary_family_ids = array['fd100000-0000-4000-8000-000000000001'::uuid];
select is(public.holiday_card_family_enabled('fd100000-0000-4000-8000-000000000001'), true,
  'a canary-listed live family is enabled');
select is(public.holiday_card_family_enabled('fd100000-0000-4000-8000-000000000002'), false,
  'an unlisted family is not enabled in canary');

update public.holiday_card_settings set mode = 'off';
select is(public.holiday_card_family_enabled('fd100000-0000-4000-8000-000000000001'), false,
  'mode off disables even a listed family');

update public.holiday_card_settings set mode = 'all';
select is(public.holiday_card_family_enabled('fd100000-0000-4000-8000-000000000002'), true,
  'mode all enables any live family');
select is(public.holiday_card_family_enabled('fd100000-0000-4000-8000-000000000003'), false,
  'a soft-deleted family is never enabled');
select is(public.holiday_card_family_enabled('fd100000-0000-4000-8000-0000000000ff'), false,
  'an unknown family is not enabled');

update public.holiday_card_settings set closes_on = (now() at time zone 'utc')::date - 1;
select is(public.holiday_card_family_enabled('fd100000-0000-4000-8000-000000000001'), false,
  'a closing date in the past disables the family (mode all)');
update public.holiday_card_settings set closes_on = (now() at time zone 'utc')::date;
select is(public.holiday_card_family_enabled('fd100000-0000-4000-8000-000000000001'), true,
  'the closing date itself (UTC today) is still open');
update public.holiday_card_settings set closes_on = (now() at time zone 'utc')::date + 1;
select is(public.holiday_card_family_enabled('fd100000-0000-4000-8000-000000000001'), true,
  'a future closing date is open');
update public.holiday_card_settings set closes_on = null;

update public.holiday_card_settings set mode = 'canary', closes_on = (now() at time zone 'utc')::date - 1;
select is(public.holiday_card_family_enabled('fd100000-0000-4000-8000-000000000001'), false,
  'a closing date in the past also disables a canary-listed family');
update public.holiday_card_settings set closes_on = null;

select is(public.holiday_card_orders_enabled(), true, 'orders are enabled by default');
update public.holiday_card_settings set orders_enabled = false;
select is(public.holiday_card_orders_enabled(), false, 'orders_enabled = false is the kill switch');
update public.holiday_card_settings set orders_enabled = true;

select is(public.holiday_card_hold_confirm('fd100000-0000-4000-8000-000000000001'), false,
  'no family is held by default');
update public.holiday_card_settings set hold_confirm_family_ids = array['fd100000-0000-4000-8000-000000000001'::uuid];
select is(public.holiday_card_hold_confirm('fd100000-0000-4000-8000-000000000001'), true, 'a listed family is held');
select is(public.holiday_card_hold_confirm('fd100000-0000-4000-8000-000000000002'), false, 'an unlisted family is not held');
update public.holiday_card_settings set hold_confirm_family_ids = '{}';

-- ---------------------------------------------------------------------------
-- 3. holiday_card_summary
-- ---------------------------------------------------------------------------

-- Family A is in the canary list from here on; mode canary.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'fd000000-0000-4000-8000-000000000001', true);

select is(
  (select row(enabled, card_id, year, status, last_failure_code, ordered, language)::text
   from public.holiday_card_summary('fd100000-0000-4000-8000-000000000001')),
  '(t,,,,,f,en)',
  'no card yet: enabled and language are returned, card fields are null'
);

set local role postgres;
-- Cards of two years; the 2027 card is OLDER by created_at, so "newest" must
-- follow created_at, not the year.
insert into public.holiday_cards (id, family_id, created_by, year, greeting, status, created_at) values
  ('fd200000-0000-4000-8000-000000000027', 'fd100000-0000-4000-8000-000000000001', 'fd000000-0000-4000-8000-000000000001', 2027, 'holidays', 'ready', now() - interval '2 days'),
  ('fd200000-0000-4000-8000-000000000026', 'fd100000-0000-4000-8000-000000000001', 'fd000000-0000-4000-8000-000000000001', 2026, 'christmas', 'failed', now() - interval '1 day');
update public.holiday_cards set last_failure_code = 'LETTERS_FAILED' where id = 'fd200000-0000-4000-8000-000000000026';

set local role authenticated;
select is(
  (select row(enabled, card_id, year, status, last_failure_code, ordered, language)::text
   from public.holiday_card_summary('fd100000-0000-4000-8000-000000000001')),
  '(t,fd200000-0000-4000-8000-000000000026,2026,failed,LETTERS_FAILED,f,en)',
  'the summary is the newest card by created_at, of any year, with its failure code'
);
select is((select count(*)::int from public.holiday_card_summary('fd100000-0000-4000-8000-000000000001')), 1,
  'the summary is a single row');

select set_config('request.jwt.claim.sub', 'fd000000-0000-4000-8000-000000000002', true);
select is(
  (select card_id from public.holiday_card_summary('fd100000-0000-4000-8000-000000000001')),
  'fd200000-0000-4000-8000-000000000026'::uuid,
  'a manager gets the summary row');

select set_config('request.jwt.claim.sub', 'fd000000-0000-4000-8000-000000000003', true);
select is((select count(*)::int from public.holiday_card_summary('fd100000-0000-4000-8000-000000000001')), 0, 'a viewer gets no row');
select set_config('request.jwt.claim.sub', 'fd000000-0000-4000-8000-000000000005', true);
select is((select count(*)::int from public.holiday_card_summary('fd100000-0000-4000-8000-000000000001')), 0,
  'an anonymous session gets no row');
select set_config('request.jwt.claim.sub', 'fd000000-0000-4000-8000-000000000004', true);
select is((select count(*)::int from public.holiday_card_summary('fd100000-0000-4000-8000-000000000001')), 0,
  'an outsider gets no row');
select set_config('request.jwt.claim.sub', 'fd000000-0000-4000-8000-000000000001', true);
select is((select count(*)::int from public.holiday_card_summary('fd100000-0000-4000-8000-000000000003')), 0,
  'the owner of a soft-deleted family gets no row');
select is((select count(*)::int from public.holiday_card_summary('fd100000-0000-4000-8000-0000000000ff')), 0,
  'an unknown family gets no row');
set local role anon;
select throws_ok($$select * from public.holiday_card_summary('fd100000-0000-4000-8000-000000000001')$$, '42501', null,
  'the anon role cannot execute the summary');
set local role postgres;

-- A soft-deleted newest card is skipped.
insert into public.holiday_cards (id, family_id, created_by, year, greeting, status, deleted_at) values
  ('fd200000-0000-4000-8000-000000000028', 'fd100000-0000-4000-8000-000000000001', 'fd000000-0000-4000-8000-000000000001', 2028, 'holidays', 'ready', now());
set local role authenticated;
select set_config('request.jwt.claim.sub', 'fd000000-0000-4000-8000-000000000001', true);
select is(
  (select card_id from public.holiday_card_summary('fd100000-0000-4000-8000-000000000001')),
  'fd200000-0000-4000-8000-000000000026'::uuid,
  'a soft-deleted newer card is ignored');
set local role postgres;

-- `ordered` spans every buyer, and only the four paid-or-later statuses count.
insert into public.holiday_card_orders (id, card_id, family_id, requested_by, status, price_cents, packs, shipping_address, card_snapshot, snapshot_hash)
values
  ('fd300000-0000-4000-8000-000000000001', 'fd200000-0000-4000-8000-000000000026', 'fd100000-0000-4000-8000-000000000001',
   'fd000000-0000-4000-8000-000000000002', 'cancelled', 2490, 2, '{"country":"US"}'::jsonb, '{"v":1}'::jsonb, 'h1');
insert into public.holiday_card_orders (id, card_id, family_id, requested_by, status, failure_reason)
values
  ('fd300000-0000-4000-8000-000000000002', 'fd200000-0000-4000-8000-000000000026', 'fd100000-0000-4000-8000-000000000001',
   'fd000000-0000-4000-8000-000000000002', 'failed', 'TEST_FAILURE'),
  ('fd300000-0000-4000-8000-000000000003', 'fd200000-0000-4000-8000-000000000026', 'fd100000-0000-4000-8000-000000000001',
   'fd000000-0000-4000-8000-000000000002', 'draft', null);
set local role authenticated;
select set_config('request.jwt.claim.sub', 'fd000000-0000-4000-8000-000000000001', true);
select is((select ordered from public.holiday_card_summary('fd100000-0000-4000-8000-000000000001')), false,
  'cancelled, failed and draft orders do not make a card ordered');
set local role postgres;

update public.holiday_card_orders set status = 'paid' where id = 'fd300000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'fd000000-0000-4000-8000-000000000001', true);
select is((select ordered from public.holiday_card_summary('fd100000-0000-4000-8000-000000000001')), true,
  'a paid order by ANOTHER buyer (the manager) makes the owner''s summary ordered');
set local role postgres;
update public.holiday_card_orders set status = 'shipped' where id = 'fd300000-0000-4000-8000-000000000001';
update public.holiday_card_orders set status = 'cancelled' where id = 'fd300000-0000-4000-8000-000000000001';

-- Switch and billing.
update public.holiday_card_settings set mode = 'off';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'fd000000-0000-4000-8000-000000000001', true);
select is((select enabled from public.holiday_card_summary('fd100000-0000-4000-8000-000000000001')), false,
  'enabled is false when the switch is off (the card is still returned)');
select is((select card_id from public.holiday_card_summary('fd100000-0000-4000-8000-000000000001')),
  'fd200000-0000-4000-8000-000000000026'::uuid, 'an existing card is returned even when the switch is off');
set local role postgres;

update public.holiday_card_settings set mode = 'all', closes_on = (now() at time zone 'utc')::date - 1;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'fd000000-0000-4000-8000-000000000001', true);
select is((select enabled from public.holiday_card_summary('fd100000-0000-4000-8000-000000000001')), false,
  'enabled is false after the closing date');
set local role postgres;
update public.holiday_card_settings set closes_on = null;

-- Family B: owner has no billing access; caption language es-MX.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'fd000000-0000-4000-8000-000000000004', true);
select is(
  (select row(enabled, language)::text from public.holiday_card_summary('fd100000-0000-4000-8000-000000000002')),
  '(f,es)',
  'enabled needs billing access too (switch on, no entitlement -> false); es-MX -> es'
);
set local role postgres;

-- Language mapping mirrors cardLanguageFor: case-insensitive "es" prefix, everything else en.
update public.families set gallery_caption_language = 'ES' where id = 'fd100000-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'fd000000-0000-4000-8000-000000000004', true);
select is((select language from public.holiday_card_summary('fd100000-0000-4000-8000-000000000002')), 'es',
  'upper-case ES maps to es');
set local role postgres;
update public.families set gallery_caption_language = 'fr' where id = 'fd100000-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'fd000000-0000-4000-8000-000000000004', true);
select is((select language from public.holiday_card_summary('fd100000-0000-4000-8000-000000000002')), 'en',
  'any other language maps to en');
set local role postgres;
update public.families set gallery_caption_language = 'en-US' where id = 'fd100000-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'fd000000-0000-4000-8000-000000000004', true);
select is((select language from public.holiday_card_summary('fd100000-0000-4000-8000-000000000002')), 'en',
  'en-US maps to en');
set local role postgres;

-- ---------------------------------------------------------------------------
-- 4. claim_holiday_card_checkout / release_holiday_card_checkout
-- ---------------------------------------------------------------------------

-- Use a fresh card for the claim and save sections.
insert into public.holiday_cards (id, family_id, created_by, year, greeting, status, edits_version) values
  ('fd200000-0000-4000-8000-000000000030', 'fd100000-0000-4000-8000-000000000001', 'fd000000-0000-4000-8000-000000000001', 2030, 'christmas', 'ready', 3);
insert into public.holiday_cards (id, family_id, created_by, year, greeting, status, deleted_at) values
  ('fd200000-0000-4000-8000-000000000031', 'fd100000-0000-4000-8000-000000000001', 'fd000000-0000-4000-8000-000000000001', 2031, 'christmas', 'ready', now());

-- Draft orders of card 2030 (bare drafts: no quote bundle needed).
insert into public.holiday_card_orders (id, card_id, family_id, requested_by) values
  ('fd300000-0000-4000-8000-000000000011', 'fd200000-0000-4000-8000-000000000030', 'fd100000-0000-4000-8000-000000000001', 'fd000000-0000-4000-8000-000000000001'),
  ('fd300000-0000-4000-8000-000000000012', 'fd200000-0000-4000-8000-000000000030', 'fd100000-0000-4000-8000-000000000001', 'fd000000-0000-4000-8000-000000000002'),
  ('fd300000-0000-4000-8000-000000000013', 'fd200000-0000-4000-8000-000000000031', 'fd100000-0000-4000-8000-000000000001', 'fd000000-0000-4000-8000-000000000001');

select throws_ok(
  $$select * from public.claim_holiday_card_checkout('fd300000-0000-4000-8000-0000000000ee', 3)$$,
  'P0002', 'card_not_found', 'claim: an unknown order is card_not_found');
select throws_ok(
  $$select * from public.claim_holiday_card_checkout('fd300000-0000-4000-8000-000000000013', 0)$$,
  'P0002', 'card_not_found', 'claim: a soft-deleted card is card_not_found');
select throws_ok(
  $$select * from public.claim_holiday_card_checkout('fd300000-0000-4000-8000-000000000011', 2)$$,
  '40001', 'CARD_CHANGED', 'claim: a stale version is CARD_CHANGED');
select is(
  (select checkout_order_id from public.holiday_cards where id = 'fd200000-0000-4000-8000-000000000030'),
  null, 'a refused claim sets nothing');

select is(
  (select row(id, edits_version, checkout_order_id)::text
   from public.claim_holiday_card_checkout('fd300000-0000-4000-8000-000000000011', 3)),
  '(fd200000-0000-4000-8000-000000000030,3,fd300000-0000-4000-8000-000000000011)',
  'claim: success returns the re-read card row carrying the claim');
select ok(
  (select checkout_claimed_at is not null from public.holiday_cards where id = 'fd200000-0000-4000-8000-000000000030'),
  'claim: the claim timestamp is set');

select throws_ok(
  $$select * from public.claim_holiday_card_checkout('fd300000-0000-4000-8000-000000000012', 3)$$,
  '55000', 'CHECKOUT_OPEN_ELSEWHERE', 'claim: another order''s fresh claim blocks (CHECKOUT_OPEN_ELSEWHERE)');

-- Same order re-claims and refreshes the timestamp.
update public.holiday_cards set checkout_claimed_at = now() - interval '5 minutes' where id = 'fd200000-0000-4000-8000-000000000030';
select ok(
  (select checkout_claimed_at > now() - interval '1 minute'
   from public.claim_holiday_card_checkout('fd300000-0000-4000-8000-000000000011', 3)),
  'claim: the same order re-claiming refreshes the timestamp');

-- A stale claim (> 10 minutes) no longer blocks another order and is replaced.
update public.holiday_cards set checkout_claimed_at = now() - interval '11 minutes' where id = 'fd200000-0000-4000-8000-000000000030';
select is(
  (select checkout_order_id from public.claim_holiday_card_checkout('fd300000-0000-4000-8000-000000000012', 3)),
  'fd300000-0000-4000-8000-000000000012'::uuid,
  'claim: a stale claim does not block; the new order takes it');

-- Release only clears the claim of the named order.
select public.release_holiday_card_checkout('fd300000-0000-4000-8000-000000000011');
select is(
  (select checkout_order_id from public.holiday_cards where id = 'fd200000-0000-4000-8000-000000000030'),
  'fd300000-0000-4000-8000-000000000012'::uuid,
  'release: a different order cannot clear the claim');
select public.release_holiday_card_checkout('fd300000-0000-4000-8000-000000000012');
select is(
  (select row(checkout_order_id, checkout_claimed_at)::text from public.holiday_cards where id = 'fd200000-0000-4000-8000-000000000030'),
  '(,)', 'release: the owning order clears the claim');
select lives_ok($$select public.release_holiday_card_checkout('fd300000-0000-4000-8000-000000000012')$$,
  'release is idempotent');

-- An order in 'checkout' blocks another order's claim, and only one checkout
-- order per card can exist (partial unique index).
update public.holiday_card_orders
set status = 'checkout', price_cents = 2490, packs = 2, shipping_address = '{"country":"US"}'::jsonb,
    card_snapshot = '{"v":1}'::jsonb, snapshot_hash = 'h-11'
where id = 'fd300000-0000-4000-8000-000000000011';
select throws_ok(
  $$select * from public.claim_holiday_card_checkout('fd300000-0000-4000-8000-000000000012', 3)$$,
  '55000', 'CHECKOUT_OPEN_ELSEWHERE', 'claim: another order in status checkout blocks (no claim needed)');
select is(
  (select checkout_order_id from public.claim_holiday_card_checkout('fd300000-0000-4000-8000-000000000011', 3)),
  'fd300000-0000-4000-8000-000000000011'::uuid,
  'claim: the order that is itself in checkout may claim');
select throws_ok(
  $$update public.holiday_card_orders
    set status = 'checkout', price_cents = 2490, packs = 2, shipping_address = '{"country":"US"}'::jsonb,
        card_snapshot = '{"v":1}'::jsonb, snapshot_hash = 'h-12'
    where id = 'fd300000-0000-4000-8000-000000000012'$$,
  '23505', null, 'the partial unique index allows one checkout order per card');
select public.release_holiday_card_checkout('fd300000-0000-4000-8000-000000000011');

-- ---------------------------------------------------------------------------
-- 5. save_holiday_card_edits (replaced)
-- ---------------------------------------------------------------------------

-- Order 11 is still in checkout: refused (P1 behaviour kept).
select throws_ok(
  $$select public.save_holiday_card_edits('fd200000-0000-4000-8000-000000000030', 3, '{"a":1}'::jsonb)$$,
  '55000', 'holiday_card_checkout_open', 'save: an order in checkout still refuses (P1 behaviour)');
update public.holiday_card_orders set status = 'cancelled' where id = 'fd300000-0000-4000-8000-000000000011';

-- Fresh claim refuses; stale claim does not.
select lives_ok($$select * from public.claim_holiday_card_checkout('fd300000-0000-4000-8000-000000000012', 3)$$,
  'save setup: order 12 takes a fresh claim');
select throws_ok(
  $$select public.save_holiday_card_edits('fd200000-0000-4000-8000-000000000030', 3, '{"a":1}'::jsonb)$$,
  '55000', 'holiday_card_checkout_open', 'save: a fresh card-level claim refuses (55000 holiday_card_checkout_open)');
update public.holiday_cards set checkout_claimed_at = now() - interval '11 minutes' where id = 'fd200000-0000-4000-8000-000000000030';
select is(public.save_holiday_card_edits('fd200000-0000-4000-8000-000000000030', 3, '{"a":1}'::jsonb), 4,
  'save: a stale claim does not block');
select public.release_holiday_card_checkout('fd300000-0000-4000-8000-000000000012');

-- Other P1 behaviour intact.
select throws_ok(
  $$select public.save_holiday_card_edits('fd200000-0000-4000-8000-000000000030', 3, '{"a":2}'::jsonb)$$,
  '40001', 'edits_version_mismatch', 'save: a stale version still raises edits_version_mismatch');
select throws_ok(
  $$select public.save_holiday_card_edits('fd200000-0000-4000-8000-000000000030', 4, '[]'::jsonb)$$,
  '22023', 'invalid_edits', 'save: non-object edits still raise invalid_edits');
select throws_ok(
  $$select public.save_holiday_card_edits('fd200000-0000-4000-8000-000000000031', 0, '{}'::jsonb)$$,
  'P0002', 'holiday_card_not_found', 'save: a deleted card is still holiday_card_not_found');

-- failed / cancelled never lock; each paid-or-later status does.
update public.holiday_card_orders set status = 'failed', failure_reason = 'TEST_FAILURE' where id = 'fd300000-0000-4000-8000-000000000012';
select is(public.save_holiday_card_edits('fd200000-0000-4000-8000-000000000030', 4, '{"a":3}'::jsonb), 5,
  'save: a cancelled order (11) and a failed order (12) do not lock the card');

update public.holiday_card_orders
set status = 'paid', failure_reason = null, price_cents = 2490, packs = 2, shipping_address = '{"country":"US"}'::jsonb,
    card_snapshot = '{"v":1}'::jsonb, snapshot_hash = 'h-12'
where id = 'fd300000-0000-4000-8000-000000000012';
select throws_ok(
  $$select public.save_holiday_card_edits('fd200000-0000-4000-8000-000000000030', 5, '{"a":4}'::jsonb)$$,
  'P0001', 'card_ordered', 'save: a paid order locks the card (card_ordered)');
update public.holiday_card_orders set status = 'submitted' where id = 'fd300000-0000-4000-8000-000000000012';
select throws_ok(
  $$select public.save_holiday_card_edits('fd200000-0000-4000-8000-000000000030', 5, '{"a":4}'::jsonb)$$,
  'P0001', 'card_ordered', 'save: a submitted order locks the card');
update public.holiday_card_orders set status = 'in_production' where id = 'fd300000-0000-4000-8000-000000000012';
select throws_ok(
  $$select public.save_holiday_card_edits('fd200000-0000-4000-8000-000000000030', 5, '{"a":4}'::jsonb)$$,
  'P0001', 'card_ordered', 'save: an in_production order locks the card');
update public.holiday_card_orders set status = 'shipped' where id = 'fd300000-0000-4000-8000-000000000012';
select throws_ok(
  $$select public.save_holiday_card_edits('fd200000-0000-4000-8000-000000000030', 5, '{"a":4}'::jsonb)$$,
  'P0001', 'card_ordered', 'save: a shipped order locks the card');
select throws_ok(
  $$select public.save_holiday_card_edits('fd200000-0000-4000-8000-000000000030', 0, '{"a":4}'::jsonb)$$,
  'P0001', 'card_ordered', 'save: card_ordered wins over a stale version');

-- A refunded canary (paid -> cancelled) unlocks the card again.
update public.holiday_card_orders set status = 'cancelled' where id = 'fd300000-0000-4000-8000-000000000012';
select is(public.save_holiday_card_edits('fd200000-0000-4000-8000-000000000030', 5, '{"a":5}'::jsonb), 6,
  'save: once the paid order is cancelled the card is editable again');

-- A reorder of an ordered card can still claim (only the edit path locks).
update public.holiday_card_orders set status = 'shipped' where id = 'fd300000-0000-4000-8000-000000000012';
select is(
  (select checkout_order_id from public.claim_holiday_card_checkout('fd300000-0000-4000-8000-000000000011', 6)),
  'fd300000-0000-4000-8000-000000000011'::uuid,
  'claim: a reorder of an already-ordered card may claim');
select throws_ok(
  $$select public.save_holiday_card_edits('fd200000-0000-4000-8000-000000000030', 6, '{"a":6}'::jsonb)$$,
  '55000', 'holiday_card_checkout_open', 'save: a reorder claim refuses edits too (checkout_open is checked first)');

-- ---------------------------------------------------------------------------
-- 6. web_handoff_codes
-- ---------------------------------------------------------------------------

select ok(not has_table_privilege('anon', 'public.web_handoff_codes', 'SELECT, INSERT, UPDATE, DELETE')
  and not has_table_privilege('authenticated', 'public.web_handoff_codes', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE'),
  'clients have no access to the handoff table');
select ok((select relrowsecurity from pg_class where oid = 'public.web_handoff_codes'::regclass),
  'row level security is on for the handoff table');

select ok(
  s.e between now() + interval '119 seconds' and now() + interval '121 seconds',
  'create_web_handoff returns the expiry, two minutes from now')
from (select public.create_web_handoff('fd000000-0000-4000-8000-000000000001', 'hash-one') as e) s;
select is(
  (select row(user_id, used_at is null)::text from public.web_handoff_codes where code_hash = 'hash-one'),
  '(fd000000-0000-4000-8000-000000000001,t)', 'the code row is stored unused for the user');
select throws_ok(
  $$select public.create_web_handoff('fd000000-0000-4000-8000-000000000001', 'hash-one')$$,
  '23505', null, 'a duplicate code hash is refused');

select is(public.claim_web_handoff('hash-one'), 'fd000000-0000-4000-8000-000000000001'::uuid,
  'claim_web_handoff returns the user id');
select is(public.claim_web_handoff('hash-one'), null, 'a code is single-use');
select ok((select used_at is not null from public.web_handoff_codes where code_hash = 'hash-one'), 'used_at is stamped');
select is(public.claim_web_handoff('hash-unknown'), null, 'an unknown code returns null');

-- Single winner under an interleaved double claim: the second update sees used_at.
select public.create_web_handoff('fd000000-0000-4000-8000-000000000002', 'hash-two');
select is(
  (select count(*)::int from (
     select public.claim_web_handoff('hash-two') as u
     union all select public.claim_web_handoff('hash-two')
   ) c where c.u is not null),
  1, 'two claims of the same code produce exactly one winner');

-- Expiry on the DB clock.
select public.create_web_handoff('fd000000-0000-4000-8000-000000000002', 'hash-exp');
update public.web_handoff_codes set expires_at = now() - interval '1 second' where code_hash = 'hash-exp';
select is(public.claim_web_handoff('hash-exp'), null, 'an expired code cannot be claimed');
select public.create_web_handoff('fd000000-0000-4000-8000-000000000002', 'hash-edge');
update public.web_handoff_codes set expires_at = now() + interval '1 second' where code_hash = 'hash-edge';
select is(public.claim_web_handoff('hash-edge'), 'fd000000-0000-4000-8000-000000000002'::uuid,
  'a code one second before expiry is still claimable');

-- Rate limit: 10 per user per 10 minutes. User 2 has hash-two/-exp/-edge (3),
-- add 7 more; the 11th is refused. Other users are unaffected.
select public.create_web_handoff('fd000000-0000-4000-8000-000000000002', 'hash-rl-' || g) from generate_series(1, 7) g;
select throws_ok(
  $$select public.create_web_handoff('fd000000-0000-4000-8000-000000000002', 'hash-rl-over')$$,
  'P0001', 'rate_limited', 'the 11th code within 10 minutes is rate_limited');
select is((select count(*)::int from public.web_handoff_codes where code_hash = 'hash-rl-over'), 0,
  'a rate-limited call inserts nothing');
select lives_ok($$select public.create_web_handoff('fd000000-0000-4000-8000-000000000001', 'hash-other-user')$$,
  'the limit is per user');
update public.web_handoff_codes set created_at = now() - interval '11 minutes'
where user_id = 'fd000000-0000-4000-8000-000000000002' and code_hash like 'hash-rl-%';
select lives_ok($$select public.create_web_handoff('fd000000-0000-4000-8000-000000000002', 'hash-rl-after')$$,
  'rows older than 10 minutes no longer count toward the limit');

-- Purge: rows expired more than a day ago (ANY user) go on the next create.
insert into public.web_handoff_codes (code_hash, user_id, created_at, expires_at) values
  ('hash-old', 'fd000000-0000-4000-8000-000000000003', now() - interval '3 days', now() - interval '2 days'),
  ('hash-recent-expired', 'fd000000-0000-4000-8000-000000000003', now() - interval '3 hours', now() - interval '3 hours' + interval '2 minutes');
select public.create_web_handoff('fd000000-0000-4000-8000-000000000001', 'hash-purge-trigger');
select is((select count(*)::int from public.web_handoff_codes where code_hash = 'hash-old'), 0,
  'create_web_handoff purges another user''s code expired over a day ago');
select is((select count(*)::int from public.web_handoff_codes where code_hash = 'hash-recent-expired'), 1,
  'a code expired only hours ago is kept');

-- Deleting an auth user cascades to their codes.
select public.create_web_handoff('fd000000-0000-4000-8000-000000000004', 'hash-cascade');
delete from public.family_memberships where user_id = 'fd000000-0000-4000-8000-000000000004';
delete from public.families where owner_id = 'fd000000-0000-4000-8000-000000000004';
delete from auth.users where id = 'fd000000-0000-4000-8000-000000000004';
select is((select count(*)::int from public.web_handoff_codes where code_hash = 'hash-cascade'), 0,
  'deleting the auth user deletes their handoff codes');

-- ---------------------------------------------------------------------------
-- 7. Grants and function privileges
-- ---------------------------------------------------------------------------

select ok(
  not has_function_privilege('anon', 'public.holiday_card_family_enabled(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.holiday_card_family_enabled(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.holiday_card_orders_enabled()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.holiday_card_orders_enabled()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.holiday_card_hold_confirm(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.holiday_card_hold_confirm(uuid)', 'EXECUTE'),
  'the three switch gate functions are not executable by clients');
select ok(
  has_function_privilege('service_role', 'public.holiday_card_family_enabled(uuid)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.holiday_card_orders_enabled()', 'EXECUTE')
  and has_function_privilege('service_role', 'public.holiday_card_hold_confirm(uuid)', 'EXECUTE'),
  'service_role can execute the three switch gate functions');
select ok(
  not has_function_privilege('anon', 'public.claim_holiday_card_checkout(uuid, integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.claim_holiday_card_checkout(uuid, integer)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.release_holiday_card_checkout(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.release_holiday_card_checkout(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.create_web_handoff(uuid, text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.create_web_handoff(uuid, text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.claim_web_handoff(text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.claim_web_handoff(text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.save_holiday_card_edits(uuid, integer, jsonb)', 'EXECUTE'),
  'claim / release / handoff / save RPCs are not executable by clients');
select ok(
  has_function_privilege('service_role', 'public.claim_holiday_card_checkout(uuid, integer)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.release_holiday_card_checkout(uuid)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.create_web_handoff(uuid, text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.claim_web_handoff(text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.save_holiday_card_edits(uuid, integer, jsonb)', 'EXECUTE'),
  'service_role can execute the claim / release / handoff / save RPCs');
select ok(
  has_function_privilege('authenticated', 'public.holiday_card_summary(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.holiday_card_summary(uuid)', 'EXECUTE'),
  'holiday_card_summary is the one new function granted to authenticated (not anon)');
select ok(
  not has_column_privilege('authenticated', 'public.holiday_cards', 'checkout_order_id', 'SELECT')
  and not has_column_privilege('authenticated', 'public.holiday_cards', 'checkout_claimed_at', 'SELECT')
  and has_column_privilege('authenticated', 'public.holiday_cards', 'edits_version', 'SELECT'),
  'the claim columns are not readable by clients (P1 column grants kept)');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'fd000000-0000-4000-8000-000000000001', true);
select throws_ok($$select checkout_order_id from public.holiday_cards$$, '42501', null,
  'a client cannot select the claim column');
select throws_ok($$select public.claim_holiday_card_checkout('fd300000-0000-4000-8000-000000000011', 6)$$, '42501', null,
  'a client cannot call the claim RPC');
select throws_ok($$select public.create_web_handoff('fd000000-0000-4000-8000-000000000001', 'hash-client')$$, '42501', null,
  'a client cannot mint a handoff code');
select throws_ok($$select * from public.web_handoff_codes$$, '42501', null, 'a client cannot read handoff codes');
select throws_ok($$select * from public.holiday_card_settings$$, '42501', null, 'a client cannot read the settings');
select throws_ok($$select public.holiday_card_family_enabled('fd100000-0000-4000-8000-000000000001')$$, '42501', null,
  'a client cannot call the service-role gate');
set local role postgres;

select * from finish();
rollback;
