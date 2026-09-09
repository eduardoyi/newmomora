import { useEffect, useState } from 'react';
import { supabase } from '../supabaseClient';
import { getFixtureSlug, fixtureHasOrders } from '../dev/fixture';

/**
 * Cheap existence check backing `BookViewScreen`'s "Your orders" entry
 * point (memory-book-5c order-status UX round, item 2: "on the book view
 * near 'Order this book' when the buyer has past orders"). A `limit(1)`
 * probe, not a full `useOrders()` fetch — this hook only needs to know
 * whether the link should render at all, not the order data itself (the
 * `/orders` screen the link points to does its own real fetch).
 *
 * RLS scopes `memory_book_orders` to the buyer already (see
 * `useOrders.ts`'s header comment), so no extra filter is needed here
 * either.
 */
export function useHasPastOrders(): boolean {
  const [hasOrders, setHasOrders] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (import.meta.env.DEV && getFixtureSlug()) {
        if (!cancelled) setHasOrders(fixtureHasOrders());
        return;
      }
      // Same bare-`draft` exclusion as `useOrders.ts` -- a buyer whose only
      // rows are abandoned draft shells has nothing to see on /orders, so
      // the link shouldn't render for them either.
      const { data, error } = await supabase.from('memory_book_orders').select('id').neq('status', 'draft').limit(1);
      if (cancelled || error) return;
      setHasOrders((data?.length ?? 0) > 0);
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return hasOrders;
}
