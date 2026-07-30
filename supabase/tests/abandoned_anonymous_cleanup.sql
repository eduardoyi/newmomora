begin;

-- WP-SEC item 5: proves get_abandoned_anonymous_auth_user_ids
-- (20260729150000_abandoned_anonymous_cleanup.sql) selects exactly the
-- right candidates for supabase/functions/cleanup-abandoned-anonymous-users,
-- and that no client role can call it directly.
select plan(9);

insert into auth.users (id, email, is_anonymous, created_at) values
  ('f1000000-0000-4000-8000-000000000001', 'old-abandoned@example.test', true, now() - interval '10 days'),
  ('f1000000-0000-4000-8000-000000000002', 'fresh-anonymous@example.test', true, now() - interval '1 hour'),
  ('f1000000-0000-4000-8000-000000000003', 'old-permanent@example.test', false, now() - interval '10 days'),
  ('f1000000-0000-4000-8000-000000000004', 'old-anon-owner@example.test', true, now() - interval '10 days'),
  ('f1000000-0000-4000-8000-000000000005', 'old-anon-member@example.test', true, now() - interval '10 days'),
  ('f1000000-0000-4000-8000-000000000006', 'family-owner@example.test', false, now() - interval '10 days');

-- Simulated breach fixtures (see 20260729130000's own adversarial tests for
-- why this is only reachable as postgres, never through a client path).
insert into public.families (id, name, owner_id)
values
  ('f2000000-0000-4000-8000-000000000001', 'Owner-anomaly fixture', 'f1000000-0000-4000-8000-000000000004'),
  ('f2000000-0000-4000-8000-000000000002', 'Member-anomaly fixture', 'f1000000-0000-4000-8000-000000000006');
insert into public.family_memberships (id, family_id, user_id, role)
values
  ('f3000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000004', 'owner'),
  ('f3000000-0000-4000-8000-000000000002', 'f2000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-000000000006', 'owner'),
  ('f3000000-0000-4000-8000-000000000003', 'f2000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-000000000005', 'viewer');

create temporary table candidates as
select * from public.get_abandoned_anonymous_auth_user_ids(now() - interval '7 days');

select is(
  (select count(*)::text from candidates where id = 'f1000000-0000-4000-8000-000000000001'),
  '1',
  'an old anonymous user with no real content is a candidate'
);
select is(
  (select count(*)::text from candidates where id = 'f1000000-0000-4000-8000-000000000002'),
  '0',
  'a fresh anonymous user (within the TTL) is not a candidate'
);
select is(
  (select count(*)::text from candidates where id = 'f1000000-0000-4000-8000-000000000003'),
  '0',
  'an old PERMANENT user is never a candidate, regardless of age'
);
select is(
  (select count(*)::text from candidates where id = 'f1000000-0000-4000-8000-000000000004'),
  '0',
  'an anonymous user who (anomalously) owns a family is excluded, not offered as a candidate'
);
select is(
  (select count(*)::text from candidates where id = 'f1000000-0000-4000-8000-000000000005'),
  '0',
  'an anonymous user who (anomalously) holds a real membership row is excluded'
);
select is(
  (select count(*)::text from candidates),
  '1',
  'exactly one candidate total across every fixture'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000006', true);
select throws_ok(
  $$select * from public.get_abandoned_anonymous_auth_user_ids(now())$$,
  '42501', null,
  'an authenticated (non-service-role) caller cannot invoke this function directly'
);
set local role postgres;

select ok(
  not has_function_privilege('anon', 'public.get_abandoned_anonymous_auth_user_ids(timestamptz)', 'EXECUTE'),
  'the anon role has no execute on get_abandoned_anonymous_auth_user_ids'
);
select ok(
  not has_function_privilege('authenticated', 'public.get_abandoned_anonymous_auth_user_ids(timestamptz)', 'EXECUTE'),
  'the authenticated role has no execute on get_abandoned_anonymous_auth_user_ids (service_role only)'
);

select * from finish();
rollback;
