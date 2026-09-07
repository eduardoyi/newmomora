import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../supabaseClient';
import type { MemoryBookRow } from '../types';

const POLL_INTERVAL_MS = 5000;
const ACTIVE_STATUSES = new Set(['queued', 'generating']);

/**
 * The family's own books (RLS-visible via `is_family_member`, across every
 * family the caller belongs to — same "resolve my families first" shape
 * `fetchMyFamilyMemberships` uses in the app). Polls while any row is
 * still `queued`/`generating` (plan Step 6: "poll generating rows"),
 * stopping automatically once none are.
 */
export function useFamilyBooks() {
  const [books, setBooks] = useState<MemoryBookRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (isPoll: boolean) => {
    if (!isPoll) setLoading(true);

    const { data: userData } = await supabase.auth.getUser();
    const userId = userData.user?.id;
    if (!userId) {
      setBooks([]);
      setLoading(false);
      return;
    }

    const { data: memberships, error: membershipError } = await supabase
      .from('family_memberships')
      .select('family_id')
      .eq('user_id', userId);

    if (membershipError) {
      setError(membershipError.message);
      setLoading(false);
      return;
    }

    const familyIds = Array.from(new Set((memberships ?? []).map((m) => m.family_id)));
    if (familyIds.length === 0) {
      setBooks([]);
      setLoading(false);
      return;
    }

    const { data, error: booksError } = await supabase
      .from('memory_books')
      .select('id, family_id, child_id, status, scope_label, failure_reason, created_at, updated_at, book_document, child:family_members(name)')
      .in('family_id', familyIds)
      .order('created_at', { ascending: false });

    if (booksError) {
      setError(booksError.message);
      setLoading(false);
      return;
    }

    const rows = (data ?? []) as unknown as MemoryBookRow[];
    setBooks(rows);
    setError(null);
    setLoading(false);

    const hasActive = rows.some((b) => ACTIVE_STATUSES.has(b.status));
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    if (hasActive) {
      pollTimerRef.current = setTimeout(() => void load(true), POLL_INTERVAL_MS);
    }
  }, []);

  useEffect(() => {
    void load(false);
    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [load]);

  return { books, error, loading, reload: () => load(false) };
}
