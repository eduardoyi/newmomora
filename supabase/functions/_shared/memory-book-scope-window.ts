/**
 * Scope-window resolution for an `everything` Memory Book, shared by
 * `workflow-memory-book-bridge` (generation) and `memory-book-edits` (picker
 * pool) so both always agree on the window.
 *
 * Window = [first ELIGIBLE memory on/after the child's date of birth,
 *           latest family memory + 1 day).
 * "Eligible" mirrors the worker's eligibility rule: a memory with no tags, or
 * one tagged to the book's child. With no child (family-wide book) the first
 * memory is eligible. See docs/plans/memory-book-everything-phase2.md 2.1.
 *
 * Every query error throws `ScopeWindowError` -- never the empty-window
 * sentinel (a failed read must not read as "family has no memories").
 * Messages carry no memory content; callers log ids/counts only.
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

/** No memory can ever match a window at/before its own start (a strict
 * gte/lt pair), so this sentinel makes a family with no eligible memories
 * yield an empty result through the SAME query path, rather than a malformed
 * date reaching Postgres. */
export const EMPTY_WINDOW_SENTINEL = '0001-01-01';

/** Rows per page of the ascending first-eligible scan. */
export const SCOPE_WINDOW_PAGE_SIZE = 200;
/** Pages scanned before giving up (~10k memories without an eligible one). */
export const SCOPE_WINDOW_MAX_PAGES = 50;

/** Thrown when the `everything` window cannot be resolved: a DB/PostgREST
 * error, or the scan cap was hit. Callers map it to a 5xx, never to an
 * empty window. */
export class ScopeWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeWindowError';
  }
}

export function addDaysToDateOnly(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const utcMs = Date.UTC(year, month - 1, day) + days * 24 * 60 * 60 * 1000;
  const dt = new Date(utcMs);
  const pad = (n: number, width: number) => String(n).padStart(width, '0');
  return `${pad(dt.getUTCFullYear(), 4)}-${pad(dt.getUTCMonth() + 1, 2)}-${pad(dt.getUTCDate(), 2)}`;
}

interface ScanRow {
  id: string;
  memory_date: string;
  memory_family_members: Array<{ family_member_id: string }> | null;
}

export async function resolveEverythingWindow(
  supabase: SupabaseClient,
  input: { familyId: string; childId: string | null; childDateOfBirth: string | null },
): Promise<{ start: string; endExclusive: string }> {
  const { familyId, childId, childDateOfBirth } = input;
  const emptyWindow = { start: EMPTY_WINDOW_SENTINEL, endExclusive: EMPTY_WINDOW_SENTINEL };

  // End: the latest family memory (D2 only changes the start).
  const latestResult = await supabase
    .from('memories')
    .select('memory_date')
    .eq('family_id', familyId)
    .order('memory_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestResult.error) throw new ScopeWindowError('latest_memory_query_failed');
  const latestDate = (latestResult.data as { memory_date: string } | null)?.memory_date;
  if (!latestDate) return emptyWindow;

  // Start: first eligible memory on/after DOB. Paged ascending scan with a
  // LEFT embed of the tag rows (`memory_family_members` has exactly one FK to
  // `memories`, so the embed is unambiguous -- no PGRST201). Eligibility is
  // evaluated here rather than via a PostgREST `is.null` embed filter.
  for (let page = 0; page < SCOPE_WINDOW_MAX_PAGES; page += 1) {
    const from = page * SCOPE_WINDOW_PAGE_SIZE;
    let query = supabase
      .from('memories')
      .select('id, memory_date, memory_family_members(family_member_id)')
      .eq('family_id', familyId);
    if (childDateOfBirth) query = query.gte('memory_date', childDateOfBirth);
    const { data, error } = await query
      .order('memory_date', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + SCOPE_WINDOW_PAGE_SIZE - 1);
    if (error) throw new ScopeWindowError('first_eligible_scan_failed');

    const rows = (data ?? []) as ScanRow[];
    for (const row of rows) {
      const tags = row.memory_family_members ?? [];
      const eligible = childId === null || tags.length === 0 || tags.some((t) => t.family_member_id === childId);
      if (eligible) {
        return { start: row.memory_date, endExclusive: addDaysToDateOnly(latestDate, 1) };
      }
    }
    if (rows.length < SCOPE_WINDOW_PAGE_SIZE) return emptyWindow;
  }
  throw new ScopeWindowError('first_eligible_scan_cap_exceeded');
}
