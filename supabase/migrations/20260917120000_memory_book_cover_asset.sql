-- Memory-book shelf redesign (docs/plans/memory-book.md, picker redesign
-- DESIGN LOCKED 2026-09-17): the app's picker shows each ready book as a
-- cover-facsimile tile, which needs ONE representative R2 asset key per
-- book without shipping the whole book_document jsonb through the picker's
-- 4-second poll loop. The key is denormalized here at publish time by
-- workflow-memory-book-bridge's handlePublish (same CAS update that flips
-- status to 'ready'), mirroring the web list's pickListThumbnailKey
-- (book-renderer/src/web/books/thumbnail.ts): first outline.coverCandidates
-- entry that resolves to a manifest asset, else the first photo asset of
-- any memory in the manifest. Acceptable staleness vs. a later saved cover
-- edit is the same trade the web list already made.

alter table public.memory_books
  add column cover_asset_key text;

comment on column public.memory_books.cover_asset_key is
  'R2 object key of the representative cover photo for shelf/list surfaces. '
  'Written by the publish CAS in workflow-memory-book-bridge; null for '
  'books that never reached ready (the app renders a placeholder wash).';

-- Backfill existing ready books, mirroring pickListThumbnailKey's
-- precedence. Pass 1: first cover candidate whose manifest entry has an
-- asset. (assets[0] may be a video poster; that is an image and matches
-- the web list's behavior.)
update public.memory_books mb
set cover_asset_key = pick.file
from (
  select b.id,
         (
           select c.file
           from (
             select ord,
                    b.book_document -> 'manifest' -> 'memories'
                      -> cand.candidate -> 'assets' -> 0 ->> 'file' as file
             from jsonb_array_elements_text(
                    b.book_document -> 'outline' -> 'coverCandidates'
                  ) with ordinality as cand(candidate, ord)
           ) c
           where c.file is not null
           order by c.ord
           limit 1
         ) as file
  from public.memory_books b
  where b.status = 'ready' and b.book_document is not null
) pick
where mb.id = pick.id and pick.file is not null;

-- Pass 2 fallback: any photo asset from any manifest memory.
update public.memory_books mb
set cover_asset_key = (
  select a.value ->> 'file'
  from jsonb_each(mb.book_document -> 'manifest' -> 'memories') m,
       jsonb_array_elements(m.value -> 'assets') a
  where a.value ->> 'kind' = 'photo' and a.value ->> 'file' is not null
  limit 1
)
where mb.status = 'ready'
  and mb.book_document is not null
  and mb.cover_asset_key is null;
