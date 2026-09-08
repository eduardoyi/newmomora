-- Memory Book 5c: schedule the order reconciliation sweep
-- (docs/features/memory-book-orders.md §Sweep; mirrors
-- 20260713170000_schedule_daily_reminders_cron.sql's pattern exactly).
--
-- Every 10 minutes: redispatches paid orders with no live workflow past
-- the grace window (zero-dispatch recovery), polls Prodigi for open
-- submitted/in_production orders and advances their states (tracking
-- email on shipped), ages abandoned quoted orders to cancelled, and
-- raises the not-in-production / stuck alarms. Idempotent and cheap when
-- there is nothing to do, so the short interval costs nothing and bounds
-- how long a stranded paid order can go unnoticed.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'invoke-sweep-memory-book-orders',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := (
      select decrypted_secret from vault.decrypted_secrets where name = 'project_url'
    ) || '/functions/v1/sweep-memory-book-orders',
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
