-- Best-effort, metadata-only operator alerts for newly filed content reports.
--
-- The outbox is deliberately durable: filing a report never depends on Vault,
-- pg_net, Bento, or the Edge Function being available. The trigger records a
-- pending alert first, then attempts the asynchronous request. The function
-- claims one row atomically before contacting Bento so ordinary retries do not
-- send duplicate messages.

create extension if not exists pg_net;

create table public.content_report_email_alerts (
  report_id uuid primary key references public.content_reports(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent')),
  attempt_token uuid,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_attempt_at timestamptz,
  sent_at timestamptz,
  check (
    (status = 'sent' and sent_at is not null and attempt_token is null)
    or
    (status = 'sending' and attempt_token is not null and sent_at is null)
    or
    (status = 'pending' and attempt_token is null and sent_at is null)
  )
);

alter table public.content_report_email_alerts enable row level security;
revoke all on public.content_report_email_alerts from anon, authenticated;

create function public.claim_content_report_email_alert(p_report_id uuid)
returns table (report_id uuid, attempt_token uuid)
language plpgsql
security definer
set search_path = public
as $$
begin
  -- A sending row is intentionally not reclaimed automatically. If a process
  -- dies after Bento accepts a message, guessing that it was safe to retry
  -- could duplicate an operator notification. Known failures are explicitly
  -- released below; an operator can inspect Bento before manually redriving a
  -- genuinely stuck row.
  return query
  update public.content_report_email_alerts alert
  set
    status = 'sending',
    attempt_token = gen_random_uuid(),
    attempt_count = alert.attempt_count + 1,
    last_attempt_at = now()
  where alert.report_id = p_report_id
    and alert.status = 'pending'
  returning alert.report_id, alert.attempt_token;
end;
$$;

create function public.mark_content_report_email_alert_sent(
  p_report_id uuid,
  p_attempt_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_count integer;
begin
  update public.content_report_email_alerts
  set
    status = 'sent',
    attempt_token = null,
    sent_at = now()
  where report_id = p_report_id
    and status = 'sending'
    and attempt_token = p_attempt_token;
  get diagnostics updated_count = row_count;
  return updated_count = 1;
end;
$$;

create function public.release_content_report_email_alert(
  p_report_id uuid,
  p_attempt_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_count integer;
begin
  update public.content_report_email_alerts
  set
    status = 'pending',
    attempt_token = null
  where report_id = p_report_id
    and status = 'sending'
    and attempt_token = p_attempt_token;
  get diagnostics updated_count = row_count;
  return updated_count = 1;
end;
$$;

revoke all on function public.claim_content_report_email_alert(uuid) from public;
revoke all on function public.mark_content_report_email_alert_sent(uuid, uuid) from public;
revoke all on function public.release_content_report_email_alert(uuid, uuid) from public;
revoke all on function public.claim_content_report_email_alert(uuid) from anon, authenticated;
revoke all on function public.mark_content_report_email_alert_sent(uuid, uuid) from anon, authenticated;
revoke all on function public.release_content_report_email_alert(uuid, uuid) from anon, authenticated;
grant execute on function public.claim_content_report_email_alert(uuid) to service_role;
grant execute on function public.mark_content_report_email_alert_sent(uuid, uuid) to service_role;
grant execute on function public.release_content_report_email_alert(uuid, uuid) to service_role;

create function public.enqueue_content_report_email_alert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.content_report_email_alerts (report_id)
  values (new.id);

  -- pg_net queues an asynchronous request. Missing Vault configuration or a
  -- pg_net outage must never roll back the report itself; the durable pending
  -- row remains available for a later redrive.
  begin
    perform net.http_post(
      url := (
        select decrypted_secret from vault.decrypted_secrets where name = 'project_url'
      ) || '/functions/v1/send-content-report-alert',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (
          select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'
        )
      ),
      body := jsonb_build_object('reportId', new.id),
      timeout_milliseconds := 20000
    );
  exception when others then
    raise warning 'content-report email alert enqueue failed';
  end;

  return new;
end;
$$;

create trigger enqueue_content_report_email_alert
  after insert on public.content_reports
  for each row execute function public.enqueue_content_report_email_alert();
