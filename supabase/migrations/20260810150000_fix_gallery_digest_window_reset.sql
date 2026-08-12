-- A successfully sent digest retains its row with a zero count and null
-- window timestamps. The next approval must start a new quiet window, not
-- merely increment the count while leaving first_approval_at null.

create or replace function public.finalize_gallery_import_candidate(p_candidate_id uuid, p_capability text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_candidate public.gallery_import_candidates%rowtype; v_lease public.gallery_import_approval_leases%rowtype; v_asset jsonb; v_position integer := 0; v_first_key text; v_first_type text;
begin
  select run_id into v_candidate.run_id from public.gallery_import_candidates where id=p_candidate_id;
  if v_candidate.run_id is null then raise exception 'Candidate not found' using errcode='P0002'; end if;
  perform public.gallery_import_require_actor_run(v_candidate.run_id,p_capability);
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
