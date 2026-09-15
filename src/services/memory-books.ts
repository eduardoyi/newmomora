// Memory Book in-app scope picker service layer (plan §"5a.5",
// docs/plans/memory-book.md, owner decision 2026-09-07). See
// docs/features/memory-book-generation.md's "Client integration" section
// for the end-to-end contract this implements: insert a client-frozen
// `queued` row under RLS (owner/manager only), then dispatch
// `generate-memory-book`. No schema/API change -- both are already live in
// production (supabase/migrations/20260901100000_memory_books.sql,
// supabase/functions/generate-memory-book/index.ts).
import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database';
import { addDaysToDate, MEMORY_BOOK_PAGE_BUDGET, type MemoryBookScopeKind } from '@/utils/memory-book-scope';
import { invokeEdgeFunction, type ServiceError } from '@/services/ai';

export type MemoryBookRow = Database['public']['Tables']['memory_books']['Row'];

// Postgres unique_violation -- the `memory_books_one_active_per_scope`
// partial unique index (migration above) fires this when a queued/
// generating row already exists for the exact same scope. Same code/
// handling convention as the 23505 retry paths in services/memories.ts and
// services/content-safety.ts.
const POSTGRES_UNIQUE_VIOLATION = '23505';

function mapSupabaseError(error: { message: string; code?: string }): ServiceError {
  return { message: error.message, code: error.code };
}

const MEMORY_BOOK_LIST_COLUMNS =
  'id, family_id, child_id, status, scope_kind, scope_start_date, scope_end_date, scope_label, failure_reason, created_at';

export type MemoryBookListRow = Pick<
  MemoryBookRow,
  | 'id'
  | 'family_id'
  | 'child_id'
  | 'status'
  | 'scope_kind'
  | 'scope_start_date'
  | 'scope_end_date'
  | 'scope_label'
  | 'failure_reason'
  | 'created_at'
>;

/** Every book ever requested for this child (any status, including
 * historical failed/ready rows for an overlapping scope -- the plan is
 * explicit that scopes may repeat/overlap across completed books). Used
 * both to render the picker's status surface and, after an insert
 * conflict, to recover the existing active row without an error wall (see
 * `createMemoryBook` below). */
export async function fetchMemoryBooksForChild(
  familyId: string,
  childId: string,
): Promise<{ data: MemoryBookListRow[] | null; error: ServiceError | null }> {
  const { data, error } = await supabase
    .from('memory_books')
    .select(MEMORY_BOOK_LIST_COLUMNS)
    .eq('family_id', familyId)
    .eq('child_id', childId)
    .order('created_at', { ascending: false });

  if (error) {
    return { data: null, error: mapSupabaseError(error) };
  }
  return { data: data as MemoryBookListRow[], error: null };
}

export interface CreateMemoryBookInput {
  familyId: string;
  childId: string;
  requestedBy: string;
  scopeKind: MemoryBookScopeKind;
  /** Inclusive. Null only for 'everything'. */
  scopeStartDate: string | null;
  /** Inclusive. Null only for 'everything'. */
  scopeEndDate: string | null;
  scopeLabel: string;
}

export interface CreateMemoryBookResult {
  data: MemoryBookRow | null;
  error: ServiceError | null;
  /** True iff `error` is the one-active-per-scope unique-index conflict
   * (23505) -- the caller should refetch the list and show the already-
   * existing row's state instead of an error (locked design point 5). */
  conflict: boolean;
}

/**
 * Inserts the exact "just-queued" row shape the RLS with-check pins
 * (status 'queued', requested_by = auth.uid(), page_budget = 122, every
 * generation-identity/book_document column left at its column default of
 * null -- see the migration's insert policy). Any other shape is rejected
 * by RLS, not by this function.
 */
export async function createMemoryBook(input: CreateMemoryBookInput): Promise<CreateMemoryBookResult> {
  const { data, error } = await supabase
    .from('memory_books')
    .insert({
      family_id: input.familyId,
      child_id: input.childId,
      requested_by: input.requestedBy,
      scope_kind: input.scopeKind,
      scope_start_date: input.scopeStartDate,
      scope_end_date: input.scopeEndDate,
      scope_label: input.scopeLabel,
      page_budget: MEMORY_BOOK_PAGE_BUDGET,
    })
    .select('*')
    .single();

  if (error) {
    return { data: null, error: mapSupabaseError(error), conflict: error.code === POSTGRES_UNIQUE_VIOLATION };
  }
  return { data, error: null, conflict: false };
}

export interface GenerateMemoryBookResponse {
  success: true;
  status: 'ready' | 'generating';
  queued?: true;
  attemptId?: string;
}

/** Dispatches generation for an already-`queued` (or `failed`, on retry)
 * row. Non-2xx/network failure is surfaced as `error` -- the contract
 * (docs/features/memory-book-generation.md) says to treat that as a failed
 * dispatch attempt: the row is left exactly as it was (the dispatcher's own
 * reconciliation handles a stale queued row), never an error wall. */
export async function dispatchMemoryBookGeneration(
  memoryBookId: string,
): Promise<{ data: GenerateMemoryBookResponse | null; error: ServiceError | null }> {
  return invokeEdgeFunction<GenerateMemoryBookResponse>('generate-memory-book', { memoryBookId });
}

interface EligibilityRow {
  id: string;
  memory_family_members: { family_member_id: string }[] | null;
}

/**
 * Approximates `cloudflare/memory-book-worker/src/eligibility.ts`'s
 * `computeMemoryEligibility`: a memory is eligible iff it is tagged to
 * THIS child, or has no tags at all. One query per scope (locked design
 * point 3: "one cheap count query at picker-open"), fetching only ids and
 * tag rows -- never memory content -- for every memory in the window, then
 * counting eligibility client-side. This is intentionally NOT identical to
 * the generation worker's own eligibility pass: the worker also requires a
 * memory to be "printable" (`isPrintable`: has text OR at least one photo/
 * video). This count does not apply that filter, because every memory in
 * this app already has either `content` or a media attachment by
 * construction (the composer requires one) -- so in practice the two counts
 * coincide; this is a documented, deliberate divergence, not an oversight
 * (see docs/features/memory-book-generation.md).
 */
export async function countEligibleMemoriesForScope(
  familyId: string,
  childId: string,
  /** Inclusive. Null for 'everything' (no date filter at all). */
  startDate: string | null,
  /** Inclusive. Null for 'everything'. */
  endDate: string | null,
): Promise<{ data: number | null; error: ServiceError | null }> {
  let query = supabase
    .from('memories')
    .select('id, memory_family_members(family_member_id)')
    .eq('family_id', familyId);

  if (startDate) {
    query = query.gte('memory_date', startDate);
  }
  if (endDate) {
    // scope_end_date is frozen inclusive; the eligibility window (like the
    // generation bridge's own windowEndExclusive) is a half-open
    // [start, endExclusive) range.
    query = query.lt('memory_date', addDaysToDate(endDate, 1));
  }

  const { data, error } = await query;
  if (error) {
    return { data: null, error: mapSupabaseError(error) };
  }

  const rows = (data ?? []) as unknown as EligibilityRow[];
  const eligibleCount = rows.filter((row) => {
    const tags = row.memory_family_members ?? [];
    return tags.length === 0 || tags.some((tag) => tag.family_member_id === childId);
  }).length;

  return { data: eligibleCount, error: null };
}

// The web preview/checkout app -- see docs/features/memory-book-generation.md's
// "Client integration" section. A one-time signed-link handoff is a
// deliberately deferred seam (5b/5c concern); the app hands off to the
// web app's own (separate) auth for now, same convention as
// `INVITE_LINK_BASE_URL` in src/utils/invites.ts.
export const MEMORY_BOOK_WEB_BASE_URL = 'https://shop.usemomora.com/b';

export function memoryBookWebUrl(memoryBookId: string): string {
  return `${MEMORY_BOOK_WEB_BASE_URL}/${memoryBookId}`;
}
