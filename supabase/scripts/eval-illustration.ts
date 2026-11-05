/**
 * Local illustration generation eval — iterate on the memory-illustration
 * prompt pipeline (safety rewrite + buildIllustrationPrompt) without going
 * through the generate-illustration Edge Function.
 *
 * Examples:
 *   npm run eval:illustration -- --memory-id 89aa4af8-db47-4f30-ba89-3d57d67e9c12
 *   npm run eval:illustration -- --memory-id <uuid> --memory-id <uuid>
 *   npm run eval:illustration -- --search "meltdown" --limit 5
 *   npm run eval:illustration -- --search "fever" --model gpt-image-1.5
 *   npm run eval:illustration -- --memory-id <uuid> \
 *     --variant gpt-image-2.5-flare --variant gpt-image-2.6-flare:high --variant gpt-image-2.6-flare:low
 *
 * Every variant renders the same prompt (one safety rewrite per memory) at
 * `--quality` (default medium, as in production) and prints its latency.
 *
 * Requires OPENAI_API_KEY + R2/Supabase vars in supabase/.env.local.
 * DB/OpenAI env access is not available in every environment this script
 * runs in -- it must typecheck even when it cannot be executed.
 */
import { toFileUrl } from 'jsr:@std/path@1/to-file-url';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { stripUrls } from '../functions/_shared/link-preview.ts';
import {
  prepareIllustrationReferences,
  sortMembersByTagOrder,
  type IllustrationFamilyMember,
} from '../functions/_shared/illustration-references.ts';
import { resolveMemberIdsForIllustration } from '../functions/_shared/illustration-members.ts';
import {
  buildIllustrationPrompt,
  buildSafetySystemPrompt,
  EMOTION_PALETTES,
  normalizeEmotion,
  type SafetyPromptMember,
} from '../functions/_shared/prompts.ts';
import {
  DEFAULT_ILLUSTRATION_STYLE_TOKEN,
  getStyleDescription,
} from '../functions/_shared/styles.ts';
import {
  chatJson,
  editImageWithModel,
  PRIMARY_IMAGE_MODEL,
  type OpenAiImageComplexity,
  type OpenAiImageQuality,
} from '../functions/_shared/openai.ts';
import { getObjectBytes } from '../functions/_shared/r2.ts';

const ALLOWED_EXPRESSION_STYLES = new Set(['comedic', 'tender', 'neutral']);
type ExpressionStyle = 'comedic' | 'tender' | 'neutral';

interface ImageVariant {
  model: string;
  complexity?: OpenAiImageComplexity;
}

interface CliOptions {
  memoryIds: string[];
  search?: string;
  limit: number;
  model: string;
  /** `--variant model[:complexity]`, repeatable: A/B several from one prompt. */
  variants: ImageVariant[];
  quality: OpenAiImageQuality;
  outputDir: URL;
  listEmotions: boolean;
}

const IMAGE_COMPLEXITIES = new Set(['low', 'medium', 'high']);

function parseVariant(value: string): ImageVariant {
  const [model, complexity] = value.split(':');
  if (complexity !== undefined && !IMAGE_COMPLEXITIES.has(complexity)) {
    console.error(`Invalid complexity in --variant ${value} (use low|medium|high)`);
    Deno.exit(1);
  }
  return { model, ...(complexity ? { complexity: complexity as OpenAiImageComplexity } : {}) };
}

function variantLabel(variant: ImageVariant): string {
  return variant.complexity ? `${variant.model}-${variant.complexity}` : variant.model;
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

const defaultOutputDir = new URL('./eval-output/', import.meta.url);

function resolveOutputPath(path: string): URL {
  const base = path.startsWith('/') ? toFileUrl(path) : toFileUrl(`${Deno.cwd()}/${path}`);
  return new URL(base.href.endsWith('/') ? base.href : `${base.href}/`);
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    memoryIds: [],
    limit: 3,
    model: PRIMARY_IMAGE_MODEL,
    variants: [],
    // Production (worker + Edge Function) always asks for medium.
    quality: 'medium',
    outputDir: defaultOutputDir,
    listEmotions: false,
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
      case '--model':
        options.model = next;
        index += 1;
        break;
      case '--variant':
        options.variants.push(parseVariant(next));
        index += 1;
        break;
      case '--quality':
        options.quality = next as OpenAiImageQuality;
        index += 1;
        break;
      case '--output-dir':
        options.outputDir = resolveOutputPath(next);
        index += 1;
        break;
      case '--list-emotions':
        options.listEmotions = true;
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

function slugifyMemoryContent(content: string | null): string {
  const slug = (content ?? 'memory')
    .trim()
    .toLowerCase()
    .slice(0, 40)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || 'memory';
}

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

  // Mirror generate-illustration/index.ts: fall back to name/nickname
  // matching in the text when the memory has no explicit tags.
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

async function writeEvalArtifacts(
  outputDir: URL,
  runId: string,
  slug: string,
  prompt: string,
  scenes: Array<{ fileName: string; bytes: Uint8Array | null }>,
  previousBytes: Uint8Array | null,
  meta: Record<string, unknown>,
): Promise<string> {
  const runDir = new URL(`${runId}-${slug}/`, outputDir);
  await Deno.mkdir(runDir, { recursive: true });

  for (const scene of scenes) {
    if (scene.bytes) await Deno.writeFile(new URL(scene.fileName, runDir), scene.bytes);
  }

  await Deno.writeFile(new URL('prompt.txt', runDir), new TextEncoder().encode(prompt));

  if (previousBytes) {
    await Deno.writeFile(new URL('previous.webp', runDir), previousBytes);
  }

  await Deno.writeFile(
    new URL('meta.json', runDir),
    new TextEncoder().encode(JSON.stringify(meta, null, 2)),
  );

  return runDir.pathname;
}

async function evalMemory(
  supabase: Awaited<ReturnType<typeof createAuthedClient>>,
  memory: EvalMemoryRow,
  variants: ImageVariant[],
  quality: OpenAiImageQuality,
  outputDir: URL,
  runId: string,
): Promise<void> {
  const slug = slugifyMemoryContent(memory.content);
  console.log(`\n→ [${memory.id}] ${slug}`);

  if (memory.memory_type !== 'text_illustration' || !memory.content?.trim()) {
    console.error(`  ✗ skipped: not a text_illustration memory with content`);
    return;
  }

  const strippedContent = stripUrls(memory.content);

  if (!strippedContent.trim()) {
    console.error(`  ✗ skipped: empty content after stripping URLs`);
    return;
  }

  const { readyMembers, safetyMembers } = await resolveReadyMembers(supabase, memory);

  if (readyMembers.length === 0) {
    console.error(`  ✗ skipped: no ready character portraits for tagged/mentioned members`);
    return;
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

  const timings: Record<string, number> = {};
  const safetyStarted = Date.now();
  const safety = await chatJson<{ safeDescription?: string; expressionStyle?: string }>(
    buildSafetySystemPrompt(safetyMembers),
    strippedContent,
  );
  timings.safetyRewriteMs = Date.now() - safetyStarted;

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
    console.error(`  ✗ skipped: failed to load portrait references`);
    return;
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

  // Every variant renders the SAME prompt so the A/B isolates the model and
  // complexity, not the nondeterministic safety rewrite.
  const scenes: Array<{ fileName: string; bytes: Uint8Array | null }> = [];
  for (const variant of variants) {
    const label = variantLabel(variant);
    const imageStarted = Date.now();
    let sceneBytes: Uint8Array | null = null;
    try {
      sceneBytes = await editImageWithModel(prompt, referenceImages, variant.model, {
        quality,
        ...(variant.complexity ? { complexity: variant.complexity } : {}),
      });
    } catch (error) {
      console.error(`  ✗ ${label} failed:`, error instanceof Error ? error.message : 'unknown');
    }
    const elapsedMs = Date.now() - imageStarted;
    timings[variants.length === 1 ? 'imageGenerationMs' : `imageGenerationMs:${label}`] = elapsedMs;
    console.log(`  ${sceneBytes ? '✓' : '✗'} ${label}: ${(elapsedMs / 1000).toFixed(1)}s`);
    scenes.push({ fileName: variants.length === 1 ? 'scene.png' : `scene-${label}.png`, bytes: sceneBytes });
  }

  let previousBytes: Uint8Array | null = null;
  if (memory.illustration_key) {
    try {
      previousBytes = await getObjectBytes(memory.illustration_key);
    } catch (error) {
      console.error(
        `  ⚠ failed to download previous illustration`,
        error instanceof Error ? error.message : 'unknown',
      );
    }
  }

  const meta = {
    memoryId: memory.id,
    content: memory.content,
    emotion: memory.emotion,
    expressionStyle,
    safeDescription,
    variants,
    quality,
    referenceCount: referenceImages.length,
    createdAt: new Date().toISOString(),
    timings,
    hadPreviousIllustration: Boolean(memory.illustration_key),
  };

  const runDirPath = await writeEvalArtifacts(
    outputDir,
    runId,
    slug,
    prompt,
    scenes,
    previousBytes,
    meta,
  );

  console.log(`  ✓ saved → ${runDirPath}`);
}

const options = parseArgs(Deno.args);

if (options.listEmotions) {
  const client = await createAuthedClient();
  const { data, error } = await client.from('memories').select('emotion');

  if (error) {
    console.error(`Failed to list emotions: ${error.message}`);
    Deno.exit(1);
  }

  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    const label = row.emotion ?? '(null)';
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  const known = new Set(Object.keys(EMOTION_PALETTES));
  for (const [label, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    const flag = label !== '(null)' && !known.has(label) ? '  ← not in EMOTION_PALETTES' : '';
    console.log(`${String(count).padStart(4)}  ${label}${flag}`);
  }

  Deno.exit(0);
}

if (options.memoryIds.length === 0 && !options.search) {
  console.error('Provide --memory-id <uuid> (repeatable) or --search <substring>');
  Deno.exit(1);
}

if (!Deno.env.get('OPENAI_API_KEY')) {
  console.error('Missing OPENAI_API_KEY in supabase/.env.local');
  Deno.exit(1);
}

await Deno.mkdir(options.outputDir, { recursive: true });

const supabase = await createAuthedClient();
const runId = new Date().toISOString().replace(/[:.]/g, '-');

const memories = options.memoryIds.length > 0
  ? await loadMemoriesById(supabase, options.memoryIds)
  : await loadMemoriesBySearch(supabase, options.search!, options.limit);

if (memories.length === 0) {
  console.error('No matching memories found.');
  Deno.exit(1);
}

console.log(`Eval run ${runId} — ${memories.length} memor${memories.length === 1 ? 'y' : 'ies'}`);
const variants = options.variants.length > 0 ? options.variants : [{ model: options.model }];
console.log(`Variants: ${variants.map(variantLabel).join(', ')} (quality ${options.quality})`);

for (const memory of memories) {
  await evalMemory(supabase, memory, variants, options.quality, options.outputDir, runId);
}

console.log(`\nDone. Output under ${options.outputDir.pathname}`);
