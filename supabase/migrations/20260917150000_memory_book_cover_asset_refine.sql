-- Memory-book shelf redesign -- precedence fix (device-testing finding,
-- 2026-09-17): migration 20260917120000_memory_book_cover_asset.sql's
-- backfill picked `cover_asset_key` via an `assets[0]`-of-first-resolving-
-- candidate precedence that does NOT match the book's real rendered cover
-- (`book-renderer/src/model/fitter.ts`'s `buildCoverPages`). That earlier
-- migration already ran against the live DB and is NOT edited here --
-- this migration RE-BACKFILLS every `status = 'ready'` row with the
-- corrected precedence, in SQL, mirroring `buildCoverPages` (and its
-- `effectiveCoverWidth`/`pickMiddleOfRangeCoverPhoto` helpers) as closely
-- as jsonb querying allows. The Edge Function side
-- (`supabase/functions/_shared/memory-book-cover.ts`'s `pickCoverAssetKey`,
-- used by `workflow-memory-book-bridge`'s `handlePublish` for every NEW
-- publish going forward) already implements the exact JS algorithm; this
-- migration exists only to correct the column for books published BEFORE
-- that fix landed.
--
-- Precedence mapping (see pickCoverAssetKey's own header comment for the
-- canonical description):
--   pass1 -- outline.coverCandidates, in order; within each candidate's
--     own memory, the first (asset-array order) kind='photo' asset with
--     coalesce(originalWidth, width) >= 2000. `order by (cand_ord,
--     ast_ord) limit 1` over every qualifying (candidate, asset) pair
--     achieves exactly this: a lower cand_ord always outranks a higher
--     one regardless of ast_ord, and within one candidate the lowest
--     ast_ord (its own array order) wins.
--   pass2 -- legacy heroCandidates fallback, NO width floor. Memory
--     iteration order is ARBITRARY in SQL (jsonb_each has no defined
--     order, unlike the JS algorithm's Object.entries insertion order) --
--     accepted for this one-time backfill of already-published books (any
--     qualifying hero photo is a reasonable cover); ordered by
--     memory_id/asset-order only for migration determinism and
--     idempotency, not to reproduce the JS key order. Every NEW publish
--     still goes through the exact JS precedence in `handlePublish`
--     regardless of this approximation.
--   pass3 -- width-gated photo (kind='photo', effective width >= 2000)
--     whose memory date is closest to the midpoint of
--     manifest.scope.start/end; ties broken by widest effective width,
--     then lowest memory id (string compare). An unparseable scope/date
--     sorts as +infinity distance (float8 'infinity') -- same NaN-safe
--     "never closest unless it's the only qualifier" behavior as the JS
--     helper's own `Number.POSITIVE_INFINITY` fallback.
-- `cover_asset_key` is OVERWRITTEN (including to NULL when nothing
-- qualifies) rather than coalesced against the existing value -- the old
-- value may be wrong, so it must never be trusted as a fallback.

with ready_books as (
  select id, book_document
  from public.memory_books
  where status = 'ready' and book_document is not null
),
resolved as (
  select
    rb.id,

    -- Pass 1.
    case
      when jsonb_typeof(coalesce(rb.book_document -> 'outline' -> 'coverCandidates', '[]'::jsonb)) = 'array'
       and jsonb_typeof(coalesce(rb.book_document -> 'manifest' -> 'memories', '{}'::jsonb)) = 'object'
      then (
        select ast.value ->> 'file'
        from jsonb_array_elements_text(rb.book_document -> 'outline' -> 'coverCandidates')
               with ordinality as cand(candidate, cand_ord)
        cross join lateral jsonb_array_elements(
          coalesce(rb.book_document -> 'manifest' -> 'memories' -> cand.candidate -> 'assets', '[]'::jsonb)
        ) with ordinality as ast(value, ast_ord)
        where ast.value ->> 'kind' = 'photo'
          and coalesce(
                case when (ast.value ->> 'originalWidth') ~ '^-?\d+(\.\d+)?$' then (ast.value ->> 'originalWidth')::numeric end,
                case when (ast.value ->> 'width') ~ '^-?\d+(\.\d+)?$' then (ast.value ->> 'width')::numeric end
              ) >= 2000
        order by cand.cand_ord, ast.ast_ord
        limit 1
      )
      else null
    end as pass1_file,

    -- Pass 2.
    case
      when jsonb_typeof(coalesce(rb.book_document -> 'outline' -> 'heroCandidates', '[]'::jsonb)) = 'array'
       and jsonb_typeof(coalesce(rb.book_document -> 'manifest' -> 'memories', '{}'::jsonb)) = 'object'
      then (
        select ast.value ->> 'file'
        from jsonb_each(rb.book_document -> 'manifest' -> 'memories') as mem(memory_id, memory_value)
        cross join lateral jsonb_array_elements(coalesce(mem.memory_value -> 'assets', '[]'::jsonb))
               with ordinality as ast(value, ast_ord)
        where mem.memory_id in (
          select jsonb_array_elements_text(rb.book_document -> 'outline' -> 'heroCandidates')
        )
        and ast.value ->> 'kind' = 'photo'
        order by mem.memory_id, ast.ast_ord
        limit 1
      )
      else null
    end as pass2_file,

    -- Pass 3.
    case
      when jsonb_typeof(coalesce(rb.book_document -> 'manifest' -> 'memories', '{}'::jsonb)) = 'object'
      then (
        select cand.file
        from (
          select
            mem.memory_id,
            ast.value ->> 'file' as file,
            coalesce(
              case when (ast.value ->> 'originalWidth') ~ '^-?\d+(\.\d+)?$' then (ast.value ->> 'originalWidth')::numeric end,
              case when (ast.value ->> 'width') ~ '^-?\d+(\.\d+)?$' then (ast.value ->> 'width')::numeric end
            ) as effective_width,
            case
              when (rb.book_document -> 'manifest' -> 'scope' ->> 'start') ~ '^\d{4}-\d{2}-\d{2}'
               and (rb.book_document -> 'manifest' -> 'scope' ->> 'end')   ~ '^\d{4}-\d{2}-\d{2}'
               and (mem.memory_value ->> 'date') ~ '^\d{4}-\d{2}-\d{2}'
              then abs(
                extract(epoch from (mem.memory_value ->> 'date')::timestamp)
                - (
                    extract(epoch from (rb.book_document -> 'manifest' -> 'scope' ->> 'start')::timestamp)
                  + extract(epoch from (rb.book_document -> 'manifest' -> 'scope' ->> 'end')::timestamp)
                  ) / 2
              )
              else 'infinity'::float8
            end as distance
          from jsonb_each(rb.book_document -> 'manifest' -> 'memories') as mem(memory_id, memory_value)
          cross join lateral jsonb_array_elements(coalesce(mem.memory_value -> 'assets', '[]'::jsonb)) as ast(value)
          where ast.value ->> 'kind' = 'photo'
            and coalesce(
                  case when (ast.value ->> 'originalWidth') ~ '^-?\d+(\.\d+)?$' then (ast.value ->> 'originalWidth')::numeric end,
                  case when (ast.value ->> 'width') ~ '^-?\d+(\.\d+)?$' then (ast.value ->> 'width')::numeric end
                ) >= 2000
        ) cand
        order by cand.distance asc, cand.effective_width desc, cand.memory_id asc
        limit 1
      )
      else null
    end as pass3_file
  from ready_books rb
)
update public.memory_books mb
set cover_asset_key = coalesce(resolved.pass1_file, resolved.pass2_file, resolved.pass3_file)
from resolved
where mb.id = resolved.id;
