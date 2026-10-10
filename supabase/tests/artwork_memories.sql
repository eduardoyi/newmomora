begin;

select plan(22);

-- Artwork memories (docs/plans/artwork-scanning.md 1.1/1.3): a nullable
-- media_variant on media memories, a code-vocabulary artwork_medium, and an
-- images-only trigger on memory_media for artwork parents.

insert into auth.users (id, email, is_anonymous)
values ('a1000000-0000-4000-8000-000000000001', 'artwork-memories@example.test', false);

insert into public.families (id, name, owner_id)
values (
  'a2000000-0000-4000-8000-000000000001',
  'Artwork memories fixture family',
  'a1000000-0000-4000-8000-000000000001'
);

insert into public.family_memberships (id, family_id, user_id, role)
values (
  'a3000000-0000-4000-8000-000000000001',
  'a2000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000001',
  'owner'
);

-- The media-finalization RPC enforces the production billing gate; keep the
-- fixture on the normal paid path.
insert into public.owner_entitlements (
  owner_user_id, app_user_id, environment, store, product_id, entitlement_id,
  period_type, status, expires_at, will_renew
)
values (
  'a1000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000001',
  'production', 'app_store', 'momora_annual_v1', 'momora_plus',
  'annual', 'active', transaction_timestamp() + interval '30 days', true
);

-- 1-3. Column privileges: media_variant is insertable (so clients can create
-- artwork) but not updatable (immutable without a trigger); artwork_medium is
-- written only by the service-role analysis path.
select ok(
  has_column_privilege('authenticated', 'public.memories', 'media_variant', 'INSERT'),
  'authenticated may INSERT media_variant'
);
select ok(
  not has_column_privilege('authenticated', 'public.memories', 'media_variant', 'UPDATE'),
  'authenticated may not UPDATE media_variant'
);
select ok(
  not has_column_privilege('authenticated', 'public.memories', 'artwork_medium', 'UPDATE'),
  'authenticated may not UPDATE artwork_medium'
);

-- 4. The full client insert path, run as `authenticated` with a real JWT
-- claim so RLS and the column-level grants are exercised (a postgres-role
-- insert would pass even without `grant insert (media_variant)`).
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);

select lives_ok(
  $$insert into public.memories (
    id, user_id, family_id, memory_date, memory_type,
    media_key, media_content_type, illustration_status, media_variant
  ) values (
    'a4000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    'a2000000-0000-4000-8000-000000000001',
    current_date, 'media',
    'a1000000-0000-4000-8000-000000000001/memories/a4000000-0000-4000-8000-000000000001/media/scan1.jpg',
    'image/jpeg', 'none', 'artwork'
  )$$,
  'the authenticated client can insert an artwork media memory'
);

-- 5. ...and cannot change the variant afterwards (no UPDATE grant).
select throws_ok(
  $$update public.memories set media_variant = null
    where id = 'a4000000-0000-4000-8000-000000000001'$$,
  '42501', null,
  'the authenticated client cannot update media_variant (permission denied)'
);

-- 6. ...nor write the AI medium.
select throws_ok(
  $$update public.memories set artwork_medium = 'crayon'
    where id = 'a4000000-0000-4000-8000-000000000001'$$,
  '42501', null,
  'the authenticated client cannot update artwork_medium (permission denied)'
);

-- 7. Regular media memory (null variant), inserted as the client does today.
select lives_ok(
  $$insert into public.memories (
    id, user_id, family_id, memory_date, memory_type,
    media_key, media_content_type, illustration_status
  ) values (
    'a4000000-0000-4000-8000-000000000002',
    'a1000000-0000-4000-8000-000000000001',
    'a2000000-0000-4000-8000-000000000001',
    current_date, 'media',
    'a1000000-0000-4000-8000-000000000001/memories/a4000000-0000-4000-8000-000000000002/media/photo1.jpg',
    'image/jpeg', 'none'
  )$$,
  'a media memory without media_variant still inserts (old clients)'
);

-- 8. Variant check: only 'artwork' is a valid value.
select throws_ok(
  $$insert into public.memories (
    id, user_id, family_id, memory_date, memory_type,
    media_key, media_content_type, illustration_status, media_variant
  ) values (
    'a4000000-0000-4000-8000-000000000003',
    'a1000000-0000-4000-8000-000000000001',
    'a2000000-0000-4000-8000-000000000001',
    current_date, 'media',
    'a1000000-0000-4000-8000-000000000001/memories/a4000000-0000-4000-8000-000000000003/media/x.jpg',
    'image/jpeg', 'none', 'sketchbook'
  )$$,
  '23514', null,
  'an unknown media_variant value is rejected'
);

-- 9-10. Variant check: artwork is a media-only variant (text and audio).
select throws_ok(
  $$insert into public.memories (
    id, user_id, family_id, content, memory_date, memory_type, illustration_status, media_variant
  ) values (
    'a4000000-0000-4000-8000-000000000004',
    'a1000000-0000-4000-8000-000000000001',
    'a2000000-0000-4000-8000-000000000001',
    'a note', current_date, 'text_only', 'none', 'artwork'
  )$$,
  '23514', null,
  'media_variant = artwork on a text_only memory is rejected'
);
select throws_ok(
  $$insert into public.memories (
    id, user_id, family_id, memory_date, memory_type,
    media_key, media_content_type, illustration_status, media_variant
  ) values (
    'a4000000-0000-4000-8000-000000000005',
    'a1000000-0000-4000-8000-000000000001',
    'a2000000-0000-4000-8000-000000000001',
    current_date, 'audio',
    'a1000000-0000-4000-8000-000000000001/memories/a4000000-0000-4000-8000-000000000005/media/clip.m4a',
    'audio/mp4', 'none', 'artwork'
  )$$,
  '23514', null,
  'media_variant = artwork on an audio memory is rejected'
);

-- 11-13. Medium check (run as the table owner, the way the service-role
-- analysis write behaves): the medium requires artwork; any string is allowed
-- (the vocabulary is enforced in code, not in the DB).
set local role postgres;

select lives_ok(
  $$update public.memories set artwork_medium = 'crayon'
    where id = 'a4000000-0000-4000-8000-000000000001'$$,
  'an artwork memory accepts an artwork_medium'
);
select lives_ok(
  $$update public.memories set artwork_medium = 'some future medium'
    where id = 'a4000000-0000-4000-8000-000000000001'$$,
  'artwork_medium has no DB vocabulary check (any string on artwork is allowed)'
);
select throws_ok(
  $$update public.memories set artwork_medium = 'crayon'
    where id = 'a4000000-0000-4000-8000-000000000002'$$,
  '23514', null,
  'artwork_medium on a non-artwork media memory is rejected'
);

-- 14-18. memory_media trigger via replace_memory_media_assets, as
-- `authenticated`.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);

select lives_ok(
  $$select public.replace_memory_media_assets(
    'a4000000-0000-4000-8000-000000000001',
    '[{"objectKey":"a1000000-0000-4000-8000-000000000001/memories/a4000000-0000-4000-8000-000000000001/media/scan1.jpg","contentType":"image/jpeg","durationMs":null,"aspectRatio":0.75},
      {"objectKey":"a1000000-0000-4000-8000-000000000001/memories/a4000000-0000-4000-8000-000000000001/media/scan2.png","contentType":"image/png","durationMs":null,"aspectRatio":1.3}]'::jsonb
  )$$,
  'replace_memory_media_assets accepts image assets on an artwork memory'
);

select throws_ok(
  $$select public.replace_memory_media_assets(
    'a4000000-0000-4000-8000-000000000001',
    '[{"objectKey":"a1000000-0000-4000-8000-000000000001/memories/a4000000-0000-4000-8000-000000000001/media/scan1.jpg","contentType":"image/jpeg","durationMs":null},
      {"objectKey":"a1000000-0000-4000-8000-000000000001/memories/a4000000-0000-4000-8000-000000000001/media/clip.mp4","contentType":"video/mp4","durationMs":3000}]'::jsonb
  )$$,
  '23514', 'artwork_media_must_be_image',
  'replace_memory_media_assets rejects a video asset on an artwork memory'
);

-- The rejected call must have rolled back atomically: the two image rows stay.
set local role postgres;
select is(
  (select count(*)::integer from public.memory_media where memory_id = 'a4000000-0000-4000-8000-000000000001'),
  2,
  'the rejected RPC call left the existing artwork image rows untouched'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);

select lives_ok(
  $$select public.replace_memory_media_assets(
    'a4000000-0000-4000-8000-000000000002',
    '[{"objectKey":"a1000000-0000-4000-8000-000000000001/memories/a4000000-0000-4000-8000-000000000002/media/photo1.jpg","contentType":"image/jpeg","durationMs":null},
      {"objectKey":"a1000000-0000-4000-8000-000000000001/memories/a4000000-0000-4000-8000-000000000002/media/clip.mp4","contentType":"video/mp4","durationMs":3000}]'::jsonb
  )$$,
  'replace_memory_media_assets still accepts a video on a regular media memory'
);

-- 19-22. Direct memory_media writes (the trigger covers every writer, not
-- only the RPC).
select throws_ok(
  $$insert into public.memory_media (memory_id, object_key, content_type, position)
  values (
    'a4000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001/memories/a4000000-0000-4000-8000-000000000001/media/clip2.mp4',
    'video/quicktime', 2
  )$$,
  '23514', 'artwork_media_must_be_image',
  'a direct video insert on an artwork memory is rejected'
);
select lives_ok(
  $$insert into public.memory_media (memory_id, object_key, content_type, position)
  values (
    'a4000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001/memories/a4000000-0000-4000-8000-000000000001/media/scan3.jpg',
    'image/jpeg', 2
  )$$,
  'a direct image insert on an artwork memory is accepted'
);
select throws_ok(
  $$update public.memory_media set content_type = 'video/mp4'
    where object_key = 'a1000000-0000-4000-8000-000000000001/memories/a4000000-0000-4000-8000-000000000001/media/scan3.jpg'$$,
  '23514', 'artwork_media_must_be_image',
  'changing an artwork image row to a video content type is rejected'
);
select throws_ok(
  $$update public.memory_media set memory_id = 'a4000000-0000-4000-8000-000000000001'
    where memory_id = 'a4000000-0000-4000-8000-000000000002'
      and content_type = 'video/mp4'$$,
  '23514', 'artwork_media_must_be_image',
  'moving a video row under an artwork memory is rejected'
);

-- 23. Regular media memories keep accepting video via a direct insert.
select lives_ok(
  $$insert into public.memory_media (memory_id, object_key, content_type, position)
  values (
    'a4000000-0000-4000-8000-000000000002',
    'a1000000-0000-4000-8000-000000000001/memories/a4000000-0000-4000-8000-000000000002/media/clip3.mp4',
    'video/mp4', 2
  )$$,
  'a direct video insert on a regular media memory is accepted'
);

select * from finish();
rollback;
