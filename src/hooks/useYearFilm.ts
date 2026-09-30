// One Year Film row by id, plus the members of ITS OWN family (docs/plans/
// year-film-p2.md Step 6). The player route only has a film id: a `year-film`
// push can open before the active-family switch has completed, or for a film
// of another family the user belongs to, so neither `useFamily().familyId`
// nor the active family's films/members query is trustworthy. RLS already
// scopes `year_films` and `family_members` reads to membership, so:
//   1. the film is looked up by id (seeded synchronously from any cached
//      family films list, so a tap from the Timeline/Keepsakes opens with the
//      title already known), then fetched to confirm it still exists;
//   2. members come from `film.family_id` under the same query key
//      `useFamilyMembers` uses for that family (shared cache when it is the
//      active one).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import { familyMembersQueryKey, yearFilmsQueryKeyBase } from '@/hooks/queryKeys';
import { supabase } from '@/lib/supabase';
import { fetchFamilyMembers } from '@/services/family-members';
import { YEAR_FILM_KINDS, type YearFilm } from '@/services/year-films';
import { filmTitle } from '@/utils/year-films';

// Same column list as the foundation service (src/services/year-films.ts);
// keys and scripts are never granted to clients.
const YEAR_FILM_COLUMNS =
  'id, family_id, kind, family_member_id, age_year, scope_start_date, scope_end_exclusive, scope_label, language, placement_date, duration_ms, surface_at, ready_at, edits_version, status, blocked, stale';

async function fetchYearFilmById(filmId: string): Promise<YearFilm | null> {
  const { data, error } = await supabase.from('year_films').select(YEAR_FILM_COLUMNS).eq('id', filmId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const row = data as unknown as YearFilm & { kind: string; placement_date: string | null };
  if (!(YEAR_FILM_KINDS as readonly string[]).includes(row.kind) || typeof row.placement_date !== 'string') {
    return null;
  }
  return row as YearFilm;
}

function useCachedYearFilm(filmId: string): YearFilm | undefined {
  const queryClient = useQueryClient();
  // Read once at mount for the placeholder; the by-id fetch below is the source of truth.
  return useMemo(() => {
    const lists = queryClient.getQueriesData<unknown>({ queryKey: [yearFilmsQueryKeyBase] });
    for (const [, data] of lists) {
      if (!Array.isArray(data)) continue;
      const hit = (data as YearFilm[]).find((film) => film.id === filmId);
      if (hit) return hit;
    }
    return undefined;
  }, [filmId, queryClient]);
}

export function useYearFilm(filmId: string | null | undefined) {
  const cached = useCachedYearFilm(filmId ?? '');

  const filmQuery = useQuery({
    // [base, 'film', id] so `invalidateYearFilms(queryClient)` (no family) also refreshes it,
    // without colliding with the per-family list keys [base, familyId].
    queryKey: [yearFilmsQueryKeyBase, 'film', filmId] as const,
    queryFn: () => fetchYearFilmById(filmId!),
    enabled: Boolean(filmId),
    placeholderData: cached,
    staleTime: 60 * 1000,
    retry: 1,
  });

  const film = filmQuery.data ?? null;
  const filmFamilyId = film?.family_id ?? null;

  const membersQuery = useQuery({
    queryKey: familyMembersQueryKey(filmFamilyId),
    queryFn: async () => {
      const { data, error } = await fetchFamilyMembers(filmFamilyId!);
      if (error) throw error;
      return data ?? [];
    },
    enabled: Boolean(filmFamilyId),
  });

  // A birthday title needs the member's name: hold the title back until the
  // members query settles so "A birthday film" never flashes.
  const isTitleReady = film !== null && (film.kind !== 'birthday' || membersQuery.isFetched);
  const title = film && isTitleReady ? filmTitle(film, membersQuery.data ?? []) : null;

  return {
    film,
    title,
    /** Row lookup settled with no visible film (deleted / blocked / not a member). */
    isNotFound: filmQuery.isFetched && !filmQuery.isPlaceholderData && film === null,
    isLoading: filmQuery.isLoading,
    isError: filmQuery.isError,
    refetch: filmQuery.refetch,
  };
}
