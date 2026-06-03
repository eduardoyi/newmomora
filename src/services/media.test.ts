import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

jest.mock('@/lib/supabase', () => ({
  supabase: {
    functions: {
      invoke: jest.fn(),
    },
  },
}));

import { uploadToPresignedUrl } from '@/services/media';

jest.mock('expo-file-system/legacy', () => ({
  uploadAsync: jest.fn(),
  FileSystemUploadType: {
    BINARY_CONTENT: 0,
  },
}));

const mockedUploadAsync = FileSystem.uploadAsync as jest.MockedFunction<
  typeof FileSystem.uploadAsync
>;

describe('uploadToPresignedUrl', () => {
  const originalPlatform = Platform.OS;

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
    jest.clearAllMocks();
  });

  it('uploads via FileSystem on native and returns null on success', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    mockedUploadAsync.mockResolvedValue({
      status: 200,
      body: '',
      headers: {},
    });

    const result = await uploadToPresignedUrl(
      'https://upload.example.com/object',
      'file:///tmp/photo.jpg',
      'image/jpeg',
    );

    expect(result.error).toBeNull();
    expect(mockedUploadAsync).toHaveBeenCalledWith(
      'https://upload.example.com/object',
      'file:///tmp/photo.jpg',
      expect.objectContaining({
        httpMethod: 'PUT',
        uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
        headers: { 'Content-Type': 'image/jpeg' },
      }),
    );
  });

  it('returns an error when native upload fails', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    mockedUploadAsync.mockResolvedValue({
      status: 403,
      body: 'Forbidden',
      headers: {},
    });

    const result = await uploadToPresignedUrl(
      'https://upload.example.com/object',
      'file:///tmp/photo.jpg',
      'image/jpeg',
    );

    expect(result.error).toEqual({
      message: 'Photo upload failed',
      code: '403',
    });
  });
});
