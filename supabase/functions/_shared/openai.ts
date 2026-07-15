const DEFAULT_CHAT_MODEL = 'gpt-4o-mini';
const DEFAULT_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';
const PRIMARY_IMAGE_MODEL = 'gpt-image-2';
const FALLBACK_IMAGE_MODEL = 'gpt-image-1';
const MODELS_SUPPORTING_INPUT_FIDELITY = new Set([FALLBACK_IMAGE_MODEL]);

export interface OpenAiImageRequestOptions {
  signal?: AbortSignal;
}

export { FALLBACK_IMAGE_MODEL, PRIMARY_IMAGE_MODEL };

function getOpenAiKey(): string {
  const apiKey = Deno.env.get('OPENAI_API_KEY');

  if (!apiKey) {
    throw new Error('Missing OPENAI_API_KEY');
  }

  return apiKey;
}

async function readOpenAiErrorSnippet(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return '';
  }
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

export async function chatJson<T>(systemPrompt: string, userPrompt: string): Promise<T> {
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
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    const detail = await readOpenAiErrorSnippet(response);
    throw new Error(
      `OpenAI image generation failed (${model}, ${response.status})${detail ? `: ${detail}` : ''}`,
    );
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
    const detail = await readOpenAiErrorSnippet(response);
    console.error('OpenAI image edit failed', model, response.status, detail || 'no response body');
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
  if (referenceImages.length === 0) {
    return generateImage(prompt, options);
  }

  const primaryEdit = await editImagesWithModel(
    prompt,
    referenceImages,
    PRIMARY_IMAGE_MODEL,
    options,
  );
  if (primaryEdit) {
    return primaryEdit;
  }

  const fallbackEdit = await editImagesWithModel(
    prompt,
    referenceImages,
    FALLBACK_IMAGE_MODEL,
    options,
  );
  if (fallbackEdit) {
    return fallbackEdit;
  }

  console.error('OpenAI image edit exhausted; falling back to generation');
  return generateImage(prompt, options);
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
