/**
 * Generates onboarding slot illustrations through the real style pipeline
 * (style-reference image edit, same prompt building blocks as the memory
 * illustration pipeline) so onboarding screens can bundle real generated art
 * instead of placeholders.
 *
 * Examples:
 *   npm run art:onboarding
 *   npm run art:onboarding -- --slot welcome --slot story-night
 *   npm run art:onboarding -- --slot welcome --quality high
 *   npm run art:onboarding -- --slot welcome --extra "make the lamp glow warmer"
 *
 * Requires OPENAI_API_KEY in supabase/.env.local.
 * DB/OpenAI env access is not available in every environment this script
 * runs in -- it must typecheck even when it cannot be executed.
 */
import { toFileUrl } from 'jsr:@std/path@1/to-file-url';
import { capImageMaxEdge } from '../functions/_shared/image-bytes.ts';
import { MAX_PORTRAIT_REFERENCE_EDGE } from '../functions/_shared/image-limits.ts';
import {
  editImageWithModel,
  PRIMARY_IMAGE_MODEL,
  type OpenAiImageQuality,
  type ReferenceImageInput,
} from '../functions/_shared/openai.ts';
import { EMOTION_EXPRESSIONS, EMOTION_PALETTES } from '../functions/_shared/prompts.ts';
import { getStyleDescription } from '../functions/_shared/styles.ts';

interface OnboardingSlot {
  emotion: string;
  sceneText: string;
  paletteOverride?: string;
}

const ONBOARDING_SLOTS: Record<string, OnboardingSlot> = {
  welcome: {
    emotion: 'tender',
    paletteOverride: 'soft rose, cream, gentle lavender, deep dusky indigo shadows',
    sceneText:
      'A tired but happy parent reading a picture book to a small child curled in their lap, in a big armchair, late evening. A single warm lamp pools light low and to the right around them; the upper left of the scene falls into deep dusky indigo shadow, dark and uncluttered.',
  },
  'story-night': {
    emotion: 'weary',
    sceneText:
      'A parent sitting up in bed at 2 a.m., face lit only by the cold glow of a phone screen, the bedroom in deep blue-grey darkness, a cracked door hinting at a child asleep in the next room. Genuinely dark night scene; the phone glow is the only light source.',
  },
  'story-book': {
    emotion: 'bittersweet',
    sceneText:
      'A closed baby memory book resting on a closet shelf with a fine layer of dust, one tiny odd baby sock sitting on top of it, warm afternoon light slanting in with dust motes. Warm and a little funny, not sad. No people.',
  },
  'story-babble': {
    emotion: 'joy',
    sceneText:
      'A toddler mid-babble in a bright sunlit room, arms up, mouth open in delighted nonsense, with playful abstract hand-drawn squiggles, loops and little stars floating around their head (abstract shapes only — no letters, no words).',
  },
  'kids-doodle': {
    emotion: 'joy',
    sceneText:
      'A tiny simple spot illustration: a child\'s crayon-style smiling sun, one single motif, very minimal detail, plain paper-white background.',
  },
  'family-nest': {
    emotion: 'calm',
    sceneText:
      'A small spot illustration of a cozy round bird\'s nest holding three little eggs, tucked on a leafy branch, single motif, minimal detail, plain background.',
  },
  'join-door': {
    emotion: 'calm',
    sceneText:
      'A gently closed wooden door at the end of a calm dim hallway, warm golden light spilling from under it and through the keyhole, quiet and inviting. No people.',
  },
};

const ALL_SLOT_IDS = Object.keys(ONBOARDING_SLOTS);
const ALLOWED_QUALITIES = new Set<OpenAiImageQuality>(['low', 'medium', 'high']);

interface CliOptions {
  slots: string[];
  outputDir: URL;
  quality: OpenAiImageQuality;
  extra?: string;
}

const styleReferenceUrl = new URL('../functions/_shared/assets/default-style.png', import.meta.url);
const defaultOutputDir = new URL('./eval-output/', import.meta.url);

function resolveOutputPath(path: string): URL {
  const base = path.startsWith('/') ? toFileUrl(path) : toFileUrl(`${Deno.cwd()}/${path}`);
  return new URL(base.href.endsWith('/') ? base.href : `${base.href}/`);
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    slots: [],
    outputDir: defaultOutputDir,
    quality: 'medium',
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    switch (arg) {
      case '--slot':
        options.slots.push(next);
        index += 1;
        break;
      case '--output-dir':
        options.outputDir = resolveOutputPath(next);
        index += 1;
        break;
      case '--quality':
        options.quality = next as OpenAiImageQuality;
        index += 1;
        break;
      case '--extra':
        options.extra = next;
        index += 1;
        break;
      default:
        break;
    }
  }

  return options;
}

function buildOnboardingArtPrompt(slot: OnboardingSlot, extra?: string): string {
  const palette = slot.paletteOverride ?? EMOTION_PALETTES[slot.emotion];
  const expression = EMOTION_EXPRESSIONS[slot.emotion];

  return [
    'Create a storybook scene illustration for a parenting memory journal.',
    `Scene: ${slot.sceneText}${extra ? ` ${extra}` : ''}`,
    'Reference image 1: style reference sheet — source of truth for art style, proportions, linework, texture, and level of detail.',
    'Emotional tone:',
    `${slot.emotion}. ${expression}.`,
    'Expressions must match the emotional tone of the memory, not default to smiling.',
    `Illustration style: ${getStyleDescription('default')}`,
    `Color palette: ${palette}`,
    'Constraints:',
    'No text, no logos, no captions, no speech bubbles, no watermark.',
    'Do not make the image photorealistic, 3D, CGI, or Pixar-like.',
  ].join('\n');
}

async function generateSlot(
  slotId: string,
  slot: OnboardingSlot,
  styleReference: ReferenceImageInput,
  quality: OpenAiImageQuality,
  extra: string | undefined,
  outputDir: URL,
  runId: string,
): Promise<void> {
  console.log(`\n→ [${slotId}]`);

  const prompt = buildOnboardingArtPrompt(slot, extra);
  const started = Date.now();
  const artBytes = await editImageWithModel(prompt, [styleReference], PRIMARY_IMAGE_MODEL, {
    quality,
    outputFormat: 'png',
  });

  if (!artBytes) {
    console.error(`  ✗ [${slotId}] image edit failed (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    return;
  }

  const runDir = new URL(`${runId}-${slotId}/`, outputDir);
  await Deno.mkdir(runDir, { recursive: true });

  await Deno.writeFile(new URL('art.png', runDir), artBytes);
  await Deno.writeFile(new URL('prompt.txt', runDir), new TextEncoder().encode(prompt));

  const meta = {
    slot: slotId,
    emotion: slot.emotion,
    model: PRIMARY_IMAGE_MODEL,
    quality,
    createdAt: new Date().toISOString(),
    extra: extra ?? null,
  };

  await Deno.writeFile(
    new URL('meta.json', runDir),
    new TextEncoder().encode(JSON.stringify(meta, null, 2)),
  );

  console.log(`  ✓ [${slotId}] saved (${((Date.now() - started) / 1000).toFixed(1)}s) → ${runDir.pathname}`);
}

const options = parseArgs(Deno.args);

const unknownSlots = options.slots.filter((slotId) => !ALL_SLOT_IDS.includes(slotId));
if (unknownSlots.length > 0) {
  console.error(`Unknown slot(s): ${unknownSlots.join(', ')}. Options: ${ALL_SLOT_IDS.join(', ')}`);
  Deno.exit(1);
}

if (!ALLOWED_QUALITIES.has(options.quality)) {
  console.error(`Invalid --quality "${options.quality}". Options: low, medium, high`);
  Deno.exit(1);
}

if (!Deno.env.get('OPENAI_API_KEY')) {
  console.error('Missing OPENAI_API_KEY in supabase/.env.local');
  Deno.exit(1);
}

await Deno.mkdir(options.outputDir, { recursive: true });

const slotIds = options.slots.length > 0 ? options.slots : ALL_SLOT_IDS;
const runId = new Date().toISOString().replace(/[:.]/g, '-');

const rawStyleBytes = await Deno.readFile(styleReferenceUrl);
const cappedStyle = await capImageMaxEdge(rawStyleBytes, MAX_PORTRAIT_REFERENCE_EDGE, 'image/png');
const styleReference: ReferenceImageInput = {
  bytes: cappedStyle.bytes,
  contentType: cappedStyle.contentType,
  filename: 'reference-1-style.png',
};

console.log(`Onboarding art run ${runId} — ${slotIds.length} slot(s)`);
console.log(`Model: ${PRIMARY_IMAGE_MODEL} (quality: ${options.quality})`);
console.log(`Slots: ${slotIds.join(', ')}`);

for (const slotId of slotIds) {
  await generateSlot(
    slotId,
    ONBOARDING_SLOTS[slotId],
    styleReference,
    options.quality,
    options.extra,
    options.outputDir,
    runId,
  );
}

console.log(`\nDone. Output under ${options.outputDir.pathname}`);
