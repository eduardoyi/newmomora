/**
 * Memory Book V2 — curation outline generator (docs/plans/memory-book.md §5
 * Stage B "Curation", §9 validation row V2). This is NOT production code; it
 * is a read-only eval harness that builds a reviewable **book outline** for
 * one child + one time scope from the REAL production columns `analyze-memory`
 * now writes: `memories.topics/topic_details/labels/description/emotion/
 * analyzed_at`, `memory_milestones`, `memory_family_members`,
 * `memory_media`, `family_member_portrait_versions`, and
 * `memory_likes`/`memory_comments` (engagement).
 *
 * Pipeline (plan §5 Stage B): a deterministic scaffold (cover, title/
 * dedication, "through the years" portrait strip, a chronological backbone
 * segmented by month, a Firsts spread, one spread per birthday, closing) is
 * built entirely in code. Themed-spread CANDIDATES (topics with >=4 eligible
 * memories) are also computed in code. Exactly ONE OpenAI call per book then
 * selects/sequences: which themed candidates make the cut and where they
 * slot into the chronological flow, which memories go in each (3-6, with a
 * one-line rationale each), which backbone memories deserve a full-page
 * "highlight" treatment, and an overall editorial note. The model curates;
 * it never rewrites parent text and never paginates -- every downstream rule
 * (single placement, small-spread dissolution, page-budget trimming) is
 * enforced in CODE, never trusted from the model (plan §5 "Overlap and
 * single placement", "Code-enforced post-processing").
 *
 * This script is READ-ONLY against the database: every data read goes
 * through the RLS-scoped client (the service-role admin client only
 * bootstraps the auth session), exactly like eval-memory-book-tagging.ts /
 * eval-memory-book-audit.ts.
 *
 * PII rule: memory `content` text and its derived excerpt are used to build
 * the OpenAI prompt and are written to outline.md/outline.json/review.html
 * (an own-account, gitignored review artifact -- sanctioned by plan §9's V1c/
 * V2 rows for the same class of output) but are NEVER printed to stdout --
 * console output is ids, dates, counts, and page totals only.
 *
 * Examples:
 *   npm run eval:memory-book-outline -- --child "Enzo" --age-year 1 --dry-run
 *   npm run eval:memory-book-outline -- --child <family_member-uuid> --calendar-year 2024
 *   npm run eval:memory-book-outline -- --child "Mara" --from 2023-06-01 --to 2023-12-31 --page-budget 40
 *
 * Requires Supabase vars in supabase/.env.local, R2 vars for thumbnail
 * fetches, and OPENAI_API_KEY (unless --dry-run).
 * DB/R2/OpenAI env access is not available in every environment this script
 * runs in -- it must typecheck even when it cannot be executed.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { describeAgeAtDate, getAgeInYearsAtDate } from '../functions/_shared/age.ts';
import { getObjectBytes } from '../functions/_shared/r2.ts';
import { addYears, classifyChildOrAdult, toJulianDayNumber } from '../functions/_shared/date-context.ts';
import { DATE_GATED_TOPIC_IDS, TOPICS } from '../functions/_shared/memory-topics.ts';
import { getMilestoneById } from '../functions/_shared/memory-milestones.ts';

// ── CLI ──────────────────────────────────────────────────────────────────

interface CliOptions {
  child: string | null;
  ageYear: number | null;
  calendarYear: number | null;
  from: string | null;
  to: string | null;
  pageCap: number;
  model: string;
  dryRun: boolean;
  /** Owner round-3 decision, 2026-08-27: one-off editorial exclusions
   * (collage/comparison composites, etc.) -- repeatable
   * `--exclude-memory-id <uuid>`. Excluded ids are removed from ELIGIBILITY
   * entirely, before any candidate/backbone/firsts computation, so they can
   * never surface in an element, a candidate spread, a highlight, or Firsts
   * -- not merely dropped for budget later. */
  excludeMemoryIds: string[];
}

// Owner amendment (2026-08-24): the outline is one call per book -- quality
// over cost -- so the default model is intentionally not the cheap tagging
// model. `gpt-5.6-sol` per explicit owner instruction; `--model` overrides.
const DEFAULT_MODEL = 'gpt-5.6-sol';
/** The layflat print product's hard physical page limit. Owner decision,
 * 2026-08-27 ("Density & quality-first"): `--page-cap` now defaults to
 * this and is the single BINDING constraint end to end, replacing the old
 * soft 50-page default -- longer books are accepted up to this limit;
 * quality of output comes first. */
export const HARD_PAGE_CAP = 122;

/** Printed alongside a rejected argument (owner hardening fix, 2026-08-27:
 * never-silently-drop applies at the CLI level too -- a malformed
 * invocation once passed a single mangled string containing all five
 * `--exclude-memory-id` flags, and the run proceeded WITHOUT exclusions,
 * silently, because `parseArgs` swallowed the unrecognized token). */
export const CLI_USAGE =
  'Usage: eval-memory-book-outline.ts --child <id|name> ' +
  '(--age-year <n> | --calendar-year <year> | --from <date> --to <date>) ' +
  '[--page-cap <n>] [--model <name>] [--dry-run] [--exclude-memory-id <uuid>]...';

/**
 * Throws on any argument that isn't one of the known flags (or a value
 * already consumed by one) -- owner hardening fix, 2026-08-27. Previously
 * an unrecognized token fell through `default: break` and was silently
 * ignored; the caller (`main`) catches this and exits non-zero with the
 * offending token + `CLI_USAGE` rather than proceeding with a partially
 * (or, in the reported incident, entirely) unparsed invocation.
 */
export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    child: null,
    ageYear: null,
    calendarYear: null,
    from: null,
    to: null,
    pageCap: HARD_PAGE_CAP,
    model: DEFAULT_MODEL,
    dryRun: false,
    excludeMemoryIds: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    switch (arg) {
      case '--child':
        options.child = next ?? null;
        index += 1;
        break;
      case '--age-year':
        options.ageYear = next ? Number(next) : null;
        index += 1;
        break;
      case '--calendar-year':
        options.calendarYear = next ? Number(next) : null;
        index += 1;
        break;
      case '--from':
        options.from = next ?? null;
        index += 1;
        break;
      case '--to':
        options.to = next ?? null;
        index += 1;
        break;
      case '--page-cap':
        options.pageCap = next ? Number(next) || HARD_PAGE_CAP : HARD_PAGE_CAP;
        index += 1;
        break;
      case '--model':
        if (next) options.model = next;
        index += 1;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--exclude-memory-id':
        if (next) options.excludeMemoryIds.push(next);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: "${arg}"\n${CLI_USAGE}`);
    }
  }

  return options;
}

// ── Book scope + scope window (plan §4 book scope, brief scope rules) ──────

export type BookScope =
  | { type: 'age-year'; ageYear: number }
  | { type: 'calendar-year'; year: number }
  | { type: 'custom-range'; from: string; to: string };

/**
 * Validates the CLI's scope flags resolve to exactly one scope (plan brief:
 * "scope: exactly one of --age-year, --calendar-year, or --from/--to").
 * Pure + exported so the "exactly one scope" contract is unit-testable
 * without CLI plumbing.
 */
export function resolveBookScope(options: {
  ageYear: number | null;
  calendarYear: number | null;
  from: string | null;
  to: string | null;
}): BookScope {
  const provided = [
    options.ageYear !== null,
    options.calendarYear !== null,
    options.from !== null || options.to !== null,
  ].filter(Boolean).length;

  if (provided !== 1) {
    throw new Error('Exactly one of --age-year, --calendar-year, or --from/--to must be provided.');
  }

  if (options.ageYear !== null) {
    if (!Number.isFinite(options.ageYear) || options.ageYear < 1) {
      throw new Error('--age-year must be a positive integer (1 = "Year One", birth -> 1st birthday).');
    }
    return { type: 'age-year', ageYear: options.ageYear };
  }

  if (options.calendarYear !== null) {
    if (!Number.isFinite(options.calendarYear)) {
      throw new Error('--calendar-year must be a 4-digit year.');
    }
    return { type: 'calendar-year', year: options.calendarYear };
  }

  if (!options.from || !options.to) {
    throw new Error('--from and --to must both be provided together.');
  }
  if (options.from > options.to) {
    throw new Error('--from must be on or before --to.');
  }
  return { type: 'custom-range', from: options.from, to: options.to };
}

const ORDINAL_WORDS = [
  'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen',
  'Eighteen', 'Nineteen', 'Twenty',
];

/** `ageYear` is 1-based (1 = "Year One" = birth -> 1st birthday). */
export function ageYearLabel(ageYear: number): string {
  const word = ORDINAL_WORDS[ageYear - 1] ?? String(ageYear);
  return `Year ${word}`;
}

/**
 * Gregorian date -> Julian Day Number inverse (Fliegel & Van Flandern),
 * companion to `toJulianDayNumber` imported from date-context.ts. Needed
 * only here (custom-range's exclusive end boundary, and displaying an
 * age-year/custom-range's inclusive last day) -- not added to the shared
 * module because no production caller needs it yet.
 */
export function fromJulianDayNumber(jdn: number): { year: number; month: number; day: number } {
  const a = jdn + 32044;
  const b = Math.floor((4 * a + 3) / 146097);
  const c = a - Math.floor((146097 * b) / 4);
  const d = Math.floor((4 * c + 3) / 1461);
  const e = c - Math.floor((1461 * d) / 4);
  const m = Math.floor((5 * e + 2) / 153);
  const day = e - Math.floor((153 * m + 2) / 5) + 1;
  const month = m + 3 - 12 * Math.floor(m / 10);
  const year = 100 * b + d - 4800 + Math.floor(m / 10);
  return { year, month, day };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
function pad4(n: number): string {
  return String(n).padStart(4, '0');
}

export function addDays(dateStr: string, days: number): string {
  const jdn = toJulianDayNumber(dateStr) + days;
  const { year, month, day } = fromJulianDayNumber(jdn);
  return `${pad4(year)}-${pad2(month)}-${pad2(day)}`;
}

export interface ScopeWindow {
  /** Inclusive. */
  start: string;
  /** Exclusive -- every eligibility check is `date >= start && date < endExclusive`. */
  endExclusive: string;
  label: string;
}

/**
 * Half-open [start, endExclusive) scope window for all three scope types
 * (brief: "n=1 -> Year One = birth->1st birthday; window from the child's
 * date_of_birth using the shared addYears-style math"). Half-open keeps
 * every downstream eligibility check a single `>= start && < endExclusive`
 * comparison regardless of scope type.
 */
export function computeScopeWindow(scope: BookScope, dateOfBirth: string | null): ScopeWindow {
  if (scope.type === 'age-year') {
    if (!dateOfBirth) {
      throw new Error('Child has no date_of_birth on file -- cannot compute an age-year scope.');
    }
    return {
      start: addYears(dateOfBirth, scope.ageYear - 1),
      endExclusive: addYears(dateOfBirth, scope.ageYear),
      label: ageYearLabel(scope.ageYear),
    };
  }

  if (scope.type === 'calendar-year') {
    return {
      start: `${pad4(scope.year)}-01-01`,
      endExclusive: `${pad4(scope.year + 1)}-01-01`,
      label: String(scope.year),
    };
  }

  return {
    start: scope.from,
    endExclusive: addDays(scope.to, 1),
    label: `${scope.from} to ${scope.to}`,
  };
}

/** Inclusive last day of the window, for display only. */
export function scopeWindowLastInclusiveDay(window: ScopeWindow): string {
  return addDays(window.endExclusive, -1);
}

// ── Row shapes (hand-typed -- matches src/types/database.ts) ───────────────

interface FamilyRow {
  id: string;
  name: string;
}

interface FamilyMemberRow {
  id: string;
  family_id: string;
  name: string;
  date_of_birth: string | null;
}

interface MemoryRow {
  id: string;
  family_id: string;
  content: string | null;
  memory_date: string;
  memory_type: string;
  emotion: string | null;
  topics: string[];
  topic_details: Record<string, string>;
  analyzed_at: string | null;
}

export interface MediaRow {
  id: string;
  memory_id: string;
  object_key: string;
  content_type: string;
  position: number;
  preview_object_key: string | null;
  aspect_ratio: number | null;
}

interface TagRow {
  memory_id: string;
  family_member_id: string;
}

interface MilestoneRow {
  id: string;
  memory_id: string;
  family_member_id: string | null;
  milestone_id: string;
  detail: string | null;
  out_of_band: boolean;
}

interface PortraitVersionRow {
  id: string;
  family_member_id: string;
  reference_date: string | null;
  illustrated_profile_status: string;
}

// ── Auth (same pattern as eval-illustration.ts / eval-memory-book-tagging.ts) ─

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

// ── Small utilities (same pattern as eval-memory-book-tagging.ts) ──────────

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

const CHUNK_SIZE = 200;
const PAGE_SIZE = 1000;

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Data loading (RLS-scoped client for every read) ─────────────────────

async function loadFamilies(supabase: AuthedClient): Promise<FamilyRow[]> {
  const { data, error } = await supabase.from('families').select('id, name').is('deleted_at', null);
  if (error) throw new Error(`Failed to load families: ${error.message}`);
  return (data ?? []) as FamilyRow[];
}

async function loadFamilyMembers(supabase: AuthedClient, familyId: string): Promise<FamilyMemberRow[]> {
  const { data, error } = await supabase
    .from('family_members')
    .select('id, family_id, name, date_of_birth')
    .eq('family_id', familyId);
  if (error) throw new Error(`Failed to load family_members: ${error.message}`);
  return (data ?? []) as FamilyMemberRow[];
}

function loadMemoriesInWindow(
  supabase: AuthedClient,
  familyId: string,
  window: ScopeWindow,
): Promise<MemoryRow[]> {
  return fetchAllRows<MemoryRow>(
    (from, to) =>
      supabase
        .from('memories')
        .select('id, family_id, content, memory_date, memory_type, emotion, topics, topic_details, analyzed_at')
        .eq('family_id', familyId)
        .gte('memory_date', window.start)
        .lt('memory_date', window.endExclusive)
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
          .select('id, memory_id, object_key, content_type, position, preview_object_key, aspect_ratio')
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
          .order('memory_id', { ascending: true })
          .order('family_member_id', { ascending: true })
          .range(from, to),
      'memory_family_members',
    );
    out.push(...rows);
  }
  return out;
}

export async function loadMilestonesForMemories(supabase: AuthedClient, memoryIds: string[]): Promise<MilestoneRow[]> {
  const out: MilestoneRow[] = [];
  for (const ids of chunk(memoryIds, CHUNK_SIZE)) {
    if (ids.length === 0) continue;
    const rows = await fetchAllRows<MilestoneRow>(
      (from, to) =>
        supabase
          .from('memory_milestones')
          .select('id, memory_id, family_member_id, milestone_id, detail, out_of_band')
          // Owner round-4 decision, 2026-08-27: a 'dismissed' row is the
          // owner correcting a factually-wrong milestone match (product-
          // correct path -- the future confirmation UI does exactly this),
          // so it must never surface anywhere downstream: not the Firsts
          // section, not per-memory milestone context, and not birthday
          // detection -- `birthdayAgeTurned` is derived from this SAME
          // query's `milestone_id === 'birthday'` rows in
          // `buildMemoryFeature`, so filtering here covers all three paths
          // at once (there is no separate, unfiltered birthday query).
          .neq('status', 'dismissed')
          .in('memory_id', ids)
          .order('id', { ascending: true })
          .range(from, to),
      'memory_milestones',
    );
    out.push(...rows);
  }
  return out;
}

async function loadEngagementCounts(supabase: AuthedClient, memoryIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const id of memoryIds) counts.set(id, 0);

  for (const ids of chunk(memoryIds, CHUNK_SIZE)) {
    if (ids.length === 0) continue;

    const [likeRows, commentRows] = await Promise.all([
      fetchAllRows<{ memory_id: string }>(
        (from, to) =>
          supabase
            .from('memory_likes')
            .select('memory_id')
            .in('memory_id', ids)
            .order('memory_id', { ascending: true })
            .order('user_id', { ascending: true })
            .range(from, to),
        'memory_likes',
      ),
      fetchAllRows<{ memory_id: string }>(
        (from, to) =>
          supabase
            .from('memory_comments')
            .select('memory_id')
            .in('memory_id', ids)
            .order('id', { ascending: true })
            .range(from, to),
        'memory_comments',
      ),
    ]);

    for (const row of likeRows) counts.set(row.memory_id, (counts.get(row.memory_id) ?? 0) + 1);
    for (const row of commentRows) counts.set(row.memory_id, (counts.get(row.memory_id) ?? 0) + 1);
  }

  return counts;
}

async function loadPortraitVersionsInWindow(
  supabase: AuthedClient,
  childId: string,
  window: ScopeWindow,
): Promise<PortraitVersionRow[]> {
  const { data, error } = await supabase
    .from('family_member_portrait_versions')
    .select('id, family_member_id, reference_date, illustrated_profile_status')
    .eq('family_member_id', childId)
    .eq('illustrated_profile_status', 'ready')
    .gte('reference_date', window.start)
    .lt('reference_date', window.endExclusive)
    .order('reference_date', { ascending: true });

  if (error) throw new Error(`Failed to load family_member_portrait_versions: ${error.message}`);
  return (data ?? []) as PortraitVersionRow[];
}

// ── Child resolution (pure) ──────────────────────────────────────────────

export interface ChildCandidate {
  id: string;
  familyId: string;
  name: string;
  dateOfBirth: string | null;
}

/**
 * `--child` accepts either a `family_members` id or an exact name match
 * (plan brief). Exported so "which child did the caller mean" is
 * unit-testable independent of the DB round trip.
 */
export function resolveChild(members: ChildCandidate[], query: string): ChildCandidate {
  const byId = members.find((m) => m.id === query);
  if (byId) return byId;

  const byName = members.filter((m) => m.name === query);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new Error(`Multiple family members are named "${query}" -- pass --child <family_member id> instead.`);
  }

  throw new Error(`No family member found matching --child "${query}" (checked id and exact name).`);
}

// ── Eligibility (plan: "tagged to the child OR untagged-but-in-window") ────

export interface EligibilityResult {
  eligible: boolean;
  taggedToChild: boolean;
  untaggedInWindow: boolean;
}

export function computeMemoryEligibility(taggedMemberIds: string[], childId: string): EligibilityResult {
  const taggedToChild = taggedMemberIds.includes(childId);
  const untaggedInWindow = taggedMemberIds.length === 0;
  return { eligible: taggedToChild || untaggedInWindow, taggedToChild, untaggedInWindow };
}

// ── Per-memory features ──────────────────────────────────────────────────

export interface MemoryMilestoneFeature {
  milestoneId: string;
  name: string;
  detail: string | null;
  outOfBand: boolean;
}

export interface MemoryFeature {
  id: string;
  date: string;
  topics: string[];
  topicDetails: Record<string, string>;
  emotion: string | null;
  hasText: boolean;
  /** First 120 chars of `content`. Local review-artifact + AI-prompt use
   * only -- NEVER logged to stdout (PII rule). */
  excerpt: string | null;
  /** Full content character count (owner round-3 decision, 2026-08-27:
   * content-neutral ranking's "text richness" signal, and the page-yield
   * model's short/long illustrated-story split) -- NEVER the content
   * itself, just its length, so this stays safe to log per the PII rule. */
  textLength: number;
  photoCount: number;
  videoCount: number;
  previewKey: string | null;
  engagementCount: number;
  milestones: MemoryMilestoneFeature[];
  /** Age turned, from the deterministic `birthday` milestone row (plan: "the
   * child's own birthday" -- filtered to family_member_id === child.id
   * upstream in buildMemoryFeature's caller). */
  birthdayAgeTurned: number | null;
  taggedToChild: boolean;
  /** Every tagged person's own name/nickname (as the family wrote it) plus
   * child/adult/unknown, sent to the AI as the ONLY sanctioned source of
   * relationship words in titles/rationales (plan round-2 decision,
   * 2026-08-25) -- never inferred from photos or topic tags. */
  taggedMembers: TaggedMemberFeature[];
  /** The first photo asset's orientation (owner root-cause fix,
   * 2026-08-27), straight from `memory_media.aspect_ratio` -- null when no
   * photo, or the first photo has no aspect data. Sent to the AI so it can
   * actually judge panorama/hero suitability instead of guessing blind. */
  photoOrientation: PhotoOrientationInfo | null;
}

export interface TaggedMemberFeature {
  firstName: string;
  personType: 'child' | 'adult' | 'unknown';
}

const TEXT_EXCERPT_MAX_CHARS = 120;
const PHOTO_CONTENT_TYPE_PREFIX = 'image/';
const VIDEO_CONTENT_TYPE_PREFIX = 'video/';

function firstUsablePreviewKey(media: MediaRow[]): string | null {
  const sorted = [...media].sort((a, b) => a.position - b.position);
  for (const row of sorted) {
    if (row.preview_object_key) return row.preview_object_key;
    if (row.content_type.startsWith(PHOTO_CONTENT_TYPE_PREFIX)) return row.object_key;
  }
  return null;
}

// ── Photo orientation (owner root-cause fix, 2026-08-27: the AI nominated
// only portrait photos as panorama candidates because orientation was never
// in its metadata at all) ────────────────────────────────────────────────

export type PhotoOrientation = 'wide' | 'tall' | 'square';

const WIDE_ASPECT_RATIO_THRESHOLD = 1.15;
const TALL_ASPECT_RATIO_THRESHOLD = 0.87;
/** A `wide` photo at or above this ratio gets its approximate ratio spelled
 * out (e.g. "wide 1.7:1") since panorama nomination wants genuinely wide,
 * not just technically-landscape. */
const WIDE_RATIO_CALLOUT_THRESHOLD = 1.5;

export function classifyOrientation(aspectRatio: number): PhotoOrientation {
  if (aspectRatio > WIDE_ASPECT_RATIO_THRESHOLD) return 'wide';
  if (aspectRatio < TALL_ASPECT_RATIO_THRESHOLD) return 'tall';
  return 'square';
}

export interface PhotoOrientationInfo {
  orientation: PhotoOrientation;
  ratio: number;
}

/**
 * The FIRST photo asset's orientation, by `position`, straight from
 * `memory_media.aspect_ratio` -- never falls back to a later photo when the
 * first one lacks aspect data (per the brief: "omit marker when no aspect
 * data" for THAT memory, not "use whichever photo happens to have data").
 * Videos and photos with no aspect_ratio are skipped only in the sense that
 * a video never counts as "the first photo asset"; the first PHOTO
 * specifically is what's inspected, whether or not it has aspect data.
 */
export function computeFirstPhotoOrientation(media: MediaRow[]): PhotoOrientationInfo | null {
  const sorted = [...media].sort((a, b) => a.position - b.position);
  const firstPhoto = sorted.find((m) => m.content_type.startsWith(PHOTO_CONTENT_TYPE_PREFIX));
  if (!firstPhoto || firstPhoto.aspect_ratio === null || firstPhoto.aspect_ratio === undefined) return null;
  return { orientation: classifyOrientation(firstPhoto.aspect_ratio), ratio: firstPhoto.aspect_ratio };
}

/** The compact marker appended to a memory's metadata row -- `null` when
 * there's no aspect data to report (the field is simply omitted, never
 * shown as "unknown"). */
export function formatOrientationMarker(info: PhotoOrientationInfo | null): string | null {
  if (!info) return null;
  if (info.orientation === 'wide' && info.ratio >= WIDE_RATIO_CALLOUT_THRESHOLD) {
    return `wide ${info.ratio.toFixed(1)}:1`;
  }
  return info.orientation;
}

export interface FamilyMemberForTagging {
  id: string;
  name: string;
  dateOfBirth: string | null;
}

/**
 * Resolves each tagged member id into the name/nickname the family actually
 * gave them plus a child/adult classification at the memory's date -- the
 * ONLY sanctioned source of relationship words for the AI (plan round-2
 * decision, 2026-08-25). Unresolvable ids (shouldn't happen -- every tag
 * references a real family member) are silently skipped rather than thrown,
 * matching this script's tolerant-read style.
 */
export function buildTaggedMemberFeatures(
  taggedMemberIds: string[],
  membersById: Map<string, FamilyMemberForTagging>,
  memoryDate: string,
): TaggedMemberFeature[] {
  const out: TaggedMemberFeature[] = [];
  for (const id of taggedMemberIds) {
    const member = membersById.get(id);
    if (!member) continue;
    const ageYears = member.dateOfBirth ? getAgeInYearsAtDate(member.dateOfBirth, memoryDate) : null;
    out.push({
      firstName: member.name.trim().split(/\s+/)[0] || member.name,
      personType: classifyChildOrAdult(ageYears),
    });
  }
  return out;
}

export function buildMemoryFeature(
  memory: MemoryRow,
  media: MediaRow[],
  taggedMemberIds: string[],
  childId: string,
  milestoneRows: MilestoneRow[],
  engagementCount: number,
  taggedMembers: TaggedMemberFeature[] = [],
): MemoryFeature {
  const photoCount = media.filter((m) => m.content_type.startsWith(PHOTO_CONTENT_TYPE_PREFIX)).length;
  const videoCount = media.filter((m) => m.content_type.startsWith(VIDEO_CONTENT_TYPE_PREFIX)).length;
  const content = memory.content?.trim() ?? '';

  const childMilestoneRows = milestoneRows.filter((m) => m.family_member_id === childId);
  const nonBirthdayMilestones = childMilestoneRows.filter((m) => m.milestone_id !== 'birthday');
  const birthdayRow = childMilestoneRows.find((m) => m.milestone_id === 'birthday');

  return {
    id: memory.id,
    date: memory.memory_date,
    topics: memory.topics ?? [],
    topicDetails: memory.topic_details ?? {},
    emotion: memory.emotion,
    hasText: content.length > 0,
    excerpt: content ? content.slice(0, TEXT_EXCERPT_MAX_CHARS) : null,
    textLength: content.length,
    photoCount,
    videoCount,
    previewKey: firstUsablePreviewKey(media),
    engagementCount,
    milestones: nonBirthdayMilestones.map((m) => ({
      milestoneId: m.milestone_id,
      name: getMilestoneById(m.milestone_id)?.name ?? m.milestone_id,
      detail: m.detail,
      outOfBand: m.out_of_band,
    })),
    birthdayAgeTurned: birthdayRow?.detail ? Number(birthdayRow.detail) : null,
    taggedToChild: taggedMemberIds.includes(childId),
    taggedMembers,
    photoOrientation: computeFirstPhotoOrientation(media),
  };
}

// ── Deterministic backbone segmentation (plan: "chronological backbone
// segmented by month (merge adjacent months with <3 printable memories into
// one segment)") ───────────────────────────────────────────────────────

export interface BackboneMemoryInput {
  id: string;
  date: string;
  printable: boolean;
}

export interface BackboneSegment {
  id: string;
  label: string;
  monthKeys: string[];
  memoryIds: string[];
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function formatMonthRangeLabel(monthKeys: string[]): string {
  const first = monthKeys[0];
  const last = monthKeys[monthKeys.length - 1];
  const [fy, fm] = first.split('-').map(Number);
  const [ly, lm] = last.split('-').map(Number);

  if (first === last) return `${MONTH_NAMES[fm - 1]} ${fy}`;
  if (fy === ly) return `${MONTH_NAMES[fm - 1]}–${MONTH_NAMES[lm - 1]} ${fy}`;
  return `${MONTH_NAMES[fm - 1]} ${fy} – ${MONTH_NAMES[lm - 1]} ${ly}`;
}

/**
 * Groups memories by calendar month (reading order), then greedily merges
 * consecutive months forward until the running printable count reaches
 * `minPrintablePerSegment`, flushing a segment each time the threshold is
 * met. Any trailing months that never reach the threshold are folded into
 * the previous segment (or, if there is no previous segment -- the whole
 * scope never reaches 3 printable memories -- kept as a single small
 * segment; there is nothing to merge them into).
 */
export function buildBackboneSegments(
  memories: BackboneMemoryInput[],
  minPrintablePerSegment = 3,
): BackboneSegment[] {
  const byMonth = new Map<string, BackboneMemoryInput[]>();
  for (const memory of memories) {
    const key = memory.date.slice(0, 7);
    const list = byMonth.get(key) ?? [];
    list.push(memory);
    byMonth.set(key, list);
  }

  const monthKeys = [...byMonth.keys()].sort();
  const segments: BackboneSegment[] = [];

  let pendingMonths: string[] = [];
  let pendingIds: string[] = [];
  let pendingPrintable = 0;

  for (const key of monthKeys) {
    const bucket = byMonth.get(key)!;
    pendingMonths.push(key);
    pendingIds.push(...bucket.map((m) => m.id));
    pendingPrintable += bucket.filter((m) => m.printable).length;

    if (pendingPrintable >= minPrintablePerSegment) {
      segments.push({
        id: pendingMonths.join('_'),
        label: formatMonthRangeLabel(pendingMonths),
        monthKeys: pendingMonths,
        memoryIds: pendingIds,
      });
      pendingMonths = [];
      pendingIds = [];
      pendingPrintable = 0;
    }
  }

  if (pendingMonths.length > 0) {
    if (segments.length > 0) {
      const last = segments[segments.length - 1];
      last.monthKeys.push(...pendingMonths);
      last.memoryIds.push(...pendingIds);
      last.id = last.monthKeys.join('_');
      last.label = formatMonthRangeLabel(last.monthKeys);
    } else {
      segments.push({
        id: pendingMonths.join('_'),
        label: formatMonthRangeLabel(pendingMonths),
        monthKeys: pendingMonths,
        memoryIds: pendingIds,
      });
    }
  }

  return segments;
}

// ── Candidate generators (plan §5 Stage B, decided 2026-08-24: THREE
// deterministic candidate generators feed the single AI curation call --
// topic clusters, people-pair spreads, and emotion spreads) ────────────

export interface ThemedCandidate {
  topicId: string;
  pageTitle: string;
  memoryIds: string[];
}

export function selectThemedCandidates(
  topicMemberships: Array<{ memoryId: string; topics: string[] }>,
  topicPageTitles: Map<string, string>,
  minCount = 4,
): ThemedCandidate[] {
  const byTopic = new Map<string, string[]>();
  for (const { memoryId, topics } of topicMemberships) {
    for (const topicId of topics) {
      const list = byTopic.get(topicId) ?? [];
      list.push(memoryId);
      byTopic.set(topicId, list);
    }
  }

  const candidates: ThemedCandidate[] = [];
  for (const [topicId, memoryIds] of byTopic) {
    if (memoryIds.length >= minCount) {
      candidates.push({ topicId, pageTitle: topicPageTitles.get(topicId) ?? topicId, memoryIds });
    }
  }

  return candidates.sort((a, b) => b.memoryIds.length - a.memoryIds.length || a.topicId.localeCompare(b.topicId));
}

const TOPIC_PAGE_TITLES = new Map(TOPICS.map((t) => [t.id, t.pageTitle]));

const SPARSE_TOPIC_TRIGGER_COUNT = 3;
const SPARSE_TOPIC_MIN_COUNT = 3;
const DEFAULT_TOPIC_MIN_COUNT = 4;

/**
 * Plan (2026-08-24 outline review): the topic threshold drops from >=4 to
 * >=3 when the primary pass finds fewer than 3 topic candidates (sparse
 * Year One books, where the archive is mostly photo-led with thin topic
 * coverage). Re-running at the lower threshold rather than always using it
 * keeps precision-first behavior the default; the fallback only kicks in
 * when the primary pass would otherwise leave the book with almost no
 * themed material to draw on.
 */
export function selectTopicCandidatesWithSparseFallback(
  topicMemberships: Array<{ memoryId: string; topics: string[] }>,
  topicPageTitles: Map<string, string>,
  primaryMinCount = DEFAULT_TOPIC_MIN_COUNT,
  sparseMinCount = SPARSE_TOPIC_MIN_COUNT,
  sparseTriggerCount = SPARSE_TOPIC_TRIGGER_COUNT,
): ThemedCandidate[] {
  const primary = selectThemedCandidates(topicMemberships, topicPageTitles, primaryMinCount);
  if (primary.length < sparseTriggerCount) {
    return selectThemedCandidates(topicMemberships, topicPageTitles, sparseMinCount);
  }
  return primary;
}

/**
 * People-pair spreads (Looking Back's pair recipe, plan §5: "for each
 * family member co-tagged with the subject child in >=4 in-scope memories,
 * a candidate 'with <Name>' spread"). `coTagMemberships` should already be
 * restricted to memories where the SUBJECT CHILD is tagged (co-tagging is
 * meaningless without the child present) -- see the caller in `main()`.
 * Capped at the top 3 by co-tag count (plan: "Cap at 3 pair candidates").
 */
export interface PeoplePairCandidate {
  memberId: string;
  memberName: string;
  memoryIds: string[];
}

const PEOPLE_PAIR_MIN_COUNT = 4;
const PEOPLE_PAIR_CAP = 3;

export function selectPeoplePairCandidates(
  coTagMemberships: Array<{ memoryId: string; coTaggedMemberIds: string[] }>,
  memberNamesById: Map<string, string>,
  minCount = PEOPLE_PAIR_MIN_COUNT,
  cap = PEOPLE_PAIR_CAP,
): PeoplePairCandidate[] {
  const byMember = new Map<string, string[]>();
  for (const { memoryId, coTaggedMemberIds } of coTagMemberships) {
    for (const memberId of coTaggedMemberIds) {
      const list = byMember.get(memberId) ?? [];
      list.push(memoryId);
      byMember.set(memberId, list);
    }
  }

  const candidates: PeoplePairCandidate[] = [];
  for (const [memberId, memoryIds] of byMember) {
    if (memoryIds.length >= minCount) {
      candidates.push({ memberId, memberName: memberNamesById.get(memberId) ?? memberId, memoryIds });
    }
  }

  return candidates
    .sort((a, b) => b.memoryIds.length - a.memoryIds.length || a.memberId.localeCompare(b.memberId))
    .slice(0, cap);
}

/**
 * Emotion spreads (Looking Back's emotion recipe, plan §5: "The funny
 * ones"). Only `funny` and `tender` are eligible -- `mischief` folds into
 * `funny` per the plan's explicit merge instruction (both read as the same
 * "made us laugh" shelf in a keepsake book).
 */
export interface EmotionCandidate {
  emotion: 'funny' | 'tender';
  memoryIds: string[];
}

const EMOTION_SPREAD_TARGETS: ReadonlyArray<'funny' | 'tender'> = ['funny', 'tender'];
const EMOTION_SPREAD_MIN_COUNT = 4;

export function selectEmotionCandidates(
  memoryEmotions: Array<{ memoryId: string; emotion: string | null }>,
  targets: ReadonlyArray<'funny' | 'tender'> = EMOTION_SPREAD_TARGETS,
  minCount = EMOTION_SPREAD_MIN_COUNT,
): EmotionCandidate[] {
  const byEmotion = new Map<'funny' | 'tender', string[]>();
  for (const { memoryId, emotion } of memoryEmotions) {
    if (!emotion) continue;
    const normalized = emotion === 'mischief' ? 'funny' : emotion;
    if (!targets.includes(normalized as 'funny' | 'tender')) continue;
    const key = normalized as 'funny' | 'tender';
    const list = byEmotion.get(key) ?? [];
    list.push(memoryId);
    byEmotion.set(key, list);
  }

  const candidates: EmotionCandidate[] = [];
  for (const [emotion, memoryIds] of byEmotion) {
    if (memoryIds.length >= minCount) candidates.push({ emotion, memoryIds });
  }

  return candidates.sort((a, b) => b.memoryIds.length - a.memoryIds.length || a.emotion.localeCompare(b.emotion));
}

// ── Unified candidate model (every generator flows into the SAME AI call) ──

export type CandidateKind = 'topic' | 'people-pair' | 'emotion';

/** One curation candidate, regardless of which generator produced it. `id`
 * is globally unique (`topic:<id>`, `people:<memberId>`, `emotion:<key>`)
 * and is what the AI response's `candidate_id` field references. */
export interface Candidate {
  id: string;
  kind: CandidateKind;
  defaultTitle: string;
  memoryIds: string[];
}

const EMOTION_SPREAD_DEFAULT_TITLES: Record<'funny' | 'tender', string> = {
  funny: 'The funny ones',
  tender: 'The tender ones',
};

export function topicCandidatesToUnified(candidates: ThemedCandidate[]): Candidate[] {
  return candidates.map((c) => ({ id: `topic:${c.topicId}`, kind: 'topic', defaultTitle: c.pageTitle, memoryIds: c.memoryIds }));
}

export function peoplePairCandidatesToUnified(candidates: PeoplePairCandidate[]): Candidate[] {
  return candidates.map((c) => ({
    id: `people:${c.memberId}`,
    kind: 'people-pair',
    defaultTitle: `With ${c.memberName}`,
    memoryIds: c.memoryIds,
  }));
}

export function emotionCandidatesToUnified(candidates: EmotionCandidate[]): Candidate[] {
  return candidates.map((c) => ({
    id: `emotion:${c.emotion}`,
    kind: 'emotion',
    defaultTitle: EMOTION_SPREAD_DEFAULT_TITLES[c.emotion],
    memoryIds: c.memoryIds,
  }));
}

/**
 * Time-anchored topics (plan round-2 decision, 2026-08-25): `newborn-days`
 * (not itself date-gated, but inherently tied to a specific real-world
 * window) plus every date-gated seasonal topic from the shared vocabulary
 * (Christmas, Halloween, Thanksgiving, Easter, Valentine's, New Year, Lunar
 * New Year, Hanukkah, Eid, Diwali, Dia de Muertos, Mother's/Father's Day).
 * A themed spread built from one of these must stay pinned near its median
 * memory date -- pacing may relocate every OTHER candidate kind (people-pair,
 * emotion, non-seasonal topics) but never these.
 */
export const TIME_ANCHORED_TOPIC_IDS: ReadonlySet<string> = new Set(['newborn-days', ...DATE_GATED_TOPIC_IDS]);

/** Whether a unified candidate id (e.g. `topic:christmas`) is time-anchored. */
export function isTimeAnchoredCandidate(candidateId: string): boolean {
  if (!candidateId.startsWith('topic:')) return false;
  return TIME_ANCHORED_TOPIC_IDS.has(candidateId.slice('topic:'.length));
}

// ── Single-placement resolution (plan §5 "Overlap and single placement":
// "assigned where it is scarcest/most valuable") ───────────────────────

export interface PlacementCandidate {
  memoryId: string;
  spreadId: string;
}

export interface SinglePlacementResult {
  placementByMemory: Map<string, string>;
  reassignments: Array<{ memoryId: string; droppedFrom: string[]; keptIn: string }>;
}

/**
 * A memory that is a candidate for more than one spread is kept in whichever
 * candidate spread has the FEWEST members (scarcity -- plan: "assigned where
 * it is scarcest/most valuable"), using each spread's INITIAL candidate size
 * (not recomputed as memories get resolved elsewhere): scarcity is a
 * property of how thin each spread's overall material is, not a moving
 * target that changes mid-resolution. Ties break on spreadId so the result
 * is fully deterministic.
 */
export function resolveSinglePlacement(candidates: PlacementCandidate[]): SinglePlacementResult {
  const bySpread = new Map<string, Set<string>>();
  const byMemory = new Map<string, string[]>();

  for (const c of candidates) {
    if (!bySpread.has(c.spreadId)) bySpread.set(c.spreadId, new Set());
    bySpread.get(c.spreadId)!.add(c.memoryId);

    const list = byMemory.get(c.memoryId) ?? [];
    if (!list.includes(c.spreadId)) list.push(c.spreadId);
    byMemory.set(c.memoryId, list);
  }

  const initialCounts = new Map<string, number>();
  for (const [spreadId, members] of bySpread) initialCounts.set(spreadId, members.size);

  const placementByMemory = new Map<string, string>();
  const reassignments: SinglePlacementResult['reassignments'] = [];

  for (const [memoryId, spreadIds] of [...byMemory.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (spreadIds.length === 1) {
      placementByMemory.set(memoryId, spreadIds[0]);
      continue;
    }

    const sorted = [...spreadIds].sort((a, b) => {
      const diff = (initialCounts.get(a) ?? 0) - (initialCounts.get(b) ?? 0);
      return diff !== 0 ? diff : a.localeCompare(b);
    });

    const keptIn = sorted[0];
    placementByMemory.set(memoryId, keptIn);
    reassignments.push({ memoryId, droppedFrom: spreadIds.filter((s) => s !== keptIn), keptIn });
  }

  return { placementByMemory, reassignments };
}

// ── Dissolve undersized themed spreads (plan: "themed spreads that fall
// below 3 memories after dedup are dissolved back into the backbone") ─────

export interface DissolveResult {
  placementByMemory: Map<string, string>;
  dissolvedSpreadIds: string[];
  movedToBackbone: Array<{ memoryId: string; fromSpread: string; toSpread: string }>;
}

export function dissolveSmallThemedSpreads(
  placementByMemory: Map<string, string>,
  themedSpreadIds: Set<string>,
  defaultBackboneByMemory: Map<string, string>,
  minSize = 3,
): DissolveResult {
  const result = new Map(placementByMemory);
  const dissolvedSpreadIds: string[] = [];
  const movedToBackbone: DissolveResult['movedToBackbone'] = [];

  const countBySpread = new Map<string, number>();
  for (const spreadId of result.values()) {
    countBySpread.set(spreadId, (countBySpread.get(spreadId) ?? 0) + 1);
  }

  for (const spreadId of [...themedSpreadIds].sort()) {
    const count = countBySpread.get(spreadId) ?? 0;
    if (count > 0 && count < minSize) {
      dissolvedSpreadIds.push(spreadId);
      for (const [memoryId, placedIn] of [...result.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (placedIn !== spreadId) continue;
        const backboneId = defaultBackboneByMemory.get(memoryId);
        if (!backboneId) continue; // Should not happen -- every eligible memory has a backbone home.
        result.set(memoryId, backboneId);
        movedToBackbone.push({ memoryId, fromSpread: spreadId, toSpread: backboneId });
      }
    }
  }

  return { placementByMemory: result, dissolvedSpreadIds, movedToBackbone };
}

// ── Birthday-beat merge rule (owner round-3 note, 2026-08-25: a birthday
// spread with <3 memories duplicates the beat already carried by its
// specially-titled birthday-month backbone segment, and can't fill 2 pages
// anyway) ────────────────────────────────────────────────────────────────

export interface BirthdayDissolveResult {
  placementByMemory: Map<string, string>;
  /** Ages (ascending) whose spread dissolved into the backbone. */
  dissolvedAges: number[];
  /** The dissolved memories -- MUST survive backbone thinning (passed as
   * `pinnedIds` to `selectBackboneMemories`), since a birthday memory
   * folding into its month is the whole point of the merge. */
  pinnedMemoryIds: Set<string>;
  movedToBackbone: Array<{ memoryId: string; fromSpread: string; toSpread: string }>;
}

/**
 * Mirrors `dissolveSmallThemedSpreads`'s mechanics exactly (same <3
 * threshold, same "move to the memory's own default backbone segment"
 * behavior) but is a distinct function because the birthday case ALSO
 * needs the dissolved memories flagged as pinned -- a themed-spread
 * dissolve just returns memories to backbone ELIGIBILITY (they can still
 * lose to rank-based thinning), but a dissolved birthday spread's memories
 * must GUARANTEE their birthday-flagged month keeps its special title, so
 * they can never be thinned away.
 */
export function dissolveThinBirthdaySpreads(
  placementByMemory: Map<string, string>,
  birthdaySpreadIds: Set<string>,
  defaultBackboneByMemory: Map<string, string>,
  minSize = 3,
): BirthdayDissolveResult {
  const result = new Map(placementByMemory);
  const dissolvedAges: number[] = [];
  const pinnedMemoryIds = new Set<string>();
  const movedToBackbone: BirthdayDissolveResult['movedToBackbone'] = [];

  const countBySpread = new Map<string, number>();
  for (const spreadId of result.values()) {
    countBySpread.set(spreadId, (countBySpread.get(spreadId) ?? 0) + 1);
  }

  for (const spreadId of [...birthdaySpreadIds].sort()) {
    const count = countBySpread.get(spreadId) ?? 0;
    if (count > 0 && count < minSize) {
      dissolvedAges.push(Number(spreadId.slice('birthday-'.length)));
      for (const [memoryId, placedIn] of [...result.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (placedIn !== spreadId) continue;
        const backboneId = defaultBackboneByMemory.get(memoryId);
        if (!backboneId) continue; // Should not happen -- every eligible memory has a backbone home.
        result.set(memoryId, backboneId);
        pinnedMemoryIds.add(memoryId);
        movedToBackbone.push({ memoryId, fromSpread: spreadId, toSpread: backboneId });
      }
    }
  }

  return { placementByMemory: result, dissolvedAges: dissolvedAges.sort((a, b) => a - b), pinnedMemoryIds, movedToBackbone };
}

// ── Page accounting + priority-order budget enforcement ────────────────
//
// Corrected priority order (coordinator spec correction, 2026-08-24 -- the
// original brief's "backbone is fixed, thin it last" framing inverted the
// book's own goal): the chronological backbone is connective tissue, not
// the book, so it is the LOWEST priority for page budget, not the highest.
//
//   a. Non-droppable: cover/title/through-years/closing (4 fixed pages) +
//      Firsts + every birthday spread. These are never dropped or thinned
//      regardless of budget.
//   b. Themed spreads accepted by the AI: next priority. Only dropped
//      (lowest page-cost first) if (a)+(b) alone exceed the page cap.
//   c. The backbone gets ONLY the pages left over after (a)+(b) -- a real
//      PAGE budget (owner round-3 decision, 2026-08-27 -- see below).
//
// True page-yield model (owner round-3 decision, 2026-08-27, replacing the
// prior round's images-per-page density constants; refined same day to
// split short text-only memories into two renderer groupings): every
// memory's page cost is estimated HONESTLY from its own shape (photo
// count, text length, type), mirroring the renderer's real composition
// decision table -- solo photo ~1 page/memory, two paired photos ~1
// page/2 memories, a single memory's 3-4 photo grid ~1 page, a full-bleed
// hero 1 page, a panorama 2 pages, a short (<=200 char) text-only memory
// is EITHER a bare quote (~0.4 pages, 3-6 share a quote-collection spread)
// or a short illustrated story (~1 page, two share a 2-page spread), a
// long illustrated story 2 pages, a plain text page 1. `122`
// (`HARD_PAGE_CAP`) is a CEILING, not a target: everything that clears a
// meaningful-quality bar is selected; selection only tightens (dropping
// the lowest-ranked memory) once the honest estimate exceeds the cap. A
// content-poor scope naturally yields a shorter book -- never pad.

export type BudgetElementKind = 'themed' | 'firsts' | 'birthday' | 'backbone';

export interface BudgetElement {
  id: string;
  kind: BudgetElementKind;
  memoryCount: number;
  /** Per-member page shape (owner round-3 decision, 2026-08-27) -- drives
   * this element's page cost for 'backbone'/'themed' kinds via
   * `estimateElementPages`. Unused for 'firsts'/'birthday', which stay flat
   * 2-page elements -- out of scope for this change (see plan's separate,
   * not-yet-implemented "Firsts lists paginate" note). */
  shapes?: MemoryPageShape[];
}

const FIXED_PAGES = 4; // cover + title/dedication + through-the-years + closing

/**
 * A single memory's rendered "shape" -- the composition kind the real
 * renderer would choose for it, per the owner's round-3 yield table
 * (2026-08-27, refined same day to add `short-text`). `panorama`/
 * `full-bleed` are driven by whether this memory was actually nominated as
 * a panorama/hero candidate (never guessed from photo count alone);
 * everything else is inferred from photo/video count and text length.
 * `short-text` and `short-illustrated-story` are BOTH "short" text-only
 * memories (<=200 chars) but render differently: `short-text` is a bare
 * quote that joins a 3-6-up quote-collection spread, `short-illustrated-
 * story` gets its own small illustration and shares a spread with one
 * other. Which of the two a given short memory becomes is not something
 * this script's data can determine with certainty (no illustration-
 * completion signal is tracked here) -- it is approximated by length via
 * `SHORT_TEXT_MAX_CHARS`, a named constant for tuning after visual review.
 */
export type MemoryPageShape =
  | 'panorama'
  | 'full-bleed'
  | 'photo-grid'
  | 'solo-photo'
  | 'short-text'
  | 'short-illustrated-story'
  | 'long-story'
  | 'text-page';

export interface MemoryPageShapeInput {
  photoCount: number;
  videoCount: number;
  hasText: boolean;
  textLength: number;
  /** This memory is one of the model's nominated `panoramaCandidates`. */
  isPanorama: boolean;
  /** This memory is one of the model's nominated `heroCandidates`. */
  isFullBleed: boolean;
}

/** Named constant for tuning after visual review (owner round-3
 * refinement, 2026-08-27): a text-only memory at or under this length is a
 * bare "quote" -- it joins the quote-collection grouping (`short-text`)
 * rather than getting its own small illustration. Deliberately shorter
 * than `SHORT_STORY_MAX_CHARS` -- the two thresholds carve the "short"
 * (<=200 char) range into two different renderer groupings. */
export const SHORT_TEXT_MAX_CHARS = 100;

/** Named constant for tuning after visual review (owner round-3 decision,
 * 2026-08-27, refined same day: lowered from 400 to ~200 alongside the
 * `short-text` split): a text-only memory longer than this many characters
 * renders as a 2-page "long illustrated story" instead of a short one that
 * shares a spread with another. */
export const SHORT_STORY_MAX_CHARS = 200;

/**
 * Classifies a single memory's page shape from its own content -- never
 * from its "type" as a privileged category (owner round-3 decision,
 * 2026-08-27: content-neutral ranking). A panorama/full-bleed nomination
 * always wins (those are deliberate editorial placements, not a photo-count
 * accident); otherwise a 3+ photo/video memory is a single-memory grid, any
 * other visual memory is a solo photo, and a text-only memory splits by
 * length into a bare quote, a short illustrated story, or a long one. A
 * memory with neither text nor a visual (shouldn't occur given eligibility
 * rules) falls back to a flat text-page cost rather than costing nothing.
 */
export function classifyMemoryPageShape(m: MemoryPageShapeInput): MemoryPageShape {
  if (m.isPanorama) return 'panorama';
  if (m.isFullBleed) return 'full-bleed';
  const visualCount = m.photoCount + m.videoCount;
  if (visualCount >= 3) return 'photo-grid';
  if (visualCount >= 1) return 'solo-photo';
  if (m.hasText) {
    if (m.textLength <= SHORT_TEXT_MAX_CHARS) return 'short-text';
    return m.textLength > SHORT_STORY_MAX_CHARS ? 'long-story' : 'short-illustrated-story';
  }
  return 'text-page';
}

/** Named constant for tuning after visual review (owner round-3
 * refinement, 2026-08-27): a `short-text` quote costs ~0.4 pages on
 * average in its 3-6-up quote-collection grouping -- an approximation, not
 * a precise per-group derivation (a group can be anywhere from 3 to 6). */
export const SHORT_TEXT_PAGES_PER_ENTRY = 0.4;

/**
 * Honest page cost of a group of memories' shapes, per the owner's round-3
 * yield table (2026-08-27, refined same day): `panorama` 2,
 * `full-bleed`/`photo-grid`/`text-page`/`short-illustrated-story` 1,
 * `long-story` 2 -- each 1:1 per memory (two `short-illustrated-story`
 * memories naturally sum to 2 pages, i.e. share one 2-page spread, with no
 * special pairing math needed). `solo-photo` memories PAIR two-per-page
 * (rounded up), mirroring "paired memories ~1 page/2 memories".
 * `short-text` quotes accumulate at `SHORT_TEXT_PAGES_PER_ENTRY` pages each
 * or, ROUNDED UP as a group (a lone short-text quote still costs a full
 * page, same floor logic as `solo-photo`). An empty list costs 0 pages;
 * callers needing "a non-empty element still needs at least 1 page" apply
 * `Math.max(1, ...)`.
 */
export function estimateElementPages(shapes: MemoryPageShape[]): number {
  let pages = 0;
  let soloPhotoCount = 0;
  let shortTextCount = 0;
  for (const shape of shapes) {
    switch (shape) {
      case 'panorama':
        pages += 2;
        break;
      case 'full-bleed':
      case 'photo-grid':
      case 'text-page':
      case 'short-illustrated-story':
        pages += 1;
        break;
      case 'long-story':
        pages += 2;
        break;
      case 'solo-photo':
        soloPhotoCount += 1;
        break;
      case 'short-text':
        shortTextCount += 1;
        break;
    }
  }
  pages += Math.ceil(soloPhotoCount / 2);
  pages += Math.ceil(shortTextCount * SHORT_TEXT_PAGES_PER_ENTRY);
  return pages;
}

export function computePageEstimate(elements: BudgetElement[], fixedPages = FIXED_PAGES): number {
  let total = fixedPages;
  for (const el of elements) {
    if (el.memoryCount <= 0) continue;
    if (el.kind === 'backbone' || el.kind === 'themed') {
      total += Math.max(1, estimateElementPages(el.shapes ?? []));
    } else {
      total += 2; // firsts / birthday -- flat, unchanged (out of scope for this change).
    }
  }
  return total;
}

/**
 * The number of the model's best-first `panoramaCandidates` that MUST be
 * placed in the book, not merely nominated (owner round-3 decision,
 * 2026-08-27: "1 guaranteed + 1 per ~20 pages" -- the same pacing the
 * system prompt already tells the model to expect). `pageEstimate` is a
 * PRELIMINARY estimate (before any budget thinning) so a bigger book earns
 * more guaranteed panoramas without the guarantee count depending on its
 * own outcome.
 */
export function computePlacedPanoramaGuaranteeCount(pageEstimate: number): number {
  return 1 + Math.floor(Math.max(0, pageEstimate) / 20);
}

/**
 * Content-neutral ranking signals (owner round-3 decision, 2026-08-27,
 * replacing the type-privileged ladder -- milestone > has_text+photo >
 * visual+engagement > visual > text-only -- that caused a 77-illustration
 * skew by letting one memory "type" trump everything else). Every memory
 * now competes on the SAME signals regardless of type: editorial highlight/
 * hero status, engagement, thematic (topic-cluster) relevance, text
 * richness, and photo/video presence -- each contributes additively, none
 * is an automatic trump. Structural protections (Firsts-section membership,
 * birthday pins, guaranteed panorama placement) are handled OUTSIDE this
 * score entirely, as pins that bypass ranking (see `selectBackboneMemories`).
 */
export interface ThinningSignals {
  /** Marked as a backbone highlight OR nominated as a hero candidate. */
  isHighlighted: boolean;
  /** A member of at least one accepted topic/people-pair/emotion candidate
   * spread, even though single-placement or budget left it in the backbone
   * -- evidence of thematic relevance. */
  inThemedCluster: boolean;
  engagementCount: number;
  hasText: boolean;
  textLength: number;
  /** photoCount + videoCount > 0 (videos rank as visuals, same as photos). */
  hasVisual: boolean;
}

const HIGHLIGHT_SCORE = 4;
const THEMED_CLUSTER_SCORE = 2;
const ENGAGEMENT_SCORE_CAP = 5;
const VISUAL_SCORE = 2;
const TEXT_BASE_SCORE = 1;
/** ~80 chars of text earns 1 richness point, capped -- named constant for
 * tuning after visual review. */
const TEXT_RICHNESS_CHAR_DIVISOR = 80;
const TEXT_RICHNESS_CAP = 3;

export function computeThinningScore(s: ThinningSignals): number {
  let score = 0;
  if (s.isHighlighted) score += HIGHLIGHT_SCORE;
  if (s.inThemedCluster) score += THEMED_CLUSTER_SCORE;
  score += Math.min(s.engagementCount, ENGAGEMENT_SCORE_CAP);
  if (s.hasVisual) score += VISUAL_SCORE;
  if (s.hasText) {
    score += TEXT_BASE_SCORE + Math.min(Math.floor(s.textLength / TEXT_RICHNESS_CHAR_DIVISOR), TEXT_RICHNESS_CAP);
  }
  return score;
}

export interface ThemedBudgetElement {
  id: string;
  memoryCount: number;
  /** Member page shapes -- drives this spread's page cost (owner round-3
   * decision, 2026-08-27) and its drop order (lowest page-cost first,
   * unchanged in spirit from the prior round's "lowest image count first"). */
  shapes: MemoryPageShape[];
}

export interface NonBackboneBudgetPlan {
  /** fixed + non-droppable (Firsts/birthdays) + surviving themed spreads. */
  nonBackbonePages: number;
  keptThemedIds: string[];
  droppedThemedIds: string[];
  /** What's left of `pageCap` for the backbone, in PAGES -- a real page
   * budget now (owner round-3 decision, 2026-08-27), consumed directly by
   * `selectBackboneMemories`. */
  backboneCapacityPages: number;
}

function themedSpreadPages(t: ThemedBudgetElement): number {
  return t.memoryCount > 0 ? Math.max(1, estimateElementPages(t.shapes)) : 0;
}

/**
 * Priority steps (a) and (b): `nonDroppablePages` (already computed by the
 * caller as `2 * (Firsts present ? 1 : 0) + 2 * birthdayCount`, plus any
 * themed spread protected by a guaranteed-panorama pin) is never touched.
 * Themed spreads are dropped lowest-page-cost-first, one at a time, ONLY
 * while (a)+(b) together still exceed `pageCap` -- i.e. the backbone is
 * never consulted here at all.
 */
export function planNonBackboneBudget(
  fixedPages: number,
  nonDroppablePages: number,
  themedSpreads: ThemedBudgetElement[],
  pageCap: number,
): NonBackboneBudgetPlan {
  const kept = [...themedSpreads];
  const droppedThemedIds: string[] = [];
  const themedPages = () => kept.reduce((sum, t) => sum + themedSpreadPages(t), 0);

  while (fixedPages + nonDroppablePages + themedPages() > pageCap && kept.some((t) => t.memoryCount > 0)) {
    kept.sort((a, b) => themedSpreadPages(a) - themedSpreadPages(b) || a.memoryCount - b.memoryCount || a.id.localeCompare(b.id));
    const dropIndex = kept.findIndex((t) => t.memoryCount > 0);
    const [dropped] = kept.splice(dropIndex, 1);
    droppedThemedIds.push(dropped.id);
  }

  const nonBackbonePages = fixedPages + nonDroppablePages + themedPages();
  return {
    nonBackbonePages,
    keptThemedIds: kept.filter((t) => t.memoryCount > 0).map((t) => t.id),
    droppedThemedIds,
    backboneCapacityPages: Math.max(0, pageCap - nonBackbonePages),
  };
}

export interface BackboneCandidate {
  id: string;
  date: string;
  score: number;
  shape: MemoryPageShape;
  /** Same `printable` predicate `buildOutline` feeds into the REAL final
   * `buildBackboneSegments` call over the survivors (owner round-4
   * root-cause fix, 2026-08-27) -- needed here so the tightening loop's own
   * segmentation matches that final one exactly, month-merge behavior
   * included. */
  printable: boolean;
}

/**
 * The backbone's honest page cost SEGMENTED exactly like the final book
 * (owner round-4 root-cause fix, 2026-08-27): re-runs `buildBackboneSegments`
 * over whatever candidates are still kept, then sums each segment's own
 * `Math.max(1, estimateElementPages(...))` -- the SAME per-element floor
 * `computePageEstimate` applies to a 'backbone' element. This replaces a
 * prior flat estimate that ran `estimateElementPages` over the WHOLE
 * backbone as one ungrouped list, letting solo-photos in unrelated months
 * pair together and charging only ONE floor for the entire backbone instead
 * of one per segment -- a live regeneration hit pageEstimate 128 against a
 * pageCap of 122 because this tightening loop had already declared itself
 * "under budget" using that undercounted flat number. Segmenting here is
 * what makes the loop's own notion of "does it fit" match what
 * `computePageEstimate` will compute once selection is done.
 */
function backboneSegmentedPages(candidates: BackboneCandidate[]): number {
  if (candidates.length === 0) return 0;
  const shapeById = new Map(candidates.map((c) => [c.id, c.shape]));
  const segments = buildBackboneSegments(
    candidates.map((c) => ({ id: c.id, date: c.date, printable: c.printable })),
  );
  return segments.reduce(
    (sum, s) => sum + Math.max(1, estimateElementPages(s.memoryIds.map((id) => shapeById.get(id)!))),
    0,
  );
}

/**
 * Priority step (c) (owner round-3 decision, 2026-08-27): starts with EVERY
 * candidate kept -- a content-poor scope naturally yields a shorter book,
 * never padded -- and, only while the honest page-yield estimate
 * (`backboneSegmentedPages`, segmented exactly like the final book -- owner
 * round-4 root-cause fix, 2026-08-27) exceeds `pageBudget`, drops the single
 * LOWEST-SCORED unpinned candidate at a time (ties: latest date first, then
 * id, for full determinism) until it fits. Replaces the prior round's
 * "text is free, only visual competes for an image budget" rule -- ALL
 * memories now compete on the same content-neutral score.
 *
 * `pinnedIds` (birthday-beat merges, and now guaranteed panorama
 * placements -- owner round-3 decision, 2026-08-27) bypass ranking
 * entirely: a pinned candidate is never dropped, though its page cost still
 * counts toward `pageBudget`. If every remaining candidate is pinned and
 * the budget is still exceeded, the loop stops -- pins always win, even
 * over the cap (the caller records this as an explicit integrity note
 * rather than silently persisting a pageEstimate above pageCap).
 */
export function selectBackboneMemories(
  candidates: BackboneCandidate[],
  pageBudget: number,
  pinnedIds: ReadonlySet<string> = new Set(),
): string[] {
  let kept = [...candidates];

  while (backboneSegmentedPages(kept) > pageBudget) {
    const droppable = kept
      .filter((c) => !pinnedIds.has(c.id))
      .sort((a, b) => a.score - b.score || b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
    if (droppable.length === 0) break; // Only pinned candidates remain -- pins always win.
    const dropId = droppable[0].id;
    kept = kept.filter((c) => c.id !== dropId);
  }

  return kept.map((c) => c.id);
}

/**
 * The last final segment whose own last month is <= `anchorMonth` (a
 * "YYYY-MM" string) -- i.e. "insert right after wherever this chronological
 * point lands". Returns -1 if `anchorMonth` predates every final segment
 * (or there are no final segments at all).
 */
export function findAnchorSegmentIndex(anchorMonth: string, segments: BackboneSegment[]): number {
  let index = -1;
  segments.forEach((segment, i) => {
    const segmentLastMonth = segment.monthKeys[segment.monthKeys.length - 1];
    if (segmentLastMonth <= anchorMonth) index = i;
  });
  return index;
}

/**
 * Remaps a themed spread's `insertAfterSegmentIndex` (an index into the
 * ORIGINAL, pre-budget backbone segment list the model saw) onto the FINAL,
 * post-budget segment list, which can have entirely different segments
 * after re-segmentation. Anchors on the original segment's last month via
 * `findAnchorSegmentIndex`. `-1` (or an out-of-range original index) means
 * "before everything" and maps straight through as `-1`.
 */
export function remapInsertIndex(
  originalIndex: number,
  originalSegments: BackboneSegment[],
  finalSegments: BackboneSegment[],
): number {
  if (originalIndex < 0 || originalIndex >= originalSegments.length) return -1;

  const originalMonths = originalSegments[originalIndex].monthKeys;
  const anchorMonth = originalMonths[originalMonths.length - 1];
  return findAnchorSegmentIndex(anchorMonth, finalSegments);
}

/**
 * Lower-median of a list of `YYYY-MM-DD` date strings (sorts correctly as
 * plain strings). Used to find each candidate spread's "center of gravity"
 * in time for pacing's chronological soft-preference. Throws on an empty
 * list -- callers only invoke this for spreads with >=1 member memory
 * (dissolve already removes anything smaller).
 */
export function computeMedianDate(dates: string[]): string {
  if (dates.length === 0) {
    throw new Error('computeMedianDate: cannot compute a median of zero dates');
  }
  const sorted = [...dates].sort();
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

// ── Pacing (plan §5 outline-review decision, 2026-08-24: "no 3+ consecutive
// backbone month-segments when spreads are available to interleave,
// chronological affinity demoted to a soft preference") ────────────────

/**
 * A "run" of `minRunLength` (default 3) consecutive, unbroken backbone
 * segments is exactly `minRunLength - 1` consecutive UNOCCUPIED internal
 * gaps (the gap between segment i and i+1, for i in 0..segmentCount-2 --
 * placing a spread at gap i means "right after segment i", which splits
 * that adjacency). So preventing every such run reduces to: no
 * `minRunLength - 1` consecutive empty gaps. A periodic pattern (occupy
 * every `minRunLength - 1`-th gap) is a minimal, deterministic way to
 * guarantee that. Exported so the target gap set is independently
 * checkable in tests.
 */
export function computeRequiredPacingGaps(segmentCount: number, minRunLength = 3): number[] {
  const numGaps = Math.max(0, segmentCount - 1);
  const stride = minRunLength - 1;
  const required: number[] = [];
  if (stride <= 0) return required;
  for (let gap = stride - 1; gap < numGaps; gap += stride) {
    required.push(gap);
  }
  return required;
}

export interface PacingCandidate {
  id: string;
  /** Chronological soft preference -- typically the candidate's median
   * memory date, anchored to a final segment index via
   * `findAnchorSegmentIndex`. -1..segmentCount-1. */
  idealGapIndex: number;
  /** Plan round-2 decision (2026-08-25): time-anchored spreads (the
   * `newborn-days` topic, or any date-gated seasonal topic -- Christmas,
   * Halloween, a birthday party's own season, etc.) are pinned at
   * `idealGapIndex` and never relocated by pacing, even under scarcity --
   * moving "Los primeros dias contigo" to June defeats the point of the
   * spread. Still COUNTS toward gap coverage (an anchored spread sitting on
   * a required gap satisfies it), just never becomes a pacing DONOR. */
  anchored?: boolean;
}

/**
 * Redistributes themed/people-pair/emotion spreads across the backbone so
 * no run of `minRunLength`+ consecutive segments goes unbroken, AS LONG AS
 * a spread is available to relocate there (plan: "while any themed spread
 * could break it up" -- under scarcity, some runs may stay unbroken; that's
 * the best achievable, not a bug). A candidate is "free" to move to fill an
 * uncovered required gap when it is NOT anchored, AND its CURRENT gap
 * either isn't itself required, or is required but already covered by
 * another candidate too -- i.e. moving it creates no new violation. Among
 * free candidates for a given gap, the one whose ORIGINAL `idealGapIndex`
 * is numerically closest wins (soft chronological preference; ties break on
 * id). Firsts (now at the end of the book) and birthday spreads never pass
 * through this function -- they have fixed positions outside the backbone
 * entirely.
 */
export function paceThemedSpreads(
  segmentCount: number,
  candidates: PacingCandidate[],
  minRunLength = 3,
): Map<string, number> {
  const assignment = new Map<string, number>();
  const idealById = new Map<string, number>();
  for (const c of candidates) {
    assignment.set(c.id, c.idealGapIndex);
    idealById.set(c.id, c.idealGapIndex);
  }

  const requiredGaps = computeRequiredPacingGaps(segmentCount, minRunLength);
  if (requiredGaps.length === 0 || candidates.length === 0) return assignment;

  for (const gap of requiredGaps) {
    const alreadyCovered = [...assignment.values()].some((v) => v === gap);
    if (alreadyCovered) continue;

    const freeCandidates = candidates.filter((c) => {
      if (c.anchored) return false;
      const current = assignment.get(c.id)!;
      const occupantsAtCurrent = [...assignment.values()].filter((v) => v === current).length;
      const currentIsRequired = requiredGaps.includes(current);
      return !currentIsRequired || occupantsAtCurrent > 1;
    });

    if (freeCandidates.length === 0) continue; // Scarcity -- nothing safe to move here.

    freeCandidates.sort((a, b) => {
      const distA = Math.abs(idealById.get(a.id)! - gap);
      const distB = Math.abs(idealById.get(b.id)! - gap);
      return distA - distB || a.id.localeCompare(b.id);
    });

    assignment.set(freeCandidates[0].id, gap);
  }

  return assignment;
}

// ── Reading order assembly (single source of truth for both outline.md and
// review.html -- see the bug this replaced: rendering a themed spread was
// previously coupled to whether the specific original backbone segment it
// was anchored to survived budget thinning, so a themed/Firsts/birthday
// spread could silently vanish from the reading order even though it was
// still present in the final element list) ─────────────────────────────

export type ReadingOrderSectionKind =
  | 'cover' | 'title' | 'through-the-years' | 'firsts' | 'birthday' | 'themed' | 'backbone' | 'closing';

export const FIRSTS_DEFAULT_TITLE = 'Big and small victories this year';

export interface ReadingOrderSection {
  id: string;
  kind: ReadingOrderSectionKind;
  title: string;
  memoryIds: string[];
  rationale: Record<string, string>;
  /** Only set for `kind: 'themed'` sections -- which of the three
   * deterministic generators produced this spread (outline.json's "type"
   * field, plan §5 decision 2026-08-24). */
  spreadType?: CandidateKind;
  /** Only set for a `kind: 'backbone'` segment carrying a special
   * birth/birthday title (plan round-2 decision, 2026-08-25): the plain
   * month label, kept visible as a subtitle under the special title. */
  subtitle?: string;
  /** Only set for `kind: 'themed'` sections (owner amendment, round-2,
   * 2026-08-25): whether the title is a verbatim/lightly-trimmed quote from
   * `titleSourceMemoryId`, or a descriptive title. Renderers show a quote
   * title in quotation marks with a "quoted from <date>" attribution. */
  titleMode?: SpreadTitleMode;
  titleSourceMemoryId?: string | null;
  /** Only set for `kind: 'themed'` sections (design handoff decision,
   * 2026-08-27): a short thematic eyebrow line (antetítulo) above the
   * title, rendered in small caps by the layout. */
  kicker?: string | null;
  /** Only set for `kind: 'backbone'` sections (design handoff decision,
   * 2026-08-27): memory ids within this segment marked as a highlight --
   * the design gates full-bleed pages on this. */
  highlights?: string[];
  /** Only set for the `kind: 'firsts'` section (owner round-3 decision,
   * 2026-08-27): one AI-drafted warm second-person rephrasing per milestone
   * row, persisted here so it lands in outline.json alongside the rest of
   * this section. Connective text, editable downstream -- never alters the
   * parent's own memory caption. */
  firstsWarmNames?: ParsedFirstsWarmName[];
}

export interface ReadingOrderThemedSpreadInput {
  candidateId: string;
  candidateKind: CandidateKind;
  title: string;
  titleMode: SpreadTitleMode;
  titleSourceMemoryId: string | null;
  memoryIds: string[];
  /** Already remapped + paced against `finalBackboneSegments` (see
   * `remapInsertIndex` and `paceThemedSpreads`). */
  insertAfterFinalSegmentIndex: number;
  rationale: Record<string, string>;
  kicker: string | null;
}

export interface ReadingOrderInput {
  childName: string;
  finalBackboneSegments: BackboneSegment[];
  /** Plan (2026-08-24 outline review): Firsts now closes the book,
   * reframed as a year wrap-up -- "big and small victories this year".
   * `title` is the AI's journal-language draft of that framing; falls back
   * to `FIRSTS_DEFAULT_TITLE` when the model didn't supply one. */
  firsts: { present: boolean; title: string | null; memoryIds: string[]; warmNames?: ParsedFirstsWarmName[] } | null;
  birthdaySpreads: Array<{ ageTurned: number; memoryIds: string[] }>;
  themedSpreads: ReadingOrderThemedSpreadInput[];
  backboneRationale: Record<string, string>;
  /** Backbone segment id -> special AI-drafted title (plan round-2 decision,
   * 2026-08-25: birth-month and birthday-month segments get a special title
   * instead of the plain month label; the plain label survives as a
   * subtitle). Segments not present here render their plain `label`. */
  specialSegmentTitles?: Record<string, string>;
  /** Every memory id marked as a highlight in ANY backbone segment (design
   * handoff decision, 2026-08-27), already validated to belong to its
   * claimed original segment. Each final segment's `highlights` is the
   * intersection of this set with that segment's own `memoryIds` -- so a
   * highlighted memory that got excluded by budget, or landed in a
   * different final segment after re-segmentation, is still handled
   * correctly with no separate bridging logic. */
  highlightedMemoryIds?: ReadonlySet<string>;
}

/**
 * Builds the full reading order as a flat, ordered list of sections. Both
 * `outline.md` and `review.html` iterate this SAME list, so there is only
 * one place that decides "does this spread appear, and where" -- fixing the
 * class of bug where the two renderers (or a renderer and its own nested
 * loop) could disagree about what survived.
 */
export function buildReadingOrder(input: ReadingOrderInput): ReadingOrderSection[] {
  const sections: ReadingOrderSection[] = [];

  sections.push({ id: 'cover', kind: 'cover', title: 'Cover', memoryIds: [], rationale: {} });
  sections.push({ id: 'title', kind: 'title', title: 'Title & dedication', memoryIds: [], rationale: {} });
  sections.push({
    id: 'through-the-years',
    kind: 'through-the-years',
    title: `Through the years -- ${input.childName}`,
    memoryIds: [],
    rationale: {},
  });

  for (const spread of [...input.birthdaySpreads].sort((a, b) => a.ageTurned - b.ageTurned)) {
    sections.push({
      id: `birthday-${spread.ageTurned}`,
      kind: 'birthday',
      title: `Birthday -- turns ${spread.ageTurned}`,
      memoryIds: spread.memoryIds,
      rationale: {},
    });
  }

  const lastValidIndex = input.finalBackboneSegments.length - 1;
  const themedByIndex = new Map<number, ReadingOrderThemedSpreadInput[]>();
  for (const spread of input.themedSpreads) {
    const clamped = Math.min(Math.max(spread.insertAfterFinalSegmentIndex, -1), lastValidIndex);
    const list = themedByIndex.get(clamped) ?? [];
    list.push(spread);
    themedByIndex.set(clamped, list);
  }

  const pushThemedAt = (index: number) => {
    const group = (themedByIndex.get(index) ?? []).slice().sort((a, b) => a.candidateId.localeCompare(b.candidateId));
    for (const spread of group) {
      sections.push({
        id: spread.candidateId,
        kind: 'themed',
        title: spread.title,
        memoryIds: spread.memoryIds,
        rationale: spread.rationale,
        spreadType: spread.candidateKind,
        titleMode: spread.titleMode,
        titleSourceMemoryId: spread.titleSourceMemoryId,
        kicker: spread.kicker,
      });
    }
  };

  const highlightedMemoryIds = input.highlightedMemoryIds ?? new Set<string>();

  pushThemedAt(-1);
  input.finalBackboneSegments.forEach((segment, index) => {
    const rationale: Record<string, string> = {};
    for (const id of segment.memoryIds) {
      if (input.backboneRationale[id]) rationale[id] = input.backboneRationale[id];
    }
    const specialTitle = input.specialSegmentTitles?.[segment.id];
    sections.push({
      id: `backbone:${segment.id}`,
      kind: 'backbone',
      title: specialTitle ?? segment.label,
      subtitle: specialTitle ? segment.label : undefined,
      memoryIds: segment.memoryIds,
      rationale,
      highlights: segment.memoryIds.filter((id) => highlightedMemoryIds.has(id)),
    });
    pushThemedAt(index);
  });

  // Plan (2026-08-24 outline review): Firsts moves to the END of the book,
  // immediately before Closing -- a year wrap-up, not an opener. Birthday
  // spreads stay chronological (unchanged above).
  if (input.firsts?.present) {
    sections.push({
      id: 'firsts',
      kind: 'firsts',
      title: input.firsts.title?.trim() || FIRSTS_DEFAULT_TITLE,
      memoryIds: input.firsts.memoryIds,
      rationale: {},
      firstsWarmNames: (input.firsts.warmNames ?? []).filter((w) => input.firsts!.memoryIds.includes(w.memoryId)),
    });
  }

  sections.push({ id: 'closing', kind: 'closing', title: 'Closing', memoryIds: [], rationale: {} });

  return sections;
}

// ── Special backbone titles for birth/birthday months (plan round-2
// decision, 2026-08-25) ─────────────────────────────────────────────────

export type SpecialSegmentFlagKind = 'birth' | 'birthday';

export interface SpecialSegmentFlag {
  segmentId: string;
  /** The specific "YYYY-MM" that triggered this flag -- used to bridge a
   * flag computed on the ORIGINAL (pre-budget) segment list to whichever
   * FINAL segment the same calendar month lands in after re-segmentation,
   * since segment ids/boundaries can change but the flagged month cannot. */
  month: string;
  kind: SpecialSegmentFlagKind;
  ageTurned?: number;
}

/**
 * Flags every segment containing the child's birth month (`kind: 'birth'`,
 * takes priority) or a month in which a birthday was celebrated (`kind:
 * 'birthday'`, one flag per segment even if multiple birthday months
 * happen to share a merged segment -- the first chronologically wins).
 * Pure and independent of budget/pacing so it can run identically on the
 * original (prompt-time) and final (render-time) segment lists.
 */
export function flagSpecialBackboneSegments(
  segments: BackboneSegment[],
  birthMonth: string | null,
  birthdayMonthToAge: Map<string, number>,
): SpecialSegmentFlag[] {
  const flags: SpecialSegmentFlag[] = [];
  for (const segment of segments) {
    if (birthMonth && segment.monthKeys.includes(birthMonth)) {
      flags.push({ segmentId: segment.id, month: birthMonth, kind: 'birth' });
      continue;
    }
    for (const month of segment.monthKeys) {
      const ageTurned = birthdayMonthToAge.get(month);
      if (ageTurned !== undefined) {
        flags.push({ segmentId: segment.id, month, kind: 'birthday', ageTurned });
        break;
      }
    }
  }
  return flags;
}

/**
 * Bridges the AI's `segment_titles` response (keyed by the ORIGINAL,
 * prompt-time segment ids the model actually saw) into a month-keyed map,
 * so a caller can look up the right special title for a FINAL segment even
 * though re-segmentation may have changed segment ids/boundaries -- the
 * calendar month a flag fired on never changes, so it is the stable key.
 */
export function buildSpecialSegmentTitlesByMonth(
  originalFlags: SpecialSegmentFlag[],
  aiTitlesBySegmentId: Record<string, string>,
): Map<string, string> {
  const byMonth = new Map<string, string>();
  for (const flag of originalFlags) {
    const title = aiTitlesBySegmentId[flag.segmentId];
    if (title && title.trim()) byMonth.set(flag.month, title.trim());
  }
  return byMonth;
}

/**
 * Birthday-beat precedence (owner round-3 note, 2026-08-25): when a
 * birthday spread SURVIVES on its own (>=3 memories, rendered as its own
 * section), the adjacent birthday-month segment reverts to its plain month
 * label instead of ALSO carrying the special title -- otherwise the same
 * celebration shows up twice, right next to itself. Birth-month flags are
 * never suppressed by this rule (there is no competing "birth spread" to
 * duplicate against).
 */
export function suppressSurvivingBirthdaySpecialTitles(
  flags: SpecialSegmentFlag[],
  survivingBirthdayAges: ReadonlySet<number>,
): SpecialSegmentFlag[] {
  return flags.filter((flag) => !(flag.kind === 'birthday' && survivingBirthdayAges.has(flag.ageTurned!)));
}

// ── AI call: prompt construction ─────────────────────────────────────────

export function buildOutlineSystemPrompt(): string {
  return [
    "You are the curator for a premium printed baby/family memory book, built from a parent's private journal entries. You receive a deterministic skeleton (already decided in code: cover, title page, a portrait timeline, a chronological backbone segmented by month, possibly birthday spreads, a Firsts spread that CLOSES the book, and a closing page) and a list of SPREAD CANDIDATES from three sources: topic clusters, people-pair spreads (\"With <Name>\"), and emotion spreads (\"The funny ones\"). Your job is to select and sequence -- not to write or rewrite.",
    '',
    "RULES:",
    "- The parent's text is sacred and will be printed verbatim later. You are selecting and sequencing memories, never rewriting or paraphrasing their words.",
    '- Prefer emotional variety over repetition: do not fill a book with near-duplicate moments when other emotions/topics are available.',
    '- When a memory fits several spreads, it belongs where it is scarcest -- prefer placing it in the spread it will do more work for, since code will only keep it in one place.',
    '- Never invent milestones, dates, or facts not present in the data you were given.',
    '- Never write "missing" or "behind" language about development -- celebrate what exists only.',
    '- If a Firsts spread is present (listed below), draft its title around the framing "big and small victories this year" -- in the family\'s own journal language (the same way you draft every other spread title), not a literal translation of that English phrase.',
    '',
    'FIRSTS WARM NAMES: for EACH row listed under FIRSTS MILESTONES below (if any), write a `warm_name` -- the milestone rephrased as a warm second-person sentence, in the family\'s journal language, addressed to the child. Examples: "Monta bicicleta sin pedales" -> "Aprendiste a montar bicicleta sin pedales"; "Primer corte de pelo" -> "Tuviste tu primer corte de pelo". This is connective text (editable downstream) and must NEVER alter the parent\'s own memory caption -- it stands alongside it, not instead of it. Echo back the exact `memory_id` and `milestone_id` from that row so code can match your `warm_name` to the right entry.',
    '',
    'RELATIONSHIP WORDS (aunt, uncle, grandma, "nonno", "abuelo", "zio", "mami", etc.) may ONLY come from the TAGGED PEOPLE listed on each memory below (their actual names/nicknames as the family wrote them -- reasoning from a name like "Nonna Rosa" or "Tio Mike" is fine, that is user-authored evidence). NEVER infer a relationship from what people look like in a photo, and NEVER infer one just because a topic tag like `extended-family` or `grandparents` is present -- a real failure titled a cluster of grandparent photos "Entre tias, tios y primos" (aunts, uncles, and cousins) purely from the topic tag, when the tagged people did not support that specific relationship mix. When you are not confident a specific relationship word is supported by the tagged people, use a warm generic title instead (spirit: "Look who came to see you") rather than guessing who someone is.',
    '',
    'SPREAD TITLES HAVE TWO MODES -- declare which one you used via `title_mode`:',
    '- "quote": verbatim (or lightly trimmed) text lifted from a memory INSIDE the spread. Preferred when a great one exists, especially for emotion/people-pair spreads (real examples that worked: "Ay Dios mío" on a funny spread, "Papi, con amor, por favor" on a tender one). Set `title_source_memory_id` to that memory\'s id -- code verifies the title actually appears in that memory\'s real text, so never fabricate or paraphrase a "quote".',
    '- "descriptive": any title that names a concrete place/activity/object.',
    '',
    'DESCRIPTIVE TITLES (and any QUOTE title that names something concrete, e.g. mentions a specific place) MUST BE TRUE OF EVERY MEMORY IN THE SPREAD. If member memories vary, choose a more general title that still fits all of them. If a single memory does not fit an otherwise-specific title, leave that memory OUT of the spread (it returns to backbone eligibility) rather than stretching the title. Real failure: a boat-trip memory was included inside a spread titled "¡Nos vamos en avión!" ("We\'re going by plane!") -- a boat is not a plane, so it should have been excluded from that spread, not included under a title that no longer fit every memory. A quote does not exempt a title from this rule.',
    '',
    'RATIONALES ARE INTERNAL, NEVER BOOK COPY. Every `rationale` value is a private curation note for the human reviewing this outline -- it is never printed in the book. Each one must:',
    '- Cite concrete evidence: which topic/emotion/milestone applies, engagement (likes/comments), has_text, or "only photo of X" -- something checkable in the data you were given.',
    '- Be telegraphic, max ~12 words. Not a sentence written for a reader.',
    '- GOOD: "only travel memory with text; high engagement"',
    '- BAD: "establishes adventure as part of the year" (this is prose written to justify a choice, not evidence)',
    '',
    'SPECIAL BACKBONE SEGMENT TITLES: some backbone segments below are flagged as the child\'s BIRTH month or a BIRTHDAY month. For ONLY those flagged segments (never any other segment), draft a special title in the family\'s journal language -- birth in the spirit of "welcome to the world", birthday in the spirit of "the month you turned N". Return these in `segment_titles`, keyed by the flagged segment\'s id. Do not add an entry for a segment that was not flagged.',
    '',
    'KICKER (antetítulo): for a THEMED spread ONLY (never for months/Firsts/birthday), you may add a `kicker` -- a short thematic eyebrow line that sits above the title (the design renders it in small caps), <=6 words, journal language. It is connective text, editable later, never parent text. Examples: "lo que nos hiciste reír" above the title "Ay Dios mío"; "lo que más te gustó hacer" above the title "Construir y jugar". Optional -- omit it rather than force one.',
    '',
    'HERO CANDIDATES: across the WHOLE book (any eligible memory, not just ones you selected into a spread), pick up to 5 `hero_candidates` -- the strongest single images (not videos) of the year, worth a full-bleed page or the cover. Each memory\'s row shows its first photo\'s orientation (`wide`, `tall`, or `square`, omitted when unknown) -- prefer `wide` or `square` for a full-bleed page; a `tall` photo makes a poor full-page bleed on a square page, but it is not forbidden if it is genuinely the strongest image.',
    '',
    'PANORAMA CANDIDATES: across the WHOLE book, nominate EVERY qualifying memory as a `panorama_candidate` -- there is no cap, so do not ration these. NOMINATE GENEROUSLY: you cannot see pixel dimensions, only orientation, so under-nomination is the real failure mode -- a real incident had the model nominating only 1-2 candidates and losing every panorama to a downstream resolution check. Aim for 5-10 candidates whenever the archive plausibly has that many wide/scenic memories; over-nomination costs nothing (a resolution filter downstream silently drops anything too small to print at 2:1 -- that is its job, not yours), but under-nomination kills a panoramic spread outright. A panorama spans TWO PAGES at roughly 2:1 -- a `tall` or `square` photo can NEVER work here, no matter how scenic; a candidate MUST show `wide` in its metadata row (and the wider the better -- prefer a called-out ratio like "wide 1.7:1" over a plain "wide"). Beyond orientation, qualifying also means scenic: a landscape, a vista, an open space, with no faces near the center of the frame -- judge that part from the memory\'s topics/labels/description context (you are not shown the actual image). Order the list BEST-FIRST (widest and most scenic first) -- the renderer uses roughly 1 spread per ~20 pages, picking down your list in order, so ranking matters more than count. Every book should open up into at least one panoramic breath WHEN a genuinely wide, scenic memory exists -- but if none of the `wide` memories are actually scenic (or no memory is `wide` at all), returning an EMPTY list is the correct, expected answer; never nominate a tall or square photo just to avoid an empty list. A memory may be both a hero candidate and a panorama candidate. These are human-reviewed downstream, so nominate confidently and completely rather than leaving qualifying ones out of caution.',
    '',
    'DEDICATION AND BACK COVER LINE: two more pieces of connective text, same class as the kicker/editorial note (journal language, editable downstream, never parent text).',
    '- `dedication`: a short dedication-page body, 2-3 sentences, referencing the scope\'s span and spirit. Owner round-3 rule: do NOT open with a salutation like "Para <name>," -- the printed page\'s own furniture already prints that greeting, so your text is only the body that follows it; opening with one duplicates it on the page. Canvas example (do not reuse verbatim, write fresh for this book): "Este año aprendiste a decir casi todo. Aquí está guardado lo que dijiste, lo que hiciste y lo que nos hiciste sentir, del 23 de octubre de 2024 al 22 de octubre de 2025."',
    '- `back_cover_line`: one short colophon line for the back cover. Canvas spirit (do not reuse verbatim): "Este libro recoge un año de recuerdos, escrito día a día."',
    '',
    'Return STRICT JSON with this shape:',
    '{',
    '  "spreads": [',
    '    {',
    '      "candidate_id": "<one of the candidate ids given to you, e.g. \\"topic:beach\\", \\"people:<memberId>\\", \\"emotion:funny\\">",',
    '      "insert_after_segment_index": <integer, -1 means "right at the start, before the first backbone segment">,',
    '      "title": "<short warm page title>",',
    '      "title_mode": "quote" | "descriptive",',
    '      "title_source_memory_id": "<required when title_mode is quote -- must be one of this spread\'s own memory_ids -- omit/null for descriptive>",',
    '      "kicker": "<optional, <=6 words, journal language -- see KICKER above>",',
    '      "memory_ids": ["<3 to 6 memory ids from that candidate\'s member list -- omit any that would break the title-fits-all rule>"],',
    '      "rationale": { "<memory_id>": "<internal, evidence-based, <=12 words -- see RATIONALES above>" }',
    '    }',
    '  ],',
    '  "backbone_highlights": [',
    '    { "segment_id": "<a backbone segment id>", "memory_ids": ["<ids in that segment worth a full page>"], "rationale": { "<memory_id>": "<internal, evidence-based, <=12 words>" } }',
    '  ],',
    '  "hero_candidates": ["<up to 5 memory ids -- see HERO CANDIDATES above>"],',
    '  "panorama_candidates": ["<ALL qualifying memory ids, best-first, no cap -- see PANORAMA CANDIDATES above -- at least 1 whenever plausible>"],',
    '  "segment_titles": { "<flagged segment id>": "<special birth/birthday title in journal language -- see SPECIAL BACKBONE SEGMENT TITLES above>" },',
    '  "firsts_title": "<only if a Firsts spread is listed below -- its draft title, journal-language \'big and small victories this year\' framing>",',
    '  "firsts_milestones": [',
    '    { "memory_id": "<a memory id from a FIRSTS MILESTONES row>", "milestone_id": "<that row\'s milestone_id, echoed back exactly>", "warm_name": "<warm second-person rephrasing -- see FIRSTS WARM NAMES above>" }',
    '  ],',
    '  "dedication": "<2-3 sentence dedication-page body, NO salutation -- see DEDICATION AND BACK COVER LINE above>",',
    '  "back_cover_line": "<one short colophon line -- see DEDICATION AND BACK COVER LINE above>",',
    '  "editorial_note": "<INTERNAL ONLY, never printed in the book -- 2-3 sentences on the arc of this book for the human reviewer>"',
    '}',
    '',
    'Omit a candidate entirely if it is not worth including. Only reference memory ids and segment/candidate ids that were given to you.',
  ].join('\n');
}

/** Minimum non-birthday milestone memories required for the Firsts section
 * to exist at all (owner round-4 decision, 2026-08-27: a live regeneration
 * had the owner dismiss a wrong milestone match, leaving exactly ONE real
 * milestone behind -- the OLD >=2 gate then dropped the whole Firsts
 * section, silently losing that one genuine milestone from the book, AND
 * left the model guessing a `milestone_id` from the bare name it saw on the
 * backbone memory line (since the FIRSTS MILESTONES block -- the only place
 * real `milestone_id` slugs are given out -- was withheld below the same
 * threshold), producing an `unknown_firsts_milestone` violation for a
 * milestone that was perfectly real. A single genuine victory still earns
 * the closing section, so this is 1: every location that gates on "is
 * Firsts present" (the prompt announcement, the FIRSTS MILESTONES block,
 * and the placement decision in `buildOutline`) must read this SAME
 * constant, never a hardcoded number, so they can never drift apart again. */
const FIRSTS_MIN_MILESTONES = 1;

export interface OutlineSkeletonSummaryInput {
  childName: string;
  scopeLabel: string;
  windowStart: string;
  windowLastDay: string;
  backboneSegments: BackboneSegment[];
  firstsCount: number;
  birthdaySpreads: Array<{ ageTurned: number; memoryCount: number }>;
  throughTheYearsCount: number;
  /** Segments flagged for a special birth/birthday title (plan round-2
   * decision, 2026-08-25) -- computed on these SAME (original, pre-budget)
   * `backboneSegments` via `flagSpecialBackboneSegments`. */
  specialSegments: SpecialSegmentFlag[];
}

export function buildOutlineUserPrompt(
  skeleton: OutlineSkeletonSummaryInput,
  candidates: Candidate[],
  features: Map<string, MemoryFeature>,
): string {
  const lines: string[] = [];

  lines.push(
    `BOOK: ${skeleton.childName} -- ${skeleton.scopeLabel} (${skeleton.windowStart} to ${skeleton.windowLastDay})`,
  );
  lines.push(`Through-the-years portraits in scope: ${skeleton.throughTheYearsCount}`);
  lines.push(
    `Firsts (non-birthday explicit milestones) in scope: ${skeleton.firstsCount}${skeleton.firstsCount >= FIRSTS_MIN_MILESTONES ? ' -- this spread CLOSES the book, draft its title now' : ''}`,
  );
  if (skeleton.birthdaySpreads.length > 0) {
    lines.push(
      `Birthdays in scope: ${skeleton.birthdaySpreads.map((b) => `turns ${b.ageTurned} (${b.memoryCount} memories)`).join(', ')}`,
    );
  }
  lines.push('');

  // Owner round-3 decision, 2026-08-27 (threshold lowered to 1 in round 4):
  // only listed once Firsts itself is present (same FIRSTS_MIN_MILESTONES
  // threshold as the title-drafting instruction above) -- this is the ONLY
  // place the model is given a real `milestone_id` slug, so withholding it
  // below the threshold is what left the model guessing a milestone NAME as
  // the id in the round-4 incident; below the threshold there is no Firsts
  // section at all, so there is nothing to reference.
  if (skeleton.firstsCount >= FIRSTS_MIN_MILESTONES) {
    lines.push('FIRSTS MILESTONES (write a warm_name for EACH row -- see FIRSTS WARM NAMES above):');
    const sortedFeatures = [...features.values()].sort((a, b) => a.date.localeCompare(b.date));
    for (const feature of sortedFeatures) {
      for (const milestone of feature.milestones) {
        lines.push(`- memory_id="${feature.id}" milestone_id="${milestone.milestoneId}" ("${milestone.name}")`);
      }
    }
    lines.push('');
  }

  lines.push('BACKBONE SEGMENTS (chronological, in order -- index is what insert_after_segment_index refers to):');
  const specialBySegmentId = new Map(skeleton.specialSegments.map((f) => [f.segmentId, f]));
  skeleton.backboneSegments.forEach((segment, index) => {
    const flag = specialBySegmentId.get(segment.id);
    const flagDesc = flag
      ? flag.kind === 'birth'
        ? ' -- FLAGGED: birth month, draft a segment_titles entry'
        : ` -- FLAGGED: birthday month (turns ${flag.ageTurned}), draft a segment_titles entry`
      : '';
    lines.push(`[${index}] ${segment.id} "${segment.label}" -- ${segment.memoryIds.length} memories${flagDesc}`);
  });
  lines.push('');

  lines.push('SPREAD CANDIDATES (topic / people-pair / emotion -- all compete equally for a place in the book):');
  if (candidates.length === 0) {
    lines.push('(none -- no candidate reached its minimum eligible-memory threshold in this scope)');
  }
  for (const candidate of candidates) {
    lines.push(
      `- candidate_id="${candidate.id}" [${candidate.kind}] ("${candidate.defaultTitle}") -- ${candidate.memoryIds.length} member memories: ${candidate.memoryIds.join(', ')}`,
    );
  }
  lines.push('');

  lines.push('MEMORIES (id | date | topics | emotion | hasText | excerpt | photos/videos/orientation | engagement | milestones | tagged people -- the ONLY sanctioned source of relationship words, see RELATIONSHIP WORDS above):');
  for (const feature of [...features.values()].sort((a, b) => a.date.localeCompare(b.date))) {
    const milestoneDesc = feature.milestones.map((m) => m.name).join(';') || '-';
    const excerpt = feature.excerpt ? feature.excerpt.replace(/\n/g, ' ') : '(no text)';
    const peopleDesc = feature.taggedMembers.map((m) => `${m.firstName}(${m.personType})`).join(',') || '-';
    const orientationMarker = formatOrientationMarker(feature.photoOrientation);
    const assetDesc = `p${feature.photoCount}/v${feature.videoCount}${orientationMarker ? `/${orientationMarker}` : ''}`;
    lines.push(
      `${feature.id} | ${feature.date} | [${feature.topics.join(',')}] | ${feature.emotion ?? '-'} | ${feature.hasText ? 'y' : 'n'} | "${excerpt}" | ${assetDesc} | eng${feature.engagementCount} | ${milestoneDesc} | ${peopleDesc}`,
    );
  }

  return lines.join('\n');
}

// ── AI call ───────────────────────────────────────────────────────────────

interface OpenAiUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

interface OpenAiChatResult {
  content: string;
  usage: OpenAiUsage | null;
}

const RETRY_BACKOFF_MS = 1500;

/**
 * Request body for the outline chat call, as a plain object (exported for
 * direct unit testing, independent of the fetch plumbing). Deliberately
 * omits `temperature` and any token-cap param: reasoning-family models
 * (e.g. `gpt-5.6-sol`) reject a non-default `temperature` with a 400
 * `unsupported_value`, and separately require `max_completion_tokens`
 * instead of `max_tokens` if a cap is ever added -- neither classic nor
 * reasoning models need either field here, so the simplest fix is to send
 * neither and let every model use its own default. `response_format:
 * {type:'json_object'}` is supported by both families and stays.
 */
export function buildOutlineRequestBody(
  systemPrompt: string,
  userPrompt: string,
  model: string,
): Record<string, unknown> {
  return {
    model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  };
}

async function callOpenAiOutline(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  apiKey: string,
): Promise<OpenAiChatResult> {
  const body = JSON.stringify(buildOutlineRequestBody(systemPrompt, userPrompt, model));

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

// ── AI response parsing + validation (never trust the model -- plan §5) ────

export type SpreadTitleMode = 'quote' | 'descriptive';

export interface ParsedSpreadSelection {
  candidateId: string;
  candidateKind: CandidateKind;
  insertAfterSegmentIndex: number;
  title: string;
  /** Owner amendment (round-2, 2026-08-25): a spread title is either a
   * verbatim/lightly-trimmed `quote` lifted from a member memory (code
   * verifies it against that memory's real text -- see
   * `isQuoteSupportedByContent`/`verifyQuoteTitles`), or a `descriptive`
   * title naming a concrete place/activity/object, which must stay true of
   * every memory in the spread. Defaults to 'descriptive' when the model
   * omits or garbles the field. */
  titleMode: SpreadTitleMode;
  /** Required (and validated to be one of this spread's OWN `memoryIds`)
   * when `titleMode` is 'quote'; downgraded to 'descriptive' + null with a
   * recorded violation otherwise. */
  titleSourceMemoryId: string | null;
  memoryIds: string[];
  rationale: Record<string, string>;
  /** Design handoff decision (2026-08-27): a short thematic eyebrow line
   * (antetítulo) above the title, journal language, <=6 words -- design
   * renders it in small caps (PJS 700 6.5pt). Themed spreads only (never
   * requested for months/firsts/birthday). Connective text, editable
   * later, never parent text. Null when the model omitted it -- a kicker
   * is optional, not every spread needs one. */
  kicker: string | null;
}

export interface ParsedBackboneHighlight {
  segmentId: string;
  memoryIds: string[];
  rationale: Record<string, string>;
}

export interface ParsedOutlineResponse {
  spreads: ParsedSpreadSelection[];
  backboneHighlights: ParsedBackboneHighlight[];
  /** The AI's journal-language draft of the Firsts spread's "big and small
   * victories this year" framing (plan 2026-08-24). Null when no Firsts
   * spread was offered, or the model didn't supply one -- callers fall back
   * to `FIRSTS_DEFAULT_TITLE`. */
  firstsTitle: string | null;
  /** Special birth/birthday backbone segment titles (plan round-2 decision,
   * 2026-08-25), keyed by the ORIGINAL segment id the model saw. Only
   * entries whose key was actually flagged are ever used by the caller --
   * see `buildSpecialSegmentTitlesByMonth`. */
  segmentTitles: Record<string, string>;
  /** Design handoff decision (2026-08-27): up to 5 book-wide candidates for
   * a full-bleed page or the cover -- the strongest single images of the
   * year. Not scoped to any spread/segment; validated only for existence
   * in scope (see `parseOutlineResponse`). */
  heroCandidates: string[];
  /** Owner decision, 2026-08-27 ("Density & quality-first"), amended
   * 2026-08-27: EVERY qualifying book-wide candidate for a full
   * double-page panorama spread -- wide, scenic, no faces near center --
   * uncapped, ordered best-first by the model (the renderer takes 1 + 1
   * per ~20 pages down this list). May overlap `heroCandidates` (a memory
   * can be both). Validated for existence AND for being `wide`-orientation
   * (owner root-cause fix, 2026-08-27 -- a tall/square photo can never
   * span a 2:1 panorama; see `parseOutlineResponse`); order is preserved
   * as given, never re-sorted. */
  panoramaCandidates: string[];
  /** Owner decision, 2026-08-27: a 2-3 sentence dedication-page body
   * addressed to the child, journal language, connective text (same class
   * as `kicker`/`internalEditorialNote`). Owner round-3 amendment
   * (2026-08-27): the body must NOT open with a salutation ("Para X,") --
   * the printed page's own furniture supplies that greeting; a model that
   * still emits one duplicates it on the page. Null when the model didn't
   * supply one. */
  dedication: string | null;
  /** Owner decision, 2026-08-27: a one-line back-cover colophon, journal
   * language, connective text. Null when the model didn't supply one.
   * Spine text and the closing page's copy are deliberately NOT AI fields
   * (deterministic furniture) -- never add them here. */
  backCoverLine: string | null;
  /** Owner round-3 decision, 2026-08-27: renamed from `editorialNote` and
   * documented as INTERNAL ONLY -- a curator's note for human review of the
   * book's arc, never printed on any page (it leaked into a closing page
   * once under the old name). Every renderer must treat this as
   * review-artifact-only, same as a spread's `rationale`. */
  internalEditorialNote: string;
  /** Owner round-3 decision, 2026-08-27: one AI-drafted warm second-person
   * rephrasing per milestone row in scope (e.g. "Monta bicicleta sin
   * pedales" -> "Aprendiste a montar bicicleta sin pedales"), journal
   * language -- connective text, editable downstream, and NEVER alters the
   * parent's own memory caption. Persisted per Firsts entry in outline.json
   * via the `firsts` reading-order section. Empty when Firsts is absent
   * from this book. */
  firstsWarmNames: ParsedFirstsWarmName[];
}

export interface ParsedFirstsWarmName {
  memoryId: string;
  milestoneId: string;
  warmName: string;
}

export interface OutlineIntegrityViolation {
  kind: string;
  detail: string;
}

function candidateKindFromId(candidateId: string): CandidateKind | null {
  if (candidateId.startsWith('topic:')) return 'topic';
  if (candidateId.startsWith('people:')) return 'people-pair';
  if (candidateId.startsWith('emotion:')) return 'emotion';
  return null;
}

/**
 * Tolerant-but-traced parsing of the model's raw JSON (mirrors
 * eval-memory-book-tagging.ts's parseTopics: never silently drop something
 * unrecognized -- record it). Every `memory_ids` entry not in
 * `validMemoryIds`, every `candidate_id` not in `validCandidateIds`, and
 * every `segment_id` not in `validSegmentIds` is dropped and recorded as a
 * violation rather than trusted.
 */
export function parseOutlineResponse(
  raw: unknown,
  validCandidateIds: Set<string>,
  validSegmentIds: Set<string>,
  validMemoryIds: Set<string>,
  candidateMembersById: Map<string, Set<string>>,
  candidateDefaultTitleById: Map<string, string>,
  segmentMembersById: Map<string, Set<string>>,
  /** owner root-cause fix, 2026-08-27: panorama candidates must be `wide`
   * -- a tall/square/unknown-orientation photo can never span a 2:1
   * double-page panorama, no matter how scenic. */
  wideOrientationMemoryIds: Set<string> = new Set(),
  /** owner round-3 decision, 2026-08-27: `"<memoryId>::<milestoneId>"` keys
   * for every real (memory, milestone) pair in scope -- a `firsts_milestones`
   * entry not matching one of these is dropped and recorded, never trusted. */
  validMilestoneKeys: Set<string> = new Set(),
): { response: ParsedOutlineResponse; violations: OutlineIntegrityViolation[] } {
  const violations: OutlineIntegrityViolation[] = [];
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const spreadsRaw = Array.isArray(obj.spreads) ? obj.spreads : [];
  const spreads: ParsedSpreadSelection[] = [];

  for (const item of spreadsRaw) {
    if (!item || typeof item !== 'object') {
      violations.push({ kind: 'malformed_spread', detail: previewJson(item) });
      continue;
    }
    const o = item as Record<string, unknown>;
    const candidateId = typeof o.candidate_id === 'string' ? o.candidate_id : null;
    const candidateKind = candidateId ? candidateKindFromId(candidateId) : null;
    if (!candidateId || !candidateKind || !validCandidateIds.has(candidateId)) {
      violations.push({ kind: 'unknown_candidate_id', detail: String(candidateId) });
      continue;
    }

    const memberSet = candidateMembersById.get(candidateId) ?? new Set<string>();
    const rawIds = Array.isArray(o.memory_ids) ? o.memory_ids : [];
    const memoryIds: string[] = [];
    for (const id of rawIds) {
      if (typeof id !== 'string') {
        violations.push({ kind: 'malformed_memory_id', detail: previewJson(id) });
        continue;
      }
      if (!validMemoryIds.has(id)) {
        violations.push({ kind: 'unknown_memory_id', detail: id });
        continue;
      }
      if (!memberSet.has(id)) {
        violations.push({ kind: 'memory_not_in_candidate', detail: `${id} not a member of ${candidateId}` });
        continue;
      }
      if (memoryIds.includes(id)) {
        violations.push({ kind: 'duplicate_memory_id', detail: id });
        continue;
      }
      memoryIds.push(id);
    }

    const insertAfterSegmentIndex = typeof o.insert_after_segment_index === 'number'
      ? o.insert_after_segment_index
      : -1;

    const rationale: Record<string, string> = {};
    if (o.rationale && typeof o.rationale === 'object') {
      for (const [id, reason] of Object.entries(o.rationale as Record<string, unknown>)) {
        if (typeof reason === 'string' && memoryIds.includes(id)) rationale[id] = reason;
      }
    }

    const rawTitleMode = o.title_mode;
    let titleMode: SpreadTitleMode = 'descriptive';
    if (rawTitleMode === 'quote') {
      titleMode = 'quote';
    } else if (rawTitleMode !== undefined && rawTitleMode !== 'descriptive') {
      violations.push({ kind: 'invalid_title_mode', detail: `${candidateId}: ${previewJson(rawTitleMode)}` });
    }

    let titleSourceMemoryId: string | null = null;
    if (titleMode === 'quote') {
      const rawSourceId = typeof o.title_source_memory_id === 'string' ? o.title_source_memory_id : null;
      if (rawSourceId && memoryIds.includes(rawSourceId)) {
        titleSourceMemoryId = rawSourceId;
      } else {
        violations.push({
          kind: 'quote_missing_source',
          detail: `${candidateId}: title_source_memory_id "${String(rawSourceId)}" is not one of this spread's own memory_ids`,
        });
        titleMode = 'descriptive'; // Safe fallback -- never render a "quoted from" attribution with no real source.
      }
    }

    const kicker = typeof o.kicker === 'string' && o.kicker.trim() ? o.kicker.trim() : null;

    spreads.push({
      candidateId,
      candidateKind,
      insertAfterSegmentIndex,
      title: typeof o.title === 'string' && o.title.trim() ? o.title.trim() : (candidateDefaultTitleById.get(candidateId) ?? candidateId),
      titleMode,
      titleSourceMemoryId,
      memoryIds,
      rationale,
      kicker,
    });
  }

  const backboneHighlightsRaw = Array.isArray(obj.backbone_highlights) ? obj.backbone_highlights : [];
  const backboneHighlights: ParsedBackboneHighlight[] = [];

  for (const item of backboneHighlightsRaw) {
    if (!item || typeof item !== 'object') {
      violations.push({ kind: 'malformed_backbone_highlight', detail: previewJson(item) });
      continue;
    }
    const o = item as Record<string, unknown>;
    const segmentId = typeof o.segment_id === 'string' ? o.segment_id : null;
    if (!segmentId || !validSegmentIds.has(segmentId)) {
      violations.push({ kind: 'unknown_segment_id', detail: String(segmentId) });
      continue;
    }

    const segmentMemberSet = segmentMembersById.get(segmentId) ?? new Set<string>();
    const rawIds = Array.isArray(o.memory_ids) ? o.memory_ids : [];
    const memoryIds: string[] = [];
    for (const id of rawIds) {
      if (typeof id !== 'string' || !validMemoryIds.has(id)) {
        violations.push({ kind: 'unknown_memory_id', detail: previewJson(id) });
        continue;
      }
      if (!segmentMemberSet.has(id)) {
        violations.push({ kind: 'highlight_not_in_segment', detail: `${id} not a member of ${segmentId}` });
        continue;
      }
      if (memoryIds.includes(id)) {
        violations.push({ kind: 'duplicate_memory_id', detail: id });
        continue;
      }
      memoryIds.push(id);
    }

    const rationale: Record<string, string> = {};
    if (o.rationale && typeof o.rationale === 'object') {
      for (const [id, reason] of Object.entries(o.rationale as Record<string, unknown>)) {
        if (typeof reason === 'string' && memoryIds.includes(id)) rationale[id] = reason;
      }
    }

    backboneHighlights.push({ segmentId, memoryIds, rationale });
  }

  const internalEditorialNote = typeof obj.editorial_note === 'string' ? obj.editorial_note : '';
  const firstsTitle = typeof obj.firsts_title === 'string' && obj.firsts_title.trim() ? obj.firsts_title.trim() : null;

  // Owner round-3 decision, 2026-08-27: one warm second-person rephrasing
  // per (memory, milestone) pair -- never trust the model's own memory_id/
  // milestone_id echo without checking it against a REAL milestone row.
  const firstsMilestonesRaw = Array.isArray(obj.firsts_milestones) ? obj.firsts_milestones : [];
  const firstsWarmNames: ParsedFirstsWarmName[] = [];
  const seenFirstsMilestoneKeys = new Set<string>();
  for (const item of firstsMilestonesRaw) {
    if (!item || typeof item !== 'object') {
      violations.push({ kind: 'malformed_firsts_milestone', detail: previewJson(item) });
      continue;
    }
    const o = item as Record<string, unknown>;
    const memoryId = typeof o.memory_id === 'string' ? o.memory_id : null;
    const milestoneId = typeof o.milestone_id === 'string' ? o.milestone_id : null;
    const key = `${memoryId}::${milestoneId}`;
    if (!memoryId || !milestoneId || !validMilestoneKeys.has(key)) {
      violations.push({ kind: 'unknown_firsts_milestone', detail: key });
      continue;
    }
    const warmName = typeof o.warm_name === 'string' && o.warm_name.trim() ? o.warm_name.trim() : null;
    if (!warmName) {
      violations.push({ kind: 'missing_firsts_warm_name', detail: key });
      continue;
    }
    if (seenFirstsMilestoneKeys.has(key)) {
      violations.push({ kind: 'duplicate_firsts_milestone', detail: key });
      continue;
    }
    seenFirstsMilestoneKeys.add(key);
    firstsWarmNames.push({ memoryId, milestoneId, warmName });
  }

  const segmentTitles: Record<string, string> = {};
  if (obj.segment_titles && typeof obj.segment_titles === 'object') {
    for (const [segmentId, title] of Object.entries(obj.segment_titles as Record<string, unknown>)) {
      if (!validSegmentIds.has(segmentId)) {
        violations.push({ kind: 'unknown_segment_id', detail: segmentId });
        continue;
      }
      if (typeof title === 'string' && title.trim()) segmentTitles[segmentId] = title.trim();
    }
  }

  const heroCandidates = parseCappedIdList(
    obj.hero_candidates,
    validMemoryIds,
    MAX_HERO_CANDIDATES,
    { unknown: 'unknown_hero_candidate', tooMany: 'too_many_hero_candidates' },
    violations,
  );

  // Owner amendment, 2026-08-27: panorama nomination is UNCAPPED (`cap:
  // null`) -- the renderer paces itself off the best-first ordering, so
  // nomination should never be the bottleneck. Order is preserved exactly
  // as the model returned it (never re-sorted).
  const panoramaCandidates = parseCappedIdList(
    obj.panorama_candidates,
    validMemoryIds,
    null,
    { unknown: 'unknown_panorama_candidate' },
    violations,
    { check: (id) => wideOrientationMemoryIds.has(id), failKind: 'panorama_candidate_not_wide' },
  );

  const dedication = typeof obj.dedication === 'string' && obj.dedication.trim() ? obj.dedication.trim() : null;
  const backCoverLine = typeof obj.back_cover_line === 'string' && obj.back_cover_line.trim() ? obj.back_cover_line.trim() : null;

  return {
    response: {
      spreads,
      backboneHighlights,
      firstsTitle,
      segmentTitles,
      heroCandidates,
      panoramaCandidates,
      dedication,
      backCoverLine,
      internalEditorialNote,
      firstsWarmNames,
    },
    violations,
  };
}

const MAX_HERO_CANDIDATES = 5;

/**
 * Shared parsing for the book-wide memory-id lists (`hero_candidates`,
 * `panorama_candidates`): validates existence, an optional extra predicate
 * (e.g. "must be photo-bearing"), dedupes (preserving first-seen order --
 * load-bearing for panorama's best-first contract), and records a
 * violation for anything dropped -- never silently. `cap: null` means
 * uncapped (no "too many" check, nothing sliced off); a numeric `cap`
 * requires `kinds.tooMany` and truncates + records a violation if exceeded.
 */
function parseCappedIdList(
  raw: unknown,
  validIds: Set<string>,
  cap: number | null,
  kinds: { unknown: string; tooMany?: string },
  violations: OutlineIntegrityViolation[],
  extra?: { check: (id: string) => boolean; failKind: string },
): string[] {
  const out: string[] = [];
  const rawList = Array.isArray(raw) ? raw : [];
  for (const id of rawList) {
    if (typeof id !== 'string' || !validIds.has(id)) {
      violations.push({ kind: kinds.unknown, detail: previewJson(id) });
      continue;
    }
    if (extra && !extra.check(id)) {
      violations.push({ kind: extra.failKind, detail: id });
      continue;
    }
    if (out.includes(id)) {
      violations.push({ kind: 'duplicate_memory_id', detail: id });
      continue;
    }
    out.push(id);
  }
  if (cap === null) return out;
  if (out.length > cap) {
    violations.push({ kind: kinds.tooMany!, detail: `${out.length} > ${cap}` });
  }
  return out.slice(0, cap);
}

// ── Quote-title verification (owner amendment, round-2, 2026-08-25: "never
// silently accept an unverifiable quote -- a fabricated quote would violate
// the parent-text-is-sacred rule") ──────────────────────────────────────

/** Lowercases, strips diacritics, and collapses everything but letters/digits
 * to single spaces -- a deliberately coarse normalization so a lightly
 * trimmed/re-punctuated quote (the plan's own phrasing: "verbatim or
 * lightly trimmed") still matches, while a title that doesn't appear in the
 * source text AT ALL still fails. */
export function normalizeForQuoteCheck(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function isQuoteSupportedByContent(title: string, sourceContent: string | null): boolean {
  if (!sourceContent) return false;
  const normalizedTitle = normalizeForQuoteCheck(title);
  if (!normalizedTitle) return false;
  return normalizeForQuoteCheck(sourceContent).includes(normalizedTitle);
}

export interface QuoteTitleCheckInput {
  candidateId: string;
  title: string;
  titleMode: SpreadTitleMode;
  titleSourceMemoryId: string | null;
}

/**
 * Code-verifies every `quote`-mode spread title against its declared source
 * memory's REAL text (never the model's word for it) -- on failure the
 * title is NOT discarded (the caller still uses it; "keep the title in the
 * eval artifact but flag it") but a violation is recorded so a fabricated
 * quote is never silently presented as real. `contentByMemoryId` should
 * hold full `memories.content`, not the 120-char excerpt.
 */
export function verifyQuoteTitles(
  spreads: QuoteTitleCheckInput[],
  contentByMemoryId: Map<string, string | null>,
): OutlineIntegrityViolation[] {
  const violations: OutlineIntegrityViolation[] = [];
  for (const spread of spreads) {
    if (spread.titleMode !== 'quote') continue;
    const sourceContent = spread.titleSourceMemoryId ? contentByMemoryId.get(spread.titleSourceMemoryId) ?? null : null;
    if (!isQuoteSupportedByContent(spread.title, sourceContent)) {
      violations.push({
        kind: 'unverifiable_quote_title',
        detail: `${spread.candidateId}: "${spread.title}" not found in source memory ${spread.titleSourceMemoryId ?? '(none)'}`,
      });
    }
  }
  return violations;
}

function previewJson(value: unknown): string {
  try {
    const json = JSON.stringify(value) ?? String(value);
    return json.length > 80 ? `${json.slice(0, 80)}…` : json;
  } catch {
    return String(value);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(Deno.args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
  const userEmail = Deno.env.get('EVAL_USER_EMAIL') ?? 'eduardoyi@gmail.com';
  const apiKey = Deno.env.get('OPENAI_API_KEY') ?? null;

  if (!options.child) {
    console.error('Missing required --child <family_member id or exact name>.');
    Deno.exit(1);
  }

  const scope = resolveBookScope(options);

  if (!options.dryRun && !apiKey) {
    console.error('Missing OPENAI_API_KEY (pass --dry-run to build the outline without calling OpenAI).');
    Deno.exit(1);
  }

  if (options.pageCap > HARD_PAGE_CAP) {
    console.warn(`--page-cap ${options.pageCap} exceeds the layflat hard physical limit of ${HARD_PAGE_CAP}; clamping.`);
    options.pageCap = HARD_PAGE_CAP;
  }

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  console.log(`Memory Book V2 outline run ${runId} -- account: ${userEmail}`);

  const supabase = await createAuthedClient();
  const families = await loadFamilies(supabase);
  if (families.length === 0) {
    console.error('No families visible to this account.');
    Deno.exit(1);
  }

  const allMembers: ChildCandidate[] = [];
  for (const family of families) {
    const members = await loadFamilyMembers(supabase, family.id);
    for (const m of members) {
      allMembers.push({ id: m.id, familyId: m.family_id, name: m.name, dateOfBirth: m.date_of_birth });
    }
  }

  const child = resolveChild(allMembers, options.child);
  const window = computeScopeWindow(scope, child.dateOfBirth);
  console.log(`Child: ${child.id} -- scope: ${scope.type} -- window: ${window.start} to ${scopeWindowLastInclusiveDay(window)}`);

  let familyMemories = await loadMemoriesInWindow(supabase, child.familyId, window);

  // Owner round-3 decision, 2026-08-27: `--exclude-memory-id` removes ids
  // from ELIGIBILITY entirely, before any candidate/backbone/Firsts
  // computation runs -- so an excluded id can never surface anywhere
  // downstream (an element, a candidate spread, a highlight, Firsts), not
  // merely get dropped for budget later.
  const cliExcludeIdSet = new Set(options.excludeMemoryIds);
  const cliExcludedMemoryIds: Array<{ memoryId: string; elementId: string; reason: string }> = [];
  if (cliExcludeIdSet.size > 0) {
    for (const memory of familyMemories) {
      if (cliExcludeIdSet.has(memory.id)) {
        cliExcludedMemoryIds.push({ memoryId: memory.id, elementId: 'cli', reason: 'cli_exclude_memory_id' });
      }
    }
    familyMemories = familyMemories.filter((m) => !cliExcludeIdSet.has(m.id));
    console.log(
      `--exclude-memory-id: ${cliExcludedMemoryIds.length} of ${cliExcludeIdSet.size} requested id(s) matched a memory in window and were excluded.`,
    );
  }

  const memoryIds = familyMemories.map((m) => m.id);
  // Full content (not the 120-char excerpt) -- quote-title verification only,
  // never logged or otherwise surfaced (PII rule).
  const contentByMemoryId = new Map(familyMemories.map((m) => [m.id, m.content]));

  const [media, tags, milestones, engagement, portraitVersions] = await Promise.all([
    loadMediaForMemories(supabase, memoryIds),
    loadTagsForMemories(supabase, memoryIds),
    loadMilestonesForMemories(supabase, memoryIds),
    loadEngagementCounts(supabase, memoryIds),
    loadPortraitVersionsInWindow(supabase, child.id, window),
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

  const milestonesByMemory = new Map<string, MilestoneRow[]>();
  for (const row of milestones) {
    const list = milestonesByMemory.get(row.memory_id) ?? [];
    list.push(row);
    milestonesByMemory.set(row.memory_id, list);
  }

  const familyMembersById = new Map<string, FamilyMemberForTagging>(
    allMembers.map((m) => [m.id, { id: m.id, name: m.name, dateOfBirth: m.dateOfBirth }]),
  );

  let taggedToChildCount = 0;
  let untaggedInWindowCount = 0;
  let eligibleTotal = 0;
  const features = new Map<string, MemoryFeature>();

  for (const memory of familyMemories) {
    const taggedIds = tagsByMemory.get(memory.id) ?? [];
    const eligibility = computeMemoryEligibility(taggedIds, child.id);
    if (!eligibility.eligible) continue;

    eligibleTotal += 1;
    if (eligibility.taggedToChild) taggedToChildCount += 1;
    if (eligibility.untaggedInWindow) untaggedInWindowCount += 1;

    const feature = buildMemoryFeature(
      memory,
      mediaByMemory.get(memory.id) ?? [],
      taggedIds,
      child.id,
      milestonesByMemory.get(memory.id) ?? [],
      engagement.get(memory.id) ?? 0,
      buildTaggedMemberFeatures(taggedIds, familyMembersById, memory.memory_date),
    );
    features.set(memory.id, feature);
  }

  console.log(
    `Eligible memories: ${eligibleTotal} (tagged to child: ${taggedToChildCount}, untagged-in-window: ${untaggedInWindowCount}) of ${familyMemories.length} in window.`,
  );

  // ── Deterministic skeleton ────────────────────────────────────────────

  const backboneInputs: BackboneMemoryInput[] = [...features.values()].map((f) => ({
    id: f.id,
    date: f.date,
    printable: f.hasText || f.photoCount + f.videoCount > 0,
  }));
  const backboneSegments = buildBackboneSegments(backboneInputs);
  const validSegmentIds = new Set(backboneSegments.map((s) => s.id));
  const segmentMembersById = new Map(backboneSegments.map((s) => [s.id, new Set(s.memoryIds)]));

  const defaultBackboneByMemory = new Map<string, string>();
  for (const segment of backboneSegments) {
    for (const id of segment.memoryIds) defaultBackboneByMemory.set(id, segment.id);
  }

  const firstsMemories = [...features.values()].filter((f) => f.milestones.length > 0);
  const firstsPresent = firstsMemories.length >= FIRSTS_MIN_MILESTONES;

  const birthdayGroups = new Map<number, string[]>();
  for (const feature of features.values()) {
    if (feature.birthdayAgeTurned === null) continue;
    const list = birthdayGroups.get(feature.birthdayAgeTurned) ?? [];
    list.push(feature.id);
    birthdayGroups.set(feature.birthdayAgeTurned, list);
  }
  console.log(
    `Skeleton: ${backboneSegments.length} backbone segment(s), Firsts ${firstsPresent ? `present (${firstsMemories.length})` : 'absent'}, ${birthdayGroups.size} birthday spread(s), ${portraitVersions.length} through-the-years portrait(s).`,
  );

  // Special backbone titles (plan round-2 decision, 2026-08-25): flag birth-
  // month and birthday-month segments on the ORIGINAL (pre-budget) segment
  // list, since that's what the AI's single call actually sees. The birthday
  // month is read from the actual memory dates (already within the ±7-day
  // window of the true anniversary from the deterministic DOB join), not the
  // exact anniversary date itself.
  const birthMonth = child.dateOfBirth ? child.dateOfBirth.slice(0, 7) : null;
  const birthdayMonthToAge = new Map<string, number>();
  for (const [ageTurned, ids] of birthdayGroups) {
    for (const id of ids) {
      const month = features.get(id)!.date.slice(0, 7);
      if (!birthdayMonthToAge.has(month)) birthdayMonthToAge.set(month, ageTurned);
    }
  }
  const originalSpecialFlags = flagSpecialBackboneSegments(backboneSegments, birthMonth, birthdayMonthToAge);
  if (originalSpecialFlags.length > 0) {
    console.log(`Special segments flagged: ${originalSpecialFlags.map((f) => `${f.segmentId}:${f.kind}`).join(', ')}.`);
  }

  // ── Candidate generation (plan §5, decided 2026-08-24: three deterministic
  // generators -- topic clusters, people-pairs, emotion spreads -- all flow
  // into the SAME AI curation call) ───────────────────────────────────────

  const topicCandidates = selectTopicCandidatesWithSparseFallback(
    [...features.values()].map((f) => ({ memoryId: f.id, topics: f.topics })),
    TOPIC_PAGE_TITLES,
  );

  const otherFamilyMembers = allMembers.filter((m) => m.familyId === child.familyId && m.id !== child.id);
  const memberFirstNameById = new Map(otherFamilyMembers.map((m) => [m.id, m.name.trim().split(/\s+/)[0] || m.name]));
  const coTagMemberships: Array<{ memoryId: string; coTaggedMemberIds: string[] }> = [];
  for (const [memoryId] of features) {
    const taggedIds = tagsByMemory.get(memoryId) ?? [];
    if (!taggedIds.includes(child.id)) continue;
    coTagMemberships.push({ memoryId, coTaggedMemberIds: taggedIds.filter((id) => id !== child.id) });
  }
  const peoplePairCandidates = selectPeoplePairCandidates(coTagMemberships, memberFirstNameById);

  const emotionCandidates = selectEmotionCandidates(
    [...features.values()].map((f) => ({ memoryId: f.id, emotion: f.emotion })),
  );

  const candidates: Candidate[] = [
    ...topicCandidatesToUnified(topicCandidates),
    ...peoplePairCandidatesToUnified(peoplePairCandidates),
    ...emotionCandidatesToUnified(emotionCandidates),
  ];
  const validCandidateIds = new Set(candidates.map((c) => c.id));
  const candidateMembersById = new Map(candidates.map((c) => [c.id, new Set(c.memoryIds)]));
  const candidateDefaultTitleById = new Map(candidates.map((c) => [c.id, c.defaultTitle]));

  console.log(
    `Candidates: ${topicCandidates.length} topic, ${peoplePairCandidates.length} people-pair, ${emotionCandidates.length} emotion (${candidates.map((c) => c.id).join(', ') || 'none'}).`,
  );

  const outputDir = new URL(`./eval-output/memory-book-outline/${child.id}-${runId}/`, import.meta.url);
  await Deno.mkdir(outputDir, { recursive: true });

  if (options.dryRun) {
    console.log('Dry run -- skipping the OpenAI call and post-processing. Skeleton computed successfully.');
    console.log(`Output dir: ${outputDir.pathname}`);
    return;
  }

  const systemPrompt = buildOutlineSystemPrompt();
  const userPrompt = buildOutlineUserPrompt(
    {
      childName: child.name,
      scopeLabel: window.label,
      windowStart: window.start,
      windowLastDay: scopeWindowLastInclusiveDay(window),
      backboneSegments,
      firstsCount: firstsMemories.length,
      birthdaySpreads: [...birthdayGroups.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([ageTurned, ids]) => ({ ageTurned, memoryCount: ids.length })),
      throughTheYearsCount: portraitVersions.length,
      specialSegments: originalSpecialFlags,
    },
    candidates,
    features,
  );

  const { content, usage } = await callOpenAiOutline(systemPrompt, userPrompt, options.model, apiKey!);
  const rawParsed = JSON.parse(content);
  const validMemoryIds = new Set(features.keys());
  // owner root-cause fix, 2026-08-27: panorama candidates must be `wide` --
  // a tall/square/unknown-orientation photo can never span a 2:1 spread.
  const wideOrientationMemoryIds = new Set(
    [...features.entries()].filter(([, f]) => f.photoOrientation?.orientation === 'wide').map(([id]) => id),
  );
  // Owner round-3 decision, 2026-08-27: every REAL (memory, milestone) pair
  // in scope -- the only `firsts_milestones` entries `parseOutlineResponse`
  // will accept a `warm_name` for.
  const validMilestoneKeys = new Set(
    [...features.values()].flatMap((f) => f.milestones.map((m) => `${f.id}::${m.milestoneId}`)),
  );

  const { response, violations } = parseOutlineResponse(
    rawParsed,
    validCandidateIds,
    validSegmentIds,
    validMemoryIds,
    candidateMembersById,
    candidateDefaultTitleById,
    segmentMembersById,
    wideOrientationMemoryIds,
    validMilestoneKeys,
  );

  // Never trust the model's word that a quote is real -- verify against the
  // actual memory content (owner amendment, round-2, 2026-08-25).
  violations.push(
    ...verifyQuoteTitles(
      response.spreads.map((s) => ({
        candidateId: s.candidateId,
        title: s.title,
        titleMode: s.titleMode,
        titleSourceMemoryId: s.titleSourceMemoryId,
      })),
      contentByMemoryId,
    ),
  );

  if (usage) {
    console.log(`Token usage: prompt=${usage.prompt_tokens}, completion=${usage.completion_tokens}`);
  }
  if (violations.length > 0) {
    console.log(`Integrity violations from the model's response: ${violations.length} (see outline.md).`);
  }

  // ── Single placement + dissolve + page budget ──────────────────────────

  const placementCandidates: PlacementCandidate[] = [];
  for (const [memoryId] of features) {
    const backboneId = defaultBackboneByMemory.get(memoryId);
    if (backboneId) placementCandidates.push({ memoryId, spreadId: `backbone:${backboneId}` });
  }
  if (firstsPresent) {
    for (const feature of firstsMemories) {
      placementCandidates.push({ memoryId: feature.id, spreadId: 'firsts' });
    }
  }
  for (const [ageTurned, ids] of birthdayGroups) {
    for (const id of ids) placementCandidates.push({ memoryId: id, spreadId: `birthday-${ageTurned}` });
  }
  const spreadCandidateIds = new Set<string>();
  for (const spread of response.spreads) {
    const spreadId = `spread:${spread.candidateId}`;
    spreadCandidateIds.add(spreadId);
    for (const memoryId of spread.memoryIds) {
      placementCandidates.push({ memoryId, spreadId });
    }
  }

  const defaultBackboneCandidateByMemory = new Map(
    [...defaultBackboneByMemory.entries()].map(([id, segId]) => [id, `backbone:${segId}`]),
  );

  const { placementByMemory, reassignments } = resolveSinglePlacement(placementCandidates);
  const { placementByMemory: afterThemedDissolve, dissolvedSpreadIds, movedToBackbone: themedMovedToBackbone } = dissolveSmallThemedSpreads(
    placementByMemory,
    spreadCandidateIds,
    defaultBackboneCandidateByMemory,
  );

  // Birthday-beat merge rule (owner round-3 note, 2026-08-25): a birthday
  // spread with <3 memories duplicates the beat its birthday-flagged month
  // segment already carries, and can't fill 2 pages anyway -- dissolve it
  // into the backbone, pinned so it survives thinning and the segment keeps
  // its special title.
  const birthdaySpreadIdSet = new Set([...birthdayGroups.keys()].map((ageTurned) => `birthday-${ageTurned}`));
  const {
    placementByMemory: afterDissolve,
    dissolvedAges: dissolvedBirthdayAges,
    pinnedMemoryIds,
    movedToBackbone: birthdayMovedToBackbone,
  } = dissolveThinBirthdaySpreads(afterThemedDissolve, birthdaySpreadIdSet, defaultBackboneCandidateByMemory);
  const movedToBackbone = [...themedMovedToBackbone, ...birthdayMovedToBackbone];

  // Firsts/birthday are non-droppable and never reassigned after this point
  // (only THEMED-origin spreads get dropped-for-budget below), so their
  // FINAL membership is already settled here -- read it from `afterDissolve`
  // (post single-placement AND birthday-beat dissolve) rather than the raw
  // pre-placement candidate lists, or a memory that lost its placement
  // contest to a scarcer spread would incorrectly still show up here too
  // (double placement).
  const firstsFinalMemoryIds = [...afterDissolve.entries()].filter(([, s]) => s === 'firsts').map(([id]) => id);
  const firstsFinalPresent = firstsFinalMemoryIds.length > 0;
  const birthdayFinalMemoryIdsByAge = new Map<number, string[]>();
  for (const ageTurned of birthdayGroups.keys()) {
    birthdayFinalMemoryIdsByAge.set(
      ageTurned,
      [...afterDissolve.entries()].filter(([, s]) => s === `birthday-${ageTurned}`).map(([id]) => id),
    );
  }
  // A dissolved age's memories all moved OUT of `birthday-N` above, so its
  // list here is empty; a surviving age (>=3, never touched) is untouched.
  // No age can land at 1-2 post-dissolve -- that's exactly what triggered
  // the dissolve.
  const survivingBirthdayAges = new Set(
    [...birthdayFinalMemoryIdsByAge.entries()].filter(([, ids]) => ids.length >= 3).map(([ageTurned]) => ageTurned),
  );

  // ── Priority-order page budget: (a) non-droppable, (b) candidate spreads,
  // (c) backbone gets only the leftover pages (coordinator spec correction,
  // 2026-08-24) -- a dissolved birthday spread's 2 pages are freed back into
  // the budget here automatically, since `nonDroppablePages` only counts
  // ages whose list (above) is still non-empty ─────────────────────────────

  const nonDroppablePages =
    (firstsFinalPresent ? 2 : 0) +
    [...birthdayFinalMemoryIdsByAge.values()].filter((ids) => ids.length > 0).length * 2;

  const isVisual = (memoryId: string) => {
    const f = features.get(memoryId)!;
    return f.photoCount + f.videoCount > 0;
  };

  // Owner root-cause fix, 2026-08-27: panorama/hero nominations drive each
  // memory's page SHAPE (never guessed from photo count alone), which in
  // turn drives its honest page cost -- see `classifyMemoryPageShape`.
  const heroCandidateIdSet = new Set(response.heroCandidates);
  const panoramaCandidateIdSet = new Set(response.panoramaCandidates);
  const shapeFor = (memoryId: string): MemoryPageShape => {
    const f = features.get(memoryId)!;
    return classifyMemoryPageShape({
      photoCount: f.photoCount,
      videoCount: f.videoCount,
      hasText: f.hasText,
      textLength: f.textLength,
      isPanorama: panoramaCandidateIdSet.has(memoryId),
      isFullBleed: heroCandidateIdSet.has(memoryId),
    });
  };

  // Owner round-3 decision, 2026-08-27: content-neutral ranking signals --
  // "highlight/hero status" and "topic-cluster membership" -- computed once
  // over the WHOLE book, independent of where a memory ends up landing.
  const highlightedOrHeroIds = new Set([
    ...response.backboneHighlights.flatMap((h) => h.memoryIds),
    ...response.heroCandidates,
  ]);
  const themedClusterMemberIds = new Set(candidates.flatMap((c) => c.memoryIds));

  const candidateBudgetElements: ThemedBudgetElement[] = [...spreadCandidateIds].map((spreadId) => {
    const memberIds = [...afterDissolve.entries()].filter(([, s]) => s === spreadId).map(([id]) => id);
    return { id: spreadId, memoryCount: memberIds.length, shapes: memberIds.map(shapeFor) };
  });

  // Placed-panorama guarantee (owner round-3 decision, 2026-08-27): "1 + 1
  // per ~20 pages" of the model's best-first panorama nominations must be
  // SELECTED into the book, not just nominated. `N` is derived from a
  // PRELIMINARY estimate (nothing dropped yet) so the guarantee count never
  // depends on its own outcome.
  const preliminaryBackboneShapes = [...afterDissolve.entries()]
    .filter(([, s]) => s.startsWith('backbone:'))
    .map(([id]) => shapeFor(id));
  const preliminaryPageEstimate =
    FIXED_PAGES +
    nonDroppablePages +
    candidateBudgetElements.reduce((sum, t) => sum + themedSpreadPages(t), 0) +
    Math.max(1, estimateElementPages(preliminaryBackboneShapes));
  const panoramaGuaranteeCount = computePlacedPanoramaGuaranteeCount(preliminaryPageEstimate);
  const guaranteedPanoramaIds = new Set(response.panoramaCandidates.slice(0, panoramaGuaranteeCount));

  // A themed spread carrying a guaranteed panorama is protected from being
  // dropped for budget -- the memory's guarantee would otherwise be
  // undermined by dropping the whole spread it lives in.
  const protectedThemedElements = candidateBudgetElements.filter((t) =>
    [...afterDissolve.entries()].some(([mid, s]) => s === t.id && guaranteedPanoramaIds.has(mid)),
  );
  const protectedThemedIdSet = new Set(protectedThemedElements.map((t) => t.id));
  const droppableThemedElements = candidateBudgetElements.filter((t) => !protectedThemedIdSet.has(t.id));
  const protectedThemedPages = protectedThemedElements.reduce((sum, t) => sum + themedSpreadPages(t), 0);

  const droppableNonBackbonePlan = planNonBackboneBudget(
    FIXED_PAGES,
    nonDroppablePages + protectedThemedPages,
    droppableThemedElements,
    options.pageCap,
  );
  const nonBackbonePlan: NonBackboneBudgetPlan = {
    nonBackbonePages: droppableNonBackbonePlan.nonBackbonePages,
    keptThemedIds: [...protectedThemedElements.map((t) => t.id), ...droppableNonBackbonePlan.keptThemedIds],
    droppedThemedIds: droppableNonBackbonePlan.droppedThemedIds,
    backboneCapacityPages: droppableNonBackbonePlan.backboneCapacityPages,
  };
  const droppedCandidateSet = new Set(nonBackbonePlan.droppedThemedIds);

  // A budget-dropped candidate spread's memories return to backbone
  // ELIGIBILITY (they compete on rank below) rather than being excluded
  // outright -- backbone thinning already handles overflow.
  const finalPlacement = new Map(afterDissolve);
  for (const [memoryId, spreadId] of afterDissolve) {
    if (!droppedCandidateSet.has(spreadId)) continue;
    const backboneId = defaultBackboneCandidateByMemory.get(memoryId);
    if (backboneId) finalPlacement.set(memoryId, backboneId);
  }

  // Content-neutral ranking (owner round-3 decision, 2026-08-27): every
  // backbone candidate competes on the SAME signals regardless of type --
  // never a milestone/text/photo "type" trump. Structural protections
  // (Firsts membership, birthday pins) stay outside this score entirely;
  // guaranteed panoramas join the same pin mechanism below.
  const backboneCandidates: BackboneCandidate[] = [...finalPlacement.entries()]
    .filter(([, spreadId]) => spreadId.startsWith('backbone:'))
    .map(([memoryId]) => {
      const f = features.get(memoryId)!;
      return {
        id: memoryId,
        date: f.date,
        shape: shapeFor(memoryId),
        // Same predicate as `finalBackboneInputs` below -- keeps this
        // candidate's segmentation identical to the REAL final segmentation
        // it will be re-run through once selection is done.
        printable: f.hasText || f.photoCount + f.videoCount > 0,
        score: computeThinningScore({
          isHighlighted: highlightedOrHeroIds.has(memoryId),
          inThemedCluster: themedClusterMemberIds.has(memoryId),
          engagementCount: f.engagementCount,
          hasText: f.hasText,
          textLength: f.textLength,
          hasVisual: f.photoCount + f.videoCount > 0,
        }),
      };
    });

  const allPinnedIds = new Set([...pinnedMemoryIds, ...guaranteedPanoramaIds]);
  const keptBackboneIds = new Set(
    selectBackboneMemories(backboneCandidates, nonBackbonePlan.backboneCapacityPages, allPinnedIds),
  );
  const excludedMemoryIds = [
    ...cliExcludedMemoryIds,
    ...backboneCandidates
      .filter((c) => !keptBackboneIds.has(c.id))
      .map((c) => ({ memoryId: c.id, elementId: 'backbone', reason: 'over_budget_backbone_not_selected' })),
  ];

  const finalBackboneInputs: BackboneMemoryInput[] = backboneCandidates
    .filter((c) => keptBackboneIds.has(c.id))
    .map((c) => {
      const f = features.get(c.id)!;
      return { id: c.id, date: c.date, printable: f.hasText || f.photoCount + f.videoCount > 0 };
    });
  // Re-segment chronologically from scratch over just the survivors --
  // buildBackboneSegments already merges/drops now-empty month segments.
  const finalBackboneSegments = buildBackboneSegments(finalBackboneInputs);

  const finalPageElements: BudgetElement[] = [
    ...nonBackbonePlan.keptThemedIds.map((id) => {
      const memberIds = [...finalPlacement.entries()].filter(([, s]) => s === id).map(([mid]) => mid);
      return { id, kind: 'themed' as const, memoryCount: memberIds.length, shapes: memberIds.map(shapeFor) };
    }),
    ...(firstsFinalPresent ? [{ id: 'firsts', kind: 'firsts' as const, memoryCount: firstsFinalMemoryIds.length }] : []),
    ...[...birthdayFinalMemoryIdsByAge.entries()].map(([ageTurned, ids]) => ({
      id: `birthday-${ageTurned}`,
      kind: 'birthday' as const,
      memoryCount: ids.length,
    })),
    ...finalBackboneSegments.map((s) => ({
      id: `backbone:${s.id}`,
      kind: 'backbone' as const,
      memoryCount: s.memoryIds.length,
      shapes: s.memoryIds.map(shapeFor),
    })),
  ];
  const totalPages = computePageEstimate(finalPageElements);
  const finalKeptMemoryIds = new Set<string>([
    ...finalBackboneInputs.map((b) => b.id),
    ...nonBackbonePlan.keptThemedIds.flatMap((id) => [...finalPlacement.entries()].filter(([, s]) => s === id).map(([mid]) => mid)),
    ...firstsFinalMemoryIds,
    ...[...birthdayFinalMemoryIdsByAge.values()].flat(),
  ]);
  const totalImageCount = [...finalKeptMemoryIds].filter(isVisual).length;
  const droppedElements = nonBackbonePlan.droppedThemedIds.map((id) => ({
    id,
    kind: 'themed' as const,
    reason: 'over_budget_dropped_themed_spread',
  }));

  console.log(
    `Page estimate: ${totalPages} (page cap ${options.pageCap} -- a CEILING, not a target; layflat hard limit ${HARD_PAGE_CAP}), via the per-composition page-yield model (owner round-3 decision, 2026-08-27). ${totalImageCount} visual (photo/video-bearing) memories kept. Dropped ${droppedElements.length} candidate spread(s) for budget; ${excludedMemoryIds.length} memory(ies) excluded (CLI + budget combined).`,
  );
  console.log(
    `Placed-panorama guarantee: ${guaranteedPanoramaIds.size} of ${response.panoramaCandidates.length} nominated (N = 1 + pageEstimate/20, from a preliminary estimate of ${preliminaryPageEstimate}).`,
  );

  // Owner round-4 decision, 2026-08-27: pageCap is supposed to be a hard
  // ceiling -- `planNonBackboneBudget` and `selectBackboneMemories` both
  // tighten until the honest estimate fits it. With both now segmenting the
  // backbone exactly like this final tally (root-cause fix above), the ONLY
  // way `totalPages` can still exceed `options.pageCap` here is if every
  // page left standing is structurally non-droppable -- Firsts, birthdays,
  // a themed spread protected by a guaranteed panorama, or a pinned
  // backbone memory -- i.e. physically impossible to trim further. That is
  // a real, visible fact about this book, not a bug to swallow silently, so
  // it is recorded as an integrity note rather than just persisted.
  if (totalPages > options.pageCap) {
    const detail =
      `pageEstimate ${totalPages} > pageCap ${options.pageCap} -- every remaining page is structurally ` +
      'non-droppable (Firsts, birthdays, guaranteed-panorama-protected themed spreads, and/or pinned ' +
      'backbone memories); there is nothing left to trim.';
    violations.push({ kind: 'page_cap_exceeded_all_protected', detail });
    console.warn(`INTEGRITY: page cap did not bind -- ${detail}`);
  }

  // ── Pacing (plan 2026-08-24: no 3+ consecutive unbroken backbone segments
  // while a spread is available to interleave; chronological affinity is a
  // soft preference, using each spread's median memory date) ─────────────

  const originalInsertIndexBySpreadId = new Map(response.spreads.map((s) => [`spread:${s.candidateId}`, s.insertAfterSegmentIndex]));

  const pacingInputs: PacingCandidate[] = nonBackbonePlan.keptThemedIds.map((spreadId) => {
    const memberIds = [...finalPlacement.entries()].filter(([, sid]) => sid === spreadId).map(([id]) => id);
    const idealGapIndex = memberIds.length > 0
      ? findAnchorSegmentIndex(computeMedianDate(memberIds.map((id) => features.get(id)!.date)).slice(0, 7), finalBackboneSegments)
      // Defensive fallback only -- keptThemedIds is already filtered to
      // memoryCount > 0, so this branch should not be reachable in practice.
      : remapInsertIndex(originalInsertIndexBySpreadId.get(spreadId) ?? -1, backboneSegments, finalBackboneSegments);
    return { id: spreadId, idealGapIndex, anchored: isTimeAnchoredCandidate(spreadId.slice('spread:'.length)) };
  });

  const pacedAssignment = paceThemedSpreads(finalBackboneSegments.length, pacingInputs);

  // ── Assemble the reading order (single source of truth for both renderers) ─

  const backboneRationale: Record<string, string> = {};
  for (const highlight of response.backboneHighlights) {
    for (const id of highlight.memoryIds) {
      if (highlight.rationale[id]) backboneRationale[id] = highlight.rationale[id];
    }
  }

  const readingOrderThemedSpreads: ReadingOrderThemedSpreadInput[] = response.spreads
    .filter((s) => nonBackbonePlan.keptThemedIds.includes(`spread:${s.candidateId}`))
    .map((s) => {
      const spreadId = `spread:${s.candidateId}`;
      const memoryIds = [...finalPlacement.entries()].filter(([, sid]) => sid === spreadId).map(([id]) => id);
      const rationale: Record<string, string> = {};
      for (const id of memoryIds) {
        if (s.rationale[id]) rationale[id] = s.rationale[id];
      }
      return {
        candidateId: s.candidateId,
        candidateKind: s.candidateKind,
        title: s.title,
        titleMode: s.titleMode,
        titleSourceMemoryId: s.titleSourceMemoryId,
        memoryIds,
        insertAfterFinalSegmentIndex: pacedAssignment.get(spreadId) ?? -1,
        rationale,
        kicker: s.kicker,
      };
    });

  // Bridge the AI's segment_titles (keyed by ORIGINAL segment id) onto the
  // FINAL (post-budget, re-segmented) segment list via the flagged month --
  // segment ids/boundaries can change across re-segmentation, but the
  // calendar month that triggered a flag cannot.
  const specialTitleByMonth = buildSpecialSegmentTitlesByMonth(originalSpecialFlags, response.segmentTitles);
  const finalSpecialFlags = flagSpecialBackboneSegments(finalBackboneSegments, birthMonth, birthdayMonthToAge);
  const applicableSpecialFlags = suppressSurvivingBirthdaySpecialTitles(finalSpecialFlags, survivingBirthdayAges);
  const specialSegmentTitles: Record<string, string> = {};
  for (const flag of applicableSpecialFlags) {
    const title = specialTitleByMonth.get(flag.month);
    if (title) specialSegmentTitles[flag.segmentId] = title;
  }

  const readingOrder = buildReadingOrder({
    childName: child.name,
    finalBackboneSegments,
    firsts: firstsFinalPresent
      ? { present: true, title: response.firstsTitle, memoryIds: firstsFinalMemoryIds, warmNames: response.firstsWarmNames }
      : null,
    birthdaySpreads: [...birthdayFinalMemoryIdsByAge.entries()]
      .filter(([, ids]) => ids.length > 0)
      .map(([ageTurned, ids]) => ({ ageTurned, memoryIds: ids })),
    themedSpreads: readingOrderThemedSpreads,
    backboneRationale,
    specialSegmentTitles,
    highlightedMemoryIds: new Set(response.backboneHighlights.flatMap((h) => h.memoryIds)),
  });

  // ── Render outputs ────────────────────────────────────────────────────

  await renderOutlineOutputs(outputDir, {
    runId,
    child,
    scope,
    window,
    familyMemoriesInWindow: familyMemories.length,
    eligibleTotal,
    taggedToChildCount,
    untaggedInWindowCount,
    portraitVersions,
    features,
    readingOrder,
    internalEditorialNote: response.internalEditorialNote,
    violations,
    reassignments,
    dissolvedSpreadIds,
    dissolvedBirthdayAges,
    movedToBackbone,
    droppedElements,
    excludedMemoryIds,
    totalPages,
    totalImageCount,
    pageCap: options.pageCap,
    heroCandidates: response.heroCandidates,
    panoramaCandidates: response.panoramaCandidates,
    guaranteedPanoramaIds,
    dedication: response.dedication,
    backCoverLine: response.backCoverLine,
  });

  console.log('\nDone.');
  console.log(`  Output dir: ${outputDir.pathname}`);
}

// ── Output rendering ─────────────────────────────────────────────────────

interface RenderContext {
  runId: string;
  child: ChildCandidate;
  scope: BookScope;
  window: ScopeWindow;
  familyMemoriesInWindow: number;
  eligibleTotal: number;
  taggedToChildCount: number;
  untaggedInWindowCount: number;
  portraitVersions: PortraitVersionRow[];
  features: Map<string, MemoryFeature>;
  /** Single source of truth for both outline.md and review.html -- see the
   * module comment above `buildReadingOrder`. */
  readingOrder: ReadingOrderSection[];
  /** Owner round-3 decision, 2026-08-27: renamed from `editorialNote` --
   * INTERNAL ONLY, never printed in the book (it leaked into a closing page
   * once under the old name). Rendered clearly labeled as such below. */
  internalEditorialNote: string;
  violations: OutlineIntegrityViolation[];
  reassignments: SinglePlacementResult['reassignments'];
  dissolvedSpreadIds: string[];
  /** Ages whose birthday spread dissolved into its backbone month (owner
   * round-3 note, 2026-08-25: birthday-beat merge rule). */
  dissolvedBirthdayAges: number[];
  movedToBackbone: DissolveResult['movedToBackbone'];
  droppedElements: Array<{ id: string; kind: BudgetElementKind; reason: string }>;
  excludedMemoryIds: Array<{ memoryId: string; elementId: string; reason: string }>;
  totalPages: number;
  /** Total visual (photo/video-bearing) memories in the final book. */
  totalImageCount: number;
  pageCap: number;
  /** Design handoff decision (2026-08-27): up to 5 book-wide candidates for
   * a full-bleed page or the cover. */
  heroCandidates: string[];
  /** Uncapped, best-first (owner amendment, 2026-08-27): every qualifying
   * book-wide candidate for a full double-page panorama spread. */
  panoramaCandidates: string[];
  /** Owner round-3 decision, 2026-08-27: the best-first prefix of
   * `panoramaCandidates` that was GUARANTEED a placement (backbone or
   * spread membership), not merely nominated -- see
   * `computePlacedPanoramaGuaranteeCount`. */
  guaranteedPanoramaIds: ReadonlySet<string>;
  /** Owner decision, 2026-08-27: dedication-page body + back-cover
   * colophon line, both connective text (journal language, editable
   * downstream). Null when the model didn't supply one. */
  dedication: string | null;
  backCoverLine: string | null;
}

/**
 * Plan (2026-08-24 outline review): AI rationales are internal review notes
 * only, never presentable as book copy -- every rendering of one must be
 * visually/textually labeled as such so it can never be mistaken for the
 * spread's actual (future, Stage D) connective text.
 */
function memoryLine(feature: MemoryFeature, rationale?: string): string {
  const markers: string[] = [];
  if (feature.topics.length > 0) markers.push(feature.topics.join('/'));
  if (feature.emotion) markers.push(feature.emotion);
  if (feature.milestones.length > 0) markers.push(`milestone:${feature.milestones.map((m) => m.name).join(',')}`);
  const excerpt = feature.excerpt ?? '(no text)';
  const rationaleSuffix = rationale ? ` — why selected (internal): ${rationale}` : '';
  return `${feature.date} -- ${excerpt} -- [${markers.join(', ')}]${rationaleSuffix}`;
}

/**
 * A section's display heading, shared by outline.md and review.html so a
 * quote title (owner amendment, round-2, 2026-08-25: quotation marks + a
 * "quoted from <date>" attribution) and a special birth/birthday backbone
 * title (plan round-2 decision, 2026-08-25: the plain month label survives
 * as a subtitle) render identically in both artifacts.
 */
function resolveSectionHeading(
  section: ReadingOrderSection,
  features: Map<string, MemoryFeature>,
): { title: string; subtitle: string | null } {
  if (section.kind === 'themed' && section.titleMode === 'quote') {
    const sourceDate = section.titleSourceMemoryId ? features.get(section.titleSourceMemoryId)?.date : undefined;
    return { title: `"${section.title}"`, subtitle: `quoted from ${sourceDate ?? 'unknown date'}` };
  }
  return { title: section.title, subtitle: section.subtitle ?? null };
}

async function renderOutlineOutputs(outputDir: URL, ctx: RenderContext): Promise<void> {
  const md: string[] = [];
  md.push(`# Memory Book Outline -- ${ctx.child.name}`);
  md.push('');
  md.push(`Run: ${ctx.runId}  `);
  md.push(`Scope: ${ctx.scope.type} (${ctx.window.label}), window ${ctx.window.start} to ${scopeWindowLastInclusiveDay(ctx.window)}  `);
  md.push(`Page estimate: ${ctx.totalPages} / page cap ${ctx.pageCap} (a CEILING, not a target; layflat hard limit ${HARD_PAGE_CAP}) -- via the per-composition page-yield model (owner round-3 decision, 2026-08-27)`);
  md.push(`Image count: ${ctx.totalImageCount} visual (photo/video-bearing) memories in the final book`);
  md.push('');
  md.push('## Memory counts');
  md.push('');
  md.push(`- Memories in window: ${ctx.familyMemoriesInWindow}`);
  md.push(`- Eligible: ${ctx.eligibleTotal} (tagged to child: ${ctx.taggedToChildCount}, untagged-in-window: ${ctx.untaggedInWindowCount})`);
  md.push(`- Excluded (CLI + over budget): ${ctx.excludedMemoryIds.length}`);
  md.push('');

  md.push('## Reading order');
  md.push('');

  for (const section of ctx.readingOrder) {
    if (section.kind === 'cover') {
      md.push('### Cover');
      md.push('_(concept slot -- no memories; illustration TBD in Stage C/D)_');
      md.push('');
      continue;
    }
    if (section.kind === 'title') {
      md.push('### Title & dedication');
      md.push('_(placeholder -- AI connective text fills this in Stage D)_');
      md.push('');
      continue;
    }
    if (section.kind === 'closing') {
      md.push('### Closing');
      md.push('_(placeholder -- AI connective text fills this in Stage D)_');
      md.push('');
      continue;
    }
    if (section.kind === 'through-the-years') {
      md.push(`### ${section.title}`);
      if (ctx.portraitVersions.length === 0) {
        md.push('_(no ready portrait versions in scope)_');
      } else {
        for (const version of ctx.portraitVersions) {
          const age = version.reference_date
            ? describeAgeAtDate(ctx.child.dateOfBirth ?? version.reference_date, version.reference_date)
            : 'unknown age';
          md.push(`- ${version.id} -- ${version.reference_date ?? '(undated)'} -- ${age}`);
        }
      }
      md.push('');
      continue;
    }

    // firsts / birthday / themed / backbone -- uniform rendering, always in
    // sync with review.html because both walk this exact same list.
    const heading = resolveSectionHeading(section, ctx.features);
    md.push(`### ${heading.title}`);
    if (section.kicker) md.push(`_(kicker, small caps): ${section.kicker}_`);
    if (heading.subtitle) md.push(`_(${heading.subtitle})_`);
    for (const id of section.memoryIds) {
      const feature = ctx.features.get(id);
      if (!feature) continue;
      const highlightMarker = section.highlights?.includes(id) ? '★ ' : '';
      md.push(`- ${highlightMarker}${memoryLine(feature, section.rationale[id])}`);
      if (section.kind === 'firsts') {
        const warmNames = (section.firstsWarmNames ?? []).filter((w) => w.memoryId === id);
        for (const w of warmNames) md.push(`  - warm_name: "${w.warmName}"`);
      }
    }
    md.push('');
  }

  md.push('## Exclusions');
  md.push('');
  const excludedByReason = new Map<string, string[]>();
  for (const excl of ctx.excludedMemoryIds) {
    const list = excludedByReason.get(excl.reason) ?? [];
    list.push(excl.memoryId);
    excludedByReason.set(excl.reason, list);
  }
  if (excludedByReason.size === 0) {
    md.push('_(none)_');
  } else {
    for (const [reason, ids] of excludedByReason) {
      md.push(`- ${reason}: ${ids.length} memory(ies)`);
    }
  }
  md.push('');

  md.push('## Hero candidates (full-bleed / cover consideration)');
  md.push('');
  if (ctx.heroCandidates.length === 0) {
    md.push('_(none)_');
  } else {
    for (const id of ctx.heroCandidates) {
      const feature = ctx.features.get(id);
      if (feature) md.push(`- ${memoryLine(feature)}`);
    }
  }
  md.push('');

  md.push('## Panorama candidates (full double-page spread consideration)');
  md.push('');
  if (ctx.panoramaCandidates.length === 0) {
    md.push('_(none -- flag for review: every book should have at least one when a plausible landscape exists)_');
  } else {
    md.push(
      `_${ctx.guaranteedPanoramaIds.size} of ${ctx.panoramaCandidates.length} nominated are GUARANTEED a placement (owner round-3 decision, 2026-08-27: "1 + 1 per ~20 pages"), marked ✓ below._`,
    );
    for (const id of ctx.panoramaCandidates) {
      const feature = ctx.features.get(id);
      const guaranteedMarker = ctx.guaranteedPanoramaIds.has(id) ? '✓ ' : '';
      if (feature) md.push(`- ${guaranteedMarker}${memoryLine(feature)}`);
    }
  }
  md.push('');

  md.push('## Dedication');
  md.push('');
  md.push(ctx.dedication || '_(none returned)_');
  md.push('');

  md.push('## Back cover');
  md.push('');
  md.push(ctx.backCoverLine || '_(none returned)_');
  md.push('');

  md.push('## Editorial note (INTERNAL ONLY -- never printed in the book)');
  md.push('');
  md.push(ctx.internalEditorialNote || '_(none returned)_');
  md.push('');

  md.push('## Integrity notes');
  md.push('');
  md.push(`- Model response violations: ${ctx.violations.length}`);
  for (const v of ctx.violations) md.push(`  - ${v.kind}: ${v.detail}`);
  md.push(`- Single-placement reassignments: ${ctx.reassignments.length}`);
  for (const r of ctx.reassignments) md.push(`  - ${r.memoryId}: kept in ${r.keptIn}, dropped from ${r.droppedFrom.join(', ')}`);
  md.push(`- Dissolved candidate spreads (fell below 3 after dedup): ${ctx.dissolvedSpreadIds.join(', ') || 'none'}`);
  md.push(
    `- Dissolved birthday spreads (fell below 3, merged into their birthday month, pinned): ${ctx.dissolvedBirthdayAges.length > 0 ? ctx.dissolvedBirthdayAges.map((age) => `turns ${age}`).join(', ') : 'none'}`,
  );
  md.push(`- Moved to backbone on dissolve: ${ctx.movedToBackbone.length}`);
  md.push(`- Dropped whole candidate spreads for page budget (returned to backbone eligibility): ${ctx.droppedElements.map((d) => d.id).join(', ') || 'none'}`);
  md.push('');

  await Deno.writeTextFile(new URL('outline.md', outputDir), md.join('\n'));

  const json = {
    runId: ctx.runId,
    child: { id: ctx.child.id, name: ctx.child.name },
    scope: ctx.scope,
    window: ctx.window,
    pageEstimate: ctx.totalPages,
    imageCount: ctx.totalImageCount,
    pageCap: ctx.pageCap,
    counts: {
      inWindow: ctx.familyMemoriesInWindow,
      eligible: ctx.eligibleTotal,
      taggedToChild: ctx.taggedToChildCount,
      untaggedInWindow: ctx.untaggedInWindowCount,
      excluded: ctx.excludedMemoryIds.length,
    },
    elements: ctx.readingOrder,
    heroCandidates: ctx.heroCandidates,
    panoramaCandidates: ctx.panoramaCandidates,
    // Owner round-3 decision, 2026-08-27: "1 + 1 per ~20 pages" of
    // `panoramaCandidates` (best-first prefix) that were GUARANTEED a
    // placement, not merely nominated -- see
    // `computePlacedPanoramaGuaranteeCount`.
    guaranteedPanoramaIds: [...ctx.guaranteedPanoramaIds],
    dedication: ctx.dedication,
    backCoverLine: ctx.backCoverLine,
    // Owner round-3 decision, 2026-08-27: renamed from `editorialNote` --
    // INTERNAL ONLY, a curator's note for human review, NEVER printed on
    // any book page (it leaked into a closing page once under the old
    // name; see `internalEditorialNote`'s doc comment on
    // `ParsedOutlineResponse`). No renderer should ever read this field.
    internalEditorialNote: ctx.internalEditorialNote,
    integrity: {
      violations: ctx.violations,
      reassignments: ctx.reassignments,
      dissolvedSpreadIds: ctx.dissolvedSpreadIds,
      dissolvedBirthdayAges: ctx.dissolvedBirthdayAges,
      movedToBackbone: ctx.movedToBackbone,
      droppedElements: ctx.droppedElements,
      excludedMemoryIds: ctx.excludedMemoryIds,
    },
  };
  await Deno.writeTextFile(new URL('outline.json', outputDir), JSON.stringify(json, null, 2));

  await renderReviewHtml(outputDir, ctx);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function renderReviewHtml(outputDir: URL, ctx: RenderContext): Promise<void> {
  const thumbsDir = new URL('thumbs/', outputDir);
  await Deno.mkdir(thumbsDir, { recursive: true });

  const cards: string[] = [];
  // Walks the exact same ordered list outline.md walks -- see the
  // RenderContext.readingOrder doc comment. cover/title/through-the-years/
  // closing carry no memoryIds, so they're skipped here by construction.
  for (const section of ctx.readingOrder) {
    if (section.memoryIds.length === 0) continue;
    const memberCards: string[] = [];
    for (const id of section.memoryIds) {
      const feature = ctx.features.get(id);
      if (!feature) continue;

      let thumbTag = '';
      if (feature.previewKey) {
        try {
          const bytes = await getObjectBytes(feature.previewKey);
          const ext = feature.previewKey.endsWith('.png') ? 'png' : feature.previewKey.endsWith('.webp') ? 'webp' : 'jpg';
          await Deno.writeFile(new URL(`${id}.${ext}`, thumbsDir), bytes);
          thumbTag = `<img class="thumb" src="thumbs/${id}.${ext}" loading="lazy" />`;
        } catch (error) {
          console.error(`  memory ${id}: failed to fetch thumbnail --`, error instanceof Error ? error.message : error);
        }
      }

      const isHighlight = section.highlights?.includes(id) ?? false;
      memberCards.push(`
      <div class="memory${isHighlight ? ' highlight' : ''}">
        ${isHighlight ? '<div class="highlight-badge">★ highlight</div>' : ''}
        ${thumbTag}
        <div class="date">${escapeHtml(feature.date)}</div>
        <div class="excerpt">${escapeHtml(feature.excerpt ?? '(no text)')}</div>
        <div class="markers">${[...feature.topics, feature.emotion ?? ''].filter(Boolean).map((m) => `<span class="chip">${escapeHtml(m)}</span>`).join('')}</div>
        ${section.rationale[id] ? `<div class="rationale"><span class="rationale-label">Why selected (internal)</span>${escapeHtml(section.rationale[id])}</div>` : ''}
      </div>`);
    }

    const heading = resolveSectionHeading(section, ctx.features);
    cards.push(`
    <section class="spread">
      ${section.kicker ? `<div class="kicker">${escapeHtml(section.kicker)}</div>` : ''}
      <h2>${escapeHtml(heading.title)}</h2>
      ${heading.subtitle ? `<div class="section-subtitle">${escapeHtml(heading.subtitle)}</div>` : ''}
      <div class="grid">${memberCards.join('\n')}</div>
    </section>`);
  }

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Memory Book Outline -- ${escapeHtml(ctx.child.name)} (${escapeHtml(ctx.runId)})</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #faf8f5; margin: 0; padding: 24px; }
  h1 { font-size: 20px; }
  h2 { font-size: 16px; margin-bottom: 2px; }
  .section-subtitle { font-size: 12px; font-style: italic; color: #777; margin-bottom: 8px; }
  .kicker { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #8b7ec8; margin-bottom: 2px; }
  .memory.highlight { border-color: #8b7ec8; box-shadow: 0 0 0 2px rgba(139,126,200,0.3); }
  .highlight-badge { font-size: 10px; font-weight: 700; color: #6a5ea8; margin-bottom: 4px; }
  .spread { background: #fff; border-radius: 12px; padding: 16px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
  .memory { border: 1px solid #eee; border-radius: 8px; padding: 8px; }
  .thumb { width: 100%; height: 120px; object-fit: cover; border-radius: 6px; background: #eee; }
  .date { font-weight: 600; font-size: 12px; margin-top: 6px; }
  .excerpt { font-size: 13px; font-style: italic; color: #555; margin-top: 2px; }
  .markers { margin-top: 4px; }
  .chip { display: inline-block; background: #eef; border-radius: 10px; padding: 2px 8px; margin: 2px 2px 0 0; font-size: 11px; }
  .rationale { font-size: 11px; color: #92620a; margin-top: 6px; padding: 4px 6px; background: #fff7e6; border-left: 3px solid #e0a92e; border-radius: 3px; }
  .rationale-label { display: block; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: #b5790a; margin-bottom: 2px; }
</style>
</head>
<body>
<h1>Memory Book Outline -- ${escapeHtml(ctx.child.name)} (run ${escapeHtml(ctx.runId)})</h1>
${cards.join('\n')}
</body>
</html>`;

  await Deno.writeTextFile(new URL('review.html', outputDir), html);
}

if (import.meta.main) {
  await main();
}
