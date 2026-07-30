begin;

-- WP-SEC: proves the anonymous-authorization lockdown
-- (20260729130000_onboarding_anonymous_lockdown.sql) actually denies an
-- anonymous Auth session everywhere a normal tenant operates, and does NOT
-- regress a real signed-up user's access.
select plan(56);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, is_anonymous) values
  ('a1000000-0000-4000-8000-000000000001', 'anon-lockdown@example.test', true),
  ('a1000000-0000-4000-8000-000000000002', 'owner-lockdown@example.test', false),
  ('a1000000-0000-4000-8000-000000000003', 'other-owner-lockdown@example.test', false);

-- Regression: a normal signup still gets a user_profiles row.
select is(
  (select name from public.user_profiles where id = 'a1000000-0000-4000-8000-000000000002'),
  'Parent',
  'handle_new_user still provisions a profile for a permanent Auth user'
);

-- Item 1: an anonymous Auth user gets NO user_profiles row at all.
select ok(
  not exists(select 1 from public.user_profiles where id = 'a1000000-0000-4000-8000-000000000001'),
  'handle_new_user does not provision a profile for an anonymous Auth user'
);

select ok(
  public.is_anonymous_user() is false,
  'is_anonymous_user() is false with no session (role postgres, auth.uid() null)'
);

insert into public.families (id, name, owner_id)
values ('a2000000-0000-4000-8000-000000000001', 'Lockdown fixture family', 'a1000000-0000-4000-8000-000000000002');
insert into public.family_memberships (id, family_id, user_id, role)
values ('a3000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000002', 'owner');
insert into public.family_members (id, family_id, user_id, name, date_of_birth)
values ('a4000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000002', 'Kiddo', '2020-01-01');
insert into public.memories (id, family_id, user_id, content, memory_type)
values ('a5000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000002', 'A real memory', 'text_only');
insert into public.family_invites (id, family_id, code, role, invited_by, status, redeemed_by, redeemed_at)
values ('a6000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'sunny-tiger-lockdown', 'viewer', 'a1000000-0000-4000-8000-000000000002', 'redeemed', 'a1000000-0000-4000-8000-000000000002', now());

-- Adversarial setup: simulate a hypothetical breach where the anonymous
-- user's id somehow ended up as a real 'manager' member of the fixture
-- family (as postgres, bypassing every policy/RPC -- this is NOT reachable
-- through any client path once this migration lands; it exists purely so
-- the tests below prove the RESTRICTIVE RLS layer and the RPC guards hold
-- independently of "an anonymous caller never has real membership", not
-- merely coincide with it). 'manager' (not 'owner', which the fixture
-- family already has -- see one_owner_per_family) still passes every
-- manager+ role check these RPCs otherwise require.
insert into public.family_memberships (id, family_id, user_id, role)
values ('a3000000-0000-4000-8000-000000000099', 'a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'manager');

-- ---------------------------------------------------------------------------
-- RESTRICTIVE RLS: direct PostgREST-shaped reads/writes as the anonymous
-- session, despite the simulated 'manager' membership row above.
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);

select ok(
  public.is_anonymous_user(),
  'is_anonymous_user() is true for the anonymous session'
);

select is(
  (select count(*)::text from public.families where id = 'a2000000-0000-4000-8000-000000000001'),
  '0',
  'anonymous session cannot SELECT a family despite a simulated manager membership row'
);
select is(
  (select count(*)::text from public.family_memberships where user_id = 'a1000000-0000-4000-8000-000000000001'),
  '0',
  'anonymous session cannot SELECT its own simulated membership row'
);
select is(
  (select count(*)::text from public.family_members where family_id = 'a2000000-0000-4000-8000-000000000001'),
  '0',
  'anonymous session cannot SELECT family_members'
);
select is(
  (select count(*)::text from public.memories where family_id = 'a2000000-0000-4000-8000-000000000001'),
  '0',
  'anonymous session cannot SELECT memories'
);
select is(
  (select count(*)::text from public.family_invites where family_id = 'a2000000-0000-4000-8000-000000000001'),
  '0',
  'anonymous session cannot SELECT family_invites'
);
select is(
  (select count(*)::text from public.user_profiles where id = 'a1000000-0000-4000-8000-000000000002'),
  '0',
  'anonymous session cannot SELECT another user''s profile'
);

select throws_ok(
  $$insert into public.memories (family_id, user_id, content, memory_type) values ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'anon write', 'text_only')$$,
  '42501', null,
  'anonymous session cannot INSERT a memory despite the simulated manager row'
);
-- An UPDATE whose target row fails RLS's USING clause simply matches zero
-- rows (no exception -- that only fires for INSERT/the WITH CHECK side,
-- since there is no "existing row" a plain UPDATE must have found). Verify
-- as postgres (bypassing RLS) since the anonymous session can't SELECT the
-- row either.
update public.families set name = 'anon rename' where id = 'a2000000-0000-4000-8000-000000000001';
set local role postgres;
select is(
  (select name from public.families where id = 'a2000000-0000-4000-8000-000000000001'),
  'Lockdown fixture family',
  'anonymous session''s UPDATE of a family matches zero rows despite the simulated manager row'
);
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);
select throws_ok(
  $$insert into public.user_profiles (id, name, timezone) values ('a1000000-0000-4000-8000-000000000001', 'Self-provisioned', 'UTC')$$,
  '42501', null,
  'anonymous session cannot self-provision a user_profiles row directly'
);
select throws_ok(
  $$insert into public.family_members (family_id, user_id, name) values ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'Anon kid')$$,
  '42501', null,
  'anonymous session cannot INSERT a family_members row'
);
select throws_ok(
  $$insert into public.memory_likes (memory_id, user_id) values ('a5000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001')$$,
  '42501', null,
  'anonymous session cannot INSERT a memory_likes row'
);
select throws_ok(
  $$insert into public.memory_comments (memory_id, user_id, content) values ('a5000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'hi')$$,
  '42501', null,
  'anonymous session cannot INSERT a memory_comments row'
);

-- ---------------------------------------------------------------------------
-- SECURITY DEFINER RPC guards -- these bypass RLS entirely, so they are
-- proven independently of the RESTRICTIVE policies above.
-- ---------------------------------------------------------------------------

select throws_ok(
  $$select public.create_family('Anon Family')$$,
  '42501', 'Anonymous accounts cannot create a family',
  'create_family rejects an anonymous caller'
);
select throws_ok(
  $$select public.create_family_invite('a2000000-0000-4000-8000-000000000001', 'viewer')$$,
  '42501', 'Anonymous accounts cannot create an invite',
  'create_family_invite rejects an anonymous caller despite the simulated manager row'
);
select throws_ok(
  $$select public.delete_family('a2000000-0000-4000-8000-000000000001')$$,
  '42501', 'Anonymous accounts cannot delete a family',
  'delete_family rejects an anonymous caller despite the simulated manager row'
);
select throws_ok(
  $$select public.replace_memory_media_assets('a5000000-0000-4000-8000-000000000001', '[]'::jsonb)$$,
  '42501', 'Anonymous accounts cannot modify memory media',
  'replace_memory_media_assets rejects an anonymous caller'
);
select throws_ok(
  $$select public.set_memory_like('a5000000-0000-4000-8000-000000000001', true)$$,
  '42501', 'Anonymous accounts cannot like memories',
  'set_memory_like rejects an anonymous caller despite the simulated manager row'
);
select throws_ok(
  $$select public.create_content_report('memory', 'a5000000-0000-4000-8000-000000000001', 'other', null, null)$$,
  '42501', 'Anonymous accounts cannot file a report',
  'create_content_report rejects an anonymous caller'
);
select throws_ok(
  $$select public.set_family_account_block(true, 'a3000000-0000-4000-8000-000000000001', null)$$,
  '42501', 'Anonymous accounts cannot manage blocked accounts',
  'set_family_account_block rejects an anonymous caller'
);
select throws_ok(
  $$select public.create_family_member_portrait_version(gen_random_uuid(), 'a4000000-0000-4000-8000-000000000001', current_date, 'manual', 'a1000000-0000-4000-8000-000000000001/family/a4000000-0000-4000-8000-000000000001/portraits/x/photo.jpg')$$,
  '42501', 'Anonymous accounts cannot create a portrait version',
  'create_family_member_portrait_version rejects an anonymous caller'
);
select throws_ok(
  $$select public.update_family_member_portrait_version_date(gen_random_uuid(), current_date)$$,
  '42501', 'Anonymous accounts cannot update a portrait version',
  'update_family_member_portrait_version_date rejects an anonymous caller'
);

-- Read-only RPCs: explicit guard, proven despite the simulated manager row.
select throws_ok(
  $$select * from public.get_invite_redeemer('a6000000-0000-4000-8000-000000000001')$$,
  '42501', 'Not authorized',
  'get_invite_redeemer rejects an anonymous caller despite the simulated manager row'
);
select is(
  (select count(*)::text from public.get_my_redeemed_invite_status()),
  '0',
  'get_my_redeemed_invite_status returns nothing for an anonymous caller'
);
select throws_ok(
  $$select * from public.get_family_member_profiles('a2000000-0000-4000-8000-000000000001')$$,
  '42501', 'Not authorized',
  'get_family_member_profiles rejects an anonymous caller despite the simulated manager row'
);
select is(
  (select count(*)::text from public.get_memory_engagement(array['a5000000-0000-4000-8000-000000000001']::uuid[])),
  '0',
  'get_memory_engagement returns nothing for an anonymous caller'
);
select throws_ok(
  $$select * from public.get_my_open_content_reports('a2000000-0000-4000-8000-000000000001')$$,
  '42501', 'Not authorized',
  'get_my_open_content_reports rejects an anonymous caller despite the simulated manager row'
);

-- current_user_local_date stays callable and harmless for anyone, including
-- an anonymous session -- it leaks nothing membership/ownership-shaped.
select lives_ok(
  $$select public.current_user_local_date()$$,
  'current_user_local_date remains callable (and harmless) for an anonymous session'
);

-- Clean up the simulated breach row before proving the real-owner
-- regression path below, so it can't mask a false pass.
set local role postgres;
delete from public.family_memberships where id = 'a3000000-0000-4000-8000-000000000099';

-- ---------------------------------------------------------------------------
-- Regression: a real signed-up owner keeps full access through every path
-- above -- the lockdown must not collaterally break normal tenants.
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000002', true);

select ok(
  not public.is_anonymous_user(),
  'is_anonymous_user() is false for a permanent signed-up session'
);
select is(
  (select count(*)::text from public.families where id = 'a2000000-0000-4000-8000-000000000001'),
  '1',
  'a real owner can still SELECT their own family'
);
-- Field access (not a bare composite `IS NOT NULL`) -- a function returning
-- a row type re-invoked inside a whole-row IS NOT NULL test is a known
-- Postgres planner hazard that can execute a VOLATILE function twice.
select ok(
  (public.create_family('Second real family')).id is not null,
  'a real user can still create_family'
);
select ok(
  (public.set_memory_like('a5000000-0000-4000-8000-000000000001', true)).changed,
  'a real owner can still set_memory_like'
);
select ok(
  public.create_content_report('memory', 'a5000000-0000-4000-8000-000000000001', 'other', null, null) is not null,
  'a real owner can still create_content_report'
);
select is(
  (select count(*)::text from public.get_family_member_profiles('a2000000-0000-4000-8000-000000000001')),
  '1',
  'a real owner can still read get_family_member_profiles'
);
select is(
  (select count(*)::text from public.get_memory_engagement(array['a5000000-0000-4000-8000-000000000001']::uuid[])),
  '1',
  'a real owner can still read get_memory_engagement'
);
select lives_ok(
  $$insert into public.memory_comments (memory_id, user_id, content) values ('a5000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000002', 'still works')$$,
  'a real owner can still insert a memory_comments row'
);

-- ---------------------------------------------------------------------------
-- Grant hygiene: PUBLIC execute is gone; `authenticated` keeps it (the
-- anonymous-vs-permanent distinction is enforced in the function body, not
-- by GRANT, since both share the Postgres `authenticated` role).
-- ---------------------------------------------------------------------------

set local role postgres;
select ok(
  not has_function_privilege('anon', 'public.create_family(text)', 'EXECUTE'),
  'the anon role has no execute on create_family'
);
select ok(
  has_function_privilege('authenticated', 'public.create_family(text)', 'EXECUTE'),
  'the authenticated role retains execute on create_family (body enforces the anonymous guard)'
);
select ok(
  not has_function_privilege('anon', 'public.create_family_invite(uuid,text)', 'EXECUTE'),
  'the anon role has no execute on create_family_invite'
);
select ok(
  not has_function_privilege('anon', 'public.delete_family(uuid)', 'EXECUTE'),
  'the anon role has no execute on delete_family'
);
select ok(
  not has_function_privilege('anon', 'public.replace_memory_media_assets(uuid,jsonb)', 'EXECUTE'),
  'the anon role has no execute on replace_memory_media_assets'
);
select ok(
  not has_function_privilege('anon', 'public.get_invite_redeemer(uuid)', 'EXECUTE'),
  'the anon role has no execute on get_invite_redeemer'
);
select ok(
  not has_function_privilege('anon', 'public.get_my_redeemed_invite_status()', 'EXECUTE'),
  'the anon role has no execute on get_my_redeemed_invite_status'
);

-- ---------------------------------------------------------------------------
-- Not part of this migration's original scope -- a gap found while
-- auditing every definer RPC (see §3b of the migration). These five
-- portrait-attempt functions were always meant to be service_role-only, but
-- their original `revoke ... from public;` (with no anon/authenticated
-- follow-up) left the fully UNAUTHENTICATED `anon` role -- not just an
-- anonymous Auth session -- able to call them directly.
-- ---------------------------------------------------------------------------

select ok(
  not has_function_privilege('anon', 'public.claim_family_member_portrait_generation(uuid,uuid,text,uuid)', 'EXECUTE'),
  'the anon role has no execute on claim_family_member_portrait_generation'
);
select ok(
  not has_function_privilege('authenticated', 'public.claim_family_member_portrait_generation(uuid,uuid,text,uuid)', 'EXECUTE'),
  'the authenticated role has no execute on claim_family_member_portrait_generation (service_role only)'
);
select ok(
  not has_function_privilege('anon', 'public.finish_family_member_portrait_generation(uuid,uuid,text)', 'EXECUTE'),
  'the anon role has no execute on finish_family_member_portrait_generation'
);
select ok(
  not has_function_privilege('anon', 'public.fail_family_member_portrait_generation(uuid,uuid)', 'EXECUTE'),
  'the anon role has no execute on fail_family_member_portrait_generation'
);
select ok(
  not has_function_privilege('anon', 'public.claim_family_member_portrait_deletion(uuid,uuid,uuid)', 'EXECUTE'),
  'the anon role has no execute on claim_family_member_portrait_deletion'
);
select ok(
  not has_function_privilege('anon', 'public.finish_family_member_portrait_deletion(uuid,uuid)', 'EXECUTE'),
  'the anon role has no execute on finish_family_member_portrait_deletion'
);
select ok(
  has_function_privilege('service_role', 'public.claim_family_member_portrait_generation(uuid,uuid,text,uuid)', 'EXECUTE'),
  'service_role retains execute on claim_family_member_portrait_generation'
);
select ok(
  not has_function_privilege('anon', 'public.current_user_local_date()', 'EXECUTE'),
  'the anon role has no execute on current_user_local_date'
);

-- ---------------------------------------------------------------------------
-- Item 5: an abandoned anonymous Auth user cascades cleanly on deletion --
-- zero normal-tenant footprint to begin with, so nothing is orphaned.
-- ---------------------------------------------------------------------------

delete from auth.users where id = 'a1000000-0000-4000-8000-000000000001';
select ok(
  not exists(select 1 from public.user_profiles where id = 'a1000000-0000-4000-8000-000000000001'),
  'deleting the abandoned anonymous Auth user leaves no user_profiles row (there never was one)'
);
select ok(
  not exists(select 1 from public.family_memberships where user_id = 'a1000000-0000-4000-8000-000000000001'),
  'deleting the abandoned anonymous Auth user leaves no family_memberships row (the FK cascades and there was no legitimate one anyway)'
);

select * from finish();
rollback;
