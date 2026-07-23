import { describe, expect, it, vi } from 'vitest';

import { loadPortraitReferences } from '../src/portrait-references';

function body(bytes: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

describe('portrait reference loading', () => {
  it('requires, resizes, and separates the style and source references', async () => {
    const styleGet = vi.fn(async () => ({ body: body([1, 2, 3]) }));
    const sourceGet = vi.fn(async () => ({ body: body([4, 5, 6]) }));
    const transform = {
      transform: vi.fn(),
      output: vi.fn(async () => ({ image: () => body([7, 8, 9]) })),
    };
    transform.transform.mockReturnValue(transform);
    const env = {
      STYLE_REFERENCES: { get: styleGet },
      PROFILE_PICTURES: { get: sourceGet },
      IMAGES: { input: vi.fn(() => transform) },
    } as unknown as Env;

    const references = await loadPortraitReferences(env, 'source.jpg', '_assets/styles/default.png');

    expect(styleGet).toHaveBeenCalledWith('_assets/styles/default.png');
    expect(sourceGet).toHaveBeenCalledWith('source.jpg');
    expect(transform.transform).toHaveBeenCalledWith({
      width: 1024,
      height: 1024,
      fit: 'scale-down',
    });
    expect(transform.output).toHaveBeenCalledWith({ format: 'image/webp', quality: 85 });
    expect(references.style.bytes).toBeInstanceOf(ArrayBuffer);
    expect(references.source.bytes).toBeInstanceOf(ArrayBuffer);
  });

  it('fails before generation if the frozen style or source reference cannot be read', async () => {
    const transform = {
      transform: () => transform,
      output: async () => ({ image: () => body([1]) }),
    };
    const noStyle = {
      STYLE_REFERENCES: { get: vi.fn(async () => null) },
      PROFILE_PICTURES: { get: vi.fn(async () => ({ body: body([1]) })) },
      IMAGES: { input: () => transform },
    } as unknown as Env;
    const noSource = {
      STYLE_REFERENCES: { get: vi.fn(async () => ({ body: body([1]) })) },
      PROFILE_PICTURES: { get: vi.fn(async () => null) },
      IMAGES: { input: () => transform },
    } as unknown as Env;

    await expect(loadPortraitReferences(noStyle, 'source.jpg', 'style.png'))
      .rejects.toMatchObject({ code: 'STYLE_REFERENCE_UNAVAILABLE' });
    await expect(loadPortraitReferences(noSource, 'source.jpg', 'style.png'))
      .rejects.toMatchObject({ code: 'SOURCE_REFERENCE_UNAVAILABLE' });
  });
});
