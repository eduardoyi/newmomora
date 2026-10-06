/**
 * Holiday Card C1 -- front eval (docs/plans/holiday-cards.md §6 C1). Answers
 * the owner review questions "is the top pick the photo you'd choose?" and "is
 * the illustrated scene card-worthy?" for one family's holiday card front.
 *
 *   1. Photo pool: last Dec 1 → today, photos with ≥2 family members tagged,
 *      share-safe (the film's share-safety filter + worried/sad/weary
 *      removed), not reported, original big enough to print (ranged R2 reads
 *      of the originals, never full downloads), judged against the card in the
 *      photo's own orientation (`_shared/holiday-card-photos.ts`).
 *   2. Vision "card-worthy" judge on the best N pre-scored candidates
 *      (`--max-vision`, default 30; ~1280 px previews, `detail: high`).
 *   3. Ranking: top picks with why, near-misses with why, and a mock of each
 *      top-3 pick cropped to the card's 5:7 trim in its own orientation.
 *   4. Illustrated holiday scenes: 3 variants of the core family from their
 *      CURRENT ready illustrated portraits, in the house storybook style, on
 *      the production illustration model at `quality: medium`. Hard cap: 4
 *      image generations per run; `--no-illustrations` skips them.
 * All photo/scene logic comes from the production modules
 * (`_shared/holiday-card-photos.ts`, `_shared/holiday-card-illustration.ts`).
 *
 * READ-ONLY. Every per-family read goes through the RLS-scoped client (the
 * service-role client only bootstraps the session). No DB writes, no R2
 * writes. Blocked-account filtering (own-family eval) is not applied;
 * production must apply it.
 *
 * PII rule: memory `content` is fetched for share-safety only and is NEVER
 * printed, logged, or written. The review page and JSON hold family photos,
 * family-member first names and vision verdicts, and are written only under
 * the gitignored supabase/scripts/eval-output/holiday-card/. stdout is
 * counts and ids only.
 *
 * Examples:
 *   npm run eval:holiday-card-front
 *   npm run eval:holiday-card-front -- --today 2026-11-15 --max-vision 30
 *   npm run eval:holiday-card-front -- --max-vision 4 --no-illustrations
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { describeAgeAtDate } from '../functions/_shared/age.ts';
import { normalizeOpenAiUsage, priceOpenAiUsage } from '../functions/_shared/ai-pricing.ts';
import {
  FRONT_JUDGE_MODEL,
  type FrontVerdict,
  coreFamilyMemberIds,
  frontPoolStart,
  type FrontRanking,
  readChatUsage,
} from '../functions/_shared/holiday-card-photos.ts';
import {
  type FrontPickInput,
  type FrontPickMemory,
  type FrontPool,
  type FrontPickPorts,
  type PreviewImage,
  buildFrontPool,
  runFrontPipeline,
} from '../functions/_shared/holiday-card-generate-front.ts';
import type { ChatResult, ImageReaderPort } from '../functions/_shared/holiday-card-generate-ports.ts';
import {
  buildHolidaySceneIllustrationPrompt,
  HOLIDAY_SCENE_VARIANTS,
  type HolidaySceneVariant,
} from '../functions/_shared/holiday-card-illustration.ts';
import { sniffImageFormat } from '../functions/_shared/image-bytes.ts';
import {
  type IllustrationFamilyMember,
  prepareIllustrationReferences,
} from '../functions/_shared/illustration-references.ts';
import { encodeBytesToBase64, PRIMARY_IMAGE_MODEL } from '../functions/_shared/openai.ts';
import { type PortraitVersionCandidate, resolvePortraitVersionAtDate } from '../functions/_shared/portrait-versions.ts';
import { createPresignedGetUrls, getObjectBytes, getR2Config } from '../functions/_shared/r2.ts';
import { DEFAULT_ILLUSTRATION_STYLE_TOKEN, getStyleDescription } from '../functions/_shared/styles.ts';
import {
  type FilmMediaInput,
  type FilmMemberInput,
  type FilmMemoryInput,
  type FilmMilestoneInput,
  isFilmChild,
} from '../functions/_shared/year-film-eligibility.ts';

// ── CLI ──────────────────────────────────────────────────────────────────

interface Args {
  today: string;
  maxVision: number;
  illustrations: boolean;
  familyId: string | null;
  /** Reuse the scenes of an earlier run (its runId) instead of generating. */
  scenesFrom: string | null;
  /** Generate only these variant ids (default: all, unless --scenes-from). */
  scenes: string[] | null;
}

function parseArgs(args: string[]): Args {
  let today = new Date().toISOString().slice(0, 10);
  let maxVision = 30;
  let illustrations = true;
  let familyId: string | null = null;
  let scenesFrom: string | null = null;
  let scenes: string[] | null = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--today' && /^\d{4}-\d{2}-\d{2}$/.test(args[i + 1] ?? '')) {
      today = args[i + 1];
      i += 1;
    } else if (args[i] === '--max-vision' && Number(args[i + 1]) > 0) {
      maxVision = Math.floor(Number(args[i + 1]));
      i += 1;
    } else if (args[i] === '--no-illustrations') {
      illustrations = false;
    } else if (args[i] === '--family' && args[i + 1]) {
      familyId = args[i + 1];
      i += 1;
    } else if (args[i] === '--scenes-from' && args[i + 1]) {
      scenesFrom = args[i + 1];
      i += 1;
    } else if (args[i] === '--scenes' && args[i + 1]) {
      scenes = args[i + 1].split(',').map((id) => id.trim()).filter(Boolean);
      i += 1;
    }
  }
  return { today, maxVision, illustrations, familyId, scenesFrom, scenes };
}

// ── Row shapes (hand-typed -- matches src/types/database.ts) ───────────────

interface FamilyRow {
  id: string;
  name: string;
  illustration_style: string | null;
}

interface MemberRow {
  id: string;
  name: string;
  nicknames: string[] | null;
  date_of_birth: string | null;
  gender: string | null;
  additional_info: string | null;
  relationship: string | null;
  illustrated_profile_key: string | null;
  illustrated_profile_status: string | null;
  profile_picture_key: string | null;
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

// ── Auth (same pattern as eval-holiday-card-audit.ts) ────────────────────

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

interface CardPhoto {
  mediaId: string;
  objectKey: string;
  previewKey: string | null;
  aspectRatio: number | null;
  contentType: string | null;
}

/** A film memory plus what the card needs to judge its photos. */
interface CardMemory extends FilmMemoryInput {
  photos: CardPhoto[];
}

interface FamilyData {
  family: FamilyRow;
  members: MemberRow[];
  portraits: PortraitVersionCandidate[];
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
    .select(
      'id, name, nicknames, date_of_birth, gender, additional_info, relationship, illustrated_profile_key, illustrated_profile_status, profile_picture_key',
    )
    .eq('family_id', family.id);
  if (membersError) throw new Error(`Failed to load family_members: ${membersError.message}`);
  const memberRows = (members ?? []) as MemberRow[];

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

  const memberIds = memberRows.map((m) => m.id);
  const portraits = memberIds.length === 0 ? [] : await fetchAllRows<PortraitVersionCandidate>(
    (from, to) =>
      supabase
        .from('family_member_portrait_versions')
        .select(
          'id, family_member_id, reference_date, profile_picture_key, illustrated_profile_key, illustrated_profile_status, deletion_token, created_at',
        )
        .in('family_member_id', memberIds)
        .order('id', { ascending: true })
        .range(from, to),
    'family_member_portrait_versions',
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
    const photos: CardPhoto[] = rows
      .filter((m) => m.content_type.startsWith('image/'))
      .map((m) => ({ mediaId: m.id, objectKey: m.object_key, previewKey: m.preview_object_key, aspectRatio: m.aspect_ratio, contentType: m.content_type }));
    // Legacy single-asset memories predate memory_media rows.
    if (filmMedia.length === 0 && row.media_key && row.media_content_type) {
      const kind = mediaKind(row.media_content_type);
      if (kind) filmMedia = [{ kind, durationMs: null, hasPreview: kind === 'image' }];
      if (kind === 'image') photos.push({ mediaId: `legacy:${row.id}`, objectKey: row.media_key, previewKey: null, aspectRatio: null, contentType: row.media_content_type });
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

  return { family, members: memberRows, portraits, memories, milestones };
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

// ── OpenAI usage (counts and prices only) ────────────────────────────────

interface UsageTally {
  calls: number;
  usd: number;
  unpricedCalls: number;
  inputTokens: number;
  outputTokens: number;
}

const usageByModel = new Map<string, UsageTally>();

/** Image usage the shared pricer cannot complete (no itemized output tokens):
 * price what the response does report -- text input at the text rate, image
 * input at the image rate, all output at the image-output rate (gpt-image-2.5
 * flare, openai-2026-09-08). An estimate, flagged as such. */
function estimateImageCostUsd(usage: unknown): number | null {
  const u = usage && typeof usage === 'object' ? usage as Record<string, unknown> : {};
  const details = u.input_tokens_details && typeof u.input_tokens_details === 'object'
    ? u.input_tokens_details as Record<string, unknown>
    : {};
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  if (input === null || output === null) return null;
  const text = num(details.text_tokens) ?? 0;
  const image = num(details.image_tokens) ?? Math.max(0, input - text);
  return (text * 5 + image * 8 + output * 30) / 1_000_000;
}

/** Numeric usage fields only (token counts), for the run JSON. */
function numericUsage(usage: unknown): Record<string, unknown> {
  if (!usage || typeof usage !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(usage as Record<string, unknown>)) {
    if (typeof value === 'number') out[key] = value;
    else if (value && typeof value === 'object') out[key] = numericUsage(value);
  }
  return out;
}

function tally(model: string, usage: unknown, fallbackUsd?: (usage: unknown) => number | null): number | null {
  const entry = usageByModel.get(model) ?? { calls: 0, usd: 0, unpricedCalls: 0, inputTokens: 0, outputTokens: 0 };
  entry.calls += 1;
  const dimensions = normalizeOpenAiUsage(usage);
  const priced = priceOpenAiUsage(model, dimensions);
  entry.inputTokens += (dimensions.input_text_tokens ?? 0) + (dimensions.input_image_tokens ?? 0);
  entry.outputTokens += (dimensions.output_text_tokens ?? 0) + (dimensions.output_image_tokens ?? 0);
  const cost = priced.estimatedCostUsd ?? fallbackUsd?.(usage) ?? null;
  if (cost === null) entry.unpricedCalls += 1;
  else entry.usd += cost;
  usageByModel.set(model, entry);
  return cost;
}

// ── Adapters for the production front modules ────────────────────────────
// The orchestration (pool, ranged probe, previews, judge batches, ranking) is
// `_shared/holiday-card-generate-front.ts`, the same code the card Workflow
// runs; this script only supplies Deno/R2/ffmpeg/OpenAI ports and keeps the
// review page.

/** Longest edge capped to `maxEdge`; ffmpeg applies EXIF rotation. */
async function downscaleToJpeg(bytes: Uint8Array, maxEdge: number): Promise<Uint8Array | null> {
  const dir = await Deno.makeTempDir();
  try {
    const input = `${dir}/in`;
    const output = `${dir}/out.jpg`;
    await Deno.writeFile(input, bytes);
    const scale =
      `scale='if(gt(iw,ih),min(${maxEdge},iw),-2)':'if(gt(iw,ih),-2,min(${maxEdge},ih))'`;
    const { code } = await new Deno.Command('ffmpeg', {
      args: ['-v', 'error', '-y', '-i', input, '-frames:v', '1', '-vf', scale, '-q:v', '4', output],
    }).output();
    return code === 0 ? await Deno.readFile(output) : null;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function chat(body: Record<string, unknown>): Promise<ChatResult> {
  const apiKey = Deno.env.get('OPENAI_API_KEY');
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY');
  const call = () =>
    fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  let response = await call();
  if (!response.ok && (response.status === 429 || response.status >= 500)) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    response = await call();
  }
  if (!response.ok) {
    console.error(`OpenAI chat ${response.status}`);
    return { content: null, usage: null, ok: false };
  }
  const payload = await response.json();
  return { content: payload.choices?.[0]?.message?.content ?? null, usage: payload.usage, ok: true };
}

/** R2 over presigned URLs (the Worker uses its bucket binding). */
const r2Images: ImageReaderPort = {
  async readRange(key, length) {
    const url = (await createPresignedGetUrls([key]))[key];
    if (!url) return null;
    const response = await fetch(url, { headers: { Range: `bytes=0-${length - 1}` } });
    if (!response.ok && response.status !== 206) return null;
    return new Uint8Array(await response.arrayBuffer());
  },
  async read(key) {
    try {
      return await getObjectBytes(key);
    } catch {
      return null;
    }
  },
};

const { imageSize } = await import('npm:image-size@1.2.1');

const frontPorts: FrontPickPorts = {
  chat,
  usage: (event) => {
    if (!event.ok) return;
    tally(event.model, event.usage);
    const usage = readChatUsage(event.usage);
    if (usage) console.log(`  judge call: ${usage.promptTokens} in / ${usage.completionTokens} out tokens`);
  },
  images: r2Images,
  imageSize: (bytes) => imageSize(bytes),
  downscaleToJpeg,
  progress: (message) => console.log(message),
};

// ── Illustrated scenes ───────────────────────────────────────────────────

/** Hard cap on paid image calls per run (including a size fallback). */
const MAX_IMAGE_GENERATIONS = 4;
const IMAGE_QUALITY = 'medium';
let imageGenerations = 0;

interface SceneResult {
  variant: HolidaySceneVariant;
  requestedSize: string;
  usedSize: string | null;
  note: string | null;
  fileName: string | null;
  bytes: Uint8Array | null;
  contentType: string | null;
  costUsd: number | null;
  usage: Record<string, unknown>;
  referenceCount: number;
  prompt: string;
}

async function requestImageEdit(
  model: string,
  prompt: string,
  references: { bytes: Uint8Array; contentType: string; filename: string }[],
  size: string,
): Promise<{ ok: true; bytes: Uint8Array; usage: unknown } | { ok: false; status: number; message: string }> {
  if (imageGenerations >= MAX_IMAGE_GENERATIONS) throw new Error('Image generation cap reached');
  imageGenerations += 1;
  const form = new FormData();
  form.append('model', model);
  form.append('prompt', prompt);
  form.append('size', size);
  // Never send an image call without an explicit quality (docs/COST_OPTIMIZATION.md).
  form.append('quality', IMAGE_QUALITY);
  form.append('output_format', 'webp');
  form.append('output_compression', '90');
  for (const reference of references) {
    form.append(
      'image[]',
      new Blob([reference.bytes as Uint8Array<ArrayBuffer>], { type: reference.contentType }),
      reference.filename,
    );
  }
  const response = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${Deno.env.get('OPENAI_API_KEY')}` },
    body: form,
  });
  if (!response.ok) {
    let message = '';
    try {
      const body = await response.json();
      message = String(body?.error?.message ?? '').slice(0, 200);
    } catch {
      // keep the status only
    }
    return { ok: false, status: response.status, message };
  }
  const payload = await response.json();
  const base64 = payload.data?.[0]?.b64_json;
  if (typeof base64 !== 'string' || !base64) return { ok: false, status: 200, message: 'empty image' };
  return { ok: true, bytes: Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)), usage: payload.usage };
}

/** Core members in a stable order (parents first, then children oldest first),
 * each with their CURRENT ready illustrated portrait as the reference. */
function sceneMembers(data: FamilyData, today: string): { members: IllustrationFamilyMember[]; skipped: number } {
  const filmMembers: (FilmMemberInput & MemberRow)[] = data.members.map((m) => ({
    ...m,
    dateOfBirth: m.date_of_birth,
  }));
  const coreIds = coreFamilyMemberIds(filmMembers, today);
  const core = filmMembers.filter((m) => coreIds.has(m.id));
  core.sort((a, b) => {
    const parentRank = (m: MemberRow) => (m.relationship === 'parent' ? 0 : 1);
    return parentRank(a) - parentRank(b) || (a.date_of_birth ?? '').localeCompare(b.date_of_birth ?? '') || a.id.localeCompare(b.id);
  });
  const members: IllustrationFamilyMember[] = [];
  let skipped = 0;
  for (const member of core.slice(0, 6)) {
    const versions = data.portraits.filter((v) => v.family_member_id === member.id);
    const resolved = resolvePortraitVersionAtDate(versions, today);
    const key = resolved?.illustrated_profile_key ??
      (member.illustrated_profile_status === 'ready' ? member.illustrated_profile_key : null);
    if (!key) {
      skipped += 1;
      continue;
    }
    members.push({
      id: member.id,
      name: firstName(member.name),
      nicknames: null,
      date_of_birth: member.date_of_birth,
      gender: member.gender,
      additional_info: member.additional_info,
      illustrated_profile_key: key,
      // Never fall back to a real photo of a person for a card scene.
      profile_picture_key: null,
    });
  }
  return { members, skipped: skipped + Math.max(0, core.length - 6) };
}

/** Scenes of an earlier run, read back from its JSON + image files (no
 * image calls: re-ranking photos shouldn't pay for new illustrations). */
async function loadScenes(fromRunId: string, outputDir: URL): Promise<SceneResult[]> {
  const previous = JSON.parse(await Deno.readTextFile(new URL(`${fromRunId}-front.json`, outputDir))) as {
    scenes: { variant: string; requestedSize: string; usedSize: string | null; note: string | null; file: string | null; referenceCount: number; costUsd: number | null }[];
  };
  const out: SceneResult[] = [];
  for (const scene of previous.scenes) {
    const variant = HOLIDAY_SCENE_VARIANTS.find((v) => v.id === scene.variant);
    if (!variant) continue;
    const bytes = scene.file ? await Deno.readFile(new URL(scene.file, outputDir)) : null;
    out.push({
      variant,
      requestedSize: scene.requestedSize,
      usedSize: scene.usedSize,
      note: scene.note ?? `reused from ${fromRunId}`,
      fileName: scene.file,
      bytes,
      contentType: scene.file?.endsWith('.png') ? 'image/png' : 'image/webp',
      costUsd: scene.costUsd,
      usage: {},
      referenceCount: scene.referenceCount,
      prompt: '',
    });
  }
  console.log(`illustrations: reused ${out.length} scenes from ${fromRunId}`);
  return out;
}

async function generateScenes(data: FamilyData, args: Args, runId: string, outputDir: URL): Promise<SceneResult[]> {
  const { members, skipped } = sceneMembers(data, args.today);
  console.log(`illustrations: ${members.length} core members with a ready portrait (${skipped} skipped)`);
  if (members.length < 2) {
    console.log('illustrations: fewer than 2 members with portraits, skipping');
    return [];
  }
  const bundle = await prepareIllustrationReferences(members, args.today, getObjectBytes);
  if (bundle.referenceImages.length < 2) {
    console.log('illustrations: portrait references failed to load, skipping');
    return [];
  }
  const styleDescription = getStyleDescription(data.family.illustration_style ?? DEFAULT_ILLUSTRATION_STYLE_TOKEN);
  const cardYear = Number(args.today.slice(0, 4));

  const results: SceneResult[] = [];
  let sizeRejected = false;
  const wanted = HOLIDAY_SCENE_VARIANTS.filter((v) => !args.scenes || args.scenes.includes(v.id));
  for (const variant of wanted) {
    const prompt = buildHolidaySceneIllustrationPrompt({
      variant,
      characterReferences: bundle.characterReferences,
      styleDescription,
      cardYear,
    });
    const references = bundle.referenceImages.map((r) => ({ bytes: r.bytes, contentType: r.contentType, filename: r.filename }));
    const result: SceneResult = {
      variant,
      requestedSize: variant.size,
      usedSize: null,
      note: null,
      fileName: null,
      bytes: null,
      contentType: null,
      costUsd: null,
      usage: {},
      referenceCount: references.length,
      prompt,
    };
    // Once the model rejects a non-square size, later variants go straight to
    // 1024x1024 so the 4-generation cap still covers all three scenes.
    let attempt = await requestImageEdit(PRIMARY_IMAGE_MODEL, prompt, references, sizeRejected ? '1024x1024' : variant.size);
    if (sizeRejected && attempt.ok) {
      result.usedSize = '1024x1024';
      result.note = `${PRIMARY_IMAGE_MODEL} rejects ${variant.size}; used 1024x1024`;
    } else if (!attempt.ok && attempt.status === 400 && /size/i.test(attempt.message) && imageGenerations < MAX_IMAGE_GENERATIONS) {
      sizeRejected = true;
      result.note = `${PRIMARY_IMAGE_MODEL} rejected ${variant.size} (${attempt.message}); fell back to 1024x1024`;
      console.log(`  scene ${variant.id}: ${variant.size} rejected, falling back to 1024x1024`);
      attempt = await requestImageEdit(PRIMARY_IMAGE_MODEL, prompt, references, '1024x1024');
      if (attempt.ok) result.usedSize = '1024x1024';
    } else if (attempt.ok) {
      result.usedSize = variant.size;
    }
    if (!attempt.ok) {
      result.note = `${result.note ? `${result.note}; ` : ''}image call failed (HTTP ${attempt.status}${attempt.message ? `: ${attempt.message}` : ''})`;
      console.error(`  scene ${variant.id}: failed (HTTP ${attempt.status})`);
      results.push(result);
      continue;
    }
    result.bytes = attempt.bytes;
    const format = sniffImageFormat(attempt.bytes) ?? 'webp';
    result.contentType = `image/${format}`;
    result.fileName = `${runId}-front-scene-${variant.id}.${format === 'jpeg' ? 'jpg' : format}`;
    await Deno.writeFile(new URL(result.fileName, outputDir), attempt.bytes);
    result.costUsd = tally(PRIMARY_IMAGE_MODEL, attempt.usage, estimateImageCostUsd);
    result.usage = numericUsage(attempt.usage);
    console.log(
      `  scene ${variant.id}: ${result.usedSize}, ${Math.round(attempt.bytes.length / 1024)} KB, ` +
        `${result.costUsd === null ? 'cost unpriced' : `$${result.costUsd.toFixed(4)}`}`,
    );
    results.push(result);
  }
  return results;
}

// ── Review page ──────────────────────────────────────────────────────────

function esc(value: unknown): string {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function dataUrl(bytes: Uint8Array, contentType: string): string {
  return `data:${contentType};base64,${encodeBytesToBase64(bytes)}`;
}

function chips(verdict: FrontVerdict, expected: number): string {
  const chip = (label: string, tone: 'good' | 'warn' | 'bad' | 'neutral') => `<span class="chip ${tone}">${esc(label)}</span>`;
  return [
    chip(`${verdict.peopleVisible} visible / ${expected} tagged`, verdict.peopleVisible >= expected ? 'good' : 'neutral'),
    chip(verdict.allFacesVisible ? 'all faces visible' : 'a face is hidden', verdict.allFacesVisible ? 'good' : 'warn'),
    chip(verdict.eyesOpenMostly ? 'eyes open' : 'blinks / closed eyes', verdict.eyesOpenMostly ? 'good' : 'warn'),
    chip(`camera: ${verdict.lookingAtCamera}`, verdict.lookingAtCamera === 'most' ? 'good' : verdict.lookingAtCamera === 'some' ? 'neutral' : 'warn'),
    chip(`light: ${verdict.light}`, verdict.light === 'good' ? 'good' : verdict.light === 'ok' ? 'neutral' : 'bad'),
    chip(verdict.sharp ? 'sharp' : 'soft / blurry', verdict.sharp ? 'good' : 'bad'),
    chip(verdict.cropRisk ? 'crop risk' : 'crops safely', verdict.cropRisk ? 'warn' : 'good'),
    chip(verdict.setting, 'neutral'),
  ].join('');
}

/** A card-shaped (5:7 trim) box showing `src` cropped with object-fit: cover.
 * The dashed line is the 4 mm text-safe margin inside the trim. */
function cardMock(src: string, orientation: 'landscape' | 'portrait', label: string): string {
  const safe = orientation === 'landscape' ? '3.15% 2.25%' : '2.25% 3.15%';
  return `<figure class="mock ${orientation}">
  <div class="card"><img src="${src}" alt="${esc(label)}"><div class="safe" style="inset:${safe}"></div></div>
  <figcaption>${esc(label)}</figcaption>
</figure>`;
}

interface PageInput {
  runId: string;
  args: Args;
  familyName: string;
  coreNames: string[];
  counts: {
    poolPhotos: number;
    probed: number;
    eligible: number;
    candidates: number;
    previews: number;
    judged: number;
    picks: number;
    nearMisses: number;
  };
  dropped: Record<string, number>;
  ranking: FrontRanking;
  images: Map<string, PreviewImage>;
  scenes: SceneResult[];
  spend: { model: string; calls: number; usd: number; unpricedCalls: number }[];
}

const TOP_PICKS = 10;
const TOP_MOCKS = 3;

function renderPage(input: PageInput): string {
  const { ranking } = input;
  const top = ranking.picks.slice(0, TOP_PICKS);
  const imageSrc = (mediaId: string) => {
    const image = input.images.get(mediaId);
    return image ? dataUrl(image.bytes, image.contentType) : '';
  };
  const spendTotal = input.spend.reduce((sum, row) => sum + row.usd, 0);

  const mocks = top.slice(0, TOP_MOCKS).map((pick, index) =>
    cardMock(imageSrc(pick.candidate.mediaId), pick.candidate.cardOrientation, `#${index + 1} on a ${pick.candidate.cardOrientation} 5x7 card`)
  ).join('\n');

  const pickCards = top.map((pick, index) => {
    const c = pick.candidate;
    return `<article class="pick">
  <div class="rank">#${index + 1}<span>${pick.score.toFixed(1)}</span></div>
  <img class="photo" src="${imageSrc(c.mediaId)}" alt="Pick ${index + 1}" loading="lazy">
  <div class="meta">
    <p class="line"><strong>${esc(c.date)}</strong> · ${esc(c.orientation)} · ${c.width}×${c.height} px · print <b class="${c.printClass === 'full-bleed' ? 'ok' : 'mid'}">${esc(c.printClass)}</b> · card ${esc(c.cardOrientation)}${c.holiday ? ' · holiday topic' : ''}${c.wholeCore ? ' · whole core family tagged' : ''}</p>
    <div class="chips">${chips(pick.verdict, c.taggedMemberIds.length)}</div>
    <p class="why">${esc(pick.verdict.why)} <em>(judge ${pick.verdict.cardScore.toFixed(1)}/10)</em></p>
    <p class="notes">${esc(pick.notes.join(' · ') || 'no bonuses')}</p>
    <p class="ids">memory ${esc(c.memoryId.slice(0, 8))} · media ${esc(c.mediaId.slice(0, 8))}</p>
  </div>
</article>`;
  }).join('\n');

  const nearCards = ranking.nearMisses.map((miss) => {
    const c = miss.candidate;
    return `<article class="near">
  <img src="${imageSrc(c.mediaId)}" alt="Near miss" loading="lazy">
  <p class="line"><strong>${esc(c.date)}</strong> · ${esc(c.orientation)} · ${c.width}×${c.height} · ${esc(c.printClass)}</p>
  <p class="reason">${esc(miss.detail)}${miss.verdict ? ` · judge ${miss.verdict.cardScore.toFixed(1)}/10` : ''}</p>
  ${miss.verdict ? `<p class="why">${esc(miss.verdict.why)}</p>` : ''}
  <p class="ids">memory ${esc(c.memoryId.slice(0, 8))}</p>
</article>`;
  }).join('\n');

  const sceneCards = input.scenes.map((scene) => {
    if (!scene.bytes || !scene.contentType) {
      return `<article class="scene"><h3>${esc(scene.variant.id)}</h3><p class="why">No image: ${esc(scene.note ?? 'not generated')}</p></article>`;
    }
    const src = dataUrl(scene.bytes, scene.contentType);
    const [w, h] = (scene.usedSize ?? scene.requestedSize).split('x').map(Number);
    const orientation = w >= h ? 'landscape' : 'portrait';
    return `<article class="scene">
  <h3>${esc(scene.variant.id)} · ${esc(scene.usedSize)}${scene.usedSize !== scene.requestedSize ? ` (asked ${esc(scene.requestedSize)})` : ''}</h3>
  <div class="scene-row">
    <img class="photo" src="${src}" alt="Illustrated scene ${esc(scene.variant.id)}" loading="lazy">
    ${cardMock(src, orientation, `cropped to the ${orientation} 5x7 trim`)}
  </div>
  <p class="notes">${scene.referenceCount} portrait references · ${esc(PRIMARY_IMAGE_MODEL)} · quality ${IMAGE_QUALITY} · ${
    scene.costUsd === null ? 'cost unpriced' : `$${scene.costUsd.toFixed(3)}`
  }${scene.note ? ` · ${esc(scene.note)}` : ''}</p>
</article>`;
  }).join('\n');

  const spendRows = input.spend.map((row) =>
    `${esc(row.model)}: ${row.calls} call(s), ≈ $${row.usd.toFixed(3)}${row.unpricedCalls ? ` (+${row.unpricedCalls} unpriced)` : ''}`
  ).join(' · ') || 'no paid calls';
  const droppedText = Object.entries(input.dropped).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(' · ') || 'none';
  const hardDropped = Object.entries(ranking.dropped).map(([k, n]) => `${k} ${n}`).join(' · ') || 'none';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Holiday card front review</title>
<style>
:root{--bg:#faf7f2;--fg:#2a2622;--muted:#756c63;--card:#fff;--line:#e4ddd2;--ok:#2f7d4f;--mid:#9a6a1c;--bad:#b3402f;--accent:#6b4fa3}
@media(prefers-color-scheme:dark){:root{--bg:#1b1917;--fg:#eee9e2;--muted:#a79e93;--card:#262321;--line:#3a3531;--ok:#6cc08f;--mid:#e0a94d;--bad:#e5786a;--accent:#b8a1ea}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;padding:16px;max-width:1100px;margin-inline:auto}
h1{font-size:1.5rem;margin:.2rem 0}h2{font-size:1.15rem;margin:2rem 0 .6rem;border-bottom:1px solid var(--line);padding-bottom:.3rem}h3{font-size:1rem;margin:.2rem 0 .5rem}
.sub{color:var(--muted);font-size:.9rem;margin:.2rem 0}
.counts{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin:1rem 0}
.counts div{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 10px}.counts b{display:block;font-size:1.3rem}.counts span{color:var(--muted);font-size:.78rem}
.mocks{display:flex;flex-wrap:wrap;gap:20px;align-items:flex-end}
.mock{margin:0}.mock .card{position:relative;background:#fff;box-shadow:0 4px 18px rgba(0,0,0,.25);overflow:hidden}
.mock.landscape .card{width:min(100%,420px);aspect-ratio:177.8/127}.mock.portrait .card{width:min(100%,280px);aspect-ratio:127/177.8}
.mock .card img{width:100%;height:100%;object-fit:cover;display:block}.mock .safe{position:absolute;border:1px dashed rgba(255,255,255,.75);outline:1px dashed rgba(0,0,0,.35);pointer-events:none}
.mock figcaption{font-size:.8rem;color:var(--muted);margin-top:6px}
.pick{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:14px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;margin:14px 0;position:relative}
.pick .photo{width:100%;max-height:78vh;object-fit:contain;background:#0001;border-radius:8px}
.rank{position:absolute;top:8px;left:8px;background:var(--accent);color:#fff;border-radius:999px;padding:2px 10px;font-weight:700;font-size:.95rem;display:flex;gap:8px;align-items:baseline}.rank span{font-weight:400;font-size:.75rem;opacity:.85}
.line{margin:.2rem 0;font-size:.9rem}.ok{color:var(--ok)}.mid{color:var(--mid)}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:.5rem 0}.chip{font-size:.75rem;border-radius:999px;padding:2px 9px;border:1px solid var(--line);background:var(--bg)}
.chip.good{color:var(--ok);border-color:var(--ok)}.chip.warn{color:var(--mid);border-color:var(--mid)}.chip.bad{color:var(--bad);border-color:var(--bad)}
.why{margin:.4rem 0}.notes,.ids{color:var(--muted);font-size:.78rem;margin:.2rem 0}
.nears{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px}
.near{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px}.near img{width:100%;aspect-ratio:4/3;object-fit:contain;background:#0001;border-radius:6px}.near .reason{color:var(--bad);font-size:.82rem;margin:.2rem 0}.near .line{font-size:.78rem}.near .why{font-size:.8rem}
.scene{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;margin:14px 0}.scene-row{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start}.scene-row .photo{flex:1 1 320px;max-width:100%;max-height:70vh;object-fit:contain;border-radius:8px}
@media(max-width:700px){.pick{grid-template-columns:1fr}body{padding:12px}}
</style></head><body>
<h1>Holiday card front — review</h1>
<p class="sub">${esc(input.familyName)} · core family: ${esc(input.coreNames.join(', ') || '—')} · photos ${esc(frontPoolStart(input.args.today))} → ${esc(input.args.today)} · run ${esc(input.runId)}</p>
<p class="sub">Questions: is the top pick the photo you'd choose? Is the illustrated scene card-worthy? · Judge model ${esc(FRONT_JUDGE_MODEL)} · ${esc(spendRows)} · total ≈ $${spendTotal.toFixed(3)}</p>
<div class="counts">
  <div><b>${input.counts.poolPhotos}</b><span>photos in the pool (≥2 tagged, share-safe)</span></div>
  <div><b>${input.counts.eligible}</b><span>print-ready candidates</span></div>
  <div><b>${input.counts.judged}</b><span>judged by vision (cap ${input.args.maxVision})</span></div>
  <div><b>${ranking.picks.length}</b><span>ranked picks</span></div>
  <div><b>${ranking.nearMisses.length}</b><span>near-misses shown</span></div>
</div>
<p class="sub">Dropped before vision: ${esc(droppedText)}. Dropped by the judge: ${esc(hardDropped)}${ranking.unjudged ? `; ${ranking.unjudged} not judged` : ''}.</p>

<h2>Top 3 on a card</h2>
<p class="sub">Cropped to the 5:7 trim in the photo's own orientation. The dashed line is the 4 mm text-safe margin.</p>
<div class="mocks">${mocks || '<p>No picks.</p>'}</div>

<h2>Top ${top.length} photo picks</h2>
${pickCards || '<p>No picks.</p>'}

<h2>Near-misses</h2>
<p class="sub">Good photos the rules or the judge kept out, or duplicates of a higher pick.</p>
<div class="nears">${nearCards || '<p>None.</p>'}</div>

<h2>Illustrated holiday scenes</h2>
<p class="sub">${input.scenes.length ? `Built from each core member's current illustrated portrait, house storybook style, no text, space left for a greeting.` : 'Skipped (--no-illustrations, or no ready portraits).'}</p>
${sceneCards}
</body></html>
`;
}

// ── Main ─────────────────────────────────────────────────────────────────

const args = parseArgs(Deno.args);
const supabase = await createAuthedClient();
const { data: families, error: familiesError } = await supabase
  .from('families')
  .select('id, name, illustration_style')
  .order('id');
if (familiesError) throw new Error(`Failed to load families: ${familiesError.message}`);

function pickInputOf(data: FamilyData, today: string, maxVision: number): FrontPickInput {
  return {
    today,
    members: data.members.map((m) => ({ id: m.id, dateOfBirth: m.date_of_birth, relationship: m.relationship })),
    memories: data.memories satisfies FrontPickMemory[],
    milestones: data.milestones,
    maxVision,
  };
}

interface FamilyPool {
  data: FamilyData;
  input: FrontPickInput;
  front: FrontPool;
}

const pools: FamilyPool[] = [];
for (const family of (families ?? []) as FamilyRow[]) {
  if (args.familyId && family.id !== args.familyId) continue;
  const data = await loadFamilyData(supabase, family);
  const input = pickInputOf(data, args.today, args.maxVision);
  const front = buildFrontPool(input);
  pools.push({ data, input, front });
  console.log(`family ${family.id}: ${front.pool.length} front-pool photos (of ${front.rawPhotos.length} photos)`);
}
if (pools.length === 0) throw new Error('No family to evaluate');
const chosen = pools.reduce((best, p) => (p.front.pool.length > best.front.pool.length ? p : best));
console.log(`evaluating family ${chosen.data.family.id}`);

const { data } = chosen;
const pool = chosen.front.pool;
getR2Config(); // fail fast with a clear error when R2 env is missing

// Probe, candidates, previews, judge and ranking: the production module.
const run = await runFrontPipeline(chosen.input, frontPorts);
const { selection, previews, verdicts, ranking } = run;
const core = run.coreMemberIds;
console.log(
  `judged ${verdicts.size}/${selection.candidates.length}: ${ranking.picks.length} picks, ` +
    `${ranking.nearMisses.length} near-misses, hard-dropped ${JSON.stringify(ranking.dropped)}, unjudged ${ranking.unjudged}`,
);
ranking.picks.slice(0, 10).forEach((pick, index) =>
  console.log(
    `  #${index + 1} memory ${pick.candidate.memoryId} media ${pick.candidate.mediaId} ${pick.candidate.date} ` +
      `score ${pick.score.toFixed(2)} (judge ${pick.verdict.cardScore})`,
  )
);

const outputDir = new URL('./eval-output/holiday-card/', import.meta.url);
await Deno.mkdir(outputDir, { recursive: true });
const runId = new Date().toISOString().replace(/[:.]/g, '-');

// `--scenes-from <runId>` reuses that run's scenes whose variants still exist
// (no image calls); `--scenes a,b` generates only those variants. Together they
// give one page with reused + fresh scenes.
const reusedScenes = args.scenesFrom ? await loadScenes(args.scenesFrom, outputDir) : [];
const generateNow = args.illustrations && (args.scenes !== null || args.scenesFrom === null);
const freshScenes = generateNow ? await generateScenes(data, args, runId, outputDir) : [];
const sceneOrder = HOLIDAY_SCENE_VARIANTS.map((v) => v.id as string);
const scenes = [...reusedScenes.filter((s) => !freshScenes.some((f) => f.variant.id === s.variant.id)), ...freshScenes]
  .sort((a, b) => sceneOrder.indexOf(a.variant.id) - sceneOrder.indexOf(b.variant.id));

const spend = [...usageByModel.entries()].map(([model, t]) => ({
  model,
  calls: t.calls,
  usd: t.usd,
  unpricedCalls: t.unpricedCalls,
}));
const coreNames = data.members.filter((m) => core.has(m.id)).map((m) => firstName(m.name));
const familyChildren = data.members.filter((m) =>
  isFilmChild({ id: m.id, dateOfBirth: m.date_of_birth, relationship: m.relationship }, args.today)
).length;

const pageInput: PageInput = {
  runId,
  args,
  familyName: data.family.name,
  coreNames,
  counts: {
    poolPhotos: pool.length,
    probed: run.probedKeys,
    eligible: selection.eligible,
    candidates: selection.candidates.length,
    previews: previews.size,
    judged: verdicts.size,
    picks: ranking.picks.length,
    nearMisses: ranking.nearMisses.length,
  },
  dropped: selection.dropped as Record<string, number>,
  ranking,
  images: previews,
  scenes,
  spend,
};
const htmlPath = new URL(`${runId}-front.html`, outputDir);
await Deno.writeTextFile(htmlPath, renderPage(pageInput));
await Deno.writeTextFile(
  new URL(`${runId}-front.json`, outputDir),
  JSON.stringify(
    {
      runId,
      args,
      familyId: data.family.id,
      coreMemberCount: core.size,
      childCount: familyChildren,
      counts: pageInput.counts,
      dropped: selection.dropped,
      hardDropped: ranking.dropped,
      unjudged: ranking.unjudged,
      judgeModel: FRONT_JUDGE_MODEL,
      picks: ranking.picks.map((p) => ({ candidate: p.candidate, verdict: p.verdict, score: p.score, notes: p.notes })),
      nearMisses: ranking.nearMisses.map((n) => ({ candidate: n.candidate, verdict: n.verdict, reason: n.reason, detail: n.detail })),
      scenes: scenes.map((s) => ({
        variant: s.variant.id,
        requestedSize: s.requestedSize,
        usedSize: s.usedSize,
        note: s.note,
        file: s.fileName,
        referenceCount: s.referenceCount,
        costUsd: s.costUsd,
        usage: s.usage,
        model: PRIMARY_IMAGE_MODEL,
        quality: IMAGE_QUALITY,
        prompt: s.prompt,
      })),
      imageGenerations,
      usage: [...usageByModel.entries()].map(([model, t]) => ({ model, ...t })),
    },
    null,
    2,
  ),
);
for (const row of spend) {
  console.log(`spend: ${row.model} ${row.calls} call(s) ≈ $${row.usd.toFixed(4)}${row.unpricedCalls ? ` (+${row.unpricedCalls} unpriced)` : ''}`);
}
console.log(`image generations: ${imageGenerations}/${MAX_IMAGE_GENERATIONS}`);
console.log(`review page: ${htmlPath.pathname}`);
