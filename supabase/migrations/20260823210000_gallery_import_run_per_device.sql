-- Continuous model follow-up (device-observed 2026-08-23): a sweep's run now
-- stays 'reviewing' for as long as its review window keeps extending, and a
-- run is device-bound -- so the old one-active-run-per-family rule locked
-- every OTHER family device out of starting its own sweep ("Momora has
-- reached its limit for now" on a second phone). Allow a small number of
-- concurrent device-bound runs per family instead. Cost stays bounded by the
-- family-wide rolling daily cluster cap (register_gallery_import_chunk), not
-- by run count.

drop index if exists public.gallery_import_one_active_run_per_family;
-- Same partial predicate, non-unique: keeps the create RPC's count query and
-- the cleanup/digest scans cheap.
create index gallery_import_active_runs_per_family
  on public.gallery_import_runs (family_id)
  where status in ('scanning', 'processing', 'reviewing');

create or replace function public.create_gallery_import_run_internal(
  p_family_id uuid,
  p_capability text,
  p_algorithm_version text,
  p_consent_version text,
  p_permission_mode text
)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_settings public.gallery_import_admission_settings%rowtype; v_run_id uuid; v_active integer; v_now timestamptz := transaction_timestamp();
begin
  if auth.uid() is null then raise exception 'Unauthorized' using errcode = '28000'; end if;
  if public.is_anonymous_user() or not public.has_family_role(p_family_id, array['owner','manager']) then raise exception 'Not authorized' using errcode = '42501'; end if;
  if not public.billing_write_allowed(p_family_id, auth.uid()) then raise exception 'Subscription required' using errcode = 'P0001'; end if;
  if p_capability is null or char_length(p_capability) < 32 or char_length(p_capability) > 512 then raise exception 'Invalid import capability' using errcode = '22023'; end if;
  select * into v_settings from public.gallery_import_admission_settings where singleton for share;
  if not v_settings.enabled then raise exception 'Gallery import is not available' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtextextended('gallery-import:' || p_family_id::text, 0));
  -- One sweep per device; runs are device-bound, so cap the number of
  -- concurrently active runs rather than forbidding a second device
  -- outright. 4 covers a two-parent household with a spare phone each.
  select count(*) into v_active from public.gallery_import_runs where family_id = p_family_id and status in ('scanning','processing','reviewing');
  if v_active >= 4 then raise exception 'A gallery import is already active' using errcode = 'P0001'; end if;
  insert into public.gallery_import_runs (family_id, actor_id, capability_hash, algorithm_version, consent_version, permission_mode, limit_snapshot, policy_epoch, expires_at)
  values (p_family_id, auth.uid(), encode(extensions.digest(p_capability, 'sha256'), 'hex'), p_algorithm_version, p_consent_version, p_permission_mode, v_settings.limit_template, v_settings.policy_epoch, v_now + v_settings.review_ttl)
  returning id into v_run_id;
  return v_run_id;
end;
$$;
