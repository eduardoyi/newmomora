import { assertEquals } from 'jsr:@std/assert@1';
import { defaultBed, isYearFilmBed, YEAR_FILM_BEDS } from './year-film-beds.ts';

const bedsJson = JSON.parse(
  await Deno.readTextFile(new URL('../../../film-renderer/composition/assets/audio/beds/beds.json', import.meta.url)),
) as { beds: { id: string; use: string[] }[] };
const migration = await Deno.readTextFile(
  new URL('../../migrations/20260929120000_year_films.sql', import.meta.url),
);

Deno.test('beds mirror beds.json (ids and uses)', () => {
  const fromJson = bedsJson.beds.map((b) => ({ id: b.id, use: b.use })).sort((a, b) => a.id.localeCompare(b.id));
  assertEquals(YEAR_FILM_BEDS.map((b) => ({ id: b.id, use: [...b.use] })), fromJson);
});

Deno.test('the SQL allow-list matches', () => {
  const start = migration.indexOf('create or replace function public.year_film_bed_ids()');
  const block = migration.slice(start, migration.indexOf('$$;', start));
  const ids = [...block.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
  assertEquals(ids, YEAR_FILM_BEDS.map((b) => b.id));
});

// assemble.mjs's pickBed, copied as-is: the default must not drift from it.
function assemblePick(kind: string, slug: string, spanFrom: string): string {
  const options = bedsJson.beds.filter((b) => b.use.includes(kind)).sort((x, y) => x.id.localeCompare(y.id));
  if (kind === 'family_month') {
    const [y, m] = spanFrom.split('-').map(Number);
    return options[(y * 12 + (m - 1)) % options.length].id;
  }
  let h = 0;
  for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return options[h % options.length].id;
}

Deno.test('defaultBed matches assemble.mjs for the same slugs', () => {
  const cases: [('birthday' | 'family_month' | 'family_year'), string, string][] = [
    ['birthday', 'birthday-enzo-y4', '2025-10-23'],
    ['birthday', 'birthday-mara-y2', '2025-11-08'],
    ['birthday', '7f0c2b3e-1f11-4a2c-9a3e-3f0b1c2d4e5f', '2025-10-23'],
    ['family_month', 'month-2026-08', '2026-08-01'],
    ['family_month', 'month-2026-09', '2026-09-01'],
    ['family_year', 'family-2026', '2026-01-01'],
  ];
  for (const [kind, slug, from] of cases) assertEquals(defaultBed(kind, slug, from), assemblePick(kind, slug, from));
  assertEquals(isYearFilmBed('bright-pop'), true);
  assertEquals(isYearFilmBed('polka'), false);
});
