// Memory Book in-app scope picker (docs/plans/memory-book.md §"5a.5", owner
// decision 2026-09-07). See docs/features/memory-book-generation.md's
// "Client integration" section for the contract this implements.
import { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useAuth } from '@/hooks/use-auth';
import {
  familyMemoryBooksQueryKey,
  keepsakesOverviewQueryKey,
  memoryBookEligibilityQueryKey,
  memoryBooksQueryKey,
} from '@/hooks/queryKeys';
import {
  countEligibleMemoriesForScope,
  createMemoryBook,
  dispatchMemoryBookGeneration,
  fetchExampleCoverAssetKey,
  fetchMemoryBooksForChild,
  fetchMemoryBooksForFamily,
  type MemoryBookListRow,
} from '@/services/memory-books';
import {
  buildMemoryBookScopeOptions,
  memoryBookMatchesScope,
  memoryBookScopeKey,
  thinPeriodReason,
  type MemoryBookScopeOption,
} from '@/utils/memory-book-scope';
import { getLocalTodayIso } from '@/utils/portrait-versions';

// Locked design point 4: queued/generating both render as the same
// "progress" state (~3 minute expectation); ready/failed are their own
// terminal states. 'available'/'thin' cover the no-book-yet case.
export type MemoryBookDisplayStatus = 'available' | 'thin' | 'in_progress' | 'ready' | 'failed';

/** What `generate` reports: a new row was created and dispatched; the exact
 * scope already had an active row (23505 conflict -- the existing row's own
 * status renders); or the insert / dispatch failed (see the row's
 * `dispatchError`). */
export type GenerateMemoryBookResult = 'started' | 'exists' | 'error';

export interface MemoryBookScopeRow {
  key: string;
  option: MemoryBookScopeOption;
  /** The most relevant existing row for this exact scope, or null if none
   * has ever been requested (see `pickRelevantBook` below for tie-break). */
  book: MemoryBookListRow | null;
  status: MemoryBookDisplayStatus;
  /** Null while the eligibility count for this scope hasn't loaded yet. */
  eligibleCount: number | null;
  /** Thin-period copy ("12 memories in this period — books need about
   * 30"), only set when status === 'thin'. */
  disabledReason: string | null;
  /** A transient (this-session-only) error from a dispatch call that
   * itself failed to reach the server -- distinct from a persisted
   * `failed` book row. Cleared on the next generate/retry attempt. */
  dispatchError: string | null;
  /** True while a generate/retry/retryDispatch call for this row's scope
   * is in flight. */
  isPending: boolean;
}

interface UseMemoryBooksParams {
  familyId: string | null | undefined;
  childId: string | undefined;
  dateOfBirth: string | null | undefined;
  // Supplied by a caller that recomputes it (Keepsakes, on focus); otherwise
  // frozen for this mount.
  todayIso?: string;
}

const BOOK_POLL_INTERVAL_MS = 4000;

function hasActiveBook(rows: readonly MemoryBookListRow[] | undefined): boolean {
  return (rows ?? []).some((row) => row.status === 'queued' || row.status === 'generating');
}

/** Locked design point 4: an existing row (any non-failed status) always
 * takes over the status surface for its scope. Among several rows for the
 * identical scope (overlapping/repeated requests over time are allowed --
 * see docs/features/memory-book-generation.md), prefer an active
 * (queued/generating) one, then ready, then the most recent failed one --
 * so a long-past failure never outranks a book actually in flight or done. */
export function pickRelevantBook(matches: MemoryBookListRow[]): MemoryBookListRow | null {
  const active = matches.find((b) => b.status === 'queued' || b.status === 'generating');
  if (active) return active;
  const ready = matches.find((b) => b.status === 'ready');
  if (ready) return ready;
  return matches.find((b) => b.status === 'failed') ?? null;
}

/**
 * One status row per scope option for a child: the option, its most relevant
 * existing book (if any), and the derived display status. Pure -- shared by
 * useMemoryBooks (the create/retry flow) and the Keepsakes shelves, which
 * derive rows from the family-wide books query.
 */
export function buildMemoryBookRows(
  scopeOptions: readonly MemoryBookScopeOption[],
  books: readonly MemoryBookListRow[],
  eligibility: Record<string, number | null> = {},
  dispatchErrors: Record<string, string> = {},
  pendingKeys: Record<string, boolean> = {},
): MemoryBookScopeRow[] {
  return scopeOptions.map((option) => {
    const key = memoryBookScopeKey(option);
    const book = pickRelevantBook(books.filter((b) => memoryBookMatchesScope(b, option)));
    const eligibleCount = eligibility[key] ?? null;

    let status: MemoryBookDisplayStatus;
    let disabledReason: string | null = null;

    if (book?.status === 'queued' || book?.status === 'generating') {
      status = 'in_progress';
    } else if (book?.status === 'ready') {
      status = 'ready';
    } else if (book?.status === 'failed') {
      status = 'failed';
    } else {
      const reason = eligibleCount === null ? null : thinPeriodReason(eligibleCount);
      status = reason ? 'thin' : 'available';
      disabledReason = reason;
    }

    return {
      key,
      option,
      book,
      status,
      eligibleCount,
      disabledReason,
      dispatchError: dispatchErrors[key] ?? null,
      isPending: Boolean(pendingKeys[key]),
    };
  });
}

/**
 * Every book in the family from ONE query (Keepsakes,
 * docs/plans/timeline-calendar-keepsakes.md C2), grouped by child. Polls
 * every 4s only while a book is queued/generating AND `isFocused` -- the tab
 * never unmounts, so the focus gate is what stops a backgrounded tab polling.
 */
export function useFamilyMemoryBooks({
  familyId,
  isFocused,
}: {
  familyId: string | null | undefined;
  isFocused: boolean;
}) {
  const query = useQuery({
    queryKey: familyMemoryBooksQueryKey(familyId),
    queryFn: async () => {
      const { data, error } = await fetchMemoryBooksForFamily(familyId!);
      if (error) throw new Error(error.message);
      return data ?? [];
    },
    enabled: Boolean(familyId),
    refetchInterval: (q) => (isFocused && hasActiveBook(q.state.data) ? BOOK_POLL_INTERVAL_MS : false),
  });

  const booksByChild = useMemo(() => {
    const map = new Map<string, MemoryBookListRow[]>();
    for (const book of query.data ?? []) {
      if (!book.child_id) continue;
      const list = map.get(book.child_id) ?? [];
      list.push(book);
      map.set(book.child_id, list);
    }
    return map;
  }, [query.data]);

  return {
    booksByChild,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}

export function useMemoryBooks({ familyId, childId, dateOfBirth, todayIso: todayIsoParam }: UseMemoryBooksParams) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // Stable for the lifetime of the mounted picker unless the caller supplies
  // it -- re-evaluating "today" on every render would let scope options
  // quietly grow mid-session.
  const [frozenTodayIso] = useState(() => getLocalTodayIso());
  const todayIso = todayIsoParam ?? frozenTodayIso;
  const scopeOptions = useMemo(
    () => buildMemoryBookScopeOptions(dateOfBirth ?? null, todayIso),
    [dateOfBirth, todayIso],
  );

  const booksQuery = useQuery({
    queryKey: memoryBooksQueryKey(familyId, childId),
    queryFn: async () => {
      const { data, error } = await fetchMemoryBooksForChild(familyId!, childId!);
      if (error) throw new Error(error.message);
      return data ?? [];
    },
    enabled: Boolean(familyId && childId),
    // Locked design point 4: "poll the row every few seconds while
    // visible". React Query stops calling refetchInterval once this query
    // has no observers (the picker screen unmounted), so no separate
    // visibility/focus wiring is needed here.
    refetchInterval: (query) => (hasActiveBook(query.state.data) ? BOOK_POLL_INTERVAL_MS : false),
  });

  // Every write here also refreshes Keepsakes' family-wide books query, so a
  // new/retried book shows on its shelf without waiting for a poll.
  const refetchBooks = useCallback(async () => {
    await booksQuery.refetch();
    void queryClient.invalidateQueries({ queryKey: familyMemoryBooksQueryKey(familyId) });
    // A new/retried book changes the Keepsakes overview's order/preview data.
    void queryClient.invalidateQueries({ queryKey: keepsakesOverviewQueryKey(familyId) });
  }, [booksQuery, familyId, queryClient]);

  // Locked design point 3: "one cheap count query at picker-open" per
  // scope. Counted once (long staleTime) rather than kept live -- the
  // count is a coarse motivational signal, not the generation input itself
  // (the server re-derives eligibility fresh at generation time).
  const eligibilityQuery = useQuery({
    queryKey: memoryBookEligibilityQueryKey(familyId, childId, dateOfBirth, todayIso),
    queryFn: async () => {
      const entries = await Promise.all(scopeOptions.map(async (option) => {
        const { data } = await countEligibleMemoriesForScope(
          familyId!,
          childId!,
          option.startDate,
          option.endDate,
        );
        return [memoryBookScopeKey(option), data] as const;
      }));
      return Object.fromEntries(entries) as Record<string, number | null>;
    },
    enabled: Boolean(familyId && childId) && scopeOptions.length > 0,
    staleTime: 5 * 60 * 1000,
  });

  // Shelf-redesign empty state's personalized example cover (owner-approved
  // picker-redesign brief): one real photo of this child, picked at random
  // -- see `fetchExampleCoverAssetKey`'s header comment for why the random
  // pick itself lives in the service layer rather than here. A long
  // `staleTime` is what keeps the pick stable across this mount's
  // re-renders; it's read only while the shelf is actually empty (the
  // screen only renders the empty state's example cover in that case), but
  // kept unconditional here so switching from empty -> populated mid-session
  // (a book finishes generating) never shows a loading flicker if the parent
  // navigates back to an empty shelf for a sibling.
  const exampleCoverQuery = useQuery({
    queryKey: ['memory-book-example-cover', familyId, childId],
    queryFn: async () => {
      const { data } = await fetchExampleCoverAssetKey(familyId!, childId!);
      return data;
    },
    enabled: Boolean(familyId && childId),
    staleTime: 30 * 60 * 1000,
  });

  const [dispatchErrors, setDispatchErrors] = useState<Record<string, string>>({});
  const [pendingKeys, setPendingKeys] = useState<Record<string, boolean>>({});

  const clearError = useCallback((key: string) => {
    setDispatchErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const setPending = useCallback((key: string, isPending: boolean) => {
    setPendingKeys((prev) => {
      if (isPending) return { ...prev, [key]: true };
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const refresh = useCallback(() => {
    void refetchBooks();
  }, [refetchBooks]);

  /** Both the initial "Generate" tap AND the "Retry" tap on a `failed` row
   * (locked design point 5: retry creates a fresh queued row + dispatch;
   * the failed row stays as history) -- both are a plain insert + dispatch
   * from this hook's point of view. */
  const generate = useCallback(async (option: MemoryBookScopeOption): Promise<GenerateMemoryBookResult> => {
    if (!familyId || !childId || !user) return 'error';
    const key = memoryBookScopeKey(option);
    clearError(key);
    setPending(key, true);
    try {
      const insertResult = await createMemoryBook({
        familyId,
        childId,
        requestedBy: user.id,
        scopeKind: option.kind,
        scopeStartDate: option.startDate,
        scopeEndDate: option.endDate,
        scopeLabel: option.label,
      });

      if (insertResult.error || !insertResult.data) {
        if (insertResult.conflict) {
          // Someone (or a double-tap) already claimed this exact scope --
          // refetch and let the existing row's own status render. Never an
          // error wall for this case (locked design point 5).
          await refetchBooks();
          return 'exists';
        }
        setDispatchErrors((prev) => ({ ...prev, [key]: insertResult.error?.message ?? 'Could not start your book.' }));
        return 'error';
      }

      const bookId = insertResult.data.id;
      // Show the new queued row immediately, before waiting on dispatch.
      await refetchBooks();

      const dispatchResult = await dispatchMemoryBookGeneration(bookId);
      if (dispatchResult.error) {
        setDispatchErrors((prev) => ({ ...prev, [key]: dispatchResult.error!.message }));
      }
      await refetchBooks();
      return dispatchResult.error ? 'error' : 'started';
    } finally {
      setPending(key, false);
    }
  }, [familyId, childId, user, refetchBooks, clearError, setPending]);

  /** Re-invokes generation for a row that is already `queued` in the DB
   * but whose dispatch call itself failed (network error or non-2xx --
   * contract note: "treat non-2xx as a failed dispatch; row stays queued;
   * show retryable error"). Does NOT insert a new row. */
  const retryDispatch = useCallback(async (option: MemoryBookScopeOption, bookId: string) => {
    const key = memoryBookScopeKey(option);
    clearError(key);
    setPending(key, true);
    try {
      const dispatchResult = await dispatchMemoryBookGeneration(bookId);
      if (dispatchResult.error) {
        setDispatchErrors((prev) => ({ ...prev, [key]: dispatchResult.error!.message }));
      }
      await refetchBooks();
    } finally {
      setPending(key, false);
    }
  }, [refetchBooks, clearError, setPending]);

  const rows: MemoryBookScopeRow[] = useMemo(
    () => buildMemoryBookRows(scopeOptions, booksQuery.data ?? [], eligibilityQuery.data ?? {}, dispatchErrors, pendingKeys),
    [scopeOptions, booksQuery.data, eligibilityQuery.data, dispatchErrors, pendingKeys],
  );

  return {
    rows,
    isLoading: booksQuery.isLoading,
    isError: booksQuery.isError,
    isEligibilityLoading: eligibilityQuery.isLoading,
    exampleCoverAssetKey: exampleCoverQuery.data ?? null,
    generate,
    retryDispatch,
    refresh,
  };
}
