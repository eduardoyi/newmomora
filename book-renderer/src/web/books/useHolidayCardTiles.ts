import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../supabaseClient';
import { getHolidayCard } from '../card/cardApi';
import { cardTilePreview, type CardTilePreview } from './cardPreview';
import { CARD_POLL_MS, shouldPollCards, tilesFromSummaries, type CardTile, type HolidayCardSummaryRow } from './keepsakes';

/**
 * The holiday card tile(s) for the home page: `holiday_card_summary` for each
 * family the book list resolved (the RPC returns zero rows unless the caller
 * owns or manages that family). Polls while a card is still being made, like
 * the books do. A failing RPC (not deployed yet, offline) simply yields no
 * tile: the section is hidden, never an error on the home page.
 */
export function useHolidayCardTiles(familyIds: readonly string[] | null) {
  const [tiles, setTiles] = useState<CardTile[]>([]);
  // Until the first answer for these families: the home page must not flash its empty state meanwhile.
  const [loaded, setLoaded] = useState(false);
  // Front previews by card id (signed URLs last an hour: fetched once per card per page visit).
  const [previews, setPreviews] = useState<Record<string, CardTilePreview | null>>({});
  const requested = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const key = familyIds ? [...familyIds].sort().join('|') : null;

  const load = useCallback(async () => {
    if (!familyIds) return;
    if (familyIds.length === 0) {
      setTiles([]);
      setLoaded(true);
      return;
    }
    const rows: HolidayCardSummaryRow[] = [];
    await Promise.all(
      familyIds.map(async (familyId) => {
        const { data, error } = await supabase.rpc('holiday_card_summary', { p_family_id: familyId });
        if (error) {
          console.warn('holiday_card_summary failed', error.code ?? '');
          return;
        }
        rows.push(...((data ?? []) as HolidayCardSummaryRow[]));
      }),
    );
    const next = tilesFromSummaries(rows);
    setTiles(next);
    setLoaded(true);
    if (timer.current) clearTimeout(timer.current);
    if (shouldPollCards(next)) timer.current = setTimeout(() => void load(), CARD_POLL_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // A tile that is not being made and has no preview yet gets one `get` (the same call the editor makes).
  const needKey = tiles.filter((t) => t.state !== 'being_made' && t.state !== 'failed').map((t) => t.cardId).join('|');
  useEffect(() => {
    for (const id of needKey ? needKey.split('|') : []) {
      if (requested.current.has(id)) continue;
      requested.current.add(id);
      getHolidayCard(id)
        .then((view) => setPreviews((prev) => ({ ...prev, [id]: cardTilePreview(view) })))
        .catch((e: unknown) => {
          requested.current.delete(id); // retry on the next poll / revisit
          console.warn('holiday card preview failed', e instanceof Error ? e.name : '');
        });
    }
  }, [needKey]);

  useEffect(() => {
    void load();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  return { tiles, previews, loading: !loaded };
}
