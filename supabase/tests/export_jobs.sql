begin;

-- Emailed export jobs (docs/features/data-export.md): start_export_job
-- dedupes an in-flight build, rate limits per rolling day, and
-- expire_export_jobs only fails stuck builds (ready -> expired belongs to
-- the export Worker's cleanup cron).
select plan(9);

insert into auth.users (id, email, is_anonymous) values
  ('e7000000-0000-4000-8000-000000000001', 'export-owner@example.test', false),
  ('e7000000-0000-4000-8000-000000000002', 'export-other@example.test', false);

select is(
  (select already_running from public.start_export_job('e7000000-0000-4000-8000-000000000001', 1)),
  false,
  'the first request starts a new job'
);

select is(
  (select status from public.export_jobs where owner_user_id = 'e7000000-0000-4000-8000-000000000001'),
  'queued',
  'a new job starts queued'
);

select is(
  (select already_running from public.start_export_job('e7000000-0000-4000-8000-000000000001', 1)),
  true,
  'a second request while one is queued returns the running job'
);

select is(
  (select count(*)::int from public.export_jobs where owner_user_id = 'e7000000-0000-4000-8000-000000000001'),
  1,
  'no duplicate job is created for an in-flight export'
);

-- Finish it, then use up the rolling-day allowance.
update public.export_jobs set status = 'ready' where owner_user_id = 'e7000000-0000-4000-8000-000000000001';
select public.start_export_job('e7000000-0000-4000-8000-000000000001', 1);
update public.export_jobs set status = 'ready' where owner_user_id = 'e7000000-0000-4000-8000-000000000001';
select public.start_export_job('e7000000-0000-4000-8000-000000000001', 1);
update public.export_jobs set status = 'ready' where owner_user_id = 'e7000000-0000-4000-8000-000000000001';

select throws_ok(
  $$select public.start_export_job('e7000000-0000-4000-8000-000000000001', 1)$$,
  'P0001', 'export_rate_limited',
  'a fourth export within 24 hours is rate limited'
);

-- A stuck build past its deadline is failed by expire_export_jobs and no
-- longer blocks the owner.
select public.start_export_job('e7000000-0000-4000-8000-000000000002', 1);
update public.export_jobs set status = 'building', expires_at = now() - interval '1 minute'
where owner_user_id = 'e7000000-0000-4000-8000-000000000002';

select is(public.expire_export_jobs(), 1, 'expire_export_jobs fails one stuck build');

select is(
  (select failure_code from public.export_jobs where owner_user_id = 'e7000000-0000-4000-8000-000000000002'),
  'build_timeout',
  'the stuck build is marked build_timeout'
);

select is(
  (select already_running from public.start_export_job('e7000000-0000-4000-8000-000000000002', 1)),
  false,
  'after a failed build the owner can start a new export'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'e7000000-0000-4000-8000-000000000002', true);

select throws_ok(
  $$select public.start_export_job('e7000000-0000-4000-8000-000000000002', 1)$$,
  '42501', null,
  'clients cannot call start_export_job directly'
);

select * from finish();
rollback;
