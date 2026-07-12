import * as ImageManipulator from 'expo-image-manipulator';

import {
  MEMORY_IMAGE_STRIP_QUALITY,
  stripImageMetadataForUpload,
} from '@/utils/strip-image-metadata';

const mockedManipulateAsync = ImageManipulator.manipulateAsync as jest.MockedFunction<
  typeof ImageManipulator.manipulateAsync
>;

describe('stripImageMetadataForUpload', () => {
  beforeEach(() => {
    mockedManipulateAsync.mockReset();
    mockedManipulateAsync.mockImplementation(async (uri: string) => ({
      uri: `stripped:${uri}`,
      width: 100,
      height: 100,
    }));
  });

  it('passes videos through untouched without calling manipulateAsync', async () => {
    const media = { fileUri: 'file:///clip.mp4', contentType: 'video/mp4' };

    const result = await stripImageMetadataForUpload(media);

    expect(result).toEqual(media);
    expect(mockedManipulateAsync).not.toHaveBeenCalled();
  });

  it('re-encodes a JPEG image and keeps the JPEG content type', async () => {
    const result = await stripImageMetadataForUpload({
      fileUri: 'file:///photo.jpg',
      contentType: 'image/jpeg',
    });

    expect(mockedManipulateAsync).toHaveBeenCalledWith('file:///photo.jpg', [], {
      compress: MEMORY_IMAGE_STRIP_QUALITY,
      format: ImageManipulator.SaveFormat.JPEG,
    });
    expect(result).toEqual({
      fileUri: 'stripped:file:///photo.jpg',
      contentType: 'image/jpeg',
    });
  });

  it('re-encodes a PNG image and keeps the PNG content type', async () => {
    const result = await stripImageMetadataForUpload({
      fileUri: 'file:///photo.png',
      contentType: 'image/png',
    });

    expect(mockedManipulateAsync).toHaveBeenCalledWith('file:///photo.png', [], {
      compress: MEMORY_IMAGE_STRIP_QUALITY,
      format: ImageManipulator.SaveFormat.PNG,
    });
    expect(result.contentType).toBe('image/png');
  });

  it('re-encodes a WEBP image and keeps the WEBP content type', async () => {
    const result = await stripImageMetadataForUpload({
      fileUri: 'file:///photo.webp',
      contentType: 'image/webp',
    });

    expect(mockedManipulateAsync).toHaveBeenCalledWith('file:///photo.webp', [], {
      compress: MEMORY_IMAGE_STRIP_QUALITY,
      format: ImageManipulator.SaveFormat.WEBP,
    });
    expect(result.contentType).toBe('image/webp');
  });

  it.each(['image/heic', 'image/heif'])(
    'converts %s to JPEG, since expo-image-manipulator cannot write HEIC/HEIF',
    async (contentType) => {
      const result = await stripImageMetadataForUpload({
        fileUri: 'file:///photo.heic',
        contentType,
      });

      expect(mockedManipulateAsync).toHaveBeenCalledWith('file:///photo.heic', [], {
        compress: MEMORY_IMAGE_STRIP_QUALITY,
        format: ImageManipulator.SaveFormat.JPEG,
      });
      expect(result.contentType).toBe('image/jpeg');
    },
  );

  it('fails closed: rejects instead of falling back to the original file when re-encoding fails', async () => {
    mockedManipulateAsync.mockRejectedValue(new Error('manipulator unavailable'));

    await expect(
      stripImageMetadataForUpload({ fileUri: 'file:///photo.jpg', contentType: 'image/jpeg' }),
    ).rejects.toThrow('manipulator unavailable');
  });
});
