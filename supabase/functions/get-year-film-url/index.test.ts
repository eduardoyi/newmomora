import { assertEquals } from 'jsr:@std/assert@1';
import { type FilmUrlRow, type GetYearFilmUrlDeps, handleGetYearFilmUrl } from './index.ts';

const FILM = '11111111-1111-4111-8111-111111111111';
const row: FilmUrlRow = {
  family_id: 'fam', video_key: 'o/year-films/f/a/film.mp4', poster_key: 'o/year-films/f/a/poster.jpg',
  scenes_key: 'o/year-films/f/a/scenes.json', blocked: false, surface_at: '2026-10-26T13:00:00Z', duration_ms: 61000,
};

function deps(overrides: Partial<GetYearFilmUrlDeps> = {}): GetYearFilmUrlDeps {
  return {
    getAuthenticatedUser: async () => ({ id: 'u' }),
    loadFilm: async () => row,
    getRole: async () => 'viewer',
    presign: async (keys) => Object.fromEntries(keys.map((k) => [k, `https://signed/${k}`])),
    now: () => new Date('2026-10-26T14:00:00Z'),
    ...overrides,
  };
}

const post = (body: unknown) => new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) });

Deno.test('a member gets short-lived URLs for a surfaced film', async () => {
  const res = await handleGetYearFilmUrl(post({ filmId: FILM }), deps());
  const json = await res.json();
  assertEquals(res.status, 200);
  assertEquals(json.videoUrl, `https://signed/${row.video_key}`);
  assertEquals(json.durationMs, 61000);
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
