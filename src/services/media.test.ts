import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

jest.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(),
    },
    functions: {
      invoke: jest.fn(),
    },
  },
}));

import { supabase } from '@/lib/supabase';
import { uploadMediaObject, uploadToPresignedUrl } from '@/services/media';

jest.mock('expo-file-system/legacy', () => ({
  uploadAsync: jest.fn(),
  FileSystemUploadType: {
    BINARY_CONTENT: 0,
  },
}));

const mockedUploadAsync = FileSystem.uploadAsync as jest.MockedFunction<
  typeof FileSystem.uploadAsync
>;
const mockedGetSession = supabase.auth.getSession as jest.MockedFunction<
  typeof supabase.auth.getSession
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

describe('uploadMediaObject', () => {
  const originalPlatform = Platform.OS;

  beforeEach(() => {
    mockedGetSession.mockResolvedValue({
      data: {
        session: {
          access_token: 'session-token',
        },
      },
      error: null,
    } as never);
  });

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
    jest.clearAllMocks();
  });

  it('uploads native files through the Supabase upload-media function', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    mockedUploadAsync.mockResolvedValue({
      status: 200,
      body: JSON.stringify({ objectKey: 'user-1/memories/memory-1/media/asset.jpg', success: true }),
      headers: {},
    });

    const result = await uploadMediaObject(
      'user-1/memories/memory-1/media/asset.jpg',
      'file:///tmp/photo.jpg',
      'image/jpeg',
      'family-1',
    );

    expect(result.error).toBeNull();
    expect(mockedUploadAsync).toHaveBeenCalledWith(
      'https://example.supabase.co/functions/v1/upload-media',
      'file:///tmp/photo.jpg',
      expect.objectContaining({
        httpMethod: 'POST',
        uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
        headers: expect.objectContaining({
          Authorization: 'Bearer session-token',
          'Content-Type': 'image/jpeg',
          'x-object-key': 'user-1/memories/memory-1/media/asset.jpg',
          'x-family-id': 'family-1',
        }),
      }),
    );
  });

  it('returns the upload-media error response for native failures', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    mockedUploadAsync.mockResolvedValue({
      status: 400,
      body: JSON.stringify({ error: 'Invalid object key', code: 'validation_error' }),
      headers: {},
    });

    const result = await uploadMediaObject(
      'bad-key',
      'file:///tmp/photo.jpg',
      'image/jpeg',
      'family-1',
    );

    expect(result.error).toEqual({
      message: 'Invalid object key',
      code: 'validation_error',
    });
  });
});
