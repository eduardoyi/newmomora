// Holiday Card front photo (docs/plans/holiday-cards.md §6 C1). Picks the
// photos a family could put on the FRONT of a printed 5x7 holiday card:
// candidates from the journal (≥2 family members tagged, share-safe, large
// enough to print), a vision "card-worthy" judge, and a ranking with
// near-misses. Pure: no I/O, no env -- prompt, request body, parsing and
// ranking only. The eval script (and later the Edge Function) own fetching
// images and calling OpenAI.
//
// PII: functions here never read memory text. Share-safety is decided by the
// caller (`shareSensitiveIds` in year-film-script.ts needs the text) and
// arrives as a precomputed id set. The judge prompt never names anyone and
// asks the model not to identify people.
import { type FilmMemberInput, isFilmChild } from './year-film-eligibility.ts';
import { CLAIM_CHECK_MODEL, type VisionImage } from './year-film-vision.ts';

// ── Card geometry (Gelato 5R, plan §3 / C0) ──────────────────────────────

/** Gelato 5R card: 5x7 in trim (177.8 x 127 mm landscape), 4 mm bleed on every
 * side, 300 dpi (support.gelato.com, 2026-10-04). */
export const CARD_TRIM_MM = { long: 177.8, short: 127 } as const;
export const CARD_BLEED_MM = 4;
export const CARD_DPI = 300;
const MM_PER_INCH = 25.4;

/** Pixels a full-bleed front needs (trim + bleed on every side). */
export const FULL_BLEED_PX = {
  long: Math.round(((CARD_TRIM_MM.long + 2 * CARD_BLEED_MM) / MM_PER_INCH) * CARD_DPI),
  short: Math.round(((CARD_TRIM_MM.short + 2 * CARD_BLEED_MM) / MM_PER_INCH) * CARD_DPI),
} as const;

/** A bordered layout prints the photo ~80% of the card width; at 60% of the
 * full-bleed pixels that is still ~180+ dpi. */
export const BORDERED_MIN_FRACTION = 0.6;

export type CardOrientation = 'portrait' | 'landscape';
export type PhotoOrientation = CardOrientation | 'square';
export type FrontPrintClass = 'full-bleed' | 'bordered' | 'low';

export interface PixelSize {
  width: number;
  height: number;
}

/** Square-ish photos (aspect 0.87–1.15) fit either card orientation. */
export function orientationOfPixels(size: PixelSize): PhotoOrientation {
  const aspect = size.width / size.height;
  if (aspect >= 1.15) return 'landscape';
  if (aspect <= 0.87) return 'portrait';
  return 'square';
}

/** Orientation from a stored aspect ratio (width / height) when the original
 * has not been measured. */
export function orientationOfAspect(aspect: number | null | undefined): PhotoOrientation | null {
  if (aspect == null || !Number.isFinite(aspect) || aspect <= 0) return null;
  return orientationOfPixels({ width: aspect, height: 1 });
}

/** Full-bleed pixel size of a card in the given orientation. */
export function cardPixels(orientation: CardOrientation): { width: number; height: number } {
  return orientation === 'landscape'
    ? { width: FULL_BLEED_PX.long, height: FULL_BLEED_PX.short }
    : { width: FULL_BLEED_PX.short, height: FULL_BLEED_PX.long };
}

const PRINT_RANK: Record<FrontPrintClass, number> = { low: 0, bordered: 1, 'full-bleed': 2 };

/** The photo evaluated against a card of the given orientation: the largest
 * crop at the card's aspect, against the full-bleed pixels. */
export function printClassForCard(size: PixelSize, card: CardOrientation): FrontPrintClass {
  const target = cardPixels(card);
  const aspect = target.width / target.height;
  const cropWidth = Math.min(size.width, size.height * aspect);
  const cropHeight = cropWidth / aspect;
  if (cropWidth >= target.width && cropHeight >= target.height) return 'full-bleed';
  if (cropWidth >= target.width * BORDERED_MIN_FRACTION) return 'bordered';
  return 'low';
}

export interface FrontPrintFit {
  orientation: PhotoOrientation;
  /** The card orientation the photo would be printed on. */
  cardOrientation: CardOrientation;
  printClass: FrontPrintClass;
}

/** A portrait photo goes on a portrait card, a landscape photo on a landscape
 * card (the card follows the photo, plan C0 consequence 1). A square photo
 * fits either, so it takes whichever orientation prints better (landscape on
 * a tie). */
export function frontPrintFit(size: PixelSize): FrontPrintFit {
  const orientation = orientationOfPixels(size);
  if (orientation !== 'square') {
    return { orientation, cardOrientation: orientation, printClass: printClassForCard(size, orientation) };
  }
  const landscape = printClassForCard(size, 'landscape');
  const portrait = printClassForCard(size, 'portrait');
  return PRINT_RANK[portrait] > PRINT_RANK[landscape]
    ? { orientation, cardOrientation: 'portrait', printClass: portrait }
    : { orientation, cardOrientation: 'landscape', printClass: landscape };
}

// ── Candidate pool ───────────────────────────────────────────────────────

/** A card front is often last Christmas's best family photo (C0
 * consequence 3): the pool starts on Dec 1 of the previous year. */
export function frontPoolStart(today: string): string {
  return `${Number(today.slice(0, 4)) - 1}-12-01`;
}

export function inFrontWindow(date: string, today: string): boolean {
  return date >= frontPoolStart(today) && date <= today;
}

/** Holiday-flavored topics (a card front that already looks like the
 * season). Halloween is not one. */
export const HOLIDAY_TOPICS: ReadonlySet<string> = new Set([
  'christmas',
  'hanukkah',
  'new-year',
  'thanksgiving',
  'snow-play',
  'family-gathering',
]);

/** Card audience = acquaintances: low-mood moments never front a card. */
export const FRONT_EXCLUDED_EMOTIONS: ReadonlySet<string> = new Set(['worry', 'worried', 'sad', 'weary']);

export const FRONT_MIN_TAGGED = 2;
export const FRONT_MAX_CANDIDATES = 30;
export const FRONT_MAX_PER_MEMORY = 3;
/** Soft cap per calendar date in the first selection pass, so one busy day
 * does not use up the vision budget. */
const FRONT_MAX_PER_DATE_FIRST_PASS = 2;

/** The family's core people: own children (explicit role or DOB rule, under
 * 13) and members with the 'parent' relationship. */
export function coreFamilyMemberIds(members: FilmMemberInput[], today: string): Set<string> {
  const ids = new Set<string>();
  for (const member of members) {
    if (member.relationship === 'parent' || isFilmChild(member, today)) ids.add(member.id);
  }
  return ids;
}

export interface FrontPhotoInput {
  memoryId: string;
  mediaId: string;
  date: string; // YYYY-MM-DD
  taggedMemberIds: string[];
  emotion: string | null;
  topics: string[];
  /** Open memory-level content report. */
  reported: boolean;
  /** Original pixel size (EXIF-corrected) or null when it could not be read. */
  dims: PixelSize | null;
  /** Stored width / height, used only when `dims` is missing. */
  aspectRatio?: number | null;
}

export interface FrontCandidate {
  memoryId: string;
  mediaId: string;
  date: string;
  taggedMemberIds: string[];
  /** Core-family members tagged on the photo's memory. */
  coreCovered: string[];
  /** Every core-family member is tagged. */
  wholeCore: boolean;
  orientation: PhotoOrientation;
  cardOrientation: CardOrientation;
  width: number;
  height: number;
  printClass: Exclude<FrontPrintClass, 'low'>;
  holiday: boolean;
  /** Deterministic pre-score that decides who gets a vision judgment. */
  preScore: number;
}

export type FrontDropReason =
  | 'outside-window'
  | 'too-few-tagged'
  | 'share-sensitive'
  | 'reported'
  | 'low-mood'
  | 'unreadable-size'
  | 'low-print';

export interface FrontPoolOptions {
  today: string;
  /** Share-safety exclusions (from `shareSensitiveIds`), by memory id. */
  excludedMemoryIds: ReadonlySet<string>;
}

/** Everything a photo must pass BEFORE its pixels matter. The eval probes
 * original sizes only for photos this lets through. */
export function frontPoolDropReason(photo: FrontPhotoInput, options: FrontPoolOptions): FrontDropReason | null {
  if (!inFrontWindow(photo.date, options.today)) return 'outside-window';
  if (photo.taggedMemberIds.length < FRONT_MIN_TAGGED) return 'too-few-tagged';
  if (options.excludedMemoryIds.has(photo.memoryId)) return 'share-sensitive';
  if (photo.reported) return 'reported';
  if (photo.emotion && FRONT_EXCLUDED_EMOTIONS.has(photo.emotion.trim().toLowerCase())) return 'low-mood';
  return null;
}

export function frontPoolPhotos(photos: FrontPhotoInput[], options: FrontPoolOptions): FrontPhotoInput[] {
  return photos.filter((photo) => frontPoolDropReason(photo, options) === null);
}

const POSITIVE_EMOTIONS: ReadonlySet<string> = new Set(['joy', 'funny', 'tender', 'pride', 'wonder', 'mischief']);

/** Days from the window start (0) to today (1), for the recency terms. */
function recency(date: string, today: string): number {
  const start = frontPoolStart(today);
  const dayNumber = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
  const span = Math.max(1, dayNumber(today) - dayNumber(start));
  return Math.min(1, Math.max(0, (dayNumber(date) - dayNumber(start)) / span));
}

function preScoreOf(candidate: Omit<FrontCandidate, 'preScore'>, coreSize: number, emotion: string | null, today: string): number {
  let score = 0;
  if (coreSize > 0) score += (candidate.coreCovered.length / coreSize) * 3;
  if (candidate.wholeCore) score += 3;
  if (candidate.printClass === 'full-bleed') score += 2;
  if (candidate.holiday) score += 1.5;
  if (emotion && POSITIVE_EMOTIONS.has(emotion.trim().toLowerCase())) score += 0.5;
  score += recency(candidate.date, today) * 0.5;
  return Math.round(score * 1000) / 1000;
}

export interface FrontSelection {
  candidates: FrontCandidate[];
  /** Pool photos that passed every filter, before the vision cap. */
  eligible: number;
  dropped: Partial<Record<FrontDropReason, number>>;
}

export interface SelectFrontOptions extends FrontPoolOptions {
  coreMemberIds: ReadonlySet<string>;
  /** Photos sent to the vision judge. */
  maxCandidates?: number;
  maxPerMemory?: number;
}

/** Candidates for the vision judge: the family's photos that could print on
 * the card, whole core family first, a few per memory, spread over dates.
 * Deterministic (ties break on memory id, then media id). */
export function selectFrontCandidates(photos: FrontPhotoInput[], options: SelectFrontOptions): FrontSelection {
  const maxCandidates = options.maxCandidates ?? FRONT_MAX_CANDIDATES;
  const maxPerMemory = options.maxPerMemory ?? FRONT_MAX_PER_MEMORY;
  const dropped: Partial<Record<FrontDropReason, number>> = {};
  const drop = (reason: FrontDropReason) => {
    dropped[reason] = (dropped[reason] ?? 0) + 1;
  };

  const eligible: Array<FrontCandidate & { emotion: string | null }> = [];
  for (const photo of photos) {
    const reason = frontPoolDropReason(photo, options);
    if (reason) {
      drop(reason);
      continue;
    }
    const size = photo.dims ?? null;
    if (!size || !(size.width > 0) || !(size.height > 0)) {
      drop('unreadable-size');
      continue;
    }
    const fit = frontPrintFit(size);
    if (fit.printClass === 'low') {
      drop('low-print');
      continue;
    }
    const coreCovered = [...new Set(photo.taggedMemberIds)].filter((id) => options.coreMemberIds.has(id));
    const base = {
      memoryId: photo.memoryId,
      mediaId: photo.mediaId,
      date: photo.date,
      taggedMemberIds: [...new Set(photo.taggedMemberIds)],
      coreCovered,
      wholeCore: options.coreMemberIds.size > 0 && coreCovered.length === options.coreMemberIds.size,
      orientation: fit.orientation,
      cardOrientation: fit.cardOrientation,
      width: size.width,
      height: size.height,
      printClass: fit.printClass as 'full-bleed' | 'bordered',
      holiday: photo.topics.some((topic) => HOLIDAY_TOPICS.has(topic)),
    };
    eligible.push({
      ...base,
      preScore: preScoreOf(base, options.coreMemberIds.size, photo.emotion, options.today),
      emotion: photo.emotion,
    });
  }

  const ordered = [...eligible].sort(
    (a, b) =>
      b.preScore - a.preScore || a.memoryId.localeCompare(b.memoryId) || a.mediaId.localeCompare(b.mediaId),
  );
  const perMemory = new Map<string, number>();
  const perDate = new Map<string, number>();
  const chosen: typeof eligible = [];
  const overflow: typeof eligible = [];
  for (const candidate of ordered) {
    if ((perMemory.get(candidate.memoryId) ?? 0) >= maxPerMemory) continue;
    if ((perDate.get(candidate.date) ?? 0) >= FRONT_MAX_PER_DATE_FIRST_PASS) {
      overflow.push(candidate);
      continue;
    }
    if (chosen.length >= maxCandidates) break;
    chosen.push(candidate);
    perMemory.set(candidate.memoryId, (perMemory.get(candidate.memoryId) ?? 0) + 1);
    perDate.set(candidate.date, (perDate.get(candidate.date) ?? 0) + 1);
  }
  // Second pass: a family with few busy days still fills the budget.
  for (const candidate of overflow) {
    if (chosen.length >= maxCandidates) break;
    if ((perMemory.get(candidate.memoryId) ?? 0) >= maxPerMemory) continue;
    chosen.push(candidate);
    perMemory.set(candidate.memoryId, (perMemory.get(candidate.memoryId) ?? 0) + 1);
  }

  chosen.sort(
    (a, b) =>
      b.preScore - a.preScore || a.memoryId.localeCompare(b.memoryId) || a.mediaId.localeCompare(b.mediaId),
  );
  return {
    candidates: chosen.map(({ emotion: _emotion, ...candidate }) => candidate),
    eligible: eligible.length,
    dropped,
  };
}

// ── Vision judge ─────────────────────────────────────────────────────────

/** Judged by the same model as the year film's claim checks: it decides
 * which photo goes on a printed card, a claim-level call (plan C1). */
export const FRONT_JUDGE_MODEL = CLAIM_CHECK_MODEL;
export const FRONT_JUDGE_BATCH = 8;

export type LookingAtCamera = 'most' | 'some' | 'none';
export type FrontLight = 'good' | 'ok' | 'poor';

export interface FrontVerdict {
  /** People in the frame (not the number tagged). */
  peopleVisible: number;
  allFacesVisible: boolean;
  eyesOpenMostly: boolean;
  lookingAtCamera: LookingAtCamera;
  light: FrontLight;
  sharp: boolean;
  /** Short setting tag, e.g. "living room", "beach". */
  setting: string;
  /** Nudity beyond everyday dress, toilet, medical, crying or distress. */
  unsafe: boolean;
  screenshotOrDocument: boolean;
  /** Heads or faces would be cut or cramped by a 5:7 crop in the photo's own
   * orientation. */
  cropRisk: boolean;
  /** 0–10: would the family proudly send this card? */
  cardScore: number;
  /** ≤15 words. */
  why: string;
}

export type FrontJudgeImage = VisionImage | { url: string };

export interface FrontJudgeItem {
  /** Opaque id the caller maps back (the media id); never shown to the model. */
  id: string;
  image: FrontJudgeImage;
  orientation: PhotoOrientation;
  /** Number of people tagged on the memory ("expected people"). A count only. */
  expectedPeople: number;
}

export function buildFrontJudgeSystemPrompt(): string {
  return [
    'You choose the FRONT PHOTO of a printed 5x7 family holiday card that parents mail to relatives and friends. The photo is the hero of the card: it must be one the parents would be proud to send. You are shown numbered candidate photos, labeled by INDEX only.',
    'For EACH index, report (never identify or name anyone; do not guess who people are -- count and describe only what is visible):',
    '- people_visible: integer, how many people are visible in the frame (faces or bodies).',
    '- all_faces_visible: true only if every visible person\'s face is clearly visible (not turned away, covered, cropped or tiny).',
    '- eyes_open_mostly: true if nearly everyone has their eyes open (no mid-blink faces).',
    '- looking_at_camera: "most" if most people look toward the camera, "some" if a few do, "none" otherwise.',
    '- light: "good" (well exposed, flattering), "ok", or "poor" (dark, harsh, blown out, muddy).',
    '- sharp: true if the people are in focus and free of motion blur.',
    '- setting: a short lowercase tag for the place or scene, at most 4 words (e.g. "living room", "beach", "christmas tree").',
    '- unsafe: true ONLY for nudity beyond everyday dress (bare bottoms, genitals), toilet use, a medical setting or procedure, or a child crying or in distress. Swimsuits, diapers, a shirtless toddler and big smiles are NOT unsafe.',
    '- screenshot_or_document: true if it is a screenshot, screen recording, scan, photo of a document, drawing, painting or framed picture, a collage or multi-panel image, or baby-monitor / security-camera footage.',
    '- crop_risk: the card is a 5:7 print in the SAME orientation as the photo (the photo\'s orientation is given with each index). Imagine a center crop to that ratio: true if heads, faces or hands would be cut off, or people would be pushed to the very edge.',
    '- card_score: integer 0-10. 9-10 = a card-front photo parents would frame (everyone together, happy, sharp, flattering, calm background). 7-8 = good. 5-6 = usable but flawed. 0-4 = not for a card. A group with someone missing, hidden or looking away scores lower. Candid charm is fine; a messy or distracting background, clutter or poor light is not.',
    '- why: at most 15 words, plain description of why this score.',
    'You may be told the number of people expected in the photo (people tagged on the memory); treat it as a hint only, never as proof of who is there.',
    'Return STRICT JSON: {"photos":[{"index":0,"people_visible":4,"all_faces_visible":true,"eyes_open_mostly":true,"looking_at_camera":"most","light":"good","sharp":true,"setting":"living room","unsafe":false,"screenshot_or_document":false,"crop_risk":false,"card_score":8,"why":"..."}]} -- exactly one entry per index shown.',
  ].join('\n');
}

function imageUrl(image: FrontJudgeImage): string {
  return 'url' in image ? image.url : `data:${image.contentType};base64,${image.base64}`;
}

/** Chat Completions body for one batch (≤ `FRONT_JUDGE_BATCH` photos),
 * `detail: 'high'` images labeled by position. */
export function buildFrontJudgeRequestBody(model: string, items: FrontJudgeItem[]): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [
    {
      type: 'text',
      text: `${items.length} numbered candidate photo(s) follow, index 0 through ${items.length - 1}, in that order. Judge each and return one entry per index.`,
    },
  ];
  items.forEach((item, index) => {
    content.push({
      type: 'text',
      text: `Index ${index} (${item.orientation} photo; expected people: ${Math.max(0, Math.round(item.expectedPeople))}):`,
    });
    content.push({ type: 'image_url', image_url: { url: imageUrl(item.image), detail: 'high' } });
  });
  return {
    model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: buildFrontJudgeSystemPrompt() },
      { role: 'user', content },
    ],
  };
}

const LOOKING: ReadonlySet<string> = new Set(['most', 'some', 'none']);
const LIGHTS: ReadonlySet<string> = new Set(['good', 'ok', 'poor']);
const WHY_MAX_WORDS = 15;

function cleanShort(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim().slice(0, maxChars).trim();
  return text.length > 0 ? text : null;
}

/** Never trust the model: each entry is validated field by field and a
 * malformed entry is dropped (that photo is simply unjudged). `ids[i]` is the
 * id behind index i; indices outside `ids`, duplicates and unknown ids are
 * dropped. */
export function parseFrontJudgeResponse(raw: unknown, ids: string[]): Map<string, FrontVerdict> {
  const out = new Map<string, FrontVerdict>();
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return out;
    }
  }
  const list = (parsed as { photos?: unknown } | null)?.photos;
  if (!Array.isArray(list)) return out;
  const seen = new Set<number>();

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const index = entry.index;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= ids.length || seen.has(index)) {
      continue;
    }
    const people = entry.people_visible;
    const score = entry.card_score;
    const setting = cleanShort(entry.setting, 40);
    const why = cleanShort(entry.why, 200);
    if (typeof people !== 'number' || !Number.isFinite(people) || people < 0) continue;
    if (typeof score !== 'number' || !Number.isFinite(score)) continue;
    if (
      typeof entry.all_faces_visible !== 'boolean' || typeof entry.eyes_open_mostly !== 'boolean' ||
      typeof entry.sharp !== 'boolean' || typeof entry.unsafe !== 'boolean' ||
      typeof entry.screenshot_or_document !== 'boolean' || typeof entry.crop_risk !== 'boolean'
    ) continue;
    if (typeof entry.looking_at_camera !== 'string' || !LOOKING.has(entry.looking_at_camera)) continue;
    if (typeof entry.light !== 'string' || !LIGHTS.has(entry.light)) continue;
    if (!setting || !why) continue;
    seen.add(index);
    out.set(ids[index], {
      peopleVisible: Math.min(30, Math.round(people)),
      allFacesVisible: entry.all_faces_visible,
      eyesOpenMostly: entry.eyes_open_mostly,
      lookingAtCamera: entry.looking_at_camera as LookingAtCamera,
      light: entry.light as FrontLight,
      sharp: entry.sharp,
      setting: setting.toLowerCase(),
      unsafe: entry.unsafe,
      screenshotOrDocument: entry.screenshot_or_document,
      cropRisk: entry.crop_risk,
      cardScore: Math.min(10, Math.max(0, Math.round(score * 10) / 10)),
      why: why.split(' ').slice(0, WHY_MAX_WORDS).join(' '),
    });
  }
  return out;
}

export interface JudgeUsage {
  promptTokens: number;
  completionTokens: number;
}

/** Token usage from a Chat Completions response, or null when absent. */
export function readChatUsage(usage: unknown): JudgeUsage | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const prompt = u.prompt_tokens;
  const completion = u.completion_tokens;
  if (typeof prompt !== 'number' || typeof completion !== 'number' || prompt < 0 || completion < 0) return null;
  return { promptTokens: prompt, completionTokens: completion };
}

// ── Ranking ──────────────────────────────────────────────────────────────

export type FrontRejectReason =
  | 'unsafe'
  | 'screenshot-or-document'
  | 'not-sharp'
  | 'poor-light'
  | 'same-moment-as-a-higher-pick'
  | 'not-judged';

export interface RankedPick {
  candidate: FrontCandidate;
  verdict: FrontVerdict;
  /** cardScore plus bonuses; only comparable inside one run. */
  score: number;
  /** Bonuses and flags that moved the score, for the review page. */
  notes: string[];
}

export interface NearMiss {
  candidate: FrontCandidate;
  verdict: FrontVerdict | null;
  reason: FrontRejectReason;
  /** Human-readable reason. */
  detail: string;
}

export interface RankFrontOptions {
  today: string;
  /** Picks per memory in the ranked list; the rest become near-misses. */
  maxPerMemory?: number;
  /** A hard-dropped photo is a near-miss only when its card score is at least this. */
  nearMissMinScore?: number;
  maxNearMisses?: number;
  /** Core family size (own children + parents). The memory's tags describe
   * the whole memory, not this photo, so tag bonuses are only trusted when
   * the judge sees about that many people. */
  expectedPeople?: number;
}

export interface FrontRanking {
  picks: RankedPick[];
  nearMisses: NearMiss[];
  /** Hard-dropped photos too weak to be near-misses, by reason. */
  dropped: Partial<Record<FrontRejectReason, number>>;
  unjudged: number;
}

const HARD_REASON_TEXT: Record<'unsafe' | 'screenshot-or-document' | 'not-sharp' | 'poor-light', string> = {
  unsafe: 'flagged unsafe for a card (nudity, toilet, medical or distress)',
  'screenshot-or-document': 'a screenshot, document, artwork or collage',
  'not-sharp': 'not sharp enough for print',
  'poor-light': 'poor light',
};

/** Hard filters first (unsafe, screenshot/document, not sharp, poor light),
 * then score = card score + bonuses (whole core family, all faces visible,
 * full-bleed print, holiday topic, recency; a crop risk costs points). */
export function rankFrontPicks(
  candidates: FrontCandidate[],
  verdicts: ReadonlyMap<string, FrontVerdict>,
  options: RankFrontOptions,
): FrontRanking {
  const maxPerMemory = options.maxPerMemory ?? 2;
  const nearMissMinScore = options.nearMissMinScore ?? 6;
  const maxNearMisses = options.maxNearMisses ?? 12;
  const nearMisses: NearMiss[] = [];
  const dropped: Partial<Record<FrontRejectReason, number>> = {};
  const scored: RankedPick[] = [];
  let unjudged = 0;
  const startOfWindow = frontPoolStart(options.today);

  for (const candidate of candidates) {
    const verdict = verdicts.get(candidate.mediaId);
    if (!verdict) {
      unjudged += 1;
      continue;
    }
    const hard: keyof typeof HARD_REASON_TEXT | null = verdict.unsafe
      ? 'unsafe'
      : verdict.screenshotOrDocument
      ? 'screenshot-or-document'
      : !verdict.sharp
      ? 'not-sharp'
      : verdict.light === 'poor'
      ? 'poor-light'
      : null;
    if (hard) {
      if (verdict.cardScore >= nearMissMinScore && hard !== 'unsafe') {
        nearMisses.push({ candidate, verdict, reason: hard, detail: HARD_REASON_TEXT[hard] });
      } else {
        dropped[hard] = (dropped[hard] ?? 0) + 1;
      }
      continue;
    }

    const notes: string[] = [];
    let score = verdict.cardScore;
    const expected = options.expectedPeople ?? 0;
    const people = verdict.peopleVisible;
    if (candidate.wholeCore && people >= expected) {
      score += 2;
      notes.push('whole core family tagged and visible (+2)');
    }
    if (people < 2 && expected >= 2) {
      score -= 3;
      notes.push('only one person in this photo (-3)');
    }
    // The card is the family's own photo: an uncle or a friend tagged on the
    // memory usually means they're in the picture (owner review, C1 #8).
    const outsiders = candidate.taggedMemberIds.length - candidate.coreCovered.length;
    if (outsiders > 0) {
      score -= 4;
      notes.push('someone outside the core family is tagged (-4)');
    }
    if (expected > 0 && people > expected + 3) {
      score -= 2;
      notes.push('a crowd, not the family (-2)');
    }
    if (verdict.allFacesVisible) {
      score += 1;
      notes.push('all faces visible (+1)');
    }
    if (verdict.lookingAtCamera === 'most') {
      score += 1;
      notes.push('looking at the camera (+1)');
    } else if (verdict.lookingAtCamera === 'some') {
      score += 0.3;
    }
    if (verdict.eyesOpenMostly) score += 0.5;
    if (candidate.printClass === 'full-bleed') {
      score += 1;
      notes.push('full-bleed print (+1)');
    }
    if (candidate.holiday) {
      score += 1;
      notes.push('holiday topic (+1)');
    }
    const days = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
    const fraction = Math.min(1, Math.max(0, (days(candidate.date) - days(startOfWindow)) / Math.max(1, days(options.today) - days(startOfWindow))));
    score += fraction * 0.5;
    if (verdict.cropRisk) {
      score -= 1.5;
      notes.push('crop risk (-1.5)');
    }
    scored.push({ candidate, verdict, score: Math.round(score * 100) / 100, notes });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score || b.candidate.date.localeCompare(a.candidate.date) ||
      a.candidate.mediaId.localeCompare(b.candidate.mediaId),
  );
  const perMemory = new Map<string, number>();
  const picks: RankedPick[] = [];
  for (const pick of scored) {
    const count = perMemory.get(pick.candidate.memoryId) ?? 0;
    if (count >= maxPerMemory) {
      nearMisses.push({
        candidate: pick.candidate,
        verdict: pick.verdict,
        reason: 'same-moment-as-a-higher-pick',
        detail: 'same moment as a higher-ranked pick',
      });
      continue;
    }
    perMemory.set(pick.candidate.memoryId, count + 1);
    picks.push(pick);
  }

  nearMisses.sort(
    (a, b) => (b.verdict?.cardScore ?? 0) - (a.verdict?.cardScore ?? 0) || a.candidate.mediaId.localeCompare(b.candidate.mediaId),
  );
  return { picks, nearMisses: nearMisses.slice(0, maxNearMisses), dropped, unjudged };
}
