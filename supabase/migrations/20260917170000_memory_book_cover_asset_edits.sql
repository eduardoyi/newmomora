-- Shelf cover-edit awareness (2026-09-17 owner decision): re-backfill
-- `cover_asset_key` for `status = 'ready'` books that ALREADY have a saved
-- COVER edit (`memory_book_edits.edits -> 'images' -> 'cover'`) qualifying
-- under the SAME width gate `pickCoverAssetKey` applies at every write
-- point (see `supabase/functions/_shared/memory-book-cover.ts`'s header
-- comment) -- mirrors `book-renderer/src/model/edits.ts`'s
-- `applyCoverImageEdit` + `applyWidthHeight` synthetic-asset construction:
-- effective width = coalesce(originalWidth, round(100 * aspectRatio))
-- (independent of `originalHeight`, same "asset.originalWidth ?? null"
-- quirk `pickCoverAssetKey`'s own `buildCoverEditCandidate` mirrors).
--
-- A book with NO saved cover edit is left completely untouched: migration
-- `20260917150000_memory_book_cover_asset_refine.sql` already computed the
-- correct AI-only `cover_asset_key` for every ready book, and that value is
-- EXACTLY what the full precedence still resolves to whenever a cover edit
-- doesn't qualify (or doesn't exist) -- `pickCoverAssetKey` falls through to
-- the unmodified AI precedence in that case. So the only rows THIS
-- migration needs to touch are the ones where a QUALIFYING cover edit
-- exists -- those are the only rows where the correct answer differs from
-- what `150000` already wrote.
--
-- Conservative by construction, per the owner's explicit guidance ("when in
-- doubt whether the edit qualifies, prefer leaving the existing AI-pick
-- value"): a row is updated ONLY when the cover edit's qualification can be
-- determined with confidence (file present and non-empty, aspectRatio
-- present and numeric, effective width safely parseable and >= 2000).
-- Anything ambiguous or malformed -- missing/non-numeric aspectRatio,
-- non-string/empty file, a non-object `cover` value -- is left UNTOUCHED
-- (never overwritten to null, never guessed), keeping the existing
-- (already-correct-for-the-no-qualifying-edit-case) `150000` value in
-- place. This is a deliberate simplification vs. re-running the full
-- `pickCoverAssetKey(book_document, coverEdit)` precedence in SQL: it never
-- needs to re-derive the AI-only fallback at all, since it's already
-- correct on every row this migration skips.

with candidate_edits as (
  select
    mb.id,
    mbe.edits -> 'images' -> 'cover' as cover
  from public.memory_books mb
  join public.memory_book_edits mbe on mbe.book_id = mb.id
  where mb.status = 'ready'
    and mb.book_document is not null
    and jsonb_typeof(mbe.edits -> 'images' -> 'cover') = 'object'
),
qualifying as (
  select
    id,
    cover ->> 'file' as file
  from candidate_edits
  where (cover ->> 'file') is not null
    and (cover ->> 'file') <> ''
    and (cover ->> 'aspectRatio') ~ '^-?\d+(\.\d+)?$'
    and coalesce(
          case when (cover ->> 'originalWidth') ~ '^-?\d+(\.\d+)?$' then (cover ->> 'originalWidth')::numeric end,
          round(100 * (cover ->> 'aspectRatio')::numeric)
        ) >= 2000
)
update public.memory_books mb
set cover_asset_key = q.file
from qualifying q
where mb.id = q.id;
