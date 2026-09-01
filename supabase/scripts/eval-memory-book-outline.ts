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
 * "highlight" treatment, and an overall editorial note. The model curates
 * for QUALITY only; it never rewrites parent text, never paginates, and
 * (round-14 owner decision) is never asked to self-ration for a page count
 * -- single placement and small-spread dissolution are enforced in CODE,
 * never trusted from the model (plan §5 "Overlap and single placement",
 * "Code-enforced post-processing"), but page-BUDGET fitting is no longer
 * one of this script's own downstream rules at all: it happens once, later,
 * entirely inside the renderer's fitter at render time (round-13's
 * balanced cap-pressure demotion) -- see the "Fitter-as-oracle" section
 * below for why and how this script still reports an (informational,
 * non-binding) page estimate.
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
 *   npm run eval:memory-book-outline -- --child "Mara" --from 2023-06-01 --to 2023-12-31 --page-cap 100
 *
 * Requires Supabase vars in supabase/.env.local, R2 vars for thumbnail
 * fetches, and OPENAI_API_KEY (unless --dry-run).
 * DB/R2/OpenAI env access is not available in every environment this script
 * runs in -- it must typecheck even when it cannot be executed.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { describeAgeAtDate, getAgeInYearsAtDate } from '../functions/_shared/age.ts';
import { getObjectBytes, getObjectBytesBatch, type ObjectBytesBatchEntry } from '../functions/_shared/r2.ts';
import { addYears, classifyChildOrAdult, toJulianDayNumber } from '../functions/_shared/date-context.ts';
import { DATE_GATED_TOPIC_IDS, TOPICS } from '../functions/_shared/memory-topics.ts';
import { getMilestoneById } from '../functions/_shared/memory-milestones.ts';
// V5a "part B": the pure outline-generation pieces (prompt builders, request-
// body builders, response parsing/validation, cover-verify pass, usage/cost
// summation, and the outline-shape types) now live in a runtime-agnostic
// shared module so the upcoming Cloudflare Workflow worker can import them
// too -- same precedent as workflow.ts importing prompts.ts. This eval
// script re-imports them here rather than redefining them.
import {
  applyCoverVerifyVerdicts,
  buildCoverVerifyRequestBody,
  buildCoverVerifySystemPrompt,
  buildCoverVerifyUserText,
  buildOutlineRequestBody,
  buildOutlineSystemPrompt,
  buildOutlineUserPrompt,
  FIRSTS_MIN_MILESTONES,
  parseCoverVerifyResponse,
  parseOutlineResponse,
  PRICE_USD_PER_MTOK,
  sumOpenAiUsage,
  verifyQuoteTitles,
  type BackboneSegment,
  type Candidate,
  type CandidateKind,
  type CoverVerifyImageInput,
  type MemoryFeature,
  type OpenAiUsage,
  type OutlineIntegrityViolation,
  type OutlineSkeletonSummaryInput,
  type ParsedFirstsWarmName,
  type ParsedOutlineResponse,
  type ParsedSpreadSelection,
  type PhotoOrientation,
  type PhotoOrientationInfo,
  type SpecialSegmentFlag,
  type SpreadTitleMode,
  type TaggedMemberFeature,
} from '../functions/_shared/memory-book-outline.ts';
// Round-13 "fitter-as-oracle" architecture follow-up (docs/plans/memory-book.md):
// the real renderer's page-yield model, imported directly -- pure TS, no
// React/DOM (see the file-header comment on the "Fitter-as-oracle" section
// below for why this needs `--sloppy-imports` at the CLI, and why two of
// fitter.ts's own type-only imports were split into `.types.ts` companions
// to keep this graph React-free). This REPLACES the hand-rolled page-
// accounting constants as the source of every BINDING page estimate.
import { fitBook } from '../../book-renderer/src/model/fitter.ts';
import type {
  BookManifest,
  BookOutline,
  ManifestAsset,
  ManifestMemory,
  ManifestPortrait,
  OutlineElementKind,
  SpreadType,
  TitleMode,
} from '../../book-renderer/src/model/types.ts';

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
 * this. Round-14: `--page-cap`/`HARD_PAGE_CAP` are no longer BINDING inside
 * this script at all (nothing here drops anything for budget) -- they now
 * feed only (a) the clamp warning below and (b) the "at-cap" oracle
 * simulation in `main()`'s printed summary, which reports what the
 * renderer's own fitter would do to this selection, never enforces it
 * here. The renderer's fitter is the one place a page cap actually binds. */
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
  /** Round-18 (owner decision, "books are standalone"): the owner-managed
   * BCP-47 caption locale (`families.gallery_caption_language`, see
   * docs/features/gallery-import.md) -- source (2) of the outline's LANGUAGE
   * resolution chain, behind the account's actual predominant caption
   * language and ahead of the final 'en' fallback. Column default is
   * `'en-US'` and NOT NULL in the schema, but this is read defensively (a
   * blank/whitespace value is treated the same as unset) rather than
   * assumed always-present. */
  gallery_caption_language: string | null;
}

interface FamilyMemberRow {
  id: string;
  family_id: string;
  name: string;
  date_of_birth: string | null;
  /** Round-16 (owner correction): the PROFILE'S own kinship/pet nicknames
   * (`family_members.nicknames text[]`) -- the authoritative source for a
   * person's name in generated copy, never text-mined from memory
   * captions (a caption may incidentally contain the same word, but that's
   * not where this comes from). */
  nicknames: string[] | null;
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
  // Round-18: `gallery_caption_language` added to this SAME query (every
  // family visible to the account is already loaded here to resolve
  // `--child`) rather than a second round trip per book.
  const { data, error } = await supabase
    .from('families')
    .select('id, name, gallery_caption_language')
    .is('deleted_at', null);
  if (error) throw new Error(`Failed to load families: ${error.message}`);
  return (data ?? []) as FamilyRow[];
}

/**
 * Up to `limit` recent non-empty `memories.content` values for the WHOLE
 * family archive (never scoped to this book's window or child) -- LANGUAGE
 * EVIDENCE ONLY, per the outline's LANGUAGE resolution chain (plan round-18,
 * "books are standalone": "predominant caption language account-wide").
 * Only called when the window's OWN caption count is sparse (see
 * `WINDOW_CAPTION_SPARSE_THRESHOLD` in `main()`) -- most books never need
 * this extra round trip. Each caption is trimmed and capped to
 * `LANGUAGE_EVIDENCE_EXCERPT_MAX_CHARS`; this text is sent to the OpenAI
 * prompt (same PII posture as every other memory excerpt in this file) but
 * is NEVER printed to stdout.
 */
async function loadAccountWideCaptionSample(
  supabase: AuthedClient,
  familyId: string,
  limit: number,
): Promise<string[]> {
  const { data, error } = await supabase
    .from('memories')
    .select('content')
    .eq('family_id', familyId)
    .not('content', 'is', null)
    .neq('content', '')
    .order('memory_date', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Failed to load account-wide caption sample: ${error.message}`);
  return ((data ?? []) as Array<{ content: string | null }>)
    .map((row) => row.content?.trim() ?? '')
    .filter((c) => c.length > 0)
    .map((c) => (c.length > LANGUAGE_EVIDENCE_EXCERPT_MAX_CHARS ? `${c.slice(0, LANGUAGE_EVIDENCE_EXCERPT_MAX_CHARS)}…` : c));
}

async function loadFamilyMembers(supabase: AuthedClient, familyId: string): Promise<FamilyMemberRow[]> {
  const { data, error } = await supabase
    .from('family_members')
    .select('id, family_id, name, date_of_birth, nicknames')
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
  /** Round-16: profile nicknames (`family_members.nicknames`), normalized
   * to `[]` when the profile has none. */
  nicknames: string[];
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
//
// MemoryMilestoneFeature/MemoryFeature/TaggedMemberFeature moved to
// ../functions/_shared/memory-book-outline.ts (V5a "part B") -- they're the
// outline's core "memory as fed to the AI" shape, needed by
// buildOutlineUserPrompt's own signature.

const TEXT_EXCERPT_MAX_CHARS = 120;
const PHOTO_CONTENT_TYPE_PREFIX = 'image/';
const VIDEO_CONTENT_TYPE_PREFIX = 'video/';

// ── LANGUAGE resolution (plan round-18, "books are standalone": caption-less
// books -- Enzo year one/two's caption-less photo eras -- came out in
// ENGLISH because "the family's journal language" was inferred by the model
// purely from captions it never had. Owner chain: (1) predominant language
// of the ACCOUNT's captions (whole archive, not the window); (2)
// `families.gallery_caption_language`; (3) 'en'. The MODEL resolves (1) --
// it can read caption text, this script cannot -- and returns its choice as
// a `language` field (see buildOutlineSystemPrompt's LANGUAGE block); this
// script only supplies the evidence and a deterministic (2)/(3) fallback
// for when the model's field is missing or malformed. ) ────────────────────

/** Below this many in-WINDOW non-empty captions, the window's own MEMORIES
 * block is too thin for the model to reliably judge a language from --
 * `main()` then also loads `loadAccountWideCaptionSample` as LANGUAGE
 * EVIDENCE ONLY. Deliberately small (mirrors `SPARSE_TOPIC_TRIGGER_COUNT`'s
 * precedent above): a caption-less photo ERA (the reported incident) can
 * have a window caption count of zero, but a normal book with even a
 * handful of real captions should judge its own language from itself. */
const WINDOW_CAPTION_SPARSE_THRESHOLD = 5;

/** "up to ~40 recent account-wide non-empty captions" per the owner brief --
 * enough for the model to confidently judge a predominant language without
 * ballooning prompt size. */
const LANGUAGE_EVIDENCE_SAMPLE_LIMIT = 40;

/** Each LANGUAGE EVIDENCE caption is trimmed to this length -- the model
 * only needs enough text to recognize the language, not the full story. */
const LANGUAGE_EVIDENCE_EXCERPT_MAX_CHARS = 80;

// BCP47_PATTERN/FALLBACK_LANGUAGE/resolveOutlineLanguage moved to
// ../functions/_shared/memory-book-outline.ts (used directly inside
// parseOutlineResponse, which moved too).

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

// PhotoOrientation/PhotoOrientationInfo/formatOrientationMarker moved to
// ../functions/_shared/memory-book-outline.ts (needed by
// buildOutlineUserPrompt). classifyOrientation/computeFirstPhotoOrientation
// stay here -- they read `MediaRow`, a DB-shape type local to this script.

const WIDE_ASPECT_RATIO_THRESHOLD = 1.15;
const TALL_ASPECT_RATIO_THRESHOLD = 0.87;

export function classifyOrientation(aspectRatio: number): PhotoOrientation {
  if (aspectRatio > WIDE_ASPECT_RATIO_THRESHOLD) return 'wide';
  if (aspectRatio < TALL_ASPECT_RATIO_THRESHOLD) return 'tall';
  return 'square';
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

export interface FamilyMemberForTagging {
  id: string;
  name: string;
  dateOfBirth: string | null;
  /** Round-16: profile nicknames (`family_members.nicknames`) -- the
   * authoritative source for how the AI should name this person in
   * generated copy (people-pair titles, etc.), never text-mined. */
  nicknames: string[];
}

/**
 * Resolves each tagged member id into their first name, profile
 * nicknames, and a child/adult classification at the memory's date. The
 * first name/child-adult classification are the ONLY sanctioned source of
 * RELATIONSHIP WORDS for the AI (plan round-2 decision, 2026-08-25) --
 * `nicknames` is a SEPARATE, round-16 addition: the profile's own data,
 * not text evidence, and not a relationship claim -- see the system
 * prompt's "PEOPLE-PAIR SPREAD TITLES AND NAMES IN COPY" section.
 * Unresolvable ids (shouldn't happen -- every tag references a real family
 * member) are silently skipped rather than thrown, matching this script's
 * tolerant-read style.
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
      nicknames: member.nicknames,
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

// BackboneSegment moved to ../functions/_shared/memory-book-outline.ts
// (needed by OutlineSkeletonSummaryInput's own signature).

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
//
// CandidateKind/Candidate moved to ../functions/_shared/memory-book-outline.ts
// (needed by buildOutlineUserPrompt/ParsedSpreadSelection's own signatures).

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
  /** The dissolved memories (round-14: no longer consumed as `pinnedIds`
   * anywhere -- `selectBackboneMemories` keeps everyone unconditionally
   * now, so nothing needs pinning against thinning. Kept in the return
   * shape as a record of which memories the birthday-beat merge touched,
   * since a birthday memory folding into its month is still the whole
   * point of the merge -- just no longer a protective mechanism.) */
  pinnedMemoryIds: Set<string>;
  movedToBackbone: Array<{ memoryId: string; fromSpread: string; toSpread: string }>;
}

/**
 * Mirrors `dissolveSmallThemedSpreads`'s mechanics exactly (same <3
 * threshold, same "move to the memory's own default backbone segment"
 * behavior) but is a distinct function because the birthday case ALSO
 * flags the dissolved memories in its own `pinnedMemoryIds` set (round-14:
 * no longer consumed for thinning protection -- see that field's doc
 * comment -- but the distinct tracking stays, since a birthday-beat merge
 * is still a semantically different event from an ordinary themed-spread
 * dissolve).
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

// ── Page accounting (round-14: outline-side BUDGET THINNING REMOVED) ────
//
// Owner decision (round-14, following an A/B test): this script no longer
// prices individual memories or spreads for page budget AT ALL, in any
// form -- not the original round-3 hand-rolled shape-based model, and not
// round-13's shape-placeholder oracle that replaced it (both are deleted).
// The A/B showed the shape-placeholder oracle over-thinned real books
// (Enzo fell to 93 selected memories, Mara to 96, when the OLD flow -- and
// the renderer itself -- comfortably printed ~112+ at the page cap) because
// pricing a memory in ISOLATION, via a canonical stand-in for its shape,
// cannot see the pairing/digest-row compression the real fitter applies
// once memories sit next to each other on a page. The fix is architectural,
// not a better price: the outline's job is taste and structure (which
// spreads, which memories, how they sequence); FITTING those choices to a
// physical page count is the renderer's job alone, at render time, via
// `book-renderer/src/model/fitter.ts`'s round-13 balanced cap-pressure
// demotion (month floors, milestone/quote-source protections, photo/video/
// illustrated keep-rate balancing -- see fitter.ts's own file-header
// comment on `DemotionKind`). This script selects for QUALITY and lets the
// selection be however long it honestly is; see `main()`'s "Panorama
// guarantee + published pageEstimate" section for how the (now purely
// informational) page estimate is still reported.
//
// The ONE surviving numeric estimate below (`computePlacedPanoramaGuaranteeCount`)
// is not a budget mechanism -- it never drops or excludes anything -- it
// only sizes how many of the model's best-first panorama nominations this
// script reports as "expected to survive" for reviewer context.

/**
 * The number of the model's best-first `panoramaCandidates` reported as
 * "guaranteed" survivors, for reviewer context only (owner round-3
 * decision, 2026-08-27: "1 guaranteed + 1 per ~20 pages" -- the same
 * pacing the system prompt already tells the model to expect; round-14:
 * this no longer protects anything from being dropped -- nothing in this
 * script drops anything anymore -- it is purely an informational count).
 * `pageEstimate` is the PRE-CAP holistic oracle estimate of the FULL
 * curated selection (round-14: fed by the one remaining oracle call in
 * `main()`, not a preliminary-vs-final split -- there is no "final" thin
 * to distinguish it from anymore).
 */
export function computePlacedPanoramaGuaranteeCount(pageEstimate: number): number {
  return 1 + Math.floor(Math.max(0, pageEstimate) / 20);
}

// ---------------------------------------------------------------------------
// Fitter-as-oracle (round-13 architecture follow-up, docs/plans/memory-book.md
// "make the fitter the yield oracle"; round-14 UPDATE below): the original
// hand-written page-accounting model (since DELETED -- it duplicated the
// real renderer's page-yield math in its own constants, and the two had
// drifted through 12 layout rounds: predicted 108 pages where the renderer
// produced 121 on Mara; the hand model predated digest spreads entirely).
// This section imports the REAL fitter (`fitBook`) and calls it directly on
// a SYNTHETIC `BookManifest`/`BookOutline` built from data this script
// already loads, so every BINDING page number reflects the real renderer,
// not a parallel guess. Round-13 ALSO tried routing the outline's own
// backbone-thinning/candidate-dropping loops through a per-shape oracle
// approximation; round-14 found (via A/B) that pricing a memory in
// ISOLATION over-thinned real books, and the owner decision was to remove
// outline-side thinning ENTIRELY rather than chase a better per-candidate
// price -- see the "Themed-spread and backbone selection" section below.
// What remains here is purely the HOLISTIC oracle: one real-fitter call
// over a full assembled selection, used for the published pageEstimate,
// the panorama-guarantee sizing input, and the at-cap summary report.
//
// Outline-time unknowns (fail closed, never guessed -- task spec):
//   - Asset PIXEL dimensions: this script has `memory_media.aspect_ratio`
//     but never measures real width/height. Every synthetic asset gets a
//     nominal width/height at the SAME aspect ratio, deliberately scaled
//     well under every trust threshold in the fitter (panorama 3500px,
//     full-bleed 2500px -- `SYNTHETIC_NOMINAL_LONG_SIDE_PX` below) so an
//     ordinary photo can never accidentally pass a trust gate.
//     `originalWidth`/`originalHeight` are left undefined, exactly like a
//     real outline-time export would be.
//   - The two exceptions are the outline's OWN `panoramaCandidates` and
//     `heroCandidates` nominations: wired into the synthetic manifest with
//     an explicit trusted `originalWidth` (mirroring how the real export
//     pipeline measures dimensions specifically for nominated candidates),
//     so the fitter's panorama/full-bleed splice logic can activate for
//     them and the yield estimate accounts for the extra pages those
//     compositions actually consume.
//   - Illustration pixel dimensions are never tracked here either: every
//     text memory's synthetic illustration gets aspect ratio 1.0 (task
//     spec: "a text memory ⇒ illustration aspect 1.0").
//   - Memory TEXT CONTENT never flows into a synthetic manifest, only its
//     LENGTH (`MemoryFeature.textLength`, already the PII-safe signal this
//     script logs elsewhere -- see its own doc comment) -- a placeholder
//     string of the same length stands in, since every one of the fitter's
//     page-shape decisions depends on length, never content.
// ---------------------------------------------------------------------------

/** Deliberately well under every trust threshold in fitter.ts (panorama
 * 3500px, full-bleed 2500px) -- an ordinary, non-nominated synthetic photo
 * can never accidentally pass a trust gate. */
const SYNTHETIC_NOMINAL_LONG_SIDE_PX = 1600;
/** Comfortably over BOTH trust thresholds -- a nominated (panorama/hero)
 * synthetic photo always passes. */
const SYNTHETIC_TRUSTED_LONG_SIDE_PX = 4000;

function syntheticAssetDimensions(
  aspectRatio: number,
  trusted: boolean,
): { width: number; height: number; originalWidth: number | null; originalHeight: number | null } {
  const longSide = trusted ? SYNTHETIC_TRUSTED_LONG_SIDE_PX : SYNTHETIC_NOMINAL_LONG_SIDE_PX;
  const width = aspectRatio >= 1 ? longSide : Math.round(longSide * aspectRatio);
  const height = aspectRatio >= 1 ? Math.round(longSide / aspectRatio) : longSide;
  return { width, height, originalWidth: trusted ? width : null, originalHeight: trusted ? height : null };
}

/**
 * One `memory_media` row -> one synthetic `ManifestAsset` (round-13 oracle).
 * Pixel dimensions are nominal/outline-time (see section comment above);
 * `trusted` wires a panorama/hero nomination's dimensions so the fitter's
 * trust gates can activate for it.
 */
export function buildSyntheticAsset(media: MediaRow, trusted: boolean): ManifestAsset {
  const aspectRatio = media.aspect_ratio ?? 1.5; // rare null -- ordinary landscape fallback, never trusted-path-relevant
  const dims = syntheticAssetDimensions(aspectRatio, trusted);
  return {
    file: `synthetic/${media.id}.jpg`,
    width: dims.width,
    height: dims.height,
    aspectRatio,
    kind: media.content_type.startsWith(VIDEO_CONTENT_TYPE_PREFIX) ? 'video-poster' : 'photo',
    durationMs: null,
    originalWidth: dims.originalWidth,
    originalHeight: dims.originalHeight,
  };
}

/**
 * One eligible memory's already-computed `MemoryFeature` + its raw media
 * rows -> one synthetic `ManifestMemory` (round-13 oracle). Never carries
 * real text content -- see section comment above.
 */
export function buildSyntheticMemory(feature: MemoryFeature, media: MediaRow[], trusted: boolean): ManifestMemory {
  const assets = media
    .filter((m) => m.content_type.startsWith(PHOTO_CONTENT_TYPE_PREFIX) || m.content_type.startsWith(VIDEO_CONTENT_TYPE_PREFIX))
    .map((m) => buildSyntheticAsset(m, trusted));
  const hasVideo = assets.some((a) => a.kind === 'video-poster');
  return {
    date: feature.date,
    type: feature.hasText ? 'text_illustration' : hasVideo ? 'video' : assets.length > 0 ? 'photo' : 'text',
    text: feature.hasText ? 'x'.repeat(feature.textLength) : null,
    emotion: feature.emotion,
    topics: feature.topics,
    milestones: feature.milestones.map((m) => ({ id: m.milestoneId, name: m.name, detail: '' })),
    engagement: feature.engagementCount,
    taggedMembers: feature.taggedMembers.map((m) => ({ name: m.firstName, isChild: m.personType === 'child' })),
    assets,
    // A text memory always gets an illustration in production; aspect 1.0
    // is the task's own outline-time simplification -- outline time never
    // knows the real generated illustration's pixel dimensions.
    illustration: feature.hasText
      ? { file: `synthetic/${feature.id}-illo.webp`, width: 1000, height: 1000, aspectRatio: 1 }
      : null,
  };
}

function emptySyntheticManifest(
  memories: Record<string, ManifestMemory>,
  child: { id: string; name: string; dateOfBirth: string | null },
  portraits: ManifestPortrait[] = [],
): BookManifest {
  return {
    child: { id: child.id, name: child.name, dateOfBirth: child.dateOfBirth },
    scope: { kind: 'oracle', label: 'Oracle estimate', start: '1970-01-01', end: '2999-12-31' },
    generatedAt: new Date(0).toISOString(),
    outlineRun: 'oracle',
    memories,
    portraits,
  };
}

/** A `family_member_portrait_versions` row -> a synthetic `ManifestPortrait` (round-13 oracle) -- only `manifest.portraits.length` and rough chunking matter for page yield (see `buildThroughTheYearsPage`'s `partitionPortraits`), so the file/label are placeholders. */
export function buildSyntheticPortrait(referenceDate: string): ManifestPortrait {
  return { file: 'synthetic/portrait.jpg', date: referenceDate, ageLabel: '' };
}

/**
 * Builds a synthetic `BookManifest` covering every id in `features`
 * (round-13 oracle) -- called ONCE per run and reused across every oracle
 * call below, since the manifest itself never changes across thinning
 * iterations, only which outline elements reference it. `trustedWideIds`
 * (the union of the outline's own `panoramaCandidates`/`heroCandidates`)
 * get trusted pixel dims; everything else fails closed.
 */
export function buildSyntheticManifest(
  features: ReadonlyMap<string, MemoryFeature>,
  mediaByMemory: ReadonlyMap<string, MediaRow[]>,
  child: { id: string; name: string; dateOfBirth: string | null },
  trustedWideIds: ReadonlySet<string>,
  portraits: ManifestPortrait[] = [],
): BookManifest {
  const memories: Record<string, ManifestMemory> = {};
  for (const [id, feature] of features) {
    memories[id] = buildSyntheticMemory(feature, mediaByMemory.get(id) ?? [], trustedWideIds.has(id));
  }
  return emptySyntheticManifest(memories, child, portraits);
}

/**
 * One outline element reduced to exactly what `fitBook` needs to estimate
 * its page cost (round-13 oracle): usually a backbone segment, a kept
 * themed spread, or Firsts, but the FINAL holistic pageEstimate call also
 * includes the fixed cover/title/through-the-years/closing kinds (empty
 * `memoryIds` -- their content comes from `manifest`/`outline` directly,
 * not from a memory list).
 */
export interface OracleElementInput {
  id: string;
  kind: OutlineElementKind;
  memoryIds: string[];
  titleMode?: TitleMode;
  titleSourceMemoryId?: string | null;
  spreadType?: SpreadType;
  highlights?: string[];
}

/**
 * Wraps a set of already-decided elements into a full synthetic
 * `BookOutline` the fitter can run (round-13 oracle) -- fixed cover/title/
 * through-the-years/closing elements are OMITTED on purpose: this is an
 * ISOLATED cost estimate for just `elements`' own content, and `fitBook`
 * tolerates a partial element list (an absent kind simply contributes 0
 * pages, see `runFit`'s `default: continue` branch).
 */
export function buildSyntheticOutline(
  elements: OracleElementInput[],
  panoramaCandidates: string[] = [],
  heroCandidates: string[] = [],
): BookOutline {
  return {
    runId: 'oracle',
    child: { id: 'oracle-child', name: 'Oracle' },
    scope: { type: 'oracle' },
    window: { start: '1970-01-01', endExclusive: '2999-12-31', label: 'Oracle' },
    pageEstimate: 0,
    pageBudget: 0,
    counts: {},
    elements: elements.map((el) => ({
      id: el.id,
      kind: el.kind,
      title: el.id,
      memoryIds: el.memoryIds,
      rationale: {},
      spreadType: el.spreadType,
      titleMode: el.titleMode,
      titleSourceMemoryId: el.titleSourceMemoryId ?? null,
      highlights: el.highlights ?? [],
    })),
    editorialNote: '',
    integrity: {
      violations: [],
      reassignments: [],
      dissolvedSpreadIds: [],
      dissolvedBirthdayAges: [],
      movedToBackbone: [],
      droppedElements: [],
      excludedMemoryIds: [],
    },
    heroCandidates,
    panoramaCandidates,
  };
}

/**
 * An oracle call wants the NATURAL (unconstrained) page yield of exactly
 * the given elements by default -- never the fitter's OWN cap-pressure
 * demotion silently masking the count, which is a separate, later concern.
 * Callers that specifically want the printer-honest, post-demotion count
 * (the final published `pageEstimate`) pass the real page cap instead.
 */
const ORACLE_UNCAPPED_MAX_PAGES = 100_000;

/**
 * Runs the real fitter over a synthetic outline+manifest and returns its
 * total page count (round-13 oracle) -- the function every BINDING
 * pageEstimate/thinning call site in `main()` routes through. `maxPages`
 * defaults to effectively uncapped (see `ORACLE_UNCAPPED_MAX_PAGES`); pass
 * the real page cap to instead read the post-demotion, printer-honest count.
 */
export function estimatePagesViaFitter(
  elements: OracleElementInput[],
  manifest: BookManifest,
  panoramaCandidates: string[] = [],
  heroCandidates: string[] = [],
  maxPages: number = ORACLE_UNCAPPED_MAX_PAGES,
): number {
  if (elements.every((el) => el.memoryIds.length === 0)) return 0;
  const outline = buildSyntheticOutline(elements, panoramaCandidates, heroCandidates);
  const { capacity } = fitBook(outline, manifest, { maxPages });
  return capacity.totalPages;
}

// ── Themed-spread and backbone selection (round-14: no more thinning) ────
//
// `planNonBackboneBudget`/`selectBackboneMemories` used to iteratively drop
// the lowest-page-cost themed spread / lowest-scored backbone memory until
// an estimate fit a page budget (round-3 through round-13, several
// generations of increasingly accurate but still ultimately WRONG-BY-
// CONSTRUCTION price models -- see the "Page accounting" section comment
// above). Round-14 owner decision removes that cutting entirely: both
// functions now simply return everyone they were given. They are kept
// (rather than deleted outright) as the stable, discoverable answer to
// "does the outline still limit themed spreads/backbone memories by page
// cost" -- unconditionally no, not even a little, for either. All
// budget-only fields/parameters (`shapes`, `pageCap`, `pageBudget`,
// `pinnedIds`, `estimate`, `score`) are removed as vestigial; nothing in
// these two functions ever needed them for anything BUT the cutting that
// no longer happens.

export interface ThemedBudgetElement {
  id: string;
  memoryCount: number;
}

export interface NonBackboneBudgetPlan {
  keptThemedIds: string[];
  /** Always `[]` -- round-14: nothing is ever dropped here anymore. Kept
   * in the return shape (rather than removed) so a caller checking "were
   * any candidate spreads dropped for budget" gets an honest, typed "no"
   * instead of the field vanishing out from under it. */
  droppedThemedIds: string[];
}

/** Keeps every themed spread candidate with at least one member -- see the section comment above. */
export function planNonBackboneBudget(themedSpreads: ThemedBudgetElement[]): NonBackboneBudgetPlan {
  return {
    keptThemedIds: themedSpreads.filter((t) => t.memoryCount > 0).map((t) => t.id),
    droppedThemedIds: [],
  };
}

export interface BackboneCandidate {
  id: string;
}

/** Keeps every backbone candidate it's given -- see the section comment above. */
export function selectBackboneMemories(candidates: BackboneCandidate[]): string[] {
  return candidates.map((c) => c.id);
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
 * Round-15 owner-approved spacing rule (mirrors the digest non-adjacency
 * rule): in the reading order, no two THEMED spreads may ever be adjacent,
 * and at most ONE themed spread may occupy the run between any two
 * consecutive backbone elements -- i.e. at most one per "gap", where a gap
 * is `insertAfterFinalSegmentIndex` (`-1` = before the first backbone
 * segment, `0..lastValidIndex-1` = between two segments, `lastValidIndex` =
 * after the last). `buildReadingOrder` pushes every spread sharing a gap
 * back-to-back with nothing else between them (see `themedByIndex`), so
 * ">1 occupant at a gap" IS exactly the adjacency violation -- both halves
 * of the owner's rule collapse into this one invariant.
 *
 * Context: this was previously satisfied only as a side effect of page-
 * budget scarcity (rounds 3-13 thinned most candidate spreads away before
 * they could ever collide); round-14 removed that thinning, so Enzo's 11
 * surviving spreads -- most anchored to the same jul-oct text-heavy window
 * -- started stacking 4-in-a-row with no backbone between them.
 *
 * Resolution: every spread wants its own anchor gap
 * (`insertAfterFinalSegmentIndex`, already remapped + paced by
 * `remapInsertIndex`/`paceThemedSpreads` upstream -- this function runs
 * LAST, after both). Spreads are processed in a deterministic PRIORITY
 * order -- highest priority claims its anchor gap first. This outline has
 * no independent per-spread ranking signal to reuse (checked: `Candidate`/
 * `ThemedCandidate`/`PeoplePairCandidate`/`EmotionCandidate` and
 * `ReadingOrderThemedSpreadInput` carry only `memoryIds`, nothing else
 * survives this far), so priority is member count DESC, then candidateId
 * ASC for full determinism. Because higher-priority spreads claim first, an
 * oversubscribed anchor is always WON by its highest-priority claimant;
 * every other claimant on that anchor is the "overflow" that SPILLS to the
 * nearest still-free gap in the full valid range -- smaller
 * `|gap - ownAnchor|` wins (ascending search order makes an exact tie
 * resolve to the earlier/lower gap automatically, satisfying "tie -> earlier
 * gap" without a separate branch). A time-anchored spread's own anchor
 * computation is untouched by this function -- it can still spill when
 * oversubscribed, which is exactly how the owner decision keeps a
 * time-anchored exemption "satisfied" even when it cannot sit exactly on
 * its own month: nearest available gap, not its literal anchor.
 *
 * If spreads ever outnumber available gaps (`lastValidIndex + 2` slots --
 * pathological; not observed on either real book), the excess keeps its
 * own anchor rather than crashing or losing a spread -- spacing is
 * best-effort under true exhaustion, never a hard failure.
 */
export function enforceThemedSpreadSpacing(
  spreads: Array<{ id: string; memberCount: number; anchorGap: number }>,
  lastValidIndex: number,
): Map<string, number> {
  const minGap = -1;
  const totalGaps = lastValidIndex - minGap + 1;

  const ordered = [...spreads].sort((a, b) => b.memberCount - a.memberCount || a.id.localeCompare(b.id));

  const taken = new Set<number>();
  const assignment = new Map<string, number>();

  for (const spread of ordered) {
    const anchor = Math.min(Math.max(spread.anchorGap, minGap), lastValidIndex);
    if (!taken.has(anchor)) {
      taken.add(anchor);
      assignment.set(spread.id, anchor);
      continue;
    }
    if (taken.size >= totalGaps) {
      // Pathological exhaustion -- nothing free anywhere in the whole
      // valid range; keep the anchor (spacing not achievable, but a spread
      // is never dropped or crashed on).
      assignment.set(spread.id, anchor);
      continue;
    }
    let best = anchor;
    let bestDist = Infinity;
    for (let gap = minGap; gap <= lastValidIndex; gap++) {
      if (taken.has(gap)) continue;
      const dist = Math.abs(gap - anchor);
      if (dist < bestDist) {
        best = gap;
        bestDist = dist;
      }
    }
    taken.add(best);
    assignment.set(spread.id, best);
  }

  return assignment;
}

// ── Themed-spread admission: seasonal bound + spread budget + dissolve
// (round-16 owner-approved rules, following the round-15 regeneration:
// round-15's UNBOUNDED spacing rule technically satisfied "no two adjacent",
// but at a taste cost the owner rejected -- 12 spreads saturated every
// month boundary, and one spilled a jul-oct-dated spread between Oct-Nov
// 2024 and Dec 2024, wildly out of season in a chronological book) ────────

/** Owner-tunable: a themed spread may spill at most this many gaps away
 * from its own seasonal anchor gap before it is considered unplaceable
 * (round-16 rule (a)). Small enough that a spill still reads as "nearby",
 * unlike round-15's unbounded search. */
export const SPREAD_SPILL_BOUND = 2;

/** Owner-tunable, same shape as the renderer's own full-bleed pacing rule
 * (`FULL_BLEED_BUDGET_PER_PAGES` in book-renderer's fitter.ts: roughly
 * 1 per N pages) -- round-16 rule (b): at most `floor(min(preCapPageEstimate,
 * pageCap) / SPREAD_BUDGET_PAGES_PER_SPREAD)` themed spreads survive per
 * book. For a full 122-page book that's `floor(122/15) = 8`. */
export const SPREAD_BUDGET_PAGES_PER_SPREAD = 15;

/**
 * Round-16 rule (b)'s budget formula: `min(preCapPageEstimate, pageCap)`
 * caps the input at the printer's hard limit first (a book that would
 * naturally run longer than the cap doesn't earn extra spreads for pages
 * it will never print), THEN divides by the per-spread page cost.
 */
export function computeThemedSpreadBudget(preCapPageEstimate: number, pageCap: number): number {
  return Math.floor(Math.max(0, Math.min(preCapPageEstimate, pageCap)) / SPREAD_BUDGET_PAGES_PER_SPREAD);
}

export interface ThemedSpreadAdmissionCandidate {
  id: string;
  memberCount: number;
  /** The spread's own seasonal anchor gap (already remapped + paced --
   * same input `enforceThemedSpreadSpacing` takes). */
  anchorGap: number;
}

export interface ThemedSpreadAdmissionResult {
  /** Survivors and the gap each was placed at -- spacing (round-15) AND
   * the spill bound (round-16 rule (a)) both already satisfied. */
  placedGapById: Map<string, number>;
  /** Ids that DISSOLVE (round-16 rule (c)): either cut for budget, or
   * budget-admitted but unplaceable within the spill bound of their own
   * anchor. Sorted for determinism. Never "dropped" -- see
   * `reassignDissolvedSpreadMembers`, which is how a dissolved spread's
   * members return to their chronological backbone home. */
  dissolvedIds: string[];
}

/**
 * Admits themed spreads within a page BUDGET, then places the survivors
 * within a bounded SEASONAL SPILL distance of their own anchor -- anything
 * that loses either contest dissolves rather than drops (round-16 rules
 * (a)+(b)+(c)).
 *
 * Priority for both the budget cut AND who wins a contested gap is the
 * SAME signal round-15 already established (documented there: this outline
 * has no independent per-spread ranking signal, so member count DESC, then
 * id ASC, is the deterministic stand-in) -- the budget keeps the highest-
 * priority `budget` spreads outright; among THOSE survivors, spacing runs
 * exactly like `enforceThemedSpreadSpacing`, except the spill search is
 * bounded to `[anchor - maxSpillDistance, anchor + maxSpillDistance]`
 * (clamped to the valid range) instead of the whole book -- a spread with
 * no free gap in that window dissolves instead of spilling further, which
 * is precisely the fix for round-15's "travel" spread (dated jul-oct 2025)
 * landing next to Oct-Nov 2024/Dec 2024, months away from its own season.
 */
export function admitThemedSpreads(
  spreads: ThemedSpreadAdmissionCandidate[],
  lastValidIndex: number,
  budget: number,
  maxSpillDistance: number = SPREAD_SPILL_BOUND,
): ThemedSpreadAdmissionResult {
  const minGap = -1;
  const ordered = [...spreads].sort((a, b) => b.memberCount - a.memberCount || a.id.localeCompare(b.id));

  const withinBudget = ordered.slice(0, Math.max(0, budget));
  const dissolvedIds: string[] = ordered.slice(Math.max(0, budget)).map((s) => s.id);

  const taken = new Set<number>();
  const placedGapById = new Map<string, number>();

  for (const spread of withinBudget) {
    const anchor = Math.min(Math.max(spread.anchorGap, minGap), lastValidIndex);
    if (!taken.has(anchor)) {
      taken.add(anchor);
      placedGapById.set(spread.id, anchor);
      continue;
    }
    let best: number | null = null;
    let bestDist = Infinity;
    const searchStart = Math.max(minGap, anchor - maxSpillDistance);
    const searchEnd = Math.min(lastValidIndex, anchor + maxSpillDistance);
    for (let gap = searchStart; gap <= searchEnd; gap++) {
      if (taken.has(gap)) continue;
      const dist = Math.abs(gap - anchor);
      if (dist < bestDist) {
        best = gap;
        bestDist = dist;
      }
    }
    if (best === null) {
      dissolvedIds.push(spread.id); // unplaceable within the spill bound -- dissolves, never dropped.
      continue;
    }
    taken.add(best);
    placedGapById.set(spread.id, best);
  }

  return { placedGapById, dissolvedIds: dissolvedIds.sort() };
}

/**
 * Round-16 rule (c), "dissolve, never drop": reverses a themed-spread
 * placement for every dissolved spread's members -- each memory returns to
 * its OWN natural chronological backbone home, exactly as if it had never
 * been grouped into a spread at all. This is the SAME reassignment concept
 * the pre-round-14 budget-thinning code used for a dropped candidate spread
 * (`finalPlacement.set(memoryId, backboneId)`), reapplied here for the new
 * dissolve trigger. A memory whose id has no entry in `defaultBackboneByMemory`
 * (shouldn't happen -- every eligible memory has a backbone home) is left
 * at its current placement rather than silently vanishing.
 *
 * ZERO memories are ever lost by this function: it only ever changes WHERE
 * an already-placed memory id points, never removes an entry -- the union
 * of `placementByMemory`'s keys is identical before and after.
 */
export function reassignDissolvedSpreadMembers(
  placementByMemory: ReadonlyMap<string, string>,
  dissolvedSpreadMemberIds: ReadonlyMap<string, readonly string[]>,
  defaultBackboneByMemory: ReadonlyMap<string, string>,
): Map<string, string> {
  const result = new Map(placementByMemory);
  for (const memoryIds of dissolvedSpreadMemberIds.values()) {
    for (const memoryId of memoryIds) {
      const backboneId = defaultBackboneByMemory.get(memoryId);
      if (backboneId) result.set(memoryId, backboneId);
    }
  }
  return result;
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

  // Round-15: enforce the spacing invariant LAST, after remap + pacing have
  // already produced their own `insertAfterFinalSegmentIndex` -- see
  // `enforceThemedSpreadSpacing`'s doc comment.
  const spacedGapByCandidateId = enforceThemedSpreadSpacing(
    input.themedSpreads.map((s) => ({ id: s.candidateId, memberCount: s.memoryIds.length, anchorGap: s.insertAfterFinalSegmentIndex })),
    lastValidIndex,
  );

  const themedByIndex = new Map<number, ReadingOrderThemedSpreadInput[]>();
  for (const spread of input.themedSpreads) {
    const gap = spacedGapByCandidateId.get(spread.candidateId) ?? -1;
    const list = themedByIndex.get(gap) ?? [];
    list.push(spread);
    themedByIndex.set(gap, list);
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

// SpecialSegmentFlagKind/SpecialSegmentFlag moved to
// ../functions/_shared/memory-book-outline.ts (needed by
// OutlineSkeletonSummaryInput's own signature).

/**
 * Flags every MONTH that is either the child's birth month (`kind: 'birth'`,
 * takes priority over a birthday flag at that SAME month) or a flagged
 * birthday month (`kind: 'birthday'`), keyed to whichever segment currently
 * contains that month. Round-18 fix (owner-decided, "books are standalone"):
 * this checks every month in a segment independently and never stops after
 * the first hit, so a segment that happens to contain TWO distinct flagged
 * months (a real case: a sparse year merges the opening and closing-run-up
 * months into one backbone segment) gets BOTH flags, each keyed to its own
 * month -- the old `break`-after-first-birthday-month and the old
 * whole-segment `continue` on a birth-month hit silently dropped the second
 * flag in exactly that case. Two flags can share a `segmentId` but never a
 * `month` (a month cannot be both). Pure and independent of budget/pacing so
 * it can run identically on the original (prompt-time) and final
 * (render-time) segment lists.
 */
export function flagSpecialBackboneSegments(
  segments: BackboneSegment[],
  birthMonth: string | null,
  birthdayMonthToAge: Map<string, number>,
): SpecialSegmentFlag[] {
  const flags: SpecialSegmentFlag[] = [];
  for (const segment of segments) {
    for (const month of segment.monthKeys) {
      if (birthMonth && month === birthMonth) {
        flags.push({ segmentId: segment.id, month, kind: 'birth' });
        continue;
      }
      const ageTurned = birthdayMonthToAge.get(month);
      if (ageTurned !== undefined) {
        flags.push({ segmentId: segment.id, month, kind: 'birthday', ageTurned });
      }
    }
  }
  return flags;
}

/**
 * Owner decision (round-18, "books are standalone"): for an AGE-YEAR scope
 * ONLY, `birthdayMonthToAge` above must be built DETERMINISTICALLY from the
 * child's `date_of_birth` + the scope window -- never from whether a
 * birthday-milestone-tagged memory happens to exist in the account. This
 * replaces the data-dependent mechanism entirely for age-year scope (an
 * age-year window's only two "birthday-shaped" months are its own opening
 * and closing-run-up months by construction -- there is no interior case to
 * also preserve).
 *
 * Root cause this fixes: the OLD `birthdayMonthToAge` was built purely from
 * REAL `memory_milestones` rows with `milestone_id === 'birthday'` that
 * happened to fall inside the window's own loaded memories. Two related
 * bugs followed from that:
 * (1) The CLOSING run-up month's birthday memory is, by construction, dated
 *     ON the window's `endExclusive` boundary -- `loadMemoriesInWindow`
 *     filters `memory_date < endExclusive`, so that memory can never even
 *     be loaded into `features`, so its month can never appear in
 *     `birthdayMonthToAge`, so the closing month can NEVER be flagged no
 *     matter what data exists. This is why Enzo's year-two book got no
 *     "the month you turned two" title at all.
 * (2) The OPENING month's flag depended on a real birthday-milestone memory
 *     actually landing in that exact month -- if the parent never logged
 *     one there (or logged it a few days into the next month), the flag
 *     silently never fired, even though the child's age-turned for that
 *     month is fully determined by `date_of_birth` alone and needs no
 *     memory to be true.
 *
 * Fix: read the ages straight off the window itself. `window.start` IS the
 * opening month's first day (birthday N-1, this book's own scope start) and
 * `window.endExclusive` IS the closing-run-up month's birthday day (age N,
 * even though that exact day is excluded from the window's own memories --
 * its MONTH still gets the special title). Age 0 (ageYear - 1 === 0, i.e.
 * Year One's "opening" is literally the birth month itself) is omitted --
 * the birth flag already covers that month and takes priority, and "the
 * month you turned zero" is not a real birthday.
 */
export function computeAgeYearBirthdayMonths(scope: BookScope, window: ScopeWindow): Map<string, number> {
  const map = new Map<string, number>();
  if (scope.type !== 'age-year') return map;
  if (scope.ageYear - 1 >= 1) {
    map.set(window.start.slice(0, 7), scope.ageYear - 1);
  }
  map.set(window.endExclusive.slice(0, 7), scope.ageYear);
  return map;
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

// buildOutlineSystemPrompt/OutlineSkeletonSummaryInput/buildOutlineUserPrompt
// moved to ../functions/_shared/memory-book-outline.ts (V5a "part B").

// ── AI call ───────────────────────────────────────────────────────────────

// OpenAiUsage moved to ../functions/_shared/memory-book-outline.ts.

interface OpenAiChatResult {
  content: string;
  usage: OpenAiUsage | null;
}

const RETRY_BACKOFF_MS = 1500;

// buildOutlineRequestBody moved to ../functions/_shared/memory-book-outline.ts.

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

// ParsedSpreadSelection/ParsedBackboneHighlight/ParsedOutlineResponse/
// ParsedFirstsWarmName/OutlineIntegrityViolation/parseOutlineResponse
// (incl. its private candidateKindFromId/parseCappedIdList/previewJson
// helpers), and the quote-title verification pieces
// (normalizeForQuoteCheck/isQuoteSupportedByContent/QuoteTitleCheckInput/
// verifyQuoteTitles) all moved to
// ../functions/_shared/memory-book-outline.ts.

// CoverVerifyReasonCode/CoverVerifyVerdict/buildCoverVerifySystemPrompt/
// buildCoverVerifyUserText/CoverVerifyImageInput/buildCoverVerifyRequestBody
// moved to ../functions/_shared/memory-book-outline.ts. callOpenAiCoverVerify
// below (the actual fetch call) stays here -- IO plumbing, not pure.

async function callOpenAiCoverVerify(
  systemPrompt: string,
  userText: string,
  images: CoverVerifyImageInput[],
  model: string,
  apiKey: string,
): Promise<OpenAiChatResult> {
  const body = JSON.stringify(buildCoverVerifyRequestBody(systemPrompt, userText, images, model));

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

// parseCoverVerifyResponse/applyCoverVerifyVerdicts moved to
// ../functions/_shared/memory-book-outline.ts.

async function bytesToBase64(bytes: Uint8Array): Promise<string> {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function contentTypeFromObjectKey(objectKey: string): 'image/jpeg' | 'image/png' | 'image/webp' {
  if (objectKey.endsWith('.png')) return 'image/png';
  if (objectKey.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

export interface CoverVerifyResult {
  /** `coverCandidates` after dropping any disqualified id, best-first order
   * preserved. */
  coverCandidates: string[];
  violations: OutlineIntegrityViolation[];
  usage: OpenAiUsage | null;
}

/**
 * Runs the cover-candidate verify pass (see the section comment above):
 * fetches each candidate's real preview thumbnail, sends them to a
 * dedicated vision judge against ONLY the disqualification checklist, and
 * drops whichever the judge disqualifies -- preserving the model's original
 * best-first order. Every failure mode this function can hit -- a candidate
 * with no fetchable thumbnail, a network/HTTP failure, an unparseable
 * response -- FAILS OPEN (keeps every candidate it could not judge) rather
 * than dropping anything on uncertainty: the renderer's own fallback cover
 * selection is the safe path, so a failed verify pass should never turn
 * into a hard stop for the whole outline run.
 */
export async function verifyCoverCandidates(
  candidateIds: string[],
  features: Map<string, MemoryFeature>,
  model: string,
  apiKey: string,
  thumbsDir: URL,
): Promise<CoverVerifyResult> {
  const violations: OutlineIntegrityViolation[] = [];
  if (candidateIds.length === 0) {
    return { coverCandidates: candidateIds, violations, usage: null };
  }

  const previewKeyById = new Map<string, string>();
  for (const id of candidateIds) {
    const previewKey = features.get(id)?.previewKey;
    if (previewKey) previewKeyById.set(id, previewKey);
  }

  const uniqueKeys = [...new Set(previewKeyById.values())];
  const bytesByKey: Map<string, ObjectBytesBatchEntry> =
    uniqueKeys.length > 0 ? await getObjectBytesBatch(uniqueKeys) : new Map();

  await Deno.mkdir(thumbsDir, { recursive: true });

  const images: CoverVerifyImageInput[] = [];
  const indexToId = new Map<number, string>();
  for (const id of candidateIds) {
    const previewKey = previewKeyById.get(id);
    const entry = previewKey ? bytesByKey.get(previewKey) : undefined;
    if (!previewKey || !entry || !entry.ok || !entry.bytes) {
      violations.push({ kind: 'cover_verify_thumb_unavailable', detail: id });
      continue;
    }
    const contentType = contentTypeFromObjectKey(previewKey);
    const ext = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
    try {
      await Deno.writeFile(new URL(`${id}.${ext}`, thumbsDir), entry.bytes);
    } catch {
      // Best-effort review artifact only -- never blocks the judgment call.
    }
    const index = images.length;
    indexToId.set(index, id);
    images.push({ index, base64: await bytesToBase64(entry.bytes), contentType });
  }

  if (images.length === 0) {
    violations.push({
      kind: 'cover_verify_unparseable',
      detail: `0 of ${candidateIds.length} candidate(s) had a fetchable thumbnail; kept all`,
    });
    return { coverCandidates: candidateIds, violations, usage: null };
  }

  const systemPrompt = buildCoverVerifySystemPrompt();
  const userText = buildCoverVerifyUserText(images.length);

  let content: string;
  let usage: OpenAiUsage | null;
  try {
    ({ content, usage } = await callOpenAiCoverVerify(systemPrompt, userText, images, model, apiKey));
  } catch (error) {
    violations.push({
      kind: 'cover_verify_unparseable',
      detail: `verify call failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return { coverCandidates: candidateIds, violations, usage: null };
  }

  let rawParsed: unknown;
  try {
    rawParsed = JSON.parse(content);
  } catch {
    const applied = applyCoverVerifyVerdicts(candidateIds, indexToId, null);
    violations.push(...applied.violations);
    return { coverCandidates: applied.coverCandidates, violations, usage };
  }

  const verdicts = parseCoverVerifyResponse(rawParsed, images.length);
  const applied = applyCoverVerifyVerdicts(candidateIds, indexToId, verdicts);
  violations.push(...applied.violations);
  return { coverCandidates: applied.coverCandidates, violations, usage };
}

// sumOpenAiUsage moved to ../functions/_shared/memory-book-outline.ts.

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
      allMembers.push({ id: m.id, familyId: m.family_id, name: m.name, dateOfBirth: m.date_of_birth, nicknames: m.nicknames ?? [] });
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
    allMembers.map((m) => [m.id, { id: m.id, name: m.name, dateOfBirth: m.dateOfBirth, nicknames: m.nicknames }]),
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
  // Round-18 fix (owner-decided, "books are standalone"): an AGE-YEAR scope
  // gets its opening/closing-run-up birthday months DETERMINISTICALLY from
  // the window itself (`computeAgeYearBirthdayMonths`), never from whether
  // a birthday-milestone memory happens to exist in the account -- see that
  // function's doc comment for the two bugs this replaces. Calendar-year
  // and custom-range scopes are unchanged: their birthday flag(s), if any,
  // still come from real `birthday`-milestone memories inside the window
  // (an "interior" birthday has no deterministic window-boundary analogue).
  const birthdayMonthToAge = scope.type === 'age-year'
    ? computeAgeYearBirthdayMonths(scope, window)
    : (() => {
        const map = new Map<string, number>();
        for (const [ageTurned, ids] of birthdayGroups) {
          for (const id of ids) {
            const month = features.get(id)!.date.slice(0, 7);
            if (!map.has(month)) map.set(month, ageTurned);
          }
        }
        return map;
      })();
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

  // ── LANGUAGE resolution inputs (round-18) ──────────────────────────────
  // Owner chain step (2): the family's configured caption locale, already
  // loaded alongside every family visible to this account -- no extra
  // round trip. Read defensively (blank/whitespace treated as unset) even
  // though the column is NOT NULL with a default in the schema.
  const familyRow = families.find((f) => f.id === child.familyId);
  const configuredLanguage = familyRow?.gallery_caption_language?.trim() || null;

  // Owner chain step (1) evidence: the model judges language from the
  // window's own MEMORIES excerpts when there are enough of them; below
  // WINDOW_CAPTION_SPARSE_THRESHOLD (the caption-less-era case this fixes),
  // also fetch a recent account-wide sample as LANGUAGE EVIDENCE ONLY.
  const windowCaptionCount = [...features.values()].filter((f) => f.hasText).length;
  const languageEvidenceCaptions = windowCaptionCount < WINDOW_CAPTION_SPARSE_THRESHOLD
    ? await loadAccountWideCaptionSample(supabase, child.familyId, LANGUAGE_EVIDENCE_SAMPLE_LIMIT)
    : [];
  console.log(
    `Language evidence: ${windowCaptionCount} in-window caption(s)${
      languageEvidenceCaptions.length > 0
        ? ` (sparse -- below ${WINDOW_CAPTION_SPARSE_THRESHOLD}; loaded ${languageEvidenceCaptions.length} account-wide sample caption(s) as evidence)`
        : ''
    }, configured language: ${configuredLanguage ?? '(not set)'}.`,
  );

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
      configuredLanguage,
      languageEvidenceCaptions,
    },
    candidates,
    features,
  );

  const { content, usage: outlineUsage } = await callOpenAiOutline(systemPrompt, userPrompt, options.model, apiKey!);
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
    configuredLanguage,
  );
  console.log(`Resolved language: ${response.language}.`);

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

  // ── Cover-candidate verification pass (owner decision, 2026-09-01) ─────
  // `response.coverCandidates` above was nominated BLIND by the same
  // text-only call -- this is the first point in the pipeline that shows a
  // dedicated judge the real thumbnails against ONLY the disqualification
  // checklist. See `verifyCoverCandidates`'s doc comment for the two real
  // books whose text-only nominations violated their own stated rules.
  let coverVerifyUsage: OpenAiUsage | null = null;
  if (response.coverCandidates.length > 0) {
    const nominatedCount = response.coverCandidates.length;
    const verifyResult = await verifyCoverCandidates(
      response.coverCandidates,
      features,
      options.model,
      apiKey!,
      new URL('thumbs/', outputDir),
    );
    response.coverCandidates = verifyResult.coverCandidates;
    violations.push(...verifyResult.violations);
    coverVerifyUsage = verifyResult.usage;
    console.log(
      `Cover verify: ${nominatedCount} nominated candidate(s) judged; ${response.coverCandidates.length} survive (dropped ${nominatedCount - response.coverCandidates.length} -- see outline.md's Integrity notes for ids + reasons).`,
    );
  }

  const usage = sumOpenAiUsage(outlineUsage, coverVerifyUsage);
  if (usage) {
    const price = PRICE_USD_PER_MTOK[options.model];
    const costLine = price
      ? ` -- est. cost $${((usage.prompt_tokens * price.input + usage.completion_tokens * price.output) / 1_000_000).toFixed(4)} (${options.model} @ $${price.input}/$${price.output} per MTok)`
      : ` -- no price on file for model ${options.model}; update PRICE_USD_PER_MTOK for a cost line`;
    console.log(`Token usage: prompt=${usage.prompt_tokens}, completion=${usage.completion_tokens}${costLine} (outline + cover-verify combined)`);
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
  // segment already carries -- dissolve it into the backbone; the segment
  // keeps its special title. (Round-14: `dissolveThinBirthdaySpreads` still
  // returns a `pinnedMemoryIds` set, unused here now that nothing thins --
  // see its own doc comment.)
  const birthdaySpreadIdSet = new Set([...birthdayGroups.keys()].map((ageTurned) => `birthday-${ageTurned}`));
  const {
    placementByMemory: afterDissolve,
    dissolvedAges: dissolvedBirthdayAges,
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

  // ── Panorama guarantee + published pageEstimate (round-14: outline-side
  // BUDGET THINNING REMOVED ENTIRELY) ──────────────────────────────────────
  //
  // Owner decision, following an A/B test: the shape-placeholder oracle's
  // per-candidate pricing (round-13) lacked pairing/digest-row compression
  // knowledge and over-thinned real books (Enzo fell to 93 selected
  // memories, Mara to 96, vs. the ~112+ the OLD flow -- and the real
  // renderer itself -- comfortably printed at the cap). Fix: this script no
  // longer thins anything for page budget, ever. `planNonBackboneBudget`/
  // `selectBackboneMemories` above now unconditionally keep everyone they
  // are given, so `keptThemedIds` below is simply "every themed spread the
  // AI accepted" and the backbone selection is simply "every eligible
  // memory not placed into Firsts/a birthday/a themed spread". Fitting all
  // of this to the printer's page cap is the RENDERER's job alone, at
  // render time (book-renderer/src/model/fitter.ts's round-13 balanced
  // cap-pressure demotion -- month floors, milestone/quote-source
  // protections, photo/video/illustrated keep-rate balancing).

  const isVisual = (memoryId: string) => {
    const f = features.get(memoryId)!;
    return f.photoCount + f.videoCount > 0;
  };

  // Owner round-3 decision, 2026-08-27: "highlight/hero status" -- computed
  // once over the WHOLE book -- still feeds the oracle's per-element
  // `highlights` (drives full-bleed/hero-slot composition, never budget).
  const highlightedOrHeroIds = new Set([
    ...response.backboneHighlights.flatMap((h) => h.memoryIds),
    ...response.heroCandidates,
  ]);

  const candidateBudgetElements: ThemedBudgetElement[] = [...spreadCandidateIds].map((spreadId) => ({
    id: spreadId,
    memoryCount: [...afterDissolve.entries()].filter(([, s]) => s === spreadId).length,
  }));
  const nonBackbonePlan = planNonBackboneBudget(candidateBudgetElements);

  const finalPlacement = afterDissolve; // round-14: nothing is ever reassigned for budget anymore.

  const backboneCandidates: BackboneCandidate[] = [...finalPlacement.entries()]
    .filter(([, spreadId]) => spreadId.startsWith('backbone:'))
    .map(([memoryId]) => ({ id: memoryId }));
  const keptBackboneIds = new Set(selectBackboneMemories(backboneCandidates));
  const excludedMemoryIds = [...cliExcludedMemoryIds]; // round-14: budget can no longer exclude anyone.

  const finalBackboneInputs: BackboneMemoryInput[] = [...keptBackboneIds].map((id) => {
    const f = features.get(id)!;
    return { id, date: f.date, printable: f.hasText || f.photoCount + f.videoCount > 0 };
  });
  // Re-segment chronologically from scratch -- buildBackboneSegments
  // already merges/drops now-empty month segments.
  const finalBackboneSegments = buildBackboneSegments(finalBackboneInputs);

  // Round-13 "fitter-as-oracle": ONE synthetic manifest, built once and
  // reused for both oracle calls below. Every model-nominated panorama/hero
  // candidate gets trusted synthetic dimensions, same as the real export
  // pipeline trusting a nominee's measured dimensions; the fitter's own
  // internal panorama/full-bleed budget still caps how many actually get
  // placed, exactly like production.
  const oracleTrustedWideIds = new Set([...response.panoramaCandidates, ...response.heroCandidates]);
  const oraclePortraits = portraitVersions
    .filter((p) => p.reference_date)
    .map((p) => buildSyntheticPortrait(p.reference_date!));
  const oracleManifest = buildSyntheticManifest(features, mediaByMemory, child, oracleTrustedWideIds, oraclePortraits);

  const spreadMetaById = new Map(response.spreads.map((s) => [`spread:${s.candidateId}`, s]));
  const themedOracleElements: OracleElementInput[] = nonBackbonePlan.keptThemedIds.map((id) => {
    const memberIds = [...finalPlacement.entries()].filter(([, s]) => s === id).map(([mid]) => mid);
    const meta = spreadMetaById.get(id);
    return {
      id,
      kind: 'themed',
      memoryIds: memberIds,
      titleMode: meta?.titleMode,
      titleSourceMemoryId: meta?.titleSourceMemoryId,
      spreadType: meta?.candidateKind,
      highlights: memberIds.filter((mid) => highlightedOrHeroIds.has(mid)),
    };
  });
  const firstsOracleElement: OracleElementInput[] = firstsFinalPresent
    ? [{ id: 'firsts', kind: 'firsts', memoryIds: firstsFinalMemoryIds }]
    : [];
  const birthdayOracleElements: OracleElementInput[] = [...birthdayFinalMemoryIdsByAge.entries()].map(([ageTurned, ids]) => ({
    id: `birthday-${ageTurned}`,
    kind: 'themed',
    memoryIds: ids,
    highlights: ids.filter((mid) => highlightedOrHeroIds.has(mid)),
  }));
  const backboneOracleElements: OracleElementInput[] = finalBackboneSegments.map((s) => ({
    id: `backbone:${s.id}`,
    kind: 'backbone',
    memoryIds: s.memoryIds,
    highlights: s.memoryIds.filter((mid) => highlightedOrHeroIds.has(mid)),
  }));
  const fixedOracleElements: OracleElementInput[] = [
    { id: 'cover', kind: 'cover', memoryIds: [] },
    { id: 'title', kind: 'title', memoryIds: [] },
    { id: 'through-the-years', kind: 'through-the-years', memoryIds: [] },
    { id: 'closing', kind: 'closing', memoryIds: [] },
  ];
  const fullSelectionElements: OracleElementInput[] = [
    ...fixedOracleElements,
    ...themedOracleElements,
    ...firstsOracleElement,
    ...birthdayOracleElements,
    ...backboneOracleElements,
  ];

  // Round-14: ONE holistic, UNCAPPED oracle call over the FULL curated
  // selection is both (a) the panorama-guarantee sizing input and (b) the
  // published "pre-cap" pageEstimate -- may exceed the printer's hard cap;
  // that is EXPECTED and FINE now (see the section comment above). There is
  // no more preliminary-vs-final split, since nothing is thinned in
  // between anymore.
  const totalPages = estimatePagesViaFitter(
    fullSelectionElements,
    oracleManifest,
    response.panoramaCandidates,
    response.heroCandidates,
  );
  const panoramaGuaranteeCount = computePlacedPanoramaGuaranteeCount(totalPages);
  const guaranteedPanoramaIds = new Set(response.panoramaCandidates.slice(0, panoramaGuaranteeCount));

  // Round-14: a SECOND oracle call, this time AT the real page cap --
  // purely for the printed summary below (what the renderer's own round-13
  // balanced cap-pressure demotion would actually do to this exact
  // selection: post-demotion page count + which KINDS it would trim). This
  // never feeds back into selection above -- it is reporting only, and
  // reports ids/counts alone, never memory content (PII rule).
  const atCapOutline = buildSyntheticOutline(fullSelectionElements, response.panoramaCandidates, response.heroCandidates);
  const atCapResult = fitBook(atCapOutline, oracleManifest, { maxPages: options.pageCap });
  const capPageEstimate = atCapResult.capacity.totalPages;
  const omittedByKind = { photo: 0, video: 0, illustrated: 0 };
  for (const omittedId of atCapResult.capacity.omittedMemoryIds) {
    const f = features.get(omittedId);
    if (!f) continue;
    // Mirrors the real fitter's own kind classification (fitter.ts
    // `classifyMemoryKind`): text -> illustrated (every text memory gets an
    // illustration); otherwise photo/video by which asset kind is present.
    if (f.hasText) omittedByKind.illustrated += 1;
    else if (f.videoCount > 0) omittedByKind.video += 1;
    else if (f.photoCount > 0) omittedByKind.photo += 1;
  }

  const finalKeptMemoryIds = new Set<string>([
    ...finalBackboneInputs.map((b) => b.id),
    ...nonBackbonePlan.keptThemedIds.flatMap((id) => [...finalPlacement.entries()].filter(([, s]) => s === id).map(([mid]) => mid)),
    ...firstsFinalMemoryIds,
    ...[...birthdayFinalMemoryIdsByAge.values()].flat(),
  ]);
  const totalImageCount = [...finalKeptMemoryIds].filter(isVisual).length;
  const droppedElements: Array<{ id: string; kind: 'themed'; reason: string }> = []; // round-14: budget can no longer drop a whole spread.

  console.log(
    `Pre-cap page estimate (full curated selection, before the renderer's own cap-pressure demotion): ${totalPages} pages -- the outline no longer self-rations, so this may exceed the ${options.pageCap}-page cap; that is expected. ${totalImageCount} visual (photo/video-bearing) memories kept, ${finalKeptMemoryIds.size} total.`,
  );
  console.log(
    `At-cap estimate (what the renderer would actually print, via its own round-13 balanced cap-pressure demotion): ${capPageEstimate} pages, omitting ${atCapResult.capacity.omittedMemoryIds.length} memory(ies) to fit -- photo ${omittedByKind.photo}, video ${omittedByKind.video}, illustrated ${omittedByKind.illustrated} (ids/counts only; see the review artifact for per-page detail).`,
  );
  console.log(
    `Placed-panorama guarantee: ${guaranteedPanoramaIds.size} of ${response.panoramaCandidates.length} nominated (N = 1 + pageEstimate/20, from the pre-cap estimate of ${totalPages} -- reviewer context only; round-14: no longer a protective mechanism, since nothing is dropped by this script anymore).`,
  );

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

  // ── Themed-spread admission: seasonal bound + spread budget + dissolve
  // (round-16 owner-approved rules -- see `admitThemedSpreads`'s doc
  // comment). Runs AFTER pacing (pacing's `idealGapIndex` becomes each
  // spread's admission "anchor") and BEFORE the reading order is assembled.
  // `totalPages` above is deliberately the PRE-admission estimate (every
  // themed candidate still included) -- that IS `preCapPageEstimate`, the
  // budget's own input; admission narrows the SELECTION, it doesn't change
  // what "the full curated book" was estimated at. ───────────────────────

  const admissionCandidates: ThemedSpreadAdmissionCandidate[] = nonBackbonePlan.keptThemedIds.map((spreadId) => ({
    id: spreadId,
    memberCount: [...finalPlacement.entries()].filter(([, sid]) => sid === spreadId).length,
    anchorGap: pacedAssignment.get(spreadId) ?? -1,
  }));
  const themedSpreadBudget = computeThemedSpreadBudget(totalPages, options.pageCap);
  const { placedGapById: survivingSpreadGapById, dissolvedIds: budgetDissolvedSpreadIds } = admitThemedSpreads(
    admissionCandidates,
    finalBackboneSegments.length - 1,
    themedSpreadBudget,
  );

  // Round-16 rule (c), "dissolve, never drop": every dissolved spread's
  // members return to their OWN natural chronological backbone home --
  // exactly the reassignment the pre-round-14 budget-thinning code used
  // for a dropped candidate spread, reapplied here for the new trigger.
  const dissolvedSpreadMemberIds = new Map<string, string[]>(
    budgetDissolvedSpreadIds.map((spreadId) => [
      spreadId,
      [...finalPlacement.entries()].filter(([, sid]) => sid === spreadId).map(([id]) => id),
    ]),
  );
  const readingOrderPlacement = reassignDissolvedSpreadMembers(finalPlacement, dissolvedSpreadMemberIds, defaultBackboneCandidateByMemory);

  // The backbone must be REBUILT from the updated placement -- a dissolved
  // spread's members are now backbone-eligible where they weren't before,
  // and re-running `buildBackboneSegments` from scratch (rather than
  // patching the existing segments) is what makes this "as if never
  // grouped": identical to how the memory would have segmented if it had
  // never been offered to a themed spread at all.
  const readingOrderBackboneIds = [...readingOrderPlacement.entries()]
    .filter(([, spreadId]) => spreadId.startsWith('backbone:'))
    .map(([memoryId]) => memoryId);
  const readingOrderBackboneInputs: BackboneMemoryInput[] = readingOrderBackboneIds.map((id) => {
    const f = features.get(id)!;
    return { id, date: f.date, printable: f.hasText || f.photoCount + f.videoCount > 0 };
  });
  const readingOrderBackboneSegments = buildBackboneSegments(readingOrderBackboneInputs);

  const survivingThemedSpreadIds = nonBackbonePlan.keptThemedIds.filter((id) => !budgetDissolvedSpreadIds.includes(id));

  // ── Assemble the reading order (single source of truth for both renderers) ─

  const backboneRationale: Record<string, string> = {};
  for (const highlight of response.backboneHighlights) {
    for (const id of highlight.memoryIds) {
      if (highlight.rationale[id]) backboneRationale[id] = highlight.rationale[id];
    }
  }

  const readingOrderThemedSpreads: ReadingOrderThemedSpreadInput[] = response.spreads
    .filter((s) => survivingThemedSpreadIds.includes(`spread:${s.candidateId}`))
    .map((s) => {
      const spreadId = `spread:${s.candidateId}`;
      const memoryIds = [...readingOrderPlacement.entries()].filter(([, sid]) => sid === spreadId).map(([id]) => id);
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
        insertAfterFinalSegmentIndex: survivingSpreadGapById.get(spreadId) ?? -1,
        rationale,
        kicker: s.kicker,
      };
    });

  // Bridge the AI's segment_titles (keyed by ORIGINAL segment id) onto the
  // FINAL (post-budget, post-dissolve, re-segmented) segment list via the
  // flagged month -- segment ids/boundaries can change across
  // re-segmentation, but the calendar month that triggered a flag cannot.
  const specialTitleByMonth = buildSpecialSegmentTitlesByMonth(originalSpecialFlags, response.segmentTitles);
  const finalSpecialFlags = flagSpecialBackboneSegments(readingOrderBackboneSegments, birthMonth, birthdayMonthToAge);
  const applicableSpecialFlags = suppressSurvivingBirthdaySpecialTitles(finalSpecialFlags, survivingBirthdayAges);
  const specialSegmentTitles: Record<string, string> = {};
  for (const flag of applicableSpecialFlags) {
    const title = specialTitleByMonth.get(flag.month);
    if (title) specialSegmentTitles[flag.segmentId] = title;
  }

  const readingOrder = buildReadingOrder({
    childName: child.name,
    finalBackboneSegments: readingOrderBackboneSegments,
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

  console.log(
    `Themed-spread admission (round-16): budget ${themedSpreadBudget} (floor(min(${totalPages}, ${options.pageCap})/${SPREAD_BUDGET_PAGES_PER_SPREAD})), spill bound ±${SPREAD_SPILL_BOUND} gaps -- ${survivingThemedSpreadIds.length} of ${nonBackbonePlan.keptThemedIds.length} candidate spread(s) survive; ${budgetDissolvedSpreadIds.length} dissolved (never dropped -- members returned to their own backbone month): ${budgetDissolvedSpreadIds.join(', ') || 'none'}.`,
  );

  // ── Render outputs ────────────────────────────────────────────────────

  await renderOutlineOutputs(outputDir, {
    runId,
    child,
    scope,
    window,
    language: response.language,
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
    budgetDissolvedSpreadIds,
    dissolvedBirthdayAges,
    movedToBackbone,
    droppedElements,
    excludedMemoryIds,
    totalPages,
    totalImageCount,
    pageCap: options.pageCap,
    heroCandidates: response.heroCandidates,
    coverCandidates: response.coverCandidates,
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
  /** Round-18: the resolved BCP-47 journal language (`ParsedOutlineResponse
   * .language`) -- persisted here so it lands in both outline.md's header
   * and outline.json, which `eval-memory-book-assets.ts` reads as its own
   * `--language` default when the flag isn't passed explicitly. */
  language: string;
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
  /** Round-16 owner-approved rule: a candidate spread cut for the themed-
   * spread page budget, or budget-admitted but unplaceable within its
   * seasonal spill bound -- DISSOLVED (never dropped), its members
   * returned to their own chronological backbone month. See
   * `admitThemedSpreads`/`reassignDissolvedSpreadMembers`. */
  budgetDissolvedSpreadIds: string[];
  /** Ages whose birthday spread dissolved into its backbone month (owner
   * round-3 note, 2026-08-25: birthday-beat merge rule). */
  dissolvedBirthdayAges: number[];
  movedToBackbone: DissolveResult['movedToBackbone'];
  /** Always `[]` (round-14: the outline no longer drops a whole candidate
   * spread for budget) -- kept in the output shape rather than removed. */
  droppedElements: Array<{ id: string; kind: 'themed'; reason: string }>;
  excludedMemoryIds: Array<{ memoryId: string; elementId: string; reason: string }>;
  totalPages: number;
  /** Total visual (photo/video-bearing) memories in the final book. */
  totalImageCount: number;
  pageCap: number;
  /** Design handoff decision (2026-08-27): up to 5 book-wide candidates for
   * a full-bleed page or the cover. */
  heroCandidates: string[];
  /** Owner decision, 2026-08-31 (cover-safety fix): up to `MAX_COVER_
   * CANDIDATES` book-wide candidates for the COVER specifically, ranked
   * best-first, vision-judged against stricter criteria than
   * `heroCandidates` -- see `ParsedOutlineResponse.coverCandidates`. */
  coverCandidates: string[];
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
  md.push(`Language: ${ctx.language} (round-18 resolution chain -- see outline.json's "language")  `);
  md.push(`Page estimate: ${ctx.totalPages} / page cap ${ctx.pageCap} (a CEILING, not a target; layflat hard limit ${HARD_PAGE_CAP}) -- via the real book-renderer fitter (round-13 'fitter-as-oracle')`);
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

  md.push('## Cover candidates (cover specifically, best-first, stricter than hero candidates)');
  md.push('');
  if (ctx.coverCandidates.length === 0) {
    md.push('_(none -- the renderer falls back to its own selection; see book-renderer/src/model/fitter.ts buildCoverPages)_');
  } else {
    for (const id of ctx.coverCandidates) {
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
  md.push(`- Dissolved candidate spreads (round-16: over the themed-spread page budget, or unplaceable within the seasonal spill bound -- never dropped, members returned to their own backbone month): ${ctx.budgetDissolvedSpreadIds.join(', ') || 'none'}`);
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
    // Round-18: resolved BCP-47 journal language -- `eval-memory-book-
    // assets.ts` reads this as its own `--language` default when the flag
    // is absent (see `resolveManifestLanguageDefault`/`coerceManifestLanguage`
    // there).
    language: ctx.language,
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
    coverCandidates: ctx.coverCandidates,
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
      budgetDissolvedSpreadIds: ctx.budgetDissolvedSpreadIds,
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
