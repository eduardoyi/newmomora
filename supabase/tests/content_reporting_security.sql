begin;

select plan(35);

insert into auth.users (id, email)
values
  ('11000000-0000-4000-8000-000000000001', 'reporter-security@example.test'),
  ('11000000-0000-4000-8000-000000000002', 'target-security@example.test'),
  ('11000000-0000-4000-8000-000000000003', 'manager-security@example.test'),
  ('11000000-0000-4000-8000-000000000004', 'outsider-security@example.test'),
  ('11000000-0000-4000-8000-000000000005', 'spammer-security@example.test'),
  ('11000000-0000-4000-8000-000000000006', 'disposable-reporter@example.test'),
  ('11000000-0000-4000-8000-000000000007', 'family-b-owner@example.test'),
  ('11000000-0000-4000-8000-000000000008', 'family-b-target@example.test');

insert into public.families (id, name, owner_id)
values
  ('21000000-0000-4000-8000-000000000001', 'Safety A', '11000000-0000-4000-8000-000000000001'),
  ('21000000-0000-4000-8000-000000000002', 'Safety B', '11000000-0000-4000-8000-000000000007');

insert into public.family_memberships (id, family_id, user_id, role)
values
  ('31000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001', 'owner'),
  ('31000000-0000-4000-8000-000000000002', '21000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000002', 'viewer'),
  ('31000000-0000-4000-8000-000000000003', '21000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003', 'manager'),
  ('31000000-0000-4000-8000-000000000005', '21000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000005', 'viewer'),
  ('31000000-0000-4000-8000-000000000006', '21000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000006', 'viewer'),
  ('31000000-0000-4000-8000-000000000007', '21000000-0000-4000-8000-000000000002', '11000000-0000-4000-8000-000000000007', 'owner'),
  ('31000000-0000-4000-8000-000000000008', '21000000-0000-4000-8000-000000000002', '11000000-0000-4000-8000-000000000008', 'viewer');

insert into public.memories (
  id, family_id, user_id, content, memory_type, illustration_status,
  illustration_key, illustration_generation_id
)
values (
  '41000000-0000-4000-8000-000000000001',
  '21000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000002',
  'Security target',
  'text_illustration',
  'ready',
  '11000000-0000-4000-8000-000000000002/memories/41000000-0000-4000-8000-000000000001/illustrations/51000000-0000-4000-8000-000000000001.webp',
  '51000000-0000-4000-8000-000000000001'
);

insert into public.family_members (
  id, family_id, user_id, name, date_of_birth
)
values (
  '61000000-0000-4000-8000-000000000001',
  '21000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000002',
  'Profile target',
  '2020-01-01'
);

insert into public.family_member_portrait_versions (
  id, family_member_id, family_id, user_id, reference_date, date_source,
  profile_picture_key, illustrated_profile_key, illustrated_profile_status
)
values (
  '71000000-0000-4000-8000-000000000001',
  '61000000-0000-4000-8000-000000000001',
  '21000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000003',
  '2025-01-01',
  'manual',
  'photo.jpg',
  'portrait.webp',
  'ready'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-000000000004', true);

select throws_ok(
  $$select public.create_content_report('memory', '41000000-0000-4000-8000-000000000001', 'privacy', null, null)$$,
  'P0002', 'Report target is unavailable',
  'an outsider cannot report a family target'
);
select throws_ok(
  $$select * from public.get_my_open_content_reports('21000000-0000-4000-8000-000000000001')$$,
  '42501', 'Not authorized',
  'an outsider cannot read a family report state'
);
select throws_ok(
  $$select public.set_family_account_block(true, '31000000-0000-4000-8000-000000000002', null)$$,
  'P0002', 'Account is unavailable',
  'an outsider cannot block a family membership'
);

select set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-000000000001', true);
select throws_ok(
  $$select public.create_content_report('household_member', '31000000-0000-4000-8000-000000000001', 'other', null, null)$$,
  'P0002', 'Report target is unavailable',
  'a household account cannot report itself'
);
select throws_ok(
  $$select public.set_family_account_block(true, '31000000-0000-4000-8000-000000000001', null)$$,
  'P0002', 'Account is unavailable',
  'a household account cannot block itself'
);
select throws_ok(
  $$select public.create_content_report('memory_illustration', '41000000-0000-4000-8000-000000000001', 'privacy', null, null)$$,
  'P0002', 'Report target is unavailable',
  'an illustration report requires a generation id'
);
select throws_ok(
  $$select public.create_content_report('memory', '41000000-0000-4000-8000-000000000001', 'privacy', null, '51000000-0000-4000-8000-000000000001')$$,
  'P0002', 'Report target is unavailable',
  'a non-versioned report rejects a generation id'
);
select throws_ok(
  $$select public.create_content_report('memory_illustration', '41000000-0000-4000-8000-000000000001', 'privacy', null, '51000000-0000-4000-8000-000000000002')$$,
  'P0002', 'Report target is unavailable',
  'an illustration report rejects a mismatched generation id'
);
select throws_ok(
  $$select public.create_content_report('memory', '41000000-0000-4000-8000-000000000001', 'misleading_ai_depiction', null, null)$$,
  '22023', 'Invalid reason for this report target',
  'the AI-only reason is rejected for nonvisual content'
);
select throws_ok(
  $$select public.create_content_report('memory', '41000000-0000-4000-8000-000000000001', 'other', repeat('x', 501), null)$$,
  '22023', 'Report note must be 500 characters or fewer',
  'notes longer than 500 characters are rejected'
);
select throws_ok(
  $$select public.set_family_account_block(true, '31000000-0000-4000-8000-000000000008', null)$$,
  'P0002', 'Account is unavailable',
  'blocking is scoped to the caller family and rejects cross-family targets'
);

create temporary table owned_block as
select (public.set_family_account_block(
  true, '31000000-0000-4000-8000-000000000002', null
)).id as id;

select set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-000000000003', true);
select throws_ok(
  format(
    'select public.set_family_account_block(false, null, %L)',
    (select id from owned_block)
  ),
  'P0002', 'Account is unavailable',
  'another active manager cannot remove the reporter block'
);
select is(
  (select count(*) from public.get_my_open_content_reports('21000000-0000-4000-8000-000000000001')),
  0::bigint,
  'another active manager sees only their own empty report state'
);

set local role postgres;
create temporary table spam_targets (id uuid primary key);
insert into spam_targets select gen_random_uuid() from generate_series(1, 11);
insert into public.memories (id, family_id, user_id, content, memory_type)
select id, '21000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000002', 'rate target', 'text_only'
from spam_targets;
grant select on spam_targets to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-000000000005', true);
select lives_ok(
  $$select public.create_content_report('memory', id, 'other', null, null) from spam_targets order by id limit 10$$,
  'ten reports in the rolling hour are accepted'
);
select throws_ok(
  $$select public.create_content_report('memory', id, 'other', null, null) from spam_targets order by id offset 10 limit 1$$,
  'P0001', 'Report limit reached. Try again later',
  'the eleventh report in the rolling hour is rejected'
);

select set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-000000000001', true);
select ok(
  public.create_content_report('family_member_profile', '61000000-0000-4000-8000-000000000001', 'privacy', null, null) is not null,
  'a family profile report is accepted'
);
select ok(
  public.create_content_report('family_member_portrait', '71000000-0000-4000-8000-000000000001', 'misleading_ai_depiction', null, null) is not null,
  'a concrete portrait-version report is accepted'
);
set local role postgres;
select is(
  (select target_user_id from public.content_reports where target_type = 'family_member_profile' limit 1),
  '11000000-0000-4000-8000-000000000002'::uuid,
  'profile attribution identifies its creator'
);
select is(
  (select target_user_id from public.content_reports where target_type = 'family_member_portrait' limit 1),
  '11000000-0000-4000-8000-000000000003'::uuid,
  'portrait attribution identifies the exact version uploader'
);

set local role postgres;
update public.memories
set illustration_generation_attempt_id = '81000000-0000-4000-8000-000000000001',
    illustration_status = 'generating'
where id = '41000000-0000-4000-8000-000000000001';
update public.memories
set link_previews = '{"https://example.test":"Example"}'::jsonb
where id = '41000000-0000-4000-8000-000000000001';
select is(
  (select illustration_generation_attempt_id from public.memories where id = '41000000-0000-4000-8000-000000000001'),
  '81000000-0000-4000-8000-000000000001'::uuid,
  'unrelated link-preview writes do not invalidate an active generation'
);
update public.memories
set content = 'Edited security target'
where id = '41000000-0000-4000-8000-000000000001';
select is(
  (select illustration_generation_attempt_id from public.memories where id = '41000000-0000-4000-8000-000000000001'),
  null::uuid,
  'an illustration-relevant memory edit invalidates the attempt token'
);
select is(
  (select illustration_status from public.memories where id = '41000000-0000-4000-8000-000000000001'),
  'ready'::text,
  'an interrupted regeneration restores the retained ready illustration'
);
update public.memories
set illustration_generation_attempt_id = '81000000-0000-4000-8000-000000000002',
    illustration_status = 'generating'
where id = '41000000-0000-4000-8000-000000000001';
insert into public.memory_family_members (memory_id, family_member_id)
values ('41000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000001');
select is(
  (select illustration_generation_attempt_id from public.memories where id = '41000000-0000-4000-8000-000000000001'),
  null::uuid,
  'a tag change invalidates the active generation before junction replacement completes'
);
update public.memories
set updated_at = '2000-01-01T00:00:00Z'
where id = '41000000-0000-4000-8000-000000000001';
delete from public.memory_family_members
where memory_id = '41000000-0000-4000-8000-000000000001'
  and family_member_id = '61000000-0000-4000-8000-000000000001';
select ok(
  (select updated_at > '2000-01-01T00:00:00Z'::timestamptz from public.memories where id = '41000000-0000-4000-8000-000000000001'),
  'a tag edit without an active attempt still touches the parent revision for cache freshness'
);
insert into public.memories (id, family_id, user_id, content, memory_type)
values (
  '41000000-0000-4000-8000-000000000099',
  '21000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000001',
  'Cascade deletion target',
  'text_only'
);
insert into public.memory_family_members (memory_id, family_member_id)
values ('41000000-0000-4000-8000-000000000099', '61000000-0000-4000-8000-000000000001');
select lives_ok(
  $$delete from public.memories where id = '41000000-0000-4000-8000-000000000099'$$,
  'memory deletion succeeds when tag rows cascade through the invalidation trigger'
);
select is(
  (select count(*) from public.memories where id = '41000000-0000-4000-8000-000000000099'),
  0::bigint,
  'the tagged memory is absent after cascade deletion'
);
insert into public.memories (
  id, family_id, user_id, content, memory_type, illustration_status,
  illustration_generation_attempt_id
)
values (
  '41000000-0000-4000-8000-000000000098',
  '21000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000001',
  'Disable AI target',
  'text_illustration',
  'generating',
  '81000000-0000-4000-8000-000000000098'
);
update public.memories
set memory_type = 'text_only'
where id = '41000000-0000-4000-8000-000000000098';
select is(
  (select illustration_generation_attempt_id from public.memories where id = '41000000-0000-4000-8000-000000000098'),
  null::uuid,
  'disabling AI invalidates the active generation token'
);
select is(
  (select illustration_status from public.memories where id = '41000000-0000-4000-8000-000000000098'),
  'none'::text,
  'disabling AI without a retained image restores the non-AI status'
);
update public.memories
set memory_type = 'text_illustration', illustration_status = 'pending'
where id = '41000000-0000-4000-8000-000000000098';
select is(
  (select illustration_status from public.memories where id = '41000000-0000-4000-8000-000000000098'),
  'pending'::text,
  're-enabling AI can return the memory to pending generation'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-000000000006', true);
select ok(
  public.create_content_report('memory', '41000000-0000-4000-8000-000000000001', 'other', 'private context', null) is not null,
  'a disposable reporter can file a report with a note'
);
set local role postgres;
delete from public.user_profiles where id = '11000000-0000-4000-8000-000000000006';
delete from auth.users where id = '11000000-0000-4000-8000-000000000006';
select is(
  (select reporter_user_id from public.content_reports where note is null and target_type = 'memory' and reporter_user_id is null limit 1),
  null::uuid,
  'reporter auth deletion anonymizes reporter id'
);
select is(
  (select note from public.content_reports where target_type = 'memory' and reporter_user_id is null limit 1),
  null::text,
  'reporter auth deletion clears the optional note'
);

delete from public.family_members where id = '61000000-0000-4000-8000-000000000001';
select is(
  (select count(*) from public.content_reports where target_type in ('family_member_profile', 'family_member_portrait')),
  2::bigint,
  'profile and portrait report metadata remains after target deletion'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-000000000007', true);
select public.create_content_report('household_member', '31000000-0000-4000-8000-000000000008', 'other', null, null);
select public.set_family_account_block(true, '31000000-0000-4000-8000-000000000008', null);
set local role postgres;
delete from public.families where id = '21000000-0000-4000-8000-000000000002';
select is(
  (select count(*) from public.content_reports where family_id = '21000000-0000-4000-8000-000000000002'),
  0::bigint,
  'family deletion cascades report metadata'
);
select is(
  (select count(*) from public.blocked_family_accounts where family_id = '21000000-0000-4000-8000-000000000002'),
  0::bigint,
  'family deletion cascades family-scoped blocks'
);

select * from finish();
rollback;
