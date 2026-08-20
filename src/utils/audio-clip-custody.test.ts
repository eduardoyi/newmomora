import * as FileSystem from 'expo-file-system/legacy';

import { claimAudioClip, discardAudioClip, sweepAudioRecordingsDirectory } from './audio-clip-custody';

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///documents/',
  getInfoAsync: jest.fn(),
  makeDirectoryAsync: jest.fn(),
  copyAsync: jest.fn(),
  deleteAsync: jest.fn(),
  readDirectoryAsync: jest.fn(),
}));

const mockedFileSystem = FileSystem as jest.Mocked<typeof FileSystem>;

describe('claimAudioClip', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates the recordings directory when missing, then copies the clip into it', async () => {
    mockedFileSystem.getInfoAsync.mockResolvedValue({ exists: false, uri: '', isDirectory: false } as never);
    mockedFileSystem.copyAsync.mockResolvedValue(undefined);

    const result = await claimAudioClip('file:///cache/tmp-recording.m4a');

    expect(mockedFileSystem.makeDirectoryAsync).toHaveBeenCalledWith(
      'file:///documents/audio-recordings/',
      { intermediates: true },
    );
    expect(mockedFileSystem.copyAsync).toHaveBeenCalledWith({
      from: 'file:///cache/tmp-recording.m4a',
      to: expect.stringMatching(/^file:\/\/\/documents\/audio-recordings\/[a-f0-9-]+\.m4a$/),
    });
    expect(result).toMatch(/^file:\/\/\/documents\/audio-recordings\/[a-f0-9-]+\.m4a$/);
  });

  it('does not recreate the directory when it already exists', async () => {
    mockedFileSystem.getInfoAsync.mockResolvedValue({
      exists: true,
      uri: '',
      isDirectory: true,
      modificationTime: 0,
    } as never);
    mockedFileSystem.copyAsync.mockResolvedValue(undefined);

    await claimAudioClip('file:///cache/tmp-recording.m4a');

    expect(mockedFileSystem.makeDirectoryAsync).not.toHaveBeenCalled();
  });

  it('produces a distinct destination filename per call', async () => {
    mockedFileSystem.getInfoAsync.mockResolvedValue({
      exists: true,
      uri: '',
      isDirectory: true,
      modificationTime: 0,
    } as never);
    mockedFileSystem.copyAsync.mockResolvedValue(undefined);

    const first = await claimAudioClip('file:///cache/a.m4a');
    const second = await claimAudioClip('file:///cache/b.m4a');

    expect(first).not.toEqual(second);
  });
});

describe('discardAudioClip', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('deletes the file idempotently', async () => {
    mockedFileSystem.deleteAsync.mockResolvedValue(undefined);

    await discardAudioClip('file:///documents/audio-recordings/clip-1.m4a');

    expect(mockedFileSystem.deleteAsync).toHaveBeenCalledWith(
      'file:///documents/audio-recordings/clip-1.m4a',
      { idempotent: true },
    );
  });

  it('is a no-op for a null/undefined uri', async () => {
    await discardAudioClip(null);
    await discardAudioClip(undefined);

    expect(mockedFileSystem.deleteAsync).not.toHaveBeenCalled();
  });

  it('never throws when the delete itself fails', async () => {
    mockedFileSystem.deleteAsync.mockRejectedValue(new Error('gone'));

    await expect(discardAudioClip('file:///documents/audio-recordings/clip-1.m4a')).resolves.toBeUndefined();
  });
});

describe('sweepAudioRecordingsDirectory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date('2026-08-19T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('is a no-op when the recordings directory does not exist', async () => {
    mockedFileSystem.getInfoAsync.mockResolvedValue({ exists: false, uri: '', isDirectory: false } as never);

    await sweepAudioRecordingsDirectory();

    expect(mockedFileSystem.readDirectoryAsync).not.toHaveBeenCalled();
  });

  it('deletes only entries older than 48h', async () => {
    const nowSeconds = Date.now() / 1000;
    mockedFileSystem.getInfoAsync.mockImplementation(async (uri: string) => {
      if (uri === 'file:///documents/audio-recordings/') {
        return { exists: true, uri, isDirectory: true, modificationTime: nowSeconds } as never;
      }
      if (uri.endsWith('old.m4a')) {
        return { exists: true, uri, isDirectory: false, modificationTime: nowSeconds - 49 * 60 * 60 } as never;
      }
      return { exists: true, uri, isDirectory: false, modificationTime: nowSeconds - 1 * 60 * 60 } as never;
    });
    mockedFileSystem.readDirectoryAsync.mockResolvedValue(['old.m4a', 'fresh.m4a']);
    mockedFileSystem.deleteAsync.mockResolvedValue(undefined);

    await sweepAudioRecordingsDirectory();

    expect(mockedFileSystem.deleteAsync).toHaveBeenCalledTimes(1);
    expect(mockedFileSystem.deleteAsync).toHaveBeenCalledWith(
      'file:///documents/audio-recordings/old.m4a',
      { idempotent: true },
    );
  });

  it('never throws when a per-entry lookup fails', async () => {
    mockedFileSystem.getInfoAsync.mockImplementation(async (uri: string) => {
      if (uri === 'file:///documents/audio-recordings/') {
        return { exists: true, uri, isDirectory: true, modificationTime: 0 } as never;
      }
      throw new Error('boom');
    });
    mockedFileSystem.readDirectoryAsync.mockResolvedValue(['broken.m4a']);

    await expect(sweepAudioRecordingsDirectory()).resolves.toBeUndefined();
    expect(mockedFileSystem.deleteAsync).not.toHaveBeenCalled();
  });

  it('never throws when the directory listing itself fails', async () => {
    mockedFileSystem.getInfoAsync.mockResolvedValue({
      exists: true,
      uri: 'file:///documents/audio-recordings/',
      isDirectory: true,
      modificationTime: 0,
    } as never);
    mockedFileSystem.readDirectoryAsync.mockRejectedValue(new Error('boom'));

    await expect(sweepAudioRecordingsDirectory()).resolves.toBeUndefined();
  });
});
