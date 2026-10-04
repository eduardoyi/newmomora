/**
 * Holiday Card C0 data audit -- read-only eval answering the C0 pass
 * questions from docs/plans/holiday-cards.md §6: is there enough for a great
 * card today, how many photos qualify for a 5x7 print, and what should the
 * card film's floor be for thin years?
 *
 * For every family the eval user can see (RLS-scoped), over the card scope
 * (Jan 1 of `--year` → `--today`, the same scope a card film made today
 * would use):
 *   1. Film pool: moments / visuals / videos / quarters after the share-safety
 *      filter, the year-end family floors for reference, and a cumulative
 *      month-by-month table plus "if the family had started on the 1st of
 *      month M" rows to set the card-film floor.
 *   2. Front photo candidates: photo memories tagged with ≥2 family members,
 *      core-family coverage (own children + parents), orientation (the card
 *      is landscape 7x5), and the ORIGINAL pixel size classified against a
 *      5x7 print at 300 dpi (ranged R2 reads, never the full object). Last
 *      December's holiday photos are counted separately (a card front is
 *      often last Christmas's best family photo).
 *   3. Letter material: distinctive themes (the film's `distinctiveThemes`),
 *      certain firsts, quotable lines, holiday/travel topics, monthly coverage,
 *      and the journal language.
 *   4. Illustrated-scene readiness: which core-family members have a ready
 *      illustrated portrait.
 * With `--all-families` it also prints a counts-only histogram of every
 * family's card-scope pool (service-role, no ids, no names, no content) so
 * the floor can be set against the whole user base, not one rich family.
 *
 * All film logic comes from the production modules
 * (`_shared/year-film-eligibility.ts`, `_shared/year-film-script.ts`,
 * `_shared/year-film-i18n.ts`).
 *
 * READ-ONLY. Every per-family read goes through the RLS-scoped client (the
 * service-role client only bootstraps the session and, with
 * --all-families, runs the counts-only histogram).
 *
 * PII rule: memory `content` is fetched (share-safety, quote and first
 * detection need it) but is NEVER printed, logged, or written -- only ids,
 * dates, counts, topic/milestone labels, pixel sizes and family-member first
 * names appear. Output goes to the gitignored
 * supabase/scripts/eval-output/holiday-card/. stdout is counts-only.
 *
 * Examples:
 *   npm run eval:holiday-card-audit
 *   npm run eval:holiday-card-audit -- --today 2026-11-15 --all-families
 *   npm run eval:holiday-card-audit -- --skip-pixels
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { getTopicById } from '../functions/_shared/memory-topics.ts';
import { createPresignedGetUrls, getR2Config } from '../functions/_shared/r2.ts';
import {
  addDays,
  countPool,
  evaluateFamilyFilm,
  FAMILY_MIN_POOL,
  FAMILY_MIN_VISUALS,
  familyPool,
  type FilmMediaInput,
  type FilmMemberInput,
  type FilmMemoryInput,
  type FilmMilestoneInput,
  type FilmScope,
  isFilmChild,
  isQuotePoolText,
  visualKind,
  YEAR_MIN_QUARTERS,
} from '../functions/_shared/year-film-eligibility.ts';
import { distinctiveThemes, isCertainFirst, shareSensitiveIds } from '../functions/_shared/year-film-script.ts';
import { detectJournalLanguage, milestoneLabel } from '../functions/_shared/year-film-i18n.ts';

// ── CLI ──────────────────────────────────────────────────────────────────

interface Args {
  today: string;
  year: number;
  skipPixels: boolean;
  allFamilies: boolean;
}

function parseArgs(args: string[]): Args {
  let today = new Date().toISOString().slice(0, 10);
  let year: number | null = null;
  let skipPixels = false;
  let allFamilies = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--today' && /^\d{4}-\d{2}-\d{2}$/.test(args[i + 1] ?? '')) {
      today = args[i + 1];
      i += 1;
    } else if (args[i] === '--year' && /^\d{4}$/.test(args[i + 1] ?? '')) {
      year = Number(args[i + 1]);
      i += 1;
    } else if (args[i] === '--skip-pixels') {
      skipPixels = true;
    } else if (args[i] === '--all-families') {
      allFamilies = true;
    }
  }
  return { today, year: year ?? Number(today.slice(0, 4)), skipPixels, allFamilies };
}

// ── Card constants (C0 proposals; production values land in C1/C3) ───────

/** Gelato 5R card: 5x7 in trim (127 x 177.8 mm), 4 mm bleed on every side,
 * page 1 = front, page 2 = back (support.gelato.com, 2026-10-04). */
const CARD_TRIM_MM = { width: 177.8, height: 127 };
const CARD_BLEED_MM = 4;
const MM_PER_INCH = 25.4;
/** Pixels a full-bleed front needs at 300 dpi (trim + bleed), landscape. */
const FULL_BLEED_PX = {
  long: Math.round(((CARD_TRIM_MM.width + 2 * CARD_BLEED_MM) / MM_PER_INCH) * 300),
  short: Math.round(((CARD_TRIM_MM.height + 2 * CARD_BLEED_MM) / MM_PER_INCH) * 300),
};

/** Candidate card-film floors to evaluate (moments, visuals). */
const FLOOR_CANDIDATES: { moments: number; visuals: number }[] = [
  { moments: 10, visuals: 6 },
  { moments: 15, visuals: 10 },
  { moments: 20, visuals: 12 },
  { moments: 30, visuals: 20 },
  { moments: 40, visuals: 25 },
  { moments: FAMILY_MIN_POOL, visuals: FAMILY_MIN_VISUALS },
];

const HOLIDAY_TOPICS = ['christmas', 'hanukkah', 'new-year', 'thanksgiving', 'halloween', 'snow-play', 'family-gathering'];
const TRIP_TOPICS = ['travel', 'beach', 'camping', 'road-trip', 'vacation'];
const LETTER_EXCLUDED_EMOTIONS = new Set(['worry', 'sad', 'weary']);

// ── Row shapes (hand-typed -- matches src/types/database.ts) ───────────────

interface FamilyRow {
  id: string;
  name: string;
}

interface MemberRow {
  id: string;
  name: string;
  date_of_birth: string | null;
  relationship: string | null;
  illustrated_profile_key: string | null;
  illustrated_profile_status: string | null;
}

interface MemoryRow {
  id: string;
  content: string | null;
  memory_date: string;
  memory_type: string;
  emotion: string | null;
  topics: string[] | null;
  illustration_status: string;
  media_key: string | null;
  media_content_type: string | null;
  onboarding_media_pending: boolean;
}

interface MediaRow {
  id: string;
  memory_id: string;
  object_key: string;
  content_type: string;
  duration_ms: number | null;
  preview_object_key: string | null;
  aspect_ratio: number | null;
  position: number;
}

interface TagRow {
  memory_id: string;
  family_member_id: string;
}

interface MilestoneRow {
  memory_id: string;
  family_member_id: string | null;
  milestone_id: string;
  status: string;
}

interface ReportRow {
  target_id: string;
  target_type: string;
}

// ── Auth (same pattern as eval-year-film-audit.ts) ───────────────────────

function supabaseEnv() {
  const supabaseUrl = Deno.env.get('EXPO_PUBLIC_SUPABASE_URL') ?? Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = Deno.env.get('EXPO_PUBLIC_SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !serviceRoleKey || !anonKey) {
    throw new Error('Missing Supabase env vars in supabase/.env.local');
  }
  return { supabaseUrl, serviceRoleKey, anonKey };
}

function createAdminClient() {
  const { supabaseUrl, serviceRoleKey } = supabaseEnv();
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createAuthedClient() {
  const { supabaseUrl, anonKey } = supabaseEnv();
  const userEmail = Deno.env.get('EVAL_USER_EMAIL') ?? 'eduardoyi@gmail.com';
  const admin = createAdminClient();
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

// ── Loading ──────────────────────────────────────────────────────────────

const PAGE_SIZE = 1000;
const CHUNK_SIZE = 200;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Pages `.range()` until a short page; callers pass a deterministic `.order()`. */
async function fetchAllRows<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  label: string,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Failed to load ${label}: ${error.message}`);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) return out;
  }
}

async function loadByMemoryIds<T>(
  memoryIds: string[],
  label: string,
  page: (ids: string[], from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (const ids of chunk(memoryIds, CHUNK_SIZE)) {
    out.push(...(await fetchAllRows<T>((from, to) => page(ids, from, to), label)));
  }
  return out;
}

/** A film memory plus what the card needs to judge its photos. */
interface CardMemory extends FilmMemoryInput {
  photos: { mediaId: string; objectKey: string; aspectRatio: number | null }[];
}

interface FamilyData {
  family: FamilyRow;
  members: MemberRow[];
  memories: CardMemory[];
  milestones: FilmMilestoneInput[];
}

function mediaKind(contentType: string): FilmMediaInput['kind'] | null {
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  return null;
}

async function loadFamilyData(supabase: AuthedClient, family: FamilyRow): Promise<FamilyData> {
  const { data: members, error: membersError } = await supabase
    .from('family_members')
    .select('id, name, date_of_birth, relationship, illustrated_profile_key, illustrated_profile_status')
    .eq('family_id', family.id);
  if (membersError) throw new Error(`Failed to load family_members: ${membersError.message}`);

  const memoryRows = await fetchAllRows<MemoryRow>(
    (from, to) =>
      supabase
        .from('memories')
        .select(
          'id, content, memory_date, memory_type, emotion, topics, illustration_status, media_key, media_content_type, onboarding_media_pending',
        )
        .eq('family_id', family.id)
        .order('memory_date', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    'memories',
  );
  const saved = memoryRows.filter((m) => !m.onboarding_media_pending);
  const ids = saved.map((m) => m.id);

  const media = await loadByMemoryIds<MediaRow>(ids, 'memory_media', (chunkIds, from, to) =>
    supabase
      .from('memory_media')
      .select('id, memory_id, object_key, content_type, duration_ms, preview_object_key, aspect_ratio, position')
      .in('memory_id', chunkIds)
      .order('id', { ascending: true })
      .range(from, to)
  );
  const tags = await loadByMemoryIds<TagRow>(ids, 'memory_family_members', (chunkIds, from, to) =>
    supabase
      .from('memory_family_members')
      .select('memory_id, family_member_id')
      .in('memory_id', chunkIds)
      .order('memory_id', { ascending: true })
      .order('family_member_id', { ascending: true })
      .range(from, to)
  );
  const milestoneRows = await loadByMemoryIds<MilestoneRow>(ids, 'memory_milestones', (chunkIds, from, to) =>
    supabase
      .from('memory_milestones')
      .select('memory_id, family_member_id, milestone_id, status')
      .in('memory_id', chunkIds)
      .order('id', { ascending: true })
      .range(from, to)
  );

  const { data: reports, error: reportsError } = await supabase.rpc('get_my_open_content_reports', {
    p_family_id: family.id,
  });
  if (reportsError) throw new Error(`Failed to load content reports: ${reportsError.message}`);
  const reportedMemories = new Set(
    ((reports ?? []) as ReportRow[]).filter((r) => r.target_type === 'memory').map((r) => r.target_id),
  );

  const mediaByMemory = new Map<string, MediaRow[]>();
  for (const row of media) {
    const list = mediaByMemory.get(row.memory_id) ?? [];
    list.push(row);
    mediaByMemory.set(row.memory_id, list);
  }
  const tagsByMemory = new Map<string, string[]>();
  for (const row of tags) {
    const list = tagsByMemory.get(row.memory_id) ?? [];
    list.push(row.family_member_id);
    tagsByMemory.set(row.memory_id, list);
  }

  const memories: CardMemory[] = saved.map((row) => {
    const rows = (mediaByMemory.get(row.id) ?? []).sort((a, b) => a.position - b.position);
    let filmMedia: FilmMediaInput[] = rows.flatMap((m) => {
      const kind = mediaKind(m.content_type);
      return kind ? [{ kind, durationMs: m.duration_ms, hasPreview: !!m.preview_object_key || kind === 'image' }] : [];
    });
    const photos = rows
      .filter((m) => m.content_type.startsWith('image/'))
      .map((m) => ({ mediaId: m.id, objectKey: m.object_key, aspectRatio: m.aspect_ratio }));
    // Legacy single-asset memories predate memory_media rows.
    if (filmMedia.length === 0 && row.media_key && row.media_content_type) {
      const kind = mediaKind(row.media_content_type);
      if (kind) filmMedia = [{ kind, durationMs: null, hasPreview: kind === 'image' }];
      if (kind === 'image') photos.push({ mediaId: `legacy:${row.id}`, objectKey: row.media_key, aspectRatio: null });
    }
    return {
      id: row.id,
      date: row.memory_date,
      type: row.memory_type,
      text: row.content,
      emotion: row.emotion,
      topics: row.topics ?? [],
      taggedMemberIds: tagsByMemory.get(row.id) ?? [],
      illustrationReady: row.illustration_status === 'completed',
      media: filmMedia,
      reported: reportedMemories.has(row.id),
      photos,
    };
  });

  const milestones: FilmMilestoneInput[] = milestoneRows.map((row) => ({
    memoryId: row.memory_id,
    familyMemberId: row.family_member_id,
    milestoneId: row.milestone_id,
    status: row.status,
  }));

  return { family, members: (members ?? []) as MemberRow[], memories, milestones };
}

// ── Pixel probe (ranged reads; mirrors memory-book-worker/src/dimensions.ts) ─

const PROBE_BYTES = 256 * 1024;
const PROBE_FALLBACK_BYTES = 4 * 1024 * 1024;
const PROBE_CONCURRENCY = 8;

async function runPool<T>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await fn(items[index], index);
    }
  });
  await Promise.all(workers);
}

async function probeDimensions(url: string): Promise<{ width: number; height: number } | null> {
  const { imageSize } = await import('npm:image-size@1.2.1');
  for (const bytes of [PROBE_BYTES, PROBE_FALLBACK_BYTES]) {
    try {
      const response = await fetch(url, { headers: { Range: `bytes=0-${bytes - 1}` } });
      if (!response.ok && response.status !== 206) return null;
      const buffer = new Uint8Array(await response.arrayBuffer());
      const { width, height, orientation } = imageSize(buffer);
      if (!width || !height) continue;
      // EXIF orientations 5-8 rotate the stored pixels by 90 degrees.
      return orientation && orientation >= 5 ? { width: height, height: width } : { width, height };
    } catch {
      // Header not complete in this range: try the larger one.
    }
  }
  return null;
}

async function measurePhotos(objectKeys: string[]): Promise<Map<string, { width: number; height: number } | null>> {
  getR2Config(); // fail fast with a clear error when R2 env is missing
  const results = new Map<string, { width: number; height: number } | null>();
  let done = 0;
  for (const keys of chunk(objectKeys, 100)) {
    const urls = await createPresignedGetUrls(keys);
    await runPool(keys, PROBE_CONCURRENCY, async (key) => {
      const url = urls[key];
      results.set(key, url ? await probeDimensions(url) : null);
      done += 1;
      if (done % 50 === 0 || done === objectKeys.length) console.log(`  ... pixel probe ${done}/${objectKeys.length}`);
    });
  }
  return results;
}

// ── Evaluation ───────────────────────────────────────────────────────────

type PrintClass = 'full-bleed' | 'bordered' | 'low' | 'unreadable';

/** Classify against a landscape 7x5 front after cropping to 7:5. */
function printClass(dims: { width: number; height: number } | null): PrintClass {
  if (!dims) return 'unreadable';
  const long = Math.max(dims.width, dims.height);
  const short = Math.min(dims.width, dims.height);
  // Usable crop at the card's landscape aspect from this photo.
  const aspect = FULL_BLEED_PX.long / FULL_BLEED_PX.short;
  const isLandscape = dims.width >= dims.height;
  const cropLong = isLandscape ? Math.min(long, short * aspect) : short;
  const cropShort = cropLong / aspect;
  if (cropLong >= FULL_BLEED_PX.long && cropShort >= FULL_BLEED_PX.short) return 'full-bleed';
  // A bordered layout prints the photo ~80% of the card width; ~220 dpi floor.
  if (cropLong >= FULL_BLEED_PX.long * 0.6) return 'bordered';
  return 'low';
}

function orientationOf(aspect: number | null): 'landscape' | 'square' | 'portrait' | 'unknown' {
  if (aspect == null) return 'unknown';
  if (aspect >= 1.15) return 'landscape';
  if (aspect <= 0.87) return 'portrait';
  return 'square';
}

function quarterOf(date: string): number {
  return Math.floor((Number(date.slice(5, 7)) - 1) / 3);
}

function monthStarts(year: number, today: string): string[] {
  const out: string[] = [];
  for (let m = 1; m <= 12; m += 1) {
    const d = `${year}-${String(m).padStart(2, '0')}-01`;
    if (d <= today) out.push(d);
  }
  return out;
}

/** `addDays` only counts forward. */
function previousDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function addOneDay(date: string): string {
  return addDays(date, 1);
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

interface PoolStats {
  moments: number;
  visuals: number;
  photos: number;
  videos: number;
  sounds: number;
  quarters: number;
}

function poolStats(pool: FilmMemoryInput[]): PoolStats {
  const counts = countPool(pool);
  return {
    moments: counts.moments,
    visuals: pool.filter((m) => visualKind(m) !== null).length,
    photos: counts.photos,
    videos: counts.videos,
    sounds: counts.sounds,
    quarters: new Set(pool.map((m) => quarterOf(m.date))).size,
  };
}

interface PhotoCandidate {
  memoryId: string;
  date: string;
  mediaId: string;
  objectKey: string;
  tagged: number;
  coreTagged: number;
  wholeCore: boolean;
  orientation: ReturnType<typeof orientationOf>;
  holiday: boolean;
  dims: { width: number; height: number } | null;
  print: PrintClass | 'not-measured';
}

interface FamilyAudit {
  family: FamilyRow;
  today: string;
  scope: FilmScope;
  core: { children: string[]; parents: string[]; others: number };
  portraits: { name: string; role: string; ready: boolean }[];
  language: string | null;
  pool: PoolStats;
  sensitiveExcluded: number;
  yearEnd: { eligible: boolean; moments: number; visuals: number; quarters: number };
  cumulative: { through: string; stats: PoolStats }[];
  startedOn: { start: string; stats: PoolStats }[];
  floors: { moments: number; visuals: number; passToday: boolean; passFromMonth: string | null }[];
  photos: PhotoCandidate[];
  lastDecember: PhotoCandidate[];
  themes: { topicId: string; title: string; memories: number; lift: number }[];
  firsts: { milestone: string; date: string }[];
  quotable: number;
  holidayTopics: { topic: string; memories: number }[];
  tripTopics: { topic: string; memories: number }[];
  monthly: { month: string; moments: number }[];
}

function evaluateFamily(data: FamilyData, args: Args, pixels: Map<string, { width: number; height: number } | null>): FamilyAudit {
  const scope: FilmScope = { start: `${args.year}-01-01`, endExclusive: addOneDay(args.today) };
  const members = data.members;
  const filmMembers: (FilmMemberInput & { name: string })[] = members.map((m) => ({
    id: m.id,
    name: m.name,
    dateOfBirth: m.date_of_birth,
    relationship: m.relationship,
  }));
  const children = filmMembers.filter((m) => isFilmChild(m, args.today));
  const parents = members.filter((m) => m.relationship === 'parent');
  const coreIds = new Set([...children.map((c) => c.id), ...parents.map((p) => p.id)]);

  const sensitive = shareSensitiveIds(data.memories, data.milestones);
  const safe = data.memories.filter((m) => !sensitive.has(m.id) && !LETTER_EXCLUDED_EMOTIONS.has(m.emotion ?? ''));
  const rawPool = familyPool(data.memories, scope);
  const pool = familyPool(safe, scope);

  const yearEnd = evaluateFamilyFilm({ memories: data.memories, children, scope });

  const cumulative = monthStarts(args.year, args.today).map((start) => {
    const next = new Date(`${start}T00:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const endExclusive = next.toISOString().slice(0, 10) < scope.endExclusive ? next.toISOString().slice(0, 10) : scope.endExclusive;
    return { through: previousDay(endExclusive), stats: poolStats(familyPool(safe, { start: scope.start, endExclusive })) };
  });
  const startedOn = monthStarts(args.year, args.today).map((start) => ({
    start,
    stats: poolStats(familyPool(safe, { start, endExclusive: scope.endExclusive })),
  }));
  const poolNow = poolStats(pool);
  const floors = FLOOR_CANDIDATES.map((f) => {
    const passes = (s: PoolStats) => s.moments >= f.moments && s.visuals >= f.visuals;
    // Latest month a family could have started and still pass today.
    const latest = [...startedOn].reverse().find((row) => passes(row.stats));
    return { ...f, passToday: passes(poolNow), passFromMonth: latest?.start ?? null };
  });

  // Front photo candidates: safe, in scope, a photo, ≥2 family members tagged.
  const toCandidate = (m: CardMemory): PhotoCandidate[] =>
    m.photos.map((p) => {
      const coreTagged = m.taggedMemberIds.filter((id) => coreIds.has(id)).length;
      const dims = pixels.get(p.objectKey);
      return {
        memoryId: m.id,
        date: m.date,
        mediaId: p.mediaId,
        objectKey: p.objectKey,
        tagged: m.taggedMemberIds.length,
        coreTagged,
        wholeCore: coreIds.size > 0 && [...coreIds].every((id) => m.taggedMemberIds.includes(id)),
        orientation: orientationOf(p.aspectRatio),
        holiday: m.topics.some((t) => HOLIDAY_TOPICS.includes(t)),
        dims: dims ?? null,
        print: dims === undefined ? 'not-measured' : printClass(dims),
      };
    });
  const photos = pool.filter((m) => m.photos.length > 0 && m.taggedMemberIds.length >= 2).flatMap((m) => toCandidate(m as CardMemory));
  const lastDecember = familyPool(safe, { start: `${args.year - 1}-12-01`, endExclusive: `${args.year}-01-01` })
    .filter((m) => m.photos.length > 0 && m.taggedMemberIds.length >= 2)
    .flatMap((m) => toCandidate(m as CardMemory));

  const language = detectJournalLanguage(pool.map((m) => m.text));
  const lang = language ?? 'en';
  const themes = distinctiveThemes(pool, safe, 8, 2, lang);
  const poolIds = new Set(pool.map((m) => m.id));
  const textById = new Map(data.memories.map((m) => [m.id, m.text]));
  const dateById = new Map(data.memories.map((m) => [m.id, m.date]));
  const firsts = data.milestones
    .filter((ms) => poolIds.has(ms.memoryId) && isCertainFirst(ms, textById.get(ms.memoryId) ?? null))
    .map((ms) => ({ milestone: milestoneLabel(ms.milestoneId, lang) ?? ms.milestoneId, date: dateById.get(ms.memoryId) ?? '' }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const topicCount = (topics: string[], source: FilmMemoryInput[]) =>
    topics
      .map((topic) => ({ topic, memories: source.filter((m) => m.topics.includes(topic)).length }))
      .filter((row) => row.memories > 0 && getTopicById(row.topic));

  const monthly = monthStarts(args.year, args.today).map((start) => ({
    month: start.slice(0, 7),
    moments: pool.filter((m) => m.date.startsWith(start.slice(0, 7))).length,
  }));

  const portraitRoles = members
    .filter((m) => coreIds.has(m.id))
    .map((m) => ({
      name: firstName(m.name),
      role: m.relationship ?? 'child (by age)',
      ready: !!m.illustrated_profile_key && (m.illustrated_profile_status ?? 'ready') === 'ready',
    }));

  return {
    family: data.family,
    today: args.today,
    scope,
    core: {
      children: children.map((c) => firstName(c.name)),
      parents: parents.map((p) => firstName(p.name)),
      others: members.length - coreIds.size,
    },
    portraits: portraitRoles,
    language,
    pool: poolNow,
    sensitiveExcluded: rawPool.length - pool.length,
    yearEnd: {
      eligible: yearEnd.eligible,
      moments: yearEnd.counts.moments,
      visuals: yearEnd.visuals,
      quarters: yearEnd.quartersCovered,
    },
    cumulative,
    startedOn,
    floors,
    photos,
    lastDecember,
    themes,
    firsts,
    quotable: pool.filter((m) => isQuotePoolText(m.text)).length,
    holidayTopics: topicCount(HOLIDAY_TOPICS, pool),
    tripTopics: topicCount(TRIP_TOPICS, pool),
    monthly,
  };
}

// ── All-families histogram (service role, counts only) ───────────────────

interface Histogram {
  families: number;
  buckets: { label: string; families: number }[];
  floors: { moments: number; visuals: number; families: number }[];
}

async function allFamiliesHistogram(args: Args): Promise<Histogram> {
  const admin = createAdminClient();
  const start = `${args.year}-01-01`;
  const end = addOneDay(args.today);
  const rows = await fetchAllRows<{ family_id: string; memory_type: string; media_content_type: string | null; illustration_status: string }>(
    (from, to) =>
      admin
        .from('memories')
        .select('family_id, memory_type, media_content_type, illustration_status')
        .gte('memory_date', start)
        .lt('memory_date', end)
        .eq('onboarding_media_pending', false)
        .order('id', { ascending: true })
        .range(from, to),
    'memories (histogram)',
  );
  const perFamily = new Map<string, { moments: number; visuals: number }>();
  for (const row of rows) {
    const entry = perFamily.get(row.family_id) ?? { moments: 0, visuals: 0 };
    entry.moments += 1;
    // Approximation of visualKind without per-asset rows: a media memory or
    // a ready illustration is a visual.
    if (row.memory_type === 'media' || row.illustration_status === 'completed') entry.visuals += 1;
    perFamily.set(row.family_id, entry);
  }
  const values = [...perFamily.values()];
  const bucketEdges = [1, 10, 20, 40, 60, 100, 200, Infinity];
  const buckets = bucketEdges.slice(0, -1).map((lo, i) => {
    const hi = bucketEdges[i + 1];
    return {
      label: hi === Infinity ? `${lo}+` : `${lo}–${hi - 1}`,
      families: values.filter((v) => v.moments >= lo && v.moments < hi).length,
    };
  });
  return {
    families: values.length,
    buckets,
    floors: FLOOR_CANDIDATES.map((f) => ({
      ...f,
      families: values.filter((v) => v.moments >= f.moments && v.visuals >= f.visuals).length,
    })),
  };
}

// ── Report ───────────────────────────────────────────────────────────────

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return out;
}

function fmtCounts(counts: Record<string, number>): string {
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ') || '—';
}

function statsRow(label: string, s: PoolStats): string {
  return `| ${label} | ${s.moments} | ${s.visuals} | ${s.photos} | ${s.videos} | ${s.sounds} | ${s.quarters}/4 |`;
}

function photoTable(rows: PhotoCandidate[], limit: number): string[] {
  const rank = (p: PhotoCandidate) =>
    (p.print === 'full-bleed' ? 4 : p.print === 'bordered' ? 2 : 0) +
    (p.wholeCore ? 3 : 0) + p.coreTagged * 0.5 + (p.orientation === 'landscape' ? 1 : 0) + (p.holiday ? 1 : 0);
  const sorted = [...rows].sort((a, b) => rank(b) - rank(a) || b.date.localeCompare(a.date));
  const lines = [
    '| Memory | Media | Date | Tagged (core) | Whole core family | Orientation | Pixels | 5x7 print | Holiday topic |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const p of sorted.slice(0, limit)) {
    lines.push(
      `| ${p.memoryId} | ${p.mediaId} | ${p.date} | ${p.tagged} (${p.coreTagged}) | ${p.wholeCore ? 'yes' : ''} | ${p.orientation} | ` +
        `${p.dims ? `${p.dims.width}×${p.dims.height}` : '—'} | ${p.print} | ${p.holiday ? 'yes' : ''} |`,
    );
  }
  return lines;
}

function renderMarkdown(runId: string, args: Args, audits: FamilyAudit[], histogram: Histogram | null): string {
  const lines: string[] = [];
  lines.push(`# Holiday Card C0 audit — ${runId}`, '');
  lines.push(
    `Card scope: ${args.year}-01-01 → ${args.today} (what a card film made today would cover). ` +
      `Share-safe pool = the film's share-safety filter plus worried/sad/weary moments removed (card audience = acquaintances). ` +
      `Print classes for a landscape 7x5 front (Gelato 5R: 177.8 × 127 mm trim + 4 mm bleed): ` +
      `**full-bleed** ≥ ${FULL_BLEED_PX.long}×${FULL_BLEED_PX.short} px after a 7:5 crop (300 dpi); ` +
      `**bordered** ≥ 60% of that (~180+ dpi in a bordered layout); **low** below.`,
    '',
  );

  for (const a of audits) {
    lines.push(`## ${a.family.name}`, '');
    lines.push(
      `- Core family: children ${a.core.children.join(', ') || '—'}; parents ${a.core.parents.join(', ') || '—'}; ` +
        `${a.core.others} other people in the family.`,
      `- Journal language (detected): ${a.language ?? 'unknown'}.`,
      `- Illustrated portraits (core family): ${a.portraits.map((p) => `${p.name} (${p.role}) ${p.ready ? '✓' : '✗'}`).join(', ') || '—'}.`,
      `- Year-end family film floors (${FAMILY_MIN_POOL}/${FAMILY_MIN_VISUALS}, ≥${YEAR_MIN_QUARTERS} quarters) on this scope: ` +
        `${a.yearEnd.eligible ? '**eligible**' : 'not eligible'} (${a.yearEnd.moments} moments, ${a.yearEnd.visuals} visuals, ${a.yearEnd.quarters}/4 quarters).`,
      '',
    );

    lines.push(`### 1. Film pool`, '');
    lines.push('| Scope | Moments | Visuals | Photo memories | Video memories | Sounds | Quarters |', '|---|---|---|---|---|---|---|');
    lines.push(statsRow(`Jan 1 → ${a.today} (share-safe)`, a.pool));
    lines.push('', `Share-safety removed ${a.sensitiveExcluded} memories from the card scope.`, '');
    lines.push(`**Cumulative (from Jan 1)** — what a card made at the end of each month would have:`, '');
    lines.push('| Through | Moments | Visuals | Photo memories | Video memories | Sounds | Quarters |', '|---|---|---|---|---|---|---|');
    for (const row of a.cumulative) lines.push(statsRow(row.through, row.stats));
    lines.push('', `**Thin-year proxy** — if this family had started on the 1st of month M (scope M → ${a.today}):`, '');
    lines.push('| Started | Moments | Visuals | Photo memories | Video memories | Sounds | Quarters |', '|---|---|---|---|---|---|---|');
    for (const row of a.startedOn) lines.push(statsRow(row.start, row.stats));
    lines.push('', `**Candidate card-film floors** (moments / visuals):`, '');
    lines.push('| Floor | Passes today | Latest start month that still passes |', '|---|---|---|');
    for (const f of a.floors) lines.push(`| ${f.moments} / ${f.visuals} | ${f.passToday ? 'yes' : 'no'} | ${f.passFromMonth ?? '—'} |`);
    lines.push('');

    lines.push(`### 2. Front photo candidates (photos with ≥2 people tagged)`, '');
    const measured = a.photos.filter((p) => p.print !== 'not-measured');
    lines.push(
      `- ${a.photos.length} photos across ${new Set(a.photos.map((p) => p.memoryId)).size} memories; ` +
        `${a.photos.filter((p) => p.wholeCore).length} tag the whole core family; ` +
        `${a.photos.filter((p) => p.coreTagged >= 2).length} tag ≥2 core members.`,
      `- Orientation: ${fmtCounts(countBy(a.photos, (p) => p.orientation))}.`,
      `- 5x7 print class (${measured.length} measured): ${fmtCounts(countBy(measured, (p) => p.print))}.`,
      `- Whole core family AND full-bleed: **${a.photos.filter((p) => p.wholeCore && p.print === 'full-bleed').length}**; ` +
        `≥2 core AND full-bleed: **${a.photos.filter((p) => p.coreTagged >= 2 && p.print === 'full-bleed').length}**.`,
      `- Holiday-topic photos in scope: ${a.photos.filter((p) => p.holiday).length}. ` +
        `Last December (${args.year - 1}-12): ${a.lastDecember.length} photos with ≥2 tagged, ` +
        `${a.lastDecember.filter((p) => p.print === 'full-bleed').length} full-bleed.`,
      '',
      'Top 25 by a naive rank (print class, whole core family, core tags, landscape, holiday) — C1 replaces this with a vision judge:',
      '',
      ...photoTable(a.photos, 25),
      '',
      `Last December's best (top 10):`,
      '',
      ...photoTable(a.lastDecember, 10),
      '',
    );

    lines.push(`### 3. Letter material`, '');
    lines.push(
      `- Distinctive themes: ${a.themes.map((t) => `${t.title} (${t.memories}, ×${t.lift})`).join(' · ') || '—'}.`,
      `- Certain firsts (${a.firsts.length}): ${a.firsts.map((f) => `${f.milestone} (${f.date})`).join(' · ') || '—'}.`,
      `- Quotable memories (quote-pool text): ${a.quotable}.`,
      `- Holiday topics: ${a.holidayTopics.map((t) => `${t.topic} ${t.memories}`).join(' · ') || '—'}.`,
      `- Trip topics: ${a.tripTopics.map((t) => `${t.topic} ${t.memories}`).join(' · ') || '—'}.`,
      `- Moments per month: ${a.monthly.map((m) => `${m.month.slice(5)}:${m.moments}`).join(' ')}.`,
      '',
    );
  }

  if (histogram) {
    lines.push(`## All families (counts only, raw pool, ${args.year}-01-01 → ${args.today})`, '');
    lines.push(
      `${histogram.families} families with ≥1 memory in scope. Visuals approximated as media memories + ready illustrations; ` +
        `no share-safety filter (needs content), so real pools are a little smaller.`,
      '',
      '| Moments in scope | Families |',
      '|---|---|',
      ...histogram.buckets.map((b) => `| ${b.label} | ${b.families} |`),
      '',
      '| Floor (moments / visuals) | Families passing |',
      '|---|---|',
      ...histogram.floors.map((f) => `| ${f.moments} / ${f.visuals} | ${f.families} |`),
      '',
    );
  }

  lines.push(
    `## Notes`,
    '',
    `- Gelato print spec (support.gelato.com, 2026-10-04): one PDF, page 1 = front, page 2 = back; 4 mm bleed every side; ` +
      `keep text ≥4 mm inside the trim; PDF/X-4 recommended. Page size with bleed: ` +
      `${(CARD_TRIM_MM.width + 2 * CARD_BLEED_MM).toFixed(1)} × ${(CARD_TRIM_MM.height + 2 * CARD_BLEED_MM).toFixed(1)} mm.`,
    `- Blocked-account filtering is not applied here (own-family audit); production must apply it.`,
  );
  return lines.join('\n') + '\n';
}

// ── Main ─────────────────────────────────────────────────────────────────

const args = parseArgs(Deno.args);
const supabase = await createAuthedClient();
const { data: families, error: familiesError } = await supabase.from('families').select('id, name').order('id');
if (familiesError) throw new Error(`Failed to load families: ${familiesError.message}`);

const audits: FamilyAudit[] = [];
for (const family of (families ?? []) as FamilyRow[]) {
  const data = await loadFamilyData(supabase, family);
  // Measure only the photos the card could use: this year + last December, ≥2 tagged.
  let pixels = new Map<string, { width: number; height: number } | null>();
  if (!args.skipPixels) {
    const keys = new Set<string>();
    for (const m of data.memories) {
      if (m.date < `${args.year - 1}-12-01` || m.date > args.today || m.taggedMemberIds.length < 2) continue;
      for (const p of m.photos) keys.add(p.objectKey);
    }
    console.log(`family ${family.id}: probing ${keys.size} photo originals`);
    pixels = await measurePhotos([...keys]);
  }
  const audit = evaluateFamily(data, args, pixels);
  audits.push(audit);
  console.log(
    `family ${family.id}: ${audit.pool.moments} moments, ${audit.pool.visuals} visuals in scope; ` +
      `${audit.photos.length} front candidates`,
  );
}

const histogram = args.allFamilies ? await allFamiliesHistogram(args) : null;
if (histogram) console.log(`histogram: ${histogram.families} families`);

const outputDir = new URL('./eval-output/holiday-card/', import.meta.url);
await Deno.mkdir(outputDir, { recursive: true });
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const mdPath = new URL(`${runId}-audit.md`, outputDir);
await Deno.writeTextFile(mdPath, renderMarkdown(runId, args, audits, histogram));
await Deno.writeTextFile(
  new URL(`${runId}-audit.json`, outputDir),
  JSON.stringify({ runId, args, audits: audits.map((a) => ({ ...a, photos: a.photos.map(({ objectKey: _k, ...p }) => p), lastDecember: a.lastDecember.map(({ objectKey: _k, ...p }) => p) })), histogram }, null, 2),
);
console.log(`report: ${mdPath.pathname}`);
