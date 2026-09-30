import fs from 'fs';
import path from 'path';

import { bedsForFilmKind, YEAR_FILM_BEDS, yearFilmBedLabel } from '@/utils/year-film-beds';

const root = path.resolve(__dirname, '../..');
const bedsJson = JSON.parse(
  fs.readFileSync(path.join(root, 'film-renderer/composition/assets/audio/beds/beds.json'), 'utf8'),
) as { beds: { id: string; use: string[] }[] };

describe('year film bed manifest', () => {
  it('mirrors beds.json (ids and uses)', () => {
    const fromJson = bedsJson.beds.map((bed) => ({ id: bed.id, use: bed.use })).sort((a, b) => a.id.localeCompare(b.id));
    const fromManifest = YEAR_FILM_BEDS.map((bed) => ({ id: bed.id, use: [...bed.use] })).sort((a, b) => a.id.localeCompare(b.id));
    expect(fromManifest).toEqual(fromJson);
  });

  it('matches the SQL allow-list public.year_film_bed_ids()', () => {
    const sql = fs.readFileSync(path.join(root, 'supabase/migrations/20260929120000_year_films.sql'), 'utf8');
    const start = sql.indexOf('create or replace function public.year_film_bed_ids()');
    expect(start).toBeGreaterThan(-1);
    const block = sql.slice(start, sql.indexOf('$$;', start));
    const ids = [...block.matchAll(/'([a-z-]+)'/g)].map((match) => match[1]);
    expect(YEAR_FILM_BEDS.map((bed) => bed.id)).toEqual(ids);
  });

  it('ships a small bundled preview per bed', () => {
    for (const bed of YEAR_FILM_BEDS) {
      const file = path.join(root, 'assets/audio/film-beds', `${bed.id}.m4a`);
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.statSync(file).size).toBeLessThan(60 * 1024);
      expect(bed.preview).toBeDefined();
      expect(bed.label.length).toBeGreaterThan(0);
    }
  });

  it('offers the beds made for the film kind', () => {
    expect(bedsForFilmKind('birthday').map((bed) => bed.id)).toEqual(['bright-pop', 'sparkle-pop']);
    expect(bedsForFilmKind('family_month').map((bed) => bed.id)).toHaveLength(6);
  });

  it('falls back to every bed when a kind has fewer than two, and keeps the current bed', () => {
    expect(bedsForFilmKind('family_year')).toHaveLength(YEAR_FILM_BEDS.length);
    expect(bedsForFilmKind('birthday', 'tender-piano').map((bed) => bed.id)).toEqual([
      'bright-pop',
      'sparkle-pop',
      'tender-piano',
    ]);
  });

  it('labels a bed by id', () => {
    expect(yearFilmBedLabel('bright-pop')).toBe('Bright pop');
    expect(yearFilmBedLabel('nope')).toBeNull();
    expect(yearFilmBedLabel(null)).toBeNull();
  });
});
