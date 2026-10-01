begin;

-- Manager-linked "this is me" (docs/plans/manager-account-linking.md §5).
-- link_family_member_account: owner/manager links an active member's account
-- to a family person. Covers: manager links a viewer; owner links self;
-- manager links the owner; viewer / non-member / other-family owner /
-- anonymous rejected; account_not_in_family; member_not_in_family;
-- member_not_linkable (child, pet, unsorted under-13); a person held by
-- another account is never stolen (member_already_linked, links unchanged);
-- relinking replaces; not_in_list cleared; same-person relink is a no-op;
-- anon has no execute.
select plan(28);

-- ---------------------------------------------------------------------------
-- Fixtures (default postgres role, so RLS/billing never interferes).
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, is_anonymous) values
  ('fa000000-0000-4000-8000-000000000001', 'lnk-owner@example.test', false),
  ('fa000000-0000-4000-8000-000000000002', 'lnk-manager@example.test', false),
  ('fa000000-0000-4000-8000-000000000003', 'lnk-viewer@example.test', false),
  ('fa000000-0000-4000-8000-000000000004', 'lnk-anon@example.test', true),
  ('fa000000-0000-4000-8000-000000000005', 'lnk-outsider@example.test', false),
  ('fa000000-0000-4000-8000-000000000006', 'lnk-other-owner@example.test', false);

insert into public.families (id, name, owner_id) values
  ('fa100000-0000-4000-8000-000000000001', 'Link fixture family', 'fa000000-0000-4000-8000-000000000001'),
  ('fa100000-0000-4000-8000-000000000002', 'Other link family', 'fa000000-0000-4000-8000-000000000006');

insert into public.family_memberships (family_id, user_id, role) values
  ('fa100000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000001', 'owner'),
  ('fa100000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000002', 'manager'),
  ('fa100000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000003', 'viewer'),
  ('fa100000-0000-4000-8000-000000000002', 'fa000000-0000-4000-8000-000000000006', 'owner');

-- Adversarial: simulate a breach where the anonymous user ended up a manager
-- (impossible through client paths -- proves the RPC guard holds on its own).
insert into public.family_memberships (family_id, user_id, role)
values ('fa100000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000004', 'manager');

insert into public.family_members (id, family_id, name, nicknames, date_of_birth, relationship) values
  ('fa200000-0000-4000-8000-000000000001', 'fa100000-0000-4000-8000-000000000001', 'Abuela Lupe', '{}', '1952-03-03', null),
  ('fa200000-0000-4000-8000-000000000002', 'fa100000-0000-4000-8000-000000000001', 'Kiddo', '{}', '2021-05-01', 'child'),
  ('fa200000-0000-4000-8000-000000000003', 'fa100000-0000-4000-8000-000000000001', 'Rex', '{}', null, 'pet'),
  ('fa200000-0000-4000-8000-000000000004', 'fa100000-0000-4000-8000-000000000001', 'Baby', '{}', current_date - 200, null),
  ('fa200000-0000-4000-8000-000000000005', 'fa100000-0000-4000-8000-000000000001', 'Nana', '{}', null, null),
  ('fa200000-0000-4000-8000-000000000007', 'fa100000-0000-4000-8000-000000000001', 'Tia Rosa', '{}', '1975-01-01', 'aunt_uncle'),
  ('fa200000-0000-4000-8000-000000000101', 'fa100000-0000-4000-8000-000000000002', 'Other Olga', '{}', '1980-01-01', 'parent');

-- ---------------------------------------------------------------------------
-- 1. Happy paths
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', 'fa000000-0000-4000-8000-000000000002', true);

select lives_ok(
  $$select public.link_family_member_account('fa100000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000003', 'fa200000-0000-4000-8000-000000000005')$$,
  'a manager can link a viewer to a person'
);
set local role postgres;
select is(
  (select family_member_id::text from public.family_memberships where family_id = 'fa100000-0000-4000-8000-000000000001' and user_id = 'fa000000-0000-4000-8000-000000000003'),
  'fa200000-0000-4000-8000-000000000005',
  'the viewer''s membership now points at Nana'
);
select is(
  (select count(*)::int from public.family_memberships where family_id = 'fa100000-0000-4000-8000-000000000001' and family_member_id is not null),
  1,
  'only the target membership row was written'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'fa000000-0000-4000-8000-000000000001', true);
select lives_ok(
  $$select public.link_family_member_account('fa100000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000001', 'fa200000-0000-4000-8000-000000000001')$$,
  'an owner can link their own account'
);
set local role postgres;
select is(
  (select family_member_id::text from public.family_memberships where family_id = 'fa100000-0000-4000-8000-000000000001' and user_id = 'fa000000-0000-4000-8000-000000000001'),
  'fa200000-0000-4000-8000-000000000001',
  'the owner''s membership now points at Abuela'
);

-- A manager links the owner, replacing the owner's previous link.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'fa000000-0000-4000-8000-000000000002', true);
select lives_ok(
  $$select public.link_family_member_account('fa100000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000001', 'fa200000-0000-4000-8000-000000000007')$$,
  'a manager can link the owner (and relink replaces the previous link)'
);
set local role postgres;
select is(
  (select family_member_id::text from public.family_memberships where family_id = 'fa100000-0000-4000-8000-000000000001' and user_id = 'fa000000-0000-4000-8000-000000000001'),
  'fa200000-0000-4000-8000-000000000007',
  'relinking replaced the owner''s previous link with Tia Rosa'
);
select is(
  (select family_member_id::text from public.family_memberships where family_id = 'fa100000-0000-4000-8000-000000000001' and user_id = 'fa000000-0000-4000-8000-000000000003'),
  'fa200000-0000-4000-8000-000000000005',
  'the viewer''s link is untouched by relinking the owner'
);

-- Manager links themselves.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'fa000000-0000-4000-8000-000000000002', true);
select lives_ok(
  $$select public.link_family_member_account('fa100000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000002', 'fa200000-0000-4000-8000-000000000001')$$,
  'a manager can link themselves'
);

-- Same-person relink is a no-op success.
select lives_ok(
  $$select public.link_family_member_account('fa100000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000001', 'fa200000-0000-4000-8000-000000000007')$$,
  'linking a person to the account that already holds them is a no-op success'
);
set local role postgres;
select is(
  (select family_member_id::text from public.family_memberships where family_id = 'fa100000-0000-4000-8000-000000000001' and user_id = 'fa000000-0000-4000-8000-000000000001'),
  'fa200000-0000-4000-8000-000000000007',
  'the same-person relink left the link unchanged'
);

-- not_in_list is cleared by a manager link.
update public.family_memberships
set family_member_id = null, not_in_list = true
where family_id = 'fa100000-0000-4000-8000-000000000001' and user_id = 'fa000000-0000-4000-8000-000000000003';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'fa000000-0000-4000-8000-000000000002', true);
select lives_ok(
  $$select public.link_family_member_account('fa100000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000003', 'fa200000-0000-4000-8000-000000000005')$$,
  'a manager can link an account that said "not in the list"'
);
set local role postgres;
select ok(
  (select not_in_list = false and family_member_id = 'fa200000-0000-4000-8000-000000000005'
   from public.family_memberships where family_id = 'fa100000-0000-4000-8000-000000000001' and user_id = 'fa000000-0000-4000-8000-000000000003'),
  'linking cleared not_in_list'
);

-- ---------------------------------------------------------------------------
-- 2. A person held by another account is never stolen
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', 'fa000000-0000-4000-8000-000000000002', true);
select throws_ok(
  $$select public.link_family_member_account('fa100000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000003', 'fa200000-0000-4000-8000-000000000007')$$,
  '23505', 'member_already_linked',
  'a person claimed by another account is rejected with member_already_linked'
);
set local role postgres;
select ok(
  (select family_member_id = 'fa200000-0000-4000-8000-000000000007'
   from public.family_memberships where family_id = 'fa100000-0000-4000-8000-000000000001' and user_id = 'fa000000-0000-4000-8000-000000000001')
  and (select family_member_id = 'fa200000-0000-4000-8000-000000000005'
   from public.family_memberships where family_id = 'fa100000-0000-4000-8000-000000000001' and user_id = 'fa000000-0000-4000-8000-000000000003'),
  'both the holder''s and the target''s links are unchanged after the rejected steal'
);

-- ---------------------------------------------------------------------------
-- 3. Validation errors
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', 'fa000000-0000-4000-8000-000000000002', true);
select throws_ok(
  $$select public.link_family_member_account('fa100000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000005', 'fa200000-0000-4000-8000-000000000001')$$,
  '22023', 'account_not_in_family',
  'an account that is not a member of the family is rejected'
);
select throws_ok(
  $$select public.link_family_member_account('fa100000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000006', 'fa200000-0000-4000-8000-000000000001')$$,
  '22023', 'account_not_in_family',
  'an owner of another family is not an account of this family'
);
select throws_ok(
  $$select public.link_family_member_account('fa100000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000003', 'fa200000-0000-4000-8000-000000000101')$$,
  '22023', 'member_not_in_family',
  'a person from another family is rejected'
);
select throws_ok(
  $$select public.link_family_member_account('fa100000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000003', 'fa200000-0000-4000-8000-0000000000ff')$$,
  '22023', 'member_not_in_family',
  'a nonexistent person is rejected'
);
select throws_ok(
  $$select public.link_family_member_account('fa100000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000003', 'fa200000-0000-4000-8000-000000000002')$$,
  '22023', 'member_not_linkable',
  'a child cannot be linked'
);
select throws_ok(
  $$select public.link_family_member_account('fa100000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000003', 'fa200000-0000-4000-8000-000000000003')$$,
  '22023', 'member_not_linkable',
  'a pet cannot be linked'
);
select throws_ok(
  $$select public.link_family_member_account('fa100000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000003', 'fa200000-0000-4000-8000-000000000004')$$,
  '22023', 'member_not_linkable',
  'an unsorted under-13 person cannot be linked'
);

-- ---------------------------------------------------------------------------
-- 4. Authorization
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'fa000000-0000-4000-8000-000000000003', true);
select throws_ok(
  $$select public.link_family_member_account('fa100000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000003', 'fa200000-0000-4000-8000-000000000001')$$,
  '42501', 'Not authorized',
  'a viewer cannot link anyone, not even themselves'
);
select set_config('request.jwt.claim.sub', 'fa000000-0000-4000-8000-000000000005', true);
select throws_ok(
  $$select public.link_family_member_account('fa100000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000003', 'fa200000-0000-4000-8000-000000000001')$$,
  '42501', 'Not authorized',
  'a non-member cannot link anyone'
);
select set_config('request.jwt.claim.sub', 'fa000000-0000-4000-8000-000000000006', true);
select throws_ok(
  $$select public.link_family_member_account('fa100000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000003', 'fa200000-0000-4000-8000-000000000001')$$,
  '42501', 'Not authorized',
  'an owner of another family has no authority here'
);
select set_config('request.jwt.claim.sub', 'fa000000-0000-4000-8000-000000000004', true);
select throws_ok(
  $$select public.link_family_member_account('fa100000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000003', 'fa200000-0000-4000-8000-000000000001')$$,
  '42501', 'Not authorized',
  'an anonymous caller is rejected despite the simulated manager row'
);

set local role anon;
select throws_ok(
  $$select public.link_family_member_account('fa100000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000003', 'fa200000-0000-4000-8000-000000000001')$$,
  '42501', null,
  'the anon role cannot call link_family_member_account'
);
set local role postgres;

select ok(
  has_function_privilege('authenticated', 'public.link_family_member_account(uuid,uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.link_family_member_account(uuid,uuid,uuid)', 'EXECUTE'),
  'link_family_member_account is executable by authenticated and not by anon'
);

select * from finish();
rollback;
