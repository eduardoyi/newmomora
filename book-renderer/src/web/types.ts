/**
 * Narrow, HAND-PICKED row shapes for exactly the tables/columns this web app
 * reads — NOT a copy of the app's generated `src/types/database.ts` (this is
 * an isolated package with its own deps; see `supabaseClient.ts`'s header
 * comment for the "copied, not imported" boundary). Keep in sync BY HAND with
 * the real schema (`supabase/migrations/20260901100000_memory_books.sql`,
 * `..._memory_book_edits.sql`) if either changes — same maintenance contract
 * `theme.ts` already documents for its own copied tokens.
 */

export type MemoryBookStatus = 'queued' | 'generating' | 'ready' | 'failed';

export interface FamilyMembershipRow {
  id: string;
  family_id: string;
  role: string;
  family: { id: string; name: string; deleted_at: string | null } | null;
}

export interface MemoryBookRow {
  id: string;
  family_id: string;
  child_id: string | null;
  status: MemoryBookStatus;
  scope_label: string;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
  /** `{ outline, manifest }` (single-renderer contract) — null until `status = 'ready'`. */
  book_document: { outline: unknown; manifest: unknown } | null;
  child: { name: string } | null;
}

export interface MemoryBookEditsRow {
  book_id: string;
  family_id: string;
  edits: unknown;
  updated_at: string;
}

/** memory-book-5c plan Step 6: the buyer-scoped columns
 * `OrderStatusScreen` reads via a direct `memory_book_orders` SELECT (RLS
 * already restricts this to `requested_by = auth.uid()` -- see
 * `docs/features/memory-book-orders.md#rls`). Keep in sync BY HAND with
 * `supabase/migrations/20260908120000_memory_book_orders.sql` if it changes,
 * same maintenance contract as `MemoryBookRow`/`MemoryBookEditsRow` above. */
export type MemoryBookOrderStatus =
  | 'draft'
  | 'quoted'
  | 'paid'
  | 'rendering'
  | 'submitted'
  | 'in_production'
  | 'shipped'
  | 'delivered'
  | 'failed'
  | 'cancelled';

export interface MemoryBookOrderRow {
  id: string;
  book_id: string;
  status: MemoryBookOrderStatus;
  price_cents: number | null;
  shipping_cost_cents: number | null;
  currency: string;
  quoted_page_count: number | null;
  prodigi_order_id: string | null;
  failure_reason: string | null;
  refunded_at: string | null;
  created_at: string;
  updated_at: string;
}
