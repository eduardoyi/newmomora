begin;

-- The fixture exercises the candidate RPC in a copied local database. It uses
-- two families so the small main fixture can prove all-date eligibility while
-- the second family proves the 40-row cap and band backfill independently.
select plan(47);

select ok(
  has_function_privilege(
    'authenticated',
    'public.get_widget_family_timezone(uuid)',
    'EXECUTE'
  ),
  'authenticated callers can execute the timezone helper'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.get_widget_family_timezone(uuid)',
    'EXECUTE'
  ),
  'anonymous callers cannot execute the timezone helper'
);
select ok(
  (select prosecdef from pg_proc where oid = 'public.get_widget_family_timezone(uuid)'::regprocedure),
  'the timezone helper is security definer'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.get_widget_memory_candidates(uuid)',
    'EXECUTE'
  ),
  'authenticated callers can execute the candidate RPC'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.get_widget_memory_candidates(uuid)',
    'EXECUTE'
  ),
  'anonymous callers cannot execute the candidate RPC'
);
select ok(
  not (select prosecdef from pg_proc where oid = 'public.get_widget_memory_candidates(uuid)'::regprocedure),
  'the candidate RPC remains security invoker so memory RLS applies'
);

insert into auth.users (id, email, is_anonymous)
values
  ('a1000000-0000-4000-8000-000000000001', 'widget-owner@example.test', false),
  ('a1000000-0000-4000-8000-000000000002', 'widget-manager@example.test', false),
  ('a1000000-0000-4000-8000-000000000003', 'widget-viewer@example.test', false),
  ('a1000000-0000-4000-8000-000000000004', 'widget-outsider@example.test', false),
  ('a1000000-0000-4000-8000-000000000005', 'widget-empty-owner@example.test', false),
  ('a1000000-0000-4000-8000-000000000006', 'widget-anonymous@example.test', true),
  ('a1000000-0000-4000-8000-000000000007', 'widget-expiring@example.test', false);

-- Auth's new-user trigger creates the own profile row; update those fixture
-- rows so the owner timezone remains private but deterministic.
update public.user_profiles
set name = case id
  when 'a1000000-0000-4000-8000-000000000001' then 'Widget Owner'
  when 'a1000000-0000-4000-8000-000000000002' then 'Widget Manager'
  when 'a1000000-0000-4000-8000-000000000003' then 'Widget Viewer'
  else 'Widget Empty Owner'
end,
timezone = case id
  when 'a1000000-0000-4000-8000-000000000001' then 'America/New_York'
  when 'a1000000-0000-4000-8000-000000000005' then 'Not/A-Timezone'
  else 'UTC'
end
where id in (
  'a1000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000002',
  'a1000000-0000-4000-8000-000000000003',
  'a1000000-0000-4000-8000-000000000005'
);

insert into public.families (id, name, owner_id)
values
  (
    'a2000000-0000-4000-8000-000000000001',
    'Widget main family',
    'a1000000-0000-4000-8000-000000000001'
  ),
  (
    'a2000000-0000-4000-8000-000000000002',
    'Widget cap family',
    'a1000000-0000-4000-8000-000000000001'
  ),
  (
    'a2000000-0000-4000-8000-000000000003',
    'Widget empty family',
    'a1000000-0000-4000-8000-000000000005'
  );

insert into public.family_memberships (id, family_id, user_id, role)
values
  (
    'a3000000-0000-4000-8000-000000000001',
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    'owner'
  ),
  (
    'a3000000-0000-4000-8000-000000000002',
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000002',
    'manager'
  ),
  (
    'a3000000-0000-4000-8000-000000000003',
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000003',
    'viewer'
  ),
  (
    'a3000000-0000-4000-8000-000000000004',
    'a2000000-0000-4000-8000-000000000002',
    'a1000000-0000-4000-8000-000000000001',
    'owner'
  ),
  (
    'a3000000-0000-4000-8000-000000000005',
    'a2000000-0000-4000-8000-000000000003',
    'a1000000-0000-4000-8000-000000000005',
    'owner'
  ),
  (
    'a3000000-0000-4000-8000-000000000006',
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000006',
    'viewer'
  ),
  (
    'a3000000-0000-4000-8000-000000000007',
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000007',
    'viewer'
  );

-- Explicit IDs make the assertions readable. Date boundaries use the same
-- owner-local date that the RPC uses, so the test remains valid on any day.
insert into public.memories (
  id, family_id, user_id, content, memory_date, memory_type,
  illustration_status, illustration_key, illustration_generation_id,
  media_content_type, onboarding_media_pending, onboarding_media_pending_until,
  created_at, updated_at
)
values
  (
    'a4000000-0000-4000-8000-000000000001',
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    'Today memory',
    (transaction_timestamp() at time zone 'America/New_York')::date,
    'text_only', 'none', null, null, null, false, null, now(), now()
  ),
  (
    'a4000000-0000-4000-8000-000000000002',
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    'Future imported memory',
    ((transaction_timestamp() at time zone 'America/New_York')::date + 365),
    'text_only', 'none', null, null, null, false, null, now(), now()
  ),
  (
    'a4000000-0000-4000-8000-000000000003',
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    'Exactly ninety days old',
    ((transaction_timestamp() at time zone 'America/New_York')::date - 90),
    'text_illustration', 'ready',
    'a1000000-0000-4000-8000-000000000001/memories/a4000000-0000-4000-8000-000000000003/illustration.webp',
    'a5000000-0000-4000-8000-000000000003', null, false, null, now(), now()
  ),
  (
    'a4000000-0000-4000-8000-000000000004',
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    'Exactly eighteen months old',
    ((transaction_timestamp() at time zone 'America/New_York')::date - interval '18 months')::date,
    'text_illustration', 'ready',
    'a1000000-0000-4000-8000-000000000001/memories/a4000000-0000-4000-8000-000000000004/illustration.webp',
    'a5000000-0000-4000-8000-000000000004', null, false, null, now(), now()
  ),
  (
    'a4000000-0000-4000-8000-000000000005',
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    'Exactly thirty six months old',
    ((transaction_timestamp() at time zone 'America/New_York')::date - interval '36 months')::date,
    'text_illustration', 'ready',
    'a1000000-0000-4000-8000-000000000001/memories/a4000000-0000-4000-8000-000000000005/illustration.webp',
    'a5000000-0000-4000-8000-000000000005', null, false, null, now(), now()
  ),
  (
    'a4000000-0000-4000-8000-000000000006',
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    'Very old memory',
    '1900-01-01',
    'text_only', 'none', null, null, null, false, null,
    now() - interval '10 years', now() - interval '10 years'
  ),
  (
    'a4000000-0000-4000-8000-000000000007',
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    'Illustrated memory with reported illustration',
    (transaction_timestamp() at time zone 'America/New_York')::date,
    'text_illustration', 'ready',
    'a1000000-0000-4000-8000-000000000001/memories/a4000000-0000-4000-8000-000000000007/illustration.webp',
    'a5000000-0000-4000-8000-000000000007', null, false, null, now(), now()
  ),
  (
    'a4000000-0000-4000-8000-000000000010',
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000002',
    'Manager authored memory',
    (transaction_timestamp() at time zone 'America/New_York')::date,
    'text_only', 'none', null, null, null, false, null, now(), now()
  ),
  (
    'a4000000-0000-4000-8000-000000000011',
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000002',
    'Reported whole memory',
    (transaction_timestamp() at time zone 'America/New_York')::date,
    'text_only', 'none', null, null, null, false, null, now(), now()
  ),
  (
    'a4000000-0000-4000-8000-000000000013',
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    'Legacy illustrated memory without a generation id',
    (transaction_timestamp() at time zone 'America/New_York')::date,
    'text_illustration', 'ready',
    'a1000000-0000-4000-8000-000000000001/memories/a4000000-0000-4000-8000-000000000013/legacy-illustration.webp',
    null, null, false, null, now(), now()
  );

-- Illustration eligibility is strict: the current row must be a ready
-- illustrated memory with a key. Pending/failed rows and a text-only row that
-- happens to retain an old illustration stay out of the widget pool.
insert into public.memories (
  id, family_id, user_id, content, memory_date, memory_type,
  illustration_status, illustration_key, illustration_generation_id
)
values
  (
    'a4000000-0000-4000-8000-000000000018',
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    'Unreported ready illustration',
    (transaction_timestamp() at time zone 'America/New_York')::date,
    'text_illustration', 'ready',
    'a1000000-0000-4000-8000-000000000001/memories/a4000000-0000-4000-8000-000000000018/illustration.webp',
    'a5000000-0000-4000-8000-000000000018'
  ),
  (
    'a4000000-0000-4000-8000-000000000019',
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    'Pending illustration',
    (transaction_timestamp() at time zone 'America/New_York')::date,
    'text_illustration', 'pending',
    'a1000000-0000-4000-8000-000000000001/memories/a4000000-0000-4000-8000-000000000019/illustration.webp',
    'a5000000-0000-4000-8000-000000000019'
  ),
  (
    'a4000000-0000-4000-8000-000000000020',
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    'Failed illustration',
    (transaction_timestamp() at time zone 'America/New_York')::date,
    'text_illustration', 'failed',
    'a1000000-0000-4000-8000-000000000001/memories/a4000000-0000-4000-8000-000000000020/illustration.webp',
    'a5000000-0000-4000-8000-000000000020'
  ),
  (
    'a4000000-0000-4000-8000-000000000021',
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    'Text-only memory retaining an illustration',
    (transaction_timestamp() at time zone 'America/New_York')::date,
    'text_only', 'ready',
    'a1000000-0000-4000-8000-000000000001/memories/a4000000-0000-4000-8000-000000000021/illustration.webp',
    'a5000000-0000-4000-8000-000000000021'
  );

insert into public.memories (
  id, family_id, user_id, memory_date, memory_type, illustration_status,
  media_key, media_content_type
)
values
  (
    'a4000000-0000-4000-8000-000000000008',
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    (transaction_timestamp() at time zone 'America/New_York')::date,
    'media', 'none',
    'a1000000-0000-4000-8000-000000000001/memories/a4000000-0000-4000-8000-000000000008/media.webp',
    'image/webp'
  ),
  (
    'a4000000-0000-4000-8000-000000000009',
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    (transaction_timestamp() at time zone 'America/New_York')::date,
    'audio', 'none',
    'a1000000-0000-4000-8000-000000000001/memories/a4000000-0000-4000-8000-000000000009/audio.m4a',
    'audio/mp4'
  ),
  (
    'a4000000-0000-4000-8000-000000000014',
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    ((transaction_timestamp() at time zone 'America/New_York')::date + 365),
    'media', 'none',
    'a1000000-0000-4000-8000-000000000001/memories/a4000000-0000-4000-8000-000000000014/media.jpg',
    'image/jpeg'
  ),
  (
    'a4000000-0000-4000-8000-000000000015',
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    '1900-01-01',
    'media', 'none',
    'a1000000-0000-4000-8000-000000000001/memories/a4000000-0000-4000-8000-000000000015/media.png',
    'image/png'
  ),
  (
    'a4000000-0000-4000-8000-000000000016',
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    (transaction_timestamp() at time zone 'America/New_York')::date,
    'media', 'none',
    'a1000000-0000-4000-8000-000000000001/memories/a4000000-0000-4000-8000-000000000016/media.mp4',
    'video/mp4'
  ),
  (
    'a4000000-0000-4000-8000-000000000024',
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    (transaction_timestamp() at time zone 'America/New_York')::date,
    'media', 'none',
    'a1000000-0000-4000-8000-000000000001/memories/a4000000-0000-4000-8000-000000000024/media.webp',
    'image/webp'
  ),
  (
    'a4000000-0000-4000-8000-000000000017',
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000001',
    (transaction_timestamp() at time zone 'America/New_York')::date,
    'media', 'none',
    'a1000000-0000-4000-8000-000000000001/memories/a4000000-0000-4000-8000-000000000017/media.mp4',
    'video/mp4'
  ),
  (
    'a4000000-0000-4000-8000-000000000022',
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000002',
    (transaction_timestamp() at time zone 'America/New_York')::date,
    'media', 'none',
    'a1000000-0000-4000-8000-000000000002/memories/a4000000-0000-4000-8000-000000000022/media.webp',
    'image/webp'
  ),
  (
    'a4000000-0000-4000-8000-000000000023',
    'a2000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000002',
    (transaction_timestamp() at time zone 'America/New_York')::date,
    'media', 'none',
    'a1000000-0000-4000-8000-000000000002/memories/a4000000-0000-4000-8000-000000000023/media.webp',
    'image/webp'
  );

-- The first asset is a video, but the second is a photo. The SQL candidate
-- surface must still admit this mixed carousel while excluding video-only
-- media above.
insert into public.memory_media (memory_id, object_key, content_type, position)
values
  (
    'a4000000-0000-4000-8000-000000000017',
    'a1000000-0000-4000-8000-000000000001/memories/a4000000-0000-4000-8000-000000000017/media-0.mp4',
    'video/mp4',
    0
  ),
  (
    'a4000000-0000-4000-8000-000000000017',
    'a1000000-0000-4000-8000-000000000001/memories/a4000000-0000-4000-8000-000000000017/media-1.webp',
    'image/webp',
    1
  ),
  (
    'a4000000-0000-4000-8000-000000000024',
    'a1000000-0000-4000-8000-000000000001/memories/a4000000-0000-4000-8000-000000000024/media-0.mp4',
    'video/mp4',
    0
  );

insert into public.memories (
  id, family_id, user_id, memory_date, memory_type, illustration_status,
  onboarding_media_pending, onboarding_media_pending_until
)
values (
  'a4000000-0000-4000-8000-000000000012',
  'a2000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000001',
  (transaction_timestamp() at time zone 'America/New_York')::date,
  'media', 'none', true, transaction_timestamp() + interval '1 day'
);

-- Fifty saved photo rows force the per-band quota plus deterministic backfill:
-- 35 recent, then five in each older band. The owner has no local report/block.
insert into public.memories (
  id, family_id, user_id, content, memory_date, memory_type,
  media_key, media_content_type
)
select
  ('a4100000-0000-4000-8000-' || lpad((g + 1)::text, 12, '0'))::uuid,
  'a2000000-0000-4000-8000-000000000002',
  'a1000000-0000-4000-8000-000000000001',
  'Cap fixture ' || g,
  case
    when g < 35 then ((transaction_timestamp() at time zone 'America/New_York')::date - g)
    when g < 40 then ((transaction_timestamp() at time zone 'America/New_York')::date - 91 - (g - 35))
    when g < 45 then ((transaction_timestamp() at time zone 'America/New_York')::date - interval '19 months')::date - (g - 40)
    else ((transaction_timestamp() at time zone 'America/New_York')::date - interval '37 months')::date - (g - 45)
  end,
  'media',
  'a1000000-0000-4000-8000-000000000001/memories/'
    || ('a4100000-0000-4000-8000-' || lpad((g + 1)::text, 12, '0'))
    || '/media.webp',
  'image/webp'
from generate_series(0, 49) as series(g);

-- The caller cannot see the owner's profile row through ordinary RLS.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000003', true);
select is(
  (select count(*) from public.user_profiles where id = 'a1000000-0000-4000-8000-000000000001'),
  0::bigint,
  'ordinary profile RLS hides the owner timezone from a viewer'
);
select is(
  public.get_widget_family_timezone('a2000000-0000-4000-8000-000000000001'),
  'America/New_York',
  'the definer helper returns the exact owner timezone after membership validation'
);

set local role postgres;
create temporary table widget_owner_candidates (memory_id uuid primary key);
create temporary table widget_manager_candidates (memory_id uuid primary key);
create temporary table widget_viewer_candidates (memory_id uuid primary key);
create temporary table widget_cap_candidates (memory_id uuid primary key);
grant insert, select on widget_owner_candidates, widget_manager_candidates, widget_viewer_candidates, widget_cap_candidates to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);

insert into widget_owner_candidates
select memory_id
from public.get_widget_memory_candidates('a2000000-0000-4000-8000-000000000001')
where memory_id is not null;

select is(
  (select count(*) from widget_owner_candidates),
  12::bigint,
  'main family returns only saved photo or ready-illustration memories'
);
select is(
  (select count(*) from public.get_widget_memory_candidates('a2000000-0000-4000-8000-000000000001')),
  12::bigint,
  'main family has no null sentinel when eligible memories exist'
);
select ok(
  exists (select 1 from widget_owner_candidates where memory_id = 'a4000000-0000-4000-8000-000000000014'),
  'future-dated memories remain eligible in the recent band'
);
select ok(
  exists (select 1 from widget_owner_candidates where memory_id = 'a4000000-0000-4000-8000-000000000015'),
  'very old memories remain eligible in the deep band'
);
select ok(
  exists (select 1 from widget_owner_candidates where memory_id = 'a4000000-0000-4000-8000-000000000013'),
  'legacy illustrated memories with a null generation id remain eligible'
);
select is(
  (select age_band from public.get_widget_memory_candidates('a2000000-0000-4000-8000-000000000001') where memory_id = 'a4000000-0000-4000-8000-000000000003'),
  'medium',
  'exactly ninety days old is in the medium band'
);
select is(
  (select age_band from public.get_widget_memory_candidates('a2000000-0000-4000-8000-000000000001') where memory_id = 'a4000000-0000-4000-8000-000000000004'),
  'old',
  'exactly eighteen calendar months old is in the old band'
);
select is(
  (select age_band from public.get_widget_memory_candidates('a2000000-0000-4000-8000-000000000001') where memory_id = 'a4000000-0000-4000-8000-000000000005'),
  'deep',
  'exactly thirty six calendar months old is in the deep band'
);
select ok(
  not exists (select 1 from widget_owner_candidates where memory_id = 'a4000000-0000-4000-8000-000000000012'),
  'onboarding media pending rows are excluded'
);
select ok(
  exists (select 1 from widget_owner_candidates where memory_id = 'a4000000-0000-4000-8000-000000000008')
  and exists (select 1 from widget_owner_candidates where memory_id = 'a4000000-0000-4000-8000-000000000017'),
  'a saved photo and a mixed photo/video memory are eligible'
);
select ok(
  not exists (select 1 from widget_owner_candidates where memory_id = 'a4000000-0000-4000-8000-000000000009')
  and not exists (select 1 from widget_owner_candidates where memory_id = 'a4000000-0000-4000-8000-000000000016')
  and not exists (select 1 from widget_owner_candidates where memory_id = 'a4000000-0000-4000-8000-000000000024'),
  'audio-only and video-only memories are excluded'
);
select ok(
  not exists (select 1 from widget_owner_candidates where memory_id = 'a4000000-0000-4000-8000-000000000001')
  and not exists (select 1 from widget_owner_candidates where memory_id = 'a4000000-0000-4000-8000-000000000021'),
  'text-only memories stay excluded even when one retains an illustration'
);
select ok(
  exists (select 1 from widget_owner_candidates where memory_id = 'a4000000-0000-4000-8000-000000000018')
  and not exists (select 1 from widget_owner_candidates where memory_id = 'a4000000-0000-4000-8000-000000000019')
  and not exists (select 1 from widget_owner_candidates where memory_id = 'a4000000-0000-4000-8000-000000000020'),
  'only ready illustrated memories with keys are eligible'
);
select is(
  (select count(*) from widget_owner_candidates),
  (select count(distinct memory_id) from widget_owner_candidates),
  'the SQL candidate response has unique memory ids'
);
select is(
  (select timezone_name from public.get_widget_memory_candidates('a2000000-0000-4000-8000-000000000001') limit 1),
  'America/New_York',
  'candidate rows carry the owner-local timezone metadata'
);
select ok(
  (select family_date is not null and next_day_boundary > transaction_timestamp()
   from public.get_widget_memory_candidates('a2000000-0000-4000-8000-000000000001') limit 1),
  'candidate rows carry a current local date and future day boundary'
);
select is(
  (select next_day_boundary from public.get_widget_memory_candidates('a2000000-0000-4000-8000-000000000001') limit 1),
  (
    (select (family_date + 1)::timestamp at time zone timezone_name
     from public.get_widget_memory_candidates('a2000000-0000-4000-8000-000000000001') limit 1)
  ),
  'next_day_boundary is the next owner-local midnight'
);

-- Owner and manager receive the same candidate set before reporter-local
-- safety state is added. This also proves family membership is exact.
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000002', true);
insert into widget_manager_candidates
select memory_id
from public.get_widget_memory_candidates('a2000000-0000-4000-8000-000000000001')
where memory_id is not null;
select is(
  (select array_agg(memory_id order by memory_id) from widget_manager_candidates),
  (select array_agg(memory_id order by memory_id) from widget_owner_candidates),
  'owner and manager get the same candidate set without local safety filters'
);

select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000003', true);
insert into widget_viewer_candidates
select memory_id
from public.get_widget_memory_candidates('a2000000-0000-4000-8000-000000000001')
where memory_id is not null;
select is(
  (select array_agg(memory_id order by memory_id) from widget_viewer_candidates),
  (select array_agg(memory_id order by memory_id) from widget_owner_candidates),
  'viewer receives the same candidate set before reporter-local safety state'
);

-- The cap family has 35 recent and 5 in each older band. Ten per band are
-- selected first and the remaining 15 slots backfill from recent.
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);
insert into widget_cap_candidates
select memory_id
from public.get_widget_memory_candidates('a2000000-0000-4000-8000-000000000002')
where memory_id is not null;
select is(
  (select count(*) from widget_cap_candidates),
  40::bigint,
  'candidate RPC caps the result at forty ids'
);
select is(
  (select count(distinct memory_id) from widget_cap_candidates),
  40::bigint,
  'the forty-row cap does not duplicate ids'
);
select is(
  (select count(*) from public.get_widget_memory_candidates('a2000000-0000-4000-8000-000000000002') where age_band = 'recent'),
  25::bigint,
  'backfill uses remaining recent rows after older bands are represented'
);
select is(
  (select count(*) from public.get_widget_memory_candidates('a2000000-0000-4000-8000-000000000002') where age_band = 'medium'),
  5::bigint,
  'medium rows remain below the per-band quota'
);
select is(
  (select count(*) from public.get_widget_memory_candidates('a2000000-0000-4000-8000-000000000002') where age_band = 'old'),
  5::bigint,
  'old rows remain below the per-band quota'
);
select is(
  (select count(*) from public.get_widget_memory_candidates('a2000000-0000-4000-8000-000000000002') where age_band = 'deep'),
  5::bigint,
  'deep rows remain below the per-band quota'
);

-- Reporter-local whole-memory reports, illustration reports, and account
-- blocks are applied before the cap. A report for the current illustration
-- generation removes that image-only memory from the persistent widget pool.
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000003', true);
select ok(
  public.create_content_report(
    'memory',
    'a4000000-0000-4000-8000-000000000023',
    'privacy', null, null
  ) is not null,
  'the viewer can create a whole-memory report for the fixture'
);
select ok(
  (public.set_family_account_block(
    true,
    'a3000000-0000-4000-8000-000000000002',
    null
  )).id is not null,
  'the viewer can create a local block for the manager'
);
select ok(
  public.create_content_report(
    'memory_illustration',
    'a4000000-0000-4000-8000-000000000007',
    'misleading_ai_depiction', null,
    'a5000000-0000-4000-8000-000000000007'
  ) is not null,
  'the viewer can report one illustration generation'
);
select ok(
  not exists (
    select 1
    from public.get_widget_memory_candidates('a2000000-0000-4000-8000-000000000001')
    where memory_id = 'a4000000-0000-4000-8000-000000000023'
  ),
  'a reporter-local whole-memory report removes the memory before the cap'
);
select ok(
  not exists (
    select 1
    from public.get_widget_memory_candidates('a2000000-0000-4000-8000-000000000001')
    where memory_id = 'a4000000-0000-4000-8000-000000000022'
  ),
  'a reporter-local account block removes that author before the cap'
);
select ok(
  not exists (
    select 1
    from public.get_widget_memory_candidates('a2000000-0000-4000-8000-000000000001')
    where memory_id = 'a4000000-0000-4000-8000-000000000007'
  ),
  'a current-generation illustration report removes the illustration memory'
);

select throws_ok(
  $$select public.get_widget_family_timezone('a2000000-0000-4000-8000-000000000003')$$,
  '42501', 'Not authorized for this family',
  'a Family A viewer cannot read Family B owner timezone metadata'
);

-- Empty families return clock metadata plus one null-id sentinel. Invalid
-- owner timezones fall back to UTC instead of producing a malformed response.
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000005', true);
select is(
  (select count(*) from public.get_widget_memory_candidates('a2000000-0000-4000-8000-000000000003')),
  1::bigint,
  'an empty family returns one metadata sentinel row'
);
select is(
  (select memory_id from public.get_widget_memory_candidates('a2000000-0000-4000-8000-000000000003') limit 1),
  null::uuid,
  'the empty-family sentinel has no memory id'
);
select is(
  public.get_widget_family_timezone('a2000000-0000-4000-8000-000000000003'),
  'UTC',
  'an invalid owner timezone falls back to UTC'
);

select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000004', true);
select throws_ok(
  $$select public.get_widget_family_timezone('a2000000-0000-4000-8000-000000000001')$$,
  '42501', 'Not authorized for this family',
  'a non-member cannot use the timezone helper'
);
select throws_ok(
  $$select * from public.get_widget_memory_candidates('a2000000-0000-4000-8000-000000000001')$$,
  '42501', 'Not authorized for this family',
  'a non-member cannot use the candidate RPC'
);

select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000006', true);
select throws_ok(
  $$select * from public.get_widget_memory_candidates('a2000000-0000-4000-8000-000000000001')$$,
  '28000', 'Authentication required',
  'an authenticated anonymous account cannot use the candidate RPC'
);

set local role postgres;
delete from public.family_memberships
where id = 'a3000000-0000-4000-8000-000000000007';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000007', true);
select throws_ok(
  $$select * from public.get_widget_memory_candidates('a2000000-0000-4000-8000-000000000001')$$,
  '42501', 'Not authorized for this family',
  'a removed membership cannot renew widget candidate access'
);

select * from finish();
rollback;
