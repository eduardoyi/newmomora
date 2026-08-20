-- Completed gallery runs retain their staging data until the review TTL ends.
-- Once due, they must enter the same fenced cleanup path as every other
-- expired run so transient R2 previews cannot be retained indefinitely.

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
      or (v_old->>'status'='processing' and v_new->>'status' in ('completed','failed','cancelled','expired'))
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
create or replace function public.claim_gallery_import_cleanup(p_limit integer default 50)
returns table (run_id uuid, claim_token uuid) language plpgsql security definer set search_path = public as $$
begin
  return query
  with candidates as (
    select r.id from public.gallery_import_runs r
    where (r.expires_at <= transaction_timestamp() or r.status='cancelled')
      and r.status <> 'expired'
      and (r.cleanup_claimed_at is null or r.cleanup_claimed_at < transaction_timestamp()-interval '10 minutes')
    order by r.expires_at limit greatest(1,least(coalesce(p_limit,50),200)) for update skip locked
  ), claimed as (
    update public.gallery_import_runs r set cleanup_claim_token=gen_random_uuid(),cleanup_claimed_at=transaction_timestamp(),status='expired'
    from candidates c where r.id=c.id returning r.id,r.cleanup_claim_token
  ) select id,cleanup_claim_token from claimed;
end;
$$;
drop index if exists public.gallery_import_runs_cleanup_idx;
create index gallery_import_runs_cleanup_idx
  on public.gallery_import_runs (expires_at) where status <> 'expired';
