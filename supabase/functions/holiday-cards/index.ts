/**
 * Holiday Cards edge function (docs/plans/holiday-cards-p1.md Step 3). One JWT
 * function, six ops (`POST { op, ... }`), owners and managers only:
 *
 *   - `create`        one card per family per year; warns (`regionWarning`) when the
 *                     timezone is not US/CA but never blocks; dispatches the
 *                     generation Workflow once.
 *   - `get`           the card + derived film state + QR url + signed preview
 *                     URLs + `hasOpenCheckout`.
 *   - `picker_pool`   keys-only, cursor-paginated photo pool (Dec 1 of last year
 *                     -> today) for the front-photo picker.
 *   - `save_edits`    optimistic-concurrency save of the card's `CardEdits`
 *                     with server-side trust checks (media ownership, original
 *                     print resolution by ranged GET; client keys/urls ignored).
 *   - `delete`        soft delete (the year's slot stays used), ends the card's
 *                     film, deletes its R2 artifacts. Refused once ordered.
 *   - `disable_link`  OWNER only; revokes the card's public share token even
 *                     when ordered.
 *
 * Owner decisions 2026-10-06: US/CA only; no regenerate_letters / refresh_film
 * / set_greeting (the greeting is fixed at creation); the card film is
 * card-only; no illustrated front.
 *
 * Generation runs in the year-film worker (`POST /holiday-cards/generate`,
 * signed like schedule-year-films' `/dispatch`: `_shared/year-film-worker-dispatch.ts`).
 *
 * PII rule: only ids and stable codes reach a log line. Letters, names,
 * addresses, memory text and edit VALUES are never logged.
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { getAuthenticatedNonAnonymousUser } from '../_shared/auth.ts';
import { checkBillingFamilyWrite } from '../_shared/billing.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { getCallerFamilyRole, isManagerRole } from '../_shared/family-access.ts';
import { frontPoolStart, frontPrintFit } from '../_shared/holiday-card-photos.ts';
import { isFreshClaim, parsePrintFiles } from '../_shared/holiday-card-fulfillment.ts';
import { regionGuessForTimezone } from '../_shared/holiday-card-products.ts';
import {
  CARD_GREETING_KEYS,
  CARD_QR_BASE_URL,
  type CardEdits,
  type CardGreetingKey,
  normalizeCardEdits,
} from '../_shared/holiday-card-snapshot.ts';
import { addDaysToDateOnly } from '../_shared/memory-book-scope-window.ts';
import { createPresignedGetUrls, deleteObject } from '../_shared/r2.ts';
import { serveWithSentry } from '../_shared/sentry.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';
import { postSignedToYearFilmWorker } from '../_shared/year-film-worker-dispatch.ts';
import {
  SHARE_SENSITIVE_MILESTONES,
  SHARE_SENSITIVE_TEXT,
  SHARE_SENSITIVE_TOPICS,
} from '../_shared/year-film-script.ts';

// ── Contracts ────────────────────────────────────────────────────────────

export type HolidayCardsRequestBody =
  | { op: 'create'; familyId: string; greeting: CardGreetingKey; timezone?: string }
  | { op: 'get'; cardId: string }
  | { op: 'picker_pool'; cardId: string; cursor?: string | null; limit?: number }
  | { op: 'save_edits'; cardId: string; expectedVersion: number; edits: unknown }
  | { op: 'delete'; cardId: string }
  | { op: 'disable_link'; cardId: string; confirm: true };

export type FilmState = 'none' | 'rendering' | 'ready' | 'blocked' | 'failed';

export interface FrontCandidateView {
  mediaId: string;
  memoryId: string | null;
  rank: number | null;
  cardOrientation: 'portrait' | 'landscape' | null;
  printClass: 'full-bleed' | 'bordered' | null;
  width: number | null;
  height: number | null;
  /** Signed GET url of the candidate's preview (1 hour); null when it could not be signed. */
  previewUrl: string | null;
}

export interface CardView {
  id: string;
  familyId: string;
  year: number;
  status: 'generating' | 'ready' | 'failed';
  lastFailureCode: string | null;
  language: string;
  locale: string | null;
  greeting: CardGreetingKey;
  letters: unknown;
  qrCaption: string | null;
  signature: string | null;
  edits: CardEdits;
  editsVersion: number;
  generationAttempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface HolidayCardsDependencies {
  getAuthenticatedUser: typeof getAuthenticatedNonAnonymousUser;
  createServiceClient: typeof createServiceClient;
  getCallerFamilyRole: typeof getCallerFamilyRole;
  checkBillingFamilyWrite: typeof checkBillingFamilyWrite;
  createPresignedGetUrls: typeof createPresignedGetUrls;
  deleteObject: typeof deleteObject;
  /** Signed POST of `{ cardId, attemptId }` to the worker's `/holiday-cards/generate`; true = accepted (202, also a duplicate). */
  dispatchGeneration: (cardId: string, attemptId: string) => Promise<boolean>;
  /** Original pixel size (EXIF-corrected) of an R2 object by ranged GET; null when unreadable. */
  probeDimensions: (objectKey: string) => Promise<{ width: number; height: number } | null>;
  now: () => Date;
}

export const DEFAULT_DEPENDENCIES: HolidayCardsDependencies = {
  getAuthenticatedUser: getAuthenticatedNonAnonymousUser,
  createServiceClient,
  getCallerFamilyRole,
  checkBillingFamilyWrite,
  createPresignedGetUrls,
  deleteObject,
  dispatchGeneration: (cardId, attemptId) => postSignedToYearFilmWorker('/holiday-cards/generate', { cardId, attemptId }),
  probeDimensions: (objectKey) => probeDimensionsByRangedGet(objectKey),
  now: () => new Date(),
};

// ── Small helpers ────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEGACY_MEDIA_PREFIX = 'legacy:';
const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;
/** Generation attempts allowed per card (the first dispatch is attempt 1). */
export const GENERATION_ATTEMPT_CAP = 3;
export const PREVIEW_URL_TTL_SECONDS = 60 * 60;
const MAX_FRONT_CANDIDATES = 24;
/** What the print renderer can decode for the front (HEIC/HEIF originals cannot be printed). */
export const PRINTABLE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
function isPrintableContentType(contentType: unknown): boolean {
  return typeof contentType === 'string' && (PRINTABLE_CONTENT_TYPES as readonly string[]).includes(contentType.toLowerCase());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

interface DbError {
  code?: string;
  message?: string;
  hint?: string;
}

function asDbError(error: unknown): DbError {
  return isPlainObject(error) ? (error as DbError) : {};
}

function dbCode(error: unknown): string {
  return asDbError(error).code ?? 'unknown';
}

/** The stable reason of an RPC `raise ... using hint = '<reason>'`. */
function dbReason(error: unknown): string | null {
  const { hint, message } = asDbError(error);
  return hint ?? message ?? null;
}

// ── Timezone / region ────────────────────────────────────────────────────

export type RegionVerdict = 'us_ca' | 'unknown' | 'outside';

/**
 * Warn-only signal (the shipping address decides at quote time; families abroad
 * may send cards to a US address). `outside` is a real IANA zone that is not
 * US/Canada; anything missing, malformed, UTC-like or unrecognised is
 * `unknown`. Both make `create` return `regionWarning: true`; neither blocks.
 */
export function classifyTimezone(timezone: unknown): RegionVerdict {
  if (typeof timezone !== 'string') return 'unknown';
  const name = timezone.trim();
  if (!name || name.length > 64) return 'unknown';
  if (regionGuessForTimezone(name) === 'us_ca') return 'us_ca';
  if (/^(utc|gmt|uct|zulu|universal|etc\/.*)$/i.test(name)) return 'unknown';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
  } catch {
    return 'unknown';
  }
  return 'outside';
}

/** `YYYY-MM-DD` of `now` in `timezone` (UTC when the zone is missing/invalid). */
export function civilDate(now: Date, timezone: string | null): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone ?? 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** families.gallery_caption_language ("es-CO", "en-US", "en", ...) -> the card's language + locale. */
export function cardLanguageFor(captionLanguage: unknown): { language: 'en' | 'es'; locale: string } {
  const raw = typeof captionLanguage === 'string' ? captionLanguage.trim() : '';
  const language = raw.toLowerCase().startsWith('es') ? 'es' : 'en';
  const locale = /^[a-z]{2}(-[A-Za-z0-9]{2,8})?$/.test(raw) ? raw : language === 'es' ? 'es' : 'en-US';
  return { language, locale };
}

// ── Ranged-GET dimension probe (production default) ─────────────────────

const DIMENSION_PROBE_URL_EXPIRY_SECONDS = 300;

async function probeDimensionsByRangedGet(objectKey: string): Promise<{ width: number; height: number } | null> {
  const { probePhotoDimensions } = await import('../_shared/holiday-card-generate-front.ts');
  const { imageSize } = await import('npm:image-size@1.1.1');
  let url: string | undefined;
  try {
    url = (await createPresignedGetUrls([objectKey], DIMENSION_PROBE_URL_EXPIRY_SECONDS))[objectKey];
  } catch {
    return null;
  }
  if (!url) return null;
  const presigned = url;
  const readRange = async (_key: string, length: number): Promise<Uint8Array | null> => {
    const response = await fetch(presigned, { headers: { Range: `bytes=0-${length - 1}` } });
    // R2 honours Range (206); a 200 just means "not narrow".
    if (!response.ok && response.status !== 206) return null;
    return new Uint8Array(await response.arrayBuffer());
  };
  return await probePhotoDimensions(
    objectKey,
    { readRange, read: async () => null },
    imageSize,
  );
}

// ── Card loading / authorization ─────────────────────────────────────────

// Never `editor_facts` or the lease columns (workflow_instance_id, attempt_id,
// heartbeat_at) in what a client may see.
const CARD_COLUMNS =
  'id, family_id, year, status, language, locale, film_id, share_token, greeting, front_candidates, letters, ' +
  'qr_caption, signature, edits, edits_version, generation_attempts, last_failure_code, created_at, updated_at, deleted_at';

interface CardRow {
  id: string;
  family_id: string;
  year: number;
  status: 'generating' | 'ready' | 'failed';
  language: string;
  locale: string | null;
  film_id: string | null;
  share_token: string | null;
  greeting: CardGreetingKey;
  front_candidates: unknown;
  letters: unknown;
  qr_caption: string | null;
  signature: string | null;
  edits: unknown;
  edits_version: number;
  generation_attempts: number;
  last_failure_code: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

type LoadCardResult = { card: CardRow } | { response: Response };

/** Loads a card and authorizes the caller (owner/manager of its family). */
async function loadAuthorizedCard(
  dependencies: HolidayCardsDependencies,
  supabase: SupabaseClient,
  callerId: string,
  cardIdInput: unknown,
  options: { allowDeleted?: boolean; ownerOnly?: boolean } = {},
): Promise<LoadCardResult> {
  if (!isUuid(cardIdInput)) {
    return { response: errorResponse('cardId is invalid', 400, 'validation_error') };
  }
  const { data, error } = await supabase
    .from('holiday_cards')
    .select(CARD_COLUMNS)
    .eq('id', cardIdInput)
    .maybeSingle();
  if (error) {
    console.error('holiday-cards card lookup failed', dbCode(error));
    return { response: errorResponse('Failed to load card', 500, 'internal_error') };
  }
  const card = data as unknown as CardRow | null;
  if (!card || (card.deleted_at && !options.allowDeleted)) {
    return { response: errorResponse('Card not found', 404, 'card_not_found') };
  }
  const role = await dependencies.getCallerFamilyRole(supabase, card.family_id, callerId);
  if (options.ownerOnly ? role !== 'owner' : !isManagerRole(role)) {
    return { response: errorResponse('Not authorized for this card', 403, 'forbidden') };
  }
  return { card };
}

// ── Derived state ────────────────────────────────────────────────────────

interface FilmRow {
  status: string;
  blocked: boolean;
  ready_at: string | null;
}

/**
 * `none` (no film row, skipped below the floor, or ended), `rendering`,
 * `ready` (published; a later re-render keeps the published film), `blocked`
 * (content the family removed/reported: not served) or `failed` (never
 * published and the render gave up).
 */
export function deriveFilmState(film: FilmRow | null): FilmState {
  if (!film) return 'none';
  if (film.status === 'ended' || film.status === 'skipped') return 'none';
  if (film.blocked) return 'blocked';
  const published = film.ready_at !== null;
  if (film.status === 'ready') return 'ready';
  if (film.status === 'failed') return published ? 'ready' : 'failed';
  return published ? 'ready' : 'rendering';
}

export function cardQrUrl(token: string | null): string | null {
  return token ? `${CARD_QR_BASE_URL}/${token}` : null;
}

function toCardView(card: CardRow): CardView {
  return {
    id: card.id,
    familyId: card.family_id,
    year: card.year,
    status: card.status,
    lastFailureCode: card.last_failure_code,
    language: card.language,
    locale: card.locale,
    greeting: card.greeting,
    letters: card.letters,
    qrCaption: card.qr_caption,
    signature: card.signature,
    edits: normalizeCardEdits(card.edits),
    editsVersion: card.edits_version,
    generationAttempts: card.generation_attempts,
    createdAt: card.created_at,
    updatedAt: card.updated_at,
  };
}

/** The stored `front_candidates` (array, or `{ candidates: [...] }`) as safe views without URLs. */
export function readFrontCandidates(raw: unknown): Omit<FrontCandidateView, 'previewUrl'>[] {
  const list = Array.isArray(raw) ? raw : isPlainObject(raw) && Array.isArray(raw.candidates) ? raw.candidates : [];
  const out: Omit<FrontCandidateView, 'previewUrl'>[] = [];
  for (const item of list) {
    if (!isPlainObject(item) || typeof item.mediaId !== 'string') continue;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    out.push({
      mediaId: item.mediaId,
      memoryId: typeof item.memoryId === 'string' ? item.memoryId : null,
      rank: num(item.rank),
      cardOrientation: item.cardOrientation === 'portrait' || item.cardOrientation === 'landscape' ? item.cardOrientation : null,
      printClass: item.printClass === 'full-bleed' || item.printClass === 'bordered' ? item.printClass : null,
      width: num(item.width),
      height: num(item.height),
    });
    if (out.length >= MAX_FRONT_CANDIDATES) break;
  }
  return out;
}

// ── Family photo resolution (trust boundary for media ids) ──────────────

interface FamilyPhoto {
  id: string;
  originalKey: string;
  previewKey: string;
  isImage: boolean;
  /** jpeg / png / webp: can be the printed front. */
  isPrintable: boolean;
}

/**
 * Resolves media ids to photos of `familyId`. Ids that do not exist or belong
 * to another family are simply absent from the result (no oracle). An id is a
 * `memory_media.id`, or `legacy:<memoryId>` for a legacy single-asset memory
 * (the photo lives on `memories.media_key`).
 */
async function resolveFamilyPhotos(
  supabase: SupabaseClient,
  familyId: string,
  mediaIds: string[],
): Promise<Map<string, FamilyPhoto>> {
  const result = new Map<string, FamilyPhoto>();
  const mediaUuids = [...new Set(mediaIds.filter(isUuid))];
  const legacyMemoryIds = [
    ...new Set(
      mediaIds
        .filter((id) => id.startsWith(LEGACY_MEDIA_PREFIX))
        .map((id) => id.slice(LEGACY_MEDIA_PREFIX.length))
        .filter(isUuid),
    ),
  ];

  if (mediaUuids.length > 0) {
    const { data, error } = await supabase
      .from('memory_media')
      .select('id, object_key, preview_object_key, content_type, memories!inner(family_id)')
      .in('id', mediaUuids);
    if (error) throw new Error(`media_lookup_failed ${dbCode(error)}`);
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const memory = Array.isArray(row.memories) ? row.memories[0] : row.memories;
      if (!isPlainObject(memory) || memory.family_id !== familyId) continue;
      if (typeof row.id !== 'string' || typeof row.object_key !== 'string') continue;
      result.set(row.id, {
        id: row.id,
        originalKey: row.object_key,
        previewKey: typeof row.preview_object_key === 'string' ? row.preview_object_key : row.object_key,
        isImage: typeof row.content_type === 'string' && row.content_type.startsWith('image/'),
        isPrintable: isPrintableContentType(row.content_type),
      });
    }
  }

  if (legacyMemoryIds.length > 0) {
    const { data, error } = await supabase
      .from('memories')
      .select('id, media_key, media_content_type')
      .eq('family_id', familyId)
      .in('id', legacyMemoryIds);
    if (error) throw new Error(`media_lookup_failed ${dbCode(error)}`);
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      if (typeof row.id !== 'string' || typeof row.media_key !== 'string') continue;
      result.set(`${LEGACY_MEDIA_PREFIX}${row.id}`, {
        id: `${LEGACY_MEDIA_PREFIX}${row.id}`,
        originalKey: row.media_key,
        previewKey: row.media_key,
        isImage: typeof row.media_content_type === 'string' && row.media_content_type.startsWith('image/'),
        isPrintable: isPrintableContentType(row.media_content_type),
      });
    }
  }
  return result;
}

async function presignPreviews(
  dependencies: HolidayCardsDependencies,
  keys: string[],
): Promise<Record<string, string>> {
  if (keys.length === 0) return {};
  try {
    return await dependencies.createPresignedGetUrls([...new Set(keys)], PREVIEW_URL_TTL_SECONDS);
  } catch {
    console.error('holiday-cards preview presign failed');
    return {};
  }
}

// ── create ───────────────────────────────────────────────────────────────

const LEASE_FRESH_MS = 20 * 60 * 1000;

async function handleCreate(
  dependencies: HolidayCardsDependencies,
  supabase: SupabaseClient,
  callerId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const { familyId, greeting, timezone } = body;
  if (!isUuid(familyId)) return errorResponse('familyId is invalid', 400, 'validation_error');
  if (typeof greeting !== 'string' || !(CARD_GREETING_KEYS as readonly string[]).includes(greeting)) {
    return errorResponse(`greeting must be one of ${CARD_GREETING_KEYS.join(', ')}`, 400, 'validation_error');
  }
  if (timezone !== undefined && timezone !== null && typeof timezone !== 'string') {
    return errorResponse('timezone must be a string', 400, 'validation_error');
  }

  const role = await dependencies.getCallerFamilyRole(supabase, familyId, callerId);
  if (!isManagerRole(role)) return errorResponse('Not authorized to make a card for this family', 403, 'forbidden');

  const billingResponse = await dependencies.checkBillingFamilyWrite(supabase, familyId, callerId, 'holiday_card_create');
  if (billingResponse) return billingResponse;

  // The device timezone (body) wins; otherwise the one the account stores.
  let zone: string | null = typeof timezone === 'string' && timezone.trim() ? timezone.trim() : null;
  if (!zone) {
    const { data: profile } = await supabase.from('user_profiles').select('timezone').eq('id', callerId).maybeSingle();
    const stored = (profile as { timezone?: unknown } | null)?.timezone;
    zone = typeof stored === 'string' && stored.trim() ? stored.trim() : null;
  }
  const verdict = classifyTimezone(zone);
  const now = dependencies.now();
  const year = Number(civilDate(now, verdict === 'unknown' ? null : zone).slice(0, 4));

  // An existing card (a double tap, a reopened app) is returned as is: the
  // region guess only gates creating a NEW card.
  const { data: existing, error: existingError } = await supabase
    .from('holiday_cards')
    .select('id, deleted_at')
    .eq('family_id', familyId)
    .eq('year', year)
    .maybeSingle();
  if (existingError) {
    console.error('holiday-cards create lookup failed', dbCode(existingError));
    return errorResponse('Failed to create card', 500, 'internal_error');
  }
  const { data: family } = await supabase.from('families').select('gallery_caption_language').eq('id', familyId).maybeSingle();
  const { language, locale } = cardLanguageFor((family as { gallery_caption_language?: unknown } | null)?.gallery_caption_language);

  const { data: created, error: createError } = await supabase.rpc('create_holiday_card', {
    p_family_id: familyId,
    p_user_id: callerId,
    p_year: year,
    p_greeting: greeting,
    p_language: language,
    p_locale: locale,
  });
  if (createError) {
    const code = dbCode(createError);
    if (code === '42501') return errorResponse('Not authorized to make a card for this family', 403, 'forbidden');
    if (code === '23505' && dbReason(createError)?.includes('holiday_card_slot_used')) {
      return errorResponse('This family already made (and deleted) its card for this year', 409, 'holiday_card_slot_used');
    }
    console.error('holiday-cards create failed', code);
    return errorResponse('Failed to create card', 500, 'internal_error');
  }
  const rpcCard = (Array.isArray(created) ? created[0] : created) as { id?: string } | null;
  if (!rpcCard?.id) {
    console.error('holiday-cards create returned no card');
    return errorResponse('Failed to create card', 500, 'internal_error');
  }

  // Re-read the safe columns (the RPC returns the whole row, lease included)
  // plus the lease heartbeat for the dispatch decision.
  const { data: row, error: rowError } = await supabase
    .from('holiday_cards')
    .select(`${CARD_COLUMNS}, heartbeat_at`)
    .eq('id', rpcCard.id)
    .maybeSingle();
  if (rowError || !row) {
    console.error('holiday-cards create reload failed', dbCode(rowError));
    return errorResponse('Failed to create card', 500, 'internal_error');
  }
  const card = row as unknown as CardRow & { heartbeat_at: string | null };

  const leaseLive = card.heartbeat_at !== null && now.getTime() - Date.parse(card.heartbeat_at) < LEASE_FRESH_MS;
  let dispatched = false;
  let attemptsNow = card.generation_attempts;
  // Only a card that never dispatched is dispatched here: a double tap, a
  // reopened app or a retry returns the same card without a second dispatch.
  // Re-dispatch of stuck generations belongs to the sweep. The atomic counter
  // is the guard against concurrent taps: only the caller that moved it 0 -> 1
  // dispatches.
  if (card.status === 'generating' && !leaseLive && card.generation_attempts === 0) {
    const { data: attempt, error: attemptError } = await supabase.rpc('increment_holiday_card_generation_attempt', {
      p_card_id: card.id,
      p_cap: GENERATION_ATTEMPT_CAP,
    });
    if (attemptError) {
      console.error('holiday-cards attempt claim failed', card.id, dbCode(attemptError));
    } else if (attempt === 1) {
      attemptsNow = 1;
      try {
        dispatched = await dependencies.dispatchGeneration(card.id, crypto.randomUUID());
      } catch {
        dispatched = false;
      }
      if (!dispatched) console.error('holiday-cards generation dispatch failed', card.id);
    }
  }

  const current = { ...card, generation_attempts: attemptsNow };
  return jsonResponse(
    {
      success: true,
      created: !existing,
      card: toCardView(current),
      generation: generationState(current, dispatched),
      regionWarning: verdict !== 'us_ca',
    },
    existing ? 200 : 201,
  );
}

function generationState(card: Pick<CardRow, 'status' | 'last_failure_code' | 'generation_attempts'>, dispatched?: boolean) {
  return {
    state: card.status,
    failureCode: card.last_failure_code,
    attempts: card.generation_attempts,
    ...(dispatched === undefined ? {} : { dispatched }),
  };
}

// ── get ──────────────────────────────────────────────────────────────────

const OPEN_ORDER_STATUSES = ['checkout'];
const ORDERED_STATUSES = ['paid', 'submitted', 'in_production', 'shipped'];

async function handleGet(
  dependencies: HolidayCardsDependencies,
  supabase: SupabaseClient,
  card: CardRow,
): Promise<Response> {
  let film: FilmRow | null = null;
  if (card.film_id) {
    const { data, error } = await supabase
      .from('year_films')
      .select('status, blocked, ready_at')
      .eq('id', card.film_id)
      .maybeSingle();
    if (error) {
      console.error('holiday-cards film lookup failed', dbCode(error));
      return errorResponse('Failed to load card', 500, 'internal_error');
    }
    film = data as FilmRow | null;
  }
  const filmState = deriveFilmState(film);

  let linkRevoked = false;
  if (card.share_token) {
    const { data, error } = await supabase
      .from('film_share_tokens')
      .select('revoked_at')
      .eq('token', card.share_token)
      .maybeSingle();
    if (error) {
      console.error('holiday-cards token lookup failed', dbCode(error));
      return errorResponse('Failed to load card', 500, 'internal_error');
    }
    linkRevoked = (data as { revoked_at?: string | null } | null)?.revoked_at != null;
  }

  // Orders are buyer-only under RLS; the card's open-checkout flag is computed
  // here with the service client so every manager sees it.
  const { data: orders, error: ordersError } = await supabase
    .from('holiday_card_orders')
    .select('id, status')
    .eq('card_id', card.id);
  if (ordersError) {
    console.error('holiday-cards orders lookup failed', dbCode(ordersError));
    return errorResponse('Failed to load card', 500, 'internal_error');
  }
  const statuses = ((orders ?? []) as Array<{ status: string }>).map((o) => o.status);
  const hasOpenCheckout = statuses.some((s) => OPEN_ORDER_STATUSES.includes(s));
  const isOrdered = statuses.some((s) => ORDERED_STATUSES.includes(s));

  // Signed previews: the front candidates plus the currently chosen front.
  const candidates = readFrontCandidates(card.front_candidates);
  const edits = normalizeCardEdits(card.edits);
  const wanted = [...new Set([...candidates.map((c) => c.mediaId), ...(edits.frontImage ? [edits.frontImage] : [])])];
  let previewByMedia = new Map<string, string>();
  let printableIds: Set<string> | null = null;
  try {
    const photos = await resolveFamilyPhotos(supabase, card.family_id, wanted);
    // Legacy ids, other families' media and HEIC/video originals cannot be the printed front.
    printableIds = new Set([...photos.values()].filter((p) => p.isPrintable && !p.id.startsWith(LEGACY_MEDIA_PREFIX)).map((p) => p.id));
    const signed = await presignPreviews(dependencies, [...photos.values()].map((p) => p.previewKey));
    previewByMedia = new Map(
      [...photos.values()].filter((p) => signed[p.previewKey]).map((p) => [p.id, signed[p.previewKey]]),
    );
  } catch (error) {
    console.error('holiday-cards preview lookup failed', error instanceof Error ? error.message : 'unknown');
  }

  const published = filmState === 'ready';
  return jsonResponse({
    card: toCardView(card),
    film: { state: filmState, filmId: card.film_id, readyAt: film?.ready_at ?? null },
    qrUrl: published && !linkRevoked ? cardQrUrl(card.share_token) : null,
    linkDisabled: linkRevoked,
    frontCandidates: candidates.filter((c) => printableIds === null || printableIds.has(c.mediaId)).map((c) => ({ ...c, previewUrl: previewByMedia.get(c.mediaId) ?? null })),
    frontImage: edits.frontImage
      ? { mediaId: edits.frontImage, previewUrl: previewByMedia.get(edits.frontImage) ?? null }
      : null,
    hasOpenCheckout,
    isOrdered,
    generation: generationState(card),
  });
}

// ── picker_pool ──────────────────────────────────────────────────────────

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 50;

function encodeCursor(offset: number): string {
  return btoa(String(offset));
}

function decodeCursor(cursor: string): number | null {
  try {
    const decoded = atob(cursor);
    if (!/^\d+$/.test(decoded)) return null;
    const value = Number(decoded);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

export interface PickerPoolItem {
  memoryId: string;
  mediaId: string;
  previewKey: string;
  date: string;
  aspectRatio: number | null;
}

async function handlePickerPool(
  dependencies: HolidayCardsDependencies,
  supabase: SupabaseClient,
  card: CardRow,
  cursorInput: unknown,
  limitInput: unknown,
): Promise<Response> {
  const limit = typeof limitInput === 'number' && Number.isInteger(limitInput) && limitInput > 0
    ? Math.min(limitInput, MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE;
  let offset = 0;
  if (typeof cursorInput === 'string' && cursorInput.length > 0) {
    const decoded = decodeCursor(cursorInput);
    if (decoded === null) return errorResponse('Invalid cursor', 400, 'validation_error');
    offset = decoded;
  }

  // Dec 1 of the previous year -> today (UTC today + 1 day so a parent east of
  // UTC still sees today's photos). Same window start as the front pick.
  const start = frontPoolStart(`${card.year}-12-31`);
  const endExclusive = addDaysToDateOnly(dependencies.now().toISOString().slice(0, 10), 2);

  const { data: rows, error } = await supabase
    .from('memory_media')
    .select(
      'id, memory_id, preview_object_key, object_key, aspect_ratio, content_type, ' +
        'memories!inner(memory_date, family_id, user_id, topics, content, onboarding_media_pending)',
    )
    .eq('memories.family_id', card.family_id)
    .gte('memories.memory_date', start)
    .lt('memories.memory_date', endExclusive)
    .in('content_type', [...PRINTABLE_CONTENT_TYPES])
    .order('memories(memory_date)', { ascending: true })
    .order('id', { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) {
    console.error('holiday-cards picker_pool query failed', dbCode(error));
    return errorResponse('Failed to load photo pool', 500, 'internal_error');
  }
  const typedRows = (rows ?? []) as unknown as Array<Record<string, unknown>>;
  const memoryIds = [...new Set(typedRows.map((r) => r.memory_id).filter((id): id is string => typeof id === 'string'))];

  // The same share-safety the card front applies, so the picker never offers a
  // photo the pipeline itself would refuse: open content reports, bath /
  // doctor / tough-day topics, the sensitive-text pattern, sensitive
  // milestones, parent-blocked authors and onboarding-pending memories.
  const reported = new Set<string>();
  const sensitiveMilestoneMemories = new Set<string>();
  let blockedAuthors = new Set<string>();
  if (memoryIds.length > 0) {
    const [reports, milestones, blocked] = await Promise.all([
      supabase
        .from('content_reports')
        .select('target_id')
        .eq('family_id', card.family_id)
        .eq('target_type', 'memory')
        .in('status', ['open', 'reviewing'])
        .in('target_id', memoryIds),
      supabase
        .from('memory_milestones')
        .select('memory_id, milestone_id, status')
        .in('memory_id', memoryIds),
      supabase.rpc('year_film_parent_blocked_users', { p_family_id: card.family_id }),
    ]);
    if (reports.error || milestones.error || blocked.error) {
      console.error('holiday-cards picker_pool safety lookup failed', card.id);
      return errorResponse('Failed to load photo pool', 500, 'internal_error');
    }
    for (const r of (reports.data ?? []) as Array<{ target_id: string }>) reported.add(r.target_id);
    for (const m of (milestones.data ?? []) as Array<{ memory_id: string; milestone_id: string; status: string }>) {
      if (m.status !== 'dismissed' && SHARE_SENSITIVE_MILESTONES.has(m.milestone_id)) sensitiveMilestoneMemories.add(m.memory_id);
    }
    blockedAuthors = new Set(Array.isArray(blocked.data) ? (blocked.data as string[]) : []);
  }

  const items: PickerPoolItem[] = [];
  for (const row of typedRows) {
    const memory = Array.isArray(row.memories) ? row.memories[0] : row.memories;
    if (!isPlainObject(memory)) continue;
    const memoryId = row.memory_id as string;
    const topics = Array.isArray(memory.topics) ? (memory.topics as unknown[]).filter((t): t is string => typeof t === 'string') : [];
    if (memory.onboarding_media_pending === true) continue;
    if (typeof memory.user_id === 'string' && blockedAuthors.has(memory.user_id)) continue;
    if (reported.has(memoryId) || sensitiveMilestoneMemories.has(memoryId)) continue;
    if (topics.some((t) => SHARE_SENSITIVE_TOPICS.has(t))) continue;
    if (typeof memory.content === 'string' && SHARE_SENSITIVE_TEXT.test(memory.content)) continue;
    items.push({
      memoryId,
      mediaId: row.id as string,
      previewKey: (row.preview_object_key as string | null) ?? (row.object_key as string),
      date: typeof memory.memory_date === 'string' ? memory.memory_date : '',
      aspectRatio: typeof row.aspect_ratio === 'number' ? row.aspect_ratio : null,
    });
  }

  // The cursor follows the RAW page (offset pagination, like the book's
  // picker), so a page can come back with fewer items than `limit`, or none,
  // while `nextCursor` is still set.
  const nextCursor = typedRows.length === limit ? encodeCursor(offset + limit) : null;
  return jsonResponse({ items, nextCursor });
}

// ── save_edits ───────────────────────────────────────────────────────────

const MAX_EDITS_JSON_CHARS = 64 * 1024;
const MAX_TEXT_CHARS = 500;
const MAX_LETTER_CHARS = 3000;
const MAX_FOCAL_POINTS = 40;
const LETTER_KEY = /^[A-Za-z0-9_-]{1,32}$/;

type EditsCheck = { edits: CardEdits } | { response: Response };

/** Shape/length checks on the NORMALIZED edits (the normalizer already drops anything it does not know). */
function validateNormalizedEdits(edits: CardEdits): Response | null {
  for (const value of Object.values(edits.text)) {
    if (typeof value !== 'string' || value.length > MAX_TEXT_CHARS || CONTROL_CHAR_PATTERN.test(value)) {
      return errorResponse('A text edit is too long or contains control characters', 400, 'invalid_edits');
    }
  }
  for (const [key, value] of Object.entries(edits.letters)) {
    if (!LETTER_KEY.test(key) || value.length > MAX_LETTER_CHARS || CONTROL_CHAR_PATTERN.test(value)) {
      return errorResponse('A letter edit is invalid or too long', 400, 'invalid_edits');
    }
  }
  if (edits.choices.tone.length > 32 || CONTROL_CHAR_PATTERN.test(edits.choices.tone)) {
    return errorResponse('choices.tone is invalid', 400, 'invalid_edits');
  }
  if (Object.keys(edits.focalPoints).length > MAX_FOCAL_POINTS) {
    return errorResponse('Too many focal points', 400, 'invalid_edits');
  }
  return null;
}

async function checkEditMedia(
  dependencies: HolidayCardsDependencies,
  supabase: SupabaseClient,
  card: CardRow,
  edits: CardEdits,
): Promise<Response | null> {
  const ids = [...new Set([...(edits.frontImage ? [edits.frontImage] : []), ...Object.keys(edits.focalPoints)])];
  if (ids.length === 0) return null;
  // The order loader cannot print a legacy single-asset id.
  if (edits.frontImage?.startsWith(LEGACY_MEDIA_PREFIX)) {
    return errorResponse('That photo cannot be printed', 400, 'MEDIA_NOT_PRINTABLE');
  }
  for (const id of ids) {
    if (!UUID.test(id) && !(id.startsWith(LEGACY_MEDIA_PREFIX) && UUID.test(id.slice(LEGACY_MEDIA_PREFIX.length)))) {
      return errorResponse('Invalid media id in edits', 400, 'invalid_edits');
    }
  }

  let photos: Map<string, FamilyPhoto>;
  try {
    photos = await resolveFamilyPhotos(supabase, card.family_id, ids);
  } catch (error) {
    console.error('holiday-cards save_edits media lookup failed', error instanceof Error ? error.message : 'unknown');
    return errorResponse('Failed to resolve media', 500, 'internal_error');
  }
  for (const id of ids) {
    const photo = photos.get(id);
    // Same answer whether the id is unknown or another family's.
    if (!photo) return errorResponse('Media not found', 404, 'MEDIA_NOT_FOUND');
    if (id === edits.frontImage) {
      if (!photo.isPrintable) {
        return errorResponse('That photo cannot be printed (use a JPEG, PNG or WebP photo)', 400, 'MEDIA_NOT_PRINTABLE');
      }
    } else if (!photo.isImage) {
      return errorResponse('Only photos can be used on a card', 400, 'MEDIA_NOT_PHOTO');
    }
  }

  // The chosen front must be printable. Re-measured only when it CHANGES and is
  // not one of the already-probed candidates (every other save skips this).
  const front = edits.frontImage;
  if (front && front !== normalizeCardEdits(card.edits).frontImage) {
    const known = readFrontCandidates(card.front_candidates).find((c) => c.mediaId === front);
    let size: { width: number; height: number } | null =
      known && known.width && known.height ? { width: known.width, height: known.height } : null;
    if (!size) size = await dependencies.probeDimensions(photos.get(front)!.originalKey);
    if (!size) return errorResponse('That photo could not be read', 422, 'front_unreadable');
    if (frontPrintFit(size).printClass === 'low') {
      return errorResponse('That photo is too small to print well on a card', 422, 'front_low_resolution');
    }
  }
  return null;
}

async function prepareEdits(
  dependencies: HolidayCardsDependencies,
  supabase: SupabaseClient,
  card: CardRow,
  editsInput: unknown,
): Promise<EditsCheck> {
  if (!isPlainObject(editsInput)) {
    return { response: errorResponse('edits must be an object', 400, 'validation_error') };
  }
  if (JSON.stringify(editsInput).length > MAX_EDITS_JSON_CHARS) {
    return { response: errorResponse('edits is too large', 400, 'invalid_edits') };
  }
  const edits = normalizeCardEdits(editsInput);
  // The card row is the single source of the greeting (fixed at creation).
  delete edits.choices.greeting;
  const invalid = validateNormalizedEdits(edits);
  if (invalid) return { response: invalid };
  const mediaProblem = await checkEditMedia(dependencies, supabase, card, edits);
  if (mediaProblem) return { response: mediaProblem };
  return { edits };
}

async function handleSaveEdits(
  dependencies: HolidayCardsDependencies,
  supabase: SupabaseClient,
  callerId: string,
  card: CardRow,
  body: Record<string, unknown>,
): Promise<Response> {
  const { expectedVersion } = body;
  if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion) || expectedVersion < 0) {
    return errorResponse('expectedVersion must be a non-negative integer', 400, 'validation_error');
  }

  const billingResponse = await dependencies.checkBillingFamilyWrite(supabase, card.family_id, callerId, 'holiday_card_edit');
  if (billingResponse) return billingResponse;

  const prepared = await prepareEdits(dependencies, supabase, card, body.edits);
  if ('response' in prepared) return prepared.response;

  const { data: newVersion, error } = await supabase.rpc('save_holiday_card_edits', {
    p_card_id: card.id,
    p_expected_version: expectedVersion,
    p_edits: prepared.edits,
  });
  if (error) {
    const code = dbCode(error);
    if (code === '40001') {
      const { data: current } = await supabase.from('holiday_cards').select('edits_version').eq('id', card.id).maybeSingle();
      const currentVersion = (current as { edits_version?: number } | null)?.edits_version ?? null;
      return jsonResponse(
        { error: 'The card changed since you loaded it', code: 'edits_version_mismatch', currentVersion },
        409,
      );
    }
    if (code === '55000') return errorResponse('A checkout is open for this card', 423, 'holiday_card_checkout_open');
    if (code === '22023') return errorResponse('Invalid edits', 400, 'invalid_edits');
    if (code === 'P0002') return errorResponse('Card not found', 404, 'card_not_found');
    console.error('holiday-cards save_edits failed', card.id, code);
    return errorResponse('Failed to save edits', 500, 'internal_error');
  }
  return jsonResponse({ success: true, editsVersion: newVersion, edits: prepared.edits });
}

// ── delete ───────────────────────────────────────────────────────────────

async function handleDelete(
  dependencies: HolidayCardsDependencies,
  supabase: SupabaseClient,
  card: CardRow,
): Promise<Response> {
  const { data: orders, error: ordersError } = await supabase
    .from('holiday_card_orders')
    .select('id, status, print_files')
    .eq('card_id', card.id);
  if (ordersError) {
    console.error('holiday-cards delete orders lookup failed', dbCode(ordersError));
    return errorResponse('Failed to delete card', 500, 'internal_error');
  }
  const orderRows = (orders ?? []) as Array<{ status: string; print_files?: unknown }>;
  const statuses = orderRows.map((o) => o.status);
  // The QR is on paper once an order is paid: only disable_link can turn it off.
  if (statuses.some((s) => ORDERED_STATUSES.includes(s))) {
    return errorResponse('This card has been ordered and cannot be deleted', 409, 'card_ordered');
  }
  // A payment may complete at any moment while a Checkout session is open.
  // A quoted order whose create_checkout is running right now (a fresh
  // `print_files.claim`, written by holiday-card-orders) is about to open a
  // Checkout session: treat it as open. Same shape + TTL as that function.
  const nowMs = dependencies.now().getTime();
  const checkoutRunning = orderRows.some((o) => o.status === 'quoted' && isFreshClaim(parsePrintFiles(o.print_files), nowMs));
  if (checkoutRunning || statuses.some((s) => OPEN_ORDER_STATUSES.includes(s))) {
    return errorResponse('A checkout is open for this card', 423, 'holiday_card_checkout_open');
  }

  // Soft delete first: it stops a running generation from creating the film
  // (create_holiday_card_film refuses a deleted card) and hides the card. The
  // (family, year) slot stays used. Idempotent: a retry after a partial failure
  // runs the film end again.
  if (!card.deleted_at) {
    const { error: deleteError } = await supabase
      .from('holiday_cards')
      .update({ deleted_at: dependencies.now().toISOString() })
      .eq('id', card.id)
      .is('deleted_at', null);
    if (deleteError) {
      console.error('holiday-cards delete failed', card.id, dbCode(deleteError));
      return errorResponse('Failed to delete card', 500, 'internal_error');
    }
  }

  const { data: ended, error: endError } = await supabase.rpc('end_holiday_card_film', { p_card_id: card.id });
  if (endError) {
    console.error('holiday-cards end film failed', card.id, dbCode(endError));
    return errorResponse('The card was deleted but its film could not be ended; retry delete', 500, 'film_end_failed');
  }

  const result = isPlainObject(ended) ? ended : {};
  // Defense in depth: delete only keys under THIS card's film directory,
  // whatever the RPC returned.
  const filmId = typeof result.film_id === 'string' ? result.film_id : null;
  const rawKeys = Array.isArray(result.delete_keys) ? result.delete_keys : [];
  const keys = filmId !== null && filmId === card.film_id
    ? rawKeys.filter((key): key is string => typeof key === 'string' && key.includes(`/year-films/${filmId}/`))
    : [];
  const settled = await Promise.allSettled(keys.map((key) => dependencies.deleteObject(key)));
  const failed = settled.filter((r) => r.status === 'rejected').length;
  if (failed > 0) console.error('holiday-cards film artifact delete failed', card.id, failed);

  return jsonResponse({ success: true, deleted: true, filmEnded: result.ended === true });
}

// ── disable_link ─────────────────────────────────────────────────────────

async function handleDisableLink(
  supabase: SupabaseClient,
  card: CardRow,
  body: Record<string, unknown>,
): Promise<Response> {
  if (body.confirm !== true) {
    return errorResponse('confirm must be true to disable the public link', 400, 'confirmation_required');
  }
  if (!card.film_id) return jsonResponse({ success: true, revoked: false, reason: 'no_link' });

  const { data, error } = await supabase
    .from('film_share_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('film_id', card.film_id)
    .is('revoked_at', null)
    .select('token');
  if (error) {
    console.error('holiday-cards disable_link failed', card.id, dbCode(error));
    return errorResponse('Failed to disable the link', 500, 'internal_error');
  }
  const revoked = Array.isArray(data) ? data.length : 0;
  return jsonResponse({ success: true, revoked: revoked > 0, reason: revoked > 0 ? null : 'already_disabled' });
}

// ── Entry point ──────────────────────────────────────────────────────────

const OPS = new Set(['create', 'get', 'picker_pool', 'save_edits', 'delete', 'disable_link']);

export async function handleHolidayCards(
  req: Request,
  dependencyOverrides: Partial<HolidayCardsDependencies> = {},
): Promise<Response> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, 'method_not_allowed');

  const user = await dependencies.getAuthenticatedUser(req);
  if (!user) return errorResponse('Unauthorized', 401, 'unauthorized');

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, 'invalid_json');
  }
  if (!isPlainObject(body) || typeof body.op !== 'string' || !OPS.has(body.op)) {
    return errorResponse(`op must be one of ${[...OPS].join(', ')}`, 400, 'validation_error');
  }

  const supabase = dependencies.createServiceClient();
  try {
    if (body.op === 'create') return await handleCreate(dependencies, supabase, user.id, body);

    const loaded = await loadAuthorizedCard(dependencies, supabase, user.id, body.cardId, {
      allowDeleted: body.op === 'delete',
      ownerOnly: body.op === 'disable_link',
    });
    if ('response' in loaded) return loaded.response;
    const { card } = loaded;

    switch (body.op) {
      case 'get':
        return await handleGet(dependencies, supabase, card);
      case 'picker_pool':
        return await handlePickerPool(dependencies, supabase, card, body.cursor, body.limit);
      case 'save_edits':
        return await handleSaveEdits(dependencies, supabase, user.id, card, body);
      case 'delete':
        return await handleDelete(dependencies, supabase, card);
      default:
        return await handleDisableLink(supabase, card, body);
    }
  } catch (error) {
    console.error('holiday-cards failed', error instanceof Error ? error.name : 'unknown');
    return errorResponse('Internal error', 500, 'internal_error');
  }
}

if (import.meta.main) {
  serveWithSentry('holiday-cards', (request) => handleHolidayCards(request));
}
