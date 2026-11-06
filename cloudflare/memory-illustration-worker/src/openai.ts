import { parseUsage as parseVisionUsage } from './gallery-vision';
import { sniffImageFormat } from './image-output';
import type {
  IllustrationModel,
  ImageProviderResult,
  ImageUsage,
  LoadedReference,
  MotionCheckResult,
} from './types';

const OPENAI_IMAGE_EDITS_URL = 'https://api.openai.com/v1/images/edits';
const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
const MOTION_CHECK_MODEL = 'gpt-6-luna';
const MOTION_CHECK_KEYS = ['same_person', 'equal_panels', 'no_text_or_borders', 'stable_framing'] as const;
// The API defaults 2.6 to `high` planning. On real memories `medium` was ~1s
// faster than `high` with no visible quality loss (2026-11-04 eval); keep in
// sync with supabase/functions/_shared/openai.ts.
const GPT_IMAGE_2_6_COMPLEXITY = 'medium';

export class ImageProviderError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(code);
  }
}

function isModerationError(body: unknown): boolean {
  if (!body || typeof body !== 'object') {
    return false;
  }
  const error = (body as { error?: { code?: unknown } }).error;
  return error?.code === 'moderation_blocked' || error?.code === 'content_policy_violation';
}

export async function editImage(
  env: Env,
  model: IllustrationModel,
  prompt: string,
  references: LoadedReference[],
  quality: 'medium' | undefined,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  return (await editImageWithUsage(env, model, prompt, references, quality, signal)).bytes;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Extract only the OpenAI usage dimensions we persist. Never forward raw API bodies. */
export function parseImageUsage(value: unknown): ImageUsage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const usage = value as Record<string, unknown>;
  const inputDetails = usage.input_tokens_details && typeof usage.input_tokens_details === 'object'
    ? usage.input_tokens_details as Record<string, unknown> : {};
  const outputDetails = usage.output_tokens_details && typeof usage.output_tokens_details === 'object'
    ? usage.output_tokens_details as Record<string, unknown> : {};
  return {
    inputTextTokens: nonNegativeInteger(inputDetails.text_tokens ?? usage.input_text_tokens),
    inputImageTokens: nonNegativeInteger(inputDetails.image_tokens ?? usage.input_image_tokens),
    inputCachedTokens: nonNegativeInteger(inputDetails.cached_tokens ?? usage.input_cached_tokens),
    outputTextTokens: nonNegativeInteger(outputDetails.text_tokens ?? usage.output_text_tokens),
    outputImageTokens: nonNegativeInteger(outputDetails.image_tokens ?? usage.output_image_tokens),
  };
}

async function sendImageEdit(
  env: Env,
  form: FormData,
  signal: AbortSignal,
): Promise<ImageProviderResult> {
  let response: Response;
  try {
    response = await fetch(OPENAI_IMAGE_EDITS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: form,
      signal,
    });
  } catch {
    throw new ImageProviderError('OPENAI_NETWORK_ERROR', true);
  }

  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // Preserve a non-PII response classification only.
    }
    if (isModerationError(body)) {
      throw new ImageProviderError('MODERATION_BLOCKED', false);
    }
    throw new ImageProviderError(
      response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500
        ? 'OPENAI_RETRYABLE_ERROR'
        : 'OPENAI_REJECTED',
      response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500,
    );
  }

  let body: { data?: Array<{ b64_json?: string }>; usage?: unknown };
  try {
    body = await response.json() as { data?: Array<{ b64_json?: string }> };
  } catch {
    throw new ImageProviderError('OPENAI_MALFORMED_RESPONSE', true);
  }
  const image = body.data?.[0]?.b64_json;
  if (!image || typeof image !== 'string') {
    throw new ImageProviderError('OPENAI_EMPTY_IMAGE', true);
  }

  try {
    return { bytes: decodeBase64(image), usage: parseImageUsage(body.usage) };
  } catch {
    throw new ImageProviderError('OPENAI_MALFORMED_RESPONSE', true);
  }
}

export async function editImageWithUsage(
  env: Env,
  model: IllustrationModel,
  prompt: string,
  references: LoadedReference[],
  quality: 'medium' | undefined,
  signal: AbortSignal,
): Promise<ImageProviderResult> {
  const form = new FormData();
  form.set('model', model);
  form.set('prompt', prompt);
  form.set('size', '1024x1024');
  form.set('output_format', 'webp');
  form.set('output_compression', '85');
  if (quality) {
    form.set('quality', quality);
  }
  if (model === 'gpt-image-2.6-flare') {
    form.set('complexity', GPT_IMAGE_2_6_COMPLEXITY);
  }
  if (model === 'gpt-image-1.5' && references.length > 1) {
    form.set('input_fidelity', 'high');
  }
  for (const [index, reference] of references.entries()) {
    form.append('image[]', new Blob([reference.bytes], { type: 'image/webp' }), `reference-${index + 1}.webp`);
  }

  return await sendImageEdit(env, form, signal);
}

/**
 * Portraits always edit from two references. Reference order is meaningful to
 * the prompt contract: the canonical style comes first, then the source
 * person. Do not add a text-only fallback here.
 */
export async function editPortraitImage(
  env: Env,
  model: IllustrationModel,
  prompt: string,
  styleReference: LoadedReference,
  sourceReference: LoadedReference,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  return await editImage(
    env,
    model,
    prompt,
    [styleReference, sourceReference],
    'medium',
    signal,
  );
}

export async function editPortraitImageWithUsage(
  env: Env,
  model: IllustrationModel,
  prompt: string,
  styleReference: LoadedReference,
  sourceReference: LoadedReference,
  signal: AbortSignal,
): Promise<ImageProviderResult> {
  return await editImageWithUsage(env, model, prompt, [styleReference, sourceReference], 'medium', signal);
}

/**
 * Living-portrait motion sheet: one edit from the still as the ONLY
 * reference, with the size/quality/complexity the bridge dictates. PNG output
 * is requested because the sheet is QA'd and converted to WebP by the caller.
 */
export async function editMotionSheetWithUsage(
  env: Env,
  model: IllustrationModel,
  prompt: string,
  still: ArrayBuffer,
  options: { size: string; quality: string; complexity: string },
  signal: AbortSignal,
): Promise<ImageProviderResult> {
  const form = new FormData();
  form.set('model', model);
  form.set('prompt', prompt);
  form.set('size', options.size);
  form.set('quality', options.quality);
  form.set('output_format', 'png');
  if (model === 'gpt-image-2.6-flare') {
    form.set('complexity', options.complexity);
  }
  const format = sniffImageFormat(new Uint8Array(still)) ?? 'webp';
  const extension = format === 'jpeg' ? 'jpg' : format;
  form.append('image[]', new Blob([still], { type: `image/${format}` }), `reference-1.${extension}`);
  return await sendImageEdit(env, form, signal);
}

function bytesToDataUrl(bytes: ArrayBuffer, contentType: string): string {
  const view = new Uint8Array(bytes);
  let binary = '';
  for (let index = 0; index < view.length; index += 1) binary += String.fromCharCode(view[index]);
  return `data:${contentType};base64,${btoa(binary)}`;
}

function motionCheckSchema() {
  return {
    name: 'portrait_motion_check',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: [...MOTION_CHECK_KEYS],
      properties: Object.fromEntries(MOTION_CHECK_KEYS.map((key) => [key, { type: 'boolean' }])),
    },
  };
}

/** Strict QA verdict: exactly the four booleans, all true. Anything else fails. */
export function parseMotionCheckVerdict(content: unknown): boolean {
  if (typeof content !== 'string') return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== MOTION_CHECK_KEYS.length || !MOTION_CHECK_KEYS.every((key) => keys.includes(key))) {
    return false;
  }
  return MOTION_CHECK_KEYS.every((key) => record[key] === true);
}

/**
 * Vision QA of a motion sheet against its still (image 1 = still, image 2 =
 * sheet; both must already be downscaled). HTTP/network failures throw
 * ImageProviderError; a completed call whose output cannot be parsed, or a
 * refusal, is a QA failure (`passed: false`) -- never an exception.
 */
export async function checkMotionSheet(
  env: Env,
  checkPrompt: string,
  still: { bytes: ArrayBuffer; contentType: string },
  sheet: { bytes: ArrayBuffer; contentType: string },
  signal: AbortSignal,
): Promise<MotionCheckResult> {
  let response: Response;
  try {
    response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MOTION_CHECK_MODEL,
        reasoning_effort: 'low',
        response_format: { type: 'json_schema', json_schema: motionCheckSchema() },
        messages: [
          { role: 'system', content: 'Follow the schema exactly. Never include commentary.' },
          {
            role: 'user',
            content: [
              { type: 'text', text: checkPrompt },
              { type: 'image_url', image_url: { url: bytesToDataUrl(still.bytes, still.contentType), detail: 'high' } },
              { type: 'image_url', image_url: { url: bytesToDataUrl(sheet.bytes, sheet.contentType), detail: 'high' } },
            ],
          },
        ],
      }),
      signal,
    });
  } catch {
    throw new ImageProviderError('OPENAI_NETWORK_ERROR', true);
  }
  if (!response.ok) {
    const retryable = response.status === 408 || response.status === 409 || response.status === 429 ||
      response.status >= 500;
    throw new ImageProviderError(retryable ? 'OPENAI_RETRYABLE_ERROR' : 'OPENAI_REJECTED', retryable);
  }
  let body: Record<string, unknown>;
  try {
    body = await response.json() as Record<string, unknown>;
  } catch {
    return { passed: false, usage: null };
  }
  const usage = parseVisionUsage(body.usage);
  const message = (body.choices as Array<Record<string, unknown>> | undefined)?.[0]?.message as
    Record<string, unknown> | undefined;
  if (typeof message?.refusal === 'string' && message.refusal.trim().length > 0) {
    return { passed: false, usage };
  }
  return { passed: parseMotionCheckVerdict(message?.content), usage };
}

function decodeBase64(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}
