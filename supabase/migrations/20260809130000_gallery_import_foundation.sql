-- Gallery import database foundation.
--
-- Staged camera-roll content is intentionally separated from normal memories.
-- No raw platform asset identifier, filename, GPS value, model prompt, or model
-- response belongs in these tables.  The opaque tokens below are run-scoped
-- server identifiers; the originating device keeps the OS-ID mapping locally.

alter table public.memories
  add column if not exists creation_source text not null default 'manual';
alter table public.memories
  drop constraint if exists memories_creation_source_check,
  add constraint memories_creation_source_check
    check (creation_source in ('manual', 'onboarding', 'gallery_import'));
revoke insert (creation_source) on public.memories from public, anon, authenticated;
revoke update (creation_source) on public.memories from public, anon, authenticated;
alter table public.families
  add column if not exists gallery_caption_language text not null default 'en-US',
  add column if not exists gallery_caption_instructions text not null default '';
alter table public.families
  drop constraint if exists families_gallery_caption_language_check,
  add constraint families_gallery_caption_language_check
    check (gallery_caption_language ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  drop constraint if exists families_gallery_caption_instructions_check,
  add constraint families_gallery_caption_instructions_check
    check (
      char_length(gallery_caption_instructions) <= 500
      and gallery_caption_instructions !~ '[[:cntrl:]]'
    );
revoke insert (gallery_caption_language, gallery_caption_instructions) on public.families from public, anon, authenticated;
revoke update (gallery_caption_language, gallery_caption_instructions) on public.families from public, anon, authenticated;
create table public.gallery_import_admission_settings (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  normal_monthly_run_limit smallint not null default 1 check (normal_monthly_run_limit between 1 and 12),
  initial_run_limit smallint not null default 2 check (initial_run_limit between 1 and 4),
  initial_window interval not null default interval '30 days' check (initial_window = interval '30 days'),
  review_ttl interval not null default interval '30 days' check (review_ttl between interval '1 day' and interval '90 days'),
  quiet_period interval not null default interval '30 minutes' check (quiet_period = interval '30 minutes'),
  limit_template jsonb not null default '{"maxChunksPerRun":20,"maxAssetsPerRun":1000,"maxAssetsPerChunk":100,"maxCandidatesPerRun":60,"maxProviderAttemptsPerCluster":3,"maxImagesPerCluster":10,"maxPreviewBytes":1500000}'::jsonb
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
      and (limit_template->>'maxChunksPerRun')::integer between 1 and 100
      and (limit_template->>'maxAssetsPerRun')::integer between 1 and 10000
      and (limit_template->>'maxAssetsPerChunk')::integer between 1 and 500
      and (limit_template->>'maxCandidatesPerRun')::integer between 1 and 300
      and (limit_template->>'maxProviderAttemptsPerCluster')::integer between 1 and 3
      and (limit_template->>'maxImagesPerCluster')::integer between 1 and 10
      and (limit_template->>'maxPreviewBytes')::integer between 1024 and 1500000),
  policy_epoch integer not null default 1 check (policy_epoch > 0),
  updated_at timestamptz not null default transaction_timestamp()
);
insert into public.gallery_import_admission_settings (singleton) values (true)
on conflict (singleton) do nothing;
create or replace function public.touch_gallery_import_admission_settings()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := transaction_timestamp();
  if new.normal_monthly_run_limit is distinct from old.normal_monthly_run_limit
    or new.initial_run_limit is distinct from old.initial_run_limit
    or new.review_ttl is distinct from old.review_ttl
    or new.quiet_period is distinct from old.quiet_period
    or new.limit_template is distinct from old.limit_template
    or new.enabled is distinct from old.enabled then
    new.policy_epoch := old.policy_epoch + 1;
  end if;
  return new;
end;
$$;
create trigger touch_gallery_import_admission_settings
  before update on public.gallery_import_admission_settings
  for each row execute function public.touch_gallery_import_admission_settings();
create table public.gallery_import_runs (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete cascade,
  capability_hash text not null check (capability_hash ~ '^[0-9a-f]{64}$'),
  algorithm_version text not null check (algorithm_version ~ '^[A-Za-z0-9._-]{1,64}$'),
  consent_version text not null check (consent_version ~ '^[A-Za-z0-9._-]{1,64}$'),
  permission_mode text not null check (permission_mode in ('all', 'limited', 'selected')),
  status text not null default 'scanning' check (status in ('scanning','processing','reviewing','completed','cancelled','expired','failed')),
  limit_snapshot jsonb not null default '{}'::jsonb check (jsonb_typeof(limit_snapshot) = 'object' and octet_length(limit_snapshot::text) <= 8192),
  policy_epoch integer not null check (policy_epoch > 0),
  expires_at timestamptz not null,
  cancelled_at timestamptz,
  completed_at timestamptz,
  cleanup_claim_token uuid,
  cleanup_claimed_at timestamptz,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  unique (id, family_id),
  unique (id, actor_id)
);
create unique index gallery_import_one_active_run_per_family
  on public.gallery_import_runs (family_id)
  where status in ('scanning', 'processing', 'reviewing');
create unique index gallery_import_run_capability_hash_unique
  on public.gallery_import_runs (capability_hash);
create index gallery_import_runs_actor_active_idx
  on public.gallery_import_runs (actor_id, created_at desc);
create index gallery_import_runs_cleanup_idx
  on public.gallery_import_runs (expires_at) where status not in ('completed', 'cancelled', 'expired');
create table public.gallery_import_chunks (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.gallery_import_runs(id) on delete cascade,
  ordinal integer not null check (ordinal >= 0 and ordinal < 10000),
  workflow_id text unique check (workflow_id is null or workflow_id ~ '^[A-Za-z0-9._:-]{1,200}$'),
  status text not null default 'registered' check (status in ('registered','uploading','dispatched','processing','completed','failed','cancelled','expired')),
  cluster_count integer not null default 0 check (cluster_count between 0 and 1000),
  asset_count integer not null default 0 check (asset_count between 0 and 10000),
  declared_cluster_count integer not null check (declared_cluster_count between 1 and 1000),
  declared_asset_count integer not null check (declared_asset_count between 1 and 10000),
  closed_error_code text check (closed_error_code is null or closed_error_code ~ '^[A-Z0-9_]{1,64}$'),
  dispatched_at timestamptz,
  completed_at timestamptz,
  scrubbed_at timestamptz,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  unique (run_id, ordinal),
  check ((status in ('completed','failed','cancelled','expired') and completed_at is not null)
    or (status not in ('completed','failed','cancelled','expired') and completed_at is null))
);
create index gallery_import_chunks_run_status_idx on public.gallery_import_chunks (run_id, status, ordinal);
create table public.gallery_import_assets (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.gallery_import_runs(id) on delete cascade,
  chunk_id uuid references public.gallery_import_chunks(id) on delete set null,
  opaque_token uuid not null default gen_random_uuid(),
  cluster_signature text not null check (cluster_signature ~ '^[0-9a-f]{64}$'),
  capture_date date not null,
  width integer check (width is null or width between 1 and 200000),
  height integer check (height is null or height between 1 and 200000),
  is_favorite boolean not null default false,
  preview_object_key text check (preview_object_key is null or preview_object_key ~ '^[0-9a-f-]{36}/gallery-import/[0-9a-f-]{36}/previews/[0-9a-f-]{36}[.]jpg$'),
  preview_content_type text check (preview_content_type is null or preview_content_type = 'image/jpeg'),
  preview_width integer check (preview_width is null or preview_width between 1 and 512),
  preview_height integer check (preview_height is null or preview_height between 1 and 512),
  preview_bytes integer check (preview_bytes is null or preview_bytes between 1 and 1500000),
  preview_sha256 text check (preview_sha256 is null or preview_sha256 ~ '^[0-9a-f]{64}$'),
  preview_uploaded_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default transaction_timestamp(),
  unique (run_id, opaque_token),
  check ((preview_uploaded_at is null and preview_object_key is null and preview_content_type is null and preview_width is null and preview_height is null and preview_bytes is null and preview_sha256 is null)
    or (preview_uploaded_at is not null and preview_object_key is not null and preview_content_type is not null and preview_width is not null and preview_height is not null and preview_bytes is not null and preview_sha256 is not null))
);
create index gallery_import_assets_cluster_idx on public.gallery_import_assets (run_id, cluster_signature);
create index gallery_import_assets_cleanup_idx on public.gallery_import_assets (expires_at) where preview_object_key is not null;
create table public.gallery_import_cluster_results (
  chunk_id uuid not null references public.gallery_import_chunks(id) on delete cascade,
  cluster_signature text not null check (cluster_signature ~ '^[0-9a-f]{64}$'),
  state text not null default 'pending' check (state in ('pending','completed','skipped','refused','invalid_preview','suppressed','failed')),
  skip_reason text check (skip_reason is null or skip_reason in ('no_candidate','low_confidence','safety_refusal','invalid_provider_output','invalid_preview','provider_refusal')),
  candidate_count smallint not null default 0 check (candidate_count between 0 and 3),
  completed_at timestamptz,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  primary key (chunk_id, cluster_signature),
  check ((state='pending' and completed_at is null and skip_reason is null and candidate_count=0)
    or (state='completed' and completed_at is not null and skip_reason is null and candidate_count>0)
    or (state in ('skipped','refused','invalid_preview') and completed_at is not null and skip_reason is not null and candidate_count=0)
    or (state='suppressed' and completed_at is not null and skip_reason is null and candidate_count=0)
    or (state='failed' and completed_at is not null and candidate_count=0))
);
create or replace function public.gallery_import_uuid_array_is_distinct(p_values uuid[])
returns boolean language sql immutable strict set search_path = public as $$
  select cardinality(p_values) = (select count(distinct value) from unnest(p_values) value);
$$;
create table public.gallery_import_candidates (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.gallery_import_runs(id) on delete cascade,
  chunk_id uuid references public.gallery_import_chunks(id) on delete set null,
  family_id uuid not null references public.families(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete cascade,
  cluster_signature text not null check (cluster_signature ~ '^[0-9a-f]{64}$'),
  candidate_fingerprint text not null check (candidate_fingerprint ~ '^[0-9a-f]{64}$'),
  split_index smallint not null default 0 check (split_index between 0 and 2),
  status text not null default 'staged' check (status in ('staged','posting','approved','skipped','unavailable','expired')),
  caption text not null check (char_length(btrim(caption)) between 1 and 1000 and caption !~ '[[:cntrl:]]'),
  memory_date date not null,
  emotion text check (emotion is null or emotion in ('joy','funny','calm','wonder','tender','mischief','pride','bittersweet','worry','weary','sad')),
  confidence double precision not null check (confidence >= 0 and confidence <= 1),
  selected_asset_tokens uuid[] not null check (cardinality(selected_asset_tokens) between 1 and 10 and public.gallery_import_uuid_array_is_distinct(selected_asset_tokens)),
  family_member_ids uuid[] not null default '{}'::uuid[],
  memory_id uuid references public.memories(id) on delete set null,
  unavailable_reason text check (unavailable_reason is null or unavailable_reason ~ '^[A-Z0-9_]{1,64}$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  unique (run_id, cluster_signature, split_index),
  unique (run_id, candidate_fingerprint),
  unique (id, run_id),
  unique (id, family_id),
  unique (id, actor_id)
);
create index gallery_import_candidates_actor_run_idx on public.gallery_import_candidates (actor_id, run_id, status, created_at);
create index gallery_import_candidates_cleanup_idx on public.gallery_import_candidates (expires_at) where status in ('staged','posting','skipped','unavailable');
create table public.gallery_import_cluster_receipts (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete cascade,
  algorithm_version text not null check (algorithm_version ~ '^[A-Za-z0-9._-]{1,64}$'),
  cluster_signature text not null check (cluster_signature ~ '^[0-9a-f]{64}$'),
  candidate_fingerprint text not null check (candidate_fingerprint ~ '^[0-9a-f]{64}$'),
  outcome text not null check (outcome in ('skipped','approved','unavailable')),
  source_candidate_id uuid references public.gallery_import_candidates(id) on delete set null,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  unique (family_id, actor_id, algorithm_version, cluster_signature)
);
create table public.gallery_import_provider_attempts (
  id uuid primary key default gen_random_uuid(),
  chunk_id uuid not null references public.gallery_import_chunks(id) on delete cascade,
  cluster_signature text not null check (cluster_signature ~ '^[0-9a-f]{64}$'),
  attempt_ordinal smallint not null check (attempt_ordinal between 1 and 3),
  provider text not null check (provider ~ '^[a-z0-9_-]{1,64}$'),
  state text not null default 'reserved' check (state in ('reserved','inflight','completed','failed','ambiguous','cancelled')),
  reservation_token uuid not null default gen_random_uuid(),
  usage jsonb not null default '{}'::jsonb check (jsonb_typeof(usage) = 'object' and octet_length(usage::text) <= 4096),
  closed_error_code text check (closed_error_code is null or closed_error_code ~ '^[A-Z0-9_]{1,64}$'),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default transaction_timestamp(),
  unique (chunk_id, cluster_signature, attempt_ordinal),
  unique (id, reservation_token)
);
create table public.gallery_import_approval_leases (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null unique references public.gallery_import_candidates(id) on delete cascade,
  run_id uuid not null references public.gallery_import_runs(id) on delete cascade,
  family_id uuid not null references public.families(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete cascade,
  memory_id uuid not null unique default gen_random_uuid(),
  lease_token_hash text not null check (lease_token_hash ~ '^[0-9a-f]{64}$'),
  expected_assets jsonb not null check (jsonb_typeof(expected_assets) = 'array' and jsonb_array_length(expected_assets) between 1 and 10 and octet_length(expected_assets::text) <= 16384),
  uploaded_assets jsonb not null default '[]'::jsonb check (jsonb_typeof(uploaded_assets) = 'array' and jsonb_array_length(uploaded_assets) <= 10 and octet_length(uploaded_assets::text) <= 16384),
  state text not null default 'reserved' check (state in ('reserved','uploading','finalizing','finalized','cancelled','expired','orphaned')),
  expires_at timestamptz not null,
  finalized_at timestamptz,
  cleanup_claim_token uuid,
  cleanup_claimed_at timestamptz,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  unique (id, candidate_id)
);
create index gallery_import_approval_leases_cleanup_idx on public.gallery_import_approval_leases (expires_at) where state in ('reserved','uploading','finalizing','expired','orphaned');
create table public.gallery_import_digest_windows (
  family_id uuid not null references public.families(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete cascade,
  approval_count integer not null default 0 check (approval_count >= 0),
  first_approval_at timestamptz,
  last_approval_at timestamptz,
  claimed_at timestamptz,
  claim_token uuid,
  claimed_approval_count integer check (claimed_approval_count is null or claimed_approval_count > 0),
  sent_at timestamptz,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  primary key (family_id, actor_id),
  check ((approval_count = 0 and first_approval_at is null and last_approval_at is null) or (approval_count > 0 and first_approval_at is not null and last_approval_at is not null)),
  check ((claim_token is null and claimed_at is null and claimed_approval_count is null)
    or (claim_token is not null and claimed_at is not null and claimed_approval_count between 1 and approval_count))
);
create table public.gallery_import_workflow_bridge_nonces (
  nonce uuid primary key,
  created_at timestamptz not null default transaction_timestamp(),
  expires_at timestamptz not null default (transaction_timestamp() + interval '10 minutes'),
  check (expires_at > created_at and expires_at <= created_at + interval '24 hours')
);
create index gallery_import_bridge_nonces_expiry_idx on public.gallery_import_workflow_bridge_nonces (expires_at);
create or replace function public.gallery_import_set_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at := transaction_timestamp(); return new; end;
$$;
create trigger gallery_import_runs_updated_at before update on public.gallery_import_runs for each row execute function public.gallery_import_set_updated_at();
create trigger gallery_import_chunks_updated_at before update on public.gallery_import_chunks for each row execute function public.gallery_import_set_updated_at();
create trigger gallery_import_candidates_updated_at before update on public.gallery_import_candidates for each row execute function public.gallery_import_set_updated_at();
create trigger gallery_import_receipts_updated_at before update on public.gallery_import_cluster_receipts for each row execute function public.gallery_import_set_updated_at();
create trigger gallery_import_leases_updated_at before update on public.gallery_import_approval_leases for each row execute function public.gallery_import_set_updated_at();
create trigger gallery_import_digest_updated_at before update on public.gallery_import_digest_windows for each row execute function public.gallery_import_set_updated_at();
-- Candidate inserts are service-owned, but this catches a malformed worker
-- publication even if its JSON validation regresses.
create or replace function public.validate_gallery_import_candidate_assets()
returns trigger language plpgsql set search_path = public as $$
declare v_token uuid; v_count integer; v_member uuid; v_expected_fingerprint text;
begin
  if not exists (select 1 from public.gallery_import_runs r where r.id = new.run_id and r.family_id = new.family_id and r.actor_id = new.actor_id) then
    raise exception 'Candidate run, family, and actor must agree' using errcode = '23514';
  end if;
  foreach v_token in array new.selected_asset_tokens loop
    if not exists (
      select 1 from public.gallery_import_assets a
      where a.run_id = new.run_id and a.opaque_token = v_token and a.cluster_signature = new.cluster_signature
    ) then raise exception 'Candidate token is not in this run cluster' using errcode = '23514'; end if;
  end loop;
  select encode(extensions.digest(new.run_id::text || ':' || new.cluster_signature || ':' || string_agg(a.opaque_token::text, ',' order by a.opaque_token::text), 'sha256'), 'hex')
    into v_expected_fingerprint
    from public.gallery_import_assets a
    where a.run_id=new.run_id and a.cluster_signature=new.cluster_signature and a.opaque_token=any(new.selected_asset_tokens);
  if v_expected_fingerprint is distinct from new.candidate_fingerprint then
    raise exception 'Candidate fingerprint does not match selected pseudonymous assets' using errcode = '23514';
  end if;
  select count(*) into v_count from (select distinct unnest(new.family_member_ids) as id) s;
  if v_count <> cardinality(new.family_member_ids) then raise exception 'Candidate tags must be unique' using errcode = '23514'; end if;
  foreach v_member in array new.family_member_ids loop
    if not exists (select 1 from public.family_members fm where fm.id=v_member and fm.family_id=new.family_id) then
      raise exception 'Candidate tag is outside family' using errcode = '23514';
    end if;
  end loop;
  return new;
end;
$$;
create trigger validate_gallery_import_candidate_assets
  before insert or update of run_id, family_id, actor_id, cluster_signature, candidate_fingerprint, selected_asset_tokens, family_member_ids
  on public.gallery_import_candidates for each row execute function public.validate_gallery_import_candidate_assets();
create or replace function public.protect_gallery_import_preview_manifest()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.preview_uploaded_at is not null and (
    new.preview_object_key,new.preview_content_type,new.preview_width,new.preview_height,new.preview_bytes,new.preview_sha256
  ) is distinct from (
    old.preview_object_key,old.preview_content_type,old.preview_width,old.preview_height,old.preview_bytes,old.preview_sha256
  ) then raise exception 'Verified gallery preview manifest is immutable' using errcode='42501'; end if;
  return new;
end;
$$;
create trigger protect_gallery_import_preview_manifest before update of preview_object_key,preview_content_type,preview_width,preview_height,preview_bytes,preview_sha256 on public.gallery_import_assets for each row execute function public.protect_gallery_import_preview_manifest();
create or replace function public.enforce_gallery_import_transitions()
returns trigger language plpgsql set search_path = public as $$
declare v_new jsonb := to_jsonb(new); v_old jsonb := to_jsonb(old);
begin
  if tg_table_name = 'gallery_import_runs' and v_new->>'status' is distinct from v_old->>'status'
    and not ((v_old->>'status'='scanning' and v_new->>'status' in ('processing','reviewing','cancelled','expired','failed'))
      or (v_old->>'status'='processing' and v_new->>'status' in ('reviewing','cancelled','expired','failed'))
      or (v_old->>'status'='reviewing' and v_new->>'status' in ('completed','cancelled','expired','failed'))
      or (v_old->>'status' in ('cancelled','failed') and v_new->>'status'='expired')) then
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
create trigger enforce_gallery_import_run_transitions before update of status on public.gallery_import_runs for each row execute function public.enforce_gallery_import_transitions();
create trigger enforce_gallery_import_chunk_transitions before update of status on public.gallery_import_chunks for each row execute function public.enforce_gallery_import_transitions();
create trigger enforce_gallery_import_candidate_transitions before update of status on public.gallery_import_candidates for each row execute function public.enforce_gallery_import_transitions();
create trigger enforce_gallery_import_cluster_result_transitions before update of state,skip_reason,candidate_count,completed_at on public.gallery_import_cluster_results for each row execute function public.enforce_gallery_import_transitions();
create or replace function public.protect_gallery_import_run_identity()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.family_id is distinct from old.family_id
    or new.actor_id is distinct from old.actor_id
    or new.capability_hash is distinct from old.capability_hash
    or new.algorithm_version is distinct from old.algorithm_version
    or new.consent_version is distinct from old.consent_version
    or new.permission_mode is distinct from old.permission_mode
    or new.limit_snapshot is distinct from old.limit_snapshot
    or new.policy_epoch is distinct from old.policy_epoch then
    raise exception 'Gallery import run identity is immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger protect_gallery_import_run_identity
  before update on public.gallery_import_runs
  for each row execute function public.protect_gallery_import_run_identity();
create or replace function public.gallery_import_capability_matches(p_run_id uuid, p_capability text)
returns boolean language sql security definer stable set search_path = public as $$
  select p_capability is not null
    and char_length(p_capability) between 32 and 512
    and exists (
      select 1 from public.gallery_import_runs r
      where r.id = p_run_id
        and r.capability_hash = encode(extensions.digest(p_capability, 'sha256'), 'hex')
    );
$$;
create or replace function public.gallery_import_require_actor_run(p_run_id uuid, p_capability text)
returns public.gallery_import_runs language plpgsql security definer set search_path = public as $$
declare v_run public.gallery_import_runs%rowtype;
begin
  if auth.uid() is null then raise exception 'Unauthorized' using errcode = '28000'; end if;
  if public.is_anonymous_user() then raise exception 'Anonymous accounts cannot import a gallery' using errcode = '42501'; end if;
  select * into v_run from public.gallery_import_runs where id = p_run_id for update;
  if not found or v_run.actor_id <> auth.uid() or not public.gallery_import_capability_matches(p_run_id, p_capability) then
    raise exception 'Gallery import not found' using errcode = 'P0002';
  end if;
  if not public.has_family_role(v_run.family_id, array['owner','manager'])
    or not exists (select 1 from public.families f where f.id=v_run.family_id and f.deleted_at is null) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  return v_run;
end;
$$;
create or replace function public.create_gallery_import_run_internal(
  p_family_id uuid,
  p_capability text,
  p_algorithm_version text,
  p_consent_version text,
  p_permission_mode text
)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_settings public.gallery_import_admission_settings%rowtype; v_run_id uuid; v_initial_count integer; v_monthly_count integer; v_now timestamptz := transaction_timestamp();
begin
  if auth.uid() is null then raise exception 'Unauthorized' using errcode = '28000'; end if;
  if public.is_anonymous_user() or not public.has_family_role(p_family_id, array['owner','manager']) then raise exception 'Not authorized' using errcode = '42501'; end if;
  if not public.billing_write_allowed(p_family_id, auth.uid()) then raise exception 'Subscription required' using errcode = 'P0001'; end if;
  if p_capability is null or char_length(p_capability) < 32 or char_length(p_capability) > 512 then raise exception 'Invalid import capability' using errcode = '22023'; end if;
  select * into v_settings from public.gallery_import_admission_settings where singleton for share;
  if not v_settings.enabled then raise exception 'Gallery import is not available' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtextextended('gallery-import:' || p_family_id::text, 0));
  if exists (select 1 from public.gallery_import_runs where family_id=p_family_id and status in ('scanning','processing','reviewing')) then raise exception 'A gallery import is already active' using errcode = 'P0001'; end if;
  select count(*) into v_initial_count from public.gallery_import_runs r join public.families f on f.id=r.family_id
    where r.family_id=p_family_id and r.created_at < f.created_at + v_settings.initial_window;
  if v_now >= (select created_at + v_settings.initial_window from public.families where id=p_family_id) or v_initial_count >= v_settings.initial_run_limit then
    select count(*) into v_monthly_count from public.gallery_import_runs
      where family_id=p_family_id and created_at >= date_trunc('month', v_now at time zone 'UTC')::timestamp at time zone 'UTC';
    if v_monthly_count >= v_settings.normal_monthly_run_limit then raise exception 'Gallery import limit reached' using errcode = 'P0001'; end if;
  end if;
  insert into public.gallery_import_runs (family_id, actor_id, capability_hash, algorithm_version, consent_version, permission_mode, limit_snapshot, policy_epoch, expires_at)
  values (p_family_id, auth.uid(), encode(extensions.digest(p_capability, 'sha256'), 'hex'), p_algorithm_version, p_consent_version, p_permission_mode, v_settings.limit_template, v_settings.policy_epoch, v_now + v_settings.review_ttl)
  returning id into v_run_id;
  return v_run_id;
end;
$$;
create or replace function public.get_gallery_import_run(p_run_id uuid, p_capability text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_run public.gallery_import_runs%rowtype;
begin
  v_run := public.gallery_import_require_actor_run(p_run_id, p_capability);
  return jsonb_build_object('id',v_run.id,'familyId',v_run.family_id,'status',v_run.status,'permissionMode',v_run.permission_mode,'expiresAt',v_run.expires_at,'createdAt',v_run.created_at,
    'chunks', (select count(*) from public.gallery_import_chunks c where c.run_id=v_run.id),
    'readyCandidates', (select count(*) from public.gallery_import_candidates c where c.run_id=v_run.id and c.status='staged'));
end;
$$;
create or replace function public.get_gallery_import_candidates(p_run_id uuid, p_capability text)
returns setof public.gallery_import_candidates language plpgsql security definer set search_path = public as $$
declare v_run public.gallery_import_runs%rowtype;
begin
  v_run := public.gallery_import_require_actor_run(p_run_id, p_capability);
  return query select c.* from public.gallery_import_candidates c where c.run_id=v_run.id and c.status in ('staged','posting','skipped','unavailable') and c.expires_at > transaction_timestamp() order by c.created_at;
end;
$$;
create or replace function public.register_gallery_import_chunk(
  p_run_id uuid, p_capability text, p_ordinal integer, p_cluster_count integer, p_asset_count integer
)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_run public.gallery_import_runs%rowtype; v_chunk public.gallery_import_chunks%rowtype; v_chunk_id uuid;
begin
  v_run := public.gallery_import_require_actor_run(p_run_id,p_capability);
  if v_run.status not in ('scanning','processing') or v_run.expires_at <= transaction_timestamp() then raise exception 'Import run is not accepting chunks' using errcode = 'P0001'; end if;
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
    update public.gallery_import_runs set status='reviewing' where id=v_run.id and status in ('scanning','processing');
  end if;
  return jsonb_build_object('acceptedAssetTokens',v_accepted,'suppressedClusterSignatures',(select coalesce(array_agg(distinct s order by s),'{}'::text[]) from unnest(v_suppressed) s));
end;
$$;
create or replace function public.record_gallery_import_preview_upload(
  p_run_id uuid, p_opaque_token uuid, p_object_key text, p_content_type text, p_width integer, p_height integer, p_bytes integer, p_sha256 text
)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_asset public.gallery_import_assets%rowtype; v_run public.gallery_import_runs%rowtype; v_expected_key text;
begin
  select * into v_asset from public.gallery_import_assets where run_id=p_run_id and opaque_token=p_opaque_token for update;
  if not found then return false; end if;
  select * into v_run from public.gallery_import_runs where id=p_run_id;
  v_expected_key := v_run.actor_id::text || '/gallery-import/' || p_run_id::text || '/previews/' || p_opaque_token::text || '.jpg';
  if p_object_key is distinct from v_expected_key or p_content_type <> 'image/jpeg' or p_width not between 1 and 512 or p_height not between 1 and 512
    or p_bytes not between 1 and (v_run.limit_snapshot->>'maxPreviewBytes')::integer or p_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'Invalid preview verification metadata' using errcode='22023'; end if;
  if v_asset.preview_uploaded_at is not null and (v_asset.preview_object_key,v_asset.preview_content_type,v_asset.preview_width,v_asset.preview_height,v_asset.preview_bytes,v_asset.preview_sha256) is distinct from (p_object_key,p_content_type,p_width,p_height,p_bytes,p_sha256) then raise exception 'Preview manifest replay differs' using errcode='42501'; end if;
  update public.gallery_import_assets set preview_object_key=p_object_key,preview_content_type=p_content_type,preview_width=p_width,preview_height=p_height,preview_bytes=p_bytes,preview_sha256=p_sha256,preview_uploaded_at=coalesce(preview_uploaded_at,transaction_timestamp())
    where run_id=p_run_id and opaque_token=p_opaque_token and expires_at > transaction_timestamp();
  return found;
end;
$$;
create or replace function public.mark_gallery_chunk_dispatched(p_chunk_id uuid, p_workflow_id text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.gallery_import_chunks set workflow_id=p_workflow_id,status='dispatched',dispatched_at=transaction_timestamp()
    where id=p_chunk_id and status in ('registered','uploading','dispatched')
      and asset_count=(select count(*) from public.gallery_import_assets a where a.chunk_id=p_chunk_id)
      and not exists (select 1 from public.gallery_import_assets a where a.chunk_id=p_chunk_id and a.preview_uploaded_at is null);
  return found;
end;
$$;
create or replace function public.update_gallery_import_candidate_draft(
  p_candidate_id uuid, p_capability text, p_caption text, p_memory_date date, p_asset_tokens uuid[], p_family_member_ids uuid[] default '{}'::uuid[]
)
returns public.gallery_import_candidates language plpgsql security definer set search_path = public as $$
declare v_candidate public.gallery_import_candidates%rowtype; v_run public.gallery_import_runs%rowtype; v_fingerprint text;
begin
  select r.* into v_run from public.gallery_import_runs r join public.gallery_import_candidates c on c.run_id=r.id where c.id=p_candidate_id;
  if not found then raise exception 'Candidate not found' using errcode='P0002'; end if;
  v_run := public.gallery_import_require_actor_run(v_run.id,p_capability);
  select * into v_candidate from public.gallery_import_candidates where id=p_candidate_id for update;
  if v_candidate.status not in ('staged','unavailable') or v_candidate.expires_at <= transaction_timestamp() then raise exception 'Candidate cannot be edited' using errcode='P0001'; end if;
  if cardinality(p_asset_tokens) not between 1 and (v_run.limit_snapshot->>'maxImagesPerCluster')::integer or not public.gallery_import_uuid_array_is_distinct(p_asset_tokens) then raise exception 'Invalid candidate asset selection' using errcode='22023'; end if;
  select encode(extensions.digest(v_run.id::text || ':' || v_candidate.cluster_signature || ':' || string_agg(a.opaque_token::text,',' order by a.opaque_token::text),'sha256'),'hex')
    into v_fingerprint from public.gallery_import_assets a
    where a.run_id=v_run.id and a.cluster_signature=v_candidate.cluster_signature and a.opaque_token=any(p_asset_tokens);
  if v_fingerprint is null or (select count(*) from public.gallery_import_assets a where a.run_id=v_run.id and a.cluster_signature=v_candidate.cluster_signature and a.opaque_token=any(p_asset_tokens))<>cardinality(p_asset_tokens) then raise exception 'Candidate selection is outside its cluster' using errcode='22023'; end if;
  update public.gallery_import_candidates set caption=p_caption,memory_date=p_memory_date,selected_asset_tokens=p_asset_tokens,candidate_fingerprint=v_fingerprint,family_member_ids=coalesce(p_family_member_ids,'{}'::uuid[]),status='staged',unavailable_reason=null where id=p_candidate_id returning * into v_candidate;
  return v_candidate;
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
create or replace function public.set_gallery_import_candidate_unavailable(p_candidate_id uuid, p_capability text, p_unavailable boolean)
returns public.gallery_import_candidates language plpgsql security definer set search_path = public as $$
declare v_candidate public.gallery_import_candidates%rowtype; v_run public.gallery_import_runs%rowtype; v_run_id uuid;
begin
  select run_id into v_run_id from public.gallery_import_candidates where id=p_candidate_id;
  if v_run_id is null then raise exception 'Candidate not found' using errcode='P0002'; end if;
  v_run := public.gallery_import_require_actor_run(v_run_id,p_capability);
  if v_run.status not in ('scanning','processing','reviewing') or v_run.expires_at<=transaction_timestamp() then raise exception 'Import run is not active' using errcode='P0001'; end if;
  select * into v_candidate from public.gallery_import_candidates where id=p_candidate_id for update;
  if p_unavailable and v_candidate.status='staged' then
    update public.gallery_import_candidates set status='unavailable',unavailable_reason='ORIGINAL_UNAVAILABLE' where id=p_candidate_id returning * into v_candidate;
  elsif not p_unavailable and v_candidate.status='unavailable' then
    update public.gallery_import_candidates set status='staged',unavailable_reason=null where id=p_candidate_id returning * into v_candidate;
  elsif (p_unavailable and v_candidate.status='unavailable') or (not p_unavailable and v_candidate.status='staged') then null;
  else raise exception 'Candidate cannot change availability state' using errcode='P0001'; end if;
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
create or replace function public.record_gallery_import_approval_upload(
  p_lease_id uuid, p_object_key text, p_content_type text, p_byte_length integer, p_sha256 text, p_aspect_ratio double precision default null
)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_lease public.gallery_import_approval_leases%rowtype; v_asset jsonb;
begin
  select * into v_lease from public.gallery_import_approval_leases where id=p_lease_id for update;
  if not found or v_lease.state not in ('reserved','uploading') or v_lease.expires_at <= transaction_timestamp() then return false; end if;
  if p_content_type not in ('image/jpeg','image/png','image/heic','image/heif','image/webp') or p_byte_length not between 1 and 20971520
    or (p_sha256 is not null and p_sha256 !~ '^[0-9a-f]{64}$') or (p_aspect_ratio is not null and p_aspect_ratio not between 0.1 and 10) then raise exception 'Invalid imported media metadata' using errcode='22023'; end if;
  select value into v_asset from jsonb_array_elements(v_lease.expected_assets) where value->>'objectKey'=p_object_key and value->>'contentType'=p_content_type;
  if v_asset is null then raise exception 'Object is outside approval lease' using errcode='42501'; end if;
  update public.gallery_import_approval_leases
    set state='uploading', uploaded_assets = (
      select jsonb_agg(value) from (
        select value from jsonb_array_elements(uploaded_assets) where value->>'objectKey' <> p_object_key
        union all select jsonb_strip_nulls(jsonb_build_object('objectKey',p_object_key,'contentType',p_content_type,'byteLength',p_byte_length,'sha256',p_sha256,'aspectRatio',p_aspect_ratio))
      ) s
    )
    where id=p_lease_id;
  return true;
end;
$$;
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
    on conflict (family_id,actor_id) do update set approval_count=gallery_import_digest_windows.approval_count+1, last_approval_at=excluded.last_approval_at, sent_at=null;
  return v_lease.memory_id;
end;
$$;
create or replace function public.cancel_gallery_import_run(p_run_id uuid, p_capability text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_run public.gallery_import_runs%rowtype;
begin
  v_run := public.gallery_import_require_actor_run(p_run_id,p_capability);
  if v_run.status in ('completed','cancelled','expired') then return v_run.status='cancelled'; end if;
  update public.gallery_import_runs set status='cancelled',cancelled_at=transaction_timestamp() where id=v_run.id;
  update public.gallery_import_chunks set status='cancelled',completed_at=transaction_timestamp() where run_id=v_run.id and status in ('registered','uploading','dispatched','processing');
  update public.gallery_import_approval_leases set state='cancelled' where run_id=v_run.id and state in ('reserved','uploading','finalizing');
  update public.gallery_import_candidates set status='expired',caption='Expired gallery suggestion',family_member_ids='{}'::uuid[]
    where run_id=v_run.id and status in ('staged','posting','skipped','unavailable');
  return true;
end;
$$;
create or replace function public.complete_gallery_import_run(p_run_id uuid, p_capability text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_run public.gallery_import_runs%rowtype;
begin
  v_run := public.gallery_import_require_actor_run(p_run_id,p_capability);
  if v_run.status='completed' then return true; end if;
  if v_run.status <> 'reviewing' or exists (select 1 from public.gallery_import_candidates where run_id=v_run.id and status in ('staged','posting')) then raise exception 'Gallery import still has reviewable suggestions' using errcode='P0001'; end if;
  update public.gallery_import_runs set status='completed',completed_at=transaction_timestamp() where id=v_run.id;
  return true;
end;
$$;
-- Service bridge primitives.  They are intentionally separate from the
-- authenticated capability RPCs above: Workers never receive a device
-- capability and clients never receive prompt inputs or provider attempts.
create or replace function public.get_gallery_chunk_input(p_chunk_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_chunk public.gallery_import_chunks%rowtype; v_run public.gallery_import_runs%rowtype; v_family public.families%rowtype;
begin
  select * into v_chunk from public.gallery_import_chunks where id=p_chunk_id for update;
  if not found then raise exception 'Chunk not found' using errcode='P0002'; end if;
  select * into v_run from public.gallery_import_runs where id=v_chunk.run_id;
  select * into v_family from public.families where id=v_run.family_id;
  if v_chunk.status not in ('dispatched','processing') or v_run.status in ('cancelled','expired','failed','completed') or v_run.expires_at <= transaction_timestamp() or v_family.deleted_at is not null then raise exception 'Chunk is not dispatchable' using errcode='P0001'; end if;
  if (select count(*) from public.gallery_import_assets where chunk_id=v_chunk.id) <> v_chunk.asset_count
    or exists (select 1 from public.gallery_import_assets where chunk_id=v_chunk.id and (preview_uploaded_at is null or preview_object_key is null or preview_content_type is null or preview_width is null or preview_height is null or preview_bytes is null or preview_sha256 is null)) then raise exception 'Chunk preview manifest is incomplete' using errcode='P0001'; end if;
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
      where a.chunk_id=v_chunk.id and not exists (select 1 from public.gallery_import_cluster_results r where r.chunk_id=v_chunk.id and r.cluster_signature=a.cluster_signature and r.state <> 'pending')
      group by a.cluster_signature
    ) clusters)
  );
end;
$$;
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
    if v_attempt.state in ('reserved','inflight') then return query select v_attempt.id,v_attempt.reservation_token,'already_reserved'::text;
    else return query select v_attempt.id,null::uuid,'denied'::text; end if;
  end if;
  insert into public.gallery_import_provider_attempts (chunk_id,cluster_signature,provider,attempt_ordinal,state,started_at)
    values (p_chunk_id,p_cluster_signature,'openai',p_attempt_ordinal,'inflight',transaction_timestamp()) returning * into v_attempt;
  return query select v_attempt.id,v_attempt.reservation_token,'reserved_now'::text;
end;
$$;
create or replace function public.record_gallery_usage(p_attempt_id uuid, p_reservation_token uuid, p_usage jsonb)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_status text;
begin
  if p_usage is null or jsonb_typeof(p_usage) <> 'object' or octet_length(p_usage::text)>512
    or (p_usage - array['success','providerStatus','inputTokens','outputTokens','totalTokens']) <> '{}'::jsonb
    or not (p_usage ?& array['success','providerStatus','inputTokens','outputTokens','totalTokens'])
    or jsonb_typeof(p_usage->'success') <> 'boolean'
    or jsonb_typeof(p_usage->'providerStatus') <> 'string'
    or p_usage->>'providerStatus' not in ('completed','failed','ambiguous')
    or exists (
      select 1 from (values ('inputTokens'),('outputTokens'),('totalTokens')) token(key)
      where jsonb_typeof(p_usage->token.key) not in ('number','null')
        or (jsonb_typeof(p_usage->token.key)='number' and ((p_usage->>token.key) !~ '^[0-9]+$' or (p_usage->>token.key)::numeric > 2147483647))
    ) then
    raise exception 'Invalid gallery usage' using errcode='22023';
  end if;
  v_status := p_usage->>'providerStatus';
  if ((p_usage->>'success')::boolean) is distinct from (v_status='completed') then raise exception 'Usage success and status disagree' using errcode='22023'; end if;
  update public.gallery_import_provider_attempts set usage=p_usage, state=v_status, completed_at=transaction_timestamp()
    where id=p_attempt_id and reservation_token=p_reservation_token and state in ('reserved','inflight');
  return found;
end;
$$;
create or replace function public.mark_gallery_attempt_ambiguous(p_attempt_id uuid, p_reservation_token uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.gallery_import_provider_attempts set state='ambiguous',completed_at=transaction_timestamp()
    where id=p_attempt_id and reservation_token=p_reservation_token and state in ('reserved','inflight');
  return found;
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
    if (select count(*) from public.gallery_import_candidates c where c.run_id=v_run.id) >= (v_run.limit_snapshot->>'maxCandidatesPerRun')::integer then raise exception 'Run candidate limit reached' using errcode='P0001'; end if;
    insert into public.gallery_import_candidates (run_id,chunk_id,family_id,actor_id,cluster_signature,candidate_fingerprint,split_index,status,caption,memory_date,emotion,confidence,selected_asset_tokens,family_member_ids,expires_at)
      values (v_run.id,v_chunk.id,v_run.family_id,v_run.actor_id,v_item->>'clusterSignature',v_candidate_fingerprint,v_split_index,'staged',v_item->>'caption',(v_item->>'memoryDate')::date,nullif(v_item->>'emotion',''),(v_item->>'confidence')::double precision,v_tokens,'{}'::uuid[],v_run.expires_at)
      returning id into v_candidate_id;
    if v_candidate_id is not null then v_count := v_count+1; end if;
  end loop;
  return v_count;
end;
$$;
create or replace function public.publish_gallery_cluster_result(
  p_chunk_id uuid, p_cluster_signature text, p_candidates jsonb, p_skip_reason text default null
)
returns integer language plpgsql security definer set search_path = public as $$
declare v_count integer; v_chunk public.gallery_import_chunks%rowtype; v_existing public.gallery_import_cluster_results%rowtype; v_candidates_with_cluster jsonb;
begin
  if p_candidates is null or jsonb_typeof(p_candidates)<>'array' or jsonb_array_length(p_candidates)>3 then raise exception 'Invalid cluster candidates' using errcode='22023'; end if;
  if (jsonb_array_length(p_candidates)>0 and p_skip_reason is not null)
    or (jsonb_array_length(p_candidates)=0 and p_skip_reason not in ('no_candidate','low_confidence','safety_refusal','invalid_provider_output','invalid_preview','provider_refusal')) then raise exception 'Invalid cluster terminal result' using errcode='22023'; end if;
  select * into v_chunk from public.gallery_import_chunks where id=p_chunk_id for update;
  if not found then raise exception 'Chunk not found' using errcode='P0002'; end if;
  select * into v_existing from public.gallery_import_cluster_results where chunk_id=p_chunk_id and cluster_signature=p_cluster_signature for update;
  if not found then raise exception 'Cluster is not registered' using errcode='P0002'; end if;
  if v_existing.state<>'pending' then return v_existing.candidate_count; end if;
  select coalesce(jsonb_agg(value || jsonb_build_object('clusterSignature',p_cluster_signature)),'[]'::jsonb)
    into v_candidates_with_cluster from jsonb_array_elements(p_candidates);
  select public.publish_gallery_candidates(p_chunk_id,v_candidates_with_cluster) into v_count;
  if jsonb_array_length(p_candidates)>0 then
    select count(*) into v_count from public.gallery_import_candidates where chunk_id=p_chunk_id and cluster_signature=p_cluster_signature;
  end if;
  update public.gallery_import_cluster_results set state=case when v_count>0 then 'completed' when p_skip_reason='provider_refusal' then 'refused' when p_skip_reason='invalid_preview' then 'invalid_preview' else 'skipped' end,
    skip_reason=case when v_count>0 then null else coalesce(p_skip_reason,'no_candidate') end,candidate_count=v_count,completed_at=transaction_timestamp(),updated_at=transaction_timestamp()
    where chunk_id=p_chunk_id and cluster_signature=p_cluster_signature;
  if not exists (select 1 from public.gallery_import_cluster_results where chunk_id=p_chunk_id and state='pending') then
    update public.gallery_import_chunks set status='completed',completed_at=transaction_timestamp() where id=p_chunk_id;
    update public.gallery_import_runs set status='reviewing'
      where id=v_chunk.run_id and status in ('scanning','processing')
        and not exists (select 1 from public.gallery_import_chunks c where c.run_id=v_chunk.run_id and c.status not in ('completed','failed','cancelled','expired'));
  end if;
  return v_count;
end;
$$;
create or replace function public.fail_gallery_chunk(p_chunk_id uuid, p_closed_error_code text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_run_id uuid; v_updated boolean := false;
begin
  if p_closed_error_code is null or p_closed_error_code !~ '^[A-Z0-9_]{1,64}$' then raise exception 'Invalid closed error code' using errcode='22023'; end if;
  update public.gallery_import_cluster_results set state='failed',completed_at=transaction_timestamp(),updated_at=transaction_timestamp()
    where chunk_id=p_chunk_id and state='pending';
  update public.gallery_import_chunks set status='failed',closed_error_code=p_closed_error_code,completed_at=transaction_timestamp()
    where id=p_chunk_id and status not in ('completed','failed','cancelled','expired') returning run_id into v_run_id;
  if found then
    v_updated := true;
    update public.gallery_import_runs set status='reviewing'
      where id=v_run_id and status in ('scanning','processing')
        and not exists (select 1 from public.gallery_import_chunks c where c.run_id=v_run_id and c.status not in ('completed','failed','cancelled','expired'));
  end if;
  return v_updated;
end;
$$;
create or replace function public.scrub_gallery_chunk(p_chunk_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.gallery_import_chunks set scrubbed_at=transaction_timestamp() where id=p_chunk_id and scrubbed_at is null;
  return found;
end;
$$;
create or replace function public.claim_gallery_import_cleanup(p_limit integer default 50)
returns table (run_id uuid, claim_token uuid) language plpgsql security definer set search_path = public as $$
begin
  return query
  with candidates as (
    select r.id from public.gallery_import_runs r
    where (r.expires_at <= transaction_timestamp() or r.status='cancelled') and r.status not in ('completed','expired')
      and (r.cleanup_claimed_at is null or r.cleanup_claimed_at < transaction_timestamp()-interval '10 minutes')
    order by r.expires_at limit greatest(1,least(coalesce(p_limit,50),200)) for update skip locked
  ), claimed as (
    update public.gallery_import_runs r set cleanup_claim_token=gen_random_uuid(),cleanup_claimed_at=transaction_timestamp(),status='expired'
    from candidates c where r.id=c.id returning r.id,r.cleanup_claim_token
  ) select id,cleanup_claim_token from claimed;
end;
$$;
create or replace function public.finish_gallery_import_cleanup(p_run_id uuid, p_claim_token uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.gallery_import_runs where id=p_run_id and cleanup_claim_token=p_claim_token and status='expired') then
    return false;
  end if;
  update public.gallery_import_runs set cleanup_claimed_at=transaction_timestamp() where id=p_run_id and cleanup_claim_token=p_claim_token and status='expired';
  update public.gallery_import_candidates set status='expired',caption='Expired gallery suggestion',family_member_ids='{}'::uuid[] where run_id=p_run_id and status in ('staged','posting','skipped','unavailable');
  update public.gallery_import_chunks set status='expired',completed_at=coalesce(completed_at,transaction_timestamp()) where run_id=p_run_id and status not in ('completed','cancelled','expired');
  update public.gallery_import_approval_leases set state='expired' where run_id=p_run_id and state in ('reserved','uploading','finalizing');
  return true;
end;
$$;
create or replace function public.get_gallery_import_cleanup_objects(p_run_id uuid, p_claim_token uuid)
returns table (object_key text) language sql security definer set search_path = public as $$
  select a.preview_object_key
  from public.gallery_import_assets a join public.gallery_import_runs r on r.id=a.run_id
  where a.run_id=p_run_id and r.cleanup_claim_token=p_claim_token and r.status='expired' and a.preview_object_key is not null
  union
  select asset->>'objectKey'
  from public.gallery_import_approval_leases l
  join public.gallery_import_runs r on r.id=l.run_id
  cross join lateral jsonb_array_elements(l.expected_assets) asset
  where l.run_id=p_run_id and r.cleanup_claim_token=p_claim_token and r.status='expired'
    and l.state not in ('finalized');
$$;
create or replace function public.claim_gallery_import_digests(p_limit integer default 50)
returns table (family_id uuid, actor_id uuid, claim_token uuid)
language plpgsql security definer set search_path = public as $$
declare v_quiet interval;
begin
  select quiet_period into v_quiet from public.gallery_import_admission_settings where singleton;
  return query
  with due as (
    select w.family_id,w.actor_id from public.gallery_import_digest_windows w
    where w.approval_count>0 and w.last_approval_at <= transaction_timestamp()-v_quiet
      and (w.claimed_at is null or w.claimed_at < transaction_timestamp()-interval '10 minutes')
    order by w.last_approval_at
    limit greatest(1,least(coalesce(p_limit,50),200)) for update skip locked
  ), claimed as (
    update public.gallery_import_digest_windows w set claim_token=gen_random_uuid(),claimed_at=transaction_timestamp(),claimed_approval_count=w.approval_count
    from due d where w.family_id=d.family_id and w.actor_id=d.actor_id
    returning w.family_id,w.actor_id,w.claim_token
  ) select claimed.family_id,claimed.actor_id,claimed.claim_token from claimed;
end;
$$;
create or replace function public.finish_gallery_import_digest(p_family_id uuid,p_actor_id uuid,p_claim_token uuid,p_sent boolean)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if p_sent then
    update public.gallery_import_digest_windows set
      approval_count=greatest(approval_count-claimed_approval_count,0),
      first_approval_at=case when approval_count>claimed_approval_count then last_approval_at else null end,
      last_approval_at=case when approval_count>claimed_approval_count then last_approval_at else null end,
      claim_token=null,claimed_at=null,claimed_approval_count=null,sent_at=transaction_timestamp()
    where family_id=p_family_id and actor_id=p_actor_id and claim_token=p_claim_token;
  else
    update public.gallery_import_digest_windows set claim_token=null,claimed_at=null,claimed_approval_count=null
    where family_id=p_family_id and actor_id=p_actor_id and claim_token=p_claim_token;
  end if;
  return found;
end;
$$;
create or replace function public.cleanup_gallery_import_workflow_bridge_nonces(p_limit integer default 500)
returns integer language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  with expired as (
    select nonce from public.gallery_import_workflow_bridge_nonces
    where expires_at <= transaction_timestamp()
    order by expires_at limit greatest(1,least(coalesce(p_limit,500),5000))
    for update skip locked
  )
  delete from public.gallery_import_workflow_bridge_nonces n using expired e where n.nonce=e.nonce;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
create or replace function public.get_gallery_caption_settings(p_family_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_family public.families%rowtype;
begin
  if auth.uid() is null or not public.has_family_role(p_family_id,array['owner']) then raise exception 'Not authorized' using errcode='42501'; end if;
  select * into v_family from public.families where id=p_family_id and deleted_at is null;
  if not found then raise exception 'Family not found' using errcode='P0002'; end if;
  return jsonb_build_object('language',v_family.gallery_caption_language,'instructions',v_family.gallery_caption_instructions);
end;
$$;
create or replace function public.update_gallery_caption_settings(p_family_id uuid, p_language text, p_instructions text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_family public.families%rowtype;
begin
  if auth.uid() is null or public.is_anonymous_user() or not public.has_family_role(p_family_id,array['owner']) then raise exception 'Not authorized' using errcode='42501'; end if;
  if not public.billing_write_allowed(p_family_id,auth.uid()) then raise exception 'Subscription required' using errcode='P0001'; end if;
  update public.families set gallery_caption_language=p_language,gallery_caption_instructions=coalesce(p_instructions,'') where id=p_family_id and deleted_at is null returning * into v_family;
  if not found then raise exception 'Family not found' using errcode='P0002'; end if;
  return jsonb_build_object('language',v_family.gallery_caption_language,'instructions',v_family.gallery_caption_instructions);
end;
$$;
-- Tables are RPC/service-only.  In particular, an account logged in on a
-- second phone cannot query another device's unapproved cards by guessing a
-- run UUID; capability-bound readers above are the only client read surface.
alter table public.gallery_import_admission_settings enable row level security;
alter table public.gallery_import_runs enable row level security;
alter table public.gallery_import_chunks enable row level security;
alter table public.gallery_import_assets enable row level security;
alter table public.gallery_import_cluster_results enable row level security;
alter table public.gallery_import_candidates enable row level security;
alter table public.gallery_import_cluster_receipts enable row level security;
alter table public.gallery_import_provider_attempts enable row level security;
alter table public.gallery_import_approval_leases enable row level security;
alter table public.gallery_import_digest_windows enable row level security;
alter table public.gallery_import_workflow_bridge_nonces enable row level security;
revoke all on table
  public.gallery_import_admission_settings,
  public.gallery_import_runs,
  public.gallery_import_chunks,
  public.gallery_import_assets,
  public.gallery_import_cluster_results,
  public.gallery_import_candidates,
  public.gallery_import_cluster_receipts,
  public.gallery_import_provider_attempts,
  public.gallery_import_approval_leases,
  public.gallery_import_digest_windows,
  public.gallery_import_workflow_bridge_nonces
from public, anon, authenticated;
grant select, insert, delete on table public.gallery_import_workflow_bridge_nonces to service_role;
revoke all on function public.touch_gallery_import_admission_settings() from public, anon, authenticated, service_role;
revoke all on function public.gallery_import_set_updated_at() from public, anon, authenticated, service_role;
revoke all on function public.validate_gallery_import_candidate_assets() from public, anon, authenticated, service_role;
revoke all on function public.protect_gallery_import_preview_manifest() from public, anon, authenticated, service_role;
revoke all on function public.enforce_gallery_import_transitions() from public, anon, authenticated, service_role;
revoke all on function public.protect_gallery_import_run_identity() from public, anon, authenticated, service_role;
revoke all on function public.gallery_import_capability_matches(uuid,text) from public, anon, authenticated, service_role;
revoke all on function public.gallery_import_require_actor_run(uuid,text) from public, anon, authenticated, service_role;
revoke all on function public.gallery_import_uuid_array_is_distinct(uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.create_gallery_import_run_internal(uuid,text,text,text,text) from public, anon, authenticated, service_role;
revoke all on function public.get_gallery_import_run(uuid,text) from public, anon;
revoke all on function public.get_gallery_import_candidates(uuid,text) from public, anon;
revoke all on function public.register_gallery_import_chunk(uuid,text,integer,integer,integer) from public, anon;
revoke all on function public.register_gallery_import_assets(uuid,uuid,text,jsonb) from public, anon;
revoke all on function public.update_gallery_import_candidate_draft(uuid,text,text,date,uuid[],uuid[]) from public, anon;
revoke all on function public.set_gallery_import_candidate_skip(uuid,text,boolean) from public, anon;
revoke all on function public.set_gallery_import_candidate_unavailable(uuid,text,boolean) from public, anon;
revoke all on function public.begin_gallery_import_approval(uuid,text,jsonb) from public, anon;
revoke all on function public.finalize_gallery_import_candidate(uuid,text) from public, anon;
revoke all on function public.cancel_gallery_import_run(uuid,text) from public, anon;
revoke all on function public.complete_gallery_import_run(uuid,text) from public, anon;
revoke all on function public.get_gallery_caption_settings(uuid) from public, anon;
revoke all on function public.update_gallery_caption_settings(uuid,text,text) from public, anon;
grant execute on function public.get_gallery_import_run(uuid,text) to authenticated;
grant execute on function public.get_gallery_import_candidates(uuid,text) to authenticated;
grant execute on function public.register_gallery_import_chunk(uuid,text,integer,integer,integer) to authenticated;
grant execute on function public.register_gallery_import_assets(uuid,uuid,text,jsonb) to authenticated;
grant execute on function public.update_gallery_import_candidate_draft(uuid,text,text,date,uuid[],uuid[]) to authenticated;
grant execute on function public.set_gallery_import_candidate_skip(uuid,text,boolean) to authenticated;
grant execute on function public.set_gallery_import_candidate_unavailable(uuid,text,boolean) to authenticated;
grant execute on function public.begin_gallery_import_approval(uuid,text,jsonb) to authenticated;
grant execute on function public.finalize_gallery_import_candidate(uuid,text) to authenticated;
grant execute on function public.cancel_gallery_import_run(uuid,text) to authenticated;
grant execute on function public.complete_gallery_import_run(uuid,text) to authenticated;
grant execute on function public.get_gallery_caption_settings(uuid) to authenticated;
grant execute on function public.update_gallery_caption_settings(uuid,text,text) to authenticated;
revoke all on function public.record_gallery_import_approval_upload(uuid,text,text,integer,text,double precision) from public, anon, authenticated;
revoke all on function public.record_gallery_import_preview_upload(uuid,uuid,text,text,integer,integer,integer,text) from public, anon, authenticated;
revoke all on function public.mark_gallery_chunk_dispatched(uuid,text) from public, anon, authenticated;
revoke all on function public.get_gallery_chunk_input(uuid) from public, anon, authenticated;
revoke all on function public.reserve_gallery_attempt(uuid,text,smallint) from public, anon, authenticated;
revoke all on function public.record_gallery_usage(uuid,uuid,jsonb) from public, anon, authenticated;
revoke all on function public.mark_gallery_attempt_ambiguous(uuid,uuid) from public, anon, authenticated;
revoke all on function public.publish_gallery_candidates(uuid,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.publish_gallery_cluster_result(uuid,text,jsonb,text) from public, anon, authenticated;
revoke all on function public.fail_gallery_chunk(uuid,text) from public, anon, authenticated;
revoke all on function public.scrub_gallery_chunk(uuid) from public, anon, authenticated;
revoke all on function public.claim_gallery_import_cleanup(integer) from public, anon, authenticated;
revoke all on function public.finish_gallery_import_cleanup(uuid,uuid) from public, anon, authenticated;
revoke all on function public.get_gallery_import_cleanup_objects(uuid,uuid) from public, anon, authenticated;
revoke all on function public.claim_gallery_import_digests(integer) from public, anon, authenticated;
revoke all on function public.finish_gallery_import_digest(uuid,uuid,uuid,boolean) from public, anon, authenticated;
revoke all on function public.cleanup_gallery_import_workflow_bridge_nonces(integer) from public, anon, authenticated;
grant execute on function public.record_gallery_import_approval_upload(uuid,text,text,integer,text,double precision) to service_role;
grant execute on function public.record_gallery_import_preview_upload(uuid,uuid,text,text,integer,integer,integer,text) to service_role;
grant execute on function public.mark_gallery_chunk_dispatched(uuid,text) to service_role;
grant execute on function public.get_gallery_chunk_input(uuid) to service_role;
grant execute on function public.reserve_gallery_attempt(uuid,text,smallint) to service_role;
grant execute on function public.record_gallery_usage(uuid,uuid,jsonb) to service_role;
grant execute on function public.mark_gallery_attempt_ambiguous(uuid,uuid) to service_role;
grant execute on function public.publish_gallery_cluster_result(uuid,text,jsonb,text) to service_role;
grant execute on function public.fail_gallery_chunk(uuid,text) to service_role;
grant execute on function public.scrub_gallery_chunk(uuid) to service_role;
grant execute on function public.claim_gallery_import_cleanup(integer) to service_role;
grant execute on function public.finish_gallery_import_cleanup(uuid,uuid) to service_role;
grant execute on function public.get_gallery_import_cleanup_objects(uuid,uuid) to service_role;
grant execute on function public.claim_gallery_import_digests(integer) to service_role;
grant execute on function public.finish_gallery_import_digest(uuid,uuid,uuid,boolean) to service_role;
grant execute on function public.cleanup_gallery_import_workflow_bridge_nonces(integer) to service_role;
-- The public admission contract deliberately has no caller-provided limits.
create function public.create_gallery_import_run(
  p_family_id uuid, p_capability text, p_algorithm_version text,
  p_consent_version text, p_permission_mode text
)
returns uuid language sql security definer set search_path = public as $$
  select public.create_gallery_import_run_internal($1,$2,$3,$4,$5);
$$;
revoke all on function public.create_gallery_import_run(uuid,text,text,text,text) from public, anon;
grant execute on function public.create_gallery_import_run(uuid,text,text,text,text) to authenticated;
-- Scheduler requests read their environment-specific URL and shared secret at
-- execution time. Replacing any existing job by name makes migration replay
-- deterministic without committing credentials.
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.unschedule(jobid) from cron.job where jobname='invoke-send-gallery-import-digests';
select cron.unschedule(jobid) from cron.job where jobname='invoke-cleanup-gallery-imports';
select cron.schedule(
  'invoke-send-gallery-import-digests',
  '*/5 * * * *',
  $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='project_url') || '/functions/v1/send-gallery-import-digests',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-cron-secret',(select decrypted_secret from vault.decrypted_secrets where name='cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $cron$
);
select cron.schedule(
  'invoke-cleanup-gallery-imports',
  '0 * * * *',
  $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='project_url') || '/functions/v1/cleanup-gallery-imports',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-cron-secret',(select decrypted_secret from vault.decrypted_secrets where name='cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $cron$
);
