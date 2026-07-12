import * as ImageManipulator from 'expo-image-manipulator';

import { createMediaMemory } from '@/services/memories';
import { deleteStorageObject, uploadMediaObject } from '@/services/media';
import { postMediaMemory, uploadMemoryMediaAssets } from '@/services/memory-posting';

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

const mockedCreateMediaMemory = createMediaMemory as jest.MockedFunction<typeof createMediaMemory>;
const mockedUploadMediaObject = uploadMediaObject as jest.MockedFunction<typeof uploadMediaObject>;
const mockedDeleteStorageObject = deleteStorageObject as jest.MockedFunction<typeof deleteStorageObject>;
const mockedManipulateAsync = ImageManipulator.manipulateAsync as jest.MockedFunction<
  typeof ImageManipulator.manipulateAsync
>;

const baseInput = {
  memoryId: 'memory-1',
  mediaAssets: [
    { mediaAssetId: 'asset-photo-1', fileUri: 'file:///photo.jpg', contentType: 'image/jpeg' },
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

    await uploadMemoryMediaAssets({
      userId: 'user-1',
      familyId: 'family-1',
      memoryId: 'memory-1',
      assets: [{ fileUri: 'file:///clip.mp4', contentType: 'video/mp4' }],
      uploadedKeys,
    });

    expect(mockedManipulateAsync).not.toHaveBeenCalled();
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
});
