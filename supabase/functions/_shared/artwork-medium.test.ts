import { assertEquals } from 'jsr:@std/assert@1';
import {
  ARTWORK_MEDIUMS as CLIENT_ARTWORK_MEDIUMS,
  formatArtworkMedium,
  isArtworkMedium,
} from '../../../src/utils/artwork-medium.ts';
import { ARTWORK_MEDIUMS, normalizeArtworkMedium } from './artwork-medium.ts';

Deno.test('ARTWORK_MEDIUMS matches the client mirror in src/utils/artwork-medium.ts exactly (order included)', () => {
  assertEquals([...ARTWORK_MEDIUMS], [...CLIENT_ARTWORK_MEDIUMS]);
});

Deno.test('ARTWORK_MEDIUMS is the approved ten-item lowercase vocabulary with no duplicates', () => {
  assertEquals(ARTWORK_MEDIUMS.length, 10);
  assertEquals(new Set(ARTWORK_MEDIUMS).size, ARTWORK_MEDIUMS.length);
  for (const medium of ARTWORK_MEDIUMS) assertEquals(medium, medium.toLowerCase());
});

Deno.test('normalizeArtworkMedium returns every vocabulary item unchanged', () => {
  for (const medium of ARTWORK_MEDIUMS) assertEquals(normalizeArtworkMedium(medium), medium);
});

Deno.test('normalizeArtworkMedium tolerates case, whitespace, hyphens, underscores and punctuation', () => {
  assertEquals(normalizeArtworkMedium('  Crayon.  '), 'crayon');
  assertEquals(normalizeArtworkMedium('WATERCOLOR'), 'watercolor');
  assertEquals(normalizeArtworkMedium('mixed-media'), 'mixed media');
  assertEquals(normalizeArtworkMedium('Mixed_Media'), 'mixed media');
  assertEquals(normalizeArtworkMedium('colored   pencil'), 'colored pencil');
});

Deno.test('normalizeArtworkMedium folds plurals onto the singular vocabulary item', () => {
  assertEquals(normalizeArtworkMedium('crayons'), 'crayon');
  assertEquals(normalizeArtworkMedium('Markers'), 'marker');
  assertEquals(normalizeArtworkMedium('colored pencils'), 'colored pencil');
  assertEquals(normalizeArtworkMedium('watercolors'), 'watercolor');
  assertEquals(normalizeArtworkMedium('pastels'), 'pastel');
  assertEquals(normalizeArtworkMedium('paints'), 'paint');
  assertEquals(normalizeArtworkMedium('collages'), 'collage');
});

Deno.test('normalizeArtworkMedium maps spelling variants and synonyms', () => {
  assertEquals(normalizeArtworkMedium('water color'), 'watercolor');
  assertEquals(normalizeArtworkMedium('watercolour'), 'watercolor');
  assertEquals(normalizeArtworkMedium('colouring pencil'), 'colored pencil');
  assertEquals(normalizeArtworkMedium('coloured pencils'), 'colored pencil');
  assertEquals(normalizeArtworkMedium('felt tip'), 'marker');
  assertEquals(normalizeArtworkMedium('felt-tip pens'), 'marker');
  assertEquals(normalizeArtworkMedium('oil pastel'), 'pastel');
  assertEquals(normalizeArtworkMedium('Oil Pastels'), 'pastel');
  assertEquals(normalizeArtworkMedium('wax crayons'), 'crayon');
  assertEquals(normalizeArtworkMedium('tempera paint'), 'paint');
  assertEquals(normalizeArtworkMedium('finger painting'), 'paint');
  assertEquals(normalizeArtworkMedium('graphite'), 'pencil');
  assertEquals(normalizeArtworkMedium('sidewalk chalk'), 'chalk');
  assertEquals(normalizeArtworkMedium('paper collage'), 'collage');
  assertEquals(normalizeArtworkMedium('multimedia'), 'mixed media');
});

Deno.test('normalizeArtworkMedium returns null for unknown, empty, or non-string values (never guesses)', () => {
  assertEquals(normalizeArtworkMedium('oil on canvas'), null);
  assertEquals(normalizeArtworkMedium('crayon and marker'), null);
  assertEquals(normalizeArtworkMedium(''), null);
  assertEquals(normalizeArtworkMedium('   '), null);
  assertEquals(normalizeArtworkMedium('123'), null);
  assertEquals(normalizeArtworkMedium(null), null);
  assertEquals(normalizeArtworkMedium(undefined), null);
  assertEquals(normalizeArtworkMedium(42), null);
  assertEquals(normalizeArtworkMedium({ medium: 'crayon' }), null);
  assertEquals(normalizeArtworkMedium(['crayon']), null);
});

Deno.test('client isArtworkMedium accepts exactly the vocabulary; formatArtworkMedium trims and nulls blanks', () => {
  for (const medium of ARTWORK_MEDIUMS) assertEquals(isArtworkMedium(medium), true);
  assertEquals(isArtworkMedium('Crayon'), false);
  assertEquals(isArtworkMedium(null), false);
  assertEquals(formatArtworkMedium(' crayon '), 'crayon');
  assertEquals(formatArtworkMedium('   '), null);
  assertEquals(formatArtworkMedium(null), null);
  assertEquals(formatArtworkMedium(undefined), null);
});
