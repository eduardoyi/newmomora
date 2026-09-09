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
  /** The quoted shipping destination, persisted by the `quote` op
   * (camelCase JSON, same shape as `order/types.ts`'s
   * `ShippingAddressInput` — the server's `ShippingAddress` interface owns
   * it). Null until `quoted`. Shown on `OrderStatusScreen` so a buyer can
   * catch a wrong address while the kept 2h Prodigi edit window can still
   * fix it. Declared structurally here rather than importing from
   * `order/types.ts` — this file is the web package's base types module
   * and imports nothing. */
  shipping_address: {
    name: string;
    line1: string;
    line2?: string;
    city?: string;
    state?: string;
    postalCode: string;
    countryCode: string;
  } | null;
  /** memory-book-5c order-status UX round, item 3 (migration
   * `20260909130000_memory_book_order_tracking.sql`). All three null until
   * the sweep extracts them from Prodigi's shipments array on the `shipped`
   * transition -- and `tracking_url`/`carrier` can stay null even once
   * `tracking_number` is set, since Prodigi doesn't guarantee either. */
  tracking_number: string | null;
  tracking_url: string | null;
  carrier: string | null;
  created_at: string;
  updated_at: string;
}

/** A row from the buyer's own order history (`OrdersListScreen`/`useOrders.ts`
 * -- memory-book-5c order-status UX round, item 2). Deliberately a NARROWER
 * projection than `MemoryBookOrderRow` (no shipping address/Stripe/Prodigi
 * ids -- the list view never needs them) plus a `book_title` the row itself
 * doesn't carry, resolved via a join against `memory_books` (RLS: the buyer
 * is a family member of every book they've ordered, so `is_family_member`
 * already allows the embedded read -- see `useOrders.ts`'s own comment). */
export interface MemoryBookOrderListRow {
  id: string;
  book_id: string;
  status: MemoryBookOrderStatus;
  price_cents: number | null;
  shipping_cost_cents: number | null;
  currency: string;
  refunded_at: string | null;
  created_at: string;
  /** Falls back to a generic label if the joined book row is unreadable
   * (e.g. RLS hides it because the buyer left the family since ordering) --
   * see `useOrders.ts`'s `FALLBACK_BOOK_TITLE`. */
  book_title: string;
}
