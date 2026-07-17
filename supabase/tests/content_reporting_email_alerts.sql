begin;

select plan(19);

insert into auth.users (id, email)
values
  ('12000000-0000-4000-8000-000000000001', 'report-alert-reporter@example.test'),
  ('12000000-0000-4000-8000-000000000002', 'report-alert-target@example.test');

insert into public.families (id, name, owner_id)
values (
  '22000000-0000-4000-8000-000000000001',
  'Report alert test family',
  '12000000-0000-4000-8000-000000000001'
);

insert into public.family_memberships (id, family_id, user_id, role)
values
  (
    '32000000-0000-4000-8000-000000000001',
    '22000000-0000-4000-8000-000000000001',
    '12000000-0000-4000-8000-000000000001',
    'owner'
  ),
  (
    '32000000-0000-4000-8000-000000000002',
    '22000000-0000-4000-8000-000000000001',
    '12000000-0000-4000-8000-000000000002',
    'viewer'
  );

insert into public.memories (id, family_id, user_id, content, memory_type)
values (
  '42000000-0000-4000-8000-000000000001',
  '22000000-0000-4000-8000-000000000001',
  '12000000-0000-4000-8000-000000000002',
  'Alert target memory',
  'text_only'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '12000000-0000-4000-8000-000000000001', true);

create temporary table filed_report as
select public.create_content_report(
  'memory',
  '42000000-0000-4000-8000-000000000001',
  'privacy',
  'operator must not receive this note in email',
  null
) as id;

select ok(
  (select id is not null from filed_report),
  'filing a report succeeds even when alert delivery is asynchronous'
);

select ok(
  position(
    'jsonb_build_object(''reportId'', new.id)'
    in pg_get_functiondef('public.enqueue_content_report_email_alert()'::regprocedure)
  ) > 0,
  'the trigger payload contains only the report id, never report metadata'
);

set local role postgres;

select is(
  (select status from public.content_report_email_alerts where report_id = (select id from filed_report)),
  'pending'::text,
  'the insert trigger durably records a pending alert before delivery'
);

select ok(
  not has_table_privilege('authenticated', 'public.content_report_email_alerts', 'select'),
  'authenticated users cannot read the private alert outbox'
);

select ok(
  has_function_privilege('service_role', 'public.claim_content_report_email_alert(uuid)', 'execute'),
  'only the service role can claim an alert for delivery'
);

select ok(
  not has_function_privilege('authenticated', 'public.claim_content_report_email_alert(uuid)', 'execute'),
  'authenticated users cannot claim an alert for delivery'
);

create temporary table first_claim as
select * from public.claim_content_report_email_alert((select id from filed_report));

select is(
  (select count(*) from first_claim),
  1::bigint,
  'a pending alert can be claimed exactly once'
);

select is(
  (select status from public.content_report_email_alerts where report_id = (select id from filed_report)),
  'sending'::text,
  'claiming moves the outbox row into sending'
);

select is(
  (select count(*) from public.claim_content_report_email_alert((select id from filed_report))),
  0::bigint,
  'a concurrent or retried endpoint call cannot claim a sending row'
);

select ok(
  not public.mark_content_report_email_alert_sent(
    (select id from filed_report),
    '99999999-9999-4999-8999-999999999999'
  ),
  'the wrong attempt token cannot complete an alert'
);

select ok(
  public.release_content_report_email_alert(
    (select id from filed_report),
    (select attempt_token from first_claim)
  ),
  'a known send failure releases the claim for retry'
);

create temporary table retry_claim as
select * from public.claim_content_report_email_alert((select id from filed_report));

select ok(
  public.mark_content_report_email_alert_sent(
    (select id from filed_report),
    (select attempt_token from retry_claim)
  ),
  'a successful retry marks the alert sent'
);

select is(
  (select status from public.content_report_email_alerts where report_id = (select id from filed_report)),
  'sent'::text,
  'a completed alert cannot be sent by a later endpoint retry'
);

update public.content_report_email_alerts
set status = 'pending', sent_at = null, attempt_count = 0, last_attempt_at = null
where report_id = (select id from filed_report);

select is(
  (select count(*) from public.get_content_report_email_alert_redrive_candidates(20)),
  1::bigint,
  'a new pending alert is eligible for the bounded redrive job'
);

update public.content_report_email_alerts
set attempt_count = 1, last_attempt_at = now()
where report_id = (select id from filed_report);

select is(
  (select count(*) from public.get_content_report_email_alert_redrive_candidates(20)),
  0::bigint,
  'a recently rejected alert observes the first five-minute backoff'
);

update public.content_report_email_alerts
set last_attempt_at = now() - interval '6 minutes'
where report_id = (select id from filed_report);

select is(
  (select count(*) from public.get_content_report_email_alert_redrive_candidates(20)),
  1::bigint,
  'an alert becomes eligible after its current backoff expires'
);

update public.content_report_email_alerts
set attempt_count = 5, last_attempt_at = now() - interval '7 hours'
where report_id = (select id from filed_report);

select is(
  (select count(*) from public.get_content_report_email_alert_redrive_candidates(20)),
  0::bigint,
  'the automatic redrive cap excludes an alert after five attempts'
);

select ok(
  not has_function_privilege('authenticated', 'public.enqueue_content_report_email_alert()', 'execute'),
  'the security-definer trigger function is not externally executable'
);

select ok(
  exists (
    select 1 from cron.job
    where jobname = 'redrive-content-report-email-alerts'
      and schedule = '*/5 * * * *'
  ),
  'the bounded redrive job is scheduled every five minutes'
);

select * from finish();
rollback;
