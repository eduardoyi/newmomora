begin;

select plan(24);

insert into auth.users (id, email, is_anonymous) values
  ('f1000000-0000-4000-8000-000000000001', 'retained-preview-owner@example.test', false),
  ('f1000000-0000-4000-8000-000000000002', 'retained-preview-manager@example.test', false),
  ('f1000000-0000-4000-8000-000000000003', 'retained-preview-creator@example.test', false),
  ('f1000000-0000-4000-8000-000000000004', 'retained-preview-viewer@example.test', false),
  ('f1000000-0000-4000-8000-000000000005', 'retained-preview-outsider@example.test', false);

insert into public.families (id, name, owner_id)
values (
  'f2000000-0000-4000-8000-000000000001',
  'Retained media preview fixture family',
  'f1000000-0000-4000-8000-000000000001'
);

insert into public.family_memberships (family_id, user_id, role)
values
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', 'owner'),
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000002', 'manager'),
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000003', 'viewer'),
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000004', 'viewer');

-- The RPC's billing guard must be passed for the authorization assertions to
-- exercise preview admission rather than fail earlier.
insert into public.owner_entitlements (
  owner_user_id, app_user_id, environment, store, product_id, entitlement_id,
  period_type, status, expires_at, will_renew
)
values (
  'f1000000-0000-4000-8000-000000000001',
  'f1000000-0000-4000-8000-000000000001',
  'production', 'app_store', 'momora_annual_v1', 'momora_plus',
  'annual', 'active', transaction_timestamp() + interval '30 days', true
);

insert into public.memories (
  id, family_id, user_id, memory_type, media_key, media_content_type
)
values (
  'f3000000-0000-4000-8000-000000000001',
  'f2000000-0000-4000-8000-000000000001',
  'f1000000-0000-4000-8000-000000000003',
  'media',
  'f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-one.jpg',
  'image/jpeg'
);

insert into public.memory_media (
  memory_id, object_key, content_type, aspect_ratio, preview_object_key, position
)
values
  (
    'f3000000-0000-4000-8000-000000000001',
    'f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-one.jpg',
    'image/jpeg', 1.25,
    'f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-one-preview.jpg',
    0
  ),
  (
    'f3000000-0000-4000-8000-000000000001',
    'f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-two.jpg',
    'image/jpeg', 0.8,
    'f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-two-preview.jpg',
    1
  );

set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000001', true);
select lives_ok(
  $$select public.replace_memory_media_assets(
    'f3000000-0000-4000-8000-000000000001',
    '[
      {"objectKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-one.jpg","contentType":"image/jpeg","previewObjectKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-one-preview.jpg"},
      {"objectKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-two.jpg","contentType":"image/jpeg","previewObjectKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-two-preview.jpg"}
    ]'::jsonb
  )$$,
  'an owner can retain another creator''s original keys with their exact paired previews'
);

select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000002', true);
select lives_ok(
  $$select public.replace_memory_media_assets(
    'f3000000-0000-4000-8000-000000000001',
    '[
      {"objectKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-two.jpg","contentType":"image/jpeg"},
      {"objectKey":"f1000000-0000-4000-8000-000000000002/memories/f3000000-0000-4000-8000-000000000001/media/manager-new.jpg","contentType":"image/jpeg","aspectRatio":1.6,"previewObjectKey":"f1000000-0000-4000-8000-000000000002/memories/f3000000-0000-4000-8000-000000000001/media/manager-new-preview.jpg"},
      {"objectKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-one.jpg","contentType":"image/jpeg"}
    ]'::jsonb
  )$$,
  'a manager can reorder retained foreign assets with omitted previews while adding a caller-owned asset and preview'
);

select is(
  (
    select jsonb_agg(
      jsonb_build_object(
        'objectKey', object_key,
        'previewObjectKey', preview_object_key,
        'aspectRatio', aspect_ratio,
        'position', position
      )
      order by position
    )
    from public.memory_media
    where memory_id = 'f3000000-0000-4000-8000-000000000001'
  ),
  '[
    {"objectKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-two.jpg","previewObjectKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-two-preview.jpg","aspectRatio":0.8,"position":0},
    {"objectKey":"f1000000-0000-4000-8000-000000000002/memories/f3000000-0000-4000-8000-000000000001/media/manager-new.jpg","previewObjectKey":"f1000000-0000-4000-8000-000000000002/memories/f3000000-0000-4000-8000-000000000001/media/manager-new-preview.jpg","aspectRatio":1.6,"position":1},
    {"objectKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-one.jpg","previewObjectKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-one-preview.jpg","aspectRatio":1.25,"position":2}
  ]'::jsonb,
  'the manager retain-add-reorder operation preserves every row, preview pair, ratio, and position'
);
select is(
  (
    select jsonb_build_object(
      'mediaKey', media_key,
      'mediaContentType', media_content_type
    )
    from public.memories
    where id = 'f3000000-0000-4000-8000-000000000001'
  ),
  '{"mediaKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-two.jpg","mediaContentType":"image/jpeg"}'::jsonb,
  'the manager reorder updates the memory cover cache to position zero'
);

select throws_ok(
  $$select public.replace_memory_media_assets(
    'f3000000-0000-4000-8000-000000000001',
    '[{"objectKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-one.jpg","contentType":"image/jpeg","previewObjectKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/forged-preview.jpg"}]'::jsonb
  )$$,
  '22023', 'Invalid preview object key',
  'a manager cannot substitute a forged foreign preview for a retained original'
);

select is(
  (
    select jsonb_agg(
      jsonb_build_object(
        'objectKey', object_key,
        'previewObjectKey', preview_object_key,
        'aspectRatio', aspect_ratio,
        'position', position
      )
      order by position
    )
    from public.memory_media
    where memory_id = 'f3000000-0000-4000-8000-000000000001'
  ),
  '[
    {"objectKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-two.jpg","previewObjectKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-two-preview.jpg","aspectRatio":0.8,"position":0},
    {"objectKey":"f1000000-0000-4000-8000-000000000002/memories/f3000000-0000-4000-8000-000000000001/media/manager-new.jpg","previewObjectKey":"f1000000-0000-4000-8000-000000000002/memories/f3000000-0000-4000-8000-000000000001/media/manager-new-preview.jpg","aspectRatio":1.6,"position":1},
    {"objectKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-one.jpg","previewObjectKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-one-preview.jpg","aspectRatio":1.25,"position":2}
  ]'::jsonb,
  'a forged preview rejection rolls back every delete-and-reinsert row change'
);
select is(
  (
    select jsonb_build_object(
      'mediaKey', media_key,
      'mediaContentType', media_content_type
    )
    from public.memories
    where id = 'f3000000-0000-4000-8000-000000000001'
  ),
  '{"mediaKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-two.jpg","mediaContentType":"image/jpeg"}'::jsonb,
  'a forged preview rejection leaves the reordered memory cover cache intact'
);

select throws_ok(
  $$select public.replace_memory_media_assets(
    'f3000000-0000-4000-8000-000000000001',
    '[{"objectKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-one.jpg","contentType":"image/jpeg","previewObjectKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-two-preview.jpg"}]'::jsonb
  )$$,
  '22023', 'Invalid preview object key',
  'a manager cannot swap a preview from another retained asset'
);

select is(
  (
    select jsonb_agg(
      jsonb_build_object(
        'objectKey', object_key,
        'previewObjectKey', preview_object_key,
        'aspectRatio', aspect_ratio,
        'position', position
      )
      order by position
    )
    from public.memory_media
    where memory_id = 'f3000000-0000-4000-8000-000000000001'
  ),
  '[
    {"objectKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-two.jpg","previewObjectKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-two-preview.jpg","aspectRatio":0.8,"position":0},
    {"objectKey":"f1000000-0000-4000-8000-000000000002/memories/f3000000-0000-4000-8000-000000000001/media/manager-new.jpg","previewObjectKey":"f1000000-0000-4000-8000-000000000002/memories/f3000000-0000-4000-8000-000000000001/media/manager-new-preview.jpg","aspectRatio":1.6,"position":1},
    {"objectKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-one.jpg","previewObjectKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-one-preview.jpg","aspectRatio":1.25,"position":2}
  ]'::jsonb,
  'a swapped-preview rejection rolls back every delete-and-reinsert row change'
);

select is(
  (
    select jsonb_build_object(
      'mediaKey', media_key,
      'mediaContentType', media_content_type
    )
    from public.memories
    where id = 'f3000000-0000-4000-8000-000000000001'
  ),
  '{"mediaKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-two.jpg","mediaContentType":"image/jpeg"}'::jsonb,
  'a swapped-preview rejection leaves the reordered memory cover cache intact'
);

-- A caller-owned original is not itself enough to authorize an arbitrary
-- foreign preview. This is the NULL-sensitive branch: there is no existing
-- preview mapping for manager-new-two, so the exact-pair comparison is NULL.
select throws_ok(
  $$select public.replace_memory_media_assets(
    'f3000000-0000-4000-8000-000000000001',
    '[{"objectKey":"f1000000-0000-4000-8000-000000000002/memories/f3000000-0000-4000-8000-000000000001/media/manager-new-two.jpg","contentType":"image/jpeg","previewObjectKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/arbitrary-foreign-preview.jpg"}]'::jsonb
  )$$,
  '22023', 'Invalid preview object key',
  'a caller-owned new original cannot attach an arbitrary foreign preview'
);
select is(
  (
    select jsonb_agg(
      jsonb_build_object(
        'objectKey', object_key,
        'previewObjectKey', preview_object_key,
        'aspectRatio', aspect_ratio,
        'position', position
      )
      order by position
    )
    from public.memory_media
    where memory_id = 'f3000000-0000-4000-8000-000000000001'
  ),
  '[
    {"objectKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-two.jpg","previewObjectKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-two-preview.jpg","aspectRatio":0.8,"position":0},
    {"objectKey":"f1000000-0000-4000-8000-000000000002/memories/f3000000-0000-4000-8000-000000000001/media/manager-new.jpg","previewObjectKey":"f1000000-0000-4000-8000-000000000002/memories/f3000000-0000-4000-8000-000000000001/media/manager-new-preview.jpg","aspectRatio":1.6,"position":1},
    {"objectKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-one.jpg","previewObjectKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-one-preview.jpg","aspectRatio":1.25,"position":2}
  ]'::jsonb,
  'a new-original foreign-preview rejection rolls back every row change'
);

-- This row deliberately has no preview. A foreign preview must not pass the
-- exact-pair branch through SQL three-valued logic.
set local role postgres;
insert into public.memory_media (
  memory_id, object_key, content_type, aspect_ratio, preview_object_key, position
)
values (
  'f3000000-0000-4000-8000-000000000001',
  'f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-no-preview.jpg',
  'image/jpeg', 1.1, null, 3
);
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000002', true);
select throws_ok(
  $$select public.replace_memory_media_assets(
    'f3000000-0000-4000-8000-000000000001',
    '[{"objectKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-no-preview.jpg","contentType":"image/jpeg","previewObjectKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/arbitrary-foreign-preview.jpg"}]'::jsonb
  )$$,
  '22023', 'Invalid preview object key',
  'a retained original with no preview cannot attach an arbitrary foreign preview'
);
select is(
  (
    select jsonb_build_object(
      'objectKey', object_key,
      'previewObjectKey', preview_object_key,
      'aspectRatio', aspect_ratio,
      'position', position
    )
    from public.memory_media
    where memory_id = 'f3000000-0000-4000-8000-000000000001'
      and object_key = 'f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-no-preview.jpg'
  ),
  '{"objectKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-no-preview.jpg","previewObjectKey":null,"aspectRatio":1.1,"position":3}'::jsonb,
  'a no-preview foreign substitution rejection rolls back the retained row intact'
);

select lives_ok(
  $$select public.replace_memory_media_assets(
    'f3000000-0000-4000-8000-000000000001',
    '[
      {"objectKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-two.jpg","contentType":"image/jpeg"},
      {"objectKey":"f1000000-0000-4000-8000-000000000002/memories/f3000000-0000-4000-8000-000000000001/media/manager-new.jpg","contentType":"image/jpeg"},
      {"objectKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-one.jpg","contentType":"image/jpeg","previewObjectKey":"f1000000-0000-4000-8000-000000000002/memories/f3000000-0000-4000-8000-000000000001/media/manager-replacement-preview.jpg"},
      {"objectKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-no-preview.jpg","contentType":"image/jpeg"}
    ]'::jsonb
  )$$,
  'a manager can replace a retained foreign original preview with a caller-owned preview'
);
select is(
  (select preview_object_key from public.memory_media where memory_id = 'f3000000-0000-4000-8000-000000000001' and position = 2),
  'f1000000-0000-4000-8000-000000000002/memories/f3000000-0000-4000-8000-000000000001/media/manager-replacement-preview.jpg',
  'a caller-owned replacement preview is persisted on the retained foreign original'
);

select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000004', true);
select throws_ok(
  $$select public.replace_memory_media_assets(
    'f3000000-0000-4000-8000-000000000001',
    '[{"objectKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-one.jpg","contentType":"image/jpeg"}]'::jsonb
  )$$,
  '42501', 'Not authorized',
  'a viewer remains unable to replace media assets'
);

select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000005', true);
select throws_ok(
  $$select public.replace_memory_media_assets(
    'f3000000-0000-4000-8000-000000000001',
    '[{"objectKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-one.jpg","contentType":"image/jpeg"}]'::jsonb
  )$$,
  '42501', 'Not authorized',
  'a non-member remains unable to replace media assets'
);

-- Omitted metadata on an older editor payload still comes from the same
-- before-delete snapshot, including the foreign retained preview pair.
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000002', true);
select lives_ok(
  $$select public.replace_memory_media_assets(
    'f3000000-0000-4000-8000-000000000001',
    '[
      {"objectKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-one.jpg","contentType":"image/jpeg"},
      {"objectKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-two.jpg","contentType":"image/jpeg"},
      {"objectKey":"f1000000-0000-4000-8000-000000000002/memories/f3000000-0000-4000-8000-000000000001/media/manager-new.jpg","contentType":"image/jpeg"},
      {"objectKey":"f1000000-0000-4000-8000-000000000003/memories/f3000000-0000-4000-8000-000000000001/media/creator-no-preview.jpg","contentType":"image/jpeg"}
    ]'::jsonb
  )$$,
  'omitting metadata preserves retained previews and aspect ratios'
);

set local role postgres;
select is(
  (select aspect_ratio from public.memory_media where memory_id = 'f3000000-0000-4000-8000-000000000001' and position = 0),
  1.25::double precision,
  'the first retained foreign asset keeps its aspect ratio'
);
select is(
  (select preview_object_key from public.memory_media where memory_id = 'f3000000-0000-4000-8000-000000000001' and position = 0),
  'f1000000-0000-4000-8000-000000000002/memories/f3000000-0000-4000-8000-000000000001/media/manager-replacement-preview.jpg',
  'the first retained foreign asset preserves its caller-owned replacement preview'
);
select is(
  (select aspect_ratio from public.memory_media where memory_id = 'f3000000-0000-4000-8000-000000000001' and position = 2),
  1.6::double precision,
  'the newly added caller-owned asset keeps its aspect ratio'
);
select is(
  (select preview_object_key from public.memory_media where memory_id = 'f3000000-0000-4000-8000-000000000001' and position = 2),
  'f1000000-0000-4000-8000-000000000002/memories/f3000000-0000-4000-8000-000000000001/media/manager-new-preview.jpg',
  'the newly added caller-owned asset keeps its preview'
);
select ok(
  (select prosecdef from pg_proc where oid = 'public.replace_memory_media_assets(uuid,jsonb)'::regprocedure),
  'replace_memory_media_assets remains a security definer RPC'
);

select * from finish();
rollback;
