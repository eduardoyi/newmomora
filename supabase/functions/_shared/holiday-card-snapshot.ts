// The frozen print snapshot of a holiday card (docs/plans/holiday-cards-p1.md
// Step 2 / Step 6): PURE functions turning already-loaded rows into the exact
// `card.json` + `edits.json` + asset list the book renderer's card print app
// consumes, plus a stable hash so the paid order can prove what was approved.
// The production port of the assembly in `supabase/scripts/eval-holiday-card-assets.ts`.
//
// No I/O, no env, no Deno-only APIs, no supabase-js: runs in Edge Functions and
// Cloudflare Workers. Callers load rows, probe pixel sizes (EXIF-corrected, the
// `save_edits` trust check) and pass everything in.
//
// SOURCE OF TRUTH for the shapes below is `book-renderer/src/card/types.ts`
// (`CardData`), `edits.ts` (`CardEdits`, `normalizeEdits`) and `fromData.ts`
// (how the print app reads them). Deno cannot import book-renderer, so the
// needed subset is mirrored here; keep them in step (the test pins the fields
// `cardInputFromData` reads).
//
// What the print app reads (book-renderer/src/card/print/CardPrintApp.tsx +
// fromData.ts): card.json `version`, `slug`, `year`, `language`, `greeting`,
// `signature`, `qrCaption`, `qr.{enabled,url}`, `format`, `letters[]`,
// `photo.{mediaId,file,width,height,focal,greetingPosition}`, `frontOptions`
// (to resolve the chosen front by id), `portraits[]`; and edits `text`,
// `letters`, `focalPoints`, `frontImage`, `choices`. It fetches
// `/<slug>/card.json`, `/<slug>/edits.json` and `/<slug>/<file>` for assets.
//
// PII: the snapshot holds the family's letter text, names and photo keys by
// design (it IS the print content). Nothing here logs; errors carry codes only.

import { type PortraitVersionCandidate, resolvePortraitVersionAtDate } from './portrait-versions.ts';
import { coreFamilyMemberIds } from './holiday-card-photos.ts';

// ── Mirrored card types (book-renderer/src/card/types.ts + edits.ts) ──────

export const CARD_GREETING_KEYS = ['christmas', 'holidays', 'new-year'] as const;
export type CardGreetingKey = (typeof CARD_GREETING_KEYS)[number];
export type CardLanguage = 'es' | 'en';
export type CardFormat = '5R' | 'A5';
export type CardOrientation = 'landscape' | 'portrait';

export const GREETING_POSITIONS = ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'] as const;
export type GreetingPosition = (typeof GREETING_POSITIONS)[number];

export const TEXT_TARGETS = ['front.greeting', 'front.subline', 'back.heading', 'back.signature', 'back.qrCaption'] as const;
export type TextTarget = (typeof TEXT_TARGETS)[number];

export interface Focal {
  x: number;
  y: number;
}

export interface CardChoices {
  layout: 'full-bleed' | 'bordered';
  tone: string;
  greeting?: CardGreetingKey;
  qr?: boolean;
  orientation?: CardOrientation | null;
  greetingPosition?: GreetingPosition;
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

export interface CardPortrait {
  memberId: string;
  name: string;
  role: 'parent' | 'child';
  file: string;
  width: number;
  height: number;
}

export interface FrontOption {
  id: string;
  kind: 'photo' | 'illustration';
  file: string;
  thumb?: string;
  width: number;
  height: number;
  date?: string;
  rank?: number;
  label?: string;
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
  format?: CardFormat;
  letters: { tone: string; text: string }[];
  photo: { mediaId?: string; memoryId?: string; file: string; width: number; height: number; focal?: Focal; greetingPosition?: GreetingPosition };
  illustrations: { id: string; file: string; width: number; height: number }[];
  frontOptions?: FrontOption[];
  portraits?: CardPortrait[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function emptyCardEdits(): CardEdits {
  return { version: 1, text: {}, letters: {}, focalPoints: {}, frontImage: null, choices: { layout: 'bordered', tone: 'classic' } };
}

/** Mirror of the renderer's tolerant `normalizeEdits`: a malformed category degrades to "no edits of that kind". */
export function normalizeCardEdits(raw: unknown): CardEdits {
  const out = emptyCardEdits();
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
    if ((CARD_GREETING_KEYS as readonly unknown[]).includes(c.greeting)) out.choices.greeting = c.greeting as CardGreetingKey;
    if (typeof c.qr === 'boolean') out.choices.qr = c.qr;
    if (c.orientation === 'landscape' || c.orientation === 'portrait') out.choices.orientation = c.orientation;
    if ((GREETING_POSITIONS as readonly unknown[]).includes(c.greetingPosition)) out.choices.greetingPosition = c.greetingPosition as GreetingPosition;
    if (typeof c.portraits === 'boolean') out.choices.portraits = c.portraits;
  }
  return out;
}

// ── Input ─────────────────────────────────────────────────────────────────

/** Where the public film page lives (workers/memory-viewer `/f/:token`). */
export const CARD_QR_BASE_URL = 'https://m.usemomora.com/f';

export interface SnapshotMedia {
  id: string;
  /** R2 key of the ORIGINAL (what prints). */
  originalKey: string;
  /** R2 key of the downscaled preview (the editor shows it; never printed). */
  previewKey: string | null;
  /** EXIF-corrected pixel size of the original; null = unknown (cannot be the front). */
  width: number | null;
  height: number | null;
  memoryId?: string | null;
  /** Memory date, YYYY-MM-DD. */
  date?: string | null;
}

export interface SnapshotPerson {
  id: string;
  name: string;
  dateOfBirth: string | null;
  /** family_members.relationship ('parent', 'child', ...). */
  relationship: string | null;
  /** The member's own current portrait (fallback when no dated version applies). */
  illustratedProfileKey?: string | null;
  illustratedProfileStatus?: string | null;
}

export interface BuildCardSnapshotInput {
  /** Directory name the print app uses (`/<slug>/card.json`); defaults to `cardId`. */
  slug?: string;
  cardId: string;
  year: number;
  language: CardLanguage;
  locale: string;
  /** The card row's greeting: the single source (fixed at creation). */
  greeting: CardGreetingKey;
  familyName: string;
  signature: string;
  qrCaption: string | null;
  /** The film's public share token; null = no film, so no QR. */
  shareToken: string | null;
  qrBaseUrl?: string;
  /** Print format of the product being ordered. */
  format: CardFormat;
  letters: { tone: string; text: string }[];
  /** The card row's `edits` jsonb (any shape; normalized here). */
  edits: unknown;
  /** Ranked front candidates: media ids, best first (`front_candidates`). */
  frontCandidateIds: string[];
  /** Media records for the candidates and any `edits.frontImage` pick. */
  media: SnapshotMedia[];
  people: SnapshotPerson[];
  portraitVersions: PortraitVersionCandidate[];
  /** Pixel sizes of the portrait files keyed by R2 key (the caller probes them). */
  portraitDimensions: Record<string, { width: number; height: number }>;
  /** Civil date the card is made for (YYYY-MM-DD): picks each person's age-appropriate portrait and who counts as a child. */
  asOfDate: string;
}

export type SnapshotErrorCode = 'NO_LETTERS' | 'NO_FRONT_PHOTO' | 'INVALID_INPUT';

export class CardSnapshotError extends Error {
  constructor(public readonly code: SnapshotErrorCode) {
    super(`Card snapshot failed: ${code}`);
    this.name = 'CardSnapshotError';
  }
}

export type SnapshotWarning = { code: 'portrait_missing' | 'portrait_no_dimensions'; memberId: string };

export interface CardSnapshot {
  /** `card.json` for the print app. */
  card: CardData;
  /** `edits.json` for the print app (greeting stripped: the card row is the single source; frozen to the chosen front). */
  edits: CardEdits;
  /** Files to place under `<slug>/<file>`; `key` is the R2 object key (original for the front photo). */
  assets: { file: string; key: string }[];
  /** The QR target, or null when the card prints without a QR. */
  qrUrl: string | null;
  /** The chosen front (print + editor-preview keys), for callers that need the thumbnail too. */
  front: { mediaId: string; originalKey: string; previewKey: string | null; width: number; height: number };
  warnings: SnapshotWarning[];
}

// ── Build ─────────────────────────────────────────────────────────────────

const MAX_PORTRAITS = 6;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

function extensionOf(key: string): 'jpg' | 'png' | 'webp' {
  const ext = /\.([A-Za-z0-9]+)$/.exec(key)?.[1]?.toLowerCase();
  if (ext === 'png') return 'png';
  if (ext === 'webp') return 'webp';
  return 'jpg';
}

function hasDims(media: SnapshotMedia): media is SnapshotMedia & { width: number; height: number } {
  return typeof media.width === 'number' && typeof media.height === 'number' && media.width > 0 && media.height > 0;
}

export function buildCardSnapshot(input: BuildCardSnapshotInput): CardSnapshot {
  const slug = input.slug ?? input.cardId;
  if (!SLUG.test(slug) || !Number.isInteger(input.year)) throw new CardSnapshotError('INVALID_INPUT');
  if (!(CARD_GREETING_KEYS as readonly string[]).includes(input.greeting)) throw new CardSnapshotError('INVALID_INPUT');
  const letters = input.letters.filter((l) => typeof l.tone === 'string' && typeof l.text === 'string' && l.text.trim());
  if (letters.length === 0) throw new CardSnapshotError('NO_LETTERS');

  const edits = normalizeCardEdits(input.edits);
  const mediaById = new Map(input.media.map((m) => [m.id, m]));

  // The chosen front: the editor's pick when it is a usable photo, else the top candidate with a known size.
  const pick = edits.frontImage ? mediaById.get(edits.frontImage) : undefined;
  const chosen = pick && hasDims(pick)
    ? pick
    : input.frontCandidateIds.map((id) => mediaById.get(id)).find((m): m is SnapshotMedia => !!m && hasDims(m));
  if (!chosen || !hasDims(chosen)) throw new CardSnapshotError('NO_FRONT_PHOTO');
  const frontWidth = chosen.width as number;
  const frontHeight = chosen.height as number;
  const photoFile = `assets/photo-${chosen.id.slice(0, 8)}.${extensionOf(chosen.originalKey)}`;

  // QR: only with a published film token; an edit can switch it off, never on without a token.
  const token = input.shareToken && /^[0-9A-Za-z]{22}$/.test(input.shareToken) ? input.shareToken : null;
  const qrEnabled = token !== null && (edits.choices.qr ?? true);
  const qrUrl = qrEnabled && token ? `${input.qrBaseUrl ?? CARD_QR_BASE_URL}/${token}` : null;

  // Frozen edits: the card row owns the greeting; only the chosen front's focal point matters; the QR switch is explicit.
  const frozen: CardEdits = {
    ...edits,
    frontImage: chosen.id,
    focalPoints: edits.focalPoints[chosen.id] ? { [chosen.id]: edits.focalPoints[chosen.id] } : {},
    choices: { ...edits.choices, qr: qrEnabled },
  };
  delete frozen.choices.greeting;

  // Portraits (the signature element): own children + parents with their age-appropriate ready portrait.
  const warnings: SnapshotWarning[] = [];
  const assets: { file: string; key: string }[] = [{ file: photoFile, key: chosen.originalKey }];
  const portraits: CardPortrait[] = [];
  const coreIds = coreFamilyMemberIds(
    input.people.map((p) => ({ id: p.id, dateOfBirth: p.dateOfBirth, relationship: p.relationship })),
    input.asOfDate,
  );
  const core = input.people.filter((p) => coreIds.has(p.id)).sort((a, b) => {
    const rank = (m: SnapshotPerson) => (m.relationship === 'parent' ? 0 : 1);
    return rank(a) - rank(b) || (a.dateOfBirth ?? '').localeCompare(b.dateOfBirth ?? '') || a.id.localeCompare(b.id);
  });
  for (const member of core.slice(0, MAX_PORTRAITS)) {
    const resolved = resolvePortraitVersionAtDate(input.portraitVersions.filter((v) => v.family_member_id === member.id), input.asOfDate);
    const key = resolved?.illustrated_profile_key ?? (member.illustratedProfileStatus === 'ready' ? member.illustratedProfileKey ?? null : null);
    if (!key) {
      warnings.push({ code: 'portrait_missing', memberId: member.id });
      continue;
    }
    const dims = input.portraitDimensions[key];
    if (!dims || !(dims.width > 0) || !(dims.height > 0)) {
      warnings.push({ code: 'portrait_no_dimensions', memberId: member.id });
      continue;
    }
    const file = `assets/portrait-${member.id.slice(0, 8)}.${extensionOf(key)}`;
    portraits.push({
      memberId: member.id,
      name: member.name.trim().split(/\s+/)[0] ?? member.name,
      role: member.relationship === 'parent' ? 'parent' : 'child',
      file,
      width: dims.width,
      height: dims.height,
    });
    assets.push({ file, key });
  }

  const card: CardData = {
    version: 1,
    slug,
    year: input.year,
    language: input.language,
    locale: input.locale,
    greeting: input.greeting,
    familyName: input.familyName,
    signature: input.signature,
    qrCaption: qrEnabled ? input.qrCaption : null,
    qr: { enabled: qrEnabled, token: qrEnabled && token ? token : '', url: qrUrl ?? '' },
    format: input.format,
    letters: letters.map((l) => ({ tone: l.tone, text: l.text })),
    photo: {
      mediaId: chosen.id,
      ...(chosen.memoryId ? { memoryId: chosen.memoryId } : {}),
      file: photoFile,
      width: frontWidth,
      height: frontHeight,
    },
    illustrations: [],
    // The print app resolves the chosen front through `frontOptions` by id; the frozen snapshot carries just that one.
    frontOptions: [{
      id: chosen.id,
      kind: 'photo',
      file: photoFile,
      width: frontWidth,
      height: frontHeight,
      ...(chosen.date ? { date: chosen.date } : {}),
    }],
    portraits,
  };

  return {
    card,
    edits: frozen,
    assets,
    qrUrl,
    front: { mediaId: chosen.id, originalKey: chosen.originalKey, previewKey: chosen.previewKey, width: frontWidth, height: frontHeight },
    warnings,
  };
}

// ── Hash ──────────────────────────────────────────────────────────────────

/** JSON with object keys sorted recursively and `undefined` dropped: the same value always serializes the same way. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

/**
 * sha256 (hex) over the canonical JSON of what prints: `card`, `edits`, `assets`
 * and `qrUrl`. WebCrypto, so it works in Deno, Cloudflare Workers and Node.
 */
export async function snapshotHash(snapshot: Pick<CardSnapshot, 'card' | 'edits' | 'assets' | 'qrUrl'>): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson({ card: snapshot.card, edits: snapshot.edits, assets: snapshot.assets, qrUrl: snapshot.qrUrl }));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}
