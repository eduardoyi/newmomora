// Year Film eligibility + per-scene "include when" rules
// (docs/plans/year-film.md §4, §5). Pure: no I/O, no Date objects (date math
// goes through date-context.ts's string/JDN helpers, same reason as there).
//
// Written as the production module from F0 on (plan §10 conventions): the
// eval scripts import it, and the Workflow's FilmScript builder will too, so
// passing a dogfood stage means this logic passed -- not a throwaway copy.
//
// PII: functions here may *read* memory text (quote detection) but never
// return it. Everything returned is ids, dates, counts, and flags.
import { addYears, classifyChildOrAdult } from './date-context.ts';
import { getAgeInYearsAtDate } from './age.ts';
import { isOwnChild } from './family-relationships.ts';
import { type PortraitVersionCandidate, resolvePortraitVersionAtDate } from './portrait-versions.ts';

// ── Thresholds (plan §4; tuned by F0) ───────────────────────────────────

// Monthly recaps take the low bar (plan §4.3); year-scale films need a much
// richer pool or they come out "meh" (owner, 2026-09-27). Year-scale values
// are set from the F0 re-run — see plan §10 "F0 results".
export const MONTHLY_MIN_POOL = 10;
export const MONTHLY_MIN_VISUALS = 6;
// Owner, F1 round 2 (2026-09-27): 60 memories is the floor for a year film
// (Tomás Y3 subsampled); richer years get fuller films, never more padding.
export const BIRTHDAY_MIN_POOL = 60;
export const BIRTHDAY_MIN_VISUALS = 40;
export const FAMILY_MIN_POOL = 60;
export const FAMILY_MIN_VISUALS = 40;
/** A year-scale film must span the year, not one busy month. */
export const YEAR_MIN_QUARTERS = 3;
// Holiday-card film (docs/plans/holiday-cards.md §6 C0/C2, owner 2026-10-04):
// a ~45 s film for a printed card. A family that started journaling in
// September still gets one; below this the card ships without a QR. No
// quarter rule: the scope is "Jan 1 → the day the card is made".
export const HOLIDAY_MIN_POOL = 20;
export const HOLIDAY_MIN_VISUALS = 12;

/** Sound of the year needs at least this much clip (plan §5 scene 3). */
export const SOUND_MIN_DURATION_MS = 2000;
/** A video must run this long to be cut into the montage as a moving clip. */
export const VIDEO_CLIP_MIN_DURATION_MS = 2000;
/** Starring: a person must co-occur with the child in this many memories. */
export const STARRING_MIN_SHARED = 2;
/** Their world: need this many topics, each on this many pool memories. */
export const WORLD_MIN_TOPICS = 3;
export const WORLD_MIN_MEMORIES_PER_TOPIC = 2;
export const FIRSTS_MAX_SHOWN = 4;
export const MONTAGE_MIN_FRAMES = 8;
export const MONTAGE_MAX_FRAMES = 14;
/** Emotions never used for montage frames (plan §7.3). */
export const MONTAGE_EXCLUDED_EMOTIONS: ReadonlySet<string> = new Set(['worry', 'sad']);

/** Nominal scene durations (seconds) for the length estimate only. The real
 * timing comes from the music bed's beat map in F3. */
const SCENE_SECONDS = {
  cold_open: 4,
  counters: 4,
  sound_overhead: 1.5,
  sound_max_clip: 8,
  line: 4,
  starring: 4,
  world: 3.5,
  firsts_per_item: 1.5,
  montage_per_frame: 0.6,
  close: 4,
  end_card: 1.5,
} as const;

// ── Inputs ───────────────────────────────────────────────────────────────

export type FilmMediaKind = 'image' | 'video' | 'audio';

export interface FilmMediaInput {
  kind: FilmMediaKind;
  durationMs: number | null;
  /** Has a preview/poster (videos) — used for thumbnails, not eligibility. */
  hasPreview: boolean;
}

export interface FilmMemoryInput {
  id: string;
  date: string; // YYYY-MM-DD
  type: string; // text_illustration | text_only | media | audio
  /** Memory text (content). Read for quote detection, never returned. */
  text: string | null;
  emotion: string | null;
  topics: string[];
  taggedMemberIds: string[];
  illustrationReady: boolean;
  media: FilmMediaInput[];
  /** Excluded upstream when true (open memory-level content report). */
  reported: boolean;
}

export interface FilmMilestoneInput {
  memoryId: string;
  familyMemberId: string | null;
  milestoneId: string;
  status: string; // candidate | confirmed | dismissed
  /** The claim falls outside the milestone's plausible age band. */
  outOfBand?: boolean;
}

export interface FilmMemberInput {
  id: string;
  dateOfBirth: string | null;
  /** family_members.relationship; null/absent = unsorted (DOB rule). */
  relationship?: string | null;
}

export interface FilmScope {
  start: string; // inclusive
  endExclusive: string;
}

// ── Scopes ───────────────────────────────────────────────────────────────

export interface AgeYearScope extends FilmScope {
  ageYear: number; // 1 = birth → 1st birthday ("Year One")
  /** true when the birthday closing this age-year is on/before `today`. */
  complete: boolean;
}

/** Every age-year that has started by `today`, oldest first. Mirrors
 * buildAgeYearScopeOptions (src/utils/memory-book-scope.ts) but with an
 * exclusive end, so no day-subtraction is needed. */
export function ageYearScopes(dateOfBirth: string, today: string): AgeYearScope[] {
  const out: AgeYearScope[] = [];
  for (let ageYear = 1; ageYear <= 21; ageYear += 1) {
    const start = addYears(dateOfBirth, ageYear - 1);
    if (start > today) break;
    const endExclusive = addYears(dateOfBirth, ageYear);
    out.push({ ageYear, start, endExclusive, complete: endExclusive <= today });
  }
  return out;
}

/** Days after the birthday a birthday film still covers, so the party is in
 * it (owner, 2026-09-27: the film comes out a couple of days AFTER the
 * birthday and closes on this year's celebration). Owner 2026-09-29: the
 * film is made 00:30 and delivered 09:00 two days after the birthday, i.e. on
 * the day its scope ends (birthday + DAYS_AFTER + 1). Coupled to
 * year_film_due and year_films.placement_date in SQL. */
export const BIRTHDAY_FILM_DAYS_AFTER = 1;

function daysInMonth(year: number, month: number): number {
  return [31, (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/** YYYY-MM-DD + n days, pure string/calendar arithmetic (no Date objects). */
export function addDays(date: string, days: number): string {
  let [y, m, d] = date.split('-').map(Number);
  for (let i = 0; i < days; i += 1) {
    d += 1;
    if (d > daysInMonth(y, m)) {
      d = 1;
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
  }
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** YYYY-MM-DD minus one day (addDays only counts forward). */
export function previousDay(date: string): string {
  let [y, m, d] = date.split('-').map(Number);
  d -= 1;
  if (d < 1) {
    m -= 1;
    if (m < 1) {
      m = 12;
      y -= 1;
    }
    d = daysInMonth(y, m);
  }
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** The birthday film for `ageYear` ("Year Four"): the age-year plus the
 * birthday that closes it and BIRTHDAY_FILM_DAYS_AFTER days, so this year's
 * party is the film's ending. Eligibility is still judged on the age-year
 * (ageYearScopes); this is the film's content window. */
export function birthdayFilmScope(dateOfBirth: string, ageYear: number): FilmScope {
  return {
    start: addYears(dateOfBirth, ageYear - 1),
    endExclusive: addDays(addYears(dateOfBirth, ageYear), BIRTHDAY_FILM_DAYS_AFTER + 1),
  };
}

/** The year-end family film's window: Jan 1 → Dec 27 (it renders Dec 28 and
 * surfaces Dec 30 09:00; memories after the cut-off never re-render it, plan
 * §4.2; dates: year-film-p2.md §2). */
export const FAMILY_FILM_CUTOFF = '12-28';
export function familyYearScope(year: number): FilmScope {
  return { start: `${year}-01-01`, endExclusive: `${year}-${FAMILY_FILM_CUTOFF}` };
}

/** The holiday card film's window: Jan 1 → the day the card is made,
 * inclusive (so `endExclusive` is the day after). */
export function holidayFilmScope(year: number, madeOn: string): FilmScope {
  return { start: `${year}-01-01`, endExclusive: addDays(madeOn, 1) };
}

export function inScope(date: string, scope: FilmScope): boolean {
  return date >= scope.start && date < scope.endExclusive;
}

/** The family's own children (plan §4.1): own child by role (explicit
 * 'child' wins, any other role excludes -- a niece marked 'cousin' is out;
 * unsorted falls back to the DOB rule), with a DOB, and still under 13 at
 * `today` -- an explicit 'child' role never unlocks films for teens
 * (docs/plans/family-relationships.md §7.1). */
export function isFilmChild(member: FilmMemberInput, today: string): boolean {
  if (!member.dateOfBirth) return false;
  if (!isOwnChild(member, today)) return false;
  return classifyChildOrAdult(getAgeInYearsAtDate(member.dateOfBirth, today)) === 'child';
}

// ── Per-memory classification ────────────────────────────────────────────

// NOTE: `hasVideoClip` / `visualKind` below and `holidayPool` further down are
// mirrored in SQL by public.keepsake_pool (supabase/migrations/
// 20261009120000_keepsakes_overview.sql), which feeds the Keepsakes tab's
// recap progress. Change a rule here => change the SQL (a new migration) and
// supabase/tests/keepsakes_overview_test.sql too. The same goes for the floors
// (BIRTHDAY_/FAMILY_MIN_POOL, _MIN_VISUALS, YEAR_MIN_QUARTERS), birthdayPool /
// familyPool, the birthday/family scopes and the quarter rule in evaluateMontage,
// which public.keepsake_upcoming_films (20261011120000_keepsakes_overview_cards_
// upcoming.sql) mirrors for the Keepsakes "coming up" tiles.

export type VisualKind = 'illustration' | 'photo' | 'video';

/** A video long enough to cut in as a moving clip (plan §5: videos are
 * first-class montage frames since 2026-09-27). Unknown duration (legacy
 * single-asset rows) counts; F2 probes the real file. */
export function hasVideoClip(memory: FilmMemoryInput): boolean {
  return memory.media.some(
    (m) => m.kind === 'video' && (m.durationMs === null || m.durationMs >= VIDEO_CLIP_MIN_DURATION_MS),
  );
}

/** What a memory can contribute to the montage, best first. */
export function visualKind(memory: FilmMemoryInput): VisualKind | null {
  if (memory.type === 'audio') return null;
  if (memory.illustrationReady) return 'illustration';
  if (hasVideoClip(memory)) return 'video';
  if (memory.media.some((m) => m.kind === 'image')) return 'photo';
  return null;
}

export function soundDurationMs(memory: FilmMemoryInput): number | null {
  if (memory.type !== 'audio') return null;
  const clip = memory.media.find((m) => m.kind === 'audio');
  return clip?.durationMs ?? null;
}

export function isSoundCandidate(memory: FilmMemoryInput): boolean {
  const duration = soundDurationMs(memory);
  return duration !== null && duration >= SOUND_MIN_DURATION_MS;
}

// Paired quotation marks: straight, curly, guillemets, low-high German.
const QUOTED_SPAN = /["“«„]([^"“”«»„]{2,140})["”»“]/u;

/** Floor estimate for "line of the year": text with explicitly quoted
 * speech. Many real quotes are unmarked ("Ay Dios mío"), so F1's LLM pick
 * searches all text; this is only the cheap, certain subset. */
export function hasQuotedSpeech(text: string | null): boolean {
  return !!text && QUOTED_SPAN.test(text);
}

/** Text long enough for the F1 quote pick to consider. */
export function isQuotePoolText(text: string | null): boolean {
  return !!text && text.trim().length >= 12;
}

// ── Pools ────────────────────────────────────────────────────────────────

export type UntaggedPolicy = 'exclude' | 'include';

/** Birthday pool: memories in scope tagged to the child. With `include`,
 * untagged memories count too (the book's rule — right for single-child
 * families, questionable with siblings; F0 reports both). */
export function birthdayPool<T extends FilmMemoryInput>(
  memories: T[],
  childId: string,
  scope: FilmScope,
  untagged: UntaggedPolicy,
): T[] {
  return memories.filter((m) => {
    if (m.reported || !inScope(m.date, scope)) return false;
    if (m.taggedMemberIds.includes(childId)) return true;
    return untagged === 'include' && m.taggedMemberIds.length === 0;
  });
}

export function familyPool<T extends FilmMemoryInput>(memories: T[], scope: FilmScope): T[] {
  return memories.filter((m) => !m.reported && inScope(m.date, scope));
}

/** Emotions a public holiday card never shows (owner, 2026-10-04: no
 * sad/worried moments). Same set the film's frames already skip. */
export const HOLIDAY_EXCLUDED_EMOTIONS: ReadonlySet<string> = new Set(['worry', 'sad', 'weary']);

/** Topics that score up in the holiday film and letter (check
 * memory-topics.ts: Occasions + snow + gatherings). Halloween is left out: a
 * card goes out for the winter holidays. */
export const HOLIDAY_TOPICS: ReadonlySet<string> = new Set([
  'christmas',
  'hanukkah',
  'new-year',
  'thanksgiving',
  'snow-play',
  'family-gathering',
  'other-holiday',
  'diwali',
  'eid',
  'lunar-new-year',
]);

/** The holiday card's pool: the family pool minus everything a public
 * audience must not see — share-sensitive memories (`excludeIds`, from
 * shareSensitiveIds) and worried/sad/weary moments. The film builder and the
 * floor check both use it, so the floor counts what the film can show. */
export function holidayPool<T extends FilmMemoryInput>(
  memories: T[],
  scope: FilmScope,
  excludeIds: ReadonlySet<string> = new Set(),
): T[] {
  return familyPool(memories, scope).filter(
    (m) => !excludeIds.has(m.id) && !(m.emotion && HOLIDAY_EXCLUDED_EMOTIONS.has(m.emotion)),
  );
}

// ── Scene evaluation ─────────────────────────────────────────────────────

export interface FilmCounts {
  moments: number;
  photos: number; // memories with ≥1 image
  sounds: number; // audio memories
  drawings: number; // ready illustrations
  videos: number; // memories with ≥1 video
}

export function countPool(pool: FilmMemoryInput[]): FilmCounts {
  return {
    moments: pool.length,
    photos: pool.filter((m) => m.media.some((x) => x.kind === 'image')).length,
    sounds: pool.filter((m) => m.type === 'audio').length,
    drawings: pool.filter((m) => m.illustrationReady).length,
    videos: pool.filter((m) => m.media.some((x) => x.kind === 'video')).length,
  };
}

export type ColdOpenMode = 'match_cut' | 'single_portrait' | 'none';

export interface SceneReport {
  coldOpen: ColdOpenMode;
  counters: boolean;
  /** Audio memories first; video clips are the voice fallback for years
   * before audio memories existed (owner, 2026-09-27). F2 checks the clip
   * really has voice. */
  sound: { include: boolean; candidates: number; longestMs: number | null; videoFallbacks: number };
  line: { quotedSpeechMemories: number; quotePoolMemories: number };
  starring: { include: boolean; people: number };
  world: { include: boolean; qualifyingTopics: number; topTopics: { id: string; memories: number }[] };
  firsts: { include: boolean; total: number; shown: number };
  montage: {
    visuals: number;
    byKind: Record<VisualKind, number>;
    usableFrames: number; // visuals minus excluded emotions, same-day deduped
    frames: number; // what the film would use (capped)
    quartersCovered: number; // 0–4
  };
  close: 'portraits' | 'visuals' | 'none';
}

export interface BirthdayEvaluation {
  counts: FilmCounts;
  visuals: number;
  eligible: boolean;
  scenes: SceneReport;
  lengthSeconds: number;
}

export function evaluateColdOpen(
  portraits: PortraitVersionCandidate[],
  scope: FilmScope,
): { mode: ColdOpenMode; startId: string | null; endId: string | null } {
  const lastDay = scope.endExclusive; // birthday itself: close enough for "now"
  const atStart = resolvePortraitVersionAtDate(portraits, scope.start);
  const atEnd = resolvePortraitVersionAtDate(portraits, lastDay);
  if (!atStart && !atEnd) return { mode: 'none', startId: null, endId: null };
  if (atStart && atEnd && atStart.id !== atEnd.id) {
    return { mode: 'match_cut', startId: atStart.id, endId: atEnd.id };
  }
  const only = atEnd ?? atStart;
  return { mode: 'single_portrait', startId: only!.id, endId: only!.id };
}

function quarterOf(date: string, scope: FilmScope): number {
  // Position within the scope by string-sorted day index is overkill; use
  // month distance from start, which is exact enough for coverage.
  const [sy, sm] = scope.start.split('-').map(Number);
  const [y, m] = date.split('-').map(Number);
  const monthIndex = (y - sy) * 12 + (m - sm);
  return Math.max(0, Math.min(3, Math.floor(monthIndex / 3)));
}

export function evaluateMontage(pool: FilmMemoryInput[], scope: FilmScope): SceneReport['montage'] {
  const byKind: Record<VisualKind, number> = { illustration: 0, photo: 0, video: 0 };
  const usableDays = new Set<string>();
  const quarters = new Set<number>();
  let visuals = 0;
  for (const memory of pool) {
    const kind = visualKind(memory);
    if (!kind) continue;
    visuals += 1;
    byKind[kind] += 1;
    if (memory.emotion && MONTAGE_EXCLUDED_EMOTIONS.has(memory.emotion)) continue;
    if (!usableDays.has(memory.date)) {
      usableDays.add(memory.date);
      quarters.add(quarterOf(memory.date, scope));
    }
  }
  const usableFrames = usableDays.size;
  return {
    visuals,
    byKind,
    usableFrames,
    frames: Math.min(MONTAGE_MAX_FRAMES, usableFrames),
    quartersCovered: quarters.size,
  };
}

export function evaluateStarring(
  pool: FilmMemoryInput[],
  childId: string,
): { include: boolean; people: number } {
  const shared = new Map<string, number>();
  for (const memory of pool) {
    if (!memory.taggedMemberIds.includes(childId)) continue;
    for (const id of memory.taggedMemberIds) {
      if (id === childId) continue;
      shared.set(id, (shared.get(id) ?? 0) + 1);
    }
  }
  const people = [...shared.values()].filter((n) => n >= STARRING_MIN_SHARED).length;
  return { include: people >= 1, people };
}

export function evaluateWorld(pool: FilmMemoryInput[]): SceneReport['world'] {
  const counts = new Map<string, number>();
  for (const memory of pool) {
    for (const topic of new Set(memory.topics)) {
      counts.set(topic, (counts.get(topic) ?? 0) + 1);
    }
  }
  const qualifying = [...counts.entries()]
    .filter(([, n]) => n >= WORLD_MIN_MEMORIES_PER_TOPIC)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return {
    include: qualifying.length >= WORLD_MIN_TOPICS,
    qualifyingTopics: qualifying.length,
    topTopics: qualifying.slice(0, 5).map(([id, memories]) => ({ id, memories })),
  };
}

export function evaluateFirsts(
  pool: FilmMemoryInput[],
  milestones: FilmMilestoneInput[],
  childId: string,
): { include: boolean; total: number; shown: number } {
  const poolIds = new Set(pool.map((m) => m.id));
  const distinct = new Set(
    milestones
      .filter(
        (row) =>
          row.status !== 'dismissed' &&
          poolIds.has(row.memoryId) &&
          (row.familyMemberId === childId || row.familyMemberId === null),
      )
      .map((row) => row.milestoneId),
  );
  const total = distinct.size;
  return { include: total >= 1, total, shown: Math.min(FIRSTS_MAX_SHOWN, total) };
}

export function estimateLengthSeconds(scenes: SceneReport): number {
  let seconds = SCENE_SECONDS.end_card;
  if (scenes.coldOpen !== 'none') seconds += SCENE_SECONDS.cold_open;
  if (scenes.counters) seconds += SCENE_SECONDS.counters;
  if (scenes.sound.include) {
    const clipMs = scenes.sound.longestMs ?? SCENE_SECONDS.sound_max_clip * 1000; // video fallback
    const clip = Math.min(SCENE_SECONDS.sound_max_clip, clipMs / 1000);
    seconds += clip + SCENE_SECONDS.sound_overhead;
  }
  // F0 can't know if a quote verifies; count the scene when explicit quoted
  // speech exists (the certain subset).
  if (scenes.line.quotedSpeechMemories > 0) seconds += SCENE_SECONDS.line;
  if (scenes.starring.include) seconds += SCENE_SECONDS.starring;
  if (scenes.world.include) seconds += SCENE_SECONDS.world;
  if (scenes.firsts.include) seconds += scenes.firsts.shown * SCENE_SECONDS.firsts_per_item;
  seconds += scenes.montage.frames * SCENE_SECONDS.montage_per_frame;
  if (scenes.close !== 'none') seconds += SCENE_SECONDS.close;
  return Math.round(seconds * 10) / 10;
}

export function evaluateBirthdayFilm(args: {
  memories: FilmMemoryInput[];
  childId: string;
  scope: FilmScope;
  untagged: UntaggedPolicy;
  milestones: FilmMilestoneInput[];
  portraits: PortraitVersionCandidate[];
}): BirthdayEvaluation {
  const pool = birthdayPool(args.memories, args.childId, args.scope, args.untagged);
  const counts = countPool(pool);
  const montage = evaluateMontage(pool, args.scope);
  const soundCandidates = pool.filter(isSoundCandidate);
  const longestMs = soundCandidates.reduce<number | null>(
    (max, m) => Math.max(max ?? 0, soundDurationMs(m) ?? 0),
    null,
  );
  const coldOpen = evaluateColdOpen(args.portraits, args.scope).mode;
  const videoFallbacks = pool.filter(hasVideoClip).length;

  const scenes: SceneReport = {
    coldOpen,
    counters: counts.moments > 0,
    sound: {
      include: soundCandidates.length > 0 || videoFallbacks > 0,
      candidates: soundCandidates.length,
      longestMs,
      videoFallbacks,
    },
    line: {
      quotedSpeechMemories: pool.filter((m) => hasQuotedSpeech(m.text)).length,
      quotePoolMemories: pool.filter((m) => isQuotePoolText(m.text)).length,
    },
    starring: evaluateStarring(pool, args.childId),
    world: evaluateWorld(pool),
    firsts: evaluateFirsts(pool, args.milestones, args.childId),
    montage,
    close: coldOpen === 'match_cut' ? 'portraits' : montage.usableFrames >= 2 ? 'visuals' : 'none',
  };

  return {
    counts,
    visuals: montage.visuals,
    eligible: counts.moments >= BIRTHDAY_MIN_POOL && montage.visuals >= BIRTHDAY_MIN_VISUALS &&
      montage.quartersCovered >= YEAR_MIN_QUARTERS,
    scenes,
    lengthSeconds: estimateLengthSeconds(scenes),
  };
}

// ── Family film ──────────────────────────────────────────────────────────

export interface FamilyChapterReport {
  childId: string;
  memories: number; // tagged to this child in scope
  visuals: number;
  videoClips: number;
  hasSound: boolean;
  quotedSpeech: boolean;
  /** Portrait-only beat (plan §4.2: never skipped, even with zero memories). */
  portraitOnly: boolean;
}

export interface FamilyEvaluation {
  counts: FilmCounts;
  visuals: number;
  videoClips: number;
  quartersCovered: number;
  eligible: boolean;
  chapters: FamilyChapterReport[];
  sharedMoments: number; // memories tagging ≥2 members
  /** Ratio of the richest child's memories to the thinnest's (sibling-gap signal). */
  siblingGapRatio: number | null;
}

function chapterFor(pool: FilmMemoryInput[], childId: string): FamilyChapterReport {
  const mine = pool.filter((m) => m.taggedMemberIds.includes(childId));
  const myVisuals = mine.filter((m) => visualKind(m) !== null).length;
  return {
    childId,
    memories: mine.length,
    visuals: myVisuals,
    videoClips: mine.filter(hasVideoClip).length,
    hasSound: mine.some(isSoundCandidate),
    quotedSpeech: mine.some((m) => hasQuotedSpeech(m.text)),
    portraitOnly: myVisuals === 0,
  };
}

function gapRatio(chapters: FamilyChapterReport[]): number | null {
  if (chapters.length < 2) return null;
  const sizes = chapters.map((c) => c.memories);
  return Math.round((Math.max(...sizes) / Math.max(1, Math.min(...sizes))) * 10) / 10;
}

/** The family's own children (plan §4.2: nieces/cousins with profiles
 * never get chapters — the caller decides who they are) who were born
 * before the scope ends. A child born mid-scope still gets a chapter. */
export function chapterChildren(children: FilmMemberInput[], scope: FilmScope): FilmMemberInput[] {
  return children.filter((c) => !!c.dateOfBirth && c.dateOfBirth < scope.endExclusive);
}

export function evaluateFamilyFilm(args: {
  memories: FilmMemoryInput[];
  children: FilmMemberInput[];
  scope: FilmScope;
}): FamilyEvaluation {
  const pool = familyPool(args.memories, args.scope);
  const counts = countPool(pool);
  const montage = evaluateMontage(pool, args.scope);
  const chapters = chapterChildren(args.children, args.scope).map((c) => chapterFor(pool, c.id));
  return {
    counts,
    visuals: montage.visuals,
    videoClips: pool.filter(hasVideoClip).length,
    quartersCovered: montage.quartersCovered,
    eligible: counts.moments >= FAMILY_MIN_POOL && montage.visuals >= FAMILY_MIN_VISUALS &&
      montage.quartersCovered >= YEAR_MIN_QUARTERS,
    chapters,
    sharedMoments: pool.filter((m) => m.taggedMemberIds.length >= 2).length,
    siblingGapRatio: gapRatio(chapters),
  };
}

/** Holiday card film floor: ≥ HOLIDAY_MIN_POOL moments and
 * HOLIDAY_MIN_VISUALS visuals in the share-safe pool, no quarter rule.
 * `excludeIds` = shareSensitiveIds(memories, milestones). */
export function evaluateHolidayFilm(args: {
  memories: FilmMemoryInput[];
  children: FilmMemberInput[];
  scope: FilmScope;
  excludeIds?: ReadonlySet<string>;
}): FamilyEvaluation {
  const pool = holidayPool(args.memories, args.scope, args.excludeIds);
  const counts = countPool(pool);
  const montage = evaluateMontage(pool, args.scope);
  const chapters = chapterChildren(args.children, args.scope).map((c) => chapterFor(pool, c.id));
  return {
    counts,
    visuals: montage.visuals,
    videoClips: pool.filter(hasVideoClip).length,
    quartersCovered: montage.quartersCovered,
    eligible: counts.moments >= HOLIDAY_MIN_POOL && montage.visuals >= HOLIDAY_MIN_VISUALS,
    chapters,
    sharedMoments: pool.filter((m) => m.taggedMemberIds.length >= 2).length,
    siblingGapRatio: gapRatio(chapters),
  };
}

// ── Monthly family recap (plan §4.3) ─────────────────────────────────────

/** Emotions that can back a per-child "award" beat. One award per child,
 * never comparative (plan §3: no ranking of people). */
export const AWARD_EMOTIONS: ReadonlySet<string> = new Set(['joy', 'funny', 'mischief', 'wonder', 'pride', 'tender']);

export interface MonthlyChapterReport extends FamilyChapterReport {
  /** Memories of this child whose emotion can back an award beat. */
  awardCandidates: number;
}

export interface MonthlyEvaluation {
  scope: FilmScope;
  counts: FilmCounts;
  visuals: number;
  videoClips: number;
  eligible: boolean;
  chapters: MonthlyChapterReport[];
  /** Topics on ≥2 memories this month, most frequent first (their
   * `pageTitle` renders as the theme triplet). */
  themes: { id: string; memories: number }[];
  montageFrames: number;
  siblingGapRatio: number | null;
}

/** `YYYY-MM` → [first day, first day of next month). */
export function monthScope(yearMonth: string): FilmScope {
  const [y, m] = yearMonth.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return { start: `${yearMonth}-01`, endExclusive: `${next}-01` };
}

export function evaluateMonthlyFilm(args: {
  memories: FilmMemoryInput[];
  children: FilmMemberInput[];
  yearMonth: string;
}): MonthlyEvaluation {
  const scope = monthScope(args.yearMonth);
  const pool = familyPool(args.memories, scope);
  const counts = countPool(pool);
  const montage = evaluateMontage(pool, scope);
  const chapters = chapterChildren(args.children, scope).map(({ id: childId }) => ({
    ...chapterFor(pool, childId),
    awardCandidates: pool.filter(
      (m) => m.taggedMemberIds.includes(childId) && !!m.emotion && AWARD_EMOTIONS.has(m.emotion) &&
        visualKind(m) !== null,
    ).length,
  }));
  return {
    scope,
    counts,
    visuals: montage.visuals,
    videoClips: pool.filter(hasVideoClip).length,
    eligible: counts.moments >= MONTHLY_MIN_POOL && montage.visuals >= MONTHLY_MIN_VISUALS,
    chapters,
    themes: evaluateWorld(pool).topTopics.slice(0, 3),
    // A month has no quarters; frames are same-day-deduped visuals.
    montageFrames: Math.min(MONTAGE_MAX_FRAMES, montage.usableFrames),
    siblingGapRatio: gapRatio(chapters),
  };
}
