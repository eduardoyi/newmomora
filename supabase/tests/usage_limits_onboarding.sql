begin;

-- Pre-auth voice is Momora COGS, never a synthetic family. This fixture locks
-- server-issued request/session identity, anonymous-only admission, ledger
-- reconciliation, permissions, retention, and deletion semantics.
select plan(52);

insert into auth.users (id, email, is_anonymous) values
  ('c1000000-0000-4000-8000-000000000001', 'anonymous-onboarding@example.test', true),
  ('c1000000-0000-4000-8000-000000000002', 'permanent-user@example.test', false),
  ('c1000000-0000-4000-8000-000000000003', 'anonymous-failed-transcription@example.test', true),
  ('c1000000-0000-4000-8000-000000000004', 'anonymous-cleanup-gap@example.test', true),
  ('c1000000-0000-4000-8000-000000000005', 'family-owner@example.test', false);
insert into public.families (id, name, owner_id)
values ('c2000000-0000-4000-8000-000000000001', 'Onboarding ledger fixture', 'c1000000-0000-4000-8000-000000000005');

create temporary table reservation_one as
select * from public.reserve_onboarding_voice_attempt('c1000000-0000-4000-8000-000000000001');
create temporary table reservation_two as
select * from public.reserve_onboarding_voice_attempt('c1000000-0000-4000-8000-000000000001');
create temporary table reservation_three as
select * from public.reserve_onboarding_voice_attempt('c1000000-0000-4000-8000-000000000001');

select is((select reserved from reservation_one), true, 'first anonymous onboarding reservation succeeds');
select is((select attempts_used::text from reservation_one), '1', 'first reservation reports one used attempt');
select is((select reserved from reservation_two), true, 'second anonymous onboarding reservation succeeds');
select is((select attempts_used::text from reservation_two), '2', 'second reservation reports two used attempts');
select is((select reserved from reservation_three), false, 'third anonymous onboarding reservation is denied');
select is((select request_id is null from reservation_three), true, 'denial never returns a request id');
select is((select attempts_used::text from reservation_three), '2', 'denial preserves the atomic two-attempt count');
select is((select count(*)::text from public.ai_onboarding_voice_requests where actor_user_id='c1000000-0000-4000-8000-000000000001'), '2', 'two durable requests are created and no more');
select ok((select request_id is distinct from 'c1000000-0000-4000-8000-000000000001'::uuid from reservation_one), 'database generates an opaque request id unrelated to the auth user id');
select ok((select request_id is distinct from (select request_id from reservation_two) from reservation_one), 'each reservation gets a distinct server-generated request id');

select is((select reserved from public.reserve_onboarding_voice_attempt('c1000000-0000-4000-8000-000000000002')), false, 'permanent Auth users cannot reserve onboarding voice');
select is((select request_id is null and attempts_used=0 from public.reserve_onboarding_voice_attempt('c1000000-0000-4000-8000-000000000099')), true, 'arbitrary actor UUID cannot reserve onboarding voice');
select throws_ok($$select public.reserve_onboarding_voice_attempt(null)$$, '22023', 'actor user id required', 'reservation rejects an unbound actor');

select lives_ok(
  $$select public.record_ai_usage_event_detailed('onboarding-transcription', null, null, 'c1000000-0000-4000-8000-000000000001', 'transcription', 'gpt-4o-mini-transcribe', true, '{"audio_seconds": 12}'::jsonb, 0.001, 'provider_usage', 'known', true, 'test-v1', 'onboarding', (select request_id from reservation_one))$$,
  'onboarding transcription is linked through the server-issued request'
);
select throws_ok(
  $$select public.record_ai_usage_event_detailed('onboarding-cleanup-before-marker', null, null, 'c1000000-0000-4000-8000-000000000001', 'voice_cleanup', 'gpt-4o-mini', true, '{}'::jsonb, null, 'unpriced', 'unknown', false, null, 'onboarding', (select request_id from reservation_one))$$,
  '22023', 'onboarding cleanup not expected', 'cleanup ledger cannot precede durable cleanup expectation'
);
select is(public.mark_onboarding_voice_cleanup_expected((select request_id from reservation_one), 'c1000000-0000-4000-8000-000000000001'), true, 'transcription success path marks cleanup expected before cleanup');
select lives_ok(
  $$select public.record_ai_usage_event_detailed('onboarding-cleanup', null, null, 'c1000000-0000-4000-8000-000000000001', 'voice_cleanup', 'gpt-4o-mini', false, '{}'::jsonb, null, 'unpriced', 'unknown', false, null, 'onboarding', (select request_id from reservation_one))$$,
  'failed onboarding cleanup is still recorded'
);
select ok((select family_id is null and onboarding_request_id=(select request_id from reservation_one) from public.ai_usage_events where ai_call_id='onboarding-transcription'), 'ledger retains only the server-issued onboarding request correlation');
select is((select actor_user_id::text from public.ai_usage_events where ai_call_id='onboarding-transcription'), 'c1000000-0000-4000-8000-000000000001', 'ledger derives actor from private request');
select throws_ok(
  $$select public.record_ai_usage_event_detailed('wrong-onboarding-actor', null, null, 'c1000000-0000-4000-8000-000000000002', 'transcription', 'model', true, '{}'::jsonb, null, 'unpriced', 'unknown', false, null, 'onboarding', (select request_id from reservation_two))$$,
  '22023', 'invalid onboarding usage request', 'ledger rejects a mismatched supplied actor'
);
select throws_ok(
  $$select public.record_ai_usage_event_detailed('bad-onboarding-family', null, 'c2000000-0000-4000-8000-000000000001', null, 'transcription', 'model', true, '{}'::jsonb, null, 'unpriced', 'unknown', false, null, 'onboarding', (select request_id from reservation_two))$$,
  '22023', 'invalid usage attribution', 'onboarding scope cannot carry a family'
);
select throws_ok(
  $$select public.record_ai_usage_event_detailed('bad-onboarding-operation', null, null, null, 'illustration', 'model', true, '{}'::jsonb, null, 'unpriced', 'unknown', false, null, 'onboarding', (select request_id from reservation_two))$$,
  '22023', 'invalid usage attribution', 'onboarding scope is limited to voice operations'
);
select throws_ok(
  $$select public.record_ai_usage_event_detailed('bad-family-null', null, null, null, 'transcription', 'model', true, '{}'::jsonb)$$,
  '22023', 'invalid usage attribution', 'family scope still requires a real family'
);
select throws_ok(
  $$insert into public.ai_usage_events(ai_call_id, attribution_scope, operation, model, success) values ('bad-table-onboarding-request', 'onboarding', 'transcription', 'model', true)$$,
  '23514', NULL, 'table constraint requires every onboarding event to link its durable request'
);

select lives_ok(
  $$select public.record_ai_usage_event_detailed('family-transcription', null, 'c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000005', 'transcription', 'gpt-4o-mini-transcribe', true, '{}'::jsonb, 0.002, 'provider_usage', 'known', true)$$,
  'existing family ledger call remains backward compatible'
);
select is((select calls::text from public.family_ai_costs_monthly where family_id='c2000000-0000-4000-8000-000000000001' and operation='transcription'), '1', 'family view excludes onboarding costs');
select is((select calls::text from public.company_ai_costs_monthly where attribution_scope='onboarding' and operation='transcription'), '1', 'company view includes onboarding COGS');
select is((select calls::text from public.company_ai_costs_monthly where attribution_scope='family' and operation='transcription'), '1', 'company view keeps family costs separate');

create temporary table failed_transcription_request as
select * from public.reserve_onboarding_voice_attempt('c1000000-0000-4000-8000-000000000003');
update public.ai_onboarding_voice_requests set created_at=transaction_timestamp()-interval '11 minutes', updated_at=transaction_timestamp()-interval '11 minutes'
where id=(select request_id from failed_transcription_request);
select ok(not public.mark_onboarding_voice_cleanup_expected((select request_id from failed_transcription_request), 'c1000000-0000-4000-8000-000000000002'), 'cleanup marker rejects a different actor');
select ok(exists(select 1 from public.ai_usage_observability_gaps where onboarding_request_id=(select request_id from failed_transcription_request) and expected_operation='transcription'), 'reserved request without transcription becomes a reconciliation gap');
select ok(not exists(select 1 from public.ai_usage_observability_gaps where onboarding_request_id=(select request_id from failed_transcription_request) and expected_operation='voice_cleanup'), 'failed transcription path creates no false cleanup gap');

create temporary table cleanup_gap_request as
select * from public.reserve_onboarding_voice_attempt('c1000000-0000-4000-8000-000000000004');
select is(public.mark_onboarding_voice_cleanup_expected((select request_id from cleanup_gap_request), 'c1000000-0000-4000-8000-000000000004'), true, 'successful transcription handler progression durably marks cleanup expected');
update public.ai_onboarding_voice_requests set created_at=transaction_timestamp()-interval '11 minutes', updated_at=transaction_timestamp()-interval '11 minutes'
where id=(select request_id from cleanup_gap_request);
select ok(exists(select 1 from public.ai_usage_observability_gaps where onboarding_request_id=(select request_id from cleanup_gap_request) and expected_operation='transcription'), 'missing detached transcription ledger is independently visible');
select ok(exists(select 1 from public.ai_usage_observability_gaps where onboarding_request_id=(select request_id from cleanup_gap_request) and expected_operation='voice_cleanup'), 'expected cleanup without ledger is visible');

update public.ai_usage_settings set global_unpriced_alert_min_calls=1, global_unpriced_alert_fraction=0.1;
select lives_ok($$select public.enqueue_ai_usage_alerts('onboarding-test', transaction_timestamp())$$, 'global alerts process onboarding COGS and gaps');
select ok(exists(select 1 from public.ai_usage_alert_outbox where environment_id='onboarding-test' and idempotency_key like 'onboarding-test:gap:onboarding:%'), 'global observability alert includes onboarding ledger gaps');
select ok(exists(select 1 from public.ai_usage_alert_outbox where environment_id='onboarding-test' and idempotency_key like 'onboarding-test:unpriced-global:%' and payload->>'aiCalls' is not null), 'global unpriced alert includes nullable-family onboarding calls');

update public.ai_usage_events set created_at=transaction_timestamp()-interval '4 months'
where onboarding_request_id=(select request_id from reservation_one);
update public.ai_onboarding_voice_requests set created_at=transaction_timestamp()-interval '4 months' where id=(select request_id from reservation_one);
select lives_ok($$select public.purge_expired_ai_usage_data(transaction_timestamp())$$, 'retention purge succeeds for onboarding data');
select ok(not exists(select 1 from public.ai_usage_events where ai_call_id='onboarding-transcription'), '90-day retention removes expired onboarding raw event');
select ok(not exists(select 1 from public.ai_onboarding_voice_requests where id=(select request_id from reservation_one)), '90-day retention removes expired raw onboarding request');
select ok(exists(select 1 from public.ai_system_usage_monthly_rollups where attribution_scope='onboarding' and operation='transcription'), '13-month system rollup survives raw retention');
insert into public.ai_system_usage_monthly_rollups(attribution_scope, month, operation, model, calls)
values ('onboarding', date_trunc('month', transaction_timestamp()-interval '14 months')::date, 'transcription', 'expired-system-model', 1);
select lives_ok($$select public.purge_expired_ai_usage_data(transaction_timestamp())$$, 'retention purge removes expired system rollups');
select ok(not exists(select 1 from public.ai_system_usage_monthly_rollups where model='expired-system-model'), 'system rollups expire after 13 months');

select lives_ok(
  $$select public.record_ai_usage_event_detailed('onboarding-auth-cleanup', null, null, 'c1000000-0000-4000-8000-000000000001', 'transcription', 'gpt-4o-mini-transcribe', true, '{}'::jsonb, null, 'unpriced', 'unknown', false, null, 'onboarding', (select request_id from reservation_two))$$,
  'retained onboarding request can record an event before Auth cleanup'
);
delete from auth.users where id='c1000000-0000-4000-8000-000000000001';
select ok((select actor_user_id is null from public.ai_usage_events where ai_call_id='onboarding-auth-cleanup'), 'Auth cleanup nulls onboarding ledger actor attribution');
select ok((select actor_user_id is null from public.ai_onboarding_voice_requests where id=(select request_id from reservation_two)), 'Auth cleanup deidentifies retained onboarding request actor');
select ok(exists(select 1 from public.ai_system_usage_monthly_rollups where attribution_scope='onboarding'), 'Auth cleanup preserves deidentified company COGS');

create function pg_temp.table_is_private(p_table regclass) returns boolean
language plpgsql as $$
declare v_count integer;
begin
  if not has_table_privilege(current_user, p_table, 'SELECT') then return true; end if;
  execute format('select count(*) from %s', p_table) into v_count;
  return v_count=0;
end;
$$;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000005', true);
select ok(pg_temp.table_is_private('public.ai_onboarding_voice_requests'), 'clients cannot read onboarding requests');
select ok(pg_temp.table_is_private('public.ai_system_usage_monthly_rollups'), 'clients cannot read system COGS rollups');
select ok(not has_function_privilege('authenticated', 'public.reserve_onboarding_voice_attempt(uuid)', 'EXECUTE'), 'clients cannot reserve onboarding voice directly');
select ok(not has_function_privilege('authenticated', 'public.mark_onboarding_voice_cleanup_expected(uuid,uuid)', 'EXECUTE'), 'clients cannot mark cleanup expected directly');
select ok(not has_function_privilege('authenticated', 'public.record_ai_usage_event_detailed(text,uuid,uuid,uuid,text,text,boolean,jsonb,numeric,text,text,boolean,text,text,uuid)', 'EXECUTE'), 'clients cannot write onboarding ledger events directly');
set local role postgres;

select * from finish();
rollback;
