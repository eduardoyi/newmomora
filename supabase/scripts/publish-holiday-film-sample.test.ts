import { assertEquals, assertThrows } from 'jsr:@std/assert@1';

import {
  buildFilmRowInsert,
  buildFilmRowUpdate,
  buildFilmScript,
  filmObjectKeys,
  maskToken,
  parseArgs,
  planToken,
  posterArgs,
  posterThumbArgs,
  readFilmMeta,
} from './publish-holiday-film-sample-lib.ts';

// Fictional fixtures: this repo is public.
const FAMILY = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const FILM = '33333333-3333-4333-8333-333333333333';
const ATTEMPT = '44444444-4444-4444-8444-444444444444';
const TOKEN = 'aB3xQ9zK1mN7pR5tW2yC4d';

const baseArgs = ['--family', FAMILY, '--film-data', 'data/holiday', '--mp4', 'out.mp4', '--token', TOKEN, '--year', '2026'];

function film(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'family_holiday',
    language: 'es',
    title: 'Nuestro 2026',
    scope: { start: '2026-01-01', endExclusive: '2026-10-06' },
    scenes: [
      { type: 'title', title: '2026' },
      { type: 'chapter', name: 'SECRET-NAME', line: { quote: 'SECRET-QUOTE' } },
      { type: 'end_card', greeting: 'Feliz Navidad', from: 'de parte de la familia Pruebas' },
    ],
    ...overrides,
  };
}

Deno.test('parseArgs: defaults to a dry run', () => {
  const args = parseArgs(baseArgs);
  assertEquals(args.apply, false);
  assertEquals(args.family, FAMILY);
  assertEquals(args.year, 2026);
  assertEquals(args.posterAt, 3);
  assertEquals(args.bed, null);
  assertEquals(parseArgs([...baseArgs, '--apply']).apply, true);
});

Deno.test('parseArgs: rejects bad input without echoing the token', () => {
  assertThrows(() => parseArgs([]), Error, '--family is required');
  assertThrows(() => parseArgs(['--family', 'nope', ...baseArgs.slice(2)]), Error, 'family');
  const shortToken = [...baseArgs];
  shortToken[shortToken.indexOf('--token') + 1] = 'abc';
  const error = assertThrows(() => parseArgs(shortToken), Error, '22 base62');
  assertEquals(String((error as Error).message).includes('abc'), false);
  assertThrows(() => parseArgs([...baseArgs, '--bogus']), Error, 'unknown flag');
  assertThrows(() => parseArgs([...baseArgs, '--poster-at', '99']), Error, 'poster-at');
  assertThrows(() => parseArgs([...baseArgs, '--bed', 'polka']), Error, 'bed');
  assertEquals(parseArgs([...baseArgs, '--bed', 'winter-bells']).bed, 'winter-bells');
  assertThrows(() => parseArgs(baseArgs.slice(0, 8)), Error, '--year');
});

Deno.test('maskToken hides most of the token', () => {
  assertEquals(maskToken(TOKEN), 'aB3x…4d');
  assertEquals(maskToken(TOKEN).includes('N7pR5'), false);
});

Deno.test('readFilmMeta: reads the scope, language and end card only', () => {
  const meta = readFilmMeta(film(), 2026);
  assertEquals(meta, {
    language: 'es',
    scopeStart: '2026-01-01',
    scopeEndExclusive: '2026-10-06',
    title: 'Nuestro 2026',
    greeting: 'Feliz Navidad',
    from: 'de parte de la familia Pruebas',
  });
  assertEquals(JSON.stringify(meta).includes('SECRET'), false);
});

Deno.test('readFilmMeta: validates the film', () => {
  assertThrows(() => readFilmMeta(film({ kind: 'family_year' }), 2026), Error, 'family_holiday');
  assertThrows(() => readFilmMeta(film({ language: 'fr' }), 2026), Error, 'language');
  assertThrows(() => readFilmMeta(film({ scope: { start: '2026-01-01' } }), 2026), Error, 'scope');
  assertThrows(() => readFilmMeta(film({ scope: { start: '2026-02-01', endExclusive: '2026-01-01' } }), 2026), Error, 'before it starts');
  assertThrows(() => readFilmMeta(film(), 2027), Error, '2027');
  assertThrows(() => readFilmMeta(null, 2026), Error, 'object');
});

Deno.test('readFilmMeta: a film without an end card still resolves', () => {
  const meta = readFilmMeta(film({ scenes: [{ type: 'title' }] }), 2026);
  assertEquals([meta.greeting, meta.from], [null, null]);
});

Deno.test('buildFilmScript: only the end card, never memory text', () => {
  const script = buildFilmScript(readFilmMeta(film(), 2026));
  assertEquals(script.scenes, [{ type: 'end_card', greeting: 'Feliz Navidad', from: 'de parte de la familia Pruebas' }]);
  assertEquals(JSON.stringify(script).includes('SECRET'), false);
});

Deno.test('filmObjectKeys: the render pipeline layout, uuids only', () => {
  const keys = filmObjectKeys(OWNER, FILM, ATTEMPT);
  assertEquals(keys.video, `${OWNER}/year-films/${FILM}/${ATTEMPT}/film.mp4`);
  assertEquals(keys.poster, `${OWNER}/year-films/${FILM}/${ATTEMPT}/poster.jpg`);
  assertEquals(keys.posterThumb, `${OWNER}/year-films/${FILM}/${ATTEMPT}/poster_thumb.jpg`);
  assertThrows(() => filmObjectKeys('../x', FILM, ATTEMPT), Error, 'non-uuid');
});

Deno.test('the row is forced, ready, outside the scheduler key and the invalidation arrays', () => {
  const meta = readFilmMeta(film(), 2026);
  const keys = filmObjectKeys(OWNER, FILM, ATTEMPT);
  const input = { familyId: FAMILY, meta, year: 2026, keys, attemptId: ATTEMPT, durationMs: 59000, bed: 'winter-bells', now: '2026-10-05T20:00:00.000Z' };
  const insert = buildFilmRowInsert({ ...input, filmId: FILM });
  assertEquals(insert.kind, 'family_holiday');
  assertEquals(insert.forced, true);
  assertEquals(insert.status, 'ready');
  assertEquals(insert.scope_start_date, '2026-01-01');
  assertEquals(insert.scope_end_exclusive, '2026-10-06');
  assertEquals(insert.video_key, keys.video);
  assertEquals(insert.poster_key, keys.poster);
  assertEquals(insert.music_bed_id, 'winter-bells');
  assertEquals(insert.scope_label, 'Película navideña 2026');
  // never claimable by the dispatcher, never announced
  assertEquals('referenced_memory_ids' in insert, false);
  assertEquals(insert.notified_at, input.now);
  assertEquals(insert.blocked, false);

  const update = buildFilmRowUpdate({ ...input, bed: null });
  assertEquals('music_bed_id' in update, false);
  assertEquals('forced' in update, false);
  assertEquals('kind' in update, false);
  assertEquals(update.cleanup_needed, true);
});

Deno.test('planToken: create, no-op and the refusals', () => {
  assertEquals(planToken(null, null, null, TOKEN), { action: 'create' });
  assertEquals(planToken(null, FILM, null, TOKEN), { action: 'create' });
  assertEquals(planToken({ film_id: FILM, revoked_at: null }, FILM, TOKEN, TOKEN), { action: 'noop' });
  const other = planToken({ film_id: 'other', revoked_at: null }, FILM, null, TOKEN);
  assertEquals(other.action, 'conflict');
  const revoked = planToken({ film_id: FILM, revoked_at: '2026-10-01T00:00:00Z' }, FILM, null, TOKEN);
  assertEquals(revoked.action, 'conflict');
  const second = planToken(null, FILM, 'ZZZZZZZZZZZZZZZZZZZZZZ', TOKEN);
  assertEquals(second.action, 'conflict');
  assertEquals(String((second as { reason: string }).reason).includes('ZZZZZZZZZZ'), false);
  // a film that does not exist yet cannot already own the token
  assertEquals(planToken({ film_id: FILM, revoked_at: null }, null, null, TOKEN).action, 'conflict');
});

Deno.test('ffmpeg arguments: 1080x1920 source frame, 360x640 thumbnail', () => {
  assertEquals(posterArgs('in.mp4', 3, 'p.jpg'), ['-y', '-loglevel', 'error', '-ss', '3', '-i', 'in.mp4', '-frames:v', '1', '-q:v', '3', 'p.jpg']);
  assertEquals(posterThumbArgs('p.jpg', 't.jpg').includes('scale=360:640'), true);
});
