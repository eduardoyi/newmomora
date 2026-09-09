import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../supabaseClient';
import type { MemoryBookOrderListRow } from '../types';
import { isTerminalOrderStatus } from './orderStatusCopy';
import { getFixtureSlug, fixtureListOrders } from '../dev/fixture';

const POLL_INTERVAL_MS = 5000;
const FALLBACK_BOOK_TITLE = 'Memory Book';

interface State {
  loading: boolean;
  error: string | null;
  orders: MemoryBookOrderListRow[] | null;
}

interface OrderListQueryRow {
  id: string;
  book_id: string;
  status: MemoryBookOrderListRow['status'];
  price_cents: number | null;
  shipping_cost_cents: number | null;
  currency: string;
  refunded_at: string | null;
  created_at: string;
  // supabase-js embeds a to-one FK relationship as an object when the FK is
  // unique/one row per parent, but as an array when it can't prove that --
  // `book_id` isn't itself unique on this table (a book can have more than
  // one order — reorders, gifting), so PostgREST embeds `memory_books` as a
  // single object keyed off THIS row's `book_id`, matching every other
  // to-one embed already in this codebase (`useFamilyBooks.ts`'s own
  // `child:family_members(name)`). Typed as `null` too since RLS can hide
  // the joined row (see FALLBACK_BOOK_TITLE below) without erroring the
  // whole query.
  book: { scope_label: string; child: { name: string } | null } | null;
}

function bookTitle(book: OrderListQueryRow['book']): string {
  if (!book) return FALLBACK_BOOK_TITLE;
  return book.child?.name ? `${book.child.name} — ${book.scope_label}` : book.scope_label;
}

/**
 * "Your orders" screen's data source (memory-book-5c order-status UX round,
 * item 2): a direct `memory_book_orders` SELECT joined against
 * `memory_books` for the title. RLS on `memory_book_orders` already scopes
 * this to the buyer (`requested_by = auth.uid()` — same table
 * `useOrderStatus.ts` reads, see that hook's own header comment), so no
 * additional filter is needed here; the `memory_books` embed relies on
 * `is_family_member(family_id)` (that table's own SELECT policy) — the
 * buyer, being who placed the order, is necessarily a member of the book's
 * family, so the join is always readable UNLESS they've since left that
 * family, in which case it comes back `null` and `bookTitle()` falls back
 * to a generic label rather than erroring the whole list.
 *
 * Polls every 5s (same interval `useOrderStatus.ts`/`useFamilyBooks.ts`
 * use) while ANY order in the list is non-terminal, stopping once every row
 * is `delivered`/`failed`/`cancelled`.
 */
export function useOrders() {
  const [state, setState] = useState<State>({ loading: true, error: null, orders: null });
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (isPoll: boolean) => {
    if (!isPoll) setState((s) => ({ ...s, loading: true, error: null }));

    // DEV-ONLY fixture mode — see `dev/fixture.ts`'s header comment for the
    // tree-shaking contract `check-web-bundle.mjs` verifies.
    if (import.meta.env.DEV && getFixtureSlug()) {
      const orders = fixtureListOrders();
      setState({ loading: false, error: null, orders });
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      if (orders.some((o) => !isTerminalOrderStatus(o.status))) {
        pollTimerRef.current = setTimeout(() => void load(true), POLL_INTERVAL_MS);
      }
      return;
    }

    const { data, error } = await supabase
      .from('memory_book_orders')
      .select(
        'id, book_id, status, price_cents, shipping_cost_cents, currency, refunded_at, created_at, book:memory_books(scope_label, child:family_members(name))',
      )
      // Bare `draft` shells never surface: one is created the moment the
      // checkout screen mounts (CheckoutScreen.tsx's own header comment on
      // `create_draft`), so every abandoned "Order this book" click leaves
      // one behind by design -- a wall of meaningless "Not started" rows
      // (owner-reported, 2026-09-09). The first status a buyer should ever
      // see here is `quoted` (they at least entered an address).
      .neq('status', 'draft')
      .order('created_at', { ascending: false });

    if (error) {
      setState({ loading: false, error: error.message, orders: null });
      return;
    }

    const rows = (data ?? []) as unknown as OrderListQueryRow[];
    const orders: MemoryBookOrderListRow[] = rows.map((row) => ({
      id: row.id,
      book_id: row.book_id,
      status: row.status,
      price_cents: row.price_cents,
      shipping_cost_cents: row.shipping_cost_cents,
      currency: row.currency,
      refunded_at: row.refunded_at,
      created_at: row.created_at,
      book_title: bookTitle(row.book),
    }));
    setState({ loading: false, error: null, orders });

    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    if (orders.some((o) => !isTerminalOrderStatus(o.status))) {
      pollTimerRef.current = setTimeout(() => void load(true), POLL_INTERVAL_MS);
    }
  }, []);

  useEffect(() => {
    void load(false);
    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [load]);

  return { ...state, reload: () => load(false) };
}
