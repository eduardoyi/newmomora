begin;

-- Emoji reactions (docs/plans/emoji-reactions.md). A reaction is still one
-- memory_likes row. Covers: the default-heart backfill, set_memory_reaction's
-- inserted/changed flags, one row per user, trimming + validation (RPC and
-- check constraint), anonymous / non-member / billing guards,
-- get_memory_engagement's appended columns and top-reaction ordering, the old
-- set_memory_like contract, and that a reaction CHANGE neither duplicates the
-- memory_liked activity event nor leaves a stale emoji in the feed.
select plan(41);

-- ---------------------------------------------------------------------------
-- Fixtures (inserted as the default postgres role; only the RPC/RLS
-- assertions switch to `authenticated`).
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, is_anonymous) values
  ('b7000000-0000-4000-8000-000000000001', 'react-owner@example.test', false),
  ('b7000000-0000-4000-8000-000000000002', 'react-b@example.test', false),
  ('b7000000-0000-4000-8000-000000000003', 'react-c@example.test', false),
  ('b7000000-0000-4000-8000-000000000004', 'react-h@example.test', false),
  ('b7000000-0000-4000-8000-000000000005', 'react-i@example.test', false),
  ('b7000000-0000-4000-8000-000000000006', 'react-outsider@example.test', false),
  ('b7000000-0000-4000-8000-000000000007', 'react-unpaid-owner@example.test', false);
insert into auth.users (id, email, is_anonymous) values
  ('b7000000-0000-4000-8000-000000000008', 'react-anon@example.test', true);

update public.user_profiles set name = 'Owen' where id = 'b7000000-0000-4000-8000-000000000001';
update public.user_profiles set name = 'Bea' where id = 'b7000000-0000-4000-8000-000000000002';

insert into public.families (id, name, owner_id) values
  ('b8000000-0000-4000-8000-000000000001', 'Reactions fixture family', 'b7000000-0000-4000-8000-000000000001'),
  ('b8000000-0000-4000-8000-000000000002', 'Unpaid reactions family', 'b7000000-0000-4000-8000-000000000007');

insert into public.owner_entitlements (
  owner_user_id, app_user_id, environment, store, product_id, entitlement_id,
  period_type, status, expires_at, will_renew
)
values (
  'b7000000-0000-4000-8000-000000000001', 'b7000000-0000-4000-8000-000000000001',
  'production', 'app_store', 'momora_annual_v1', 'momora_plus', 'annual', 'active',
  transaction_timestamp() + interval '30 days', true
);

insert into public.family_memberships (family_id, user_id, role) values
  ('b8000000-0000-4000-8000-000000000001', 'b7000000-0000-4000-8000-000000000001', 'owner'),
  ('b8000000-0000-4000-8000-000000000001', 'b7000000-0000-4000-8000-000000000002', 'viewer'),
  ('b8000000-0000-4000-8000-000000000001', 'b7000000-0000-4000-8000-000000000003', 'viewer'),
  ('b8000000-0000-4000-8000-000000000001', 'b7000000-0000-4000-8000-000000000004', 'viewer'),
  ('b8000000-0000-4000-8000-000000000001', 'b7000000-0000-4000-8000-000000000005', 'viewer'),
  ('b8000000-0000-4000-8000-000000000001', 'b7000000-0000-4000-8000-000000000008', 'viewer'),
  ('b8000000-0000-4000-8000-000000000002', 'b7000000-0000-4000-8000-000000000007', 'owner');

insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status) values
  ('b9000000-0000-4000-8000-000000000001', 'b8000000-0000-4000-8000-000000000001', 'b7000000-0000-4000-8000-000000000001', 'RPC memory', 'text_illustration', 'pending'),
  ('b9000000-0000-4000-8000-000000000002', 'b8000000-0000-4000-8000-000000000001', 'b7000000-0000-4000-8000-000000000001', 'Ranking memory', 'text_illustration', 'pending'),
  ('b9000000-0000-4000-8000-000000000003', 'b8000000-0000-4000-8000-000000000002', 'b7000000-0000-4000-8000-000000000007', 'Unpaid memory', 'text_illustration', 'pending');

-- ---------------------------------------------------------------------------
-- 1. Default backfill: a like inserted without an emoji is a heart.
-- ---------------------------------------------------------------------------

insert into public.memory_likes (memory_id, user_id)
values ('b9000000-0000-4000-8000-000000000001', 'b7000000-0000-4000-8000-000000000003');

select is(
  (select emoji from public.memory_likes where memory_id = 'b9000000-0000-4000-8000-000000000001' and user_id = 'b7000000-0000-4000-8000-000000000003'),
  U&'\2764\FE0F',
  'a like inserted without an emoji defaults to the heart'
);

-- ---------------------------------------------------------------------------
-- 2. set_memory_reaction flags (caller B, memory 1 already has C's heart).
--    Row text: (my_reaction, changed, inserted, like_count)
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', 'b7000000-0000-4000-8000-000000000002', true);

select is(
  (select (r.my_reaction, r.changed, r.inserted, r.like_count)::text
   from public.set_memory_reaction('b9000000-0000-4000-8000-000000000001', U&'\+01F602') r),
  '(' || U&'\+01F602' || ',t,t,2)',
  'a new reaction is inserted and changed'
);
select is(
  (select (r.my_reaction, r.changed, r.inserted, r.like_count)::text
   from public.set_memory_reaction('b9000000-0000-4000-8000-000000000001', U&'\+01F602') r),
  '(' || U&'\+01F602' || ',f,f,2)',
  'the same reaction again is a no-op'
);
select is(
  (select (r.my_reaction, r.changed, r.inserted, r.like_count)::text
   from public.set_memory_reaction('b9000000-0000-4000-8000-000000000001', U&'\+01F64F') r),
  '(' || U&'\+01F64F' || ',t,f,2)',
  'a different reaction replaces the old one: changed but not inserted'
);

set local role postgres;
select is(
  (select count(*)::int from public.family_activity_events
   where kind = 'memory_liked' and memory_id = 'b9000000-0000-4000-8000-000000000001' and like_user_id = 'b7000000-0000-4000-8000-000000000002'),
  1,
  'changing a reaction does not create a second memory_liked activity event'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'b7000000-0000-4000-8000-000000000002', true);

select is(
  (select (r.my_reaction, r.changed, r.inserted)::text
   from public.set_memory_reaction('b9000000-0000-4000-8000-000000000001', '  ' || U&'\+01F44D' || '  ') r),
  '(' || U&'\+01F44D' || ',t,f)',
  'surrounding whitespace is trimmed before storing'
);

set local role postgres;
select is(
  (select count(*)::int from public.memory_likes where memory_id = 'b9000000-0000-4000-8000-000000000001' and user_id = 'b7000000-0000-4000-8000-000000000002'),
  1,
  'a user only ever has one reaction row per memory'
);
select is(
  (select emoji from public.memory_likes where memory_id = 'b9000000-0000-4000-8000-000000000001' and user_id = 'b7000000-0000-4000-8000-000000000002'),
  U&'\+01F44D',
  'the stored emoji is the trimmed value'
);

-- The feed shows the CURRENT emoji, for both the v1 and v2 RPCs. Owner reads.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'b7000000-0000-4000-8000-000000000001', true);

select is(
  (select reaction_emoji from public.get_family_activity_v2('b8000000-0000-4000-8000-000000000001')
   where kind = 'memory_liked' and actor_id = 'b7000000-0000-4000-8000-000000000002'),
  U&'\+01F44D',
  'get_family_activity_v2.reaction_emoji reflects the current reaction'
);
select is(
  (select reaction_emoji from public.get_family_activity('b8000000-0000-4000-8000-000000000001')
   where kind = 'memory_liked' and actor_id = 'b7000000-0000-4000-8000-000000000002'),
  U&'\+01F44D',
  'get_family_activity.reaction_emoji reflects the current reaction'
);
select ok(
  (select bool_and(reaction_emoji is null) from public.get_family_activity_v2('b8000000-0000-4000-8000-000000000001') where kind <> 'memory_liked'),
  'reaction_emoji is null for non-reaction events'
);

-- Removal.
select set_config('request.jwt.claim.sub', 'b7000000-0000-4000-8000-000000000002', true);

select is(
  (select (r.my_reaction is null, r.changed, r.inserted, r.like_count)::text
   from public.set_memory_reaction('b9000000-0000-4000-8000-000000000001', null) r),
  '(t,t,f,1)',
  'a null reaction removes the caller''s row'
);
select is(
  (select (r.my_reaction is null, r.changed, r.inserted, r.like_count)::text
   from public.set_memory_reaction('b9000000-0000-4000-8000-000000000001', null) r),
  '(t,f,f,1)',
  'removing again is a no-op'
);

set local role postgres;
select is(
  (select count(*)::int from public.family_activity_events
   where kind = 'memory_liked' and memory_id = 'b9000000-0000-4000-8000-000000000001' and like_user_id = 'b7000000-0000-4000-8000-000000000002'),
  0,
  'removing a reaction removes its activity event'
);

-- ---------------------------------------------------------------------------
-- 3. Validation: RPC (22023) and check constraint (23514).
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', 'b7000000-0000-4000-8000-000000000002', true);

select throws_ok(
  $$select * from public.set_memory_reaction('b9000000-0000-4000-8000-000000000001', '')$$,
  '22023', 'Invalid reaction', 'the RPC rejects an empty reaction'
);
select throws_ok(
  $$select * from public.set_memory_reaction('b9000000-0000-4000-8000-000000000001', '   ')$$,
  '22023', 'Invalid reaction', 'the RPC rejects a whitespace-only reaction'
);
select throws_ok(
  $$select * from public.set_memory_reaction('b9000000-0000-4000-8000-000000000001', 'a b')$$,
  '22023', 'Invalid reaction', 'the RPC rejects a reaction containing whitespace'
);
select throws_ok(
  $$select * from public.set_memory_reaction('b9000000-0000-4000-8000-000000000001', 'aaaaaaaaaaaaaaaaa')$$,
  '22023', 'Invalid reaction', 'the RPC rejects a 17-character reaction'
);
select lives_ok(
  $$select * from public.set_memory_reaction('b9000000-0000-4000-8000-000000000001', 'aaaaaaaaaaaaaaaa')$$,
  'the RPC accepts a 16-character reaction'
);
select is(
  (select r.changed from public.set_memory_reaction('b9000000-0000-4000-8000-000000000001', null) r),
  true,
  'cleanup: the 16-character reaction is removed'
);

set local role postgres;

select throws_ok(
  $$update public.memory_likes set emoji = '' where memory_id = 'b9000000-0000-4000-8000-000000000001' and user_id = 'b7000000-0000-4000-8000-000000000003'$$,
  '23514', null, 'the constraint rejects an empty emoji'
);
select throws_ok(
  $$update public.memory_likes set emoji = '   ' where memory_id = 'b9000000-0000-4000-8000-000000000001' and user_id = 'b7000000-0000-4000-8000-000000000003'$$,
  '23514', null, 'the constraint rejects a whitespace-only emoji'
);
select throws_ok(
  $$update public.memory_likes set emoji = 'a b' where memory_id = 'b9000000-0000-4000-8000-000000000001' and user_id = 'b7000000-0000-4000-8000-000000000003'$$,
  '23514', null, 'the constraint rejects an emoji containing whitespace'
);
select throws_ok(
  $$update public.memory_likes set emoji = 'aaaaaaaaaaaaaaaaa' where memory_id = 'b9000000-0000-4000-8000-000000000001' and user_id = 'b7000000-0000-4000-8000-000000000003'$$,
  '23514', null, 'the constraint rejects a 17-character emoji'
);

-- ---------------------------------------------------------------------------
-- 4. Guards: anonymous, non-member, billing.
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub', 'b7000000-0000-4000-8000-000000000008', true);
select throws_ok(
  $$select * from public.set_memory_reaction('b9000000-0000-4000-8000-000000000001', 'x')$$,
  '42501', 'Anonymous accounts cannot react to memories',
  'an anonymous session cannot react despite a simulated membership row'
);

select set_config('request.jwt.claim.sub', 'b7000000-0000-4000-8000-000000000006', true);
select throws_ok(
  $$select * from public.set_memory_reaction('b9000000-0000-4000-8000-000000000001', 'x')$$,
  '42501', 'Not authorized',
  'a non-member cannot react to another family''s memory'
);
select throws_ok(
  $$select * from public.set_memory_reaction('b9000000-0000-4000-8000-000000000001', null)$$,
  '42501', 'Not authorized',
  'a non-member cannot remove a reaction either'
);

select set_config('request.jwt.claim.sub', 'b7000000-0000-4000-8000-000000000007', true);
select throws_ok(
  $$select * from public.set_memory_reaction('b9000000-0000-4000-8000-000000000003', 'x')$$,
  'P0001', 'Subscription required for engagement',
  'reacting in an unpaid family requires a subscription'
);
select lives_ok(
  $$select * from public.set_memory_reaction('b9000000-0000-4000-8000-000000000003', null)$$,
  'removing a reaction is still allowed without a subscription'
);

set local role postgres;

select ok(
  has_function_privilege('authenticated', 'public.set_memory_reaction(uuid, text)', 'execute')
  and not has_function_privilege('anon', 'public.set_memory_reaction(uuid, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.memory_top_reactions(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.memory_top_reactions(uuid)', 'execute'),
  'set_memory_reaction is authenticated-only and the top-reactions helper is internal'
);

-- ---------------------------------------------------------------------------
-- 5. get_memory_engagement: appended columns + top-3 ordering (memory 2).
--    Counts: laugh x2, then three singletons ordered by most recent use:
--    pray (-30m) > heart (-1h) > thumbs-up (-2h, dropped by the limit of 3).
-- ---------------------------------------------------------------------------

insert into public.memory_likes (memory_id, user_id, emoji, updated_at) values
  ('b9000000-0000-4000-8000-000000000002', 'b7000000-0000-4000-8000-000000000001', U&'\+01F602', now()),
  ('b9000000-0000-4000-8000-000000000002', 'b7000000-0000-4000-8000-000000000002', U&'\+01F602', now()),
  ('b9000000-0000-4000-8000-000000000002', 'b7000000-0000-4000-8000-000000000003', U&'\2764\FE0F', now() - interval '1 hour'),
  ('b9000000-0000-4000-8000-000000000002', 'b7000000-0000-4000-8000-000000000004', U&'\+01F64F', now() - interval '30 minutes'),
  ('b9000000-0000-4000-8000-000000000002', 'b7000000-0000-4000-8000-000000000005', U&'\+01F44D', now() - interval '2 hours');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'b7000000-0000-4000-8000-000000000002', true);

select is(
  (select top_reactions from public.get_memory_engagement(array['b9000000-0000-4000-8000-000000000002']::uuid[])),
  array[U&'\+01F602', U&'\+01F64F', U&'\2764\FE0F'],
  'top_reactions is count desc, then most recently used, capped at 3'
);
select is(
  (select (like_count, comment_count, liked_by_me, my_reaction)::text
   from public.get_memory_engagement(array['b9000000-0000-4000-8000-000000000002']::uuid[])),
  '(5,0,t,' || U&'\+01F602' || ')',
  'existing columns are unchanged and my_reaction is appended'
);
select is(
  (select my_reaction from public.get_memory_engagement(array['b9000000-0000-4000-8000-000000000001']::uuid[])),
  null,
  'my_reaction is null when the caller has not reacted'
);
select is(
  (select liked_by_me from public.get_memory_engagement(array['b9000000-0000-4000-8000-000000000001']::uuid[])),
  false,
  'liked_by_me stays false when the caller has not reacted'
);
select is(
  (select top_reactions from public.get_memory_engagement(array['b9000000-0000-4000-8000-000000000001']::uuid[])),
  array[U&'\2764\FE0F'],
  'top_reactions reflects the only remaining reaction (C''s heart)'
);

select set_config('request.jwt.claim.sub', 'b7000000-0000-4000-8000-000000000006', true);
select is(
  (select count(*)::int from public.get_memory_engagement(array['b9000000-0000-4000-8000-000000000002']::uuid[])),
  0,
  'a non-member gets no engagement rows'
);

-- ---------------------------------------------------------------------------
-- 6. Old clients: set_memory_like keeps its contract and never overwrites an
--    existing emoji.
-- ---------------------------------------------------------------------------

select set_config('request.jwt.claim.sub', 'b7000000-0000-4000-8000-000000000002', true);

select is(
  (select (l.liked, l.changed, l.like_count)::text
   from public.set_memory_like('b9000000-0000-4000-8000-000000000002', true) l),
  '(t,f,5)',
  'set_memory_like(true) on an existing reaction is a no-op'
);

set local role postgres;
select is(
  (select emoji from public.memory_likes where memory_id = 'b9000000-0000-4000-8000-000000000002' and user_id = 'b7000000-0000-4000-8000-000000000002'),
  U&'\+01F602',
  'set_memory_like does not overwrite an existing laugh with a heart'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'b7000000-0000-4000-8000-000000000002', true);

select is(
  (select (l.liked, l.changed, l.like_count)::text
   from public.set_memory_like('b9000000-0000-4000-8000-000000000001', true) l),
  '(t,t,2)',
  'set_memory_like(true) on a fresh memory still inserts'
);

set local role postgres;
select is(
  (select emoji from public.memory_likes where memory_id = 'b9000000-0000-4000-8000-000000000001' and user_id = 'b7000000-0000-4000-8000-000000000002'),
  U&'\2764\FE0F',
  'a fresh set_memory_like stores the default heart'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'b7000000-0000-4000-8000-000000000002', true);

select is(
  (select (l.liked, l.changed, l.like_count)::text
   from public.set_memory_like('b9000000-0000-4000-8000-000000000002', false) l),
  '(f,t,4)',
  'set_memory_like(false) removes any reaction'
);

set local role postgres;

select * from finish();
rollback;
