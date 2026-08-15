begin;

select plan(6);

insert into auth.users (id, email, is_anonymous)
values ('b1000000-0000-4000-8000-000000000001', 'media-metadata@example.test', false);

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

-- The media-finalization RPC enforces the production billing gate. Keep this
-- fixture on the normal paid path rather than relying on an onboarding grace
-- exception so it remains valid after a fresh migration reset.
insert into public.owner_entitlements (
  owner_user_id, app_user_id, environment, store, product_id, entitlement_id,
  period_type, status, expires_at, will_renew
)
values (
  'b1000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000001',
  'production', 'app_store', 'momora_annual_v1', 'momora_plus',
  'annual', 'active', transaction_timestamp() + interval '30 days', true
);

insert into public.memories (
  id, family_id, user_id, memory_type, media_key, media_content_type
)
values (
  'b4000000-0000-4000-8000-000000000001',
  'b2000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000001',
  'media',
  'b1000000-0000-4000-8000-000000000001/memories/b4000000-0000-4000-8000-000000000001/media/photo.jpg',
  'image/jpeg'
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
