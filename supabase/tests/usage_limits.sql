begin;

select plan(32);

insert into auth.users (id, email)
values ('a1000000-0000-4000-8000-000000000001', 'usage-limits-db@example.test');

insert into public.families (id, name, owner_id)
values ('a2000000-0000-4000-8000-000000000001', 'Usage limits test family', 'a1000000-0000-4000-8000-000000000001');
insert into public.family_memberships (id, family_id, user_id, role)
values ('a3000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'owner');
insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status)
values
  ('a4000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'First', 'text_illustration', 'pending'),
  ('a4000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'Second', 'text_illustration', 'pending');

select ok(exists(select 1 from public.ai_family_usage_locks where family_id='a2000000-0000-4000-8000-000000000001'), 'family insert eagerly creates its usage lock');
select is((select enforcement_enabled::text from public.ai_usage_settings), 'false', 'enforcement is disabled on migration deploy');
select is((select outcome from public.begin_memory_illustration_usage('a4000000-0000-4000-8000-000000000001', 'initial', 'a5000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001')), 'enforcement_bypassed', 'old producers are safely bypassed before activation');

update public.ai_usage_settings set enforcement_enabled=true, enforcement_activated_at=now(), image_requests_per_family_per_day=1, image_requests_per_family_per_month=2, manual_regenerations_per_memory_per_day=1;

create temporary table admitted as
select * from public.begin_memory_illustration_usage(
  'a4000000-0000-4000-8000-000000000001', 'initial',
  'a5000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000001'
);
select is((select outcome from admitted), 'admitted_new', 'first generation gets a preparation admission');
select ok((select request_id is not null and preparation_token is not null from admitted), 'admission returns fenced request and preparation identities');
select ok((select preparation_input_updated_at is not null from admitted), 'admission returns the fenced input snapshot required by preparation RPCs');
select is((select state from public.ai_image_generation_requests where id=(select request_id from admitted)), 'reserved', 'pre-provider request remains reserved');
select is((select count(*)::text from public.ai_image_generation_admissions where request_id=(select request_id from admitted) and state='active'), '1', 'one active hold exists for the request');

select is((select outcome from public.begin_memory_illustration_usage('a4000000-0000-4000-8000-000000000001', 'initial', 'a5000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000001')), 'already_preparing', 'duplicate preparation is not admitted twice');
select is((select public.release_ai_image_preparation((select request_id from admitted), 'b5000000-0000-4000-8000-000000000001')), false, 'wrong lease token cannot release the reservation');
select is((select public.release_ai_image_preparation((select request_id from admitted), (select preparation_token from admitted))), true, 'matching lease token releases a pre-provider failure');
select is((select state from public.ai_image_generation_requests where id=(select request_id from admitted)), 'cancelled', 'released preparation is cancelled rather than counted');

create temporary table admitted_again as
select * from public.begin_memory_illustration_usage(
  'a4000000-0000-4000-8000-000000000001', 'initial',
  'a5000000-0000-4000-8000-000000000004', 'a1000000-0000-4000-8000-000000000001'
);
select is((select outcome from admitted_again), 'admitted_new', 'released work leaves capacity for a new request');
select is((select outcome from public.reserve_legacy_ai_image_provider_attempt_v2((select request_id from admitted_again), 'memory', 'a4000000-0000-4000-8000-000000000001', (select preparation_token from admitted_again), (select preparation_ordinal from admitted_again), (select preparation_input_updated_at from admitted_again), 'primary', 1::smallint)), 'reserved_now', 'first provider authorization consumes one unit');
select is((select state from public.ai_image_generation_requests where id=(select request_id from admitted_again)), 'consumed', 'provider authorization consumes the logical request');
select is((select outcome from public.reserve_legacy_ai_image_provider_attempt_v2((select request_id from admitted_again), 'memory', 'a4000000-0000-4000-8000-000000000001', (select preparation_token from admitted_again), (select preparation_ordinal from admitted_again), (select preparation_input_updated_at from admitted_again), 'primary', 1::smallint)), 'already_reserved', 'provider replay fails closed');
select is((select outcome from public.reserve_legacy_ai_image_provider_attempt_v2((select request_id from admitted_again), 'memory', 'a4000000-0000-4000-8000-000000000001', (select preparation_token from admitted_again), (select preparation_ordinal from admitted_again), (select preparation_input_updated_at from admitted_again), 'fallback', 1::smallint)), 'reserved_now', 'fallback gets a separate provider slot without another quota unit');
select is((select provider_attempt_count::text from public.ai_image_generation_requests where id=(select request_id from admitted_again)), '2', 'fallback increases attempts while retaining one consumed request');

select is((select outcome from public.begin_memory_illustration_usage('a4000000-0000-4000-8000-000000000002','initial','a5000000-0000-4000-8000-000000000005','a1000000-0000-4000-8000-000000000001')), 'limit_rejected', 'daily limit denies a second logical request');
select is((select usage_limit_scope from public.memories where id='a4000000-0000-4000-8000-000000000002'), 'daily', 'limit scope is stored server-side on the entity');
select ok(exists(select 1 from public.ai_usage_limit_notices where actor_user_id='a1000000-0000-4000-8000-000000000001'), 'rejection creates an actor-scoped durable notice');

select lives_ok($$select public.record_ai_usage_event_detailed('test-call-1', (select request_id from admitted_again), 'a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'illustration', 'gpt-image-2', true, '{"input_text_tokens": 1, "prompt": "must not persist"}'::jsonb, null, 'unpriced', 'known', false)$$, 'ledger write accepts the request-linked detailed contract');
select is((select provider_usage ? 'prompt' from public.ai_usage_events where ai_call_id='test-call-1'), false, 'ledger strips prompt-like fields');
select is((select count(*)::text from public.ai_usage_events where ai_call_id='test-call-1'), '1', 'ledger event is idempotent by call id');
select lives_ok($$select public.record_ai_usage_event_detailed('test-call-1', (select request_id from admitted_again), 'a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'illustration', 'gpt-image-2', true, '{}'::jsonb, null, 'unpriced', 'known', false)$$, 'ledger replay succeeds');
select is((select count(*)::text from public.ai_usage_events where ai_call_id='test-call-1'), '1', 'ledger replay does not duplicate the event');

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
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);
-- Dynamic SQL keeps the table scan in caller context; pgTAP's string helpers
-- otherwise execute with definer visibility.
select ok(pg_temp.table_is_private('public.ai_image_generation_requests'), 'clients cannot read private generation requests');
select ok(pg_temp.table_is_private('public.ai_usage_events'), 'clients cannot read private usage events');
select ok(has_function_privilege('authenticated', 'public.get_my_ai_usage_limit_notices()', 'EXECUTE'), 'clients receive only the narrow notice reader');
select ok(not has_function_privilege('authenticated', 'public.reserve_ai_image_provider_attempt_v2(uuid,text,smallint)', 'EXECUTE'), 'clients cannot authorize paid provider calls');
set local role postgres;

select is((select quota_policy_epoch::text from public.ai_usage_settings), '2', 'enabling enforcement increments the policy epoch');
update public.ai_usage_settings set image_requests_per_family_per_day=2;
select is((select quota_policy_epoch::text from public.ai_usage_settings), '3', 'quota changes increment rather than reset the policy epoch');

select * from finish();
rollback;
