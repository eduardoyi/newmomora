// Music beds for Year Films (docs/plans/year-film-p1.md Step 2). Mirrors
// film-renderer/composition/assets/audio/beds/beds.json (ids + which film
// kinds use them) and assemble.mjs's default pick, so the Worker can choose
// and store a film's bed at curate time (`year_films.music_bed_id`) and the
// renderer just plays what film.json names. The SQL allow-list
// (public.year_film_bed_ids) and beds.json are parity-tested against this.

export type FilmKind = 'birthday' | 'family_month' | 'family_year' | 'family_holiday';

export const YEAR_FILM_BEDS: readonly { id: string; use: readonly string[] }[] = [
  { id: 'bells-and-claps', use: ['family_month'] },
  { id: 'bright-pop', use: ['birthday'] },
  { id: 'bubbly-synth', use: ['family_month'] },
  { id: 'celebration-pop', use: ['family_year'] },
  { id: 'fireside-piano', use: ['family_holiday'] },
  { id: 'groovy-keys', use: ['family_month'] },
  { id: 'pizzicato-bop', use: ['family_month'] },
  { id: 'playful-marimba', use: ['family_month'] },
  { id: 'playful-piano', use: ['family_month'] },
  { id: 'sparkle-pop', use: ['birthday'] },
  { id: 'tender-piano', use: ['tender'] },
  { id: 'winter-bells', use: ['family_holiday'] },
];

export function isYearFilmBed(id: unknown): id is string {
  return typeof id === 'string' && YEAR_FILM_BEDS.some((b) => b.id === id);
}

/**
 * The default bed, same rule as assemble.mjs's pickBed: monthlies rotate by
 * calendar month (consecutive months never share a bed); other kinds hash the
 * slug (production passes the film id) so siblings don't always share one.
 */
export function defaultBed(kind: FilmKind, slug: string, spanFrom: string): string {
  const options = YEAR_FILM_BEDS.filter((b) => b.use.includes(kind)).map((b) => b.id).sort((x, y) => x.localeCompare(y));
  if (options.length === 0) throw new Error(`no bed for film kind ${kind}`);
  if (kind === 'family_month') {
    const [y, m] = spanFrom.split('-').map(Number);
    return options[(y * 12 + (m - 1)) % options.length];
  }
  let h = 0;
  for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return options[h % options.length];
}
