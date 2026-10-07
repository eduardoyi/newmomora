// Keepsakes tab overview (docs/plans/keepsakes-redesign.md B1). One RPC
// (`keepsakes_overview`, SQL in supabase/migrations/20261009120000_*) returns
// everything the redesigned tab needs beyond the films/books/card queries:
// the upcoming-recap progress, the family's preview pictures, the viewer
// flag, the holiday-card eligibility numbers and the order statuses. Fields
// that are owner/manager-only come back null / [] for viewers.
import { supabase } from '@/lib/supabase';

/** The next monthly recap, with its progress toward the film floors. */
export interface KeepsakesRecap {
  /** Owner-local first day of the month being collected (`YYYY-MM-DD`). */
  month_start: string;
  /** Owner-local day the film is due (the next 1st). */
  delivers_on: string;
  moments: number;
  visuals: number;
  min_moments: number;
  min_visuals: number;
  /** Storage key of the newest moment's picture this month, or null. */
  picture_key: string | null;
}

export type KeepsakesOrderProduct = 'book' | 'card';

/** One item's latest paid-or-later order. Status only; never address or price. */
export interface KeepsakesOrder {
  product: KeepsakesOrderProduct;
  /** `memory_books.id` for a book, `holiday_cards.id` for a card. */
  item_id: string;
  status: string;
  shipped_at: string | null;
}

export interface KeepsakesOverview {
  recap: KeepsakesRecap | null;
  /** Owner/manager only (null for viewers): does the family have a viewer member. */
  has_viewers: boolean | null;
  year_moments: number | null;
  holiday_pool: number | null;
  holiday_min_pool: number | null;
  holiday_ship_by_note: string | null;
  /** Newest picture key across the family (storefront card + card page). */
  preview_key: string | null;
  /** Newest picture key per child (`family_member_id` -> key). Always an object. */
  book_preview_keys: Record<string, string>;
  /** Always an array; empty for viewers. */
  orders: KeepsakesOrder[];
}

const DEFAULT_MIN_MOMENTS = 10;
const DEFAULT_MIN_VISUALS = 6;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function toDateString(value: unknown): string | null {
  return typeof value === 'string' && DATE_RE.test(value) ? value : null;
}

function parseRecap(raw: unknown): KeepsakesRecap | null {
  if (!isRecord(raw)) return null;
  const monthStart = toDateString(raw.month_start);
  const deliversOn = toDateString(raw.delivers_on);
  // Without both owner-local dates the tile cannot place or label itself.
  if (!monthStart || !deliversOn) return null;
  return {
    month_start: monthStart,
    delivers_on: deliversOn,
    moments: Math.max(0, toCount(raw.moments) ?? 0),
    visuals: Math.max(0, toCount(raw.visuals) ?? 0),
    min_moments: toCount(raw.min_moments) ?? DEFAULT_MIN_MOMENTS,
    min_visuals: toCount(raw.min_visuals) ?? DEFAULT_MIN_VISUALS,
    picture_key: toNonEmptyString(raw.picture_key),
  };
}

function parseOrders(raw: unknown): KeepsakesOrder[] {
  if (!Array.isArray(raw)) return [];
  const orders: KeepsakesOrder[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const product = entry.product;
    const itemId = toNonEmptyString(entry.item_id);
    const status = toNonEmptyString(entry.status);
    if ((product !== 'book' && product !== 'card') || !itemId || !status) continue;
    orders.push({ product, item_id: itemId, status, shipped_at: toNonEmptyString(entry.shipped_at) });
  }
  return orders;
}

function parsePreviewKeys(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {};
  const keys: Record<string, string> = {};
  for (const [memberId, key] of Object.entries(raw)) {
    const value = toNonEmptyString(key);
    if (value) keys[memberId] = value;
  }
  return keys;
}

/**
 * Defensive parse of the RPC payload: anything unknown or missing becomes
 * null / `[]` / `{}`; never throws on shape. A non-object payload yields an
 * all-empty overview.
 */
export function parseKeepsakesOverview(raw: unknown): KeepsakesOverview {
  const row = isRecord(raw) ? raw : {};
  return {
    recap: parseRecap(row.recap),
    has_viewers: typeof row.has_viewers === 'boolean' ? row.has_viewers : null,
    year_moments: toCount(row.year_moments),
    holiday_pool: toCount(row.holiday_pool),
    holiday_min_pool: toCount(row.holiday_min_pool),
    holiday_ship_by_note: toNonEmptyString(row.holiday_ship_by_note),
    preview_key: toNonEmptyString(row.preview_key),
    book_preview_keys: parsePreviewKeys(row.book_preview_keys),
    orders: parseOrders(row.orders),
  };
}

/**
 * Loads the overview. Throws ONLY when the RPC itself errors (the hook turns
 * that into `overview: null` so the tab degrades); a malformed payload is
 * parsed into empty fields instead.
 */
export async function fetchKeepsakesOverview(familyId: string): Promise<KeepsakesOverview> {
  const { data, error } = await supabase.rpc('keepsakes_overview', { p_family_id: familyId });
  if (error) throw new Error(error.message);
  return parseKeepsakesOverview(data);
}
