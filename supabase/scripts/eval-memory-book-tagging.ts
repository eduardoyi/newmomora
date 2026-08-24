/**
 * Memory Book V1a — open-vocabulary discovery pass (docs/plans/memory-book.md
 * §5 Stage A `analyze-memory`, §9 validation row V1a). This is NOT production
 * code; it is a read-only eval harness that runs an OpenAI multimodal call
 * over every memory in the eval user's archive and records what the model
 * sees, with NO fixed topic vocabulary, so the controlled book vocabulary can
 * be derived bottom-up (V1b) from the real archive instead of hand-guessed.
 *
 * Per memory it sends: the parent's text (if any), up to `--max-images`
 * photos/video-poster frames (never the AI illustration -- illustrations are
 * generated, not evidence), and structured context computed in code (date,
 * tagged members' ages/child-adult/days-to-birthday, nearby holidays). The
 * model returns themes/labels/description/emotion/occasion/milestone as
 * strict JSON. Whose-birthday and the milestone "explicit text only" rule are
 * enforced deterministically in code, never left to the model (plan §5).
 *
 * This script is READ-ONLY against the database: every data read goes
 * through the RLS-scoped client (the service-role admin client only
 * bootstraps the auth session, exactly like eval-illustration.ts /
 * eval-memory-book-audit.ts).
 *
 * PII rule: memory `content` text and the model's `description` field are
 * used to build prompts and are written to results.jsonl/review.html (an
 * own-account, gitignored review artifact -- sanctioned by plan §9's V1c
 * row for the same class of output) but are NEVER printed to stdout --
 * console output is ids, dates, counts, and progress only.
 *
 * Examples:
 *   npm run eval:memory-book-tagging -- --dry-run
 *   npm run eval:memory-book-tagging -- --limit 20
 *   npm run eval:memory-book-tagging -- --memory-id <uuid> --memory-id <uuid>
 *   npm run eval:memory-book-tagging -- --resume supabase/scripts/eval-output/memory-book-tagging/<runId>/results.jsonl
 *   npm run eval:memory-book-tagging -- --mode discovery --limit 50
 *   npm run eval:memory-book-tagging -- --mode controlled --limit 50
 *
 * `--mode` (default `strict`) only changes the topics/themes axis:
 * `discovery` asks the model to list candidate themes with a confidence
 * score even when tentative (recall-leaning, for spotting themes the
 * strict/precision-first prompt misses); `strict` is the plan's default
 * precision-first open-vocabulary behavior; `controlled` (V1c) replaces
 * open-vocabulary themes entirely with 0-3 topic ids drawn from the
 * approved vocabulary in docs/plans/topic-vocabulary.md, precision-first,
 * with deterministic date-gating applied in code after parsing (a topic
 * tied to a calendar occasion is dropped -- and recorded in
 * `topicsDateGated` -- when the memory date isn't plausible for it).
 * Every other axis (labels/description/emotion/occasion/milestone, and the
 * milestone "explicit text only" rule) is identical across all three modes.
 *
 * Requires Supabase vars in supabase/.env.local, R2 vars for image fetches,
 * and OPENAI_API_KEY (unless --dry-run).
 * DB/R2/OpenAI env access is not available in every environment this script
 * runs in -- it must typecheck even when it cannot be executed.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { getAgeInYearsAtDate } from '../functions/_shared/age.ts';
import { getObjectBytes } from '../functions/_shared/r2.ts';
import { EMOTION_PALETTES, normalizeEmotion } from '../functions/_shared/prompts.ts';

// ── CLI ──────────────────────────────────────────────────────────────────

export type TaggingMode = 'discovery' | 'strict' | 'controlled';

interface CliOptions {
  limit: number;
  offset: number;
  memoryIds: string[];
  model: string;
  concurrency: number;
  maxImages: number;
  resume: string | null;
  dryRun: boolean;
  mode: TaggingMode;
}

const DEFAULT_MODEL = 'gpt-4o-mini';

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    limit: Infinity,
    offset: 0,
    memoryIds: [],
    model: DEFAULT_MODEL,
    concurrency: 4,
    maxImages: 4,
    resume: null,
    dryRun: false,
    mode: 'strict',
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    switch (arg) {
      case '--limit':
        options.limit = Number(next) || Infinity;
        index += 1;
        break;
      case '--offset':
        options.offset = Number(next) || 0;
        index += 1;
        break;
      case '--memory-id':
        if (next) options.memoryIds.push(next);
        index += 1;
        break;
      case '--model':
        if (next) options.model = next;
        index += 1;
        break;
      case '--concurrency':
        options.concurrency = Number(next) || options.concurrency;
        index += 1;
        break;
      case '--max-images':
        options.maxImages = Number(next) || options.maxImages;
        index += 1;
        break;
      case '--resume':
        options.resume = next ?? null;
        index += 1;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--mode':
        if (next === 'discovery' || next === 'strict' || next === 'controlled') options.mode = next;
        index += 1;
        break;
      default:
        break;
    }
  }

  return options;
}

// ── Row shapes (hand-typed -- matches src/types/database.ts) ───────────────

interface FamilyRow {
  id: string;
  name: string;
}

interface MemoryRow {
  id: string;
  family_id: string;
  content: string | null;
  memory_date: string;
  memory_type: string;
  emotion: string | null;
  illustration_key: string | null;
}

interface MediaRow {
  id: string;
  memory_id: string;
  object_key: string;
  content_type: string;
  duration_ms: number | null;
  position: number;
  preview_object_key: string | null;
}

interface FamilyMemberRow {
  id: string;
  name: string;
  date_of_birth: string | null;
}

interface TagRow {
  memory_id: string;
  family_member_id: string;
}

// ── Auth (same pattern as eval-illustration.ts / eval-memory-book-audit.ts) ─

async function createAuthedClient() {
  const supabaseUrl = Deno.env.get('EXPO_PUBLIC_SUPABASE_URL') ?? Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = Deno.env.get('EXPO_PUBLIC_SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_ANON_KEY');
  const userEmail = Deno.env.get('EVAL_USER_EMAIL') ?? 'eduardoyi@gmail.com';

  if (!supabaseUrl || !serviceRoleKey || !anonKey) {
    throw new Error('Missing Supabase env vars in supabase/.env.local');
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: userEmail,
  });

  if (linkError || !linkData.properties?.hashed_token) {
    throw new Error(linkError?.message ?? 'Failed to generate auth link');
  }

  const client = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: sessionData, error: sessionError } = await client.auth.verifyOtp({
    type: 'magiclink',
    token_hash: linkData.properties.hashed_token,
  });

  if (sessionError || !sessionData.session?.access_token) {
    throw new Error(sessionError?.message ?? 'Failed to create session');
  }

  return createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${sessionData.session.access_token}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

type AuthedClient = Awaited<ReturnType<typeof createAuthedClient>>;

// ── Small utilities ─────────────────────────────────────────────────────

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

const CHUNK_SIZE = 200;
const PAGE_SIZE = 1000;

/**
 * Loops `.range()` pages until one comes back shorter than PAGE_SIZE.
 * Supabase's hosted PostgREST caps any un-paginated select at 1000 rows --
 * trusting a single un-paginated call would silently truncate any
 * family/chunk with more rows than that. `.range()` offsets are only stable
 * relative to a fixed sort order, so every caller must attach a
 * deterministic `.order()` (unique column(s)) to the query it hands in.
 */
async function fetchAllRows<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  errorLabel: string,
): Promise<T[]> {
  const out: T[] = [];
  let from = 0;

  for (;;) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);

    if (error) {
      throw new Error(`Failed to load ${errorLabel}: ${error.message}`);
    }

    const rows = data ?? [];
    out.push(...rows);

    if (rows.length < PAGE_SIZE) {
      break;
    }

    from += PAGE_SIZE;
  }

  return out;
}

/** Fixed-size worker pool over a shared index cursor -- same pattern as
 * eval-memory-book-audit.ts's runPool(). */
async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker()));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Pure date math (no Date object round-tripping -- see addYears below) ───

/**
 * Adds `years` to a `YYYY-MM-DD` date string without ever round-tripping
 * through a `Date` object: `new Date('YYYY-MM-DDT00:00:00')` parses in local
 * time but `toISOString()` renders in UTC, so on a UTC-positive machine the
 * sliced result silently lands on the previous day. Plain string/number
 * arithmetic sidesteps timezones entirely. (Copied from
 * eval-memory-book-audit.ts -- same precedent, self-contained eval script.)
 */
function addYears(dateStr: string, years: number): string {
  const { year, month, day } = parseDateParts(dateStr);
  const newYear = year + years;

  const isLeapYear = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const clampedDay = month === 2 && day === 29 && !isLeapYear(newYear) ? 28 : day;

  return `${String(newYear).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(clampedDay).padStart(2, '0')}`;
}

function parseDateParts(dateStr: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) {
    throw new Error(`Unexpected date format "${dateStr}"`);
  }
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function pad4(n: number): string {
  return String(n).padStart(4, '0');
}

/**
 * Gregorian calendar date -> Julian Day Number, via the standard integer
 * formula (Fliegel & Van Flandern). Pure integer arithmetic, no `Date`
 * object anywhere -- lets every date-distance calculation below (birthday
 * proximity, holiday proximity, day-of-week) work in exact whole days with
 * no timezone exposure at all.
 */
export function toJulianDayNumber(dateStr: string): number {
  const { year: y, month: m, day: d } = parseDateParts(dateStr);
  const a = Math.floor((14 - m) / 12);
  const y2 = y + 4800 - a;
  const m2 = m + 12 * a - 3;
  return (
    d +
    Math.floor((153 * m2 + 2) / 5) +
    365 * y2 +
    Math.floor(y2 / 4) -
    Math.floor(y2 / 100) +
    Math.floor(y2 / 400) -
    32045
  );
}

/** 0=Sunday .. 6=Saturday, derived from the JDN (verified against known
 * reference date 2000-01-01 = Saturday). */
function dayOfWeek(dateStr: string): number {
  return (toJulianDayNumber(dateStr) + 1) % 7;
}

/** The date of the n-th occurrence of `weekday` (0=Sunday..6=Saturday) in a
 * given month/year -- used for Thanksgiving (4th Thursday of November). */
function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): string {
  const firstOfMonth = `${pad4(year)}-${pad2(month)}-01`;
  const firstDow = dayOfWeek(firstOfMonth);
  const dayOffset = (weekday - firstDow + 7) % 7;
  const day = 1 + dayOffset + (n - 1) * 7;
  return `${pad4(year)}-${pad2(month)}-${pad2(day)}`;
}

/**
 * Age in whole months at `referenceDate`, pure calendar arithmetic (no Date
 * object). Returns null if `referenceDate` is before `dateOfBirth`.
 */
export function ageInMonthsAtDate(dateOfBirth: string, referenceDate: string): number | null {
  const birth = parseDateParts(dateOfBirth);
  const ref = parseDateParts(referenceDate);
  let months = (ref.year - birth.year) * 12 + (ref.month - birth.month);
  if (ref.day < birth.day) {
    months -= 1;
  }
  return months < 0 ? null : months;
}

export function classifyChildOrAdult(ageYears: number | null): 'child' | 'adult' | 'unknown' {
  if (ageYears === null) {
    return 'unknown';
  }
  return ageYears < 13 ? 'child' : 'adult';
}

interface NearestBirthday {
  date: string;
  diffDays: number;
}

/** The birthday anniversary (in the year before/of/after `referenceDate`)
 * closest to `referenceDate`, with a signed day distance (positive = still
 * to come, negative = already passed). */
function nearestBirthdayAnniversary(dateOfBirth: string, referenceDate: string): NearestBirthday {
  const birthYear = parseDateParts(dateOfBirth).year;
  const refYear = parseDateParts(referenceDate).year;
  const refJdn = toJulianDayNumber(referenceDate);

  let best: NearestBirthday | null = null;
  for (const candidateYear of [refYear - 1, refYear, refYear + 1]) {
    const anniversary = addYears(dateOfBirth, candidateYear - birthYear);
    const diffDays = toJulianDayNumber(anniversary) - refJdn;
    if (!best || Math.abs(diffDays) < Math.abs(best.diffDays)) {
      best = { date: anniversary, diffDays };
    }
  }
  return best!;
}

/** Signed distance in days from `referenceDate` to the tagged member's
 * nearest birthday anniversary (plan §5 Stage A structured context). */
export function daysToBirthday(dateOfBirth: string, referenceDate: string): number {
  return nearestBirthdayAnniversary(dateOfBirth, referenceDate).diffDays;
}

export interface BirthdayMatchMember {
  id: string;
  name: string;
  dateOfBirth: string | null;
}

export interface BirthdayMatch {
  memberName: string;
  ageTurned: number;
  /** Signed: memory_date minus the anniversary date (positive = memory is
   * after the anniversary, negative = before it). */
  daysOffset: number;
}

export interface BirthMatch {
  memberName: string;
  /** Signed: memory_date minus the actual date_of_birth. */
  daysFromBirth: number;
}

export interface BirthdayMatchResult {
  birthdayMatch: BirthdayMatch | null;
  birthMatch: BirthMatch | null;
}

/**
 * Deterministic whose-birthday resolution (plan §5: "never guessed by the
 * model"): any tagged member whose birthday anniversary falls within
 * `windowDays` of `memoryDate` is a candidate. A candidate whose nearest
 * anniversary IS the birth itself (ageTurned <= 0 -- the anniversary year
 * equals or precedes the birth year) is a "birth" memory, not a birthday,
 * and is reported separately as `birthMatch` (newborn-week memories say
 * "birth", not "1st birthday"). Within each of the two buckets, when more
 * than one member matches (rare -- twins, or two members close in the
 * window), the closest anniversary wins; ties break on member id for
 * determinism.
 */
export function computeBirthdayMatch(
  members: BirthdayMatchMember[],
  memoryDate: string,
  windowDays = 7,
): BirthdayMatchResult {
  let bestBirthday: { id: string; memberName: string; ageTurned: number; diffDays: number } | null = null;
  let bestBirth: { id: string; memberName: string; diffDays: number } | null = null;

  for (const member of members) {
    if (!member.dateOfBirth) continue;

    const nearest = nearestBirthdayAnniversary(member.dateOfBirth, memoryDate);
    if (Math.abs(nearest.diffDays) > windowDays) continue;

    const ageTurned = parseDateParts(nearest.date).year - parseDateParts(member.dateOfBirth).year;
    const absDiff = Math.abs(nearest.diffDays);

    if (ageTurned < 1) {
      if (
        !bestBirth ||
        absDiff < Math.abs(bestBirth.diffDays) ||
        (absDiff === Math.abs(bestBirth.diffDays) && member.id < bestBirth.id)
      ) {
        bestBirth = { id: member.id, memberName: member.name, diffDays: nearest.diffDays };
      }
      continue;
    }

    if (
      !bestBirthday ||
      absDiff < Math.abs(bestBirthday.diffDays) ||
      (absDiff === Math.abs(bestBirthday.diffDays) && member.id < bestBirthday.id)
    ) {
      bestBirthday = { id: member.id, memberName: member.name, ageTurned, diffDays: nearest.diffDays };
    }
  }

  return {
    birthdayMatch: bestBirthday
      ? { memberName: bestBirthday.memberName, ageTurned: bestBirthday.ageTurned, daysOffset: -bestBirthday.diffDays }
      : null,
    birthMatch: bestBirth ? { memberName: bestBirth.memberName, daysFromBirth: -bestBirth.diffDays } : null,
  };
}

export interface NearbyHoliday {
  name: string;
  date: string;
  daysAway: number;
}

const FIXED_HOLIDAYS: Array<{ name: string; month: number; day: number }> = [
  { name: "New Year's Day", month: 1, day: 1 },
  { name: "Valentine's Day", month: 2, day: 14 },
  { name: 'Halloween', month: 10, day: 31 },
  { name: 'Christmas', month: 12, day: 25 },
  { name: "New Year's Eve", month: 12, day: 31 },
];

/**
 * Holidays within `windowDays` of `memoryDate` (plan §5 structured context
 * "proximity to major holidays"). Easter, Mother's Day, and Father's Day are
 * deliberately omitted (movable/ambiguous -- see the implementation brief).
 * Thanksgiving (US, 4th Thursday of November) is computed via
 * nthWeekdayOfMonth rather than a fixed day-of-month.
 */
export function nearbyHolidays(memoryDate: string, windowDays = 10): NearbyHoliday[] {
  const { year } = parseDateParts(memoryDate);
  const refJdn = toJulianDayNumber(memoryDate);
  const results: NearbyHoliday[] = [];

  for (const candidateYear of [year - 1, year, year + 1]) {
    for (const holiday of FIXED_HOLIDAYS) {
      const dateStr = `${pad4(candidateYear)}-${pad2(holiday.month)}-${pad2(holiday.day)}`;
      const daysAway = toJulianDayNumber(dateStr) - refJdn;
      if (Math.abs(daysAway) <= windowDays) {
        results.push({ name: holiday.name, date: dateStr, daysAway });
      }
    }

    const thanksgiving = nthWeekdayOfMonth(candidateYear, 11, 4, 4);
    const thanksgivingDaysAway = toJulianDayNumber(thanksgiving) - refJdn;
    if (Math.abs(thanksgivingDaysAway) <= windowDays) {
      results.push({ name: 'Thanksgiving (US)', date: thanksgiving, daysAway: thanksgivingDaysAway });
    }
  }

  results.sort((a, b) => Math.abs(a.daysAway) - Math.abs(b.daysAway));
  return results;
}

// ── Milestone catalog (parsed at runtime from docs/plans/milestone-catalog.md) ─

export interface MilestoneCatalogEntry {
  id: string;
  name: string;
  band: string;
}

const CATALOG_ROW_PATTERN = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/;

/**
 * Parses `| id | Milestone | Band | Example explicit cues |` table rows out
 * of docs/plans/milestone-catalog.md. Skips header rows (`id` cell literally
 * "id") and separator rows (`---`). V1a intentionally passes ALL catalog
 * entries with no age-band filtering (per the implementation brief) -- V1a
 * is a discovery pass; we want to see raw claims before deciding what a
 * child's age band should suppress.
 */
export function parseMilestoneCatalog(markdown: string): MilestoneCatalogEntry[] {
  const entries: MilestoneCatalogEntry[] = [];

  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) continue;

    const match = CATALOG_ROW_PATTERN.exec(line);
    if (!match) continue;

    const id = match[1].trim();
    const name = match[2].trim();
    const band = match[3].trim();

    if (!id || id.toLowerCase() === 'id' || /^-+$/.test(id)) continue;

    entries.push({ id, name, band });
  }

  return entries;
}

export function formatMilestoneCatalogForPrompt(entries: MilestoneCatalogEntry[]): string {
  return entries.map((entry) => `${entry.id} — ${entry.name} (${entry.band})`).join('\n');
}

async function loadMilestoneCatalog(): Promise<MilestoneCatalogEntry[]> {
  const catalogUrl = new URL('../../docs/plans/milestone-catalog.md', import.meta.url);
  const markdown = await Deno.readTextFile(catalogUrl);
  return parseMilestoneCatalog(markdown);
}

// ── Topic vocabulary (V1c controlled mode; parsed at runtime from
// docs/plans/topic-vocabulary.md) ───────────────────────────────────────

export const TOPIC_VOCAB_VERSION = 'v2.1';

export interface TopicVocabularyEntry {
  id: string;
  pageTitle: string;
  covers: string;
}

/**
 * Matches only the vocabulary tables' rows: the id cell is backtick-wrapped
 * (optionally followed by the `✦` "added in v2" marker), e.g.
 * "| `beach` | A day at the beach | Beach, sand, sea, seaside. | 8 | ... |".
 * Requiring backticks on the id cell is what lets this skip header rows
 * (`| id | Page title | ... |`), separator rows (`|---|...|`), AND the
 * doc's other table ("Concepts owned by other axes"), whose first column is
 * bold text like `**Emotion**` -- no backticks -- rather than a topic id.
 */
const TOPIC_ROW_PATTERN = /^\|\s*`([a-z0-9-]+)`\s*✦?\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/;

/**
 * Parses `| \`id\` [✦] | Page title | Covers | Source archive | Top raw
 * themes |` table rows out of docs/plans/topic-vocabulary.md. Strips the
 * backticks and the ✦ "added in v2" marker from the id (neither belongs in
 * the id string itself -- see TOPIC_ROW_PATTERN's doc comment for how
 * unrelated tables are excluded).
 */
export function parseTopicVocabulary(markdown: string): TopicVocabularyEntry[] {
  const entries: TopicVocabularyEntry[] = [];

  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) continue;

    const match = TOPIC_ROW_PATTERN.exec(line);
    if (!match) continue;

    entries.push({ id: match[1].trim(), pageTitle: match[2].trim(), covers: match[3].trim() });
  }

  return entries;
}

export function formatTopicVocabularyForPrompt(entries: TopicVocabularyEntry[]): string {
  return entries.map((entry) => `${entry.id} — ${entry.pageTitle}: ${entry.covers}`).join('\n');
}

async function loadTopicVocabulary(): Promise<TopicVocabularyEntry[]> {
  const vocabUrl = new URL('../../docs/plans/topic-vocabulary.md', import.meta.url);
  const markdown = await Deno.readTextFile(vocabUrl);
  return parseTopicVocabulary(markdown);
}

/**
 * The doc's "Dropped catch-alls" (v1's 674-raw-token junk-drawer tags) plus
 * the 3 additional catch-alls freed up by dropping `home-life` (Review
 * decision #3) -- hardcoded from docs/plans/topic-vocabulary.md ("Dropped
 * catch-alls" section + Review decision #3), not parsed, since they are
 * prose, not a table.
 */
export const NEGATIVE_EXAMPLES: string[] = [
  'playtime',
  'family time',
  'family moments',
  'family bonding',
  'smiles',
  'celebration',
  'growing up',
  'family fun',
  'toddler fun',
  'togetherness',
  'exploring',
  'playful moments',
  'happy moments',
  'childhood',
  'everyday moments',
  'adventure',
  'cozy moments',
  'home activities',
  'indoor fun',
];

// ── Topic assignment parsing + validation (V1c controlled mode) ─────────

export interface TopicAssignment {
  id: string;
  detail: string | null;
}

const MAX_TOPICS = 3;

/** These 4 topic ids carry a required `detail` (canonical English name);
 * every other topic's `detail` is forced to null regardless of what the
 * model sends. */
const TOPICS_REQUIRING_DETAIL = new Set(['other-holiday', 'national-holiday', 'ceremony', 'mothers-fathers-day']);

/** `"Beach Day"` / `"beach_day"` -> `"beach-day"` -- lets a near-miss id
 * shape still resolve against the vocabulary (exact match only; this is
 * NOT fuzzy matching, just format normalization). */
function normalizeTopicId(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

/** First string-typed value found among `candidates` (in order), or null.
 * Used to read an id/detail off whichever key name the model actually
 * used. */
function firstStringValue(candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate;
    }
  }
  return null;
}

/** Whether a raw JSON value should count as "the model sent something for
 * topics" for the topicsRawUnparsed diagnostic tripwire: null/undefined and
 * empty arrays/strings don't count (those are legitimate "no topics"
 * answers), everything else does. */
function isNonEmptyRawValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

const REJECTED_ITEM_PREVIEW_MAX_CHARS = 60;

/** A short, safe-to-log preview of a topics-array item that couldn't be
 * turned into an id at all, so "never silently drop" still leaves a trace
 * of WHAT was dropped in topicsRejected. */
function previewRejectedItem(item: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(item) ?? String(item);
  } catch {
    json = String(item);
  }
  return json.length > REJECTED_ITEM_PREVIEW_MAX_CHARS
    ? `${json.slice(0, REJECTED_ITEM_PREVIEW_MAX_CHARS)}…`
    : json;
}

/**
 * Parses+validates the model's raw `topics` field against the approved
 * vocabulary. Tolerant by design (mirrors parseThemes' tolerance for a
 * bare string in discovery mode) because models don't reliably follow the
 * requested `{"id": string, "detail": string|null}` shape -- a live run
 * that only ever produces `topics: ["beach"]` or `[{"topic": "beach"}]`
 * must still resolve `beach`, not silently produce zero topics with no
 * bookkeeping trail:
 *
 * - A bare string item is read as the id directly.
 * - An object item's id is read from `id` ?? `topic` ?? `name` ?? `theme`
 *   (first string-typed key present); its detail from `detail` ?? `note`.
 * - Every resolved id is normalized (trim, lowercase, spaces/underscores
 *   -> hyphens) BEFORE the vocabulary check, so a stylistic mismatch like
 *   "Beach Day" still resolves if it exactly equals a vocab id after
 *   normalization (NOT fuzzy matching).
 * - An id not in `vocabIds` (even after normalization) is dropped and
 *   recorded in `topicsRejected` as the normalized string.
 * - An item that yields no id at all (wrong shape entirely -- not a
 *   string, no id/topic/name/theme key) is STILL recorded in
 *   `topicsRejected`, as a short JSON preview -- nothing is ever silently
 *   dropped with zero trace.
 * - A required-detail topic (see TOPICS_REQUIRING_DETAIL) missing its
 *   detail is KEPT (per plan brief -- the topic assignment itself may
 *   still be right even if the model forgot the detail) but recorded in
 *   `topicsMissingDetail`.
 *
 * Caps at MAX_TOPICS after validation (mirrors parseThemes: build the full
 * valid list, then cap).
 */
export function parseTopics(
  value: unknown,
  vocabIds: Set<string>,
): { topics: TopicAssignment[]; topicsRejected: string[]; topicsMissingDetail: string[] } {
  const topics: TopicAssignment[] = [];
  const topicsRejected: string[] = [];
  const topicsMissingDetail: string[] = [];

  if (!Array.isArray(value)) {
    return { topics, topicsRejected, topicsMissingDetail };
  }

  for (const item of value) {
    let rawId: string | null = null;
    let rawDetail: string | null = null;

    if (typeof item === 'string') {
      rawId = item;
    } else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      rawId = firstStringValue([o.id, o.topic, o.name, o.theme]);
      rawDetail = firstStringValue([o.detail, o.note]);
    }

    if (!rawId) {
      // Wrong shape entirely -- still traced, never silently dropped.
      topicsRejected.push(previewRejectedItem(item));
      continue;
    }

    const normalizedId = normalizeTopicId(rawId);

    if (!vocabIds.has(normalizedId)) {
      topicsRejected.push(normalizedId);
      continue;
    }

    const requiresDetail = TOPICS_REQUIRING_DETAIL.has(normalizedId);
    const detail = requiresDetail && rawDetail ? rawDetail.trim() || null : null;

    if (requiresDetail && !detail) {
      topicsMissingDetail.push(normalizedId);
    }

    topics.push({ id: normalizedId, detail });
  }

  return { topics: topics.slice(0, MAX_TOPICS), topicsRejected, topicsMissingDetail };
}

// ── Date gating for calendar-bound topics (V1c controlled mode) ─────────
//
// Applied in CODE, after parsing (plan brief item 2) -- never trusted from
// the model. A topic tied to a real calendar occasion only survives when
// `memory_date` is plausible for it; otherwise it's removed and recorded in
// `topicsDateGated`. `other-holiday`/`national-holiday`/`ceremony` are never
// gated -- their required `detail` carries the meaning instead of a date
// window (per plan brief item 2 and topic-vocabulary.md's "Date gating for
// occasions" section). `mothers-fathers-day` DOES carry a required detail
// but IS gated (it's listed under "Computable" in the brief).

/** Fixed month-day windows ("MM-DD" strings, zero-padded so lexicographic
 * comparison equals calendar order). A `start > end` pair means the window
 * wraps the year boundary (e.g. christmas: Dec 15 -> Jan 6). */
const FIXED_DATE_WINDOWS: Record<string, { start: string; end: string }> = {
  christmas: { start: '12-15', end: '01-06' },
  'new-year': { start: '12-26', end: '01-07' },
  halloween: { start: '10-21', end: '11-03' },
  valentines: { start: '02-07', end: '02-21' },
  'dia-de-muertos': { start: '10-25', end: '11-09' },
};

/**
 * Per-year central dates for movable holidays 2022-2027 (approximate is
 * fine per plan brief item 2 -- these are eval-only date-plausibility
 * gates, not liturgical calendars). Eid = Eid al-Fitr; Hanukkah = first
 * night. A year outside this table has no gate data and fails closed (the
 * topic is treated as NOT date-plausible -- see isTopicWithinDateWindow).
 */
const MOVABLE_HOLIDAY_DATES: Record<string, Record<number, string>> = {
  easter: {
    2022: '2022-04-17',
    2023: '2023-04-09',
    2024: '2024-03-31',
    2025: '2025-04-20',
    2026: '2026-04-05',
    2027: '2027-03-28',
  },
  eid: {
    2022: '2022-05-02',
    2023: '2023-04-21',
    2024: '2024-04-10',
    2025: '2025-03-30',
    2026: '2026-03-20',
    2027: '2027-03-09',
  },
  diwali: {
    2022: '2022-10-24',
    2023: '2023-11-12',
    2024: '2024-11-01',
    2025: '2025-10-20',
    2026: '2026-11-08',
    2027: '2027-10-29',
  },
  hanukkah: {
    2022: '2022-12-18',
    2023: '2023-12-07',
    2024: '2024-12-25',
    2025: '2025-12-14',
    2026: '2026-12-04',
    2027: '2027-12-24',
  },
  'lunar-new-year': {
    2022: '2022-02-01',
    2023: '2023-01-22',
    2024: '2024-02-10',
    2025: '2025-01-29',
    2026: '2026-02-17',
    2027: '2027-01-26',
  },
};

/** Topic ids never subject to date gating -- their required `detail`
 * carries the specific meaning instead. */
const NEVER_DATE_GATED = new Set(['other-holiday', 'national-holiday', 'ceremony']);

const DATE_GATED_TOPIC_IDS = new Set<string>([
  ...Object.keys(FIXED_DATE_WINDOWS),
  ...Object.keys(MOVABLE_HOLIDAY_DATES),
  'thanksgiving',
  'mothers-fathers-day',
]);

function monthDayString(month: number, day: number): string {
  return `${pad2(month)}-${pad2(day)}`;
}

/** Whether month-day `md` falls in [start, end], where start > end means
 * the window wraps the year boundary. */
function isMonthDayInRange(md: string, start: string, end: string): boolean {
  if (start <= end) {
    return md >= start && md <= end;
  }
  return md >= start || md <= end;
}

function isWithinDaysOfAny(memoryDate: string, candidates: string[], windowDays: number): boolean {
  const refJdn = toJulianDayNumber(memoryDate);
  return candidates.some((candidate) => Math.abs(toJulianDayNumber(candidate) - refJdn) <= windowDays);
}

/**
 * Whether `memoryDate` is calendar-plausible for `topicId`. Returns `true`
 * for any topic that isn't date-gated at all (nothing to check). Exported
 * for direct unit testing (in-window / out-of-window / year-boundary
 * wraparound) independent of the array-level `gateTopicsByDate`.
 */
export function isTopicWithinDateWindow(topicId: string, memoryDate: string): boolean {
  const { year, month, day } = parseDateParts(memoryDate);

  const fixedWindow = FIXED_DATE_WINDOWS[topicId];
  if (fixedWindow) {
    return isMonthDayInRange(monthDayString(month, day), fixedWindow.start, fixedWindow.end);
  }

  if (topicId === 'thanksgiving') {
    // 4th Thursday of November -- only ever near the boundary of its own
    // year (late Nov ± 7 days never reaches Jan), so a single year's
    // computed date is enough.
    return isWithinDaysOfAny(memoryDate, [nthWeekdayOfMonth(year, 11, 4, 4)], 7);
  }

  if (topicId === 'mothers-fathers-day') {
    const mothersDay = nthWeekdayOfMonth(year, 5, 0, 2); // 2nd Sunday of May
    const fathersDay = nthWeekdayOfMonth(year, 6, 0, 3); // 3rd Sunday of June
    return isWithinDaysOfAny(memoryDate, [mothersDay, fathersDay], 7);
  }

  const movableTable = MOVABLE_HOLIDAY_DATES[topicId];
  if (movableTable) {
    const candidateDate = movableTable[year];
    if (!candidateDate) return false; // outside the 2022-2027 table -- fail closed.
    return isWithinDaysOfAny(memoryDate, [candidateDate], 10);
  }

  return true; // Not a date-gated topic at all.
}

export interface TopicDateGateResult {
  topics: TopicAssignment[];
  dateGated: string[];
}

/**
 * Removes any date-gated topic whose window doesn't cover `memoryDate`,
 * recording the removed ids in `dateGated` (plan brief item 2: "A
 * date-gated topic outside its window is REMOVED from `topics` and
 * recorded in `topicsDateGated`").
 */
export function gateTopicsByDate(topics: TopicAssignment[], memoryDate: string): TopicDateGateResult {
  const surviving: TopicAssignment[] = [];
  const dateGated: string[] = [];

  for (const topic of topics) {
    const isGated = DATE_GATED_TOPIC_IDS.has(topic.id) && !NEVER_DATE_GATED.has(topic.id);
    if (!isGated || isTopicWithinDateWindow(topic.id, memoryDate)) {
      surviving.push(topic);
    } else {
      dateGated.push(topic.id);
    }
  }

  return { topics: surviving, dateGated };
}

// ── Data loading (RLS-scoped client for every read) ────────────────────

async function loadFamilies(supabase: AuthedClient): Promise<FamilyRow[]> {
  const { data, error } = await supabase.from('families').select('id, name').is('deleted_at', null);

  if (error) {
    throw new Error(`Failed to load families: ${error.message}`);
  }

  return (data ?? []) as FamilyRow[];
}

async function loadMemories(supabase: AuthedClient, familyId: string): Promise<MemoryRow[]> {
  return fetchAllRows<MemoryRow>(
    (from, to) =>
      supabase
        .from('memories')
        .select('id, family_id, content, memory_date, memory_type, emotion, illustration_key')
        .eq('family_id', familyId)
        .order('memory_date', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    'memories',
  );
}

async function loadMediaForMemories(supabase: AuthedClient, memoryIds: string[]): Promise<MediaRow[]> {
  const out: MediaRow[] = [];
  for (const ids of chunk(memoryIds, CHUNK_SIZE)) {
    if (ids.length === 0) continue;
    const rows = await fetchAllRows<MediaRow>(
      (from, to) =>
        supabase
          .from('memory_media')
          .select('id, memory_id, object_key, content_type, duration_ms, position, preview_object_key')
          .in('memory_id', ids)
          .order('memory_id', { ascending: true })
          .order('position', { ascending: true })
          .range(from, to),
      'memory_media',
    );
    out.push(...rows);
  }
  return out;
}

async function loadTagsForMemories(supabase: AuthedClient, memoryIds: string[]): Promise<TagRow[]> {
  const out: TagRow[] = [];
  for (const ids of chunk(memoryIds, CHUNK_SIZE)) {
    if (ids.length === 0) continue;
    const rows = await fetchAllRows<TagRow>(
      (from, to) =>
        supabase
          .from('memory_family_members')
          .select('memory_id, family_member_id')
          .in('memory_id', ids)
          // Composite PK (memory_id, family_member_id) -- no single id
          // column, so both make up the deterministic sort key.
          .order('memory_id', { ascending: true })
          .order('family_member_id', { ascending: true })
          .range(from, to),
      'memory_family_members',
    );
    out.push(...rows);
  }
  return out;
}

async function loadFamilyMembers(supabase: AuthedClient, familyId: string): Promise<FamilyMemberRow[]> {
  const { data, error } = await supabase
    .from('family_members')
    .select('id, name, date_of_birth')
    .eq('family_id', familyId);

  if (error) {
    throw new Error(`Failed to load family_members: ${error.message}`);
  }

  return (data ?? []) as FamilyMemberRow[];
}

// ── Image source selection ─────────────────────────────────────────────

type ImageSource = 'preview' | 'fallback_original' | 'skipped_heic_no_preview' | 'skipped_video_no_poster' | 'skipped_unsupported';

interface ImageCandidate {
  mediaId: string;
  source: ImageSource;
  objectKey: string | null;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp' | null;
}

const FALLBACK_ORIGINAL_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * Per plan brief: prefer `preview_object_key` (always JPEG, present for
 * both photo previews and video poster frames) for every media row, in
 * `position` order. If missing, fall back to the original ONLY for
 * jpeg/png/webp photos (sent as-is); HEIC/HEIF originals without a preview
 * and videos without a poster are skipped and counted, never fetched.
 */
export function selectImageCandidates(media: MediaRow[]): ImageCandidate[] {
  return media.map((row) => {
    if (row.preview_object_key) {
      return { mediaId: row.id, source: 'preview', objectKey: row.preview_object_key, contentType: 'image/jpeg' };
    }

    if (FALLBACK_ORIGINAL_CONTENT_TYPES.has(row.content_type)) {
      return {
        mediaId: row.id,
        source: 'fallback_original',
        objectKey: row.object_key,
        contentType: row.content_type as 'image/jpeg' | 'image/png' | 'image/webp',
      };
    }

    const isVideo = row.content_type.startsWith('video/');
    return {
      mediaId: row.id,
      source: isVideo ? 'skipped_video_no_poster' : 'skipped_heic_no_preview',
      objectKey: null,
      contentType: null,
    };
  });
}

function extensionForContentType(contentType: string): string {
  if (contentType === 'image/png') return 'png';
  if (contentType === 'image/webp') return 'webp';
  return 'jpg';
}

// ── Structured per-memory context ──────────────────────────────────────

export interface MemberContext {
  memberId: string;
  firstName: string;
  ageYears: number | null;
  ageMonths: number | null; // only populated under 24 months, per brief
  personType: 'child' | 'adult' | 'unknown';
  daysToBirthday: number | null;
}

export interface MemoryContext {
  memoryDate: string;
  members: MemberContext[];
  holidays: NearbyHoliday[];
}

export function buildMemoryContext(
  memoryDate: string,
  taggedMembers: FamilyMemberRow[],
): MemoryContext {
  const members: MemberContext[] = taggedMembers.map((member) => {
    const ageYears = member.date_of_birth ? getAgeInYearsAtDate(member.date_of_birth, memoryDate) : null;
    const ageMonthsRaw = member.date_of_birth ? ageInMonthsAtDate(member.date_of_birth, memoryDate) : null;
    const ageMonths = ageMonthsRaw !== null && ageMonthsRaw < 24 ? ageMonthsRaw : null;

    return {
      memberId: member.id,
      firstName: member.name.trim().split(/\s+/)[0] || member.name,
      ageYears,
      ageMonths,
      personType: classifyChildOrAdult(ageYears),
      daysToBirthday: member.date_of_birth ? daysToBirthday(member.date_of_birth, memoryDate) : null,
    };
  });

  return { memoryDate, members, holidays: nearbyHolidays(memoryDate) };
}

function describeDaysToBirthday(days: number): string {
  if (days === 0) return 'birthday today';
  if (days > 0) return `birthday in ${days}d`;
  return `birthday ${Math.abs(days)}d ago`;
}

function renderContextText(context: MemoryContext): string {
  const lines: string[] = [];
  lines.push(`Entry date: ${context.memoryDate}`);

  if (context.members.length > 0) {
    lines.push('Tagged people:');
    for (const member of context.members) {
      const ageDesc =
        member.ageYears === null
          ? 'age unknown'
          : member.ageMonths !== null
            ? `${member.ageYears}y (${member.ageMonths} months)`
            : `${member.ageYears}y`;
      const birthdayDesc = member.daysToBirthday === null ? '' : `, ${describeDaysToBirthday(member.daysToBirthday)}`;
      lines.push(`- ${member.firstName}: ${ageDesc}, ${member.personType}${birthdayDesc}`);
    }
  } else {
    lines.push('Tagged people: none');
  }

  if (context.holidays.length > 0) {
    const holidayDesc = context.holidays
      .map((h) => `${h.name} (${h.daysAway >= 0 ? `in ${h.daysAway}d` : `${Math.abs(h.daysAway)}d ago`})`)
      .join(', ');
    lines.push(`Nearby holidays: ${holidayDesc}`);
  } else {
    lines.push('Nearby holidays: none');
  }

  return lines.join('\n');
}

// ── Prompt construction ─────────────────────────────────────────────────

/**
 * `strict` (default) is precision-first: 0-4 plain-string themes, only ones
 * the model is confident in. `discovery` is recall-leaning: up to 4
 * candidate themes even if tentative, each carrying a confidence score, so a
 * later pass can see themes the strict prompt suppressed. `controlled` (V1c)
 * doesn't use this at all -- see buildTopicsInstruction. Every other axis
 * (labels/description/emotion/occasion/milestone) is worded identically
 * across all three modes -- the milestone "explicit text only" rule is
 * never relaxed.
 */
function buildThemesInstruction(mode: TaggingMode): string {
  if (mode === 'discovery') {
    return '- `themes`: list up to 4 candidate page-title themes even if tentative; return each as {"theme": string, "confidence": 0-1} (a short noun phrase that could headline a page in a printed family photo book, e.g. "beach day", "bath time", "cooking together", "birthday party", "first snow"). An empty list is fine if truly nothing fits. Never use people\'s names as themes.';
  }
  return '- `themes`: 0-4 short noun phrases that could serve as the TITLE OF A PAGE in a printed family photo book (e.g. "beach day", "bath time", "cooking together", "birthday party", "first snow"). Only include a theme you are confident in; an empty list is a good answer. Never use people\'s names as themes.';
}

/**
 * `controlled` (V1c) mode's replacement for the open-vocabulary `themes`
 * axis: topic ids drawn from the approved vocabulary
 * (docs/plans/topic-vocabulary.md). `detail` is required for the 4 topics
 * whose meaning depends on it (a canonical English name, not the parent's
 * raw wording, so the same occasion clusters across memories/years) and
 * omitted for every other topic.
 *
 * The vocabulary list is embedded HERE, immediately after the instruction
 * and before `labels`, rather than appended at the end of the prompt after
 * the milestone catalog -- a live 25-memory sample with the vocab at the
 * end of the prompt came back with topics on only 1/25 memories (model
 * genuinely emitting `topics: []`, confirmed via the topicsRawUnparsed
 * tripwire firing zero times -- a parsing bug was ruled out). Keeping the
 * instruction and the list it refers to adjacent, plus leading with a
 * concrete example and an expected match rate ("most memories match 1-2
 * topics"), is the fix being tested against that same sample.
 *
 * The negative-examples line is deliberately phrased as "don't invent ids
 * outside the list" rather than "here's how to abstain" -- the earlier
 * wording ("these are NOT topics") risked reading as permission to lean on
 * abstention, which is the collapse this rewrite is meant to fix.
 */
function buildTopicsInstruction(vocabEntries: TopicVocabularyEntry[]): string[] {
  return [
    '- `topics`: choose from the TOPIC VOCABULARY below -- output the matching ids as an array, e.g. "topics": ["beach", "grandparents"]. Most family memories match 1-2 topics; look for the place, activity, occasion, or people-context in the images and text. Use an empty list only when nothing in the vocabulary fits. Items may be bare id strings; use {"id": ..., "detail": ...} only for `other-holiday`, `national-holiday`, `ceremony`, `mothers-fathers-day`, where `detail` (a canonical English name, e.g. "Passover", "July 4th") is required.',
    '',
    'TOPIC VOCABULARY (choose ids from this list only):',
    formatTopicVocabularyForPrompt(vocabEntries),
    '',
    `Do not invent ids outside the list. Abstract concepts like ${NEGATIVE_EXAMPLES.join(', ')} are not in the vocabulary on purpose -- when a memory is only that, leave topics empty rather than forcing a bad fit.`,
  ];
}

export function buildSystemPrompt(
  emotionKeys: string[],
  catalogEntries: MilestoneCatalogEntry[],
  mode: TaggingMode,
  vocabEntries: TopicVocabularyEntry[],
): string {
  const emotionList = emotionKeys.join(', ');
  const catalogText = formatMilestoneCatalogForPrompt(catalogEntries);

  const lines = [
    "You are tagging entries from a family's private memory journal (a parent app). Entries may be in any language (often Spanish or English); always answer in lowercase English. You receive: the entry date, the people tagged (with ages, child/adult, days to their birthday), nearby holidays, the parent's text (may be absent), and up to 4 photos or video frames (may be absent). Return strict JSON with these fields:",
    '',
    ...(mode === 'controlled' ? buildTopicsInstruction(vocabEntries) : [buildThemesInstruction(mode)]),
    '- `labels`: 3-10 concrete descriptive labels for search (objects, setting, activities, weather, food items, animals...).',
    '- `description`: one neutral factual sentence describing the entry; may use tagged first names.',
    `- \`emotion\`: exactly one of [${emotionList}], judged from text and images together; videos/photos without text still get an emotion.`,
    '- `occasion`: null, or {"type": string, "evidence": "text"|"image"|"date", "confidence": 0-1}. Seasonal/holiday occasions require calendar plausibility (a costume in March is not halloween) or explicit text. For birthdays, type "birthday party" describes the EVENT only -- never decide whose birthday it is.',
    '- `milestone`: null, or {"claim": short paraphrase, "catalog_id": one of the provided catalog ids or null, "detail": string|null}. STRICT RULE: a milestone exists ONLY when the parent\'s TEXT explicitly records a first/milestone ("first steps", "dijo su primera palabra", "turned three"). Never infer a milestone from images, dates, or ages. If there is no text, milestone must be null.',
    '',
    'Milestone catalog (id — name (age band)):',
    catalogText,
  ];

  return lines.join('\n');
}

function buildUserText(contextText: string, text: string | null): string {
  const bodyText = text && text.trim() ? text.trim() : '(no text)';
  return `${contextText}\n\nParent's text:\n${bodyText}`;
}

// ── OpenAI call ─────────────────────────────────────────────────────────

interface EncodedImage {
  base64: string;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
}

interface OpenAiUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

interface OpenAiChatResult {
  content: string;
  usage: OpenAiUsage | null;
}

const RETRY_BACKOFF_MS = 1500;

async function bytesToBase64(bytes: Uint8Array): Promise<string> {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function callOpenAiTagger(
  systemPrompt: string,
  userText: string,
  images: EncodedImage[],
  model: string,
  apiKey: string,
): Promise<OpenAiChatResult> {
  const userContent: Array<Record<string, unknown>> = [{ type: 'text', text: userText }];
  for (const image of images) {
    userContent.push({
      type: 'image_url',
      image_url: { url: `data:${image.contentType};base64,${image.base64}`, detail: 'low' },
    });
  }

  const body = JSON.stringify({
    model,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
  });

  const attempt = () =>
    fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body,
    });

  let response = await attempt();
  if (!response.ok && (response.status === 429 || response.status >= 500)) {
    await delay(RETRY_BACKOFF_MS);
    response = await attempt();
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`OpenAI chat failed (${response.status}): ${errorText.slice(0, 300)}`);
  }

  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;

  if (!content || typeof content !== 'string') {
    throw new Error('OpenAI chat returned empty content');
  }

  const usage = payload.usage
    ? { prompt_tokens: payload.usage.prompt_tokens ?? 0, completion_tokens: payload.usage.completion_tokens ?? 0 }
    : null;

  return { content, usage };
}

// ── Model output shape + validation ─────────────────────────────────────

export interface ModelOccasion {
  type: string;
  evidence: 'text' | 'image' | 'date';
  confidence: number;
}

export interface ModelMilestone {
  claim: string;
  catalog_id: string | null;
  detail: string | null;
  /** The model's raw `catalog_id`, kept here ONLY when it didn't match any
   * parsed catalog entry (catalog_id above is null'd in that case). Lets
   * frequency.md surface hallucinated ids without letting them pollute the
   * validated `catalog_id` field. */
  catalogIdRejected: string | null;
}

export interface ModelTaggingOutput {
  /** Empty in `controlled` mode (which uses `topics` instead). */
  themes: string[];
  /** Parallel to `themes` (same length/order); null in strict and
   * controlled modes, where the model never emits a confidence per theme. */
  themeConfidences: number[] | null;
  /** Empty in `discovery`/`strict` modes (which use `themes` instead). Post
   * validation+date-gating -- see gateTopicsByDate, applied in
   * processMemory, not here (gating needs memory_date, which this function
   * doesn't receive). */
  topics: TopicAssignment[];
  /** Topic ids the model returned that aren't in the approved vocabulary. */
  topicsRejected: string[];
  /** Topic ids kept despite missing a required `detail` (see
   * TOPICS_REQUIRING_DETAIL). */
  topicsMissingDetail: string[];
  labels: string[];
  description: string;
  emotion: string | null;
  occasion: ModelOccasion | null;
  milestone: ModelMilestone | null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim());
}

const MAX_THEMES = 4;

/**
 * Parses the `themes` field, which has a different shape per mode:
 * strict -> plain strings; discovery -> {"theme": string, "confidence":
 * number} objects (recall-leaning, so we keep the model's own confidence
 * alongside each candidate). Tolerates a plain string turning up in
 * discovery mode (treated as confidence 0) since models don't always follow
 * the requested shape exactly.
 */
export function parseThemes(value: unknown, mode: TaggingMode): { themes: string[]; themeConfidences: number[] | null } {
  if (!Array.isArray(value)) {
    return { themes: [], themeConfidences: mode === 'discovery' ? [] : null };
  }

  if (mode === 'strict') {
    return { themes: toStringArray(value).slice(0, MAX_THEMES), themeConfidences: null };
  }

  const parsed: Array<{ theme: string; confidence: number }> = [];
  for (const item of value) {
    if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      if (typeof o.theme === 'string' && o.theme.trim()) {
        const confidence = typeof o.confidence === 'number' ? o.confidence : 0;
        parsed.push({ theme: o.theme.trim(), confidence });
      }
    } else if (typeof item === 'string' && item.trim()) {
      parsed.push({ theme: item.trim(), confidence: 0 });
    }
  }

  const capped = parsed.slice(0, MAX_THEMES);
  return { themes: capped.map((t) => t.theme), themeConfidences: capped.map((t) => t.confidence) };
}

/**
 * Normalizes the model's raw JSON into ModelTaggingOutput. `emotion` is
 * normalized (aliases resolved) but NOT rejected when it falls outside
 * `emotionKeys` -- V1a is a discovery pass, so a model slip outside the
 * allowed set is a signal worth seeing in frequency.md, not something to
 * silently coerce away. `catalog_id` IS rejected (set to null, original
 * preserved in `catalogIdRejected`) when it doesn't match a parsed catalog
 * entry -- unlike emotion, a bad catalog_id can't be meaningfully counted
 * or displayed as "a milestone catalog entry" if it isn't one. `topics`
 * (controlled mode only) go through the same reject-unknown-ids treatment
 * via parseTopics -- `vocabIds` is unused outside controlled mode.
 */
export function parseModelOutput(
  raw: unknown,
  emotionKeys: Set<string>,
  mode: TaggingMode,
  catalogIds: Set<string>,
  vocabIds: Set<string>,
): ModelTaggingOutput {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const rawEmotion = typeof obj.emotion === 'string' ? obj.emotion : null;
  const emotion = normalizeEmotion(rawEmotion);
  if (emotion && !emotionKeys.has(emotion)) {
    console.warn(`  model returned an emotion outside the allowed set: "${emotion}"`);
  }

  let occasion: ModelOccasion | null = null;
  if (obj.occasion && typeof obj.occasion === 'object') {
    const o = obj.occasion as Record<string, unknown>;
    if (typeof o.type === 'string') {
      const evidence = o.evidence === 'text' || o.evidence === 'image' || o.evidence === 'date' ? o.evidence : 'text';
      const confidence = typeof o.confidence === 'number' ? o.confidence : 0;
      occasion = { type: o.type, evidence, confidence };
    }
  }

  let milestone: ModelMilestone | null = null;
  if (obj.milestone && typeof obj.milestone === 'object') {
    const m = obj.milestone as Record<string, unknown>;
    if (typeof m.claim === 'string') {
      const rawCatalogId = typeof m.catalog_id === 'string' ? m.catalog_id : null;
      const catalogIdValid = rawCatalogId !== null && catalogIds.has(rawCatalogId);
      milestone = {
        claim: m.claim,
        catalog_id: catalogIdValid ? rawCatalogId : null,
        detail: typeof m.detail === 'string' ? m.detail : null,
        catalogIdRejected: rawCatalogId !== null && !catalogIdValid ? rawCatalogId : null,
      };
    }
  }

  let themes: string[] = [];
  let themeConfidences: number[] | null = null;
  let topics: TopicAssignment[] = [];
  let topicsRejected: string[] = [];
  let topicsMissingDetail: string[] = [];

  if (mode === 'controlled') {
    const parsedTopics = parseTopics(obj.topics, vocabIds);
    topics = parsedTopics.topics;
    topicsRejected = parsedTopics.topicsRejected;
    topicsMissingDetail = parsedTopics.topicsMissingDetail;
  } else {
    const parsedThemes = parseThemes(obj.themes, mode);
    themes = parsedThemes.themes;
    themeConfidences = parsedThemes.themeConfidences;
  }

  return {
    themes,
    themeConfidences,
    topics,
    topicsRejected,
    topicsMissingDetail,
    labels: toStringArray(obj.labels).slice(0, 10),
    description: typeof obj.description === 'string' ? obj.description : '',
    emotion,
    occasion,
    milestone,
  };
}

// ── Per-memory processing ────────────────────────────────────────────────

interface ProcessTarget {
  memory: MemoryRow;
  taggedMembers: FamilyMemberRow[];
  media: MediaRow[];
}

/** One thumbnail actually written to disk -- `index` is its position among
 * the memory's usable image candidates (may have gaps if an individual
 * fetch failed), `extension` is its real saved file extension. Lets
 * review.html reference the exact file without extension-guessing. */
interface SentImageRef {
  index: number;
  extension: string;
}

interface ResultLine {
  memoryId: string;
  memoryDate: string;
  memoryType: string;
  familyId: string;
  mode: TaggingMode;
  context: MemoryContext;
  imagesSent: number;
  imageSources: ImageSource[];
  sentImages: SentImageRef[];
  textPresent: boolean;
  textExcerpt: string | null;
  existingEmotion: string | null;
  birthdayMatch: BirthdayMatch | null;
  birthMatch: BirthMatch | null;
  model?: ModelTaggingOutput;
  usage?: OpenAiUsage;
  skipped?: 'no_input';
  milestoneSuppressedNoText?: boolean;
  /** Controlled mode only: topic ids removed by gateTopicsByDate because
   * memory_date wasn't calendar-plausible for them. */
  topicsDateGated?: string[];
  /** Controlled mode only: the topic-vocabulary doc version tagging ran
   * against (docs/plans/topic-vocabulary.md), so results.jsonl stays
   * interpretable if the vocabulary changes later. */
  vocabVersion?: string;
  /** Diagnostic tripwire (controlled mode only): the raw `topics` field
   * from the model's JSON, captured verbatim, ONLY when it was non-empty
   * but parseTopics still produced zero topics -- i.e. parseTopics failed
   * to make sense of a shape it should have. Should be empty/absent in a
   * healthy run; a populated column means parseTopics needs another
   * tolerant case. */
  topicsRawUnparsed?: unknown;
  error?: string;
}

const TEXT_EXCERPT_MAX_CHARS = 240;

interface ProcessDeps {
  systemPrompt: string;
  emotionKeys: Set<string>;
  catalogIds: Set<string>;
  vocabIds: Set<string>;
  mode: TaggingMode;
  model: string;
  apiKey: string | null;
  maxImages: number;
  dryRun: boolean;
  outputDir: URL;
}

async function processMemory(target: ProcessTarget, deps: ProcessDeps): Promise<ResultLine> {
  const { memory, taggedMembers, media } = target;
  const context = buildMemoryContext(memory.memory_date, taggedMembers);
  const textPresent = Boolean(memory.content?.trim());
  const { birthdayMatch, birthMatch } = computeBirthdayMatch(
    taggedMembers.map((m) => ({ id: m.id, name: m.name, dateOfBirth: m.date_of_birth })),
    memory.memory_date,
  );

  const candidates = selectImageCandidates(media);
  const usableCandidates = candidates.filter((c) => c.objectKey !== null).slice(0, deps.maxImages);
  const skippedSources = candidates.filter((c) => c.objectKey === null).map((c) => c.source);

  const base: Pick<
    ResultLine,
    | 'memoryId'
    | 'memoryDate'
    | 'memoryType'
    | 'familyId'
    | 'mode'
    | 'context'
    | 'textPresent'
    | 'textExcerpt'
    | 'existingEmotion'
    | 'birthdayMatch'
    | 'birthMatch'
  > = {
    memoryId: memory.id,
    memoryDate: memory.memory_date,
    memoryType: memory.memory_type,
    familyId: memory.family_id,
    mode: deps.mode,
    context,
    textPresent,
    textExcerpt: memory.content?.trim() ? memory.content.trim().slice(0, TEXT_EXCERPT_MAX_CHARS) : null,
    existingEmotion: memory.emotion,
    birthdayMatch,
    birthMatch,
  };

  if (!textPresent && usableCandidates.length === 0) {
    return { ...base, imagesSent: 0, imageSources: skippedSources, sentImages: [], skipped: 'no_input' };
  }

  if (deps.dryRun) {
    return {
      ...base,
      imagesSent: usableCandidates.length,
      imageSources: [...usableCandidates.map((c) => c.source), ...skippedSources],
      sentImages: [],
    };
  }

  if (!deps.apiKey) {
    return {
      ...base,
      imagesSent: 0,
      imageSources: skippedSources,
      sentImages: [],
      error: 'Missing OPENAI_API_KEY',
    };
  }

  const images: EncodedImage[] = [];
  const sentSources: ImageSource[] = [];
  const sentImages: SentImageRef[] = [];
  for (let i = 0; i < usableCandidates.length; i += 1) {
    const candidate = usableCandidates[i];
    try {
      const bytes = await getObjectBytes(candidate.objectKey!);
      const base64 = await bytesToBase64(bytes);
      images.push({ base64, contentType: candidate.contentType! });
      sentSources.push(candidate.source);

      const ext = extensionForContentType(candidate.contentType!);
      const thumbsDir = new URL('thumbs/', deps.outputDir);
      await Deno.mkdir(thumbsDir, { recursive: true });
      await Deno.writeFile(new URL(`${memory.id}-${i}.${ext}`, thumbsDir), bytes);
      sentImages.push({ index: i, extension: ext });
    } catch (error) {
      console.error(`  memory ${memory.id}: failed to fetch image ${candidate.objectKey} —`, error instanceof Error ? error.message : error);
    }
  }

  const contextText = renderContextText(context);
  const userText = buildUserText(contextText, memory.content);

  try {
    const { content, usage } = await callOpenAiTagger(deps.systemPrompt, userText, images, deps.model, deps.apiKey);
    const parsedRaw = JSON.parse(content);
    const parsed = parseModelOutput(parsedRaw, deps.emotionKeys, deps.mode, deps.catalogIds, deps.vocabIds);

    // Diagnostic tripwire: if the model clearly sent SOMETHING for topics
    // but parseTopics still came back empty, that's parseTopics failing to
    // recognize a shape, not the model saying "no topics" -- capture the
    // raw field verbatim so a live-run collapse (like the 726-processed/
    // 13-tagged incident that prompted this) is diagnosable from
    // results.jsonl alone instead of needing a live rerun.
    let topicsRawUnparsed: unknown;
    if (deps.mode === 'controlled' && parsed.topics.length === 0) {
      const rawTopicsField = parsedRaw && typeof parsedRaw === 'object'
        ? (parsedRaw as Record<string, unknown>).topics
        : undefined;
      if (isNonEmptyRawValue(rawTopicsField)) {
        topicsRawUnparsed = rawTopicsField;
      }
    }

    let milestoneSuppressedNoText = false;
    let model = parsed;
    if (!textPresent && parsed.milestone) {
      milestoneSuppressedNoText = true;
      model = { ...model, milestone: null };
    }

    let topicsDateGated: string[] | undefined;
    if (deps.mode === 'controlled') {
      const gated = gateTopicsByDate(model.topics, memory.memory_date);
      model = { ...model, topics: gated.topics };
      topicsDateGated = gated.dateGated;
    }

    return {
      ...base,
      imagesSent: images.length,
      imageSources: [...sentSources, ...skippedSources],
      sentImages,
      model,
      usage: usage ?? undefined,
      milestoneSuppressedNoText,
      topicsDateGated,
      vocabVersion: deps.mode === 'controlled' ? TOPIC_VOCAB_VERSION : undefined,
      topicsRawUnparsed,
    };
  } catch (error) {
    return {
      ...base,
      imagesSent: images.length,
      imageSources: [...sentSources, ...skippedSources],
      sentImages,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ── Results file writer (serialized so concurrent workers never interleave) ─

let writeChain: Promise<void> = Promise.resolve();

function queueAppendResultLine(path: string, line: ResultLine): Promise<void> {
  writeChain = writeChain.then(async () => {
    await Deno.writeTextFile(path, JSON.stringify(line) + '\n', { append: true, create: true });
  });
  return writeChain;
}

// ── frequency.md rendering ───────────────────────────────────────────────

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface RunStats {
  processed: number;
  skippedNoInput: number;
  errors: number;
  milestoneSuppressedNoText: number;
  catalogIdRejections: number;
  imagesSentTotal: number;
  imageSourceCounts: Record<string, number>;
  promptTokens: number;
  completionTokens: number;
}

function computeRunStats(lines: ResultLine[]): RunStats {
  const stats: RunStats = {
    processed: 0,
    skippedNoInput: 0,
    errors: 0,
    milestoneSuppressedNoText: 0,
    catalogIdRejections: 0,
    imagesSentTotal: 0,
    imageSourceCounts: {},
    promptTokens: 0,
    completionTokens: 0,
  };

  for (const line of lines) {
    if (line.skipped === 'no_input') {
      stats.skippedNoInput += 1;
      continue;
    }
    if (line.error) {
      stats.errors += 1;
    } else if (line.model) {
      stats.processed += 1;
    }
    if (line.milestoneSuppressedNoText) stats.milestoneSuppressedNoText += 1;
    if (line.model?.milestone?.catalogIdRejected) stats.catalogIdRejections += 1;
    stats.imagesSentTotal += line.imagesSent;
    for (const source of line.imageSources) {
      stats.imageSourceCounts[source] = (stats.imageSourceCounts[source] ?? 0) + 1;
    }
    if (line.usage) {
      stats.promptTokens += line.usage.prompt_tokens;
      stats.completionTokens += line.usage.completion_tokens;
    }
  }

  return stats;
}

function estimateCostUsd(promptTokens: number, completionTokens: number): number {
  return (promptTokens / 1_000_000) * 0.15 + (completionTokens / 1_000_000) * 0.6;
}

/** discovery/strict-mode Themes section -- unchanged behavior, extracted so
 * renderFrequencyMarkdown can pick between this and renderTopicsSections
 * (controlled mode) with a single line. */
function renderThemesSection(withModel: ResultLine[], mode: TaggingMode): string[] {
  const out: string[] = [];

  // discovery mode additionally tracks each theme's confidence scores
  // (parallel to `themes` on ModelTaggingOutput); strict mode never has
  // confidences (themeConfidences is null), so those columns are omitted.
  const CONFIDENT_THEME_THRESHOLD = 0.6;
  const themeCounts = new Map<
    string,
    { count: number; confidences: number[]; samples: Array<{ id: string; date: string }> }
  >();
  for (const line of withModel) {
    const { themes, themeConfidences } = line.model!;
    themes.forEach((theme, i) => {
      const entry = themeCounts.get(theme) ?? { count: 0, confidences: [], samples: [] };
      entry.count += 1;
      if (themeConfidences) entry.confidences.push(themeConfidences[i]);
      if (entry.samples.length < 5) entry.samples.push({ id: line.memoryId, date: line.memoryDate });
      themeCounts.set(theme, entry);
    });
  }
  out.push('## Themes (ranked by frequency)');
  out.push('');
  if (mode === 'discovery') {
    out.push('| Theme | Count | Mean confidence | Count ≥0.6 | Sample memories |');
    out.push('|---|---|---|---|---|');
    for (const [theme, entry] of [...themeCounts.entries()].sort((a, b) => b[1].count - a[1].count)) {
      const samples = entry.samples.map((s) => `${s.id.slice(0, 8)}@${s.date}`).join(', ');
      const meanConfidence = entry.confidences.length > 0
        ? entry.confidences.reduce((sum, c) => sum + c, 0) / entry.confidences.length
        : 0;
      const highConfidenceCount = entry.confidences.filter((c) => c >= CONFIDENT_THEME_THRESHOLD).length;
      out.push(`| ${theme} | ${entry.count} | ${meanConfidence.toFixed(2)} | ${highConfidenceCount} | ${samples} |`);
    }
  } else {
    out.push('| Theme | Count | Sample memories |');
    out.push('|---|---|---|');
    for (const [theme, entry] of [...themeCounts.entries()].sort((a, b) => b[1].count - a[1].count)) {
      const samples = entry.samples.map((s) => `${s.id.slice(0, 8)}@${s.date}`).join(', ');
      out.push(`| ${theme} | ${entry.count} | ${samples} |`);
    }
  }
  out.push('');

  return out;
}

/** Tallies how often each value in a string-array field (topicsRejected /
 * topicsMissingDetail / topicsDateGated) occurs across `lines`, with up to
 * 5 sample memory ids+dates per value -- shared shape for the three
 * controlled-mode bookkeeping tables in renderTopicsSections. */
function tallyStringArrayField(
  lines: ResultLine[],
  getValues: (line: ResultLine) => string[] | undefined,
): Array<{ value: string; count: number; samples: Array<{ id: string; date: string }> }> {
  const counts = new Map<string, { count: number; samples: Array<{ id: string; date: string }> }>();

  for (const line of lines) {
    for (const value of getValues(line) ?? []) {
      const entry = counts.get(value) ?? { count: 0, samples: [] };
      entry.count += 1;
      if (entry.samples.length < 5) entry.samples.push({ id: line.memoryId, date: line.memoryDate });
      counts.set(value, entry);
    }
  }

  return [...counts.entries()]
    .map(([value, entry]) => ({ value, ...entry }))
    .sort((a, b) => b.count - a.count);
}

function renderSampleTable(
  title: string,
  rows: Array<{ value: string; count: number; samples: Array<{ id: string; date: string }> }>,
  valueColumnHeader: string,
): string[] {
  const out: string[] = [];
  out.push(`## ${title}`);
  out.push('');
  if (rows.length === 0) {
    out.push('_(none)_');
    out.push('');
    return out;
  }
  out.push(`| ${valueColumnHeader} | Count | Sample memories |`);
  out.push('|---|---|---|');
  for (const row of rows) {
    const samples = row.samples.map((s) => `${s.id.slice(0, 8)}@${s.date}`).join(', ');
    out.push(`| ${row.value} | ${row.count} | ${samples} |`);
  }
  out.push('');
  return out;
}

/**
 * controlled-mode (V1c) "table of contents" view: per-topic counts, %
 * coverage, and up to 5 sample memories, plus the three bookkeeping tables
 * (topicsRejected/topicsMissingDetail/topicsDateGated) and a topics-per-
 * memory coverage histogram (plan brief item 3).
 */
function renderTopicsSections(withModel: ResultLine[]): string[] {
  const out: string[] = [];
  const totalMemories = withModel.length;

  interface TopicCountEntry {
    count: number;
    withDetail: number;
    detailCounts: Map<string, number>;
    samples: Array<{ id: string; date: string }>;
  }

  const topicCounts = new Map<string, TopicCountEntry>();
  for (const line of withModel) {
    for (const topic of line.model!.topics) {
      const entry: TopicCountEntry = topicCounts.get(topic.id) ??
        { count: 0, withDetail: 0, detailCounts: new Map<string, number>(), samples: [] };
      entry.count += 1;
      if (topic.detail) {
        entry.withDetail += 1;
        entry.detailCounts.set(topic.detail, (entry.detailCounts.get(topic.detail) ?? 0) + 1);
      }
      if (entry.samples.length < 5) entry.samples.push({ id: line.memoryId, date: line.memoryDate });
      topicCounts.set(topic.id, entry);
    }
  }

  out.push(`## Topics (table of contents) — vocabulary ${TOPIC_VOCAB_VERSION}`);
  out.push('');
  out.push('| Topic | Count | % of archive | With detail | Top details | Sample memories |');
  out.push('|---|---|---|---|---|---|');
  for (const [topicId, entry] of [...topicCounts.entries()].sort((a, b) => b[1].count - a[1].count)) {
    const pct = totalMemories > 0 ? ((entry.count / totalMemories) * 100).toFixed(1) : '0.0';
    const topDetails = [...entry.detailCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([detail, count]) => `${detail} (${count})`)
      .join(', ');
    const samples = entry.samples.map((s) => `${s.id.slice(0, 8)}@${s.date}`).join(', ');
    out.push(`| ${topicId} | ${entry.count} | ${pct}% | ${entry.withDetail} | ${topDetails} | ${samples} |`);
  }
  out.push('');

  // Coverage: how many topics (0-3) did each memory end up with, post
  // validation + date-gating.
  const coverageCounts = new Map<number, number>();
  for (const line of withModel) {
    const n = Math.min(line.model!.topics.length, MAX_TOPICS);
    coverageCounts.set(n, (coverageCounts.get(n) ?? 0) + 1);
  }
  out.push('## Topic coverage');
  out.push('');
  out.push('| Topics assigned | Memories |');
  out.push('|---|---|');
  for (let n = 0; n <= MAX_TOPICS; n += 1) {
    out.push(`| ${n} | ${coverageCounts.get(n) ?? 0} |`);
  }
  out.push('');

  out.push(
    ...renderSampleTable(
      'Rejected topic ids (not in the approved vocabulary)',
      tallyStringArrayField(withModel, (l) => l.model?.topicsRejected),
      'Topic id',
    ),
  );
  out.push(
    ...renderSampleTable(
      'Topics missing a required detail',
      tallyStringArrayField(withModel, (l) => l.model?.topicsMissingDetail),
      'Topic id',
    ),
  );
  out.push(
    ...renderSampleTable(
      'Date-gated topics (removed -- memory date implausible for the occasion)',
      tallyStringArrayField(withModel, (l) => l.topicsDateGated),
      'Topic id',
    ),
  );

  return out;
}

function renderFrequencyMarkdown(runId: string, lines: ResultLine[], dryRun: boolean, mode: TaggingMode): string {
  const out: string[] = [];
  out.push('# Memory Book V1a — Tagging Discovery Sheet');
  out.push('');
  out.push(`Run: ${runId}  `);
  out.push(`Execution: ${dryRun ? 'dry-run (no OpenAI calls)' : 'live'}  `);
  out.push(`Tagging mode: ${mode}`);
  out.push('');

  const stats = computeRunStats(lines);
  out.push('## Run stats');
  out.push('');
  out.push(`- Processed (model call succeeded): ${stats.processed}`);
  out.push(`- Skipped (no text, no usable image): ${stats.skippedNoInput}`);
  out.push(`- Errors: ${stats.errors}`);
  out.push(`- Milestones suppressed (model returned one with no text present): ${stats.milestoneSuppressedNoText}`);
  out.push(`- Milestone catalog_id rejections (model returned an id not in the catalog): ${stats.catalogIdRejections}`);
  out.push(`- Images sent: ${stats.imagesSentTotal}`);
  out.push(
    `- Image source breakdown: ${
      Object.entries(stats.imageSourceCounts).map(([k, v]) => `${k}=${v}`).join(', ') || '(none)'
    }`,
  );
  if (!dryRun) {
    out.push(`- Token totals: prompt=${stats.promptTokens}, completion=${stats.completionTokens}`);
    out.push(
      `- Estimated cost (gpt-4o-mini rates, $0.15/M input + $0.60/M output — estimate only): $${
        estimateCostUsd(stats.promptTokens, stats.completionTokens).toFixed(4)
      }`,
    );
  }
  out.push('');

  if (dryRun) {
    return out.join('\n');
  }

  const withModel = lines.filter((l) => l.model);

  if (mode === 'controlled') {
    out.push(...renderTopicsSections(withModel));
  } else {
    out.push(...renderThemesSection(withModel, mode));
  }

  // Labels
  const labelCounts = new Map<string, number>();
  for (const line of withModel) {
    for (const label of line.model!.labels) {
      labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }
  }
  out.push('## Labels (top 150 by frequency)');
  out.push('');
  out.push('| Label | Count |');
  out.push('|---|---|');
  for (const [label, count] of [...labelCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 150)) {
    out.push(`| ${label} | ${count} |`);
  }
  out.push('');

  // Emotion distribution + agreement with stored memories.emotion
  const emotionCounts = new Map<string, number>();
  let agree = 0;
  let comparable = 0;
  for (const line of withModel) {
    const modelEmotion = line.model!.emotion ?? '(null)';
    emotionCounts.set(modelEmotion, (emotionCounts.get(modelEmotion) ?? 0) + 1);

    const existing = normalizeEmotion(line.existingEmotion);
    if (existing && line.model!.emotion) {
      comparable += 1;
      if (existing === line.model!.emotion) agree += 1;
    }
  }
  out.push('## Emotion distribution');
  out.push('');
  out.push('| Emotion (model) | Count |');
  out.push('|---|---|');
  for (const [emotion, count] of [...emotionCounts.entries()].sort((a, b) => b[1] - a[1])) {
    out.push(`| ${emotion} | ${count} |`);
  }
  out.push('');
  out.push(
    comparable > 0
      ? `Agreement with stored \`memories.emotion\` (both non-null): ${agree}/${comparable} (${((agree / comparable) * 100).toFixed(1)}%).`
      : 'Agreement with stored `memories.emotion`: no comparable memories (existing emotion or model emotion missing on all processed memories).',
  );
  out.push('');

  // Occasions
  const occasionCounts = new Map<string, { total: number; evidence: Record<string, number> }>();
  for (const line of withModel) {
    const occasion = line.model!.occasion;
    if (!occasion) continue;
    const entry = occasionCounts.get(occasion.type) ?? { total: 0, evidence: {} };
    entry.total += 1;
    entry.evidence[occasion.evidence] = (entry.evidence[occasion.evidence] ?? 0) + 1;
    occasionCounts.set(occasion.type, entry);
  }
  out.push('## Occasions (ranked by frequency)');
  out.push('');
  out.push('| Occasion type | Count | Evidence breakdown |');
  out.push('|---|---|---|');
  for (const [type, entry] of [...occasionCounts.entries()].sort((a, b) => b[1].total - a[1].total)) {
    const evidence = Object.entries(entry.evidence).map(([k, v]) => `${k}=${v}`).join(', ');
    out.push(`| ${type} | ${entry.total} | ${evidence} |`);
  }
  out.push('');

  // Milestone claims
  const milestoneLines = withModel.filter((l) => l.model!.milestone);
  out.push('## Milestone claims');
  out.push('');
  out.push('| Memory ID | Date | Catalog ID | Catalog ID Rejected | Claim | Detail | Tagged members |');
  out.push('|---|---|---|---|---|---|---|');
  for (const line of milestoneLines.sort((a, b) => a.memoryDate.localeCompare(b.memoryDate))) {
    const m = line.model!.milestone!;
    const members = line.context.members.map((mem) => mem.firstName).join(', ');
    out.push(
      `| ${line.memoryId} | ${line.memoryDate} | ${m.catalog_id ?? '(none)'} | ${m.catalogIdRejected ?? ''} | ${m.claim} | ${m.detail ?? ''} | ${members} |`,
    );
  }
  out.push('');

  // Birthday matches (ageTurned >= 1 -- see computeBirthdayMatch; the birth
  // case, ageTurned 0, is reported separately below as `birthMatch`).
  const birthdayLines = lines.filter((l) => l.birthdayMatch);
  out.push('## Deterministic birthday matches');
  out.push('');
  out.push('| Memory ID | Date | Member | Age turned | Offset (days) |');
  out.push('|---|---|---|---|---|');
  for (const line of birthdayLines.sort((a, b) => a.memoryDate.localeCompare(b.memoryDate))) {
    const match = line.birthdayMatch!;
    const offset = match.daysOffset >= 0 ? `+${match.daysOffset}` : `${match.daysOffset}`;
    out.push(`| ${line.memoryId} | ${line.memoryDate} | ${match.memberName} | ${match.ageTurned} | ${offset} |`);
  }
  out.push('');

  const OFFSET_HISTOGRAM_RANGE = 7;
  out.push(
    `Offset histogram (memory_date minus anniversary, -${OFFSET_HISTOGRAM_RANGE}..+${OFFSET_HISTOGRAM_RANGE} days):`,
  );
  out.push('');
  out.push('| Offset | Count | |');
  out.push('|---|---|---|');
  const offsetCounts = new Map<number, number>();
  for (let offset = -OFFSET_HISTOGRAM_RANGE; offset <= OFFSET_HISTOGRAM_RANGE; offset += 1) {
    offsetCounts.set(offset, 0);
  }
  for (const line of birthdayLines) {
    const offset = line.birthdayMatch!.daysOffset;
    if (offsetCounts.has(offset)) {
      offsetCounts.set(offset, (offsetCounts.get(offset) ?? 0) + 1);
    }
  }
  const maxOffsetCount = Math.max(1, ...offsetCounts.values());
  for (let offset = -OFFSET_HISTOGRAM_RANGE; offset <= OFFSET_HISTOGRAM_RANGE; offset += 1) {
    const count = offsetCounts.get(offset) ?? 0;
    const bar = '█'.repeat(Math.round((count / maxOffsetCount) * 20));
    out.push(`| ${offset >= 0 ? `+${offset}` : offset} | ${count} | ${bar} |`);
  }
  out.push('');

  // Birth matches (the ageTurned-0/"birth itself" case computeBirthdayMatch
  // routes separately from a real birthday -- newborn-week memories say
  // "birth", not "1st birthday").
  const birthLines = lines.filter((l) => l.birthMatch);
  out.push('## Deterministic birth matches');
  out.push('');
  out.push('| Memory ID | Date | Member | Days from birth |');
  out.push('|---|---|---|---|');
  for (const line of birthLines.sort((a, b) => a.memoryDate.localeCompare(b.memoryDate))) {
    const match = line.birthMatch!;
    const daysFromBirth = match.daysFromBirth >= 0 ? `+${match.daysFromBirth}` : `${match.daysFromBirth}`;
    out.push(`| ${line.memoryId} | ${line.memoryDate} | ${match.memberName} | ${daysFromBirth} |`);
  }
  out.push('');

  return out.join('\n');
}

function renderReviewHtml(runId: string, lines: ResultLine[]): string {
  const withModel = lines.filter((l) => l.model || l.error);
  const cards = withModel
    .sort((a, b) => a.memoryDate.localeCompare(b.memoryDate))
    .map((line) => {
      const membersDesc = line.context.members
        .map((m) => `${escapeHtml(m.firstName)} (${m.ageYears ?? '?'}y)`)
        .join(', ') || '(none)';

      const thumbs = line.sentImages
        .map((img) => `<img class="thumb" src="thumbs/${line.memoryId}-${img.index}.${img.extension}" loading="lazy" />`)
        .join('');

      const model = line.model;
      const excerpt = line.textExcerpt
        ? `<div class="excerpt">"${escapeHtml(line.textExcerpt)}"</div>`
        : '<div class="excerpt">(no text)</div>';

      return `
      <section class="card">
        <header>
          <strong>${escapeHtml(line.memoryDate)}</strong>
          <span class="tag">${escapeHtml(line.memoryType)}</span>
          ${line.error ? '<span class="tag error">error</span>' : ''}
        </header>
        <div class="members">Tagged: ${membersDesc}</div>
        <div class="thumbs">${thumbs}</div>
        ${excerpt}
        ${model
          ? `
        ${line.mode === 'controlled'
          ? `<div class="themes">Topics: ${
              model.topics
                .map((t) => `<span class="chip">${escapeHtml(t.id)}${t.detail ? ` — ${escapeHtml(t.detail)}` : ''}</span>`)
                .join('') || '(none)'
            }</div>`
          : `<div class="themes">Themes: ${
              model.themes
                .map((t, i) => {
                  const confidence = model.themeConfidences ? ` (${model.themeConfidences[i].toFixed(2)})` : '';
                  return `<span class="chip">${escapeHtml(t)}${confidence}</span>`;
                })
                .join('') || '(none)'
            }</div>`}
        <div class="labels">Labels: ${model.labels.map((l) => `<span class="chip alt">${escapeHtml(l)}</span>`).join('') || '(none)'}</div>
        <div class="emotion">Emotion: ${escapeHtml(model.emotion ?? '(none)')}</div>
        <div class="occasion">Occasion: ${model.occasion ? escapeHtml(`${model.occasion.type} (${model.occasion.evidence}, ${model.occasion.confidence})`) : '(none)'}</div>
        <div class="milestone">Milestone: ${
            model.milestone
              ? escapeHtml(
                  `${model.milestone.catalog_id ?? (model.milestone.catalogIdRejected ? `rejected:${model.milestone.catalogIdRejected}` : '?')} — ${model.milestone.claim}`,
                )
              : '(none)'
          }</div>
        `
          : `<div class="error-detail">${escapeHtml(line.error ?? 'unknown error')}</div>`}
        ${line.birthdayMatch ? `<div class="birthday">Birthday match: ${escapeHtml(line.birthdayMatch.memberName)} turns ${line.birthdayMatch.ageTurned} (offset ${line.birthdayMatch.daysOffset >= 0 ? '+' : ''}${line.birthdayMatch.daysOffset}d)</div>` : ''}
        ${line.birthMatch ? `<div class="birthday">Birth match: ${escapeHtml(line.birthMatch.memberName)} (${line.birthMatch.daysFromBirth >= 0 ? '+' : ''}${line.birthMatch.daysFromBirth}d from birth)</div>` : ''}
      </section>`;
    })
    .join('\n');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Memory Book V1a Discovery — ${escapeHtml(runId)}</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #faf8f5; margin: 0; padding: 24px; }
  h1 { font-size: 20px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
  .card { background: #fff; border-radius: 12px; padding: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .card header { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
  .tag { font-size: 11px; background: #eee; border-radius: 6px; padding: 2px 6px; }
  .tag.error { background: #fdd; color: #900; }
  .thumbs { display: flex; gap: 4px; flex-wrap: wrap; margin: 6px 0; }
  .thumb { width: 100%; max-width: 120px; height: 90px; object-fit: cover; border-radius: 6px; background: #eee; }
  .chip { display: inline-block; background: #eef; border-radius: 10px; padding: 2px 8px; margin: 2px 2px 0 0; font-size: 12px; }
  .chip.alt { background: #efe; }
  .members, .emotion, .occasion, .milestone, .birthday, .error-detail, .excerpt { font-size: 13px; margin-top: 4px; }
  .excerpt { font-style: italic; color: #555; }
  .error-detail { color: #900; }
</style>
</head>
<body>
<h1>Memory Book V1a Discovery — run ${escapeHtml(runId)}</h1>
<div class="grid">
${cards}
</div>
</body>
</html>`;
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const options = parseArgs(Deno.args);
  const userEmail = Deno.env.get('EVAL_USER_EMAIL') ?? 'eduardoyi@gmail.com';
  const apiKey = Deno.env.get('OPENAI_API_KEY') ?? null;

  if (!options.dryRun && !apiKey) {
    console.error('Missing OPENAI_API_KEY (pass --dry-run to build inputs without calling OpenAI).');
    Deno.exit(1);
  }

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  console.log(`Memory Book V1a tagging discovery run ${runId} — account: ${userEmail}`);

  const supabase = await createAuthedClient();
  const catalogEntries = await loadMilestoneCatalog();
  console.log(`Loaded milestone catalog: ${catalogEntries.length} entries`);
  const vocabEntries = await loadTopicVocabulary();
  console.log(`Loaded topic vocabulary (${TOPIC_VOCAB_VERSION}): ${vocabEntries.length} entries`);

  const families = await loadFamilies(supabase);
  if (families.length === 0) {
    console.error('No families visible to this account.');
    Deno.exit(1);
  }
  console.log(`Found ${families.length} famil${families.length === 1 ? 'y' : 'ies'}.`);

  const allMemories: MemoryRow[] = [];
  const familyMembersByFamily = new Map<string, FamilyMemberRow[]>();
  for (const family of families) {
    const [memories, members] = await Promise.all([
      loadMemories(supabase, family.id),
      loadFamilyMembers(supabase, family.id),
    ]);
    allMemories.push(...memories);
    familyMembersByFamily.set(family.id, members);
  }
  allMemories.sort((a, b) => a.memory_date.localeCompare(b.memory_date) || a.id.localeCompare(b.id));

  let targetMemories: MemoryRow[];
  if (options.memoryIds.length > 0) {
    const wanted = new Set(options.memoryIds);
    targetMemories = allMemories.filter((m) => wanted.has(m.id));
  } else {
    const offsetted = allMemories.slice(options.offset);
    targetMemories = Number.isFinite(options.limit) ? offsetted.slice(0, options.limit) : offsetted;
  }

  console.log(`Targeting ${targetMemories.length} of ${allMemories.length} total memories.`);

  const memoryIds = targetMemories.map((m) => m.id);
  const [media, tags] = await Promise.all([
    loadMediaForMemories(supabase, memoryIds),
    loadTagsForMemories(supabase, memoryIds),
  ]);

  const mediaByMemory = new Map<string, MediaRow[]>();
  for (const row of media) {
    const list = mediaByMemory.get(row.memory_id) ?? [];
    list.push(row);
    mediaByMemory.set(row.memory_id, list);
  }

  const tagsByMemory = new Map<string, string[]>();
  for (const tag of tags) {
    const list = tagsByMemory.get(tag.memory_id) ?? [];
    list.push(tag.family_member_id);
    tagsByMemory.set(tag.memory_id, list);
  }

  const outputDir = new URL(`./eval-output/memory-book-tagging/${runId}/`, import.meta.url);
  await Deno.mkdir(outputDir, { recursive: true });
  const resultsPath = new URL('results.jsonl', outputDir).pathname;

  const priorResults: ResultLine[] = [];
  const resumeSkipIds = new Set<string>();
  if (options.resume) {
    try {
      const priorText = await Deno.readTextFile(options.resume);
      for (const rawLine of priorText.split('\n')) {
        if (!rawLine.trim()) continue;
        const parsed = JSON.parse(rawLine) as ResultLine;
        priorResults.push(parsed);
        resumeSkipIds.add(parsed.memoryId);
      }
      // Copy prior lines into the new run's results.jsonl verbatim.
      for (const line of priorResults) {
        await Deno.writeTextFile(resultsPath, JSON.stringify(line) + '\n', { append: true, create: true });
      }
      console.log(`Resumed from ${options.resume}: ${priorResults.length} prior result(s) carried forward.`);
    } catch (error) {
      console.error(`Failed to read --resume file: ${error instanceof Error ? error.message : error}`);
      Deno.exit(1);
    }
  }

  const toProcess = targetMemories.filter((m) => !resumeSkipIds.has(m.id));
  console.log(`Processing ${toProcess.length} memor${toProcess.length === 1 ? 'y' : 'ies'} (${resumeSkipIds.size} skipped via --resume).`);

  const emotionKeys = new Set(Object.keys(EMOTION_PALETTES));
  const catalogIds = new Set(catalogEntries.map((entry) => entry.id));
  const vocabIds = new Set(vocabEntries.map((entry) => entry.id));
  const systemPrompt = buildSystemPrompt(Object.keys(EMOTION_PALETTES), catalogEntries, options.mode, vocabEntries);
  console.log(`Tagging mode: ${options.mode}`);

  const deps: ProcessDeps = {
    systemPrompt,
    emotionKeys,
    catalogIds,
    vocabIds,
    mode: options.mode,
    model: options.model,
    apiKey,
    maxImages: options.maxImages,
    dryRun: options.dryRun,
    outputDir,
  };

  const newResults: ResultLine[] = new Array(toProcess.length);
  let completed = 0;

  await runPool(toProcess, options.concurrency, async (memory, index) => {
    const taggedMemberIds = tagsByMemory.get(memory.id) ?? [];
    const familyMembers = familyMembersByFamily.get(memory.family_id) ?? [];
    const taggedMembers = familyMembers.filter((m) => taggedMemberIds.includes(m.id));
    const memoryMedia = (mediaByMemory.get(memory.id) ?? []).slice().sort((a, b) => a.position - b.position);

    const result = await processMemory({ memory, taggedMembers, media: memoryMedia }, deps);
    newResults[index] = result;

    if (!options.dryRun) {
      await queueAppendResultLine(resultsPath, result);
    }

    completed += 1;
    if (completed % 10 === 0 || completed === toProcess.length) {
      console.log(`  ... ${completed}/${toProcess.length} memories processed`);
    }
  });

  const allResults = [...priorResults, ...newResults];

  const frequencyMarkdown = renderFrequencyMarkdown(runId, allResults, options.dryRun, options.mode);
  await Deno.writeTextFile(new URL('frequency.md', outputDir), frequencyMarkdown);

  if (!options.dryRun) {
    const reviewHtml = renderReviewHtml(runId, allResults);
    await Deno.writeTextFile(new URL('review.html', outputDir), reviewHtml);
  }

  const stats = computeRunStats(allResults);
  console.log('\nDone.');
  console.log(`  Processed: ${stats.processed}, skipped: ${stats.skippedNoInput}, errors: ${stats.errors}`);
  console.log(`  Output dir: ${outputDir.pathname}`);
}

if (import.meta.main) {
  await main();
}
