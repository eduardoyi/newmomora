// Keepsakes tab overview (docs/plans/keepsakes-redesign.md B1). One RPC
// (`keepsakes_overview`, SQL in supabase/migrations/20261009120000_*) returns
// everything the redesigned tab needs beyond the films/books/card queries:
// the upcoming-recap progress, the family's preview pictures, the viewer
// flag, the holiday-card eligibility numbers and the order statuses. Fields
// that are owner/manager-only come back null / [] for viewers.
import { supabase } from '@/lib/supabase';
import type { HolidayCardGreeting, HolidayCardLanguage } from '@/services/holiday-cards';

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

export type KeepsakesCardLayout = 'bordered' | 'full-bleed';
export type KeepsakesCardOrientation = 'landscape' | 'portrait';
export type KeepsakesCardGreetingPosition =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

const CARD_GREETINGS: readonly HolidayCardGreeting[] = ['christmas', 'holidays', 'new-year'];
const CARD_GREETING_POSITIONS: readonly KeepsakesCardGreetingPosition[] = [
  'top-left',
  'top-center',
  'top-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
];

/**
 * What the real card's FRONT looks like, as the family chose it in the shop
 * editor (the newest card; null for viewers or when there is no card). Drives
 * `HolidayCardFront`, the app's port of the print layout.
 */
export interface KeepsakesCardFront {
  card_id: string;
  year: number;
  /** R2 key of the chosen front picture; null renders a warm wash. */
  image_key: string | null;
  /** The picture's pixel size; both null when unknown (the card's own aspect is assumed). */
  width: number | null;
  height: number | null;
  layout: KeepsakesCardLayout;
  orientation: KeepsakesCardOrientation;
  /** Where the visible window sits in the crop slack (0..1 each), or null for the centre. */
  focal: { x: number; y: number } | null;
  greeting: HolidayCardGreeting;
  language: HolidayCardLanguage;
  /** The edited greeting text, or null for the language's default. */
  greeting_text: string | null;
  /** The edited small line; null = the year; "" = hidden. */
  subline_text: string | null;
  greeting_position: KeepsakesCardGreetingPosition;
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
  /** The newest card's front (owner/manager, and only when a card exists). */
  card_front: KeepsakesCardFront | null;
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

function toPositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function toUnit(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
}

function parseCardFront(raw: unknown): KeepsakesCardFront | null {
  if (!isRecord(raw)) return null;
  const cardId = toNonEmptyString(raw.card_id);
  const year = toCount(raw.year);
  // Without an id and a year there is no card to draw.
  if (!cardId || year === null) return null;

  // Both sides or neither: half a size cannot give an aspect.
  const width = toPositiveInt(raw.width);
  const height = toPositiveInt(raw.height);
  const hasSize = width !== null && height !== null;

  const focalX = isRecord(raw.focal) ? toUnit(raw.focal.x) : null;
  const focalY = isRecord(raw.focal) ? toUnit(raw.focal.y) : null;

  const orientation: KeepsakesCardOrientation =
    raw.orientation === 'portrait' || raw.orientation === 'landscape'
      ? raw.orientation
      : hasSize && height > width
        ? 'portrait'
        : 'landscape';

  return {
    card_id: cardId,
    year,
    image_key: toNonEmptyString(raw.image_key),
    width: hasSize ? width : null,
    height: hasSize ? height : null,
    // The print editor's third layout ("illustrated") is a band layout too.
    layout: raw.layout === 'full-bleed' ? 'full-bleed' : 'bordered',
    orientation,
    focal: focalX !== null && focalY !== null ? { x: focalX, y: focalY } : null,
    greeting: CARD_GREETINGS.find((key) => key === raw.greeting) ?? 'holidays',
    language: raw.language === 'es' ? 'es' : 'en',
    greeting_text: typeof raw.greeting_text === 'string' ? raw.greeting_text : null,
    // "" is meaningful (hidden), so only a non-string becomes null.
    subline_text: typeof raw.subline_text === 'string' ? raw.subline_text : null,
    greeting_position: CARD_GREETING_POSITIONS.find((key) => key === raw.greeting_position) ?? 'bottom-left',
  };
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
    card_front: parseCardFront(row.card_front),
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
