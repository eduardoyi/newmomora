import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  checkMotionSheet,
  editImage,
  editMotionSheetWithUsage,
  ImageProviderError,
  parseImageUsage,
  parseMotionCheckVerdict,
} from '../src/openai';
import { priceImageUsage, priceVisionUsage } from '../src/pricing';

const fakeEnv = { OPENAI_API_KEY: 'test-openai-key' } as Env;
const references = [{ description: 'A child', bytes: new Uint8Array([1, 2, 3]).buffer }];

afterEach(() => vi.unstubAllGlobals());

describe('OpenAI error classification', () => {
  it('allowlists nested image usage and prices split output categories', () => {
    const usage = parseImageUsage({
      input_tokens_details: { text_tokens: 10, image_tokens: 20, cached_tokens: 3, ignored: 999 },
      output_tokens_details: { text_tokens: 4, image_tokens: 5, ignored: 999 },
      prompt: 'must not persist',
    });
    expect(usage).toEqual({
      inputTextTokens: 10,
      inputImageTokens: 20,
      inputCachedTokens: 3,
      outputTextTokens: 4,
      outputImageTokens: 5,
    });
    expect(priceImageUsage('gpt-image-1.5', usage)).toMatchObject({
      costBasis: 'provider_usage', costIsComplete: true, estimatedCostUsd: 0.000434,
    });
  });

  it('marks missing usage unpriced instead of guessing a token count', () => {
    expect(parseImageUsage({ input_tokens_details: { text_tokens: 1 } })).toMatchObject({
      inputImageTokens: null, outputImageTokens: null,
    });
    expect(priceImageUsage('gpt-image-2.5-flare', null)).toEqual({
      costBasis: 'unpriced', costIsComplete: false, estimatedCostUsd: null,
    });
  });
  it('does not fall back after moderation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(
      { error: { code: 'moderation_blocked' } },
      { status: 400 },
    )));
    await expect(editImage(fakeEnv, 'gpt-image-2.6-flare', 'safe prompt', references, undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'MODERATION_BLOCKED', retryable: false });
  });

  it('uses high fidelity only on the gpt-image-1.5 multi-reference fallback', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body as FormData;
      expect(form.get('input_fidelity')).toBe('high');
      return Response.json({ data: [{ b64_json: 'AQI=' }] });
    });
    vi.stubGlobal('fetch', fetchMock);
    await editImage(
      fakeEnv,
      'gpt-image-1.5',
      'safe prompt',
      [references[0], { description: 'A parent', bytes: new Uint8Array([4]).buffer }],
      'medium',
      new AbortController().signal,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks GPT Image 2.6 for medium complexity and never sends it to older models', async () => {
    const complexities: Array<FormDataEntryValue | null> = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      complexities.push((init?.body as FormData).get('complexity'));
      return Response.json({ data: [{ b64_json: 'AQI=' }] });
    }));
    await editImage(fakeEnv, 'gpt-image-2.6-flare', 'safe prompt', references, 'medium', new AbortController().signal);
    await editImage(fakeEnv, 'gpt-image-1.5', 'safe prompt', references, 'medium', new AbortController().signal);
    expect(complexities).toEqual(['medium', null]);
  });

  it('classifies malformed 200 responses as retryable instead of terminal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{not-json', { status: 200 })));
    await expect(editImage(fakeEnv, 'gpt-image-2.6-flare', 'safe prompt', references, undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'OPENAI_MALFORMED_RESPONSE', retryable: true });
  });
});


describe('Flare pricing', () => {
  it('prices image output and leaves ambiguous cached usage incomplete', () => {
    const usage = { inputTextTokens: 10, inputImageTokens: 20, inputCachedTokens: 0, outputTextTokens: 0, outputImageTokens: 5 };
    expect(priceImageUsage('gpt-image-2.5-flare', usage)).toEqual({ costBasis: 'provider_usage', costIsComplete: true, estimatedCostUsd: 0.00036 });
    expect(priceImageUsage('gpt-image-2.5-flare', { ...usage, inputCachedTokens: 3 })).toMatchObject({ costIsComplete: false, estimatedCostUsd: null });
    expect(priceImageUsage('gpt-image-2.6-flare', usage)).toEqual({ costBasis: 'provider_usage', costIsComplete: true, estimatedCostUsd: 0.00036 });
    expect(priceImageUsage('gpt-image-2.6-flare', { ...usage, inputCachedTokens: 3 })).toMatchObject({ costIsComplete: false, estimatedCostUsd: null });
  });
});

describe('motion sheet edit', () => {
  const still = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]).buffer;
  const options = { size: '1536x1536', quality: 'medium', complexity: 'medium' };

  it('sends only the still with explicit size/quality/complexity and PNG output, returning bytes and usage', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
      data: [{ b64_json: 'AQI=' }],
      usage: {
        input_tokens_details: { text_tokens: 1, image_tokens: 2, cached_tokens: 0 },
        output_tokens_details: { text_tokens: 0, image_tokens: 3 },
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await editMotionSheetWithUsage(
      fakeEnv, 'gpt-image-2.6-flare', 'a prompt', still, options, new AbortController().signal,
    );

    expect(Array.from(new Uint8Array(result.bytes))).toEqual([1, 2]);
    expect(result.usage).toEqual({
      inputTextTokens: 1, inputImageTokens: 2, inputCachedTokens: 0, outputTextTokens: 0, outputImageTokens: 3,
    });
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.openai.com/v1/images/edits');
    const form = fetchMock.mock.calls[0][1]?.body as FormData;
    expect(form.get('model')).toBe('gpt-image-2.6-flare');
    expect(form.get('size')).toBe('1536x1536');
    expect(form.get('quality')).toBe('medium');
    expect(form.get('complexity')).toBe('medium');
    expect(form.get('output_format')).toBe('png');
    expect(form.get('output_compression')).toBeNull();
    expect(form.get('input_fidelity')).toBeNull();
    const files = form.getAll('image[]') as File[];
    expect(files).toHaveLength(1);
    expect(files[0].type).toBe('image/webp');
  });

  it('omits complexity for models that do not take it', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ data: [{ b64_json: 'AQI=' }] }));
    vi.stubGlobal('fetch', fetchMock);
    await editMotionSheetWithUsage(fakeEnv, 'gpt-image-1.5', 'p', still, options, new AbortController().signal);
    expect((fetchMock.mock.calls[0][1]?.body as FormData).get('complexity')).toBeNull();
  });

  it.each([
    [{ error: { code: 'moderation_blocked' } }, 400, 'MODERATION_BLOCKED', false],
    [{ error: { code: 'invalid_request_error' } }, 400, 'OPENAI_REJECTED', false],
    [{}, 429, 'OPENAI_RETRYABLE_ERROR', true],
    [{}, 503, 'OPENAI_RETRYABLE_ERROR', true],
  ])('classifies provider failures (%j, %i)', async (body, status, code, retryable) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(body, { status })));
    await expect(editMotionSheetWithUsage(
      fakeEnv, 'gpt-image-2.6-flare', 'p', still, options, new AbortController().signal,
    )).rejects.toMatchObject({ code, retryable });
  });

  it('treats a network failure as retryable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network'); }));
    await expect(editMotionSheetWithUsage(
      fakeEnv, 'gpt-image-2.6-flare', 'p', still, options, new AbortController().signal,
    )).rejects.toBeInstanceOf(ImageProviderError);
  });
});

describe('motion sheet QA', () => {
  const all = { same_person: true, equal_panels: true, no_text_or_borders: true, stable_framing: true };
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  const input = { bytes, contentType: 'image/webp' };

  it('passes only when exactly the four booleans are all true', () => {
    expect(parseMotionCheckVerdict(JSON.stringify(all))).toBe(true);
    for (const key of Object.keys(all)) {
      expect(parseMotionCheckVerdict(JSON.stringify({ ...all, [key]: false }))).toBe(false);
    }
    expect(parseMotionCheckVerdict(JSON.stringify({ ...all, extra: true }))).toBe(false);
    expect(parseMotionCheckVerdict(JSON.stringify({ same_person: true }))).toBe(false);
    expect(parseMotionCheckVerdict('```json\n{}\n```')).toBe(false);
    expect(parseMotionCheckVerdict('null')).toBe(false);
    expect(parseMotionCheckVerdict(undefined)).toBe(false);
  });

  it('posts the prompt then still and sheet to gpt-4o-mini with a strict schema, and returns usage', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
      choices: [{ message: { content: JSON.stringify(all) } }],
      usage: { prompt_tokens: 1200, completion_tokens: 15, total_tokens: 1215 },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkMotionSheet(fakeEnv, 'check prompt', input, input, new AbortController().signal);

    expect(result).toEqual({ passed: true, usage: { inputTokens: 1200, outputTokens: 15, totalTokens: 1215 } });
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as {
      model: string;
      response_format: { json_schema: { strict: boolean; schema: { required: string[] } } };
      messages: Array<{ content: Array<{ type: string; text?: string; image_url?: { url: string } }> | string }>;
    };
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.schema.required).toEqual(Object.keys(all));
    const parts = body.messages[1].content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(parts.map((part) => part.type)).toEqual(['text', 'image_url', 'image_url']);
    expect(parts[0].text).toBe('check prompt');
    expect(parts[1].image_url?.url).toBe('data:image/webp;base64,AQID');
  });

  it('reports a completed call with unusable output as a QA failure that keeps its usage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      choices: [{ message: { content: 'not json' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    })));
    await expect(checkMotionSheet(fakeEnv, 'p', input, input, new AbortController().signal)).resolves.toEqual({
      passed: false, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    });
  });

  it.each([[429, true], [500, true], [400, false], [401, false]])('throws a classified error for HTTP %i', async (status, retryable) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status })));
    await expect(checkMotionSheet(fakeEnv, 'p', input, input, new AbortController().signal))
      .rejects.toMatchObject({ retryable });
  });

  it('prices gpt-4o-mini vision usage with the mirrored rates', () => {
    expect(priceVisionUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 })).toEqual({
      costBasis: 'provider_usage', costIsComplete: true, estimatedCostUsd: 0.75,
    });
    expect(priceVisionUsage(null)).toEqual({ costBasis: 'unpriced', costIsComplete: false, estimatedCostUsd: null });
    expect(priceVisionUsage({ inputTokens: 5, outputTokens: null, totalTokens: null })).toMatchObject({
      costIsComplete: false, estimatedCostUsd: null,
    });
  });
});
