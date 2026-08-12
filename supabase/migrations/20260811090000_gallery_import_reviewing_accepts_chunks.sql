-- Streaming-while-reviewing is the designed behavior: the run flips to
-- 'reviewing' the instant its FIRST chunk finishes AI processing (see
-- publish_gallery_cluster_result / fail_gallery_chunk below), while the
-- device is still serially registering/uploading/dispatching the remaining
-- planned chunks of a real library. register_gallery_import_chunk's guard
-- only accepted ('scanning','processing'), so every chunk registered after
-- the first one completed was refused with 'Import run is not accepting
-- chunks' -- silently, because the client's registration failure was never
-- surfaced as a distinguishable error (see the companion client-side fix in
-- gallery-import-runner.ts). Device-verified: run d7efe5b5 admitted only 12
-- of ~61 clusters from a 16-chunk plan before the rest were refused; the
-- deck's "+51 coming" counter never resolved because the review UI expects
-- late chunks to keep landing while 'reviewing' is active.
--
-- Every other RPC in the chunk pipeline was audited against this same race
-- (register_gallery_import_assets, record_gallery_import_preview_upload,
-- mark_gallery_chunk_dispatched, get_gallery_chunk_input,
-- reserve_gallery_attempt, publish_gallery_candidates/
-- publish_gallery_cluster_result) and each already gates on chunk-level
-- status and/or the terminal run states (cancelled/expired/failed/completed)
-- rather than the ('scanning','processing') allowlist -- only this function
-- needed widening. A run must still never accept a chunk once it is
-- genuinely terminal, so 'Import run is not accepting chunks' is preserved
-- for cancelled/expired/failed/completed runs.

create or replace function public.register_gallery_import_chunk(
  p_run_id uuid, p_capability text, p_ordinal integer, p_cluster_count integer, p_asset_count integer
)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_run public.gallery_import_runs%rowtype; v_chunk public.gallery_import_chunks%rowtype; v_chunk_id uuid;
begin
  v_run := public.gallery_import_require_actor_run(p_run_id,p_capability);
  if v_run.status not in ('scanning','processing','reviewing') or v_run.expires_at <= transaction_timestamp() then raise exception 'Import run is not accepting chunks' using errcode = 'P0001'; end if;
  if p_cluster_count not between 1 and least(1000,p_asset_count) or p_asset_count not between 1 and (v_run.limit_snapshot->>'maxAssetsPerChunk')::integer then raise exception 'Invalid chunk manifest counts' using errcode = '22023'; end if;
  select * into v_chunk from public.gallery_import_chunks where run_id=p_run_id and ordinal=p_ordinal for update;
  if found then
    if v_chunk.declared_cluster_count<>p_cluster_count or v_chunk.declared_asset_count<>p_asset_count then raise exception 'Chunk replay changed manifest counts' using errcode='22023'; end if;
    return v_chunk.id;
  end if;
  if (select count(*) from public.gallery_import_chunks where run_id=p_run_id) >= (v_run.limit_snapshot->>'maxChunksPerRun')::integer
    or (select coalesce(sum(declared_asset_count),0) from public.gallery_import_chunks where run_id=p_run_id) + p_asset_count > (v_run.limit_snapshot->>'maxAssetsPerRun')::integer then raise exception 'Gallery import manifest limit reached' using errcode='P0001'; end if;
  insert into public.gallery_import_chunks (run_id,ordinal,cluster_count,asset_count,declared_cluster_count,declared_asset_count,status) values (p_run_id,p_ordinal,p_cluster_count,p_asset_count,p_cluster_count,p_asset_count,'uploading')
  returning id into v_chunk_id;
  update public.gallery_import_runs set status='processing' where id=p_run_id and status='scanning';
  return v_chunk_id;
end;
$$;
