/**
 * Pure routing + token-to-film resolution for the public film page
 * (`/f/:token`, `/f/:token/video`, `/f/:token/poster`). Same split as
 * resolve.ts: no I/O here, so it is unit-testable without Miniflare or a
 * Supabase mock server. See README "Public film page".
 *
 * Privacy: a film row carries a `film_script` full of memory text (captions,
 * quotes). This module only ever reads the end card's two short strings (the
 * greeting and the signature line, which are printed on the card itself) out of
 * it and drops everything else on the floor. Nothing else from the script can
 * reach a page, a header or a log.
 */

/** A film share token: exactly 22 base62 characters, the format the
 * `film_share_tokens_token_format` CHECK enforces. Tighter than the memory
 * viewer's pattern because this table owns the format. Case-sensitive. */
const FILM_TOKEN_PATTERN = /^[A-Za-z0-9]{22}$/;

export type FilmRouteKind = 'page' | 'video' | 'poster';

export interface FilmRoute {
  token: string;
  kind: FilmRouteKind;
}

/**
 * Parses `/f/:token`, `/f/:token/video` and `/f/:token/poster`. Anything else
 * (wrong token shape, extra segments, trailing slash) is `null` so the caller
 * can 404 without touching Supabase. Returns `null` for non-`/f/` paths too.
 */
export function parseFilmRoute(pathname: string): FilmRoute | null {
  if (!pathname.startsWith('/f/')) return null;
  const [token, sub, ...extra] = pathname.slice('/f/'.length).split('/');
  if (extra.length > 0 || !FILM_TOKEN_PATTERN.test(token ?? '')) return null;
  if (sub === undefined) return { token, kind: 'page' };
  if (sub === 'video' || sub === 'poster') return { token, kind: sub };
  return null;
}

/** Row shape from `film_share_tokens` (SELECT film_id,revoked_at). */
export interface FilmTokenRow {
  film_id: string;
  revoked_at: string | null;
}

export type FilmTokenResolution =
  | { status: 'not_found' }
  | { status: 'revoked' }
  | { status: 'active'; filmId: string };

export function classifyFilmToken(row: FilmTokenRow | null): FilmTokenResolution {
  if (!row) return { status: 'not_found' };
  if (row.revoked_at) return { status: 'revoked' };
  return { status: 'active', filmId: row.film_id };
}

/** Row shape from `year_films`, with the family's deletion marker embedded. */
export interface FilmRow {
  id: string;
  family_id: string;
  kind: string;
  status: string;
  blocked: boolean;
  video_key: string | null;
  poster_key: string | null;
  language: string | null;
  /** The whole script; see the module comment. Only the end card is read. */
  film_script: unknown;
  families?: { deleted_at: string | null } | null;
}

export type FilmLanguage = 'es' | 'en';

export interface ResolvedFilm {
  videoKey: string;
  posterKey: string;
  language: FilmLanguage;
  /** The end card's greeting ("Feliz Navidad"), when the script has one. */
  greeting: string | null;
  /** The end card's signature line ("de parte de la familia …"). */
  from: string | null;
}

export type FilmResolution =
  | { kind: 'not_found' }
  | { kind: 'revoked' }
  | { kind: 'updating'; language: FilmLanguage }
  | { kind: 'film'; film: ResolvedFilm };

export function filmLanguage(value: string | null | undefined): FilmLanguage {
  return value === 'es' ? 'es' : 'en';
}

const MAX_END_CARD_TEXT = 80;

/** Collapses whitespace, strips control characters, caps the length. */
function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const characters = Array.from(text);
  return characters.length <= MAX_END_CARD_TEXT ? text : `${characters.slice(0, MAX_END_CARD_TEXT - 1).join('').trimEnd()}…`;
}

/**
 * The end card's greeting and signature line, if the script has an `end_card`
 * scene (the last one wins). Defensive about the shape: a script that is not
 * an object, has no scenes, or whose end card has no strings yields nulls.
 */
export function readEndCard(script: unknown): { greeting: string | null; from: string | null } {
  const empty = { greeting: null, from: null };
  if (typeof script !== 'object' || script === null) return empty;
  const scenes = (script as { scenes?: unknown }).scenes;
  if (!Array.isArray(scenes)) return empty;
  for (let i = scenes.length - 1; i >= 0; i--) {
    const scene = scenes[i];
    if (typeof scene === 'object' && scene !== null && (scene as { type?: unknown }).type === 'end_card') {
      const card = scene as { greeting?: unknown; from?: unknown };
      return { greeting: cleanText(card.greeting), from: cleanText(card.from) };
    }
  }
  return empty;
}

/**
 * Resolves the film row of an active token into what the page may serve.
 *
 *  - no row, or its family is pending deletion: `not_found`;
 *  - `blocked` (a removal/report took content out of the current video) or no
 *    servable video yet: `updating`, a calm page, never the video;
 *  - otherwise `film`. A merely `stale` film (a re-render is wanted) keeps
 *    serving its current video, exactly like the in-app player.
 */
export function resolveFilm(row: FilmRow | null): FilmResolution {
  if (!row) return { kind: 'not_found' };
  if (row.families?.deleted_at) return { kind: 'not_found' };
  const language = filmLanguage(row.language);
  if (row.blocked || !row.video_key || !row.poster_key) return { kind: 'updating', language };
  const { greeting, from } = readEndCard(row.film_script);
  return { kind: 'film', film: { videoKey: row.video_key, posterKey: row.poster_key, language, greeting, from } };
}

/** "de parte de la familia X" reads stiff in a title: "de la familia X". */
function shortenFrom(from: string): string {
  return from.replace(/^de parte de /i, 'de ');
}

/**
 * The share title: "Feliz Navidad · de la familia X" when the end card is
 * known (both strings are printed on the card the person scanned), else the
 * greeting alone, else a neutral line. Never anything from a memory.
 */
export function filmTitle(film: Pick<ResolvedFilm, 'language' | 'greeting' | 'from'>): string {
  if (film.greeting && film.from) return `${film.greeting} · ${shortenFrom(film.from)}`;
  if (film.greeting) return film.greeting;
  return film.language === 'es' ? 'Un año en familia' : 'A year as a family';
}
