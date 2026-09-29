begin;

-- Year Film P1 (docs/plans/year-film-p1.md Step 1). Scheduling (timezones,
-- catch-up, launch cutoff, own-child + under-13 rules, billing, rollout,
-- idempotency, forced rows), dispatch/heartbeat/curation/render slot/publish
-- CAS, invalidation triggers (incl. delete during an attempt and the
-- delete+reinsert media save), cycle-end rules, edits RPC, client access,
-- notifications, recovery, the deletion fence and ledger operations.
select plan(73);

-- ---------------------------------------------------------------------------
-- Fixtures (postgres role; assertions switch to authenticated where needed)
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, is_anonymous) values
  ('f8000000-0000-4000-8000-000000000001', 'yf-owner@example.test', false),
  ('f8000000-0000-4000-8000-000000000002', 'yf-manager@example.test', false),
  ('f8000000-0000-4000-8000-000000000003', 'yf-viewer@example.test', false),
  ('f8000000-0000-4000-8000-000000000004', 'yf-lapsed@example.test', false);

update public.user_profiles set timezone = 'America/New_York'
where id in ('f8000000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000004');

insert into public.families (id, name, owner_id) values
  ('f8100000-0000-4000-8000-000000000001', 'Film family', 'f8000000-0000-4000-8000-000000000001'),
  ('f8100000-0000-4000-8000-000000000002', 'Lapsed film family', 'f8000000-0000-4000-8000-000000000004');

insert into public.family_memberships (family_id, user_id, role) values
  ('f8100000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000001', 'owner'),
  ('f8100000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000002', 'manager'),
  ('f8100000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000003', 'viewer'),
  ('f8100000-0000-4000-8000-000000000002', 'f8000000-0000-4000-8000-000000000004', 'owner');

insert into public.owner_entitlements (
  owner_user_id, app_user_id, environment, store, product_id, entitlement_id,
  period_type, status, expires_at, will_renew
) values (
  'f8000000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000001',
  'production', 'app_store', 'momora_annual_v1', 'momora_plus', 'annual', 'active',
  transaction_timestamp() + interval '400 days', true
);

insert into public.family_members (id, family_id, name, date_of_birth, relationship) values
  ('f8200000-0000-4000-8000-000000000001', 'f8100000-0000-4000-8000-000000000001', 'Enzo', '2022-10-23', 'child'),
  ('f8200000-0000-4000-8000-000000000002', 'f8100000-0000-4000-8000-000000000001', 'Elena', '2020-10-22', 'cousin'),
  ('f8200000-0000-4000-8000-000000000003', 'f8100000-0000-4000-8000-000000000001', 'Baby', '2025-03-10', null),
  ('f8200000-0000-4000-8000-000000000004', 'f8100000-0000-4000-8000-000000000001', 'Teen', '2012-10-23', 'child'),
  ('f8200000-0000-4000-8000-000000000005', 'f8100000-0000-4000-8000-000000000001', 'Eduardo', '1985-01-01', 'parent'),
  ('f8200000-0000-4000-8000-000000000101', 'f8100000-0000-4000-8000-000000000002', 'Lapsed kid', '2022-10-23', 'child');

-- 12 September memories (monthly floor) and 3 August ones (below it).
insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, memory_date)
select ('f8300000-0000-4000-8000-0000000000' || lpad(g::text, 2, '0'))::uuid,
       'f8100000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000001',
       'September moment ' || g, 'text_only', 'none', date '2026-09-01' + g
from generate_series(1, 12) g;
insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, memory_date)
select ('f8300000-0000-4000-8000-0000000001' || lpad(g::text, 2, '0'))::uuid,
       'f8100000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000001',
       'August moment ' || g, 'text_only', 'none', date '2026-08-01' + g
from generate_series(1, 3) g;
insert into public.memory_media (memory_id, object_key, content_type, position)
values ('f8300000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000001/memories/a/photo.jpg', 'image/jpeg', 0);

update public.year_film_settings
set mode = 'canary',
    canary_family_ids = array['f8100000-0000-4000-8000-000000000001', 'f8100000-0000-4000-8000-000000000002']::uuid[],
    launch_date = date '2026-01-01',
    max_concurrent_renders = 1;

-- ---------------------------------------------------------------------------
-- 1. Scheduling
-- ---------------------------------------------------------------------------

-- Enzo turns 4 on Oct 23 → due Oct 26 00:30 New York (04:30 UTC).
select is(public.year_film_due('2026-10-26 04:20:00+00'), 0, 'birthday: nothing before 00:30 owner-local');
select is(public.year_film_due('2026-10-26 04:40:00+00'), 1, 'birthday: due at 00:30 owner-local (only the own child)');

select results_eq(
  $$select kind, family_member_id, age_year, scope_start_date, scope_end_exclusive, surface_at
    from public.year_films where family_id = 'f8100000-0000-4000-8000-000000000001' and kind = 'birthday'$$,
  $$values ('birthday'::text, 'f8200000-0000-4000-8000-000000000001'::uuid, 4, date '2025-10-23', date '2026-10-26',
            timestamptz '2026-10-26 13:00:00+00')$$,
  'birthday: scope = age-year + 2 days after, surfaces 09:00 local'
);
select ok(not exists (select 1 from public.year_films where family_member_id = 'f8200000-0000-4000-8000-000000000002'),
  'a niece marked cousin never gets a birthday film');
select ok(not exists (select 1 from public.year_films where family_member_id = 'f8200000-0000-4000-8000-000000000004'),
  'an explicit child turning 14 gets no film (under-13 ceiling)');
select ok(not exists (select 1 from public.year_films where family_id = 'f8100000-0000-4000-8000-000000000002'),
  'a billing-blocked family gets nothing');
select is(public.year_film_due('2026-10-27 04:40:00+00'), 0, 'idempotent: a second run inside the window inserts nothing');

-- Baby (unsorted, 2025-03-10): first birthday due 2026-03-13; a run a week later is outside the catch-up window.
select is(public.year_film_due('2026-03-20 12:00:00+00'), 0, 'catch-up window is 3 days');
select is(public.year_film_due('2026-03-14 12:00:00+00'), 1, 'inside the catch-up window: an unsorted under-13 kid counts');

update public.year_film_settings set launch_date = date '2027-01-01';
select is(public.year_film_due('2026-10-26 05:00:00+00') + public.year_film_due('2026-10-01 05:00:00+00'), 0,
  'nothing is scheduled before launch_date (no backfill)');
update public.year_film_settings set launch_date = date '2026-01-01';

-- Monthly: Oct 1 (September ≥ 10 memories) yes; Sep 1 (August 3 memories) no.
select is(public.year_film_due('2026-09-01 05:00:00+00'), 0, 'monthly: SQL pre-filter drops a thin month');
select is(public.year_film_due('2026-10-01 05:00:00+00'), 1, 'monthly: due on the 1st');
select results_eq(
  $$select scope_start_date, scope_end_exclusive, surface_at from public.year_films where kind = 'family_month'$$,
  $$values (date '2026-09-01', date '2026-10-01', timestamptz '2026-10-01 23:00:00+00')$$,
  'monthly: previous month, surfaces 19:00 local'
);

-- A forced canary family film must not take the real Dec 12 slot.
select isnt(
  public.queue_year_film_forced('f8100000-0000-4000-8000-000000000001', 'family_year', null, null,
    date '2026-01-01', date '2026-09-29', '2026-09-29 12:00:00+00'),
  null, 'operator can queue a forced film'
);
select is(public.year_film_due('2026-12-12 06:00:00+00'), 1, 'family film is still scheduled next to a forced one');
select results_eq(
  $$select scope_start_date, scope_end_exclusive, surface_at from public.year_films where kind = 'family_year' and not forced$$,
  $$values (date '2026-01-01', date '2026-12-12', timestamptz '2026-12-15 14:00:00+00')$$,
  'family film: Jan 1 – Dec 11, surfaces Dec 15 09:00 local (EST)'
);

update public.year_film_settings set mode = 'off';
delete from public.year_films where kind = 'family_month';
select is(public.year_film_due('2026-10-01 05:00:00+00'), 0, 'mode off schedules nothing');
update public.year_film_settings set mode = 'canary';

-- ---------------------------------------------------------------------------
-- 2. Dispatch, heartbeat, curation, render slot, publish
-- ---------------------------------------------------------------------------

create temp table film_ids on commit drop as
select id, kind from public.year_films where family_id = 'f8100000-0000-4000-8000-000000000001';

delete from public.year_films where kind in ('family_year') and forced;
create temp table claimed on commit drop as
select * from public.claim_year_film_dispatch(10, now());

select is((select count(*)::int from claimed), 3, 'dispatch claims every queued film of enabled families');
select ok((select bool_and(status = 'curating' and attempt_count = 1 and attempt_id is not null)
           from public.year_films where id in (select film_id from claimed)),
  'claimed films are curating with a fresh attempt');

create temp table enzo on commit drop as
select y.id, y.attempt_id from public.year_films y where y.kind = 'birthday' and y.age_year = 4;
grant select on enzo to authenticated;

select is(public.year_film_heartbeat((select id from enzo), (select attempt_id from enzo), null), 'ok', 'heartbeat ok');
select is(public.year_film_heartbeat((select id from enzo), gen_random_uuid(), null), 'superseded', 'a stale attempt is superseded');
select is(public.year_film_heartbeat((select id from enzo), (select attempt_id from enzo), 7), 'epoch_changed', 'epoch mismatch is reported');
update public.year_film_settings set mode = 'off';
select is(public.year_film_heartbeat((select id from enzo), (select attempt_id from enzo), null), 'disabled', 'mode off stops in-flight work');
update public.year_film_settings set mode = 'canary';

select is(
  public.year_film_save_curation((select id from enzo), (select attempt_id from enzo), jsonb_build_object('epoch', 3)),
  'epoch_changed', 'curation against an older epoch is refused'
);
select is(
  public.year_film_save_curation((select id from enzo), (select attempt_id from enzo), jsonb_build_object(
    'epoch', 0, 'language', 'es', 'scope_label', 'Año Cuatro', 'music_bed_id', 'bright-pop',
    'quote_candidates', jsonb_build_array(jsonb_build_object('memoryId', 'f8300000-0000-4000-8000-000000000002', 'textHash', 'h', 'quote', 'q')),
    'film_script', jsonb_build_object('version', 1),
    'referenced_memory_ids', jsonb_build_array('f8300000-0000-4000-8000-000000000001', 'f8300000-0000-4000-8000-000000000002'),
    'referenced_asset_keys', jsonb_build_array('f8000000-0000-4000-8000-000000000001/memories/a/photo.jpg'),
    'referenced_member_ids', jsonb_build_array('f8200000-0000-4000-8000-000000000001'),
    'quoted_memory_text_hashes', jsonb_build_object('f8300000-0000-4000-8000-000000000002',
      public.year_film_text_hash('September moment 2', null, null))
  )),
  'ok', 'curation is saved'
);
select is((select language from public.year_films where id = (select id from enzo)), 'es', 'language is stored');
select is(public.year_film_set_status((select id from enzo), (select attempt_id from enzo), 'preparing'), 'ok', 'curating → preparing');
select is(public.year_film_claim_render_slot((select id from enzo), (select attempt_id from enzo)), 'ok', 'first render slot granted');

-- Another film reaches the render stage while the only slot is taken.
create temp table monthly on commit drop as
select id, attempt_id from public.year_films where kind = 'birthday' and age_year = 1;
update public.year_films set status = 'preparing' where id = (select id from monthly);
select is(public.year_film_claim_render_slot((select id from monthly), (select attempt_id from monthly)), 'full', 'render slots are capped');

select is(
  public.publish_year_film((select id from enzo), (select attempt_id from enzo), 1, 'o/v.mp4', 'o/p.jpg', 'o/s.json', 60000) ->> 'reason',
  'edits_changed', 'publish rejects a stale edits_version'
);
select is(
  (public.publish_year_film((select id from enzo), (select attempt_id from enzo), 0,
     'f8000000-0000-4000-8000-000000000001/year-films/x/a1/film.mp4', 'f8000000-0000-4000-8000-000000000001/year-films/x/a1/poster.jpg',
     'f8000000-0000-4000-8000-000000000001/year-films/x/a1/scenes.json', 60000)) ->> 'ok',
  'true', 'publish succeeds'
);
select ok((select status = 'ready' and not blocked and not stale and attempt_id is null and cleanup_needed
           from public.year_films where id = (select id from enzo)), 'published film is ready');

-- ---------------------------------------------------------------------------
-- 3. Client access
-- ---------------------------------------------------------------------------

update public.year_films set surface_at = now() - interval '1 hour' where id = (select id from enzo);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'f8000000-0000-4000-8000-000000000003', true);
select is((select count(*)::int from public.year_films where id = (select id from enzo)), 1, 'a viewer sees a surfaced, ready film');
select throws_ok($$select film_script from public.year_films$$, '42501', null, 'clients cannot read film_script');
select throws_ok($$select video_key from public.year_films$$, '42501', null, 'clients cannot read storage keys');
select throws_ok($$update public.year_films set status = 'ready'$$, '42501', null, 'clients cannot write films');
select lives_ok(
  format($$insert into public.year_film_views (film_id, user_id) values (%L, 'f8000000-0000-4000-8000-000000000003')$$, (select id from enzo)),
  'a member records their own view'
);
select throws_ok(
  $$select public.save_year_film_edits((select id from enzo), '{"musicBedId":"sparkle-pop"}')$$,
  '42501', null, 'a viewer cannot edit'
);
set local role postgres;

update public.year_films set surface_at = now() + interval '2 days' where id = (select id from enzo);
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f8000000-0000-4000-8000-000000000003', true);
select is((select count(*)::int from public.year_films where id = (select id from enzo)), 0, 'no peeking before surface_at');
select set_config('request.jwt.claim.sub', 'f8000000-0000-4000-8000-000000000002', true);
select is((select count(*)::int from public.year_films where id = (select id from enzo)), 1, 'managers may preview early');

-- ---------------------------------------------------------------------------
-- 4. Edits
-- ---------------------------------------------------------------------------

select throws_ok(
  $$select public.save_year_film_edits((select id from enzo), '{"musicBedId":"polka"}')$$,
  '22023', null, 'unknown music bed rejected'
);
select throws_ok(
  $$select public.save_year_film_edits((select id from enzo), '{"removedMemoryIds":["f8300000-0000-4000-8000-000000000009"]}')$$,
  '22023', null, 'removing a memory the film does not use is rejected'
);
select is(
  public.save_year_film_edits((select id from enzo), '{"removedMemoryIds":["f8300000-0000-4000-8000-000000000001"]}') ->> 'ok',
  'true', 'a manager removes a memory'
);
set local role postgres;
select ok((select status = 'queued' and blocked and stale and edits_version = 1
           from public.year_films where id = (select id from enzo)),
  'removing content re-queues the film and blocks the old video until it re-renders');

insert into public.year_film_render_requests (film_id, family_id, requested_by)
select (select id from enzo), 'f8100000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000002'
from generate_series(1, 4);
update public.year_films set status = 'ready' where id = (select id from enzo);
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f8000000-0000-4000-8000-000000000002', true);
select is(public.save_year_film_edits((select id from enzo), '{"musicBedId":"sparkle-pop"}') ->> 'reason',
  'rate_limited', 'fair use: 5 edit renders per film per day');
set local role postgres;

-- ---------------------------------------------------------------------------
-- 5. Invalidation
-- ---------------------------------------------------------------------------

-- Reset Enzo's film to a clean ready state.
update public.year_films
set status = 'ready', blocked = false, stale = false, requeue_after = null
where id = (select id from enzo);

-- A media save deletes and re-inserts unchanged rows: no invalidation.
delete from public.memory_media where memory_id = 'f8300000-0000-4000-8000-000000000001';
insert into public.memory_media (memory_id, object_key, content_type, position)
values ('f8300000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000001/memories/a/photo.jpg', 'image/jpeg', 0);
set constraints public.year_films_on_memory_media_deleted immediate;
select ok((select not blocked and requeue_after is null from public.year_films where id = (select id from enzo)),
  'delete + re-insert of the same media key does not invalidate');
set constraints public.year_films_on_memory_media_deleted deferred;

-- The key really goes away.
delete from public.memory_media where memory_id = 'f8300000-0000-4000-8000-000000000001';
set constraints public.year_films_on_memory_media_deleted immediate;
select ok((select blocked and stale and requeue_after is not null from public.year_films where id = (select id from enzo)),
  'removing a referenced media key blocks the film');
set constraints public.year_films_on_memory_media_deleted deferred;

update public.year_films
set blocked = false, stale = false, requeue_after = null
where id = (select id from enzo);

-- Editing a quoted memory's text blocks the film.
update public.memories set content = 'September moment 2 (edited)' where id = 'f8300000-0000-4000-8000-000000000002';
select ok((select blocked from public.year_films where id = (select id from enzo)), 'editing quoted text blocks the film');
update public.year_films set blocked = false, stale = false, requeue_after = null where id = (select id from enzo);

-- Editing an unquoted memory does nothing.
update public.memories set content = 'September moment 5 (edited)' where id = 'f8300000-0000-4000-8000-000000000005';
select ok((select not blocked from public.year_films where id = (select id from enzo)), 'editing an unquoted memory does not');

-- A report on a referenced member's profile blocks the film.
insert into public.content_reports (family_id, reporter_user_id, target_type, target_id, reason)
values ('f8100000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000003', 'family_member_profile',
        'f8200000-0000-4000-8000-000000000001', 'other');
select ok((select blocked from public.year_films where id = (select id from enzo)), 'a profile report blocks the film');
update public.year_films set blocked = false, stale = false, requeue_after = null where id = (select id from enzo);
delete from public.content_reports where target_id = 'f8200000-0000-4000-8000-000000000001';

-- The owner deletes a referenced memory through the client path.
select is((select content_epoch from public.year_films where id = (select id from enzo)) >= 1, true, 'epoch has moved with each invalidation');
create temp table epoch_before on commit drop as select content_epoch as e from public.year_films where id = (select id from enzo);
grant select on epoch_before to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f8000000-0000-4000-8000-000000000001', true);
select lives_ok($$delete from public.memories where id = 'f8300000-0000-4000-8000-000000000001'$$,
  'a client memory delete still succeeds with the film trigger');
set local role postgres;
select ok((select blocked and stale and content_epoch = (select e from epoch_before) + 1
           from public.year_films where id = (select id from enzo)),
  'deleting a referenced memory blocks the film and bumps its epoch');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f8000000-0000-4000-8000-000000000003', true);
select is((select count(*)::int from public.year_films where id = (select id from enzo)), 0, 'a blocked film is invisible to members');
set local role postgres;

-- Delete during an attempt: the publish CAS refuses and the film starts over.
update public.year_films
set status = 'rendering', attempt_id = 'f8900000-0000-4000-8000-000000000001', curated_epoch = content_epoch,
    blocked = false, requeue_after = null,
    referenced_memory_ids = array['f8300000-0000-4000-8000-000000000003']::uuid[],
    quoted_memory_text_hashes = '{}'::jsonb, referenced_asset_keys = '{}', referenced_member_ids = '{}'
where id = (select id from enzo);
delete from public.memories where id = 'f8300000-0000-4000-8000-000000000003';
select is(
  public.publish_year_film((select id from enzo), 'f8900000-0000-4000-8000-000000000001', 1,
    'o/n.mp4', 'o/n.jpg', 'o/n.json', 1000) ->> 'reason',
  'content_changed', 'a memory deleted mid-render never publishes'
);
select ok((select status = 'queued' and blocked and attempt_id is null
           from public.year_films where id = (select id from enzo)),
  'the film starts a fresh cycle with its old video blocked (deleted when replaced or when the cycle gives up)');

-- ---------------------------------------------------------------------------
-- 6. End of cycle, recovery
-- ---------------------------------------------------------------------------

create temp table fy on commit drop as
select id from public.year_films where kind = 'family_year' and not forced;
update public.year_films
set status = 'curating', attempt_id = 'f8900000-0000-4000-8000-000000000002', attempt_count = 1, requeue_after = null
where id = (select id from fy);
select is(
  public.year_film_end_cycle((select id from fy), 'f8900000-0000-4000-8000-000000000002', 'failed', 'RENDER_FAILED') ->> 'status',
  'queued', 'a first failure retries later'
);
select ok((select next_attempt_at > now() + interval '50 minutes' from public.year_films where id = (select id from fy)),
  'retries are spaced (≥1h)');

update public.year_films
set status = 'rendering', attempt_id = 'f8900000-0000-4000-8000-000000000003', attempt_count = 3,
    video_key = 'o/old.mp4', poster_key = 'o/old.jpg', blocked = false
where id = (select id from fy);
select is(
  public.year_film_end_cycle((select id from fy), 'f8900000-0000-4000-8000-000000000003', 'failed', 'RENDER_FAILED') ->> 'status',
  'ready', 'a failed re-render keeps the good film serving'
);

update public.year_films
set status = 'rendering', attempt_id = 'f8900000-0000-4000-8000-000000000004', attempt_count = 3, blocked = true
where id = (select id from fy);
select is(
  public.year_film_end_cycle((select id from fy), 'f8900000-0000-4000-8000-000000000004', 'failed', 'RENDER_FAILED') -> 'delete_keys',
  '["o/old.mp4", "o/old.jpg"]'::jsonb, 'a blocked film that fails deletes its old video'
);
select ok((select status = 'failed' and video_key is null from public.year_films where id = (select id from fy)),
  'and ends failed');
select is(public.year_film_due('2026-12-13 06:00:00+00'), 0, 'a failed film is never re-inserted by the scheduler');

update public.year_films
set status = 'preparing', attempt_id = 'f8900000-0000-4000-8000-000000000005', attempt_count = 1,
    heartbeat_at = now() - interval '30 minutes'
where id = (select id from fy);
select is(public.year_film_recover(now()) ->> 'retried', '1', 'a lost heartbeat is retried');

-- ---------------------------------------------------------------------------
-- 7. Notifications, fence, ledger, hash
-- ---------------------------------------------------------------------------

update public.year_films
set status = 'ready', blocked = false, video_key = 'o/a.mp4', poster_key = 'o/a.jpg',
    surface_at = now() - interval '1 hour', notified_at = null
where id = (select id from fy);
select is((select count(*)::int from public.year_film_notifications_due(now()) where film_id = (select id from fy)), 1,
  'a surfaced film is announced');
select is((select count(*)::int from public.year_film_notifications_due(now()) where film_id = (select id from fy)), 0,
  'only once');

update public.year_films set status = 'rendering', heartbeat_at = now() where id = (select id from fy);
select throws_ok(
  $$select public.claim_family_deletion_fence('f8100000-0000-4000-8000-000000000001', gen_random_uuid())$$,
  '55000', 'Fresh year film generation is still active', 'family deletion waits for an in-flight film'
);

select lives_ok(
  $$insert into public.ai_usage_events (ai_call_id, attribution_scope, family_id, actor_user_id, operation, model, success)
    values ('yf-test-call', 'family', 'f8100000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000001',
            'year_film_vision', 'gpt-6-luna', true)$$,
  'the ledger accepts year_film_* operations'
);

select is(public.year_film_text_hash('Hola', null, 'desc'),
  'ce3e78aedcf937fb1e8a454c7e65c09bff23dbcd5abfe7ce58e3ece86d12008d',
  'text hash is stable (Deno twin uses the same fixture)');


-- ---------------------------------------------------------------------------
-- 8. Parent blocks (owner decision 2026-09-29)
-- ---------------------------------------------------------------------------

insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, memory_date)
values ('f8300000-0000-4000-8000-000000000301', 'f8100000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000003',
        'A viewer memory', 'text_only', 'none', '2026-09-20');
insert into public.year_films (id, family_id, kind, forced, scope_start_date, scope_end_exclusive, surface_at, status,
                               video_key, poster_key, referenced_memory_ids)
values ('f8400000-0000-4000-8000-000000000001', 'f8100000-0000-4000-8000-000000000001', 'family_month', true,
        '2026-09-01', '2026-10-01', now() - interval '1 day', 'ready', 'o/b.mp4', 'o/b.jpg',
        array['f8300000-0000-4000-8000-000000000301']::uuid[]);

-- A viewer blocking a manager is personal: films don't change.
insert into public.blocked_family_accounts (family_id, blocker_user_id, blocked_user_id)
values ('f8100000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000003', 'f8000000-0000-4000-8000-000000000002');
select ok((select not blocked from public.year_films where id = 'f8400000-0000-4000-8000-000000000001'),
  'a viewer block does not touch family films');
select is(public.year_film_parent_blocked_users('f8100000-0000-4000-8000-000000000001'), '{}'::uuid[],
  'viewer blocks are not parent blocks');

-- The owner blocks the viewer who wrote a memory in the film.
insert into public.blocked_family_accounts (family_id, blocker_user_id, blocked_user_id)
values ('f8100000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000003');
select is(public.year_film_parent_blocked_users('f8100000-0000-4000-8000-000000000001'),
  array['f8000000-0000-4000-8000-000000000003']::uuid[], 'an owner block is a parent block');
select ok((select blocked and stale and requeue_after is not null from public.year_films where id = 'f8400000-0000-4000-8000-000000000001'),
  'a parent block blocks films showing that account''s memories');

-- Publish never lets a blocked author's memory through.
update public.year_films
set status = 'rendering', attempt_id = 'f8900000-0000-4000-8000-000000000301', curated_epoch = content_epoch,
    blocked = false, requeue_after = null
where id = 'f8400000-0000-4000-8000-000000000001';
select is(
  public.publish_year_film('f8400000-0000-4000-8000-000000000001', 'f8900000-0000-4000-8000-000000000301', 0,
    'o/c.mp4', 'o/c.jpg', 'o/c.json', 1000) ->> 'reason',
  'content_changed', 'publish refuses a film with a parent-blocked author'
);

select * from finish();
rollback;
