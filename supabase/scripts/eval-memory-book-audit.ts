/**
 * Memory Book V0 data audit -- read-only eval that answers the "is there
 * enough material?" questions from docs/plans/memory-book.md §9 (V0) against
 * a real account, before any curation/layout/render code exists.
 *
 * For every family the eval user can see (RLS-scoped), this script reports:
 *   1. Inventory: memory/type/emotion/illustration/media/caption counts.
 *   2. Scope simulation: printable-memory counts per calendar year and per
 *      child age-year (birth -> 1st birthday = "Year One", ...), checked
 *      against the plan's proposed 30-memory threshold.
 *   3. Print-resolution audit: pixel dimensions of photos + illustrations
 *      fetched from R2, classified against 300dpi print slots.
 *   4. Engagement distribution: likes+comments per memory (curation signal).
 * ...then a top-of-report verdict summary answering V0's pass questions.
 *
 * This script is READ-ONLY: it never writes to the database, and every data
 * read goes through the RLS-scoped client (the service-role admin client is
 * only used to bootstrap the auth session, exactly like eval-illustration.ts).
 *
 * PII rule: memory `content` text is fetched (needed to know whether a
 * memory has a caption) but is NEVER printed, logged, or written to the
 * output report -- only ids, dates, counts, and pixel dimensions appear.
 *
 * Examples:
 *   npm run eval:memory-book-audit
 *   npm run eval:memory-book-audit -- --max-assets 200
 *   npm run eval:memory-book-audit -- --skip-r2
 *
 * Requires Supabase vars in supabase/.env.local (+ R2 vars for the
 * print-resolution audit, unless --skip-r2 is passed).
 * DB/R2 env access is not available in every environment this script runs
 * in -- it must typecheck even when it cannot be executed.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { getAgeInYearsAtDate } from '../functions/_shared/age.ts';
import { getObjectBytes } from '../functions/_shared/r2.ts';

// ── CLI ──────────────────────────────────────────────────────────────────

interface CliOptions {
  maxAssets: number;
  skipR2: boolean;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    maxAssets: Infinity,
    skipR2: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    switch (arg) {
      case '--max-assets':
        options.maxAssets = Number(next) || Infinity;
        index += 1;
        break;
      case '--skip-r2':
        options.skipR2 = true;
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
  aspect_ratio: number | null;
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

// ── Auth (same pattern as eval-illustration.ts) ─────────────────────────

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

/** Chunk an array for `.in()` queries -- keeps PostgREST query strings well
 * under URL length limits on accounts with large archives. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

const CHUNK_SIZE = 200;

function percentile(sortedAscending: number[], p: number): number {
  if (sortedAscending.length === 0) {
    return 0;
  }
  const index = Math.min(
    sortedAscending.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedAscending.length) - 1),
  );
  return sortedAscending[index];
}

/**
 * Adds `years` to a `YYYY-MM-DD` date string without ever round-tripping
 * through a `Date` object: `new Date('YYYY-MM-DDT00:00:00')` parses in local
 * time but `toISOString()` renders in UTC, so on a UTC-positive machine the
 * sliced result silently lands on the previous day -- which would shift the
 * age-year window boundaries used for the untagged-in-range count. Plain
 * string/number arithmetic sidesteps timezones entirely.
 */
function addYears(dateStr: string, years: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) {
    throw new Error(`addYears: unexpected date format "${dateStr}"`);
  }

  const year = Number(match[1]) + years;
  const month = Number(match[2]);
  const day = Number(match[3]);

  const isLeapYear = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const clampedDay = month === 2 && day === 29 && !isLeapYear(year) ? 28 : day;

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(clampedDay).padStart(2, '0')}`;
}

const ORDINAL_WORDS = [
  'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen',
  'Eighteen', 'Nineteen', 'Twenty',
];

function ageYearLabel(index: number): string {
  const word = ORDINAL_WORDS[index] ?? String(index + 1);
  return `Year ${word}`;
}

/** Fixed-size worker pool over a shared index cursor -- same pattern as
 * backfill-media-previews.ts's runWorker(), generalized. */
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

// ── Print-resolution classification ─────────────────────────────────────

type ResolutionSlot = 'spread-safe' | 'full-page' | 'half-page' | 'quarter-page' | 'small-only';

/** 8.3"x8.3" layflat book at 300dpi with 3mm bleed (plan §5 Stage E). */
function classifyResolution(maxDim: number): ResolutionSlot {
  if (maxDim >= 2560) return 'spread-safe';
  if (maxDim >= 2490) return 'full-page';
  if (maxDim >= 1245) return 'half-page';
  if (maxDim >= 625) return 'quarter-page';
  return 'small-only';
}

interface ResolutionAsset {
  memoryId: string;
  memoryDate: string;
  objectKey: string;
  kind: 'photo' | 'illustration';
}

interface ResolutionResult extends ResolutionAsset {
  maxDim: number | null;
  slot: ResolutionSlot | 'unreadable';
}

const R2_CONCURRENCY = 6;
const R2_PROGRESS_INTERVAL = 25;

async function auditResolutions(
  assets: ResolutionAsset[],
  maxAssets: number,
): Promise<ResolutionResult[]> {
  const capped = assets.slice(0, Number.isFinite(maxAssets) ? maxAssets : assets.length);
  const results: ResolutionResult[] = new Array(capped.length);
  let processed = 0;

  await runPool(capped, R2_CONCURRENCY, async (asset, index) => {
    try {
      const bytes = await getObjectBytes(asset.objectKey);
      // NOTE: pinned to the version actually present in node_modules (see
      // package-lock.json) -- `deno check` resolves npm: specifiers against
      // node_modules and 1.1.1 (the version compose-share-card/index.ts
      // references) isn't there, so pinning to it fails typecheck in this
      // repo's current state.
      const { imageSize } = await import('npm:image-size@1.2.1');
      const { width, height } = imageSize(bytes);
      const maxDim = width && height ? Math.max(width, height) : null;
      results[index] = {
        ...asset,
        maxDim,
        slot: maxDim ? classifyResolution(maxDim) : 'unreadable',
      };
    } catch {
      results[index] = { ...asset, maxDim: null, slot: 'unreadable' };
    }

    processed += 1;
    if (processed % R2_PROGRESS_INTERVAL === 0 || processed === capped.length) {
      console.log(`  ... resolution audit ${processed}/${capped.length} assets`);
    }
  });

  return results;
}

// ── Data loading (RLS-scoped client for every read) ────────────────────

const PAGE_SIZE = 1000;

/**
 * Loops `.range()` pages until one comes back shorter than PAGE_SIZE.
 * Supabase's hosted PostgREST caps any un-paginated select at 1000 rows --
 * this script's whole job is counting, so trusting a single un-paginated
 * call would silently truncate any family/chunk with more rows than that.
 * `.range()` offsets are only stable relative to a fixed sort order, so
 * every caller must attach a deterministic `.order()` (unique column(s))
 * to the query it hands in.
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

async function loadFamilies(supabase: AuthedClient): Promise<FamilyRow[]> {
  const { data, error } = await supabase
    .from('families')
    .select('id, name')
    .is('deleted_at', null);

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
    // 200 memory ids x up to ~10 assets each can exceed PAGE_SIZE on its
    // own even when the memories themselves don't, so this chunk-level
    // query is paginated too, not just the outer memoryIds chunking.
    const rows = await fetchAllRows<MediaRow>(
      (from, to) =>
        supabase
          .from('memory_media')
          .select('id, memory_id, object_key, content_type, duration_ms, aspect_ratio')
          .in('memory_id', ids)
          .order('id', { ascending: true })
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

async function loadEngagementCounts(
  supabase: AuthedClient,
  memoryIds: string[],
): Promise<Map<string, number>> {
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
            // Composite PK (memory_id, user_id) -- no single id column.
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

    for (const row of likeRows) {
      counts.set(row.memory_id, (counts.get(row.memory_id) ?? 0) + 1);
    }
    for (const row of commentRows) {
      counts.set(row.memory_id, (counts.get(row.memory_id) ?? 0) + 1);
    }
  }

  return counts;
}

// ── Per-memory derived facts ─────────────────────────────────────────────

interface MemoryFacts {
  photoCount: number;
  videoCount: number;
  hasCaption: boolean;
  isPrintable: boolean;
  isTagged: boolean;
}

function isPhoto(contentType: string): boolean {
  return contentType.startsWith('image/');
}

function isVideo(contentType: string): boolean {
  return contentType.startsWith('video/');
}

function buildMemoryFacts(
  memories: MemoryRow[],
  mediaByMemory: Map<string, MediaRow[]>,
  taggedMemoryIds: Set<string>,
): Map<string, MemoryFacts> {
  const facts = new Map<string, MemoryFacts>();

  for (const memory of memories) {
    const media = mediaByMemory.get(memory.id) ?? [];
    const photoCount = media.filter((m) => isPhoto(m.content_type)).length;
    const videoCount = media.filter((m) => isVideo(m.content_type)).length;
    const hasCaption = Boolean(memory.content?.trim());

    facts.set(memory.id, {
      photoCount,
      videoCount,
      hasCaption,
      isPrintable: hasCaption || photoCount > 0,
      isTagged: taggedMemoryIds.has(memory.id),
    });
  }

  return facts;
}

// ── Scope bucket aggregation ─────────────────────────────────────────────

interface ScopeBucket {
  label: string;
  memoryCount: number;
  typeMix: Record<string, number>;
  photoAssetCount: number;
  videoAssetCount: number;
  printableCount: number;
  untaggedCount: number;
  verdict: string;
}

const PRINTABLE_THRESHOLD = 30;

function summarizeBucket(
  label: string,
  bucketMemories: MemoryRow[],
  facts: Map<string, MemoryFacts>,
): ScopeBucket {
  const typeMix: Record<string, number> = {};
  let photoAssetCount = 0;
  let videoAssetCount = 0;
  let printableCount = 0;
  let untaggedCount = 0;

  for (const memory of bucketMemories) {
    typeMix[memory.memory_type] = (typeMix[memory.memory_type] ?? 0) + 1;
    const f = facts.get(memory.id);
    if (!f) continue;
    photoAssetCount += f.photoCount;
    videoAssetCount += f.videoCount;
    if (f.isPrintable) printableCount += 1;
    if (!f.isTagged) untaggedCount += 1;
  }

  const shortfall = PRINTABLE_THRESHOLD - printableCount;
  const verdict = shortfall <= 0
    ? `PASS (${printableCount}/${PRINTABLE_THRESHOLD})`
    : `below threshold (${printableCount}/${PRINTABLE_THRESHOLD}, short by ${shortfall})`;

  return {
    label,
    memoryCount: bucketMemories.length,
    typeMix,
    photoAssetCount,
    videoAssetCount,
    printableCount,
    untaggedCount,
    verdict,
  };
}

function calendarYearBuckets(memories: MemoryRow[], facts: Map<string, MemoryFacts>): ScopeBucket[] {
  const byYear = new Map<string, MemoryRow[]>();
  for (const memory of memories) {
    const year = memory.memory_date.slice(0, 4);
    const list = byYear.get(year) ?? [];
    list.push(memory);
    byYear.set(year, list);
  }

  return [...byYear.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([year, list]) => summarizeBucket(year, list, facts));
}

interface AgeYearScope {
  memberId: string;
  memberName: string;
  buckets: ScopeBucket[];
}

function ageYearBucketsForMember(
  member: FamilyMemberRow,
  familyMemories: MemoryRow[],
  tagsByMemory: Map<string, Set<string>>,
  facts: Map<string, MemoryFacts>,
): AgeYearScope | null {
  if (!member.date_of_birth) {
    return null;
  }

  const taggedMemories = familyMemories.filter((m) => tagsByMemory.get(m.id)?.has(member.id));

  if (taggedMemories.length === 0) {
    return { memberId: member.id, memberName: member.name, buckets: [] };
  }

  const byIndex = new Map<number, MemoryRow[]>();
  for (const memory of taggedMemories) {
    const ageYears = getAgeInYearsAtDate(member.date_of_birth, memory.memory_date);
    // ageYears === null means memory_date is before date_of_birth (e.g. a
    // pregnancy/announcement memory) -- bucket those separately as -1.
    const index = ageYears ?? -1;
    const list = byIndex.get(index) ?? [];
    list.push(memory);
    byIndex.set(index, list);
  }

  const indices = [...byIndex.keys()].sort((a, b) => a - b);
  const buckets: ScopeBucket[] = [];

  for (const index of indices) {
    const bucketMemories = byIndex.get(index)!;
    const label = index === -1 ? 'Pre-birth' : ageYearLabel(index);
    const bucket = summarizeBucket(label, bucketMemories, facts);

    // "untagged-memories count per year" -- how many of the family's total
    // memories fell within this age-year's calendar window but were NOT
    // tagged to this child (a data-quality gap for age-year book scoping).
    if (index >= 0) {
      const rangeStart = addYears(member.date_of_birth, index);
      const rangeEnd = addYears(member.date_of_birth, index + 1);
      const taggedIdsInBucket = new Set(bucketMemories.map((m) => m.id));
      const untaggedInRange = familyMemories.filter(
        (m) =>
          m.memory_date >= rangeStart &&
          m.memory_date < rangeEnd &&
          !taggedIdsInBucket.has(m.id) &&
          !tagsByMemory.get(m.id)?.has(member.id),
      ).length;
      bucket.untaggedCount = untaggedInRange;
    }

    buckets.push(bucket);
  }

  return { memberId: member.id, memberName: member.name, buckets };
}

// ── Report data shape ─────────────────────────────────────────────────────

interface FamilyReport {
  familyId: string;
  familyName: string;
  inventory: {
    total: number;
    typeMix: Record<string, number>;
    emotionSet: number;
    emotionMissing: number;
    illustrationSet: number;
    illustrationMissing: number;
    photoAssetCount: number;
    videoAssetCount: number;
    memoriesWithCaption: number;
    memoriesWithoutCaption: number;
    perMemoryAssetCounts: { zero: number; one: number; twoPlus: number };
  };
  calendarYears: ScopeBucket[];
  ageYears: AgeYearScope[];
  resolutionAssetCandidates: ResolutionAsset[];
  engagementMemoryIds: string[];
}

function buildInventory(
  memories: MemoryRow[],
  facts: Map<string, MemoryFacts>,
): FamilyReport['inventory'] {
  const typeMix: Record<string, number> = {};
  let emotionSet = 0;
  let illustrationSet = 0;
  let photoAssetCount = 0;
  let videoAssetCount = 0;
  let withCaption = 0;
  const assetBuckets = { zero: 0, one: 0, twoPlus: 0 };

  for (const memory of memories) {
    typeMix[memory.memory_type] = (typeMix[memory.memory_type] ?? 0) + 1;
    if (memory.emotion) emotionSet += 1;
    if (memory.illustration_key) illustrationSet += 1;

    const f = facts.get(memory.id);
    if (f) {
      photoAssetCount += f.photoCount;
      videoAssetCount += f.videoCount;
      if (f.hasCaption) withCaption += 1;

      const totalAssets = f.photoCount + f.videoCount;
      if (totalAssets === 0) assetBuckets.zero += 1;
      else if (totalAssets === 1) assetBuckets.one += 1;
      else assetBuckets.twoPlus += 1;
    }
  }

  return {
    total: memories.length,
    typeMix,
    emotionSet,
    emotionMissing: memories.length - emotionSet,
    illustrationSet,
    illustrationMissing: memories.length - illustrationSet,
    photoAssetCount,
    videoAssetCount,
    memoriesWithCaption: withCaption,
    memoriesWithoutCaption: memories.length - withCaption,
    perMemoryAssetCounts: assetBuckets,
  };
}

async function buildFamilyReport(supabase: AuthedClient, family: FamilyRow): Promise<FamilyReport> {
  const memories = await loadMemories(supabase, family.id);
  const memoryIds = memories.map((m) => m.id);

  const [media, tags, members] = await Promise.all([
    loadMediaForMemories(supabase, memoryIds),
    loadTagsForMemories(supabase, memoryIds),
    loadFamilyMembers(supabase, family.id),
  ]);

  const mediaByMemory = new Map<string, MediaRow[]>();
  for (const row of media) {
    const list = mediaByMemory.get(row.memory_id) ?? [];
    list.push(row);
    mediaByMemory.set(row.memory_id, list);
  }

  const tagsByMemory = new Map<string, Set<string>>();
  for (const tag of tags) {
    const set = tagsByMemory.get(tag.memory_id) ?? new Set<string>();
    set.add(tag.family_member_id);
    tagsByMemory.set(tag.memory_id, set);
  }

  const taggedMemoryIds = new Set(tagsByMemory.keys());
  const facts = buildMemoryFacts(memories, mediaByMemory, taggedMemoryIds);

  const inventory = buildInventory(memories, facts);
  const calendarYears = calendarYearBuckets(memories, facts);
  const ageYears = members
    .map((member) => ageYearBucketsForMember(member, memories, tagsByMemory, facts))
    .filter((scope): scope is AgeYearScope => scope !== null);

  const memoryDateById = new Map(memories.map((m) => [m.id, m.memory_date]));
  const resolutionAssetCandidates: ResolutionAsset[] = [];

  for (const row of media) {
    if (!isPhoto(row.content_type)) continue;
    resolutionAssetCandidates.push({
      memoryId: row.memory_id,
      memoryDate: memoryDateById.get(row.memory_id) ?? '',
      objectKey: row.object_key,
      kind: 'photo',
    });
  }

  for (const memory of memories) {
    if (!memory.illustration_key) continue;
    resolutionAssetCandidates.push({
      memoryId: memory.id,
      memoryDate: memory.memory_date,
      objectKey: memory.illustration_key,
      kind: 'illustration',
    });
  }

  return {
    familyId: family.id,
    familyName: family.name,
    inventory,
    calendarYears,
    ageYears,
    resolutionAssetCandidates,
    engagementMemoryIds: memoryIds,
  };
}

// ── Report rendering ───────────────────────────────────────────────────

function renderScopeBucketTable(buckets: ScopeBucket[]): string {
  if (buckets.length === 0) {
    return '_(none)_\n';
  }

  const lines = [
    '| Scope | Memories | Printable | Photos | Videos | Untagged | Type mix | Verdict |',
    '|---|---|---|---|---|---|---|---|',
  ];

  for (const bucket of buckets) {
    const typeMix = Object.entries(bucket.typeMix)
      .map(([type, count]) => `${type}:${count}`)
      .join(', ');
    lines.push(
      `| ${bucket.label} | ${bucket.memoryCount} | ${bucket.printableCount} | ${bucket.photoAssetCount} | ` +
        `${bucket.videoAssetCount} | ${bucket.untaggedCount} | ${typeMix} | ${bucket.verdict} |`,
    );
  }

  return lines.join('\n') + '\n';
}

function renderMarkdown(
  runId: string,
  userEmail: string,
  families: FamilyReport[],
  resolutionResults: ResolutionResult[],
  skippedR2: boolean,
  engagementStats: {
    p50: number;
    p90: number;
    max: number;
    withEngagementPct: number;
    totalMemories: number;
  },
  verdictBullets: string[],
): string {
  const lines: string[] = [];

  lines.push(`# Memory Book V0 — Data Audit`);
  lines.push('');
  lines.push(`Run: ${runId}  `);
  lines.push(`Account: ${userEmail}  `);
  lines.push(`Families audited: ${families.length}`);
  lines.push('');

  lines.push('## Verdict summary');
  lines.push('');
  for (const bullet of verdictBullets) {
    lines.push(`- ${bullet}`);
  }
  lines.push('');

  for (const family of families) {
    lines.push(`## Family: ${family.familyName} (\`${family.familyId}\`)`);
    lines.push('');

    lines.push('### 1. Inventory');
    lines.push('');
    lines.push(`- Total memories: ${family.inventory.total}`);
    lines.push(
      `- Type mix: ${
        Object.entries(family.inventory.typeMix).map(([t, c]) => `${t}=${c}`).join(', ') || '(none)'
      }`,
    );
    lines.push(
      `- Emotion set: ${family.inventory.emotionSet} / missing: ${family.inventory.emotionMissing}`,
    );
    lines.push(
      `- Illustration set: ${family.inventory.illustrationSet} / missing: ${family.inventory.illustrationMissing}`,
    );
    lines.push(
      `- Media assets: ${family.inventory.photoAssetCount} photos, ${family.inventory.videoAssetCount} videos`,
    );
    lines.push(
      `- Per-memory asset counts: 0 assets=${family.inventory.perMemoryAssetCounts.zero}, ` +
        `1 asset=${family.inventory.perMemoryAssetCounts.one}, 2+=${family.inventory.perMemoryAssetCounts.twoPlus}`,
    );
    lines.push(
      `- Captions: ${family.inventory.memoriesWithCaption} with text, ` +
        `${family.inventory.memoriesWithoutCaption} without`,
    );
    lines.push('');

    lines.push('### 2. Scope simulation');
    lines.push('');
    lines.push(`Printable-memory threshold: ${PRINTABLE_THRESHOLD}. "Printable" = has text content OR ≥1 photo.`);
    lines.push('');
    lines.push('#### Calendar year');
    lines.push('');
    lines.push(renderScopeBucketTable(family.calendarYears));

    for (const scope of family.ageYears) {
      lines.push(`#### Age year — ${scope.memberName}`);
      lines.push('');
      lines.push(renderScopeBucketTable(scope.buckets));
    }
  }

  lines.push('## 3. Print-resolution audit (all families combined)');
  lines.push('');

  if (skippedR2) {
    const totalCandidates = families.reduce((sum, f) => sum + f.resolutionAssetCandidates.length, 0);
    lines.push(`Skipped (--skip-r2). ${totalCandidates} candidate asset(s) found but not fetched.`);
    lines.push('');
  } else {
    const bySlot = new Map<string, { photos: number; illustrations: number }>();
    for (const result of resolutionResults) {
      const entry = bySlot.get(result.slot) ?? { photos: 0, illustrations: 0 };
      if (result.kind === 'photo') entry.photos += 1;
      else entry.illustrations += 1;
      bySlot.set(result.slot, entry);
    }

    lines.push('| Slot | Photos | Illustrations |');
    lines.push('|---|---|---|');
    for (
      const slot of ['spread-safe', 'full-page', 'half-page', 'quarter-page', 'small-only', 'unreadable']
    ) {
      const entry = bySlot.get(slot) ?? { photos: 0, illustrations: 0 };
      lines.push(`| ${slot} | ${entry.photos} | ${entry.illustrations} |`);
    }
    lines.push('');

    const illustrations = resolutionResults.filter((r) => r.kind === 'illustration' && r.maxDim !== null);
    if (illustrations.length > 0) {
      const dims = illustrations.map((r) => r.maxDim!).sort((a, b) => a - b);
      lines.push(
        `Illustration resolution: min=${dims[0]}px, median=${percentile(dims, 50)}px, max=${
          dims[dims.length - 1]
        }px ` +
          `(full-page needs ≥2490px, spread-safe ≥2560px — see plan §5 Stage E upscaling question).`,
      );
      lines.push('');
    }

    const worstPhotos = resolutionResults
      .filter((r) => r.kind === 'photo' && r.maxDim !== null)
      .sort((a, b) => (a.maxDim ?? 0) - (b.maxDim ?? 0))
      .slice(0, 10);

    if (worstPhotos.length > 0) {
      lines.push('Worst-resolution photos:');
      lines.push('');
      lines.push('| Memory ID | Date | Max dimension (px) | Slot |');
      lines.push('|---|---|---|---|');
      for (const photo of worstPhotos) {
        lines.push(`| ${photo.memoryId} | ${photo.memoryDate} | ${photo.maxDim} | ${photo.slot} |`);
      }
      lines.push('');
    }

    const unreadableCount = resolutionResults.filter((r) => r.slot === 'unreadable').length;
    if (unreadableCount > 0) {
      lines.push(`Unreadable assets (fetch or parse failure): ${unreadableCount}`);
      lines.push('');
    }
  }

  lines.push('## 4. Engagement distribution (all families combined)');
  lines.push('');
  lines.push(`- Memories: ${engagementStats.totalMemories}`);
  lines.push(`- p50 (likes+comments): ${engagementStats.p50}`);
  lines.push(`- p90 (likes+comments): ${engagementStats.p90}`);
  lines.push(`- max (likes+comments): ${engagementStats.max}`);
  lines.push(`- % of memories with any engagement: ${engagementStats.withEngagementPct.toFixed(1)}%`);
  lines.push('');

  return lines.join('\n');
}

// ── Main ─────────────────────────────────────────────────────────────────

const options = parseArgs(Deno.args);

const supabase = await createAuthedClient();
const userEmail = Deno.env.get('EVAL_USER_EMAIL') ?? 'eduardoyi@gmail.com';
const runId = new Date().toISOString().replace(/[:.]/g, '-');

console.log(`Memory Book V0 audit run ${runId} — account: ${userEmail}`);

const families = await loadFamilies(supabase);

if (families.length === 0) {
  console.error('No families visible to this account.');
  Deno.exit(1);
}

console.log(`Found ${families.length} famil${families.length === 1 ? 'y' : 'ies'}.`);

const familyReports: FamilyReport[] = [];
for (const family of families) {
  console.log(`Auditing family ${family.id} ...`);
  familyReports.push(await buildFamilyReport(supabase, family));
}

const allResolutionCandidates = familyReports.flatMap((f) => f.resolutionAssetCandidates);
// Deterministic ordering before the --max-assets cap is applied.
allResolutionCandidates.sort((a, b) => a.memoryDate.localeCompare(b.memoryDate));

let resolutionResults: ResolutionResult[] = [];
if (!options.skipR2 && allResolutionCandidates.length > 0) {
  console.log(
    `Running print-resolution audit over ${
      Math.min(allResolutionCandidates.length, options.maxAssets)
    } of ${allResolutionCandidates.length} candidate asset(s) ...`,
  );
  resolutionResults = await auditResolutions(allResolutionCandidates, options.maxAssets);
}

const allMemoryIds = familyReports.flatMap((f) => f.engagementMemoryIds);
const engagementCounts = await loadEngagementCounts(supabase, allMemoryIds);
const engagementValues = [...engagementCounts.values()].sort((a, b) => a - b);
const withEngagement = engagementValues.filter((v) => v > 0).length;
const engagementStats = {
  p50: percentile(engagementValues, 50),
  p90: percentile(engagementValues, 90),
  max: engagementValues.length > 0 ? engagementValues[engagementValues.length - 1] : 0,
  withEngagementPct: engagementValues.length > 0 ? (withEngagement / engagementValues.length) * 100 : 0,
  totalMemories: engagementValues.length,
};

// ── Verdict bullets (plan §9 V0 pass questions) ────────────────────────

const verdictBullets: string[] = [];

const totalMemories = familyReports.reduce((sum, f) => sum + f.inventory.total, 0);
verdictBullets.push(
  `${familyReports.length} famil${familyReports.length === 1 ? 'y' : 'ies'} audited, ${totalMemories} memories total.`,
);

const bestCalendarYearBuckets = familyReports.flatMap((f) => f.calendarYears);
const passingYears = bestCalendarYearBuckets.filter((b) => b.verdict.startsWith('PASS')).length;
verdictBullets.push(
  `Calendar-year scope: ${passingYears}/${bestCalendarYearBuckets.length} year(s) clear the ` +
    `${PRINTABLE_THRESHOLD}-printable-memory threshold.`,
);

const ageYearBuckets = familyReports.flatMap((f) => f.ageYears.flatMap((s) => s.buckets));
const passingAgeYears = ageYearBuckets.filter((b) => b.verdict.startsWith('PASS')).length;
verdictBullets.push(
  `Age-year scope: ${passingAgeYears}/${ageYearBuckets.length} age-year(s) clear the ` +
    `${PRINTABLE_THRESHOLD}-printable-memory threshold.`,
);

if (options.skipR2) {
  verdictBullets.push('Print-resolution audit skipped (--skip-r2) — no verdict on 300dpi survivability.');
} else {
  const belowQuarter = resolutionResults.filter(
    (r) => r.slot === 'small-only' || r.slot === 'unreadable',
  ).length;
  const illustrationsBelowFullPage = resolutionResults.filter(
    (r) => r.kind === 'illustration' && (r.slot === 'half-page' || r.slot === 'quarter-page' || r.slot === 'small-only'),
  ).length;
  verdictBullets.push(
    `${belowQuarter}/${resolutionResults.length} audited asset(s) are below quarter-page print quality.`,
  );
  verdictBullets.push(
    illustrationsBelowFullPage > 0
      ? `${illustrationsBelowFullPage} illustration(s) are below full-page resolution — upscaling likely needed for spreads (plan §5 Stage E).`
      : `Illustrations audited are at/above full-page resolution — no upscaling signal from this sample.`,
  );
}

verdictBullets.push(
  `Engagement: ${engagementStats.withEngagementPct.toFixed(1)}% of memories have any likes/comments ` +
    `(p50=${engagementStats.p50}, p90=${engagementStats.p90}) — weak engagement coverage would blunt it as a ranking signal.`,
);

// ── Write artifacts ──────────────────────────────────────────────────────

const outputDir = new URL('./eval-output/memory-book-audit/', import.meta.url);
await Deno.mkdir(outputDir, { recursive: true });

const markdown = renderMarkdown(
  runId,
  userEmail,
  familyReports,
  resolutionResults,
  options.skipR2,
  engagementStats,
  verdictBullets,
);

const jsonReport = {
  runId,
  generatedAt: new Date().toISOString(),
  userEmail,
  printableThreshold: PRINTABLE_THRESHOLD,
  skippedR2: options.skipR2,
  maxAssets: Number.isFinite(options.maxAssets) ? options.maxAssets : null,
  verdictBullets,
  families: familyReports.map((f) => ({
    familyId: f.familyId,
    familyName: f.familyName,
    inventory: f.inventory,
    calendarYears: f.calendarYears,
    ageYears: f.ageYears,
  })),
  resolutionAudit: {
    skipped: options.skipR2,
    results: resolutionResults.map((r) => ({
      memoryId: r.memoryId,
      memoryDate: r.memoryDate,
      kind: r.kind,
      maxDim: r.maxDim,
      slot: r.slot,
    })),
  },
  engagement: engagementStats,
};

const mdPath = new URL(`${runId}-report.md`, outputDir);
const jsonPath = new URL(`${runId}-report.json`, outputDir);

await Deno.writeFile(mdPath, new TextEncoder().encode(markdown));
await Deno.writeFile(jsonPath, new TextEncoder().encode(JSON.stringify(jsonReport, null, 2)));

console.log(`\nDone.`);
console.log(`  Markdown: ${mdPath.pathname}`);
console.log(`  JSON:     ${jsonPath.pathname}`);
