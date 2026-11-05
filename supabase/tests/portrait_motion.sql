-- Living portraits (docs/plans/living-portraits.md, 20261105150000_portrait_motion.sql):
-- claim outcomes, publish CAS, fail, client write guard, telemetry-only ledger
-- operations.
begin;

select plan(70);

insert into auth.users (id, email)
values ('1a000000-0000-4000-8000-000000000001', 'portrait-motion-db@example.test');

insert into public.families (id, name, owner_id)
values ('2a000000-0000-4000-8000-000000000001', 'Portrait motion DB test', '1a000000-0000-4000-8000-000000000001');

insert into public.family_memberships (id, family_id, user_id, role)
values ('3a000000-0000-4000-8000-000000000001', '2a000000-0000-4000-8000-000000000001', '1a000000-0000-4000-8000-000000000001', 'owner');

insert into public.family_members (id, family_id, user_id, name, date_of_birth)
values ('4a000000-0000-4000-8000-000000000001', '2a000000-0000-4000-8000-000000000001', '1a000000-0000-4000-8000-000000000001', 'Portrait motion child', date '2024-01-01');

-- V1: ready still (the main subject). V2: still still pending. V3: ready but
-- being deleted.
insert into public.family_member_portrait_versions (
  id, family_id, family_member_id, user_id, reference_date, date_source,
  profile_picture_key, illustrated_profile_key, illustrated_profile_status
) values
(
  '5a000000-0000-4000-8000-000000000001',
  '2a000000-0000-4000-8000-000000000001',
  '4a000000-0000-4000-8000-000000000001',
  '1a000000-0000-4000-8000-000000000001', date '2026-01-01', 'manual',
  '1a000000-0000-4000-8000-000000000001/family/4a000000-0000-4000-8000-000000000001/portraits/5a000000-0000-4000-8000-000000000001/photo.jpg',
  'still/one.webp', 'ready'
),
(
  '5a000000-0000-4000-8000-000000000002',
  '2a000000-0000-4000-8000-000000000001',
  '4a000000-0000-4000-8000-000000000001',
  '1a000000-0000-4000-8000-000000000001', date '2026-02-01', 'manual',
  '1a000000-0000-4000-8000-000000000001/family/4a000000-0000-4000-8000-000000000001/portraits/5a000000-0000-4000-8000-000000000002/photo.jpg',
  null, 'pending'
);
insert into public.family_member_portrait_versions (
  id, family_id, family_member_id, user_id, reference_date, date_source,
  profile_picture_key, illustrated_profile_key, illustrated_profile_status,
  deletion_token, deletion_started_at
) values (
  '5a000000-0000-4000-8000-000000000003',
  '2a000000-0000-4000-8000-000000000001',
  '4a000000-0000-4000-8000-000000000001',
  '1a000000-0000-4000-8000-000000000001', date '2026-03-01', 'manual',
  '1a000000-0000-4000-8000-000000000001/family/4a000000-0000-4000-8000-000000000001/portraits/5a000000-0000-4000-8000-000000000003/photo.jpg',
  'still/three.webp', 'ready',
  '6a000000-0000-4000-8000-0000000000d0', now()
);

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
select ok(not has_function_privilege('authenticated', 'public.claim_portrait_motion(uuid,boolean)', 'EXECUTE'), 'authenticated cannot claim portrait motion');
select ok(not has_function_privilege('anon', 'public.claim_portrait_motion(uuid,boolean)', 'EXECUTE'), 'anon cannot claim portrait motion');
select ok(not has_function_privilege('authenticated', 'public.publish_portrait_motion(uuid,uuid,text,smallint,smallint)', 'EXECUTE'), 'authenticated cannot publish portrait motion');
select ok(not has_function_privilege('authenticated', 'public.fail_portrait_motion(uuid,uuid,text)', 'EXECUTE'), 'authenticated cannot fail portrait motion');
select ok(has_function_privilege('service_role', 'public.claim_portrait_motion(uuid,boolean)', 'EXECUTE'), 'service role can claim portrait motion');
select ok(has_function_privilege('service_role', 'public.publish_portrait_motion(uuid,uuid,text,smallint,smallint)', 'EXECUTE'), 'service role can publish portrait motion');
select ok(has_function_privilege('service_role', 'public.fail_portrait_motion(uuid,uuid,text)', 'EXECUTE'), 'service role can fail portrait motion');

-- ---------------------------------------------------------------------------
-- Claim: eligibility
-- ---------------------------------------------------------------------------
select is((select outcome from public.claim_portrait_motion('5a000000-0000-4000-8000-0000000000ff')), 'not_eligible', 'an unknown version is not eligible');
select is((select outcome from public.claim_portrait_motion('5a000000-0000-4000-8000-000000000002')), 'not_eligible', 'a version whose still is not ready is not eligible');
select is((select outcome from public.claim_portrait_motion('5a000000-0000-4000-8000-000000000003')), 'not_eligible', 'a version being deleted is not eligible');
select is((select motion_status from public.family_member_portrait_versions where id = '5a000000-0000-4000-8000-000000000002'), null, 'a non-eligible claim leaves the row untouched');

-- ---------------------------------------------------------------------------
-- Claim: first claim
-- ---------------------------------------------------------------------------
create temporary table motion_claim_1 as
select * from public.claim_portrait_motion('5a000000-0000-4000-8000-000000000001');

select is((select outcome from motion_claim_1), 'claimed', 'a ready still with no motion is claimed');
select ok((select motion_token is not null from motion_claim_1), 'a claim returns a token');
select is((select source_key from motion_claim_1), 'still/one.webp', 'the claim returns the current still as the source');
select is(
  (select output_key from motion_claim_1),
  '1a000000-0000-4000-8000-000000000001/family/4a000000-0000-4000-8000-000000000001/portraits/5a000000-0000-4000-8000-000000000001/motion/' || (select motion_token from motion_claim_1) || '.webp',
  'the claim returns the deterministic owner-prefixed sheet key'
);
select is((select stale_motion_key from motion_claim_1), null, 'a first claim has no stale sheet');
select is((select motion_status from public.family_member_portrait_versions where id = '5a000000-0000-4000-8000-000000000001'), 'pending', 'claim marks motion pending');
select is((select motion_token from public.family_member_portrait_versions where id = '5a000000-0000-4000-8000-000000000001'), (select motion_token from motion_claim_1), 'claim stores the token');
select is((select motion_source_key from public.family_member_portrait_versions where id = '5a000000-0000-4000-8000-000000000001'), 'still/one.webp', 'claim stores the source still');
select is((select motion_attempts from public.family_member_portrait_versions where id = '5a000000-0000-4000-8000-000000000001'), 1::smallint, 'claim counts the attempt');
select is((select outcome from public.claim_portrait_motion('5a000000-0000-4000-8000-000000000001')), 'in_flight', 'a fresh pending claim for the same still is in flight');
select is((select outcome from public.claim_portrait_motion('5a000000-0000-4000-8000-000000000001', true)), 'in_flight', 'force does not override an in-flight claim');

-- ---------------------------------------------------------------------------
-- Publish: CAS
-- ---------------------------------------------------------------------------
select is(
  (select published from public.publish_portrait_motion(
    '5a000000-0000-4000-8000-000000000001', '6a000000-0000-4000-8000-0000000000e0',
    (select output_key from motion_claim_1), 3::smallint, 3::smallint)),
  false, 'publish with a stale token is rejected'
);
select is(
  (select published from public.publish_portrait_motion(
    '5a000000-0000-4000-8000-000000000001', (select motion_token from motion_claim_1),
    'forged/key.webp', 3::smallint, 3::smallint)),
  false, 'publish with a non-deterministic output key is rejected'
);
select throws_ok(
  $$select public.publish_portrait_motion(
    '5a000000-0000-4000-8000-000000000001', (select motion_token from motion_claim_1),
    (select output_key from motion_claim_1), 5::smallint, 3::smallint)$$,
  '22023', 'invalid motion grid', 'publish rejects a grid outside 1..4'
);
select is((select motion_status from public.family_member_portrait_versions where id = '5a000000-0000-4000-8000-000000000001'), 'pending', 'rejected publishes leave motion pending');

create temporary table motion_publish_1 as
select * from public.publish_portrait_motion(
  '5a000000-0000-4000-8000-000000000001', (select motion_token from motion_claim_1),
  (select output_key from motion_claim_1), 3::smallint, 3::smallint);
select is((select published from motion_publish_1), true, 'publish with the current token and key succeeds');
select is((select old_motion_key from motion_publish_1), null, 'a first publish replaces no sheet');
select is((select motion_status from public.family_member_portrait_versions where id = '5a000000-0000-4000-8000-000000000001'), 'ready', 'publish marks motion ready');
select is((select motion_key from public.family_member_portrait_versions where id = '5a000000-0000-4000-8000-000000000001'), (select output_key from motion_claim_1), 'publish stores the sheet key');
select is((select motion_columns || 'x' || motion_rows from public.family_member_portrait_versions where id = '5a000000-0000-4000-8000-000000000001'), '3x3', 'publish stores the grid');
select is(
  (select published from public.publish_portrait_motion(
    '5a000000-0000-4000-8000-000000000001', (select motion_token from motion_claim_1),
    (select output_key from motion_claim_1), 3::smallint, 3::smallint)),
  false, 'a replayed publish is rejected because the claim is no longer pending'
);

-- ---------------------------------------------------------------------------
-- Claim: already ready, force
-- ---------------------------------------------------------------------------
select is((select outcome from public.claim_portrait_motion('5a000000-0000-4000-8000-000000000001')), 'already_ready', 'a ready sheet for the current still is already ready');

create temporary table motion_claim_forced as
select * from public.claim_portrait_motion('5a000000-0000-4000-8000-000000000001', true);
select is((select outcome from motion_claim_forced), 'claimed', 'force reclaims a ready sheet');
select is((select stale_motion_key from motion_claim_forced), (select output_key from motion_claim_1), 'a forced reclaim returns the previous sheet for deletion');
select is((select motion_key from public.family_member_portrait_versions where id = '5a000000-0000-4000-8000-000000000001'), null, 'a pending row never holds a sheet (shape check)');
select is((select motion_attempts from public.family_member_portrait_versions where id = '5a000000-0000-4000-8000-000000000001'), 2::smallint, 'every claim counts an attempt');

-- ---------------------------------------------------------------------------
-- Fail
-- ---------------------------------------------------------------------------
select is(public.fail_portrait_motion('5a000000-0000-4000-8000-000000000001', '6a000000-0000-4000-8000-0000000000e0', 'QA_FAILED'), false, 'fail with a stale token does nothing');
select is((select motion_status from public.family_member_portrait_versions where id = '5a000000-0000-4000-8000-000000000001'), 'pending', 'a stale fail leaves the claim pending');
select is(public.fail_portrait_motion('5a000000-0000-4000-8000-000000000001', (select motion_token from motion_claim_forced), 'QA_FAILED'), true, 'fail with the current token fails the claim');
select is((select motion_status from public.family_member_portrait_versions where id = '5a000000-0000-4000-8000-000000000001'), 'failed', 'fail marks motion failed');
select is(public.fail_portrait_motion('5a000000-0000-4000-8000-000000000001', (select motion_token from motion_claim_forced), 'QA_FAILED'), false, 'a replayed fail is a no-op');
select is(
  (select published from public.publish_portrait_motion(
    '5a000000-0000-4000-8000-000000000001', (select motion_token from motion_claim_forced),
    (select output_key from motion_claim_forced), 3::smallint, 3::smallint)),
  false, 'a failed claim cannot publish'
);
select is((select outcome from public.claim_portrait_motion('5a000000-0000-4000-8000-000000000001')), 'already_failed', 'a failed attempt for the current still is not retried automatically');

create temporary table motion_claim_retry as
select * from public.claim_portrait_motion('5a000000-0000-4000-8000-000000000001', true);
select is((select outcome from motion_claim_retry), 'claimed', 'force retries a failed attempt');

-- ---------------------------------------------------------------------------
-- Stale claims and a replaced still
-- ---------------------------------------------------------------------------
update public.family_member_portrait_versions
set motion_started_at = now() - interval '16 minutes'
where id = '5a000000-0000-4000-8000-000000000001';
create temporary table motion_claim_reclaim as
select * from public.claim_portrait_motion('5a000000-0000-4000-8000-000000000001');
select is((select outcome from motion_claim_reclaim), 'claimed', 'a pending claim older than 15 minutes is reclaimed');
select isnt((select motion_token from motion_claim_reclaim), (select motion_token from motion_claim_retry), 'a reclaim issues a new token');

-- The still is regenerated while a claim is pending: the old claim can no
-- longer publish (CAS on the source still), and the next claim supersedes it.
update public.family_member_portrait_versions
set illustrated_profile_key = 'still/one-regenerated.webp'
where id = '5a000000-0000-4000-8000-000000000001';
select is(
  (select published from public.publish_portrait_motion(
    '5a000000-0000-4000-8000-000000000001', (select motion_token from motion_claim_reclaim),
    (select output_key from motion_claim_reclaim), 3::smallint, 3::smallint)),
  false, 'a claim made from a replaced still cannot publish'
);
create temporary table motion_claim_new_still as
select * from public.claim_portrait_motion('5a000000-0000-4000-8000-000000000001');
select is((select outcome from motion_claim_new_still), 'claimed', 'a pending claim for an older still is superseded');
select is((select source_key from motion_claim_new_still), 'still/one-regenerated.webp', 'the new claim derives from the regenerated still');
select is(
  (select published from public.publish_portrait_motion(
    '5a000000-0000-4000-8000-000000000001', (select motion_token from motion_claim_new_still),
    (select output_key from motion_claim_new_still), 2::smallint, 2::smallint)),
  true, 'the new claim publishes'
);

-- A ready sheet whose still has since been replaced is stale: claiming returns
-- the old object for deletion.
update public.family_member_portrait_versions
set illustrated_profile_key = 'still/one-regenerated-again.webp'
where id = '5a000000-0000-4000-8000-000000000001';
create temporary table motion_claim_stale as
select * from public.claim_portrait_motion('5a000000-0000-4000-8000-000000000001');
select is((select outcome from motion_claim_stale), 'claimed', 'a ready sheet made from a replaced still is reclaimed');
select is((select stale_motion_key from motion_claim_stale), (select output_key from motion_claim_new_still), 'the replaced sheet is returned as stale');

-- A deletion token set while a claim is pending blocks publication.
update public.family_member_portrait_versions
set deletion_token = '6a000000-0000-4000-8000-0000000000d1', deletion_started_at = now()
where id = '5a000000-0000-4000-8000-000000000001';
select is(
  (select published from public.publish_portrait_motion(
    '5a000000-0000-4000-8000-000000000001', (select motion_token from motion_claim_stale),
    (select output_key from motion_claim_stale), 3::smallint, 3::smallint)),
  false, 'a version being deleted cannot publish motion'
);
update public.family_member_portrait_versions
set deletion_token = null, deletion_started_at = null
where id = '5a000000-0000-4000-8000-000000000001';

-- ---------------------------------------------------------------------------
-- Deletion fences make a version ineligible
-- ---------------------------------------------------------------------------
update public.family_member_portrait_versions
set motion_status = null, motion_key = null, motion_source_key = null, motion_token = null,
    motion_columns = null, motion_rows = null, motion_started_at = null
where id = '5a000000-0000-4000-8000-000000000001';

update public.family_members
set deletion_fence_token = '6a000000-0000-4000-8000-0000000000f1', deletion_fence_started_at = now()
where id = '4a000000-0000-4000-8000-000000000001';
select is((select outcome from public.claim_portrait_motion('5a000000-0000-4000-8000-000000000001')), 'not_eligible', 'a member being deleted is not eligible');
update public.family_members
set deletion_fence_token = null, deletion_fence_started_at = null
where id = '4a000000-0000-4000-8000-000000000001';

update public.families
set deletion_fence_token = '6a000000-0000-4000-8000-0000000000f2', deletion_fence_started_at = now()
where id = '2a000000-0000-4000-8000-000000000001';
select is((select outcome from public.claim_portrait_motion('5a000000-0000-4000-8000-000000000001')), 'not_eligible', 'a family being deleted is not eligible');
update public.families
set deletion_fence_token = null, deletion_fence_started_at = null
where id = '2a000000-0000-4000-8000-000000000001';

update public.families set deleted_at = now() where id = '2a000000-0000-4000-8000-000000000001';
select is((select outcome from public.claim_portrait_motion('5a000000-0000-4000-8000-000000000001')), 'not_eligible', 'a family in its account-deletion grace period is not eligible');
update public.families set deleted_at = null where id = '2a000000-0000-4000-8000-000000000001';

select is((select outcome from public.claim_portrait_motion('5a000000-0000-4000-8000-000000000001')), 'claimed', 'eligibility returns once the fences are cleared');

-- ---------------------------------------------------------------------------
-- Shape checks
-- ---------------------------------------------------------------------------
select throws_ok(
  $$update public.family_member_portrait_versions set motion_status = 'ready' where id = '5a000000-0000-4000-8000-000000000001'$$,
  '23514', null, 'a ready status without a sheet violates the shape check'
);
select throws_ok(
  $$update public.family_member_portrait_versions set motion_key = 'x.webp' where id = '5a000000-0000-4000-8000-000000000001'$$,
  '23514', null, 'a sheet key without a ready status violates the shape check'
);
select throws_ok(
  $$update public.family_member_portrait_versions set motion_status = 'ready', motion_key = 'x.webp' where id = '5a000000-0000-4000-8000-000000000001'$$,
  '23514', null, 'a ready sheet needs its grid'
);

-- ---------------------------------------------------------------------------
-- Clients cannot write motion state
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', '1a000000-0000-4000-8000-000000000001', true);
select throws_ok(
  $$update public.family_member_portrait_versions set motion_status = 'failed' where id = '5a000000-0000-4000-8000-000000000001'$$,
  '42501', null, 'authenticated cannot update motion columns'
);
set local role postgres;

-- The guard trigger itself (reached once a future grant/policy lets a client
-- UPDATE the table): forge the JWT role so auth.role() reports a client.
select set_config('request.jwt.claim.role', 'authenticated', true);
select throws_ok(
  $$update public.family_member_portrait_versions set motion_key = 'forged.webp', motion_status = 'ready', motion_columns = 3, motion_rows = 3 where id = '5a000000-0000-4000-8000-000000000001'$$,
  '42501', 'Portrait motion state is server managed', 'the guard trigger rejects client motion writes'
);
select lives_ok(
  $$update public.family_member_portrait_versions set reference_date = reference_date where id = '5a000000-0000-4000-8000-000000000001'$$,
  'the guard does not block unrelated client-role updates'
);
select set_config('request.jwt.claim.role', 'service_role', true);
select lives_ok(
  $$update public.family_member_portrait_versions set motion_attempts = motion_attempts where id = '5a000000-0000-4000-8000-000000000001'$$,
  'the service role can write motion state'
);

-- ---------------------------------------------------------------------------
-- Telemetry-only ledger operations
-- ---------------------------------------------------------------------------
create temporary table motion_request_count as
select count(*) as n from public.ai_image_generation_requests where family_id = '2a000000-0000-4000-8000-000000000001';

select lives_ok(
  $$select public.record_ai_usage_event_detailed(
    'motion:6a000000-0000-4000-8000-0000000000a1:1', null,
    '2a000000-0000-4000-8000-000000000001', '1a000000-0000-4000-8000-000000000001',
    'portrait_motion', 'gpt-image-2.6-flare', true,
    '{"output_image_tokens": 2073}'::jsonb, 0.072, 'provider_usage', 'known', true, 'test')$$,
  'the ledger accepts a portrait_motion event'
);
select lives_ok(
  $$select public.record_ai_usage_event_detailed(
    'motion-check:6a000000-0000-4000-8000-0000000000a1:1', null,
    '2a000000-0000-4000-8000-000000000001', '1a000000-0000-4000-8000-000000000001',
    'portrait_motion_check', 'gpt-4o-mini', true,
    '{"input_text_tokens": 900}'::jsonb, 0.001, 'provider_usage', 'known', true, 'test')$$,
  'the ledger accepts a portrait_motion_check event'
);
select throws_ok(
  $$select public.record_ai_usage_event_detailed(
    'motion:6a000000-0000-4000-8000-0000000000a1:9', null,
    '2a000000-0000-4000-8000-000000000001', '1a000000-0000-4000-8000-000000000001',
    'portrait_motion_bogus', 'gpt-image-2.6-flare', true)$$,
  '23514', null, 'the ledger still rejects unknown operations'
);
select is(
  (select count(*) from public.ai_image_generation_requests where family_id = '2a000000-0000-4000-8000-000000000001'),
  (select n from motion_request_count),
  'motion events never create image-generation reservations (not counted toward caps)'
);
select is(
  (select count(*) from public.ai_usage_events where family_id = '2a000000-0000-4000-8000-000000000001' and operation in ('portrait_motion', 'portrait_motion_check') and usage_request_id is null),
  2::bigint,
  'motion events are family-attributed telemetry with no usage request'
);

select * from finish();
rollback;
