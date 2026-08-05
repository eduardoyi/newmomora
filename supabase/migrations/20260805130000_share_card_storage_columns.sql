-- Share card store-through cache (docs/plans/share-card-store-through.md, W1):
-- compose-share-card currently recomputes every card on every share request,
-- and Supabase Edge's WORKER_RESOURCE_LIMIT (546) means a real share of
-- those computations fail outright (see docs/features/memory-sharing.md's
-- Constraints section for the measured rates). The fix absorbs compose
-- failures server-side behind a stored-card cache: once a card is composed
-- successfully, compose-share-card (W2, using its service-role client)
-- records the R2 key here so a later share of the SAME content can stream
-- the cached PNG instead of recomposing. Per-MEMORY card for text-only and
-- illustrated memories (this column); per-ASSET card for media memories
-- (memory_media.share_card_key below) -- a single carousel photo can be
-- shared independently of its siblings, so each asset needs its own cache
-- slot.
--
-- Both columns are service-role-only by CONVENTION, not by grant: unlike
-- `families` (20260731110000_grant_authenticated_client_table_access.sql
-- revoked its table-level UPDATE and replaced it with narrow column grants,
-- e.g. `grant update (viewer_sharing_enabled)`), `memories` and
-- `memory_media` still carry a blanket `grant select, insert, update,
-- delete ... to authenticated` from that same migration. A new nullable
-- column on either table is therefore technically writable by any
-- owner/manager through the existing table-level grant + RLS policy, same
-- as several other columns already on these tables that only
-- server-side/service-role code is meant to populate (`illustration_key`,
-- `illustration_generation_id`, `usage_limit_epoch`, etc.). Carving out a
-- column-level exception here would mean revoking and rebuilding the whole
-- grant surface for two heavily-written tables -- out of scope for this
-- migration and inconsistent with how those existing columns are already
-- handled. No grant statement is added; the client app simply never writes
-- these columns, and compose-share-card is the only intended writer.
alter table public.memories
  add column share_card_key text null;

alter table public.memory_media
  add column share_card_key text null;

-- memory_media rows are never updated in place for a media edit:
-- replace_memory_media_assets (current body last touched in
-- 20260801150000_paid_subscription_hardening.sql) does
-- `delete from public.memory_media where memory_id = target_memory_id;`
-- followed by a fresh insert loop whose column list is
-- (memory_id, object_key, content_type, duration_ms, aspect_ratio,
-- preview_object_key, position) -- share_card_key is not among them, and
-- default expressions on `alter table ... add column` do not apply
-- retroactively to a function body written before the column existed. So
-- every row the RPC inserts already starts with share_card_key null with NO
-- migration change required. Verified by reading the current function
-- definition before writing this migration; if a future migration recreates
-- this RPC with new columns, keep confirming share_card_key stays out of
-- the insert list (or is inserted as null) so a replaced asset can never
-- inherit a stale card.

-- Staleness trigger for the memory-level card: clear share_card_key
-- whenever the content the card was rendered from changes. Scoped to
-- `before update of content, memory_date, emotion` (not a blanket
-- BEFORE/AFTER UPDATE trigger) so illustration-status-only writes -- by far
-- the most common update to this row, driven by the async illustration
-- pipeline (pending -> generating -> ready/failed) -- never fire it and
-- never pay a wasted cache invalidation. Postgres only fires an
-- `update of (col, ...)` trigger when one of those columns appears in the
-- UPDATE statement's target list, regardless of whether the value actually
-- changes, so the IS DISTINCT FROM guards below additionally protect a
-- no-op update that still lists these columns (e.g.
-- `update memories set content = content`) from clearing a live card.
create or replace function public.clear_memory_share_card_on_content_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.content is distinct from new.content
    or old.memory_date is distinct from new.memory_date
    or old.emotion is distinct from new.emotion then
    new.share_card_key := null;
  end if;
  return new;
end;
$$;

drop trigger if exists clear_memory_share_card_on_content_change on public.memories;
create trigger clear_memory_share_card_on_content_change
  before update of content, memory_date, emotion
  on public.memories
  for each row execute function public.clear_memory_share_card_on_content_change();
