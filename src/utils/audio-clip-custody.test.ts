import * as FileSystem from 'expo-file-system/legacy';

import {
  claimAudioClip,
  discardAudioClip,
  isInsideAudioRecordingsDirectory,
  newAudioRecordingUri,
  sweepAudioRecordingsDirectory,
} from './audio-clip-custody';

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
      to: expect.stringMatching(/^file:\/\/\/documents\/audio-recordings\/\d{13}-[a-f0-9-]+\.m4a$/),
    });
    expect(result).toMatch(/^file:\/\/\/documents\/audio-recordings\/\d{13}-[a-f0-9-]+\.m4a$/);
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

describe('newAudioRecordingUri', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedFileSystem.getInfoAsync.mockResolvedValue({
      exists: true,
      uri: '',
      isDirectory: true,
      modificationTime: 0,
    } as never);
  });

  it('names files <claimEpochMs>-<uuid>.<ext> inside audio-recordings/', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-10T12:00:00.000Z'));
    try {
      const uri = await newAudioRecordingUri('.OPUS');
      expect(uri).toMatch(
        new RegExp(`^file:///documents/audio-recordings/${Date.now()}-[a-f0-9-]+\\.opus$`),
      );
      expect(isInsideAudioRecordingsDirectory(uri)).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('falls back to m4a for a missing or junk extension and strips path characters', async () => {
    expect(await newAudioRecordingUri('')).toMatch(/\.m4a$/);
    expect(await newAudioRecordingUri('../x/y')).toMatch(/\.xy$/);
    expect(await newAudioRecordingUri('///')).toMatch(/\.m4a$/);
  });

  it('claims with the extension of the source when asked', async () => {
    mockedFileSystem.copyAsync.mockResolvedValue(undefined);
    const uri = await claimAudioClip('file:///cache/PTT-1.opus', 'opus');
    expect(uri).toMatch(/\d{13}-[a-f0-9-]+\.opus$/);
  });

  it('does not treat other directories as inside audio-recordings/', () => {
    expect(isInsideAudioRecordingsDirectory('file:///documents/other/a.m4a')).toBe(false);
    expect(isInsideAudioRecordingsDirectory('file:///cache/a.m4a')).toBe(false);
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

  it('uses the claim timestamp in the name instead of a stale mtime', async () => {
    const nowMs = Date.now();
    const nowSeconds = nowMs / 1000;
    const freshName = `${nowMs - 60 * 60 * 1000}-aaaa-bbbb.m4a`;
    const staleName = `${nowMs - 49 * 60 * 60 * 1000}-cccc-dddd.m4a`;
    mockedFileSystem.getInfoAsync.mockImplementation(async (uri: string) => {
      if (uri === 'file:///documents/audio-recordings/') {
        return { exists: true, uri, isDirectory: true, modificationTime: nowSeconds } as never;
      }
      // A copied voice note recorded a month ago keeps its old mtime on the
      // fresh copy; the fresh claim name must still protect it. A stale name
      // with a brand-new mtime (copy touched later) is still swept.
      if (uri.endsWith(freshName)) {
        return { exists: true, uri, isDirectory: false, modificationTime: nowSeconds - 30 * 24 * 3600 } as never;
      }
      return { exists: true, uri, isDirectory: false, modificationTime: nowSeconds } as never;
    });
    mockedFileSystem.readDirectoryAsync.mockResolvedValue([freshName, staleName]);
    mockedFileSystem.deleteAsync.mockResolvedValue(undefined);

    await sweepAudioRecordingsDirectory();

    expect(mockedFileSystem.deleteAsync).toHaveBeenCalledTimes(1);
    expect(mockedFileSystem.deleteAsync).toHaveBeenCalledWith(
      `file:///documents/audio-recordings/${staleName}`,
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
