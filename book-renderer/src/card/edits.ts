import type { CardGreetingKey, CardOrientation, Focal, GreetingPosition } from './types';

/**
 * The card's edits model (docs/plans/holiday-cards.md C3 round 2), the card
 * counterpart of the book's `memory_book_edits` (`src/model/edits.ts`):
 * everything the parent changed on top of the generated card, stored as plain
 * JSON so P1 can persist it in a column/table the same way. Locally the preview
 * saves it to `card-data/<slug>/edits.json` (dev-server PUT) and `card:pdf`
 * prints with it.
 *
 *   text         per-field text overrides (absent = the generated default)
 *   letters      the edited letter text per tone (absent = the generated letter)
 *   focalPoints  reposition per picture id (CSS object-position semantics, 0..1)
 *   frontImage   the chosen front picture (a `frontOptions` id; absent = the card's own photo)
 *   choices      the control strip: layout, letter tone, greeting, QR, ...
 */

export const TEXT_TARGETS = ['front.greeting', 'front.subline', 'back.heading', 'back.signature', 'back.qrCaption'] as const;
export type TextTarget = (typeof TEXT_TARGETS)[number];

export interface CardChoices {
  /** Applies to photos; an illustration always uses its own band layout. */
  layout: 'full-bleed' | 'bordered';
  tone: string;
  /** Absent = the card's own greeting. */
  greeting?: CardGreetingKey;
  /** Absent = the card's own QR setting. */
  qr?: boolean;
  /** Dev: force the orientation instead of following the picture. */
  orientation?: CardOrientation | null;
  /** Dev: where the full-bleed greeting sits. */
  greetingPosition?: GreetingPosition;
  /** Dev: the family portraits on the back (default on). */
  portraits?: boolean;
}

export interface CardEdits {
  version: 1;
  text: Partial<Record<TextTarget, string>>;
  letters: Record<string, string>;
  focalPoints: Record<string, Focal>;
  frontImage: string | null;
  choices: CardChoices;
}

export const DEFAULT_CHOICES: CardChoices = { layout: 'bordered', tone: 'classic' };

export function emptyEdits(): CardEdits {
  return { version: 1, text: {}, letters: {}, focalPoints: {}, frontImage: null, choices: { ...DEFAULT_CHOICES } };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Tolerant parse: a malformed category degrades to "no edits of that kind" (same posture as the book's normalizeEdits). */
export function normalizeEdits(raw: unknown): CardEdits {
  const out = emptyEdits();
  if (!isObj(raw)) return out;
  if (isObj(raw.text)) {
    for (const t of TEXT_TARGETS) if (typeof raw.text[t] === 'string') out.text[t] = raw.text[t] as string;
  }
  if (isObj(raw.letters)) for (const [k, v] of Object.entries(raw.letters)) if (typeof v === 'string' && v.trim()) out.letters[k] = v;
  if (isObj(raw.focalPoints)) {
    for (const [k, v] of Object.entries(raw.focalPoints)) {
      if (isObj(v) && typeof v.x === 'number' && typeof v.y === 'number') out.focalPoints[k] = { x: clamp01(v.x), y: clamp01(v.y) };
    }
  }
  if (typeof raw.frontImage === 'string') out.frontImage = raw.frontImage;
  if (isObj(raw.choices)) {
    const c = raw.choices;
    if (c.layout === 'full-bleed' || c.layout === 'bordered') out.choices.layout = c.layout;
    if (typeof c.tone === 'string') out.choices.tone = c.tone;
    if (c.greeting === 'christmas' || c.greeting === 'holidays' || c.greeting === 'new-year') out.choices.greeting = c.greeting;
    if (typeof c.qr === 'boolean') out.choices.qr = c.qr;
    if (c.orientation === 'landscape' || c.orientation === 'portrait') out.choices.orientation = c.orientation;
    if (typeof c.greetingPosition === 'string') out.choices.greetingPosition = c.greetingPosition as GreetingPosition;
    if (typeof c.portraits === 'boolean') out.choices.portraits = c.portraits;
  }
  return out;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

// Pure updaters (return a new edits object; the store is the caller's).

export function setText(edits: CardEdits, target: TextTarget, value: string): CardEdits {
  return { ...edits, text: { ...edits.text, [target]: value } };
}

export function resetText(edits: CardEdits, target: TextTarget): CardEdits {
  const { [target]: _removed, ...rest } = edits.text;
  return { ...edits, text: rest };
}

export function setLetter(edits: CardEdits, tone: string, value: string): CardEdits {
  return { ...edits, letters: { ...edits.letters, [tone]: value } };
}

export function resetLetter(edits: CardEdits, tone: string): CardEdits {
  const { [tone]: _removed, ...rest } = edits.letters;
  return { ...edits, letters: rest };
}

export function setFocal(edits: CardEdits, imageId: string, focal: Focal): CardEdits {
  return { ...edits, focalPoints: { ...edits.focalPoints, [imageId]: focal } };
}

export function resetFocal(edits: CardEdits, imageId: string): CardEdits {
  const { [imageId]: _removed, ...rest } = edits.focalPoints;
  return { ...edits, focalPoints: rest };
}

export function setFrontImage(edits: CardEdits, id: string | null): CardEdits {
  return { ...edits, frontImage: id };
}

export function setChoices(edits: CardEdits, patch: Partial<CardChoices>): CardEdits {
  return { ...edits, choices: { ...edits.choices, ...patch } };
}

/** A new greeting key means the greeting-derived texts follow it again. */
export function changeGreeting(edits: CardEdits, greeting: CardGreetingKey): CardEdits {
  const next = resetText(resetText(edits, 'front.greeting'), 'back.heading');
  return setChoices(next, { greeting });
}

export function hasAnyEdit(edits: CardEdits): boolean {
  return (
    Object.keys(edits.text).length > 0 ||
    Object.keys(edits.letters).length > 0 ||
    Object.keys(edits.focalPoints).length > 0 ||
    edits.frontImage !== null
  );
}
