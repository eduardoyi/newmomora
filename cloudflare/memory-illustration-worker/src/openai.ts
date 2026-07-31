import type { IllustrationModel, ImageProviderResult, ImageUsage, LoadedReference } from './types';

const OPENAI_IMAGE_EDITS_URL = 'https://api.openai.com/v1/images/edits';

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
  if (model === 'gpt-image-1.5' && references.length > 1) {
    form.set('input_fidelity', 'high');
  }
  for (const [index, reference] of references.entries()) {
    form.append('image[]', new Blob([reference.bytes], { type: 'image/webp' }), `reference-${index + 1}.webp`);
  }

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

function decodeBase64(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}
