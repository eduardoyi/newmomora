/**
 * Local image-generation cost eval — runs real OpenAI `/v1/images/edits`
 * calls against real memories/family members in this account, captures the
 * `usage` object from each response, and computes actual per-generation
 * cost (with a focus on how reference-image count drives input-token cost).
 *
 * This intentionally reimplements a minimal edit-image call (with `usage`
 * capture) rather than reusing `_shared/openai.ts`'s `editImageWithModel` --
 * that helper discards `usage` and production code is out of scope for this
 * eval.
 *
 * Examples:
 *   npm run eval:image-cost -- --memory-id <uuid> --dry-run
 *   npm run eval:image-cost -- --memory-id <uuid> --memory-id <uuid> --cells baseline,quality-sweep --yes
 *   npm run eval:image-cost -- --search "meltdown" --limit 5 --cells baseline,fallback-model,smaller-refs
 *   npm run eval:image-cost -- --member-id <uuid> --cells baseline,quality-sweep --repeats 3
 *
 * Requires OPENAI_API_KEY + R2/Supabase vars in supabase/.env.local.
 * DB/OpenAI env access is not available in every environment this script
 * runs in -- it must typecheck even when it cannot be executed.
 *
 * This is a paid-call eval: it prints the planned call matrix and a rough
 * worst-case cost before spending money, and prompts for confirmation
 * unless --yes is passed. Use --dry-run to see the plan without spending.
 */
import { toFileUrl } from 'jsr:@std/path@1/to-file-url';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { describeAgeAtDate, isAdultAtDate } from '../functions/_shared/age.ts';
import { capImageMaxEdge } from '../functions/_shared/image-bytes.ts';
import { MAX_PORTRAIT_REFERENCE_EDGE } from '../functions/_shared/image-limits.ts';
import { stripUrls } from '../functions/_shared/link-preview.ts';
import {
  prepareIllustrationReferences,
  sortMembersByTagOrder,
  type IllustrationFamilyMember,
} from '../functions/_shared/illustration-references.ts';
import { resolveMemberIdsForIllustration } from '../functions/_shared/illustration-members.ts';
import {
  buildIllustrationPrompt,
  buildPortraitPrompt,
  buildSafetySystemPrompt,
  EMOTION_PALETTES,
  normalizeEmotion,
  type SafetyPromptMember,
} from '../functions/_shared/prompts.ts';
import {
  chatJson,
  decodeBase64ToBytes,
  FALLBACK_IMAGE_MODEL,
  PRIMARY_IMAGE_MODEL,
  type OpenAiImageQuality,
  type ReferenceImageInput,
} from '../functions/_shared/openai.ts';
import {
  DEFAULT_ILLUSTRATION_STYLE_TOKEN,
  getIllustrationStyle,
  getStyleDescription,
} from '../functions/_shared/styles.ts';
import { getObjectBytes } from '../functions/_shared/r2.ts';

// ── Pricing ──────────────────────────────────────────────────────────────
// OpenAI Images API pricing, per 1M tokens, captured from the OpenAI
// pricing page on 2026-07-23. Update the date + values if pricing changes.
// `output` is the image-output rate; `textOutput` applies to
// `output_tokens_details.text_tokens` (gpt-image-1.5 emits them; gpt-image-2
// does not, so its textOutput is unused).
const IMAGE_MODEL_PRICING_PER_1M_TOKENS_USD = {
  'gpt-image-2': { text: 5.0, image: 8.0, output: 30.0, textOutput: 30.0 },
  'gpt-image-1.5': { text: 5.0, image: 8.0, output: 32.0, textOutput: 10.0 },
} as const;

const ROUGH_WORST_CASE_COST_PER_CALL_USD = 0.25;

const ALLOWED_EXPRESSION_STYLES = new Set(['comedic', 'tender', 'neutral']);
type ExpressionStyle = 'comedic' | 'tender' | 'neutral';

type CellName = 'baseline' | 'quality-sweep' | 'fallback-model' | 'fallback-no-fidelity' | 'smaller-refs';
const ALL_CELLS: CellName[] = ['baseline', 'quality-sweep', 'fallback-model', 'fallback-no-fidelity', 'smaller-refs'];
const PORTRAIT_ALLOWED_CELLS: Set<CellName> = new Set(['baseline', 'quality-sweep']);
const SMALLER_REFS_MAX_EDGE = 512;

interface CliOptions {
  memoryIds: string[];
  search?: string;
  limit: number;
  memberIds: string[];
  repeats: number;
  cells: CellName[];
  model?: string;
  outputDir: URL;
  yes: boolean;
  dryRun: boolean;
  listMembers: boolean;
}

interface EvalMemoryRow {
  id: string;
  family_id: string;
  content: string | null;
  memory_date: string;
  emotion: string | null;
  illustration_key: string | null;
  memory_type: string;
}

/** A resolved generation target: a memory or family member, with a fixed
 * prompt and reference set. Cells vary quality/model/reference-size on top
 * of this. */
interface ResolvedTarget {
  kind: 'memory' | 'member';
  id: string;
  slug: string;
  prompt: string;
  referenceImages: ReferenceImageInput[];
  referenceCount: number;
  normalMaxEdge: number;
}

interface CallSpec {
  cell: CellName;
  qualityLabel: string;
  quality?: OpenAiImageQuality;
  model: string;
  smallerRefs: boolean;
  /** Omit `input_fidelity` even where production would send `high`. */
  noInputFidelity?: boolean;
}

interface UsageInputTokensDetails {
  text_tokens?: number;
  image_tokens?: number;
}

interface UsageOutputTokensDetails {
  text_tokens?: number;
  image_tokens?: number;
}

interface OpenAiImageUsage {
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: UsageInputTokensDetails;
  output_tokens_details?: UsageOutputTokensDetails;
}

interface CostBreakdown {
  inputTextCost: number;
  inputImageCost: number;
  outputCost: number;
  totalCost: number;
  costIsEstimate: boolean;
  textTokens: number;
  imageTokens: number;
  outputTokens: number;
}

interface JobResult {
  target: ResolvedTarget;
  call: CallSpec;
  repeat: number;
  cellLabel: string;
  usage: OpenAiImageUsage | undefined;
  cost: CostBreakdown;
  durationMs: number;
  ok: boolean;
}

const defaultOutputDir = new URL('./eval-output/', import.meta.url);

function resolveOutputPath(path: string): URL {
  const base = path.startsWith('/') ? toFileUrl(path) : toFileUrl(`${Deno.cwd()}/${path}`);
  return new URL(base.href.endsWith('/') ? base.href : `${base.href}/`);
}

function parseCells(raw: string): CellName[] {
  const cells = raw.split(',').map((entry) => entry.trim()).filter(Boolean) as CellName[];
  const invalid = cells.filter((cell) => !ALL_CELLS.includes(cell));

  if (invalid.length > 0) {
    console.error(`Unknown --cells value(s): ${invalid.join(', ')}. Allowed: ${ALL_CELLS.join(', ')}`);
    Deno.exit(1);
  }

  return cells;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    memoryIds: [],
    limit: 3,
    memberIds: [],
    repeats: 2,
    cells: ['baseline'],
    outputDir: defaultOutputDir,
    yes: false,
    dryRun: false,
    listMembers: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    switch (arg) {
      case '--memory-id':
        options.memoryIds.push(next);
        index += 1;
        break;
      case '--search':
        options.search = next;
        index += 1;
        break;
      case '--limit':
        options.limit = Number(next) || 3;
        index += 1;
        break;
      case '--member-id':
        options.memberIds.push(next);
        index += 1;
        break;
      case '--repeats':
        options.repeats = Math.max(1, Number(next) || 2);
        index += 1;
        break;
      case '--cells':
        options.cells = parseCells(next);
        index += 1;
        break;
      case '--model':
        options.model = next;
        index += 1;
        break;
      case '--output-dir':
        options.outputDir = resolveOutputPath(next);
        index += 1;
        break;
      case '--yes':
        options.yes = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--list-members':
        options.listMembers = true;
        break;
      default:
        break;
    }
  }

  return options;
}

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

function slugifyText(text: string | null, fallback: string): string {
  const slug = (text ?? fallback)
    .trim()
    .toLowerCase()
    .slice(0, 40)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || fallback;
}

// ── Memory resolution (mirrors eval-illustration.ts) ────────────────────

async function loadMemoriesById(
  supabase: Awaited<ReturnType<typeof createAuthedClient>>,
  memoryIds: string[],
): Promise<EvalMemoryRow[]> {
  const { data, error } = await supabase
    .from('memories')
    .select('id, family_id, content, memory_date, emotion, illustration_key, memory_type')
    .in('id', memoryIds);

  if (error) {
    throw new Error(`Failed to load memories: ${error.message}`);
  }

  return (data ?? []) as EvalMemoryRow[];
}

async function loadMemoriesBySearch(
  supabase: Awaited<ReturnType<typeof createAuthedClient>>,
  search: string,
  limit: number,
): Promise<EvalMemoryRow[]> {
  const { data, error } = await supabase
    .from('memories')
    .select('id, family_id, content, memory_date, emotion, illustration_key, memory_type')
    .eq('memory_type', 'text_illustration')
    .ilike('content', `%${search}%`)
    .order('memory_date', { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to search memories: ${error.message}`);
  }

  return (data ?? []) as EvalMemoryRow[];
}

async function resolveReadyMembers(
  supabase: Awaited<ReturnType<typeof createAuthedClient>>,
  memory: EvalMemoryRow,
): Promise<{ readyMembers: IllustrationFamilyMember[]; safetyMembers: SafetyPromptMember[] }> {
  const { data: tagRows, error: tagError } = await supabase
    .from('memory_family_members')
    .select('family_member_id')
    .eq('memory_id', memory.id);

  if (tagError) {
    throw new Error(`Failed to load memory tags: ${tagError.message}`);
  }

  const taggedMemberIds = (tagRows ?? []).map((row: { family_member_id: string }) => row.family_member_id);

  const { data: nameRows, error: nameRowsError } = await supabase
    .from('family_members')
    .select('id, name, nicknames')
    .eq('family_id', memory.family_id);

  if (nameRowsError) {
    throw new Error(`Failed to load family member names: ${nameRowsError.message}`);
  }

  const safetyMembers: SafetyPromptMember[] = nameRows ?? [];

  const memberIds = resolveMemberIdsForIllustration(
    taggedMemberIds,
    stripUrls(memory.content ?? ''),
    nameRows ?? [],
  );

  if (memberIds.length === 0) {
    return { readyMembers: [], safetyMembers };
  }

  const { data: members, error: membersError } = await supabase
    .from('family_members')
    .select(
      'id, name, nicknames, date_of_birth, gender, additional_info, illustrated_profile_key, illustrated_profile_status, profile_picture_key',
    )
    .eq('family_id', memory.family_id)
    .in('id', memberIds);

  if (membersError) {
    throw new Error(`Failed to load family members: ${membersError.message}`);
  }

  interface MemberRow extends IllustrationFamilyMember {
    illustrated_profile_status: string | null;
  }

  const readyMembers = sortMembersByTagOrder(
    ((members ?? []) as MemberRow[]).filter(
      (member) => member.illustrated_profile_status === 'ready' && member.illustrated_profile_key,
    ),
    memberIds,
  );

  return { readyMembers, safetyMembers };
}

async function resolveMemoryTarget(
  supabase: Awaited<ReturnType<typeof createAuthedClient>>,
  memory: EvalMemoryRow,
): Promise<ResolvedTarget | null> {
  const slug = slugifyText(memory.content, 'memory');

  if (memory.memory_type !== 'text_illustration' || !memory.content?.trim()) {
    console.error(`  ✗ [${slug}] skipped: not a text_illustration memory with content`);
    return null;
  }

  const strippedContent = stripUrls(memory.content);

  if (!strippedContent.trim()) {
    console.error(`  ✗ [${slug}] skipped: empty content after stripping URLs`);
    return null;
  }

  const { readyMembers, safetyMembers } = await resolveReadyMembers(supabase, memory);

  if (readyMembers.length === 0) {
    console.error(`  ✗ [${slug}] skipped: no ready character portraits for tagged/mentioned members`);
    return null;
  }

  const { data: family } = await supabase
    .from('families')
    .select('illustration_style')
    .eq('id', memory.family_id)
    .maybeSingle();

  const styleDescription = getStyleDescription(
    family?.illustration_style ?? DEFAULT_ILLUSTRATION_STYLE_TOKEN,
  );

  const normalizedEmotion = normalizeEmotion(memory.emotion);
  const resolvedPalette = (normalizedEmotion ? EMOTION_PALETTES[normalizedEmotion] : undefined) ??
    EMOTION_PALETTES.tender;

  const safety = await chatJson<{ safeDescription?: string; expressionStyle?: string }>(
    buildSafetySystemPrompt(safetyMembers),
    strippedContent,
  );

  const safeDescription = safety.safeDescription?.trim() || strippedContent.slice(0, 280);
  const expressionStyle: ExpressionStyle = ALLOWED_EXPRESSION_STYLES.has(safety.expressionStyle ?? '')
    ? (safety.expressionStyle as ExpressionStyle)
    : 'neutral';

  const { characterReferences, referenceImages } = await prepareIllustrationReferences(
    readyMembers,
    memory.memory_date,
    getObjectBytes,
  );

  if (referenceImages.length === 0) {
    console.error(`  ✗ [${slug}] skipped: failed to load portrait references`);
    return null;
  }

  const prompt = buildIllustrationPrompt({
    safeSceneDescription: safeDescription,
    characterReferences,
    colorPalette: resolvedPalette,
    memoryDate: memory.memory_date,
    styleDescription,
    emotion: memory.emotion,
    expressionStyle,
  });

  return {
    kind: 'memory',
    id: memory.id,
    slug,
    prompt,
    referenceImages,
    referenceCount: referenceImages.length,
    normalMaxEdge: 1024, // MAX_ILLUSTRATION_REFERENCE_EDGE, see illustration-references.ts
  };
}

// ── Member/portrait resolution (mirrors eval-portrait.ts default variant) ─

interface FamilyMemberRow {
  id: string;
  name: string;
  date_of_birth: string | null;
  gender: string | null;
  additional_info: string | null;
  profile_picture_key: string | null;
}

async function resolveMemberTarget(
  supabase: Awaited<ReturnType<typeof createAuthedClient>>,
  memberId: string,
): Promise<ResolvedTarget | null> {
  const { data: member, error } = await supabase
    .from('family_members')
    .select('id, name, date_of_birth, gender, additional_info, profile_picture_key')
    .eq('id', memberId)
    .maybeSingle();

  const memberRow = member as FamilyMemberRow | null;

  if (error || !memberRow?.profile_picture_key) {
    console.error(`  ✗ [${memberId}] skipped: ${error?.message ?? 'family member or profile photo not found'}`);
    return null;
  }

  const slug = slugifyText(memberRow.name, 'member');
  const photoBytes = await getObjectBytes(memberRow.profile_picture_key);
  const styleBytes = await Deno.readFile(new URL('../../assets/styles/default.png', import.meta.url));

  const referenceDate = new Date().toISOString().slice(0, 10);
  const ageDescription = memberRow.date_of_birth
    ? describeAgeAtDate(memberRow.date_of_birth, referenceDate)
    : 'young child';
  const isAdult = memberRow.date_of_birth ? isAdultAtDate(memberRow.date_of_birth, referenceDate) : false;
  const defaultStyle = getIllustrationStyle(DEFAULT_ILLUSTRATION_STYLE_TOKEN);

  const cappedPhoto = await capImageMaxEdge(photoBytes, MAX_PORTRAIT_REFERENCE_EDGE, 'image/jpeg');
  const cappedStyle = await capImageMaxEdge(styleBytes, MAX_PORTRAIT_REFERENCE_EDGE, 'image/png');

  // Style-first ordering, matching eval-portrait.ts's default character-design variant.
  const referenceImages: ReferenceImageInput[] = [
    { bytes: cappedStyle.bytes, contentType: cappedStyle.contentType, filename: 'reference-1-style.png' },
    { bytes: cappedPhoto.bytes, contentType: cappedPhoto.contentType, filename: 'reference-2-person-photo.jpg' },
  ];

  const prompt = buildPortraitPrompt({
    name: memberRow.name,
    ageDescription,
    isAdult,
    gender: memberRow.gender,
    styleToken: defaultStyle.token,
    additionalInfo: memberRow.additional_info,
  });

  return {
    kind: 'member',
    id: memberRow.id,
    slug,
    prompt,
    referenceImages,
    referenceCount: referenceImages.length,
    normalMaxEdge: MAX_PORTRAIT_REFERENCE_EDGE,
  };
}

// ── Cell -> call-spec expansion ──────────────────────────────────────────

function buildCallSpecsForCell(cell: CellName, baselineModel: string): CallSpec[] {
  switch (cell) {
    case 'baseline':
      return [{ cell, qualityLabel: 'medium', quality: 'medium', model: baselineModel, smallerRefs: false }];
    case 'quality-sweep':
      return [
        { cell, qualityLabel: 'auto', quality: undefined, model: baselineModel, smallerRefs: false },
        { cell, qualityLabel: 'low', quality: 'low', model: baselineModel, smallerRefs: false },
        { cell, qualityLabel: 'medium', quality: 'medium', model: baselineModel, smallerRefs: false },
      ];
    case 'fallback-model':
      return [{ cell, qualityLabel: 'medium', quality: 'medium', model: FALLBACK_IMAGE_MODEL, smallerRefs: false }];
    case 'fallback-no-fidelity':
      return [{
        cell,
        qualityLabel: 'medium',
        quality: 'medium',
        model: FALLBACK_IMAGE_MODEL,
        smallerRefs: false,
        noInputFidelity: true,
      }];
    case 'smaller-refs':
      return [{ cell, qualityLabel: 'medium', quality: 'medium', model: baselineModel, smallerRefs: true }];
    default:
      return [];
  }
}

function cellLabelFor(call: CallSpec): string {
  return call.cell === 'quality-sweep' ? `quality-sweep-${call.qualityLabel}` : call.cell;
}

// ── OpenAI edit-image call with usage capture ────────────────────────────

function getOpenAiKeyOrThrow(): string {
  const apiKey = Deno.env.get('OPENAI_API_KEY');

  if (!apiKey) {
    throw new Error('Missing OPENAI_API_KEY in supabase/.env.local');
  }

  return apiKey;
}

interface EditImageWithUsageResult {
  bytes: Uint8Array;
  usage: OpenAiImageUsage | undefined;
  requestParams: Record<string, unknown>;
}

async function editImageWithUsage(
  prompt: string,
  referenceImages: ReferenceImageInput[],
  model: string,
  options: { quality?: OpenAiImageQuality; noInputFidelity?: boolean } = {},
): Promise<EditImageWithUsageResult | null> {
  const apiKey = getOpenAiKeyOrThrow();
  const usesInputFidelity = !options.noInputFidelity &&
    referenceImages.length > 1 && model === FALLBACK_IMAGE_MODEL;

  const formData = new FormData();
  formData.append('model', model);
  formData.append('prompt', prompt);
  formData.append('size', '1024x1024');
  if (options.quality) {
    formData.append('quality', options.quality);
  }
  formData.append('output_format', 'webp');
  formData.append('output_compression', '85');
  if (usesInputFidelity) {
    formData.append('input_fidelity', 'high');
  }

  for (const referenceImage of referenceImages) {
    formData.append(
      'image[]',
      // Deno 2.9's TS treats `Uint8Array<ArrayBufferLike>` as non-BlobPart;
      // these bytes are always backed by a real ArrayBuffer at runtime.
      new Blob([referenceImage.bytes as Uint8Array<ArrayBuffer>], { type: referenceImage.contentType }),
      referenceImage.filename,
    );
  }

  const requestParams: Record<string, unknown> = {
    model,
    size: '1024x1024',
    quality: options.quality ?? 'auto',
    output_format: 'webp',
    output_compression: 85,
    input_fidelity: usesInputFidelity ? 'high' : undefined,
    referenceCount: referenceImages.length,
  };

  const response = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`  ✗ OpenAI image edit failed (${model}, ${response.status}): ${errorBody.slice(0, 240)}`);
    return null;
  }

  const payload = await response.json();
  const base64 = payload.data?.[0]?.b64_json;

  if (!base64 || typeof base64 !== 'string') {
    console.error(`  ✗ OpenAI image edit returned empty image (${model})`);
    return null;
  }

  return { bytes: decodeBase64ToBytes(base64), usage: payload.usage, requestParams };
}

// ── Cost computation ─────────────────────────────────────────────────────

function computeCost(model: string, usage: OpenAiImageUsage | undefined): CostBreakdown {
  const rates = IMAGE_MODEL_PRICING_PER_1M_TOKENS_USD[model as keyof typeof IMAGE_MODEL_PRICING_PER_1M_TOKENS_USD] ??
    IMAGE_MODEL_PRICING_PER_1M_TOKENS_USD['gpt-image-2'];

  const outputTokens = usage?.output_tokens ?? 0;
  const detailedTextTokens = usage?.input_tokens_details?.text_tokens;
  const detailedImageTokens = usage?.input_tokens_details?.image_tokens;

  let textTokens: number;
  let imageTokens: number;
  let costIsEstimate: boolean;

  if (detailedTextTokens !== undefined && detailedImageTokens !== undefined) {
    textTokens = detailedTextTokens;
    imageTokens = detailedImageTokens;
    costIsEstimate = false;
  } else {
    // input_tokens_details missing from the response: fall back to
    // treating all input tokens as image tokens (the dominant cost driver
    // for edit calls) and flag the resulting cost as an estimate.
    textTokens = 0;
    imageTokens = usage?.input_tokens ?? 0;
    costIsEstimate = true;
  }

  // gpt-image-1.5 emits text output tokens billed at a cheaper rate than
  // image output tokens; split them when the response provides the detail.
  const detailedOutputImageTokens = usage?.output_tokens_details?.image_tokens;
  const detailedOutputTextTokens = usage?.output_tokens_details?.text_tokens;

  let outputCost: number;
  if (detailedOutputImageTokens !== undefined && detailedOutputTextTokens !== undefined) {
    outputCost = (detailedOutputImageTokens / 1e6) * rates.output +
      (detailedOutputTextTokens / 1e6) * rates.textOutput;
  } else {
    outputCost = (outputTokens / 1e6) * rates.output;
    if (rates.textOutput !== rates.output) {
      costIsEstimate = true;
    }
  }

  const inputTextCost = (textTokens / 1e6) * rates.text;
  const inputImageCost = (imageTokens / 1e6) * rates.image;

  return {
    inputTextCost,
    inputImageCost,
    outputCost,
    totalCost: inputTextCost + inputImageCost + outputCost,
    costIsEstimate,
    textTokens,
    imageTokens,
    outputTokens,
  };
}

// ── Reference resizing for the smaller-refs cell ─────────────────────────

async function recapReferencesToEdge(
  referenceImages: ReferenceImageInput[],
  maxEdge: number,
): Promise<ReferenceImageInput[]> {
  const recapped: ReferenceImageInput[] = [];

  for (const referenceImage of referenceImages) {
    const capped = await capImageMaxEdge(referenceImage.bytes, maxEdge, referenceImage.contentType);
    recapped.push({
      bytes: capped.bytes,
      contentType: capped.contentType,
      filename: referenceImage.filename,
    });
  }

  return recapped;
}

// ── Artifact writing ─────────────────────────────────────────────────────

async function writeJobArtifacts(
  runDir: URL,
  cellLabel: string,
  target: ResolvedTarget,
  repeat: number,
  imageBytes: Uint8Array | null,
  meta: Record<string, unknown>,
): Promise<string> {
  const jobDir = new URL(`${cellLabel}-${target.slug}-r${repeat}/`, runDir);
  await Deno.mkdir(jobDir, { recursive: true });

  if (imageBytes) {
    await Deno.writeFile(new URL('image.webp', jobDir), imageBytes);
  }

  await Deno.writeFile(new URL('prompt.txt', jobDir), new TextEncoder().encode(target.prompt));
  await Deno.writeFile(new URL('meta.json', jobDir), new TextEncoder().encode(JSON.stringify(meta, null, 2)));

  return jobDir.pathname;
}

// ── Summary formatting ────────────────────────────────────────────────────

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

interface SummaryRow {
  cellLabel: string;
  targetLabel: string;
  model: string;
  qualityLabel: string;
  referenceCount: number;
  meanImageInTokens: number;
  meanTextInTokens: number;
  meanOutTokens: number;
  meanCostPerCall: number;
  okCalls: number;
  attemptedCalls: number;
  anyEstimate: boolean;
}

function buildSummaryRows(results: JobResult[]): SummaryRow[] {
  const groups = new Map<string, JobResult[]>();

  for (const result of results) {
    const key = `${result.cellLabel}::${result.target.kind}:${result.target.id}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(result);
    groups.set(key, bucket);
  }

  const rows: SummaryRow[] = [];

  for (const bucket of groups.values()) {
    const okResults = bucket.filter((result) => result.ok);
    const count = okResults.length;
    const first = bucket[0];

    rows.push({
      cellLabel: first.cellLabel,
      targetLabel: `${first.target.kind}:${first.target.slug}`,
      model: first.call.model,
      qualityLabel: first.call.qualityLabel,
      referenceCount: first.target.referenceCount,
      meanImageInTokens: count > 0 ? okResults.reduce((sum, r) => sum + r.cost.imageTokens, 0) / count : 0,
      meanTextInTokens: count > 0 ? okResults.reduce((sum, r) => sum + r.cost.textTokens, 0) / count : 0,
      meanOutTokens: count > 0 ? okResults.reduce((sum, r) => sum + r.cost.outputTokens, 0) / count : 0,
      meanCostPerCall: count > 0 ? okResults.reduce((sum, r) => sum + r.cost.totalCost, 0) / count : 0,
      okCalls: count,
      attemptedCalls: bucket.length,
      anyEstimate: okResults.some((r) => r.cost.costIsEstimate),
    });
  }

  return rows.sort((a, b) => a.referenceCount - b.referenceCount);
}

function renderSummaryTable(rows: SummaryRow[]): string {
  const header = [
    'cell',
    'target',
    'model',
    'quality',
    'refs',
    'image_in',
    'text_in',
    'out',
    'mean $/call',
    'calls',
  ];
  const lines = [header.join(' | ')];

  for (const row of rows) {
    lines.push([
      row.cellLabel,
      row.targetLabel,
      row.model,
      row.qualityLabel,
      String(row.referenceCount),
      row.meanImageInTokens.toFixed(0),
      row.meanTextInTokens.toFixed(0),
      row.meanOutTokens.toFixed(0),
      `${formatUsd(row.meanCostPerCall)}${row.anyEstimate ? '*' : ''}`,
      row.okCalls === row.attemptedCalls ? String(row.attemptedCalls) : `${row.okCalls}/${row.attemptedCalls}`,
    ].join(' | '));
  }

  return lines.join('\n');
}

// Only aggregates calls whose spec matches production baseline behavior
// (medium quality, full-size refs, the run's baseline model) -- this
// correctly includes baseline cells AND the medium leg of quality-sweep
// (more samples), while excluding auto/low quality, fallback-model, and
// smaller-refs, whose deliberately-different configs would otherwise skew
// the headline mean $/generation curve.
function buildPerRefCountAggregate(results: JobResult[], baselineModel: string): string {
  const okResults = results.filter(
    (result) =>
      result.ok &&
      result.call.qualityLabel === 'medium' &&
      !result.call.smallerRefs &&
      result.call.model === baselineModel,
  );
  const groups = new Map<number, JobResult[]>();

  for (const result of okResults) {
    const bucket = groups.get(result.target.referenceCount) ?? [];
    bucket.push(result);
    groups.set(result.target.referenceCount, bucket);
  }

  const lines: string[] = [];
  for (const refCount of [...groups.keys()].sort((a, b) => a - b)) {
    const bucket = groups.get(refCount)!;
    const meanImageTokens = bucket.reduce((sum, r) => sum + r.cost.imageTokens, 0) / bucket.length;
    const meanTotalCost = bucket.reduce((sum, r) => sum + r.cost.totalCost, 0) / bucket.length;
    lines.push(
      `  refs=${refCount}: mean image_in_tokens=${meanImageTokens.toFixed(0)}, mean $/generation=${formatUsd(meanTotalCost)} (n=${bucket.length})`,
    );
  }

  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────

const options = parseArgs(Deno.args);

if (options.listMembers) {
  const client = await createAuthedClient();
  const { data, error } = await client
    .from('family_members')
    .select('id, name, illustrated_profile_status, profile_picture_key')
    .order('name');

  if (error) {
    console.error(`Failed to list family members: ${error.message}`);
    Deno.exit(1);
  }

  for (const row of data ?? []) {
    const photo = row.profile_picture_key ? 'photo' : 'no-photo';
    console.log(`${row.id}  ${photo}  portrait=${row.illustrated_profile_status ?? '(none)'}  ${row.name}`);
  }

  Deno.exit(0);
}

if (options.memoryIds.length === 0 && !options.search && options.memberIds.length === 0) {
  console.error('Provide --memory-id <uuid>, --search <substring>, and/or --member-id <uuid> (all repeatable/combinable)');
  Deno.exit(1);
}

const baselineModel = options.model ?? PRIMARY_IMAGE_MODEL;

await Deno.mkdir(options.outputDir, { recursive: true });

const supabase = await createAuthedClient();
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = new URL(`${runId}-cost/`, options.outputDir);
await Deno.mkdir(runDir, { recursive: true });

console.log(`Eval run ${runId}-cost`);
console.log(`Cells: ${options.cells.join(', ')}`);
console.log(`Baseline model: ${baselineModel} (fallback: ${FALLBACK_IMAGE_MODEL})`);
console.log(`Repeats: ${options.repeats}`);

const targets: ResolvedTarget[] = [];

if (options.memoryIds.length > 0 || options.search) {
  const memories = options.memoryIds.length > 0
    ? await loadMemoriesById(supabase, options.memoryIds)
    : await loadMemoriesBySearch(supabase, options.search!, options.limit);

  console.log(`\nResolving ${memories.length} memor${memories.length === 1 ? 'y' : 'ies'}...`);

  for (const memory of memories) {
    const target = await resolveMemoryTarget(supabase, memory);
    if (target) {
      console.log(`  ✓ [${target.slug}] refs=${target.referenceCount} id=${target.id}`);
      targets.push(target);
    }
  }
}

if (options.memberIds.length > 0) {
  console.log(`\nResolving ${options.memberIds.length} family member(s)...`);

  for (const memberId of options.memberIds) {
    const target = await resolveMemberTarget(supabase, memberId);
    if (target) {
      console.log(`  ✓ [${target.slug}] refs=${target.referenceCount} id=${target.id}`);
      targets.push(target);
    }
  }
}

if (targets.length === 0) {
  console.error('\nNo resolvable targets (memories/members). Nothing to run.');
  Deno.exit(1);
}

// ── Build the planned call matrix ────────────────────────────────────────

interface PlannedJob {
  target: ResolvedTarget;
  call: CallSpec;
  repeat: number;
  cellLabel: string;
}

const plannedJobs: PlannedJob[] = [];

for (const target of targets) {
  const applicableCells = target.kind === 'member'
    ? options.cells.filter((cell) => {
      const allowed = PORTRAIT_ALLOWED_CELLS.has(cell);
      if (!allowed) {
        console.error(`  ⚠ [${target.slug}] skipping cell "${cell}" — portraits only support baseline/quality-sweep`);
      }
      return allowed;
    })
    : options.cells;

  for (const cell of applicableCells) {
    const callSpecs = buildCallSpecsForCell(cell, baselineModel);
    for (const call of callSpecs) {
      for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
        plannedJobs.push({ target, call, repeat, cellLabel: cellLabelFor(call) });
      }
    }
  }
}

console.log(`\nPlanned call matrix (${plannedJobs.length} call(s)):`);
const matrixByTargetAndCell = new Map<string, number>();
for (const job of plannedJobs) {
  const key = `${job.target.kind}:${job.target.slug} | ${job.cellLabel} | ${job.call.model} | refs=${job.target.referenceCount}`;
  matrixByTargetAndCell.set(key, (matrixByTargetAndCell.get(key) ?? 0) + 1);
}
for (const [key, count] of matrixByTargetAndCell.entries()) {
  console.log(`  ${key} × ${count} repeat(s)`);
}

const roughWorstCaseCost = plannedJobs.length * ROUGH_WORST_CASE_COST_PER_CALL_USD;
console.log(`\nTotal planned calls: ${plannedJobs.length}`);
console.log(`Rough worst-case cost ceiling: ${formatUsd(roughWorstCaseCost)} (at ~${formatUsd(ROUGH_WORST_CASE_COST_PER_CALL_USD)}/call)`);

if (options.dryRun) {
  console.log('\n--dry-run: not calling OpenAI. Exiting.');
  Deno.exit(0);
}

if (!Deno.env.get('OPENAI_API_KEY')) {
  console.error('\nMissing OPENAI_API_KEY in supabase/.env.local');
  Deno.exit(1);
}

if (!options.yes) {
  const proceed = confirm(
    `\nThis will make ${plannedJobs.length} paid OpenAI image-edit call(s), rough worst case ${formatUsd(roughWorstCaseCost)}. Proceed?`,
  );
  if (!proceed) {
    console.log('Aborted.');
    Deno.exit(0);
  }
}

// ── Execute ───────────────────────────────────────────────────────────────

const smallerRefsCache = new Map<string, ReferenceImageInput[]>();

async function getReferencesForCall(target: ResolvedTarget, call: CallSpec): Promise<ReferenceImageInput[]> {
  if (!call.smallerRefs) {
    return target.referenceImages;
  }

  const cacheKey = `${target.kind}:${target.id}`;
  const cached = smallerRefsCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const recapped = await recapReferencesToEdge(target.referenceImages, SMALLER_REFS_MAX_EDGE);
  smallerRefsCache.set(cacheKey, recapped);
  return recapped;
}

const results: JobResult[] = [];

for (const job of plannedJobs) {
  const { target, call, repeat, cellLabel } = job;
  console.log(`\n→ [${cellLabel}] ${target.kind}:${target.slug} r${repeat} (${call.model}, quality=${call.qualityLabel}, refs=${target.referenceCount})`);

  const referenceImages = await getReferencesForCall(target, call);
  const started = Date.now();
  const edit = await editImageWithUsage(target.prompt, referenceImages, call.model, {
    quality: call.quality,
    noInputFidelity: call.noInputFidelity,
  });
  const durationMs = Date.now() - started;

  const usage = edit?.usage as OpenAiImageUsage | undefined;
  const cost = computeCost(call.model, usage);

  const meta = {
    targetKind: target.kind,
    targetId: target.id,
    cell: call.cell,
    cellLabel,
    model: call.model,
    quality: call.qualityLabel,
    referenceCount: referenceImages.length,
    references: referenceImages.map((ref) => ({
      filename: ref.filename,
      contentType: ref.contentType,
      bytes: ref.bytes.length,
    })),
    referenceMaxEdge: call.smallerRefs ? SMALLER_REFS_MAX_EDGE : target.normalMaxEdge,
    requestParams: edit?.requestParams ?? null,
    usage: usage ?? null,
    cost: {
      inputTextCost: cost.inputTextCost,
      inputImageCost: cost.inputImageCost,
      outputCost: cost.outputCost,
      totalCost: cost.totalCost,
      costIsEstimate: cost.costIsEstimate,
    },
    durationMs,
    timestamp: new Date().toISOString(),
    repeat,
  };

  const jobDirPath = await writeJobArtifacts(runDir, cellLabel, target, repeat, edit?.bytes ?? null, meta);

  if (edit) {
    console.log(
      `  ✓ (${(durationMs / 1000).toFixed(1)}s) usage=${JSON.stringify(usage ?? {})} cost=${formatUsd(cost.totalCost)}${cost.costIsEstimate ? ' (estimate)' : ''} → ${jobDirPath}`,
    );
  } else {
    console.log(`  ✗ failed (${(durationMs / 1000).toFixed(1)}s) → ${jobDirPath}`);
  }

  results.push({ target, call, repeat, cellLabel, usage, cost, durationMs, ok: Boolean(edit) });
}

// ── Summary ───────────────────────────────────────────────────────────────

const summaryRows = buildSummaryRows(results);
const summaryTable = renderSummaryTable(summaryRows);
const totalSpend = results.filter((r) => r.ok).reduce((sum, r) => sum + r.cost.totalCost, 0);
const failedCount = results.filter((r) => !r.ok).length;
const perRefCountAggregate = buildPerRefCountAggregate(results, baselineModel);
const perRefCountHeading =
  `Per-reference-count aggregate (production-equivalent calls: medium quality, full-size refs, ${baselineModel}):`;

console.log(`\n${summaryTable}`);
console.log(`\nTotal spend for this run: ${formatUsd(totalSpend)}${failedCount > 0 ? ` (${failedCount} failed call(s) excluded)` : ''}`);
console.log(`\n${perRefCountHeading}`);
console.log(perRefCountAggregate || '  (no successful calls)');

const summaryMarkdown = [
  `# Image cost eval — ${runId}`,
  '',
  `Cells: ${options.cells.join(', ')}`,
  `Baseline model: ${baselineModel} (fallback: ${FALLBACK_IMAGE_MODEL})`,
  `Repeats: ${options.repeats}`,
  `Total calls: ${plannedJobs.length} (${failedCount} failed)`,
  '',
  '## Per cell/target',
  '',
  '```',
  summaryTable,
  '```',
  '',
  `(* mean cost is a lower-bound estimate — response omitted \`input_tokens_details\`)`,
  '',
  `## ${perRefCountHeading.replace(/:$/, '')}`,
  '',
  perRefCountAggregate || '(no successful calls)',
  '',
  `## Total spend: ${formatUsd(totalSpend)}`,
  '',
].join('\n');

await Deno.writeFile(new URL('summary.md', runDir), new TextEncoder().encode(summaryMarkdown));

console.log(`\nDone. Output under ${runDir.pathname}`);
