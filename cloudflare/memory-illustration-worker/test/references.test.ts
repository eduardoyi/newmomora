import { describe, expect, it, vi } from 'vitest';

import { loadIllustrationReferences } from '../src/references';

function body(bytes: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

describe('reference loading', () => {
  it('reads portrait and profile fallbacks from their source buckets, never the output bucket', async () => {
    const outputGet = vi.fn();
    const portraitGet = vi.fn(async () => null);
    const profileGet = vi.fn(async () => ({ body: body([1, 2, 3]) }));
    const transform = {
      transform: () => transform,
      output: async () => ({ image: () => body([4, 5, 6]) }),
    };
    const env = {
      MEMORY_ILLUSTRATIONS: { get: outputGet },
      CHARACTER_PORTRAITS: { get: portraitGet },
      PROFILE_PICTURES: { get: profileGet },
      IMAGES: { input: () => transform },
    } as unknown as Env;

    const references = await loadIllustrationReferences(env, [{
      memberId: 'member-id',
      description: 'A child',
      portraitKey: 'portrait.webp',
      portraitContentType: 'image/webp',
      profileKey: 'profile.jpg',
      profileContentType: 'image/jpeg',
    }]);

    expect(references).toHaveLength(1);
    expect(portraitGet).toHaveBeenCalledWith('portrait.webp');
    expect(profileGet).toHaveBeenCalledWith('profile.jpg');
    expect(outputGet).not.toHaveBeenCalled();
  });

  it('loads members concurrently but keeps candidate order and drops unusable ones', async () => {
    const releases: Array<() => void> = [];
    const portraitGet = vi.fn((key: string) => new Promise((resolve) => {
      releases.push(() => resolve(key === 'missing.webp' ? null : { body: body([key.length]) }));
    }));
    const env = {
      CHARACTER_PORTRAITS: { get: portraitGet },
      PROFILE_PICTURES: { get: vi.fn(async () => null) },
      IMAGES: {
        input: (stream: ReadableStream<Uint8Array>) => ({
          transform() { return this; },
          output: async () => ({ image: () => stream }),
        }),
      },
    } as unknown as Env;
    const candidate = (memberId: string, portraitKey: string) => ({
      memberId, description: memberId, portraitKey, portraitContentType: 'image/webp', profileKey: null, profileContentType: null,
    });

    const pending = loadIllustrationReferences(env, [
      candidate('first', 'a.webp'),
      candidate('gone', 'missing.webp'),
      candidate('third', 'ccc.webp'),
    ]);
    await vi.waitFor(() => expect(portraitGet).toHaveBeenCalledTimes(3));
    for (const release of releases.reverse()) release();

    expect((await pending).map((reference) => reference.description)).toEqual(['first', 'third']);
  });

  it('uses the original image bytes when the Images binding fails, but not non-images', async () => {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2];
    const failingImages = {
      input: () => ({
        transform() { return this; },
        output: async () => { throw new Error('IMAGES_TRANSFORM_ERROR 9523: Internal error.'); },
      }),
    };
    const env = {
      CHARACTER_PORTRAITS: { get: vi.fn(async (key: string) => ({ body: body(key === 'garbage.webp' ? [9, 9, 9] : png) })) },
      PROFILE_PICTURES: { get: vi.fn(async () => null) },
      IMAGES: failingImages,
    } as unknown as Env;
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const candidate = (memberId: string, portraitKey: string) => ({
      memberId, description: memberId, portraitKey, portraitContentType: 'image/webp', profileKey: null, profileContentType: null,
    });

    const references = await loadIllustrationReferences(env, [candidate('ok', 'ok.webp'), candidate('bad', 'garbage.webp')]);

    expect(references.map((reference) => reference.description)).toEqual(['ok']);
    expect([...new Uint8Array(references[0].bytes)]).toEqual(png);
    error.mockRestore();
  });
});

