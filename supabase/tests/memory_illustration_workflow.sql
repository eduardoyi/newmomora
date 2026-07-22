begin;

select plan(17);

insert into auth.users (id, email)
values ('12000000-0000-4000-8000-000000000001', 'workflow-db@example.test');

insert into public.families (id, name, owner_id)
values ('22000000-0000-4000-8000-000000000001', 'Workflow DB test', '12000000-0000-4000-8000-000000000001');

insert into public.family_memberships (id, family_id, user_id, role)
values ('32000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001', 'owner');

insert into public.memories (
  id, family_id, user_id, content, memory_type, illustration_status
) values (
  '42000000-0000-4000-8000-000000000001',
  '22000000-0000-4000-8000-000000000001',
  '12000000-0000-4000-8000-000000000001',
  'Never dispatched pending memory', 'text_illustration', 'pending'
);

select ok(
  (select illustration_generation_started_at is not null from public.memories where id = '42000000-0000-4000-8000-000000000001'),
  'never-dispatched pending rows receive a dedicated recovery clock'
);

update public.memories
set illustration_status = 'generating',
    illustration_generation_attempt_id = '52000000-0000-4000-8000-000000000001',
    illustration_generation_started_at = now()
where id = '42000000-0000-4000-8000-000000000001';

insert into public.memory_illustration_jobs (
  id, workflow_instance_id, memory_id, family_id, attempt_id, request_intent,
  provider_deadline_at, color_palette, memory_date, output_key, old_illustration_key,
  illustration_prompt
) values (
  '52000000-0000-4000-8000-000000000001',
  '52000000-0000-4000-8000-000000000001',
  '42000000-0000-4000-8000-000000000001',
  '22000000-0000-4000-8000-000000000001',
  '52000000-0000-4000-8000-000000000001', 'initial',
  now() + interval '5 minutes', 'Tender', current_date,
  'test/new.webp', 'test/old.webp', 'safe stored prompt'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '12000000-0000-4000-8000-000000000001', true);
select is_empty(
  'select * from public.memory_illustration_jobs',
  'authenticated clients cannot read private workflow jobs through RLS'
);
set local role postgres;

select is(public.reserve_memory_illustration_provider_attempt('52000000-0000-4000-8000-000000000001', 'primary', 1::smallint), true, 'first primary reservation succeeds');
select is(public.reserve_memory_illustration_provider_attempt('52000000-0000-4000-8000-000000000001', 'primary', 1::smallint), true, 'primary reservation replay is idempotent');
select is(public.reserve_memory_illustration_provider_attempt('52000000-0000-4000-8000-000000000001', 'primary', 2::smallint), true, 'second primary reservation succeeds');
select is(public.reserve_memory_illustration_provider_attempt('52000000-0000-4000-8000-000000000001', 'primary', 2::smallint), true, 'second primary reservation replay is idempotent');
select is(public.reserve_memory_illustration_provider_attempt('52000000-0000-4000-8000-000000000001', 'fallback', 1::smallint), true, 'one fallback reservation succeeds');
select is(public.reserve_memory_illustration_provider_attempt('52000000-0000-4000-8000-000000000001', 'fallback', 1::smallint), true, 'fallback reservation replay is idempotent');
select throws_ok(
  $$select public.reserve_memory_illustration_provider_attempt('52000000-0000-4000-8000-000000000001', null, 1::smallint)$$,
  'P0001', 'invalid provider', 'reserve RPC rejects a null provider'
);

-- A legacy client can set pending, but it must not discard the attempt token
-- or block a completed Workflow publication.
update public.memories set illustration_status = 'pending'
where id = '42000000-0000-4000-8000-000000000001';

create temporary table first_publish as
select * from public.publish_memory_illustration_workflow_job(
  '52000000-0000-4000-8000-000000000001', 'gpt-image-2'
);

select is((select published from first_publish), true, 'attempt-id publish succeeds despite legacy status reset');
select is((select illustration_status from public.memories where id = '42000000-0000-4000-8000-000000000001'), 'ready', 'publish restores ready state');
select is((select illustration_key from public.memories where id = '42000000-0000-4000-8000-000000000001'), 'test/new.webp', 'publish swaps output key');
select is((select old_key from public.publish_memory_illustration_workflow_job('52000000-0000-4000-8000-000000000001', 'gpt-image-2')), 'test/old.webp', 'idempotent publish replay retains old key for cleanup');

insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, illustration_generation_attempt_id)
values ('42000000-0000-4000-8000-000000000002', '22000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001', 'Edited while running', 'text_illustration', 'generating', '52000000-0000-4000-8000-000000000003');
insert into public.memory_illustration_jobs (id, workflow_instance_id, memory_id, family_id, attempt_id, request_intent, provider_deadline_at, color_palette, memory_date, output_key, illustration_prompt)
values ('52000000-0000-4000-8000-000000000002', '52000000-0000-4000-8000-000000000002', '42000000-0000-4000-8000-000000000002', '22000000-0000-4000-8000-000000000001', '52000000-0000-4000-8000-000000000002', 'recovery', now() + interval '5 minutes', 'Tender', current_date, 'test/superseded.webp', 'old prompt');

select is((select published from public.publish_memory_illustration_workflow_job('52000000-0000-4000-8000-000000000002', 'gpt-image-2')), false, 'token mismatch cannot publish a stale image');
select is((select status from public.memory_illustration_jobs where id = '52000000-0000-4000-8000-000000000002'), 'superseded', 'token mismatch marks job superseded');

insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, illustration_key, illustration_generation_id, illustration_generation_attempt_id)
values ('42000000-0000-4000-8000-000000000003', '22000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001', 'Retained image retry', 'text_illustration', 'generating', 'test/retained.webp', '52000000-0000-4000-8000-000000000004', '52000000-0000-4000-8000-000000000003');
insert into public.memory_illustration_jobs (id, workflow_instance_id, memory_id, family_id, attempt_id, request_intent, provider_deadline_at, color_palette, memory_date, output_key)
values ('52000000-0000-4000-8000-000000000003', '52000000-0000-4000-8000-000000000003', '42000000-0000-4000-8000-000000000003', '22000000-0000-4000-8000-000000000001', '52000000-0000-4000-8000-000000000003', 'recovery', now() + interval '5 minutes', 'Tender', current_date, 'test/failed.webp');

select * from public.fail_memory_illustration_workflow_job('52000000-0000-4000-8000-000000000003', 'GENERATION_TIMEOUT');
select is((select illustration_status from public.memories where id = '42000000-0000-4000-8000-000000000003'), 'ready', 'failure restores retained illustration to ready');
select * from public.fail_memory_illustration_workflow_job('52000000-0000-4000-8000-000000000003', 'GENERATION_TIMEOUT');
select is((select status from public.memory_illustration_jobs where id = '52000000-0000-4000-8000-000000000003'), 'failed', 'failure replay preserves the terminal failed status');

select * from finish();
rollback;
