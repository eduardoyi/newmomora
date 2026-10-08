begin;

-- Keepsakes tab overview (20261009120000_keepsakes_overview.sql +
-- 20261010120000_keepsakes_overview_card_front.sql,
-- docs/plans/keepsakes-redesign.md A1): public.keepsakes_overview and the
-- internal pool helper public.keepsake_pool. FICTIONAL data only (public
-- repo). DATE-INDEPENDENT: every memory is placed relative to the owner-local
-- current month / year (the owner's timezone is far from UTC on purpose), and
-- the holiday fixtures live in a family of their own so they never overlap
-- the month fixtures.
select plan(176);

-- ---------------------------------------------------------------------------
-- Fixtures (postgres role; assertions switch to authenticated where needed)
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, is_anonymous) values
  ('ce000000-0000-4000-8000-000000000001', 'ko-owner@example.test', false),
  ('ce000000-0000-4000-8000-000000000002', 'ko-manager@example.test', false),
  ('ce000000-0000-4000-8000-000000000003', 'ko-viewer@example.test', false),
  ('ce000000-0000-4000-8000-000000000004', 'ko-outsider@example.test', false),
  ('ce000000-0000-4000-8000-000000000005', 'ko-anon@example.test', true),
  ('ce000000-0000-4000-8000-000000000006', 'ko-blocked-author@example.test', false),
  ('ce000000-0000-4000-8000-000000000007', 'ko-hidden-author@example.test', false),
  ('ce000000-0000-4000-8000-000000000008', 'ko-holiday-owner@example.test', false);

-- Far from UTC, so a UTC-based "month" would be wrong for part of every day.
update public.user_profiles set timezone = 'Pacific/Kiritimati'
where id in ('ce000000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000008');

insert into public.families (id, name, owner_id) values
  ('ce100000-0000-4000-8000-000000000001', 'Overview family', 'ce000000-0000-4000-8000-000000000001'),
  ('ce100000-0000-4000-8000-000000000002', 'Other family', 'ce000000-0000-4000-8000-000000000004'),
  ('ce100000-0000-4000-8000-000000000003', 'Holiday pool family', 'ce000000-0000-4000-8000-000000000008');

insert into public.family_memberships (family_id, user_id, role) values
  ('ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001', 'owner'),
  ('ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000002', 'manager'),
  ('ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000003', 'viewer'),
  ('ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000005', 'viewer'),
  ('ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000006', 'viewer'),
  ('ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000007', 'viewer'),
  ('ce100000-0000-4000-8000-000000000002', 'ce000000-0000-4000-8000-000000000004', 'owner'),
  ('ce100000-0000-4000-8000-000000000003', 'ce000000-0000-4000-8000-000000000008', 'owner');

-- Billing for the overview family's owner (the recap gate).
insert into public.owner_entitlements (
  owner_user_id, app_user_id, environment, store, product_id, entitlement_id,
  period_type, status, expires_at, will_renew
) values (
  'ce000000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001',
  'production', 'app_store', 'momora_annual_v1', 'momora_plus', 'annual', 'active',
  transaction_timestamp() + interval '400 days', true
);

-- Enzo: own child with a DOB. Mia: own child, text-only tags (no picture).
-- Nico: a cousin (not an own child) with a picture tagged.
insert into public.family_members (id, family_id, name, date_of_birth, relationship) values
  ('ce200000-0000-4000-8000-000000000001', 'ce100000-0000-4000-8000-000000000001', 'Enzo', '2022-10-23', 'child'),
  ('ce200000-0000-4000-8000-000000000002', 'ce100000-0000-4000-8000-000000000001', 'Mia', '2024-02-02', 'child'),
  ('ce200000-0000-4000-8000-000000000003', 'ce100000-0000-4000-8000-000000000001', 'Nico', '2021-05-05', 'cousin');

update public.year_film_settings
set mode = 'canary',
    canary_family_ids = array['ce100000-0000-4000-8000-000000000001']::uuid[],
    launch_date = date '2020-01-01';

-- Owner-local clock, exactly as the function computes it.
create temp table cur on commit drop as
select (now() at time zone 'Pacific/Kiritimati')::date as today,
       date_trunc('month', now() at time zone 'Pacific/Kiritimati')::date as ms,
       (date_trunc('month', now() at time zone 'Pacific/Kiritimati') + interval '1 month')::date as nf,
       date_trunc('year', now() at time zone 'Pacific/Kiritimati')::date as ys,
       (date_trunc('year', now() at time zone 'Pacific/Kiritimati') + interval '1 year')::date as nys;

-- Snapshots of the RPC as different callers (taken as `authenticated`, read
-- back as postgres).
create temp table ov (label text primary key, doc jsonb);
grant all on ov to authenticated;

-- ---------------------------------------------------------------------------
-- 1. Privileges and auth
-- ---------------------------------------------------------------------------

select ok(
  not has_function_privilege('authenticated', 'public.keepsake_pool(uuid, date, date, uuid, uuid, boolean, integer, boolean)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.keepsake_pool(uuid, date, date, uuid, uuid, boolean, integer, boolean)', 'EXECUTE'),
  'keepsake_pool is internal: neither authenticated nor anon can execute it'
);
select ok(
  has_function_privilege('authenticated', 'public.keepsakes_overview(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.keepsakes_overview(uuid)', 'EXECUTE'),
  'keepsakes_overview is granted to authenticated, not anon'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000001', true);
select throws_ok(
  $$select * from public.keepsake_pool('ce100000-0000-4000-8000-000000000001', date '2020-01-01', date '2030-01-01')$$,
  '42501', null, 'a signed-in client cannot call keepsake_pool directly');

select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000005', true);
select throws_ok($$select public.keepsakes_overview('ce100000-0000-4000-8000-000000000001')$$, '42501', 'Not authorized',
  'an anonymous session is rejected even as a member');

select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000004', true);
select throws_ok($$select public.keepsakes_overview('ce100000-0000-4000-8000-000000000001')$$, '42501', 'Not authorized',
  'a non-member is rejected');

select set_config('request.jwt.claim.sub', '', true);
select throws_ok($$select public.keepsakes_overview('ce100000-0000-4000-8000-000000000001')$$, '42501', 'Not authorized',
  'no session is rejected');
set local role postgres;

-- ---------------------------------------------------------------------------
-- 2. Pool and picture rules (recap), one stage at a time. Each stage uses a
--    later day than the one before, so "newest" is predictable.
-- ---------------------------------------------------------------------------

-- Stage A: a text-only memory and an audio memory. Moments only.
insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, memory_date)
values ('ce300000-0000-4000-8000-000000000001', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001',
        'A quiet morning', 'text_only', 'none', (select ms from cur) + 1);
insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, media_key, media_content_type, memory_date)
values ('ce300000-0000-4000-8000-000000000002', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001',
        null, 'audio', 'none', 'ce-key/clip-a.m4a', 'audio/mp4', (select ms from cur) + 2);
insert into public.memory_media (memory_id, object_key, content_type, duration_ms, position)
values ('ce300000-0000-4000-8000-000000000002', 'ce-key/clip-a.m4a', 'audio/mp4', 9000, 0);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000001', true);
insert into ov select 'a', public.keepsakes_overview('ce100000-0000-4000-8000-000000000001');
set local role postgres;

select is((select (doc->'recap'->>'moments')::int from ov where label = 'a'), 2,
  'text-only and audio memories both count as moments');
select is((select (doc->'recap'->>'visuals')::int from ov where label = 'a'), 0,
  'audio is a moment only: not a visual');
select is((select doc->'recap'->>'picture_key' from ov where label = 'a'), null,
  'only text/audio memories: the picture is null');

-- The envelope of the recap.
select is((select doc->'recap'->>'month_start' from ov where label = 'a'), (select ms::text from cur),
  'month_start is the owner-local first of the month (not the UTC month)');
select is((select doc->'recap'->>'delivers_on' from ov where label = 'a'), (select nf::text from cur),
  'delivers_on is the owner-local next first');
select is((select row((doc->'recap'->>'min_moments')::int, (doc->'recap'->>'min_visuals')::int)::text from ov where label = 'a'),
  '(10,6)', 'the monthly floors ride along');

-- Stage B: a ready illustration (d3), then a LATER text-only memory (d4).
insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, illustration_key, memory_date)
values ('ce300000-0000-4000-8000-000000000003', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001',
        'Enzo and the kite', 'text_illustration', 'ready', 'ce-key/ill-b.png', (select ms from cur) + 3);
insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, memory_date)
values ('ce300000-0000-4000-8000-000000000004', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001',
        'Later, only words', 'text_only', 'none', (select ms from cur) + 4);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000001', true);
insert into ov select 'b', public.keepsakes_overview('ce100000-0000-4000-8000-000000000001');
set local role postgres;

select is((select row((doc->'recap'->>'moments')::int, (doc->'recap'->>'visuals')::int)::text from ov where label = 'b'),
  '(4,1)', 'a ready illustration is a visual');
select is((select doc->'recap'->>'picture_key' from ov where label = 'b'), 'ce-key/ill-b.png',
  'the newest picture is the illustration: a later text-only memory does not win');

-- Stage C: an AUDIO memory carrying a ready illustration (d5). The invariants
-- check forbids it today, so lift it inside this (rolled back) transaction:
-- old rows and edit races can still hold one.
alter table public.memories drop constraint memories_type_invariants;
insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, illustration_key, media_key, media_content_type, memory_date)
values ('ce300000-0000-4000-8000-000000000005', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001',
        null, 'audio', 'ready', 'ce-key/ill-audio.png', 'ce-key/clip-c.m4a', 'audio/mp4', (select ms from cur) + 5);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000001', true);
insert into ov select 'c', public.keepsakes_overview('ce100000-0000-4000-8000-000000000001');
set local role postgres;

select is((select row((doc->'recap'->>'moments')::int, (doc->'recap'->>'visuals')::int)::text from ov where label = 'c'),
  '(5,1)', 'an audio memory with an illustration counts as a moment but is not a visual');
select is((select doc->'recap'->>'picture_key' from ov where label = 'c'), 'ce-key/ill-b.png',
  'an audio memory''s illustration is never the picture');

-- Stage D: an illustration under an open memory_illustration report (d6).
insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, illustration_key, memory_date)
values ('ce300000-0000-4000-8000-000000000006', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001',
        'Reported picture', 'text_illustration', 'ready', 'ce-key/ill-d.png', (select ms from cur) + 6);
insert into public.content_reports (family_id, reporter_user_id, target_type, target_id, target_version_id, reason)
values ('ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000003', 'memory_illustration',
        'ce300000-0000-4000-8000-000000000006', gen_random_uuid(), 'other');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000001', true);
insert into ov select 'd', public.keepsakes_overview('ce100000-0000-4000-8000-000000000001');
set local role postgres;

select is((select row((doc->'recap'->>'moments')::int, (doc->'recap'->>'visuals')::int)::text from ov where label = 'd'),
  '(6,1)', 'a reported illustration still counts as a moment, but not as a visual');
select is((select doc->'recap'->>'picture_key' from ov where label = 'd'), 'ce-key/ill-b.png',
  'a reported illustration is never the picture');

-- Stage E: a reported memory (open), a reviewing one (d7), and a resolved
-- report (d8: no longer excludes).
insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, illustration_key, memory_date) values
  ('ce300000-0000-4000-8000-000000000007', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001',
   'Open report', 'text_illustration', 'ready', 'ce-key/ill-e1.png', (select ms from cur) + 7),
  ('ce300000-0000-4000-8000-000000000008', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001',
   'Reviewing report', 'text_illustration', 'ready', 'ce-key/ill-e2.png', (select ms from cur) + 7);
insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, memory_date)
values ('ce300000-0000-4000-8000-000000000009', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001',
        'Resolved report', 'text_only', 'none', (select ms from cur) + 8);
insert into public.content_reports (family_id, reporter_user_id, target_type, target_id, reason, status) values
  ('ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000003', 'memory',
   'ce300000-0000-4000-8000-000000000007', 'other', 'open'),
  ('ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000003', 'memory',
   'ce300000-0000-4000-8000-000000000008', 'other', 'reviewing');
insert into public.content_reports (family_id, reporter_user_id, target_type, target_id, reason, status, resolution, resolved_at)
values ('ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000003', 'memory',
        'ce300000-0000-4000-8000-000000000009', 'other', 'resolved', 'dismissed', now());

set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000001', true);
insert into ov select 'e', public.keepsakes_overview('ce100000-0000-4000-8000-000000000001');
set local role postgres;

select is((select row((doc->'recap'->>'moments')::int, (doc->'recap'->>'visuals')::int)::text from ov where label = 'e'),
  '(7,1)', 'open and reviewing memory reports leave the pool; a resolved report does not');
select is((select doc->'recap'->>'picture_key' from ov where label = 'e'), 'ce-key/ill-b.png',
  'a reported memory''s illustration is never the picture');

-- Stage F: an onboarding-pending memory (d9). The boolean alone excludes it.
insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, onboarding_media_pending, onboarding_media_pending_until, memory_date)
values ('ce300000-0000-4000-8000-00000000000a', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001',
        null, 'media', 'none', true, now() + interval '1 day', (select ms from cur) + 9);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000001', true);
insert into ov select 'f', public.keepsakes_overview('ce100000-0000-4000-8000-000000000001');
set local role postgres;

select is((select (doc->'recap'->>'moments')::int from ov where label = 'f'), 7,
  'an onboarding-pending memory is not in the pool');

-- An EXPIRED pending window is still pending (no `_until` rule, like the worker).
update public.memories set onboarding_media_pending_until = now() - interval '1 day'
where id = 'ce300000-0000-4000-8000-00000000000a';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000001', true);
insert into ov select 'f2', public.keepsakes_overview('ce100000-0000-4000-8000-000000000001');
set local role postgres;
select is((select (doc->'recap'->>'moments')::int from ov where label = 'f2'), 7,
  'the pending boolean alone excludes: an expired _until does not bring the memory back');

-- Stage G: a memory by an account the owner blocked (d10).
insert into public.blocked_family_accounts (family_id, blocker_user_id, blocked_user_id)
values ('ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000006');
insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, illustration_key, memory_date)
values ('ce300000-0000-4000-8000-00000000000b', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000006',
        'By a blocked account', 'text_illustration', 'ready', 'ce-key/ill-g.png', (select ms from cur) + 10);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000001', true);
insert into ov select 'g', public.keepsakes_overview('ce100000-0000-4000-8000-000000000001');
set local role postgres;

select is((select row((doc->'recap'->>'moments')::int, (doc->'recap'->>'visuals')::int)::text from ov where label = 'g'),
  '(7,1)', 'a memory by a parent-blocked author leaves the pool');
select is((select doc->'recap'->>'picture_key' from ov where label = 'g'), 'ce-key/ill-b.png',
  'a parent-blocked author''s illustration is never the picture');

-- Stage H: a memory by a viewer-hidden author (d11). A VIEWER''s block is
-- personal: counts stay family-wide, only that viewer''s picture changes.
insert into public.blocked_family_accounts (family_id, blocker_user_id, blocked_user_id)
values ('ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000003', 'ce000000-0000-4000-8000-000000000007');
insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, illustration_key, memory_date)
values ('ce300000-0000-4000-8000-00000000000c', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000007',
        'By an account the viewer hid', 'text_illustration', 'ready', 'ce-key/ill-h.png', (select ms from cur) + 11);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000001', true);
insert into ov select 'h-owner', public.keepsakes_overview('ce100000-0000-4000-8000-000000000001');
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000003', true);
insert into ov select 'h-viewer', public.keepsakes_overview('ce100000-0000-4000-8000-000000000001');
set local role postgres;

select is((select row((doc->'recap'->>'moments')::int, (doc->'recap'->>'visuals')::int)::text from ov where label = 'h-owner'),
  '(8,2)', 'a viewer''s block does not change the family-wide counts (owner)');
select is((select row((doc->'recap'->>'moments')::int, (doc->'recap'->>'visuals')::int)::text from ov where label = 'h-viewer'),
  '(8,2)', 'a viewer''s block does not change the family-wide counts (the viewer)');
select is((select doc->'recap'->>'picture_key' from ov where label = 'h-owner'), 'ce-key/ill-h.png',
  'the owner (who did not hide that author) gets the newest picture');
select is((select doc->'recap'->>'picture_key' from ov where label = 'h-viewer'), 'ce-key/ill-b.png',
  'the viewer''s own block removes that author from the picture');

-- Stage I: a LEGACY image (media_key, no memory_media rows) (d12).
insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, media_key, media_content_type, memory_date)
values ('ce300000-0000-4000-8000-00000000000d', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001',
        null, 'media', 'none', 'ce-key/legacy-i.jpg', 'image/jpeg', (select ms from cur) + 12);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000001', true);
insert into ov select 'i', public.keepsakes_overview('ce100000-0000-4000-8000-000000000001');
set local role postgres;

select is((select row((doc->'recap'->>'moments')::int, (doc->'recap'->>'visuals')::int)::text from ov where label = 'i'),
  '(9,3)', 'a legacy media_key image is a visual');
select is((select doc->'recap'->>'picture_key' from ov where label = 'i'), 'ce-key/legacy-i.jpg',
  'the legacy image''s media_key is the picture');

-- Stage J: a video with a NULL duration and no poster, via memory_media (d13).
insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, media_key, media_content_type, memory_date)
values ('ce300000-0000-4000-8000-00000000000e', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001',
        null, 'media', 'none', 'ce-key/vid-j.mp4', 'video/mp4', (select ms from cur) + 13);
insert into public.memory_media (memory_id, object_key, content_type, duration_ms, position)
values ('ce300000-0000-4000-8000-00000000000e', 'ce-key/vid-j.mp4', 'video/mp4', null, 0);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000001', true);
insert into ov select 'j', public.keepsakes_overview('ce100000-0000-4000-8000-000000000001');
set local role postgres;

select is((select row((doc->'recap'->>'moments')::int, (doc->'recap'->>'visuals')::int)::text from ov where label = 'j'),
  '(10,4)', 'a NULL-duration video counts as a visual');
select is((select doc->'recap'->>'picture_key' from ov where label = 'j'), 'ce-key/legacy-i.jpg',
  'a video with no poster is skipped for the picture: it never hides an older picture');

-- Stage K: a legacy video (media_key, no rows, no poster possible) (d14).
insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, media_key, media_content_type, memory_date)
values ('ce300000-0000-4000-8000-00000000000f', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001',
        null, 'media', 'none', 'ce-key/legacy-k.mp4', 'video/mp4', (select ms from cur) + 14);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000001', true);
insert into ov select 'k', public.keepsakes_overview('ce100000-0000-4000-8000-000000000001');
set local role postgres;

select is((select row((doc->'recap'->>'moments')::int, (doc->'recap'->>'visuals')::int)::text from ov where label = 'k'),
  '(11,5)', 'a legacy video is a visual');
select is((select doc->'recap'->>'picture_key' from ov where label = 'k'), 'ce-key/legacy-i.jpg',
  'a legacy video without a poster is skipped for the picture');

-- Stage L: a 1.5 s video with a poster (d15: too short to be a visual), then a
-- 2 s video with a poster (d16: visual, picture = its poster).
insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, media_key, media_content_type, memory_date) values
  ('ce300000-0000-4000-8000-000000000010', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001',
   null, 'media', 'none', 'ce-key/vid-l1.mp4', 'video/mp4', (select ms from cur) + 15),
  ('ce300000-0000-4000-8000-000000000011', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001',
   null, 'media', 'none', 'ce-key/vid-l2.mp4', 'video/mp4', (select ms from cur) + 16);
insert into public.memory_media (memory_id, object_key, preview_object_key, content_type, duration_ms, position) values
  ('ce300000-0000-4000-8000-000000000010', 'ce-key/vid-l1.mp4', 'ce-key/poster-l1.jpg', 'video/mp4', 1500, 0),
  ('ce300000-0000-4000-8000-000000000011', 'ce-key/vid-l2.mp4', 'ce-key/poster-l2.jpg', 'video/mp4', 2000, 0);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000001', true);
insert into ov select 'l', public.keepsakes_overview('ce100000-0000-4000-8000-000000000001');
set local role postgres;

select is((select row((doc->'recap'->>'moments')::int, (doc->'recap'->>'visuals')::int)::text from ov where label = 'l'),
  '(13,6)', 'a 1.5 s video is a moment only; a 2 s video is a visual');
select is((select doc->'recap'->>'picture_key' from ov where label = 'l'), 'ce-key/poster-l2.jpg',
  'a video''s picture is its poster');

-- Stage M: an image with a preview (d17): preview wins; plus the
-- viewer-visible shape.
insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, media_key, media_content_type, memory_date)
values ('ce300000-0000-4000-8000-000000000012', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001',
        null, 'media', 'none', 'ce-key/img-m.jpg', 'image/jpeg', (select ms from cur) + 17);
insert into public.memory_media (memory_id, object_key, preview_object_key, content_type, position)
values ('ce300000-0000-4000-8000-000000000012', 'ce-key/img-m.jpg', 'ce-key/img-m-preview.jpg', 'image/jpeg', 0);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000001', true);
insert into ov select 'm-owner', public.keepsakes_overview('ce100000-0000-4000-8000-000000000001');
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000003', true);
insert into ov select 'm-viewer', public.keepsakes_overview('ce100000-0000-4000-8000-000000000001');
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000002', true);
insert into ov select 'm-manager', public.keepsakes_overview('ce100000-0000-4000-8000-000000000001');
set local role postgres;

select is((select row((doc->'recap'->>'moments')::int, (doc->'recap'->>'visuals')::int)::text from ov where label = 'm-owner'),
  '(14,7)', 'final month tally');
select is((select doc->'recap'->>'picture_key' from ov where label = 'm-owner'), 'ce-key/img-m-preview.jpg',
  'an image''s picture is its preview key, not the original');

-- ---------------------------------------------------------------------------
-- 3. Viewer view: recap yes, everything else null / empty
-- ---------------------------------------------------------------------------

select is((select doc->'recap' from ov where label = 'm-viewer'), (select doc->'recap' from ov where label = 'm-owner'),
  'a viewer gets the same recap as the owner');
select ok(
  (select doc ?& array['recap', 'has_viewers', 'year_moments', 'holiday_pool', 'holiday_min_pool',
                       'holiday_ship_by_note', 'preview_key', 'book_preview_keys', 'orders'] from ov where label = 'm-viewer'),
  'every contract key is present in the viewer payload');
select is(
  (select row(
     jsonb_typeof(doc->'has_viewers'), jsonb_typeof(doc->'year_moments'), jsonb_typeof(doc->'holiday_pool'),
     jsonb_typeof(doc->'holiday_min_pool'), jsonb_typeof(doc->'holiday_ship_by_note'), jsonb_typeof(doc->'preview_key'),
     jsonb_typeof(doc->'book_preview_keys'))::text
   from ov where label = 'm-viewer'),
  '(null,null,null,null,null,null,null)',
  'a viewer gets null has_viewers, year_moments, holiday_pool, holiday_min_pool, ship_by_note, preview_key and book_preview_keys');
select is((select doc->'orders' from ov where label = 'm-viewer'), '[]'::jsonb, 'a viewer gets no orders');

select is((select doc->>'has_viewers' from ov where label = 'm-manager'), 'true',
  'a manager sees has_viewers (the family has viewers)');
select is((select doc->>'holiday_min_pool' from ov where label = 'm-owner'), '20',
  'owners and managers get the holiday floor (HOLIDAY_MIN_POOL)');

-- ---------------------------------------------------------------------------
-- 4. Previews: family-wide and per own child
-- ---------------------------------------------------------------------------

-- Enzo is tagged on the older illustration (d3) and on three NEWER memories
-- that must not be used: a reported illustration (d6), a reported memory (d7)
-- and a parent-blocked author's memory (d10). Mia: only audio / text-only
-- tags, plus an illustration older than the one-year lookback. Nico (a
-- cousin) has a picture tagged but is not an own child.
insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, illustration_key, memory_date)
values ('ce300000-0000-4000-8000-000000000013', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001',
        'A long time ago', 'text_illustration', 'ready', 'ce-key/ill-old.png', (select today from cur) - 400);
insert into public.memory_family_members (memory_id, family_member_id) values
  ('ce300000-0000-4000-8000-000000000003', 'ce200000-0000-4000-8000-000000000001'),
  ('ce300000-0000-4000-8000-000000000006', 'ce200000-0000-4000-8000-000000000001'),
  ('ce300000-0000-4000-8000-000000000007', 'ce200000-0000-4000-8000-000000000001'),
  ('ce300000-0000-4000-8000-00000000000b', 'ce200000-0000-4000-8000-000000000001'),
  ('ce300000-0000-4000-8000-000000000001', 'ce200000-0000-4000-8000-000000000002'),
  ('ce300000-0000-4000-8000-000000000002', 'ce200000-0000-4000-8000-000000000002'),
  ('ce300000-0000-4000-8000-000000000005', 'ce200000-0000-4000-8000-000000000002'),
  ('ce300000-0000-4000-8000-000000000013', 'ce200000-0000-4000-8000-000000000002'),
  ('ce300000-0000-4000-8000-00000000000d', 'ce200000-0000-4000-8000-000000000003');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000001', true);
insert into ov select 'previews', public.keepsakes_overview('ce100000-0000-4000-8000-000000000001');
set local role postgres;

select is((select doc->>'preview_key' from ov where label = 'previews'), 'ce-key/img-m-preview.jpg',
  'preview_key is the newest family picture');
select is((select doc->'book_preview_keys' from ov where label = 'previews'),
  '{"ce200000-0000-4000-8000-000000000001": "ce-key/ill-b.png"}'::jsonb,
  'book_preview_keys: Enzo gets his newest USABLE picture (reported, blocked and audio ones skipped); Mia has none (omitted, and the 400-day-old one is outside the lookback); the cousin is not an own child');

-- ---------------------------------------------------------------------------
-- 5. Orders
-- ---------------------------------------------------------------------------

insert into public.memory_books (id, family_id, child_id, requested_by, scope_kind, scope_start_date, scope_end_date, scope_label, status, failure_reason, page_budget) values
  ('ce400000-0000-4000-8000-00000000000a', 'ce100000-0000-4000-8000-000000000001', 'ce200000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001', 'calendar_year', '2025-01-01', '2025-12-31', '2025', 'queued', null, 30),
  ('ce400000-0000-4000-8000-00000000000b', 'ce100000-0000-4000-8000-000000000001', 'ce200000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001', 'calendar_year', '2024-01-01', '2024-12-31', '2024', 'queued', null, 30),
  ('ce400000-0000-4000-8000-00000000000c', 'ce100000-0000-4000-8000-000000000001', 'ce200000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001', 'calendar_year', '2023-01-01', '2023-12-31', '2023', 'queued', null, 30),
  ('ce400000-0000-4000-8000-00000000000d', 'ce100000-0000-4000-8000-000000000001', 'ce200000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001', 'calendar_year', '2022-01-01', '2022-12-31', '2022', 'queued', null, 30);

-- Book A: paid (oldest) -> shipped, then a refunded delivered, then a newer
-- DRAFT. The latest non-refunded paid-or-later row (shipped) must win.
-- Book B: only a refunded shipped order. Book C: only draft / quoted /
-- cancelled / failed. Book D: a rendering order.
insert into public.memory_book_orders
  (id, book_id, family_id, requested_by, status, failure_reason, refunded_at, price_cents, quoted_page_count, book_document_snapshot, edits_snapshot, created_at) values
  ('ce600000-0000-4000-8000-000000000001', 'ce400000-0000-4000-8000-00000000000a', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001', 'paid', null, null, 5000, 30, '{}', '{}', now() - interval '5 days'),
  ('ce600000-0000-4000-8000-000000000002', 'ce400000-0000-4000-8000-00000000000a', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001', 'shipped', null, null, 5000, 30, '{}', '{}', now() - interval '4 days'),
  ('ce600000-0000-4000-8000-000000000003', 'ce400000-0000-4000-8000-00000000000a', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001', 'delivered', null, now() - interval '1 day', 5000, 30, '{}', '{}', now() - interval '3 days'),
  ('ce600000-0000-4000-8000-000000000004', 'ce400000-0000-4000-8000-00000000000a', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001', 'draft', null, null, null, null, null, null, now() - interval '1 day'),
  ('ce600000-0000-4000-8000-000000000005', 'ce400000-0000-4000-8000-00000000000b', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001', 'shipped', null, now(), 5000, 30, '{}', '{}', now() - interval '2 days'),
  ('ce600000-0000-4000-8000-000000000006', 'ce400000-0000-4000-8000-00000000000c', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001', 'draft', null, null, null, null, null, null, now() - interval '5 days'),
  ('ce600000-0000-4000-8000-000000000007', 'ce400000-0000-4000-8000-00000000000c', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001', 'quoted', null, null, 5000, 30, null, null, now() - interval '4 days'),
  ('ce600000-0000-4000-8000-000000000008', 'ce400000-0000-4000-8000-00000000000c', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001', 'cancelled', null, null, 5000, 30, null, null, now() - interval '3 days'),
  ('ce600000-0000-4000-8000-000000000009', 'ce400000-0000-4000-8000-00000000000c', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001', 'failed', 'TEST_FAILURE', null, 5000, 30, '{}', '{}', now() - interval '2 days'),
  ('ce600000-0000-4000-8000-00000000000a', 'ce400000-0000-4000-8000-00000000000d', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000002', 'rendering', null, null, 5000, 30, '{}', '{}', now() - interval '1 day');

insert into public.holiday_cards (id, family_id, created_by, year, greeting, status) values
  ('ce500000-0000-4000-8000-00000000000a', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001', 2025, 'holidays', 'ready'),
  ('ce500000-0000-4000-8000-00000000000b', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001', 2024, 'holidays', 'ready'),
  ('ce500000-0000-4000-8000-00000000000c', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001', 2023, 'holidays', 'ready'),
  ('ce500000-0000-4000-8000-00000000000d', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001', 2022, 'holidays', 'ready');

-- Card A: paid -> shipped (with shipped_at), then a NEWER checkout and draft:
-- the shipped row wins. Card B: only a refunded paid order. Card C: only
-- draft / quoted / checkout / cancelled / failed. Card D: in_production.
-- Plus a paid order whose card was deleted (card_id null): skipped.
insert into public.holiday_card_orders
  (id, card_id, family_id, requested_by, status, failure_reason, refunded_at, shipped_at, price_cents, packs, shipping_address, card_snapshot, snapshot_hash, created_at) values
  ('ce700000-0000-4000-8000-000000000001', 'ce500000-0000-4000-8000-00000000000a', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001', 'paid', null, null, null, 2490, 1, '{"country":"US"}', '{}', 'h1', now() - interval '5 days'),
  ('ce700000-0000-4000-8000-000000000002', 'ce500000-0000-4000-8000-00000000000a', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001', 'shipped', null, null, '2026-01-05 12:00:00+00', 2490, 1, '{"country":"US"}', '{}', 'h2', now() - interval '4 days'),
  ('ce700000-0000-4000-8000-000000000003', 'ce500000-0000-4000-8000-00000000000a', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001', 'checkout', null, null, null, 2490, 1, '{"country":"US"}', '{}', 'h3', now() - interval '1 day'),
  ('ce700000-0000-4000-8000-000000000004', 'ce500000-0000-4000-8000-00000000000a', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001', 'draft', null, null, null, null, null, null, null, null, now() - interval '1 day'),
  ('ce700000-0000-4000-8000-000000000005', 'ce500000-0000-4000-8000-00000000000b', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001', 'paid', null, now(), null, 2490, 1, '{"country":"US"}', '{}', 'h5', now() - interval '2 days'),
  ('ce700000-0000-4000-8000-000000000006', 'ce500000-0000-4000-8000-00000000000c', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001', 'draft', null, null, null, null, null, null, null, null, now() - interval '5 days'),
  ('ce700000-0000-4000-8000-000000000007', 'ce500000-0000-4000-8000-00000000000c', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001', 'quoted', null, null, null, 2490, 1, '{"country":"US"}', null, null, now() - interval '4 days'),
  ('ce700000-0000-4000-8000-000000000008', 'ce500000-0000-4000-8000-00000000000c', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001', 'checkout', null, null, null, 2490, 1, '{"country":"US"}', '{}', 'h8', now() - interval '3 days'),
  ('ce700000-0000-4000-8000-000000000009', 'ce500000-0000-4000-8000-00000000000c', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001', 'cancelled', null, null, null, null, null, null, null, null, now() - interval '2 days'),
  ('ce700000-0000-4000-8000-00000000000a', 'ce500000-0000-4000-8000-00000000000c', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001', 'failed', 'TEST_FAILURE', null, null, null, null, null, null, null, now() - interval '1 day'),
  ('ce700000-0000-4000-8000-00000000000b', 'ce500000-0000-4000-8000-00000000000d', 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000002', 'in_production', null, null, null, 2490, 1, '{"country":"US"}', '{}', 'hb', now() - interval '1 day'),
  ('ce700000-0000-4000-8000-00000000000c', null, 'ce100000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001', 'paid', null, null, null, 2490, 1, '{"country":"US"}', '{}', 'hc', now() - interval '1 day');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000001', true);
insert into ov select 'orders-owner', public.keepsakes_overview('ce100000-0000-4000-8000-000000000001');
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000002', true);
insert into ov select 'orders-manager', public.keepsakes_overview('ce100000-0000-4000-8000-000000000001');
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000003', true);
insert into ov select 'orders-viewer', public.keepsakes_overview('ce100000-0000-4000-8000-000000000001');
set local role postgres;

select is((select jsonb_array_length(doc->'orders') from ov where label = 'orders-owner'), 4,
  'exactly four ordered items: refunded, draft/quoted/checkout/cancelled/failed and null-card rows are all ignored');
select ok(
  (select doc->'orders' @> '[{"product":"book","item_id":"ce400000-0000-4000-8000-00000000000a","status":"shipped","shipped_at":null}]'::jsonb from ov where label = 'orders-owner'),
  'book A: the latest non-refunded paid-or-later order wins (a refunded delivered and a newer draft do not displace shipped)');
select ok(
  (select doc->'orders' @> '[{"product":"book","item_id":"ce400000-0000-4000-8000-00000000000d","status":"rendering"}]'::jsonb from ov where label = 'orders-owner'),
  'book D: a rendering order is reported (placed by the manager, visible family-wide)');
select ok(
  (select doc->'orders' @> '[{"product":"card","item_id":"ce500000-0000-4000-8000-00000000000a","status":"shipped","shipped_at":"2026-01-05T12:00:00+00:00"}]'::jsonb from ov where label = 'orders-owner'),
  'card A: the shipped order wins over a newer checkout / draft and carries shipped_at');
select ok(
  (select doc->'orders' @> '[{"product":"card","item_id":"ce500000-0000-4000-8000-00000000000d","status":"in_production"}]'::jsonb from ov where label = 'orders-owner'),
  'card D: in_production is reported');
select ok(
  (select not (doc->'orders' @> '[{"item_id":"ce400000-0000-4000-8000-00000000000b"}]'::jsonb)
      and not (doc->'orders' @> '[{"item_id":"ce400000-0000-4000-8000-00000000000c"}]'::jsonb)
      and not (doc->'orders' @> '[{"item_id":"ce500000-0000-4000-8000-00000000000b"}]'::jsonb)
      and not (doc->'orders' @> '[{"item_id":"ce500000-0000-4000-8000-00000000000c"}]'::jsonb)
   from ov where label = 'orders-owner'),
  'refunded-only and never-paid items (books B, C; cards B, C) are absent');
select is((select doc->'orders' from ov where label = 'orders-manager'), (select doc->'orders' from ov where label = 'orders-owner'),
  'a manager sees the same family-wide orders as the owner');
select is((select doc->'orders' from ov where label = 'orders-viewer'), '[]'::jsonb, 'a viewer still gets no orders');
select ok(
  (select doc::text !~ '(address|price|tracking|stripe|email)' from ov where label = 'orders-owner'),
  'the payload carries status only: no address, price, tracking or payment fields');

-- ---------------------------------------------------------------------------
-- 6. Holiday ship-by note (season switch)
-- ---------------------------------------------------------------------------

update public.holiday_card_settings
set mode = 'canary', canary_family_ids = '{}', closes_on = null, ship_by_note = 'Order by Dec 10 for Christmas delivery in the US.';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000001', true);
insert into ov select 'ship-off', public.keepsakes_overview('ce100000-0000-4000-8000-000000000001');
set local role postgres;
select is((select doc->>'holiday_ship_by_note' from ov where label = 'ship-off'), null,
  'out of season (family not enabled): no ship-by note');

update public.holiday_card_settings set mode = 'all';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000001', true);
insert into ov select 'ship-owner', public.keepsakes_overview('ce100000-0000-4000-8000-000000000001');
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000003', true);
insert into ov select 'ship-viewer', public.keepsakes_overview('ce100000-0000-4000-8000-000000000001');
set local role postgres;
select is((select doc->>'holiday_ship_by_note' from ov where label = 'ship-owner'), 'Order by Dec 10 for Christmas delivery in the US.',
  'in season: the owner gets the ship-by note verbatim');
select is((select doc->>'holiday_ship_by_note' from ov where label = 'ship-viewer'), null,
  'in season: a viewer still gets no note');

update public.holiday_card_settings set ship_by_note = '   ';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000001', true);
insert into ov select 'ship-blank', public.keepsakes_overview('ce100000-0000-4000-8000-000000000001');
set local role postgres;
select is((select doc->>'holiday_ship_by_note' from ov where label = 'ship-blank'), null, 'a blank note is null');
update public.holiday_card_settings set mode = 'canary', ship_by_note = null;

-- ---------------------------------------------------------------------------
-- 7. Holiday pool and year moments (a family of their own)
-- ---------------------------------------------------------------------------

-- Everything dated inside the owner-local current year. Pool rules (see
-- holidayPool): minus share-sensitive memories (topics, milestones, text) and
-- worried / sad / weary moments.
insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, emotion, topics, memory_date) values
  ('ce380000-0000-4000-8000-000000000001', 'ce100000-0000-4000-8000-000000000003', 'ce000000-0000-4000-8000-000000000008', 'A normal day at the park', 'text_only', 'none', 'joy', '{}', (select ys from cur) + 1),
  ('ce380000-0000-4000-8000-000000000002', 'ce100000-0000-4000-8000-000000000003', 'ce000000-0000-4000-8000-000000000008', 'Splashing around', 'text_only', 'none', 'joy', array['bath'], (select ys from cur) + 2),
  ('ce380000-0000-4000-8000-000000000003', 'ce100000-0000-4000-8000-000000000003', 'ce000000-0000-4000-8000-000000000008', 'He had a Fever and stayed in', 'text_only', 'none', 'joy', '{}', (select ys from cur) + 3),
  ('ce380000-0000-4000-8000-000000000004', 'ce100000-0000-4000-8000-000000000003', 'ce000000-0000-4000-8000-000000000008', 'A grumpy afternoon', 'text_only', 'none', 'sad', '{}', (select ys from cur) + 4),
  ('ce380000-0000-4000-8000-000000000005', 'ce100000-0000-4000-8000-000000000003', 'ce000000-0000-4000-8000-000000000008', 'First day nerves', 'text_only', 'none', 'worry', '{}', (select ys from cur) + 5),
  ('ce380000-0000-4000-8000-000000000006', 'ce100000-0000-4000-8000-000000000003', 'ce000000-0000-4000-8000-000000000008', 'A long night', 'text_only', 'none', 'weary', '{}', (select ys from cur) + 6),
  ('ce380000-0000-4000-8000-000000000007', 'ce100000-0000-4000-8000-000000000003', 'ce000000-0000-4000-8000-000000000008', 'Big news today', 'text_only', 'none', 'joy', '{}', (select ys from cur) + 7),
  ('ce380000-0000-4000-8000-000000000008', 'ce100000-0000-4000-8000-000000000003', 'ce000000-0000-4000-8000-000000000008', 'Splash time', 'text_only', 'none', 'joy', '{}', (select ys from cur) + 8),
  ('ce380000-0000-4000-8000-000000000009', 'ce100000-0000-4000-8000-000000000003', 'ce000000-0000-4000-8000-000000000008', 'Diaperman visited the hospitality tent', 'text_only', 'none', 'joy', '{}', (select ys from cur) + 9),
  ('ce380000-0000-4000-8000-00000000000a', 'ce100000-0000-4000-8000-000000000003', 'ce000000-0000-4000-8000-000000000008', 'Pipí en la poceta', 'text_only', 'none', 'joy', '{}', (select ys from cur) + 10),
  ('ce380000-0000-4000-8000-00000000000b', 'ce100000-0000-4000-8000-000000000003', 'ce000000-0000-4000-8000-000000000008', 'Reported one', 'text_only', 'none', 'joy', '{}', (select ys from cur) + 11),
  ('ce380000-0000-4000-8000-00000000000c', 'ce100000-0000-4000-8000-000000000003', 'ce000000-0000-4000-8000-000000000008', 'Last year''s one', 'text_only', 'none', 'joy', '{}', (select ys from cur) - 1),
  ('ce380000-0000-4000-8000-00000000000d', 'ce100000-0000-4000-8000-000000000003', 'ce000000-0000-4000-8000-000000000008', 'Next year''s one', 'text_only', 'none', 'joy', '{}', (select nys from cur)),
  ('ce380000-0000-4000-8000-00000000000e', 'ce100000-0000-4000-8000-000000000003', 'ce000000-0000-4000-8000-000000000008', 'A happy one', 'text_only', 'none', 'pride', '{}', (select ys from cur) + 12);
-- Milestones: potty-trained (candidate) is share-sensitive; first-bath
-- dismissed is not.
insert into public.memory_milestones (family_id, memory_id, milestone_id, status) values
  ('ce100000-0000-4000-8000-000000000003', 'ce380000-0000-4000-8000-000000000007', 'potty-trained', 'candidate'),
  ('ce100000-0000-4000-8000-000000000003', 'ce380000-0000-4000-8000-000000000008', 'first-bath', 'dismissed');
insert into public.content_reports (family_id, reporter_user_id, target_type, target_id, reason)
values ('ce100000-0000-4000-8000-000000000003', 'ce000000-0000-4000-8000-000000000008', 'memory', 'ce380000-0000-4000-8000-00000000000b', 'other');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000008', true);
insert into ov select 'holiday', public.keepsakes_overview('ce100000-0000-4000-8000-000000000003');
set local role postgres;

-- Pooled this year: 01-0a and 0e = 11 (the reported, last-year and next-year
-- ones are out). Holiday pool: 01, 08, 09, 0e = 4 (02 topic bath, 03 text
-- 'fever', 04 sad, 05 worry, 06 weary, 07 potty-trained milestone, 0a text).
select is((select (doc->>'year_moments')::int from ov where label = 'holiday'), 11,
  'year_moments counts the owner-local calendar year pool (reported / other-year memories out)');
select is((select (doc->>'holiday_pool')::int from ov where label = 'holiday'), 4,
  'holiday_pool excludes share-sensitive (topic, milestone, text) and sad / worried / weary memories');
select is((select doc->>'has_viewers' from ov where label = 'holiday'), 'false',
  'has_viewers is false when the family has no viewer');
select is((select doc->'recap' from ov where label = 'holiday'), 'null'::jsonb,
  'recap is null when the rollout does not include the family');
select is((select doc->>'preview_key' from ov where label = 'holiday'), null, 'no pictures: preview_key null');
select is((select doc->'book_preview_keys' from ov where label = 'holiday'), '{}'::jsonb,
  'no own children / pictures: book_preview_keys is an empty object');

-- ---------------------------------------------------------------------------
-- 8. Recap gates (the year_films_enabled gates, minus the >= 10 check)
-- ---------------------------------------------------------------------------

-- Rollout does not include the family.
update public.year_film_settings set canary_family_ids = '{}';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000001', true);
insert into ov select 'gate-rollout', public.keepsakes_overview('ce100000-0000-4000-8000-000000000001');
set local role postgres;
select is((select doc->'recap' from ov where label = 'gate-rollout'), 'null'::jsonb, 'recap is null when the rollout excludes the family');
update public.year_film_settings set canary_family_ids = array['ce100000-0000-4000-8000-000000000001']::uuid[];

-- launch_date after the next 1st / exactly the next 1st.
update public.year_film_settings set launch_date = (select nf + 1 from cur);
set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000001', true);
insert into ov select 'gate-launch-late', public.keepsakes_overview('ce100000-0000-4000-8000-000000000001');
set local role postgres;
select is((select doc->'recap' from ov where label = 'gate-launch-late'), 'null'::jsonb, 'recap is null while launch_date is after the next 1st');

update public.year_film_settings set launch_date = (select nf from cur);
set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000001', true);
insert into ov select 'gate-launch-edge', public.keepsakes_overview('ce100000-0000-4000-8000-000000000001');
set local role postgres;
select isnt((select doc->'recap' from ov where label = 'gate-launch-edge'), 'null'::jsonb, 'recap shows when launch_date is exactly the next 1st');

update public.year_film_settings set launch_date = null;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000001', true);
insert into ov select 'gate-launch-null', public.keepsakes_overview('ce100000-0000-4000-8000-000000000001');
set local role postgres;
select is((select doc->'recap' from ov where label = 'gate-launch-null'), 'null'::jsonb, 'recap is null without a launch_date');
update public.year_film_settings set launch_date = date '2020-01-01';

-- No own child with a date of birth.
update public.family_members set date_of_birth = null where family_id = 'ce100000-0000-4000-8000-000000000001' and relationship = 'child';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000001', true);
insert into ov select 'gate-child', public.keepsakes_overview('ce100000-0000-4000-8000-000000000001');
set local role postgres;
select is((select doc->'recap' from ov where label = 'gate-child'), 'null'::jsonb, 'recap is null without an own child that has a date of birth');
update public.family_members set date_of_birth = '2022-10-23' where id = 'ce200000-0000-4000-8000-000000000001';
update public.family_members set date_of_birth = '2024-02-02' where id = 'ce200000-0000-4000-8000-000000000002';

-- Billing lapses.
delete from public.owner_entitlements where owner_user_id = 'ce000000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000001', true);
insert into ov select 'gate-billing', public.keepsakes_overview('ce100000-0000-4000-8000-000000000001');
set local role postgres;
select is((select doc->'recap' from ov where label = 'gate-billing'), 'null'::jsonb, 'recap is null when billing does not allow films');
select isnt((select doc->>'preview_key' from ov where label = 'gate-billing'), null,
  'the owner extras do not depend on the recap gates');

-- ---------------------------------------------------------------------------
-- 9. card_front (20261010120000_keepsakes_overview_card_front.sql): the newest
--    non-deleted holiday card's actual front, owner/manager only. A family of
--    its own so the pool / order fixtures above never overlap.
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, is_anonymous) values
  ('ce000000-0000-4000-8000-000000000009', 'ko-card-owner@example.test', false),
  ('ce000000-0000-4000-8000-00000000000a', 'ko-card-viewer@example.test', false);
insert into public.families (id, name, owner_id) values
  ('ce100000-0000-4000-8000-000000000004', 'Card front family', 'ce000000-0000-4000-8000-000000000009');
insert into public.family_memberships (family_id, user_id, role) values
  ('ce100000-0000-4000-8000-000000000004', 'ce000000-0000-4000-8000-000000000009', 'owner'),
  ('ce100000-0000-4000-8000-000000000004', 'ce000000-0000-4000-8000-00000000000a', 'viewer');

-- One media memory in the family (m1 jpeg with a preview, m2 heic, m3 png,
-- m4 webp with a 1:2 aspect ratio, m5 video) and one in ANOTHER family (a
-- foreign jpeg, id ...ff).
insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, media_key, media_content_type, memory_date) values
  ('ce390000-0000-4000-8000-000000000001', 'ce100000-0000-4000-8000-000000000004', 'ce000000-0000-4000-8000-000000000009',
   'Card photos', 'media', 'none', 'cf-key/m1.jpg', 'image/jpeg', date '2020-06-01'),
  ('ce390000-0000-4000-8000-0000000000ff', 'ce100000-0000-4000-8000-000000000002', 'ce000000-0000-4000-8000-000000000004',
   'Foreign photo', 'media', 'none', 'cf-key/foreign.jpg', 'image/jpeg', date '2020-06-01');
insert into public.memory_media (id, memory_id, object_key, preview_object_key, content_type, aspect_ratio, position) values
  ('ce3a0000-0000-4000-8000-000000000001', 'ce390000-0000-4000-8000-000000000001', 'cf-key/m1.jpg', 'cf-key/m1-prev.jpg', 'image/jpeg', null, 0),
  ('ce3a0000-0000-4000-8000-000000000002', 'ce390000-0000-4000-8000-000000000001', 'cf-key/m2.heic', null, 'image/heic', null, 1),
  ('ce3a0000-0000-4000-8000-000000000003', 'ce390000-0000-4000-8000-000000000001', 'cf-key/m3.png', null, 'image/png', null, 2),
  ('ce3a0000-0000-4000-8000-000000000004', 'ce390000-0000-4000-8000-000000000001', 'cf-key/m4.webp', null, 'image/webp', 0.5, 3),
  ('ce3a0000-0000-4000-8000-000000000005', 'ce390000-0000-4000-8000-000000000001', 'cf-key/m5.mp4', 'cf-key/m5-poster.jpg', 'video/mp4', null, 4),
  ('ce3a0000-0000-4000-8000-0000000000ff', 'ce390000-0000-4000-8000-0000000000ff', 'cf-key/foreign.jpg', null, 'image/jpeg', null, 0);

-- No card yet.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000009', true);
insert into ov select 'cf-none', public.keepsakes_overview('ce100000-0000-4000-8000-000000000004');
set local role postgres;
select is((select doc->'card_front' from ov where label = 'cf-none'), 'null'::jsonb,
  'no card: card_front is JSON null');

-- Two live cards (the newer one is the answer) and a NEWER soft-deleted one.
-- Candidates in stored order: a legacy id, a heic, a foreign photo, a
-- non-uuid, a video, a bare string (ignored by readFrontCandidates), then the
-- png (m3, no size) and the jpeg (m1, 4000x3000).
insert into public.holiday_cards (id, family_id, created_by, year, greeting, language, status, front_candidates, edits, created_at) values
  ('ce510000-0000-4000-8000-000000000001', 'ce100000-0000-4000-8000-000000000004', 'ce000000-0000-4000-8000-000000000009', 2024, 'christmas', 'en', 'ready',
   '[{"mediaId":"ce3a0000-0000-4000-8000-000000000001"}]', '{}', now() - interval '2 days'),
  ('ce510000-0000-4000-8000-000000000002', 'ce100000-0000-4000-8000-000000000004', 'ce000000-0000-4000-8000-000000000009', 2025, 'new-year', 'es', 'ready',
   '[{"mediaId":"legacy:ce390000-0000-4000-8000-000000000001"},
     {"mediaId":"ce3a0000-0000-4000-8000-000000000002","rank":1},
     {"mediaId":"ce3a0000-0000-4000-8000-0000000000ff","rank":2},
     {"mediaId":"not-a-uuid","rank":3},
     {"mediaId":"ce3a0000-0000-4000-8000-000000000005","rank":4},
     "ce3a0000-0000-4000-8000-000000000001",
     {"mediaId":"ce3a0000-0000-4000-8000-000000000003","rank":6},
     {"mediaId":"ce3a0000-0000-4000-8000-000000000001","rank":7,"width":4000,"height":3000}]',
   '{}', now() - interval '1 day');
insert into public.holiday_cards (id, family_id, created_by, year, greeting, language, status, front_candidates, edits, created_at, deleted_at) values
  ('ce510000-0000-4000-8000-000000000003', 'ce100000-0000-4000-8000-000000000004', 'ce000000-0000-4000-8000-000000000009', 2026, 'holidays', 'en', 'ready',
   '[{"mediaId":"ce3a0000-0000-4000-8000-000000000001"}]', '{}', now(), now());

set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000009', true);
insert into ov select 'cf-default', public.keepsakes_overview('ce100000-0000-4000-8000-000000000004');
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-00000000000a', true);
insert into ov select 'cf-viewer', public.keepsakes_overview('ce100000-0000-4000-8000-000000000004');
set local role postgres;

select is((select doc->'card_front'->>'card_id' from ov where label = 'cf-default'), 'ce510000-0000-4000-8000-000000000002',
  'card_front is the newest NON-DELETED card (an older card and a newer soft-deleted one are skipped)');
select is((select (doc->'card_front'->>'year')::int from ov where label = 'cf-default'), 2025,
  'card_front carries the card''s year');
select is((select doc->'card_front'->>'image_key' from ov where label = 'cf-default'), 'cf-key/m3.png',
  'default front: the first USABLE candidate in stored order (legacy, heic, foreign, non-uuid, video and bare-string entries skipped); no preview falls back to the original');
select is((select doc->'card_front'->'width' from ov where label = 'cf-default'), 'null'::jsonb,
  'no pixel size known for the default front: width is JSON null');
select is((select doc->'card_front'->'height' from ov where label = 'cf-default'), 'null'::jsonb,
  'no pixel size known for the default front: height is JSON null');
select is((select doc->'card_front'->>'layout' from ov where label = 'cf-default'), 'bordered',
  'layout defaults to bordered');
select is((select doc->'card_front'->>'orientation' from ov where label = 'cf-default'), 'landscape',
  'orientation defaults to landscape when the size is unknown');
select is((select doc->'card_front'->>'greeting_position' from ov where label = 'cf-default'), 'bottom-left',
  'greeting_position defaults to bottom-left');
select is((select doc->'card_front'->'focal' from ov where label = 'cf-default'), 'null'::jsonb,
  'no saved focal point: focal is JSON null');
select is((select doc->'card_front'->'greeting_text' from ov where label = 'cf-default'), 'null'::jsonb,
  'no text override: greeting_text is JSON null');
select is((select doc->'card_front'->'subline_text' from ov where label = 'cf-default'), 'null'::jsonb,
  'no text override: subline_text is JSON null');
select is((select row(doc->'card_front'->>'greeting', doc->'card_front'->>'language')::text from ov where label = 'cf-default'),
  '(new-year,es)', 'greeting and language come from the card row');
select is((select (select array_agg(k order by k) from jsonb_object_keys(doc->'card_front') k)::text from ov where label = 'cf-default'),
  '{card_id,focal,greeting,greeting_position,greeting_text,height,image_key,language,layout,orientation,subline_text,width,year}',
  'card_front has exactly the documented keys');
select is((select doc->'card_front' from ov where label = 'cf-viewer'), 'null'::jsonb,
  'a viewer gets card_front null even when a card exists');
select ok((select doc::text !~ 'cf-key/' from ov where label = 'cf-viewer'),
  'a viewer''s payload carries no card photo key');

-- A saved pick wins (a usable one, even when ranked below others): the
-- preview key is preferred, the candidate entry supplies the pixel size.
update public.holiday_cards set edits = '{"frontImage":"ce3a0000-0000-4000-8000-000000000001"}'
where id = 'ce510000-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000009', true);
insert into ov select 'cf-pick', public.keepsakes_overview('ce100000-0000-4000-8000-000000000004');
set local role postgres;
select is((select doc->'card_front'->>'image_key' from ov where label = 'cf-pick'), 'cf-key/m1-prev.jpg',
  'a usable saved pick wins over the default and uses its preview key');
select is((select row((doc->'card_front'->>'width')::int, (doc->'card_front'->>'height')::int)::text from ov where label = 'cf-pick'),
  '(4000,3000)', 'the pick''s size comes from its front_candidates entry');
select is((select doc->'card_front'->>'orientation' from ov where label = 'cf-pick'), 'landscape',
  'wider than tall: landscape');

-- An unusable pick (heic, foreign family, not a uuid, a video, a legacy id,
-- an id that does not exist) falls back to the default front.
update public.holiday_cards set edits = '{"frontImage":"ce3a0000-0000-4000-8000-000000000002"}' where id = 'ce510000-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000009', true);
insert into ov select 'cf-pick-heic', public.keepsakes_overview('ce100000-0000-4000-8000-000000000004');
set local role postgres;
update public.holiday_cards set edits = '{"frontImage":"ce3a0000-0000-4000-8000-0000000000ff"}' where id = 'ce510000-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000009', true);
insert into ov select 'cf-pick-foreign', public.keepsakes_overview('ce100000-0000-4000-8000-000000000004');
set local role postgres;
update public.holiday_cards set edits = '{"frontImage":"nope"}' where id = 'ce510000-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000009', true);
insert into ov select 'cf-pick-junk', public.keepsakes_overview('ce100000-0000-4000-8000-000000000004');
set local role postgres;
update public.holiday_cards set edits = '{"frontImage":"ce3a0000-0000-4000-8000-000000000005"}' where id = 'ce510000-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000009', true);
insert into ov select 'cf-pick-video', public.keepsakes_overview('ce100000-0000-4000-8000-000000000004');
set local role postgres;
select is((select doc->'card_front'->>'image_key' from ov where label = 'cf-pick-heic'), 'cf-key/m3.png',
  'a heic pick is not printable: the default front is used');
select is((select doc->'card_front'->>'image_key' from ov where label = 'cf-pick-foreign'), 'cf-key/m3.png',
  'another family''s photo as the pick is ignored: the default front is used');
select is((select doc->'card_front'->>'image_key' from ov where label = 'cf-pick-junk'), 'cf-key/m3.png',
  'a non-uuid pick is ignored (and never errors): the default front is used');
select is((select doc->'card_front'->>'image_key' from ov where label = 'cf-pick-video'), 'cf-key/m3.png',
  'a video pick is not a photo: the default front is used');

-- A pick that is NOT a candidate still resolves; with only an aspect ratio
-- the size is the editor's placeholder (3000 px long side) and a tall picture
-- is a portrait card.
update public.holiday_cards set edits = '{"frontImage":"ce3a0000-0000-4000-8000-000000000004"}' where id = 'ce510000-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000009', true);
insert into ov select 'cf-pick-ratio', public.keepsakes_overview('ce100000-0000-4000-8000-000000000004');
set local role postgres;
select is((select doc->'card_front'->>'image_key' from ov where label = 'cf-pick-ratio'), 'cf-key/m4.webp',
  'a printable photo of the family resolves as the pick even when it is not a ranked candidate');
select is((select row((doc->'card_front'->>'width')::int, (doc->'card_front'->>'height')::int)::text from ov where label = 'cf-pick-ratio'),
  '(1500,3000)', 'no candidate entry: the size is a placeholder from the aspect ratio (3000 px long side)');
select is((select doc->'card_front'->>'orientation' from ov where label = 'cf-pick-ratio'), 'portrait',
  'taller than wide: portrait');

-- Edits overrides. The choices.greeting in edits is ignored (the row wins);
-- the focal point is read for the CHOSEN photo and clamped; "" survives.
update public.holiday_cards set edits = '{
  "frontImage": "ce3a0000-0000-4000-8000-000000000004",
  "choices": {"layout": "full-bleed", "orientation": "landscape", "greeting": "christmas", "greetingPosition": "top-center"},
  "focalPoints": {"ce3a0000-0000-4000-8000-000000000004": {"x": 1.7, "y": -0.2},
                  "ce3a0000-0000-4000-8000-000000000001": {"x": 0.1, "y": 0.2}},
  "text": {"front.greeting": "Happy everything!", "front.subline": "", "back.heading": "ignored"}
}' where id = 'ce510000-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000009', true);
insert into ov select 'cf-edits', public.keepsakes_overview('ce100000-0000-4000-8000-000000000004');
set local role postgres;
select is((select doc->'card_front'->>'layout' from ov where label = 'cf-edits'), 'full-bleed', 'edits.choices.layout full-bleed is honoured');
select is((select doc->'card_front'->>'orientation' from ov where label = 'cf-edits'), 'landscape',
  'edits.choices.orientation overrides the picture''s own (a tall picture forced to landscape)');
select is((select doc->'card_front'->>'greeting_position' from ov where label = 'cf-edits'), 'top-center', 'edits.choices.greetingPosition is honoured');
select is((select doc->'card_front'->'focal' from ov where label = 'cf-edits'), '{"x": 1, "y": 0}'::jsonb,
  'the focal point of the chosen photo is returned, clamped to 0..1');
select is((select doc->'card_front'->>'greeting_text' from ov where label = 'cf-edits'), 'Happy everything!', 'front.greeting override is returned');
select is((select doc->'card_front'->'subline_text' from ov where label = 'cf-edits'), '""'::jsonb,
  'an empty front.subline override ("hidden") is preserved as "", not null');
select is((select doc->'card_front'->>'greeting' from ov where label = 'cf-edits'), 'new-year',
  'the card row''s greeting is authoritative: edits.choices.greeting is ignored');

-- Invalid values degrade to the defaults (normalizeCardEdits).
update public.holiday_cards set edits = '{
  "choices": {"layout": "weird", "orientation": "diagonal", "greetingPosition": "middle"},
  "focalPoints": {"ce3a0000-0000-4000-8000-000000000003": {"x": "a", "y": 0.5}},
  "text": {"front.greeting": 5, "front.subline": null}
}' where id = 'ce510000-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000009', true);
insert into ov select 'cf-invalid', public.keepsakes_overview('ce100000-0000-4000-8000-000000000004');
set local role postgres;
select is((select row(doc->'card_front'->>'layout', doc->'card_front'->>'orientation', doc->'card_front'->>'greeting_position')::text
           from ov where label = 'cf-invalid'),
  '(bordered,landscape,bottom-left)', 'invalid layout / orientation / greetingPosition fall back to the defaults');
select is((select row(doc->'card_front'->'focal', doc->'card_front'->'greeting_text', doc->'card_front'->'subline_text')::text
           from ov where label = 'cf-invalid'),
  '(null,null,null)', 'a malformed focal point and non-string text overrides are null');

-- No usable photo at all: the rest of the card still comes back. The object
-- form of front_candidates ({ candidates: [...] }) is read like the array.
update public.holiday_cards set edits = '{}', front_candidates = '[{"mediaId":"ce3a0000-0000-4000-8000-000000000002"}]'
where id = 'ce510000-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000009', true);
insert into ov select 'cf-nophoto', public.keepsakes_overview('ce100000-0000-4000-8000-000000000004');
set local role postgres;
update public.holiday_cards set front_candidates = '{"candidates":[{"mediaId":"ce3a0000-0000-4000-8000-000000000002"},{"mediaId":"ce3a0000-0000-4000-8000-000000000003"}]}'
where id = 'ce510000-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000009', true);
insert into ov select 'cf-object', public.keepsakes_overview('ce100000-0000-4000-8000-000000000004');
set local role postgres;
select is((select row(doc->'card_front'->'image_key', doc->'card_front'->>'greeting', doc->'card_front'->>'layout')::text
           from ov where label = 'cf-nophoto'),
  '(null,new-year,bordered)', 'no usable photo: image_key is null but the card, greeting and layout still come back');
select is((select doc->'card_front'->>'image_key' from ov where label = 'cf-object'), 'cf-key/m3.png',
  'front_candidates in the { candidates: [...] } form is read like the array');

-- All cards soft-deleted: back to null.
update public.holiday_cards set deleted_at = now() where family_id = 'ce100000-0000-4000-8000-000000000004';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-000000000009', true);
insert into ov select 'cf-deleted', public.keepsakes_overview('ce100000-0000-4000-8000-000000000004');
set local role postgres;
select is((select doc->'card_front' from ov where label = 'cf-deleted'), 'null'::jsonb,
  'every card soft-deleted: card_front is JSON null');

-- ---------------------------------------------------------------------------
-- 10. cards + upcoming_films (20261011120000_keepsakes_overview_cards_upcoming.sql).
--     Families of their own; every date is relative to the owner-local today
--     (or to the current year for the year-end film), so the file passes on
--     any day. Internal helpers are called directly as postgres with a pinned
--     p_today.
-- ---------------------------------------------------------------------------

select ok(
  not has_function_privilege('authenticated', 'public.keepsake_card_front(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.keepsake_card_front(uuid)', 'EXECUTE'),
  'keepsake_card_front is internal: neither authenticated nor anon can execute it'
);
select ok(
  not has_function_privilege('authenticated', 'public.keepsake_upcoming_films(uuid, uuid, date)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.keepsake_upcoming_films(uuid, uuid, date)', 'EXECUTE'),
  'keepsake_upcoming_films is internal: neither authenticated nor anon can execute it'
);

insert into auth.users (id, email, is_anonymous) values
  ('ce000000-0000-4000-8000-00000000000b', 'ko-up-owner@example.test', false),
  ('ce000000-0000-4000-8000-00000000000c', 'ko-up-viewer@example.test', false),
  ('ce000000-0000-4000-8000-00000000000d', 'ko-up-manager@example.test', false),
  ('ce000000-0000-4000-8000-00000000000e', 'ko-up-hidden@example.test', false),
  ('ce000000-0000-4000-8000-00000000000f', 'ko-yr-owner@example.test', false);
update public.user_profiles set timezone = 'Pacific/Kiritimati'
where id in ('ce000000-0000-4000-8000-00000000000b', 'ce000000-0000-4000-8000-00000000000f');

insert into public.families (id, name, owner_id) values
  ('ce100000-0000-4000-8000-000000000005', 'Upcoming family', 'ce000000-0000-4000-8000-00000000000b'),
  ('ce100000-0000-4000-8000-000000000006', 'Year-end family', 'ce000000-0000-4000-8000-00000000000f');
insert into public.family_memberships (family_id, user_id, role) values
  ('ce100000-0000-4000-8000-000000000005', 'ce000000-0000-4000-8000-00000000000b', 'owner'),
  ('ce100000-0000-4000-8000-000000000005', 'ce000000-0000-4000-8000-00000000000c', 'viewer'),
  ('ce100000-0000-4000-8000-000000000005', 'ce000000-0000-4000-8000-00000000000d', 'manager'),
  ('ce100000-0000-4000-8000-000000000005', 'ce000000-0000-4000-8000-00000000000e', 'viewer'),
  ('ce100000-0000-4000-8000-000000000006', 'ce000000-0000-4000-8000-00000000000f', 'owner');
insert into public.owner_entitlements (
  owner_user_id, app_user_id, environment, store, product_id, entitlement_id,
  period_type, status, expires_at, will_renew
) values
  ('ce000000-0000-4000-8000-00000000000b', 'ce000000-0000-4000-8000-00000000000b',
   'production', 'app_store', 'momora_annual_v1', 'momora_plus', 'annual', 'active',
   transaction_timestamp() + interval '400 days', true),
  ('ce000000-0000-4000-8000-00000000000f', 'ce000000-0000-4000-8000-00000000000f',
   'production', 'app_store', 'momora_annual_v1', 'momora_plus', 'annual', 'active',
   transaction_timestamp() + interval '400 days', true);

-- Rollout to every family; launch long ago.
update public.year_film_settings set mode = 'all', launch_date = date '2020-01-01';

-- Members. Each child's age-N birthday falls at `today + k` (so the film, due
-- birthday + 2, is `today + k + 2`):
--   Ada  child, age 4, birthday today+8   -> film today+10   (the pool tests)
--   Bo   cousin (tag target only; never an own child)
--   Cy   child, age 3, birthday today+28  -> film today+30   (last day in)
--   Di   child, age 2, birthday today+29  -> film today+31   (one day out)
--   Ed   child, age 5, birthday today-2   -> film today      (due today: in)
--   Fay  child, age 6, birthday today-3   -> film yesterday  (out)
--   Gus  child, age 13, birthday today+3  -> age 13 is outside 1..12
--   Ivy  cousin, age 4, birthday today+8  -> not an own child
--   Jo   unsorted (null role), age 7, birthday today+13 -> DOB rule: in
--   Kai  child, age 3, birthday today+10  -> film today+12   (film-row tests)
insert into public.family_members (id, family_id, name, date_of_birth, relationship)
select v.id::uuid, 'ce100000-0000-4000-8000-000000000005', v.name,
       case when v.age is null then null else ((cur.today + v.k) - make_interval(years => v.age))::date end,
       v.rel
from cur,
(values
  ('ce200000-0000-4000-8000-00000000000a', 'Ada', 4, 8, 'child'),
  ('ce200000-0000-4000-8000-00000000000b', 'Bo', null, null, 'cousin'),
  ('ce200000-0000-4000-8000-00000000000c', 'Cy', 3, 28, 'child'),
  ('ce200000-0000-4000-8000-00000000000d', 'Di', 2, 29, 'child'),
  ('ce200000-0000-4000-8000-00000000000e', 'Ed', 5, -2, 'child'),
  ('ce200000-0000-4000-8000-00000000000f', 'Fay', 6, -3, 'child'),
  ('ce200000-0000-4000-8000-000000000010', 'Gus', 13, 3, 'child'),
  ('ce200000-0000-4000-8000-000000000011', 'Ivy', 4, 8, 'cousin'),
  ('ce200000-0000-4000-8000-000000000012', 'Jo', 7, 13, null),
  ('ce200000-0000-4000-8000-000000000013', 'Kai', 3, 10, 'child')
) as v(id, name, age, k, rel);

-- Ada's film window, and the month-index dates the quarters are read from.
-- Quarter = floor(months since the MONTH of scope_start / 3), clamped to 3.
create temp table ad on commit drop as
select cur.today,
       ((cur.today + 8) - interval '1 year')::date as sc,        -- scope_start (age-3 birthday)
       cur.today + 10 as se,                                      -- scope_end_excl = film date
       date_trunc('month', ((cur.today + 8) - interval '1 year'))::date as m0
from cur;

create or replace function pg_temp.entry(p_doc jsonb, p_member uuid)
returns jsonb language sql as $$
  select e from jsonb_array_elements(p_doc) e where e ->> 'member_id' = p_member::text
$$;
-- In December the owner-local "today" also announces the year-end film: the
-- birthday assertions look at the birthday entries only.
create or replace function pg_temp.births(p_doc jsonb)
returns jsonb language sql as $$
  select coalesce(jsonb_agg(e), '[]'::jsonb) from jsonb_array_elements(p_doc) e where e ->> 'kind' = 'birthday'
$$;
create or replace function pg_temp.kinds(p_doc jsonb, p_kind text)
returns jsonb language sql as $$
  select e from jsonb_array_elements(p_doc) e where e ->> 'kind' = p_kind
$$;

create temp table uf (label text primary key, doc jsonb);

-- ---- Window: which birthdays are announced --------------------------------
insert into uf select 'window', public.keepsake_upcoming_films(
  'ce100000-0000-4000-8000-000000000005', null, (select today from cur));

select is(
  (select array_agg(e ->> 'member_id' order by ord) from uf, jsonb_array_elements(pg_temp.births(doc)) with ordinality as x(e, ord) where label = 'window'),
  array['ce200000-0000-4000-8000-00000000000e', 'ce200000-0000-4000-8000-00000000000a',
        'ce200000-0000-4000-8000-000000000013', 'ce200000-0000-4000-8000-000000000012',
        'ce200000-0000-4000-8000-00000000000c'],
  'announced, soonest first: Ed (today), Ada (+10), Kai (+12), Jo (+15, unsorted role by the DOB rule), Cy (+30)');
select is((select (pg_temp.entry(doc, 'ce200000-0000-4000-8000-00000000000c') ->> 'film_date')::date - (select today from cur) from uf where label = 'window'),
  30, 'a film date 30 days out is announced');
select is((select pg_temp.entry(doc, 'ce200000-0000-4000-8000-00000000000d') from uf where label = 'window'), null,
  'a film date 31 days out is not');
select is((select (pg_temp.entry(doc, 'ce200000-0000-4000-8000-00000000000e') ->> 'film_date')::date - (select today from cur) from uf where label = 'window'),
  0, 'a film due today is announced (inclusive of today)');
select is((select pg_temp.entry(doc, 'ce200000-0000-4000-8000-00000000000f') from uf where label = 'window'), null,
  'a film date yesterday is not');
select is((select pg_temp.entry(doc, 'ce200000-0000-4000-8000-000000000010') from uf where label = 'window'), null,
  'age 13 is outside the 1-12 birthday films');
select is((select pg_temp.entry(doc, 'ce200000-0000-4000-8000-000000000011') from uf where label = 'window'), null,
  'a cousin (explicit non-child role) is not an own child');

-- ---- Ada's envelope --------------------------------------------------------
select is(
  (select row(e ->> 'kind', (e ->> 'age_year')::int, (e ->> 'film_date')::date, (e ->> 'scope_end_excl')::date)::text
   from uf, pg_temp.entry(doc, 'ce200000-0000-4000-8000-00000000000a') e where label = 'window'),
  (select row('birthday', 4, se, se)::text from ad),
  'Ada: a birthday film, age 4, film date = scope_end_excl = birthday + 2 days');
select is(
  (select (e ->> 'scope_start')::date from uf, pg_temp.entry(doc, 'ce200000-0000-4000-8000-00000000000a') e where label = 'window'),
  (select sc from ad), 'scope_start is the previous birthday (the age-year start)');
select is(
  (select row(e -> 'min_moments', e -> 'min_visuals', e -> 'min_quarters')::text
   from uf, pg_temp.entry(doc, 'ce200000-0000-4000-8000-00000000000a') e where label = 'window'),
  '(60,40,3)', 'the birthday floors ride along: 60 moments, 40 visuals, 3 quarters');
select is(
  (select (select array_agg(k order by k) from jsonb_object_keys(e) k)::text
   from uf, pg_temp.entry(doc, 'ce200000-0000-4000-8000-00000000000a') e where label = 'window'),
  '{age_year,film_date,kind,member_id,min_moments,min_quarters,min_visuals,moments,picture_key,quarters,scope_end_excl,scope_start,visuals}',
  'an upcoming film has exactly the documented keys');

-- ---- Ada's pool: tagged to the child only, in the film's scope -------------
-- Stage 1. Counted: t1 (text, scope_start), t2 (illustration, month 3),
-- t3 (illustration, SAD, month 6). Not counted: t5 untagged, t6 tagged to a
-- sibling only, t8 under an open report, t9a the day before the scope, t9b ON
-- scope_end_excl.
insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, illustration_key, emotion, memory_date)
select v.id::uuid, 'ce100000-0000-4000-8000-000000000005', 'ce000000-0000-4000-8000-00000000000b', v.content,
       case when v.ill then 'text_illustration' else 'text_only' end,
       case when v.ill then 'ready' else 'none' end,
       case when v.ill then 'up-key/' || v.tag || '.png' end, v.emotion, v.d
from (values
  ('ce3b0000-0000-4000-8000-000000000001', 'Ada t1', false, 't1', null, (select sc from ad)),
  ('ce3b0000-0000-4000-8000-000000000002', 'Ada t2', true, 't2', null, (select (m0 + make_interval(months => 3))::date + 10 from ad)),
  ('ce3b0000-0000-4000-8000-000000000003', 'Ada t3 sad', true, 't3', 'sad', (select (m0 + make_interval(months => 6))::date + 10 from ad)),
  ('ce3b0000-0000-4000-8000-000000000005', 'Untagged', true, 't5', null, (select sc + 1 from ad)),
  ('ce3b0000-0000-4000-8000-000000000006', 'Sibling only', true, 't6', null, (select sc + 1 from ad)),
  ('ce3b0000-0000-4000-8000-000000000008', 'Reported', true, 't8', null, (select sc + 2 from ad)),
  ('ce3b0000-0000-4000-8000-000000000009', 'Day before scope', true, 't9a', null, (select sc - 1 from ad)),
  ('ce3b0000-0000-4000-8000-00000000000a', 'On scope end', true, 't9b', null, (select se from ad))
) as v(id, content, ill, tag, emotion, d);
insert into public.memory_family_members (memory_id, family_member_id) values
  ('ce3b0000-0000-4000-8000-000000000001', 'ce200000-0000-4000-8000-00000000000a'),
  ('ce3b0000-0000-4000-8000-000000000002', 'ce200000-0000-4000-8000-00000000000a'),
  ('ce3b0000-0000-4000-8000-000000000003', 'ce200000-0000-4000-8000-00000000000a'),
  ('ce3b0000-0000-4000-8000-000000000006', 'ce200000-0000-4000-8000-00000000000b'),
  ('ce3b0000-0000-4000-8000-000000000008', 'ce200000-0000-4000-8000-00000000000a'),
  ('ce3b0000-0000-4000-8000-000000000009', 'ce200000-0000-4000-8000-00000000000a'),
  ('ce3b0000-0000-4000-8000-00000000000a', 'ce200000-0000-4000-8000-00000000000a');
insert into public.content_reports (family_id, reporter_user_id, target_type, target_id, reason)
values ('ce100000-0000-4000-8000-000000000005', 'ce000000-0000-4000-8000-00000000000c', 'memory',
        'ce3b0000-0000-4000-8000-000000000008', 'other');

insert into uf select 's1', public.keepsake_upcoming_films('ce100000-0000-4000-8000-000000000005', null, (select today from ad));
select is(
  (select row(e -> 'moments', e -> 'visuals', e -> 'quarters')::text
   from uf, pg_temp.entry(doc, 'ce200000-0000-4000-8000-00000000000a') e where label = 's1'),
  '(3,2,1)',
  'stage 1: only memories TAGGED to the child, inside scope_start..scope_end_excl, unreported, count (untagged, sibling-only, reported, the day before and the scope end are out); a SAD visual is a visual but covers no quarter');

-- Stage 2. t4: illustration, WEARY, month 9 (weary still covers its quarter);
-- t7: illustration tagged to Ada AND Bo, on scope_start (quarter 0).
insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, illustration_key, emotion, memory_date)
select v.id::uuid, 'ce100000-0000-4000-8000-000000000005', 'ce000000-0000-4000-8000-00000000000b', v.content,
       'text_illustration', 'ready', 'up-key/' || v.tag || '.png', v.emotion, v.d
from (values
  ('ce3b0000-0000-4000-8000-000000000004', 'Ada t4 weary', 't4', 'weary', (select (m0 + make_interval(months => 9))::date + 10 from ad)),
  ('ce3b0000-0000-4000-8000-000000000007', 'Ada and Bo', 't7', null, (select sc from ad))
) as v(id, content, tag, emotion, d);
insert into public.memory_family_members (memory_id, family_member_id) values
  ('ce3b0000-0000-4000-8000-000000000004', 'ce200000-0000-4000-8000-00000000000a'),
  ('ce3b0000-0000-4000-8000-000000000007', 'ce200000-0000-4000-8000-00000000000a'),
  ('ce3b0000-0000-4000-8000-000000000007', 'ce200000-0000-4000-8000-00000000000b');
insert into uf select 's2', public.keepsake_upcoming_films('ce100000-0000-4000-8000-000000000005', null, (select today from ad));
select is(
  (select row(e -> 'moments', e -> 'visuals', e -> 'quarters')::text
   from uf, pg_temp.entry(doc, 'ce200000-0000-4000-8000-00000000000a') e where label = 's2'),
  '(5,4,3)',
  'stage 2: a weary visual and a memory tagged to the child plus a sibling count; quarters 0, 1 and 3 are covered (the sad one still covers nothing)');

-- Stage 3. t10: a visual on the day AFTER the birthday (scope_end_excl - 1),
-- by an author the viewer hid. Its month index is >= 12, which clamps to
-- quarter 3 instead of opening a fourth quarter.
insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, illustration_key, memory_date)
values ('ce3b0000-0000-4000-8000-000000000010', 'ce100000-0000-4000-8000-000000000005', 'ce000000-0000-4000-8000-00000000000e',
        'The day after the party', 'text_illustration', 'ready', 'up-key/t10.png', (select se - 1 from ad));
insert into public.memory_family_members (memory_id, family_member_id)
values ('ce3b0000-0000-4000-8000-000000000010', 'ce200000-0000-4000-8000-00000000000a');
insert into public.blocked_family_accounts (family_id, blocker_user_id, blocked_user_id)
values ('ce100000-0000-4000-8000-000000000005', 'ce000000-0000-4000-8000-00000000000c', 'ce000000-0000-4000-8000-00000000000e');
insert into uf select 's3', public.keepsake_upcoming_films('ce100000-0000-4000-8000-000000000005', null, (select today from ad));
select is(
  (select row(e -> 'moments', e -> 'visuals', e -> 'quarters')::text
   from uf, pg_temp.entry(doc, 'ce200000-0000-4000-8000-00000000000a') e where label = 's3'),
  '(6,5,3)',
  'stage 3: the two days after the birthday are in scope, and a month index past 11 clamps into quarter 3');

-- ---- RPC level: viewers see films, not cards; personal blocks hide pictures -
insert into public.holiday_cards (id, family_id, created_by, year, greeting, language, status, front_candidates, edits, created_at, deleted_at) values
  ('ce520000-0000-4000-8000-000000000001', 'ce100000-0000-4000-8000-000000000005', 'ce000000-0000-4000-8000-00000000000b',
   2025, 'new-year', 'es', 'generating', null, '{}', now() - interval '2 days', null),
  ('ce520000-0000-4000-8000-000000000002', 'ce100000-0000-4000-8000-000000000005', 'ce000000-0000-4000-8000-00000000000b',
   2024, 'christmas', 'en', 'ready', null, '{}', now() - interval '3 days', null),
  ('ce520000-0000-4000-8000-000000000003', 'ce100000-0000-4000-8000-000000000005', 'ce000000-0000-4000-8000-00000000000b',
   2023, 'holidays', 'en', 'failed', null, '{}', now() - interval '1 hour', null),
  ('ce520000-0000-4000-8000-000000000004', 'ce100000-0000-4000-8000-000000000005', 'ce000000-0000-4000-8000-00000000000b',
   2022, 'holidays', 'en', 'ready', '[]', '{}', now() - interval '4 days', null),
  ('ce520000-0000-4000-8000-000000000005', 'ce100000-0000-4000-8000-000000000005', 'ce000000-0000-4000-8000-00000000000b',
   2026, 'holidays', 'en', 'ready', null, '{}', now(), now());

set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-00000000000b', true);
insert into ov select 'up-owner', public.keepsakes_overview('ce100000-0000-4000-8000-000000000005');
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-00000000000c', true);
insert into ov select 'up-viewer', public.keepsakes_overview('ce100000-0000-4000-8000-000000000005');
set local role postgres;

select ok(
  (select doc ?& array['recap', 'has_viewers', 'year_moments', 'holiday_pool', 'holiday_min_pool', 'holiday_ship_by_note',
                       'preview_key', 'book_preview_keys', 'orders', 'card_front', 'cards', 'upcoming_films']
          and (select count(*) from jsonb_object_keys(doc)) = 12
   from ov where label = 'up-owner'),
  'the payload keeps every existing key and adds cards + upcoming_films (12 keys)');
select is((select doc -> 'cards' from ov where label = 'up-viewer'), '[]'::jsonb, 'a viewer gets cards = []');
select is((select jsonb_typeof(doc -> 'upcoming_films') from ov where label = 'up-viewer'), 'array', 'a viewer gets upcoming_films');
select is(
  (select jsonb_agg(e - 'picture_key') from ov, jsonb_array_elements(doc -> 'upcoming_films') e where label = 'up-viewer'),
  (select jsonb_agg(e - 'picture_key') from ov, jsonb_array_elements(doc -> 'upcoming_films') e where label = 'up-owner'),
  'a viewer sees the same upcoming films (and counts) as the owner');
select is(
  (select jsonb_array_length(pg_temp.births(doc -> 'upcoming_films')) from ov where label = 'up-viewer'), 5,
  'five birthday films are announced');
select is((select pg_temp.entry(doc -> 'upcoming_films', 'ce200000-0000-4000-8000-00000000000a') ->> 'picture_key' from ov where label = 'up-owner'),
  'up-key/t10.png', 'picture_key: the newest pooled picture in the scope');
select is((select pg_temp.entry(doc -> 'upcoming_films', 'ce200000-0000-4000-8000-00000000000a') ->> 'picture_key' from ov where label = 'up-viewer'),
  'up-key/t4.png', 'picture_key skips an author the CALLER hid (counts do not)');
select is((select pg_temp.entry(doc -> 'upcoming_films', 'ce200000-0000-4000-8000-00000000000c') -> 'picture_key' from ov where label = 'up-owner'),
  'null'::jsonb, 'a child with no pictures in the scope: picture_key is JSON null');

-- ---- Film rows: which tiles the real film takes over ----------------------
-- Kai's film key (the scheduler's): family, kind, member, scope_start_date.
create temp table kai as
select ((cur.today + 10) - interval '1 year')::date as sc, cur.today + 12 as se from cur;
insert into public.year_films (id, family_id, kind, family_member_id, age_year, scope_start_date, scope_end_exclusive, surface_at, status)
select 'ce530000-0000-4000-8000-000000000001', 'ce100000-0000-4000-8000-000000000005', 'birthday',
       'ce200000-0000-4000-8000-000000000013', 3, sc, se, now() + interval '2 days', 'queued'
from kai;
insert into uf select 'kai-queued', public.keepsake_upcoming_films('ce100000-0000-4000-8000-000000000005', null, (select today from cur));
update public.year_films set status = 'skipped' where id = 'ce530000-0000-4000-8000-000000000001';
insert into uf select 'kai-skipped', public.keepsake_upcoming_films('ce100000-0000-4000-8000-000000000005', null, (select today from cur));
update public.year_films set status = 'failed' where id = 'ce530000-0000-4000-8000-000000000001';
insert into uf select 'kai-failed', public.keepsake_upcoming_films('ce100000-0000-4000-8000-000000000005', null, (select today from cur));
update public.year_films set status = 'rendering' where id = 'ce530000-0000-4000-8000-000000000001';
insert into uf select 'kai-rendering', public.keepsake_upcoming_films('ce100000-0000-4000-8000-000000000005', null, (select today from cur));
update public.year_films set status = 'ready', ready_at = now() where id = 'ce530000-0000-4000-8000-000000000001';
insert into uf select 'kai-ready', public.keepsake_upcoming_films('ce100000-0000-4000-8000-000000000005', null, (select today from cur));
delete from public.year_films where id = 'ce530000-0000-4000-8000-000000000001';
insert into public.year_films (id, family_id, kind, family_member_id, age_year, scope_start_date, scope_end_exclusive, surface_at, status, forced)
select 'ce530000-0000-4000-8000-000000000002', 'ce100000-0000-4000-8000-000000000005', 'birthday',
       'ce200000-0000-4000-8000-000000000013', 3, sc, se, now() + interval '2 days', 'ready', true
from kai;
insert into uf select 'kai-forced', public.keepsake_upcoming_films('ce100000-0000-4000-8000-000000000005', null, (select today from cur));
delete from public.year_films where id = 'ce530000-0000-4000-8000-000000000002';

select is((select pg_temp.entry(doc, 'ce200000-0000-4000-8000-000000000013') from uf where label = 'kai-queued'), null,
  'a queued film row takes the tile away (the film is on its way)');
select isnt((select pg_temp.entry(doc, 'ce200000-0000-4000-8000-000000000013') from uf where label = 'kai-skipped'), null,
  'a skipped film row keeps the tile (terminal, invisible to clients)');
select isnt((select pg_temp.entry(doc, 'ce200000-0000-4000-8000-000000000013') from uf where label = 'kai-failed'), null,
  'a failed film row keeps the tile');
select is((select pg_temp.entry(doc, 'ce200000-0000-4000-8000-000000000013') from uf where label = 'kai-rendering'), null,
  'a rendering film row takes the tile away');
select is((select pg_temp.entry(doc, 'ce200000-0000-4000-8000-000000000013') from uf where label = 'kai-ready'), null,
  'a ready film row takes the tile away');
select isnt((select pg_temp.entry(doc, 'ce200000-0000-4000-8000-000000000013') from uf where label = 'kai-forced'), null,
  'a forced (operator / canary) film row never takes a real film''s slot');
select is((select jsonb_array_length(pg_temp.births(doc)) from uf where label = 'kai-ready'), 4,
  'a film row of one child leaves the other tiles alone');

-- ---- cards ----------------------------------------------------------------
-- One photo memory in the family (m1 jpeg with a preview, m2 png).
insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, media_key, media_content_type, memory_date)
values ('ce3c0000-0000-4000-8000-000000000001', 'ce100000-0000-4000-8000-000000000005', 'ce000000-0000-4000-8000-00000000000b',
        'Card photos', 'media', 'none', 'uc-key/m1.jpg', 'image/jpeg', date '2020-06-01');
insert into public.memory_media (id, memory_id, object_key, preview_object_key, content_type, aspect_ratio, position) values
  ('ce3d0000-0000-4000-8000-000000000001', 'ce3c0000-0000-4000-8000-000000000001', 'uc-key/m1.jpg', 'uc-key/m1-prev.jpg', 'image/jpeg', null, 0),
  ('ce3d0000-0000-4000-8000-000000000002', 'ce3c0000-0000-4000-8000-000000000001', 'uc-key/m2.png', null, 'image/png', 0.5, 1);
update public.holiday_cards set
  front_candidates = '[{"mediaId":"ce3d0000-0000-4000-8000-000000000001","width":4000,"height":3000}]',
  edits = '{"choices":{"layout":"full-bleed","greetingPosition":"top-center"},"text":{"front.greeting":"Hi there"}}'
where id = 'ce520000-0000-4000-8000-000000000001';
update public.holiday_cards set front_candidates = '[{"mediaId":"ce3d0000-0000-4000-8000-000000000002"}]'
where id = 'ce520000-0000-4000-8000-000000000003';

-- 2025: no order. 2024: shipped. 2023: paid but REFUNDED (holiday_card_summary
-- still calls that ordered). 2022: only a draft.
insert into public.holiday_card_orders
  (id, card_id, family_id, requested_by, status, failure_reason, refunded_at, shipped_at, price_cents, packs, shipping_address, card_snapshot, snapshot_hash, created_at) values
  ('ce540000-0000-4000-8000-000000000001', 'ce520000-0000-4000-8000-000000000002', 'ce100000-0000-4000-8000-000000000005', 'ce000000-0000-4000-8000-00000000000b', 'shipped', null, null, '2026-01-05 12:00:00+00', 2490, 1, '{"country":"US"}', '{}', 'u1', now() - interval '2 days'),
  ('ce540000-0000-4000-8000-000000000002', 'ce520000-0000-4000-8000-000000000003', 'ce100000-0000-4000-8000-000000000005', 'ce000000-0000-4000-8000-00000000000b', 'paid', null, now(), null, 2490, 1, '{"country":"US"}', '{}', 'u2', now() - interval '2 days'),
  ('ce540000-0000-4000-8000-000000000003', 'ce520000-0000-4000-8000-000000000004', 'ce100000-0000-4000-8000-000000000005', 'ce000000-0000-4000-8000-00000000000b', 'draft', null, null, null, null, null, null, null, null, now() - interval '2 days');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-00000000000b', true);
insert into ov select 'cards-owner', public.keepsakes_overview('ce100000-0000-4000-8000-000000000005');
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-00000000000d', true);
insert into ov select 'cards-manager', public.keepsakes_overview('ce100000-0000-4000-8000-000000000005');
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-00000000000c', true);
insert into ov select 'cards-viewer', public.keepsakes_overview('ce100000-0000-4000-8000-000000000005');
set local role postgres;

select is((select array_agg((e ->> 'year')::int order by ord) from ov, jsonb_array_elements(doc -> 'cards') with ordinality as x(e, ord) where label = 'cards-owner'),
  array[2025, 2024, 2023, 2022], 'cards: every non-deleted card, newest year first (the soft-deleted 2026 card is out)');
select is((select array_agg(e ->> 'status' order by ord) from ov, jsonb_array_elements(doc -> 'cards') with ordinality as x(e, ord) where label = 'cards-owner'),
  array['generating', 'ready', 'failed', 'ready'], 'cards carry their status');
select is((select array_agg((e ->> 'ordered')::boolean order by ord) from ov, jsonb_array_elements(doc -> 'cards') with ordinality as x(e, ord) where label = 'cards-owner'),
  array[false, true, true, false],
  'ordered follows holiday_card_summary: any paid / submitted / in_production / shipped order (a refund does not undo it, a draft is not an order)');
select is((select doc -> 'cards' from ov where label = 'cards-manager'), (select doc -> 'cards' from ov where label = 'cards-owner'),
  'a manager sees the same cards as the owner');
select is((select doc -> 'cards' from ov where label = 'cards-viewer'), '[]'::jsonb, 'a viewer gets no cards');
select ok((select doc::text !~ 'uc-key/' from ov where label = 'cards-viewer'), 'a viewer''s payload carries no card photo key');
select is(
  (select (select array_agg(k order by k) from jsonb_object_keys(doc -> 'cards' -> 0) k)::text from ov where label = 'cards-owner'),
  '{card_id,front,ordered,status,year}', 'a card entry has exactly the documented keys');
select is(
  (select (select array_agg(k order by k) from jsonb_object_keys(doc -> 'cards' -> 0 -> 'front') k)::text from ov where label = 'cards-owner'),
  '{focal,greeting,greeting_position,greeting_text,height,image_key,language,layout,orientation,subline_text,width}',
  'a card front has the card_front keys minus card_id and year');
select ok(
  (select bool_and((e -> 'front') = (public.keepsake_card_front((e ->> 'card_id')::uuid) - 'card_id' - 'year'))
   from ov, jsonb_array_elements(doc -> 'cards') e where label = 'cards-owner'),
  'every cards[].front equals keepsake_card_front for that card');
select is((select doc -> 'card_front' ->> 'card_id' from ov where label = 'cards-owner'), 'ce520000-0000-4000-8000-000000000003',
  'card_front is unchanged: the newest card by created_at (2023), not the newest year');
select is(
  (select (doc -> 'card_front') - 'card_id' - 'year' from ov where label = 'cards-owner'),
  (select e -> 'front' from ov, jsonb_array_elements(doc -> 'cards') e where label = 'cards-owner' and e ->> 'year' = '2023'),
  'card_front and the matching cards[].front are the same front');
select is(
  (select row(e -> 'front' ->> 'image_key', (e -> 'front' ->> 'width')::int, (e -> 'front' ->> 'height')::int,
              e -> 'front' ->> 'layout', e -> 'front' ->> 'greeting_position', e -> 'front' ->> 'greeting_text',
              e -> 'front' ->> 'greeting', e -> 'front' ->> 'language')::text
   from ov, jsonb_array_elements(doc -> 'cards') e where label = 'cards-owner' and e ->> 'year' = '2025'),
  '(uc-key/m1-prev.jpg,4000,3000,full-bleed,top-center,"Hi there",new-year,es)',
  'the 2025 front: the candidate''s preview key and size, the saved layout, position and caption, the row''s greeting and language');
select is(
  (select e -> 'front' -> 'image_key' from ov, jsonb_array_elements(doc -> 'cards') e where label = 'cards-owner' and e ->> 'year' = '2024'),
  'null'::jsonb, 'a card with no candidates still lists, with image_key null');
select is(public.keepsake_card_front('ce520000-0000-4000-8000-000000000005'), null,
  'keepsake_card_front is null for a soft-deleted card');
select is(public.keepsake_card_front(gen_random_uuid()), null, 'keepsake_card_front is null for an unknown card');

update public.holiday_cards set deleted_at = now() where family_id = 'ce100000-0000-4000-8000-000000000005';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-00000000000b', true);
insert into ov select 'cards-none', public.keepsakes_overview('ce100000-0000-4000-8000-000000000005');
set local role postgres;
select ok((select doc -> 'cards' = '[]'::jsonb and doc -> 'card_front' = 'null'::jsonb from ov where label = 'cards-none'),
  'every card soft-deleted: cards is [] and card_front is null');

-- ---- Gates ----------------------------------------------------------------
update public.year_film_settings set mode = 'canary', canary_family_ids = '{}';
insert into uf select 'g-rollout', public.keepsake_upcoming_films('ce100000-0000-4000-8000-000000000005', null, (select today from cur));
update public.year_film_settings set mode = 'all';
update public.year_film_settings set launch_date = null;
insert into uf select 'g-launch-null', public.keepsake_upcoming_films('ce100000-0000-4000-8000-000000000005', null, (select today from cur));
update public.year_film_settings set launch_date = (select se from ad);        -- Ada's film date exactly
insert into uf select 'g-launch-edge', public.keepsake_upcoming_films('ce100000-0000-4000-8000-000000000005', null, (select today from cur));
update public.year_film_settings set launch_date = (select se + 1 from ad);    -- the day after
insert into uf select 'g-launch-late', public.keepsake_upcoming_films('ce100000-0000-4000-8000-000000000005', null, (select today from cur));
update public.year_film_settings set launch_date = date '2020-01-01';
delete from public.owner_entitlements where owner_user_id = 'ce000000-0000-4000-8000-00000000000b';
insert into uf select 'g-billing', public.keepsake_upcoming_films('ce100000-0000-4000-8000-000000000005', null, (select today from cur));
set local role authenticated;
select set_config('request.jwt.claim.sub', 'ce000000-0000-4000-8000-00000000000c', true);
insert into ov select 'g-billing-viewer', public.keepsakes_overview('ce100000-0000-4000-8000-000000000005');
set local role postgres;

select is((select doc from uf where label = 'g-rollout'), '[]'::jsonb, 'upcoming films are [] when the rollout excludes the family');
select is((select doc from uf where label = 'g-launch-null'), '[]'::jsonb, 'upcoming films are [] without a launch_date');
select isnt((select pg_temp.entry(doc, 'ce200000-0000-4000-8000-00000000000a') from uf where label = 'g-launch-edge'), null,
  'a film due exactly on launch_date is announced (year_film_due: due_date >= launch_date)');
select is((select pg_temp.entry(doc, 'ce200000-0000-4000-8000-00000000000a') from uf where label = 'g-launch-late'), null,
  'a film due before launch_date is never scheduled, so it is not announced (the later ones still are)');
select is((select jsonb_array_length(pg_temp.births(doc)) from uf where label = 'g-launch-late'), 3,
  'with launch_date the day after Ada''s film, only the films due after it remain (Kai, Jo, Cy)');
select is((select doc from uf where label = 'g-billing'), '[]'::jsonb, 'upcoming films are [] when billing does not allow films');
select is((select doc -> 'upcoming_films' from ov where label = 'g-billing-viewer'), '[]'::jsonb,
  'the RPC reports [] to a viewer too when billing lapses');

-- ---- Year-end family film (a family of its own) ----------------------------
-- Everything is in the CURRENT year Y: a pinned p_today in December of Y.
-- Scope Jan 1 -> Dec 28 (exclusive); film date Dec 30.
create temp table yr on commit drop as
select extract(year from today)::integer as y from cur;
insert into public.family_members (id, family_id, name, date_of_birth, relationship)
select 'ce200000-0000-4000-8000-000000000014', 'ce100000-0000-4000-8000-000000000006', 'Baby',
       (make_date(y, 1, 1) - interval '200 days')::date, 'child'
from yr;

-- Stage 1: Jan 10 text; Feb illustration (Q0); May illustration (Q1); Aug
-- illustration SAD (visual, covers no quarter); Dec 27 illustration (Q3, the
-- last in-scope day); Dec 28 illustration (the scope end: out). The family
-- pool does not care about tags: one is tagged to nobody, one to the child.
insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, illustration_key, emotion, memory_date)
select v.id::uuid, 'ce100000-0000-4000-8000-000000000006', 'ce000000-0000-4000-8000-00000000000f', v.content,
       case when v.ill then 'text_illustration' else 'text_only' end,
       case when v.ill then 'ready' else 'none' end,
       case when v.ill then 'yr-key/' || v.tag || '.png' end, v.emotion, make_date(yr.y, v.mo, v.d)
from yr,
(values
  ('ce3e0000-0000-4000-8000-000000000001', 'January', false, 'jan', null, 1, 10),
  ('ce3e0000-0000-4000-8000-000000000002', 'February', true, 'feb', null, 2, 1),
  ('ce3e0000-0000-4000-8000-000000000003', 'May', true, 'may', null, 5, 5),
  ('ce3e0000-0000-4000-8000-000000000004', 'August sad', true, 'aug', 'sad', 8, 8),
  ('ce3e0000-0000-4000-8000-000000000005', 'December 27', true, 'dec27', null, 12, 27),
  ('ce3e0000-0000-4000-8000-000000000006', 'December 28', true, 'dec28', null, 12, 28)
) as v(id, content, ill, tag, emotion, mo, d);
insert into public.memory_family_members (memory_id, family_member_id)
values ('ce3e0000-0000-4000-8000-000000000002', 'ce200000-0000-4000-8000-000000000014');

insert into uf select 'y-nov30', public.keepsake_upcoming_films('ce100000-0000-4000-8000-000000000006', null, (select make_date(y, 11, 30) from yr));
insert into uf select 'y-dec1', public.keepsake_upcoming_films('ce100000-0000-4000-8000-000000000006', 'ce000000-0000-4000-8000-00000000000f', (select make_date(y, 12, 1) from yr));
insert into uf select 'y-dec30', public.keepsake_upcoming_films('ce100000-0000-4000-8000-000000000006', null, (select make_date(y, 12, 30) from yr));
insert into uf select 'y-dec31', public.keepsake_upcoming_films('ce100000-0000-4000-8000-000000000006', null, (select make_date(y, 12, 31) from yr));

select is((select doc from uf where label = 'y-nov30'), '[]'::jsonb, 'no year-end tile before December');
select is((select doc from uf where label = 'y-dec31'), '[]'::jsonb, 'no year-end tile after the film date (Dec 30) has passed');
select isnt((select pg_temp.kinds(doc, 'family_year') from uf where label = 'y-dec30'), null, 'the year-end tile is there on Dec 30');
select is(
  (select row(e ->> 'kind', e -> 'member_id', e -> 'age_year', e ->> 'film_date', e ->> 'scope_start', e ->> 'scope_end_excl')::text
   from uf, pg_temp.kinds(doc, 'family_year') e where label = 'y-dec1'),
  (select row('family_year', 'null'::jsonb, 'null'::jsonb, make_date(y, 12, 30)::text, make_date(y, 1, 1)::text, make_date(y, 12, 28)::text)::text from yr),
  'from Dec 1: a family_year film, no member / age, surfacing Dec 30, scope Jan 1 -> Dec 28 (exclusive)');
select is(
  (select row(e -> 'moments', e -> 'visuals', e -> 'quarters', e -> 'min_moments', e -> 'min_visuals', e -> 'min_quarters', e ->> 'picture_key')::text
   from uf, pg_temp.kinds(doc, 'family_year') e where label = 'y-dec1'),
  '(5,4,3,60,40,3,yr-key/dec27.png)',
  'year pool: every pooled memory Jan 1..Dec 27 (Dec 28 is out), tagged or not; a SAD visual covers no quarter (Q0, Q1, Q3 here); floors 60 / 40 / 3; the picture is the newest');

insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, illustration_key, emotion, memory_date)
select 'ce3e0000-0000-4000-8000-000000000007', 'ce100000-0000-4000-8000-000000000006', 'ce000000-0000-4000-8000-00000000000f',
       'September weary', 'text_illustration', 'ready', 'yr-key/sep.png', 'weary', make_date(y, 9, 9) from yr;
insert into uf select 'y-weary', public.keepsake_upcoming_films('ce100000-0000-4000-8000-000000000006', null, (select make_date(y, 12, 1) from yr));
select is(
  (select row(e -> 'moments', e -> 'visuals', e -> 'quarters')::text from uf, pg_temp.kinds(doc, 'family_year') e where label = 'y-weary'),
  '(6,5,4)', 'a weary visual covers its quarter: all four quarters');

-- Film rows of the year-end film (family_member_id null, scope Jan 1).
insert into public.year_films (id, family_id, kind, scope_start_date, scope_end_exclusive, surface_at, status)
select 'ce530000-0000-4000-8000-000000000003', 'ce100000-0000-4000-8000-000000000006', 'family_year',
       make_date(y, 1, 1), make_date(y, 12, 28), now() + interval '1 day', 'queued' from yr;
insert into uf select 'y-queued', public.keepsake_upcoming_films('ce100000-0000-4000-8000-000000000006', null, (select make_date(y, 12, 1) from yr));
update public.year_films set status = 'skipped' where id = 'ce530000-0000-4000-8000-000000000003';
insert into uf select 'y-skipped', public.keepsake_upcoming_films('ce100000-0000-4000-8000-000000000006', null, (select make_date(y, 12, 1) from yr));
update public.year_films set status = 'ready', scope_start_date = make_date((select y from yr) - 1, 1, 1),
       scope_end_exclusive = make_date((select y from yr) - 1, 12, 28)
where id = 'ce530000-0000-4000-8000-000000000003';
insert into uf select 'y-lastyear', public.keepsake_upcoming_films('ce100000-0000-4000-8000-000000000006', null, (select make_date(y, 12, 1) from yr));
select is((select pg_temp.kinds(doc, 'family_year') from uf where label = 'y-queued'), null, 'a queued year-end film row takes the tile away');
select isnt((select pg_temp.kinds(doc, 'family_year') from uf where label = 'y-skipped'), null, 'a skipped year-end film row keeps the tile');
select isnt((select pg_temp.kinds(doc, 'family_year') from uf where label = 'y-lastyear'), null, 'last year''s film row does not take this year''s tile');
delete from public.year_films where id = 'ce530000-0000-4000-8000-000000000003';

-- Year-end gates: launch after Dec 28, and an own child under 13 on Dec 28.
update public.year_film_settings set launch_date = (select make_date(y, 12, 29) from yr);
insert into uf select 'y-launch', public.keepsake_upcoming_films('ce100000-0000-4000-8000-000000000006', null, (select make_date(y, 12, 1) from yr));
update public.year_film_settings set launch_date = date '2020-01-01';
update public.family_members set date_of_birth = (select make_date(y - 14, 6, 1) from yr) where id = 'ce200000-0000-4000-8000-000000000014';
insert into uf select 'y-teen', public.keepsake_upcoming_films('ce100000-0000-4000-8000-000000000006', null, (select make_date(y, 12, 1) from yr));
update public.family_members set date_of_birth = null where id = 'ce200000-0000-4000-8000-000000000014';
insert into uf select 'y-nodob', public.keepsake_upcoming_films('ce100000-0000-4000-8000-000000000006', null, (select make_date(y, 12, 1) from yr));
select is((select doc from uf where label = 'y-launch'), '[]'::jsonb, 'no year-end tile when its due date (Dec 28) is before launch_date');
select is((select doc from uf where label = 'y-teen'), '[]'::jsonb, 'no year-end tile when the only child is over 12 on Dec 28');
select is((select doc from uf where label = 'y-nodob'), '[]'::jsonb, 'no year-end tile without an own child that has a date of birth');

select * from finish();
rollback;
