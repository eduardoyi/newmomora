-- Emailed, stored archive exports (docs/features/data-export.md).
--
-- The original flow streamed one ZIP to the phone and opened the share
-- sheet. Exports now run in the background: the export Worker's Workflow
-- builds one ZIP per family "Family & portraits" set and per memory year
-- (split further when a year passes the ZIP32-safe size), stores them
-- privately in R2 under exports/<job id>/, and emails the owner a 7-day
-- download link. This migration extends export_jobs for that lifecycle.
--
-- Lifecycle: queued -> building -> ready -> expired, or -> failed.
--   queued/building: the Workflow is running (at most one per owner).
--   ready: archives listed in `archives`, downloadable until expires_at
--          with the token whose SHA-256 is download_token_hash.
--   expired/failed: the Worker's daily cron has deleted (or never wrote)
--          the R2 objects.

alter table public.export_jobs drop constraint export_jobs_status_check;
alter table public.export_jobs
  add constraint export_jobs_status_check
  check (status in ('queued', 'building', 'ready', 'expired', 'failed'));

alter table public.export_jobs
  add column archives jsonb not null default '[]'::jsonb,
  add column total_bytes bigint not null default 0 check (total_bytes >= 0),
  add column download_token_hash text,
  add column started_at timestamptz,
  add column completed_at timestamptz,
  add column failure_code text,
  add column email_sent_at timestamptz,
  add column files_deleted_at timestamptz;

-- The daily cleanup sweep: finished jobs whose files still exist.
create index export_jobs_cleanup_idx
  on public.export_jobs (expires_at)
  where files_deleted_at is null;

-- Replaces create_export_job. Starting an export while one is already
-- queued/building returns that job with already_running = true instead of
-- starting a second Workflow (the owner just gets the one email). Otherwise
-- at most p_max_per_day jobs per rolling 24h, which bounds R2 write and
-- storage cost for a heavy archive.
drop function if exists public.create_export_job(uuid, integer, integer);

create function public.start_export_job(
  p_owner_user_id uuid,
  p_family_count integer,
  p_max_per_day integer default 3
)
returns table (job_id uuid, status text, already_running boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.export_jobs%rowtype;
  v_job public.export_jobs%rowtype;
begin
  if p_owner_user_id is null or p_family_count is null or p_family_count < 0 then
    raise exception 'Invalid export job' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_owner_user_id::text, 0));

  select * into v_existing
  from public.export_jobs j
  where j.owner_user_id = p_owner_user_id
    and j.status in ('queued', 'building')
    -- A job stuck past its build deadline (expires_at while queued/building)
    -- no longer blocks a fresh request.
    and j.expires_at > transaction_timestamp()
  order by j.created_at desc
  limit 1;

  if found then
    return query select v_existing.id, v_existing.status, true;
    return;
  end if;

  if (
    select count(*)
    from public.export_jobs j
    where j.owner_user_id = p_owner_user_id
      and j.created_at > transaction_timestamp() - interval '24 hours'
      and j.status <> 'failed'
  ) >= greatest(1, least(coalesce(p_max_per_day, 3), 10)) then
    raise exception 'export_rate_limited' using errcode = 'P0001';
  end if;

  insert into public.export_jobs (owner_user_id, family_count, status, expires_at)
  values (p_owner_user_id, p_family_count, 'queued', transaction_timestamp() + interval '1 day')
  returning * into v_job;

  return query select v_job.id, v_job.status, false;
end;
$$;

revoke all on function public.start_export_job(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.start_export_job(uuid, integer, integer) to service_role;

-- Still called by process-billing-webhooks' sweep. Ready -> expired now
-- belongs to the Worker's cleanup cron (it must delete the R2 objects
-- first), so this only fails builds that blew past their 1-day deadline;
-- the cron then deletes any partial files they left behind.
create or replace function public.expire_export_jobs(
  p_now timestamptz default transaction_timestamp()
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.export_jobs
  set status = 'failed', failure_code = coalesce(failure_code, 'build_timeout')
  where status in ('queued', 'building') and expires_at <= p_now;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
