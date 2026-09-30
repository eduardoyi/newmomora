begin;

-- Year Film P1 (docs/plans/year-film-p1.md Step 1). Scheduling (timezones,
-- catch-up, launch cutoff, own-child + under-13 rules, billing, rollout,
-- idempotency, forced rows), dispatch/heartbeat/curation/render slot/publish
-- CAS, invalidation triggers (incl. delete during an attempt and the
-- delete+reinsert media save), cycle-end rules, edits RPC, client access,
-- notifications, recovery, the deletion fence and ledger operations; P2 dates,
-- backfill and the edit sheet's get_year_film_edit_options (section 12).
select plan(156);

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

-- Enzo turns 4 on Oct 23 → due Oct 25 (birthday + 2) 00:30 New York (04:30 UTC).
select is(public.year_film_due('2026-10-25 04:20:00+00'), 0, 'birthday: nothing before 00:30 owner-local');
select is(public.year_film_due('2026-10-25 04:40:00+00'), 1, 'birthday: due at 00:30 owner-local (only the own child)');

select results_eq(
  $$select kind, family_member_id, age_year, scope_start_date, scope_end_exclusive, surface_at
    from public.year_films where family_id = 'f8100000-0000-4000-8000-000000000001' and kind = 'birthday'$$,
  $$values ('birthday'::text, 'f8200000-0000-4000-8000-000000000001'::uuid, 4, date '2025-10-23', date '2026-10-25',
            timestamptz '2026-10-25 13:00:00+00')$$,
  'birthday: due birthday + 2 (scope ends the day after the birthday), surfaces 09:00 local'
);
select ok(not exists (select 1 from public.year_films where family_member_id = 'f8200000-0000-4000-8000-000000000002'),
  'a niece marked cousin never gets a birthday film');
select ok(not exists (select 1 from public.year_films where family_member_id = 'f8200000-0000-4000-8000-000000000004'),
  'an explicit child turning 14 gets no film (under-13 ceiling)');
select ok(not exists (select 1 from public.year_films where family_id = 'f8100000-0000-4000-8000-000000000002'),
  'a billing-blocked family gets nothing');
select is(public.year_film_due('2026-10-26 04:40:00+00'), 0, 'idempotent: a second run inside the window inserts nothing');

-- Baby (unsorted, 2025-03-10): first birthday due 2026-03-12; a run a week later is outside the catch-up window.
select is(public.year_film_due('2026-03-20 12:00:00+00'), 0, 'catch-up window is 3 days');
select is(public.year_film_due('2026-03-14 12:00:00+00'), 1, 'inside the catch-up window: an unsorted under-13 kid counts');

update public.year_film_settings set launch_date = date '2027-01-01';
select is(public.year_film_due('2026-10-25 05:00:00+00') + public.year_film_due('2026-10-01 05:00:00+00'), 0,
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

-- A forced canary family film must not take the real Dec 28 slot.
select isnt(
  public.queue_year_film_forced('f8100000-0000-4000-8000-000000000001', 'family_year', null, null,
    date '2026-01-01', date '2026-09-29', '2026-09-29 12:00:00+00'),
  null, 'operator can queue a forced film'
);
select is(public.year_film_due('2026-12-28 04:40:00+00'), 0, 'family film: nothing before 00:30 owner-local on Dec 28');
select is(public.year_film_due('2026-12-28 06:00:00+00'), 1, 'family film is still scheduled next to a forced one');
select results_eq(
  $$select scope_start_date, scope_end_exclusive, surface_at from public.year_films where kind = 'family_year' and not forced$$,
  $$values (date '2026-01-01', date '2026-12-28', timestamptz '2026-12-30 14:00:00+00')$$,
  'family film: Jan 1 – Dec 27, surfaces Dec 30 09:00 local (EST)'
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
  '["o/old.mp4", "o/old.jpg", "o/poster_thumb.jpg"]'::jsonb, 'a blocked film that fails deletes its old video and its poster thumb'
);
select ok((select status = 'failed' and video_key is null from public.year_films where id = (select id from fy)),
  'and ends failed');
select is(public.year_film_due('2026-12-29 06:00:00+00'), 0, 'a failed film is never re-inserted by the scheduler');

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

-- ===========================================================================
-- P2 (docs/plans/year-film-p2.md Step 1): placement_date, forced films are
-- operator-only, film_ready on notification, poster thumb delete keys,
-- year_films_enabled, candidate-row parity with year_film_due, and the silent
-- history backfill.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 9. placement_date, forced films, notification event, thumb keys
-- ---------------------------------------------------------------------------

select is((select placement_date from public.year_films where id = (select id from enzo)), date '2026-10-23',
  'placement_date: a birthday film sits on the birthday (scope_end_exclusive - 2)');
select ok(not exists (
    select 1 from public.year_films y
    join public.family_members m on m.id = y.family_member_id
    where y.kind = 'birthday'
      and y.placement_date is distinct from (m.date_of_birth + make_interval(years => y.age_year))::date
  ),
  'placement_date: every birthday film sits on the actual birthday (coupled to BIRTHDAY_FILM_DAYS_AFTER = 1)');
select is((select placement_date from public.year_films where id = (select id from fy)), date '2026-12-31',
  'placement_date: the year-end film sits on Dec 31');

insert into public.year_films (id, family_id, kind, forced, scope_start_date, scope_end_exclusive, surface_at, status,
                               video_key, poster_key, scenes_key)
values
  ('f8400000-0000-4000-8000-000000000002', 'f8100000-0000-4000-8000-000000000001', 'family_month', true,
   '2025-05-01', '2025-06-01', now() - interval '1 hour', 'ready', 'o/f2.mp4', 'o/f2.jpg', 'o/f2.json'),
  ('f8400000-0000-4000-8000-000000000003', 'f8100000-0000-4000-8000-000000000001', 'family_month', false,
   '2025-06-01', '2025-07-01', now() - interval '1 hour', 'ready', 'o/f3.mp4', 'o/f3.jpg', 'o/f3.json');
select is((select placement_date from public.year_films where id = 'f8400000-0000-4000-8000-000000000003'), date '2025-06-30',
  'placement_date: a monthly recap sits on the last day of its month');
select ok(has_column_privilege('authenticated', 'public.year_films', 'placement_date', 'SELECT'),
  'placement_date is granted to clients');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'f8000000-0000-4000-8000-000000000003', true);
select is((select count(*)::int from public.year_films where id = 'f8400000-0000-4000-8000-000000000003'), 1,
  'a viewer sees a surfaced, non-forced film');
select is((select placement_date from public.year_films where id = 'f8400000-0000-4000-8000-000000000003'), date '2025-06-30',
  'a client can read placement_date');
select is((select count(*)::int from public.year_films where id = 'f8400000-0000-4000-8000-000000000002'), 0,
  'a forced film is invisible to a viewer');
select set_config('request.jwt.claim.sub', 'f8000000-0000-4000-8000-000000000002', true);
select is((select count(*)::int from public.year_films where id = 'f8400000-0000-4000-8000-000000000002'), 0,
  'a forced film is invisible to a manager');
select set_config('request.jwt.claim.sub', 'f8000000-0000-4000-8000-000000000001', true);
select is((select count(*)::int from public.year_films where id = 'f8400000-0000-4000-8000-000000000002'), 0,
  'a forced film is invisible to the owner');
set local role postgres;

-- Notification: the returned row and exactly one film_ready event per film.
create temp table nd on commit drop as
select * from public.year_film_notifications_due(now());
select is((select count(*)::int from nd where film_id = 'f8400000-0000-4000-8000-000000000003'), 1,
  'notifications_due returns the surfaced film');
select results_eq(
  $$select kind, family_member_id, age_year, scope_start_date, family_id from nd where film_id = 'f8400000-0000-4000-8000-000000000003'$$,
  $$values ('family_month'::text, null::uuid, null::integer, date '2025-06-01', 'f8100000-0000-4000-8000-000000000001'::uuid)$$,
  'notifications_due keeps its returned columns'
);
select is((select count(*)::int from nd where film_id = 'f8400000-0000-4000-8000-000000000002'), 0,
  'a forced film is never announced');
select is((select count(*)::int from public.family_activity_events
           where film_id = 'f8400000-0000-4000-8000-000000000003' and kind = 'film_ready' and actor_id is null), 1,
  'the notification writes exactly one film_ready event');
select is((select count(*)::int from public.year_film_notifications_due(now()) where film_id = 'f8400000-0000-4000-8000-000000000003'), 0,
  'a second notifications_due run returns nothing');
select is((select count(*)::int from public.family_activity_events where film_id = 'f8400000-0000-4000-8000-000000000003'), 1,
  'and writes no second event');
select is((select count(*)::int from public.family_activity_events where film_id = 'f8400000-0000-4000-8000-000000000002'), 0,
  'a forced film gets no event');

-- Poster thumbs travel with the poster in every delete list.
insert into public.year_films (id, family_id, kind, scope_start_date, scope_end_exclusive, surface_at, status,
                               attempt_id, curated_epoch, video_key, poster_key, scenes_key)
values ('f8400000-0000-4000-8000-000000000004', 'f8100000-0000-4000-8000-000000000001', 'family_month',
        '2025-07-01', '2025-08-01', now(), 'rendering', 'f8900000-0000-4000-8000-000000000401', 0,
        'o/old2/film.mp4', 'o/old2/poster.jpg', 'o/old2/scenes.json');
select is(
  public.publish_year_film('f8400000-0000-4000-8000-000000000004', 'f8900000-0000-4000-8000-000000000401', 0,
    'o/new/film.mp4', 'o/new/poster.jpg', 'o/new/scenes.json', 1000) -> 'delete_keys',
  '["o/old2/film.mp4", "o/old2/poster.jpg", "o/old2/poster_thumb.jpg", "o/old2/scenes.json"]'::jsonb,
  'publish returns the replaced version''s poster_thumb.jpg for deletion too'
);
select is(public.year_film_poster_thumb_key(null), null, 'no poster, no thumb key');

-- ---------------------------------------------------------------------------
-- 10. year_films_enabled (member RPC for the upcoming-recap card)
-- ---------------------------------------------------------------------------

-- The lapsed family's owner (04) gets an entitlement and a clean current
-- month. (The main film family already has September memories.)
update public.year_film_settings
set mode = 'canary',
    canary_family_ids = array['f8100000-0000-4000-8000-000000000001', 'f8100000-0000-4000-8000-000000000002']::uuid[],
    launch_date = date '2026-01-01';
update public.user_profiles set timezone = 'America/New_York' where id = 'f8000000-0000-4000-8000-000000000004';
insert into public.owner_entitlements (
  owner_user_id, app_user_id, environment, store, product_id, entitlement_id,
  period_type, status, expires_at, will_renew
) values (
  'f8000000-0000-4000-8000-000000000004', 'f8000000-0000-4000-8000-000000000004',
  'production', 'app_store', 'momora_annual_v1', 'momora_plus', 'annual', 'active',
  transaction_timestamp() + interval '400 days', true
);

create temp table cur on commit drop as
select date_trunc('month', now() at time zone 'America/New_York')::date as month_start,
       (date_trunc('month', now() at time zone 'America/New_York') + interval '1 month')::date as next_first;

insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, memory_date)
select ('f8300000-0000-4000-8000-0000000005' || lpad(g::text, 2, '0'))::uuid,
       'f8100000-0000-4000-8000-000000000002', 'f8000000-0000-4000-8000-000000000004',
       'Lapsed this month ' || g, 'text_only', 'none', (select month_start from cur) + g
from generate_series(1, 9) g;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'f8000000-0000-4000-8000-000000000004', true);
select is(public.year_films_enabled('f8100000-0000-4000-8000-000000000002'), false,
  'year_films_enabled: false while the current month is below the 10-memory floor');
set local role postgres;

insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, memory_date)
values ('f8300000-0000-4000-8000-000000000510', 'f8100000-0000-4000-8000-000000000002', 'f8000000-0000-4000-8000-000000000004',
        'Lapsed this month 10', 'text_only', 'none', (select month_start from cur) + 10);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'f8000000-0000-4000-8000-000000000004', true);
select is(public.year_films_enabled('f8100000-0000-4000-8000-000000000002'), true,
  'year_films_enabled: true with rollout, launch_date, billing, an own child and 10 memories this month');
set local role postgres;

update public.year_film_settings set launch_date = (select next_first + 1 from cur);
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f8000000-0000-4000-8000-000000000004', true);
select is(public.year_films_enabled('f8100000-0000-4000-8000-000000000002'), false,
  'year_films_enabled: false while launch_date is after the next 1st');
set local role postgres;

update public.year_film_settings set launch_date = (select next_first from cur);
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f8000000-0000-4000-8000-000000000004', true);
select is(public.year_films_enabled('f8100000-0000-4000-8000-000000000002'), true,
  'year_films_enabled: true when launch_date is exactly the next 1st');
set local role postgres;

update public.year_film_settings set launch_date = null;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f8000000-0000-4000-8000-000000000004', true);
select is(public.year_films_enabled('f8100000-0000-4000-8000-000000000002'), false,
  'year_films_enabled: false without a launch_date');
set local role postgres;

update public.year_film_settings
set launch_date = date '2026-01-01', canary_family_ids = array['f8100000-0000-4000-8000-000000000001']::uuid[];
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f8000000-0000-4000-8000-000000000004', true);
select is(public.year_films_enabled('f8100000-0000-4000-8000-000000000002'), false,
  'year_films_enabled: false when the rollout does not include the family');
set local role postgres;
update public.year_film_settings
set canary_family_ids = array['f8100000-0000-4000-8000-000000000001', 'f8100000-0000-4000-8000-000000000002']::uuid[];

update public.family_members set relationship = 'cousin' where id = 'f8200000-0000-4000-8000-000000000101';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f8000000-0000-4000-8000-000000000004', true);
select is(public.year_films_enabled('f8100000-0000-4000-8000-000000000002'), false,
  'year_films_enabled: false without an own child');
set local role postgres;
update public.family_members set relationship = 'child' where id = 'f8200000-0000-4000-8000-000000000101';

delete from public.owner_entitlements where owner_user_id = 'f8000000-0000-4000-8000-000000000004';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f8000000-0000-4000-8000-000000000004', true);
select is(public.year_films_enabled('f8100000-0000-4000-8000-000000000002'), false,
  'year_films_enabled: false when billing does not allow');
set local role postgres;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'f8000000-0000-4000-8000-000000000003', true);
select throws_ok(
  $$select public.year_films_enabled('f8100000-0000-4000-8000-000000000002')$$,
  '42501', 'Not authorized', 'year_films_enabled: a non-member is rejected'
);
set local role postgres;

select ok(not has_function_privilege('anon', 'public.year_films_enabled(uuid)', 'execute')
          and has_function_privilege('authenticated', 'public.year_films_enabled(uuid)', 'execute'),
  'year_films_enabled is executable by authenticated only');

-- ---------------------------------------------------------------------------
-- 11. Parity: year_film_candidate_rows == what year_film_due inserts
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, is_anonymous) values
  ('f9000000-0000-4000-8000-000000000001', 'yf-parity@example.test', false),
  ('f9000000-0000-4000-8000-000000000002', 'yf-backfill@example.test', false);

insert into public.families (id, name, owner_id) values
  ('f9100000-0000-4000-8000-000000000001', 'Parity family', 'f9000000-0000-4000-8000-000000000001'),
  ('f9100000-0000-4000-8000-000000000002', 'Backfill family', 'f9000000-0000-4000-8000-000000000002');
insert into public.family_memberships (family_id, user_id, role) values
  ('f9100000-0000-4000-8000-000000000001', 'f9000000-0000-4000-8000-000000000001', 'owner'),
  ('f9100000-0000-4000-8000-000000000002', 'f9000000-0000-4000-8000-000000000002', 'owner');
insert into public.owner_entitlements (
  owner_user_id, app_user_id, environment, store, product_id, entitlement_id,
  period_type, status, expires_at, will_renew
)
select u, u, 'production', 'app_store', 'momora_annual_v1', 'momora_plus', 'annual', 'active',
       transaction_timestamp() + interval '400 days', true
from unnest(array['f9000000-0000-4000-8000-000000000001', 'f9000000-0000-4000-8000-000000000002']::uuid[]) as u;
update public.user_profiles set timezone = 'UTC' where id = 'f9000000-0000-4000-8000-000000000002';

-- Parity family: a Feb 29 child, a Dec 30 child (film due Jan 1, next year),
-- a plain Oct child, an unsorted kid (DOB rule), a cousin (never), and a
-- parent. 12 memories in every month of 2025-12..2028-03 except two thin ones.
insert into public.family_members (id, family_id, name, date_of_birth, relationship) values
  ('f9200000-0000-4000-8000-000000000001', 'f9100000-0000-4000-8000-000000000001', 'A', '2022-10-23', 'child'),
  ('f9200000-0000-4000-8000-000000000002', 'f9100000-0000-4000-8000-000000000001', 'B', '2024-02-29', 'child'),
  ('f9200000-0000-4000-8000-000000000003', 'f9100000-0000-4000-8000-000000000001', 'C', '2023-12-30', 'child'),
  ('f9200000-0000-4000-8000-000000000004', 'f9100000-0000-4000-8000-000000000001', 'D', '2020-03-01', 'child'),
  ('f9200000-0000-4000-8000-000000000005', 'f9100000-0000-4000-8000-000000000001', 'E', '2015-05-05', 'cousin'),
  ('f9200000-0000-4000-8000-000000000006', 'f9100000-0000-4000-8000-000000000001', 'F', '2013-12-29', null),
  ('f9200000-0000-4000-8000-000000000007', 'f9100000-0000-4000-8000-000000000001', 'G', '1985-01-01', 'parent');
insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, memory_date)
select gen_random_uuid(), 'f9100000-0000-4000-8000-000000000001', 'f9000000-0000-4000-8000-000000000001',
       'Parity memory', 'text_only', 'none', (m.month_start::date + (g - 1))
from generate_series(timestamp '2025-12-01', timestamp '2028-03-01', interval '1 month') as m(month_start)
cross join generate_series(1, 12) as g
where not (m.month_start::date in (date '2026-04-01', date '2026-11-01') and g > 3);

update public.year_film_settings
set mode = 'canary', canary_family_ids = array['f9100000-0000-4000-8000-000000000001']::uuid[],
    launch_date = date '2020-01-01';

create temp table parity_probe (
  tz text, probe_date date, extra integer, missing integer, total integer, birthdays integer, months integer, years integer
) on commit drop;

do $parity$
declare
  v_family constant uuid := 'f9100000-0000-4000-8000-000000000001';
  v_tz text;
  v_day date;
  v_now timestamptz;
  v_extra integer;
  v_missing integer;
  v_total integer;
begin
  foreach v_tz in array array['America/New_York', 'Pacific/Pago_Pago', 'Pacific/Kiritimati', 'Europe/Lisbon'] loop
    update public.user_profiles set timezone = v_tz where id = 'f9000000-0000-4000-8000-000000000001';
    foreach v_day in array array[
      date '2026-01-31', date '2026-02-01', date '2026-02-28', date '2026-03-01', date '2026-03-02',
      date '2026-03-03', date '2026-03-08', date '2026-03-09', date '2026-05-01', date '2026-09-30',
      date '2026-10-01', date '2026-10-25', date '2026-10-26', date '2026-11-01', date '2026-11-02',
      date '2026-12-01', date '2026-12-27', date '2026-12-28', date '2026-12-29', date '2026-12-30',
      date '2026-12-31', date '2027-01-01', date '2027-01-02', date '2027-01-03', date '2027-01-04',
      date '2027-02-28', date '2027-03-01', date '2028-02-29', date '2028-03-01', date '2028-03-02',
      date '2028-03-03'
    ] loop
      delete from public.year_films where family_id = v_family;
      v_now := (v_day + time '12:00') at time zone v_tz;
      perform public.year_film_due(v_now);

      -- year_film_due catches up the last 3 days, so a clean table holds every
      -- film due in [local today - 2, local today].
      select count(*) into v_extra from (
        select kind, family_member_id, age_year, scope_start_date, scope_end_exclusive, surface_at
        from public.year_films where family_id = v_family
        except
        select kind, family_member_id, age_year, scope_start_date, scope_end_exclusive, surface_at
        from public.year_film_candidate_rows(v_family, v_day - 2, v_day)
      ) x;
      select count(*) into v_missing from (
        select kind, family_member_id, age_year, scope_start_date, scope_end_exclusive, surface_at
        from public.year_film_candidate_rows(v_family, v_day - 2, v_day)
        except
        select kind, family_member_id, age_year, scope_start_date, scope_end_exclusive, surface_at
        from public.year_films where family_id = v_family
      ) x;
      select count(*) into v_total from public.year_films where family_id = v_family;

      insert into parity_probe values (
        v_tz, v_day, v_extra, v_missing, v_total,
        (select count(*) from public.year_films where family_id = v_family and kind = 'birthday'),
        (select count(*) from public.year_films where family_id = v_family and kind = 'family_month'),
        (select count(*) from public.year_films where family_id = v_family and kind = 'family_year')
      );
    end loop;
  end loop;
  delete from public.year_films where family_id = v_family;
end
$parity$;

select is((select count(*)::int from parity_probe), 124, 'parity sweep ran every probe date in every timezone');
select is((select count(*)::int from parity_probe where extra <> 0 or missing <> 0), 0,
  'parity: year_film_due inserts exactly the candidate rows due in its catch-up window (DST, UTC-11, UTC+14, year end, month ends, Feb 29)');
select ok((select sum(birthdays) > 0 and sum(months) > 0 and sum(years) > 0 from parity_probe),
  'parity sweep is not vacuous: birthday, monthly and year-end films were all compared');
select ok((select bool_and(total >= 1) from parity_probe
           where tz = 'America/New_York' and probe_date in (date '2026-03-02', date '2028-03-02')),
  'parity sweep covers a Feb 29 birthday (due Mar 2)');
select ok((select bool_and(total >= 1) from parity_probe where probe_date = date '2027-01-01'),
  'parity sweep covers a Dec 30 birthday due Jan 1 of the next year');
select is((select count(*)::int from parity_probe where probe_date = date '2026-05-01' and months > 0), 0,
  'parity: the thin April (3 memories) never produces a May 1 recap');
select ok((select bool_and(years = 1) from parity_probe where probe_date = date '2026-12-29'),
  'parity: the year-end film is in its window on Dec 29 (due Dec 28)');

select throws_ok(
  $$set local role authenticated; select * from public.year_film_candidate_rows('f9100000-0000-4000-8000-000000000001', date '2026-01-01', date '2026-12-31')$$,
  '42501', null, 'candidate rows are service-role only'
);
set local role postgres;

-- ---------------------------------------------------------------------------
-- 12. History backfill (silent, idempotent, gated)
-- ---------------------------------------------------------------------------

insert into public.family_members (id, family_id, name, date_of_birth, relationship) values
  ('f9200000-0000-4000-8000-000000000101', 'f9100000-0000-4000-8000-000000000002', 'Leap', '2024-02-29', 'child'),
  ('f9200000-0000-4000-8000-000000000102', 'f9100000-0000-4000-8000-000000000002', 'Summer', '2023-06-15', 'child');
-- Jan 2026: 16 memories, Feb: 12, Mar: 3 (thin), Apr: 12. First memory Jan 10.
insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, memory_date)
select gen_random_uuid(), 'f9100000-0000-4000-8000-000000000002', 'f9000000-0000-4000-8000-000000000002',
       'Backfill memory', 'text_only', 'none', d
from (
  select date '2026-01-09' + g as d from generate_series(1, 16) g
  union all select date '2026-02-01' + g from generate_series(1, 12) g
  union all select date '2026-03-01' + g from generate_series(1, 3) g
  union all select date '2026-04-01' + g from generate_series(1, 12) g
) s;

update public.year_film_settings
set mode = 'canary',
    canary_family_ids = array['f9100000-0000-4000-8000-000000000002', 'f8100000-0000-4000-8000-000000000002']::uuid[];

select is((select count(*)::int from public.year_film_enabled_families()), 2, 'the operator loop lists the enabled families');

select results_eq(
  $$select kind, family_member_id, age_year, scope_start_date, due_date, inserted
    from public.queue_year_film_backfill('f9100000-0000-4000-8000-000000000002', date '2026-04-30', true)$$,
  $$values
    ('family_month'::text, null::uuid, null::integer, date '2026-01-01', date '2026-02-01', true),
    ('family_month'::text, null::uuid, null::integer, date '2026-02-01', date '2026-03-01', true),
    ('birthday'::text, 'f9200000-0000-4000-8000-000000000101'::uuid, 2, date '2025-02-28', date '2026-03-02', true)$$,
  'backfill dry run lists the recaps with >= 10 memories and the Feb 29 birthday, and skips the thin March'
);
select is((select count(*)::int from public.year_films where family_id = 'f9100000-0000-4000-8000-000000000002'), 0,
  'a dry run inserts nothing');
select is((select count(*)::int from public.queue_year_film_backfill('f9100000-0000-4000-8000-000000000002', date '2026-04-30', true,
            'family_month', date '2026-01-01')), 1,
  'the --only filter narrows a run to one film key');

-- Smoke subset first, then everything: the second run reports the first as already there.
select results_eq(
  $$select kind, scope_start_date, inserted from public.queue_year_film_backfill('f9100000-0000-4000-8000-000000000002', date '2026-04-30', false,
      'family_month', date '2026-01-01')$$,
  $$values ('family_month'::text, date '2026-01-01', true)$$,
  'the smoke subset inserts only the chosen film'
);
select is((select count(*)::int from public.year_films where family_id = 'f9100000-0000-4000-8000-000000000002'), 1,
  'and only that row exists');
select results_eq(
  $$select kind, scope_start_date, inserted from public.queue_year_film_backfill('f9100000-0000-4000-8000-000000000002', date '2026-04-30', false)$$,
  $$values
    ('family_month'::text, date '2026-01-01', false),
    ('family_month'::text, date '2026-02-01', true),
    ('birthday'::text, date '2025-02-28', true)$$,
  'the full run inserts the rest and reports the existing film as not inserted'
);
select results_eq(
  $$select kind, scope_start_date, surface_at, status, forced, notified_at is not null
    from public.year_films where family_id = 'f9100000-0000-4000-8000-000000000002' order by scope_start_date, kind$$,
  $$values
    ('birthday'::text, date '2025-02-28', timestamptz '2026-03-02 09:00:00+00', 'queued'::text, false, true),
    ('family_month'::text, date '2026-01-01', timestamptz '2026-02-01 19:00:00+00', 'queued'::text, false, true),
    ('family_month'::text, date '2026-02-01', timestamptz '2026-03-01 19:00:00+00', 'queued'::text, false, true)$$,
  'backfilled rows are queued, non-forced, historically timed and pre-notified'
);
select is((select count(*)::int from public.family_activity_events where family_id = 'f9100000-0000-4000-8000-000000000002' and kind = 'film_ready'), 0,
  'a backfill writes no drawer events');
select is((select count(*)::int from public.year_film_notifications_due(now()) where family_id = 'f9100000-0000-4000-8000-000000000002'), 0,
  'and no push is ever due for backfilled films');
select is((select count(*) filter (where inserted)::int from public.queue_year_film_backfill('f9100000-0000-4000-8000-000000000002', date '2026-04-30', false)), 0,
  'a repeated backfill is idempotent');
select is((select count(*)::int from public.year_films where family_id = 'f9100000-0000-4000-8000-000000000002'), 3,
  'and leaves exactly the three films');
select ok((select max(due_date) <= (now() at time zone 'UTC')::date
           from public.queue_year_film_backfill('f9100000-0000-4000-8000-000000000002', date '2099-12-31', true)),
  'p_through is clamped to the family-local today');

-- Gates.
update public.year_film_settings set mode = 'off';
select throws_ok(
  $$select * from public.queue_year_film_backfill('f9100000-0000-4000-8000-000000000002', date '2026-04-30', true)$$,
  'P0001', 'Year films are not enabled for this family', 'backfill requires the rollout to include the family'
);
update public.year_film_settings
set mode = 'canary', canary_family_ids = array['f9100000-0000-4000-8000-000000000002', 'f8100000-0000-4000-8000-000000000002']::uuid[];
select throws_ok(
  $$select * from public.queue_year_film_backfill('f8100000-0000-4000-8000-000000000002', date '2026-04-30', true)$$,
  'P0001', 'Billing does not allow year films for this family', 'backfill requires billing to allow the family'
);
update public.year_film_settings set launch_date = null;
select ok(exists (select 1 from public.queue_year_film_backfill('f9100000-0000-4000-8000-000000000002', date '2026-04-30', true)),
  'backfill ignores launch_date');
select throws_ok(
  $$set local role authenticated; select * from public.queue_year_film_backfill('f9100000-0000-4000-8000-000000000002', date '2026-04-30', true)$$,
  '42501', null, 'backfill is service-role only'
);
set local role postgres;

-- ---------------------------------------------------------------------------
-- 12. Edit sheet options (20260930150000_year_film_edit_options.sql)
-- ---------------------------------------------------------------------------

set local role postgres;
insert into auth.users (id, email, is_anonymous) values
  ('f8000000-0000-4000-8000-000000000005', 'yf-anon@example.test', true);

-- A ready monthly film (scope March 2025, so the unique key is free) whose
-- script shows memories 01-04 and 06-08 (05 sits in a counters backdrop, 10
-- in the end-card grid, 09 has no frame; 02 repeats). Memory 11 is already
-- removed by an earlier edit, so the re-rendered script no longer uses it.
with frame(n, k, d) as (values
  ('01', 'photo', '2026-09-02'), ('02', 'illustration', '2026-09-03'), ('03', 'video', '2026-09-04'),
  ('04', 'audio', '2026-09-05'), ('05', 'photo', '2026-09-06'), ('06', 'photo', '2026-09-07'),
  ('07', 'illustration', '2026-09-08'), ('08', 'photo', '2026-09-09'), ('10', 'photo', '2026-09-11')
), f as (
  select n, jsonb_build_object(
    'memoryId', 'f8300000-0000-4000-8000-0000000000' || n, 'date', d, 'kind', k, 'key', 'k/' || n) as j
  from frame
), portrait as (select jsonb_build_object('memoryId', null, 'date', null, 'kind', 'portrait', 'key', 'k/p') as j)
insert into public.year_films (
  family_id, kind, scope_start_date, scope_end_exclusive, surface_at, status, video_key, poster_key,
  music_bed_id, edits_version, ready_at, referenced_memory_ids, edits, film_script, quote_candidates
)
select 'f8100000-0000-4000-8000-000000000001', 'family_month', date '2025-03-01', date '2025-04-01', now() - interval '1 day',
  'ready', 'films/eo.mp4', 'films/eo.jpg', 'bubbly-synth', 2, now(),
  array(select ('f8300000-0000-4000-8000-0000000000' || n)::uuid from frame),
  jsonb_build_object('removedMemoryIds', jsonb_build_array('f8300000-0000-4000-8000-000000000011')),
  jsonb_build_object('scenes', jsonb_build_array(
    jsonb_build_object('type', 'title', 'cards', jsonb_build_array((select j from f where n = '01'), (select j from f where n = '02'))),
    jsonb_build_object('type', 'counters', 'backdrop', jsonb_build_array((select j from f where n = '05'))),
    jsonb_build_object('type', 'burst', 'frames', jsonb_build_array((select j from f where n = '02'), (select j from f where n = '03'), (select j from portrait))),
    jsonb_build_object('type', 'sound', 'frame', (select j from f where n = '04'), 'alternates', jsonb_build_array((select j from f where n = '10'))),
    jsonb_build_object('type', 'line', 'memoryId', 'f8300000-0000-4000-8000-000000000006', 'quote', 'q', 'frame', (select j from f where n = '06')),
    jsonb_build_object('type', 'starring', 'people', jsonb_build_array(jsonb_build_object(
      'memberId', 'f8200000-0000-4000-8000-000000000001', 'portrait', (select j from portrait),
      'moments', jsonb_build_array((select j from f where n = '07'))))),
    jsonb_build_object('type', 'firsts', 'items', jsonb_build_array(
      jsonb_build_object('memoryId', 'f8300000-0000-4000-8000-000000000008', 'frame', (select j from f where n = '08')),
      jsonb_build_object('memoryId', 'f8300000-0000-4000-8000-000000000009'))),
    jsonb_build_object('type', 'end_card', 'grid', jsonb_build_array((select j from f where n = '10')))
  )),
  (select jsonb_agg(jsonb_build_object(
      'memoryId', 'f8300000-0000-4000-8000-0000000000' || c.n, 'quote', 'Quote ' || c.n, 'textHash', 'hash' || c.n,
      'speakerId', 'f8200000-0000-4000-8000-000000000001') order by c.o)
   from (values ('06', 1), ('02', 2), ('07', 3), ('08', 4), ('03', 5)) c(n, o))
;
create temp table eo on commit drop as
select id from public.year_films
where family_id = 'f8100000-0000-4000-8000-000000000001' and kind = 'family_month' and scope_start_date = date '2025-03-01';
grant select on eo to authenticated;

create temp table eo_forced on commit drop as
select public.queue_year_film_forced('f8100000-0000-4000-8000-000000000001', 'family_year', null, null,
  date '2025-01-01', date '2025-12-28', now()) as id;
grant select on eo_forced to authenticated;
update public.year_films set status = 'ready', video_key = 'films/forced.mp4', poster_key = 'films/forced.jpg'
where id = (select id from eo_forced);

create temp table eo_lapsed on commit drop as
with ins as (
  insert into public.year_films (family_id, kind, scope_start_date, scope_end_exclusive, surface_at, status, video_key, poster_key)
  values ('f8100000-0000-4000-8000-000000000002', 'family_month', date '2025-03-01', date '2025-04-01', now(), 'ready', 'films/l.mp4', 'films/l.jpg')
  returning id)
select id from ins;
grant select on eo_lapsed to authenticated;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'f8000000-0000-4000-8000-000000000001', true);
create temp table eo_owner_result on commit drop as
select public.get_year_film_edit_options((select id from eo)) as o;
grant select on eo_owner_result to authenticated;
select is((select o ->> 'editable' from eo_owner_result), 'true', 'edit options: an owner gets an editable film');
select is((select o ->> 'kind' from eo_owner_result), 'family_month', 'edit options: kind');
select is((select (o ->> 'editsVersion')::int from eo_owner_result), 2, 'edit options: edits version');
select is((select o ->> 'musicBedId' from eo_owner_result), 'bubbly-synth', 'edit options: current bed');
select is(
  (select array(select f ->> 'memoryId' from jsonb_array_elements(o -> 'frames') f) from eo_owner_result),
  array[
    'f8300000-0000-4000-8000-000000000001', 'f8300000-0000-4000-8000-000000000002',
    'f8300000-0000-4000-8000-000000000003', 'f8300000-0000-4000-8000-000000000004',
    'f8300000-0000-4000-8000-000000000006', 'f8300000-0000-4000-8000-000000000007',
    'f8300000-0000-4000-8000-000000000008', 'f8300000-0000-4000-8000-000000000011'
  ],
  'frames: film order, de-duplicated, no portraits, counters backdrop, end-card grid or alternates; removed moment last'
);
select is(
  (select o -> 'frames' -> 2 from eo_owner_result),
  '{"memoryId":"f8300000-0000-4000-8000-000000000003","date":"2026-09-04","kind":"video"}'::jsonb,
  'frames: memoryId, date and kind from the script'
);
select is(
  (select o -> 'frames' -> 7 from eo_owner_result),
  '{"memoryId":"f8300000-0000-4000-8000-000000000011","date":"2026-09-12","kind":"illustration"}'::jsonb,
  'frames: an already-removed moment is listed from the memory row'
);
select is((select o -> 'removedMemoryIds' from eo_owner_result), '["f8300000-0000-4000-8000-000000000011"]'::jsonb,
  'edit options: current removals');
select is((select jsonb_array_length(o -> 'quoteCandidates') from eo_owner_result), 3, 'quote candidates are capped at three');
select is(
  (select o -> 'quoteCandidates' -> 0 from eo_owner_result),
  '{"memoryId":"f8300000-0000-4000-8000-000000000006","textHash":"hash06","text":"Quote 06","speakerName":"Enzo","isCurrent":true}'::jsonb,
  'quote candidates: text, hash, speaker name, and the shown line is current'
);
select is((select o -> 'chosenQuote' from eo_owner_result), 'null'::jsonb, 'no chosen quote yet');

select set_config('request.jwt.claim.sub', 'f8000000-0000-4000-8000-000000000002', true);
select is((public.get_year_film_edit_options((select id from eo))) ->> 'editable', 'true', 'edit options: a manager may edit');

-- Re-sending an earlier removal alongside a new one is valid (regression);
-- an id the film never used is still rejected.
select throws_ok(
  $$select public.save_year_film_edits((select id from eo), '{"removedMemoryIds":["f8300000-0000-4000-8000-000000000011","f8300000-0000-4000-8000-000000000012"]}')$$,
  '22023', null, 'save: a moment neither in the film nor removed earlier is rejected'
);
select is(
  public.save_year_film_edits((select id from eo),
    '{"removedMemoryIds":["f8300000-0000-4000-8000-000000000011","f8300000-0000-4000-8000-000000000001"],"quote":{"memoryId":"f8300000-0000-4000-8000-000000000002","textHash":"hash02"}}') ->> 'ok',
  'true', 'save: the full removal set may include moments removed by an earlier edit'
);
set local role postgres;
select is((select edits -> 'removedMemoryIds' from public.year_films where id = (select id from eo)) @> '["f8300000-0000-4000-8000-000000000001","f8300000-0000-4000-8000-000000000011"]'::jsonb,
  true, 'save: both removals are stored');

-- Queued (re-render in flight) -> not ready; then ready+blocked -> blocked.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f8000000-0000-4000-8000-000000000001', true);
select is((public.get_year_film_edit_options((select id from eo))) ->> 'reason', 'not_ready', 'edit options: a film being remade is not editable');
set local role postgres;
update public.year_films set status = 'ready' where id = (select id from eo);
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f8000000-0000-4000-8000-000000000001', true);
select is(
  (public.get_year_film_edit_options((select id from eo))) ->> 'reason', 'blocked',
  'edit options: a blocked film reports editable false (removal took it down)'
);
select is((public.get_year_film_edit_options((select id from eo))) ->> 'editable', 'false', 'edit options: blocked is not editable');
set local role postgres;
update public.year_films set blocked = false where id = (select id from eo);
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f8000000-0000-4000-8000-000000000001', true);
select is((public.get_year_film_edit_options((select id from eo)) -> 'chosenQuote' ->> 'memoryId'), 'f8300000-0000-4000-8000-000000000002',
  'edit options: the chosen quote is returned');
select is(
  (select array_agg(c ->> 'memoryId') filter (where (c ->> 'isCurrent')::boolean)
   from jsonb_array_elements(public.get_year_film_edit_options((select id from eo)) -> 'quoteCandidates') c),
  array['f8300000-0000-4000-8000-000000000002'],
  'edit options: only the chosen candidate is current'
);
select is(
  (select array(select f ->> 'memoryId' from jsonb_array_elements(public.get_year_film_edit_options((select id from eo)) -> 'frames') f
    where f ->> 'memoryId' in ('f8300000-0000-4000-8000-000000000001', 'f8300000-0000-4000-8000-000000000011'))),
  array['f8300000-0000-4000-8000-000000000001', 'f8300000-0000-4000-8000-000000000011'],
  'frames: a newly removed moment stays listed once (de-duplicated against the script)'
);

-- Access.
select set_config('request.jwt.claim.sub', 'f8000000-0000-4000-8000-000000000003', true);
select throws_ok($$select public.get_year_film_edit_options((select id from eo))$$, '42501', null, 'edit options: a viewer is denied');
select set_config('request.jwt.claim.sub', 'f8000000-0000-4000-8000-000000000004', true);
select throws_ok($$select public.get_year_film_edit_options((select id from eo))$$, '42501', null, 'edit options: a non-member is denied');
select set_config('request.jwt.claim.sub', 'f8000000-0000-4000-8000-000000000005', true);
select throws_ok($$select public.get_year_film_edit_options((select id from eo))$$, '42501', null, 'edit options: an anonymous Auth user is denied');
select set_config('request.jwt.claim.sub', 'f8000000-0000-4000-8000-000000000001', true);
select throws_ok($$select public.get_year_film_edit_options((select id from eo_forced))$$, '42501', null, 'edit options: a forced (operator) film is denied');
select throws_ok($$select public.get_year_film_edit_options(gen_random_uuid())$$, '42501', null, 'edit options: an unknown film is denied');
select set_config('request.jwt.claim.sub', 'f8000000-0000-4000-8000-000000000004', true);
select is((public.get_year_film_edit_options((select id from eo_lapsed))) ->> 'reason', 'subscription_required',
  'edit options: a family whose billing lapsed cannot edit');
set local role anon;
select throws_ok($$select public.get_year_film_edit_options((select id from eo))$$, '42501', null, 'edit options: the anon role cannot execute it');
set local role postgres;

select * from finish();
rollback;
