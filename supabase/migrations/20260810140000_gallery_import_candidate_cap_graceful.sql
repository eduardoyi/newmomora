-- Candidate admission is bounded per run. Reaching the server-owned cap is a
-- normal terminal outcome for later model groups, not a chunk/workflow error.
create or replace function public.publish_gallery_candidates(p_chunk_id uuid, p_candidates jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare v_chunk public.gallery_import_chunks%rowtype; v_run public.gallery_import_runs%rowtype; v_item jsonb; v_count integer := 0; v_tokens uuid[]; v_candidate_id uuid; v_candidate_fingerprint text; v_split_index smallint;
begin
  if p_candidates is null or jsonb_typeof(p_candidates) <> 'array' or jsonb_array_length(p_candidates)>300 then raise exception 'Invalid candidate publication' using errcode='22023'; end if;
  select * into v_chunk from public.gallery_import_chunks where id=p_chunk_id for update;
  if not found then raise exception 'Chunk not found' using errcode='P0002'; end if;
  select * into v_run from public.gallery_import_runs where id=v_chunk.run_id for update;
  if v_run.status in ('cancelled','expired','failed') or v_run.expires_at <= transaction_timestamp() then raise exception 'Run is closed' using errcode='P0001'; end if;
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
