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
 *   npm run eval:illustration -- --list-recent 40
 *   npm run eval:illustration -- --memory-id <uuid> \
 *     --style-file styles/line-art.txt --style-file styles/riso.txt
 *
 * `--style-file` (repeatable) swaps the production "Illustration style" +
 * "Color palette" block for the file's text (`{palette}` expands to the
 * memory's emotion palette), so art directions A/B against the same scene.
 * `@@ old => new` lines in the file patch the rest of the prompt literally.
 * An `@image path` line appends that image as an extra (style) reference;
 * `{styleRef}` in the text expands to its "reference image N" label.
 *
 * `--director N` adds a cinematographer pass after the safety rewrite: an LLM
 * proposes N distinct shots (camera height, angle, distance, POV, staging
 * idea) and every style renders once per shot, inserted as "Camera and
 * staging:" after the Scene line. The director sees the original memory too.
 * `--director-model model[:effort]` (repeatable) A/Bs director models on the
 * same safety rewrite; `--shot "label: text"` renders hand-written shots.
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
  buildSceneWithCameraDirection,
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
  type ReferenceImageInput,
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
  /** `--list-recent N`: print recent illustrated memories and exit. */
  listRecent: number;
  styleFiles: string[];
  /** `--director N`: render each style once per LLM-proposed shot. */
  director: number;
  /** `--shots-only`: print the director's shots and skip image generation. */
  shotsOnly: boolean;
  /** `--shot "label: text"`, repeatable: hand-written shots instead of the director. */
  manualShots: DirectorShot[];
  /** `--director-model model[:effort]`, repeatable: A/B director models on one safety rewrite. */
  directorModels: DirectorModel[];
}

interface StyleOverride {
  name: string;
  text: string;
  image?: ReferenceImageInput;
}

interface DirectorModel {
  model: string;
  effort?: string;
}

interface DirectorShot {
  label: string;
  shot: string;
}

/** Director pass uses a stronger reasoning model than production's chatJson default. */
const DEFAULT_DIRECTOR_MODEL = 'gpt-5.4-mini';

async function directorJson<T>(systemPrompt: string, userPrompt: string, model: DirectorModel): Promise<T> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${Deno.env.get('OPENAI_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: model.model,
      ...(model.effort ? { reasoning_effort: model.effort } : {}),
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });
  if (!response.ok) throw new Error(`director request failed: ${response.status}`);
  const payload = await response.json();
  return JSON.parse(payload.choices?.[0]?.message?.content ?? '{}') as T;
}

function buildDirectorSystemPrompt(count: number): string {
  return [
    'You are the cinematographer for the illustrations in a family memory journal.',
    count === 1
      ? 'Given a child-safe scene, choose the ONE way to stage it as a still image that makes this memory land best — as bold as the memory can justify.'
      : `Given a child-safe scene, propose ${count} DISTINCT ways to stage it as one still image.`,
    'The shot must be specific and drawable and make THIS memory\'s story or feeling land. Never a generic centered medium shot of the family smiling at the viewer.',
    'Toolbox — mix freely, choose what serves the story:',
    'Camera height and angle: worm\'s-eye from the floor looking up (a child towers like a giant), bird\'s-eye straight down (patterns of toys or laundry, a bed seen from the ceiling), high angle (smallness), low angle (heroism), tilted frame (chaos), eye level at the child\'s height (the child\'s world).',
    'Distance: extreme wide (tiny figures in a big world), wide, medium, or an extreme close-up of one telling detail (small hands, a toe touching the water).',
    'Point of view: from an object or place in the story (from inside a box, from the sky looking down), over-the-shoulder, or a listed parent\'s own POV with only their hands or arms in frame.',
    'Framing devices: through a doorway, under a table, between crib bars, a reflection in a mirror, window or puddle, a shadow on a wall.',
    'Imagination and scale: draw what the child believes as if it were real — a hug the wind carried away visibly floating in the sky, a cardboard box that is truly a bus on a road, a toddler "being a monster" towering over a toy city.',
    'Sound and feeling made visible without words: a burp as a little puff, a song as drifting ripples, a tiny storm cloud over one cross child.',
    'Timing: the instant just before or after the punchline. Placement: tiny figures in a corner with a huge empty sky, bold cropping.',
    'Rules:',
    'Only the people listed under People appear. Never add anyone else — no searcher, helper, bystander, or the hands of a parent who is not listed.',
    'Never describe anyone\'s appearance (eyes, hair, glasses, skin, clothing colors); the portraits handle that. Describe position, pose, action, and expression only.',
    'Every listed person stays recognizable, with faces readable.',
    'Stay truthful to the memory and its emotional tone. Boldness follows expressionStyle: comedic → exaggerated, cartoon-bold camera; tender → intimate and unusual but calm; neutral or hard moments (sick, sad, tantrums, worry) → quiet, observational, honest, never a joke.',
    'Bath scenes: the camera stays outside the tub, level with the rim; the child is seen from the chest up behind the tub wall, in bubbles, or wrapped in a towel. Never look down into the water at the child, never a close-up of bare skin. Changing and bedtime scenes: pajamas or a blanket.',
    'Children in a car sit in their car seat in the back.',
    count > 1
      ? 'Make the options genuinely different: the first is the boldest idea the memory can justify, the second an unusual but realistic angle, the third a quiet observational frame. For hard moments all stay honest.'
      : null,
    'Examples of the boldness and literal physical detail wanted (they are NOT this memory; invent the equivalent):',
    '(a) A toddler pretending to be a dinosaur next to her block tower: "The camera lies flat on the kitchen floor among the wooden blocks, lens pointing steeply up like a monster movie. The block tower looms in the foreground. The toddler TOWERS behind it, seen from below, arms up like claws mid-roar, gleeful face near the top edge."',
    '(b) Siblings asleep together on a picnic blanket: "Straight top-down view from high above, no horizon. The checkered blanket is a flat pattern filling the frame; the two kids are small, curled toward each other in the lower-left third, each about a sixth of the frame."',
    '(c) A child reading a book to a teddy bear: "The camera sits just behind the teddy bear\'s shoulder, its fuzzy ear soft in the foreground; the child faces it across the rug, holding the book open toward the bear, earnest and absorbed."',
    'Be literal about the lens: say where the camera physically is, what fills the foreground, and how much of the frame each person takes.',
    `Each shot: 1-3 sentences in English naming the camera position and angle, distance, where each person sits in the frame, and the one staging idea that makes it special.`,
    'JSON only: {"shots":[{"label":"two-or-three-word-kebab-case","shot":"..."}]}',
  ].filter((line): line is string => Boolean(line)).join(' ');
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
    listRecent: 0,
    styleFiles: [],
    director: 0,
    shotsOnly: false,
    manualShots: [],
    directorModels: [],
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
      case '--list-recent':
        options.listRecent = Number(next) || 30;
        index += 1;
        break;
      case '--style-file':
        options.styleFiles.push(next);
        index += 1;
        break;
      case '--shot': {
        const [label, ...rest] = next.split(':');
        options.manualShots.push({ label: `hand-${label.trim()}`, shot: rest.join(':').trim() });
        index += 1;
        break;
      }
      case '--director-model': {
        const [model, effort] = next.split(':');
        options.directorModels.push({ model, ...(effort ? { effort } : {}) });
        index += 1;
        break;
      }
      case '--shots-only':
        options.shotsOnly = true;
        break;
      case '--director':
        options.director = Number(next) || 3;
        index += 1;
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

/**
 * Swap the production style block for a style file's text. Lines of the form
 * `@@ old text => new text` are pulled out and applied as literal replacements
 * to the whole prompt (e.g. to retarget "storybook figure" wording).
 */
function applyStyleOverride(
  prompt: string,
  productionStyleBlock: string,
  styleText: string,
  palette: string,
  styleRefLabel: string,
): string {
  const replacements: Array<[string, string]> = [];
  const body = styleText.split('\n').filter((line) => {
    const match = line.match(/^@@ (.+?) => (.*)$/);
    if (match) replacements.push([match[1], match[2]]);
    return !match;
  }).join('\n').trim().replaceAll('{palette}', palette).replaceAll('{styleRef}', styleRefLabel);
  let result = prompt.replace(productionStyleBlock, body);
  for (const [from, to] of replacements) {
    if (!result.includes(from)) console.error(`  ⚠ style replacement not found: ${from.slice(0, 60)}`);
    result = result.replaceAll(from, to);
  }
  return result;
}

async function evalMemory(
  supabase: Awaited<ReturnType<typeof createAuthedClient>>,
  memory: EvalMemoryRow,
  variants: ImageVariant[],
  quality: OpenAiImageQuality,
  outputDir: URL,
  runId: string,
  styleOverrides: StyleOverride[],
  director: number,
  shotsOnly = false,
  manualShots: DirectorShot[] = [],
  directorModels: DirectorModel[] = [],
): Promise<void> {
  const slug = slugifyMemoryContent(memory.content);
  console.log(`\n→ [${memory.id}] ${slug}`);

  if (!['text_illustration', 'text_only'].includes(memory.memory_type) || !memory.content?.trim()) {
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
  const safety = await chatJson<{ safeDescription?: string; expressionStyle?: string; cameraDirection?: unknown }>(
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

  // Default runs match production: the safety call's own camera pick rides
  // in the scene text. --director / --shot runs stage the plain scene instead.
  const useProductionCamera = director === 0 && manualShots.length === 0;
  if (useProductionCamera && typeof safety.cameraDirection === 'string') {
    console.log(`  🎥 production: ${safety.cameraDirection}`);
  }
  const prompt = buildIllustrationPrompt({
    safeSceneDescription: useProductionCamera
      ? buildSceneWithCameraDirection(safeDescription, safety.cameraDirection)
      : safeDescription,
    characterReferences,
    colorPalette: resolvedPalette,
    memoryDate: memory.memory_date,
    styleDescription,
    emotion: memory.emotion,
    expressionStyle,
  });

  let shots: DirectorShot[] = manualShots;
  if (director > 0 && manualShots.length === 0) {
    const cast = characterReferences.map((reference) => reference.description).join('; ');
    const userPrompt = [
      `Original memory (for story details only; stage the child-safe scene): ${strippedContent}`,
      `Child-safe scene: ${safeDescription}`,
      `People: ${cast}`,
      `Emotion: ${normalizedEmotion ?? 'unknown'}; expressionStyle: ${expressionStyle}`,
    ].join('\n');
    const models = directorModels.length > 0 ? directorModels : [{ model: DEFAULT_DIRECTOR_MODEL, effort: 'low' }];
    // One director call per model, in parallel; with several models each
    // shot label is prefixed by its model so the A/B reads in file names.
    const perModel = await Promise.all(models.map(async (model) => {
      const started = Date.now();
      try {
        const directed = await directorJson<{ shots?: DirectorShot[] }>(
          buildDirectorSystemPrompt(director),
          userPrompt,
          model,
        );
        timings[`directorMs:${model.model}`] = Date.now() - started;
        return (directed.shots ?? [])
          .filter((shot) => shot.label && shot.shot)
          .slice(0, director)
          .map((shot, index) => {
            const slug = shot.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            const prefix = models.length > 1 ? `${model.model}-` : '';
            return { label: `${prefix}${index + 1}-${slug}`, shot: shot.shot.trim() };
          });
      } catch (error) {
        console.error(`  ✗ director ${model.model} failed:`, error instanceof Error ? error.message : 'unknown');
        return [];
      }
    }));
    shots = perModel.flat();
    for (const shot of shots) console.log(`  🎥 ${shot.label}: ${shot.shot}`);
  }
  if (shotsOnly) return;

  // Every variant renders the SAME prompt so the A/B isolates the model and
  // complexity, not the nondeterministic safety rewrite.
  const productionStyleBlock = `Illustration style: ${styleDescription}\nColor palette: ${resolvedPalette}`;
  const sceneLine = `Scene: ${safeDescription}`;
  const styled = styleOverrides.length > 0
    ? styleOverrides.map((style) => ({
      suffix: `-${style.name}`,
      prompt: applyStyleOverride(
        prompt,
        productionStyleBlock,
        style.text,
        resolvedPalette,
        `reference image ${referenceImages.length + 1}`,
      ),
      images: style.image ? [...referenceImages, style.image] : referenceImages,
    }))
    : [{ suffix: '', prompt, images: referenceImages }];
  const prompts = shots.length > 0
    ? styled.flatMap((entry) => shots.map((shot) => ({
      ...entry,
      suffix: `${entry.suffix}-${shot.label}`,
      prompt: entry.prompt.replace(sceneLine, `Scene: ${buildSceneWithCameraDirection(safeDescription, shot.shot)}`),
    })))
    : styled;
  const runs = prompts.flatMap((entry) => variants.map((variant) => ({ ...entry, variant })));
  const single = runs.length === 1;
  const scenes = (await Promise.all(runs.map(async (run) => {
    const { variant } = run;
    const label = `${variantLabel(variant)}${run.suffix}`;
    const imageStarted = Date.now();
    let sceneBytes: Uint8Array | null = null;
    try {
      sceneBytes = await editImageWithModel(run.prompt, run.images, variant.model, {
        quality,
        ...(variant.complexity ? { complexity: variant.complexity } : {}),
      });
    } catch (error) {
      console.error(`  ✗ ${label} failed:`, error instanceof Error ? error.message : 'unknown');
    }
    const elapsedMs = Date.now() - imageStarted;
    timings[single ? 'imageGenerationMs' : `imageGenerationMs:${label}`] = elapsedMs;
    console.log(`  ${sceneBytes ? '✓' : '✗'} ${label}: ${(elapsedMs / 1000).toFixed(1)}s`);
    const files: Array<{ fileName: string; bytes: Uint8Array | null }> = [
      { fileName: single ? 'scene.png' : `scene-${label}.png`, bytes: sceneBytes },
    ];
    if (run.suffix) {
      files.push({ fileName: `prompt${run.suffix}.txt`, bytes: new TextEncoder().encode(run.prompt) });
    }
    return files;
  }))).flat();

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
    productionCameraDirection: safety.cameraDirection ?? null,
    shots,
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

if (options.listRecent > 0) {
  const client = await createAuthedClient();
  const { data, error } = await client
    .from('memories')
    .select('id, content, memory_date, emotion, illustration_key, memory_type')
    .not('illustration_key', 'is', null)
    .order('memory_date', { ascending: false })
    .limit(options.listRecent);

  if (error) {
    console.error(`Failed to list memories: ${error.message}`);
    Deno.exit(1);
  }

  for (const row of data ?? []) {
    const snippet = (row.content ?? '').replace(/\s+/g, ' ').slice(0, 140);
    console.log(`${row.id}  ${row.memory_date}  ${(row.emotion ?? '-').padEnd(11)}  ${row.memory_type.padEnd(17)}  ${snippet}`);
  }

  Deno.exit(0);
}

const styleOverrides: StyleOverride[] = await Promise.all(options.styleFiles.map(async (path) => {
  const lines = (await Deno.readTextFile(path)).split('\n');
  const imagePath = lines.map((line) => line.match(/^@image (.+)$/)?.[1]).find(Boolean);
  const extension = imagePath?.split('.').pop()?.toLowerCase();
  return {
    name: path.split('/').pop()!.replace(/\.[^.]+$/, ''),
    text: lines.filter((line) => !line.startsWith('@image ')).join('\n').trim(),
    ...(imagePath
      ? {
        image: {
          bytes: await Deno.readFile(imagePath.trim()),
          contentType: extension === 'png' ? 'image/png' : 'image/jpeg',
          filename: `style-reference.${extension === 'png' ? 'png' : 'jpg'}`,
        },
      }
      : {}),
  };
}));

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
  await evalMemory(
    supabase,
    memory,
    variants,
    options.quality,
    options.outputDir,
    runId,
    styleOverrides,
    options.director,
    options.shotsOnly,
    options.manualShots,
    options.directorModels,
  );
}

console.log(`\nDone. Output under ${options.outputDir.pathname}`);
