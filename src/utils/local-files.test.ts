import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

import { getLocalFileSizeBytes, readLocalFileAsBase64 } from '@/utils/local-files';

jest.mock('expo-file-system/legacy', () => ({
  readAsStringAsync: jest.fn(),
  getInfoAsync: jest.fn(),
  EncodingType: {
    Base64: 'base64',
  },
}));

const mockedReadAsStringAsync = FileSystem.readAsStringAsync as jest.MockedFunction<
  typeof FileSystem.readAsStringAsync
>;
const mockedGetInfoAsync = FileSystem.getInfoAsync as jest.MockedFunction<
  typeof FileSystem.getInfoAsync
>;

describe('readLocalFileAsBase64', () => {
  const originalPlatform = Platform.OS;

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
    jest.clearAllMocks();
  });

  it('reads native files as base64 via FileSystem', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    mockedReadAsStringAsync.mockResolvedValue('Zm9v');

    const result = await readLocalFileAsBase64('file:///tmp/audio.m4a');

    expect(result).toBe('Zm9v');
    expect(mockedReadAsStringAsync).toHaveBeenCalledWith('file:///tmp/audio.m4a', {
      encoding: FileSystem.EncodingType.Base64,
    });
  });
});

describe('getLocalFileSizeBytes', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns the file size when the file exists', async () => {
    mockedGetInfoAsync.mockResolvedValue({
      exists: true,
      size: 12_345,
      uri: 'file:///clip.mp4',
    } as FileSystem.FileInfo);

    await expect(getLocalFileSizeBytes('file:///clip.mp4')).resolves.toBe(12_345);
  });

  it('returns null when the file does not exist', async () => {
    mockedGetInfoAsync.mockResolvedValue({ exists: false, uri: 'file:///missing.mp4' } as FileSystem.FileInfo);

    await expect(getLocalFileSizeBytes('file:///missing.mp4')).resolves.toBeNull();
  });

  it('returns null when the info shape has no size field', async () => {
    mockedGetInfoAsync.mockResolvedValue({ exists: true, uri: 'file:///clip.mp4' } as FileSystem.FileInfo);

    await expect(getLocalFileSizeBytes('file:///clip.mp4')).resolves.toBeNull();
  });

  it('returns null when getInfoAsync throws', async () => {
    mockedGetInfoAsync.mockRejectedValue(new Error('stat failed'));

    await expect(getLocalFileSizeBytes('file:///clip.mp4')).resolves.toBeNull();
  });
});
