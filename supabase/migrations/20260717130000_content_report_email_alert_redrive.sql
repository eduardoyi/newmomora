-- Bounded redrive for definitely-unsent content-report operator alerts.
--
-- This never touches `sending` rows: a timeout or lost provider response can
-- be ambiguous, so those require deliberate Bento reconciliation rather than
-- an automatic duplicate. The original report transaction remains independent
-- of this job and of every pg_net request it creates.

create or replace function public.get_content_report_email_alert_redrive_candidates(
  p_limit integer default 20
)
returns table (report_id uuid)
language sql
security definer
set search_path = public
as $$
  select alert.report_id
  from public.content_report_email_alerts alert
  where alert.status = 'pending'
    and alert.attempt_count < 5
    and (
      alert.last_attempt_at is null
      or alert.last_attempt_at <= now() - case
        when alert.attempt_count <= 1 then interval '5 minutes'
        when alert.attempt_count = 2 then interval '15 minutes'
        when alert.attempt_count = 3 then interval '1 hour'
        else interval '6 hours'
      end
    )
  order by alert.last_attempt_at nulls first, alert.report_id
  limit greatest(1, least(coalesce(p_limit, 20), 20));
$$;

revoke all on function public.get_content_report_email_alert_redrive_candidates(integer) from public;
revoke all on function public.get_content_report_email_alert_redrive_candidates(integer) from anon, authenticated;
grant execute on function public.get_content_report_email_alert_redrive_candidates(integer) to service_role;

-- The trigger mechanism does not need an externally callable EXECUTE grant.
revoke all on function public.enqueue_content_report_email_alert() from public, anon, authenticated, service_role;

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'redrive-content-report-email-alerts',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := (
      select decrypted_secret from vault.decrypted_secrets where name = 'project_url'
    ) || '/functions/v1/send-content-report-alert',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (
        select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'
      )
    ),
    body := jsonb_build_object('reportId', candidate.report_id),
    timeout_milliseconds := 20000
  )
  from public.get_content_report_email_alert_redrive_candidates(20) candidate;
  $$
);
