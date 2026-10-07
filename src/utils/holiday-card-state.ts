// Which holiday-card state the Keepsakes tab shows for a `holiday_card_summary`
// row (moved out of holiday-card-tile.tsx so it survives the tile's removal;
// docs/plans/keepsakes-redesign.md B3). Pure -- the caller supplies "today".
import type { HolidayCardSummary } from '@/services/holiday-cards';

export type HolidayCardTileState = 'make' | 'generating' | 'ready' | 'failed' | 'ordered';

/**
 * Which tile (if any) the summary calls for. The summary returns the newest
 * card of ANY year, so `todayIso` (the tab's local today) decides what a
 * previous-year card means: if it was ordered it stays reachable as "ordered"
 * through Jan 31 of the following year (the cards are in transit and tracking
 * lives in the shop); after that, or if it was never ordered, it counts as no
 * card (offer "make" when the switch is on, else hide the tile).
 */
export function holidayCardTileState(
  summary: HolidayCardSummary | null,
  todayIso: string,
): HolidayCardTileState | null {
  if (!summary) return null;
  const currentYear = Number(todayIso.slice(0, 4));
  let hasCard = summary.cardId !== null;
  if (hasCard && summary.year !== null && summary.year < currentYear) {
    hasCard = summary.ordered && summary.year === currentYear - 1 && todayIso <= `${currentYear}-01-31`;
  }
  if (!hasCard) return summary.enabled ? 'make' : null;
  if (summary.ordered) return 'ordered';
  // `readiness` is authoritative when the backend sends it: `status` reads
  // 'ready' while the film is still rendering. Older backends omit it.
  switch (summary.readiness) {
    case 'generating':
    case 'film':
      return 'generating';
    case 'ready':
      return 'ready';
    case 'failed':
      return 'failed';
    default:
      break;
  }
  if (summary.status === 'ready') return 'ready';
  if (summary.status === 'failed') return 'failed';
  return 'generating';
}
