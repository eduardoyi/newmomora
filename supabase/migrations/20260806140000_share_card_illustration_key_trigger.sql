-- Incident (2026-08-06): two fresh text_illustration memories were found in
-- production with share_card_key pointing at a v4 card that was composed
-- BEFORE their async illustration had finished -- the client's create-time
-- warm (warmShareCardForMemoryFireAndForget, fired from useMemories.ts's
-- createMutation.onSuccess) requests a store-through cache warm the instant
-- createMemory() returns, but a text_illustration memory's illustration is
-- still 'pending'/'generating' at that exact moment (the async pipeline
-- dispatches afterward -- see runMemoryIllustrationPipeline). compose-share-
-- card has no way to know the illustration is incomplete; it renders and
-- caches whatever the row looks like right now, producing a text-only quote
-- card that then never gets recomposed, because
-- 20260805130000_share_card_storage_columns.sql's staleness trigger only
-- watches `content, memory_date, emotion` -- none of which change when the
-- illustration finishes. The row's illustration_key going from null to a
-- real key (paired with illustration_status flipping to 'ready' in the SAME
-- UPDATE statement -- see generate-illustration/index.ts's commitDatabase,
-- which sets both illustration_key and illustration_status:'ready'
-- together) is therefore the one column change that actually correlates
-- with "the card this row would now render is different from the one that
-- was cached," and the trigger never watched it.
--
-- Two-part fix, per docs/plans/share-card-store-through.md's incident
-- follow-up:
--   1. (this migration) Extend the trigger to also clear on illustration_key
--      change, so ANY future premature-warm race -- not just the one the
--      client-side fix below closes -- self-heals the moment the real
--      illustration lands, instead of leaving a stale card cached
--      indefinitely.
--   2. (src/hooks/useMemories.ts, src/hooks/memory-cache.ts,
--      src/services/share-card.ts -- same PR) Stop firing the premature
--      create-time warm for text_illustration memories at all, and instead
--      warm once, centrally, when illustration_status actually transitions
--      to 'ready' (deduped per illustration_generation_id so the three
--      independent observers of that transition -- the detail hook, the
--      shared generation-status poll, and the realtime UPDATE handler --
--      produce exactly one warm request, not three).
create or replace function public.clear_memory_share_card_on_content_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.content is distinct from new.content
    or old.memory_date is distinct from new.memory_date
    or old.emotion is distinct from new.emotion
    or old.illustration_key is distinct from new.illustration_key then
    new.share_card_key := null;
  end if;
  return new;
end;
$$;

drop trigger if exists clear_memory_share_card_on_content_change on public.memories;
create trigger clear_memory_share_card_on_content_change
  before update of content, memory_date, emotion, illustration_key
  on public.memories
  for each row execute function public.clear_memory_share_card_on_content_change();

-- One-time repair: null out any share_card_key stored since the warm hooks
-- that can race an in-flight illustration first shipped. `2026-08-05` is the
-- date 20260805130000_share_card_storage_columns.sql (which added the
-- share_card_key column and its original, narrower trigger) landed --
-- share_card_key did not exist before that migration, so no row could have
-- a stored card older than it; every row that has one was written by
-- compose-share-card's store-through cache sometime on or after that date.
-- Scoping the repair to `memory_type = 'text_illustration' and
-- illustration_status = 'ready'` targets exactly the shape of the two
-- incident rows (a finished illustration with a card that might predate
-- it) without touching text_only/media cards, which were never subject to
-- this race (their content is complete the instant they're created/posted,
-- with nothing async left to finish). Over-clearing here is cheap: a
-- cleared share_card_key just means the next share pays one cold-path
-- compose-share-card call instead of a cache hit (or gets silently re-warmed
-- by the trigger/client fix above); there is no correctness cost to
-- clearing a row whose card was actually fine.
update public.memories
set share_card_key = null
where memory_type = 'text_illustration'
  and illustration_status = 'ready'
  and share_card_key is not null
  and created_at >= '2026-08-05';
