// Pure decisions behind the Keepsakes product pages
// (docs/plans/keepsakes-redesign.md D3/D4), kept out of the route files so the
// unit tests can pin every branch.
import type { KeepsakesOverview } from '@/services/keepsakes';
import type { ScopeChoice } from '@/utils/keepsakes';

/** A `queued` book row older than this is treated as a dispatch that never happened. */
export const STUCK_QUEUE_MS = 10 * 60 * 1000;

function momentsText(count: number): string {
  return `${count} ${count === 1 ? 'moment' : 'moments'}`;
}

/**
 * The holiday-card page's eligibility line and whether the card's back links
 * to a film. Card create has no floor: below the holiday film floor
 * (`holiday_min_pool`) the card ships WITHOUT a QR film, so the page must not
 * promise one. Both are null while the overview is unknown.
 */
export function holidayCardEligibility(
  overview: KeepsakesOverview | null,
  year: number,
): { line: string | null; promisesFilm: boolean | null } {
  if (!overview || overview.holiday_pool === null || overview.holiday_min_pool === null) {
    return { line: null, promisesFilm: null };
  }
  const promisesFilm = overview.holiday_pool >= overview.holiday_min_pool;
  if (overview.year_moments === null) return { line: null, promisesFilm };
  const count = momentsText(overview.year_moments);
  return {
    line: promisesFilm ? `Your ${year} has ${count}, plenty for the letter.` : `Your ${year} has ${count} so far.`,
    promisesFilm,
  };
}

export type BookCta =
  | { kind: 'make'; label: string }
  | { kind: 'open'; label: string }
  | { kind: 'retry'; label: string }
  | { kind: 'redispatch'; label: string }
  | { kind: 'busy'; label: string };

/** What the Memory Book page's bottom button does for the selected period. */
export function bookCtaFor(choice: ScopeChoice, name: string, nowMs: number): BookCta {
  const row = choice.row;
  const book = row?.book ?? null;
  if (!row || !book) return { kind: 'make', label: `Make ${name}’s ${choice.option.label} book` };
  if (row.status === 'ready') return { kind: 'open', label: `Open ${name}’s book` };
  if (row.status === 'failed') return { kind: 'retry', label: 'Try again' };
  // In progress. A queued row whose dispatch failed (or never happened) would
  // otherwise be a permanently disabled "Being made…".
  if (book.status === 'queued') {
    const age = nowMs - new Date(book.created_at).getTime();
    if (row.dispatchError || age > STUCK_QUEUE_MS) return { kind: 'redispatch', label: 'Try again' };
  }
  return { kind: 'busy', label: 'Being made…' };
}
