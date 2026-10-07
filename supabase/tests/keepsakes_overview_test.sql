begin;

-- Keepsakes tab overview (20261009120000_keepsakes_overview.sql,
-- docs/plans/keepsakes-redesign.md A1): public.keepsakes_overview and the
-- internal pool helper public.keepsake_pool. FICTIONAL data only (public
-- repo). DATE-INDEPENDENT: every memory is placed relative to the owner-local
-- current month / year (the owner's timezone is far from UTC on purpose), and
-- the holiday fixtures live in a family of their own so they never overlap
-- the month fixtures.
select plan(72);

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

select * from finish();
rollback;
