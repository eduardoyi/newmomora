-- Wire up the hourly trigger for the schedule-daily-reminders Edge Function
-- (TECH_SPEC §4.6). The function was deployed but nothing invoked it, so
-- daily journal reminders never fired. pg_cron calls it at minute 0 of every
-- hour -- it only sends within the first 5 minutes of a user's target hour
-- (see parseNotificationHour / the localMinute > 5 guard in the function).
--
-- No secrets live in this file. The job reads two Vault secrets at run time,
-- which must be created once per environment (Dashboard > Project Settings >
-- Vault, or `select vault.create_secret(...)`):
--   project_url  -- e.g. https://<project-ref>.supabase.co
--   cron_secret  -- same value as the CRON_SECRET Edge Function secret
-- Until both exist, each run fails visibly in cron.job_run_details without
-- affecting anything else.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'invoke-schedule-daily-reminders',
  '0 * * * *',
  $$
  select net.http_post(
    url := (
      select decrypted_secret from vault.decrypted_secrets where name = 'project_url'
    ) || '/functions/v1/schedule-daily-reminders',
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
