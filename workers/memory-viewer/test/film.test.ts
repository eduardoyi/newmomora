import { describe, expect, it } from 'vitest';

import { classifyFilmToken, filmLanguage, filmTitle, parseFilmRoute, readEndCard, resolveFilm, type FilmRow } from '../src/film';

const TOKEN = 'aB3xQ9zK1mN7pR5tW2yC4d';

function row(overrides: Partial<FilmRow> = {}): FilmRow {
  return {
    id: 'film-1',
    family_id: 'family-1',
    kind: 'family_holiday',
    status: 'ready',
    blocked: false,
    video_key: 'owner/year-films/film-1/attempt-1/film.mp4',
    poster_key: 'owner/year-films/film-1/attempt-1/poster.jpg',
    language: 'es',
    film_script: {
      scenes: [
        { type: 'title', title: '2026' },
        { type: 'end_card', greeting: 'Feliz Navidad', from: 'de parte de la familia Pruebas' },
      ],
    },
    families: { deleted_at: null },
    ...overrides,
  };
}

describe('parseFilmRoute', () => {
  it('parses the page, video and poster routes', () => {
    expect(parseFilmRoute(`/f/${TOKEN}`)).toEqual({ token: TOKEN, kind: 'page' });
    expect(parseFilmRoute(`/f/${TOKEN}/video`)).toEqual({ token: TOKEN, kind: 'video' });
    expect(parseFilmRoute(`/f/${TOKEN}/poster`)).toEqual({ token: TOKEN, kind: 'poster' });
  });

  it('keeps the token case', () => {
    expect(parseFilmRoute(`/f/${TOKEN}`)?.token).toBe(TOKEN);
  });

  it('rejects anything that is not exactly 22 base62 characters', () => {
    expect(parseFilmRoute('/f/short')).toBeNull();
    expect(parseFilmRoute(`/f/${TOKEN}x`)).toBeNull();
    expect(parseFilmRoute(`/f/${TOKEN.slice(1)}`)).toBeNull();
    expect(parseFilmRoute(`/f/${TOKEN.slice(0, 21)}-`)).toBeNull();
    expect(parseFilmRoute(`/f/${TOKEN.slice(0, 21)}_`)).toBeNull();
  });

  it('rejects trailing slashes, extra segments and unknown sub-routes', () => {
    expect(parseFilmRoute(`/f/${TOKEN}/`)).toBeNull();
    expect(parseFilmRoute(`/f/${TOKEN}/video/x`)).toBeNull();
    expect(parseFilmRoute(`/f/${TOKEN}/scenes`)).toBeNull();
    expect(parseFilmRoute('/f/')).toBeNull();
    expect(parseFilmRoute('/f')).toBeNull();
    expect(parseFilmRoute(`/m/${TOKEN}`)).toBeNull();
  });
});

describe('classifyFilmToken', () => {
  it('maps no row / revoked / active', () => {
    expect(classifyFilmToken(null)).toEqual({ status: 'not_found' });
    expect(classifyFilmToken({ film_id: 'f', revoked_at: '2026-10-01T00:00:00Z' })).toEqual({ status: 'revoked' });
    expect(classifyFilmToken({ film_id: 'f', revoked_at: null })).toEqual({ status: 'active', filmId: 'f' });
  });
});

describe('resolveFilm', () => {
  it('resolves a ready film with its end card', () => {
    expect(resolveFilm(row())).toEqual({
      kind: 'film',
      film: {
        videoKey: 'owner/year-films/film-1/attempt-1/film.mp4',
        posterKey: 'owner/year-films/film-1/attempt-1/poster.jpg',
        language: 'es',
        greeting: 'Feliz Navidad',
        from: 'de parte de la familia Pruebas',
      },
    });
  });

  it('is not_found without a row or for a family pending deletion', () => {
    expect(resolveFilm(null)).toEqual({ kind: 'not_found' });
    expect(resolveFilm(row({ families: { deleted_at: '2026-10-01T00:00:00Z' } }))).toEqual({ kind: 'not_found' });
  });

  it('is updating when blocked or without a servable video, keeping the language', () => {
    expect(resolveFilm(row({ blocked: true }))).toEqual({ kind: 'updating', language: 'es' });
    expect(resolveFilm(row({ video_key: null, poster_key: null, language: 'en' }))).toEqual({ kind: 'updating', language: 'en' });
    expect(resolveFilm(row({ poster_key: null }))).toEqual({ kind: 'updating', language: 'es' });
  });

  it('keeps serving a stale film (a re-render is wanted but the video is fine)', () => {
    expect(resolveFilm(row({ status: 'queued' })).kind).toBe('film');
  });

  it('defaults the language to English', () => {
    expect(filmLanguage(null)).toBe('en');
    expect(filmLanguage('fr')).toBe('en');
    expect(filmLanguage('es')).toBe('es');
  });
});

describe('readEndCard', () => {
  it('reads only the last end_card scene', () => {
    expect(
      readEndCard({
        scenes: [
          { type: 'end_card', greeting: 'old', from: 'old' },
          { type: 'chapter', name: 'SECRET' },
          { type: 'end_card', greeting: 'Merry Christmas', from: 'from the Sample family' },
        ],
      }),
    ).toEqual({ greeting: 'Merry Christmas', from: 'from the Sample family' });
  });

  it('is defensive about shapes', () => {
    const none = { greeting: null, from: null };
    expect(readEndCard(null)).toEqual(none);
    expect(readEndCard('x')).toEqual(none);
    expect(readEndCard({})).toEqual(none);
    expect(readEndCard({ scenes: 'nope' })).toEqual(none);
    expect(readEndCard({ scenes: [{ type: 'title' }] })).toEqual(none);
    expect(readEndCard({ scenes: [{ type: 'end_card', greeting: 7, from: {} }] })).toEqual(none);
  });

  it('cleans control characters and caps the length', () => {
    const long = 'x'.repeat(200);
    const card = readEndCard({ scenes: [{ type: 'end_card', greeting: '  Feliz\n\tNavidad\u0000 ', from: long }] });
    expect(card.greeting).toBe('Feliz Navidad');
    expect(Array.from(card.from ?? '').length).toBe(80);
    expect(card.from?.endsWith('…')).toBe(true);
  });
});

describe('filmTitle', () => {
  it('joins the greeting and a shortened Spanish signature', () => {
    expect(filmTitle({ language: 'es', greeting: 'Feliz Navidad', from: 'de parte de la familia Pruebas' })).toBe(
      'Feliz Navidad · de la familia Pruebas',
    );
  });

  it('keeps an English signature as is', () => {
    expect(filmTitle({ language: 'en', greeting: 'Merry Christmas', from: 'from the Sample family' })).toBe(
      'Merry Christmas · from the Sample family',
    );
  });

  it('falls back to the greeting alone, then a neutral line', () => {
    expect(filmTitle({ language: 'es', greeting: 'Felices fiestas', from: null })).toBe('Felices fiestas');
    expect(filmTitle({ language: 'es', greeting: null, from: null })).toBe('Un año en familia');
    expect(filmTitle({ language: 'en', greeting: null, from: 'orphan' })).toBe('A year as a family');
  });
});
