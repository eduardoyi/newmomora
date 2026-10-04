import { assert, assertEquals } from 'jsr:@std/assert@1';
import {
  buildDetailsPrompt,
  buildDetailsRequestBody,
  DETAIL_EXCERPT_CHARS,
  DETAILS_MODEL,
  type DetailExcerpt,
  parseDetails,
  selectDetailExcerpts,
} from './holiday-card-details.ts';
import { buildDigestFromPool } from './holiday-card-digest.ts';
import { holidayFilmScope } from './year-film-eligibility.ts';
import type { FilmMemorySource, FilmPerson } from './year-film-script.ts';

const ENZO = 'enzo';
const MARA = 'mara';
const SCOPE = holidayFilmScope(2026, '2026-10-04');

let n = 0;
function memory(overrides: Partial<FilmMemorySource>): FilmMemorySource {
  n += 1;
  return {
    id: `m${String(n).padStart(2, '0')}`,
    date: '2026-03-15',
    type: 'text_only',
    text: `Enzo jugó en el parque con su disfraz de Spider-Man, número ${n}`,
    emotion: 'joy',
    topics: [],
    taggedMemberIds: [ENZO],
    illustrationReady: false,
    illustrationKey: null,
    media: [],
    assets: [],
    reported: false,
    ...overrides,
  };
}

const EXCERPTS: DetailExcerpt[] = [
  { memoryId: 'a', date: '2026-01-10', text: 'Hoy Enzo se puso su disfraz de Spider-Man y salió corriendo al jardín' },
  { memoryId: 'b', date: '2026-03-10', text: 'Otra vez Spider-Man: no se lo quita ni para cenar, qué locura' },
  { memoryId: 'c', date: '2026-05-10', text: 'Enzo armó el tren azul con las vías nuevas y no paró en toda la tarde' },
  { memoryId: 'd', date: '2026-06-10', text: 'Leímos "Los tres cerditos" otra vez antes de dormir' },
];

Deno.test('detail excerpts: share-safe, tagging the child, best first, capped, in date order', () => {
  const memories = [
    ...Array.from({ length: 30 }, (_, i) => memory({ date: `2026-0${(i % 8) + 1}-${String(i + 1).padStart(2, '0')}` })),
    memory({ id: 'other', taggedMemberIds: [MARA] }),
    memory({ id: 'sad', emotion: 'sad' }),
    memory({ id: 'potty', text: 'Hoy hizo pipí en el baño y todos aplaudimos mucho en casa' }),
    memory({ id: 'short', text: 'corto' }),
    memory({ id: 'later', date: '2026-10-05' }),
    memory({ id: 'reported', reported: true }),
  ];
  const got = selectDetailExcerpts(memories, [], { childId: ENZO, scope: SCOPE, ownChildIds: [ENZO, MARA] });
  assertEquals(got.length, 25);
  const ids = got.map((e) => e.memoryId);
  for (const bad of ['other', 'sad', 'potty', 'short', 'later', 'reported']) assert(!ids.includes(bad), bad);
  assertEquals(got.map((e) => e.date), got.map((e) => e.date).sort());
  assert(got.every((e) => Array.from(e.text).length <= DETAIL_EXCERPT_CHARS));
});

Deno.test('details prompt: numbered captions, specific-not-generic rules, cheap model', () => {
  const { system, user } = buildDetailsPrompt('Enzo', EXCERPTS);
  assert(system.includes('SPECIFIC') && system.includes('NOT generic categories') && system.includes('Code rejects any detail'));
  assert(user.includes('Child: Enzo') && user.includes('[1] Hoy Enzo') && user.includes('[4] Leímos'));
  assertEquals((buildDetailsRequestBody(DETAILS_MODEL, system, user) as { model: string }).model, 'gpt-6-luna');
});

Deno.test('parseDetails: verifies every detail in the excerpts it cites, recomputes recurring, drops the rest', () => {
  const raw = JSON.stringify({
    details: [
      { detail: 'Spider-Man', memory_ids: [1], recurring: false }, // really in 2 captions: recurring is recomputed
      { detail: 'el tren azul', memory_ids: [3], recurring: true }, // claimed recurring, only in 1
      { detail: 'Los tres cerditos', memory_ids: [4], recurring: false }, // accents/quotes normalize
      { detail: 'una moto roja', memory_ids: [3], recurring: false }, // not in the cited caption
      { detail: 'Spider-Man', memory_ids: [2], recurring: true }, // duplicate
      { detail: 'Enzo', memory_ids: [1] }, // names someone
      { detail: 'pipí', memory_ids: [1] }, // sensitive (and not there)
      { detail: 'tren', memory_ids: [9] }, // unknown caption number
      { detail: 'un disfraz muy muy largo de superhéroe volador', memory_ids: [1] }, // too long
      { memory_ids: [1] }, // bad shape
    ],
  });
  const result = parseDetails(raw, EXCERPTS, ['Enzo', 'Mara', 'Rosa']);
  assertEquals(result.details.map((d) => [d.detail, d.memoryIds, d.recurring]), [
    ['Spider-Man', ['a', 'b'], true],
    ['el tren azul', ['c'], false],
    ['Los tres cerditos', ['d'], false],
  ]);
  assertEquals([result.extracted, result.verified, result.dropped], [10, 3, 7]);
  assertEquals(result.reasons, { not_in_cited_excerpts: 1, sensitive: 1, duplicate: 1, names_someone: 1, unknown_id: 1, too_long: 1, bad_shape: 1 });
  assertEquals(parseDetails('nope', EXCERPTS, []).reasons, { bad_shape: 1 });
  assertEquals(parseDetails('{"details":"x"}', EXCERPTS, []).details, []);
});

Deno.test('parseDetails keeps at most five, recurring first', () => {
  const excerpts = Array.from({ length: 8 }, (_, i) => ({ memoryId: `e${i}`, date: `2026-01-0${i + 1}`, text: `texto número ${i} con la cosa${i} y también cosa0 de siempre` }));
  const details = excerpts.map((_, i) => ({ detail: `cosa${i}`, memory_ids: [i + 1] }));
  const result = parseDetails(JSON.stringify({ details }), excerpts, []);
  assertEquals(result.details.length, 5);
  assertEquals(result.details[0].detail, 'cosa0'); // in all 8 captions
  assert(result.details[0].recurring);
  assertEquals(result.verified, 5);
  assertEquals(result.dropped, 3);
});

Deno.test('digest: specifics ride on the child profile (memberId, counts, recurring)', () => {
  const kid = (id: string, name: string, dob: string): FilmPerson => ({ id, name, dateOfBirth: dob, relationship: 'child', createdAt: '2024-01-01', portraits: [] });
  const members = [kid(ENZO, 'Enzo Rivera', '2022-10-23'), kid(MARA, 'Mara Rivera', '2024-11-08')];
  const specifics = { [ENZO]: [{ detail: 'Spider-Man', memoryIds: ['a', 'b'], recurring: true }, { detail: 'el tren azul', memoryIds: ['c'], recurring: false }] };
  const digest = buildDigestFromPool([memory({})], [], members, SCOPE, 'es', { familyName: 'Rivera', specifics });
  assertEquals(digest.children.map((c) => c.memberId), [ENZO, MARA]);
  assertEquals(digest.children[0].specifics, [{ detail: 'Spider-Man', memories: 2, recurring: true }, { detail: 'el tren azul', memories: 1, recurring: false }]);
  assertEquals(digest.children[1].specifics, []);
});
