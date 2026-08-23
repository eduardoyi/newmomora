-- Companion to gallery_import_foundation.sql and gallery_import_streaming.sql:
-- locks in the continuous-model migration (20260823100000_gallery_import_
-- continuous.sql) -- the monthly/initial-window run caps are removed in favor
-- of a rolling 24h per-family cluster cap, activity extends the review
-- window, completion/publish races are closed, assets can be marked
-- unavailable without blocking a chunk forever, and reconciliation can
-- recover a chunk whose Workflow never called back. Also locks in the
-- `reserve_gallery_attempt` control-flow bug fix (see the migration's
-- comment on that function): before the fix, retrying an ordinal whose
-- earlier attempt went 'ambiguous' raised a duplicate-key error instead of
-- returning 'denied'.
begin;

select no_plan();

insert into auth.users (id,email,is_anonymous) values
  ('e1000000-0000-4000-8000-000000000001','gallery-continuous-owner@example.test',false);
insert into public.families (id,name,owner_id,created_at)
values ('e2000000-0000-4000-8000-000000000001','Gallery continuous test family','e1000000-0000-4000-8000-000000000001',transaction_timestamp());
insert into public.family_memberships (family_id,user_id,role) values
  ('e2000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001','owner');
insert into public.owner_entitlements (owner_user_id,app_user_id,environment,store,product_id,entitlement_id,period_type,status,expires_at,will_renew)
values ('e1000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001','production','app_store','momora_annual_v1','momora_plus','annual','active',transaction_timestamp()+interval '30 days',true);
update public.gallery_import_admission_settings set enabled=true, daily_cluster_limit=2;

-- ---------------------------------------------------------------------
-- The monthly/initial-window run caps are gone: three runs in the same
-- calendar month (well past the old normal_monthly_run_limit default of 1)
-- succeed sequentially, each after the previous one closes.
-- ---------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub','e1000000-0000-4000-8000-000000000001',true);
create temporary table run_a as
  select public.create_gallery_import_run('e2000000-0000-4000-8000-000000000001','11111111111111111111111111111111','v1','consent-v1','all') id;
select ok(public.cancel_gallery_import_run((select id from run_a),'11111111111111111111111111111111'),'first run of the month cancels');
create temporary table run_b as
  select public.create_gallery_import_run('e2000000-0000-4000-8000-000000000001','22222222222222222222222222222222','v1','consent-v1','all') id;
select ok(public.cancel_gallery_import_run((select id from run_b),'22222222222222222222222222222222'),'second run of the month cancels');
create temporary table run_c as
  select public.create_gallery_import_run('e2000000-0000-4000-8000-000000000001','33333333333333333333333333333333','v1','consent-v1','all') id;
select isnt((select id from run_c),null,'a third run in the same calendar month is admitted now the monthly/initial-window caps are removed');

-- ---------------------------------------------------------------------
-- Daily cluster fair-use cap (S2): raises P0002 with an ISO hint distinct
-- from every other (plain) P0002 in this domain, once the family's rolling
-- 24h cluster_results count would exceed daily_cluster_limit.
-- ---------------------------------------------------------------------

create temporary table chunk_daily as
  select public.register_gallery_import_chunk((select id from run_c),'33333333333333333333333333333333',0,2,2) id;
create temporary table registered_daily as
  select public.register_gallery_import_assets((select id from run_c),(select id from chunk_daily),'33333333333333333333333333333333',
    ('[{"opaqueToken":"e5000000-0000-4000-8000-000000000001","clusterSignature":"' || repeat('c',64) || '","captureDate":"2026-08-01","isFavorite":false},'
    || '{"opaqueToken":"e5000000-0000-4000-8000-000000000002","clusterSignature":"' || repeat('d',64) || '","captureDate":"2026-08-01","isFavorite":false}]')::jsonb) result;
select is((select jsonb_array_length(result->'acceptedAssetTokens') from registered_daily),2,'daily-limit fixture registers two clusters (used=2, at the test cap of 2)');

create temporary table daily_limit_result (caught boolean, hint text);
do $probe$
declare v_hint text;
begin
  begin
    perform public.register_gallery_import_chunk((select id from run_c),'33333333333333333333333333333333',1,1,1);
    insert into daily_limit_result values (false, null);
  exception when sqlstate 'P0002' then
    get stacked diagnostics v_hint = pg_exception_hint;
    insert into daily_limit_result values (true, v_hint);
  end;
end;
$probe$;
select ok((select caught from daily_limit_result),'a chunk that would push the family over its rolling 24h daily_cluster_limit raises P0002');
select ok((select hint ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$' from daily_limit_result),'the daily-limit P0002 carries an ISO-8601 UTC reset hint the Edge can turn into retryAfterSeconds');

-- ---------------------------------------------------------------------
-- Fair-use hint precision (review fix): the hint must be the instant at
-- which enough of the *currently counted* rows have aged out for the
-- specific request to fit, not simply min(created_at) of the whole window.
-- A single-cluster read on a min()-only hint would keep getting refused
-- (and the client would thrash) even after the single oldest row ages out,
-- if more than one row needs to free. Uses its own family so `used` is not
-- contaminated by chunk_daily's rows above.
-- ---------------------------------------------------------------------

insert into auth.users (id,email,is_anonymous) values
  ('e1000000-0000-4000-8000-000000000002','gallery-continuous-fairuse-hint@example.test',false);
insert into public.families (id,name,owner_id,created_at)
values ('e2000000-0000-4000-8000-000000000002','Gallery fair-use hint test family','e1000000-0000-4000-8000-000000000002',transaction_timestamp());
insert into public.family_memberships (family_id,user_id,role) values
  ('e2000000-0000-4000-8000-000000000002','e1000000-0000-4000-8000-000000000002','owner');
insert into public.owner_entitlements (owner_user_id,app_user_id,environment,store,product_id,entitlement_id,period_type,status,expires_at,will_renew)
values ('e1000000-0000-4000-8000-000000000002','e1000000-0000-4000-8000-000000000002','production','app_store','momora_annual_v1','momora_plus','annual','active',transaction_timestamp()+interval '30 days',true);

-- daily_cluster_limit is a single global row (shared by every family): raise
-- it before registering this fixture's own 3-cluster chunk, since it is
-- still 2 from the earlier daily-limit test above.
set local role postgres;
update public.gallery_import_admission_settings set daily_cluster_limit=1000;

set local role authenticated;
select set_config('request.jwt.claim.sub','e1000000-0000-4000-8000-000000000002',true);
create temporary table run_kth as
  select public.create_gallery_import_run('e2000000-0000-4000-8000-000000000002','88888888888888888888888888888888','v1','consent-v1','all') id;
create temporary table chunk_kth as
  select public.register_gallery_import_chunk((select id from run_kth),'88888888888888888888888888888888',0,3,3) id;
select public.register_gallery_import_assets((select id from run_kth),(select id from chunk_kth),'88888888888888888888888888888888',
  ('[{"opaqueToken":"eb000000-0000-4000-8000-000000000001","clusterSignature":"' || repeat('4',64) || '","captureDate":"2026-08-08","isFavorite":false},'
  || '{"opaqueToken":"eb000000-0000-4000-8000-000000000002","clusterSignature":"' || repeat('5',64) || '","captureDate":"2026-08-08","isFavorite":false},'
  || '{"opaqueToken":"eb000000-0000-4000-8000-000000000003","clusterSignature":"' || repeat('6',64) || '","captureDate":"2026-08-08","isFavorite":false}]')::jsonb);

-- Give the three counted rows distinct ages (they would otherwise all share
-- the same transaction_timestamp(), since this whole file runs in one
-- transaction) so a min()-based hint is distinguishable from a k-th-row hint.
set local role postgres;
update public.gallery_import_cluster_results set created_at=transaction_timestamp()-interval '3 hours' where chunk_id=(select id from chunk_kth) and cluster_signature=repeat('4',64);
update public.gallery_import_cluster_results set created_at=transaction_timestamp()-interval '2 hours' where chunk_id=(select id from chunk_kth) and cluster_signature=repeat('5',64);
update public.gallery_import_cluster_results set created_at=transaction_timestamp()-interval '1 hour' where chunk_id=(select id from chunk_kth) and cluster_signature=repeat('6',64);
-- Now lower the cap so the next registration attempt (below) is refused.
update public.gallery_import_admission_settings set daily_cluster_limit=2;

-- used=3, +1 requested, limit=2 -> excess=2: the SECOND-oldest row (-2h)
-- must age out, not the oldest (-3h) one.
create temporary table kth_hint_result (caught boolean, hint text);
set local role authenticated;
select set_config('request.jwt.claim.sub','e1000000-0000-4000-8000-000000000002',true);
do $kth$
declare v_hint text;
begin
  begin
    perform public.register_gallery_import_chunk((select id from run_kth),'88888888888888888888888888888888',1,1,1);
    insert into kth_hint_result values (false, null);
  exception when sqlstate 'P0002' then
    get stacked diagnostics v_hint = pg_exception_hint;
    insert into kth_hint_result values (true, v_hint);
  end;
end;
$kth$;
select ok((select caught from kth_hint_result),'a request that would still exceed the cap after only the single oldest row ages out still raises P0002 (used=3, +1 requested, limit=2)');
select ok((select hint::timestamptz between transaction_timestamp() - interval '2 hours' + interval '24 hours' - interval '2 minutes'
                                        and transaction_timestamp() - interval '2 hours' + interval '24 hours' + interval '2 minutes'
           from kth_hint_result),
  'the hint is the SECOND-oldest counted row''s created_at + 24h (the row that must age out for used''+requested to fit) -- a min()-only hint (oldest row, -3h) would fail this assertion by a full hour');

set local role postgres;
create temporary table kth_fair_use as select public.get_gallery_import_fair_use('e2000000-0000-4000-8000-000000000002') result;
select is((select result->>'used' from kth_fair_use)::integer,3,'get_gallery_import_fair_use reports the live 24h count');
select ok((select (result->>'resets_at')::timestamptz between transaction_timestamp() - interval '2 hours' + interval '24 hours' - interval '2 minutes'
                                                            and transaction_timestamp() - interval '2 hours' + interval '24 hours' + interval '2 minutes'
           from kth_fair_use),
  'get_gallery_import_fair_use.resets_at uses the same k-th-row precision (used=3 >= limit=2 -> excess=2 -> second-oldest row, not the single oldest)');

-- Every remaining fixture below registers its own clusters against the same
-- (first) family; raise the cap back out so it stops constraining them (its
-- own enforcement is already locked in above).
set local role postgres;
update public.gallery_import_admission_settings set daily_cluster_limit=1000;

-- ---------------------------------------------------------------------
-- Touch-on-activity (S3 step in the plan's numbering; internal model step
-- 3): the review window is 30 days from *last activity*, not creation, and
-- the extension propagates to a live candidate's own expiry so it never
-- lapses ahead of the run it belongs to.
-- ---------------------------------------------------------------------

set local role postgres;
update public.gallery_import_runs set expires_at = transaction_timestamp() + interval '1 day' where id=(select id from run_c);
insert into public.gallery_import_candidates (id,run_id,chunk_id,family_id,actor_id,cluster_signature,candidate_fingerprint,caption,memory_date,confidence,selected_asset_tokens,expires_at)
values ('e6000000-0000-4000-8000-000000000001',(select id from run_c),(select id from chunk_daily),'e2000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001',
  repeat('c',64), encode(extensions.digest((select id::text from run_c)||':'||repeat('c',64)||':e5000000-0000-4000-8000-000000000001','sha256'),'hex'),
  'A test moment', current_date, .8, array['e5000000-0000-4000-8000-000000000001'::uuid], transaction_timestamp()+interval '1 day');
select ok((select expires_at < transaction_timestamp() + interval '2 days' from public.gallery_import_runs where id=(select id from run_c)),'fixture: run expiry was rolled back to soon, before the touch');

set local role authenticated;
select set_config('request.jwt.claim.sub','e1000000-0000-4000-8000-000000000001',true);
select ok((select status from public.set_gallery_import_candidate_skip('e6000000-0000-4000-8000-000000000001','33333333333333333333333333333333',true)) = 'skipped','touch fixture: skip succeeds');

set local role postgres;
select ok((select expires_at > transaction_timestamp() + interval '29 days' from public.gallery_import_runs where id=(select id from run_c)),'activity (skip) extends the run''s expires_at back out to review_ttl from now');
select ok((select expires_at > transaction_timestamp() + interval '29 days' from public.gallery_import_candidates where id='e6000000-0000-4000-8000-000000000001'),'the extension propagates to a live candidate''s own expires_at so it cannot lapse ahead of its run');

-- Throttle (review fix): a second touch within the same day of activity
-- must be a no-op -- get_gallery_import_candidates alone is polled by the
-- review deck every ~9s, and without the throttle this would UPDATE every
-- live asset/candidate row on every poll.
create temporary table run_c_expiry_after_first_touch as
  select expires_at from public.gallery_import_runs where id=(select id from run_c);
create temporary table candidate_e6_expiry_after_first_touch as
  select expires_at from public.gallery_import_candidates where id='e6000000-0000-4000-8000-000000000001';

set local role authenticated;
select set_config('request.jwt.claim.sub','e1000000-0000-4000-8000-000000000001',true);
select ok((select status from public.set_gallery_import_candidate_skip('e6000000-0000-4000-8000-000000000001','33333333333333333333333333333333',false)) = 'staged','second touch fixture: unskip succeeds');

set local role postgres;
select is((select expires_at from public.gallery_import_runs where id=(select id from run_c)),(select expires_at from run_c_expiry_after_first_touch),'a second touch within the same day of activity is a throttled no-op -- the run''s expires_at is unchanged, not re-extended');
select is((select expires_at from public.gallery_import_candidates where id='e6000000-0000-4000-8000-000000000001'),(select expires_at from candidate_e6_expiry_after_first_touch),'the throttle also means the candidate propagation UPDATE never runs on the second touch, so its expires_at is unchanged too');

-- ---------------------------------------------------------------------
-- Completion guard: complete_gallery_import_run must also refuse while any
-- chunk is still in flight, even with zero staged/posting candidates.
-- ---------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub','e1000000-0000-4000-8000-000000000001',true);
create temporary table run_d as
  select public.create_gallery_import_run('e2000000-0000-4000-8000-000000000001','44444444444444444444444444444444','v1','consent-v1','all') id;
set local role postgres;
update public.gallery_import_runs set status='reviewing' where id=(select id from run_d);
insert into public.gallery_import_chunks (id,run_id,ordinal,status,declared_cluster_count,declared_asset_count)
values ('e7000000-0000-4000-8000-000000000001',(select id from run_d),0,'processing',1,1);

set local role authenticated;
select set_config('request.jwt.claim.sub','e1000000-0000-4000-8000-000000000001',true);
select throws_ok(
  $$select public.complete_gallery_import_run((select id from run_d),'44444444444444444444444444444444')$$,
  'P0001','Gallery import still has work in flight','complete refuses while any chunk is registered/uploading/dispatched/processing, not only while candidates are staged');

set local role postgres;
update public.gallery_import_chunks set status='completed',completed_at=transaction_timestamp() where id='e7000000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub','e1000000-0000-4000-8000-000000000001',true);
select ok(public.complete_gallery_import_run((select id from run_d),'44444444444444444444444444444444'),'complete succeeds once every chunk has reached a terminal status');

-- ---------------------------------------------------------------------
-- Publish guard: a completed run is closed to new publications exactly like
-- cancelled/expired/failed (a straggling Workflow must not create
-- candidates after the family finished reviewing). publish_gallery_candidates
-- itself is not service-callable (see gallery_import_foundation.sql's own
-- privilege assertion) -- it is only ever reached through
-- publish_gallery_cluster_result, so the guard is exercised the same way a
-- real Worker would hit it.
-- ---------------------------------------------------------------------

set local role postgres;
insert into public.gallery_import_cluster_results (chunk_id,cluster_signature)
values ('e7000000-0000-4000-8000-000000000001',repeat('9',64));

set local role service_role;
select throws_ok(
  $$select public.publish_gallery_cluster_result('e7000000-0000-4000-8000-000000000001',repeat('9',64),'[]'::jsonb,'no_candidate')$$,
  'P0001','Run is closed','publish_gallery_cluster_result (via publish_gallery_candidates) refuses into a completed run just as it does cancelled/expired/failed');

-- ---------------------------------------------------------------------
-- Asset unavailability (S3): an asset the device can no longer produce a
-- preview for is dropped without blocking the rest of the chunk; once every
-- asset in a chunk is unavailable, the chunk closes without dispatch and
-- every remaining pending cluster resolves invalid_preview.
-- ---------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub','e1000000-0000-4000-8000-000000000001',true);
create temporary table run_e as
  select public.create_gallery_import_run('e2000000-0000-4000-8000-000000000001','55555555555555555555555555555555','v1','consent-v1','all') id;
create temporary table chunk_e as
  select public.register_gallery_import_chunk((select id from run_e),'55555555555555555555555555555555',0,2,2) id;
select public.register_gallery_import_assets((select id from run_e),(select id from chunk_e),'55555555555555555555555555555555',
  ('[{"opaqueToken":"e8000000-0000-4000-8000-000000000001","clusterSignature":"' || repeat('e',64) || '","captureDate":"2026-08-05","isFavorite":false},'
  || '{"opaqueToken":"e8000000-0000-4000-8000-000000000002","clusterSignature":"' || repeat('f',64) || '","captureDate":"2026-08-05","isFavorite":false}]')::jsonb) result;

create temporary table unavailable_one as
  select public.mark_gallery_import_assets_unavailable((select id from run_e),'55555555555555555555555555555555',(select id from chunk_e),
    array['e8000000-0000-4000-8000-000000000001'::uuid]) result;
select is((select result->'markedAssetTokens'->>0 from unavailable_one),'e8000000-0000-4000-8000-000000000001','marking an unuploaded asset unavailable reports it back');
select is((select result->'emptiedClusterSignatures'->>0 from unavailable_one),repeat('e',64),'the emptied cluster (its only asset went unavailable) is reported');

set local role postgres;
select is((select state from public.gallery_import_cluster_results where chunk_id=(select id from chunk_e) and cluster_signature=repeat('e',64)),'invalid_preview','the emptied cluster resolves invalid_preview through the normal terminal-publication path');
select is((select skip_reason from public.gallery_import_cluster_results where chunk_id=(select id from chunk_e) and cluster_signature=repeat('e',64)),'invalid_preview','its skip_reason matches');
select is((select asset_count from public.gallery_import_chunks where id=(select id from chunk_e)),1,'the chunk''s asset_count is recomputed to exclude the unavailable asset');
select is((select status from public.gallery_import_chunks where id=(select id from chunk_e)),'uploading','the chunk stays open while its other cluster is still viable');
select ok(not exists (select 1 from public.gallery_import_cluster_receipts where cluster_signature=repeat('e',64)),'marking an asset unavailable writes no suppression receipt -- unlike a deliberate skip, it may resurface on a later sweep');

set local role authenticated;
select set_config('request.jwt.claim.sub','e1000000-0000-4000-8000-000000000001',true);
select public.mark_gallery_import_assets_unavailable((select id from run_e),'55555555555555555555555555555555',(select id from chunk_e),
  array['e8000000-0000-4000-8000-000000000002'::uuid]);
set local role postgres;
select is((select status from public.gallery_import_chunks where id=(select id from chunk_e)),'completed','a chunk left with zero available assets closes completed without ever dispatching');
select is((select status from public.gallery_import_runs where id=(select id from run_e)),'reviewing','the run advances to reviewing once its only chunk is terminal, exactly like a normal publish/fail');

-- ---------------------------------------------------------------------
-- reserve_gallery_attempt bug fix (S7): before the fix, retrying the same
-- (chunk, cluster, ordinal) after an 'ambiguous' outcome raised a
-- duplicate-key error (23505) instead of returning 'denied', because
-- `return query` in plpgsql appends to the result set without exiting the
-- function -- execution fell through into an unconditional insert.
-- ---------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub','e1000000-0000-4000-8000-000000000001',true);
create temporary table run_f as
  select public.create_gallery_import_run('e2000000-0000-4000-8000-000000000001','66666666666666666666666666666666','v1','consent-v1','all') id;
create temporary table chunk_f as
  select public.register_gallery_import_chunk((select id from run_f),'66666666666666666666666666666666',0,1,1) id;
select public.register_gallery_import_assets((select id from run_f),(select id from chunk_f),'66666666666666666666666666666666',
  ('[{"opaqueToken":"e9000000-0000-4000-8000-000000000001","clusterSignature":"' || repeat('1',64) || '","captureDate":"2026-08-06","width":800,"height":600,"isFavorite":false}]')::jsonb);

set local role service_role;
select public.record_gallery_import_preview_upload((select id from run_f),'e9000000-0000-4000-8000-000000000001',
  'e1000000-0000-4000-8000-000000000001/gallery-import/'||(select id from run_f)::text||'/previews/e9000000-0000-4000-8000-000000000001.jpg','image/jpeg',512,384,120000,repeat('2',64));
select ok(public.mark_gallery_chunk_dispatched((select id from chunk_f),'gallery:reserve-test'),'fixture chunk reaches dispatched with a complete preview manifest');

create temporary table attempt_f as
  select * from public.reserve_gallery_attempt((select id from chunk_f),repeat('1',64),1::smallint);
select is((select outcome from attempt_f),'reserved_now','first reservation at ordinal 1 succeeds');
select ok(public.mark_gallery_attempt_ambiguous((select attempt_id from attempt_f),(select reservation_token from attempt_f)),'the attempt is marked ambiguous (e.g. a network disconnect mid-request)');

create temporary table attempt_f_retry as
  select * from public.reserve_gallery_attempt((select id from chunk_f),repeat('1',64),1::smallint);
select is((select outcome from attempt_f_retry),'denied','retrying the SAME ordinal after an ambiguous outcome returns denied instead of erroring (the fixed bug)');
select is((select attempt_id from attempt_f_retry),(select attempt_id from attempt_f),'the denied response still identifies the consumed ambiguous attempt row');
select is((select reservation_token from attempt_f_retry),null,'a denied outcome never carries a usable reservation token');

create temporary table attempt_f_next as
  select * from public.reserve_gallery_attempt((select id from chunk_f),repeat('1',64),2::smallint);
select is((select outcome from attempt_f_next),'reserved_now','the caller can move on to the next ordinal and reserve normally');

-- ---------------------------------------------------------------------
-- Reconciliation (S4, S6): claim_stale_gallery_chunks recovers a chunk whose
-- Workflow never called back, and gives up (fails the chunk) once its
-- attempts are exhausted.
-- ---------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claim.sub','e1000000-0000-4000-8000-000000000001',true);
create temporary table run_g as
  select public.create_gallery_import_run('e2000000-0000-4000-8000-000000000001','77777777777777777777777777777777','v1','consent-v1','all') id;
create temporary table chunk_g as
  select public.register_gallery_import_chunk((select id from run_g),'77777777777777777777777777777777',0,1,1) id;
select public.register_gallery_import_assets((select id from run_g),(select id from chunk_g),'77777777777777777777777777777777',
  ('[{"opaqueToken":"ea000000-0000-4000-8000-000000000001","clusterSignature":"' || repeat('3',64) || '","captureDate":"2026-08-07","isFavorite":false}]')::jsonb);

set local role postgres;
update public.gallery_import_chunks set status='dispatched', dispatched_at=transaction_timestamp()-interval '25 minutes', dispatch_attempts=1 where id=(select id from chunk_g);

set local role service_role;
create temporary table stale_claim_one as select * from public.claim_stale_gallery_chunks(50);
select ok(exists (select 1 from stale_claim_one where chunk_id=(select id from chunk_g)),'a chunk stuck past the 20-minute dispatch timeout is claimed for redispatch');
select is((select dispatch_attempts from stale_claim_one where chunk_id=(select id from chunk_g)),1::smallint,'the claim reports the chunk''s current (pre-increment) attempt count so the caller can compute the next attempt number');

set local role postgres;
update public.gallery_import_chunks set dispatched_at=transaction_timestamp()-interval '25 minutes', dispatch_attempts=3 where id=(select id from chunk_g);

set local role service_role;
create temporary table stale_claim_two as select * from public.claim_stale_gallery_chunks(50);
select ok(not exists (select 1 from stale_claim_two where chunk_id=(select id from chunk_g)),'a chunk at its attempt ceiling is not returned for another redispatch');

set local role postgres;
select is((select status from public.gallery_import_chunks where id=(select id from chunk_g)),'failed','instead, the exhausted chunk is failed directly by the claim');
select is((select closed_error_code from public.gallery_import_chunks where id=(select id from chunk_g)),'GALLERY_RECONCILE_EXHAUSTED','with the reconciliation-specific closed error code');
select is((select state from public.gallery_import_cluster_results where chunk_id=(select id from chunk_g)),'failed','its pending cluster is resolved failed alongside the chunk');

-- A run that never leaves 'scanning'/'processing' before the review TTL
-- lapses is still reachable by cleanup; not exercised further here (see
-- gallery_import_foundation.sql's completed-run cleanup coverage).

select * from finish();
rollback;
