begin;

-- Family relationships (docs/plans/family-relationships.md, Step 1 / Step 6).
-- Covers: relationship / family_side / side_member_id constraints + the
-- normalize trigger; the "this is me" link (set_my_family_member,
-- unlink_family_member_account, the family_memberships column grant, the
-- one-account-per-person index, not_in_list); the AFTER-UPDATE relationship
-- trigger (kid/pet unlinks the account, stale suggestions dismissed); FK
-- set-null / cascade behavior on member delete; family_member_suggestions
-- privacy; insert_family_member_suggestions dedupe; resolve_family_member_
-- suggestions (apply, compare-and-set, nickname dedupe + collision, role +
-- billing + anonymous guards, other-family ids ignored); the service-role-only
-- claim/backoff/signals functions; commit_onboarding kids being 'child'; and
-- ai_usage_events accepting 'relationship_chat'.
select plan(121);

-- ---------------------------------------------------------------------------
-- Fixtures (inserted as the default postgres role, so RLS/billing never
-- interferes with fixture setup; assertions switch to `authenticated` + a JWT
-- sub claim where the client path is under test).
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, is_anonymous) values
  ('f7000000-0000-4000-8000-000000000001', 'rel-owner@example.test', false),
  ('f7000000-0000-4000-8000-000000000002', 'rel-manager@example.test', false),
  ('f7000000-0000-4000-8000-000000000003', 'rel-viewer@example.test', false),
  ('f7000000-0000-4000-8000-000000000004', 'rel-viewer2@example.test', false),
  ('f7000000-0000-4000-8000-000000000005', 'rel-anon@example.test', true),
  ('f7000000-0000-4000-8000-000000000006', 'rel-lapsed-owner@example.test', false),
  ('f7000000-0000-4000-8000-000000000007', 'rel-outsider@example.test', false),
  ('f7000000-0000-4000-8000-000000000008', 'rel-onboarding@example.test', false);

update public.user_profiles set name = 'Vera' where id = 'f7000000-0000-4000-8000-000000000003';

insert into public.families (id, name, owner_id) values
  ('f7100000-0000-4000-8000-000000000001', 'Relationships fixture family', 'f7000000-0000-4000-8000-000000000001'),
  ('f7100000-0000-4000-8000-000000000002', 'Lapsed fixture family', 'f7000000-0000-4000-8000-000000000006');

insert into public.family_memberships (family_id, user_id, role) values
  ('f7100000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001', 'owner'),
  ('f7100000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000002', 'manager'),
  ('f7100000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000003', 'viewer'),
  ('f7100000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000004', 'viewer'),
  ('f7100000-0000-4000-8000-000000000002', 'f7000000-0000-4000-8000-000000000006', 'owner');

-- Adversarial: simulate a breach where the anonymous user ended up a manager
-- of family A (impossible through client paths -- proves the RPC guards hold
-- on their own, same technique as onboarding_anonymous_lockdown.sql).
insert into public.family_memberships (family_id, user_id, role)
values ('f7100000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000005', 'manager');

-- Family A is paid; family B (lapsed owner, no entitlement) is billing-blocked.
insert into public.owner_entitlements (
  owner_user_id, app_user_id, environment, store, product_id, entitlement_id,
  period_type, status, expires_at, will_renew
)
values (
  'f7000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001',
  'production', 'app_store', 'momora_annual_v1', 'momora_plus', 'annual', 'active',
  transaction_timestamp() + interval '30 days', true
);

insert into public.family_members (id, family_id, name, nicknames, date_of_birth, relationship, created_at) values
  ('f7200000-0000-4000-8000-000000000001', 'f7100000-0000-4000-8000-000000000001', 'Kiddo Rivera', '{}', '2021-05-01', 'child', now() - interval '30 days'),
  ('f7200000-0000-4000-8000-000000000002', 'f7100000-0000-4000-8000-000000000001', 'Baby', '{}', current_date - 200, null, now() - interval '30 days'),
  ('f7200000-0000-4000-8000-000000000003', 'f7100000-0000-4000-8000-000000000001', 'Eduardo Rivera', '{}', '1985-01-01', 'parent', now() - interval '30 days'),
  ('f7200000-0000-4000-8000-000000000004', 'f7100000-0000-4000-8000-000000000001', 'Maria Rivera', '{}', '1986-02-02', 'parent', now() - interval '30 days'),
  ('f7200000-0000-4000-8000-000000000005', 'f7100000-0000-4000-8000-000000000001', 'Nana', '{}', '1950-01-01', null, now() - interval '30 days'),
  ('f7200000-0000-4000-8000-000000000006', 'f7100000-0000-4000-8000-000000000001', 'Rex', '{}', null, 'pet', now() - interval '30 days'),
  ('f7200000-0000-4000-8000-000000000007', 'f7100000-0000-4000-8000-000000000001', 'Abuela Lupe', '{Lala}', '1952-03-03', null, now() - interval '30 days'),
  ('f7200000-0000-4000-8000-000000000008', 'f7100000-0000-4000-8000-000000000001', 'Sam', '{}', '2020-06-06', 'cousin', now() - interval '30 days'),
  ('f7200000-0000-4000-8000-000000000009', 'f7100000-0000-4000-8000-000000000001', 'Grandpa Joe', '{}', '1948-04-04', null, now() - interval '30 days'),
  ('f7200000-0000-4000-8000-000000000010', 'f7100000-0000-4000-8000-000000000001', 'Elena', '{}', null, null, now() - interval '30 days'),
  ('f7200000-0000-4000-8000-000000000101', 'f7100000-0000-4000-8000-000000000002', 'Bee', '{}', '1980-01-01', 'parent', now() - interval '30 days');

-- ---------------------------------------------------------------------------
-- 1. Column shape + constraints. The normalize trigger would clear invalid
--    side fields before the CHECKs ever ran, so it is disabled (rolled back
--    with the transaction) to prove the CHECKs themselves.
-- ---------------------------------------------------------------------------

select ok(
  (select relationship is null and family_side is null and side_member_id is null
   from public.family_members where id = 'f7200000-0000-4000-8000-000000000005'),
  'new columns default to null (no backfill: unsorted members stay unsorted)'
);

select throws_ok(
  $$update public.family_members set relationship = 'stepdad' where id = 'f7200000-0000-4000-8000-000000000005'$$,
  '23514', null,
  'an unknown relationship value violates the check constraint'
);
select throws_ok(
  $$update public.family_members set family_side = 'sideways' where id = 'f7200000-0000-4000-8000-000000000008'$$,
  '23514', null,
  'an unknown family_side value violates the check constraint'
);

alter table public.family_members disable trigger family_members_normalize_relationship;

select throws_ok(
  $$update public.family_members set family_side = 'paternal' where id = 'f7200000-0000-4000-8000-000000000005'$$,
  '23514', null,
  'a side field on a non-side (unsorted) role violates the check constraint'
);
select throws_ok(
  $$update public.family_members set family_side = 'paternal' where id = 'f7200000-0000-4000-8000-000000000001'$$,
  '23514', null,
  'a side field on a child violates the check constraint'
);
select throws_ok(
  $$update public.family_members set relationship = 'grandparent', family_side = 'paternal', side_member_id = 'f7200000-0000-4000-8000-000000000003' where id = 'f7200000-0000-4000-8000-000000000005'$$,
  '23514', null,
  'family_side and side_member_id together violate the check constraint'
);
select throws_ok(
  $$update public.family_members set relationship = 'cousin', side_member_id = id where id = 'f7200000-0000-4000-8000-000000000005'$$,
  '23514', null,
  'a member cannot be its own side parent'
);

alter table public.family_members enable trigger family_members_normalize_relationship;

-- Normalize trigger: changing the role clears side fields (no 23514).
update public.family_members
set relationship = 'grandparent', family_side = 'paternal'
where id = 'f7200000-0000-4000-8000-000000000005';
select is(
  (select family_side from public.family_members where id = 'f7200000-0000-4000-8000-000000000005'),
  'paternal',
  'a side role keeps its family_side'
);
select lives_ok(
  $$update public.family_members set relationship = 'family_friend' where id = 'f7200000-0000-4000-8000-000000000005'$$,
  'changing a side role to a non-side role does not trip the side-role check'
);
select ok(
  (select family_side is null and side_member_id is null from public.family_members where id = 'f7200000-0000-4000-8000-000000000005'),
  'the normalize trigger cleared the side fields when the role stopped being a side role'
);
select lives_ok(
  $$insert into public.family_members (id, family_id, name, relationship, family_side)
    values ('f7200000-0000-4000-8000-000000000020', 'f7100000-0000-4000-8000-000000000001', 'Friend With Stray Side', 'family_friend', 'both')$$,
  'inserting a non-side role with a stray side does not raise'
);
select is(
  (select family_side from public.family_members where id = 'f7200000-0000-4000-8000-000000000020'),
  null,
  'insert normalization cleared the stray side'
);
delete from public.family_members where id = 'f7200000-0000-4000-8000-000000000020';

-- Side parent must be a parent of the same family.
update public.family_members set relationship = null where id = 'f7200000-0000-4000-8000-000000000005';
select throws_ok(
  $$update public.family_members set relationship = 'grandparent', side_member_id = 'f7200000-0000-4000-8000-000000000001' where id = 'f7200000-0000-4000-8000-000000000005'$$,
  '23514', 'side_member_must_be_parent',
  'a side pointing at a non-parent (a child) is rejected'
);
select throws_ok(
  $$update public.family_members set relationship = 'grandparent', side_member_id = 'f7200000-0000-4000-8000-000000000101' where id = 'f7200000-0000-4000-8000-000000000005'$$,
  '23514', 'side_member_must_be_parent',
  'a side pointing at a parent of another family is rejected'
);
select lives_ok(
  $$update public.family_members set relationship = 'grandparent', side_member_id = 'f7200000-0000-4000-8000-000000000003' where id = 'f7200000-0000-4000-8000-000000000005'$$,
  'a side pointing at a parent of the same family is accepted'
);
update public.family_members set relationship = null where id = 'f7200000-0000-4000-8000-000000000005';

-- ---------------------------------------------------------------------------
-- 2. "This is me": set_my_family_member
-- ---------------------------------------------------------------------------

select ok(
  has_column_privilege('authenticated', 'public.family_memberships', 'role', 'UPDATE'),
  'authenticated keeps the column-level UPDATE on family_memberships.role'
);
select ok(
  not has_column_privilege('authenticated', 'public.family_memberships', 'family_member_id', 'UPDATE'),
  'authenticated has no UPDATE on family_memberships.family_member_id (definer RPC only)'
);
select ok(
  not has_column_privilege('authenticated', 'public.family_memberships', 'not_in_list', 'UPDATE'),
  'authenticated has no UPDATE on family_memberships.not_in_list (definer RPC only)'
);
select ok(
  not has_column_privilege('authenticated', 'public.families', 'relationship_suggested_at', 'UPDATE'),
  'authenticated cannot write the suggestion throttle marker'
);

-- viewer (U3) links self to Nana.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f7000000-0000-4000-8000-000000000003', true);

select lives_ok(
  $$select public.set_my_family_member('f7100000-0000-4000-8000-000000000001', 'f7200000-0000-4000-8000-000000000005')$$,
  'a viewer can link their own account to an unsorted adult member'
);

set local role postgres;
select is(
  (select family_member_id::text from public.family_memberships where family_id = 'f7100000-0000-4000-8000-000000000001' and user_id = 'f7000000-0000-4000-8000-000000000003'),
  'f7200000-0000-4000-8000-000000000005',
  'the viewer''s own membership row now points at Nana'
);
select is(
  (select count(*)::int from public.family_memberships where family_id = 'f7100000-0000-4000-8000-000000000001' and family_member_id is not null),
  1,
  'no other membership row was touched by the link'
);

-- Second account (U4) cannot claim the same person.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f7000000-0000-4000-8000-000000000004', true);

select throws_ok(
  $$select public.set_my_family_member('f7100000-0000-4000-8000-000000000001', 'f7200000-0000-4000-8000-000000000005')$$,
  '23505', 'member_already_linked',
  'a member already claimed by another account raises member_already_linked'
);
select throws_ok(
  $$select public.set_my_family_member('f7100000-0000-4000-8000-000000000001', 'f7200000-0000-4000-8000-000000000101')$$,
  '22023', 'member_not_in_family',
  'a member of another family cannot be linked'
);
select throws_ok(
  $$select public.set_my_family_member('f7100000-0000-4000-8000-000000000001', 'f7200000-0000-4000-8000-000000000001')$$,
  '22023', 'member_not_linkable',
  'a child cannot be linked as an account'
);
select throws_ok(
  $$select public.set_my_family_member('f7100000-0000-4000-8000-000000000001', 'f7200000-0000-4000-8000-000000000006')$$,
  '22023', 'member_not_linkable',
  'a pet cannot be linked as an account'
);
select throws_ok(
  $$select public.set_my_family_member('f7100000-0000-4000-8000-000000000001', 'f7200000-0000-4000-8000-000000000002')$$,
  '22023', 'member_not_linkable',
  'an unsorted member under 13 cannot be linked as an account'
);
select throws_ok(
  $$select public.set_my_family_member('f7100000-0000-4000-8000-000000000001', 'f7200000-0000-4000-8000-000000000005', true)$$,
  '22023', 'not_in_list_with_member',
  'not_in_list combined with a member id is an error'
);

-- Direct writes to the link columns are denied (column grant is update (role) only).
select throws_ok(
  $$update public.family_memberships set family_member_id = 'f7200000-0000-4000-8000-000000000010' where user_id = 'f7000000-0000-4000-8000-000000000004'$$,
  '42501', null,
  'a viewer cannot set family_member_id with a direct UPDATE'
);
select set_config('request.jwt.claim.sub', 'f7000000-0000-4000-8000-000000000002', true);
select throws_ok(
  $$update public.family_memberships set family_member_id = 'f7200000-0000-4000-8000-000000000010' where user_id = 'f7000000-0000-4000-8000-000000000003'$$,
  '42501', null,
  'a manager cannot link someone else''s account with a direct UPDATE either'
);
select throws_ok(
  $$update public.family_memberships set not_in_list = true where user_id = 'f7000000-0000-4000-8000-000000000003'$$,
  '42501', null,
  'not_in_list cannot be written with a direct UPDATE'
);

-- not_in_list flow for U4.
select set_config('request.jwt.claim.sub', 'f7000000-0000-4000-8000-000000000004', true);
select lives_ok(
  $$select public.set_my_family_member('f7100000-0000-4000-8000-000000000001', null, true)$$,
  'an account can say "I''m not in the list"'
);
set local role postgres;
select ok(
  (select not_in_list and family_member_id is null from public.family_memberships where user_id = 'f7000000-0000-4000-8000-000000000004' and family_id = 'f7100000-0000-4000-8000-000000000001'),
  'not_in_list is set and the link is clear'
);
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f7000000-0000-4000-8000-000000000004', true);
select lives_ok(
  $$select public.set_my_family_member('f7100000-0000-4000-8000-000000000001', 'f7200000-0000-4000-8000-000000000010')$$,
  'an account that said "not in the list" can still link later (unsorted member, unknown age)'
);
set local role postgres;
select ok(
  (select not not_in_list and family_member_id = 'f7200000-0000-4000-8000-000000000010' from public.family_memberships where user_id = 'f7000000-0000-4000-8000-000000000004' and family_id = 'f7100000-0000-4000-8000-000000000001'),
  'linking reset not_in_list to false'
);
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f7000000-0000-4000-8000-000000000004', true);
select lives_ok(
  $$select public.set_my_family_member('f7100000-0000-4000-8000-000000000001', null, false)$$,
  'an account can unlink itself'
);
set local role postgres;
select ok(
  (select family_member_id is null and not not_in_list from public.family_memberships where user_id = 'f7000000-0000-4000-8000-000000000004' and family_id = 'f7100000-0000-4000-8000-000000000001'),
  'unlinking clears the link and leaves not_in_list false'
);

-- Failure modes: no membership, anonymous.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f7000000-0000-4000-8000-000000000007', true);
select throws_ok(
  $$select public.set_my_family_member('f7100000-0000-4000-8000-000000000001', 'f7200000-0000-4000-8000-000000000010')$$,
  '42501', 'Not authorized',
  'set_my_family_member rejects a caller with no membership in the family'
);
select throws_ok(
  $$select public.unlink_family_member_account('f7100000-0000-4000-8000-000000000001', 'f7200000-0000-4000-8000-000000000005')$$,
  '42501', 'Not authorized',
  'unlink_family_member_account rejects a caller with no membership'
);
select throws_ok(
  $$select public.resolve_family_member_suggestions('f7100000-0000-4000-8000-000000000001', '{}', '{}')$$,
  '42501', 'Not authorized',
  'resolve_family_member_suggestions rejects a caller with no membership'
);

select set_config('request.jwt.claim.sub', 'f7000000-0000-4000-8000-000000000005', true);
select throws_ok(
  $$select public.set_my_family_member('f7100000-0000-4000-8000-000000000001', 'f7200000-0000-4000-8000-000000000010')$$,
  '42501', 'Not authorized',
  'set_my_family_member rejects an anonymous caller despite the simulated manager row'
);
select throws_ok(
  $$select public.unlink_family_member_account('f7100000-0000-4000-8000-000000000001', 'f7200000-0000-4000-8000-000000000005')$$,
  '42501', 'Not authorized',
  'unlink_family_member_account rejects an anonymous caller despite the simulated manager row'
);
select throws_ok(
  $$select public.resolve_family_member_suggestions('f7100000-0000-4000-8000-000000000001', '{}', '{}')$$,
  '42501', 'Not authorized',
  'resolve_family_member_suggestions rejects an anonymous caller despite the simulated manager row'
);

-- Manager unlink (recovery path). U3 is still linked to Nana.
select set_config('request.jwt.claim.sub', 'f7000000-0000-4000-8000-000000000003', true);
select throws_ok(
  $$select public.unlink_family_member_account('f7100000-0000-4000-8000-000000000001', 'f7200000-0000-4000-8000-000000000005')$$,
  '42501', 'Not authorized',
  'a viewer cannot unlink anyone through unlink_family_member_account'
);
select set_config('request.jwt.claim.sub', 'f7000000-0000-4000-8000-000000000006', true);
select throws_ok(
  $$select public.unlink_family_member_account('f7100000-0000-4000-8000-000000000001', 'f7200000-0000-4000-8000-000000000005')$$,
  '42501', 'Not authorized',
  'an owner of another family has no authority to unlink here'
);
select set_config('request.jwt.claim.sub', 'f7000000-0000-4000-8000-000000000002', true);
select lives_ok(
  $$select public.unlink_family_member_account('f7100000-0000-4000-8000-000000000001', 'f7200000-0000-4000-8000-000000000005')$$,
  'a manager can unlink the account claiming a person'
);
set local role postgres;
select ok(
  (select family_member_id is null from public.family_memberships where user_id = 'f7000000-0000-4000-8000-000000000003' and family_id = 'f7100000-0000-4000-8000-000000000001'),
  'the viewer''s link was cleared by the manager'
);

-- Changing a linked member to child / pet nulls the account link.
update public.family_memberships set family_member_id = 'f7200000-0000-4000-8000-000000000009'
where user_id = 'f7000000-0000-4000-8000-000000000004' and family_id = 'f7100000-0000-4000-8000-000000000001';
update public.family_members set relationship = 'child' where id = 'f7200000-0000-4000-8000-000000000009';
select ok(
  (select family_member_id is null from public.family_memberships where user_id = 'f7000000-0000-4000-8000-000000000004' and family_id = 'f7100000-0000-4000-8000-000000000001'),
  'marking a linked member as child nulls the account link'
);
update public.family_members set relationship = null where id = 'f7200000-0000-4000-8000-000000000009';
update public.family_memberships set family_member_id = 'f7200000-0000-4000-8000-000000000009'
where user_id = 'f7000000-0000-4000-8000-000000000004' and family_id = 'f7100000-0000-4000-8000-000000000001';
update public.family_members set relationship = 'pet' where id = 'f7200000-0000-4000-8000-000000000009';
select ok(
  (select family_member_id is null from public.family_memberships where user_id = 'f7000000-0000-4000-8000-000000000004' and family_id = 'f7100000-0000-4000-8000-000000000001'),
  'marking a linked member as pet nulls the account link'
);
update public.family_memberships set family_member_id = 'f7200000-0000-4000-8000-000000000010'
where user_id = 'f7000000-0000-4000-8000-000000000004' and family_id = 'f7100000-0000-4000-8000-000000000001';
update public.family_members set relationship = 'grandparent' where id = 'f7200000-0000-4000-8000-000000000010';
select ok(
  (select family_member_id is not null from public.family_memberships where user_id = 'f7000000-0000-4000-8000-000000000004' and family_id = 'f7100000-0000-4000-8000-000000000001'),
  'marking a linked member as a non-kid role keeps the account link'
);
update public.family_memberships set family_member_id = null
where user_id = 'f7000000-0000-4000-8000-000000000004' and family_id = 'f7100000-0000-4000-8000-000000000001';
update public.family_members set relationship = null where id in ('f7200000-0000-4000-8000-000000000009', 'f7200000-0000-4000-8000-000000000010');

-- One account per person at the index level too.
update public.family_memberships set family_member_id = 'f7200000-0000-4000-8000-000000000005'
where user_id = 'f7000000-0000-4000-8000-000000000003' and family_id = 'f7100000-0000-4000-8000-000000000001';
select throws_ok(
  $$update public.family_memberships set family_member_id = 'f7200000-0000-4000-8000-000000000005' where user_id = 'f7000000-0000-4000-8000-000000000004' and family_id = 'f7100000-0000-4000-8000-000000000001'$$,
  '23505', null,
  'the unique partial index allows one account per family member'
);

-- ---------------------------------------------------------------------------
-- 3. Suggestions: visibility, insert dedupe, grants
-- ---------------------------------------------------------------------------

select is(
  public.insert_family_member_suggestions('f7100000-0000-4000-8000-000000000001', jsonb_build_array(
    jsonb_build_object('family_member_id', 'f7200000-0000-4000-8000-000000000005', 'field', 'relationship', 'value', 'grandparent'),
    jsonb_build_object('family_member_id', 'f7200000-0000-4000-8000-000000000005', 'field', 'family_side', 'value', 'paternal'),
    jsonb_build_object('family_member_id', 'f7200000-0000-4000-8000-000000000007', 'field', 'nickname', 'value', 'lala'),
    jsonb_build_object('family_member_id', 'f7200000-0000-4000-8000-000000000007', 'field', 'nickname', 'value', 'Gigi'),
    jsonb_build_object('family_member_id', 'f7200000-0000-4000-8000-000000000007', 'field', 'nickname', 'value', 'Nana'),
    jsonb_build_object('family_member_id', 'f7200000-0000-4000-8000-000000000008', 'field', 'family_side', 'value', 'member', 'side_member_id', 'f7200000-0000-4000-8000-000000000003', 'based_on', 'maternal'),
    jsonb_build_object('family_member_id', 'f7200000-0000-4000-8000-000000000009', 'field', 'relationship', 'value', 'grandparent'),
    jsonb_build_object('family_member_id', 'f7200000-0000-4000-8000-000000000010', 'field', 'family_side', 'value', 'both'),
    jsonb_build_object('family_member_id', 'f7200000-0000-4000-8000-000000000101', 'field', 'relationship', 'value', 'other')
  )),
  8,
  'insert_family_member_suggestions inserts the valid rows and drops the row naming another family''s member'
);
select is(
  public.insert_family_member_suggestions('f7100000-0000-4000-8000-000000000001', jsonb_build_array(
    jsonb_build_object('family_member_id', 'f7200000-0000-4000-8000-000000000007', 'field', 'nickname', 'value', 'LALA'),
    jsonb_build_object('family_member_id', 'f7200000-0000-4000-8000-000000000005', 'field', 'relationship', 'value', 'grandparent')
  )),
  0,
  'a re-proposed value (any casing) is ignored by the unique expression index'
);
select is(
  public.insert_family_member_suggestions('f7100000-0000-4000-8000-000000000002', jsonb_build_array(
    jsonb_build_object('family_member_id', 'f7200000-0000-4000-8000-000000000101', 'field', 'nickname', 'value', 'Beebee')
  )),
  1,
  'a suggestion can be inserted for the lapsed family too (insert is service-role plumbing)'
);
select throws_ok(
  $$select public.insert_family_member_suggestions('f7100000-0000-4000-8000-000000000001', '{"not":"an array"}'::jsonb)$$,
  '22023', null,
  'a non-array p_rows is rejected'
);
select throws_ok(
  $$insert into public.family_member_suggestions (family_id, family_member_id, field, value)
    values ('f7100000-0000-4000-8000-000000000001', 'f7200000-0000-4000-8000-000000000005', 'relationship', 'not_a_role')$$,
  '23514', null,
  'a relationship suggestion with an unknown role violates the check'
);

-- Selecting suggestions: owner/manager only.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f7000000-0000-4000-8000-000000000003', true);
select is(
  (select count(*)::int from public.family_member_suggestions),
  0,
  'a viewer cannot select suggestions'
);
select set_config('request.jwt.claim.sub', 'f7000000-0000-4000-8000-000000000005', true);
select is(
  (select count(*)::int from public.family_member_suggestions),
  0,
  'an anonymous session cannot select suggestions despite the simulated manager row'
);
select set_config('request.jwt.claim.sub', 'f7000000-0000-4000-8000-000000000007', true);
select is(
  (select count(*)::int from public.family_member_suggestions),
  0,
  'a non-member cannot select suggestions'
);
select set_config('request.jwt.claim.sub', 'f7000000-0000-4000-8000-000000000002', true);
select is(
  (select count(*)::int from public.family_member_suggestions),
  8,
  'a manager sees exactly their own family''s pending suggestions (not the other family''s)'
);
select throws_ok(
  $$insert into public.family_member_suggestions (family_id, family_member_id, field, value)
    values ('f7100000-0000-4000-8000-000000000001', 'f7200000-0000-4000-8000-000000000005', 'nickname', 'Hax')$$,
  '42501', null,
  'a manager cannot insert suggestions directly'
);
select throws_ok(
  $$update public.family_member_suggestions set status = 'accepted' where family_id = 'f7100000-0000-4000-8000-000000000001'$$,
  '42501', null,
  'a manager cannot update suggestions directly'
);
select throws_ok(
  $$select public.insert_family_member_suggestions('f7100000-0000-4000-8000-000000000001', '[]'::jsonb)$$,
  '42501', null,
  'clients cannot call insert_family_member_suggestions'
);

-- ---------------------------------------------------------------------------
-- 4. resolve_family_member_suggestions
-- ---------------------------------------------------------------------------

-- Guards first: viewer, lapsed billing, other-family ids.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f7000000-0000-4000-8000-000000000003', true);
select throws_ok(
  $$select public.resolve_family_member_suggestions('f7100000-0000-4000-8000-000000000001', '{}', '{}')$$,
  '42501', 'Not authorized',
  'a viewer cannot resolve suggestions'
);
select set_config('request.jwt.claim.sub', 'f7000000-0000-4000-8000-000000000006', true);
select throws_ok(
  $$select public.resolve_family_member_suggestions('f7100000-0000-4000-8000-000000000002', '{}', '{}')$$,
  '42501', 'Subscription required',
  'a lapsed (billing-blocked) family owner cannot resolve suggestions through the definer bypass'
);
set local role postgres;
select is(
  (select nicknames from public.family_members where id = 'f7200000-0000-4000-8000-000000000101'),
  '{}'::text[],
  'the lapsed family''s member was not written'
);

-- Manual edit beats an old guess: Grandpa Joe's pending relationship
-- suggestion (based_on null) goes stale when he is manually set to 'other'.
update public.family_members set relationship = 'other' where id = 'f7200000-0000-4000-8000-000000000009';
select is(
  (select status from public.family_member_suggestions where family_member_id = 'f7200000-0000-4000-8000-000000000009' and field = 'relationship'),
  'dismissed',
  'a manual relationship change dismissed that member''s pending relationship suggestion'
);
-- ...and a re-created stale row (bypassing the trigger's timing) is dismissed on resolve, not applied.
insert into public.family_member_suggestions (id, family_id, family_member_id, field, value, based_on)
values ('f7400000-0000-4000-8000-000000000001', 'f7100000-0000-4000-8000-000000000001', 'f7200000-0000-4000-8000-000000000009', 'relationship', 'aunt_uncle', 'cousin');

-- Elena: pending side suggestion but her role is not a side role -> skipped.
-- Sam (cousin): family_side maternal -> 'member' Eduardo (based_on maternal).
update public.family_members set family_side = 'maternal' where id = 'f7200000-0000-4000-8000-000000000008';

-- A pending row in the other family, addressed from family A -> ignored.
select set_config('test.fam_b_row', (select id::text from public.family_member_suggestions where family_id = 'f7100000-0000-4000-8000-000000000002'), true);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'f7000000-0000-4000-8000-000000000002', true);

select is(
  public.resolve_family_member_suggestions(
    'f7100000-0000-4000-8000-000000000001',
    array(
      select id from public.family_member_suggestions
      where family_member_id in ('f7200000-0000-4000-8000-000000000005', 'f7200000-0000-4000-8000-000000000007', 'f7200000-0000-4000-8000-000000000008', 'f7200000-0000-4000-8000-000000000010')
        and status = 'pending'
      union all select 'f7400000-0000-4000-8000-000000000001'::uuid
      union all select current_setting('test.fam_b_row')::uuid
    ),
    '{}'
  ),
  '{"accepted": 5, "dismissed": 3}'::jsonb,
  'resolve reports 5 applied and 3 dismissed (stale based_on, non-side role, name collision); the other family''s id is ignored'
);

set local role postgres;
select is(
  (select relationship from public.family_members where id = 'f7200000-0000-4000-8000-000000000005'),
  'grandparent',
  'accepted relationship suggestion was applied'
);
select is(
  (select family_side from public.family_members where id = 'f7200000-0000-4000-8000-000000000005'),
  'paternal',
  'accepted family_side suggestion was applied after the role in the same call'
);
select ok(
  (select family_side is null and side_member_id = 'f7200000-0000-4000-8000-000000000003' from public.family_members where id = 'f7200000-0000-4000-8000-000000000008'),
  'accepting a member-side suggestion sets side_member_id and clears the stale family_side'
);
select is(
  (select nicknames from public.family_members where id = 'f7200000-0000-4000-8000-000000000007'),
  '{Lala,Gigi}'::text[],
  '"lala" deduped against existing "Lala" (no duplicate); "Gigi" appended'
);
select is(
  (select status from public.family_member_suggestions where family_member_id = 'f7200000-0000-4000-8000-000000000007' and value = 'Nana'),
  'dismissed',
  'a nickname equal to another member''s name ("Nana") is dismissed, not applied'
);
select is(
  (select relationship from public.family_members where id = 'f7200000-0000-4000-8000-000000000009'),
  'other',
  'a stale based_on relationship suggestion did not overwrite the manual edit'
);
select is(
  (select status from public.family_member_suggestions where id = 'f7400000-0000-4000-8000-000000000001'),
  'dismissed',
  'the stale row was marked dismissed'
);
select ok(
  (select relationship is null and family_side is null from public.family_members where id = 'f7200000-0000-4000-8000-000000000010'),
  'a side suggestion for a member without a side role was not applied'
);
select is(
  (select status from public.family_member_suggestions where family_member_id = 'f7200000-0000-4000-8000-000000000010' and field = 'family_side'),
  'dismissed',
  'the skipped side row was marked dismissed'
);
select ok(
  (select count(*) = 5 and bool_and(decided_at is not null and decided_by = 'f7000000-0000-4000-8000-000000000002')
   from public.family_member_suggestions where status = 'accepted' and family_id = 'f7100000-0000-4000-8000-000000000001'),
  'accepted rows carry decided_at and decided_by (the resolving manager)'
);
select is(
  (select status from public.family_member_suggestions where family_id = 'f7100000-0000-4000-8000-000000000002'),
  'pending',
  'the other family''s pending suggestion is untouched'
);

-- Dismissed values are never re-proposed.
select is(
  public.insert_family_member_suggestions('f7100000-0000-4000-8000-000000000001', jsonb_build_array(
    jsonb_build_object('family_member_id', 'f7200000-0000-4000-8000-000000000007', 'field', 'nickname', 'value', 'nana')
  )),
  0,
  'a dismissed nickname is never re-proposed (any casing)'
);

-- Explicit dismiss + non-pending ids ignored.
insert into public.family_member_suggestions (id, family_id, family_member_id, field, value, based_on)
values ('f7400000-0000-4000-8000-000000000002', 'f7100000-0000-4000-8000-000000000001', 'f7200000-0000-4000-8000-000000000006', 'nickname', 'Rexy', null);
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f7000000-0000-4000-8000-000000000001', true);
select is(
  public.resolve_family_member_suggestions(
    'f7100000-0000-4000-8000-000000000001',
    array['f7400000-0000-4000-8000-000000000002'::uuid],
    array['f7400000-0000-4000-8000-000000000002'::uuid, (select id from public.family_member_suggestions where value = 'Gigi')]
  ),
  '{"accepted": 0, "dismissed": 1}'::jsonb,
  'an id in both lists is dismissed, and an already-accepted id is ignored'
);
set local role postgres;
select is(
  (select nicknames from public.family_members where id = 'f7200000-0000-4000-8000-000000000006'),
  '{}'::text[],
  'the dismissed nickname was not applied'
);
select is(
  (select status from public.family_member_suggestions where value = 'Gigi'),
  'accepted',
  'an accepted suggestion is never flipped by a later resolve call'
);

-- ---------------------------------------------------------------------------
-- 5. Delete behavior: side/link nulled, suggestions cascade
-- ---------------------------------------------------------------------------

insert into public.family_members (id, family_id, name, relationship) values
  ('f7200000-0000-4000-8000-000000000030', 'f7100000-0000-4000-8000-000000000001', 'Temp Parent', 'parent');
insert into public.family_members (id, family_id, name, relationship, side_member_id) values
  ('f7200000-0000-4000-8000-000000000031', 'f7100000-0000-4000-8000-000000000001', 'Aunt Tee', 'aunt_uncle', 'f7200000-0000-4000-8000-000000000030');
update public.family_memberships set family_member_id = 'f7200000-0000-4000-8000-000000000030'
where user_id = 'f7000000-0000-4000-8000-000000000004' and family_id = 'f7100000-0000-4000-8000-000000000001';
insert into public.family_member_suggestions (family_id, family_member_id, field, value, based_on)
values ('f7100000-0000-4000-8000-000000000001', 'f7200000-0000-4000-8000-000000000030', 'nickname', 'Tempy', null);
insert into public.family_member_suggestions (family_id, family_member_id, field, value, side_member_id, based_on)
values ('f7100000-0000-4000-8000-000000000001', 'f7200000-0000-4000-8000-000000000031', 'family_side', 'member', 'f7200000-0000-4000-8000-000000000030', null);

delete from public.family_members where id = 'f7200000-0000-4000-8000-000000000030';

select ok(
  (select side_member_id is null and family_id = 'f7100000-0000-4000-8000-000000000001' and relationship = 'aunt_uncle'
   from public.family_members where id = 'f7200000-0000-4000-8000-000000000031'),
  'deleting the side parent nulls side_member_id only (row, family_id and role survive)'
);
select ok(
  (select family_member_id is null from public.family_memberships where user_id = 'f7000000-0000-4000-8000-000000000004' and family_id = 'f7100000-0000-4000-8000-000000000001'),
  'deleting a linked member nulls the account link (membership row survives)'
);
select is(
  (select count(*)::int from public.family_member_suggestions where family_member_id = 'f7200000-0000-4000-8000-000000000030' or side_member_id = 'f7200000-0000-4000-8000-000000000030'),
  0,
  'deleting a member cascades its suggestions and suggestions that point at it as a side'
);

-- ---------------------------------------------------------------------------
-- 6. Throttle: claim_relationship_suggestion_run / fail_relationship_suggestion_run
-- ---------------------------------------------------------------------------

-- Fixture members inherit created_at = now() when inserted mid-test; age them so
-- only the explicitly-dated member below counts as "created after the last run".
update public.family_members set created_at = now() - interval '10 days'
where family_id = 'f7100000-0000-4000-8000-000000000001';

select ok(
  (select claimed and previous_suggested_at is null from public.claim_relationship_suggestion_run('f7100000-0000-4000-8000-000000000001')),
  'the first claim succeeds and reports no previous run'
);
select ok(
  (select relationship_suggested_at = now() from public.families where id = 'f7100000-0000-4000-8000-000000000001'),
  'a successful claim stamps relationship_suggested_at'
);
select ok(
  (select not claimed and previous_suggested_at = now() from public.claim_relationship_suggestion_run('f7100000-0000-4000-8000-000000000001')),
  'a second immediate claim is refused and reports the previous value'
);
update public.families set relationship_suggested_at = now() - interval '25 hours' where id = 'f7100000-0000-4000-8000-000000000001';
select ok(
  (select claimed from public.claim_relationship_suggestion_run('f7100000-0000-4000-8000-000000000001')),
  'a run older than 24h can be claimed'
);
update public.families set relationship_suggested_at = now() - interval '2 hours' where id = 'f7100000-0000-4000-8000-000000000001';
select ok(
  (select not claimed from public.claim_relationship_suggestion_run('f7100000-0000-4000-8000-000000000001')),
  'a 2h-old run is not claimed when no member was created since'
);
insert into public.family_members (family_id, name, relationship, created_at)
values ('f7100000-0000-4000-8000-000000000001', 'Newcomer', null, now() - interval '30 minutes');
select ok(
  (select claimed from public.claim_relationship_suggestion_run('f7100000-0000-4000-8000-000000000001')),
  'a >1h-old run is claimed when a member was created after it'
);
update public.families set relationship_suggested_at = now() - interval '45 minutes' where id = 'f7100000-0000-4000-8000-000000000001';
select ok(
  (select not claimed from public.claim_relationship_suggestion_run('f7100000-0000-4000-8000-000000000001')),
  'a member created after a <1h-old run does not bypass the 1h window'
);
select ok(
  (select not claimed and previous_suggested_at is null from public.claim_relationship_suggestion_run('f7100000-0000-4000-8000-000000000999')),
  'an unknown family is never claimed'
);
select public.fail_relationship_suggestion_run('f7100000-0000-4000-8000-000000000001');
select is(
  (select relationship_suggested_at from public.families where id = 'f7100000-0000-4000-8000-000000000001'),
  now() - interval '23 hours',
  'the failure backoff sets the marker to now() - 23h (retry in ~1h, never restored)'
);

-- ---------------------------------------------------------------------------
-- 7. family_relationship_signals
-- ---------------------------------------------------------------------------

-- Link the viewer (U3) to Nana so snippets get an author label.
update public.family_memberships set family_member_id = 'f7200000-0000-4000-8000-000000000005'
where user_id = 'f7000000-0000-4000-8000-000000000003' and family_id = 'f7100000-0000-4000-8000-000000000001';

insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, memory_date, created_at) values
  ('f7300000-0000-4000-8000-000000000001', 'f7100000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001', 'Kiddo took first steps with Nana watching', 'text_only', 'none', '2026-09-20', now() - interval '8 days'),
  ('f7300000-0000-4000-8000-000000000002', 'f7100000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000003', 'Grandpa Joe ' || repeat('lorem ', 50), 'text_only', 'none', '2026-09-10', now() - interval '18 days'),
  ('f7300000-0000-4000-8000-000000000003', 'f7100000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001', 'REPORTED secret memory about Kiddo', 'text_only', 'none', '2026-09-27', now() - interval '1 day');
insert into public.memories (id, family_id, user_id, content, audio_transcript, memory_type, media_key, media_content_type, illustration_status, memory_date, created_at)
values ('f7300000-0000-4000-8000-000000000004', 'f7100000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001', null, 'Kiddo said hello to the dog', 'audio', 'f7000000-0000-4000-8000-000000000001/audio/x.m4a', 'audio/mp4', 'none', '2026-09-25', now() - interval '3 days');
insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, memory_date, created_at)
select ('f7300000-0000-4000-8000-0000000001' || lpad(g::text, 2, '0'))::uuid, 'f7100000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001',
       'Everyday Kiddo moment number ' || g, 'text_only', 'none', date '2026-08-01' + g, now() - interval '50 days'
from generate_series(1, 8) g;

insert into public.memory_family_members (memory_id, family_member_id)
select m.id, 'f7200000-0000-4000-8000-000000000001' from public.memories m where m.family_id = 'f7100000-0000-4000-8000-000000000001';
insert into public.memory_family_members (memory_id, family_member_id)
values ('f7300000-0000-4000-8000-000000000001', 'f7200000-0000-4000-8000-000000000005'),
       ('f7300000-0000-4000-8000-000000000003', 'f7200000-0000-4000-8000-000000000005');

insert into public.content_reports (family_id, reporter_user_id, target_type, target_id, reason)
values ('f7100000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000002', 'memory', 'f7300000-0000-4000-8000-000000000003', 'other');

create temp table sig on commit drop as
select public.family_relationship_signals('f7100000-0000-4000-8000-000000000001') as j;

select is(
  (select m->>'first_name' from sig, jsonb_array_elements(j->'members') m where m->>'id' = 'f7200000-0000-4000-8000-000000000003'),
  'Eduardo',
  'signals carry first names only'
);
select is(
  (select (m->>'age_years')::int from sig, jsonb_array_elements(j->'members') m where m->>'id' = 'f7200000-0000-4000-8000-000000000001'),
  extract(year from age(current_date, date '2021-05-01'))::int,
  'signals carry age in whole years'
);
select is(
  (select array_agg(m->>'id' order by m->>'id') from sig, jsonb_array_elements(j->'members') m where (m->>'is_own_child')::boolean),
  array[
    'f7200000-0000-4000-8000-000000000001',
    'f7200000-0000-4000-8000-000000000002'
  ]::text[],
  'own-child rule: the explicit child and the unsorted under-13 baby are children; the cousin aged 6 (explicit role wins), adults and null-DOB unsorted members are not'
);
select is(
  (select (m->>'relationship') from sig, jsonb_array_elements(j->'members') m where m->>'id' = 'f7200000-0000-4000-8000-000000000008'),
  'cousin',
  'signals carry the current relationship'
);
select is(
  (select jsonb_array_length(j->'accounts') from sig),
  1,
  'signals list linked accounts only'
);
select is(
  (select j->'accounts'->0->>'display_name' from sig),
  'Vera',
  'a linked account carries its user_profiles display name'
);
select is(
  (select (c->>'memories')::int from sig, jsonb_array_elements(j->'co_tags') c
   where c->>'member_id' = 'f7200000-0000-4000-8000-000000000005' and c->>'child_id' = 'f7200000-0000-4000-8000-000000000001'),
  1,
  'co-tag counts: Nana shares exactly one visible memory with the own child (the reported one, also tagged with both, is excluded)'
);
select ok(
  (select count(*) = 0 from sig, jsonb_array_elements(j->'snippets') s where s->>'text' like '%REPORTED%'),
  'a memory hidden by an open content report is excluded from snippets'
);
select ok(
  (select max(length(s->>'text')) <= 200 from sig, jsonb_array_elements(j->'snippets') s),
  'snippets are capped at 200 chars'
);
select is(
  (select length(s->>'text') from sig, jsonb_array_elements(j->'snippets') s where s->>'text' like 'Grandpa Joe lorem%'),
  200,
  'a long memory is truncated to exactly 200 chars'
);
select is(
  (select s->'member_ids' @> '["f7200000-0000-4000-8000-000000000009"]'::jsonb from sig, jsonb_array_elements(j->'snippets') s where s->>'text' like 'Grandpa Joe lorem%'),
  true,
  'a member who is named (not tagged) in the text is attached to the snippet'
);
select is(
  (select s->>'author_member_id' from sig, jsonb_array_elements(j->'snippets') s where s->>'text' like 'Grandpa Joe lorem%'),
  'f7200000-0000-4000-8000-000000000005',
  'a snippet is labelled with its author''s linked member id'
);
select ok(
  (select s->>'author_member_id' is null from sig, jsonb_array_elements(j->'snippets') s where s->>'text' like 'Kiddo took first steps%'),
  'a snippet whose author has no linked member has a null author label'
);
select is(
  (select count(*)::int from sig, jsonb_array_elements(j->'snippets') s where s->'member_ids' @> '["f7200000-0000-4000-8000-000000000001"]'::jsonb),
  6,
  'at most 6 snippets per member (the child is in 11 visible memories)'
);
select is(
  (select t.s->>'text' from sig, jsonb_array_elements(j->'snippets') with ordinality as t(s, n) order by t.n limit 1),
  'Kiddo said hello to the dog',
  'snippets are newest first and audio memories fall back to the transcript'
);
select ok(
  (select jsonb_array_length(j->'snippets') <= 40 from sig),
  'never more than 40 snippets'
);

-- ---------------------------------------------------------------------------
-- 8. commit_onboarding kids are 'child'
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', 'f7000000-0000-4000-8000-000000000008', true);
select lives_ok(
  $$select public.commit_onboarding('f7500000-0000-4000-8000-000000000001', 'Onboarding fam', '["Ollie", "Ada"]'::jsonb, null, '[]'::jsonb)$$,
  'commit_onboarding still works with its unchanged signature'
);
set local role postgres;
select ok(
  (select count(*) = 2 and bool_and(relationship = 'child')
   from public.family_members fm join public.onboarding_commits oc on oc.family_id = fm.family_id
   where oc.commit_id = 'f7500000-0000-4000-8000-000000000001'),
  'kids created by commit_onboarding have relationship = child'
);

-- ---------------------------------------------------------------------------
-- 9. ai_usage_events accepts relationship_chat
-- ---------------------------------------------------------------------------

select lives_ok(
  $$insert into public.ai_usage_events (ai_call_id, family_id, actor_user_id, operation, model, success)
    values ('relationship-chat-test', 'f7100000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000002', 'relationship_chat', 'gpt-4o-mini', true)$$,
  'ai_usage_events accepts the relationship_chat operation'
);
select throws_ok(
  $$insert into public.ai_usage_events (ai_call_id, family_id, actor_user_id, operation, model, success)
    values ('relationship-bogus-test', 'f7100000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000002', 'made_up_operation', 'gpt-4o-mini', true)$$,
  '23514', null,
  'ai_usage_events still rejects an unknown operation'
);
select is(
  (select convalidated from pg_constraint where conname = 'ai_usage_events_operation_check' and conrelid = 'public.ai_usage_events'::regclass),
  true,
  'the widened operation check is validated'
);

-- ---------------------------------------------------------------------------
-- 10. Grants: service-role-only functions + RPC exposure
-- ---------------------------------------------------------------------------

select ok(
  not has_function_privilege('authenticated', 'public.insert_family_member_suggestions(uuid,jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.insert_family_member_suggestions(uuid,jsonb)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.insert_family_member_suggestions(uuid,jsonb)', 'EXECUTE'),
  'insert_family_member_suggestions is service_role only'
);
select ok(
  not has_function_privilege('authenticated', 'public.claim_relationship_suggestion_run(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.claim_relationship_suggestion_run(uuid)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.claim_relationship_suggestion_run(uuid)', 'EXECUTE'),
  'claim_relationship_suggestion_run is service_role only'
);
select ok(
  not has_function_privilege('authenticated', 'public.fail_relationship_suggestion_run(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.fail_relationship_suggestion_run(uuid)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.fail_relationship_suggestion_run(uuid)', 'EXECUTE'),
  'fail_relationship_suggestion_run is service_role only'
);
select ok(
  not has_function_privilege('authenticated', 'public.family_relationship_signals(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.family_relationship_signals(uuid)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.family_relationship_signals(uuid)', 'EXECUTE'),
  'family_relationship_signals is service_role only'
);
select ok(
  has_function_privilege('authenticated', 'public.set_my_family_member(uuid,uuid,boolean)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.set_my_family_member(uuid,uuid,boolean)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.unlink_family_member_account(uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.unlink_family_member_account(uuid,uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.resolve_family_member_suggestions(uuid,uuid[],uuid[])', 'EXECUTE')
  and not has_function_privilege('anon', 'public.resolve_family_member_suggestions(uuid,uuid[],uuid[])', 'EXECUTE'),
  'the three client RPCs are executable by authenticated and not by anon'
);

select * from finish();
rollback;
