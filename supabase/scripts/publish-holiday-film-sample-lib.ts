/**
 * Pure parts of publish-holiday-film-sample.ts (argument parsing, film.json
 * validation, the dogfood row and its R2 keys, token conflict rules). No I/O
 * here so the dry run and the tests share exactly the logic `--apply` uses.
 *
 * PII: a film's data (film.json) holds captions and names. Nothing here
 * returns them: only the language, the scope dates and the end card's
 * greeting/signature (the strings printed on the card itself) are read.
 */
import { isYearFilmBed } from '../functions/_shared/year-film-beds.ts';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TOKEN = /^[A-Za-z0-9]{22}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const DEFAULT_POSTER_AT_SECONDS = 3.0;

export interface PublishArgs {
  family: string;
  filmData: string;
  mp4: string;
  token: string;
  year: number;
  apply: boolean;
  posterAt: number;
  bed: string | null;
}

/** Throws a readable message for anything malformed; never echoes the token. */
export function parseArgs(argv: string[]): PublishArgs {
  const value = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const required = (name: string): string => {
    const v = value(name);
    if (!v || v.startsWith('--')) throw new Error(`${name} is required`);
    return v;
  };
  const known = new Set(['--family', '--film-data', '--mp4', '--token', '--year', '--apply', '--poster-at', '--bed']);
  for (const arg of argv) {
    if (arg.startsWith('--') && !known.has(arg)) throw new Error(`unknown flag ${arg}`);
  }

  const family = required('--family');
  if (!UUID.test(family)) throw new Error('--family needs a family id (uuid)');
  const token = required('--token');
  if (!TOKEN.test(token)) throw new Error('--token must be exactly 22 base62 characters');
  const year = Number(required('--year'));
  if (!Number.isInteger(year) || year < 2025 || year > 2100) throw new Error('--year needs a year like 2026');

  const posterAtText = value('--poster-at');
  const posterAt = posterAtText === undefined ? DEFAULT_POSTER_AT_SECONDS : Number(posterAtText);
  if (!Number.isFinite(posterAt) || posterAt < 0 || posterAt > 30) throw new Error('--poster-at needs seconds between 0 and 30');

  const bed = value('--bed') ?? null;
  if (bed !== null && !isYearFilmBed(bed)) throw new Error('--bed is not a known music bed id');

  return {
    family,
    filmData: required('--film-data'),
    mp4: required('--mp4'),
    token,
    year,
    apply: argv.includes('--apply'),
    posterAt,
    bed,
  };
}

/** `S5cA…8t`: enough to recognise a token in a log, not to use it. */
export function maskToken(token: string): string {
  return token.length <= 8 ? '…' : `${token.slice(0, 4)}…${token.slice(-2)}`;
}

export interface FilmMeta {
  language: 'es' | 'en';
  scopeStart: string;
  scopeEndExclusive: string;
  title: string | null;
  greeting: string | null;
  from: string | null;
}

function shortText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 80) : null;
}

/** Validates a holiday film.json and extracts only what the row needs. */
export function readFilmMeta(film: unknown, year: number): FilmMeta {
  if (typeof film !== 'object' || film === null) throw new Error('film.json is not an object');
  const f = film as Record<string, unknown>;
  if (f.kind !== 'family_holiday') throw new Error('film.json kind must be family_holiday');
  if (f.language !== 'es' && f.language !== 'en') throw new Error('film.json language must be es or en');
  const scope = f.scope as { start?: unknown; endExclusive?: unknown } | undefined;
  const start = scope?.start;
  const end = scope?.endExclusive;
  if (typeof start !== 'string' || typeof end !== 'string' || !DATE.test(start) || !DATE.test(end)) {
    throw new Error('film.json scope needs start and endExclusive dates');
  }
  if (!(end > start)) throw new Error('film.json scope ends before it starts');
  if (Number(start.slice(0, 4)) !== year) throw new Error(`film.json scope starts in ${start.slice(0, 4)}, not ${year}`);

  let greeting: string | null = null;
  let from: string | null = null;
  const scenes = Array.isArray(f.scenes) ? f.scenes : [];
  for (let i = scenes.length - 1; i >= 0; i--) {
    const scene = scenes[i] as { type?: unknown; greeting?: unknown; from?: unknown } | null;
    if (scene && scene.type === 'end_card') {
      greeting = shortText(scene.greeting);
      from = shortText(scene.from);
      break;
    }
  }
  return { language: f.language, scopeStart: start, scopeEndExclusive: end, title: shortText(f.title), greeting, from };
}

/**
 * The row's `film_script`: deliberately NOT the full script (which holds
 * memory text and asset keys). Just enough for the public page's title: the
 * end card's greeting and signature, which are printed on the card itself.
 * Same shape the Worker reads (`scenes[].type === 'end_card'`).
 */
export function buildFilmScript(meta: FilmMeta): Record<string, unknown> {
  return {
    version: 1,
    kind: 'family_holiday',
    language: meta.language,
    theme: 'holiday',
    ...(meta.title ? { title: meta.title } : {}),
    dogfood: true,
    scenes: [{ type: 'end_card', greeting: meta.greeting, from: meta.from }],
  };
}

export interface FilmObjectKeys {
  prefix: string;
  video: string;
  poster: string;
  posterThumb: string;
}

/** `{ownerId}/year-films/{filmId}/{attemptId}/…`, the render pipeline's layout. */
export function filmObjectKeys(ownerId: string, filmId: string, attemptId: string): FilmObjectKeys {
  for (const id of [ownerId, filmId, attemptId]) {
    if (!UUID.test(id)) throw new Error('refusing to build an R2 key from a non-uuid');
  }
  const prefix = `${ownerId}/year-films/${filmId}/${attemptId}/`;
  return { prefix, video: `${prefix}film.mp4`, poster: `${prefix}poster.jpg`, posterThumb: `${prefix}poster_thumb.jpg` };
}

export function scopeLabel(language: 'es' | 'en', year: number): string {
  return language === 'es' ? `Película navideña ${year}` : `Holiday film ${year}`;
}

export interface FilmRowInput {
  familyId: string;
  meta: FilmMeta;
  year: number;
  keys: FilmObjectKeys;
  attemptId: string;
  durationMs: number;
  bed: string | null;
  now: string;
}

/**
 * Columns written on BOTH insert and update. The row is `forced` (never in the
 * scheduler's key, hidden from members, never announced) and `ready` from the
 * start: it is only written after the upload succeeded, so it is never in a
 * `queued` state that claim_year_film_dispatch could pick up.
 *
 * `referenced_*` stay at their empty defaults: this dogfood row sits OUTSIDE
 * the render pipeline, so memory deletions, edits and reports do NOT
 * invalidate it. Known gap until P1 re-renders the card film under the same
 * film id (then the normal invalidation applies).
 */
export function buildFilmRowUpdate(input: FilmRowInput): Record<string, unknown> {
  return {
    status: 'ready',
    language: input.meta.language,
    scope_label: scopeLabel(input.meta.language, input.year),
    film_script: buildFilmScript(input.meta),
    ...(input.bed ? { music_bed_id: input.bed } : {}),
    video_key: input.keys.video,
    poster_key: input.keys.poster,
    duration_ms: input.durationMs,
    attempt_id: input.attemptId,
    blocked: false,
    stale: false,
    skip_reason: null,
    last_failure_code: null,
    ready_at: input.now,
    notified_at: input.now,
    // The renderer's cleanup sweep keeps only the directory holding
    // video_key, so a re-run's older attempt directory is removed.
    cleanup_needed: true,
    updated_at: input.now,
  };
}

export function buildFilmRowInsert(input: FilmRowInput & { filmId: string }): Record<string, unknown> {
  return {
    id: input.filmId,
    family_id: input.familyId,
    kind: 'family_holiday',
    forced: true,
    scope_start_date: input.meta.scopeStart,
    scope_end_exclusive: input.meta.scopeEndExclusive,
    surface_at: input.now,
    ...buildFilmRowUpdate(input),
  };
}

export interface ExistingToken {
  film_id: string;
  revoked_at: string | null;
}

export type TokenPlan =
  | { action: 'create' }
  | { action: 'noop' }
  | { action: 'conflict'; reason: string };

/**
 * What to do about the card's token for `filmId`, given the token's current
 * row (if any) and the film's current ACTIVE token (if any).
 *
 * - token unknown: create it (unless the film already has a DIFFERENT active
 *   token: the one-active-token-per-film index would refuse it);
 * - token active for this film: nothing to do;
 * - token active for another film: refuse (never steal a printed QR);
 * - token revoked: refuse (re-activating a deliberately revoked link is the
 *   owner's call, made by hand).
 */
export function planToken(
  existing: ExistingToken | null,
  filmId: string | null,
  activeTokenOfFilm: string | null,
  token: string,
): TokenPlan {
  if (existing) {
    if (existing.revoked_at) return { action: 'conflict', reason: 'the token exists but is revoked; pick another token or reactivate it by hand' };
    if (filmId !== null && existing.film_id === filmId) return { action: 'noop' };
    return { action: 'conflict', reason: 'the token is already active for another film' };
  }
  if (activeTokenOfFilm && activeTokenOfFilm !== token) {
    return { action: 'conflict', reason: `the film already has a different active token (${maskToken(activeTokenOfFilm)}); revoke it first` };
  }
  return { action: 'create' };
}

/** ffmpeg arguments for the 1080x1920 poster JPEG at `seconds`. */
export function posterArgs(mp4: string, seconds: number, out: string): string[] {
  return ['-y', '-loglevel', 'error', '-ss', String(seconds), '-i', mp4, '-frames:v', '1', '-q:v', '3', out];
}

/** The 360x640 list thumbnail, scaled from the poster itself (same frame). */
export function posterThumbArgs(posterJpg: string, out: string): string[] {
  return ['-y', '-loglevel', 'error', '-i', posterJpg, '-vf', 'scale=360:640', '-frames:v', '1', '-q:v', '4', out];
}
