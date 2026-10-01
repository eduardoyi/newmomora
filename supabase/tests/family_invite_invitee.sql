begin;

-- Invites for a person (docs/plans/invite-for-person.md, §4.1 / §6).
-- Covers: create_family_invite's new optional invitee args (old 2-arg call,
-- trim / blank / length, member default name + truncation, eligibility
-- rejections, role + anonymous + billing guards); the composite FK's
-- on-delete-set-null; apply_invite_member_link (link, claimed, no longer
-- linkable, never overwrite, not_in_list, status/shape guards); function
-- grants (service_role only / no client grant); and the column-level UPDATE
-- narrowing on family_invites.
select plan(58);

-- ---------------------------------------------------------------------------
-- Fixtures (inserted as the default postgres role so RLS/billing never
-- interfere; assertions switch to `authenticated` + a JWT sub claim).
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, is_anonymous) values
  ('f8000000-0000-4000-8000-000000000001', 'inv-owner@example.test', false),
  ('f8000000-0000-4000-8000-000000000002', 'inv-manager@example.test', false),
  ('f8000000-0000-4000-8000-000000000003', 'inv-viewer@example.test', false),
  ('f8000000-0000-4000-8000-000000000004', 'inv-anon@example.test', true),
  ('f8000000-0000-4000-8000-000000000005', 'inv-redeemer@example.test', false),
  ('f8000000-0000-4000-8000-000000000006', 'inv-lapsed-owner@example.test', false),
  ('f8000000-0000-4000-8000-000000000007', 'inv-claimer@example.test', false),
  ('f8000000-0000-4000-8000-000000000008', 'inv-redeemer-claimed@example.test', false),
  ('f8000000-0000-4000-8000-000000000009', 'inv-redeemer-late@example.test', false),
  ('f8000000-0000-4000-8000-000000000010', 'inv-redeemer-notinlist@example.test', false),
  ('f8000000-0000-4000-8000-000000000011', 'inv-redeemer-approved@example.test', false);

insert into public.families (id, name, owner_id) values
  ('f8100000-0000-4000-8000-000000000001', 'Invitee fixture family', 'f8000000-0000-4000-8000-000000000001'),
  ('f8100000-0000-4000-8000-000000000002', 'Lapsed invitee family', 'f8000000-0000-4000-8000-000000000006');

insert into public.family_memberships (family_id, user_id, role) values
  ('f8100000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000001', 'owner'),
  ('f8100000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000002', 'manager'),
  ('f8100000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000003', 'viewer'),
  ('f8100000-0000-4000-8000-000000000002', 'f8000000-0000-4000-8000-000000000006', 'owner');

-- Adversarial: simulate a breach where the anonymous user ended up a manager
-- (impossible through client paths -- proves the RPC guard holds on its own).
insert into public.family_memberships (family_id, user_id, role)
values ('f8100000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000004', 'manager');

-- Family 1 is paid; family 2 (lapsed owner, no entitlement) is billing-blocked.
insert into public.owner_entitlements (
  owner_user_id, app_user_id, environment, store, product_id, entitlement_id,
  period_type, status, expires_at, will_renew
)
values (
  'f8000000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000001',
  'production', 'app_store', 'momora_annual_v1', 'momora_plus', 'annual', 'active',
  transaction_timestamp() + interval '30 days', true
);

insert into public.family_members (id, family_id, name, nicknames, date_of_birth, relationship) values
  ('f8200000-0000-4000-8000-000000000001', 'f8100000-0000-4000-8000-000000000001', 'Abuela Lupe', '{}', '1952-03-03', null),
  ('f8200000-0000-4000-8000-000000000002', 'f8100000-0000-4000-8000-000000000001', 'Kiddo', '{}', '2021-05-01', 'child'),
  ('f8200000-0000-4000-8000-000000000003', 'f8100000-0000-4000-8000-000000000001', 'Rex', '{}', null, 'pet'),
  ('f8200000-0000-4000-8000-000000000004', 'f8100000-0000-4000-8000-000000000001', 'Baby', '{}', current_date - 200, null),
  ('f8200000-0000-4000-8000-000000000005', 'f8100000-0000-4000-8000-000000000001', repeat('y', 80), '{}', '1950-01-01', 'grandparent'),
  ('f8200000-0000-4000-8000-000000000006', 'f8100000-0000-4000-8000-000000000001', 'Claimed Carl', '{}', '1980-01-01', 'parent'),
  ('f8200000-0000-4000-8000-000000000007', 'f8100000-0000-4000-8000-000000000001', 'Tia Rosa', '{}', '1975-01-01', 'aunt_uncle'),
  ('f8200000-0000-4000-8000-000000000008', 'f8100000-0000-4000-8000-000000000001', 'Tio Sam', '{}', '1974-01-01', 'aunt_uncle'),
  ('f8200000-0000-4000-8000-000000000009', 'f8100000-0000-4000-8000-000000000001', 'Nana', '{}', null, null),
  ('f8200000-0000-4000-8000-000000000010', 'f8100000-0000-4000-8000-000000000001', 'Late Larry', '{}', '1970-01-01', 'parent'),
  ('f8200000-0000-4000-8000-000000000011', 'f8100000-0000-4000-8000-000000000001', 'Delete Dana', '{}', '1971-01-01', 'parent'),
  ('f8200000-0000-4000-8000-000000000012', 'f8100000-0000-4000-8000-000000000001', 'Approved Abe', '{}', '1969-01-01', 'parent'),
  ('f8200000-0000-4000-8000-000000000101', 'f8100000-0000-4000-8000-000000000002', 'Other Olga', '{}', '1980-01-01', 'parent');

-- Carl is already claimed by an account (U7).
insert into public.family_memberships (family_id, user_id, role, family_member_id) values
  ('f8100000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000007', 'viewer', 'f8200000-0000-4000-8000-000000000006');

-- ---------------------------------------------------------------------------
-- 1. create_family_invite: old behaviour with null args
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', 'f8000000-0000-4000-8000-000000000001', true);

select lives_ok(
  $$select public.create_family_invite('f8100000-0000-4000-8000-000000000001', 'viewer')$$,
  'the old 2-arg positional call still works'
);
select ok(
  (select invitee_name is null and family_member_id is null
   from public.family_invites
   where family_id = 'f8100000-0000-4000-8000-000000000001'
   order by created_at desc limit 1),
  'a 2-arg invite has no invitee name and no person'
);
select is(
  (public.create_family_invite(fam := 'f8100000-0000-4000-8000-000000000001', invite_role := 'viewer')).role,
  'viewer',
  'the named-arg call old clients make ({ fam, invite_role }) resolves to the new function'
);
select is(
  (public.create_family_invite(fam := 'f8100000-0000-4000-8000-000000000001', invite_role := 'viewer')).family_member_id,
  null,
  'a named-arg call without invitee args leaves family_member_id null'
);

-- ---------------------------------------------------------------------------
-- 2. Name handling
-- ---------------------------------------------------------------------------

select is(
  (public.create_family_invite('f8100000-0000-4000-8000-000000000001', 'viewer', '  Grandma Ana  ')).invitee_name,
  'Grandma Ana',
  'the invitee name is trimmed'
);
select is(
  (public.create_family_invite('f8100000-0000-4000-8000-000000000001', 'viewer', '   ')).invitee_name,
  null,
  'a whitespace-only name becomes null'
);
select is(
  (public.create_family_invite('f8100000-0000-4000-8000-000000000001', 'viewer', '')).invitee_name,
  null,
  'an empty name becomes null'
);
select is(
  char_length((public.create_family_invite('f8100000-0000-4000-8000-000000000001', 'viewer', repeat('x', 60))).invitee_name),
  60,
  'a 60-character name is accepted'
);
select is(
  char_length((public.create_family_invite('f8100000-0000-4000-8000-000000000001', 'viewer', '  ' || repeat('x', 60) || '  ')).invitee_name),
  60,
  'the 60-character limit applies after trimming'
);
select throws_ok(
  $$select public.create_family_invite('f8100000-0000-4000-8000-000000000001', 'viewer', repeat('x', 61))$$,
  '22023', 'invitee_name_too_long',
  'a 61-character name is rejected with the invitee_name_too_long token'
);

-- ---------------------------------------------------------------------------
-- 3. Person handling
-- ---------------------------------------------------------------------------

select is(
  (public.create_family_invite('f8100000-0000-4000-8000-000000000001', 'viewer', null, 'f8200000-0000-4000-8000-000000000001')).invitee_name,
  'Abuela Lupe',
  'the name defaults from the picked person when left blank'
);
select is(
  (public.create_family_invite('f8100000-0000-4000-8000-000000000001', 'viewer', null, 'f8200000-0000-4000-8000-000000000001')).family_member_id,
  'f8200000-0000-4000-8000-000000000001'::uuid,
  'the picked person is stored on the invite'
);
select is(
  (public.create_family_invite('f8100000-0000-4000-8000-000000000001', 'viewer', 'Lala', 'f8200000-0000-4000-8000-000000000007')).invitee_name,
  'Lala',
  'a typed name wins over the person default'
);
select is(
  (public.create_family_invite('f8100000-0000-4000-8000-000000000001', 'viewer', '   ', 'f8200000-0000-4000-8000-000000000009')).invitee_name,
  'Nana',
  'a whitespace-only typed name still defaults from the person'
);
select is(
  char_length((public.create_family_invite('f8100000-0000-4000-8000-000000000001', 'viewer', null, 'f8200000-0000-4000-8000-000000000005')).invitee_name),
  60,
  'an over-long person name is truncated to 60 for the default'
);
select lives_ok(
  $$select public.create_family_invite('f8100000-0000-4000-8000-000000000001', 'viewer', null, 'f8200000-0000-4000-8000-000000000001')$$,
  'multiple pending invites for the same person are allowed'
);

select throws_ok(
  $$select public.create_family_invite('f8100000-0000-4000-8000-000000000001', 'viewer', null, 'f8200000-0000-4000-8000-000000000101')$$,
  '22023', 'member_not_in_family',
  'a person from another family is rejected'
);
select throws_ok(
  $$select public.create_family_invite('f8100000-0000-4000-8000-000000000001', 'viewer', null, '00000000-0000-4000-8000-000000000000')$$,
  '22023', 'member_not_in_family',
  'an unknown person id is rejected'
);
select throws_ok(
  $$select public.create_family_invite('f8100000-0000-4000-8000-000000000001', 'viewer', null, 'f8200000-0000-4000-8000-000000000002')$$,
  '22023', 'member_not_linkable',
  'a child is rejected'
);
select throws_ok(
  $$select public.create_family_invite('f8100000-0000-4000-8000-000000000001', 'viewer', null, 'f8200000-0000-4000-8000-000000000003')$$,
  '22023', 'member_not_linkable',
  'a pet is rejected'
);
select throws_ok(
  $$select public.create_family_invite('f8100000-0000-4000-8000-000000000001', 'viewer', null, 'f8200000-0000-4000-8000-000000000004')$$,
  '22023', 'member_not_linkable',
  'an unsorted person under 13 is rejected'
);
select throws_ok(
  $$select public.create_family_invite('f8100000-0000-4000-8000-000000000001', 'viewer', null, 'f8200000-0000-4000-8000-000000000006')$$,
  '23505', 'member_already_linked',
  'a person already claimed by an account is rejected'
);

-- ---------------------------------------------------------------------------
-- 4. Guards (role, anonymous, billing, invite role)
-- ---------------------------------------------------------------------------

select throws_ok(
  $$select public.create_family_invite('f8100000-0000-4000-8000-000000000001', 'admin')$$,
  '22023', 'Invalid invite role',
  'an invalid invite role is still rejected'
);

select set_config('request.jwt.claim.sub', 'f8000000-0000-4000-8000-000000000003', true);
select throws_ok(
  $$select public.create_family_invite('f8100000-0000-4000-8000-000000000001', 'viewer', 'Grandma Ana', 'f8200000-0000-4000-8000-000000000001')$$,
  '42501', 'Not authorized',
  'a viewer cannot create an invite'
);

select set_config('request.jwt.claim.sub', 'f8000000-0000-4000-8000-000000000004', true);
select throws_ok(
  $$select public.create_family_invite('f8100000-0000-4000-8000-000000000001', 'viewer', 'Grandma Ana')$$,
  '42501', 'Unauthorized',
  'an anonymous caller is rejected despite the simulated manager row'
);

select set_config('request.jwt.claim.sub', 'f8000000-0000-4000-8000-000000000006', true);
select throws_ok(
  $$select public.create_family_invite('f8100000-0000-4000-8000-000000000002', 'viewer', 'Olga')$$,
  'P0001', null,
  'the billing gate still blocks a lapsed family'
);

select set_config('request.jwt.claim.sub', 'f8000000-0000-4000-8000-000000000002', true);
select lives_ok(
  $$select public.create_family_invite('f8100000-0000-4000-8000-000000000001', 'manager', 'Tia', 'f8200000-0000-4000-8000-000000000007')$$,
  'a manager can create an invite for a person'
);

-- ---------------------------------------------------------------------------
-- 5. Column grants: clients can only update status (D9)
-- ---------------------------------------------------------------------------

set local role postgres;
select ok(
  has_column_privilege('authenticated', 'public.family_invites', 'status', 'UPDATE'),
  'authenticated can UPDATE family_invites.status (revoke)'
);
select ok(
  not has_column_privilege('authenticated', 'public.family_invites', 'invitee_name', 'UPDATE'),
  'authenticated cannot UPDATE family_invites.invitee_name'
);
select ok(
  not has_column_privilege('authenticated', 'public.family_invites', 'family_member_id', 'UPDATE'),
  'authenticated cannot UPDATE family_invites.family_member_id'
);
select ok(
  not has_column_privilege('authenticated', 'public.family_invites', 'role', 'UPDATE'),
  'authenticated cannot UPDATE family_invites.role either'
);
select ok(
  has_table_privilege('authenticated', 'public.family_invites', 'SELECT'),
  'authenticated keeps SELECT on family_invites'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'f8000000-0000-4000-8000-000000000001', true);
select throws_ok(
  $$update public.family_invites set family_member_id = 'f8200000-0000-4000-8000-000000000007' where family_id = 'f8100000-0000-4000-8000-000000000001'$$,
  '42501', null,
  'a manager cannot retarget an invite at another person'
);
select throws_ok(
  $$update public.family_invites set invitee_name = 'Someone else' where family_id = 'f8100000-0000-4000-8000-000000000001'$$,
  '42501', null,
  'a manager cannot rename an invite after creation'
);
select lives_ok(
  $$update public.family_invites set status = 'revoked' where family_id = 'f8100000-0000-4000-8000-000000000001' and status = 'pending'$$,
  'a manager can still revoke invites (update status)'
);

-- ---------------------------------------------------------------------------
-- 6. Function grants
-- ---------------------------------------------------------------------------

set local role postgres;
select ok(
  not has_function_privilege('anon', 'public.apply_invite_member_link(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.apply_invite_member_link(uuid)', 'EXECUTE'),
  'anon and authenticated cannot execute apply_invite_member_link'
);
select ok(
  has_function_privilege('service_role', 'public.apply_invite_member_link(uuid)', 'EXECUTE'),
  'service_role can execute apply_invite_member_link'
);
select ok(
  not has_function_privilege('anon', 'public.is_linkable_family_member(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.is_linkable_family_member(uuid)', 'EXECUTE'),
  'anon and authenticated cannot execute is_linkable_family_member'
);
select ok(
  not has_function_privilege('anon', 'public.create_family_invite(uuid,text,text,uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.create_family_invite(uuid,text,text,uuid)', 'EXECUTE'),
  'create_family_invite: authenticated only (no anon), on the new signature'
);
select ok(
  not exists (
    select 1 from pg_proc
    where pronamespace = 'public'::regnamespace and proname = 'create_family_invite' and pronargs = 2
  ),
  'the old 2-arg create_family_invite is gone (no PGRST203 overload ambiguity)'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'f8000000-0000-4000-8000-000000000001', true);
select throws_ok(
  $$select public.apply_invite_member_link('00000000-0000-4000-8000-000000000000')$$,
  '42501', null,
  'an authenticated owner cannot call apply_invite_member_link'
);
select throws_ok(
  $$select public.is_linkable_family_member('f8200000-0000-4000-8000-000000000001')$$,
  '42501', null,
  'an authenticated owner cannot call is_linkable_family_member'
);

-- ---------------------------------------------------------------------------
-- 7. apply_invite_member_link (as the service role)
-- ---------------------------------------------------------------------------

set local role postgres;

insert into public.family_memberships (family_id, user_id, role) values
  ('f8100000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000005', 'viewer'),
  ('f8100000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000008', 'viewer'),
  ('f8100000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000009', 'viewer'),
  ('f8100000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000011', 'viewer');
insert into public.family_memberships (family_id, user_id, role, not_in_list) values
  ('f8100000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000010', 'viewer', true);

insert into public.family_invites (id, family_id, code, role, status, invited_by, redeemed_by, redeemed_at, family_member_id, invitee_name) values
  -- I1: happy path
  ('f8300000-0000-4000-8000-000000000001', 'f8100000-0000-4000-8000-000000000001', 'apply-happy-one', 'viewer', 'redeemed', 'f8000000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000005', now(), 'f8200000-0000-4000-8000-000000000001', 'Abuela Lupe'),
  -- I2: person already claimed by U7 (unique index)
  ('f8300000-0000-4000-8000-000000000002', 'f8100000-0000-4000-8000-000000000001', 'apply-claimed-two', 'viewer', 'redeemed', 'f8000000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000008', now(), 'f8200000-0000-4000-8000-000000000006', 'Carl'),
  -- I3: person became a child after the invite was made
  ('f8300000-0000-4000-8000-000000000003', 'f8100000-0000-4000-8000-000000000001', 'apply-late-three', 'viewer', 'redeemed', 'f8000000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000009', now(), 'f8200000-0000-4000-8000-000000000010', 'Larry'),
  -- I4: redeemer (U7) already linked to Carl; invite points at Tia
  ('f8300000-0000-4000-8000-000000000004', 'f8100000-0000-4000-8000-000000000001', 'apply-overwrite-four', 'viewer', 'redeemed', 'f8000000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000007', now(), 'f8200000-0000-4000-8000-000000000007', 'Tia'),
  -- I5: redeemer said "I'm not in the list"
  ('f8300000-0000-4000-8000-000000000005', 'f8100000-0000-4000-8000-000000000001', 'apply-notinlist-five', 'viewer', 'redeemed', 'f8000000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000010', now(), 'f8200000-0000-4000-8000-000000000009', 'Nana'),
  -- I6: still pending (nobody redeemed it)
  ('f8300000-0000-4000-8000-000000000006', 'f8100000-0000-4000-8000-000000000001', 'apply-pending-six', 'viewer', 'pending', 'f8000000-0000-4000-8000-000000000001', null, null, 'f8200000-0000-4000-8000-000000000008', 'Sam'),
  -- I7: redeemed but no person
  ('f8300000-0000-4000-8000-000000000007', 'f8100000-0000-4000-8000-000000000001', 'apply-noperson-seven', 'viewer', 'redeemed', 'f8000000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000005', now(), null, 'Someone'),
  -- I8: already approved (the 23505 already-a-member retry path)
  ('f8300000-0000-4000-8000-000000000008', 'f8100000-0000-4000-8000-000000000001', 'apply-approved-eight', 'viewer', 'approved', 'f8000000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000011', now(), 'f8200000-0000-4000-8000-000000000012', 'Abe'),
  -- I9: redeemer account deleted (redeemed_by nulled)
  ('f8300000-0000-4000-8000-000000000009', 'f8100000-0000-4000-8000-000000000001', 'apply-noredeemer-nine', 'viewer', 'redeemed', 'f8000000-0000-4000-8000-000000000001', null, now(), 'f8200000-0000-4000-8000-000000000008', 'Sam');

-- I3: Larry becomes a child (the relationship trigger only touches accounts
-- already linked to him; there are none).
update public.family_members set relationship = 'child'
where id = 'f8200000-0000-4000-8000-000000000010';

-- (table reads for verification run as postgres: service_role has no table
-- grants in the local bootstrap; the definer function itself needs none.)
set local role service_role;
select is(
  public.apply_invite_member_link('f8300000-0000-4000-8000-000000000001'),
  true,
  'apply_invite_member_link links a redeemed invite''s person'
);
set local role postgres;
select is(
  (select family_member_id from public.family_memberships
   where family_id = 'f8100000-0000-4000-8000-000000000001' and user_id = 'f8000000-0000-4000-8000-000000000005'),
  'f8200000-0000-4000-8000-000000000001'::uuid,
  'the redeemer''s membership now points at the invited person'
);
set local role service_role;
select is(
  public.apply_invite_member_link('f8300000-0000-4000-8000-000000000001'),
  true,
  'applying the same link twice is idempotent (still true: the account is linked to that person)'
);
set local role service_role;
select is(
  public.apply_invite_member_link('f8300000-0000-4000-8000-000000000002'),
  false,
  'a person claimed by another account is skipped (false, no error)'
);
set local role postgres;
select is(
  (select family_member_id from public.family_memberships
   where family_id = 'f8100000-0000-4000-8000-000000000001' and user_id = 'f8000000-0000-4000-8000-000000000008'),
  null,
  'the skipped redeemer stays unlinked'
);
set local role service_role;
select is(
  public.apply_invite_member_link('f8300000-0000-4000-8000-000000000003'),
  false,
  'a person who is no longer linkable (now a child) is skipped'
);
set local role service_role;
select is(
  public.apply_invite_member_link('f8300000-0000-4000-8000-000000000004'),
  false,
  'an existing link is never overwritten'
);
set local role postgres;
select is(
  (select family_member_id from public.family_memberships
   where family_id = 'f8100000-0000-4000-8000-000000000001' and user_id = 'f8000000-0000-4000-8000-000000000007'),
  'f8200000-0000-4000-8000-000000000006'::uuid,
  'the redeemer keeps the person they already claimed'
);
set local role service_role;
select is(
  public.apply_invite_member_link('f8300000-0000-4000-8000-000000000005'),
  false,
  'an explicit "I''m not in the list" is not overridden'
);
set local role postgres;
select ok(
  (select not_in_list and family_member_id is null from public.family_memberships
   where family_id = 'f8100000-0000-4000-8000-000000000001' and user_id = 'f8000000-0000-4000-8000-000000000010'),
  'the not_in_list membership is left untouched'
);
set local role service_role;
select is(
  public.apply_invite_member_link('f8300000-0000-4000-8000-000000000006'),
  false,
  'a pending invite (no redeemer) is skipped'
);
set local role service_role;
select is(
  public.apply_invite_member_link('f8300000-0000-4000-8000-000000000007'),
  false,
  'an invite without a person is skipped'
);
set local role service_role;
select is(
  public.apply_invite_member_link('f8300000-0000-4000-8000-000000000008'),
  true,
  'an already-approved invite still links (resolve retry path)'
);
set local role service_role;
select is(
  public.apply_invite_member_link('f8300000-0000-4000-8000-000000000009'),
  false,
  'an invite whose redeemer account is gone is skipped'
);
set local role service_role;
select is(
  public.apply_invite_member_link('00000000-0000-4000-8000-000000000000'),
  false,
  'an unknown invite id returns false'
);

-- ---------------------------------------------------------------------------
-- 8. Deleting a person nulls the invite's link, not the invite
-- ---------------------------------------------------------------------------

set local role postgres;

insert into public.family_invites (id, family_id, code, role, status, invited_by, family_member_id, invitee_name) values
  ('f8300000-0000-4000-8000-000000000010', 'f8100000-0000-4000-8000-000000000001', 'delete-person-ten', 'viewer', 'pending', 'f8000000-0000-4000-8000-000000000001', 'f8200000-0000-4000-8000-000000000011', 'Dana');

delete from public.family_members where id = 'f8200000-0000-4000-8000-000000000011';

select ok(
  (select family_member_id is null and family_id = 'f8100000-0000-4000-8000-000000000001' and invitee_name = 'Dana'
   from public.family_invites where id = 'f8300000-0000-4000-8000-000000000010'),
  'deleting a person nulls family_invites.family_member_id and keeps the invite, its family and its name'
);

select * from finish();
rollback;
