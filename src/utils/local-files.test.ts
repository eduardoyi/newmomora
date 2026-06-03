import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

import { readLocalFileAsBase64 } from '@/utils/local-files';

jest.mock('expo-file-system/legacy', () => ({
  readAsStringAsync: jest.fn(),
  EncodingType: {
    Base64: 'base64',
  },
}));

const mockedReadAsStringAsync = FileSystem.readAsStringAsync as jest.MockedFunction<
  typeof FileSystem.readAsStringAsync
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
