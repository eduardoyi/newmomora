-- Hourly trigger for the schedule-year-films Edge Function
-- (docs/plans/year-film-p1.md Step 3). Minute 5 of every hour; the function
-- decides what is due in each owner's timezone (00:30 local, 3-day catch-up)
-- and is a no-op while year_film_settings.mode = 'off'.
--
-- Same Vault secrets as the other pg_cron jobs (project_url, cron_secret);
-- until both exist each run fails visibly in cron.job_run_details.

select cron.schedule(
  'invoke-schedule-year-films',
  '5 * * * *',
  $$
  select net.http_post(
    url := (
      select decrypted_secret from vault.decrypted_secrets where name = 'project_url'
    ) || '/functions/v1/schedule-year-films',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (
        select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
