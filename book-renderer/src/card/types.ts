/**
 * Holiday card data model (docs/plans/holiday-cards.md C3). `CardData` is the
 * shape of `card-data/<slug>/card.json` written by
 * `supabase/scripts/eval-holiday-card-assets.ts`; the P2 web-shop editor will
 * produce the same shape from the database.
 */

export const CARD_GREETING_KEYS = ['christmas', 'holidays', 'new-year'] as const;
export type CardGreetingKey = (typeof CARD_GREETING_KEYS)[number];

export const LETTER_TONES = ['classic', 'short', 'playful', 'reflective'] as const;
export type LetterTone = (typeof LETTER_TONES)[number];

export type CardOrientation = 'landscape' | 'portrait';
export type CardLayout = 'full-bleed' | 'bordered' | 'illustrated';
export type CardLanguage = 'es' | 'en';

export const GREETING_POSITIONS = ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'] as const;
export type GreetingPosition = (typeof GREETING_POSITIONS)[number];

/** A point of interest in a photo, normalized 0..1 (x from the left, y from the top). */
export interface Focal {
  x: number;
  y: number;
}

/** A placed raster: its URL, pixel size and optional focal point. */
export interface CardImage {
  url: string;
  width: number;
  height: number;
  focal?: Focal | null;
}

/** A candidate for the front: a family photo (one of the C1 top picks) or an illustrated scene. */
export interface FrontOption {
  id: string;
  kind: 'photo' | 'illustration';
  file: string;
  /** A small preview for the picker grid (the original can be several MB). */
  thumb?: string;
  width: number;
  height: number;
  /** Photos: the memory date (YYYY-MM-DD); shown under the thumbnail like the book picker. */
  date?: string;
  /** Photos: the C1 rank (1 = the judge's top pick). */
  rank?: number;
  /** Illustrations: the scene id ("tree", "winter-walk", ...). */
  label?: string;
}

/** A core family member's current illustrated portrait (the signature element on the back). */
export interface CardPortrait {
  memberId: string;
  /** First name, for alt/debug only. */
  name: string;
  role: 'parent' | 'child';
  file: string;
  width: number;
  height: number;
}

export interface CardData {
  version: 1;
  slug: string;
  year: number;
  language: CardLanguage;
  locale: string;
  greeting: CardGreetingKey;
  familyName: string;
  signature: string;
  qrCaption: string | null;
  qr: { enabled: boolean; token: string; url: string };
  letters: { tone: string; text: string }[];
  photo: { mediaId?: string; memoryId?: string; file: string; width: number; height: number; focal?: Focal; greetingPosition?: GreetingPosition };
  illustrations: { id: string; file: string; width: number; height: number }[];
  /** The picker's candidates (photos then illustrations). Optional: older card.json files have none. */
  frontOptions?: FrontOption[];
  /** The core family's illustrated portraits, parents first. Optional. */
  portraits?: CardPortrait[];
}

export function parseCardData(raw: unknown): CardData {
  const d = raw as Partial<CardData> | null;
  if (!d || d.version !== 1) throw new Error('card.json: unsupported version');
  const need = (ok: boolean, what: string) => {
    if (!ok) throw new Error(`card.json: ${what}`);
  };
  need(typeof d.slug === 'string', 'slug');
  need(d.language === 'es' || d.language === 'en', 'language');
  need(CARD_GREETING_KEYS.includes(d.greeting as CardGreetingKey), 'greeting');
  need(typeof d.signature === 'string', 'signature');
  need(Array.isArray(d.letters) && d.letters.length > 0, 'letters');
  need(!!d.photo && typeof d.photo.file === 'string' && d.photo.width > 0 && d.photo.height > 0, 'photo');
  need(!!d.qr && typeof d.qr.url === 'string', 'qr');
  return { ...(d as CardData), illustrations: d.illustrations ?? [], frontOptions: d.frontOptions ?? [], portraits: d.portraits ?? [], qrCaption: d.qrCaption ?? null };
}
