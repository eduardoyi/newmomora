import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import { Image } from 'react-native';

import {
  createGalleryImportPreview,
  GALLERY_IMPORT_PREVIEW_MAX_BYTES,
} from '@/utils/gallery-import-preview';

jest.mock('expo-file-system/legacy', () => ({
  EncodingType: { Base64: 'base64' },
  makeDirectoryAsync: jest.fn(), deleteAsync: jest.fn(), moveAsync: jest.fn(),
  getInfoAsync: jest.fn(), readAsStringAsync: jest.fn(),
}));
jest.mock('@/utils/gallery-import-checkpoint', () => ({ getGalleryImportPreviewCacheDirectory: () => 'file:///cache/gallery-import/run-1/' }));
jest.mock('@/utils/gallery-import-scanner', () => ({ galleryImportSha256HexFromBytes: () => 'a'.repeat(64) }));

const manipulate = ImageManipulator.manipulateAsync as jest.MockedFunction<typeof ImageManipulator.manipulateAsync>;
const getInfo = FileSystem.getInfoAsync as jest.MockedFunction<typeof FileSystem.getInfoAsync>;
const move = FileSystem.moveAsync as jest.MockedFunction<typeof FileSystem.moveAsync>;
const remove = FileSystem.deleteAsync as jest.MockedFunction<typeof FileSystem.deleteAsync>;

function setSourceSize(width: number, height: number) {
  jest.spyOn(Image, 'getSize').mockImplementation((_uri, success) => { success(width, height); });
}

describe('createGalleryImportPreview', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (FileSystem.makeDirectoryAsync as jest.Mock).mockResolvedValue(undefined);
    remove.mockResolvedValue(undefined);
    move.mockResolvedValue(undefined);
    getInfo.mockResolvedValue({ exists: true, isDirectory: false, size: 100, uri: 'file:///cache/gallery-import/run-1/token.jpg', modificationTime: 0 });
    (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue('AQ==');
  });

  it.each([[400, 200], [200, 400]])('re-encodes a %sx%s image without upscaling', async (width, height) => {
    setSourceSize(width, height);
    manipulate.mockResolvedValue({ uri: 'file:///opaque/manipulator.jpg', width, height });
    const preview = await createGalleryImportPreview({ sourceUri: 'file:///source.jpg', runId: 'run-1', assetToken: 'token' });
    expect(manipulate).toHaveBeenCalledWith('file:///source.jpg', [], expect.objectContaining({ format: ImageManipulator.SaveFormat.JPEG }));
    expect(preview).toEqual(expect.objectContaining({ width, height }));
  });

  it('accepts exactly 1,500,000 bytes and rejects one byte more before hashing', async () => {
    setSourceSize(800, 600);
    manipulate.mockResolvedValue({ uri: 'file:///opaque/manipulator.jpg', width: 512, height: 384 });
    getInfo.mockResolvedValue({ exists: true, isDirectory: false, size: GALLERY_IMPORT_PREVIEW_MAX_BYTES, uri: 'file:///cache/gallery-import/run-1/token.jpg', modificationTime: 0 });
    await expect(createGalleryImportPreview({ sourceUri: 'file:///source.jpg', runId: 'run-1', assetToken: 'token' })).resolves.toEqual(expect.objectContaining({ byteLength: 1_500_000 }));
    getInfo.mockResolvedValue({ exists: true, isDirectory: false, size: GALLERY_IMPORT_PREVIEW_MAX_BYTES + 1, uri: 'file:///cache/gallery-import/run-1/token.jpg', modificationTime: 0 });
    await expect(createGalleryImportPreview({ sourceUri: 'file:///source.jpg', runId: 'run-1', assetToken: 'token' })).rejects.toThrow('byte limit');
    expect(FileSystem.readAsStringAsync).toHaveBeenCalledTimes(1);
  });

  it('replaces its exact local target and moves the opaque result instead of copying it', async () => {
    setSourceSize(800, 600);
    manipulate.mockResolvedValue({ uri: 'file:///opaque/manipulator.jpg', width: 512, height: 384 });
    await createGalleryImportPreview({ sourceUri: 'file:///source.jpg', runId: 'run-1', assetToken: 'token' });
    const target = 'file:///cache/gallery-import/run-1/token.jpg';
    expect(remove).toHaveBeenNthCalledWith(1, target, { idempotent: true });
    expect(move).toHaveBeenCalledWith({ from: 'file:///opaque/manipulator.jpg', to: target });
    expect((FileSystem as unknown as { copyAsync?: jest.Mock }).copyAsync).toBeUndefined();
  });

  it('uses an attempt-scoped local cache key without changing preview metadata', async () => {
    setSourceSize(800, 600);
    manipulate.mockResolvedValue({ uri: 'file:///opaque/manipulator.jpg', width: 512, height: 384 });
    const preview = await createGalleryImportPreview({ sourceUri: 'file:///source.jpg', runId: 'run-1', assetToken: 'opaque-token', localCacheKey: 'opaque-token-attempt-2' });
    expect(move).toHaveBeenCalledWith({
      from: 'file:///opaque/manipulator.jpg',
      to: 'file:///cache/gallery-import/run-1/opaque-token-attempt-2.jpg',
    });
    expect(preview).toEqual(expect.objectContaining({ width: 512, height: 384 }));
  });

  it('deletes the opaque temporary result when moving it fails', async () => {
    setSourceSize(800, 600);
    manipulate.mockResolvedValue({ uri: 'file:///opaque/manipulator.jpg', width: 512, height: 384 });
    move.mockRejectedValueOnce(new Error('move failed'));
    await expect(createGalleryImportPreview({ sourceUri: 'file:///source.jpg', runId: 'run-1', assetToken: 'token' })).rejects.toThrow('move failed');
    expect(remove).toHaveBeenLastCalledWith('file:///opaque/manipulator.jpg', { idempotent: true });
  });
});
