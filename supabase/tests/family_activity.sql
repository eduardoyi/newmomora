begin;

-- Family activity feed (docs/plans/family-activity.md, WP-DB).
-- Covers: trigger-written events for each kind, solo-founder suppression,
-- own-events exclusion, member_pending role gating, un-like removing its
-- event, cascade-delete of a memory's events, the audio-transcript excerpt
-- fallback, blocked-actor exclusion in both get_family_activity and
-- get_family_activity_unread (a non-blocking third member is unaffected),
-- retention (200-cap / 90-day), the no-direct-client-access grant posture
-- on family_activity_events, and the memory_likes select-policy flip
-- (household-read, insert/delete still self-only).
select plan(36);

-- ---------------------------------------------------------------------------
-- Fixtures. All base data is inserted as the connection's default (postgres)
-- role -- same as every other pgTAP fixture in this project -- so RLS/
-- billing gates never interfere with proving trigger behavior; only the
-- RPC/RLS assertions below switch to `authenticated` + a JWT sub claim.
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, is_anonymous) values
  ('91000000-0000-4000-8000-000000000001', 'activity-owner@example.test', false),
  ('91000000-0000-4000-8000-000000000002', 'activity-manager@example.test', false),
  ('91000000-0000-4000-8000-000000000003', 'activity-viewer@example.test', false),
  ('91000000-0000-4000-8000-000000000004', 'activity-redeemer@example.test', false);

-- handle_new_user already inserted a user_profiles row (default name
-- 'Parent') for each auth.users insert above -- update rather than insert.
update public.user_profiles set name = 'Owen' where id = '91000000-0000-4000-8000-000000000001';
update public.user_profiles set name = 'Mia' where id = '91000000-0000-4000-8000-000000000002';
update public.user_profiles set name = 'Vera' where id = '91000000-0000-4000-8000-000000000003';
update public.user_profiles set name = 'Rae' where id = '91000000-0000-4000-8000-000000000004';

insert into public.families (id, name, owner_id)
values ('92000000-0000-4000-8000-000000000001', 'Activity fixture family', '91000000-0000-4000-8000-000000000001');

-- A real entitlement so authenticated-role writes later (memory_likes
-- insert) clear billing_engagement_allowed and only the policy under test
-- decides the outcome.
insert into public.owner_entitlements (
  owner_user_id, app_user_id, environment, store, product_id, entitlement_id,
  period_type, status, expires_at, will_renew
)
values (
  '91000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001',
  'production', 'app_store', 'momora_annual_v1', 'momora_plus', 'annual', 'active',
  transaction_timestamp() + interval '30 days', true
);

-- 1. Solo founder: exactly one membership row so far -- must NOT produce a
--    member_joined event.
insert into public.family_memberships (id, family_id, user_id, role, created_at)
values ('93000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001', 'owner', now() - interval '3 days');

select is(
  (select count(*)::int from public.family_activity_events where family_id = '92000000-0000-4000-8000-000000000001' and kind = 'member_joined'),
  0,
  'solo founder membership produces zero member_joined events'
);

-- 2. Second member (manager) joins -- exactly one member_joined event.
insert into public.family_memberships (id, family_id, user_id, role, created_at)
values ('93000000-0000-4000-8000-000000000002', '92000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000002', 'manager', now() - interval '2 days');

select is(
  (select count(*)::int from public.family_activity_events where family_id = '92000000-0000-4000-8000-000000000001' and kind = 'member_joined'),
  1,
  'the second membership produces exactly one member_joined event'
);

select ok(
  exists (
    select 1 from public.family_activity_events
    where family_id = '92000000-0000-4000-8000-000000000001' and kind = 'member_joined' and actor_id = '91000000-0000-4000-8000-000000000002'
  ),
  'the member_joined event is attributed to the joining member'
);

-- 3. Third member (viewer) joins -- a second member_joined event.
insert into public.family_memberships (id, family_id, user_id, role, created_at)
values ('93000000-0000-4000-8000-000000000003', '92000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000003', 'viewer', now() - interval '1 day');

select is(
  (select count(*)::int from public.family_activity_events where family_id = '92000000-0000-4000-8000-000000000001' and kind = 'member_joined'),
  2,
  'a third membership produces a second member_joined event'
);

-- 4. memory_added: owner adds a memory.
insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, created_at)
values ('94000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001', 'First swim of the summer', 'text_illustration', 'pending', now() - interval '12 hours');

select ok(
  exists (
    select 1 from public.family_activity_events
    where family_id = '92000000-0000-4000-8000-000000000001' and kind = 'memory_added'
      and actor_id = '91000000-0000-4000-8000-000000000001' and memory_id = '94000000-0000-4000-8000-000000000001'
  ),
  'memories insert writes a memory_added event attributed to the creator'
);

-- 4b. memory_added is skipped when user_id is null (service-role / gallery
-- import inserts with no attributed creator).
insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, created_at)
values ('94000000-0000-4000-8000-000000000002', '92000000-0000-4000-8000-000000000001', null, 'Imported without an owner', 'text_illustration', 'pending', now() - interval '11 hours');

select is(
  (select count(*)::int from public.family_activity_events where memory_id = '94000000-0000-4000-8000-000000000002'),
  0,
  'a memory inserted with a null user_id produces no memory_added event'
);

-- 5. memory_commented: viewer comments on the owner's memory.
insert into public.memory_comments (id, memory_id, user_id, content, created_at)
values ('95000000-0000-4000-8000-000000000001', '94000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000003', 'So cute!', now() - interval '10 hours');

select ok(
  exists (
    select 1 from public.family_activity_events
    where family_id = '92000000-0000-4000-8000-000000000001' and kind = 'memory_commented'
      and actor_id = '91000000-0000-4000-8000-000000000003'
      and memory_id = '94000000-0000-4000-8000-000000000001'
      and comment_id = '95000000-0000-4000-8000-000000000001'
  ),
  'memory_comments insert writes a memory_commented event with family resolved via the memory'
);

-- 6. memory_liked: manager likes the owner's memory, then un-likes it.
insert into public.memory_likes (memory_id, user_id, created_at)
values ('94000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000002', now() - interval '9 hours');

select ok(
  exists (
    select 1 from public.family_activity_events
    where family_id = '92000000-0000-4000-8000-000000000001' and kind = 'memory_liked'
      and actor_id = '91000000-0000-4000-8000-000000000002'
      and memory_id = '94000000-0000-4000-8000-000000000001'
      and like_user_id = '91000000-0000-4000-8000-000000000002'
  ),
  'memory_likes insert writes a memory_liked event'
);

delete from public.memory_likes
where memory_id = '94000000-0000-4000-8000-000000000001' and user_id = '91000000-0000-4000-8000-000000000002';

select is(
  (select count(*)::int from public.family_activity_events where kind = 'memory_liked' and memory_id = '94000000-0000-4000-8000-000000000001' and like_user_id = '91000000-0000-4000-8000-000000000002'),
  0,
  'un-liking (memory_likes delete) removes the matching memory_liked event'
);

-- Re-like from the viewer so a memory_liked row survives into the
-- household-read policy test below.
insert into public.memory_likes (memory_id, user_id, created_at)
values ('94000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000003', now() - interval '8 hours');

-- 7. member_pending: an invite gets redeemed by a new user, then approved.
insert into public.family_invites (id, family_id, code, role, status, invited_by, created_at)
values ('96000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', 'quiet-otter-lamp', 'viewer', 'pending', '91000000-0000-4000-8000-000000000001', now() - interval '2 hours');

update public.family_invites
set status = 'redeemed', redeemed_by = '91000000-0000-4000-8000-000000000004', redeemed_at = now() - interval '1 hour'
where id = '96000000-0000-4000-8000-000000000001';

select ok(
  exists (
    select 1 from public.family_activity_events
    where family_id = '92000000-0000-4000-8000-000000000001' and kind = 'member_pending'
      and actor_id = '91000000-0000-4000-8000-000000000004'
      and invite_id = '96000000-0000-4000-8000-000000000001'
  ),
  'an invite moving to redeemed writes a member_pending event'
);

-- ---------------------------------------------------------------------------
-- RPC / RLS assertions -- switch to the authenticated role.
-- ---------------------------------------------------------------------------

-- Viewer cannot see member_pending rows.
set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000003', true);

select is(
  (select count(*)::int from public.get_family_activity('92000000-0000-4000-8000-000000000001') where kind = 'member_pending'),
  0,
  'a viewer does not see member_pending rows from get_family_activity'
);

select is(
  public.get_family_activity_unread('92000000-0000-4000-8000-000000000001'),
  true,
  'a viewer still has other unread activity (member_joined etc) even with member_pending hidden'
);

-- Owner CAN see member_pending rows.
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000001', true);

select is(
  (select count(*)::int from public.get_family_activity('92000000-0000-4000-8000-000000000001') where kind = 'member_pending'),
  1,
  'the owner sees the member_pending row from get_family_activity'
);

-- Own events are excluded from the caller's own feed: the owner authored
-- memory_added(94...01) and should never see it in their own feed, even
-- though the household can.
select is(
  (select count(*)::int from public.get_family_activity('92000000-0000-4000-8000-000000000001') where actor_id = '91000000-0000-4000-8000-000000000001'),
  0,
  'get_family_activity never returns the caller''s own events'
);

select ok(
  exists (
    select 1 from public.get_family_activity('92000000-0000-4000-8000-000000000001')
    where kind = 'memory_commented' and actor_id = '91000000-0000-4000-8000-000000000003'
  ),
  'the owner sees a household member''s comment on their own memory'
);

set local role postgres;

-- Approving the invite deletes the member_pending event.
update public.family_invites
set status = 'approved', resolved_by = '91000000-0000-4000-8000-000000000001', resolved_at = now()
where id = '96000000-0000-4000-8000-000000000001';

select is(
  (select count(*)::int from public.family_activity_events where kind = 'member_pending' and invite_id = '96000000-0000-4000-8000-000000000001'),
  0,
  'approving a redeemed invite deletes its member_pending event'
);

-- ---------------------------------------------------------------------------
-- Anonymous / non-member rejection (mirrors get_family_member_profiles).
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, is_anonymous) values
  ('91000000-0000-4000-8000-000000000005', 'activity-outsider@example.test', false);

set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000005', true);

select throws_ok(
  $$select * from public.get_family_activity('92000000-0000-4000-8000-000000000001')$$,
  '42501', 'Not authorized',
  'an outsider cannot read another family''s activity feed'
);
select throws_ok(
  $$select public.get_family_activity_unread('92000000-0000-4000-8000-000000000001')$$,
  '42501', 'Not authorized',
  'an outsider cannot read another family''s unread state'
);
select throws_ok(
  $$select public.mark_family_activity_seen('92000000-0000-4000-8000-000000000001')$$,
  '42501', 'Not authorized',
  'an outsider cannot mark another family''s activity seen'
);

set local role postgres;

-- ---------------------------------------------------------------------------
-- mark_family_activity_seen clears get_family_activity_unread.
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000003', true);
select public.mark_family_activity_seen('92000000-0000-4000-8000-000000000001');

select is(
  public.get_family_activity_unread('92000000-0000-4000-8000-000000000001'),
  false,
  'mark_family_activity_seen clears get_family_activity_unread for events at or before now'
);

set local role postgres;

-- New activity after the mark flips it back to unread for that viewer.
-- clock_timestamp() (not now()) -- the whole test runs inside one
-- transaction, where now() is frozen at transaction start, same instant
-- mark_family_activity_seen's now() used above.
insert into public.memory_comments (id, memory_id, user_id, content, created_at)
values ('95000000-0000-4000-8000-000000000002', '94000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000002', 'Adorable', clock_timestamp());

set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000003', true);

select is(
  public.get_family_activity_unread('92000000-0000-4000-8000-000000000001'),
  true,
  'a new event after the mark flips get_family_activity_unread back to true'
);

set local role postgres;

-- ---------------------------------------------------------------------------
-- memory_excerpt: content, falling back to audio_transcript.
-- ---------------------------------------------------------------------------

insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, media_key, media_content_type, audio_transcript, created_at)
values (
  '94000000-0000-4000-8000-000000000003', '92000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001',
  null, 'audio', 'none', 'clips/91000000-0000-4000-8000-000000000001/clip.m4a', 'audio/m4a',
  'Grandma tells the best bedtime stories', now()
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000003', true);

select is(
  (select memory_excerpt from public.get_family_activity('92000000-0000-4000-8000-000000000001') where memory_id = '94000000-0000-4000-8000-000000000003'),
  'Grandma tells the best bedtime stories',
  'memory_excerpt falls back to audio_transcript when content is null'
);

set local role postgres;

-- A like on the audio memory, for the household-read select-policy test
-- below (the earlier like on 94...01 does not survive -- see the cascade
-- test right after this one).
insert into public.memory_likes (memory_id, user_id, created_at)
values ('94000000-0000-4000-8000-000000000003', '91000000-0000-4000-8000-000000000003', now());

-- ---------------------------------------------------------------------------
-- Deleting a memory cascades its activity events.
-- ---------------------------------------------------------------------------

delete from public.memories where id = '94000000-0000-4000-8000-000000000001';

select is(
  (select count(*)::int from public.family_activity_events where memory_id = '94000000-0000-4000-8000-000000000001'),
  0,
  'deleting a memory cascades every activity event that referenced it'
);

-- ---------------------------------------------------------------------------
-- Blocked actors: a recipient who blocked the actor never sees that
-- actor's events (get_family_activity) and that actor's events never flip
-- the unread dot (get_family_activity_unread) -- same rule push delivery
-- already applies (docs/features/content-reporting.md, "Activity pushes
-- exclude recipients who blocked the actor"). A third, non-blocking member
-- still sees the blocked actor's events normally. Isolated fixture family
-- so this doesn't interact with the mark-seen / member-pending state above.
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, is_anonymous) values
  ('97000000-0000-4000-8000-000000000001', 'activity-blocker@example.test', false),
  ('97000000-0000-4000-8000-000000000002', 'activity-blocked@example.test', false),
  ('97000000-0000-4000-8000-000000000003', 'activity-bystander@example.test', false);

insert into public.families (id, name, owner_id)
values ('92000000-0000-4000-8000-000000000003', 'Block fixture family', '97000000-0000-4000-8000-000000000001');

-- Founder (A, the future blocker) -- solo, so no member_joined event yet.
insert into public.family_memberships (id, family_id, user_id, role, created_at)
values ('93000000-0000-4000-8000-000000000020', '92000000-0000-4000-8000-000000000003', '97000000-0000-4000-8000-000000000001', 'owner', now() - interval '2 days');

-- B joins -- the only event in this family right now is B's member_joined.
insert into public.family_memberships (id, family_id, user_id, role, created_at)
values ('93000000-0000-4000-8000-000000000021', '92000000-0000-4000-8000-000000000003', '97000000-0000-4000-8000-000000000002', 'manager', now() - interval '1 day');

-- A blocks B.
insert into public.blocked_family_accounts (family_id, blocker_user_id, blocked_membership_id, blocked_user_id)
values ('92000000-0000-4000-8000-000000000003', '97000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000021', '97000000-0000-4000-8000-000000000002');

set local role authenticated;
select set_config('request.jwt.claim.sub', '97000000-0000-4000-8000-000000000001', true);

select is(
  (select count(*)::int from public.get_family_activity('92000000-0000-4000-8000-000000000003') where actor_id = '97000000-0000-4000-8000-000000000002'),
  0,
  'a blocker sees none of the blocked actor''s events in get_family_activity'
);

select is(
  public.get_family_activity_unread('92000000-0000-4000-8000-000000000003'),
  false,
  'get_family_activity_unread is false when the blocked actor''s events are the only ones'
);

set local role postgres;

-- C joins (bystander, no block relationship with B) -- another
-- member_joined event, attributed to C.
insert into public.family_memberships (id, family_id, user_id, role, created_at)
values ('93000000-0000-4000-8000-000000000022', '92000000-0000-4000-8000-000000000003', '97000000-0000-4000-8000-000000000003', 'viewer', now());

set local role authenticated;
select set_config('request.jwt.claim.sub', '97000000-0000-4000-8000-000000000003', true);

select ok(
  exists (
    select 1 from public.get_family_activity('92000000-0000-4000-8000-000000000003')
    where actor_id = '97000000-0000-4000-8000-000000000002'
  ),
  'a non-blocking third member still sees the blocked actor''s events'
);

set local role postgres;

-- ---------------------------------------------------------------------------
-- Retention: prune_family_activity_events keeps newest 200 and drops >90d.
-- ---------------------------------------------------------------------------

insert into public.families (id, name, owner_id)
values ('92000000-0000-4000-8000-000000000002', 'Retention fixture family', '91000000-0000-4000-8000-000000000001');

insert into public.family_memberships (id, family_id, user_id, role, created_at)
values ('93000000-0000-4000-8000-000000000010', '92000000-0000-4000-8000-000000000002', '91000000-0000-4000-8000-000000000001', 'owner', now() - interval '400 days');

-- 210 synthetic recent events (within the 90-day window) -- only the
-- newest 200 should survive the count cap.
insert into public.family_activity_events (family_id, actor_id, kind, created_at)
select
  '92000000-0000-4000-8000-000000000002',
  '91000000-0000-4000-8000-000000000001',
  'member_joined',
  now() - (n || ' minutes')::interval
from generate_series(1, 210) as n;

-- One stale event older than 90 days -- should be dropped by the age cap
-- even though the family is nowhere near the 200-row count cap on its own.
insert into public.family_activity_events (family_id, actor_id, kind, created_at)
values ('92000000-0000-4000-8000-000000000002', '91000000-0000-4000-8000-000000000001', 'member_joined', now() - interval '120 days');

select public.prune_family_activity_events();

select is(
  (select count(*)::int from public.family_activity_events where family_id = '92000000-0000-4000-8000-000000000002'),
  200,
  'prune_family_activity_events caps a family at its newest 200 rows'
);

select is(
  (select count(*)::int from public.family_activity_events where family_id = '92000000-0000-4000-8000-000000000002' and created_at < now() - interval '90 days'),
  0,
  'prune_family_activity_events removes rows older than 90 days regardless of the count cap'
);

-- ---------------------------------------------------------------------------
-- Grant posture: no client role can touch family_activity_events directly.
-- ---------------------------------------------------------------------------

select ok(
  not has_table_privilege('authenticated', 'public.family_activity_events', 'SELECT, INSERT, UPDATE, DELETE'),
  'authenticated has no direct table privilege on family_activity_events'
);
select ok(
  not has_table_privilege('anon', 'public.family_activity_events', 'SELECT, INSERT, UPDATE, DELETE'),
  'anon has no direct table privilege on family_activity_events'
);

-- activity_seen_at is writable only through mark_family_activity_seen
-- (security definer) -- the client's blanket family_memberships UPDATE
-- grant was narrowed to the `role` column only (§2 of the migration).
select ok(
  not has_column_privilege('authenticated', 'public.family_memberships', 'activity_seen_at', 'UPDATE'),
  'authenticated cannot write family_memberships.activity_seen_at directly'
);
select ok(
  has_column_privilege('authenticated', 'public.family_memberships', 'role', 'UPDATE'),
  'authenticated retains the role column-level grant used by updateMemberRole'
);

-- ---------------------------------------------------------------------------
-- memory_likes select-policy flip: household-read, insert/delete self-only.
-- ---------------------------------------------------------------------------

-- The viewer's like on 94...03 (the audio memory) is visible to the
-- manager -- a household member who neither created nor liked it.
set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000002', true);

select ok(
  exists (
    select 1 from public.memory_likes
    where memory_id = '94000000-0000-4000-8000-000000000003' and user_id = '91000000-0000-4000-8000-000000000003'
  ),
  'a household member can select another member''s like row (household-read policy)'
) ;

set local role postgres;

-- Insert/delete are unchanged: still self-only. The manager (auth'd as
-- themself, with a real entitlement on the family so billing_engagement_
-- allowed does not confound the result) cannot insert a like row on
-- someone else's behalf -- INSERT's WITH CHECK failure raises 42501
-- outright (unlike UPDATE/DELETE's silent zero-row USING filter).
set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000002', true);

select throws_ok(
  $$insert into public.memory_likes (memory_id, user_id) values ('94000000-0000-4000-8000-000000000003', '91000000-0000-4000-8000-000000000003')$$,
  '42501', 'new row violates row-level security policy for table "memory_likes"',
  'a household member cannot insert a like row on another member''s behalf -- insert stays self-only'
);

set local role postgres;

select is(
  (select count(*)::int from public.memory_likes where memory_id = '94000000-0000-4000-8000-000000000003' and user_id = '91000000-0000-4000-8000-000000000003'),
  1,
  'the viewer''s own like row is unaffected by the manager''s rejected insert attempt'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000002', true);

delete from public.memory_likes
where memory_id = '94000000-0000-4000-8000-000000000003' and user_id = '91000000-0000-4000-8000-000000000003';

set local role postgres;

select is(
  (select count(*)::int from public.memory_likes where memory_id = '94000000-0000-4000-8000-000000000003' and user_id = '91000000-0000-4000-8000-000000000003'),
  1,
  'a household member still cannot delete another member''s like row -- delete stays self-only'
);

select * from finish();
rollback;
