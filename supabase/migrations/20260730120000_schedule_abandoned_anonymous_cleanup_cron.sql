-- Wire up the daily trigger for the cleanup-abandoned-anonymous-users Edge
-- Function (TECH_SPEC §4.17, WP-SEC item 5,
-- docs/plans/onboarding-implementation.md). The function and its
-- get_abandoned_anonymous_auth_user_ids RPC
-- (20260729150000_abandoned_anonymous_cleanup.sql) were deployed but nothing
-- invoked either, so since enable_anonymous_sign_ins went true
-- (20260729130000), every abandoned pre-auth session leaves a permanent,
-- never-reaped auth.users row. pg_cron calls it once a day at 04:00 UTC; a
-- daily cadence is sufficient given the 7-day ABANDONED_ANONYMOUS_USER_TTL_DAYS,
-- and 04:00 UTC is a free hour -- distinct from invoke-hard-delete-expired-
-- accounts' 03:00 UTC (20260713180000) and from run-ai-usage-alerts'
-- documented 06:00 UTC external schedule (docs/features/usage-limits.md);
-- invoke-schedule-daily-reminders (20260713170000) and
-- redrive-content-report-email-alerts (20260717130000) already run
-- continuously (hourly / every 5 minutes) rather than owning a specific hour.
--
-- No secrets live in this file. The job reads the same two Vault secrets as
-- the other cron jobs above, created once per environment (Dashboard >
-- Project Settings > Vault, or `select vault.create_secret(...)`):
--   project_url  -- e.g. https://<project-ref>.supabase.co
--   cron_secret  -- same value as the CRON_SECRET Edge Function secret
-- Until both exist, each run fails visibly in cron.job_run_details without
-- affecting anything else.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'invoke-cleanup-abandoned-anonymous-users',
  '0 4 * * *',
  $$
  select net.http_post(
    url := (
      select decrypted_secret from vault.decrypted_secrets where name = 'project_url'
    ) || '/functions/v1/cleanup-abandoned-anonymous-users',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (
        select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
