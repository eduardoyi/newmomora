import * as FileSystem from 'expo-file-system/legacy';

import {
  deleteFilmShareFile,
  filmShareDirectory,
  prepareFilmShareFile,
  sweepFilmShareCache,
} from '@/utils/film-share';

jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  getInfoAsync: jest.fn(),
  makeDirectoryAsync: jest.fn(),
  deleteAsync: jest.fn(),
}));

const mockedFs = FileSystem as jest.Mocked<typeof FileSystem>;

describe('film-share cache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedFs.deleteAsync.mockResolvedValue(undefined);
    mockedFs.makeDirectoryAsync.mockResolvedValue(undefined);
  });

  it('uses a film-share/ subfolder of the cache directory', () => {
    expect(filmShareDirectory()).toBe('file:///cache/film-share/');
  });

  it('creates the folder when missing and returns the film destination', async () => {
    mockedFs.getInfoAsync.mockResolvedValue({ exists: false } as never);

    await expect(prepareFilmShareFile('film-1')).resolves.toBe('file:///cache/film-share/film-1.mp4');
    expect(mockedFs.makeDirectoryAsync).toHaveBeenCalledWith('file:///cache/film-share/', { intermediates: true });
  });

  it('skips folder creation when it exists, and rejects unsafe ids', async () => {
    mockedFs.getInfoAsync.mockResolvedValue({ exists: true } as never);

    await prepareFilmShareFile('film-1');
    expect(mockedFs.makeDirectoryAsync).not.toHaveBeenCalled();
    await expect(prepareFilmShareFile('../etc')).resolves.toBeNull();
  });

  it('never throws when deleting', async () => {
    mockedFs.deleteAsync.mockRejectedValue(new Error('gone'));

    await expect(deleteFilmShareFile('file:///cache/film-share/x.mp4')).resolves.toBeUndefined();
    await expect(sweepFilmShareCache()).resolves.toBeUndefined();
  });

  it('sweeps the whole film-share folder idempotently', async () => {
    await sweepFilmShareCache();

    expect(mockedFs.deleteAsync).toHaveBeenCalledWith('file:///cache/film-share/', { idempotent: true });
  });
});
