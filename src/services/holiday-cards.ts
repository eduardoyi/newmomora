// Holiday card client (docs/plans/holiday-cards-p2.md Step 6, feature doc
// docs/features/holiday-cards.md). The Keepsakes tile reads one summary row
// (`holiday_card_summary` RPC: server switch + the family's newest card) and
// creates the card through the `holiday-cards` Edge Function (`create`). The
// editor and checkout live on the shop (`shop.usemomora.com/c/<cardId>`),
// opened with `openShopUrl` (src/services/web-handoff.ts).
import { supabase } from '@/lib/supabase';
import { invokeEdgeFunction, type ServiceError } from '@/services/ai';

export type HolidayCardLanguage = 'es' | 'en';
export type HolidayCardStatus = 'generating' | 'ready' | 'failed';
/** What the card can do for the family: 'generating' (artwork), 'film' (artwork
 * done, the QR film is still rendering -- not editable/orderable yet), 'ready'
 * (editable + orderable), 'failed'. Null: no card, or an older backend that
 * does not send it (callers then fall back to `status`). */
export type HolidayCardReadiness = 'generating' | 'film' | 'ready' | 'failed';
/** The greeting is baked into the film, so it cannot change after create.
 * Mirrors `CardGreetingKey` in book-renderer/src/card/types.ts. */
export type HolidayCardGreeting = 'christmas' | 'holidays' | 'new-year';

export const HOLIDAY_CARD_GREETINGS: readonly HolidayCardGreeting[] = ['christmas', 'holidays', 'new-year'];

/** Mirrors book-renderer/src/card/greetings.ts (`GREETINGS`) exactly. */
export const HOLIDAY_CARD_GREETING_TEXT: Record<HolidayCardLanguage, Record<HolidayCardGreeting, string>> = {
  es: {
    christmas: 'Feliz Navidad',
    holidays: 'Felices fiestas',
    'new-year': 'Feliz Año Nuevo',
  },
  en: {
    christmas: 'Merry Christmas',
    holidays: 'Happy Holidays',
    'new-year': 'Happy New Year',
  },
};

export interface HolidayCardSummary {
  /** The server switch (rollout + billing); false hides the "make" entry. */
  enabled: boolean;
  /** The family's newest non-deleted card (any year), or null. */
  cardId: string | null;
  year: number | null;
  status: HolidayCardStatus | null;
  /** See `HolidayCardReadiness`. */
  readiness: HolidayCardReadiness | null;
  lastFailureCode: string | null;
  /** A paid order exists for the card (it is locked for the whole family). */
  ordered: boolean;
  /** The card's language (greetings are shown in it). */
  language: HolidayCardLanguage;
}

export const HOLIDAY_CARD_SHOP_BASE_URL = 'https://shop.usemomora.com/c';

export function holidayCardWebUrl(cardId: string): string {
  return `${HOLIDAY_CARD_SHOP_BASE_URL}/${cardId}`;
}

function toStatus(value: unknown): HolidayCardStatus | null {
  return value === 'generating' || value === 'ready' || value === 'failed' ? value : null;
}

function toReadiness(value: unknown): HolidayCardReadiness | null {
  return value === 'generating' || value === 'film' || value === 'ready' || value === 'failed' ? value : null;
}

/**
 * The summary row, or `null` data when the RPC returned no row (the caller is
 * not an owner/manager of a live family). The tile treats null as "hidden".
 */
export async function fetchHolidayCardSummary(
  familyId: string,
): Promise<{ data: HolidayCardSummary | null; error: ServiceError | null }> {
  const { data, error } = await supabase.rpc('holiday_card_summary', { p_family_id: familyId });
  if (error) return { data: null, error: { message: error.message, code: error.code } };

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { data: null, error: null };

  return {
    data: {
      enabled: row.enabled === true,
      cardId: row.card_id ?? null,
      year: typeof row.year === 'number' ? row.year : null,
      status: toStatus(row.status),
      readiness: toReadiness(row.readiness),
      lastFailureCode: row.last_failure_code ?? null,
      ordered: row.ordered === true,
      language: row.language === 'es' ? 'es' : 'en',
    },
    error: null,
  };
}

/** Typed failure codes `createHolidayCard` maps the Edge errors onto. */
export type CreateHolidayCardErrorCode =
  | 'disabled' // 403 HOLIDAY_CARDS_DISABLED
  | 'slot_used' // 409 holiday_card_slot_used
  | 'subscription_required' // 403 SUBSCRIPTION_REQUIRED
  | 'forbidden' // 403 forbidden (not an owner/manager)
  | 'network' // no HTTP response at all (offline, timeout)
  | 'unknown';

export interface CreateHolidayCardResult {
  cardId: string;
  /** False when the family's card for this year already existed (a retry or a race). */
  created: boolean;
  /** The device timezone is not in the US/Canada: warn, never block. */
  regionWarning: boolean;
}

export interface CreateHolidayCardFailure {
  code: CreateHolidayCardErrorCode;
  message: string;
}

export function mapCreateHolidayCardError(error: ServiceError): CreateHolidayCardFailure {
  const raw = (error.code ?? '').toLowerCase();
  if (raw === 'holiday_cards_disabled') return { code: 'disabled', message: error.message };
  if (raw === 'holiday_card_slot_used') return { code: 'slot_used', message: error.message };
  if (raw === 'subscription_required') return { code: 'subscription_required', message: error.message };
  if (raw === 'forbidden') return { code: 'forbidden', message: error.message };
  // `mapFunctionError` leaves `code` unset for a fetch/relay failure (no HTTP
  // response); an HTTP failure always carries a code (the body's or the status).
  if (!error.code) return { code: 'network', message: error.message };
  return { code: 'unknown', message: error.message };
}

function deviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

interface CreateHolidayCardResponse {
  success?: boolean;
  created?: boolean;
  card?: { id?: string } | null;
  regionWarning?: boolean;
}

export async function createHolidayCard(
  familyId: string,
  greeting: HolidayCardGreeting,
): Promise<{ data: CreateHolidayCardResult | null; error: CreateHolidayCardFailure | null }> {
  const { data, error } = await invokeEdgeFunction<CreateHolidayCardResponse>('holiday-cards', {
    op: 'create',
    familyId,
    greeting,
    timezone: deviceTimezone(),
  });
  if (error) return { data: null, error: mapCreateHolidayCardError(error) };

  const cardId = data?.card?.id;
  if (!data || data.success === false || typeof cardId !== 'string' || cardId.length === 0) {
    return { data: null, error: { code: 'unknown', message: 'Unexpected response' } };
  }
  return {
    data: { cardId, created: data.created !== false, regionWarning: data.regionWarning === true },
    error: null,
  };
}
