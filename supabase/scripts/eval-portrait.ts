/**
 * Local portrait generation eval — iterate on prompts/styles without Edge Functions.
 *
 * Examples:
 *   npm run eval:portrait -- --member-id 89aa4af8-db47-4f30-ba89-3d57d67e9c12
 *   npm run eval:portrait -- --photo ./photo.jpg --age "36 years old" --adult --variant character-design
 *   npm run eval:portrait -- --member-id <uuid> --variants
 *   npm run eval:portrait -- --member-id <uuid> --variant character-sheet-abstraction --adult-prompt
 *   npm run eval:portrait -- --member-id <uuid> --variant old-memora-short-transfer
 *
 * Requires OPENAI_API_KEY + R2/Supabase vars in supabase/.env.local when using --member-id.
 */
import { toFileUrl } from 'jsr:@std/path@1/to-file-url';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { describeAgeAtDate, isAdultAtDate } from '../functions/_shared/age.ts';
import { capImageMaxEdge } from '../functions/_shared/image-bytes.ts';
import { MAX_PORTRAIT_REFERENCE_EDGE } from '../functions/_shared/image-limits.ts';
import {
  editImageWithModel,
  FALLBACK_IMAGE_MODEL,
  PRIMARY_IMAGE_MODEL,
  type ReferenceImageInput,
} from '../functions/_shared/openai.ts';
import {
  buildCharacterSheetAbstractionAddon,
  buildLegacyStyleTransferPortraitPrompt,
  buildPortraitPrompt,
} from '../functions/_shared/prompts.ts';
import {
  DEFAULT_ILLUSTRATION_STYLE_TOKEN,
  getIllustrationStyle,
} from '../functions/_shared/styles.ts';
import { getObjectBytes } from '../functions/_shared/r2.ts';

interface EvalVariant {
  label: string;
  styleFirst: boolean;
  buildPrompt: (input: PortraitPromptInput) => string;
}

interface PortraitPromptInput {
  name: string;
  ageDescription: string;
  isAdult: boolean;
  gender?: string | null;
  styleToken: string;
  styleDescription: string;
  additionalInfo?: string | null;
}

interface CliOptions {
  memberId?: string;
  photoPath?: string;
  stylePath: URL;
  model: string;
  variants: boolean;
  variantLabel?: string;
  customPrompt?: string;
  ageDescription: string;
  gender?: string;
  additionalInfo?: string;
  isAdult?: boolean;
  forceAdultPrompt?: boolean;
  outputDir: URL;
}

function inferIsAdultFromAgeDescription(ageDescription: string): boolean {
  return /adult|woman|man|mother|father|parent|grandmother|grandfather|grandparent|\b\d{2,}\s+year/i.test(
    ageDescription,
  );
}

const defaultStylePath = new URL('../../assets/styles/default.png', import.meta.url);
const defaultOutputDir = new URL('./eval-output/', import.meta.url);

function buildOldMemoraShortTransferPrompt(input: PortraitPromptInput): string {
  const gender = input.gender?.trim() && input.gender !== 'Prefer not to say'
    ? input.gender.trim().toLowerCase()
    : 'person';
  const additionalInfo = input.additionalInfo?.trim()
    ? ` Additional info: ${input.additionalInfo.trim().endsWith('.') ? input.additionalInfo.trim() : `${input.additionalInfo.trim()}.`}`
    : '';

  return [
    `Create a portrait illustration of the ${input.ageDescription} ${gender} shown in the first image.`,
    'Render it in the style of the second image, which has a children\'s book cartoon style.',
    `The person should be smiling and looking directly at the camera.${additionalInfo}`,
    'The background should be simple white background.',
    'Ensure no text or numbers appear in the image.',
  ].join(' ');
}

const EVAL_VARIANTS: EvalVariant[] = [
  {
    label: 'character-design',
    styleFirst: true,
    buildPrompt: (input) => buildPortraitPrompt(input),
  },
  {
    label: 'character-sheet-abstraction',
    styleFirst: true,
    buildPrompt: (input) => `${buildPortraitPrompt(input)} ${buildCharacterSheetAbstractionAddon(input.isAdult)}`,
  },
  {
    label: 'character-inspired-transfer',
    styleFirst: true,
    buildPrompt: (input) => {
      const gender = input.gender?.trim().toLowerCase() || 'person';
      const notes = input.additionalInfo?.trim()
        ? ` Additional guidance: ${input.additionalInfo.trim().endsWith('.') ? input.additionalInfo.trim() : `${input.additionalInfo.trim()}.`}`
        : '';
      return `Design a simplified storybook character inspired by the ${input.ageDescription} ${gender} in the photo reference. Copy the art style from the style reference sheet only — simplified shapes, soft watercolor, gentle outlines, warm muted colors, simple expressive eyes matching the style reference sheet's level of simplification, no realistic skin texture.${notes} Cheerful smile, plain white background, no text.`;
    },
  },
  {
    label: 'style-transfer-template',
    styleFirst: false,
    buildPrompt: (input) => buildLegacyStyleTransferPortraitPrompt(input),
  },
  {
    label: 'old-memora-short-transfer',
    styleFirst: false,
    buildPrompt: buildOldMemoraShortTransferPrompt,
  },
];

function resolveInputPath(path: string): URL {
  return path.startsWith('/') ? toFileUrl(path) : toFileUrl(`${Deno.cwd()}/${path}`);
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    stylePath: defaultStylePath,
    model: PRIMARY_IMAGE_MODEL,
    variants: false,
    ageDescription: 'young child',
    outputDir: defaultOutputDir,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    switch (arg) {
      case '--member-id':
        options.memberId = next;
        index += 1;
        break;
      case '--photo':
        options.photoPath = resolveInputPath(next).pathname;
        index += 1;
        break;
      case '--style':
        options.stylePath = resolveInputPath(next);
        index += 1;
        break;
      case '--model':
        options.model = next;
        index += 1;
        break;
      case '--prompt':
        options.customPrompt = next;
        index += 1;
        break;
      case '--age':
        options.ageDescription = next;
        index += 1;
        break;
      case '--gender':
        options.gender = next;
        index += 1;
        break;
      case '--notes':
        options.additionalInfo = next;
        index += 1;
        break;
      case '--output-dir':
        options.outputDir = resolveInputPath(next);
        index += 1;
        break;
      case '--variants':
        options.variants = true;
        break;
      case '--adult':
        options.isAdult = true;
        break;
      case '--adult-prompt':
        options.forceAdultPrompt = true;
        break;
      case '--variant':
        options.variantLabel = next;
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

async function loadMemberContext(memberId: string) {
  const supabase = await createAuthedClient();
  const { data: member, error } = await supabase
    .from('family_members')
    .select('id, name, date_of_birth, gender, additional_info, profile_picture_key')
    .eq('id', memberId)
    .maybeSingle();

  if (error || !member?.profile_picture_key) {
    throw new Error(error?.message ?? 'Family member or profile photo not found');
  }

  const photoBytes = await getObjectBytes(member.profile_picture_key);
  const referenceDate = new Date().toISOString().slice(0, 10);
  const ageDescription = member.date_of_birth
    ? describeAgeAtDate(member.date_of_birth, referenceDate)
    : 'young child';
  const defaultStyle = getIllustrationStyle(DEFAULT_ILLUSTRATION_STYLE_TOKEN);

  return {
    label: member.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    photoBytes,
    promptInput: {
      name: member.name,
      ageDescription,
      isAdult: member.date_of_birth ? isAdultAtDate(member.date_of_birth, referenceDate) : false,
      gender: member.gender,
      styleToken: defaultStyle.token,
      styleDescription: defaultStyle.description,
      additionalInfo: member.additional_info,
    },
  };
}

async function loadPhotoBytes(photoPath: string): Promise<Uint8Array> {
  return await Deno.readFile(photoPath);
}

async function prepareReferences(
  photoBytes: Uint8Array,
  styleBytes: Uint8Array,
  styleFirst: boolean,
): Promise<ReferenceImageInput[]> {
  const cappedPhoto = await capImageMaxEdge(photoBytes, MAX_PORTRAIT_REFERENCE_EDGE, 'image/jpeg');
  const cappedStyle = await capImageMaxEdge(styleBytes, MAX_PORTRAIT_REFERENCE_EDGE, 'image/png');

  const styleReference = {
    bytes: cappedStyle.bytes,
    contentType: cappedStyle.contentType,
    filename: 'reference-1-style.png',
  };
  const photoReference = {
    bytes: cappedPhoto.bytes,
    contentType: cappedPhoto.contentType,
    filename: styleFirst ? 'reference-2-person-photo.jpg' : 'reference-1-person-photo.jpg',
  };

  if (styleFirst) {
    return [styleReference, photoReference];
  }

  return [
    {
      ...photoReference,
      filename: 'reference-1-person-photo.jpg',
    },
    {
      ...styleReference,
      filename: 'reference-2-style.png',
    },
  ];
}

async function writeEvalArtifacts(
  outputDir: URL,
  runId: string,
  label: string,
  prompt: string,
  model: string,
  portraitBytes: Uint8Array,
  photoBytes: Uint8Array,
  styleBytes: Uint8Array,
): Promise<string> {
  const runDir = new URL(`${runId}-${label}/`, outputDir);
  await Deno.mkdir(runDir, { recursive: true });

  const portraitUrl = new URL('portrait.png', runDir);
  await Deno.writeFile(portraitUrl, portraitBytes);
  await Deno.writeFile(new URL('prompt.txt', runDir), new TextEncoder().encode(prompt));
  await Deno.writeFile(new URL('input-photo.jpg', runDir), photoBytes);
  await Deno.writeFile(new URL('input-style.png', runDir), styleBytes);
  await Deno.writeFile(
    new URL('meta.json', runDir),
    new TextEncoder().encode(JSON.stringify({
      label,
      model,
      createdAt: new Date().toISOString(),
      portraitPath: portraitUrl.pathname,
    }, null, 2)),
  );

  return portraitUrl.pathname;
}

async function runVariant(
  label: string,
  prompt: string,
  model: string,
  references: ReferenceImageInput[],
  photoBytes: Uint8Array,
  styleBytes: Uint8Array,
  outputDir: URL,
  runId: string,
): Promise<string | null> {
  console.log(`→ [${label}] calling ${model}...`);
  const started = Date.now();
  const portraitBytes = await editImageWithModel(prompt, references, model);

  if (!portraitBytes) {
    console.error(`  ✗ [${label}] edit failed (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    return null;
  }

  const portraitPath = await writeEvalArtifacts(
    outputDir,
    runId,
    label,
    prompt,
    model,
    portraitBytes,
    photoBytes,
    styleBytes,
  );

  console.log(`  ✓ [${label}] saved (${((Date.now() - started) / 1000).toFixed(1)}s) → ${portraitPath}`);
  return portraitPath;
}

const options = parseArgs(Deno.args);

if (!options.memberId && !options.photoPath) {
  console.error('Provide --member-id <uuid> or --photo <path>');
  Deno.exit(1);
}

if (!Deno.env.get('OPENAI_API_KEY')) {
  console.error('Missing OPENAI_API_KEY in supabase/.env.local');
  Deno.exit(1);
}

await Deno.mkdir(options.outputDir, { recursive: true });

const styleBytes = await Deno.readFile(options.stylePath);
const style = getIllustrationStyle('default');
const runId = new Date().toISOString().replace(/[:.]/g, '-');

let subjectLabel = 'subject';
let photoBytes: Uint8Array;
let promptInput: PortraitPromptInput;

if (options.memberId) {
  const memberContext = await loadMemberContext(options.memberId);
  subjectLabel = memberContext.label;
  photoBytes = memberContext.photoBytes;
  promptInput = memberContext.promptInput;
} else {
  photoBytes = await loadPhotoBytes(options.photoPath!);
  const isAdult = options.isAdult ?? inferIsAdultFromAgeDescription(options.ageDescription);
  promptInput = {
    name: isAdult ? 'Adult' : 'Child',
    ageDescription: options.ageDescription,
    isAdult,
    gender: options.gender ?? null,
    styleToken: DEFAULT_ILLUSTRATION_STYLE_TOKEN,
    styleDescription: style.description,
    additionalInfo: options.additionalInfo ?? null,
  };
}

if (options.forceAdultPrompt) {
  promptInput.isAdult = true;
}

interface EvalRun {
  label: string;
  prompt: string;
  styleFirst: boolean;
}

const runs: EvalRun[] = [];

if (options.customPrompt) {
  runs.push({ label: 'custom', prompt: options.customPrompt, styleFirst: true });
} else if (options.variantLabel) {
  const variant = EVAL_VARIANTS.find((entry) => entry.label === options.variantLabel);
  if (!variant) {
    console.error(`Unknown variant "${options.variantLabel}". Options: ${EVAL_VARIANTS.map((entry) => entry.label).join(', ')}`);
    Deno.exit(1);
  }
  runs.push({
    label: options.forceAdultPrompt ? `${variant.label}-adult-prompt` : variant.label,
    prompt: variant.buildPrompt(promptInput),
    styleFirst: variant.styleFirst,
  });
} else if (options.variants) {
  for (const variant of EVAL_VARIANTS) {
    runs.push({
      label: options.forceAdultPrompt ? `${variant.label}-adult-prompt` : variant.label,
      prompt: variant.buildPrompt(promptInput),
      styleFirst: variant.styleFirst,
    });
  }
} else {
  runs.push({
    label: 'character-design',
    prompt: buildPortraitPrompt(promptInput),
    styleFirst: true,
  });
}

if (options.forceAdultPrompt) {
  console.log('Prompt branch: adult identity (forced via --adult-prompt; age text unchanged)');
}
console.log(`Eval run ${runId} (${subjectLabel})`);
console.log(`Style reference: ${options.stylePath.pathname}`);
console.log(`Model: ${options.model} (fallback available: ${FALLBACK_IMAGE_MODEL})`);
console.log(`Variants: ${runs.map((run) => run.label).join(', ')}`);

const saved: string[] = [];

for (const run of runs) {
  const references = await prepareReferences(photoBytes, styleBytes, run.styleFirst);
  const path = await runVariant(
    run.label,
    run.prompt,
    options.model,
    references,
    photoBytes,
    styleBytes,
    options.outputDir,
    `${runId}-${subjectLabel}`,
  );

  if (path) {
    saved.push(path);
  }
}

if (saved.length === 0) {
  console.error('No portraits generated.');
  Deno.exit(1);
}

console.log(`Done. ${saved.length} portrait(s) saved under ${options.outputDir.pathname}`);
