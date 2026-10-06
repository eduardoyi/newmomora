import { useCallback, useEffect, useRef, useState } from 'react';
import { getHolidayCard } from './cardApi';
import { CardApiError, type HolidayCardView } from './cardTypes';
import { pollIntervalMs, shouldRefetchOnImageError, shouldRefetchOnVisible } from './editorState';

/**
 * Server state for one holiday card: `get`, polled while something is in
 * motion (5 s while generating, 30 s while the film renders), refetched when
 * the tab becomes visible again and when an image fails to load (an expired
 * signed URL). It holds ONLY server state; the user's unsaved edits live in
 * the save queue (`CardEditsProvider`), which rebases onto what this reads.
 */

export interface UseHolidayCard {
  status: 'loading' | 'ready' | 'error';
  view: HolidayCardView | null;
  /** The last failed read (kept while a stale `view` is still shown). */
  error: CardApiError | null;
  /** Epoch ms of the last successful read. */
  fetchedAt: number;
  /** Reads now; resolves with the new view (null when it failed). Concurrent callers share one read. */
  refetch: () => Promise<HolidayCardView | null>;
  /** Call when an `<img>` fails to load: refetches (throttled) for fresh signed URLs. */
  reportImageError: () => void;
}

export function useHolidayCard(cardId: string): UseHolidayCard {
  const [state, setState] = useState<{ status: UseHolidayCard['status']; view: HolidayCardView | null; error: CardApiError | null; fetchedAt: number }>({
    status: 'loading',
    view: null,
    error: null,
    fetchedAt: 0,
  });
  const seq = useRef(0);
  const inFlight = useRef<Promise<HolidayCardView | null> | null>(null);
  const fetchedAtRef = useRef(0);
  const mounted = useRef(true);

  const refetch = useCallback((): Promise<HolidayCardView | null> => {
    if (inFlight.current) return inFlight.current;
    const mine = (seq.current += 1);
    const p = (async () => {
      try {
        const view = await getHolidayCard(cardId);
        if (!mounted.current || mine !== seq.current) return view;
        const now = Date.now();
        fetchedAtRef.current = now;
        setState({ status: 'ready', view, error: null, fetchedAt: now });
        return view;
      } catch (e) {
        const error = e instanceof CardApiError ? e : new CardApiError(0, 'network_error', "We couldn't load your card.");
        if (mounted.current && mine === seq.current) {
          // Keep showing the last good view on a failed refresh; only a first load fails the screen.
          setState((prev) => ({ ...prev, status: prev.view ? 'ready' : 'error', error, fetchedAt: prev.fetchedAt }));
        }
        return null;
      } finally {
        inFlight.current = null;
      }
    })();
    inFlight.current = p;
    return p;
  }, [cardId]);

  useEffect(() => {
    mounted.current = true;
    void refetch();
    return () => {
      mounted.current = false;
    };
  }, [refetch]);

  // Poll while something is in motion.
  const interval = pollIntervalMs(state.view);
  useEffect(() => {
    if (interval === null) return undefined;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void refetch();
    }, interval);
    return () => clearInterval(id);
  }, [interval, refetch]);

  // Back on the tab: the data (and its signed URLs) may be old.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === 'visible' && shouldRefetchOnVisible(fetchedAtRef.current, Date.now())) void refetch();
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refetch]);

  const reportImageError = useCallback(() => {
    if (shouldRefetchOnImageError(fetchedAtRef.current, Date.now())) void refetch();
  }, [refetch]);

  return { status: state.status, view: state.view, error: state.error, fetchedAt: state.fetchedAt, refetch, reportImageError };
}
