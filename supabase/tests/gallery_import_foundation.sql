begin;

select no_plan();

insert into auth.users (id,email,is_anonymous) values
  ('b1000000-0000-4000-8000-000000000001','gallery-owner@example.test',false),
  ('b1000000-0000-4000-8000-000000000002','gallery-manager@example.test',false);
insert into public.families (id,name,owner_id,created_at)
values ('b2000000-0000-4000-8000-000000000001','Gallery test family','b1000000-0000-4000-8000-000000000001',transaction_timestamp());
insert into public.family_memberships (family_id,user_id,role) values
  ('b2000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','owner'),
  ('b2000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000002','manager');
insert into public.owner_entitlements (owner_user_id,app_user_id,environment,store,product_id,entitlement_id,period_type,status,expires_at,will_renew)
values ('b1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','production','app_store','momora_annual_v1','momora_plus','annual','active',transaction_timestamp()+interval '30 days',true);
update public.gallery_import_admission_settings set enabled=true;
create temporary table admission_epoch as select policy_epoch from public.gallery_import_admission_settings where singleton;
update public.gallery_import_admission_settings set limit_template=jsonb_set(limit_template,'{maxPreviewBytes}','1400000'::jsonb) where singleton;
select is((select policy_epoch from public.gallery_import_admission_settings where singleton),(select policy_epoch+1 from admission_epoch),'limit-template changes increment the policy epoch');
select throws_ok($$update public.gallery_import_admission_settings set limit_template=limit_template-'maxPreviewBytes' where singleton$$,'23514',null,'server limit template requires every numeric key');
update public.gallery_import_admission_settings set limit_template=jsonb_set(limit_template,'{maxPreviewBytes}','1500000'::jsonb) where singleton;

select ok(not has_table_privilege('authenticated','public.gallery_import_runs','SELECT,INSERT,UPDATE,DELETE'),'run tables have no client grants');
select ok(not has_table_privilege('authenticated','public.gallery_import_workflow_bridge_nonces','SELECT,INSERT,UPDATE,DELETE'),'nonce replay guard has no client grants');
select ok(has_table_privilege('service_role','public.gallery_import_workflow_bridge_nonces','SELECT,INSERT,DELETE'),'nonce replay guard is service-only');
select ok(has_function_privilege('authenticated','public.create_gallery_import_run(uuid,text,text,text,text)','EXECUTE'),'public run creation has five arguments');
select ok(to_regprocedure('public.create_gallery_import_run(uuid,text,text,text,text,jsonb)') is null,'misleading six-argument public run creation is absent');
select ok(not has_function_privilege('service_role','public.publish_gallery_candidates(uuid,jsonb)','EXECUTE'),'internal candidate publisher is not service callable');
select ok(has_function_privilege('service_role','public.publish_gallery_cluster_result(uuid,text,jsonb,text)','EXECUTE'),'cluster terminal publisher is service callable');
select ok(position('Run candidate limit reached' in pg_get_functiondef('public.publish_gallery_candidates(uuid,jsonb)'::regprocedure))=0,'candidate cap is a normal suppressed outcome, not a workflow failure');
select ok(not has_function_privilege('authenticated','public.record_gallery_import_preview_upload(uuid,uuid,text,text,integer,integer,integer,text)','EXECUTE'),'preview verification is not client callable');
select is((select count(*)::integer from cron.job where jobname='invoke-send-gallery-import-digests'),1,'digest scheduler has one idempotent named job');
select is((select schedule from cron.job where jobname='invoke-send-gallery-import-digests'),'*/5 * * * *','digest scheduler runs every five minutes');
select ok((select command from cron.job where jobname='invoke-send-gallery-import-digests') like '%/functions/v1/send-gallery-import-digests%','digest scheduler targets the digest Edge function');
select is((select count(*)::integer from cron.job where jobname='invoke-cleanup-gallery-imports'),1,'cleanup scheduler has one idempotent named job');
select is((select schedule from cron.job where jobname='invoke-cleanup-gallery-imports'),'0 * * * *','gallery cleanup scheduler runs hourly');
select ok((select command from cron.job where jobname='invoke-cleanup-gallery-imports') like '%/functions/v1/cleanup-gallery-imports%','cleanup scheduler targets the fenced cleanup Edge function');

set local role authenticated;
select set_config('request.jwt.claim.sub','b1000000-0000-4000-8000-000000000001',true);
create temporary table run_one as
  select public.create_gallery_import_run('b2000000-0000-4000-8000-000000000001','11111111111111111111111111111111','v1','consent-v1','all') id;
set local role postgres;
select is((select limit_snapshot from public.gallery_import_runs where id=(select id from run_one)),(select limit_template from public.gallery_import_admission_settings where singleton),'run snapshots server-owned limits');
set local role authenticated;
select set_config('request.jwt.claim.sub','b1000000-0000-4000-8000-000000000001',true);
select throws_ok($$select public.create_gallery_import_run('b2000000-0000-4000-8000-000000000001','99999999999999999999999999999999','v1','consent-v1','all')$$,'P0001','A gallery import is already active','family has only one active run');
create temporary table chunk_one as
  select public.register_gallery_import_chunk((select id from run_one),'11111111111111111111111111111111',0,1,1) id;
create temporary table registered_one as
  select public.register_gallery_import_assets((select id from run_one),(select id from chunk_one),'11111111111111111111111111111111',
    '[{"opaqueToken":"b5000000-0000-4000-8000-000000000001","clusterSignature":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","captureDate":"2026-08-01","width":1200,"height":900,"isFavorite":true}]'::jsonb) result;
select is((select jsonb_array_length(result->'acceptedAssetTokens') from registered_one),1,'registration returns the accepted upload tokens');

set local role postgres;
insert into public.gallery_import_candidates (id,run_id,chunk_id,family_id,actor_id,cluster_signature,candidate_fingerprint,caption,memory_date,confidence,selected_asset_tokens,expires_at)
values ('b6000000-0000-4000-8000-000000000001',(select id from run_one),(select id from chunk_one),'b2000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',encode(extensions.digest((select id::text from run_one)||':aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:b5000000-0000-4000-8000-000000000001','sha256'),'hex'),
  'A rainy afternoon',current_date,.8,array['b5000000-0000-4000-8000-000000000001'::uuid],transaction_timestamp()+interval '30 days');

-- A user-cleared draft caption ('' — never null at the candidate level)
-- must still be an accepted row: finalize_gallery_import_candidate is what
-- turns it into memories.content = null.
select lives_ok(
  $$insert into public.gallery_import_candidates (id,run_id,chunk_id,family_id,actor_id,cluster_signature,candidate_fingerprint,caption,memory_date,confidence,selected_asset_tokens,expires_at)
    values ('b6000000-0000-4000-8000-000000000002',(select id from run_one),(select id from chunk_one),'b2000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001',
      'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',encode(extensions.digest((select id::text from run_one)||':cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc:b5000000-0000-4000-8000-000000000001','sha256'),'hex'),
      '',current_date,.8,array['b5000000-0000-4000-8000-000000000001'::uuid],transaction_timestamp()+interval '30 days')$$,
  'a user-cleared empty caption is an accepted candidate row'
);

set local role authenticated;
select set_config('request.jwt.claim.sub','b1000000-0000-4000-8000-000000000001',true);
select is((select status from public.set_gallery_import_candidate_unavailable('b6000000-0000-4000-8000-000000000001','11111111111111111111111111111111',true)),'unavailable','all-missing originals mark the card unavailable without skipping it');
select is((select status from public.set_gallery_import_candidate_unavailable('b6000000-0000-4000-8000-000000000001','11111111111111111111111111111111',false)),'staged','availability can recover explicitly inside the active run');
select is((select status from public.set_gallery_import_candidate_skip('b6000000-0000-4000-8000-000000000001','11111111111111111111111111111111',true)),'skipped','skip creates a recoverable in-run card state');
select is((select status from public.set_gallery_import_candidate_skip('b6000000-0000-4000-8000-000000000001','11111111111111111111111111111111',false)),'staged','explicit capability-bound restore works while the run is active');
set local role postgres;
select ok(not exists (select 1 from public.gallery_import_cluster_receipts where cluster_signature='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),'explicit restore removes the in-run skip receipt');
set local role authenticated;
select set_config('request.jwt.claim.sub','b1000000-0000-4000-8000-000000000001',true);
select is((select status from public.set_gallery_import_candidate_skip('b6000000-0000-4000-8000-000000000001','11111111111111111111111111111111',true)),'skipped','card can be deliberately skipped again');
select ok(public.cancel_gallery_import_run((select id from run_one),'11111111111111111111111111111111'),'first run cancels');
select throws_ok($$select public.set_gallery_import_candidate_skip('b6000000-0000-4000-8000-000000000001','11111111111111111111111111111111',false)$$,'P0001','Import run is not active','restore is forbidden after the active run closes');

set local role postgres;
create temporary table run_two as
select gen_random_uuid() id;
grant select on run_two to authenticated;
insert into public.gallery_import_runs (id,family_id,actor_id,capability_hash,algorithm_version,consent_version,permission_mode,limit_snapshot,policy_epoch,expires_at)
select id,'b2000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001',encode(extensions.digest('22222222222222222222222222222222','sha256'),'hex'),'v1','consent-v1','all',limit_template,policy_epoch,transaction_timestamp()+interval '30 days'
from run_two cross join public.gallery_import_admission_settings where singleton;
set local role authenticated;
select set_config('request.jwt.claim.sub','b1000000-0000-4000-8000-000000000001',true);
create temporary table chunk_two as select public.register_gallery_import_chunk((select id from run_two),'22222222222222222222222222222222',0,1,1) id;
create temporary table suppressed as
select public.register_gallery_import_assets((select id from run_two),(select id from chunk_two),'22222222222222222222222222222222',
  '[{"opaqueToken":"b5000000-0000-4000-8000-000000000002","clusterSignature":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","captureDate":"2026-08-01","isFavorite":false}]'::jsonb) result;
select is((select jsonb_array_length(result->'acceptedAssetTokens') from suppressed),0,'permanent receipt suppresses uploads before staging');
select is((select result->'suppressedClusterSignatures'->>0 from suppressed),'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','registration reports the suppressed cluster');
set local role postgres;
select is((select count(*)::integer from public.gallery_import_assets where run_id=(select id from run_two)),0,'suppressed clusters stage no preview objects');
select is((select status from public.gallery_import_chunks where id=(select id from chunk_two)),'completed','fully suppressed chunk is terminal without provider work');
select is((select state from public.gallery_import_cluster_results where chunk_id=(select id from chunk_two)),'suppressed','suppressed declared cluster has a durable terminal ledger row');

update public.gallery_import_runs set status='completed',completed_at=transaction_timestamp() where id=(select id from run_two);
create temporary table run_three as select gen_random_uuid() id;
grant select on run_three to authenticated, service_role;
insert into public.gallery_import_runs (id,family_id,actor_id,capability_hash,algorithm_version,consent_version,permission_mode,limit_snapshot,policy_epoch,expires_at)
select id,'b2000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001',encode(extensions.digest('33333333333333333333333333333333','sha256'),'hex'),'v1','consent-v1','all',limit_template,policy_epoch,transaction_timestamp()+interval '30 days'
from run_three cross join public.gallery_import_admission_settings where singleton;

set local role authenticated;
select set_config('request.jwt.claim.sub','b1000000-0000-4000-8000-000000000001',true);
create temporary table chunk_three as select public.register_gallery_import_chunk((select id from run_three),'33333333333333333333333333333333',0,1,1) id;
grant select on chunk_three to service_role;
select is(public.register_gallery_import_chunk((select id from run_three),'33333333333333333333333333333333',0,1,1),(select id from chunk_three),'exact chunk replay returns the original chunk');
select throws_ok($$select public.register_gallery_import_chunk((select id from run_three),'33333333333333333333333333333333',0,1,2)$$,'22023','Chunk replay changed manifest counts','chunk replay cannot change declared counts');
create temporary table accepted_three as
select public.register_gallery_import_assets((select id from run_three),(select id from chunk_three),'33333333333333333333333333333333',
  '[{"opaqueToken":"b5000000-0000-4000-8000-000000000003","clusterSignature":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","captureDate":"2026-08-02","width":800,"height":600,"isFavorite":false}]'::jsonb) result;
select is((public.register_gallery_import_assets((select id from run_three),(select id from chunk_three),'33333333333333333333333333333333',
  '[{"opaqueToken":"b5000000-0000-4000-8000-000000000003","clusterSignature":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","captureDate":"2026-08-02","width":800,"height":600,"isFavorite":false}]'::jsonb)->'acceptedAssetTokens'->>0),'b5000000-0000-4000-8000-000000000003','asset replay is exact and idempotent');
select throws_ok($$select public.register_gallery_import_assets((select id from run_three),(select id from chunk_three),'33333333333333333333333333333333','[{"opaqueToken":"b5000000-0000-4000-8000-000000000003","clusterSignature":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","captureDate":"2026-08-02","width":801,"height":600,"isFavorite":false}]'::jsonb)$$,'22023','Asset token replay changed immutable manifest','asset token replay cannot mutate manifest fields');

set local role service_role;
select ok(public.record_gallery_import_preview_upload((select id from run_three),'b5000000-0000-4000-8000-000000000003',
  'b1000000-0000-4000-8000-000000000001/gallery-import/'||(select id from run_three)::text||'/previews/b5000000-0000-4000-8000-000000000003.jpg','image/jpeg',512,384,120000,'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'),'verified JPEG preview records');
select ok(public.record_gallery_import_preview_upload((select id from run_three),'b5000000-0000-4000-8000-000000000003',
  'b1000000-0000-4000-8000-000000000001/gallery-import/'||(select id from run_three)::text||'/previews/b5000000-0000-4000-8000-000000000003.jpg','image/jpeg',512,384,120000,'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'),'exact preview replay is idempotent');
select throws_ok($$select public.record_gallery_import_preview_upload((select id from run_three),'b5000000-0000-4000-8000-000000000003','b1000000-0000-4000-8000-000000000001/gallery-import/'||(select id from run_three)::text||'/previews/b5000000-0000-4000-8000-000000000003.jpg','image/jpeg',512,384,120000,'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd')$$,'42501','Preview manifest replay differs','verified preview metadata is immutable');
select ok(public.mark_gallery_chunk_dispatched((select id from chunk_three),'gallery:test'),'complete preview manifest can dispatch');
select is((public.get_gallery_chunk_input((select id from chunk_three))->'clusters'->0->'assets'->0->>'previewWidth')::integer,512,'worker input exposes verified preview dimensions');
create temporary table attempt_one as select * from public.reserve_gallery_attempt((select id from chunk_three),'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',1::smallint);
select is((select outcome from attempt_one),'reserved_now','provider attempt is atomically reserved per cluster');
select ok(public.record_gallery_usage((select attempt_id from attempt_one),(select reservation_token from attempt_one),'{"success":false,"providerStatus":"failed","inputTokens":1,"outputTokens":null,"totalTokens":1}'::jsonb),'closed usage envelope records');
set local role postgres;
select is((select state from public.gallery_import_provider_attempts where id=(select attempt_id from attempt_one)),'failed','failed provider usage remains failed');
set local role service_role;
select throws_ok($$select public.record_gallery_usage(gen_random_uuid(),gen_random_uuid(),'{"success":true,"providerStatus":200,"inputTokens":0,"outputTokens":0,"totalTokens":0}'::jsonb)$$,'22023','Invalid gallery usage','numeric provider status is rejected');
select is(public.publish_gallery_cluster_result((select id from chunk_three),'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  '[{"caption":"A sunny afternoon together","memoryDate":"2026-08-02","emotion":"joy","confidence":0.9,"selectedAssetTokens":["b5000000-0000-4000-8000-000000000003"]}]'::jsonb,null),1,'per-cluster publication creates one card');
select is(public.publish_gallery_cluster_result((select id from chunk_three),'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','[]'::jsonb,'no_candidate'),1,'terminal cluster publication replay is idempotent');
set local role postgres;
select is((select status from public.gallery_import_chunks where id=(select id from chunk_three)),'completed','chunk completes only after its cluster is terminal');
select throws_ok($$update public.gallery_import_cluster_results set state='pending',skip_reason=null,candidate_count=0,completed_at=null where chunk_id=(select id from chunk_three)$$,'23514','Terminal gallery cluster result is immutable','terminal cluster outcomes cannot be reopened');

set local role authenticated;
select set_config('request.jwt.claim.sub','b1000000-0000-4000-8000-000000000001',true);
create temporary table candidate_three as select id from public.get_gallery_import_candidates((select id from run_three),'33333333333333333333333333333333') limit 1;
select throws_ok($$select public.begin_gallery_import_approval((select id from candidate_three),'33333333333333333333333333333333','[{"assetToken":"b5000000-0000-4000-8000-000000000003","contentType":"image/jpeg","objectKey":"attacker/key.jpg"}]'::jsonb)$$,'22023','Invalid selected originals','approval rejects caller-supplied object keys');
create temporary table lease_three as
select public.begin_gallery_import_approval((select id from candidate_three),'33333333333333333333333333333333','[{"assetToken":"b5000000-0000-4000-8000-000000000003","contentType":"image/jpeg"}]'::jsonb) result;
grant select on lease_three to service_role;
select ok((select result->'expectedAssets'->0->>'objectKey' from lease_three) like 'b1000000-0000-4000-8000-000000000001/memories/%/media/b5000000-0000-4000-8000-000000000003.jpg','approval derives the actor/memory/token object key server-side');

set local role service_role;
select ok(public.record_gallery_import_approval_upload((select (result->>'leaseId')::uuid from lease_three),(select result->'expectedAssets'->0->>'objectKey' from lease_three),'image/jpeg',200000,'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',1.25),'verified original metadata records on the lease');
set local role authenticated;
select set_config('request.jwt.claim.sub','b1000000-0000-4000-8000-000000000001',true);
select is(public.finalize_gallery_import_candidate((select id from candidate_three),'33333333333333333333333333333333'),(select (result->>'memoryId')::uuid from lease_three),'approval finalization is idempotently memory-bound');
set local role postgres;
select is((select creation_source from public.memories where id=(select (result->>'memoryId')::uuid from lease_three)),'gallery_import','finalized memory records gallery provenance');

-- A sent digest keeps a zero-count row. Finalizing the next approval must
-- start a new valid 30-minute quiet window on that same row.
update public.gallery_import_digest_windows set last_approval_at=transaction_timestamp()-interval '31 minutes';
set local role service_role;
create temporary table reset_digest_claim as select * from public.claim_gallery_import_digests(10);
select ok(public.finish_gallery_import_digest((select family_id from reset_digest_claim),(select actor_id from reset_digest_claim),(select claim_token from reset_digest_claim),true),'digest send resets the window to the valid zero-count state');
set local role postgres;
select ok((select approval_count=0 and first_approval_at is null and last_approval_at is null from public.gallery_import_digest_windows),'sent digest leaves the expected zero-count timestamp state');
insert into public.gallery_import_assets (run_id,opaque_token,cluster_signature,capture_date,width,height,is_favorite,expires_at)
values ((select id from run_three),'b5000000-0000-4000-8000-000000000004','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',current_date,800,600,false,transaction_timestamp()+interval '30 days');
create temporary table candidate_four as select 'b6000000-0000-4000-8000-000000000004'::uuid id;
grant select on candidate_four to authenticated;
insert into public.gallery_import_candidates (id,run_id,family_id,actor_id,cluster_signature,candidate_fingerprint,status,caption,memory_date,confidence,selected_asset_tokens,expires_at)
values ((select id from candidate_four),(select id from run_three),'b2000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001',
  'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',encode(extensions.digest((select id::text from run_three)||':cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc:b5000000-0000-4000-8000-000000000004','sha256'),'hex'),
  'posting','A second approved moment',current_date,.9,array['b5000000-0000-4000-8000-000000000004'::uuid],transaction_timestamp()+interval '30 days');
create temporary table lease_four as select 'b7000000-0000-4000-8000-000000000004'::uuid id, 'b8000000-0000-4000-8000-000000000004'::uuid memory_id;
grant select on lease_four to authenticated;
insert into public.gallery_import_approval_leases (id,candidate_id,run_id,family_id,actor_id,memory_id,lease_token_hash,expected_assets,uploaded_assets,state,expires_at)
select id,(select id from candidate_four),(select id from run_three),'b2000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001',memory_id,
  encode(extensions.digest('lease-four','sha256'),'hex'),
  jsonb_build_array(jsonb_build_object('objectKey','b1000000-0000-4000-8000-000000000001/memories/'||memory_id::text||'/media/b5000000-0000-4000-8000-000000000004.jpg','contentType','image/jpeg')),
  jsonb_build_array(jsonb_build_object('objectKey','b1000000-0000-4000-8000-000000000001/memories/'||memory_id::text||'/media/b5000000-0000-4000-8000-000000000004.jpg','contentType','image/jpeg','byteLength',200000,'sha256','ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff','aspectRatio',1.25)),
  'uploading',transaction_timestamp()+interval '24 hours'
from lease_four;
set local role authenticated;
select set_config('request.jwt.claim.sub','b1000000-0000-4000-8000-000000000001',true);
select is(public.finalize_gallery_import_candidate((select id from candidate_four),'33333333333333333333333333333333'),(select memory_id from lease_four),'approval after a sent/reset digest window finalizes without violating the digest invariant');
set local role postgres;
select is((select approval_count from public.gallery_import_digest_windows),1,'a new approval starts a fresh digest count after the zero-count reset');
select ok((select first_approval_at is not null and last_approval_at is not null and first_approval_at=last_approval_at and sent_at is null from public.gallery_import_digest_windows),'a zero-count digest row resets both timestamps and restarts the quiet window');

update public.gallery_import_runs set status='completed',completed_at=transaction_timestamp(),expires_at=transaction_timestamp()-interval '1 second' where id=(select id from run_three);
set local role service_role;
create temporary table completed_cleanup_claim as select * from public.claim_gallery_import_cleanup(200);
select ok(exists (select 1 from completed_cleanup_claim where run_id=(select id from run_three)),'completed run is cleanup-claimable after its review TTL');
set local role postgres;
select is((select status from public.gallery_import_runs where id=(select id from run_three)),'expired','claim transitions a due completed run to the fenced expired state');
select ok((select completed_at is not null from public.gallery_import_runs where id=(select id from run_three)),'cleanup preserves completed-at audit history');
set local role service_role;
select ok(exists (select 1 from public.get_gallery_import_cleanup_objects((select id from run_three),(select claim_token from completed_cleanup_claim where run_id=(select id from run_three))) where object_key=('b1000000-0000-4000-8000-000000000001/gallery-import/'||(select id from run_three)::text||'/previews/b5000000-0000-4000-8000-000000000003.jpg')),'completed-run cleanup returns its transient preview');
select ok(not exists (select 1 from public.get_gallery_import_cleanup_objects((select id from run_three),(select claim_token from completed_cleanup_claim where run_id=(select id from run_three))) where object_key=(select result->'expectedAssets'->0->>'objectKey' from lease_three)),'completed-run cleanup never returns finalized original media');
select ok(public.finish_gallery_import_cleanup((select id from run_three),(select claim_token from completed_cleanup_claim where run_id=(select id from run_three))),'completed-run cleanup finishes with its fence token');
set local role postgres;
select ok(exists (select 1 from public.memories where id=(select (result->>'memoryId')::uuid from lease_three)),'cleanup preserves the finalized memory');
select ok(exists (select 1 from public.gallery_import_cluster_receipts where source_candidate_id=(select id from candidate_three) and outcome='approved'),'cleanup preserves the finalized suppression receipt');

update public.gallery_import_digest_windows set last_approval_at=transaction_timestamp()-interval '31 minutes';
set local role service_role;
create temporary table digest_claim as select * from public.claim_gallery_import_digests(10);
select is((select count(*)::integer from digest_claim),1,'quiet digest window is claimed atomically');
set local role postgres;
update public.gallery_import_digest_windows set approval_count=approval_count+1,last_approval_at=transaction_timestamp();
set local role service_role;
select ok(public.finish_gallery_import_digest((select family_id from digest_claim),(select actor_id from digest_claim),(select claim_token from digest_claim),true),'digest claim finishes with its fence token');
set local role postgres;
select is((select approval_count from public.gallery_import_digest_windows),1,'approval arriving during a digest claim is not lost');
set local role service_role;
select ok(not public.finish_gallery_import_digest((select family_id from digest_claim),(select actor_id from digest_claim),(select claim_token from digest_claim),true),'finished digest token is idempotently rejected');
set local role postgres;
update public.gallery_import_digest_windows set last_approval_at=transaction_timestamp()-interval '31 minutes';
set local role service_role;
create temporary table digest_retry as select * from public.claim_gallery_import_digests(10);
select ok(public.finish_gallery_import_digest((select family_id from digest_retry),(select actor_id from digest_retry),(select claim_token from digest_retry),false),'failed send releases the digest claim for retry');
set local role postgres;
select is((select approval_count from public.gallery_import_digest_windows),1,'retry release preserves pending approvals');

set local role service_role;
insert into public.gallery_import_workflow_bridge_nonces (nonce) values ('b9000000-0000-4000-8000-000000000001');
select throws_ok($$insert into public.gallery_import_workflow_bridge_nonces (nonce) values ('b9000000-0000-4000-8000-000000000001')$$,'23505',null,'nonce replay is durably rejected');
set local role postgres;
insert into public.gallery_import_workflow_bridge_nonces (nonce,created_at,expires_at)
values ('b9000000-0000-4000-8000-000000000002',transaction_timestamp()-interval '1 hour',transaction_timestamp()-interval '30 minutes');
set local role service_role;
select is(public.cleanup_gallery_import_workflow_bridge_nonces(100),1,'expired workflow nonces are cleanup bounded');

set local role postgres;
select throws_ok($$update public.gallery_import_runs set capability_hash='ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' where id=(select id from run_one)$$,'42501','Gallery import run identity is immutable','capability hash is immutable');
select ok(not has_column_privilege('authenticated','public.memories','creation_source','INSERT'),'clients cannot manufacture gallery provenance');

select * from finish();
rollback;
