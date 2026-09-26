begin;

-- Timeline search (docs/features/memory-search.md): search_memories.
-- Covers family isolation, accent/case-insensitive and prefix matching,
-- Spanish text, AI details and hidden transcripts, matched_in, person and
-- feeling chips (alone and combined with text), blocked-account exclusion,
-- punctuation safety, paging, and membership enforcement.
select plan(18);

insert into auth.users (id, email, is_anonymous) values
  ('a5000000-0000-4000-8000-000000000001', 'search-owner@example.test', false),
  ('a5000000-0000-4000-8000-000000000002', 'search-grandma@example.test', false),
  ('a5000000-0000-4000-8000-000000000003', 'search-outsider@example.test', false);

insert into public.families (id, name, owner_id) values
  ('a6000000-0000-4000-8000-000000000001', 'Search family', 'a5000000-0000-4000-8000-000000000001'),
  ('a6000000-0000-4000-8000-000000000002', 'Other family', 'a5000000-0000-4000-8000-000000000003');

insert into public.family_memberships (family_id, user_id, role) values
  ('a6000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000001', 'owner'),
  ('a6000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000002', 'manager'),
  ('a6000000-0000-4000-8000-000000000002', 'a5000000-0000-4000-8000-000000000003', 'owner');

insert into public.family_members (id, family_id, name) values
  ('a7000000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000001', 'Enzo'),
  ('a7000000-0000-4000-8000-000000000002', 'a6000000-0000-4000-8000-000000000001', 'Mara');

insert into public.memories (id, family_id, user_id, content, audio_transcript, memory_type, illustration_status, memory_date, emotion) values
  ('a8000000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000001',
   'Enzo le puso el parche en el ojo a Mara, con mucho cariño', null, 'text_only', 'none', '2026-09-09', 'tender'),
  ('a8000000-0000-4000-8000-000000000002', 'a6000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000001',
   'Cumpleaños de Mara en el café', null, 'text_only', 'none', '2026-03-01', 'joy'),
  -- Added by grandma, who the owner will block below.
  ('a8000000-0000-4000-8000-000000000004', 'a6000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000002',
   'Mara at the park with abuela', null, 'text_only', 'none', '2026-06-01', 'joy'),
  -- Another family's memory with a matching word.
  ('a8000000-0000-4000-8000-000000000005', 'a6000000-0000-4000-8000-000000000002', 'a5000000-0000-4000-8000-000000000003',
   'Mara from another family', null, 'text_only', 'none', '2026-06-02', 'joy');

-- A voice memory: only its hidden transcript mentions the search word.
insert into public.memories (id, family_id, user_id, content, audio_transcript, memory_type, illustration_status, memory_date, emotion, media_key, media_content_type) values
  ('a8000000-0000-4000-8000-000000000003', 'a6000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000001',
   'Bedtime', 'Enzo ven a lavarte los dientes', 'audio', 'none', '2026-05-05', 'funny',
   'a5000000-0000-4000-8000-000000000001/memories/a8/media/clip.m4a', 'audio/mp4');

-- A photo memory with no caption, found only through what the AI saw.
insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status, memory_date, media_key, media_content_type, description, labels, topics) values
  ('a8000000-0000-4000-8000-000000000006', 'a6000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000001',
   null, 'media', 'none', '2026-07-01', 'a5000000-0000-4000-8000-000000000001/memories/x/media/beach.jpg', 'image/jpeg',
   'Two kids building a sandcastle', array['sandcastle', 'bucket'], array['beach', 'first-steps']);

insert into public.memory_family_members (memory_id, family_member_id) values
  ('a8000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001'),
  ('a8000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000002'),
  ('a8000000-0000-4000-8000-000000000002', 'a7000000-0000-4000-8000-000000000002');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a5000000-0000-4000-8000-000000000001', true);

select set_eq(
  $$select memory_id from public.search_memories('a6000000-0000-4000-8000-000000000001', 'mara')$$,
  $$values ('a8000000-0000-4000-8000-000000000001'::uuid), ('a8000000-0000-4000-8000-000000000002'::uuid), ('a8000000-0000-4000-8000-000000000004'::uuid)$$,
  'a word matches only this family''s memories, case-insensitively'
);

select set_eq(
  $$select memory_id from public.search_memories('a6000000-0000-4000-8000-000000000001', 'cafe')$$,
  $$values ('a8000000-0000-4000-8000-000000000002'::uuid)$$,
  'matching ignores accents ("cafe" finds "café")'
);

select set_eq(
  $$select memory_id from public.search_memories('a6000000-0000-4000-8000-000000000001', 'CARIÑO')$$,
  $$values ('a8000000-0000-4000-8000-000000000001'::uuid)$$,
  'accented, upper-case input matches too'
);

select set_eq(
  $$select memory_id from public.search_memories('a6000000-0000-4000-8000-000000000001', 'cumple')$$,
  $$values ('a8000000-0000-4000-8000-000000000002'::uuid)$$,
  'a partial word matches as a prefix while typing ("cumple" finds "cumpleaños")'
);

select set_eq(
  $$select memory_id from public.search_memories('a6000000-0000-4000-8000-000000000001', 'parche mara')$$,
  $$values ('a8000000-0000-4000-8000-000000000001'::uuid)$$,
  'every word must match'
);

select is(
  (select matched_in from public.search_memories('a6000000-0000-4000-8000-000000000001', 'dientes')),
  'voice',
  'a match in the hidden transcript is reported as voice'
);

select is(
  (select matched_in from public.search_memories('a6000000-0000-4000-8000-000000000001', 'sandcastle')),
  'details',
  'a caption-less photo is found through its AI description/labels'
);

select set_eq(
  $$select memory_id from public.search_memories('a6000000-0000-4000-8000-000000000001', 'first steps')$$,
  $$values ('a8000000-0000-4000-8000-000000000006'::uuid)$$,
  'topic slugs are searchable as words'
);

select is(
  (select matched_in from public.search_memories('a6000000-0000-4000-8000-000000000001', 'parche')),
  'text',
  'a match in what people wrote is reported as text'
);

select set_eq(
  $$select memory_id from public.search_memories('a6000000-0000-4000-8000-000000000001', null, 'a7000000-0000-4000-8000-000000000002')$$,
  $$values ('a8000000-0000-4000-8000-000000000001'::uuid), ('a8000000-0000-4000-8000-000000000002'::uuid)$$,
  'a person chip alone returns everything tagged with them'
);

select set_eq(
  $$select memory_id from public.search_memories('a6000000-0000-4000-8000-000000000001', 'cafe', 'a7000000-0000-4000-8000-000000000002')$$,
  $$values ('a8000000-0000-4000-8000-000000000002'::uuid)$$,
  'text and a person chip combine'
);

select results_eq(
  $$select memory_id from public.search_memories('a6000000-0000-4000-8000-000000000001', null, null, 'joy')$$,
  $$values ('a8000000-0000-4000-8000-000000000004'::uuid), ('a8000000-0000-4000-8000-000000000002'::uuid)$$,
  'a feeling chip alone returns matching memories newest first'
);

select is(
  (select count(*)::int from public.search_memories('a6000000-0000-4000-8000-000000000001', '":*&|!()<-> ''')),
  0,
  'punctuation-only input is safe and matches nothing'
);

select is(
  (select count(*)::int from public.search_memories('a6000000-0000-4000-8000-000000000001', 'mara', null, null, 2, 2)),
  1,
  'results page with limit/offset'
);

select is(
  (select count(*)::int from public.search_memories('a6000000-0000-4000-8000-000000000001', '   ')),
  0,
  'an empty search with no chips returns nothing'
);

-- The owner blocks grandma in this family: her memories drop out.
set local role postgres;
insert into public.blocked_family_accounts (family_id, blocker_user_id, blocked_user_id)
values ('a6000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000002');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a5000000-0000-4000-8000-000000000001', true);

select ok(
  not exists (select 1 from public.search_memories('a6000000-0000-4000-8000-000000000001', 'mara') where memory_id = 'a8000000-0000-4000-8000-000000000004'),
  'memories by a blocked account are excluded'
);

-- Grandma still sees her own memory (the block is the owner's, not hers).
select set_config('request.jwt.claim.sub', 'a5000000-0000-4000-8000-000000000002', true);
select ok(
  exists (select 1 from public.search_memories('a6000000-0000-4000-8000-000000000001', 'abuela') where memory_id = 'a8000000-0000-4000-8000-000000000004'),
  'a block only hides results for the account that blocked'
);

select set_config('request.jwt.claim.sub', 'a5000000-0000-4000-8000-000000000003', true);
select throws_ok(
  $$select * from public.search_memories('a6000000-0000-4000-8000-000000000001', 'mara')$$,
  '42501', 'Not authorized',
  'non-members cannot search a family'
);

select * from finish();
rollback;
