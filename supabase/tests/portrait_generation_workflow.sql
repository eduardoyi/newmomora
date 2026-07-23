begin;

select plan(55);

insert into auth.users (id, email)
values ('13000000-0000-4000-8000-000000000001', 'portrait-workflow-db@example.test');

insert into public.families (id, name, owner_id)
values ('23000000-0000-4000-8000-000000000001', 'Portrait Workflow DB test', '13000000-0000-4000-8000-000000000001');

insert into public.family_memberships (id, family_id, user_id, role)
values ('33000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-000000000001', 'owner');

insert into public.family_members (id, family_id, user_id, name, date_of_birth)
values ('43000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-000000000001', 'Portrait test child', date '2024-01-01');

insert into public.family_member_portrait_versions (
  id, family_id, family_member_id, user_id, reference_date, date_source,
  profile_picture_key, illustrated_profile_key, illustrated_profile_status,
  generation_token, generation_started_at, generation_output_key
) values (
  '53000000-0000-4000-8000-000000000001',
  '23000000-0000-4000-8000-000000000001',
  '43000000-0000-4000-8000-000000000001',
  '13000000-0000-4000-8000-000000000001', date '2026-07-20', 'manual',
  '13000000-0000-4000-8000-000000000001/family/43000000-0000-4000-8000-000000000001/portraits/53000000-0000-4000-8000-000000000001/photo.jpg',
  'old/ready.webp', 'ready',
  '63000000-0000-4000-8000-000000000001', now() - interval '5 minutes 29 seconds', 'old/inflight.webp'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '13000000-0000-4000-8000-000000000001', true);
select is_empty('select * from public.portrait_generation_jobs', 'authenticated clients cannot read private portrait workflow jobs');
select is_empty('select * from public.portrait_generation_workflow_bridge_nonces', 'authenticated clients cannot read private portrait bridge nonces');
select ok(not has_function_privilege('authenticated', 'public.reserve_portrait_generation_provider_attempt(uuid,text,smallint)', 'EXECUTE'), 'authenticated cannot reserve provider attempts');
select ok(not has_function_privilege('authenticated', 'public.publish_portrait_generation_workflow_job(uuid,text)', 'EXECUTE'), 'authenticated cannot publish portrait workflow jobs');
select throws_ok(
  $$insert into public.portrait_generation_jobs (
    id, workflow_instance_id, portrait_version_id, family_id, attempt_id,
    request_intent, provider_deadline_at, output_key
  ) values (
    '63000000-0000-4000-8000-000000000009',
    '63000000-0000-4000-8000-000000000009',
    '53000000-0000-4000-8000-000000000001',
    '23000000-0000-4000-8000-000000000001',
    '63000000-0000-4000-8000-000000000009',
    'initial', now() + interval '5 minutes', 'forbidden/client.webp'
  )$$,
  '42501', 'new row violates row-level security policy for table "portrait_generation_jobs"',
  'authenticated clients cannot insert private portrait workflow jobs'
);
set local role postgres;
select ok(has_function_privilege('service_role', 'public.reserve_portrait_generation_provider_attempt(uuid,text,smallint)', 'EXECUTE'), 'service role can reserve portrait provider attempts');

select throws_ok(
  $$select public.claim_family_member_portrait_generation(
    '53000000-0000-4000-8000-000000000001',
    '63000000-0000-4000-8000-000000000002',
    '13000000-0000-4000-8000-000000000001/family/43000000-0000-4000-8000-000000000001/portraits/53000000-0000-4000-8000-000000000001/portrait/63000000-0000-4000-8000-000000000002.webp',
    '13000000-0000-4000-8000-000000000001'
  )$$,
  '55000', 'Portrait generation already in progress',
  'a claim remains fresh through the 5:30 recovery boundary'
);

update public.family_member_portrait_versions
set generation_started_at = now() - interval '5 minutes 31 seconds'
where id = '53000000-0000-4000-8000-000000000001';

select lives_ok(
  $$select public.claim_family_member_portrait_generation(
    '53000000-0000-4000-8000-000000000001',
    '63000000-0000-4000-8000-000000000002',
    '13000000-0000-4000-8000-000000000001/family/43000000-0000-4000-8000-000000000001/portraits/53000000-0000-4000-8000-000000000001/portrait/63000000-0000-4000-8000-000000000002.webp',
    '13000000-0000-4000-8000-000000000001'
  )$$,
  'a stale claim is reclaimed after 5:30'
);
select is((select illustrated_profile_status from public.family_member_portrait_versions where id = '53000000-0000-4000-8000-000000000001'), 'ready', 'reclaim retains an existing ready portrait');
select is((select illustrated_profile_key from public.family_member_portrait_versions where id = '53000000-0000-4000-8000-000000000001'), 'old/ready.webp', 'reclaim never clears the published portrait key');

insert into public.portrait_generation_jobs (
  id, workflow_instance_id, portrait_version_id, family_id, actor_user_id,
  attempt_id, request_intent, provider_deadline_at, source_photo_key,
  style_reference_key, portrait_prompt, output_key, old_portrait_key
) values (
  '63000000-0000-4000-8000-000000000002',
  '63000000-0000-4000-8000-000000000002',
  '53000000-0000-4000-8000-000000000001',
  '23000000-0000-4000-8000-000000000001',
  '13000000-0000-4000-8000-000000000001',
  '63000000-0000-4000-8000-000000000002', 'recovery', now() + interval '5 minutes',
  'private/source.jpg', '_assets/styles/default.png', 'private prompt',
  '13000000-0000-4000-8000-000000000001/family/43000000-0000-4000-8000-000000000001/portraits/53000000-0000-4000-8000-000000000001/portrait/63000000-0000-4000-8000-000000000002.webp',
  'old/ready.webp'
);

select is(public.reserve_portrait_generation_provider_attempt('63000000-0000-4000-8000-000000000002', 'primary', 1::smallint), true, 'first primary reservation succeeds');
select is(public.reserve_portrait_generation_provider_attempt('63000000-0000-4000-8000-000000000002', 'primary', 1::smallint), false, 'replayed primary reservation fails closed against a second paid call');
select is(public.reserve_portrait_generation_provider_attempt('63000000-0000-4000-8000-000000000002', 'fallback', 1::smallint), true, 'one fallback reservation succeeds');
select is(public.reserve_portrait_generation_provider_attempt('63000000-0000-4000-8000-000000000002', 'fallback', 1::smallint), false, 'replayed fallback reservation fails closed');
select is((select status from public.portrait_generation_jobs where id = '63000000-0000-4000-8000-000000000002'), 'running', 'reservation marks the durable job running');

select throws_ok(
  $$select public.publish_portrait_generation_workflow_job(
    '63000000-0000-4000-8000-000000000002', 'gpt-image-2'
  )$$,
  '55000', 'portrait upload has not completed',
  'portrait publication cannot bypass the exact output upload lease'
);

create temporary table portrait_upload_authorization as
select * from public.authorize_portrait_generation_workflow_upload(
  '63000000-0000-4000-8000-000000000002',
  '13000000-0000-4000-8000-000000000001/family/43000000-0000-4000-8000-000000000001/portraits/53000000-0000-4000-8000-000000000001/portrait/63000000-0000-4000-8000-000000000002.webp'
);
select is((select authorized from portrait_upload_authorization), true, 'portrait upload authorization accepts the current deterministic output');
select is((select existing_lease from portrait_upload_authorization), false, 'first portrait upload authorization creates a lease');
select ok((select upload_token is not null from portrait_upload_authorization), 'portrait upload authorization returns an exact token');

create temporary table portrait_upload_replay as
select * from public.authorize_portrait_generation_workflow_upload(
  '63000000-0000-4000-8000-000000000002',
  '13000000-0000-4000-8000-000000000001/family/43000000-0000-4000-8000-000000000001/portraits/53000000-0000-4000-8000-000000000001/portrait/63000000-0000-4000-8000-000000000002.webp'
);
select is((select upload_token from portrait_upload_replay), (select upload_token from portrait_upload_authorization), 'portrait upload replay reuses the exact in-flight token');
select is((select existing_lease from portrait_upload_replay), true, 'portrait upload replay reports the existing lease');
select is(
  public.record_portrait_generation_workflow_upload_complete(
    '63000000-0000-4000-8000-000000000002',
    '13000000-0000-4000-8000-000000000001/family/43000000-0000-4000-8000-000000000001/portraits/53000000-0000-4000-8000-000000000001/portrait/63000000-0000-4000-8000-000000000002.webp',
    '73000000-0000-4000-8000-000000000002'
  ),
  false,
  'portrait upload completion rejects a different token'
);
select is(
  public.record_portrait_generation_workflow_upload_complete(
    '63000000-0000-4000-8000-000000000002',
    '13000000-0000-4000-8000-000000000001/family/43000000-0000-4000-8000-000000000001/portraits/53000000-0000-4000-8000-000000000001/portrait/63000000-0000-4000-8000-000000000002.webp',
    (select upload_token from portrait_upload_authorization)
  ),
  true,
  'portrait upload completion records the exact token'
);
select is(
  public.record_portrait_generation_workflow_upload_complete(
    '63000000-0000-4000-8000-000000000002',
    '13000000-0000-4000-8000-000000000001/family/43000000-0000-4000-8000-000000000001/portraits/53000000-0000-4000-8000-000000000001/portrait/63000000-0000-4000-8000-000000000002.webp',
    (select upload_token from portrait_upload_authorization)
  ),
  true,
  'portrait upload completion is idempotent for a lost bridge response'
);

create temporary table publish_result as
select * from public.publish_portrait_generation_workflow_job('63000000-0000-4000-8000-000000000002', 'gpt-image-2');
select is((select published from publish_result), true, 'matching token publication succeeds');
select is((select illustrated_profile_key from public.family_member_portrait_versions where id = '53000000-0000-4000-8000-000000000001'),
  '13000000-0000-4000-8000-000000000001/family/43000000-0000-4000-8000-000000000001/portraits/53000000-0000-4000-8000-000000000001/portrait/63000000-0000-4000-8000-000000000002.webp',
  'publish swaps the portrait pointer');
select is((select source_photo_key is null and style_reference_key is null and portrait_prompt is null from public.portrait_generation_jobs where id = '63000000-0000-4000-8000-000000000002')::text, 'true', 'successful publication scrubs private input');
select is((select already_published from public.reconcile_portrait_generation_workflow_job('63000000-0000-4000-8000-000000000002', 'gpt-image-2')), true, 'reconcile replay reports the already published portrait as success');

insert into public.family_member_portrait_versions (
  id, family_id, family_member_id, user_id, reference_date, date_source,
  profile_picture_key, illustrated_profile_key, illustrated_profile_status,
  generation_token, generation_started_at, generation_output_key
) values (
  '53000000-0000-4000-8000-000000000003',
  '23000000-0000-4000-8000-000000000001',
  '43000000-0000-4000-8000-000000000001',
  '13000000-0000-4000-8000-000000000001', date '2026-07-21', 'manual',
  '13000000-0000-4000-8000-000000000001/family/43000000-0000-4000-8000-000000000001/portraits/53000000-0000-4000-8000-000000000003/photo.jpg',
  'retained/portrait.webp', 'ready',
  '63000000-0000-4000-8000-000000000003', now(), 'failed/new.webp'
);
insert into public.portrait_generation_jobs (
  id, workflow_instance_id, portrait_version_id, family_id, attempt_id, request_intent,
  provider_deadline_at, source_photo_key, style_reference_key, portrait_prompt, output_key, old_portrait_key
) values (
  '63000000-0000-4000-8000-000000000003', '63000000-0000-4000-8000-000000000003',
  '53000000-0000-4000-8000-000000000003', '23000000-0000-4000-8000-000000000001',
  '63000000-0000-4000-8000-000000000003', 'manual_regenerate', now() + interval '5 minutes',
  'private/source.jpg', '_assets/styles/default.png', 'private prompt', 'failed/new.webp', 'retained/portrait.webp'
);
select is((select terminal_status from public.fail_portrait_generation_workflow_job('63000000-0000-4000-8000-000000000003', 'PROVIDER_TIMEOUT')), 'failed', 'current attempt failure is terminal failed');
select is((select illustrated_profile_status from public.family_member_portrait_versions where id = '53000000-0000-4000-8000-000000000003'), 'ready', 'failed regeneration retains ready status');
select is((select illustrated_profile_key from public.family_member_portrait_versions where id = '53000000-0000-4000-8000-000000000003'), 'retained/portrait.webp', 'failed regeneration retains prior object');
select is((select source_photo_key is null and style_reference_key is null and portrait_prompt is null from public.portrait_generation_jobs where id = '63000000-0000-4000-8000-000000000003')::text, 'true', 'failure scrubs private input');

-- A portrait deletion claim wins over a late workflow publication. The stale
-- job is superseded and scrubbed; it cannot resurrect a deleting version.
insert into public.family_member_portrait_versions (
  id, family_id, family_member_id, user_id, reference_date, date_source,
  profile_picture_key, illustrated_profile_status, generation_token,
  generation_started_at, generation_output_key, deletion_token, deletion_started_at
) values (
  '53000000-0000-4000-8000-000000000004',
  '23000000-0000-4000-8000-000000000001',
  '43000000-0000-4000-8000-000000000001',
  '13000000-0000-4000-8000-000000000001', date '2026-07-22', 'manual',
  '13000000-0000-4000-8000-000000000001/family/43000000-0000-4000-8000-000000000001/portraits/53000000-0000-4000-8000-000000000004/photo.jpg',
  'generating', '63000000-0000-4000-8000-000000000004', now(), 'deleted/new.webp',
  '73000000-0000-4000-8000-000000000004', now()
);
insert into public.portrait_generation_jobs (
  id, workflow_instance_id, portrait_version_id, family_id, attempt_id, request_intent,
  provider_deadline_at, source_photo_key, style_reference_key, portrait_prompt, output_key
) values (
  '63000000-0000-4000-8000-000000000004', '63000000-0000-4000-8000-000000000004',
  '53000000-0000-4000-8000-000000000004', '23000000-0000-4000-8000-000000000001',
  '63000000-0000-4000-8000-000000000004', 'initial', now() + interval '5 minutes',
  'private/source.jpg', '_assets/styles/default.png', 'private prompt', 'deleted/new.webp'
);
select is((select published from public.publish_portrait_generation_workflow_job('63000000-0000-4000-8000-000000000004', 'gpt-image-2')), false, 'deletion token rejects stale publication');
select is((select status from public.portrait_generation_jobs where id = '63000000-0000-4000-8000-000000000004'), 'superseded', 'deletion race marks job superseded');
select is((select source_photo_key is null and style_reference_key is null and portrait_prompt is null from public.portrait_generation_jobs where id = '63000000-0000-4000-8000-000000000004')::text, 'true', 'deletion-race supersession scrubs private input');

insert into public.family_member_portrait_versions (
  id, family_id, family_member_id, user_id, reference_date, date_source,
  profile_picture_key, illustrated_profile_status, generation_token,
  generation_started_at, generation_output_key
) values (
  '53000000-0000-4000-8000-000000000005',
  '23000000-0000-4000-8000-000000000001',
  '43000000-0000-4000-8000-000000000001',
  '13000000-0000-4000-8000-000000000001', date '2026-07-19', 'manual',
  '13000000-0000-4000-8000-000000000001/family/43000000-0000-4000-8000-000000000001/portraits/53000000-0000-4000-8000-000000000005/photo.jpg',
  'generating', '63000000-0000-4000-8000-000000000005', now(), 'superseded/new.webp'
);
insert into public.portrait_generation_jobs (
  id, workflow_instance_id, portrait_version_id, family_id, attempt_id, request_intent,
  provider_deadline_at, source_photo_key, style_reference_key, portrait_prompt, output_key
) values (
  '63000000-0000-4000-8000-000000000005', '63000000-0000-4000-8000-000000000005',
  '53000000-0000-4000-8000-000000000005', '23000000-0000-4000-8000-000000000001',
  '63000000-0000-4000-8000-000000000005', 'initial', now() + interval '5 minutes',
  'private/source.jpg', '_assets/styles/default.png', 'private prompt', 'superseded/new.webp'
);
select is(public.supersede_portrait_generation_workflow_jobs('53000000-0000-4000-8000-000000000005', '63000000-0000-4000-8000-000000000006'), 1, 'supersede atomically retires an older active job');
select is((select source_photo_key is null and style_reference_key is null and portrait_prompt is null from public.portrait_generation_jobs where id = '63000000-0000-4000-8000-000000000005')::text, 'true', 'explicit supersession scrubs private input');

-- Whole-member cleanup must fence uploads before prefix enumeration. Fresh
-- work defers; stale work is superseded and can no longer complete through
-- either the legacy finish/fail RPCs or the durable bridge CAS.
insert into public.family_members (id, family_id, user_id, name, date_of_birth)
values ('43000000-0000-4000-8000-000000000006', '23000000-0000-4000-8000-000000000001', '13000000-0000-4000-8000-000000000001', 'Fence test child', date '2024-01-01');
insert into public.family_member_portrait_versions (
  id, family_id, family_member_id, user_id, reference_date, date_source,
  profile_picture_key, illustrated_profile_status, generation_token,
  generation_started_at, generation_output_key
) values (
  '53000000-0000-4000-8000-000000000006',
  '23000000-0000-4000-8000-000000000001',
  '43000000-0000-4000-8000-000000000006',
  '13000000-0000-4000-8000-000000000001', date '2026-07-22', 'manual',
  '13000000-0000-4000-8000-000000000001/family/43000000-0000-4000-8000-000000000006/portraits/53000000-0000-4000-8000-000000000006/photo.jpg',
  'generating', '63000000-0000-4000-8000-000000000006', now(),
  '13000000-0000-4000-8000-000000000001/family/43000000-0000-4000-8000-000000000006/portraits/53000000-0000-4000-8000-000000000006/portrait/63000000-0000-4000-8000-000000000006.webp'
);
select throws_ok(
  $$select public.finish_family_member_portrait_generation(
    '53000000-0000-4000-8000-000000000006',
    '63000000-0000-4000-8000-000000000006',
    'wrong/output.webp'
  )$$,
  '55000', 'Portrait generation claim lost',
  'legacy finish retains the deterministic output-key CAS'
);
select throws_ok(
  $$select public.claim_family_member_deletion_fence(
    '43000000-0000-4000-8000-000000000006',
    '73000000-0000-4000-8000-000000000006'
  )$$,
  '55000', 'Fresh portrait generation is still active',
  'fresh portrait work blocks member deletion before storage cleanup'
);
update public.family_member_portrait_versions
set generation_started_at = now() - interval '5 minutes 31 seconds'
where id = '53000000-0000-4000-8000-000000000006';
insert into public.portrait_generation_jobs (
  id, workflow_instance_id, portrait_version_id, family_id, attempt_id,
  request_intent, started_at, provider_deadline_at, output_key,
  upload_token, upload_started_at
) values (
  '63000000-0000-4000-8000-000000000006',
  '63000000-0000-4000-8000-000000000006',
  '53000000-0000-4000-8000-000000000006',
  '23000000-0000-4000-8000-000000000001',
  '63000000-0000-4000-8000-000000000006',
  'initial', now() - interval '5 minutes 31 seconds', now() + interval '5 minutes',
  '13000000-0000-4000-8000-000000000001/family/43000000-0000-4000-8000-000000000006/portraits/53000000-0000-4000-8000-000000000006/portrait/63000000-0000-4000-8000-000000000006.webp',
  '83000000-0000-4000-8000-000000000006', now()
);
select throws_ok(
  $$select public.claim_family_member_deletion_fence(
    '43000000-0000-4000-8000-000000000006',
    '73000000-0000-4000-8000-000000000006'
  )$$,
  '55000', 'Fresh portrait generation is still active',
  'a fresh exact upload lease blocks member deletion after its generation lease is stale'
);
update public.portrait_generation_jobs
set upload_started_at = now() - interval '5 minutes 31 seconds'
where id = '63000000-0000-4000-8000-000000000006';
select is(public.claim_family_member_deletion_fence(
  '43000000-0000-4000-8000-000000000006',
  '73000000-0000-4000-8000-000000000006'
), true, 'service-only member fence claim succeeds with the authenticated request sub still populated');
select is((select deletion_fence_token::text from public.family_members where id = '43000000-0000-4000-8000-000000000006'), '73000000-0000-4000-8000-000000000006', 'member fence is stored before R2 enumeration');
select throws_ok(
  $$select public.finish_family_member_portrait_generation(
    '53000000-0000-4000-8000-000000000006',
    '63000000-0000-4000-8000-000000000006',
    '13000000-0000-4000-8000-000000000001/family/43000000-0000-4000-8000-000000000006/portraits/53000000-0000-4000-8000-000000000006/portrait/63000000-0000-4000-8000-000000000006.webp'
  )$$,
  '55000', 'Portrait generation claim lost',
  'member fence rejects a late legacy finish'
);
select throws_ok(
  $$select public.fail_family_member_portrait_generation(
    '53000000-0000-4000-8000-000000000006',
    '63000000-0000-4000-8000-000000000006'
  )$$,
  '55000', 'Portrait generation claim lost',
  'member fence rejects a late legacy failure mutation'
);
select is(public.release_family_member_deletion_fence(
  '43000000-0000-4000-8000-000000000006',
  '73000000-0000-4000-8000-000000000006'
), true, 'storage failure can release exactly the claimed member fence');

-- The preceding cases intentionally leave historical portrait rows in
-- various terminal/deletion states. Clear their stale public claim markers
-- before exercising the independent family-memory fence below; otherwise a
-- fresh fixture from an earlier case, not this memory, would correctly defer
-- the family claim and obscure the memory-specific assertion.
update public.family_member_portrait_versions
set generation_token = null,
    generation_started_at = null,
    generation_output_key = null,
    deletion_token = null,
    deletion_started_at = null
where family_id = '23000000-0000-4000-8000-000000000001';

insert into public.memories (
  id, user_id, family_id, content, memory_date, memory_type,
  illustration_status, illustration_generation_attempt_id,
  illustration_generation_started_at
) values (
  '83000000-0000-4000-8000-000000000006',
  '13000000-0000-4000-8000-000000000001',
  '23000000-0000-4000-8000-000000000001', 'Fence memory', date '2026-07-22',
  'text_illustration', 'generating', '93000000-0000-4000-8000-000000000006', now()
);
select throws_ok(
  $$select public.claim_family_deletion_fence(
    '23000000-0000-4000-8000-000000000001',
    'a3000000-0000-4000-8000-000000000006'
  )$$,
  '55000', 'Fresh illustration generation is still active',
  'fresh memory work defers account purge before R2 cleanup'
);
update public.memories
set illustration_generation_started_at = now() - interval '5 minutes 31 seconds'
where id = '83000000-0000-4000-8000-000000000006';
select is(public.claim_family_deletion_fence(
  '23000000-0000-4000-8000-000000000001',
  'a3000000-0000-4000-8000-000000000006'
), true, 'stale memory work is fenced for account purge');
select is((select deletion_fence_token::text from public.families where id = '23000000-0000-4000-8000-000000000001'), 'a3000000-0000-4000-8000-000000000006', 'family fence is stored before account R2 cleanup');
select is((select illustration_generation_attempt_id is null from public.memories where id = '83000000-0000-4000-8000-000000000006')::text, 'true', 'family fence clears the memory publication CAS');
select throws_ok(
  $$update public.memories
    set illustration_status = 'generating',
        illustration_generation_attempt_id = 'b3000000-0000-4000-8000-000000000006',
        illustration_generation_started_at = now()
    where id = '83000000-0000-4000-8000-000000000006'$$,
  '55000', 'Family deletion is in progress',
  'family fence blocks a new memory generation claim during cleanup'
);
select is(public.release_family_deletion_fence(
  '23000000-0000-4000-8000-000000000001',
  'a3000000-0000-4000-8000-000000000006'
), true, 'storage failure can release exactly the claimed family fence');

set local role authenticated;
select set_config('request.jwt.claim.sub', '13000000-0000-4000-8000-000000000001', true);
select throws_ok(
  $$update public.family_members
    set deletion_fence_token = 'c3000000-0000-4000-8000-000000000006'
    where id = '43000000-0000-4000-8000-000000000006'$$,
  '42501', 'Deletion fence fields are service-managed',
  'authenticated clients cannot set a member deletion fence'
);
set local role postgres;

-- A crashed cleanup lease is recoverable after ten minutes, but a fresh one
-- cannot be stolen. The exact replacement token is what later R2 cleanup
-- and finalization must present.
update public.family_members
set deletion_fence_token = 'd3000000-0000-4000-8000-000000000006',
    deletion_fence_started_at = now()
where id = '43000000-0000-4000-8000-000000000006';
update public.family_member_portrait_versions
set deletion_token = 'd3000000-0000-4000-8000-000000000006',
    deletion_started_at = now()
where family_member_id = '43000000-0000-4000-8000-000000000006';
select throws_ok(
  $$select public.claim_family_member_deletion_fence(
    '43000000-0000-4000-8000-000000000006',
    'e3000000-0000-4000-8000-000000000006'
  )$$,
  '55000', 'Family member deletion already in progress',
  'a fresh member deletion fence refuses takeover'
);
update public.family_members
set deletion_fence_started_at = now() - interval '10 minutes 1 second'
where id = '43000000-0000-4000-8000-000000000006';
select is(public.claim_family_member_deletion_fence(
  '43000000-0000-4000-8000-000000000006',
  'e3000000-0000-4000-8000-000000000006'
), true, 'a stale member deletion fence is reclaimed after ten minutes');
select is(
  (select deletion_fence_token::text from public.family_members where id = '43000000-0000-4000-8000-000000000006'),
  'e3000000-0000-4000-8000-000000000006',
  'stale recovery installs the new exact member fence token'
);
select public.release_family_member_deletion_fence(
  '43000000-0000-4000-8000-000000000006',
  'e3000000-0000-4000-8000-000000000006'
);

select * from finish();
rollback;
