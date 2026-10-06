import { assertEquals } from 'jsr:@std/assert@1';
import {
  type FilmUrlRow,
  FILM_URL_TTL_SECONDS,
  type GetYearFilmUrlDeps,
  handleGetYearFilmUrl,
  MAX_BATCH_FILM_IDS,
  POSTER_URL_TTL_SECONDS,
  posterThumbKey,
} from './index.ts';

const FILM = '11111111-1111-4111-8111-111111111111';
const row: FilmUrlRow = {
  family_id: 'fam', video_key: 'o/year-films/f/a/film.mp4', poster_key: 'o/year-films/f/a/poster.jpg',
  scenes_key: 'o/year-films/f/a/scenes.json', blocked: false, forced: false, surface_at: '2026-10-26T13:00:00Z', duration_ms: 61000,
};

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

interface Calls {
  presigned: { keys: string[]; ttl: number }[];
  loadFilmsCalls: string[][];
  roleLookups: string[][];
}

/** Films by id for the batch loader; each gets its own directory. */
function filmsById(rows: Record<string, Partial<FilmUrlRow>>): (FilmUrlRow & { id: string })[] {
  return Object.entries(rows).map(([id, extra]) => ({
    ...row,
    id,
    video_key: `o/year-films/${id}/a/film.mp4`,
    poster_key: `o/year-films/${id}/a/poster.jpg`,
    scenes_key: `o/year-films/${id}/a/scenes.json`,
    ...extra,
  }));
}

function deps(overrides: Partial<GetYearFilmUrlDeps> = {}, calls?: Calls): GetYearFilmUrlDeps {
  return {
    getAuthenticatedUser: async () => ({ id: 'u' }),
    loadFilm: async () => row,
    loadFilms: async (ids) => {
      calls?.loadFilmsCalls.push(ids);
      return [];
    },
    getRole: async () => 'viewer',
    getRoles: async (familyIds) => {
      calls?.roleLookups.push(familyIds);
      return new Map(familyIds.map((f) => [f, 'viewer']));
    },
    presign: async (keys, ttl) => {
      calls?.presigned.push({ keys, ttl });
      return Object.fromEntries(keys.map((k) => [k, `https://signed/${k}`]));
    },
    liveCardFilms: async () => [],
    now: () => new Date('2026-10-26T14:00:00Z'),
    ...overrides,
  };
}

function newCalls(): Calls {
  return { presigned: [], loadFilmsCalls: [], roleLookups: [] };
}

const post = (body: unknown) => new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) });

Deno.test('a member gets short-lived URLs for a surfaced film', async () => {
  const calls = newCalls();
  const res = await handleGetYearFilmUrl(post({ filmId: FILM }), deps({}, calls));
  const json = await res.json();
  assertEquals(res.status, 200);
  assertEquals(json.videoUrl, `https://signed/${row.video_key}`);
  assertEquals(json.durationMs, 61000);
  assertEquals(json.expiresIn, FILM_URL_TTL_SECONDS);
  assertEquals(calls.presigned[0].ttl, FILM_URL_TTL_SECONDS);
});

Deno.test('no peeking, no strangers, never a blocked film', async () => {
  const early = deps({ now: () => new Date('2026-10-26T12:00:00Z') });
  assertEquals((await handleGetYearFilmUrl(post({ filmId: FILM }), early)).status, 404);
  assertEquals((await handleGetYearFilmUrl(post({ filmId: FILM }), { ...early, getRole: async () => 'manager' })).status, 200);
  assertEquals((await handleGetYearFilmUrl(post({ filmId: FILM }), deps({ getRole: async () => null }))).status, 404);
  assertEquals((await handleGetYearFilmUrl(post({ filmId: FILM }), deps({ loadFilm: async () => ({ ...row, blocked: true }) }))).status, 409);
  assertEquals((await handleGetYearFilmUrl(post({ filmId: 'x' }), deps())).status, 400);
  assertEquals((await handleGetYearFilmUrl(post({ filmId: FILM }), deps({ getAuthenticatedUser: async () => null }))).status, 401);
});

Deno.test('single mode refuses a forced (canary) film like a missing one, even for the owner', async () => {
  const forced = deps({ loadFilm: async () => ({ ...row, forced: true }), getRole: async () => 'owner' });
  const res = await handleGetYearFilmUrl(post({ filmId: FILM }), forced);
  assertEquals(res.status, 404);
  assertEquals((await res.json()).code, 'not_found');
  // A stranger cannot tell a forced film from a missing one either.
  const stranger = deps({ loadFilm: async () => ({ ...row, forced: true }), getRole: async () => null });
  assertEquals((await handleGetYearFilmUrl(post({ filmId: FILM }), stranger)).status, 404);
});

Deno.test('single mode serves a forced CARD film to owners and managers of the card family, nobody else', async () => {
  const cardFilm = { ...row, forced: true };
  const cardLookups: string[][] = [];
  const base = {
    loadFilm: async () => cardFilm,
    liveCardFilms: async (ids: string[]) => {
      cardLookups.push(ids);
      return [{ film_id: FILM, family_id: 'fam' }];
    },
  };
  for (const role of ['owner', 'manager']) {
    const res = await handleGetYearFilmUrl(post({ filmId: FILM }), deps({ ...base, getRole: async () => role }));
    assertEquals(res.status, 200, role);
    assertEquals((await res.json()).videoUrl, `https://signed/${row.video_key}`);
  }
  assertEquals(cardLookups, [[FILM], [FILM]]);
  // A viewer of the same family, and a stranger, still see a missing film.
  assertEquals((await handleGetYearFilmUrl(post({ filmId: FILM }), deps({ ...base, getRole: async () => 'viewer' }))).status, 404);
  assertEquals((await handleGetYearFilmUrl(post({ filmId: FILM }), deps({ ...base, getRole: async () => null }))).status, 404);
  // Forced film with no live card (deleted card, operator canary): still 404 for the owner.
  const noCard = deps({ ...base, liveCardFilms: async () => [], getRole: async () => 'owner' });
  assertEquals((await handleGetYearFilmUrl(post({ filmId: FILM }), noCard)).status, 404);
  // A card of ANOTHER family pointing at the film does not count.
  const otherFamily = deps({ ...base, liveCardFilms: async () => [{ film_id: FILM, family_id: 'someone-else' }], getRole: async () => 'owner' });
  assertEquals((await handleGetYearFilmUrl(post({ filmId: FILM }), otherFamily)).status, 404);
});

Deno.test('single mode: a card film keeps the blocked / unavailable rejections, and non-forced films never query cards', async () => {
  const lookups: string[][] = [];
  const cardDeps = (film: Partial<FilmUrlRow>) =>
    deps({
      loadFilm: async () => ({ ...row, forced: true, ...film }),
      liveCardFilms: async (ids) => (lookups.push(ids), [{ film_id: FILM, family_id: 'fam' }]),
      getRole: async () => 'owner',
    });
  assertEquals((await handleGetYearFilmUrl(post({ filmId: FILM }), cardDeps({ blocked: true }))).status, 409);
  // An ended card film has no video keys left.
  assertEquals((await handleGetYearFilmUrl(post({ filmId: FILM }), cardDeps({ video_key: null, poster_key: null, scenes_key: null }))).status, 409);
  lookups.length = 0;
  await handleGetYearFilmUrl(post({ filmId: FILM }), deps({ liveCardFilms: async (ids) => (lookups.push(ids), []) }));
  assertEquals(lookups, []);
});

Deno.test('batch: a forced card film signs only for owners/managers of its card family; other forced films stay omitted', async () => {
  const [card, canary] = [1, 2].map(uuid);
  const films = filmsById({ [card]: { forced: true }, [canary]: { forced: true } });
  const lookups: string[][] = [];
  const run = (role: string) =>
    handleGetYearFilmUrl(
      post({ filmIds: [card, canary] }),
      deps({
        loadFilms: async () => films,
        getRoles: async (f) => new Map(f.map((x) => [x, role])),
        liveCardFilms: async (ids) => (lookups.push(ids), [{ film_id: card, family_id: 'fam' }]),
      }),
    );
  assertEquals(Object.keys((await (await run('manager')).json()).posters), [card]);
  assertEquals(Object.keys((await (await run('owner')).json()).posters), [card]);
  assertEquals((await (await run('viewer')).json()).posters, {});
  // Only films the caller manages are looked up, and only once per request.
  assertEquals(lookups, [[card, canary], [card, canary]]);
});

Deno.test('posterThumbKey derives poster_thumb.jpg in the poster directory', () => {
  assertEquals(posterThumbKey('o/year-films/f/a/poster.jpg'), 'o/year-films/f/a/poster_thumb.jpg');
  assertEquals(posterThumbKey('poster.jpg'), null);
});

Deno.test('batch: signs the derived thumb key with a 60-minute TTL, per film id', async () => {
  const a = uuid(1);
  const b = uuid(2);
  const calls = newCalls();
  const res = await handleGetYearFilmUrl(
    post({ filmIds: [a, b] }),
    deps({ loadFilms: async (ids) => (calls.loadFilmsCalls.push(ids), filmsById({ [a]: {}, [b]: {} })) }, calls),
  );
  const json = await res.json();
  assertEquals(res.status, 200);
  assertEquals(json.posters, {
    [a]: `https://signed/o/year-films/${a}/a/poster_thumb.jpg`,
    [b]: `https://signed/o/year-films/${b}/a/poster_thumb.jpg`,
  });
  assertEquals(POSTER_URL_TTL_SECONDS, 3600);
  assertEquals(json.expiresIn, 3600);
  // One presign call, thumbs only (never the video/poster/scenes), 60 min.
  assertEquals(calls.presigned.length, 1);
  assertEquals(calls.presigned[0].ttl, 3600);
  assertEquals(calls.presigned[0].keys, [`o/year-films/${a}/a/poster_thumb.jpg`, `o/year-films/${b}/a/poster_thumb.jpg`]);
  // One film query for the batch.
  assertEquals(calls.loadFilmsCalls, [[a, b]]);
});

Deno.test('batch: blocked, forced, unsurfaced, unpublished and foreign films are omitted, not errors', async () => {
  const [ok, blocked, forced, later, noVideo, foreign, unknown] = [1, 2, 3, 4, 5, 6, 7].map(uuid);
  const calls = newCalls();
  const films = filmsById({
    [ok]: {},
    [blocked]: { blocked: true },
    [forced]: { forced: true },
    [later]: { surface_at: '2026-10-26T15:00:00Z' },
    [noVideo]: { video_key: null, poster_key: null, scenes_key: null },
    [foreign]: { family_id: 'other-family' },
  });
  const res = await handleGetYearFilmUrl(
    post({ filmIds: [ok, blocked, forced, later, noVideo, foreign, unknown] }),
    deps({
      loadFilms: async () => films,
      getRoles: async (familyIds) => {
        calls.roleLookups.push(familyIds);
        return new Map(familyIds.map((f) => [f, f === 'other-family' ? null : 'viewer']));
      },
    }, calls),
  );
  assertEquals(res.status, 200);
  assertEquals(Object.keys((await res.json()).posters), [ok]);
  // Roles are resolved once per distinct family, not per film.
  assertEquals(calls.roleLookups.length, 1);
  assertEquals([...calls.roleLookups[0]].sort(), ['fam', 'other-family']);
});

Deno.test('batch: surfaced-only for EVERYONE, owners and managers included', async () => {
  const id = uuid(1);
  const early = { now: () => new Date('2026-10-26T12:00:00Z') };
  for (const role of ['owner', 'manager', 'viewer']) {
    const res = await handleGetYearFilmUrl(
      post({ filmIds: [id] }),
      deps({ ...early, loadFilms: async () => filmsById({ [id]: {} }), getRoles: async (f) => new Map(f.map((x) => [x, role])) }),
    );
    assertEquals(res.status, 200, role);
    assertEquals((await res.json()).posters, {}, role);
  }
  // …while single mode keeps the owner/manager early preview.
  assertEquals((await handleGetYearFilmUrl(post({ filmId: FILM }), deps({ ...early, getRole: async () => 'owner' }))).status, 200);
});

Deno.test('batch: films across several families resolve each role, and only the caller\'s families sign', async () => {
  const [mine, theirs, mine2] = [1, 2, 3].map(uuid);
  const films = filmsById({ [mine]: { family_id: 'fam-a' }, [theirs]: { family_id: 'fam-b' }, [mine2]: { family_id: 'fam-a' } });
  const calls = newCalls();
  const res = await handleGetYearFilmUrl(
    post({ filmIds: [mine, theirs, mine2] }),
    deps({
      loadFilms: async () => films,
      getRoles: async (familyIds, userId) => {
        calls.roleLookups.push(familyIds);
        assertEquals(userId, 'u');
        return new Map(familyIds.map((f) => [f, f === 'fam-a' ? 'manager' : null]));
      },
    }, calls),
  );
  assertEquals(Object.keys((await res.json()).posters).sort(), [mine, mine2].sort());
  assertEquals(calls.roleLookups, [['fam-a', 'fam-b']]);
});

Deno.test('batch: nothing servable means no presign call and an empty map', async () => {
  const calls = newCalls();
  const res = await handleGetYearFilmUrl(post({ filmIds: [uuid(1)] }), deps({}, calls));
  assertEquals(res.status, 200);
  assertEquals((await res.json()).posters, {});
  assertEquals(calls.presigned.length, 0);
});

Deno.test('batch: validation and the cap of 50', async () => {
  const fifty = Array.from({ length: MAX_BATCH_FILM_IDS }, (_, i) => uuid(i + 1));
  const okRes = await handleGetYearFilmUrl(post({ filmIds: fifty }), deps());
  assertEquals(okRes.status, 200);
  const tooMany = await handleGetYearFilmUrl(post({ filmIds: [...fifty, uuid(99)] }), deps());
  assertEquals(tooMany.status, 400);
  assertEquals((await tooMany.json()).code, 'validation_error');
  assertEquals((await handleGetYearFilmUrl(post({ filmIds: [] }), deps())).status, 400);
  assertEquals((await handleGetYearFilmUrl(post({ filmIds: 'nope' }), deps())).status, 400);
  assertEquals((await handleGetYearFilmUrl(post({ filmIds: [uuid(1), 'not-a-uuid'] }), deps())).status, 400);
  assertEquals((await handleGetYearFilmUrl(post({ filmIds: [uuid(1), 7] }), deps())).status, 400);
  assertEquals((await handleGetYearFilmUrl(post({ filmIds: [uuid(1)] }), deps({ getAuthenticatedUser: async () => null }))).status, 401);
});

Deno.test('batch: duplicate ids are queried once', async () => {
  const calls = newCalls();
  await handleGetYearFilmUrl(post({ filmIds: [uuid(1), uuid(1), uuid(2)] }), deps({}, calls));
  assertEquals(calls.loadFilmsCalls, [[uuid(1), uuid(2)]]);
});
