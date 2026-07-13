-- Wire up the daily trigger for the hard-delete-expired-accounts Edge Function
-- (TECH_SPEC §4.9). The function was deployed but nothing invoked it, so
-- accounts past their 15-day grace period were never hard-deleted. pg_cron
-- calls it once a day at 03:00 UTC; the function itself finds every user with
-- scheduled_hard_delete_at <= now(), so exact run time doesn't matter.
--
-- No secrets live in this file. The job reads the same two Vault secrets as
-- invoke-schedule-daily-reminders (20260713170000), created once per
-- environment (Dashboard > Project Settings > Vault, or
-- `select vault.create_secret(...)`):
--   project_url  -- e.g. https://<project-ref>.supabase.co
--   cron_secret  -- same value as the CRON_SECRET Edge Function secret
-- Until both exist, each run fails visibly in cron.job_run_details without
-- affecting anything else.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'invoke-hard-delete-expired-accounts',
  '0 3 * * *',
  $$
  select net.http_post(
    url := (
      select decrypted_secret from vault.decrypted_secrets where name = 'project_url'
    ) || '/functions/v1/hard-delete-expired-accounts',
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
