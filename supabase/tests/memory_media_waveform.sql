begin;

-- memory_media.waveform + replace_memory_media_assets waveform handling
-- (supabase/migrations/20261013120000_memory_media_waveform.sql,
-- docs/plans/audio-trim-import.md). Fixture/RPC style follows
-- audio_memories.sql: the RPC is exercised as `authenticated` with a real JWT
-- claim; row assertions read back as the table owner.

select plan(31);

insert into auth.users (id, email)
values ('f1000000-0000-4000-8000-000000000001', 'audio-waveform@example.test');

insert into public.families (id, name, owner_id)
values (
  'f2000000-0000-4000-8000-000000000001',
  'Audio waveform fixture family',
  'f1000000-0000-4000-8000-000000000001'
);

insert into public.family_memberships (id, family_id, user_id, role)
values (
  'f3000000-0000-4000-8000-000000000001',
  'f2000000-0000-4000-8000-000000000001',
  'f1000000-0000-4000-8000-000000000001',
  'owner'
);

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

-- An audio memory and a photo memory (the image-asset case).
insert into public.memories (
  id, family_id, user_id, content, memory_type, media_key, media_content_type, illustration_status
) values
(
  'f4000000-0000-4000-8000-000000000001',
  'f2000000-0000-4000-8000-000000000001',
  'f1000000-0000-4000-8000-000000000001',
  null, 'audio',
  'f1000000-0000-4000-8000-000000000001/memories/f4000000-0000-4000-8000-000000000001/media/f5000000-0000-4000-8000-000000000001.m4a',
  'audio/mp4', 'none'
),
(
  'f4000000-0000-4000-8000-000000000002',
  'f2000000-0000-4000-8000-000000000001',
  'f1000000-0000-4000-8000-000000000001',
  null, 'media',
  'f1000000-0000-4000-8000-000000000001/memories/f4000000-0000-4000-8000-000000000002/media/f5000000-0000-4000-8000-000000000002.jpg',
  'image/jpeg', 'none'
);

-- 64 buckets, values 0, 4, ..., 252.
create temp table waveform_fixture on commit drop as
select array_agg((i * 4)::smallint order by i) as valid_a
from generate_series(0, 63) as i;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000001', true);

-- 1. A valid waveform sent through the RPC is stored as sent.
select lives_ok(
  $$select public.replace_memory_media_assets(
    'f4000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'objectKey', 'f1000000-0000-4000-8000-000000000001/memories/f4000000-0000-4000-8000-000000000001/media/f5000000-0000-4000-8000-000000000001.m4a',
      'contentType', 'audio/mp4',
      'durationMs', 4200,
      'waveform', (select jsonb_agg(i * 4 order by i) from generate_series(0, 63) as i)
    ))
  )$$,
  'the RPC accepts an audio asset with a valid 64-bucket waveform'
);

set local role postgres;
select is(
  (select waveform from public.memory_media where memory_id = 'f4000000-0000-4000-8000-000000000001'),
  (select valid_a from waveform_fixture),
  'a valid waveform is stored exactly as sent'
);
set local role authenticated;

-- 3-12. Invalid waveforms: the save succeeds and the stored value is NULL.
-- Each case re-saves the same memory, so the row is rewritten every time; the
-- payload carries a waveform key, so the previous valid value is not preserved.
select lives_ok(
  $$select public.replace_memory_media_assets(
    'f4000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'objectKey', 'f1000000-0000-4000-8000-000000000001/memories/f4000000-0000-4000-8000-000000000001/media/f5000000-0000-4000-8000-000000000001.m4a',
      'contentType', 'audio/mp4', 'durationMs', 4200,
      'waveform', (select jsonb_agg(case when i = 10 then 256 else i end order by i) from generate_series(0, 63) as i)
    ))
  )$$,
  'a waveform with an element above 255 does not fail the save'
);
set local role postgres;
select is(
  (select waveform from public.memory_media where memory_id = 'f4000000-0000-4000-8000-000000000001'),
  null::smallint[],
  'a waveform with an element above 255 is stored as NULL'
);
set local role authenticated;

select lives_ok(
  $$select public.replace_memory_media_assets(
    'f4000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'objectKey', 'f1000000-0000-4000-8000-000000000001/memories/f4000000-0000-4000-8000-000000000001/media/f5000000-0000-4000-8000-000000000001.m4a',
      'contentType', 'audio/mp4', 'durationMs', 4200,
      'waveform', (select jsonb_agg(case when i = 10 then -1 else i end order by i) from generate_series(0, 63) as i)
    ))
  )$$,
  'a waveform with a negative element does not fail the save'
);
set local role postgres;
select is(
  (select waveform from public.memory_media where memory_id = 'f4000000-0000-4000-8000-000000000001'),
  null::smallint[],
  'a waveform with a negative element is stored as NULL'
);
set local role authenticated;

select lives_ok(
  $$select public.replace_memory_media_assets(
    'f4000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'objectKey', 'f1000000-0000-4000-8000-000000000001/memories/f4000000-0000-4000-8000-000000000001/media/f5000000-0000-4000-8000-000000000001.m4a',
      'contentType', 'audio/mp4', 'durationMs', 4200,
      'waveform', (select jsonb_agg(i order by i) from generate_series(1, 15) as i)
    ))
  )$$,
  'a 15-element waveform (too short) does not fail the save'
);
set local role postgres;
select is(
  (select waveform from public.memory_media where memory_id = 'f4000000-0000-4000-8000-000000000001'),
  null::smallint[],
  'a 15-element waveform is stored as NULL'
);
set local role authenticated;

select lives_ok(
  $$select public.replace_memory_media_assets(
    'f4000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'objectKey', 'f1000000-0000-4000-8000-000000000001/memories/f4000000-0000-4000-8000-000000000001/media/f5000000-0000-4000-8000-000000000001.m4a',
      'contentType', 'audio/mp4', 'durationMs', 4200,
      'waveform', (select jsonb_agg(i % 256 order by i) from generate_series(1, 257) as i)
    ))
  )$$,
  'a 257-element waveform (too long) does not fail the save'
);
set local role postgres;
select is(
  (select waveform from public.memory_media where memory_id = 'f4000000-0000-4000-8000-000000000001'),
  null::smallint[],
  'a 257-element waveform is stored as NULL'
);
set local role authenticated;

-- A JSON null element (what a NaN becomes after JSON serialisation).
select lives_ok(
  $$select public.replace_memory_media_assets(
    'f4000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'objectKey', 'f1000000-0000-4000-8000-000000000001/memories/f4000000-0000-4000-8000-000000000001/media/f5000000-0000-4000-8000-000000000001.m4a',
      'contentType', 'audio/mp4', 'durationMs', 4200,
      'waveform', (select jsonb_agg(case when i = 10 then null else i end order by i) from generate_series(0, 63) as i)
    ))
  )$$,
  'a waveform with a null element does not fail the save'
);
set local role postgres;
select is(
  (select waveform from public.memory_media where memory_id = 'f4000000-0000-4000-8000-000000000001'),
  null::smallint[],
  'a waveform with a null element is stored as NULL'
);
set local role authenticated;

-- Non-array shapes, a non-integer, and a string element: all degrade to NULL.
select lives_ok(
  $$select public.replace_memory_media_assets(
    'f4000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'objectKey', 'f1000000-0000-4000-8000-000000000001/memories/f4000000-0000-4000-8000-000000000001/media/f5000000-0000-4000-8000-000000000001.m4a',
      'contentType', 'audio/mp4', 'durationMs', 4200,
      'waveform', '{"a": 1}'::jsonb
    ))
  )$$,
  'an object-valued waveform does not fail the save'
);
set local role postgres;
select is(
  (select waveform from public.memory_media where memory_id = 'f4000000-0000-4000-8000-000000000001'),
  null::smallint[],
  'an object-valued waveform is stored as NULL'
);
set local role authenticated;

select lives_ok(
  $$select public.replace_memory_media_assets(
    'f4000000-0000-4000-8000-000000000001',
    jsonb_build_array(
      jsonb_build_object(
        'objectKey', 'f1000000-0000-4000-8000-000000000001/memories/f4000000-0000-4000-8000-000000000001/media/f5000000-0000-4000-8000-000000000001.m4a',
        'contentType', 'audio/mp4', 'durationMs', 4200,
        'waveform', '"not-an-array"'::jsonb
      )
    )
  )$$,
  'a string-valued waveform does not fail the save'
);
set local role postgres;
select is(
  (select waveform from public.memory_media where memory_id = 'f4000000-0000-4000-8000-000000000001'),
  null::smallint[],
  'a string-valued waveform is stored as NULL'
);
set local role authenticated;

select lives_ok(
  $$select public.replace_memory_media_assets(
    'f4000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'objectKey', 'f1000000-0000-4000-8000-000000000001/memories/f4000000-0000-4000-8000-000000000001/media/f5000000-0000-4000-8000-000000000001.m4a',
      'contentType', 'audio/mp4', 'durationMs', 4200,
      'waveform', (select jsonb_agg(case when i = 10 then 1.5 else i end order by i) from generate_series(0, 63) as i)
    ))
  )$$,
  'a waveform with a non-integer element does not fail the save'
);
set local role postgres;
select is(
  (select waveform from public.memory_media where memory_id = 'f4000000-0000-4000-8000-000000000001'),
  null::smallint[],
  'a waveform with a non-integer element is stored as NULL'
);
set local role authenticated;

-- 12. Replaced when a new valid value is provided (start from a stored value).
select lives_ok(
  $$select public.replace_memory_media_assets(
    'f4000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'objectKey', 'f1000000-0000-4000-8000-000000000001/memories/f4000000-0000-4000-8000-000000000001/media/f5000000-0000-4000-8000-000000000001.m4a',
      'contentType', 'audio/mp4', 'durationMs', 4200,
      'waveform', (select jsonb_agg(i * 4 order by i) from generate_series(0, 63) as i)
    ))
  )$$,
  'the RPC re-stores a valid waveform after a run of invalid ones'
);

-- 13. Preserved when a re-save carries no waveform key, or an explicit null.
select lives_ok(
  $$select public.replace_memory_media_assets(
    'f4000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'objectKey', 'f1000000-0000-4000-8000-000000000001/memories/f4000000-0000-4000-8000-000000000001/media/f5000000-0000-4000-8000-000000000001.m4a',
      'contentType', 'audio/mp4', 'durationMs', 4200
    ))
  )$$,
  're-saving the same clip key without a waveform key succeeds'
);
set local role postgres;
select is(
  (select waveform from public.memory_media where memory_id = 'f4000000-0000-4000-8000-000000000001'),
  (select valid_a from waveform_fixture),
  'the existing waveform is preserved when the payload has no waveform'
);
set local role authenticated;

select lives_ok(
  $$select public.replace_memory_media_assets(
    'f4000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'objectKey', 'f1000000-0000-4000-8000-000000000001/memories/f4000000-0000-4000-8000-000000000001/media/f5000000-0000-4000-8000-000000000001.m4a',
      'contentType', 'audio/mp4', 'durationMs', 4200, 'waveform', null
    ))
  )$$,
  're-saving the same clip key with an explicit null waveform succeeds'
);
set local role postgres;
select is(
  (select waveform from public.memory_media where memory_id = 'f4000000-0000-4000-8000-000000000001'),
  (select valid_a from waveform_fixture),
  'the existing waveform is preserved when the payload waveform is null'
);
set local role authenticated;

-- 14. Replaced when a different valid waveform is provided for the same key.
select lives_ok(
  $$select public.replace_memory_media_assets(
    'f4000000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'objectKey', 'f1000000-0000-4000-8000-000000000001/memories/f4000000-0000-4000-8000-000000000001/media/f5000000-0000-4000-8000-000000000001.m4a',
      'contentType', 'audio/mp4', 'durationMs', 4200,
      'waveform', (select jsonb_agg(255 - i order by i) from generate_series(0, 15) as i)
    ))
  )$$,
  'a new valid waveform (16 buckets, the minimum) is accepted for an existing key'
);
set local role postgres;
select is(
  (select waveform from public.memory_media where memory_id = 'f4000000-0000-4000-8000-000000000001'),
  (select array_agg((255 - i)::smallint order by i) from generate_series(0, 15) as i),
  'the waveform is replaced when the payload provides a new one'
);
set local role authenticated;

-- 15. Ignored for a non-audio asset.
select lives_ok(
  $$select public.replace_memory_media_assets(
    'f4000000-0000-4000-8000-000000000002',
    jsonb_build_array(jsonb_build_object(
      'objectKey', 'f1000000-0000-4000-8000-000000000001/memories/f4000000-0000-4000-8000-000000000002/media/f5000000-0000-4000-8000-000000000002.jpg',
      'contentType', 'image/jpeg', 'aspectRatio', 1.5,
      'waveform', (select jsonb_agg(i * 4 order by i) from generate_series(0, 63) as i)
    ))
  )$$,
  'the RPC accepts an image asset that carries a waveform key'
);
set local role postgres;
select is(
  (select waveform from public.memory_media where memory_id = 'f4000000-0000-4000-8000-000000000002'),
  null::smallint[],
  'a waveform sent with an image asset is ignored (stored NULL)'
);

-- 16. The CHECK constraint is the guard for direct writes (the authenticated
-- role holds a table-level UPDATE grant gated only by RLS).
select lives_ok(
  $$update public.memory_media
    set waveform = (select array_agg(i::smallint order by i) from generate_series(0, 63) as i)
    where memory_id = 'f4000000-0000-4000-8000-000000000001'$$,
  'a direct UPDATE with a valid waveform is accepted'
);
select throws_ok(
  $$update public.memory_media
    set waveform = (select array_agg(case when i = 3 then 256 else i end::smallint order by i) from generate_series(0, 63) as i)
    where memory_id = 'f4000000-0000-4000-8000-000000000001'$$,
  '23514', null,
  'a direct UPDATE with an out-of-range element is rejected by the CHECK'
);
select throws_ok(
  $$update public.memory_media
    set waveform = (select array_agg(i::smallint order by i) from generate_series(0, 14) as i)
    where memory_id = 'f4000000-0000-4000-8000-000000000001'$$,
  '23514', null,
  'a direct UPDATE with a too-short waveform is rejected by the CHECK'
);
select throws_ok(
  $$update public.memory_media
    set waveform = (select array_agg(case when i = 3 then null else i::smallint end order by i) from generate_series(0, 63) as i)
    where memory_id = 'f4000000-0000-4000-8000-000000000001'$$,
  '23514', null,
  'a direct UPDATE with a NULL element is rejected by the CHECK'
);

select * from finish();
rollback;
