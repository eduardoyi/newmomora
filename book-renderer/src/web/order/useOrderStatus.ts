import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../supabaseClient';
import type { MemoryBookOrderRow } from '../types';
import { isTerminalOrderStatus } from './orderStatusCopy';
import { getFixtureSlug, fixtureGetOrder, fixtureOrderRow } from '../dev/fixture';

const POLL_INTERVAL_MS = 5000;

interface State {
  loading: boolean;
  error: string | null;
  order: MemoryBookOrderRow | null;
}

/**
 * `OrderStatusScreen`'s data source (memory-book-5c plan Step 6): a direct
 * `memory_book_orders` SELECT — RLS already scopes this to the buyer
 * (`requested_by = auth.uid()`, see
 * `docs/features/memory-book-orders.md#rls`), so there is no need to go
 * through the `memory-book-orders` Edge Function's `status` op (which the
 * function's own header comment calls "a convenience read... RLS select
 * already covers this for a direct client query"). A direct select also
 * returns `book_id`, which the `status` op's response shape omits and this
 * screen needs for its "back to your book" link.
 *
 * Polls every 5s (same interval `useFamilyBooks.ts` uses for generating
 * books) while the order is in a non-terminal status
 * (`orderStatusCopy.ts#isTerminalOrderStatus`); stops automatically once it
 * reaches `delivered`/`failed`/`cancelled`. `refunded_at` is independent of
 * `status` (docs' Refund recording section) so it never re-arms polling on
 * its own.
 */
export function useOrderStatus(orderId: string) {
  const [state, setState] = useState<State>({ loading: true, error: null, order: null });
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(
    async (isPoll: boolean) => {
      if (!isPoll) setState((s) => ({ ...s, loading: true, error: null }));

      // DEV-ONLY fixture mode — see `dev/fixture.ts`'s header comment for
      // the tree-shaking contract `check-web-bundle.mjs` verifies.
      if (import.meta.env.DEV && getFixtureSlug()) {
        const fixtureOrder = fixtureGetOrder(orderId);
        if (!fixtureOrder) {
          setState({ loading: false, error: 'Order not found.', order: null });
          return;
        }
        const row = fixtureOrderRow(fixtureOrder);
        setState({ loading: false, error: null, order: row });
        if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
        if (!isTerminalOrderStatus(row.status)) {
          pollTimerRef.current = setTimeout(() => void load(true), POLL_INTERVAL_MS);
        }
        return;
      }

      const { data, error } = await supabase
        .from('memory_book_orders')
        .select(
          'id, book_id, status, price_cents, shipping_cost_cents, currency, quoted_page_count, prodigi_order_id, failure_reason, refunded_at, created_at, updated_at',
        )
        .eq('id', orderId)
        .maybeSingle();

      if (error) {
        setState({ loading: false, error: error.message, order: null });
        return;
      }
      if (!data) {
        setState({ loading: false, error: 'Order not found, or you do not have access to it.', order: null });
        return;
      }

      const row = data as unknown as MemoryBookOrderRow;
      setState({ loading: false, error: null, order: row });

      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      if (!isTerminalOrderStatus(row.status)) {
        pollTimerRef.current = setTimeout(() => void load(true), POLL_INTERVAL_MS);
      }
    },
    [orderId],
  );

  useEffect(() => {
    void load(false);
    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [load]);

  return { ...state, reload: () => load(false) };
}
