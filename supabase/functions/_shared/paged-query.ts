/**
 * Paging + id-chunking helpers for PostgREST reads inside Edge Functions.
 *
 * Two hard limits make these necessary:
 * - `max_rows = 1000`: a plain select silently truncates at 1000 rows.
 * - URL length: `.in('memory_id', ids)` puts every id in the query string
 *   (36 chars each), and the gateway rejects URLs past a size limit. A
 *   ~776-id list produced the Memory Book "everything" incident
 *   (docs/plans/memory-book-everything-fixes.md), where the rejected query's
 *   error was swallowed and the book printed without photos/tags.
 *
 * Every helper THROWS on a query error (never returns a partial/empty
 * result), so a caller can never mistake a failed read for "no rows".
 * Callers must give each query a stable, existing `.order(...)` key so
 * offset paging is deterministic.
 */

export const PAGE_SIZE = 1000;

export type PageResult<T> = PromiseLike<{
  data: T[] | null;
  error: { message: string; code?: string } | null;
}>;

/** Thrown when any page of a paged read fails. Carries no row content. */
export class PagedQueryError extends Error {
  readonly code: string | null;

  constructor(code: string | null = null) {
    super('page_failed');
    this.name = 'PagedQueryError';
    this.code = code;
  }
}

export interface FetchAllOptions<T> {
  pageSize?: number;
  /**
   * Offset paging under concurrent inserts can repeat a row across a page
   * boundary; when given, rows sharing a key are returned once (first wins).
   */
  dedupeKey?: (row: T) => string;
}

export async function fetchAll<T>(
  page: (from: number, to: number) => PageResult<T>,
  options: FetchAllOptions<T> = {},
): Promise<T[]> {
  const pageSize = options.pageSize ?? PAGE_SIZE;
  const out: T[] = [];
  const seen = options.dedupeKey ? new Set<string>() : null;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await page(from, from + pageSize - 1);
    if (error) throw new PagedQueryError(error.code ?? null);
    const rows = data ?? [];
    for (const row of rows) {
      if (seen && options.dedupeKey) {
        const key = options.dedupeKey(row);
        if (seen.has(key)) continue;
        seen.add(key);
      }
      out.push(row);
    }
    // Termination uses the RAW page length, not the deduped count.
    if (rows.length < pageSize) return out;
  }
}

export interface ByMemoryIdsOptions<T> {
  /** Ids per `.in()` call. Required: callers pick it deliberately. */
  chunkSize: number;
  pageSize?: number;
  dedupeKey?: (row: T) => string;
}

/**
 * Runs `page` once per id chunk (sequentially, no fan-out), paging each
 * chunk to exhaustion. Dedupe (when configured) spans the whole result.
 */
export async function byMemoryIds<T>(
  ids: string[],
  page: (chunk: string[], from: number, to: number) => PageResult<T>,
  options: ByMemoryIdsOptions<T>,
): Promise<T[]> {
  if (!Number.isInteger(options.chunkSize) || options.chunkSize < 1) {
    throw new RangeError('chunkSize must be a positive integer');
  }
  const out: T[] = [];
  const seen = options.dedupeKey ? new Set<string>() : null;
  for (let i = 0; i < ids.length; i += options.chunkSize) {
    const chunk = ids.slice(i, i + options.chunkSize);
    const rows = await fetchAll<T>((from, to) => page(chunk, from, to), { pageSize: options.pageSize });
    for (const row of rows) {
      if (seen && options.dedupeKey) {
        const key = options.dedupeKey(row);
        if (seen.has(key)) continue;
        seen.add(key);
      }
      out.push(row);
    }
  }
  return out;
}
