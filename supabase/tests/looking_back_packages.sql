begin;

select plan(104);

insert into auth.users (id, email, is_anonymous)
values
  ('81000000-0000-4000-8000-000000000001', 'looking-back-owner@example.test', false),
  ('81000000-0000-4000-8000-000000000002', 'looking-back-viewer@example.test', false),
  ('81000000-0000-4000-8000-000000000003', 'looking-back-outsider@example.test', false),
  ('81000000-0000-4000-8000-000000000004', 'looking-back-other@example.test', false),
  ('81000000-0000-4000-8000-000000000005', 'looking-back-empty@example.test', false),
  ('81000000-0000-4000-8000-000000000006', 'looking-back-anonymous@example.test', true),
  ('81000000-0000-4000-8000-000000000007', 'looking-back-cooldown@example.test', false),
  ('81000000-0000-4000-8000-000000000008', 'looking-back-signature@example.test', false),
  ('81000000-0000-4000-8000-000000000009', 'looking-back-soft-penalty@example.test', false),
  ('81000000-0000-4000-8000-000000000010', 'looking-back-invalid-timezone@example.test', false),
  ('81000000-0000-4000-8000-000000000011', 'looking-back-account-cascade@example.test', false),
  ('81000000-0000-4000-8000-000000000012', 'looking-back-timezone-backward@example.test', false),
  ('81000000-0000-4000-8000-000000000013', 'looking-back-variety@example.test', false),
  ('81000000-0000-4000-8000-000000000014', 'looking-back-cap@example.test', false),
  ('81000000-0000-4000-8000-000000000015', 'looking-back-release@example.test', false),
  ('81000000-0000-4000-8000-000000000016', 'looking-back-reservation@example.test', false),
  ('81000000-0000-4000-8000-000000000017', 'looking-back-themed@example.test', false),
  ('81000000-0000-4000-8000-000000000018', 'looking-back-funny@example.test', false),
  ('81000000-0000-4000-8000-000000000019', 'looking-back-mischief@example.test', false),
  ('81000000-0000-4000-8000-000000000020', 'looking-back-shared-emotion@example.test', false),
  ('81000000-0000-4000-8000-000000000021', 'looking-back-birthday@example.test', false);

insert into public.user_profiles (id, name, timezone)
values
  ('81000000-0000-4000-8000-000000000001', 'Looking Back Owner', 'America/New_York'),
  ('81000000-0000-4000-8000-000000000002', 'Looking Back Viewer', 'UTC'),
  ('81000000-0000-4000-8000-000000000003', 'Looking Back Outsider', 'UTC'),
  ('81000000-0000-4000-8000-000000000004', 'Looking Back Other', 'UTC'),
  ('81000000-0000-4000-8000-000000000005', 'Looking Back Empty', 'UTC'),
  ('81000000-0000-4000-8000-000000000007', 'Looking Back Cooldown', 'UTC'),
  ('81000000-0000-4000-8000-000000000008', 'Looking Back Signature', 'UTC'),
  ('81000000-0000-4000-8000-000000000009', 'Looking Back Soft Penalty', 'UTC'),
  ('81000000-0000-4000-8000-000000000010', 'Looking Back Invalid Timezone', 'Mars/Olympus_Mons'),
  ('81000000-0000-4000-8000-000000000011', 'Looking Back Account Cascade', 'UTC'),
  ('81000000-0000-4000-8000-000000000012', 'Looking Back Timezone Backward', 'Pacific/Honolulu'),
  ('81000000-0000-4000-8000-000000000013', 'Looking Back Variety', 'UTC'),
  ('81000000-0000-4000-8000-000000000014', 'Looking Back Cap', 'UTC'),
  ('81000000-0000-4000-8000-000000000015', 'Looking Back Release', 'UTC'),
  ('81000000-0000-4000-8000-000000000016', 'Looking Back Reservation', 'UTC'),
  ('81000000-0000-4000-8000-000000000017', 'Looking Back Themed', 'UTC'),
  ('81000000-0000-4000-8000-000000000018', 'Looking Back Funny', 'UTC'),
  ('81000000-0000-4000-8000-000000000019', 'Looking Back Mischief', 'UTC'),
  ('81000000-0000-4000-8000-000000000020', 'Looking Back Shared Emotion', 'UTC'),
  ('81000000-0000-4000-8000-000000000021', 'Looking Back Birthday', 'UTC')
on conflict (id) do update set timezone = excluded.timezone;

insert into public.families (id, owner_id, name)
values
  ('82000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', 'Looking Back Family'),
  ('82000000-0000-4000-8000-000000000002', '81000000-0000-4000-8000-000000000004', 'Other Family'),
  ('82000000-0000-4000-8000-000000000003', '81000000-0000-4000-8000-000000000005', 'Empty Family'),
  ('82000000-0000-4000-8000-000000000004', '81000000-0000-4000-8000-000000000007', 'Cooldown Family'),
  ('82000000-0000-4000-8000-000000000005', '81000000-0000-4000-8000-000000000008', 'Signature Family'),
  ('82000000-0000-4000-8000-000000000006', '81000000-0000-4000-8000-000000000009', 'Soft Penalty Family'),
  ('82000000-0000-4000-8000-000000000007', '81000000-0000-4000-8000-000000000010', 'Invalid Timezone Family'),
  ('82000000-0000-4000-8000-000000000008', '81000000-0000-4000-8000-000000000011', 'Account Cascade Family'),
  ('82000000-0000-4000-8000-000000000009', '81000000-0000-4000-8000-000000000012', 'Timezone Backward Family'),
  ('82000000-0000-4000-8000-000000000010', '81000000-0000-4000-8000-000000000013', 'Variety Family'),
  ('82000000-0000-4000-8000-000000000014', '81000000-0000-4000-8000-000000000014', 'Cap Family'),
  ('82000000-0000-4000-8000-000000000015', '81000000-0000-4000-8000-000000000015', 'Release Family'),
  ('82000000-0000-4000-8000-000000000016', '81000000-0000-4000-8000-000000000016', 'Reservation Family'),
  ('82000000-0000-4000-8000-000000000017', '81000000-0000-4000-8000-000000000017', 'Themed Family'),
  ('82000000-0000-4000-8000-000000000018', '81000000-0000-4000-8000-000000000018', 'Funny Family'),
  ('82000000-0000-4000-8000-000000000019', '81000000-0000-4000-8000-000000000019', 'Mischief Family'),
  ('82000000-0000-4000-8000-000000000020', '81000000-0000-4000-8000-000000000020', 'Shared Emotion Family'),
  ('82000000-0000-4000-8000-000000000021', '81000000-0000-4000-8000-000000000021', 'Birthday Family');

insert into public.family_memberships (family_id, user_id, role)
values
  ('82000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', 'owner'),
  ('82000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000002', 'viewer'),
  ('82000000-0000-4000-8000-000000000002', '81000000-0000-4000-8000-000000000004', 'owner'),
  ('82000000-0000-4000-8000-000000000003', '81000000-0000-4000-8000-000000000005', 'owner'),
  ('82000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000006', 'viewer'),
  ('82000000-0000-4000-8000-000000000004', '81000000-0000-4000-8000-000000000007', 'owner'),
  ('82000000-0000-4000-8000-000000000005', '81000000-0000-4000-8000-000000000008', 'owner'),
  ('82000000-0000-4000-8000-000000000006', '81000000-0000-4000-8000-000000000009', 'owner'),
  ('82000000-0000-4000-8000-000000000007', '81000000-0000-4000-8000-000000000010', 'owner'),
  ('82000000-0000-4000-8000-000000000008', '81000000-0000-4000-8000-000000000011', 'owner'),
  ('82000000-0000-4000-8000-000000000009', '81000000-0000-4000-8000-000000000012', 'owner'),
  ('82000000-0000-4000-8000-000000000010', '81000000-0000-4000-8000-000000000013', 'owner'),
  ('82000000-0000-4000-8000-000000000014', '81000000-0000-4000-8000-000000000014', 'owner'),
  ('82000000-0000-4000-8000-000000000015', '81000000-0000-4000-8000-000000000015', 'owner'),
  ('82000000-0000-4000-8000-000000000016', '81000000-0000-4000-8000-000000000016', 'owner'),
  ('82000000-0000-4000-8000-000000000017', '81000000-0000-4000-8000-000000000017', 'owner'),
  ('82000000-0000-4000-8000-000000000018', '81000000-0000-4000-8000-000000000018', 'owner'),
  ('82000000-0000-4000-8000-000000000019', '81000000-0000-4000-8000-000000000019', 'owner'),
  ('82000000-0000-4000-8000-000000000020', '81000000-0000-4000-8000-000000000020', 'owner'),
  ('82000000-0000-4000-8000-000000000021', '81000000-0000-4000-8000-000000000021', 'owner');

insert into public.family_members (id, family_id, user_id, name, date_of_birth)
values (
  '83000000-0000-4000-8000-000000000001',
  '82000000-0000-4000-8000-000000000001',
  '81000000-0000-4000-8000-000000000001', 'Ada', current_date - interval '4 years'
);

insert into public.memories (id, family_id, user_id, content, memory_date, memory_type, illustration_status)
select
  ('84000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  '82000000-0000-4000-8000-000000000001',
  '81000000-0000-4000-8000-000000000001',
  'Looking back fixture ' || series,
  current_date - (400 + series),
  case when series <= 5 then 'text_only' else 'text_illustration' end,
  case when series <= 5 then 'none' else 'failed' end
from generate_series(1, 18) as series;

insert into public.memory_family_members (memory_id, family_member_id)
select id, '83000000-0000-4000-8000-000000000001'
from public.memories
where family_id = '82000000-0000-4000-8000-000000000001';

-- Deliberately creates four viable member-at-age candidates. The prior
-- package features Child A, so today's one age slot must rotate to Child B;
-- the other daily slots must remain available to different recipe types.
insert into public.family_members (id, family_id, user_id, name, date_of_birth)
values
  ('83000000-0000-4000-8000-000000000003', '82000000-0000-4000-8000-000000000010', '81000000-0000-4000-8000-000000000013', 'Child A', current_date - 1900),
  ('83000000-0000-4000-8000-000000000004', '82000000-0000-4000-8000-000000000010', '81000000-0000-4000-8000-000000000013', 'Child B', current_date - 1900);

insert into public.memories (id, family_id, user_id, content, memory_date, memory_type, illustration_status)
select
  ('8c000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  '82000000-0000-4000-8000-000000000010',
  '81000000-0000-4000-8000-000000000013',
  'Variety fixture ' || series,
  current_date - case when series between 1 and 4 or series between 9 and 12 then 1800 else 1400 end,
  'text_illustration',
  'failed'
from generate_series(1, 16) as series;

insert into public.memory_family_members (memory_id, family_member_id)
select id,
  case when substring(id::text from 25)::bigint <= 8
    then '83000000-0000-4000-8000-000000000003'::uuid
    else '83000000-0000-4000-8000-000000000004'::uuid
  end
from public.memories
where family_id = '82000000-0000-4000-8000-000000000010';

insert into public.looking_back_daily_sets (id, family_id, package_date, timezone_name, refresh_after, created_at)
values (
  '86400000-0000-4000-8000-000000000001',
  '82000000-0000-4000-8000-000000000010',
  current_date - 1,
  'UTC',
  current_date::timestamp at time zone 'UTC',
  transaction_timestamp() - interval '1 day'
);
insert into public.looking_back_packages (
  id, daily_set_id, family_id, package_date, package_type,
  subject_family_member_id, display_kind, display_title, display_era,
  recipe_identity, signature, position, created_at
) values (
  '86400000-0000-4000-8000-000000000002',
  '86400000-0000-4000-8000-000000000001',
  '82000000-0000-4000-8000-000000000010',
  current_date - 1,
  'member_at_age',
  '83000000-0000-4000-8000-000000000003',
  'Looking back', 'From Child A''s first year', 'From your archive',
  'member_at_age:83000000-0000-4000-8000-000000000003:0',
  repeat('a', 64), 0,
  transaction_timestamp() - interval '1 day'
);
-- Keep the current fixture focused on the age-zero title branch by giving the
-- alternate age candidate a recent recipe exposure.
insert into public.looking_back_daily_sets (id, family_id, package_date, timezone_name, refresh_after, created_at)
values (
  '86400000-0000-4000-8000-000000000003',
  '82000000-0000-4000-8000-000000000010',
  current_date - 2,
  'UTC',
  (current_date - 1)::timestamp at time zone 'UTC',
  transaction_timestamp() - interval '2 days'
);
insert into public.looking_back_packages (
  id, daily_set_id, family_id, package_date, package_type,
  subject_family_member_id, display_kind, display_title, display_era,
  recipe_identity, signature, position, created_at
) values (
  '86400000-0000-4000-8000-000000000004',
  '86400000-0000-4000-8000-000000000003',
  '82000000-0000-4000-8000-000000000010',
  current_date - 2,
  'archive_mix',
  null,
  'From your archive', 'A little look back', 'From your archive',
  'member_at_age:83000000-0000-4000-8000-000000000004:1',
  repeat('b', 64), 0,
  transaction_timestamp() - interval '2 days'
);

insert into public.memories (id, family_id, user_id, content, memory_date, memory_type, illustration_status)
values (
  '85000000-0000-4000-8000-000000000001',
  '82000000-0000-4000-8000-000000000002',
  '81000000-0000-4000-8000-000000000004', 'Other family memory',
  current_date - 500, 'text_only', 'none'
);
insert into public.memories (id, family_id, user_id, content, memory_date, memory_type, media_key, media_content_type, illustration_status)
select ('8b000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  '82000000-0000-4000-8000-000000000002', '81000000-0000-4000-8000-000000000004',
  null, current_date - (500 + series), 'media',
  '81000000-0000-4000-8000-000000000004/memories/zero-asset-' || series || '/original.jpg',
  'image/jpeg', 'none'
from generate_series(1, 4) as series;

-- Historical fixtures deliberately cover the hard memory/signature windows
-- independently. They are text illustrations with dates in separate months,
-- so archive_mix is the only viable current candidate in the signature/soft
-- tests (no written/month/anniversary recipe can mask the assertion).
insert into public.memories (id, family_id, user_id, content, memory_date, memory_type, illustration_status)
select ('87000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  '82000000-0000-4000-8000-000000000004', '81000000-0000-4000-8000-000000000007',
  'Cooldown fixture ' || series, current_date - (500 + series * 31), 'text_illustration', 'failed'
from generate_series(1, 12) as series;
insert into public.memories (id, family_id, user_id, content, memory_date, memory_type, illustration_status)
select ('88000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  '82000000-0000-4000-8000-000000000005', '81000000-0000-4000-8000-000000000008',
  'Signature fixture ' || series, current_date - (500 + series * 41), 'text_illustration', 'failed'
from generate_series(1, 4) as series;
-- The post-exposure survivors intentionally span all three archive age bands:
-- newer historical (90d-18mo), medium (18-36mo), and deep (36mo+).
insert into public.memories (id, family_id, user_id, content, memory_date, memory_type, illustration_status)
select ('89000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  '82000000-0000-4000-8000-000000000006', '81000000-0000-4000-8000-000000000009',
  'Soft penalty fixture ' || series,
  current_date - case
    when series in (1, 4, 5, 6, 7, 8, 9) then 400 + series
    when series in (2, 10, 11, 12, 13, 14) then 800 + series
    else 1500 + series
  end,
  'text_illustration', 'failed'
from generate_series(1, 19) as series;
insert into public.memories (id, family_id, user_id, content, memory_date, memory_type, illustration_status)
select ('8a000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  '82000000-0000-4000-8000-000000000007', '81000000-0000-4000-8000-000000000010',
  'Invalid timezone fixture ' || series, current_date - (500 + series * 39), 'text_illustration', 'failed'
from generate_series(1, 4) as series;
insert into public.memories (id, family_id, user_id, content, memory_date, memory_type, illustration_status)
select ('8d000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  '82000000-0000-4000-8000-000000000009', '81000000-0000-4000-8000-000000000012',
  'Timezone collision fixture ' || series, current_date - (500 + series * 43), 'text_illustration', 'failed'
from generate_series(1, 4) as series;

-- The cap fixture has three viable thematic recipes before archive_mix. Its
-- exact mixed-archive signature is cooling down, while separate month and
-- written fallbacks remain viable. Without the unconditional four-package
-- guard, the second fallback attempts position 4 and rolls back the RPC.
insert into public.family_members (id, family_id, user_id, name, date_of_birth)
values (
  '83000000-0000-4000-8000-000000000014',
  '82000000-0000-4000-8000-000000000014',
  '81000000-0000-4000-8000-000000000014',
  'Cap Child', current_date - interval '6 years'
);
insert into public.memories (id, family_id, user_id, content, memory_date, memory_type, illustration_status)
select ('8e000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  '82000000-0000-4000-8000-000000000014', '81000000-0000-4000-8000-000000000014',
  'Cap on-this-day fixture ' || series, (current_date - interval '4 years')::date,
  'text_illustration', 'failed'
from generate_series(1, 4) as series;
insert into public.memories (id, family_id, user_id, content, memory_date, memory_type, illustration_status)
select ('8f000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  '82000000-0000-4000-8000-000000000014', '81000000-0000-4000-8000-000000000014',
  'Cap around-this-time fixture ' || series,
  (current_date - interval '4 years')::date + 5, 'text_illustration', 'failed'
from generate_series(1, 4) as series;
insert into public.memories (id, family_id, user_id, content, memory_date, memory_type, illustration_status)
select ('90000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  '82000000-0000-4000-8000-000000000014', '81000000-0000-4000-8000-000000000014',
  'Cap member-at-age fixture ' || series,
  (current_date - interval '4 years')::date + 15 + series, 'text_illustration', 'failed'
from generate_series(1, 4) as series;
insert into public.memory_family_members (memory_id, family_member_id)
select id, '83000000-0000-4000-8000-000000000014'
from public.memories
where family_id = '82000000-0000-4000-8000-000000000014'
  and id::text like '90000000%';
insert into public.memories (id, family_id, user_id, content, memory_date, memory_type, illustration_status)
select ('91000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  '82000000-0000-4000-8000-000000000014', '81000000-0000-4000-8000-000000000014',
  'Cap month fallback fixture ' || series,
  (current_date - interval '4 years')::date - 11, 'text_illustration', 'failed'
from generate_series(1, 4) as series;
insert into public.memories (id, family_id, user_id, content, memory_date, memory_type, illustration_status)
select ('92000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  '82000000-0000-4000-8000-000000000014', '81000000-0000-4000-8000-000000000014',
  'Cap written fallback fixture ' || series,
  (current_date - interval '22 months')::date, 'text_only', 'none'
from generate_series(1, 4) as series;
insert into public.looking_back_daily_sets (id, family_id, package_date, timezone_name, refresh_after, created_at)
values
  ('8e100000-0000-4000-8000-000000000014', '82000000-0000-4000-8000-000000000014', current_date - 8, 'UTC', (current_date - 7)::timestamp at time zone 'UTC', transaction_timestamp() - interval '8 days'),
  ('8e300000-0000-4000-8000-000000000014', '82000000-0000-4000-8000-000000000014', current_date - 1, 'UTC', current_date::timestamp at time zone 'UTC', transaction_timestamp() - interval '1 day');
insert into public.looking_back_packages (
  id, daily_set_id, family_id, package_date, package_type, display_kind,
  display_title, display_era, recipe_identity, signature, position, created_at
)
values
  (
    '8e200000-0000-4000-8000-000000000014',
    '8e100000-0000-4000-8000-000000000014',
    '82000000-0000-4000-8000-000000000014', current_date - 8, 'archive_mix',
    'From your archive', 'Cooling archive', 'From your archive', 'archive_mix',
    encode(extensions.digest(
      'archive_mix:archive_mix:' || (
        select array_to_string(array_agg(id order by id), ',')
        from public.memories
        where family_id = '82000000-0000-4000-8000-000000000014'
          and (id::text like '91000000%' or id::text like '92000000%')
      ), 'sha256'
    ), 'hex'), 0, transaction_timestamp() - interval '8 days'
  ),
  (
    '8e400000-0000-4000-8000-000000000014',
    '8e300000-0000-4000-8000-000000000014',
    '82000000-0000-4000-8000-000000000014', current_date - 1, 'month_archive',
    'From your archive', 'From October 2024', 'October 2024',
    'month_archive:' || date_trunc('month', (current_date - interval '22 months')::date)::date::text,
    repeat('d', 64), 0, transaction_timestamp() - interval '1 day'
  );
insert into public.looking_back_package_memories (package_id, family_id, memory_id, position)
select '8e200000-0000-4000-8000-000000000014',
  '82000000-0000-4000-8000-000000000014', id,
  row_number() over (order by id) - 1
from public.memories
where family_id = '82000000-0000-4000-8000-000000000014'
  and (id::text like '91000000%' or id::text like '92000000%');

-- The release fixture has one thematic package, a viable archive_mix, and
-- two lower fallbacks. Accepting archive_mix must release its reservation so
-- the fourth package is still materialized.
insert into public.memories (id, family_id, user_id, content, memory_date, memory_type, illustration_status)
select ('93000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  '82000000-0000-4000-8000-000000000015', '81000000-0000-4000-8000-000000000015',
  'Release on-this-day fixture ' || series, (current_date - interval '4 years')::date,
  'text_illustration', 'failed'
from generate_series(1, 4) as series;
insert into public.memories (id, family_id, user_id, content, memory_date, memory_type, illustration_status)
select ('93100000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  '82000000-0000-4000-8000-000000000015', '81000000-0000-4000-8000-000000000015',
  'Release newer core fixture ' || series, current_date - (400 + series * 20),
  'text_illustration', 'failed'
from generate_series(1, 4) as series;
insert into public.memories (id, family_id, user_id, content, memory_date, memory_type, illustration_status)
select ('93200000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  '82000000-0000-4000-8000-000000000015', '81000000-0000-4000-8000-000000000015',
  'Release medium core fixture ' || series, current_date - (700 + series * 30),
  'text_illustration', 'failed'
from generate_series(1, 4) as series;
insert into public.memories (id, family_id, user_id, content, memory_date, memory_type, illustration_status)
select ('93300000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  '82000000-0000-4000-8000-000000000015', '81000000-0000-4000-8000-000000000015',
  'Release deep core fixture ' || series, current_date - (1400 + series * 30),
  'text_illustration', 'failed'
from generate_series(1, 4) as series;
insert into public.memories (id, family_id, user_id, content, memory_date, memory_type, illustration_status)
select ('93400000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  '82000000-0000-4000-8000-000000000015', '81000000-0000-4000-8000-000000000015',
  'Release month fallback fixture ' || series, (current_date - interval '4 years')::date - 10,
  'text_illustration', 'failed'
from generate_series(1, 8) as series;
insert into public.memories (id, family_id, user_id, content, memory_date, memory_type, illustration_status)
select ('93500000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  '82000000-0000-4000-8000-000000000015', '81000000-0000-4000-8000-000000000015',
  'Release written fallback fixture ' || series, (current_date - interval '22 months')::date,
  'text_only', 'none'
from generate_series(1, 8) as series;
insert into public.looking_back_daily_sets (id, family_id, package_date, timezone_name, refresh_after, created_at)
values (
  '93510000-0000-4000-8000-000000000015',
  '82000000-0000-4000-8000-000000000015',
  current_date - 1, 'UTC', current_date::timestamp at time zone 'UTC',
  transaction_timestamp() - interval '1 day'
);
insert into public.looking_back_packages (
  id, daily_set_id, family_id, package_date, package_type, display_kind,
  display_title, display_era, recipe_identity, signature, position, created_at
)
values (
  '93520000-0000-4000-8000-000000000015',
  '93510000-0000-4000-8000-000000000015',
  '82000000-0000-4000-8000-000000000015', current_date - 1, 'month_archive',
  'From your archive', 'From October 2024', 'October 2024',
  'month_archive:' || date_trunc('month', (current_date - interval '22 months')::date)::date::text,
  repeat('e', 64), 0, transaction_timestamp() - interval '1 day'
);

-- Four thematic recipes are viable here. The archive reservation must stop
-- the fourth thematic recipe from consuming position 3, and the post-overlap
-- archive must refill the deep band after the on-this-day/member packages
-- consume deep memories from its initial quota.
insert into public.family_members (id, family_id, user_id, name, date_of_birth)
values (
  '83000000-0000-4000-8000-000000000016',
  '82000000-0000-4000-8000-000000000016',
  '81000000-0000-4000-8000-000000000016',
  'Reservation Child', current_date - interval '6 years'
);
insert into public.memories (id, family_id, user_id, content, memory_date, memory_type, illustration_status)
select ('96000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  '82000000-0000-4000-8000-000000000016', '81000000-0000-4000-8000-000000000016',
  'Reservation on-this-day fixture ' || series, (current_date - interval '4 years')::date,
  'text_illustration', 'failed'
from generate_series(1, 4) as series;
insert into public.memories (id, family_id, user_id, content, memory_date, memory_type, illustration_status)
select ('96100000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  '82000000-0000-4000-8000-000000000016', '81000000-0000-4000-8000-000000000016',
  'Reservation one-year fixture ' || series,
  (current_date - interval '1 year')::date + case series when 1 then -3 when 2 then -2 when 3 then -1 else 1 end,
  'text_illustration', 'failed'
from generate_series(1, 4) as series;
insert into public.memories (id, family_id, user_id, content, memory_date, memory_type, illustration_status)
select ('96200000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  '82000000-0000-4000-8000-000000000016', '81000000-0000-4000-8000-000000000016',
  'Reservation member-at-age fixture ' || series, current_date - (1500 + series),
  'text_illustration', 'failed'
from generate_series(1, 4) as series;
insert into public.memory_family_members (memory_id, family_member_id)
select id, '83000000-0000-4000-8000-000000000016'
from public.memories
where family_id = '82000000-0000-4000-8000-000000000016'
  and id::text like '96200000%';
insert into public.memories (id, family_id, user_id, content, memory_date, memory_type, illustration_status)
select ('96300000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  '82000000-0000-4000-8000-000000000016', '81000000-0000-4000-8000-000000000016',
  'Reservation around-this-time fixture ' || series,
  (current_date - interval '2 years')::date + 5, 'text_illustration', 'failed'
from generate_series(1, 4) as series;
insert into public.memories (id, family_id, user_id, content, memory_date, memory_type, illustration_status)
select ('96400000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  '82000000-0000-4000-8000-000000000016', '81000000-0000-4000-8000-000000000016',
  'Reservation newer filler ' || series, current_date - (400 + series * 12),
  'text_illustration', 'failed'
from generate_series(1, 8) as series;
insert into public.memories (id, family_id, user_id, content, memory_date, memory_type, illustration_status)
select ('96500000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  '82000000-0000-4000-8000-000000000016', '81000000-0000-4000-8000-000000000016',
  'Reservation medium filler ' || series, current_date - (750 + series * 20),
  'text_illustration', 'failed'
from generate_series(1, 8) as series;
insert into public.memories (id, family_id, user_id, content, memory_date, memory_type, illustration_status)
select ('96600000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  '82000000-0000-4000-8000-000000000016', '81000000-0000-4000-8000-000000000016',
  'Reservation deep filler ' || series, current_date - (1400 + series * 20),
  'text_illustration', 'failed'
from generate_series(1, 8) as series;

insert into public.looking_back_daily_sets (id, family_id, package_date, timezone_name, refresh_after, created_at)
values
  ('87100000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000004', current_date - 1, 'UTC', now() - interval '12 hours', now() - interval '2 days'),
  ('88100000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000005', current_date - 8, 'UTC', now() - interval '7 days', now() - interval '9 days'),
  ('89100000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000006', current_date - 1, 'UTC', now() - interval '12 hours', now() - interval '2 days');
insert into public.looking_back_packages (id, daily_set_id, family_id, package_date, package_type, display_kind, display_title, display_era, recipe_identity, signature, position, created_at)
values
  ('87200000-0000-4000-8000-000000000001', '87100000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000004', current_date - 1, 'archive_mix', 'From your archive', 'Cooldown', 'From your archive', 'archive_mix', repeat('b', 64), 0, transaction_timestamp() - interval '1 day'),
  ('88200000-0000-4000-8000-000000000001', '88100000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000005', current_date - 8, 'archive_mix', 'From your archive', 'Signature', 'From your archive', 'archive_mix', encode(extensions.digest('archive_mix:archive_mix:' || (select array_to_string(array_agg(id order by id), ',') from public.memories where family_id = '82000000-0000-4000-8000-000000000005'), 'sha256'), 'hex'), 0, transaction_timestamp() - interval '8 days'),
  ('89200000-0000-4000-8000-000000000001', '89100000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000006', current_date - 1, 'archive_mix', 'From your archive', 'Soft penalty', 'From your archive', 'archive_mix', repeat('c', 64), 0, transaction_timestamp() - interval '1 day');
insert into public.looking_back_package_memories (package_id, family_id, memory_id, position)
select '87200000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000004', id, row_number() over (order by id) - 1
from public.memories where family_id = '82000000-0000-4000-8000-000000000004' order by id limit 4;
insert into public.looking_back_package_memories (package_id, family_id, memory_id, position)
select '88200000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000005', id, row_number() over (order by id) - 1
from public.memories where family_id = '82000000-0000-4000-8000-000000000005' order by id;
insert into public.looking_back_package_memories (package_id, family_id, memory_id, position)
select '89200000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000006', id, row_number() over (order by id) - 1
from public.memories where family_id = '82000000-0000-4000-8000-000000000006' order by id limit 4;

insert into public.looking_back_daily_sets (id, family_id, package_date, timezone_name, refresh_after, created_at)
values (
  '8c100000-0000-4000-8000-000000000001',
  '82000000-0000-4000-8000-000000000009',
  (transaction_timestamp() at time zone 'Pacific/Honolulu')::date,
  'Pacific/Kiritimati', transaction_timestamp() - interval '1 day', transaction_timestamp() - interval '2 days'
);

-- The themed-recipe fixtures stay isolated from the legacy variety/cooldown
-- cases above. Birthday memories cover two historical years in their own
-- family and are tagged only to Ada; togetherness memories use two no-DOB
-- subjects in a separate family so age selection cannot consume them first.
-- The final birthday rows are outside the ±7-day anniversary window.
insert into public.family_members (id, family_id, user_id, name, date_of_birth)
values
  ('83000000-0000-4000-8000-000000000005', '82000000-0000-4000-8000-000000000021', '81000000-0000-4000-8000-000000000021', 'Ada', current_date - interval '6 years'),
  ('83000000-0000-4000-8000-000000000006', '82000000-0000-4000-8000-000000000017', '81000000-0000-4000-8000-000000000017', 'Bea', null),
  ('83000000-0000-4000-8000-000000000007', '82000000-0000-4000-8000-000000000017', '81000000-0000-4000-8000-000000000017', 'Cleo', null);
insert into public.memories (id, family_id, user_id, content, memory_date, memory_type, illustration_status)
select
  ('a1000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  '82000000-0000-4000-8000-000000000021',
  '81000000-0000-4000-8000-000000000021',
  'Birthday fixture ' || series,
  (current_date - make_interval(years => case when series <= 12 then 1 else 2 end))::date
    + ((series % 3) - 1),
  'text_only', 'none'
from generate_series(1, 24) as series;
insert into public.memories (id, family_id, user_id, content, memory_date, memory_type, illustration_status)
values
  (
    'a1000000-0000-4000-8000-000000000025',
    '82000000-0000-4000-8000-000000000021',
    '81000000-0000-4000-8000-000000000021',
    'Birthday boundary fixture plus seven',
    (current_date - interval '1 year')::date + 7,
    'text_only', 'none'
  ),
  (
    'a1000000-0000-4000-8000-000000000026',
    '82000000-0000-4000-8000-000000000021',
    '81000000-0000-4000-8000-000000000021',
    'Birthday out-of-window fixture plus eight',
    (current_date - interval '1 year')::date + 8,
    'text_only', 'none'
  ),
  (
    'a1000000-0000-4000-8000-000000000027',
    '82000000-0000-4000-8000-000000000021',
    '81000000-0000-4000-8000-000000000021',
    'Birthday boundary fixture minus seven',
    (current_date - interval '2 years')::date - 7,
    'text_only', 'none'
  ),
  (
    'a1000000-0000-4000-8000-000000000028',
    '82000000-0000-4000-8000-000000000021',
    '81000000-0000-4000-8000-000000000021',
    'Birthday out-of-window fixture minus eight',
    (current_date - interval '2 years')::date - 8,
    'text_only', 'none'
  ),
  (
    'a1000000-0000-4000-8000-000000000029',
    '82000000-0000-4000-8000-000000000021',
    '81000000-0000-4000-8000-000000000021',
    'Birthday out-of-window fixture plus twenty',
    (current_date - interval '1 year')::date + 20,
    'text_only', 'none'
  );
insert into public.memory_family_members (memory_id, family_member_id)
select id, '83000000-0000-4000-8000-000000000005'
from public.memories
where family_id = '82000000-0000-4000-8000-000000000021'
  and id::text like 'a1000000%';
insert into public.memories (id, family_id, user_id, content, memory_date, memory_type, illustration_status)
select
  ('a2000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  '82000000-0000-4000-8000-000000000017',
  '81000000-0000-4000-8000-000000000017',
  'Togetherness fixture ' || series,
  current_date - 500 - series * 10,
  'text_only', 'none'
from generate_series(1, 4) as series;
insert into public.memory_family_members (memory_id, family_member_id)
select id, member_id
from public.memories
cross join (values
  ('83000000-0000-4000-8000-000000000006'::uuid),
  ('83000000-0000-4000-8000-000000000007'::uuid)
) as members(member_id)
where family_id = '82000000-0000-4000-8000-000000000017'
  and id::text like 'a2000000%';

insert into public.memories (id, family_id, user_id, content, memory_date, memory_type, illustration_status, emotion)
select
  ('a3000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  '82000000-0000-4000-8000-000000000018',
  '81000000-0000-4000-8000-000000000018',
  'Funny fixture ' || series,
  current_date - 400 - series,
  'text_only', 'none', 'funny'
from generate_series(1, 5) as series;
insert into public.memories (id, family_id, user_id, content, memory_date, memory_type, illustration_status, emotion)
select
  ('a4000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  '82000000-0000-4000-8000-000000000019',
  '81000000-0000-4000-8000-000000000019',
  'Mischief fixture ' || series,
  current_date - 400 - series,
  'text_only', 'none', 'mischief'
from generate_series(1, 5) as series;
insert into public.memories (id, family_id, user_id, content, memory_date, memory_type, illustration_status, emotion)
select
  ('a5000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  '82000000-0000-4000-8000-000000000020',
  '81000000-0000-4000-8000-000000000020',
  'Shared funny fixture ' || series,
  current_date - 400 - series,
  'text_only', 'none', 'funny'
from generate_series(1, 5) as series;
insert into public.memories (id, family_id, user_id, content, memory_date, memory_type, illustration_status, emotion)
select
  ('a6000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  '82000000-0000-4000-8000-000000000020',
  '81000000-0000-4000-8000-000000000020',
  'Shared mischief fixture ' || series,
  current_date - 500 - series,
  'text_only', 'none', 'mischief'
from generate_series(1, 5) as series;

set local role authenticated;
select set_config('request.jwt.claim.sub', '81000000-0000-4000-8000-000000000004', true);
select is(
  (select package_id from public.get_or_create_looking_back_packages('82000000-0000-4000-8000-000000000002') limit 1),
  null::uuid,
  'media memories without an ordered memory_media asset are not eligible for a package'
);

select set_config('request.jwt.claim.sub', '81000000-0000-4000-8000-000000000012', true);
select lives_ok(
  $$select * from public.get_or_create_looking_back_packages('82000000-0000-4000-8000-000000000009')$$,
  'a backward timezone collision can materialize viable packages in its fresh interval'
);
select is(
  (select count(*) from public.looking_back_daily_sets
   where family_id = '82000000-0000-4000-8000-000000000009'
     and package_date = (transaction_timestamp() at time zone 'Pacific/Honolulu')::date),
  2::bigint,
  'a backward timezone collision creates a fresh immutable interval for the displayed date'
);
select ok(
  (select refresh_after > transaction_timestamp()
   from public.looking_back_daily_sets
   where family_id = '82000000-0000-4000-8000-000000000009'
   order by created_at desc limit 1),
  'the replacement interval has a future refresh boundary rather than returning stale metadata'
);
select ok(
  exists (
    select 1 from public.looking_back_packages
    where family_id = '82000000-0000-4000-8000-000000000009'
  ),
  'the fresh backward-timezone interval stores its viable deterministic package'
);

select set_config('request.jwt.claim.sub', '81000000-0000-4000-8000-000000000017', true);
select lives_ok(
  $$select * from public.get_or_create_looking_back_packages('82000000-0000-4000-8000-000000000017')$$,
  'a togetherness archive can materialize for its isolated family'
);
select set_config('request.jwt.claim.sub', '81000000-0000-4000-8000-000000000021', true);
select lives_ok(
  $$select * from public.get_or_create_looking_back_packages('82000000-0000-4000-8000-000000000021')$$,
  'a birthday archive can materialize for its isolated family'
);
select is(
  (select birthday_year
   from (
     select years.birthday_year,
       make_date(years.birthday_year, 12, 31) as birthday_date
     from generate_series(2025, 2027) as years(birthday_year)
   ) anniversaries
   where date '2026-01-02' between birthday_date - 7 and birthday_date + 7
   order by abs(date '2026-01-02' - birthday_date), birthday_year
   limit 1),
  2025,
  'birthday matching associates a January memory with the prior December anniversary year'
);
select ok(
  (with birthday_years as (
     select make_date(2026 + offsets.year_offset, 8, 12) as birthday_date
     from (values (-1), (0), (1)) as offsets(year_offset)
   )
   select
     (select count(*) from birthday_years where abs(date '2026-08-15' - birthday_date) <= 3) = 1
     and (select count(*) from birthday_years where abs(date '2026-08-16' - birthday_date) <= 3) = 0),
  'birthday appearance grace includes exactly three days on either side'
);
select is(
  (select count(*) from public.looking_back_packages
   where family_id = '82000000-0000-4000-8000-000000000021'
     and package_date = current_date and package_type = 'member_birthday'),
  1::bigint,
  'the birthday recipe materializes one package on the member birthday'
);
select is(
  (select display_title from public.looking_back_packages
   where family_id = '82000000-0000-4000-8000-000000000021'
     and package_date = current_date and package_type = 'member_birthday'),
  'Ada’s birthday, through the years',
  'birthday packages use the agreed title template'
);
select is(
  (select count(*) from public.looking_back_package_memories i
   join public.looking_back_packages p on p.id = i.package_id
   where p.family_id = '82000000-0000-4000-8000-000000000021'
     and p.package_date = current_date and p.package_type = 'member_birthday'),
  10::bigint,
  'birthday packages cap a large anniversary archive at ten memories'
);
select ok(
  (select count(distinct extract(year from m.memory_date)) = 2
   from public.looking_back_package_memories i
   join public.looking_back_packages p on p.id = i.package_id
   join public.memories m on m.id = i.memory_id
   where p.family_id = '82000000-0000-4000-8000-000000000021'
     and p.package_date = current_date and p.package_type = 'member_birthday')
  and not exists (
    select 1
    from public.looking_back_package_memories i
    join public.looking_back_packages p on p.id = i.package_id
    where p.family_id = '82000000-0000-4000-8000-000000000021'
      and p.package_date = current_date and p.package_type = 'member_birthday'
      and i.memory_id in (
        'a1000000-0000-4000-8000-000000000026',
        'a1000000-0000-4000-8000-000000000028',
        'a1000000-0000-4000-8000-000000000029'
      )
  ),
  'birthday selection spans two years and excludes memories outside the ±7-day window'
);
select set_config('request.jwt.claim.sub', '81000000-0000-4000-8000-000000000017', true);
select is(
  (select count(*) from public.looking_back_packages
   where family_id = '82000000-0000-4000-8000-000000000017'
     and package_date = current_date and package_type = 'members_together'),
  1::bigint,
  'the togetherness recipe selects one unordered member pair'
);
select is(
  (select display_title from public.looking_back_packages
   where family_id = '82000000-0000-4000-8000-000000000017'
     and package_date = current_date and package_type = 'members_together'),
  'Moments with Bea & Cleo',
  'togetherness packages use both member names in the agreed title'
);
select is(
  (select secondary_subject_family_member_id from public.looking_back_packages
   where family_id = '82000000-0000-4000-8000-000000000017'
     and package_date = current_date and package_type = 'members_together'),
  '83000000-0000-4000-8000-000000000007'::uuid,
  'togetherness packages persist the canonical secondary subject'
);
select ok(
  not exists (
    select 1
    from public.looking_back_package_memories i
    join public.looking_back_packages p on p.id = i.package_id
    where p.family_id = '82000000-0000-4000-8000-000000000017'
      and p.package_date = current_date and p.package_type = 'members_together'
      and (
        not exists (
          select 1 from public.memory_family_members tag
          where tag.memory_id = i.memory_id
            and tag.family_member_id = '83000000-0000-4000-8000-000000000006'
        )
        or not exists (
          select 1 from public.memory_family_members tag
          where tag.memory_id = i.memory_id
            and tag.family_member_id = '83000000-0000-4000-8000-000000000007'
        )
      )
  ),
  'every togetherness package memory carries both required member tags'
);

select set_config('request.jwt.claim.sub', '81000000-0000-4000-8000-000000000018', true);
select lives_ok(
  $$select * from public.get_or_create_looking_back_packages('82000000-0000-4000-8000-000000000018')$$,
  'an exact funny emotion archive can materialize'
);
select is(
  (select count(*) from public.looking_back_packages
   where family_id = '82000000-0000-4000-8000-000000000018'
     and package_date = current_date and package_type = 'emotion_archive'),
  1::bigint,
  'funny memories share one emotion archive slot'
);
select is(
  (select display_title from public.looking_back_packages
   where family_id = '82000000-0000-4000-8000-000000000018'
     and package_date = current_date and package_type = 'emotion_archive'),
  'The funny ones',
  'funny packages use the agreed title'
);
select is(
  (select tint from public.looking_back_packages
   where family_id = '82000000-0000-4000-8000-000000000018'
     and package_date = current_date and package_type = 'emotion_archive'),
  'funny',
  'funny packages preserve the matching emotion tint'
);
select ok(
  not exists (
    select 1
    from public.looking_back_package_memories i
    join public.looking_back_packages p on p.id = i.package_id
    join public.memories m on m.id = i.memory_id
    where p.family_id = '82000000-0000-4000-8000-000000000018'
      and p.package_date = current_date and p.package_type = 'emotion_archive'
      and m.emotion is distinct from 'funny'
  ),
  'funny packages select only memories with the exact funny label'
);

select set_config('request.jwt.claim.sub', '81000000-0000-4000-8000-000000000019', true);
select lives_ok(
  $$select * from public.get_or_create_looking_back_packages('82000000-0000-4000-8000-000000000019')$$,
  'an exact mischief emotion archive can materialize'
);
select is(
  (select count(*) from public.looking_back_packages
   where family_id = '82000000-0000-4000-8000-000000000019'
     and package_date = current_date and package_type = 'emotion_archive'),
  1::bigint,
  'mischief memories share one emotion archive slot'
);
select is(
  (select display_title from public.looking_back_packages
   where family_id = '82000000-0000-4000-8000-000000000019'
     and package_date = current_date and package_type = 'emotion_archive'),
  'Tiny troublemakers',
  'mischief packages use the agreed title'
);
select is(
  (select tint from public.looking_back_packages
   where family_id = '82000000-0000-4000-8000-000000000019'
     and package_date = current_date and package_type = 'emotion_archive'),
  'mischief',
  'mischief packages preserve the matching emotion tint'
);
select ok(
  not exists (
    select 1
    from public.looking_back_package_memories i
    join public.looking_back_packages p on p.id = i.package_id
    join public.memories m on m.id = i.memory_id
    where p.family_id = '82000000-0000-4000-8000-000000000019'
      and p.package_date = current_date and p.package_type = 'emotion_archive'
      and m.emotion is distinct from 'mischief'
  ),
  'mischief packages select only memories with the exact mischief label'
);

select set_config('request.jwt.claim.sub', '81000000-0000-4000-8000-000000000020', true);
select lives_ok(
  $$select * from public.get_or_create_looking_back_packages('82000000-0000-4000-8000-000000000020')$$,
  'funny and mischief memories share one rotating emotion slot'
);
select is(
  (select count(*) from public.looking_back_packages
   where family_id = '82000000-0000-4000-8000-000000000020'
     and package_date = current_date and package_type = 'emotion_archive'),
  1::bigint,
  'a family with both emotion labels still receives one emotion package'
);
select ok(
  exists (
    select 1 from public.looking_back_packages
    where family_id = '82000000-0000-4000-8000-000000000020'
      and package_date = current_date and package_type = 'emotion_archive'
      and ((display_title = 'The funny ones' and tint = 'funny')
        or (display_title = 'Tiny troublemakers' and tint = 'mischief'))
  ),
  'the rotating emotion package title and tint agree on the selected label'
);
select ok(
  not exists (
    select 1
    from public.looking_back_package_memories i
    join public.looking_back_packages p on p.id = i.package_id
    join public.memories m on m.id = i.memory_id
    where p.family_id = '82000000-0000-4000-8000-000000000020'
      and p.package_date = current_date and p.package_type = 'emotion_archive'
      and m.emotion is distinct from p.tint
  ),
  'the rotating emotion package selects only memories with its chosen exact label'
);

select set_config('request.jwt.claim.sub', '81000000-0000-4000-8000-000000000001', true);

select lives_ok(
  $$select * from public.get_or_create_looking_back_packages('82000000-0000-4000-8000-000000000001')$$,
  'an active owner can materialize its exact family daily set'
);
select ok(
  (select count(*) from public.get_or_create_looking_back_packages('82000000-0000-4000-8000-000000000001')) between 1 and 4,
  'the RPC returns between the empty sentinel and four packages'
);
select cmp_ok(
  (select count(*) from public.looking_back_packages where family_id = '82000000-0000-4000-8000-000000000001'),
  '<=', 4::bigint,
  'daily inventory is capped at four packages'
);
select ok(
  not exists (
    select 1
    from public.looking_back_packages p
    left join public.looking_back_package_memories i on i.package_id = p.id
    where p.family_id = '82000000-0000-4000-8000-000000000001'
    group by p.id
    having count(i.memory_id) not between 4 and 10
  ),
  'every non-empty package contains four through ten memories'
);
select ok(
  not exists (
    select memory_id
    from public.looking_back_package_memories
    where family_id = '82000000-0000-4000-8000-000000000001'
    group by memory_id having count(*) > 1
  ),
  'a memory cannot overlap two packages in one materialized day'
);
select is(
  (select count(*) from public.looking_back_daily_sets where family_id = '82000000-0000-4000-8000-000000000001'),
  1::bigint,
  'repeated calls share one materialization sentinel (the concurrency uniqueness boundary)'
);

select is(
  (select timezone_name from public.looking_back_daily_sets where family_id = '82000000-0000-4000-8000-000000000001'),
  'America/New_York',
  'owner timezone is snapshotted on the daily set'
);
select is(
  (select refresh_after from public.looking_back_daily_sets where family_id = '82000000-0000-4000-8000-000000000001'),
  (((select package_date from public.looking_back_daily_sets where family_id = '82000000-0000-4000-8000-000000000001') + 1)::timestamp at time zone 'America/New_York'),
  'refresh boundary is next local midnight, not a fixed 24-hour interval'
);
select is(
  ((date '2028-03-12' + 1)::timestamp at time zone 'America/New_York') - (date '2028-03-12'::timestamp at time zone 'America/New_York'),
  interval '23 hours',
  'DST spring-forward boundary is calculated from local midnights'
);
select is(
  ((date '2028-11-05' + 1)::timestamp at time zone 'America/New_York') - (date '2028-11-05'::timestamp at time zone 'America/New_York'),
  interval '25 hours',
  'DST fall-back boundary is calculated from local midnights'
);

update public.user_profiles set timezone = 'UTC'
where id = '81000000-0000-4000-8000-000000000001';
select is(
  (select timezone_name from public.looking_back_daily_sets where family_id = '82000000-0000-4000-8000-000000000001'),
  'America/New_York',
  'an owner timezone change never mutates the already materialized day'
);

select ok(
  not exists (
    select 1
    from public.looking_back_packages p
    where p.family_id = '82000000-0000-4000-8000-000000000001'
      and p.signature <> encode(extensions.digest(
        p.package_type || ':' || p.recipe_identity || ':' || coalesce((
          select array_to_string(array_agg(memory_id order by memory_id), ',')
          from public.looking_back_package_memories i where i.package_id = p.id
        ), ''), 'sha256'), 'hex')
  ),
  'stored signature is computed from the final, de-overlapped item set'
);
select set_config('request.jwt.claim.sub', '81000000-0000-4000-8000-000000000007', true);
select lives_ok(
  $$select * from public.get_or_create_looking_back_packages('82000000-0000-4000-8000-000000000004')$$,
  'the memory-cooldown fixture materializes a current set'
);
select is(
  (select display_title from public.looking_back_packages
   where family_id = '82000000-0000-4000-8000-000000000004'
     and package_date = current_date
     and package_type = 'archive_mix'),
  'A little look back',
  'archive mixes use the calm rediscovery title'
);
select ok(
  not exists (
    select 1
    from public.looking_back_package_memories current_item
    join public.looking_back_package_memories exposed_item
      on exposed_item.memory_id = current_item.memory_id
    join public.looking_back_packages current_package on current_package.id = current_item.package_id
    where current_package.family_id = '82000000-0000-4000-8000-000000000004'
      and current_package.package_date = current_date
      and exposed_item.package_id = '87200000-0000-4000-8000-000000000001'
  ),
  'a memory exposed in the previous seven days is hard-excluded from today'
);

select set_config('request.jwt.claim.sub', '81000000-0000-4000-8000-000000000008', true);
select is(
  (select package_id from public.get_or_create_looking_back_packages('82000000-0000-4000-8000-000000000005') limit 1),
  null::uuid,
  'the 14-day final-signature cooldown rejects the identical post-trim package after the memory cooldown expires'
);

select set_config('request.jwt.claim.sub', '81000000-0000-4000-8000-000000000009', true);
select ok(
  (select package_id from public.get_or_create_looking_back_packages('82000000-0000-4000-8000-000000000006') limit 1) is not null,
  'a recently exposed archive_mix identity is penalized, not hard-excluded when it is the viable candidate'
);
select is(
  (select count(*) from public.looking_back_packages
   where family_id = '82000000-0000-4000-8000-000000000006'
     and package_date = current_date
     and package_type = 'archive_mix'),
  1::bigint,
  'a viable archive mix gets a daily slot before lower-priority archive fallbacks'
);
select is(
  (select count(*) from public.looking_back_package_memories i
   join public.looking_back_packages p on p.id = i.package_id
   join public.memories m on m.id = i.memory_id
   where p.family_id = '82000000-0000-4000-8000-000000000006'
     and p.package_date = current_date
     and p.package_type = 'archive_mix'
     and m.memory_date > current_date - interval '18 months'),
  4::bigint,
  'the mixed archive takes four newer historical memories when the band is full'
);
select is(
  (select count(*) from public.looking_back_package_memories i
   join public.looking_back_packages p on p.id = i.package_id
   join public.memories m on m.id = i.memory_id
   where p.family_id = '82000000-0000-4000-8000-000000000006'
     and p.package_date = current_date
     and p.package_type = 'archive_mix'
     and m.memory_date > current_date - interval '36 months'
     and m.memory_date <= current_date - interval '18 months'),
  3::bigint,
  'the mixed archive takes three medium memories when the band is full'
);
select is(
  (select count(*) from public.looking_back_package_memories i
   join public.looking_back_packages p on p.id = i.package_id
   join public.memories m on m.id = i.memory_id
   where p.family_id = '82000000-0000-4000-8000-000000000006'
     and p.package_date = current_date
     and p.package_type = 'archive_mix'
     and m.memory_date <= current_date - interval '36 months'),
  3::bigint,
  'the mixed archive takes three deep memories when the band is full'
);

select set_config('request.jwt.claim.sub', '81000000-0000-4000-8000-000000000014', true);
select lives_ok(
  $$select * from public.get_or_create_looking_back_packages('82000000-0000-4000-8000-000000000014')$$,
  'a rejected archive mix releases exactly one fallback slot without exceeding four packages'
);
select is(
  (select count(*) from public.looking_back_packages
   where family_id = '82000000-0000-4000-8000-000000000014'
     and package_date = current_date),
  4::bigint,
  'the rejected archive mix still leaves a four-package daily set'
);
select is(
  (select count(*) from public.looking_back_packages
   where family_id = '82000000-0000-4000-8000-000000000014'
     and package_date = current_date
     and position = 4),
  0::bigint,
  'a rejected archive mix can never create position four'
);

select set_config('request.jwt.claim.sub', '81000000-0000-4000-8000-000000000015', true);
select lives_ok(
  $$select * from public.get_or_create_looking_back_packages('82000000-0000-4000-8000-000000000015')$$,
  'a selected archive mix releases its reservation for a valid fourth package'
);
select is(
  (select count(*) from public.looking_back_packages
   where family_id = '82000000-0000-4000-8000-000000000015'
     and package_date = current_date),
  4::bigint,
  'a viable archive mix does not suppress a fourth lower-priority package'
);
select ok(
  exists (select 1 from public.looking_back_packages
          where family_id = '82000000-0000-4000-8000-000000000015'
            and package_date = current_date and package_type = 'archive_mix')
  and exists (select 1 from public.looking_back_packages
              where family_id = '82000000-0000-4000-8000-000000000015'
                and package_date = current_date and package_type = 'written_archive'),
  'the released slot contains both the mixed archive and its lower fallback'
);

select set_config('request.jwt.claim.sub', '81000000-0000-4000-8000-000000000016', true);
select lives_ok(
  $$select * from public.get_or_create_looking_back_packages('82000000-0000-4000-8000-000000000016')$$,
  'a viable archive mix reserves the fourth slot ahead of a fourth thematic recipe'
);
select is(
  (select count(*) from public.looking_back_packages
   where family_id = '82000000-0000-4000-8000-000000000016'
     and package_date = current_date and package_type = 'archive_mix'),
  1::bigint,
  'the reserved slot materializes an archive mix even with four thematic candidates'
);
select is(
  (select position from public.looking_back_packages
   where family_id = '82000000-0000-4000-8000-000000000016'
     and package_date = current_date and package_type = 'archive_mix'),
  3::smallint,
  'the archive mix occupies the fourth position after three thematic packages'
);
select is(
  (select count(*) from public.looking_back_package_memories i
   join public.looking_back_packages p on p.id = i.package_id
   join public.memories m on m.id = i.memory_id
   where p.family_id = '82000000-0000-4000-8000-000000000016'
     and p.package_date = current_date and p.package_type = 'archive_mix'
     and m.memory_date <= current_date - interval '36 months'),
  3::bigint,
  'same-day de-overlap refills the deep archive quota from unselected deep memories'
);

select set_config('request.jwt.claim.sub', '81000000-0000-4000-8000-000000000013', true);
select count(*) from public.get_or_create_looking_back_packages('82000000-0000-4000-8000-000000000010');
select is(
  (select count(distinct package_type) from public.looking_back_packages
   where family_id = '82000000-0000-4000-8000-000000000010'
     and package_date = current_date),
  (select count(*) from public.looking_back_packages
   where family_id = '82000000-0000-4000-8000-000000000010'
     and package_date = current_date),
  'a daily set selects at most one candidate from each recipe type'
);
select is(
  (select subject_family_member_id from public.looking_back_packages
   where family_id = '82000000-0000-4000-8000-000000000010'
     and package_date = current_date
     and package_type = 'member_at_age'),
  '83000000-0000-4000-8000-000000000004'::uuid,
  'the age candidate rotates away from a recently featured member when another is eligible'
);
select is(
  (select display_title from public.looking_back_packages
   where family_id = '82000000-0000-4000-8000-000000000010'
     and package_date = current_date
     and package_type = 'member_at_age'),
  'From Child B''s first year',
  'age-zero packages use first-year copy'
);

select set_config('request.jwt.claim.sub', '81000000-0000-4000-8000-000000000010', true);
select count(*) from public.get_or_create_looking_back_packages('82000000-0000-4000-8000-000000000007');
select is(
  (select timezone_name from public.looking_back_daily_sets where family_id = '82000000-0000-4000-8000-000000000007'),
  'UTC',
  'an invalid legacy owner timezone falls back to UTC before snapshotting'
);
select is(
  make_date(2027, 2, 1) + least(28, extract(day from (make_date(2027, 2, 1) + interval '1 month - 1 day'))::int - 1),
  date '2027-02-28',
  'the leap-day anniversary calculation normalizes a non-leap prior year to February 28'
);
select ok(
  (select count(*) from public.looking_back_packages
   where family_id = '82000000-0000-4000-8000-000000000007'
     and package_date = current_date
     and package_type = 'archive_mix') = 1
  and (select count(*) from public.looking_back_package_memories i
   join public.looking_back_packages p on p.id = i.package_id
   where p.family_id = '82000000-0000-4000-8000-000000000007'
     and p.package_date = current_date
     and p.package_type = 'archive_mix') = 4,
  'a mixed archive backfills missing age bands when only four newer/medium memories exist'
);

select set_config('request.jwt.claim.sub', '81000000-0000-4000-8000-000000000001', true);

select set_config('request.jwt.claim.sub', '81000000-0000-4000-8000-000000000003', true);
select is(
  (select count(*) from public.looking_back_daily_sets), 0::bigint,
  'an outsider cannot directly read daily-set rows'
);
select is(
  (select count(*) from public.looking_back_packages), 0::bigint,
  'an outsider cannot directly read package rows'
);
select is(
  (select count(*) from public.looking_back_package_memories), 0::bigint,
  'an outsider cannot directly read package item rows'
);
select is(
  (select count(*) from public.looking_back_package_views), 0::bigint,
  'an outsider cannot directly read personal package view rows'
);
select throws_ok(
  $$select public.mark_looking_back_package_viewed((select id from public.looking_back_packages limit 1), false)$$,
  'P0002', 'Package not found',
  'an outsider cannot create a personal view for another family package'
);

select set_config('request.jwt.claim.sub', '81000000-0000-4000-8000-000000000001', true);
select throws_ok(
  $$select * from public.get_or_create_looking_back_packages('82000000-0000-4000-8000-000000000002')$$,
  '42501', 'Not authorized for this family',
  'membership is checked inside the materialization definer RPC'
);
select throws_ok(
  $$insert into public.looking_back_daily_sets (family_id, package_date, timezone_name, refresh_after) values ('82000000-0000-4000-8000-000000000001', current_date + 1, 'UTC', now() + interval '1 day')$$,
  '42501', null,
  'authenticated clients cannot directly insert daily sets'
);
select throws_ok(
  $$insert into public.looking_back_packages (daily_set_id, family_id, package_date, package_type, display_kind, display_title, display_era, recipe_identity, signature, position) values ('00000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000001', current_date, 'archive_mix', 'x', 'x', 'x', 'x', repeat('a', 64), 0)$$,
  '42501', null,
  'authenticated clients cannot directly insert packages'
);
select throws_ok(
  $$insert into public.looking_back_package_memories (package_id, family_id, memory_id, position) values ('00000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000001', '84000000-0000-4000-8000-000000000001', 0)$$,
  '42501', null,
  'authenticated clients cannot directly insert package items'
);
select throws_ok(
  $$insert into public.looking_back_package_views (package_id, user_id) values ((select id from public.looking_back_packages limit 1), '81000000-0000-4000-8000-000000000001')$$,
  '42501', null,
  'authenticated clients cannot directly insert package views'
);
select throws_ok(
  $$update public.looking_back_packages set display_title = 'tampered' where id = (select id from public.looking_back_packages limit 1)$$,
  '42501', null,
  'authenticated clients cannot directly update packages'
);
select throws_ok(
  $$delete from public.looking_back_package_memories where package_id = (select id from public.looking_back_packages limit 1)$$,
  '42501', null,
  'authenticated clients cannot directly delete package items'
);
select throws_ok(
  $$delete from public.looking_back_package_views where package_id = (select id from public.looking_back_packages limit 1)$$,
  '42501', null,
  'authenticated clients cannot directly delete personal package views'
);
set local role postgres;
insert into public.looking_back_daily_sets (id, family_id, package_date, timezone_name, refresh_after, created_at)
values (
  '86000000-0000-4000-8000-000000000001',
  '82000000-0000-4000-8000-000000000001', current_date - 10, 'UTC', now() - interval '5 days', now() - interval '10 days'
);
insert into public.looking_back_packages (
  id, daily_set_id, family_id, package_date, package_type, display_kind,
  display_title, display_era, recipe_identity, signature, position
) values (
  '86000000-0000-4000-8000-000000000002',
  '86000000-0000-4000-8000-000000000001',
  '82000000-0000-4000-8000-000000000001', current_date - 10, 'archive_mix',
  'From your archive', 'Cross-family fixture', 'From your archive',
  'cross-family-fixture', repeat('a', 64), 0
);
select throws_ok(
  $$insert into public.looking_back_package_memories (package_id, family_id, memory_id, position) values ('86000000-0000-4000-8000-000000000002', '82000000-0000-4000-8000-000000000001', '85000000-0000-4000-8000-000000000001', 0)$$,
  '23503', null,
  'composite foreign keys reject cross-family package memory attachment'
);
select lives_ok(
  $$update public.looking_back_packages set tint = 'bittersweet' where id = '86000000-0000-4000-8000-000000000002'$$,
  'the package tint constraint accepts the current bittersweet emotion key'
);
select throws_ok(
  $$update public.looking_back_packages set tint = 'love' where id = '86000000-0000-4000-8000-000000000002'$$,
  '23514', null,
  'the package tint constraint rejects obsolete emotion keys'
);
set local role authenticated;

select is(
  (public.mark_looking_back_package_viewed((select id from public.looking_back_packages where family_id = '82000000-0000-4000-8000-000000000001' limit 1), false)).completed_at,
  null::timestamptz,
  'first-frame view creates an incomplete personal view row'
);
select ok(
  (public.mark_looking_back_package_viewed((select id from public.looking_back_packages where family_id = '82000000-0000-4000-8000-000000000001' limit 1), true)).completed_at is not null,
  'completion sets the personal completion timestamp'
);
select ok(
  (public.mark_looking_back_package_viewed((select id from public.looking_back_packages where family_id = '82000000-0000-4000-8000-000000000001' limit 1), false)).completed_at is not null,
  'a replay cannot clear completion'
);

select set_config('request.jwt.claim.sub', '81000000-0000-4000-8000-000000000002', true);
select lives_ok(
  $$select * from public.get_or_create_looking_back_packages('82000000-0000-4000-8000-000000000001')$$,
  'a viewer retains read-only archive access regardless of billing write access'
);
select is(
  (select count(*) from public.looking_back_package_views where user_id = '81000000-0000-4000-8000-000000000001'),
  0::bigint,
  'a viewer cannot read another account personal view state through RLS'
);

select set_config('request.jwt.claim.sub', '81000000-0000-4000-8000-000000000005', true);
select is(
  (select count(*) from public.get_or_create_looking_back_packages('82000000-0000-4000-8000-000000000003')),
  1::bigint,
  'a materialized empty day returns exactly one sentinel row'
);
set local role postgres;
insert into public.memories (family_id, user_id, content, memory_date, memory_type, illustration_status)
select '82000000-0000-4000-8000-000000000003', '81000000-0000-4000-8000-000000000005', 'late empty fixture ' || series, current_date - 500 - series, 'text_only', 'none'
from generate_series(1, 4) as series;
set local role authenticated;
select is(
  (select count(*) from public.get_or_create_looking_back_packages('82000000-0000-4000-8000-000000000003')),
  1::bigint,
  'an empty-day sentinel remains stable after later same-day inserts'
);
select is(
  (select package_id from public.get_or_create_looking_back_packages('82000000-0000-4000-8000-000000000003') limit 1),
  null::uuid,
  'the stable empty-day sentinel has no package id'
);

set local role postgres;
delete from public.memories
where id = (select memory_id from public.looking_back_package_memories limit 1);
select is(
  (select count(*) from public.looking_back_package_memories i left join public.memories m on m.id = i.memory_id where m.id is null),
  0::bigint,
  'deleting a memory cascades its package item rather than leaving a stale foreign key'
);
select is(
  (select count(*) from public.looking_back_daily_sets where family_id = '82000000-0000-4000-8000-000000000001'),
  2::bigint,
  'memory deletion does not rewrite the frozen daily set'
);

insert into public.family_members (id, family_id, user_id, name)
values
  ('83000000-0000-4000-8000-000000000002', '82000000-0000-4000-8000-000000000002', '81000000-0000-4000-8000-000000000004', 'Other child'),
  ('83000000-0000-4000-8000-000000000008', '82000000-0000-4000-8000-000000000002', '81000000-0000-4000-8000-000000000004', 'Other child high');
insert into public.looking_back_daily_sets (id, family_id, package_date, timezone_name, refresh_after, created_at)
values ('86100000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000001', current_date - 11, 'UTC', now() - interval '10 days', now() - interval '12 days');
select throws_ok(
  $$insert into public.looking_back_packages (daily_set_id, family_id, package_date, package_type, subject_family_member_id, display_kind, display_title, display_era, recipe_identity, signature, position) values ('86100000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000001', current_date - 11, 'member_at_age', '83000000-0000-4000-8000-000000000002', 'Looking back', 'Wrong child', 'From your archive', 'member_at_age:wrong', repeat('d', 64), 0)$$,
  '23503', null,
  'the member-at-age subject has a composite same-family foreign key'
);

insert into public.looking_back_daily_sets (id, family_id, package_date, timezone_name, refresh_after, created_at)
values ('a7000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000017', current_date - 30, 'UTC', now() - interval '29 days', now() - interval '30 days');
select throws_ok(
  $$insert into public.looking_back_packages (id, daily_set_id, family_id, package_date, package_type, subject_family_member_id, secondary_subject_family_member_id, display_kind, display_title, display_era, recipe_identity, signature, position) values ('a7000000-0000-4000-8000-000000000002', 'a7000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000017', current_date - 30, 'members_together', '83000000-0000-4000-8000-000000000006', '83000000-0000-4000-8000-000000000008', 'Together', 'Wrong family', 'From your archive', 'members_together:wrong-family', repeat('1', 64), 0)$$,
  '23503', null,
  'the togetherness secondary subject has a composite same-family foreign key'
);
select throws_ok(
  $$insert into public.looking_back_packages (id, daily_set_id, family_id, package_date, package_type, subject_family_member_id, secondary_subject_family_member_id, display_kind, display_title, display_era, recipe_identity, signature, position) values ('a7000000-0000-4000-8000-000000000003', 'a7000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000017', current_date - 30, 'members_together', '83000000-0000-4000-8000-000000000006', '83000000-0000-4000-8000-000000000006', 'Together', 'Same member', 'From your archive', 'members_together:same-member', repeat('2', 64), 0)$$,
  '23514', null,
  'the togetherness subject constraint rejects equal members'
);
select throws_ok(
  $$insert into public.looking_back_packages (id, daily_set_id, family_id, package_date, package_type, subject_family_member_id, secondary_subject_family_member_id, display_kind, display_title, display_era, recipe_identity, signature, position) values ('a7000000-0000-4000-8000-000000000004', 'a7000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000017', current_date - 30, 'members_together', '83000000-0000-4000-8000-000000000007', '83000000-0000-4000-8000-000000000006', 'Together', 'Reversed pair', 'From your archive', 'members_together:reversed', repeat('3', 64), 0)$$,
  '23514', null,
  'the togetherness subject constraint rejects reversed canonical pairs'
);
insert into public.looking_back_packages (id, daily_set_id, family_id, package_date, package_type, subject_family_member_id, secondary_subject_family_member_id, display_kind, display_title, display_era, recipe_identity, signature, position)
values ('a7000000-0000-4000-8000-000000000005', 'a7000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000017', current_date - 30, 'members_together', '83000000-0000-4000-8000-000000000006', '83000000-0000-4000-8000-000000000007', 'Together', 'Cascade pair', 'From your archive', 'members_together:cascade', repeat('4', 64), 0);
delete from public.family_members where id = '83000000-0000-4000-8000-000000000007';
select is(
  (select count(*) from public.looking_back_packages where id = 'a7000000-0000-4000-8000-000000000005'),
  0::bigint,
  'deleting a togetherness subject cascades the derived package'
);

insert into public.looking_back_daily_sets (id, family_id, package_date, timezone_name, refresh_after, created_at)
values ('86300000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000002', current_date - 11, 'UTC', now() - interval '10 days', now() - interval '12 days');
insert into public.looking_back_packages (id, daily_set_id, family_id, package_date, package_type, subject_family_member_id, display_kind, display_title, display_era, recipe_identity, signature, position)
values ('86300000-0000-4000-8000-000000000002', '86300000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000002', current_date - 11, 'member_at_age', '83000000-0000-4000-8000-000000000002', 'Looking back', 'Child deletion', 'From your archive', 'member_at_age:deletion', repeat('f', 64), 0);
delete from public.family_members where id = '83000000-0000-4000-8000-000000000002';
select is(
  (select count(*) from public.looking_back_packages where id = '86300000-0000-4000-8000-000000000002'),
  0::bigint,
  'deleting a child cascades its derived member-at-age package instead of blocking profile deletion'
);

delete from public.families where id = '82000000-0000-4000-8000-000000000007';
select is(
  (select count(*) from public.looking_back_packages where family_id = '82000000-0000-4000-8000-000000000007'),
  0::bigint,
  'family deletion cascades its materialized packages and package items'
);

insert into public.looking_back_daily_sets (id, family_id, package_date, timezone_name, refresh_after, created_at)
values ('86200000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000008', current_date - 12, 'UTC', now() - interval '11 days', now() - interval '13 days');
insert into public.looking_back_packages (id, daily_set_id, family_id, package_date, package_type, display_kind, display_title, display_era, recipe_identity, signature, position)
values ('86200000-0000-4000-8000-000000000002', '86200000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000008', current_date - 12, 'archive_mix', 'From your archive', 'Account cascade', 'From your archive', 'account-cascade', repeat('e', 64), 0);
insert into public.looking_back_package_views (package_id, user_id)
values ('86200000-0000-4000-8000-000000000002', '81000000-0000-4000-8000-000000000011');
delete from auth.users where id = '81000000-0000-4000-8000-000000000011';
select is(
  (select count(*) from public.looking_back_packages where id = '86200000-0000-4000-8000-000000000002')
  + (select count(*) from public.looking_back_package_views where package_id = '86200000-0000-4000-8000-000000000002'),
  0::bigint,
  'account deletion cascades the owned family package and its personal view rows'
);

set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select ok(
  not has_function_privilege('anon', 'public.get_or_create_looking_back_packages(uuid)', 'EXECUTE'),
  'anonymous callers have no materialization RPC privilege'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '81000000-0000-4000-8000-000000000006', true);
select throws_ok(
  $$select * from public.get_or_create_looking_back_packages('82000000-0000-4000-8000-000000000001')$$,
  '28000', 'Authentication required',
  'an authenticated anonymous session is rejected even if a malformed row grants membership'
);

select * from finish();
rollback;
