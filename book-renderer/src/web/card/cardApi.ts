import { supabase } from '../supabaseClient';
import { raceInvokeTimeout, TIMED_OUT } from '../invokeTimeout';
import { getMediaUrls } from '../media/coalescer';
import { fixtureFilmUrls, fixtureGet, fixtureMediaUrls, fixturePickerPool, fixtureSave, isCardFixture } from './dev/cardFixture';
import type { CardEdits } from '../../card/edits';
import {
  CardApiError,
  parseFilmUrls,
  parseHolidayCard,
  parsePickerPool,
  parseSaveEdits,
  toCardApiError,
  type FilmUrls,
  type HolidayCardView,
  type PickerPoolPage,
  type SaveEditsResult,
} from './cardTypes';

export { CardApiError } from './cardTypes';
export type { HolidayCardView, PickerPoolPage, SaveEditsResult, FilmUrls } from './cardTypes';

/**
 * Typed clients for the `holiday-cards` Edge Function (get, picker_pool,
 * save_edits) and `get-year-film-url`. Every call is raced against a timeout
 * (a hung `functions.invoke` becomes a `CardApiError` with code `timeout`, the
 * signal the edit queue uses to refetch before retrying) and every failure is a
 * `CardApiError { status, code, currentVersion? }`.
 */

/** `get` and `picker_pool` are cheap reads; a save is bounded tighter so a hang is noticed. */
export const READ_TIMEOUT_MS = 30_000;
export const SAVE_TIMEOUT_MS = 20_000;

export async function invoke<T>(functionName: string, body: Record<string, unknown>, timeoutMs: number): Promise<T> {
  const raced = await raceInvokeTimeout(supabase.functions.invoke<T>(functionName, { body }), timeoutMs);
  if (raced === TIMED_OUT) throw new CardApiError(0, 'timeout', 'This is taking longer than expected.');
  const { data, error } = raced;
  if (error) throw await toCardApiError(error);
  return data as T;
}

export async function getHolidayCard(cardId: string): Promise<HolidayCardView> {
  // DEV-ONLY walkthrough data (`dev/cardFixture.ts`); dead code in a production build.
  if (import.meta.env.DEV && isCardFixture()) return parseHolidayCard(await fixtureGet(cardId));
  const raw = await invoke<unknown>('holiday-cards', { op: 'get', cardId }, READ_TIMEOUT_MS);
  return parseHolidayCard(raw);
}

export async function fetchPickerPool(cardId: string, cursor: string | null, limit = 30): Promise<PickerPoolPage> {
  if (import.meta.env.DEV && isCardFixture()) return fixturePickerPool(cursor);
  const raw = await invoke<unknown>('holiday-cards', { op: 'picker_pool', cardId, cursor, limit }, READ_TIMEOUT_MS);
  return parsePickerPool(raw);
}

export async function saveCardEdits(cardId: string, expectedVersion: number, edits: CardEdits): Promise<SaveEditsResult> {
  if (import.meta.env.DEV && isCardFixture()) return fixtureSave(expectedVersion, edits);
  const raw = await invoke<unknown>('holiday-cards', { op: 'save_edits', cardId, expectedVersion, edits }, SAVE_TIMEOUT_MS);
  return parseSaveEdits(raw);
}

export async function getFilmUrls(filmId: string): Promise<FilmUrls> {
  if (import.meta.env.DEV && isCardFixture()) return fixtureFilmUrls();
  const raw = await invoke<unknown>('get-year-film-url', { filmId }, READ_TIMEOUT_MS);
  return parseFilmUrls(raw);
}

/** Signed thumbnail URLs for picker previews, through the shared batched `get-media-url` coalescer. */
export function getCardMediaUrls(keys: string[]): Promise<Map<string, string>> {
  // The shared coalescer's own fixture branch serves BOOK data; the card fixture has its own.
  if (import.meta.env.DEV && isCardFixture()) return Promise.resolve(fixtureMediaUrls(keys));
  return getMediaUrls(keys);
}
