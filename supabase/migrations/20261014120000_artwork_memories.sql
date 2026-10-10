-- Artwork memories (Phase 1 schema foundation): a media memory flagged as a
-- scan of a child's artwork. The flag is a variant of the existing 'media'
-- type, not a fifth memory_type, so every media code path (upload, carousel,
-- RPC, books, film) keeps working unchanged. The AI-suggested medium
-- (crayon, watercolor, ...) lands on the same row from the analysis pass.
-- See docs/plans/artwork-scanning.md (1.1).

-- 1. Nullable columns. media_variant is client-supplied at insert and
-- immutable afterwards; artwork_medium is written only by the service-role
-- analysis path.
alter table public.memories
  add column media_variant text,
  add column artwork_medium text;

-- 2. Cross-column checks. The variant exists only on media memories (never
-- text or audio), and a medium only on artwork. Deliberately NO
-- `artwork_medium in (<vocabulary>)` check: vocabulary drift (a new medium
-- deployed before a migration, or a normalizer bug) would fail the single
-- analysis CAS UPDATE and, with it, emotion/topics/milestones for every
-- artwork memory. No other analysis column has a DB vocabulary check; the
-- vocabulary is enforced in code (normalizeArtworkMedium plus its sync test).
-- The coalesce matters: with a NULL media_variant, `media_variant = 'artwork'`
-- is NULL, and a CHECK treats NULL as passing, so without it a medium could be
-- stored on a non-artwork row.
alter table public.memories
  add constraint memories_media_variant_check
    check (media_variant is null or (media_variant = 'artwork' and memory_type = 'media')),
  add constraint memories_artwork_medium_requires_artwork
    check (artwork_medium is null or coalesce(media_variant = 'artwork', false));

-- 3. Grants. The narrow authenticated insert/update column grants from
-- 20260801170000_paid_subscription_sol_hardening.sql predate these columns
-- (and are extended additively, as audio_transcript did). Insert only: with no
-- UPDATE grant on either column, media_variant is immutable for clients
-- without needing a trigger, and artwork_medium is writable only by the
-- service role.
grant insert (media_variant) on public.memories to authenticated;

-- 4. Images-only enforcement for artwork parents, as a trigger rather than a
-- redefinition of replace_memory_media_assets (redefined 7+ times already,
-- so any inline check would be silently dropped by the next rewrite). The
-- trigger covers every writer of memory_media: that RPC and direct table
-- writes (memory_media keeps RLS-gated table grants). It also stops old app
-- versions adding a video to an artwork memory from their edit screen.
-- SECURITY INVOKER: the parent lookup runs under the caller's RLS, which
-- always admits the caller's own family's memories (a writer must be able to
-- see the parent to attach media to it). Same child-table trigger style as
-- enforce_audio_memory_media_invariants (20260819120000_audio_memories.sql).
create or replace function public.enforce_artwork_memory_media_images_only()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  parent_media_variant text;
begin
  select media_variant
  into parent_media_variant
  from public.memories
  where id = new.memory_id;

  if parent_media_variant = 'artwork' and new.content_type not like 'image/%' then
    raise exception 'artwork_media_must_be_image'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger memory_media_artwork_images_only
  before insert or update of content_type, memory_id on public.memory_media
  for each row execute function public.enforce_artwork_memory_media_images_only();

-- get_family_activity_v2 (explicit column list) is intentionally unchanged:
-- activity rows render artwork as a plain photo in v1.
