import * as ImageManipulator from 'expo-image-manipulator';

import {
  createImagePreviewForUpload,
  MEMORY_IMAGE_PREVIEW_MAX_DIMENSION,
  MEMORY_IMAGE_PREVIEW_QUALITY,
} from '@/utils/create-image-preview';

const mockedManipulateAsync = ImageManipulator.manipulateAsync as jest.MockedFunction<
  typeof ImageManipulator.manipulateAsync
>;

describe('createImagePreviewForUpload', () => {
  beforeEach(() => {
    mockedManipulateAsync.mockReset();
    mockedManipulateAsync.mockImplementation(async (uri: string) => ({
      uri: `preview:${uri}`,
      width: 0,
      height: 0,
    }));
  });

  it('resizes a landscape image by width and returns a JPEG preview', async () => {
    const result = await createImagePreviewForUpload({
      fileUri: 'file:///wide.jpg',
      width: 4000,
      height: 3000,
    });

    expect(mockedManipulateAsync).toHaveBeenCalledWith(
      'file:///wide.jpg',
      [{ resize: { width: MEMORY_IMAGE_PREVIEW_MAX_DIMENSION } }],
      { compress: MEMORY_IMAGE_PREVIEW_QUALITY, format: ImageManipulator.SaveFormat.JPEG },
    );
    expect(result).toEqual({ fileUri: 'preview:file:///wide.jpg', contentType: 'image/jpeg' });
  });

  it('resizes a portrait image by height', async () => {
    await createImagePreviewForUpload({
      fileUri: 'file:///tall.jpg',
      width: 3000,
      height: 4000,
    });

    expect(mockedManipulateAsync).toHaveBeenCalledWith(
      'file:///tall.jpg',
      [{ resize: { height: MEMORY_IMAGE_PREVIEW_MAX_DIMENSION } }],
      expect.any(Object),
    );
  });

  it('resizes a square image by width (tie goes to the width branch)', async () => {
    await createImagePreviewForUpload({
      fileUri: 'file:///square.jpg',
      width: 2000,
      height: 2000,
    });

    expect(mockedManipulateAsync).toHaveBeenCalledWith(
      'file:///square.jpg',
      [{ resize: { width: MEMORY_IMAGE_PREVIEW_MAX_DIMENSION } }],
      expect.any(Object),
    );
  });

  it('no-upscale guard: skips preview generation when the longest edge is already at the cap', async () => {
    const result = await createImagePreviewForUpload({
      fileUri: 'file:///small.jpg',
      width: MEMORY_IMAGE_PREVIEW_MAX_DIMENSION,
      height: 800,
    });

    expect(result).toBeNull();
    expect(mockedManipulateAsync).not.toHaveBeenCalled();
  });

  it('no-upscale guard: skips preview generation when the longest edge is under the cap', async () => {
    const result = await createImagePreviewForUpload({
      fileUri: 'file:///tiny.jpg',
      width: 640,
      height: 480,
    });

    expect(result).toBeNull();
    expect(mockedManipulateAsync).not.toHaveBeenCalled();
  });

  it('skips preview generation when dimensions are unknown', async () => {
    const nullResult = await createImagePreviewForUpload({
      fileUri: 'file:///unknown.jpg',
      width: null,
      height: null,
    });
    const undefinedResult = await createImagePreviewForUpload({
      fileUri: 'file:///unknown.jpg',
      width: undefined,
      height: undefined,
    });
    const zeroResult = await createImagePreviewForUpload({
      fileUri: 'file:///unknown.jpg',
      width: 0,
      height: 0,
    });

    expect(nullResult).toBeNull();
    expect(undefinedResult).toBeNull();
    expect(zeroResult).toBeNull();
    expect(mockedManipulateAsync).not.toHaveBeenCalled();
  });

  it('propagates a manipulateAsync failure (caller is responsible for fail-open behavior)', async () => {
    mockedManipulateAsync.mockRejectedValueOnce(new Error('manipulator unavailable'));

    await expect(
      createImagePreviewForUpload({ fileUri: 'file:///wide.jpg', width: 4000, height: 3000 }),
    ).rejects.toThrow('manipulator unavailable');
  });
});
