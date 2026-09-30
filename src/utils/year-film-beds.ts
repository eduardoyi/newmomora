// Music beds the Year Film edit sheet offers (docs/plans/year-film-p2.md
// Step 11, docs/features/year-film.md "Edit sheet"). Mirrors
// film-renderer/composition/assets/audio/beds/beds.json (ids + which film
// kinds use them) and the SQL allow-list public.year_film_bed_ids();
// year-film-beds.test.ts parity-tests both. Each bed ships a ~5 s AAC preview
// (assets/audio/film-beds/<id>.m4a, cut from the bed's `drop` time) inside
// the app bundle, so previews need no network and no server change.
import type { YearFilmKind } from '@/services/year-films';

export interface YearFilmBed {
  id: string;
  label: string;
  /** Film kinds the bed suits. `tender` is not a film kind: the bed is only
   * offered when a film has too few kind-matching beds to choose from. */
  use: readonly (YearFilmKind | 'tender')[];
  /** Bundled ~5 s preview clip (Metro asset module id). */
  preview: number;
}

export const YEAR_FILM_BEDS: readonly YearFilmBed[] = [
  { id: 'bells-and-claps', label: 'Bells and claps', use: ['family_month'], preview: require('../../assets/audio/film-beds/bells-and-claps.m4a') },
  { id: 'bright-pop', label: 'Bright pop', use: ['birthday'], preview: require('../../assets/audio/film-beds/bright-pop.m4a') },
  { id: 'bubbly-synth', label: 'Bubbly synth', use: ['family_month'], preview: require('../../assets/audio/film-beds/bubbly-synth.m4a') },
  { id: 'celebration-pop', label: 'Celebration pop', use: ['family_year'], preview: require('../../assets/audio/film-beds/celebration-pop.m4a') },
  { id: 'groovy-keys', label: 'Groovy keys', use: ['family_month'], preview: require('../../assets/audio/film-beds/groovy-keys.m4a') },
  { id: 'pizzicato-bop', label: 'Pizzicato bop', use: ['family_month'], preview: require('../../assets/audio/film-beds/pizzicato-bop.m4a') },
  { id: 'playful-marimba', label: 'Playful marimba', use: ['family_month'], preview: require('../../assets/audio/film-beds/playful-marimba.m4a') },
  { id: 'playful-piano', label: 'Playful piano', use: ['family_month'], preview: require('../../assets/audio/film-beds/playful-piano.m4a') },
  { id: 'sparkle-pop', label: 'Sparkle pop', use: ['birthday'], preview: require('../../assets/audio/film-beds/sparkle-pop.m4a') },
  { id: 'tender-piano', label: 'Tender piano', use: ['tender'], preview: require('../../assets/audio/film-beds/tender-piano.m4a') },
];

export function yearFilmBedLabel(id: string | null | undefined): string | null {
  return YEAR_FILM_BEDS.find((bed) => bed.id === id)?.label ?? null;
}

/**
 * The beds to offer for a film of `kind`: those made for it. A kind with
 * fewer than two (the year-end film has one) would be no choice at all, so
 * the whole catalogue is offered instead. `currentBedId` is always included
 * (a film may already use a bed outside its kind).
 */
export function bedsForFilmKind(kind: YearFilmKind, currentBedId?: string | null): YearFilmBed[] {
  const matching = YEAR_FILM_BEDS.filter((bed) => (bed.use as readonly string[]).includes(kind));
  const offered = matching.length >= 2 ? [...matching] : [...YEAR_FILM_BEDS];
  const current = currentBedId ? YEAR_FILM_BEDS.find((bed) => bed.id === currentBedId) : undefined;
  if (current && !offered.some((bed) => bed.id === current.id)) offered.push(current);
  return offered;
}
