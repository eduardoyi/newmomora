begin;

-- Production invariants that are awkward to express in the basic quota-boundary
-- fixture.  This suite intentionally uses service/database setup and rolls the
-- complete fixture back; no global settings survive it.
select plan(42);

insert into auth.users (id, email) values
  ('b1000000-0000-4000-8000-000000000001', 'usage-invariants@example.test');
insert into public.families (id, name, owner_id) values
  ('b2000000-0000-4000-8000-000000000001', 'Usage invariants', 'b1000000-0000-4000-8000-000000000001');
insert into public.family_memberships (id, family_id, user_id, role) values
  ('b3000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'owner');
insert into public.family_members (id, family_id, user_id, name, date_of_birth) values
  ('b3500000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'Child', date '2024-01-01');
insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status) values
  ('b4000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'One', 'text_illustration', 'pending'),
  ('b4000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'Two', 'text_illustration', 'pending'),
  ('b4000000-0000-4000-8000-000000000003', 'b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'Activation handoff', 'text_illustration', 'pending');
insert into public.family_member_portrait_versions (
  id, family_id, family_member_id, user_id, reference_date, date_source, profile_picture_key
) values (
  'b4500000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'b3500000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', current_date, 'manual', 'b1000000-0000-4000-8000-000000000001/family/b3500000-0000-4000-8000-000000000001/portraits/b4500000-0000-4000-8000-000000000001/photo.jpg'
);
update public.ai_usage_settings set enforcement_enabled=true, enforcement_activated_at=now(), image_requests_per_family_per_day=20, image_requests_per_family_per_month=100, manual_regenerations_per_memory_per_day=1;
select is((select alert_policy_version::text from public.ai_usage_settings), '1', 'quota activation does not change alert-policy version');
update public.ai_usage_settings set family_request_alert_fraction=0.500;
select is((select alert_policy_version::text from public.ai_usage_settings), '2', 'dynamic alert threshold increments alert-policy version');
select is((select quota_policy_epoch::text from public.ai_usage_settings), '2', 'alert threshold change does not reset quota epoch');

create temporary table prep_one as select * from public.begin_memory_illustration_usage(
  'b4000000-0000-4000-8000-000000000001', 'initial', 'b5000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001'
);
select ok((select preparation_input_updated_at is not null from prep_one), 'admission returns an input snapshot');
select is((select public.record_ai_memory_preparation_emotion((select request_id from prep_one), (select preparation_token from prep_one), 99, (select preparation_input_updated_at from prep_one), 'joy')), false, 'stale preparation ordinal cannot write emotion');
select is((select public.release_ai_image_preparation((select request_id from prep_one), (select preparation_token from prep_one), (select preparation_ordinal from prep_one), now() - interval '1 second', 'test')), false, 'stale preparation snapshot cannot release');
select is((select public.promote_ai_image_preparation((select request_id from prep_one), (select preparation_token from prep_one), 99, (select preparation_input_updated_at from prep_one), null)), false, 'stale preparation ordinal cannot promote');

update public.memories set content='edited' where id='b4000000-0000-4000-8000-000000000001';
select is((select state from public.ai_image_generation_requests where id=(select request_id from prep_one)), 'cancelled', 'content edit releases an unconsumed preparation');

create temporary table prep_two as select * from public.begin_memory_illustration_usage(
  'b4000000-0000-4000-8000-000000000002', 'initial', 'b5000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000001'
);
insert into public.memory_family_members (memory_id, family_member_id) values ('b4000000-0000-4000-8000-000000000002', 'b3500000-0000-4000-8000-000000000001');
select is((select state from public.ai_image_generation_requests where id=(select request_id from prep_two)), 'cancelled', 'tag edit releases an unconsumed preparation');

create temporary table queued_prep as select * from public.begin_memory_illustration_usage(
  'b4000000-0000-4000-8000-000000000002', 'initial', 'b5000000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-000000000001'
);
insert into public.memory_illustration_jobs (
  id, workflow_instance_id, memory_id, family_id, attempt_id, request_intent, provider_deadline_at, color_palette, memory_date, output_key, usage_request_id, usage_protocol_version
) values (
  'b6000000-0000-4000-8000-000000000001', 'b6000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000001', 'b6000000-0000-4000-8000-000000000001', 'initial', now()+interval '5 minutes', 'warm', current_date, 'test/queued.webp', (select request_id from queued_prep), 2
);
create temporary table queued_result as select * from public.begin_memory_illustration_usage(
  'b4000000-0000-4000-8000-000000000002', 'initial', 'b5000000-0000-4000-8000-000000000004', 'b1000000-0000-4000-8000-000000000001'
);
select is((select outcome from queued_result), 'already_queued', 'active durable job wins over a new admission');
select is((select existing_job_id from queued_result)::text, 'b6000000-0000-4000-8000-000000000001', 'already queued result exposes the durable job id');

select throws_ok(
  $$insert into public.memory_illustration_jobs (id,workflow_instance_id,memory_id,family_id,attempt_id,request_intent,provider_deadline_at,color_palette,memory_date,output_key,usage_request_id,usage_protocol_version) values ('b6000000-0000-4000-8000-000000000002','b6000000-0000-4000-8000-000000000002','b4000000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000001','b6000000-0000-4000-8000-000000000002','initial',now()+interval '5 minutes','warm',current_date,'test/mismatch.webp',(select request_id from queued_prep),2)$$,
  '55000', 'usage request does not match memory job target', 'job stamp rejects request/target mismatch');

select is((select outcome from public.reserve_legacy_ai_image_provider_attempt_v2((select request_id from queued_prep), 'memory', 'b4000000-0000-4000-8000-000000000001', (select preparation_token from queued_prep), (select preparation_ordinal from queued_prep), (select preparation_input_updated_at from queued_prep), 'primary', 1::smallint)), 'denied', 'legacy provider path rejects a wrong target');
select is((select outcome from public.reserve_legacy_ai_image_provider_attempt_v2((select request_id from queued_prep), 'memory', 'b4000000-0000-4000-8000-000000000002', (select preparation_token from queued_prep), (select preparation_ordinal from queued_prep), (select preparation_input_updated_at from queued_prep), 'fallback', 1::smallint)), 'denied', 'legacy provider path cannot call fallback before primary');
select is((select outcome from public.reserve_ai_image_provider_attempt_v2((select request_id from queued_prep), 'memory', 'b6000000-0000-4000-8000-000000000001', 'fallback', 1::smallint)), 'denied', 'fallback cannot be the first provider attempt');
select is((select outcome from public.reserve_ai_image_provider_attempt_v2((select request_id from queued_prep), 'memory', 'b6000000-0000-4000-8000-000000000001', 'primary', 1::smallint)), 'reserved_now', 'job-bound primary provider attempt succeeds');
select is((select outcome from public.reserve_ai_image_provider_attempt_v2((select request_id from queued_prep), 'memory', 'b6000000-0000-4000-8000-000000000001', 'primary', 1::smallint)), 'already_reserved', 'job-bound provider replay is idempotent');
select is((select outcome from public.reserve_ai_image_provider_attempt_v2((select request_id from queued_prep), 'primary', 2::smallint)), 'denied', 'request-only provider compatibility overload is closed after activation');
update public.memory_illustration_jobs set provider_deadline_at=now()-interval '1 second' where id='b6000000-0000-4000-8000-000000000001';
select is((select outcome from public.reserve_ai_image_provider_attempt_v2((select request_id from queued_prep), 'memory', 'b6000000-0000-4000-8000-000000000001', 'fallback', 1::smallint)), 'denied', 'expired durable job deadline blocks a later provider call');
select is(public.ai_usage_limit_scope('b2000000-0000-4000-8000-000000000001', 'portrait_version', 'b4500000-0000-4000-8000-000000000001', 'manual_regenerate', (select s from public.ai_usage_settings s), now()), null, 'portrait manual regeneration does not use the per-memory manual limit');

create temporary table rebucket_prep as select * from public.begin_memory_illustration_usage(
  'b4000000-0000-4000-8000-000000000001', 'initial', 'b5000000-0000-4000-8000-000000000005', 'b1000000-0000-4000-8000-000000000001'
);
insert into public.memory_illustration_jobs (
  id, workflow_instance_id, memory_id, family_id, attempt_id, request_intent, provider_deadline_at, color_palette, memory_date, output_key, usage_request_id, usage_protocol_version
) values (
  'b6000000-0000-4000-8000-000000000003', 'b6000000-0000-4000-8000-000000000003', 'b4000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'b6000000-0000-4000-8000-000000000003', 'initial', now()+interval '5 minutes', 'warm', current_date, 'test/rebucket.webp', (select request_id from rebucket_prep), 2
);
update public.ai_image_generation_admissions
set utc_day=(transaction_timestamp() at time zone 'UTC')::date-1
where request_id=(select request_id from rebucket_prep) and state='active';
select is((select outcome from public.reserve_ai_image_provider_attempt_v2((select request_id from rebucket_prep), 'memory', 'b6000000-0000-4000-8000-000000000003', 'primary', 1::smallint)), 'reserved_now', 'provider-time UTC rebucket admits the paid call under the current day');
select ok(
  (select count(*) from public.ai_image_generation_admissions where request_id=(select request_id from rebucket_prep) and state='released')=1
  and (select count(*) from public.ai_image_generation_admissions where request_id=(select request_id from rebucket_prep) and state='consumed' and utc_day=(transaction_timestamp() at time zone 'UTC')::date)=1,
  'UTC rebucket releases the stale admission and preserves one current consumed admission'
);

select is((select public.record_ai_usage_event((select request_id from queued_prep)::text || ':primary:1', (select request_id from queued_prep), 'memory', 'b6000000-0000-4000-8000-000000000001', 'primary', 1::smallint, 'illustration', 'gpt-image-2', '{}'::jsonb, true, 'known', '2026-07-27', 'provider_usage', true, 0.123456, 10, 0, 0, 20, 30, null)), true, 'canonical Worker ledger event accepts linked deterministic identity');
select is((select pricing_version from public.ai_usage_events where usage_request_id=(select request_id from queued_prep)), '2026-07-27', 'ledger persists pricing version');
select is((select estimated_cost_usd::text from public.ai_usage_events where usage_request_id=(select request_id from queued_prep)), '0.123456', 'ledger persists exact cost');
select ok(exists(select 1 from public.ai_usage_monthly_rollups where family_id='b2000000-0000-4000-8000-000000000001' and calls=1), 'ledger insert updates monthly rollup');
select throws_ok(
  $$select public.record_ai_usage_event('unsafe-id', (select request_id from queued_prep), 'memory', 'b6000000-0000-4000-8000-000000000001', 'primary', 1::smallint, 'illustration', 'gpt-image-2', '{}'::jsonb, true, 'known', 'v1', 'provider_usage', true, 0, 0,0,0,0,0,null)$$,
  '22023', 'invalid deterministic usage event identity', 'unsafe Worker call identity is rejected');

insert into public.ai_usage_alert_outbox (id,environment_id,kind,period_start,policy_version,idempotency_key,status,claim_token)
values ('b7000000-0000-4000-8000-000000000001','test','digest',date_trunc('day',now()),1,'test:unknown','sending','b7000000-0000-4000-8000-000000000001');
select is(public.mark_ai_usage_alert_outbox_delivery_unknown('b7000000-0000-4000-8000-000000000001','b7000000-0000-4000-8000-000000000001'), true, 'ambiguous alert delivery is terminally marked');
select is((select claimed from public.claim_ai_usage_alert_outbox('b7000000-0000-4000-8000-000000000001')), false, 'delivery-unknown alert cannot be auto-redriven');
insert into public.ai_usage_alert_outbox (id,environment_id,kind,period_start,policy_version,idempotency_key,status,attempts)
values ('b7000000-0000-4000-8000-000000000002','test','digest',date_trunc('day',now()),1,'test:exhausted','failed',3);
select is((select claimed from public.claim_ai_usage_alert_outbox('b7000000-0000-4000-8000-000000000002')), false, 'definite alert failures stop after three attempts');
insert into public.ai_usage_alert_outbox (id,environment_id,kind,period_start,policy_version,idempotency_key,status,attempts,claim_started_at)
values ('b7000000-0000-4000-8000-000000000003','test','digest',date_trunc('day',now()),1,'test:stale-sending','sending',0,now()-interval '11 minutes');
select is((select claimed from public.claim_ai_usage_alert_outbox('b7000000-0000-4000-8000-000000000003')), true, 'stale pre-delivery alert claim is safely reclaimed within the attempt bound');

update public.ai_usage_settings set global_unpriced_alert_min_calls=1,global_unpriced_alert_fraction=0.001;
insert into public.ai_usage_events (ai_call_id,family_id,actor_user_id,operation,model,success,cost_basis,created_at)
values ('global-unpriced-test','b2000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','illustration','global-unpriced-test',true,'unpriced',now());
select ok(exists(
  select 1 from public.enqueue_ai_usage_alerts('invariants',now()) o
  where o.family_id is null and o.kind='unpriced'
    and o.payload @> jsonb_build_object('unpricedCalls',1,'imageCalls',2,'threshold',0.001)
), 'dynamic global-unpriced threshold enqueues a privacy-safe aggregate alert');

insert into public.ai_usage_events (ai_call_id,family_id,actor_user_id,operation,model,success,cost_basis,created_at)
values ('retention-rollup-test','b2000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','safety_chat','retention-rollup-test',true,'unpriced',now()-interval '91 days');
create temporary table purge_result as select * from public.purge_expired_ai_usage_data(now());
select is((select events_deleted::text from purge_result), '1', 'retention purges expired detailed usage events');
select ok(exists(
  select 1 from public.family_ai_costs_monthly
  where family_id='b2000000-0000-4000-8000-000000000001' and operation='safety_chat' and model='retention-rollup-test' and calls=1
), 'monthly cost rollup survives detailed-event retention while still in its retention window');

insert into public.ai_usage_limit_notices (family_id,actor_user_id,target_kind,target_id,scope,retry_after,quota_policy_epoch)
values ('b2000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','memory','b4000000-0000-4000-8000-000000000001','daily',now()+interval '1 day',(select quota_policy_epoch from public.ai_usage_settings));

set local role authenticated;
select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000001', true);
select isnt_empty('select * from public.get_my_ai_usage_limit_notices()', 'current member sees its active notice');
set local role postgres;
update public.ai_usage_settings set enforcement_enabled=false;
set local role authenticated;
select is_empty('select * from public.get_my_ai_usage_limit_notices()', 'disabled enforcement hides prior-epoch notices');
set local role postgres;

update public.ai_usage_settings set enforcement_enabled=true, enforcement_activated_at=now();
insert into public.ai_usage_limit_notices (family_id,actor_user_id,target_kind,target_id,scope,retry_after,quota_policy_epoch)
values ('b2000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','memory','b4000000-0000-4000-8000-000000000001','daily',now()+interval '1 day',(select quota_policy_epoch from public.ai_usage_settings));
create function pg_temp.portrait_usage_write_is_blocked() returns boolean
language plpgsql as $$
declare affected integer;
begin
  update public.family_member_portrait_versions
  set usage_limit_scope='daily'
  where id='b4500000-0000-4000-8000-000000000001';
  get diagnostics affected = row_count;
  return affected=0;
exception when insufficient_privilege then
  return true;
end;
$$;
set local role authenticated;
select ok(pg_temp.portrait_usage_write_is_blocked(), 'authenticated callers cannot forge portrait usage metadata');
set local role postgres;
delete from public.family_memberships where id='b3000000-0000-4000-8000-000000000001';
set local role authenticated;
select is_empty('select * from public.get_my_ai_usage_limit_notices()', 'removed membership hides notices even for the originating actor');
set local role postgres;

-- A v1 request that began preparation before the future activation boundary
-- may stamp its service-only job during the one promoted-lease handoff.
update public.ai_usage_settings set enforcement_activated_at=now()-interval '1 minute';
insert into public.memory_illustration_jobs (
  id, workflow_instance_id, memory_id, family_id, attempt_id, request_intent,
  provider_deadline_at, color_palette, memory_date, output_key
) values (
  'b6000000-0000-4000-8000-000000000004', 'b6000000-0000-4000-8000-000000000004', 'b4000000-0000-4000-8000-000000000003', 'b2000000-0000-4000-8000-000000000001', 'b6000000-0000-4000-8000-000000000004', 'initial',
  now()+interval '5 minutes', 'warm', current_date, 'test/activation-v1-memory.webp'
);
select is((select usage_enforcement_required::text from public.memory_illustration_jobs where id='b6000000-0000-4000-8000-000000000004'), 'false', 'v1 memory job is grandfathered during the five-minute activation handoff');
insert into public.portrait_generation_jobs (
  id, workflow_instance_id, portrait_version_id, family_id, attempt_id, request_intent,
  provider_deadline_at, output_key
) values (
  'b6100000-0000-4000-8000-000000000001', 'b6100000-0000-4000-8000-000000000001', 'b4500000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'b6100000-0000-4000-8000-000000000001', 'initial',
  now()+interval '5 minutes', 'test/activation-v1-portrait.webp'
);
select is((select usage_enforcement_required::text from public.portrait_generation_jobs where id='b6100000-0000-4000-8000-000000000001'), 'false', 'v1 portrait job is grandfathered during the five-minute activation handoff');

update public.ai_usage_settings set enforcement_activated_at=now()-interval '6 minutes';
select throws_ok(
  $$insert into public.memory_illustration_jobs (id,workflow_instance_id,memory_id,family_id,attempt_id,request_intent,provider_deadline_at,color_palette,memory_date,output_key) values ('b6000000-0000-4000-8000-000000000005','b6000000-0000-4000-8000-000000000005','b4000000-0000-4000-8000-000000000003','b2000000-0000-4000-8000-000000000001','b6000000-0000-4000-8000-000000000005','initial',now()+interval '5 minutes','warm',current_date,'test/activation-late-memory.webp')$$,
  '55000', 'v2 usage request is required while enforcement is active', 'v1 memory job fails closed after the activation handoff'
);
select throws_ok(
  $$insert into public.portrait_generation_jobs (id,workflow_instance_id,portrait_version_id,family_id,attempt_id,request_intent,provider_deadline_at,output_key) values ('b6100000-0000-4000-8000-000000000002','b6100000-0000-4000-8000-000000000002','b4500000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000001','b6100000-0000-4000-8000-000000000002','initial',now()+interval '5 minutes','test/activation-late-portrait.webp')$$,
  '55000', 'v2 usage request is required while enforcement is active', 'v1 portrait job fails closed after the activation handoff'
);

select * from finish();
rollback;
