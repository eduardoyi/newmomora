begin;

-- Coverage for the share-card staleness trigger
-- (clear_memory_share_card_on_content_change, originally
-- 20260805130000_share_card_storage_columns.sql, extended by
-- 20260806140000_share_card_illustration_key_trigger.sql). The extension
-- adds `illustration_key` to the trigger's watched columns: the production
-- incident it fixes is a share card composed from a text_illustration
-- memory BEFORE its async illustration finished (illustration_key still
-- null), left cached under a key that never gets invalidated once the real
-- illustration lands -- because until this migration, the trigger only
-- fired on content/memory_date/emotion, never on illustration_key.

select plan(6);

insert into auth.users (id, email)
values ('62000000-0000-4000-8000-000000000001', 'share-card-db@example.test');

insert into public.families (id, name, owner_id)
values ('62000000-0000-4000-8000-000000000002', 'Share Card DB test', '62000000-0000-4000-8000-000000000001');

insert into public.family_memberships (id, family_id, user_id, role)
values ('62000000-0000-4000-8000-000000000003', '62000000-0000-4000-8000-000000000002', '62000000-0000-4000-8000-000000000001', 'owner');

insert into public.memories (
  id, family_id, user_id, content, memory_type, illustration_status, share_card_key
) values (
  '62000000-0000-4000-8000-000000000004',
  '62000000-0000-4000-8000-000000000002',
  '62000000-0000-4000-8000-000000000001',
  'A warm-race memory', 'text_illustration', 'pending', 'cache/premature-card.png'
);

-- The mechanism this migration fixes: a card cached while illustration_key
-- was still null gets cleared the moment illustration_key actually changes
-- (the async pipeline's commit UPDATE always sets illustration_key AND
-- illustration_status='ready' in the SAME statement -- see
-- generate-illustration/index.ts's commitDatabase -- so this single-column
-- watch is sufficient to catch the ready transition).
update public.memories
set illustration_key = 'illustrations/final.webp', illustration_status = 'ready'
where id = '62000000-0000-4000-8000-000000000004';

select is(
  (select share_card_key from public.memories where id = '62000000-0000-4000-8000-000000000004'),
  null,
  'share_card_key clears when illustration_key changes on the ready transition'
);

-- Re-seed a cached card and prove a same-value illustration_key UPDATE
-- (e.g. an unrelated column-only write that still lists illustration_key in
-- its SET clause) does NOT clear it -- mirrors the existing IS DISTINCT FROM
-- guard already covering content/memory_date/emotion.
update public.memories
set share_card_key = 'cache/still-valid.png'
where id = '62000000-0000-4000-8000-000000000004';

update public.memories
set illustration_key = illustration_key
where id = '62000000-0000-4000-8000-000000000004';

select is(
  (select share_card_key from public.memories where id = '62000000-0000-4000-8000-000000000004'),
  'cache/still-valid.png',
  'a no-op illustration_key write (same value) does not clear a live card'
);

-- An illustration_status-only write (the common case -- pending ->
-- generating) must still be a no-op for the trigger: it doesn't list
-- illustration_key, content, memory_date, or emotion in its target list.
update public.memories
set illustration_status = 'generating'
where id = '62000000-0000-4000-8000-000000000004';

select is(
  (select share_card_key from public.memories where id = '62000000-0000-4000-8000-000000000004'),
  'cache/still-valid.png',
  'an illustration_status-only write leaves a live card cached'
);

-- The pre-existing content/memory_date/emotion clauses still work
-- (regression guard for the original 20260805130000 migration).
update public.memories
set content = 'Edited content'
where id = '62000000-0000-4000-8000-000000000004';

select is(
  (select share_card_key from public.memories where id = '62000000-0000-4000-8000-000000000004'),
  null,
  'share_card_key still clears on a content change'
);

-- One-time repair migration coverage: any text_illustration/ready memory
-- with a share_card_key stored on/after 2026-08-05 (when the warm hooks
-- shipped) is suspect and must be nulled out by the migration's backfill
-- UPDATE. Simulate the pre-repair state directly (the repair itself already
-- ran as part of applying 20260806140000 in this same database, so this
-- inserts a FRESH row after that point to prove the invariant going
-- forward -- an already-ready memory with a share_card_key set is only
-- valid post-migration once compose-share-card writes it AFTER
-- illustration_key was already final, which this trigger now guarantees).
insert into public.memories (
  id, family_id, user_id, content, memory_type, illustration_status,
  illustration_key, share_card_key
) values (
  '62000000-0000-4000-8000-000000000005',
  '62000000-0000-4000-8000-000000000002',
  '62000000-0000-4000-8000-000000000001',
  'Already-ready memory', 'text_illustration', 'ready',
  'illustrations/already-final.webp', 'cache/valid-post-ready-card.png'
);

select is(
  (select share_card_key from public.memories where id = '62000000-0000-4000-8000-000000000005'),
  'cache/valid-post-ready-card.png',
  'inserting a memory that is already ready (illustration_key set at insert time, not via a later UPDATE) does not clear share_card_key -- the trigger only watches UPDATE, matching the migration comment that INSERT-time cards are never premature'
);

update public.memories
set illustration_key = 'illustrations/regenerated.webp'
where id = '62000000-0000-4000-8000-000000000005';

select is(
  (select share_card_key from public.memories where id = '62000000-0000-4000-8000-000000000005'),
  null,
  'a later regeneration (illustration_key changes again on an already-ready memory) also clears the stale card'
);

select * from finish();
rollback;
