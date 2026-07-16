begin;

select plan(19);

insert into auth.users (id, email)
values
  ('10000000-0000-4000-8000-000000000001', 'reporter@example.test'),
  ('10000000-0000-4000-8000-000000000002', 'author@example.test'),
  ('10000000-0000-4000-8000-000000000003', 'outsider@example.test'),
  ('10000000-0000-4000-8000-000000000004', 'blocked-only@example.test'),
  ('10000000-0000-4000-8000-000000000005', 'other-manager@example.test');

insert into public.families (id, name, owner_id)
values (
  '20000000-0000-4000-8000-000000000001',
  'Reporting test family',
  '10000000-0000-4000-8000-000000000001'
);

insert into public.family_memberships (id, family_id, user_id, role)
values
  (
    '30000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'owner'
  ),
  (
    '30000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
    'viewer'
  ),
  (
    '30000000-0000-4000-8000-000000000004',
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000004',
    'viewer'
  ),
  (
    '30000000-0000-4000-8000-000000000005',
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000005',
    'manager'
  );

insert into public.memories (
  id,
  family_id,
  user_id,
  content,
  memory_type,
  illustration_status,
  illustration_key,
  illustration_generation_id
)
values (
  '40000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  'Test memory',
  'text_illustration',
  'ready',
  '10000000-0000-4000-8000-000000000002/memories/40000000-0000-4000-8000-000000000001/illustrations/50000000-0000-4000-8000-000000000001.webp',
  '50000000-0000-4000-8000-000000000001'
);

insert into public.memories (id, family_id, user_id, content, memory_type)
values (
  '40000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'Comment host',
  'text_only'
);

insert into public.memory_comments (id, memory_id, user_id, content)
values (
  '45000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000002',
  'Retained comment'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);

select ok(
  public.create_content_report(
    'memory_illustration',
    '40000000-0000-4000-8000-000000000001',
    'misleading_ai_depiction',
    null,
    '50000000-0000-4000-8000-000000000001'
  ) is not null,
  'a family member can report the selected current illustration generation'
);

select is(
  public.create_content_report(
    'memory_illustration',
    '40000000-0000-4000-8000-000000000001',
    'misleading_ai_depiction',
    null,
    '50000000-0000-4000-8000-000000000001'
  ),
  (select id from public.get_my_open_content_reports('20000000-0000-4000-8000-000000000001') limit 1),
  'duplicate submission returns the authoritative active report id'
);

select is(
  (select target_version_id from public.get_my_open_content_reports('20000000-0000-4000-8000-000000000001') limit 1),
  '50000000-0000-4000-8000-000000000001'::uuid,
  'reporter state includes the exact selected generation id'
);

select ok(
  not has_table_privilege('authenticated', 'public.content_reports', 'select'),
  'authenticated clients cannot select the operator queue directly'
);

select ok(
  'target_user_id' <> all (
    coalesce(
      (select proargnames from pg_proc where oid = 'public.get_my_open_content_reports(uuid)'::regprocedure),
      array[]::text[]
    )
  ),
  'the reporter RPC does not expose protected target account attribution'
);

set local role postgres;
update public.memories
set illustration_generation_id = '50000000-0000-4000-8000-000000000002',
    illustration_key = '10000000-0000-4000-8000-000000000002/memories/40000000-0000-4000-8000-000000000001/illustrations/50000000-0000-4000-8000-000000000002.webp'
where id = '40000000-0000-4000-8000-000000000001';
set local role authenticated;

select throws_ok(
  $$select public.create_content_report(
    'memory_illustration',
    '40000000-0000-4000-8000-000000000001',
    'privacy',
    null,
    '50000000-0000-4000-8000-000000000001'
  )$$,
  'P0002',
  'Report target is unavailable',
  'a stale selected generation is rejected without substituting the current one'
);

select ok(
  public.create_content_report(
    'memory_illustration',
    '40000000-0000-4000-8000-000000000001',
    'privacy',
    null,
    '50000000-0000-4000-8000-000000000002'
  ) is not null,
  'the new generation can be reported independently'
);

select is(
  (select count(*) from public.get_my_open_content_reports('20000000-0000-4000-8000-000000000001') where target_type = 'memory_illustration'),
  2::bigint,
  'two illustration generations remain distinct active reports'
);

select ok(
  public.create_content_report(
    'memory',
    '40000000-0000-4000-8000-000000000001',
    'privacy',
    null,
    null
  ) is not null,
  'an authored memory report is accepted'
);

set local role postgres;
select is(
  (select target_user_id from public.content_reports where target_type = 'memory' limit 1),
  '10000000-0000-4000-8000-000000000002'::uuid,
  'operator row captures the authored target account'
);
set local role authenticated;

select ok(
  public.create_content_report(
    'household_member',
    '30000000-0000-4000-8000-000000000002',
    'harassment_or_abuse',
    null,
    null
  ) is not null,
  'another active household account can be reported'
);

select ok(
  (public.set_family_account_block(
    true,
    '30000000-0000-4000-8000-000000000002',
    null
  )).id is not null,
  'another active household account can be blocked'
);

select public.set_family_account_block(
  true,
  '30000000-0000-4000-8000-000000000004',
  null
);

set local role postgres;
delete from public.family_memberships
where id = '30000000-0000-4000-8000-000000000002';
delete from public.family_memberships
where id = '30000000-0000-4000-8000-000000000004';
delete from public.memories
where id = '40000000-0000-4000-8000-000000000001';
set local role authenticated;
select is(
  (
    select count(*)
    from public.get_family_member_profiles('20000000-0000-4000-8000-000000000001')
    where user_id = '10000000-0000-4000-8000-000000000002'
      and is_active_member = false
  ),
  1::bigint,
  'a removed comment-only author remains in the roster so an existing block can be removed'
);
select is(
  (
    select count(*)
    from public.get_family_member_profiles('20000000-0000-4000-8000-000000000001')
    where user_id = '10000000-0000-4000-8000-000000000004'
      and is_active_member = false
  ),
  1::bigint,
  'a caller-local block keeps a removed no-content account reachable for unblock'
);
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000005', true);
select is(
  (
    select count(*)
    from public.get_family_member_profiles('20000000-0000-4000-8000-000000000001')
    where user_id = '10000000-0000-4000-8000-000000000004'
  ),
  0::bigint,
  'another family member does not learn the caller-local blocked-only account'
);
set local role postgres;

select is(
  (select target_user_id from public.content_reports where target_type = 'household_member' limit 1),
  '10000000-0000-4000-8000-000000000002'::uuid,
  'account attribution remains actionable after membership deletion'
);

select is(
  (select target_user_id from public.content_reports where target_type = 'memory' limit 1),
  '10000000-0000-4000-8000-000000000002'::uuid,
  'authored-content attribution remains actionable after target deletion'
);

select is(
  (select blocked_membership_id from public.blocked_family_accounts limit 1),
  null::uuid,
  'the family-scoped block persists after membership removal'
);

select is(
  (select count(*) from public.content_reports where target_id = '40000000-0000-4000-8000-000000000001'),
  3::bigint,
  'report metadata persists after authored target deletion'
);

select * from finish();
rollback;
