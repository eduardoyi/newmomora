begin;

-- Holiday Cards P1, Step 1 (20261006120000_holiday_cards.sql,
-- docs/plans/holiday-cards-p1.md §4): holiday_cards + holiday_card_orders
-- (grants, RLS, constraints), the card-film SELECT branch on year_films, the
-- service-role card RPCs (create / save edits / attempts / create film / end
-- film / claim by id), the terminal `ended` film status, the forced-film
-- refusal in save_year_film_edits, the widened ledger operations, the
-- deletion fence and the sweep cron job. FICTIONAL data only (public repo).
select plan(139);

-- ---------------------------------------------------------------------------
-- Fixtures (postgres role; assertions switch to authenticated where needed)
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, is_anonymous) values
  ('fc000000-0000-4000-8000-000000000001', 'hc-owner@example.test', false),
  ('fc000000-0000-4000-8000-000000000002', 'hc-manager@example.test', false),
  ('fc000000-0000-4000-8000-000000000003', 'hc-viewer@example.test', false),
  ('fc000000-0000-4000-8000-000000000004', 'hc-outsider@example.test', false),
  ('fc000000-0000-4000-8000-000000000005', 'hc-anon@example.test', true);

insert into public.families (id, name, owner_id) values
  ('fc100000-0000-4000-8000-000000000001', 'Card family', 'fc000000-0000-4000-8000-000000000001'),
  ('fc100000-0000-4000-8000-000000000002', 'Other card family', 'fc000000-0000-4000-8000-000000000004'),
  ('fc100000-0000-4000-8000-000000000003', 'Fence family shipped', 'fc000000-0000-4000-8000-000000000001'),
  ('fc100000-0000-4000-8000-000000000004', 'Fence family passed', 'fc000000-0000-4000-8000-000000000001'),
  ('fc100000-0000-4000-8000-000000000005', 'Fence family in production', 'fc000000-0000-4000-8000-000000000001'),
  ('fc100000-0000-4000-8000-000000000006', 'Fence family stale heartbeat', 'fc000000-0000-4000-8000-000000000001'),
  ('fc100000-0000-4000-8000-000000000007', 'Deleted family', 'fc000000-0000-4000-8000-000000000001'),
  ('fc100000-0000-4000-8000-000000000008', 'Fence family flagged order', 'fc000000-0000-4000-8000-000000000001'),
  ('fc100000-0000-4000-8000-000000000009', 'Fence family refunded order', 'fc000000-0000-4000-8000-000000000001');

-- The anonymous session is a viewer-role member of family A: even as a member
-- it must read nothing (restrictive deny-anonymous policy).
insert into public.family_memberships (family_id, user_id, role) values
  ('fc100000-0000-4000-8000-000000000001', 'fc000000-0000-4000-8000-000000000001', 'owner'),
  ('fc100000-0000-4000-8000-000000000001', 'fc000000-0000-4000-8000-000000000002', 'manager'),
  ('fc100000-0000-4000-8000-000000000001', 'fc000000-0000-4000-8000-000000000003', 'viewer'),
  ('fc100000-0000-4000-8000-000000000001', 'fc000000-0000-4000-8000-000000000005', 'viewer'),
  ('fc100000-0000-4000-8000-000000000002', 'fc000000-0000-4000-8000-000000000004', 'owner'),
  ('fc100000-0000-4000-8000-000000000003', 'fc000000-0000-4000-8000-000000000001', 'owner'),
  ('fc100000-0000-4000-8000-000000000004', 'fc000000-0000-4000-8000-000000000001', 'owner'),
  ('fc100000-0000-4000-8000-000000000005', 'fc000000-0000-4000-8000-000000000001', 'owner'),
  ('fc100000-0000-4000-8000-000000000006', 'fc000000-0000-4000-8000-000000000001', 'owner'),
  ('fc100000-0000-4000-8000-000000000007', 'fc000000-0000-4000-8000-000000000001', 'owner'),
  ('fc100000-0000-4000-8000-000000000008', 'fc000000-0000-4000-8000-000000000001', 'owner'),
  ('fc100000-0000-4000-8000-000000000009', 'fc000000-0000-4000-8000-000000000001', 'owner');

insert into public.owner_entitlements (
  owner_user_id, app_user_id, environment, store, product_id, entitlement_id,
  period_type, status, expires_at, will_renew
) values (
  'fc000000-0000-4000-8000-000000000001', 'fc000000-0000-4000-8000-000000000001',
  'production', 'app_store', 'momora_annual_v1', 'momora_plus', 'annual', 'active',
  transaction_timestamp() + interval '400 days', true
);

update public.year_film_settings set mode = 'all', launch_date = date '2026-01-01', max_concurrent_renders = 12;

-- ---------------------------------------------------------------------------
-- 1. Grants and function privileges
-- ---------------------------------------------------------------------------

select ok(not has_table_privilege('anon', 'public.holiday_cards', 'SELECT, INSERT, UPDATE, DELETE'),
  'anon has no access to holiday cards');
select ok(not has_table_privilege('authenticated', 'public.holiday_cards', 'INSERT, UPDATE, DELETE, TRUNCATE'),
  'authenticated has no write privilege on holiday cards');
select ok(has_column_privilege('authenticated', 'public.holiday_cards', 'film_id', 'SELECT')
  and has_column_privilege('authenticated', 'public.holiday_cards', 'letters', 'SELECT')
  and has_column_privilege('authenticated', 'public.holiday_cards', 'edits', 'SELECT'),
  'authenticated can read the safe card columns');
select ok(not has_column_privilege('authenticated', 'public.holiday_cards', 'editor_facts', 'SELECT')
  and not has_column_privilege('authenticated', 'public.holiday_cards', 'workflow_instance_id', 'SELECT')
  and not has_column_privilege('authenticated', 'public.holiday_cards', 'attempt_id', 'SELECT')
  and not has_column_privilege('authenticated', 'public.holiday_cards', 'heartbeat_at', 'SELECT'),
  'editor_facts and the lease columns are not readable by clients');
select ok(not has_table_privilege('anon', 'public.holiday_card_orders', 'SELECT, INSERT, UPDATE, DELETE'),
  'anon has no access to holiday card orders');
select ok(not has_table_privilege('authenticated', 'public.holiday_card_orders', 'UPDATE, DELETE, TRUNCATE'),
  'authenticated cannot update or delete holiday card orders');
select ok(not has_column_privilege('authenticated', 'public.holiday_card_orders', 'gelato_cost_cents', 'SELECT')
  and not has_column_privilege('authenticated', 'public.holiday_card_orders', 'print_files', 'SELECT'),
  'the internal Gelato cost and print files are not readable by clients');
select ok(has_column_privilege('authenticated', 'public.holiday_card_orders', 'card_id', 'INSERT')
  and not has_column_privilege('authenticated', 'public.holiday_card_orders', 'price_cents', 'INSERT')
  and not has_column_privilege('authenticated', 'public.holiday_card_orders', 'status', 'INSERT'),
  'a client insert can only name its identity columns');
select ok(
  not has_function_privilege('authenticated', 'public.create_holiday_card(uuid, uuid, integer, text, text, text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.create_holiday_card(uuid, uuid, integer, text, text, text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.create_holiday_card(uuid, uuid, integer, text, text, text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.save_holiday_card_edits(uuid, integer, jsonb)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.save_holiday_card_edits(uuid, integer, jsonb)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.increment_holiday_card_generation_attempt(uuid, integer)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.increment_holiday_card_generation_attempt(uuid, integer)', 'EXECUTE'),
  'create / save-edits / attempt RPCs are service role only'
);
select ok(
  not has_function_privilege('authenticated', 'public.create_holiday_card_film(uuid, date, date, text, uuid[])', 'EXECUTE')
  and not has_function_privilege('anon', 'public.create_holiday_card_film(uuid, date, date, text, uuid[])', 'EXECUTE')
  and has_function_privilege('service_role', 'public.create_holiday_card_film(uuid, date, date, text, uuid[])', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.end_holiday_card_film(uuid)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.end_holiday_card_film(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.claim_year_film_by_id(uuid)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.claim_year_film_by_id(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.holiday_card_new_share_token()', 'EXECUTE'),
  'film RPCs are service role only'
);

-- ---------------------------------------------------------------------------
-- 2. create_holiday_card
-- ---------------------------------------------------------------------------

create temp table card_a on commit drop as
select id from public.create_holiday_card(
  'fc100000-0000-4000-8000-000000000001', 'fc000000-0000-4000-8000-000000000001', 2026, 'christmas', 'en', 'en-US'
);
grant select on card_a to authenticated;

select is(
  (select row(status, greeting, language, locale, year, generation_attempts, edits_version, created_by)::text
   from public.holiday_cards where id = (select id from card_a)),
  '(generating,christmas,en,en-US,2026,0,0,fc000000-0000-4000-8000-000000000001)',
  'create_holiday_card inserts a generating card with the chosen greeting'
);
select is(
  (select id from public.create_holiday_card(
    'fc100000-0000-4000-8000-000000000001', 'fc000000-0000-4000-8000-000000000002', 2026, 'new-year', 'es', null)),
  (select id from card_a),
  'a second call for the same family-year returns the existing card (double tap)'
);
select is(
  (select greeting from public.create_holiday_card(
    'fc100000-0000-4000-8000-000000000001', 'fc000000-0000-4000-8000-000000000001', 2026, 'holidays', 'en', null)),
  'christmas',
  'the greeting is fixed at creation: a repeat call never changes it'
);
select is(
  (select count(*)::int from public.holiday_cards where family_id = 'fc100000-0000-4000-8000-000000000001' and year = 2026),
  1, 'exactly one card per family-year after repeated calls'
);
select throws_ok(
  $$select public.create_holiday_card('fc100000-0000-4000-8000-000000000001', 'fc000000-0000-4000-8000-000000000003', 2027, 'christmas', 'en', null)$$,
  '42501', 'Not authorized', 'a viewer cannot create a card'
);
select throws_ok(
  $$select public.create_holiday_card('fc100000-0000-4000-8000-000000000001', 'fc000000-0000-4000-8000-000000000004', 2027, 'christmas', 'en', null)$$,
  '42501', 'Not authorized', 'an outsider cannot create a card'
);
select throws_ok(
  $$select public.create_holiday_card('fc100000-0000-4000-8000-000000000001', 'fc000000-0000-4000-8000-000000000001', 2027, 'birthday', 'en', null)$$,
  '23514', null, 'the greeting is one of christmas | holidays | new-year'
);
select throws_ok(
  $$select public.create_holiday_card('fc100000-0000-4000-8000-000000000001', 'fc000000-0000-4000-8000-000000000001', 2027, 'christmas', 'fr', null)$$,
  '23514', null, 'the language is en | es'
);
select lives_ok(
  $$select public.create_holiday_card('fc100000-0000-4000-8000-000000000001', 'fc000000-0000-4000-8000-000000000002', 2027, 'holidays', 'es', null)$$,
  'a manager can create a card (another year)'
);
select throws_ok(
  $$insert into public.holiday_cards (family_id, year, greeting) values ('fc100000-0000-4000-8000-000000000001', 2026, 'christmas')$$,
  '23505', null, 'the unique (family_id, year) index rejects a duplicate insert'
);

-- Deleting a card does not free the year.
update public.holiday_cards set deleted_at = now()
where family_id = 'fc100000-0000-4000-8000-000000000001' and year = 2027;
select throws_ok(
  $$select public.create_holiday_card('fc100000-0000-4000-8000-000000000001', 'fc000000-0000-4000-8000-000000000001', 2027, 'christmas', 'en', null)$$,
  '23505', 'holiday_card_slot_used', 'a soft-deleted card keeps its year slot used (distinct error)'
);
select throws_ok(
  $$insert into public.holiday_cards (family_id, year, greeting) values ('fc100000-0000-4000-8000-000000000001', 2027, 'christmas')$$,
  '23505', null, 'the unique index includes soft-deleted rows'
);

update public.holiday_cards set editor_facts = '{"facts":["a fictional fact"]}'::jsonb, letters = '{"classic":"Dear friends"}'::jsonb
where id = (select id from card_a);

-- ---------------------------------------------------------------------------
-- 3. holiday_cards RLS
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', 'fc000000-0000-4000-8000-000000000001', true);
select is((select count(*)::int from public.holiday_cards), 1, 'the owner reads the family''s live card (not the soft-deleted one)');
select is((select letters ->> 'classic' from public.holiday_cards where id = (select id from card_a)), 'Dear friends',
  'the owner reads the letters');
select throws_ok($$select editor_facts from public.holiday_cards$$, '42501', null,
  'a client cannot select editor_facts');
select throws_ok($$select attempt_id from public.holiday_cards$$, '42501', null,
  'a client cannot select the lease');
select throws_ok($$insert into public.holiday_cards (family_id, year, greeting) values ('fc100000-0000-4000-8000-000000000001', 2031, 'christmas')$$,
  '42501', null, 'a client cannot insert a card');
select throws_ok($$update public.holiday_cards set signature = 'x'$$, '42501', null, 'a client cannot update a card');
select throws_ok($$delete from public.holiday_cards$$, '42501', null, 'a client cannot delete a card');

select set_config('request.jwt.claim.sub', 'fc000000-0000-4000-8000-000000000002', true);
select is((select count(*)::int from public.holiday_cards), 1, 'a manager reads the family''s live card');

select set_config('request.jwt.claim.sub', 'fc000000-0000-4000-8000-000000000003', true);
select is((select count(*)::int from public.holiday_cards), 0, 'a viewer reads no cards');

select set_config('request.jwt.claim.sub', 'fc000000-0000-4000-8000-000000000005', true);
select is((select count(*)::int from public.holiday_cards), 0, 'an anonymous session reads no cards even as a member');

select set_config('request.jwt.claim.sub', 'fc000000-0000-4000-8000-000000000004', true);
select is((select count(*)::int from public.holiday_cards), 0, 'an outsider reads no cards');

set local role anon;
select throws_ok($$select id from public.holiday_cards$$, '42501', null, 'the anon role is denied');
set local role postgres;

-- ---------------------------------------------------------------------------
-- 4. save_holiday_card_edits (CAS)
-- ---------------------------------------------------------------------------

select is(
  public.save_holiday_card_edits((select id from card_a), 0, '{"signature":"The Fictional Family"}'::jsonb),
  1, 'save_holiday_card_edits returns the new version'
);
select is(
  (select edits ->> 'signature' from public.holiday_cards where id = (select id from card_a)),
  'The Fictional Family', 'the edits were stored'
);
select throws_ok(
  $$select public.save_holiday_card_edits((select id from card_a), 0, '{"signature":"stale"}'::jsonb)$$,
  '40001', 'edits_version_mismatch', 'a stale expected version raises'
);
select throws_ok(
  $$select public.save_holiday_card_edits((select id from card_a), 1, '[]'::jsonb)$$,
  '22023', 'invalid_edits', 'edits must be a JSON object'
);
select throws_ok(
  $$select public.save_holiday_card_edits('fc200000-0000-4000-8000-0000000000ff', 0, '{}'::jsonb)$$,
  'P0002', 'holiday_card_not_found', 'an unknown card raises'
);

-- An order in 'checkout' freezes edits.
insert into public.holiday_card_orders (
  id, card_id, family_id, requested_by, status, price_cents, packs, shipping_address, card_snapshot, snapshot_hash
) values (
  'fc300000-0000-4000-8000-000000000001', (select id from card_a), 'fc100000-0000-4000-8000-000000000001',
  'fc000000-0000-4000-8000-000000000002', 'checkout', 2490, 1, '{"country":"US"}'::jsonb, '{"v":1}'::jsonb, 'hash-a'
);
select throws_ok(
  $$select public.save_holiday_card_edits((select id from card_a), 1, '{"signature":"during checkout"}'::jsonb)$$,
  '55000', 'holiday_card_checkout_open', 'edits are refused while an order is in checkout'
);
update public.holiday_card_orders set status = 'cancelled' where id = 'fc300000-0000-4000-8000-000000000001';
select is(
  public.save_holiday_card_edits((select id from card_a), 1, '{"signature":"after checkout"}'::jsonb),
  2, 'edits are accepted again once the checkout is over'
);

-- ---------------------------------------------------------------------------
-- 5. increment_holiday_card_generation_attempt
-- ---------------------------------------------------------------------------

select is(public.increment_holiday_card_generation_attempt((select id from card_a), 2), 1, 'first attempt');
select is(public.increment_holiday_card_generation_attempt((select id from card_a), 2), 2, 'second attempt');
select is(public.increment_holiday_card_generation_attempt((select id from card_a), 2), null, 'null at the cap: do not dispatch');
select is((select generation_attempts from public.holiday_cards where id = (select id from card_a)), 2,
  'the counter never passes the cap');
select is(
  public.increment_holiday_card_generation_attempt(
    (select id from public.holiday_cards where family_id = 'fc100000-0000-4000-8000-000000000001' and year = 2027), 5),
  null, 'a soft-deleted card is never dispatched'
);

-- ---------------------------------------------------------------------------
-- 6. holiday_card_orders: RLS, grants, constraints
-- ---------------------------------------------------------------------------

delete from public.holiday_card_orders;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'fc000000-0000-4000-8000-000000000002', true);
select lives_ok(
  $$insert into public.holiday_card_orders (id, card_id, family_id, requested_by)
    values ('fc300000-0000-4000-8000-000000000011', (select id from card_a), 'fc100000-0000-4000-8000-000000000001',
            'fc000000-0000-4000-8000-000000000002')$$,
  'a manager inserts a bare draft claiming themselves as buyer'
);
select throws_ok(
  $$insert into public.holiday_card_orders (card_id, family_id, requested_by)
    values ((select id from card_a), 'fc100000-0000-4000-8000-000000000001', 'fc000000-0000-4000-8000-000000000001')$$,
  '42501', null, 'a manager cannot claim another account as buyer'
);
select throws_ok(
  $$insert into public.holiday_card_orders (card_id, family_id, requested_by, price_cents)
    values ((select id from card_a), 'fc100000-0000-4000-8000-000000000001', 'fc000000-0000-4000-8000-000000000002', 1)$$,
  '42501', null, 'a client cannot seed a price (no column grant)'
);
select throws_ok(
  $$insert into public.holiday_card_orders (card_id, family_id, requested_by, status)
    values ((select id from card_a), 'fc100000-0000-4000-8000-000000000001', 'fc000000-0000-4000-8000-000000000002', 'paid')$$,
  '42501', null, 'a client cannot insert past draft'
);
select throws_ok(
  $$insert into public.holiday_card_orders (card_id, family_id, requested_by)
    values ((select id from card_a), 'fc100000-0000-4000-8000-000000000002', 'fc000000-0000-4000-8000-000000000002')$$,
  '42501', null, 'a card of one family cannot be ordered under another family'
);
select is((select count(*)::int from public.holiday_card_orders), 1, 'the buyer reads their own order');
select throws_ok($$select gelato_cost_cents from public.holiday_card_orders$$, '42501', null,
  'the buyer cannot read the internal Gelato cost');
select throws_ok($$update public.holiday_card_orders set status = 'paid'$$, '42501', null, 'a client cannot update an order');
select throws_ok($$delete from public.holiday_card_orders$$, '42501', null, 'a client cannot delete an order');

select set_config('request.jwt.claim.sub', 'fc000000-0000-4000-8000-000000000001', true);
select is((select count(*)::int from public.holiday_card_orders), 0,
  'the owner cannot read a manager''s order: buyer only');
select throws_ok(
  $$insert into public.holiday_card_orders (card_id, family_id, requested_by)
    values (null, 'fc100000-0000-4000-8000-000000000001', 'fc000000-0000-4000-8000-000000000001')$$,
  '42501', null, 'a draft needs a card of the same family (card_id null refused)'
);

select set_config('request.jwt.claim.sub', 'fc000000-0000-4000-8000-000000000003', true);
select throws_ok(
  $$insert into public.holiday_card_orders (card_id, family_id, requested_by)
    values ((select id from card_a), 'fc100000-0000-4000-8000-000000000001', 'fc000000-0000-4000-8000-000000000003')$$,
  '42501', null, 'a viewer cannot start an order'
);
select is((select count(*)::int from public.holiday_card_orders), 0, 'a viewer reads no orders');

select set_config('request.jwt.claim.sub', 'fc000000-0000-4000-8000-000000000004', true);
select throws_ok(
  $$insert into public.holiday_card_orders (card_id, family_id, requested_by)
    values ((select id from card_a), 'fc100000-0000-4000-8000-000000000002', 'fc000000-0000-4000-8000-000000000004')$$,
  '42501', null, 'an outsider cannot order another family''s card'
);
set local role postgres;

select throws_ok(
  $$update public.holiday_card_orders set status = 'quoted' where id = 'fc300000-0000-4000-8000-000000000011'$$,
  '23514', null, 'a quoted order must carry the quote bundle'
);
select throws_ok(
  $$update public.holiday_card_orders set status = 'checkout', price_cents = 2490, packs = 1,
      shipping_address = '{"country":"US"}'::jsonb where id = 'fc300000-0000-4000-8000-000000000011'$$,
  '23514', null, 'a checkout order must carry the frozen snapshot'
);
select throws_ok(
  $$update public.holiday_card_orders set status = 'failed' where id = 'fc300000-0000-4000-8000-000000000011'$$,
  '23514', null, 'a failed order must carry a reason'
);
select throws_ok(
  $$update public.holiday_card_orders set status = 'delivered' where id = 'fc300000-0000-4000-8000-000000000011'$$,
  '23514', null, 'delivered is not a card order status (nothing sets it)'
);
select lives_ok(
  $$update public.holiday_card_orders set status = 'quoted', price_cents = 2490, packs = 1, currency = 'usd',
      shipping_address = '{"country":"US"}'::jsonb where id = 'fc300000-0000-4000-8000-000000000011'$$,
  'the service role can quote an order'
);

-- Deleting the card keeps the purchase record (card_id set null).
create temp table card_del on commit drop as
select id from public.create_holiday_card(
  'fc100000-0000-4000-8000-000000000001', 'fc000000-0000-4000-8000-000000000001', 2030, 'holidays', 'en', null
);
insert into public.holiday_card_orders (id, card_id, family_id, requested_by)
values ('fc300000-0000-4000-8000-000000000012', (select id from card_del), 'fc100000-0000-4000-8000-000000000001',
        'fc000000-0000-4000-8000-000000000001');
delete from public.holiday_cards where id = (select id from card_del);
select is(
  (select card_id from public.holiday_card_orders where id = 'fc300000-0000-4000-8000-000000000012'),
  null, 'deleting a card sets the order''s card_id to null (the order survives)'
);

-- ---------------------------------------------------------------------------
-- 7. create_holiday_card_film
-- ---------------------------------------------------------------------------

create temp table film_a on commit drop as
select film_id, token from public.create_holiday_card_film(
  (select id from card_a), date '2026-01-01', date '2026-10-07', 'christmas',
  array['fc400000-0000-4000-8000-000000000001', 'fc400000-0000-4000-8000-000000000002']::uuid[]
);
grant select on film_a to authenticated;

select is((select count(*)::int from film_a), 1, 'create_holiday_card_film returns one (film_id, token)');
select matches((select token from film_a), '^[A-Za-z0-9]{22}$', 'the token is 22 base62 characters');
select is(
  (select row(kind, forced, status, scope_start_date, scope_end_exclusive, language, family_id)::text
   from public.year_films where id = (select film_id from film_a)),
  '(family_holiday,t,queued,2026-01-01,2026-10-07,en,fc100000-0000-4000-8000-000000000001)',
  'a forced, queued family_holiday film with the card''s scope and language'
);
select is(
  (select edits::text from public.year_films where id = (select film_id from film_a)),
  '{"greeting": "christmas", "preferredCloseMedia": ["fc400000-0000-4000-8000-000000000001", "fc400000-0000-4000-8000-000000000002"]}',
  'edits carry the greeting and the preferred closing shots'
);
select is(
  (select row(film_id, share_token)::text from public.holiday_cards where id = (select id from card_a)),
  (select row(film_id, token)::text from film_a),
  'the card links the film and the token'
);
select is(
  (select count(*)::int from public.film_share_tokens where film_id = (select film_id from film_a) and revoked_at is null),
  1, 'one active share token for the film'
);
select is(
  (select row(film_id, token)::text from public.create_holiday_card_film(
    (select id from card_a), date '2026-02-02', date '2026-03-03', 'christmas', '{}'::uuid[])),
  (select row(film_id, token)::text from film_a),
  'a second call is a no-op: same film, same token'
);
select is(
  (select count(*)::int from public.year_films where family_id = 'fc100000-0000-4000-8000-000000000001' and kind = 'family_holiday'),
  1, 'retries never create a second film'
);
select is(
  (select count(*)::int from public.film_share_tokens where film_id = (select film_id from film_a)),
  1, 'retries never mint a second token'
);

create temp table card_b on commit drop as
select id from public.create_holiday_card(
  'fc100000-0000-4000-8000-000000000001', 'fc000000-0000-4000-8000-000000000001', 2028, 'new-year', 'es', null
);
select throws_ok(
  $$select * from public.create_holiday_card_film((select id from card_b), date '2028-01-01', date '2028-10-07', 'christmas', '{}'::uuid[])$$,
  '22023', 'greeting_mismatch', 'the film greeting must be the card''s greeting'
);
select is(
  (select count(*)::int from public.year_films where family_id = 'fc100000-0000-4000-8000-000000000001'
     and scope_start_date = date '2028-01-01'),
  0, 'a refused call leaves no film behind'
);
select throws_ok(
  $$select * from public.create_holiday_card_film('fc200000-0000-4000-8000-0000000000ff', date '2028-01-01', date '2028-10-07', 'christmas', '{}'::uuid[])$$,
  'P0002', 'holiday_card_not_found', 'an unknown card raises'
);

-- ---------------------------------------------------------------------------
-- 8. The card-film SELECT branch
-- ---------------------------------------------------------------------------

-- An unrelated forced holiday film (the dogfood shape): not referenced by any
-- card, so it stays operator-only.
insert into public.year_films (id, family_id, kind, forced, scope_start_date, scope_end_exclusive, surface_at, status, ready_at)
values ('fc500000-0000-4000-8000-000000000001', 'fc100000-0000-4000-8000-000000000001', 'family_holiday', true,
        '2025-01-01', '2025-12-01', now(), 'ready', now());
insert into public.film_share_tokens (token, film_id) values ('Dogfood000000000000000', 'fc500000-0000-4000-8000-000000000001');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'fc000000-0000-4000-8000-000000000001', true);
select is((select count(*)::int from public.year_films where id = (select film_id from film_a)), 1,
  'the owner reads the card''s film');
select is((select status from public.year_films where id = (select film_id from film_a)), 'queued',
  'including the status of a not-yet-ready film');
select is((select count(*)::int from public.year_films where id = 'fc500000-0000-4000-8000-000000000001'), 0,
  'a forced film no card references stays hidden');
select throws_ok($$select video_key from public.year_films$$, '42501', null,
  'the video key stays ungranted');
select is((select count(*)::int from public.film_share_tokens where film_id = (select film_id from film_a)), 1,
  'the owner reads the card film''s share token');
select is((select count(*)::int from public.film_share_tokens where film_id = 'fc500000-0000-4000-8000-000000000001'), 0,
  'the unreferenced film''s token stays service-role only');

select set_config('request.jwt.claim.sub', 'fc000000-0000-4000-8000-000000000002', true);
select is((select count(*)::int from public.year_films where id = (select film_id from film_a)), 1,
  'a manager reads the card''s film');

select set_config('request.jwt.claim.sub', 'fc000000-0000-4000-8000-000000000003', true);
select is((select count(*)::int from public.year_films where id = (select film_id from film_a)), 0,
  'a viewer does not read the card''s film');

select set_config('request.jwt.claim.sub', 'fc000000-0000-4000-8000-000000000005', true);
select is((select count(*)::int from public.year_films where id = (select film_id from film_a)), 0,
  'an anonymous session does not read the card''s film');

select set_config('request.jwt.claim.sub', 'fc000000-0000-4000-8000-000000000004', true);
select is((select count(*)::int from public.year_films where id = (select film_id from film_a)), 0,
  'an outsider does not read the card''s film');
set local role postgres;

update public.holiday_cards set deleted_at = now() where id = (select id from card_a);
set local role authenticated;
select set_config('request.jwt.claim.sub', 'fc000000-0000-4000-8000-000000000001', true);
select is((select count(*)::int from public.year_films where id = (select film_id from film_a)), 0,
  'a soft-deleted card no longer exposes its film');
set local role postgres;
update public.holiday_cards set deleted_at = null where id = (select id from card_a);

-- ---------------------------------------------------------------------------
-- 9. claim_year_film_by_id
-- ---------------------------------------------------------------------------

insert into public.year_films (id, family_id, kind, forced, scope_start_date, scope_end_exclusive, surface_at, status)
values ('fc500000-0000-4000-8000-000000000002', 'fc100000-0000-4000-8000-000000000001', 'family_month', false,
        '2026-08-01', '2026-09-01', now(), 'queued');
select is((select count(*)::int from public.claim_year_film_by_id('fc500000-0000-4000-8000-000000000002')), 0,
  'a non-forced film is never claimed by id (the scheduler owns it)');

update public.year_film_settings set mode = 'off';
select is((select count(*)::int from public.claim_year_film_by_id((select film_id from film_a))), 0,
  'zero rows while the rollout excludes the family (a normal outcome)');
update public.year_film_settings set mode = 'all';

select is(
  (select row(status, attempt_count, attempt_id is null)::text from public.year_films where id = (select film_id from film_a)),
  '(queued,0,t)', 'the film is still queued before the claim'
);
create temp table claim_a on commit drop as select * from public.claim_year_film_by_id((select film_id from film_a));
select is(
  (select row(film_id = (select film_id from film_a), attempt_id is not null, family_id)::text from claim_a),
  '(t,t,fc100000-0000-4000-8000-000000000001)', 'the claim returns (film_id, attempt_id, family_id)'
);
select is(
  (select row(status, attempt_count, attempt_id = (select attempt_id from claim_a), heartbeat_at is not null)::text
   from public.year_films where id = (select film_id from film_a)),
  '(curating,1,t,t)', 'CAS queued -> curating with the same attempt semantics as the cron claim'
);
select is((select count(*)::int from public.claim_year_film_by_id((select film_id from film_a))), 0,
  'a second claim returns zero rows (already claimed)');

-- A retry spacing is respected.
update public.year_films set status = 'queued', attempt_id = null, next_attempt_at = now() + interval '1 hour'
where id = (select film_id from film_a);
select is((select count(*)::int from public.claim_year_film_by_id((select film_id from film_a))), 0,
  'next_attempt_at spacing is respected');
update public.year_films set next_attempt_at = null where id = (select film_id from film_a);
select is((select count(*)::int from public.claim_year_film_by_id((select film_id from film_a))), 1,
  'claimable again once the spacing has passed');

-- ---------------------------------------------------------------------------
-- 10. `ended` films
-- ---------------------------------------------------------------------------

-- Card for 2029 with a film that already rendered (a real video).
create temp table card_e on commit drop as
select id from public.create_holiday_card(
  'fc100000-0000-4000-8000-000000000001', 'fc000000-0000-4000-8000-000000000001', 2029, 'holidays', 'en', null
);
create temp table film_e on commit drop as
select film_id, token from public.create_holiday_card_film(
  (select id from card_e), date '2029-01-01', date '2029-10-07', 'holidays', '{}'::uuid[]
);
update public.year_films
set status = 'ready', video_key = 'o/year-films/e/a/film.mp4', poster_key = 'o/year-films/e/a/poster.jpg',
    scenes_key = 'o/year-films/e/a/scenes.json', duration_ms = 30000, ready_at = now(), cleanup_needed = false
where id = (select film_id from film_e);

create temp table ended_e on commit drop as
select public.end_holiday_card_film((select id from card_e)) as result;
select is((select (result ->> 'ended')::boolean from ended_e), true, 'end_holiday_card_film reports ended');
select is(
  (select result -> 'delete_keys' from ended_e),
  '["o/year-films/e/a/film.mp4", "o/year-films/e/a/poster.jpg", "o/year-films/e/a/poster_thumb.jpg", "o/year-films/e/a/scenes.json"]'::jsonb,
  'it hands back the artifact keys (poster thumb included)'
);
select is(
  (select row(status, video_key, poster_key, scenes_key, duration_ms, attempt_id, cleanup_needed)::text
   from public.year_films where id = (select film_id from film_e)),
  '(ended,,,,,,t)', 'status ended, keys and attempt cleared, cleanup flagged'
);
select is(
  (select count(*)::int from public.film_share_tokens where film_id = (select film_id from film_e) and revoked_at is null),
  0, 'the share token is revoked'
);
select is(
  (select deleted_at is null from public.holiday_cards where id = (select id from card_e)),
  true, 'ending the film soft-deletes nothing else'
);
select is(
  (public.end_holiday_card_film((select id from card_e)) ->> 'ended')::boolean, true,
  'ending again is idempotent'
);
select ok(
  exists (select 1 from public.year_films_needing_cleanup(50) where film_id = (select film_id from film_e) and video_key is null),
  'the existing cleanup listing picks the ended film up (video_key null releases every artifact)'
);

-- Skipped by every scheduler path, even when made as eligible as possible.
update public.year_films
set requeue_after = now() - interval '1 hour', next_attempt_at = null, heartbeat_at = now() - interval '2 hours'
where id = (select film_id from film_e);
select is((select count(*)::int from public.claim_year_film_dispatch(100) where film_id = (select film_id from film_e)), 0,
  'claim_year_film_dispatch skips an ended film');
select is((select count(*)::int from public.claim_year_film_by_id((select film_id from film_e))), 0,
  'claim_year_film_by_id skips an ended film');
select is(public.year_film_promote_requeues(now()), 0, 'year_film_promote_requeues skips an ended film');
select is((public.year_film_recover(now()) ->> 'retried')::int + (public.year_film_recover(now()) ->> 'ended')::int, 0,
  'year_film_recover skips an ended film');
update public.year_films set video_key = 'o/leftover.mp4', poster_key = 'o/leftover.jpg' where id = (select film_id from film_e);
select is(public.year_film_invalidate(array[(select film_id from film_e)], true), 0,
  'year_film_invalidate skips an ended film even with a stray video key');
select is(
  (select row(status, content_epoch, blocked)::text from public.year_films where id = (select film_id from film_e)),
  '(ended,0,f)', 'the ended film is untouched by all of them'
);

-- An in-flight attempt is superseded.
create temp table card_f on commit drop as
select id from public.create_holiday_card(
  'fc100000-0000-4000-8000-000000000001', 'fc000000-0000-4000-8000-000000000001', 2032, 'christmas', 'en', null
);
create temp table film_f on commit drop as
select film_id from public.create_holiday_card_film((select id from card_f), date '2032-01-01', date '2032-10-07', 'christmas', '{}'::uuid[]);
create temp table claim_f on commit drop as select * from public.claim_year_film_by_id((select film_id from film_f));
select is(public.year_film_heartbeat((select film_id from claim_f), (select attempt_id from claim_f), null), 'ok',
  'the in-flight attempt heartbeats before the card is deleted');
select is(
  (public.end_holiday_card_film((select id from card_f)) ->> 'film_id')::uuid, (select film_id from film_f),
  'ending an in-flight film names it'
);
select is(public.year_film_heartbeat((select film_id from claim_f), (select attempt_id from claim_f), null), 'superseded',
  'an in-flight attempt is superseded when the film ends');
select is(
  public.publish_year_film((select film_id from claim_f), (select attempt_id from claim_f), 0, 'k.mp4', 'k.jpg', null, 1000) ->> 'reason',
  'superseded', 'its publish CAS fails'
);
select is(
  (select film_id is not null from public.holiday_cards where id = (select id from card_f)),
  true, 'the card keeps its film link (the film row is never deleted)'
);
select is(
  (public.end_holiday_card_film((select id from card_b)) ->> 'ended')::boolean, false,
  'a card with no film ends nothing'
);
select throws_ok(
  $$select public.end_holiday_card_film('fc200000-0000-4000-8000-0000000000ff')$$,
  'P0002', 'holiday_card_not_found', 'an unknown card raises'
);

-- ---------------------------------------------------------------------------
-- 11. save_year_film_edits refuses forced films
-- ---------------------------------------------------------------------------

-- A non-forced ready film the manager may edit (non-vacuous baseline).
insert into public.year_films (id, family_id, kind, forced, scope_start_date, scope_end_exclusive, surface_at, status,
                               video_key, poster_key, ready_at)
values ('fc500000-0000-4000-8000-000000000003', 'fc100000-0000-4000-8000-000000000001', 'family_month', false,
        '2026-07-01', '2026-08-01', now() - interval '1 hour', 'ready', 'o/m.mp4', 'o/m.jpg', now());
update public.year_films
set status = 'ready', video_key = 'o/card.mp4', poster_key = 'o/card.jpg', ready_at = now(), attempt_id = null
where id = (select film_id from film_a);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'fc000000-0000-4000-8000-000000000002', true);
select is(
  public.save_year_film_edits('fc500000-0000-4000-8000-000000000003', '{}'::jsonb) ->> 'ok', 'true',
  'a manager can still save edits on a regular film'
);
select throws_ok(
  $$select public.save_year_film_edits((select film_id from film_a), '{}'::jsonb)$$,
  '42501', 'Not authorized', 'a manager cannot save edits on the card''s (forced) film'
);
select set_config('request.jwt.claim.sub', 'fc000000-0000-4000-8000-000000000001', true);
select throws_ok(
  $$select public.save_year_film_edits((select film_id from film_a), '{}'::jsonb)$$,
  '42501', 'Not authorized', 'nor can the owner'
);
select throws_ok(
  $$select public.get_year_film_edit_options((select film_id from film_a))$$,
  '42501', 'Not authorized', 'the edit sheet RPC refuses the card film too'
);
set local role postgres;
select is(
  (select row(status, edits_version)::text from public.year_films where id = (select film_id from film_a)),
  '(ready,0)', 'the card film was not re-queued or versioned'
);

-- ---------------------------------------------------------------------------
-- 12. Ledger operations
-- ---------------------------------------------------------------------------

select lives_ok(
  $$insert into public.ai_usage_events (ai_call_id, attribution_scope, family_id, actor_user_id, operation, model, success)
    values ('hc-test-1', 'family', 'fc100000-0000-4000-8000-000000000001', 'fc000000-0000-4000-8000-000000000001', 'holiday_card_writer', 'gpt-6-luna', true),
           ('hc-test-2', 'family', 'fc100000-0000-4000-8000-000000000001', 'fc000000-0000-4000-8000-000000000001', 'holiday_card_front_judge', 'gpt-6-luna', true),
           ('hc-test-3', 'family', 'fc100000-0000-4000-8000-000000000001', 'fc000000-0000-4000-8000-000000000001', 'holiday_card_voice', 'gpt-6-luna', true),
           ('hc-test-4', 'family', 'fc100000-0000-4000-8000-000000000001', 'fc000000-0000-4000-8000-000000000001', 'holiday_card_details', 'gpt-6-luna', true),
           ('hc-test-5', 'family', 'fc100000-0000-4000-8000-000000000001', 'fc000000-0000-4000-8000-000000000001', 'holiday_card_editor', 'gpt-6-luna', true),
           ('hc-test-6', 'family', 'fc100000-0000-4000-8000-000000000001', 'fc000000-0000-4000-8000-000000000001', 'holiday_card_quote_check', 'gpt-6-luna', true),
           ('hc-test-7', 'family', 'fc100000-0000-4000-8000-000000000001', 'fc000000-0000-4000-8000-000000000001', 'year_film_audio', 'gpt-6-luna', true),
           ('hc-test-8', 'family', 'fc100000-0000-4000-8000-000000000001', 'fc000000-0000-4000-8000-000000000001', 'illustration', 'gpt-6-luna', true)$$,
  'the ledger accepts the six holiday_card_* operations and keeps the existing ones'
);
select throws_ok(
  $$insert into public.ai_usage_events (ai_call_id, attribution_scope, family_id, actor_user_id, operation, model, success)
    values ('hc-test-9', 'family', 'fc100000-0000-4000-8000-000000000001', 'fc000000-0000-4000-8000-000000000001', 'holiday_card_refresh', 'gpt-6-luna', true)$$,
  '23514', null, 'an unknown operation is still rejected'
);
select is(
  (select convalidated from pg_constraint where conname = 'ai_usage_events_operation_check' and conrelid = 'public.ai_usage_events'::regclass),
  true, 'the widened operation check is validated'
);

-- ---------------------------------------------------------------------------
-- 13. claim_family_deletion_fence
-- ---------------------------------------------------------------------------

-- Family A: a generating card with a fresh heartbeat blocks.
insert into public.holiday_cards (id, family_id, year, greeting, status, heartbeat_at)
values ('fc200000-0000-4000-8000-000000000020', 'fc100000-0000-4000-8000-000000000003', 2026, 'christmas', 'generating', now());
select throws_ok(
  $$select public.claim_family_deletion_fence('fc100000-0000-4000-8000-000000000003', gen_random_uuid())$$,
  '55000', 'Fresh holiday card generation is still active', 'a generating card with a fresh heartbeat blocks family deletion'
);
update public.holiday_cards set heartbeat_at = now() - interval '30 minutes' where id = 'fc200000-0000-4000-8000-000000000020';
update public.holiday_cards set status = 'ready' where id = 'fc200000-0000-4000-8000-000000000020';

-- Orders, one family per non-blocking case (a successful fence mutates the family).
insert into public.holiday_card_orders (id, card_id, family_id, requested_by, status, price_cents, packs, shipping_address, card_snapshot, snapshot_hash, gelato_status)
values
  ('fc300000-0000-4000-8000-000000000031', 'fc200000-0000-4000-8000-000000000020', 'fc100000-0000-4000-8000-000000000003',
   'fc000000-0000-4000-8000-000000000001', 'paid', 2490, 1, '{"country":"US"}', '{"v":1}', 'h', null);
select throws_ok(
  $$select public.claim_family_deletion_fence('fc100000-0000-4000-8000-000000000003', gen_random_uuid())$$,
  '55000', 'A holiday card order is still waiting for Gelato to fetch its files',
  'a paid order whose files Gelato has not fetched blocks family deletion'
);
update public.holiday_card_orders set status = 'submitted', gelato_status = 'created' where id = 'fc300000-0000-4000-8000-000000000031';
select throws_ok(
  $$select public.claim_family_deletion_fence('fc100000-0000-4000-8000-000000000003', gen_random_uuid())$$,
  '55000', null, 'a submitted order Gelato still reports as created blocks too'
);
update public.holiday_card_orders set gelato_status = 'draft' where id = 'fc300000-0000-4000-8000-000000000031';
select throws_ok(
  $$select public.claim_family_deletion_fence('fc100000-0000-4000-8000-000000000003', gen_random_uuid())$$,
  '55000', null, 'a submitted order still at the draft stage blocks'
);
update public.holiday_card_orders set status = 'shipped', gelato_status = 'shipped', shipped_at = now() where id = 'fc300000-0000-4000-8000-000000000031';
select is(
  public.claim_family_deletion_fence('fc100000-0000-4000-8000-000000000003', gen_random_uuid()), true,
  'a shipped order does not block family deletion (stale generation heartbeat neither)'
);

insert into public.holiday_cards (id, family_id, year, greeting, status)
values ('fc200000-0000-4000-8000-000000000021', 'fc100000-0000-4000-8000-000000000004', 2026, 'christmas', 'ready');
insert into public.holiday_card_orders (card_id, family_id, requested_by, status, price_cents, packs, shipping_address, card_snapshot, snapshot_hash, gelato_status)
values ('fc200000-0000-4000-8000-000000000021', 'fc100000-0000-4000-8000-000000000004',
        'fc000000-0000-4000-8000-000000000001', 'submitted', 2490, 1, '{"country":"US"}', '{"v":1}', 'h', 'passed');
select is(
  public.claim_family_deletion_fence('fc100000-0000-4000-8000-000000000004', gen_random_uuid()), true,
  'a submitted order Gelato reports as passed (files fetched) does not block'
);

insert into public.holiday_cards (id, family_id, year, greeting, status)
values ('fc200000-0000-4000-8000-000000000022', 'fc100000-0000-4000-8000-000000000005', 2026, 'christmas', 'ready');
insert into public.holiday_card_orders (card_id, family_id, requested_by, status, price_cents, packs, shipping_address, card_snapshot, snapshot_hash)
values ('fc200000-0000-4000-8000-000000000022', 'fc100000-0000-4000-8000-000000000005',
        'fc000000-0000-4000-8000-000000000001', 'in_production', 2490, 1, '{"country":"US"}', '{"v":1}', 'h');
select is(
  public.claim_family_deletion_fence('fc100000-0000-4000-8000-000000000005', gen_random_uuid()), true,
  'an in_production order does not block'
);

insert into public.holiday_cards (id, family_id, year, greeting, status, heartbeat_at)
values ('fc200000-0000-4000-8000-000000000023', 'fc100000-0000-4000-8000-000000000006', 2026, 'christmas', 'generating',
        now() - interval '30 minutes');
select is(
  public.claim_family_deletion_fence('fc100000-0000-4000-8000-000000000006', gen_random_uuid()), true,
  'a generating card with a stale heartbeat does not block'
);

-- Orders parked for a human never block (they would block hard-delete forever);
-- a clean paid order still does (asserted above).
insert into public.holiday_cards (id, family_id, year, greeting, status)
values ('fc200000-0000-4000-8000-000000000024', 'fc100000-0000-4000-8000-000000000008', 2026, 'christmas', 'ready'),
       ('fc200000-0000-4000-8000-000000000025', 'fc100000-0000-4000-8000-000000000009', 2026, 'christmas', 'ready');
insert into public.holiday_card_orders (card_id, family_id, requested_by, status, price_cents, packs, shipping_address, card_snapshot, snapshot_hash, failure_reason)
values ('fc200000-0000-4000-8000-000000000024', 'fc100000-0000-4000-8000-000000000008',
        'fc000000-0000-4000-8000-000000000001', 'paid', 2490, 1, '{"country":"US"}', '{"v":1}', 'h', 'PAYMENT_MISMATCH_AMOUNT');
select is(
  public.claim_family_deletion_fence('fc100000-0000-4000-8000-000000000008', gen_random_uuid()), true,
  'a paid order flagged with a failure_reason does not block'
);
insert into public.holiday_card_orders (card_id, family_id, requested_by, status, price_cents, packs, shipping_address, card_snapshot, snapshot_hash, refunded_at)
values ('fc200000-0000-4000-8000-000000000025', 'fc100000-0000-4000-8000-000000000009',
        'fc000000-0000-4000-8000-000000000001', 'paid', 2490, 1, '{"country":"US"}', '{"v":1}', 'h', now());
select is(
  public.claim_family_deletion_fence('fc100000-0000-4000-8000-000000000009', gen_random_uuid()), true,
  'a refunded paid order does not block'
);

-- The original film check is intact.
update public.year_films set status = 'rendering', heartbeat_at = now() where id = (select film_id from film_a);
select throws_ok(
  $$select public.claim_family_deletion_fence('fc100000-0000-4000-8000-000000000001', gen_random_uuid())$$,
  '55000', 'Fresh year film generation is still active', 'an in-flight card film still blocks family deletion'
);
update public.year_films set status = 'ready', heartbeat_at = null where id = (select film_id from film_a);

-- ---------------------------------------------------------------------------
-- 14. Family deletion with a card, its film, token and an order
-- ---------------------------------------------------------------------------

insert into public.holiday_cards (id, family_id, year, greeting, status)
values ('fc200000-0000-4000-8000-000000000030', 'fc100000-0000-4000-8000-000000000007', 2026, 'christmas', 'ready');
select * from public.create_holiday_card_film('fc200000-0000-4000-8000-000000000030', date '2026-01-01', date '2026-10-07', 'christmas', '{}'::uuid[]);
insert into public.holiday_card_orders (id, card_id, family_id, requested_by, status, price_cents, packs, shipping_address, card_snapshot, snapshot_hash)
values ('fc300000-0000-4000-8000-000000000040', 'fc200000-0000-4000-8000-000000000030', 'fc100000-0000-4000-8000-000000000007',
        'fc000000-0000-4000-8000-000000000001', 'shipped', 2490, 1, '{"country":"US"}', '{"v":1}', 'h');
select lives_ok(
  $$delete from public.families where id = 'fc100000-0000-4000-8000-000000000007'$$,
  'deleting a family with a card, a film, a token and an order does not error'
);
select is(
  (select (select count(*) from public.holiday_cards where family_id = 'fc100000-0000-4000-8000-000000000007')
        + (select count(*) from public.holiday_card_orders where family_id = 'fc100000-0000-4000-8000-000000000007')
        + (select count(*) from public.year_films where family_id = 'fc100000-0000-4000-8000-000000000007')
        + (select count(*) from public.film_share_tokens t join public.year_films y on y.id = t.film_id where y.family_id = 'fc100000-0000-4000-8000-000000000007'))::int,
  0, 'every card-related row of the family is gone'
);

-- ---------------------------------------------------------------------------
-- 15. Cron
-- ---------------------------------------------------------------------------

select is(
  (select schedule from cron.job where jobname = 'invoke-sweep-holiday-card-orders'),
  '*/10 * * * *', 'the order sweep runs every 10 minutes'
);

select * from finish();
rollback;
