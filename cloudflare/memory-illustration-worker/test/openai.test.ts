import { afterEach, describe, expect, it, vi } from 'vitest';

import { editImage, ImageProviderError } from '../src/openai';

const fakeEnv = { OPENAI_API_KEY: 'test-openai-key' } as Env;
const references = [{ description: 'A child', bytes: new Uint8Array([1, 2, 3]).buffer }];

afterEach(() => vi.unstubAllGlobals());

describe('OpenAI error classification', () => {
  it('does not fall back after moderation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(
      { error: { code: 'moderation_blocked' } },
      { status: 400 },
    )));
    await expect(editImage(fakeEnv, 'gpt-image-2', 'safe prompt', references, undefined, new AbortController().signal))
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

  it('classifies malformed 200 responses as retryable instead of terminal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{not-json', { status: 200 })));
    await expect(editImage(fakeEnv, 'gpt-image-2', 'safe prompt', references, undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'OPENAI_MALFORMED_RESPONSE', retryable: true });
  });
});
