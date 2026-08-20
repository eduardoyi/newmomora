begin;

select plan(11);

insert into auth.users (id, email)
values ('e1000000-0000-4000-8000-000000000001', 'audio-memories@example.test');

insert into public.families (id, name, owner_id)
values (
  'e2000000-0000-4000-8000-000000000001',
  'Audio memories fixture family',
  'e1000000-0000-4000-8000-000000000001'
);

insert into public.family_memberships (id, family_id, user_id, role)
values (
  'e3000000-0000-4000-8000-000000000001',
  'e2000000-0000-4000-8000-000000000001',
  'e1000000-0000-4000-8000-000000000001',
  'owner'
);

-- 1. A kept clip: null content, media_key/media_content_type mirror the
-- clip, illustration_status is 'none'.
select lives_ok(
  $$insert into public.memories (
    id, family_id, user_id, content, memory_type, media_key, media_content_type, illustration_status
  ) values (
    'e4000000-0000-4000-8000-000000000001',
    'e2000000-0000-4000-8000-000000000001',
    'e1000000-0000-4000-8000-000000000001',
    null, 'audio',
    'e1000000-0000-4000-8000-000000000001/memories/e4000000-0000-4000-8000-000000000001/media/clip.m4a',
    'audio/mp4', 'none'
  )$$,
  'an audio memory with a null description is accepted (mirrored media_key/media_content_type, illustration_status none)'
);

-- 1b. content is deliberately unconstrained: an old-build edit screen can
-- still staple a caption onto an audio row without a raw Postgres error.
select lives_ok(
  $$insert into public.memories (
    id, family_id, user_id, content, memory_type, media_key, media_content_type, illustration_status
  ) values (
    'e4000000-0000-4000-8000-000000000002',
    'e2000000-0000-4000-8000-000000000001',
    'e1000000-0000-4000-8000-000000000001',
    'Mia singing in the bath', 'audio',
    'e1000000-0000-4000-8000-000000000001/memories/e4000000-0000-4000-8000-000000000002/media/clip.m4a',
    'audio/mp4', 'none'
  )$$,
  'an audio memory with a non-null description is also accepted'
);

-- 2. Audio has no illustration concept in v1: illustration_status must stay
-- 'none'.
select throws_ok(
  $$insert into public.memories (
    id, family_id, user_id, content, memory_type, media_key, media_content_type, illustration_status
  ) values (
    'e4000000-0000-4000-8000-000000000003',
    'e2000000-0000-4000-8000-000000000001',
    'e1000000-0000-4000-8000-000000000001',
    null, 'audio',
    'e1000000-0000-4000-8000-000000000001/memories/e4000000-0000-4000-8000-000000000003/media/clip.m4a',
    'audio/mp4', 'pending'
  )$$,
  '23514', null,
  'an audio memory with a non-none illustration_status is rejected'
);

-- 3. The single clip row is accepted under its audio parent.
select lives_ok(
  $$insert into public.memory_media (memory_id, object_key, content_type, position)
  values (
    'e4000000-0000-4000-8000-000000000001',
    'e1000000-0000-4000-8000-000000000001/memories/e4000000-0000-4000-8000-000000000001/media/clip.m4a',
    'audio/mp4', 0
  )$$,
  'the single clip row is accepted under its audio parent'
);

-- 4. At most one memory_media row per audio parent -- the second is
-- rejected, even though every column value is otherwise valid.
select throws_ok(
  $$insert into public.memory_media (memory_id, object_key, content_type, position)
  values (
    'e4000000-0000-4000-8000-000000000001',
    'e1000000-0000-4000-8000-000000000001/memories/e4000000-0000-4000-8000-000000000001/media/clip2.m4a',
    'audio/mp4', 1
  )$$,
  '23514', null,
  'a second memory_media row for an audio parent is rejected'
);

-- Fixture: an ordinary photo memory, for the cross-type content_type checks.
insert into public.memories (
  id, family_id, user_id, memory_type, media_key, media_content_type, illustration_status
) values (
  'e4000000-0000-4000-8000-000000000004',
  'e2000000-0000-4000-8000-000000000001',
  'e1000000-0000-4000-8000-000000000001',
  'media',
  'e1000000-0000-4000-8000-000000000001/memories/e4000000-0000-4000-8000-000000000004/media/photo.jpg',
  'image/jpeg', 'none'
);

-- 5. An audio content type is rejected under a non-audio (media) parent.
select throws_ok(
  $$insert into public.memory_media (memory_id, object_key, content_type, position)
  values (
    'e4000000-0000-4000-8000-000000000004',
    'e1000000-0000-4000-8000-000000000001/memories/e4000000-0000-4000-8000-000000000004/media/clip.m4a',
    'audio/mp4', 0
  )$$,
  '23514', null,
  'an audio content type under a media-type parent is rejected'
);

-- 6. A non-audio (image) content type is rejected under an audio parent.
select throws_ok(
  $$insert into public.memory_media (memory_id, object_key, content_type, position)
  values (
    'e4000000-0000-4000-8000-000000000001',
    'e1000000-0000-4000-8000-000000000001/memories/e4000000-0000-4000-8000-000000000001/media/photo.jpg',
    'image/jpeg', 1
  )$$,
  '23514', null,
  'an image content type under an audio-type parent is rejected'
);

-- 7. Type immutability: an audio memory can never become another type.
select throws_ok(
  $$update public.memories
  set memory_type = 'text_only', content = 'converted', media_key = null, media_content_type = null
  where id = 'e4000000-0000-4000-8000-000000000001'$$,
  '23514', null,
  'transitioning an audio memory to text_only is rejected'
);

-- Fixture: an ordinary text_only memory, for the reverse-transition check.
insert into public.memories (id, family_id, user_id, content, memory_type, illustration_status)
values (
  'e4000000-0000-4000-8000-000000000005',
  'e2000000-0000-4000-8000-000000000001',
  'e1000000-0000-4000-8000-000000000001',
  'a note', 'text_only', 'none'
);

-- 8. Type immutability, the reverse direction: no other type can become
-- audio via an update.
select throws_ok(
  $$update public.memories
  set memory_type = 'audio',
    media_key = 'e1000000-0000-4000-8000-000000000001/memories/e4000000-0000-4000-8000-000000000005/media/clip.m4a',
    media_content_type = 'audio/mp4'
  where id = 'e4000000-0000-4000-8000-000000000005'$$,
  '23514', null,
  'transitioning a text_only memory to audio is rejected'
);

-- 9. Looking Back (P1.3b): a backdated audio memory is otherwise eligible
-- (past the 90-day window) but must never enter package selection. Fixture
-- text_only memories keep the written_archive recipe viable so the RPC has
-- something to materialize even with the audio memory correctly excluded.
insert into auth.users (id, email)
values ('e1000000-0000-4000-8000-000000000002', 'audio-looking-back@example.test');

insert into public.user_profiles (id, name, timezone)
values ('e1000000-0000-4000-8000-000000000002', 'Audio Looking Back', 'UTC')
on conflict (id) do update set timezone = excluded.timezone;

insert into public.families (id, name, owner_id)
values (
  'e2000000-0000-4000-8000-000000000002',
  'Audio Looking Back Family',
  'e1000000-0000-4000-8000-000000000002'
);

insert into public.family_memberships (id, family_id, user_id, role)
values (
  'e3000000-0000-4000-8000-000000000002',
  'e2000000-0000-4000-8000-000000000002',
  'e1000000-0000-4000-8000-000000000002',
  'owner'
);

insert into public.memories (
  id, family_id, user_id, content, memory_date, memory_type, media_key, media_content_type, illustration_status
) values (
  'e6000000-0000-4000-8000-000000000001',
  'e2000000-0000-4000-8000-000000000002',
  'e1000000-0000-4000-8000-000000000002',
  'a laugh', current_date - 400, 'audio',
  'e1000000-0000-4000-8000-000000000002/memories/e6000000-0000-4000-8000-000000000001/media/clip.m4a',
  'audio/mp4', 'none'
);

insert into public.memories (id, family_id, user_id, content, memory_date, memory_type, illustration_status)
select
  ('e6000000-0000-4000-8000-' || lpad((series + 1)::text, 12, '0'))::uuid,
  'e2000000-0000-4000-8000-000000000002',
  'e1000000-0000-4000-8000-000000000002',
  'written fixture ' || series,
  current_date - (400 + series),
  'text_only', 'none'
from generate_series(1, 4) as series;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-4000-8000-000000000002', true);
select lives_ok(
  $$select * from public.get_or_create_looking_back_packages('e2000000-0000-4000-8000-000000000002')$$,
  'the Looking Back RPC materializes a package for a family with an otherwise-eligible backdated audio memory'
);
set local role postgres;

select ok(
  not exists (
    select 1 from public.looking_back_package_memories
    where family_id = 'e2000000-0000-4000-8000-000000000002'
      and memory_id = 'e6000000-0000-4000-8000-000000000001'
  ),
  'the backdated audio memory never enters a materialized Looking Back package'
);

select * from finish();
rollback;
