// An upcoming birthday film or the year-end film on its year's shelf
// (docs/plans/keepsakes-redesign.md C1): the shared `UpcomingTile` fed with
// the film's progress. Titles come from the family's members and the dates
// from the server's owner-local `upcoming_films`, never the device clock.
import { UpcomingTile } from '@/components/keepsakes/upcoming-tile';
import type { KeepsakesUpcomingFilm } from '@/services/keepsakes';
import {
  formatArrival,
  isUpcomingFilmLocked,
  upcomingFilmCaptionMeta,
  upcomingFilmHint,
  upcomingFilmTitle,
} from '@/utils/keepsakes';

export interface UpcomingFilmTileProps {
  film: KeepsakesUpcomingFilm;
  members: readonly { id: string; name: string }[];
  /** The shelf's today, for "arrives today". */
  todayIso: string;
}

/** `keepsakes-upcoming-birthday-{memberId}` / `keepsakes-upcoming-year-{year}`. */
export function upcomingFilmTestID(film: KeepsakesUpcomingFilm): string {
  return film.kind === 'birthday'
    ? `keepsakes-upcoming-birthday-${film.member_id}`
    : `keepsakes-upcoming-year-${film.scope_start.slice(0, 4)}`;
}

export function UpcomingFilmTile({ film, members, todayIso }: UpcomingFilmTileProps) {
  const title = upcomingFilmTitle(film, members) ?? 'Birthday film';
  return (
    <UpcomingTile
      accessibilityLabel={`${title}, ${upcomingFilmCaptionMeta(film, todayIso)}`}
      arrivesOn={formatArrival(film.film_date, todayIso)}
      hint={upcomingFilmHint(film)}
      locked={isUpcomingFilmLocked(film)}
      pictureKey={film.picture_key}
      progress={film.min_moments > 0 ? Math.min(1, film.moments / film.min_moments) : 1}
      testID={upcomingFilmTestID(film)}
      title={title}
    />
  );
}
