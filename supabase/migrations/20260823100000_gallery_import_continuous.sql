-- Gallery import: continuous model + reliability + admission simplification.
--
-- See docs/plans/gallery-import-continuous.md workstream I1. This migration:
--   1. Widens the admission limit template so a single run can cover a whole
--      library sweep instead of a capped "batch", and replaces the
--      first-30-days/normal-monthly run cap with a rolling 24h per-family
--      cluster (fair-use) cap -- the continuous model has no notion of
--      separate "runs" a user starts repeatedly.
--   2. Extends the review TTL on activity so a family that keeps swiping
--      never has its own in-progress review window expire under it.
--   3. Closes two completion/publish races: a run could complete while a
--      chunk was still mid-flight, and a chunk could keep publishing after
--      its run reached a terminal state.
--   4. Adds asset-unavailability handling (S3) so a chunk whose previews
--      can no longer be produced degrades gracefully instead of blocking
--      dispatch forever.
--   5. Adds dispatch-attempt tracking and a reconciliation claim RPC (S4,
--      S6, S7) so a Workflow that never called back (ambiguous outcome, or
--      simply lost) does not strand its chunk indefinitely, and fixes a
--      real control-flow bug in reserve_gallery_attempt (see below).

-- ---------------------------------------------------------------------
-- 1. Admission settings: widen limits, add the daily fair-use cap.
-- ---------------------------------------------------------------------

alter table public.gallery_import_admission_settings
  drop constraint if exists gallery_import_admission_settings_limit_template_check,
  add constraint gallery_import_admission_settings_limit_template_check
    check (jsonb_typeof(limit_template)='object' and octet_length(limit_template::text) <= 2048
      and limit_template ?& array['maxChunksPerRun','maxAssetsPerRun','maxAssetsPerChunk','maxCandidatesPerRun','maxProviderAttemptsPerCluster','maxImagesPerCluster','maxPreviewBytes']
      and jsonb_typeof(limit_template->'maxChunksPerRun')='number'
      and jsonb_typeof(limit_template->'maxAssetsPerRun')='number'
      and jsonb_typeof(limit_template->'maxAssetsPerChunk')='number'
      and jsonb_typeof(limit_template->'maxCandidatesPerRun')='number'
      and jsonb_typeof(limit_template->'maxProviderAttemptsPerCluster')='number'
      and jsonb_typeof(limit_template->'maxImagesPerCluster')='number'
      and jsonb_typeof(limit_template->'maxPreviewBytes')='number'
      and (limit_template->>'maxChunksPerRun') ~ '^[0-9]+$'
      and (limit_template->>'maxAssetsPerRun') ~ '^[0-9]+$'
      and (limit_template->>'maxAssetsPerChunk') ~ '^[0-9]+$'
      and (limit_template->>'maxCandidatesPerRun') ~ '^[0-9]+$'
      and (limit_template->>'maxProviderAttemptsPerCluster') ~ '^[0-9]+$'
      and (limit_template->>'maxImagesPerCluster') ~ '^[0-9]+$'
      and (limit_template->>'maxPreviewBytes') ~ '^[0-9]+$'
      and (limit_template->>'maxChunksPerRun')::integer between 1 and 5000
      and (limit_template->>'maxAssetsPerRun')::integer between 1 and 100000
      and (limit_template->>'maxAssetsPerChunk')::integer between 1 and 500
      and (limit_template->>'maxCandidatesPerRun')::integer between 1 and 10000
      and (limit_template->>'maxProviderAttemptsPerCluster')::integer between 1 and 3
      and (limit_template->>'maxImagesPerCluster')::integer between 1 and 10
      and (limit_template->>'maxPreviewBytes')::integer between 1024 and 1500000);

alter table public.gallery_import_admission_settings
  alter column limit_template set default
    '{"maxChunksPerRun":2000,"maxAssetsPerRun":50000,"maxAssetsPerChunk":100,"maxCandidatesPerRun":5000,"maxProviderAttemptsPerCluster":3,"maxImagesPerCluster":10,"maxPreviewBytes":1500000}'::jsonb;

-- The touch trigger bumps policy_epoch on this change; in-flight runs keep
-- their own immutable limit_snapshot, so widening the template never
-- retroactively changes an active run's admitted counts.
update public.gallery_import_admission_settings
  set limit_template = '{"maxChunksPerRun":2000,"maxAssetsPerRun":50000,"maxAssetsPerChunk":100,"maxCandidatesPerRun":5000,"maxProviderAttemptsPerCluster":3,"maxImagesPerCluster":10,"maxPreviewBytes":1500000}'::jsonb
  where singleton;

alter table public.gallery_import_admission_settings
  add column if not exists daily_cluster_limit smallint not null default 300
    check (daily_cluster_limit between 20 and 5000);

create or replace function public.touch_gallery_import_admission_settings()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := transaction_timestamp();
  if new.normal_monthly_run_limit is distinct from old.normal_monthly_run_limit
    or new.initial_run_limit is distinct from old.initial_run_limit
    or new.review_ttl is distinct from old.review_ttl
    or new.quiet_period is distinct from old.quiet_period
    or new.limit_template is distinct from old.limit_template
    or new.daily_cluster_limit is distinct from old.daily_cluster_limit
    or new.enabled is distinct from old.enabled then
    new.policy_epoch := old.policy_epoch + 1;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. Admission: the continuous model has one open-ended sweep per family,
--    not a capped number of "runs" -- drop the first-30-days/monthly caps.
-- ---------------------------------------------------------------------

create or replace function public.create_gallery_import_run_internal(
  p_family_id uuid,
  p_capability text,
  p_algorithm_version text,
  p_consent_version text,
  p_permission_mode text
)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_settings public.gallery_import_admission_settings%rowtype; v_run_id uuid; v_now timestamptz := transaction_timestamp();
begin
  if auth.uid() is null then raise exception 'Unauthorized' using errcode = '28000'; end if;
  if public.is_anonymous_user() or not public.has_family_role(p_family_id, array['owner','manager']) then raise exception 'Not authorized' using errcode = '42501'; end if;
  if not public.billing_write_allowed(p_family_id, auth.uid()) then raise exception 'Subscription required' using errcode = 'P0001'; end if;
  if p_capability is null or char_length(p_capability) < 32 or char_length(p_capability) > 512 then raise exception 'Invalid import capability' using errcode = '22023'; end if;
  select * into v_settings from public.gallery_import_admission_settings where singleton for share;
  if not v_settings.enabled then raise exception 'Gallery import is not available' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtextextended('gallery-import:' || p_family_id::text, 0));
  if exists (select 1 from public.gallery_import_runs where family_id=p_family_id and status in ('scanning','processing','reviewing')) then raise exception 'A gallery import is already active' using errcode = 'P0001'; end if;
  insert into public.gallery_import_runs (family_id, actor_id, capability_hash, algorithm_version, consent_version, permission_mode, limit_snapshot, policy_epoch, expires_at)
  values (p_family_id, auth.uid(), encode(extensions.digest(p_capability, 'sha256'), 'hex'), p_algorithm_version, p_consent_version, p_permission_mode, v_settings.limit_template, v_settings.policy_epoch, v_now + v_settings.review_ttl)
  returning id into v_run_id;
  return v_run_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. TTL extension on activity: "review window is 30 days from last
--    activity", not from run creation. Propagates to every row whose own
--    expires_at gates a live operation (assets: upload window; candidates:
--    edit/skip/approve/visibility window) so those rows never expire ahead
--    of the run they belong to.
-- ---------------------------------------------------------------------

create or replace function public.gallery_import_touch_run(p_run_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_review_ttl interval; v_new_expiry timestamptz;
begin
  select review_ttl into v_review_ttl from public.gallery_import_admission_settings where singleton;
  -- Throttled to at most once per day of activity. This function is called
  -- from get_gallery_import_candidates, which the review deck polls every
  -- ~9s: without the WHERE guard below, greatest(expires_at, now()+ttl)
  -- always moves forward and the assets/candidates propagation predicates
  -- are therefore always true, turning every poll into a full UPDATE of
  -- every live asset/candidate row for the run (10k rows on a large sweep,
  -- every 9 seconds, per reviewing device). The guard makes the no-op path
  -- (the overwhelming majority of calls) a single cheap UPDATE that touches
  -- zero rows.
  update public.gallery_import_runs
    set expires_at = transaction_timestamp() + v_review_ttl
    where id = p_run_id and status in ('scanning','processing','reviewing')
      and expires_at < transaction_timestamp() + v_review_ttl - interval '1 day'
    returning expires_at into v_new_expiry;
  if v_new_expiry is null then return; end if;
  update public.gallery_import_assets set expires_at = v_new_expiry
    where run_id = p_run_id and expires_at < v_new_expiry;
  update public.gallery_import_candidates set expires_at = v_new_expiry
    where run_id = p_run_id and status in ('staged','posting','skipped','unavailable') and expires_at < v_new_expiry;
end;
$$;
revoke all on function public.gallery_import_touch_run(uuid) from public, anon, authenticated, service_role;

create or replace function public.register_gallery_import_chunk(
  p_run_id uuid, p_capability text, p_ordinal integer, p_cluster_count integer, p_asset_count integer
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_run public.gallery_import_runs%rowtype;
  v_chunk public.gallery_import_chunks%rowtype;
  v_chunk_id uuid;
  v_daily_limit smallint;
  v_used integer;
  v_excess integer;
  v_reset_at timestamptz;
begin
  v_run := public.gallery_import_require_actor_run(p_run_id,p_capability);
  if v_run.status not in ('scanning','processing','reviewing') or v_run.expires_at <= transaction_timestamp() then raise exception 'Import run is not accepting chunks' using errcode = 'P0001'; end if;
  if p_cluster_count not between 1 and least(1000,p_asset_count) or p_asset_count not between 1 and (v_run.limit_snapshot->>'maxAssetsPerChunk')::integer then raise exception 'Invalid chunk manifest counts' using errcode = '22023'; end if;
  perform public.gallery_import_touch_run(v_run.id);
  select * into v_chunk from public.gallery_import_chunks where run_id=p_run_id and ordinal=p_ordinal for update;
  if found then
    if v_chunk.declared_cluster_count<>p_cluster_count or v_chunk.declared_asset_count<>p_asset_count then raise exception 'Chunk replay changed manifest counts' using errcode='22023'; end if;
    return v_chunk.id;
  end if;
  if (select count(*) from public.gallery_import_chunks where run_id=p_run_id) >= (v_run.limit_snapshot->>'maxChunksPerRun')::integer
    or (select coalesce(sum(declared_asset_count),0) from public.gallery_import_chunks where run_id=p_run_id) + p_asset_count > (v_run.limit_snapshot->>'maxAssetsPerRun')::integer then raise exception 'Gallery import manifest limit reached' using errcode='P0001'; end if;
  -- Fair-use: a rolling 24h cluster cap per family, independent of any run
  -- boundary (the continuous model has no other natural "per day" fence).
  -- P0002 is otherwise "not found" elsewhere in this domain; the Edge
  -- disambiguates this specific call by the presence of the ISO hint.
  select daily_cluster_limit into v_daily_limit from public.gallery_import_admission_settings where singleton;
  select count(*) into v_used
    from public.gallery_import_cluster_results cr
    join public.gallery_import_chunks c on c.id=cr.chunk_id
    where c.run_id in (select id from public.gallery_import_runs where family_id=v_run.family_id)
      and cr.created_at > transaction_timestamp() - interval '24 hours';
  v_excess := coalesce(v_used,0) + p_cluster_count - v_daily_limit;
  if v_excess > 0 then
    -- The hint is the instant used'+p_cluster_count first fits under the
    -- cap, not merely when the single oldest row ages out: a multi-cluster
    -- chunk needs v_excess rows to free, so retrying at the oldest row's
    -- +24h would still be refused and the client would thrash. v_excess-th
    -- oldest row (1-indexed) is the last one that must age out.
    select cr.created_at into v_reset_at
      from public.gallery_import_cluster_results cr
      join public.gallery_import_chunks c on c.id=cr.chunk_id
      where c.run_id in (select id from public.gallery_import_runs where family_id=v_run.family_id)
        and cr.created_at > transaction_timestamp() - interval '24 hours'
      order by cr.created_at
      offset v_excess - 1
      limit 1;
    raise exception 'Gallery import daily limit reached' using errcode = 'P0002',
      hint = to_char(timezone('utc', coalesce(v_reset_at, transaction_timestamp()) + interval '24 hours'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  end if;
  insert into public.gallery_import_chunks (run_id,ordinal,cluster_count,asset_count,declared_cluster_count,declared_asset_count,status) values (p_run_id,p_ordinal,p_cluster_count,p_asset_count,p_cluster_count,p_asset_count,'uploading')
  returning id into v_chunk_id;
  update public.gallery_import_runs set status='processing' where id=p_run_id and status='scanning';
  return v_chunk_id;
end;
$$;

create or replace function public.get_gallery_import_candidates(p_run_id uuid, p_capability text)
returns setof public.gallery_import_candidates language plpgsql security definer set search_path = public as $$
declare v_run public.gallery_import_runs%rowtype;
begin
  v_run := public.gallery_import_require_actor_run(p_run_id, p_capability);
  perform public.gallery_import_touch_run(v_run.id);
  return query select c.* from public.gallery_import_candidates c where c.run_id=v_run.id and c.status in ('staged','posting','skipped','unavailable') and c.expires_at > transaction_timestamp() order by c.created_at;
end;
$$;

create or replace function public.set_gallery_import_candidate_skip(p_candidate_id uuid, p_capability text, p_skip boolean)
returns public.gallery_import_candidates language plpgsql security definer set search_path = public as $$
declare v_candidate public.gallery_import_candidates%rowtype; v_run public.gallery_import_runs%rowtype; v_run_id uuid;
begin
  select run_id into v_run_id from public.gallery_import_candidates where id=p_candidate_id;
  if v_run_id is null then raise exception 'Candidate not found' using errcode='P0002'; end if;
  v_run := public.gallery_import_require_actor_run(v_run_id,p_capability);
  if v_run.status not in ('scanning','processing','reviewing') or v_run.expires_at<=transaction_timestamp() then raise exception 'Import run is not active' using errcode='P0001'; end if;
  perform public.gallery_import_touch_run(v_run.id);
  select * into v_candidate from public.gallery_import_candidates where id=p_candidate_id for update;
  if v_candidate.expires_at <= transaction_timestamp() then raise exception 'Candidate expired' using errcode='P0001'; end if;
  if p_skip and v_candidate.status='staged' then
    update public.gallery_import_candidates set status='skipped' where id=p_candidate_id returning * into v_candidate;
    insert into public.gallery_import_cluster_receipts (family_id,actor_id,algorithm_version,cluster_signature,candidate_fingerprint,outcome,source_candidate_id)
      values (v_candidate.family_id,v_candidate.actor_id,(select algorithm_version from public.gallery_import_runs where id=v_candidate.run_id),v_candidate.cluster_signature,v_candidate.candidate_fingerprint,'skipped',v_candidate.id)
      on conflict (family_id,actor_id,algorithm_version,cluster_signature) do update set outcome='skipped',candidate_fingerprint=excluded.candidate_fingerprint,source_candidate_id=excluded.source_candidate_id;
  elsif not p_skip and v_candidate.status='skipped' then
    update public.gallery_import_candidates set status='staged' where id=p_candidate_id returning * into v_candidate;
    delete from public.gallery_import_cluster_receipts where family_id=v_candidate.family_id and actor_id=v_candidate.actor_id
      and algorithm_version=(select algorithm_version from public.gallery_import_runs where id=v_candidate.run_id)
      and cluster_signature=v_candidate.cluster_signature and outcome='skipped';
  elsif (p_skip and v_candidate.status='skipped') or (not p_skip and v_candidate.status='staged') then null;
  else raise exception 'Candidate cannot change skip state' using errcode='P0001'; end if;
  return v_candidate;
end;
$$;

create or replace function public.begin_gallery_import_approval(
  p_candidate_id uuid, p_capability text, p_selected_assets jsonb
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_candidate public.gallery_import_candidates%rowtype; v_lease public.gallery_import_approval_leases%rowtype; v_token text; v_memory_id uuid := gen_random_uuid(); v_expected_assets jsonb; v_selected_tokens uuid[];
begin
  if p_selected_assets is null or jsonb_typeof(p_selected_assets)<>'array' or jsonb_array_length(p_selected_assets) not between 1 and 10
    or exists (select 1 from jsonb_array_elements(p_selected_assets) x where jsonb_typeof(x)<>'object'
      or (x-array['assetToken','contentType'])<>'{}'::jsonb or not (x ?& array['assetToken','contentType'])
      or jsonb_typeof(x->'assetToken')<>'string' or (x->>'assetToken') !~ '^[0-9a-fA-F-]{36}$'
      or jsonb_typeof(x->'contentType')<>'string' or x->>'contentType' not in ('image/jpeg','image/png','image/heic','image/heif','image/webp')) then raise exception 'Invalid selected originals' using errcode='22023'; end if;
  select array_agg((x->>'assetToken')::uuid order by x->>'assetToken') into v_selected_tokens from jsonb_array_elements(p_selected_assets) x;
  if cardinality(v_selected_tokens)<>(select count(distinct token) from unnest(v_selected_tokens) token) then raise exception 'Selected originals must be unique' using errcode='22023'; end if;
  select run_id into v_candidate.run_id from public.gallery_import_candidates where id=p_candidate_id;
  if v_candidate.run_id is null then raise exception 'Candidate not found' using errcode='P0002'; end if;
  perform public.gallery_import_require_actor_run(v_candidate.run_id,p_capability);
  perform public.gallery_import_touch_run(v_candidate.run_id);
  select * into v_candidate from public.gallery_import_candidates where id=p_candidate_id for update;
  if (select array_agg(token order by token) from unnest(v_candidate.selected_asset_tokens) token) is distinct from v_selected_tokens then raise exception 'Selected originals must exactly match candidate assets' using errcode='22023'; end if;
  if not public.billing_write_allowed(v_candidate.family_id,auth.uid()) then raise exception 'Subscription required' using errcode='P0001'; end if;
  if v_candidate.status not in ('staged','posting') or v_candidate.expires_at <= transaction_timestamp() then raise exception 'Candidate cannot be approved' using errcode='P0001'; end if;
  select * into v_lease from public.gallery_import_approval_leases where candidate_id=p_candidate_id for update;
  if found then
    if (select jsonb_agg(jsonb_build_object('assetToken',value->>'assetToken','contentType',value->>'contentType') order by value->>'assetToken') from jsonb_array_elements(v_lease.expected_assets))
      is distinct from (select jsonb_agg(jsonb_build_object('assetToken',value->>'assetToken','contentType',value->>'contentType') order by value->>'assetToken') from jsonb_array_elements(p_selected_assets)) then
      raise exception 'Approval replay changed selected originals' using errcode='22023';
    end if;
    if v_lease.state in ('reserved','uploading','finalizing') and v_lease.expires_at > transaction_timestamp() then
      update public.gallery_import_candidates set status='posting' where id=p_candidate_id;
      return jsonb_build_object('leaseId',v_lease.id,'memoryId',v_lease.memory_id,'expiresAt',v_lease.expires_at,'expectedAssets',v_lease.expected_assets);
    end if;
    if v_lease.state='finalized' then return jsonb_build_object('leaseId',v_lease.id,'memoryId',v_lease.memory_id,'finalized',true); end if;
    raise exception 'Approval lease is no longer usable' using errcode='P0001';
  end if;
  select jsonb_agg(jsonb_build_object('assetToken',a.opaque_token,'objectKey',v_candidate.actor_id::text || '/memories/' || v_memory_id::text || '/media/' || a.opaque_token::text || case x->>'contentType' when 'image/jpeg' then '.jpg' when 'image/png' then '.png' when 'image/heic' then '.heic' when 'image/heif' then '.heif' else '.webp' end,'contentType',x->>'contentType') order by a.opaque_token::text)
    into v_expected_assets from jsonb_array_elements(p_selected_assets) x join public.gallery_import_assets a on a.opaque_token=(x->>'assetToken')::uuid and a.run_id=v_candidate.run_id;
  if v_expected_assets is null or jsonb_array_length(v_expected_assets) <> cardinality(v_candidate.selected_asset_tokens) then raise exception 'Candidate assets are unavailable' using errcode='P0001'; end if;
  v_token := encode(extensions.gen_random_bytes(32),'hex');
  insert into public.gallery_import_approval_leases (candidate_id,run_id,family_id,actor_id,memory_id,lease_token_hash,expected_assets,expires_at)
    values (v_candidate.id,v_candidate.run_id,v_candidate.family_id,v_candidate.actor_id,v_memory_id,encode(extensions.digest(v_token,'sha256'),'hex'),v_expected_assets,least(v_candidate.expires_at,transaction_timestamp()+interval '24 hours'))
    returning * into v_lease;
  update public.gallery_import_candidates set status='posting' where id=p_candidate_id;
  -- The plaintext upload token is deliberately not returned: only the Edge
  -- upload-url endpoint holds it transiently after this authenticated call.
  return jsonb_build_object('leaseId',v_lease.id,'memoryId',v_lease.memory_id,'expiresAt',v_lease.expires_at,'expectedAssets',v_lease.expected_assets);
end;
$$;

create or replace function public.finalize_gallery_import_candidate(p_candidate_id uuid, p_capability text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_candidate public.gallery_import_candidates%rowtype; v_lease public.gallery_import_approval_leases%rowtype; v_asset jsonb; v_position integer := 0; v_first_key text; v_first_type text;
begin
  select run_id into v_candidate.run_id from public.gallery_import_candidates where id=p_candidate_id;
  if v_candidate.run_id is null then raise exception 'Candidate not found' using errcode='P0002'; end if;
  perform public.gallery_import_require_actor_run(v_candidate.run_id,p_capability);
  perform public.gallery_import_touch_run(v_candidate.run_id);
  select * into v_candidate from public.gallery_import_candidates where id=p_candidate_id for update;
  if not public.billing_write_allowed(v_candidate.family_id,auth.uid()) then raise exception 'Subscription required' using errcode='P0001'; end if;
  select * into v_lease from public.gallery_import_approval_leases where candidate_id=p_candidate_id for update;
  if not found then raise exception 'Approval lease not found' using errcode='P0002'; end if;
  if v_lease.state='finalized' then return v_lease.memory_id; end if;
  if v_candidate.status <> 'posting' or v_lease.state not in ('reserved','uploading','finalizing') or v_lease.expires_at <= transaction_timestamp() then raise exception 'Approval cannot be finalized' using errcode='P0001'; end if;
  if (select coalesce(jsonb_agg(jsonb_build_object('objectKey',value->>'objectKey','contentType',value->>'contentType') order by value->>'objectKey'),'[]'::jsonb) from jsonb_array_elements(v_lease.expected_assets))
     is distinct from (select coalesce(jsonb_agg(jsonb_build_object('objectKey',value->>'objectKey','contentType',value->>'contentType') order by value->>'objectKey'),'[]'::jsonb) from jsonb_array_elements(v_lease.uploaded_assets)) then
    raise exception 'Not all approval assets have been verified' using errcode='P0001';
  end if;
  update public.gallery_import_approval_leases set state='finalizing' where id=v_lease.id;
  select value->>'objectKey', value->>'contentType' into v_first_key,v_first_type from jsonb_array_elements(v_lease.uploaded_assets) with ordinality a(value,ordinality) where ordinality=1;
  insert into public.memories (id,user_id,family_id,content,memory_date,memory_type,media_key,media_content_type,illustration_status,emotion,creation_source)
    values (v_lease.memory_id,v_candidate.actor_id,v_candidate.family_id,v_candidate.caption,v_candidate.memory_date,'media',v_first_key,v_first_type,'none',v_candidate.emotion,'gallery_import')
    on conflict (id) do nothing;
  for v_asset in select value from jsonb_array_elements(v_lease.uploaded_assets) loop
    insert into public.memory_media (memory_id,object_key,content_type,aspect_ratio,preview_object_key,position)
      values (v_lease.memory_id,v_asset->>'objectKey',v_asset->>'contentType',nullif(v_asset->>'aspectRatio','')::double precision,nullif(v_asset->>'previewObjectKey',''),v_position)
      on conflict (memory_id,object_key) do nothing;
    v_position := v_position + 1;
  end loop;
  insert into public.memory_family_members (memory_id,family_member_id)
    select v_lease.memory_id, member_id from unnest(v_candidate.family_member_ids) member_id
    on conflict do nothing;
  update public.gallery_import_candidates set status='approved',memory_id=v_lease.memory_id where id=v_candidate.id;
  update public.gallery_import_approval_leases set state='finalized',finalized_at=transaction_timestamp() where id=v_lease.id;
  insert into public.gallery_import_cluster_receipts (family_id,actor_id,algorithm_version,cluster_signature,candidate_fingerprint,outcome,source_candidate_id)
    values (v_candidate.family_id,v_candidate.actor_id,(select algorithm_version from public.gallery_import_runs where id=v_candidate.run_id),v_candidate.cluster_signature,v_candidate.candidate_fingerprint,'approved',v_candidate.id)
    on conflict (family_id,actor_id,algorithm_version,cluster_signature) do update set outcome='approved',candidate_fingerprint=excluded.candidate_fingerprint,source_candidate_id=excluded.source_candidate_id;
  insert into public.gallery_import_digest_windows (family_id,actor_id,approval_count,first_approval_at,last_approval_at,claimed_at,claim_token,sent_at)
    values (v_candidate.family_id,v_candidate.actor_id,1,transaction_timestamp(),transaction_timestamp(),null,null,null)
    on conflict (family_id,actor_id) do update set
      approval_count=gallery_import_digest_windows.approval_count+1,
      first_approval_at=case when gallery_import_digest_windows.approval_count=0 then excluded.first_approval_at else gallery_import_digest_windows.first_approval_at end,
      last_approval_at=excluded.last_approval_at,
      -- Do not touch claim fields: an approval arriving while a prior digest is
      -- claimed must remain visible to its existing fence/reconciliation flow.
      sent_at=null;
  return v_lease.memory_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. Completion/publish races.
-- ---------------------------------------------------------------------

create or replace function public.complete_gallery_import_run(p_run_id uuid, p_capability text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_run public.gallery_import_runs%rowtype;
begin
  v_run := public.gallery_import_require_actor_run(p_run_id,p_capability);
  if v_run.status='completed' then return true; end if;
  if v_run.status <> 'reviewing' or exists (select 1 from public.gallery_import_candidates where run_id=v_run.id and status in ('staged','posting')) then raise exception 'Gallery import still has reviewable suggestions' using errcode='P0001'; end if;
  if exists (select 1 from public.gallery_import_chunks where run_id=v_run.id and status in ('registered','uploading','dispatched','processing')) then raise exception 'Gallery import still has work in flight' using errcode='P0001'; end if;
  update public.gallery_import_runs set status='completed',completed_at=transaction_timestamp() where id=v_run.id;
  return true;
end;
$$;

create or replace function public.publish_gallery_candidates(p_chunk_id uuid, p_candidates jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare v_chunk public.gallery_import_chunks%rowtype; v_run public.gallery_import_runs%rowtype; v_item jsonb; v_count integer := 0; v_tokens uuid[]; v_candidate_id uuid; v_candidate_fingerprint text; v_split_index smallint;
begin
  if p_candidates is null or jsonb_typeof(p_candidates) <> 'array' or jsonb_array_length(p_candidates)>300 then raise exception 'Invalid candidate publication' using errcode='22023'; end if;
  select * into v_chunk from public.gallery_import_chunks where id=p_chunk_id for update;
  if not found then raise exception 'Chunk not found' using errcode='P0002'; end if;
  select * into v_run from public.gallery_import_runs where id=v_chunk.run_id for update;
  -- A completed run's review window is durably closed to new suggestions,
  -- same as cancelled/expired/failed: only a straggling Workflow could
  -- otherwise publish into a run the family has already finished reviewing.
  if v_run.status in ('cancelled','expired','failed','completed') or v_run.expires_at <= transaction_timestamp() then raise exception 'Run is closed' using errcode='P0001'; end if;
  for v_item in select value from jsonb_array_elements(p_candidates) loop
    if jsonb_typeof(v_item)<>'object' or (v_item-array['clusterSignature','caption','memoryDate','emotion','confidence','selectedAssetTokens'])<>'{}'::jsonb
      or not (v_item ?& array['clusterSignature','caption','memoryDate','emotion','confidence','selectedAssetTokens'])
      or jsonb_typeof(v_item->'clusterSignature')<>'string' or (v_item->>'clusterSignature') !~ '^[0-9a-f]{64}$'
      or jsonb_typeof(v_item->'caption')<>'string'
      or jsonb_typeof(v_item->'memoryDate')<>'string' or (v_item->>'memoryDate') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or jsonb_typeof(v_item->'emotion') not in ('string','null')
      or (jsonb_typeof(v_item->'emotion')='string' and v_item->>'emotion' not in ('joy','funny','calm','wonder','tender','mischief','pride','bittersweet','worry','weary','sad'))
      or jsonb_typeof(v_item->'confidence')<>'number'
      or jsonb_typeof(v_item->'selectedAssetTokens')<>'array' then raise exception 'Invalid candidate schema' using errcode='22023'; end if;
    if exists (select 1 from public.gallery_import_cluster_receipts r where r.family_id=v_run.family_id and r.actor_id=v_run.actor_id and r.algorithm_version=v_run.algorithm_version and r.cluster_signature=v_item->>'clusterSignature' and r.outcome in ('skipped','approved')) then
      continue;
    end if;
    select array_agg(value::uuid) into v_tokens from jsonb_array_elements_text(v_item->'selectedAssetTokens');
    if cardinality(v_tokens) not between 1 and (v_run.limit_snapshot->>'maxImagesPerCluster')::integer then raise exception 'Candidate selected-asset limit exceeded' using errcode='22023'; end if;
    select encode(extensions.digest(v_run.id::text || ':' || (v_item->>'clusterSignature') || ':' || string_agg(a.opaque_token::text,',' order by a.opaque_token::text),'sha256'),'hex') into v_candidate_fingerprint
      from public.gallery_import_assets a where a.run_id=v_run.id and a.chunk_id=v_chunk.id and a.cluster_signature=v_item->>'clusterSignature' and a.opaque_token=any(v_tokens);
    if v_candidate_fingerprint is null or (select count(*) from public.gallery_import_assets a where a.run_id=v_run.id and a.chunk_id=v_chunk.id and a.cluster_signature=v_item->>'clusterSignature' and a.opaque_token=any(v_tokens)) <> cardinality(v_tokens) then
      raise exception 'Candidate tokens are not an exact cluster subset' using errcode='22023';
    end if;
    if exists (select 1 from public.gallery_import_candidates c where c.run_id=v_run.id and c.candidate_fingerprint=v_candidate_fingerprint) then continue; end if;
    select count(*)::smallint into v_split_index from public.gallery_import_candidates c where c.run_id=v_run.id and c.cluster_signature=v_item->>'clusterSignature';
    if v_split_index >= 3 then raise exception 'Cluster has reached its group limit' using errcode='22023'; end if;
    if (select count(*) from public.gallery_import_candidates c where c.run_id=v_run.id) >= (v_run.limit_snapshot->>'maxCandidatesPerRun')::integer then
      continue;
    end if;
    insert into public.gallery_import_candidates (run_id,chunk_id,family_id,actor_id,cluster_signature,candidate_fingerprint,split_index,status,caption,memory_date,emotion,confidence,selected_asset_tokens,family_member_ids,expires_at)
      values (v_run.id,v_chunk.id,v_run.family_id,v_run.actor_id,v_item->>'clusterSignature',v_candidate_fingerprint,v_split_index,'staged',v_item->>'caption',(v_item->>'memoryDate')::date,nullif(v_item->>'emotion',''),(v_item->>'confidence')::double precision,v_tokens,'{}'::uuid[],v_run.expires_at)
      returning id into v_candidate_id;
    if v_candidate_id is not null then v_count := v_count+1; end if;
  end loop;
  return v_count;
end;
$$;

create or replace function public.register_gallery_import_assets(
  p_run_id uuid, p_chunk_id uuid, p_capability text, p_assets jsonb
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_run public.gallery_import_runs%rowtype; v_chunk public.gallery_import_chunks%rowtype; v_item jsonb; v_existing public.gallery_import_assets%rowtype; v_accepted uuid[] := '{}'; v_suppressed text[] := '{}'; v_effective_clusters integer;
begin
  v_run := public.gallery_import_require_actor_run(p_run_id,p_capability);
  if p_assets is null or jsonb_typeof(p_assets) <> 'array' or jsonb_array_length(p_assets) > (v_run.limit_snapshot->>'maxAssetsPerChunk')::integer then raise exception 'Invalid import asset manifest' using errcode='22023'; end if;
  select * into v_chunk from public.gallery_import_chunks where id=p_chunk_id and run_id=v_run.id for update;
  if not found or v_chunk.status not in ('registered','uploading') then raise exception 'Chunk is not accepting assets' using errcode='P0001'; end if;
  if jsonb_array_length(p_assets) <> v_chunk.declared_asset_count then raise exception 'Asset manifest count does not match chunk' using errcode='22023'; end if;
  if exists (
    select 1 from jsonb_array_elements(p_assets) x
    where jsonb_typeof(x)<>'object'
      or (x - array['opaqueToken','clusterSignature','captureDate','width','height','isFavorite']) <> '{}'::jsonb
      or not (x ?& array['opaqueToken','clusterSignature','captureDate','isFavorite'])
      or (x->>'opaqueToken') !~ '^[0-9a-fA-F-]{36}$'
      or (x->>'clusterSignature') !~ '^[0-9a-f]{64}$'
      or (x->>'captureDate') !~ '^\d{4}-\d{2}-\d{2}$'
      or jsonb_typeof(x->'isFavorite') <> 'boolean'
      or (x ? 'width' and jsonb_typeof(x->'width') not in ('number','null'))
      or (x ? 'height' and jsonb_typeof(x->'height') not in ('number','null'))
      or (jsonb_typeof(x->'width')='number' and (x->>'width') !~ '^[0-9]+$')
      or (jsonb_typeof(x->'height')='number' and (x->>'height') !~ '^[0-9]+$')
  ) or (select count(distinct x->>'opaqueToken') from jsonb_array_elements(p_assets) x) <> v_chunk.declared_asset_count
    or (select count(distinct x->>'clusterSignature') from jsonb_array_elements(p_assets) x) <> v_chunk.declared_cluster_count
    or exists (select 1 from jsonb_array_elements(p_assets) x group by x->>'clusterSignature' having count(*) > (v_run.limit_snapshot->>'maxImagesPerCluster')::integer) then
    raise exception 'Invalid import asset manifest schema or counts' using errcode='22023';
  end if;
  for v_item in select value from jsonb_array_elements(p_assets) loop
    select * into v_existing from public.gallery_import_assets where run_id=v_run.id and opaque_token=(v_item->>'opaqueToken')::uuid;
    if found then
      if (v_existing.chunk_id,v_existing.cluster_signature,v_existing.capture_date,v_existing.width,v_existing.height,v_existing.is_favorite)
        is distinct from (v_chunk.id,v_item->>'clusterSignature',(v_item->>'captureDate')::date,nullif(v_item->>'width','')::integer,nullif(v_item->>'height','')::integer,coalesce((v_item->>'isFavorite')::boolean,false)) then raise exception 'Asset token replay changed immutable manifest' using errcode='22023'; end if;
    elsif exists (select 1 from public.gallery_import_cluster_receipts r where r.family_id=v_run.family_id and r.actor_id=v_run.actor_id and r.algorithm_version=v_run.algorithm_version and r.cluster_signature=v_item->>'clusterSignature' and r.outcome in ('skipped','approved')) then
      v_suppressed := array_append(v_suppressed,v_item->>'clusterSignature'); continue;
    else
      insert into public.gallery_import_assets (run_id,chunk_id,opaque_token,cluster_signature,capture_date,width,height,is_favorite,expires_at)
      values (v_run.id,v_chunk.id,(v_item->>'opaqueToken')::uuid,v_item->>'clusterSignature',(v_item->>'captureDate')::date,nullif(v_item->>'width','')::integer,nullif(v_item->>'height','')::integer,coalesce((v_item->>'isFavorite')::boolean,false),v_run.expires_at);
    end if;
    v_accepted := array_append(v_accepted,(v_item->>'opaqueToken')::uuid);
  end loop;
  select count(distinct cluster_signature) into v_effective_clusters from public.gallery_import_assets where chunk_id=v_chunk.id;
  update public.gallery_import_chunks set asset_count=cardinality(v_accepted),cluster_count=v_effective_clusters where id=v_chunk.id;
  insert into public.gallery_import_cluster_results (chunk_id,cluster_signature)
    select v_chunk.id, a.cluster_signature from public.gallery_import_assets a where a.chunk_id=v_chunk.id group by a.cluster_signature
    on conflict do nothing;
  insert into public.gallery_import_cluster_results (chunk_id,cluster_signature,state,candidate_count,completed_at)
    select v_chunk.id,s,'suppressed',0,transaction_timestamp() from (select distinct unnest(v_suppressed) s) suppressed
    on conflict do nothing;
  if v_effective_clusters=0 then
    update public.gallery_import_chunks set status='completed',completed_at=transaction_timestamp() where id=v_chunk.id;
    -- Mirror publish_gallery_cluster_result/fail_gallery_chunk: only flip the
    -- run to reviewing once every chunk is terminal, not just this one.
    update public.gallery_import_runs set status='reviewing'
      where id=v_run.id and status in ('scanning','processing')
        and not exists (select 1 from public.gallery_import_chunks c where c.run_id=v_run.id and c.status not in ('completed','failed','cancelled','expired'));
  end if;
  return jsonb_build_object('acceptedAssetTokens',v_accepted,'suppressedClusterSignatures',(select coalesce(array_agg(distinct s order by s),'{}'::text[]) from unnest(v_suppressed) s));
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Asset unavailability (S3): an asset the device can no longer produce
--    a preview for (deleted, iCloud-only original, permission revoked mid-
--    sweep) must not block its chunk's dispatch forever.
-- ---------------------------------------------------------------------

alter table public.gallery_import_assets add column if not exists unavailable_at timestamptz;

create or replace function public.mark_gallery_import_assets_unavailable(
  p_run_id uuid, p_capability text, p_chunk_id uuid, p_asset_tokens uuid[]
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_run public.gallery_import_runs%rowtype;
  v_chunk public.gallery_import_chunks%rowtype;
  v_marked uuid[];
  v_cluster text;
  v_available integer;
  v_emptied text[] := '{}';
  v_total_available integer;
begin
  v_run := public.gallery_import_require_actor_run(p_run_id, p_capability);
  if v_run.status not in ('scanning','processing','reviewing') or v_run.expires_at <= transaction_timestamp() then raise exception 'Import run is not active' using errcode='P0001'; end if;
  if p_asset_tokens is null or cardinality(p_asset_tokens) < 1 or cardinality(p_asset_tokens) > 500
     or not public.gallery_import_uuid_array_is_distinct(p_asset_tokens) then
    raise exception 'Invalid gallery unavailable-asset request' using errcode='22023';
  end if;
  select * into v_chunk from public.gallery_import_chunks where id=p_chunk_id and run_id=v_run.id for update;
  if not found or v_chunk.status not in ('registered','uploading','dispatched') then
    raise exception 'Chunk cannot mark assets unavailable' using errcode='P0001';
  end if;
  -- Only an asset that was never actually uploaded can be dropped this way:
  -- a verified preview manifest is immutable (protect_gallery_import_preview_manifest).
  with updated as (
    update public.gallery_import_assets
      set unavailable_at = transaction_timestamp()
      where chunk_id = v_chunk.id and opaque_token = any(p_asset_tokens)
        and preview_uploaded_at is null and unavailable_at is null
      returning opaque_token, cluster_signature
  )
  select coalesce(array_agg(distinct opaque_token),'{}'::uuid[]) into v_marked from updated;
  for v_cluster in
    select distinct cluster_signature from public.gallery_import_assets where chunk_id=v_chunk.id and opaque_token = any(v_marked)
  loop
    select count(*) into v_available from public.gallery_import_assets
      where chunk_id=v_chunk.id and cluster_signature=v_cluster and unavailable_at is null;
    if v_available = 0 and exists (
      select 1 from public.gallery_import_cluster_results where chunk_id=v_chunk.id and cluster_signature=v_cluster and state='pending'
    ) then
      -- Reuses the same terminal-publication path a Workflow uses, so chunk/
      -- run completion bookkeeping (and the immutable-terminal-result guard)
      -- is identical either way. Writes no cluster_receipts row: unlike a
      -- deliberate skip, this candidate may still exist on a later sweep if
      -- the asset becomes available again.
      perform public.publish_gallery_cluster_result(v_chunk.id, v_cluster, '[]'::jsonb, 'invalid_preview');
      v_emptied := array_append(v_emptied, v_cluster);
    end if;
  end loop;
  select count(*) into v_total_available from public.gallery_import_assets where chunk_id=v_chunk.id and unavailable_at is null;
  update public.gallery_import_chunks
    set asset_count = v_total_available,
        cluster_count = (select count(distinct cluster_signature) from public.gallery_import_assets where chunk_id=v_chunk.id and unavailable_at is null)
    where id = v_chunk.id;
  if v_total_available = 0 then
    update public.gallery_import_chunks set status='completed', completed_at=coalesce(completed_at,transaction_timestamp())
      where id=v_chunk.id and status not in ('completed','failed','cancelled','expired');
    update public.gallery_import_runs set status='reviewing'
      where id=v_run.id and status in ('scanning','processing')
        and not exists (select 1 from public.gallery_import_chunks c where c.run_id=v_run.id and c.status not in ('completed','failed','cancelled','expired'));
  end if;
  return jsonb_build_object('markedAssetTokens', to_jsonb(v_marked), 'emptiedClusterSignatures', to_jsonb(v_emptied));
end;
$$;
revoke all on function public.mark_gallery_import_assets_unavailable(uuid,text,uuid,uuid[]) from public, anon;
grant execute on function public.mark_gallery_import_assets_unavailable(uuid,text,uuid,uuid[]) to authenticated;

create or replace function public.mark_gallery_chunk_dispatched(p_chunk_id uuid, p_workflow_id text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.gallery_import_chunks
    set workflow_id=p_workflow_id, status='dispatched', dispatched_at=transaction_timestamp(), dispatch_attempts=dispatch_attempts+1
    where id=p_chunk_id and status in ('registered','uploading','dispatched','processing')
      and asset_count=(select count(*) from public.gallery_import_assets a where a.chunk_id=p_chunk_id and a.unavailable_at is null)
      and not exists (select 1 from public.gallery_import_assets a where a.chunk_id=p_chunk_id and a.unavailable_at is null and a.preview_uploaded_at is null);
  return found;
end;
$$;

create or replace function public.get_gallery_chunk_input(p_chunk_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_chunk public.gallery_import_chunks%rowtype; v_run public.gallery_import_runs%rowtype; v_family public.families%rowtype;
begin
  select * into v_chunk from public.gallery_import_chunks where id=p_chunk_id for update;
  if not found then raise exception 'Chunk not found' using errcode='P0002'; end if;
  select * into v_run from public.gallery_import_runs where id=v_chunk.run_id;
  select * into v_family from public.families where id=v_run.family_id;
  if v_chunk.status not in ('dispatched','processing') or v_run.status in ('cancelled','expired','failed','completed') or v_run.expires_at <= transaction_timestamp() or v_family.deleted_at is not null then raise exception 'Chunk is not dispatchable' using errcode='P0001'; end if;
  if (select count(*) from public.gallery_import_assets where chunk_id=v_chunk.id and unavailable_at is null) <> v_chunk.asset_count
    or exists (select 1 from public.gallery_import_assets where chunk_id=v_chunk.id and unavailable_at is null and (preview_uploaded_at is null or preview_object_key is null or preview_content_type is null or preview_width is null or preview_height is null or preview_bytes is null or preview_sha256 is null)) then raise exception 'Chunk preview manifest is incomplete' using errcode='P0001'; end if;
  update public.gallery_import_chunks set status='processing',dispatched_at=coalesce(dispatched_at,transaction_timestamp()) where id=p_chunk_id and status in ('registered','uploading','dispatched','processing');
  return jsonb_build_object(
    'chunkId',v_chunk.id,
    'runId',v_run.id,
    'providerDeadlineAt',least(v_run.expires_at, transaction_timestamp() + interval '15 minutes'),
    'maxProviderAttempts',(v_run.limit_snapshot->>'maxProviderAttemptsPerCluster')::integer,
    'maxImagesPerCluster',(v_run.limit_snapshot->>'maxImagesPerCluster')::integer,
    'captionLocale',v_family.gallery_caption_language,
    'captionInstructions',v_family.gallery_caption_instructions,
    'clusters',(select coalesce(jsonb_agg(cluster_row order by cluster_row->>'clusterSignature'),'[]'::jsonb) from (
      select jsonb_build_object(
        'clusterSignature',a.cluster_signature,
        'clusterStartDate',min(a.capture_date),
        'clusterEndDate',max(a.capture_date),
        'assets',jsonb_agg(jsonb_build_object('assetToken',a.opaque_token,'previewKey',a.preview_object_key,'expectedByteLength',a.preview_bytes,'expectedSha256',a.preview_sha256,'expectedContentType',a.preview_content_type,'previewWidth',a.preview_width,'previewHeight',a.preview_height,'captureDate',a.capture_date,'width',a.width,'height',a.height,'isFavorite',a.is_favorite) order by a.created_at)
      ) cluster_row
      from public.gallery_import_assets a
      where a.chunk_id=v_chunk.id and a.unavailable_at is null and not exists (select 1 from public.gallery_import_cluster_results r where r.chunk_id=v_chunk.id and r.cluster_signature=a.cluster_signature and r.state <> 'pending')
      group by a.cluster_signature
    ) clusters)
  );
end;
$$;

-- ---------------------------------------------------------------------
-- 6. Reconciliation (S4, S6, S7): a Workflow that never called back (worker
--    crash, ambiguous network failure, lost Cloudflare instance) must not
--    strand its chunk. dispatch_attempts records how many times a chunk has
--    been (re)dispatched; claim_stale_gallery_chunks lets the cleanup cron
--    find and retry chunks stuck past a generous timeout, or give up after
--    3 attempts.
-- ---------------------------------------------------------------------

alter table public.gallery_import_chunks add column if not exists dispatch_attempts smallint not null default 0 check (dispatch_attempts between 0 and 20);

create or replace function public.enforce_gallery_import_transitions()
returns trigger language plpgsql set search_path = public as $$
declare v_new jsonb := to_jsonb(new); v_old jsonb := to_jsonb(old);
begin
  if tg_table_name = 'gallery_import_runs' and v_new->>'status' is distinct from v_old->>'status'
    and not ((v_old->>'status'='scanning' and v_new->>'status' in ('processing','reviewing','cancelled','expired','failed'))
      or (v_old->>'status'='processing' and v_new->>'status' in ('reviewing','cancelled','expired','failed'))
      or (v_old->>'status'='reviewing' and v_new->>'status' in ('completed','cancelled','expired','failed'))
      -- A completed run remains completed until its review TTL ends. Cleanup
      -- then transitions it to expired as the durable R2 deletion fence.
      or (v_old->>'status' in ('completed','cancelled','failed') and v_new->>'status'='expired')) then
    raise exception 'Invalid gallery import run transition' using errcode = '23514';
  end if;
  if tg_table_name = 'gallery_import_candidates' and v_new->>'status' is distinct from v_old->>'status'
    and not ((v_old->>'status'='staged' and v_new->>'status' in ('posting','skipped','unavailable','expired'))
      or (v_old->>'status'='posting' and v_new->>'status' in ('staged','approved','unavailable','expired'))
      or (v_old->>'status'='skipped' and v_new->>'status' in ('staged','expired'))
      or (v_old->>'status'='unavailable' and v_new->>'status' in ('staged','expired'))
      or (v_old->>'status'='approved' and v_new->>'status'='approved')) then
    raise exception 'Invalid gallery import candidate transition' using errcode = '23514';
  end if;
  if tg_table_name = 'gallery_import_chunks' and v_new->>'status' is distinct from v_old->>'status'
    and not ((v_old->>'status'='registered' and v_new->>'status' in ('uploading','dispatched','completed','failed','cancelled','expired'))
      or (v_old->>'status'='uploading' and v_new->>'status' in ('dispatched','completed','failed','cancelled','expired'))
      or (v_old->>'status'='dispatched' and v_new->>'status' in ('processing','failed','cancelled','expired'))
      -- Reconciliation re-marks a stuck 'processing' chunk back to
      -- 'dispatched' to redispatch it under a new Workflow instance id.
      or (v_old->>'status'='processing' and v_new->>'status' in ('dispatched','completed','failed','cancelled','expired'))
      or (v_old->>'status'='failed' and v_new->>'status'='expired')) then
    raise exception 'Invalid gallery import chunk transition' using errcode='23514';
  end if;
  if tg_table_name = 'gallery_import_cluster_results' then
    if v_old->>'state'<>'pending' and (v_new->'state',v_new->'skip_reason',v_new->'candidate_count',v_new->'completed_at')
      is distinct from (v_old->'state',v_old->'skip_reason',v_old->'candidate_count',v_old->'completed_at') then
      raise exception 'Terminal gallery cluster result is immutable' using errcode='23514';
    end if;
    if v_new->>'state' is distinct from v_old->>'state' and not (v_old->>'state'='pending' and v_new->>'state' in ('completed','skipped','refused','invalid_preview','failed')) then
      raise exception 'Invalid gallery cluster result transition' using errcode='23514';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.claim_stale_gallery_chunks(p_limit integer default 50)
returns table (chunk_id uuid, run_id uuid, dispatch_attempts smallint)
language plpgsql security definer set search_path = public as $$
declare v_chunk record;
begin
  for v_chunk in
    select c.id, c.run_id, c.dispatch_attempts
    from public.gallery_import_chunks c
    join public.gallery_import_runs r on r.id = c.run_id
    where c.status in ('dispatched','processing')
      and c.dispatched_at < transaction_timestamp() - interval '20 minutes'
      and r.status not in ('cancelled','expired','failed','completed')
      and r.expires_at > transaction_timestamp()
    order by c.dispatched_at
    limit greatest(1, least(coalesce(p_limit,50), 200))
    for update of c skip locked
  loop
    if v_chunk.dispatch_attempts >= 3 then
      perform public.fail_gallery_chunk(v_chunk.id, 'GALLERY_RECONCILE_EXHAUSTED');
    else
      chunk_id := v_chunk.id;
      run_id := v_chunk.run_id;
      dispatch_attempts := v_chunk.dispatch_attempts;
      return next;
    end if;
  end loop;
  return;
end;
$$;
revoke all on function public.claim_stale_gallery_chunks(integer) from public, anon, authenticated;
grant execute on function public.claim_stale_gallery_chunks(integer) to service_role;

-- Fixes a real control-flow bug: `return query` in plpgsql appends rows to
-- the result set but does not exit the function. Previously, whenever an
-- attempt row already existed for (chunk, cluster, ordinal) -- regardless
-- of its state, including a legitimately terminal 'ambiguous' one -- this
-- function queued the correct 'already_reserved'/'denied' row and then fell
-- through into the unconditional insert below, which raised a unique-
-- constraint violation on (chunk_id, cluster_signature, attempt_ordinal)
-- instead of ever returning to the caller. A re-dispatched Workflow retrying
-- an ordinal whose earlier attempt went 'ambiguous' therefore could not
-- observe 'denied' and move on to the next ordinal; it errored instead.
create or replace function public.reserve_gallery_attempt(p_chunk_id uuid, p_cluster_signature text, p_attempt_ordinal smallint)
returns table (attempt_id uuid, reservation_token uuid, outcome text) language plpgsql security definer set search_path = public as $$
declare v_attempt public.gallery_import_provider_attempts%rowtype;
begin
  if not exists (
    select 1 from public.gallery_import_assets a
    join public.gallery_import_chunks c on c.id=a.chunk_id
    join public.gallery_import_runs r on r.id=c.run_id
    where a.chunk_id=p_chunk_id and a.cluster_signature=p_cluster_signature
      and c.status in ('dispatched','processing') and r.status in ('processing','reviewing')
      and r.expires_at > transaction_timestamp()
      and p_attempt_ordinal between 1 and (r.limit_snapshot->>'maxProviderAttemptsPerCluster')::smallint
      and exists (select 1 from public.gallery_import_cluster_results cr where cr.chunk_id=c.id and cr.cluster_signature=p_cluster_signature and cr.state='pending')
  ) then
    return query select null::uuid,null::uuid,'denied'::text;
    return;
  end if;
  select * into v_attempt from public.gallery_import_provider_attempts where chunk_id=p_chunk_id and cluster_signature=p_cluster_signature and attempt_ordinal=p_attempt_ordinal for update;
  if found then
    if v_attempt.state in ('reserved','inflight') then
      return query select v_attempt.id,v_attempt.reservation_token,'already_reserved'::text;
    else
      -- Terminal at this exact ordinal (completed/failed/ambiguous/cancelled):
      -- consumed, and can never be reserved again.
      return query select v_attempt.id,null::uuid,'denied'::text;
    end if;
    return;
  end if;
  insert into public.gallery_import_provider_attempts (chunk_id,cluster_signature,provider,attempt_ordinal,state,started_at)
    values (p_chunk_id,p_cluster_signature,'openai',p_attempt_ordinal,'inflight',transaction_timestamp()) returning * into v_attempt;
  return query select v_attempt.id,v_attempt.reservation_token,'reserved_now'::text;
end;
$$;

create or replace function public.fail_gallery_cluster(p_chunk_id uuid, p_cluster_signature text, p_closed_error_code text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_chunk public.gallery_import_chunks%rowtype; v_updated boolean;
begin
  if p_closed_error_code is null or p_closed_error_code !~ '^[A-Z0-9_]{1,64}$' then raise exception 'Invalid closed error code' using errcode='22023'; end if;
  select * into v_chunk from public.gallery_import_chunks where id=p_chunk_id for update;
  if not found then raise exception 'Chunk not found' using errcode='P0002'; end if;
  update public.gallery_import_cluster_results
    set state='failed', completed_at=transaction_timestamp(), updated_at=transaction_timestamp()
    where chunk_id=p_chunk_id and cluster_signature=p_cluster_signature and state='pending';
  v_updated := found;
  if not exists (select 1 from public.gallery_import_cluster_results where chunk_id=p_chunk_id and state='pending') then
    update public.gallery_import_chunks set status='completed',completed_at=transaction_timestamp() where id=p_chunk_id and status not in ('completed','failed','cancelled','expired');
    update public.gallery_import_runs set status='reviewing'
      where id=v_chunk.run_id and status in ('scanning','processing')
        and not exists (select 1 from public.gallery_import_chunks c where c.run_id=v_chunk.run_id and c.status not in ('completed','failed','cancelled','expired'));
  end if;
  return v_updated;
end;
$$;
revoke all on function public.fail_gallery_cluster(uuid,text,text) from public, anon, authenticated;
grant execute on function public.fail_gallery_cluster(uuid,text,text) to service_role;

-- Server-computed fair-use snapshot for the client status DTO (S1). Reads
-- live, unlike limit_snapshot: the daily cap is a rolling family-wide fence,
-- not a per-run admitted quantity.
create or replace function public.get_gallery_import_fair_use(p_family_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_limit smallint; v_used integer; v_excess integer; v_reset_at timestamptz;
begin
  select daily_cluster_limit into v_limit from public.gallery_import_admission_settings where singleton;
  select count(*) into v_used
    from public.gallery_import_cluster_results cr
    join public.gallery_import_chunks c on c.id=cr.chunk_id
    join public.gallery_import_runs r on r.id=c.run_id
    where r.family_id=p_family_id and cr.created_at > transaction_timestamp() - interval '24 hours';
  v_excess := coalesce(v_used,0) - v_limit + 1;
  if v_excess > 0 then
    -- Same precision fix as register_gallery_import_chunk's hint: the
    -- family is only genuinely un-paused once v_excess rows (not just the
    -- single oldest) have aged out of the window.
    select cr.created_at into v_reset_at
      from public.gallery_import_cluster_results cr
      join public.gallery_import_chunks c on c.id=cr.chunk_id
      join public.gallery_import_runs r on r.id=c.run_id
      where r.family_id=p_family_id and cr.created_at > transaction_timestamp() - interval '24 hours'
      order by cr.created_at
      offset v_excess - 1
      limit 1;
  end if;
  return jsonb_build_object(
    'used', coalesce(v_used,0),
    'limit', v_limit,
    'resets_at', case when coalesce(v_used,0) >= v_limit
      then to_char(timezone('utc', coalesce(v_reset_at, transaction_timestamp()) + interval '24 hours'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      else null end
  );
end;
$$;
revoke all on function public.get_gallery_import_fair_use(uuid) from public, anon, authenticated;
grant execute on function public.get_gallery_import_fair_use(uuid) to service_role;
