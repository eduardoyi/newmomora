-- Owner-only archive exports. The export worker creates short-lived rows here
-- and streams the current database manifest plus the referenced private R2
-- objects. No export bytes or public object URLs are persisted.

create table public.export_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users on delete cascade,
  status text not null default 'ready'
    check (status in ('ready', 'expired', 'failed')),
  expires_at timestamptz not null default now() + interval '1 hour',
  family_count integer not null default 0 check (family_count >= 0),
  asset_count integer not null default 0 check (asset_count >= 0),
  last_accessed_at timestamptz,
  created_at timestamptz not null default now()
);

create index export_jobs_owner_created_idx
  on public.export_jobs (owner_user_id, created_at desc);
create index export_jobs_expiry_idx
  on public.export_jobs (expires_at)
  where status = 'ready';

alter table public.export_jobs enable row level security;

create policy "Export jobs: owners can view their jobs"
  on public.export_jobs for select
  using (owner_user_id = auth.uid());

revoke all on public.export_jobs from anon, authenticated;
grant select on public.export_jobs to authenticated;

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
  set status = 'expired'
  where status = 'ready' and expires_at <= p_now;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.expire_export_jobs(timestamptz) from public, anon, authenticated;
grant execute on function public.expire_export_jobs(timestamptz) to service_role;
