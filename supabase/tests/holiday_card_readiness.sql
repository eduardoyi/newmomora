begin;

-- Holiday Cards readiness (20261008120000_holiday_card_readiness.sql): the
-- ready_notified_at column, holiday_card_readiness (every branch incl. the
-- 75-minute safety valve) and holiday_card_summary's new `readiness` column.
-- FICTIONAL data only (public repo).
select plan(33);

-- ---------------------------------------------------------------------------
-- Fixtures (postgres role)
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, is_anonymous) values
  ('fe000000-0000-4000-8000-000000000001', 'ready-owner@example.test', false),
  ('fe000000-0000-4000-8000-000000000002', 'ready-viewer@example.test', false);

insert into public.families (id, name, owner_id, gallery_caption_language) values
  ('fe100000-0000-4000-8000-000000000001', 'Readiness family', 'fe000000-0000-4000-8000-000000000001', 'en-US'),
  ('fe100000-0000-4000-8000-000000000002', 'Readiness empty family', 'fe000000-0000-4000-8000-000000000001', 'es-MX');

insert into public.family_memberships (family_id, user_id, role) values
  ('fe100000-0000-4000-8000-000000000001', 'fe000000-0000-4000-8000-000000000001', 'owner'),
  ('fe100000-0000-4000-8000-000000000001', 'fe000000-0000-4000-8000-000000000002', 'viewer'),
  ('fe100000-0000-4000-8000-000000000002', 'fe000000-0000-4000-8000-000000000001', 'owner');

-- One card per year (the unique key is family + year). Years 2031.. are the
-- readiness cases; the film (when any) is a card film of the same family.
create temp table cases (n int primary key, label text, card_status text, film_status text, blocked boolean, published boolean, card_age interval);
insert into cases values
  (1,  'generating',                      'generating', null,        false, false, interval '5 minutes'),
  (2,  'failed',                          'failed',     null,        false, false, interval '5 minutes'),
  (3,  'ready, no film',                  'ready',      null,        false, false, interval '5 minutes'),
  (4,  'film queued',                     'ready',      'queued',    false, false, interval '5 minutes'),
  (5,  'film curating',                   'ready',      'curating',  false, false, interval '5 minutes'),
  (6,  'film preparing',                  'ready',      'preparing', false, false, interval '5 minutes'),
  (7,  'film rendering, never published', 'ready',      'rendering', false, false, interval '5 minutes'),
  (8,  'film published',                  'ready',      'ready',     false, true,  interval '5 minutes'),
  (9,  'film re-rendering, old video',    'ready',      'rendering', false, true,  interval '5 minutes'),
  (10, 'film failed after publishing',    'ready',      'failed',    false, true,  interval '5 minutes'),
  (11, 'film failed, never published',    'ready',      'failed',    false, false, interval '5 minutes'),
  (12, 'film skipped',                    'ready',      'skipped',   false, false, interval '5 minutes'),
  (13, 'film ended',                      'ready',      'ended',     false, false, interval '5 minutes'),
  (14, 'film ended with a video',         'ready',      'ended',     false, true,  interval '5 minutes'),
  (15, 'film blocked, rendering',         'ready',      'rendering', true,  false, interval '5 minutes'),
  (16, 'film blocked, published',         'ready',      'ready',     true,  true,  interval '5 minutes'),
  (17, 'rendering, card 74 min old',      'ready',      'rendering', false, false, interval '74 minutes'),
  (18, 'rendering, card 76 min old',      'ready',      'rendering', false, false, interval '76 minutes'),
  (19, 'queued, card 3 hours old',        'ready',      'queued',    false, false, interval '3 hours');

insert into public.year_films (id, family_id, kind, forced, scope_start_date, scope_end_exclusive, surface_at, status,
                               blocked, video_key, poster_key, ready_at)
select ('fe500000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       'fe100000-0000-4000-8000-000000000001', 'family_holiday', true,
       '2026-01-01', '2026-12-01', now(), film_status, blocked,
       case when published then 'o/f' || n || '.mp4' end,
       case when published then 'o/f' || n || '.jpg' end,
       case when published then now() end
from cases where film_status is not null;

insert into public.holiday_cards (id, family_id, created_by, year, greeting, status, film_id, created_at)
select ('fe200000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       'fe100000-0000-4000-8000-000000000001', 'fe000000-0000-4000-8000-000000000001',
       2030 + n, 'holidays', card_status,
       case when film_status is not null then ('fe500000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid end,
       now() - card_age
from cases;

create function pg_temp.readiness(p_n int) returns text language sql as $$
  select public.holiday_card_readiness(('fe200000-0000-4000-8000-0000000000' || lpad(p_n::text, 2, '0'))::uuid)
$$;

-- ---------------------------------------------------------------------------
-- 1. holiday_card_readiness: every branch
-- ---------------------------------------------------------------------------

select is(pg_temp.readiness(1),  'generating', 'a generating card is generating');
select is(pg_temp.readiness(2),  'failed',     'a failed card is failed');
select is(pg_temp.readiness(3),  'ready',      'a ready card without a film is ready (below the film floors)');
select is(pg_temp.readiness(4),  'film',       'a queued film holds the card at film');
select is(pg_temp.readiness(5),  'film',       'a curating film holds the card at film');
select is(pg_temp.readiness(6),  'film',       'a preparing film holds the card at film');
select is(pg_temp.readiness(7),  'film',       'a rendering, never-published film holds the card at film');
select is(pg_temp.readiness(8),  'ready',      'a published film (video + ready_at) makes the card ready');
select is(pg_temp.readiness(9),  'ready',      'a re-rendering film that keeps its published video is ready');
select is(pg_temp.readiness(10), 'ready',      'a film that failed after publishing is ready');
select is(pg_temp.readiness(11), 'ready',      'a film that failed without a video is ready (prints without QR)');
select is(pg_temp.readiness(12), 'ready',      'a skipped film is ready (prints without QR)');
select is(pg_temp.readiness(13), 'ready',      'an ended film is ready (prints without QR)');
select is(pg_temp.readiness(14), 'ready',      'an ended film is ready even when a video key remains');
select is(pg_temp.readiness(15), 'ready',      'a blocked film is ready (prints without QR)');
select is(pg_temp.readiness(16), 'ready',      'a blocked, published film is ready');
select is(pg_temp.readiness(17), 'film',       'the safety valve has not opened at 74 minutes');
select is(pg_temp.readiness(18), 'ready',      'the safety valve opens after 75 minutes');
select is(pg_temp.readiness(19), 'ready',      'a long-stuck queued film never holds the card hostage');
select is(public.holiday_card_readiness('fe200000-0000-4000-8000-0000000000ff'), null, 'an unknown card has no readiness');

-- ---------------------------------------------------------------------------
-- 2. Grants + the client-hidden column
-- ---------------------------------------------------------------------------

select ok(has_function_privilege('service_role', 'public.holiday_card_readiness(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.holiday_card_readiness(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.holiday_card_readiness(uuid)', 'EXECUTE'),
  'holiday_card_readiness is service role only');
select ok(has_function_privilege('authenticated', 'public.holiday_card_summary(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.holiday_card_summary(uuid)', 'EXECUTE'),
  'holiday_card_summary is still granted to authenticated only (not anon)');
select ok(not has_column_privilege('authenticated', 'public.holiday_cards', 'ready_notified_at', 'SELECT')
  and has_column_privilege('authenticated', 'public.holiday_cards', 'status', 'SELECT'),
  'ready_notified_at is not client-readable (the P1 column grant is unchanged)');
select ok(not has_column_privilege('authenticated', 'public.holiday_cards', 'ready_notified_at', 'UPDATE'),
  'ready_notified_at is not client-writable');
select is((select count(*)::int from public.holiday_cards where ready_notified_at is not null), 0,
  'new cards start with ready_notified_at null');

-- ---------------------------------------------------------------------------
-- 3. holiday_card_summary keeps its columns and adds readiness
-- ---------------------------------------------------------------------------

-- Family 2 has no card: readiness is null with the other card fields.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'fe000000-0000-4000-8000-000000000001', true);
select is(
  (select row(card_id, year, status, last_failure_code, ordered, language, readiness)::text
   from public.holiday_card_summary('fe100000-0000-4000-8000-000000000002')),
  '(,,,,f,es,)',
  'no card: the old fields are unchanged and readiness is null');
set local role postgres;

-- Pin the newest card (by created_at) of family 1 to case 7: ready, film rendering.
update public.holiday_cards set created_at = now() - interval '10 days'
where family_id = 'fe100000-0000-4000-8000-000000000001';
update public.holiday_cards set created_at = now() - interval '1 minute'
where id = 'fe200000-0000-4000-8000-000000000007';  -- ready, film rendering, never published

set local role authenticated;
select set_config('request.jwt.claim.sub', 'fe000000-0000-4000-8000-000000000001', true);
select is(
  (select row(card_id, year, status, last_failure_code, ordered, language, readiness)::text
   from public.holiday_card_summary('fe100000-0000-4000-8000-000000000001')),
  '(fe200000-0000-4000-8000-000000000007,2037,ready,,f,en,film)',
  'the summary returns the newest card with its old fields plus readiness film');

set local role postgres;
update public.year_films set status = 'ready', video_key = 'o/f7.mp4', poster_key = 'o/f7.jpg', ready_at = now()
where id = 'fe500000-0000-4000-8000-000000000007';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'fe000000-0000-4000-8000-000000000001', true);
select is((select readiness from public.holiday_card_summary('fe100000-0000-4000-8000-000000000001')), 'ready',
  'the summary flips to ready once the film is published');
set local role postgres;

update public.holiday_cards set status = 'generating' where id = 'fe200000-0000-4000-8000-000000000007';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'fe000000-0000-4000-8000-000000000001', true);
select is((select readiness from public.holiday_card_summary('fe100000-0000-4000-8000-000000000001')), 'generating',
  'the summary reports generating for a generating card');
set local role postgres;
update public.holiday_cards set status = 'failed' where id = 'fe200000-0000-4000-8000-000000000007';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'fe000000-0000-4000-8000-000000000001', true);
select is((select readiness from public.holiday_card_summary('fe100000-0000-4000-8000-000000000001')), 'failed',
  'the summary reports failed for a failed card');

-- Zero-row rules are unchanged.
select set_config('request.jwt.claim.sub', 'fe000000-0000-4000-8000-000000000002', true);
select is((select count(*)::int from public.holiday_card_summary('fe100000-0000-4000-8000-000000000001')), 0,
  'a viewer still gets no row');
set local role anon;
select throws_ok($$select * from public.holiday_card_summary('fe100000-0000-4000-8000-000000000001')$$, '42501', null,
  'the anon role still cannot execute the summary');
set local role authenticated;
select throws_ok($$select public.holiday_card_readiness('fe200000-0000-4000-8000-000000000007')$$, '42501', null,
  'a client cannot call holiday_card_readiness directly');
set local role postgres;

select * from finish();
rollback;
