begin;

-- Holiday card film share (20261005120000_family_holiday_film_share.sql,
-- docs/plans/holiday-cards.md C5): year_films.kind accepts 'family_holiday',
-- the scheduler never creates or lists a holiday film, the holiday music beds
-- are allowed, and film_share_tokens is a select-only, member-readable table
-- whose writes are service-role only.
select plan(33);

-- ---------------------------------------------------------------------------
-- Fixtures (postgres role; assertions switch to authenticated where needed)
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, is_anonymous) values
  ('fb000000-0000-4000-8000-000000000001', 'fst-owner@example.test', false),
  ('fb000000-0000-4000-8000-000000000002', 'fst-viewer@example.test', false),
  ('fb000000-0000-4000-8000-000000000003', 'fst-outsider@example.test', false),
  ('fb000000-0000-4000-8000-000000000004', 'fst-anon@example.test', true);

update public.user_profiles set timezone = 'America/New_York'
where id = 'fb000000-0000-4000-8000-000000000001';

insert into public.families (id, name, owner_id) values
  ('fb100000-0000-4000-8000-000000000001', 'Share family', 'fb000000-0000-4000-8000-000000000001'),
  ('fb100000-0000-4000-8000-000000000002', 'Other family', 'fb000000-0000-4000-8000-000000000003');

insert into public.family_memberships (family_id, user_id, role) values
  ('fb100000-0000-4000-8000-000000000001', 'fb000000-0000-4000-8000-000000000001', 'owner'),
  ('fb100000-0000-4000-8000-000000000001', 'fb000000-0000-4000-8000-000000000002', 'viewer'),
  ('fb100000-0000-4000-8000-000000000001', 'fb000000-0000-4000-8000-000000000004', 'viewer'),
  ('fb100000-0000-4000-8000-000000000002', 'fb000000-0000-4000-8000-000000000003', 'owner');

insert into public.owner_entitlements (
  owner_user_id, app_user_id, environment, store, product_id, entitlement_id,
  period_type, status, expires_at, will_renew
) values (
  'fb000000-0000-4000-8000-000000000001', 'fb000000-0000-4000-8000-000000000001',
  'production', 'app_store', 'momora_annual_v1', 'momora_plus', 'annual', 'active',
  transaction_timestamp() + interval '400 days', true
);

insert into public.family_members (id, family_id, name, date_of_birth, relationship) values
  ('fb200000-0000-4000-8000-000000000001', 'fb100000-0000-4000-8000-000000000001', 'Kid', '2022-10-23', 'child');

-- ---------------------------------------------------------------------------
-- 1. kind = 'family_holiday'
-- ---------------------------------------------------------------------------

select lives_ok(
  $$insert into public.year_films (id, family_id, kind, forced, scope_start_date, scope_end_exclusive, surface_at)
    values ('fb300000-0000-4000-8000-000000000001', 'fb100000-0000-4000-8000-000000000001', 'family_holiday', true,
            '2026-01-01', '2026-10-06', '2026-10-06 12:00:00+00')$$,
  'the kind check accepts a forced family_holiday film'
);
select throws_ok(
  $$insert into public.year_films (family_id, kind, forced, scope_start_date, scope_end_exclusive, surface_at)
    values ('fb100000-0000-4000-8000-000000000001', 'family_decade', true, '2026-01-01', '2026-10-06', now())$$,
  '23514', null, 'the kind check still rejects an unknown kind'
);
select is(
  (select placement_date from public.year_films where id = 'fb300000-0000-4000-8000-000000000001'),
  date '2026-12-31',
  'placement_date: a holiday film sits on Dec 31 of its card year'
);
select lives_ok(
  $$insert into public.year_films (family_id, kind, scope_start_date, scope_end_exclusive, surface_at)
    values ('fb100000-0000-4000-8000-000000000001', 'family_year', '2025-01-01', '2025-12-28', '2025-12-30 12:00:00+00'),
           ('fb100000-0000-4000-8000-000000000001', 'family_month', '2025-03-01', '2025-04-01', '2025-04-01 12:00:00+00')$$,
  'existing kinds still insert'
);

-- ---------------------------------------------------------------------------
-- 2. The scheduler never creates or lists a holiday film
-- ---------------------------------------------------------------------------

update public.year_film_settings
set mode = 'canary',
    canary_family_ids = array['fb100000-0000-4000-8000-000000000001']::uuid[],
    launch_date = date '2026-01-01',
    max_concurrent_renders = 1;

delete from public.year_films where family_id = 'fb100000-0000-4000-8000-000000000001' and not forced;

-- 06:00 UTC on Dec 28 is 01:00 in New York: past the 00:30 due time.
select is(public.year_film_due('2026-12-28 06:00:00+00'), 1,
  'year_film_due still schedules the year-end film (non-vacuous baseline)');
select is(
  (select count(*)::int from public.year_films where family_id = 'fb100000-0000-4000-8000-000000000001'
     and kind = 'family_holiday' and not forced),
  0, 'year_film_due never inserts a family_holiday row'
);
select is(
  (select count(*)::int from public.year_films where family_id = 'fb100000-0000-4000-8000-000000000001'
     and kind = 'family_holiday'),
  1, 'the only holiday row is the forced fixture'
);
select ok(
  (select count(*) from public.year_film_candidate_rows('fb100000-0000-4000-8000-000000000001', '2026-01-01', '2026-12-31')) > 0,
  'year_film_candidate_rows returns the family''s scheduled films (non-vacuous baseline)'
);
select ok(
  not exists (
    select 1 from public.year_film_candidate_rows('fb100000-0000-4000-8000-000000000001', '2026-01-01', '2026-12-31')
    where kind = 'family_holiday'
  ),
  'year_film_candidate_rows never lists a family_holiday film'
);
select is(public.year_film_due('2026-12-28 06:00:00+00'), 0, 'year_film_due is idempotent and still inserts no holiday row');

-- A forced holiday film that is ready is never announced.
update public.year_films
set status = 'ready', video_key = 'o/holiday.mp4', poster_key = 'o/holiday.jpg',
    surface_at = now() - interval '1 hour', ready_at = now()
where id = 'fb300000-0000-4000-8000-000000000001';
select is(
  (select count(*)::int from public.year_film_notifications_due(now()) where kind = 'family_holiday'),
  0, 'a forced holiday film is never announced (no push, no drawer event)'
);

-- ---------------------------------------------------------------------------
-- 3. Music beds
-- ---------------------------------------------------------------------------

select ok(
  public.year_film_bed_ids() @> array['winter-bells', 'fireside-piano', 'celebration-pop', 'tender-piano'],
  'year_film_bed_ids allows the holiday beds and keeps the existing ones'
);
select is(cardinality(public.year_film_bed_ids()), 12, 'twelve beds in all');

-- ---------------------------------------------------------------------------
-- 4. film_share_tokens: structure
-- ---------------------------------------------------------------------------

-- A visible (non-forced, ever-ready, surfaced) film and a forced holiday film.
insert into public.year_films (id, family_id, kind, forced, scope_start_date, scope_end_exclusive, surface_at, status,
                               video_key, poster_key, ready_at)
values
  ('fb300000-0000-4000-8000-000000000002', 'fb100000-0000-4000-8000-000000000001', 'family_month', false,
   '2025-06-01', '2025-07-01', now() - interval '1 hour', 'ready', 'o/m.mp4', 'o/m.jpg', now());

select lives_ok(
  $$insert into public.film_share_tokens (token, film_id) values
      ('AAAAAAAAAAAAAAAAAAAAAA', 'fb300000-0000-4000-8000-000000000001'),
      ('BBBBBBBBBBBBBBBBBBBBBB', 'fb300000-0000-4000-8000-000000000002')$$,
  'service role can mint a token for a forced and a visible film'
);
select throws_ok(
  $$insert into public.film_share_tokens (token, film_id) values ('short', 'fb300000-0000-4000-8000-000000000002')$$,
  '23514', null, 'a token must be exactly 22 base62 characters'
);
select throws_ok(
  $$insert into public.film_share_tokens (token, film_id) values ('CCCCCCCCCCCCCCCCCCCCC-', 'fb300000-0000-4000-8000-000000000002')$$,
  '23514', null, 'a token cannot contain non-base62 characters'
);
select throws_ok(
  $$insert into public.film_share_tokens (token, film_id) values ('DDDDDDDDDDDDDDDDDDDDDD', 'fb300000-0000-4000-8000-000000000001')$$,
  '23505', null, 'at most one active token per film'
);
select throws_ok(
  $$insert into public.film_share_tokens (token, film_id) values ('EEEEEEEEEEEEEEEEEEEEEE', 'fb300000-0000-4000-8000-0000000000ff')$$,
  '23503', null, 'a token must point at a real film'
);
update public.film_share_tokens set revoked_at = now() where token = 'AAAAAAAAAAAAAAAAAAAAAA';
select lives_ok(
  $$insert into public.film_share_tokens (token, film_id) values ('FFFFFFFFFFFFFFFFFFFFFF', 'fb300000-0000-4000-8000-000000000001')$$,
  'revoking a token frees the film for a new active token'
);

-- ---------------------------------------------------------------------------
-- 5. film_share_tokens: grants and RLS
-- ---------------------------------------------------------------------------

select ok(not has_table_privilege('anon', 'public.film_share_tokens', 'SELECT, INSERT, UPDATE, DELETE'),
  'anon has no access to film share tokens');
select ok(has_table_privilege('authenticated', 'public.film_share_tokens', 'SELECT'),
  'authenticated can select film share tokens (RLS-scoped)');
select ok(not has_table_privilege('authenticated', 'public.film_share_tokens', 'INSERT, UPDATE, DELETE, TRUNCATE'),
  'authenticated has no write privilege on film share tokens');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'fb000000-0000-4000-8000-000000000002', true);

select is((select count(*)::int from public.film_share_tokens where token = 'BBBBBBBBBBBBBBBBBBBBBB'), 1,
  'a family member reads the token of a film they can see');
select is((select count(*)::int from public.film_share_tokens where film_id = 'fb300000-0000-4000-8000-000000000001'), 0,
  'a member cannot read the token of a forced (holiday) film: service role only for now');
select throws_ok(
  $$insert into public.film_share_tokens (token, film_id) values ('GGGGGGGGGGGGGGGGGGGGGG', 'fb300000-0000-4000-8000-000000000002')$$,
  '42501', null, 'a member cannot mint a token'
);
select throws_ok(
  $$update public.film_share_tokens set revoked_at = now()$$,
  '42501', null, 'a member cannot revoke a token'
);
select throws_ok(
  $$delete from public.film_share_tokens$$,
  '42501', null, 'a member cannot delete a token'
);

select set_config('request.jwt.claim.sub', 'fb000000-0000-4000-8000-000000000001', true);
select is((select count(*)::int from public.film_share_tokens where token = 'BBBBBBBBBBBBBBBBBBBBBB'), 1,
  'the owner reads the token of a film they can see');
select is((select count(*)::int from public.film_share_tokens where film_id = 'fb300000-0000-4000-8000-000000000001'), 0,
  'the owner cannot read the token of a forced (holiday) film either');

select set_config('request.jwt.claim.sub', 'fb000000-0000-4000-8000-000000000003', true);
select is((select count(*)::int from public.film_share_tokens), 0,
  'a user outside the family reads no tokens');

select set_config('request.jwt.claim.sub', 'fb000000-0000-4000-8000-000000000004', true);
select is((select count(*)::int from public.film_share_tokens), 0,
  'an anonymous session reads no tokens even as a member');

set local role postgres;

-- ---------------------------------------------------------------------------
-- 6. Cascade
-- ---------------------------------------------------------------------------

delete from public.year_films where id = 'fb300000-0000-4000-8000-000000000002';
select is((select count(*)::int from public.film_share_tokens where token = 'BBBBBBBBBBBBBBBBBBBBBB'), 0,
  'deleting a film deletes its tokens');

delete from public.families where id = 'fb100000-0000-4000-8000-000000000001';
select is((select count(*)::int from public.film_share_tokens), 0,
  'deleting a family removes its films'' tokens');

select * from finish();
rollback;
