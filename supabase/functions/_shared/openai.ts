const DEFAULT_CHAT_MODEL = 'gpt-4o-mini';
const DEFAULT_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';
const PRIMARY_IMAGE_MODEL = 'gpt-image-2';
const FALLBACK_IMAGE_MODEL = 'gpt-image-1.5';
const MODELS_SUPPORTING_INPUT_FIDELITY = new Set([FALLBACK_IMAGE_MODEL]);

export interface OpenAiRequestOptions {
  signal?: AbortSignal;
}

export type OpenAiImageQuality = 'low' | 'medium' | 'high' | 'auto';
export type OpenAiImageOutputFormat = 'jpeg' | 'png' | 'webp';

export interface OpenAiImageRequestOptions extends OpenAiRequestOptions {
  /**
   * The Image API's output-quality setting. Keeping this explicit matters
   * for request-tail latency: `auto` may choose an expensive output for a
   * multi-character edit.
   */
  quality?: OpenAiImageQuality;
  /** Match the persisted object format instead of storing PNG bytes as .webp. */
  outputFormat?: OpenAiImageOutputFormat;
  outputCompression?: number;
  /**
   * Start the alternate edit model after this delay while the primary is
   * still running. Used only for larger multi-reference illustration jobs,
   * where a single slow provider call would otherwise consume the whole Edge
   * request budget. The first successful image wins and aborts the loser.
   */
  fallbackHedgeDelayMs?: number;
}

export { FALLBACK_IMAGE_MODEL, PRIMARY_IMAGE_MODEL };

function getOpenAiKey(): string {
  const apiKey = Deno.env.get('OPENAI_API_KEY');

  if (!apiKey) {
    throw new Error('Missing OPENAI_API_KEY');
  }

  return apiKey;
}

function throwIfAborted(options: OpenAiRequestOptions): void {
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new DOMException('OpenAI request aborted', 'AbortError');
  }
}

class NonRetryableImageRequestError extends Error {}

function isRetryableImageStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export async function chatJson<T>(
  systemPrompt: string,
  userPrompt: string,
  options: OpenAiRequestOptions = {},
): Promise<T> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getOpenAiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: DEFAULT_CHAT_MODEL,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(`OpenAI chat failed (${response.status})`);
  }

  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;

  if (!content || typeof content !== 'string') {
    throw new Error('OpenAI chat returned empty content');
  }

  return JSON.parse(content) as T;
}

export interface VisionImageInput {
  base64: string;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
}

export async function chatJsonWithVision<T>(
  systemPrompt: string,
  userText: string | null,
  image: VisionImageInput,
): Promise<T> {
  const userContent: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];

  if (userText?.trim()) {
    userContent.push({ type: 'text', text: userText.trim() });
  }

  userContent.push({
    type: 'image_url',
    image_url: {
      url: `data:${image.contentType};base64,${image.base64}`,
    },
  });

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getOpenAiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: DEFAULT_CHAT_MODEL,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI vision chat failed (${response.status})`);
  }

  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;

  if (!content || typeof content !== 'string') {
    throw new Error('OpenAI vision chat returned empty content');
  }

  return JSON.parse(content) as T;
}

export async function transcribeAudio(
  audioBase64: string,
  prompt: string,
): Promise<string> {
  const audioBytes = base64ToBytes(audioBase64);
  const formData = new FormData();
  formData.append('file', new Blob([audioBytes], { type: 'audio/m4a' }), 'recording.m4a');
  formData.append('model', DEFAULT_TRANSCRIBE_MODEL);
  formData.append('response_format', 'json');
  formData.append('prompt', prompt);

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getOpenAiKey()}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`OpenAI transcription failed (${response.status}): ${errorBody.slice(0, 240)}`);
  }

  const payload = await response.json();
  const text = payload.text;

  if (!text || typeof text !== 'string') {
    throw new Error('OpenAI transcription returned empty text');
  }

  return text.trim();
}

async function generateImageWithModel(
  prompt: string,
  model: string,
  options: OpenAiImageRequestOptions = {},
): Promise<Uint8Array> {
  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getOpenAiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      prompt,
      size: '1024x1024',
      ...(options.quality ? { quality: options.quality } : {}),
      ...(options.outputFormat ? { output_format: options.outputFormat } : {}),
      ...(options.outputCompression !== undefined
        ? { output_compression: options.outputCompression }
        : {}),
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    console.error('OpenAI image generation failed', { model, status: response.status });
    // A second model cannot fix an invalid request, an authentication error,
    // or a policy refusal. Do not turn those into duplicate paid requests.
    if (response.status >= 400 && response.status < 500 && !isRetryableImageStatus(response.status)) {
      throw new NonRetryableImageRequestError(
        `OpenAI image generation failed (${model}, ${response.status})`,
      );
    }
    throw new Error(`OpenAI image generation failed (${model}, ${response.status})`);
  }

  const payload = await response.json();
  const base64 = payload.data?.[0]?.b64_json;

  if (!base64 || typeof base64 !== 'string') {
    throw new Error(`OpenAI image generation returned empty image (${model})`);
  }

  return base64ToBytes(base64);
}

export async function generateImage(
  prompt: string,
  options: OpenAiImageRequestOptions = {},
): Promise<Uint8Array> {
  try {
    return await generateImageWithModel(prompt, PRIMARY_IMAGE_MODEL, options);
  } catch (primaryError) {
    throwIfAborted(options);
    if (primaryError instanceof NonRetryableImageRequestError) {
      throw primaryError;
    }
    console.error(
      'OpenAI image generation primary model failed',
      primaryError instanceof Error ? primaryError.message : 'unknown',
    );
    return await generateImageWithModel(prompt, FALLBACK_IMAGE_MODEL, options);
  }
}

export interface ReferenceImageInput {
  bytes: Uint8Array;
  contentType: string;
  filename: string;
}

export async function editImageWithModel(
  prompt: string,
  referenceImages: ReferenceImageInput[],
  model: string,
  options: OpenAiImageRequestOptions = {},
): Promise<Uint8Array | null> {
  return editImagesWithModel(prompt, referenceImages, model, options);
}

async function editImagesWithModel(
  prompt: string,
  referenceImages: ReferenceImageInput[],
  model: string,
  options: OpenAiImageRequestOptions = {},
): Promise<Uint8Array | null> {
  const formData = new FormData();
  formData.append('model', model);
  formData.append('prompt', prompt);
  formData.append('size', '1024x1024');
  if (options.quality) {
    formData.append('quality', options.quality);
  }
  if (options.outputFormat) {
    formData.append('output_format', options.outputFormat);
  }
  if (options.outputCompression !== undefined) {
    formData.append('output_compression', String(options.outputCompression));
  }

  if (referenceImages.length > 1 && MODELS_SUPPORTING_INPUT_FIDELITY.has(model)) {
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

  const response = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getOpenAiKey()}`,
    },
    body: formData,
    signal: options.signal,
  });

  if (!response.ok) {
    console.error('OpenAI image edit failed', { model, status: response.status });
    // A second model cannot fix an invalid request, an authentication error,
    // or a policy refusal. Do not turn those into duplicate paid requests.
    if (response.status >= 400 && response.status < 500 && !isRetryableImageStatus(response.status)) {
      throw new NonRetryableImageRequestError(
        `OpenAI image edit failed (${model}, ${response.status})`,
      );
    }
    return null;
  }

  const payload = await response.json();
  const base64 = payload.data?.[0]?.b64_json;

  if (!base64 || typeof base64 !== 'string') {
    console.error('OpenAI image edit returned empty image', model);
    return null;
  }

  return base64ToBytes(base64);
}

export async function editImageWithReferences(
  prompt: string,
  referenceImages: ReferenceImageInput[],
  options: OpenAiImageRequestOptions = {},
): Promise<Uint8Array> {
  throwIfAborted(options);

  if (referenceImages.length === 0) {
    return generateImage(prompt, options);
  }

  const runEdit = async (
    model: string,
    signal: AbortSignal,
  ): Promise<Uint8Array | null> => {
    try {
      const image = await editImagesWithModel(prompt, referenceImages, model, { ...options, signal });
      if (signal.aborted) {
        throw signal.reason ?? new DOMException('OpenAI image edit aborted', 'AbortError');
      }
      return image;
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      if (error instanceof NonRetryableImageRequestError) {
        throw error;
      }

      console.error(
        'OpenAI image edit request failed',
        model,
        error instanceof Error ? error.message : 'unknown',
      );
      return null;
    }
  };

  // A three-or-more-character request is the tail-latency case in practice:
  // gpt-image-2 always processes reference images at high fidelity. Start a
  // second compatible edit only after the primary has been slow for a while,
  // rather than abandoning an otherwise-good primary at an arbitrary cutoff.
  // This keeps normal jobs single-provider while giving slow jobs a genuine
  // second chance inside the function-wide deadline.
  if (options.fallbackHedgeDelayMs !== undefined) {
    const primaryController = new AbortController();
    const fallbackController = new AbortController();
    const abortForParent = () => {
      primaryController.abort(options.signal?.reason);
      fallbackController.abort(options.signal?.reason);
    };
    options.signal?.addEventListener('abort', abortForParent, { once: true });

    let fallbackStarted = false;
    const fallbackState: { promise: Promise<Uint8Array | null> | null } = { promise: null };
    const startFallback = (): Promise<Uint8Array | null> => {
      if (!fallbackStarted) {
        fallbackStarted = true;
        fallbackState.promise = runEdit(FALLBACK_IMAGE_MODEL, fallbackController.signal);
      }
      return fallbackState.promise!;
    };

    const primaryPromise = runEdit(PRIMARY_IMAGE_MODEL, primaryController.signal);
    let signalHedge: (() => void) | null = null;
    const hedgeReached = new Promise<void>((resolve) => {
      signalHedge = resolve;
    });
    const hedgeTimer = setTimeout(() => {
      if (options.signal?.aborted) {
        return;
      }
      startFallback();
      signalHedge?.();
    }, options.fallbackHedgeDelayMs);

    type EditOutcome = {
      source: 'primary' | 'fallback';
      image: Uint8Array | null;
      nonRetryableError?: NonRetryableImageRequestError;
    };
    const observeEdit = (
      source: EditOutcome['source'],
      edit: Promise<Uint8Array | null>,
    ): Promise<EditOutcome> => edit.then(
      (image) => ({ source, image }),
      (error) => {
        if (error instanceof NonRetryableImageRequestError) {
          return { source, image: null, nonRetryableError: error };
        }
        throw error;
      },
    );

    const resolveFirstSuccessfulEdit = async (): Promise<Uint8Array | null> => {
      const first = await Promise.race([
        observeEdit('primary', primaryPromise),
        hedgeReached.then(() => ({ source: 'hedge' as const, image: null })),
      ]);

      if (first.source === 'primary') {
        if (first.nonRetryableError) {
          fallbackController.abort('Primary image edit was not retryable');
          throw first.nonRetryableError;
        }
        if (first.image) {
          fallbackController.abort('Primary image edit completed first');
          return first.image;
        }

        clearTimeout(hedgeTimer);
        const fallbackEdit = await startFallback();
        if (fallbackEdit) {
          return fallbackEdit;
        }
        return null;
      }

      const fallback = startFallback();
      const winner = await Promise.race([
        observeEdit('primary', primaryPromise),
        observeEdit('fallback', fallback),
      ]);

      if (winner.nonRetryableError && winner.source === 'primary') {
        fallbackController.abort('Primary image edit was not retryable');
        throw winner.nonRetryableError;
      }
      if (winner.image) {
        if (winner.source === 'primary') {
          fallbackController.abort('Primary image edit completed first');
        } else {
          primaryController.abort('Fallback image edit completed first');
        }
        return winner.image;
      }

      const other = winner.source === 'primary'
        ? await observeEdit('fallback', fallback)
        : await observeEdit('primary', primaryPromise);
      if (other.nonRetryableError) {
        throw other.nonRetryableError;
      }
      return other.image;
    };

    try {
      const image = await resolveFirstSuccessfulEdit();
      if (image) {
        return image;
      }
    } finally {
      clearTimeout(hedgeTimer);
      primaryController.abort('Image edit finished');
      fallbackController.abort('Image edit finished');
      // A cancelled losing request may reject after the winner returned.
      // Observe it so cancellation never becomes an unhandled rejection.
      const pendingFallback = fallbackState.promise;
      if (pendingFallback) {
        void pendingFallback.catch(() => undefined);
      }
      options.signal?.removeEventListener('abort', abortForParent);
    }
  } else {
    const primaryEdit = await runEdit(PRIMARY_IMAGE_MODEL, options.signal ?? new AbortController().signal);
    if (primaryEdit) {
      return primaryEdit;
    }
    throwIfAborted(options);

    const fallbackEdit = await runEdit(FALLBACK_IMAGE_MODEL, options.signal ?? new AbortController().signal);
    if (fallbackEdit) {
      return fallbackEdit;
    }
  }
  throwIfAborted(options);

  // A text-only generation after reference edits fail would lose the family
  // characters that make a Momora illustration meaningful. It also used to
  // add two more provider calls after the edit path had already exhausted the
  // request budget. Preserve the explicit no-reference generation branch
  // above, but fail reference-based jobs cleanly so the user can retry.
  throw new Error('OpenAI image edit failed for all reference-aware models');
}

export async function editImageWithReference(
  prompt: string,
  referenceImageBytes: Uint8Array,
  referenceContentType = 'image/webp',
  options: OpenAiImageRequestOptions = {},
): Promise<Uint8Array> {
  return editImageWithReferences(prompt, [
    {
      bytes: referenceImageBytes,
      contentType: referenceContentType,
      filename: 'reference.webp',
    },
  ], options);
}

export function encodeBytesToBase64(bytes: Uint8Array): string {
  return bytesToBase64(bytes);
}

export function decodeBase64ToBytes(base64: string): Uint8Array {
  return base64ToBytes(base64);
}

export function estimateAudioDurationSeconds(audioBase64: string): number {
  const bytes = base64ToBytes(audioBase64);
  // Rough AAC/m4a estimate for validation guardrails only.
  return bytes.length / 16000;
}
