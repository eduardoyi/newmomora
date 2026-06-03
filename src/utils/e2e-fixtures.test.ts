import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system/legacy';

import { loadE2eProfilePhoto } from '@/utils/e2e-fixtures';

jest.mock('expo-asset', () => ({
  Asset: {
    fromModule: jest.fn(),
  },
}));

jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  copyAsync: jest.fn(),
}));

const mockedFromModule = Asset.fromModule as jest.MockedFunction<typeof Asset.fromModule>;
const mockedCopyAsync = FileSystem.copyAsync as jest.MockedFunction<typeof FileSystem.copyAsync>;

describe('e2e-fixtures', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedCopyAsync.mockResolvedValue(undefined);
  });

  it('loads the bundled profile fixture into cache for native upload', async () => {
    mockedFromModule.mockReturnValue({
      downloadAsync: jest.fn().mockResolvedValue(undefined),
      localUri: 'file:///tmp/profile-fixture.jpg',
      uri: 'file:///tmp/profile-fixture.jpg',
    } as unknown as Asset);

    const photo = await loadE2eProfilePhoto();

    expect(photo).toEqual({
      uri: 'file:///cache/e2e-profile-fixture.jpg',
      contentType: 'image/jpeg',
    });
    expect(mockedCopyAsync).toHaveBeenCalledWith({
      from: 'file:///tmp/profile-fixture.jpg',
      to: 'file:///cache/e2e-profile-fixture.jpg',
    });
  });

  it('throws when the fixture cannot be resolved to a uri', async () => {
    mockedFromModule.mockReturnValue({
      downloadAsync: jest.fn().mockResolvedValue(undefined),
      localUri: null,
      uri: null,
    } as unknown as Asset);

    await expect(loadE2eProfilePhoto()).rejects.toThrow('E2E profile fixture could not be loaded');
  });
});
