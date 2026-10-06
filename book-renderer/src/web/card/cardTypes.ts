import { normalizeEdits, type CardEdits } from '../../card/edits';
import { parseCardData, type CardData, type CardGreetingKey, type CardLanguage } from '../../card/types';

/**
 * Types and PURE helpers for the `holiday-cards` Edge Function client (no
 * Supabase import, so they unit-test in plain node). The network calls live in
 * `cardApi.ts`; the contract is docs/plans/holiday-cards-p2.md §5 Step 2 and
 * supabase/functions/holiday-cards/index.ts.
 */

// ── Errors ───────────────────────────────────────────────────────────────

/** A failed `holiday-cards` call. `status` 0 = never reached the server (network / timeout). */
export class CardApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** 409 `edits_version_mismatch` only: the server's current version. */
  readonly currentVersion: number | null;
  constructor(status: number, code: string, message: string, currentVersion: number | null = null) {
    super(message);
    this.name = 'CardApiError';
    this.status = status;
    this.code = code;
    this.currentVersion = currentVersion;
  }
}

/** What supabase-js hands back: `FunctionsHttpError` carries the `Response` on `.context`. */
export interface FunctionsErrorLike {
  name?: string;
  message: string;
  context?: unknown;
}

/**
 * Unwraps a `functions.invoke` error into a `CardApiError`. An HTTP error has
 * the real `{ error, code, currentVersion? }` body and status on `.context`;
 * a relay/fetch error (no response) becomes status 0 `network_error`.
 */
export async function toCardApiError(error: FunctionsErrorLike): Promise<CardApiError> {
  const context = error.context as { status?: unknown; json?: unknown } | undefined;
  if (context && typeof context === 'object' && typeof context.json === 'function' && typeof context.status === 'number') {
    let body: Record<string, unknown> | null = null;
    try {
      body = (await (context as unknown as Response).json()) as Record<string, unknown>;
    } catch {
      body = null;
    }
    const message = body && typeof body.error === 'string' ? body.error : error.message;
    const code = body && typeof body.code === 'string' ? body.code : 'http_error';
    const currentVersion = body && typeof body.currentVersion === 'number' ? body.currentVersion : null;
    return new CardApiError(context.status, code, message, currentVersion);
  }
  return new CardApiError(0, 'network_error', error.message || 'Network error');
}

export function isCardApiError(value: unknown): value is CardApiError {
  return value instanceof CardApiError;
}

// ── Response shapes ──────────────────────────────────────────────────────

export type CardStatus = 'generating' | 'ready' | 'failed';
/**
 * What the card can do for the family (the server's call): 'generating'
 * (artwork), 'film' (artwork done, the QR film still rendering: not editable
 * or orderable yet, `editorView` is null), 'ready', 'failed'. Null when the
 * server (an older backend) does not send it: callers fall back to `status`.
 */
export type CardReadiness = 'generating' | 'film' | 'ready' | 'failed';
export type FilmState = 'none' | 'rendering' | 'ready' | 'blocked' | 'failed';
export type QrState = 'on' | 'waiting_film' | 'off' | 'unavailable';

export interface CardRowView {
  id: string;
  familyId: string;
  year: number;
  status: CardStatus;
  lastFailureCode: string | null;
  language: CardLanguage;
  locale: string | null;
  greeting: CardGreetingKey;
  qrCaption: string | null;
  signature: string | null;
  edits: CardEdits;
  editsVersion: number;
  createdAt: string | null;
}

export interface EditorView {
  /** The card exactly as `src/card` builds documents from it (`frontOptions` = candidates + the saved front). */
  cardData: CardData;
  edits: CardEdits;
  /** `cardData` file name -> signed URL (about an hour). */
  assets: Record<string, string>;
  /** The saved front photo is gone: the shop forces a re-pick. */
  frontMissing: boolean;
  qrState: QrState;
  /** Ordered: the view is the frozen snapshot, read-only. */
  locked: boolean;
}

export interface MyOrderView {
  id: string;
  status: string;
  packs: number;
  cards: number;
  priceCents: number | null;
  createdAt: string | null;
}

export interface HolidayCardView {
  card: CardRowView;
  /** See `CardReadiness`; null from an older backend. */
  readiness: CardReadiness | null;
  film: { state: FilmState; filmId: string | null; readyAt: string | null };
  qrUrl: string | null;
  /** The film link was revoked: the card prints without a QR. */
  linkDisabled: boolean;
  hasOpenCheckout: boolean;
  isOrdered: boolean;
  generation: { state: CardStatus; failureCode: string | null; attempts: number };
  /** Null while generating (and for a view that failed to parse: see `editorViewInvalid`). */
  editorView: EditorView | null;
  editorViewInvalid: boolean;
  openCheckout: { orderId: string; mine: boolean } | null;
  myOrders: MyOrderView[];
  /** The checkout note about ordering in time (e.g. "Order by early December for Christmas delivery in the US."); null when none is set. */
  shipByNote: string | null;
}

// ── Parsing ──────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function bad(what: string): never {
  throw new CardApiError(0, 'bad_response', `Unexpected response (${what})`);
}

const QR_STATES: readonly QrState[] = ['on', 'waiting_film', 'off', 'unavailable'];
const FILM_STATES: readonly FilmState[] = ['none', 'rendering', 'ready', 'blocked', 'failed'];
const CARD_READINESS: readonly CardReadiness[] = ['generating', 'film', 'ready', 'failed'];
const CARD_STATUSES: readonly CardStatus[] = ['generating', 'ready', 'failed'];

function parseEditorView(raw: unknown): EditorView | null {
  if (!isObj(raw)) return null;
  let cardData: CardData;
  try {
    cardData = parseCardData(raw.cardData);
  } catch {
    return null;
  }
  const assets: Record<string, string> = {};
  if (isObj(raw.assets)) for (const [file, url] of Object.entries(raw.assets)) if (typeof url === 'string') assets[file] = url;
  // Unknown qrState degrades to the safest one for ordering: "waiting".
  const qrState = QR_STATES.includes(raw.qrState as QrState) ? (raw.qrState as QrState) : 'waiting_film';
  return {
    cardData,
    edits: normalizeEdits(raw.edits),
    assets,
    frontMissing: raw.frontMissing === true,
    qrState,
    locked: raw.locked === true,
  };
}

/** Parses + normalizes a `get` response; absent P2 fields get safe defaults. Throws a `CardApiError('bad_response')` on a malformed core. */
export function parseHolidayCard(raw: unknown): HolidayCardView {
  if (!isObj(raw) || !isObj(raw.card)) return bad('card');
  const c = raw.card;
  const id = str(c.id);
  const status = c.status as CardStatus;
  if (!id || !CARD_STATUSES.includes(status)) return bad('card id/status');
  const film = isObj(raw.film) ? raw.film : {};
  const filmState = FILM_STATES.includes(film.state as FilmState) ? (film.state as FilmState) : 'none';
  const generation = isObj(raw.generation) ? raw.generation : {};

  let editorView: EditorView | null = null;
  let editorViewInvalid = false;
  if (raw.editorView !== undefined && raw.editorView !== null) {
    editorView = parseEditorView(raw.editorView);
    editorViewInvalid = editorView === null;
  }

  const open = isObj(raw.openCheckout) && str(raw.openCheckout.orderId) ? raw.openCheckout : null;
  const myOrders: MyOrderView[] = [];
  if (Array.isArray(raw.myOrders)) {
    for (const o of raw.myOrders) {
      if (!isObj(o) || !str(o.id)) continue;
      myOrders.push({
        id: o.id as string,
        status: str(o.status) ?? 'unknown',
        packs: num(o.packs) ?? 0,
        cards: num(o.cards) ?? 0,
        priceCents: num(o.priceCents),
        createdAt: str(o.createdAt),
      });
    }
  }

  // Top level of the response; tolerate it on `card` too.
  const rawReadiness = raw.readiness ?? c.readiness;
  const readiness = CARD_READINESS.includes(rawReadiness as CardReadiness) ? (rawReadiness as CardReadiness) : null;

  return {
    readiness,
    card: {
      id,
      familyId: str(c.familyId) ?? '',
      year: num(c.year) ?? new Date().getFullYear(),
      status,
      lastFailureCode: str(c.lastFailureCode),
      language: c.language === 'en' ? 'en' : 'es',
      locale: str(c.locale),
      greeting: (str(c.greeting) as CardGreetingKey | null) ?? 'christmas',
      qrCaption: str(c.qrCaption),
      signature: str(c.signature),
      edits: normalizeEdits(c.edits),
      editsVersion: num(c.editsVersion) ?? 0,
      createdAt: str(c.createdAt),
    },
    film: { state: filmState, filmId: str(film.filmId), readyAt: str(film.readyAt) },
    qrUrl: str(raw.qrUrl),
    linkDisabled: raw.linkDisabled === true,
    hasOpenCheckout: raw.hasOpenCheckout === true || open !== null,
    isOrdered: raw.isOrdered === true,
    generation: {
      state: CARD_STATUSES.includes(generation.state as CardStatus) ? (generation.state as CardStatus) : status,
      failureCode: str(generation.failureCode) ?? str(c.lastFailureCode),
      attempts: num(generation.attempts) ?? 0,
    },
    editorView,
    editorViewInvalid,
    openCheckout: open ? { orderId: open.orderId as string, mine: open.mine === true } : null,
    myOrders,
    shipByNote: str(raw.shipByNote)?.trim() || null,
  };
}

// ── picker_pool / save_edits / film url ──────────────────────────────────

export interface PickerPoolRow {
  memoryId: string;
  mediaId: string;
  previewKey: string;
  date: string;
  aspectRatio: number | null;
}

export interface PickerPoolPage {
  items: PickerPoolRow[];
  nextCursor: string | null;
}

export function parsePickerPool(raw: unknown): PickerPoolPage {
  if (!isObj(raw) || !Array.isArray(raw.items)) return bad('picker_pool');
  const items: PickerPoolRow[] = [];
  for (const r of raw.items) {
    if (!isObj(r) || !str(r.mediaId) || !str(r.previewKey)) continue;
    const ar = num(r.aspectRatio);
    items.push({
      memoryId: str(r.memoryId) ?? '',
      mediaId: r.mediaId as string,
      previewKey: r.previewKey as string,
      date: str(r.date) ?? '',
      aspectRatio: ar !== null && ar > 0 ? ar : null,
    });
  }
  return { items, nextCursor: str(raw.nextCursor) };
}

export interface SaveEditsResult {
  editsVersion: number;
  edits: CardEdits;
}

export function parseSaveEdits(raw: unknown): SaveEditsResult {
  if (!isObj(raw) || num(raw.editsVersion) === null) return bad('save_edits');
  return { editsVersion: raw.editsVersion as number, edits: normalizeEdits(raw.edits) };
}

export interface FilmUrls {
  videoUrl: string;
  posterUrl: string | null;
  durationMs: number | null;
}

export function parseFilmUrls(raw: unknown): FilmUrls {
  if (!isObj(raw) || !str(raw.videoUrl)) return bad('film url');
  return { videoUrl: raw.videoUrl as string, posterUrl: str(raw.posterUrl), durationMs: num(raw.durationMs) };
}
