import * as ImageManipulator from 'expo-image-manipulator';

import { createMediaMemory } from '@/services/memories';
import { deleteStorageObject, uploadMediaObject } from '@/services/media';
import { postMediaMemory, uploadMemoryMediaAssets } from '@/services/memory-posting';
import { getLocalFileSizeBytes } from '@/utils/local-files';
import { MAX_VIDEO_BYTES } from '@/utils/media-validation';
import { getVideoFrame } from '@/utils/video-aspect-ratio';

jest.mock('@/services/memories', () => ({
  createMediaMemory: jest.fn(),
}));

jest.mock('@/services/media', () => ({
  deleteStorageObject: jest.fn().mockResolvedValue({ error: null }),
  uploadMediaObject: jest.fn(),
}));

jest.mock('@/services/ai', () => ({
  notifyFamilyActivity: jest.fn(),
}));

jest.mock('@/utils/video-aspect-ratio', () => ({
  getVideoFrame: jest.fn(async () => null),
}));

// Default: well within MAX_VIDEO_BYTES so existing video-asset tests that
// don't care about the post-compression size check keep passing unchanged.
// Individual tests override this to exercise the cap itself.
jest.mock('@/utils/local-files', () => ({
  getLocalFileSizeBytes: jest.fn(async () => 5 * 1024 * 1024),
}));

const mockedCreateMediaMemory = createMediaMemory as jest.MockedFunction<typeof createMediaMemory>;
const mockedUploadMediaObject = uploadMediaObject as jest.MockedFunction<typeof uploadMediaObject>;
const mockedDeleteStorageObject = deleteStorageObject as jest.MockedFunction<typeof deleteStorageObject>;
const mockedManipulateAsync = ImageManipulator.manipulateAsync as jest.MockedFunction<
  typeof ImageManipulator.manipulateAsync
>;
const mockedGetVideoFrame = getVideoFrame as jest.MockedFunction<typeof getVideoFrame>;
const mockedGetLocalFileSizeBytes = getLocalFileSizeBytes as jest.MockedFunction<
  typeof getLocalFileSizeBytes
>;

const baseInput = {
  memoryId: 'memory-1',
  mediaAssets: [
    {
      mediaAssetId: 'asset-photo-1',
      fileUri: 'file:///photo.jpg',
      contentType: 'image/jpeg',
      aspectRatio: 4 / 3,
    },
  ],
  memoryDate: '2026-07-12',
  taggedMemberIds: [],
};

describe('uploadMemoryMediaAssets', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedUploadMediaObject.mockResolvedValue({
      data: { objectKey: 'key', success: true },
      error: null,
    });
  });

  it('uploads each asset under a UUID-based key and reports progress', async () => {
    const onAssetUploaded = jest.fn();
    const uploadedKeys: string[] = [];

    const assets = await uploadMemoryMediaAssets({
      userId: 'user-1',
      familyId: 'family-1',
      memoryId: 'memory-1',
      assets: [
        { mediaAssetId: 'not-a-uuid', fileUri: 'file:///photo.jpg', contentType: 'image/jpeg' },
        { fileUri: 'file:///photo2.jpg', contentType: 'image/jpeg' },
      ],
      uploadedKeys,
      onAssetUploaded,
    });

    expect(mockedUploadMediaObject).toHaveBeenCalledTimes(2);
    expect(mockedUploadMediaObject.mock.calls[0]?.[0]).toMatch(
      /^user-1\/memories\/memory-1\/media\/[0-9a-f-]{36}\.jpg$/i,
    );
    expect(mockedUploadMediaObject.mock.calls[0]?.[0]).not.toContain('not-a-uuid');
    expect(onAssetUploaded).toHaveBeenCalledTimes(2);
    expect(uploadedKeys).toHaveLength(2);
    expect(assets.map((asset) => asset.objectKey)).toEqual(uploadedKeys);
  });

  it('passes through assets that already have an object key without uploading', async () => {
    const onAssetUploaded = jest.fn();
    const uploadedKeys: string[] = [];

    const assets = await uploadMemoryMediaAssets({
      userId: 'user-1',
      familyId: 'family-1',
      memoryId: 'memory-1',
      assets: [{ objectKey: 'existing/key.jpg', contentType: 'image/jpeg' }],
      uploadedKeys,
      onAssetUploaded,
    });

    expect(mockedUploadMediaObject).not.toHaveBeenCalled();
    expect(uploadedKeys).toHaveLength(0);
    expect(onAssetUploaded).toHaveBeenCalledTimes(1);
    expect(assets[0]?.objectKey).toBe('existing/key.jpg');
  });

  it('strips EXIF from new image uploads by re-encoding them before the PUT', async () => {
    const uploadedKeys: string[] = [];

    await uploadMemoryMediaAssets({
      userId: 'user-1',
      familyId: 'family-1',
      memoryId: 'memory-1',
      assets: [{ fileUri: 'file:///photo.jpg', contentType: 'image/jpeg' }],
      uploadedKeys,
    });

    expect(mockedManipulateAsync).toHaveBeenCalledWith('file:///photo.jpg', [], {
      compress: expect.any(Number),
      format: ImageManipulator.SaveFormat.JPEG,
    });
    // The uploaded file is the manipulator's re-encoded output, not the
    // original picked URI.
    expect(mockedUploadMediaObject.mock.calls[0]?.[1]).toBe('stripped:file:///photo.jpg');
  });

  it('keeps content type and object key extension consistent with the re-encoded HEIC output', async () => {
    const uploadedKeys: string[] = [];

    const assets = await uploadMemoryMediaAssets({
      userId: 'user-1',
      familyId: 'family-1',
      memoryId: 'memory-1',
      assets: [{ fileUri: 'file:///photo.heic', contentType: 'image/heic' }],
      uploadedKeys,
    });

    // HEIC re-encodes to JPEG (expo-image-manipulator cannot write HEIC),
    // so the storage key extension and returned contentType must reflect
    // the actual re-encoded bytes, not the originally picked format.
    expect(mockedUploadMediaObject.mock.calls[0]?.[0]).toMatch(/\.jpg$/);
    expect(mockedUploadMediaObject.mock.calls[0]?.[2]).toBe('image/jpeg');
    expect(assets[0]?.contentType).toBe('image/jpeg');
    expect(uploadedKeys[0]).toMatch(/\.jpg$/);
  });

  it('passes video uploads through without invoking the image metadata strip', async () => {
    const uploadedKeys: string[] = [];

    const [asset] = await uploadMemoryMediaAssets({
      userId: 'user-1',
      familyId: 'family-1',
      memoryId: 'memory-1',
      assets: [{ fileUri: 'file:///clip.mp4', contentType: 'video/mp4' }],
      uploadedKeys,
    });

    expect(mockedManipulateAsync).not.toHaveBeenCalled();
    // getVideoFrame is mocked to null by default here (no frame extracted),
    // so no poster can be generated -- previewObjectKey stays null and the
    // carousel falls back to runtime extraction.
    expect(asset.previewObjectKey).toBeNull();
    expect(mockedUploadMediaObject).toHaveBeenCalledTimes(1);
  });

  describe('video poster generation (upload-time first-frame poster)', () => {
    const POSTER_ASSET_ID = '44444444-4444-4444-8444-444444444444';

    it('generates and uploads a poster from the single frame grab, recording previewObjectKey', async () => {
      mockedGetVideoFrame.mockResolvedValueOnce({
        uri: 'file:///frame.jpg',
        width: 1920,
        height: 1080,
      });
      mockedManipulateAsync.mockResolvedValueOnce({
        uri: 'poster:file:///frame.jpg',
        width: 1280,
        height: 720,
      });
      mockedUploadMediaObject
        .mockResolvedValueOnce({ data: { objectKey: 'key', success: true }, error: null })
        .mockResolvedValueOnce({ data: { objectKey: 'key', success: true }, error: null });

      const uploadedKeys: string[] = [];
      const [asset] = await uploadMemoryMediaAssets({
        userId: 'user-1',
        familyId: 'family-1',
        memoryId: 'memory-1',
        assets: [
          { fileUri: 'file:///clip.mp4', contentType: 'video/mp4', mediaAssetId: POSTER_ASSET_ID },
        ],
        uploadedKeys,
      });

      const expectedPosterKey = `user-1/memories/memory-1/media/${POSTER_ASSET_ID}-preview.jpg`;

      // Only one frame grab for both the aspect ratio and the poster.
      expect(mockedGetVideoFrame).toHaveBeenCalledTimes(1);
      expect(mockedGetVideoFrame).toHaveBeenCalledWith('file:///clip.mp4');
      expect(asset.aspectRatio).toBe(1920 / 1080);

      expect(mockedUploadMediaObject).toHaveBeenCalledTimes(2);
      expect(mockedUploadMediaObject.mock.calls[1]?.[0]).toBe(expectedPosterKey);
      expect(mockedUploadMediaObject.mock.calls[1]?.[1]).toBe('poster:file:///frame.jpg');
      expect(mockedUploadMediaObject.mock.calls[1]?.[2]).toBe('image/jpeg');
      expect(asset.previewObjectKey).toBe(expectedPosterKey);
      expect(uploadedKeys).toContain(expectedPosterKey);
    });

    it('still produces a poster when the extracted frame is already small (no no-upscale skip for video)', async () => {
      mockedGetVideoFrame.mockResolvedValueOnce({
        uri: 'file:///frame.jpg',
        width: 640,
        height: 480,
      });
      mockedManipulateAsync.mockResolvedValueOnce({
        uri: 'poster:file:///frame.jpg',
        width: 640,
        height: 480,
      });

      const uploadedKeys: string[] = [];
      const [asset] = await uploadMemoryMediaAssets({
        userId: 'user-1',
        familyId: 'family-1',
        memoryId: 'memory-1',
        assets: [{ fileUri: 'file:///clip.mp4', contentType: 'video/mp4' }],
        uploadedKeys,
      });

      expect(mockedManipulateAsync).toHaveBeenCalledWith('file:///frame.jpg', [], expect.any(Object));
      expect(asset.previewObjectKey).not.toBeNull();
      expect(mockedUploadMediaObject).toHaveBeenCalledTimes(2);
    });

    it('never attempts a poster when no frame could be extracted', async () => {
      mockedGetVideoFrame.mockResolvedValueOnce(null);
      const uploadedKeys: string[] = [];

      const [asset] = await uploadMemoryMediaAssets({
        userId: 'user-1',
        familyId: 'family-1',
        memoryId: 'memory-1',
        assets: [{ fileUri: 'file:///clip.mp4', contentType: 'video/mp4' }],
        uploadedKeys,
      });

      expect(mockedManipulateAsync).not.toHaveBeenCalled();
      expect(asset.previewObjectKey).toBeNull();
      expect(mockedUploadMediaObject).toHaveBeenCalledTimes(1);
    });

    it('fails open when poster generation fails: original video upload still succeeds with previewObjectKey null', async () => {
      mockedGetVideoFrame.mockResolvedValueOnce({
        uri: 'file:///frame.jpg',
        width: 1920,
        height: 1080,
      });
      mockedManipulateAsync.mockRejectedValueOnce(new Error('poster manipulator unavailable'));

      const uploadedKeys: string[] = [];
      const [asset] = await uploadMemoryMediaAssets({
        userId: 'user-1',
        familyId: 'family-1',
        memoryId: 'memory-1',
        assets: [{ fileUri: 'file:///clip.mp4', contentType: 'video/mp4' }],
        uploadedKeys,
      });

      expect(asset.previewObjectKey).toBeNull();
      expect(mockedUploadMediaObject).toHaveBeenCalledTimes(1);
      expect(uploadedKeys).toHaveLength(1);
    });

    it('fails open when the poster upload fails: falls back to previewObjectKey null', async () => {
      mockedGetVideoFrame.mockResolvedValueOnce({
        uri: 'file:///frame.jpg',
        width: 1920,
        height: 1080,
      });
      mockedManipulateAsync.mockResolvedValueOnce({
        uri: 'poster:file:///frame.jpg',
        width: 1280,
        height: 720,
      });
      mockedUploadMediaObject
        .mockResolvedValueOnce({ data: { objectKey: 'key', success: true }, error: null })
        .mockResolvedValueOnce({ data: null, error: { message: 'poster upload failed' } });

      const uploadedKeys: string[] = [];
      const [asset] = await uploadMemoryMediaAssets({
        userId: 'user-1',
        familyId: 'family-1',
        memoryId: 'memory-1',
        assets: [{ fileUri: 'file:///clip.mp4', contentType: 'video/mp4' }],
        uploadedKeys,
      });

      expect(asset.previewObjectKey).toBeNull();
      expect(uploadedKeys).toHaveLength(1);
    });
  });

  describe('post-compression size cap (video)', () => {
    afterEach(() => {
      mockedGetLocalFileSizeBytes.mockResolvedValue(5 * 1024 * 1024);
    });

    it('uploads a compressed video that fits MAX_VIDEO_BYTES', async () => {
      mockedGetLocalFileSizeBytes.mockResolvedValue(MAX_VIDEO_BYTES);
      const uploadedKeys: string[] = [];

      const [asset] = await uploadMemoryMediaAssets({
        userId: 'user-1',
        familyId: 'family-1',
        memoryId: 'memory-1',
        assets: [{ fileUri: 'file:///clip.mp4', contentType: 'video/mp4' }],
        uploadedKeys,
      });

      expect(asset.objectKey).toMatch(/\.mp4$/);
      expect(mockedUploadMediaObject).toHaveBeenCalledTimes(1);
    });

    it('fails the asset and does not upload when the compressed output exceeds MAX_VIDEO_BYTES', async () => {
      mockedGetLocalFileSizeBytes.mockResolvedValue(MAX_VIDEO_BYTES + 1);
      const uploadedKeys: string[] = [];

      await expect(
        uploadMemoryMediaAssets({
          userId: 'user-1',
          familyId: 'family-1',
          memoryId: 'memory-1',
          assets: [{ fileUri: 'file:///clip.mp4', contentType: 'video/mp4' }],
          uploadedKeys,
        }),
      ).rejects.toThrow(/too large/i);

      expect(mockedUploadMediaObject).not.toHaveBeenCalled();
      expect(uploadedKeys).toHaveLength(0);
    });

    it('fails the asset when the compressed output size cannot be determined', async () => {
      mockedGetLocalFileSizeBytes.mockResolvedValue(null);
      const uploadedKeys: string[] = [];

      await expect(
        uploadMemoryMediaAssets({
          userId: 'user-1',
          familyId: 'family-1',
          memoryId: 'memory-1',
          assets: [{ fileUri: 'file:///clip.mp4', contentType: 'video/mp4' }],
          uploadedKeys,
        }),
      ).rejects.toThrow(/too large/i);

      expect(mockedUploadMediaObject).not.toHaveBeenCalled();
    });

    it('never checks video size for image assets', async () => {
      const uploadedKeys: string[] = [];

      await uploadMemoryMediaAssets({
        userId: 'user-1',
        familyId: 'family-1',
        memoryId: 'memory-1',
        assets: [{ fileUri: 'file:///photo.jpg', contentType: 'image/jpeg' }],
        uploadedKeys,
      });

      expect(mockedGetLocalFileSizeBytes).not.toHaveBeenCalled();
    });
  });

  describe('image preview generation (Workstream C3/C4)', () => {
    const PREVIEW_ASSET_ID = '11111111-1111-4111-8111-111111111111';

    it('generates and uploads a preview for a large image, recording previewObjectKey', async () => {
      mockedManipulateAsync
        .mockResolvedValueOnce({ uri: 'stripped:file:///large.jpg', width: 4000, height: 3000 })
        .mockResolvedValueOnce({ uri: 'preview:file:///large.jpg', width: 1280, height: 960 });
      mockedUploadMediaObject
        .mockResolvedValueOnce({ data: { objectKey: 'key', success: true }, error: null })
        .mockResolvedValueOnce({ data: { objectKey: 'key', success: true }, error: null });

      const uploadedKeys: string[] = [];
      const [asset] = await uploadMemoryMediaAssets({
        userId: 'user-1',
        familyId: 'family-1',
        memoryId: 'memory-1',
        assets: [
          { fileUri: 'file:///large.jpg', contentType: 'image/jpeg', mediaAssetId: PREVIEW_ASSET_ID },
        ],
        uploadedKeys,
      });

      const expectedPreviewKey = `user-1/memories/memory-1/media/${PREVIEW_ASSET_ID}-preview.jpg`;

      expect(mockedUploadMediaObject).toHaveBeenCalledTimes(2);
      expect(mockedUploadMediaObject.mock.calls[1]?.[0]).toBe(expectedPreviewKey);
      expect(mockedUploadMediaObject.mock.calls[1]?.[1]).toBe('preview:file:///large.jpg');
      expect(mockedUploadMediaObject.mock.calls[1]?.[2]).toBe('image/jpeg');
      expect(asset.previewObjectKey).toBe(expectedPreviewKey);
      expect(uploadedKeys).toContain(expectedPreviewKey);
    });

    it('no-upscale guard: does not generate or upload a preview for an already-small image', async () => {
      mockedManipulateAsync.mockResolvedValueOnce({
        uri: 'stripped:file:///small.jpg',
        width: 800,
        height: 600,
      });

      const uploadedKeys: string[] = [];
      const [asset] = await uploadMemoryMediaAssets({
        userId: 'user-1',
        familyId: 'family-1',
        memoryId: 'memory-1',
        assets: [{ fileUri: 'file:///small.jpg', contentType: 'image/jpeg' }],
        uploadedKeys,
      });

      expect(asset.previewObjectKey).toBeNull();
      expect(mockedUploadMediaObject).toHaveBeenCalledTimes(1);
      expect(uploadedKeys).toHaveLength(1);
    });

    it('fails open when preview generation fails: original upload still succeeds with previewObjectKey null', async () => {
      mockedManipulateAsync
        .mockResolvedValueOnce({ uri: 'stripped:file:///large.jpg', width: 4000, height: 3000 })
        .mockRejectedValueOnce(new Error('preview manipulator unavailable'));

      const uploadedKeys: string[] = [];
      const [asset] = await uploadMemoryMediaAssets({
        userId: 'user-1',
        familyId: 'family-1',
        memoryId: 'memory-1',
        assets: [{ fileUri: 'file:///large.jpg', contentType: 'image/jpeg' }],
        uploadedKeys,
      });

      expect(asset.previewObjectKey).toBeNull();
      expect(mockedUploadMediaObject).toHaveBeenCalledTimes(1);
      expect(uploadedKeys).toHaveLength(1);
    });

    it('fails open when the preview upload fails: falls back to previewObjectKey null', async () => {
      mockedManipulateAsync
        .mockResolvedValueOnce({ uri: 'stripped:file:///large.jpg', width: 4000, height: 3000 })
        .mockResolvedValueOnce({ uri: 'preview:file:///large.jpg', width: 1280, height: 960 });
      mockedUploadMediaObject
        .mockResolvedValueOnce({ data: { objectKey: 'key', success: true }, error: null })
        .mockResolvedValueOnce({ data: null, error: { message: 'preview upload failed' } });

      const uploadedKeys: string[] = [];
      const [asset] = await uploadMemoryMediaAssets({
        userId: 'user-1',
        familyId: 'family-1',
        memoryId: 'memory-1',
        assets: [{ fileUri: 'file:///large.jpg', contentType: 'image/jpeg' }],
        uploadedKeys,
      });

      expect(asset.previewObjectKey).toBeNull();
      // Only the original is retained for rollback bookkeeping -- the
      // failed preview upload was never pushed.
      expect(uploadedKeys).toHaveLength(1);
    });

    it('passes through an existing previewObjectKey for already-uploaded assets without re-uploading', async () => {
      const uploadedKeys: string[] = [];
      const [asset] = await uploadMemoryMediaAssets({
        userId: 'user-1',
        familyId: 'family-1',
        memoryId: 'memory-1',
        assets: [
          {
            objectKey: 'existing/key.jpg',
            contentType: 'image/jpeg',
            previewObjectKey: 'existing/key-preview.jpg',
          },
        ],
        uploadedKeys,
      });

      expect(asset.previewObjectKey).toBe('existing/key-preview.jpg');
      expect(mockedUploadMediaObject).not.toHaveBeenCalled();
    });
  });

  it('persists a transformed video-frame aspect ratio with the uploaded asset', async () => {
    mockedGetVideoFrame.mockResolvedValueOnce({
      uri: 'file:///frame.jpg',
      width: 1080,
      height: 1920,
    });
    const uploadedKeys: string[] = [];

    const [asset] = await uploadMemoryMediaAssets({
      userId: 'user-1',
      familyId: 'family-1',
      memoryId: 'memory-1',
      assets: [{ fileUri: 'file:///portrait.mp4', contentType: 'video/mp4' }],
      uploadedKeys,
    });

    expect(mockedGetVideoFrame).toHaveBeenCalledWith('file:///portrait.mp4');
    expect(asset.aspectRatio).toBe(9 / 16);
  });

  it('fails closed and rolls back nothing new when EXIF stripping fails (no partial upload)', async () => {
    mockedManipulateAsync.mockRejectedValueOnce(new Error('manipulator unavailable'));
    const uploadedKeys: string[] = [];

    await expect(
      uploadMemoryMediaAssets({
        userId: 'user-1',
        familyId: 'family-1',
        memoryId: 'memory-1',
        assets: [{ fileUri: 'file:///photo.jpg', contentType: 'image/jpeg' }],
        uploadedKeys,
      }),
    ).rejects.toThrow('manipulator unavailable');

    expect(mockedUploadMediaObject).not.toHaveBeenCalled();
    expect(uploadedKeys).toHaveLength(0);
  });
});

describe('postMediaMemory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedUploadMediaObject.mockResolvedValue({
      data: { objectKey: 'key', success: true },
      error: null,
    });
    mockedDeleteStorageObject.mockResolvedValue({ error: null });
  });

  it('uploads then inserts and returns the created memory', async () => {
    mockedCreateMediaMemory.mockResolvedValue({
      data: { id: 'memory-1', memory_type: 'media' },
      error: null,
    } as Awaited<ReturnType<typeof createMediaMemory>>);

    const memory = await postMediaMemory({
      userId: 'user-1',
      familyId: 'family-1',
      input: baseInput,
    });

    expect(memory.id).toBe('memory-1');
    expect(mockedCreateMediaMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        familyId: 'family-1',
        memoryId: 'memory-1',
        mediaAssets: [expect.objectContaining({ aspectRatio: 4 / 3 })],
      }),
    );
  });

  it('rolls back uploaded objects when the insert fails', async () => {
    mockedCreateMediaMemory.mockResolvedValue({
      data: null,
      error: { message: 'insert failed' },
    } as Awaited<ReturnType<typeof createMediaMemory>>);

    await expect(
      postMediaMemory({ userId: 'user-1', familyId: 'family-1', input: baseInput }),
    ).rejects.toThrow('insert failed');

    expect(mockedDeleteStorageObject).toHaveBeenCalledTimes(1);
    expect(mockedDeleteStorageObject.mock.calls[0]?.[0]).toMatch(
      /^user-1\/memories\/memory-1\/media\//,
    );
  });

  it('rolls back completed uploads when a later upload fails', async () => {
    mockedUploadMediaObject
      .mockResolvedValueOnce({ data: { objectKey: 'key', success: true }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'upload failed' } });

    await expect(
      postMediaMemory({
        userId: 'user-1',
        familyId: 'family-1',
        input: {
          ...baseInput,
          mediaAssets: [
            { fileUri: 'file:///a.jpg', contentType: 'image/jpeg' },
            { fileUri: 'file:///b.jpg', contentType: 'image/jpeg' },
          ],
        },
      }),
    ).rejects.toThrow('upload failed');

    expect(mockedCreateMediaMemory).not.toHaveBeenCalled();
    expect(mockedDeleteStorageObject).toHaveBeenCalledTimes(1);
  });

  it('rolls back completed uploads when a video exceeds the post-compression cap, so the queue can surface a Retry/Discard error', async () => {
    // Only the video asset calls getLocalFileSizeBytes (image assets never
    // do -- see "never checks video size for image assets" above).
    mockedGetLocalFileSizeBytes.mockResolvedValueOnce(MAX_VIDEO_BYTES + 1);

    await expect(
      postMediaMemory({
        userId: 'user-1',
        familyId: 'family-1',
        input: {
          ...baseInput,
          mediaAssets: [
            { fileUri: 'file:///a.jpg', contentType: 'image/jpeg' },
            { fileUri: 'file:///clip.mp4', contentType: 'video/mp4' },
          ],
        },
      }),
    ).rejects.toThrow(/too large/i);

    expect(mockedCreateMediaMemory).not.toHaveBeenCalled();
    // The image upload that already completed must be rolled back even
    // though the failure came from the size check, not uploadMediaObject.
    expect(mockedDeleteStorageObject).toHaveBeenCalledTimes(1);

    mockedGetLocalFileSizeBytes.mockResolvedValue(5 * 1024 * 1024);
  });
});
