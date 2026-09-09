import { useEffect, useState } from 'react';
import { supabase } from '../supabaseClient';
import { getFixtureSlug } from '../dev/fixture';

export interface FamilyMemberOption {
  id: string;
  name: string;
}

/**
 * Item 1 (owner-approved editing-UX round): the picker's person filter
 * needs the book's family member roster. `family_members` already has a
 * membership-scoped SELECT policy ("Family members: select" —
 * `is_family_member(family_id)`, `20260711120000_family_sharing.sql`), and
 * `family_id` is already on hand client-side (`MemoryBookRow.family_id`,
 * loaded by `useEditableBook`) — so this is a direct client-side read
 * against a column the app already has, cleaner than threading a new
 * `members` array through the `picker_pool` response for data the client
 * can read itself with no server change.
 *
 * DEV-ONLY fixture mode returns an empty roster — no network call, and
 * nothing to filter by: the fixture pool carries no member tags at all
 * (see `dev/fixture.ts`'s `fixtureFetchPickerPool`, which treats a
 * `memberId` filter as a documented no-op for the same reason).
 * `PickerSheet` hides the person filter entirely when this comes back
 * empty, so fixture mode simply never shows it.
 */
export function useFamilyMembers(bookId: string, familyId: string | null): FamilyMemberOption[] {
  const [members, setMembers] = useState<FamilyMemberOption[]>([]);

  useEffect(() => {
    setMembers([]);
    if (!familyId) return;
    if (import.meta.env.DEV) {
      const fixtureSlug = getFixtureSlug();
      if (fixtureSlug && fixtureSlug === bookId) return;
    }
    let cancelled = false;
    void supabase
      .from('family_members')
      .select('id, name')
      .eq('family_id', familyId)
      .order('name', { ascending: true })
      .then(({ data, error }) => {
        if (cancelled || error || !data) return;
        setMembers(data as FamilyMemberOption[]);
      });
    return () => {
      cancelled = true;
    };
  }, [bookId, familyId]);

  return members;
}
