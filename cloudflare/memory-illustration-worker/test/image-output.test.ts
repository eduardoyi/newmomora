import { describe, expect, it, vi } from 'vitest';

import { resolveOutputBytesForR2, sniffImageFormat } from '../src/image-output';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00];
const JPEG_MAGIC = [0xff, 0xd8, 0xff, 0x00, 0x00];
const WEBP_MAGIC = [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50];

function stream(bytes: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

function imagesEnv(outputBytes: number[]): Env {
  const transform = {
    transform: () => transform,
    output: async () => ({ image: () => stream(outputBytes) }),
  };
  return { IMAGES: { input: vi.fn(() => transform) } } as unknown as Env;
}

function throwingImagesEnv(): Env {
  return {
    IMAGES: {
      input: vi.fn(() => {
        throw new Error('IMAGES binding unavailable');
      }),
    },
  } as unknown as Env;
}

describe('sniffImageFormat', () => {
  it('recognizes the PNG signature', () => {
    expect(sniffImageFormat(new Uint8Array(PNG_MAGIC))).toBe('png');
  });

  it('recognizes the JPEG signature', () => {
    expect(sniffImageFormat(new Uint8Array(JPEG_MAGIC))).toBe('jpeg');
  });

  it('recognizes the RIFF....WEBP container signature', () => {
    expect(sniffImageFormat(new Uint8Array(WEBP_MAGIC))).toBe('webp');
  });

  it('returns null for unrecognized or too-short bytes', () => {
    expect(sniffImageFormat(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(sniffImageFormat(new Uint8Array([]))).toBeNull();
    expect(sniffImageFormat(new Uint8Array([0x89, 0x50]))).toBeNull();
  });
});

describe('resolveOutputBytesForR2', () => {
  it('passes real webp bytes through unchanged and never calls IMAGES', async () => {
    const env = imagesEnv([9, 9, 9]);
    const bytes = new Uint8Array(WEBP_MAGIC).buffer;

    const result = await resolveOutputBytesForR2(env, bytes);

    expect(result.contentType).toBe('image/webp');
    expect(new Uint8Array(result.bytes)).toEqual(new Uint8Array(WEBP_MAGIC));
    expect(env.IMAGES.input).not.toHaveBeenCalled();
  });

  it('re-encodes real PNG bytes to webp via the Images binding', async () => {
    const env = imagesEnv([1, 1, 1]);
    const bytes = new Uint8Array(PNG_MAGIC).buffer;

    const result = await resolveOutputBytesForR2(env, bytes);

    expect(result.contentType).toBe('image/webp');
    expect(new Uint8Array(result.bytes)).toEqual(new Uint8Array([1, 1, 1]));
    expect(env.IMAGES.input).toHaveBeenCalledTimes(1);
  });

  it('re-encodes real JPEG bytes to webp via the Images binding', async () => {
    const env = imagesEnv([2, 2, 2]);
    const bytes = new Uint8Array(JPEG_MAGIC).buffer;

    const result = await resolveOutputBytesForR2(env, bytes);

    expect(result.contentType).toBe('image/webp');
    expect(new Uint8Array(result.bytes)).toEqual(new Uint8Array([2, 2, 2]));
    expect(env.IMAGES.input).toHaveBeenCalledTimes(1);
  });

  it('fails open to the original bytes and sniffed content type when re-encoding throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = throwingImagesEnv();
    const bytes = new Uint8Array(PNG_MAGIC).buffer;

    const result = await resolveOutputBytesForR2(env, bytes);

    expect(result.contentType).toBe('image/png');
    expect(new Uint8Array(result.bytes)).toEqual(new Uint8Array(PNG_MAGIC));
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('fails open to the sniffed JPEG content type when re-encoding throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = throwingImagesEnv();
    const bytes = new Uint8Array(JPEG_MAGIC).buffer;

    const result = await resolveOutputBytesForR2(env, bytes);

    expect(result.contentType).toBe('image/jpeg');
    expect(new Uint8Array(result.bytes)).toEqual(new Uint8Array(JPEG_MAGIC));
    errorSpy.mockRestore();
  });

  it('stores unrecognized bytes unchanged under image/webp and never calls IMAGES', async () => {
    const env = imagesEnv([9, 9, 9]);
    const garbage = new Uint8Array([1, 2, 3, 4]).buffer;

    const result = await resolveOutputBytesForR2(env, garbage);

    expect(result.contentType).toBe('image/webp');
    expect(new Uint8Array(result.bytes)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(env.IMAGES.input).not.toHaveBeenCalled();
  });
});
