begin;

select plan(6);

insert into auth.users (id, email)
values ('b1000000-0000-4000-8000-000000000001', 'media-metadata@example.test');

insert into public.families (id, name, owner_id)
values (
  'b2000000-0000-4000-8000-000000000001',
  'Media metadata fixture family',
  'b1000000-0000-4000-8000-000000000001'
);

insert into public.family_memberships (id, family_id, user_id, role)
values (
  'b3000000-0000-4000-8000-000000000001',
  'b2000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000001',
  'owner'
);

insert into public.memories (id, family_id, user_id, memory_type)
values (
  'b4000000-0000-4000-8000-000000000001',
  'b2000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000001',
  'media'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000001', true);

select lives_ok(
  $$select public.replace_memory_media_assets(
    'b4000000-0000-4000-8000-000000000001',
    '[{"objectKey":"b1000000-0000-4000-8000-000000000001/memories/b4000000-0000-4000-8000-000000000001/media/photo.jpg","contentType":"image/jpeg","durationMs":null,"aspectRatio":0.4453125,"previewObjectKey":"b1000000-0000-4000-8000-000000000001/memories/b4000000-0000-4000-8000-000000000001/media/photo-preview.jpg"}]'::jsonb
  )$$,
  'replace_memory_media_assets accepts and stores photo display metadata'
);

set local role postgres;
select is(
  (select round(aspect_ratio::numeric, 6) from public.memory_media where memory_id = 'b4000000-0000-4000-8000-000000000001'),
  0.445313::numeric,
  'photo aspect_ratio survives the media replacement RPC'
);
select is(
  (select preview_object_key from public.memory_media where memory_id = 'b4000000-0000-4000-8000-000000000001'),
  'b1000000-0000-4000-8000-000000000001/memories/b4000000-0000-4000-8000-000000000001/media/photo-preview.jpg',
  'preview_object_key survives the media replacement RPC'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000001', true);
select lives_ok(
  $$select public.replace_memory_media_assets(
    'b4000000-0000-4000-8000-000000000001',
    '[{"objectKey":"b1000000-0000-4000-8000-000000000001/memories/b4000000-0000-4000-8000-000000000001/media/photo.jpg","contentType":"image/jpeg","durationMs":null}]'::jsonb
  )$$,
  'editing with an older payload does not erase existing media metadata'
);

set local role postgres;
select is(
  (select round(aspect_ratio::numeric, 6) from public.memory_media where memory_id = 'b4000000-0000-4000-8000-000000000001'),
  0.445313::numeric,
  'editing without aspectRatio preserves the stored photo ratio'
);
select is(
  (select preview_object_key from public.memory_media where memory_id = 'b4000000-0000-4000-8000-000000000001'),
  'b1000000-0000-4000-8000-000000000001/memories/b4000000-0000-4000-8000-000000000001/media/photo-preview.jpg',
  'editing without previewObjectKey preserves the stored preview key'
);

select * from finish();
rollback;
