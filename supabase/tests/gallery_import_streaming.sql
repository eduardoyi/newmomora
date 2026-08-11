-- Companion to gallery_import_foundation.sql: locks in the streaming-while-
-- reviewing fix (20260811090000_gallery_import_reviewing_accepts_chunks.sql).
-- The run flips to 'reviewing' the instant its first chunk finishes AI
-- processing while later planned chunks of the same device-side manifest are
-- still being registered/uploaded/dispatched -- device-verified: run
-- d7efe5b5 admitted only 12 of ~61 clusters from a 16-chunk plan because
-- register_gallery_import_chunk refused every chunk registered after the run
-- left 'processing'. A run must still refuse the pipeline once it is
-- genuinely terminal.
begin;

select no_plan();

insert into auth.users (id,email,is_anonymous) values
  ('d1000000-0000-4000-8000-000000000001','gallery-stream-owner@example.test',false);
insert into public.families (id,name,owner_id,created_at)
values ('d2000000-0000-4000-8000-000000000001','Gallery streaming test family','d1000000-0000-4000-8000-000000000001',transaction_timestamp());
insert into public.family_memberships (family_id,user_id,role) values
  ('d2000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000001','owner');
insert into public.owner_entitlements (owner_user_id,app_user_id,environment,store,product_id,entitlement_id,period_type,status,expires_at,will_renew)
values ('d1000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000001','production','app_store','momora_annual_v1','momora_plus','annual','active',transaction_timestamp()+interval '30 days',true);
update public.gallery_import_admission_settings set enabled=true;

-- A 'reviewing' run (its first chunk already completed) must keep accepting
-- the full register -> upload -> dispatch lifecycle for every later chunk.
set local role authenticated;
select set_config('request.jwt.claim.sub','d1000000-0000-4000-8000-000000000001',true);
create temporary table reviewing_run as
  select public.create_gallery_import_run('d2000000-0000-4000-8000-000000000001','44444444444444444444444444444444','v1','consent-v1','all') id;
set local role postgres;
-- scanning -> reviewing is itself a valid run transition (enforce_gallery_import_transitions);
-- this simulates the first chunk of a larger manifest already completing.
update public.gallery_import_runs set status='reviewing' where id=(select id from reviewing_run);
select is((select status from public.gallery_import_runs where id=(select id from reviewing_run)),'reviewing','fixture run is reviewing before any later chunk registers');

set local role authenticated;
select set_config('request.jwt.claim.sub','d1000000-0000-4000-8000-000000000001',true);
create temporary table reviewing_chunk as
  select public.register_gallery_import_chunk((select id from reviewing_run),'44444444444444444444444444444444',1,1,1) id;
select isnt((select id from reviewing_chunk),null,'a reviewing run still admits a new chunk manifest (the fixed race)');
create temporary table reviewing_assets as
  select public.register_gallery_import_assets((select id from reviewing_run),(select id from reviewing_chunk),'44444444444444444444444444444444',
    '[{"opaqueToken":"d5000000-0000-4000-8000-000000000001","clusterSignature":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","captureDate":"2026-08-11","width":800,"height":600,"isFavorite":false}]'::jsonb) result;
select is((select jsonb_array_length(result->'acceptedAssetTokens') from reviewing_assets),1,'a reviewing run still admits the chunk''s asset manifest');

set local role service_role;
select ok(public.record_gallery_import_preview_upload((select id from reviewing_run),'d5000000-0000-4000-8000-000000000001',
  'd1000000-0000-4000-8000-000000000001/gallery-import/'||(select id from reviewing_run)::text||'/previews/d5000000-0000-4000-8000-000000000001.jpg','image/jpeg',512,384,120000,'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'),'preview upload still records while the run is reviewing');
select ok(public.mark_gallery_chunk_dispatched((select id from reviewing_chunk),'gallery:stream-test'),'a reviewing run''s late chunk still dispatches to the worker');
set local role postgres;
select is((select status from public.gallery_import_chunks where id=(select id from reviewing_chunk)),'dispatched','the late chunk reached dispatched, not stuck refused');

-- A genuinely terminal (completed) run must still refuse a new chunk.
set local role authenticated;
select set_config('request.jwt.claim.sub','d1000000-0000-4000-8000-000000000001',true);
create temporary table completed_run as
  select public.create_gallery_import_run('d2000000-0000-4000-8000-000000000001','55555555555555555555555555555555','v1','consent-v1','all') id;
set local role postgres;
update public.gallery_import_runs set status='reviewing' where id=(select id from completed_run);
update public.gallery_import_runs set status='completed',completed_at=transaction_timestamp() where id=(select id from completed_run);
select is((select status from public.gallery_import_runs where id=(select id from completed_run)),'completed','fixture run is completed (terminal) before the refusal check');

set local role authenticated;
select set_config('request.jwt.claim.sub','d1000000-0000-4000-8000-000000000001',true);
select throws_ok(
  $$select public.register_gallery_import_chunk((select id from completed_run),'55555555555555555555555555555555',0,1,1)$$,
  'P0001','Import run is not accepting chunks','a completed (terminal) run still refuses a new chunk manifest');

select * from finish();
rollback;
