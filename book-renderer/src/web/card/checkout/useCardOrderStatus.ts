import { useCallback, useEffect, useRef, useState } from 'react';
import { CardApiError } from '../cardTypes';
import { FIXTURE_STATUS_POLL_MS, isCardFixture } from '../dev/cardFixture';
import { getCardOrderStatus } from './cardOrdersApi';
import { shouldPollStatus, STATUS_POLL_MS } from './cardOrderStatusCopy';
import type { CardOrderStatus } from './checkoutTypes';
import { describeCheckoutError, type ErrorView } from './errorCopy';

/** Failures in a row before the panel says it cannot refresh (it keeps retrying quietly either way). */
const SOFT_FAIL_AFTER = 3;

export interface UseCardOrderStatus {
  status: 'loading' | 'ready' | 'error';
  order: CardOrderStatus | null;
  /** Set for a first-load failure (no order to show). */
  error: ErrorView | null;
  /** Several refreshes failed in a row (the last good status stays on screen). */
  stale: boolean;
  /** Epoch ms of the first read (for "taking longer than usual" copy). */
  startedAt: number;
  reload: () => void;
}

/**
 * One order's status: read now, then every 5 s while the order is still before
 * the printer (draft / quoted / checkout / paid). A transient failure keeps the
 * last good status and retries; only a first-load failure (or 404) is an error.
 */
export function useCardOrderStatus(orderId: string): UseCardOrderStatus {
  const [state, setState] = useState<{ status: UseCardOrderStatus['status']; order: CardOrderStatus | null; error: ErrorView | null; stale: boolean }>({
    status: 'loading',
    order: null,
    error: null,
    stale: false,
  });
  const [startedAt] = useState(() => Date.now());
  const [nonce, setNonce] = useState(0);
  const failures = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    failures.current = 0;

    async function read() {
      try {
        const order = await getCardOrderStatus(orderId);
        if (cancelled) return;
        failures.current = 0;
        setState({ status: 'ready', order, error: null, stale: false });
        if (shouldPollStatus(order.status)) schedule();
      } catch (e) {
        if (cancelled) return;
        const err = e instanceof CardApiError ? e : new CardApiError(0, 'network_error', 'Network error');
        failures.current += 1;
        if (err.status === 404 || err.status === 401 || err.status === 403) {
          setState({ status: 'error', order: null, error: describeCheckoutError(err), stale: false });
          return;
        }
        setState((prev) =>
          prev.order
            ? { ...prev, stale: failures.current >= SOFT_FAIL_AFTER }
            : failures.current >= SOFT_FAIL_AFTER
              ? { status: 'error', order: null, error: describeCheckoutError(err), stale: false }
              : prev,
        );
        schedule();
      }
    }
    function schedule() {
      const pollMs = import.meta.env.DEV && isCardFixture() ? FIXTURE_STATUS_POLL_MS : STATUS_POLL_MS;
      timer = setTimeout(() => void read(), pollMs);
    }

    void read();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [orderId, nonce]);

  const reload = useCallback(() => {
    setState((prev) => (prev.order ? prev : { status: 'loading', order: null, error: null, stale: false }));
    setNonce((n) => n + 1);
  }, []);

  return { ...state, startedAt, reload };
}
