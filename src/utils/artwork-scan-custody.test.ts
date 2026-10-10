import * as FileSystem from 'expo-file-system/legacy';

import {
  claimArtworkScan,
  createArtworkScanId,
  deleteArtworkScanFile,
  isInsideArtworkScansDirectory,
  sweepStaleArtworkScans,
} from './artwork-scan-custody';

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///documents/',
  getInfoAsync: jest.fn(),
  makeDirectoryAsync: jest.fn(),
  moveAsync: jest.fn(),
  copyAsync: jest.fn(),
  deleteAsync: jest.fn(),
  readDirectoryAsync: jest.fn(),
}));

const mockedFileSystem = FileSystem as jest.Mocked<typeof FileSystem>;
const DAY_MS = 24 * 60 * 60 * 1000;
const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';

describe('isInsideArtworkScansDirectory', () => {
  it('accepts direct children of artwork-scans/', () => {
    expect(isInsideArtworkScansDirectory(`file:///documents/artwork-scans/1-${UUID_A}.jpg`)).toBe(true);
  });

  it('rejects other locations, traversal, nested paths, and empty input', () => {
    expect(isInsideArtworkScansDirectory(null)).toBe(false);
    expect(isInsideArtworkScansDirectory('')).toBe(false);
    expect(isInsideArtworkScansDirectory('file:///documents/audio-recordings/a.m4a')).toBe(false);
    expect(isInsideArtworkScansDirectory('file:///cache/ImagePicker/a.jpg')).toBe(false);
    expect(isInsideArtworkScansDirectory('file:///documents/artwork-scans/')).toBe(false);
    expect(isInsideArtworkScansDirectory('file:///documents/artwork-scans/../secret.jpg')).toBe(false);
    expect(isInsideArtworkScansDirectory('file:///documents/artwork-scans/sub/a.jpg')).toBe(false);
  });
});

describe('claimArtworkScan', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates the directory when missing and moves the file with a timestamped uuid name', async () => {
    mockedFileSystem.getInfoAsync.mockResolvedValue({ exists: false } as never);

    const result = await claimArtworkScan('file:///cache/scan-1.jpg', 1_700_000_000_000);

    expect(mockedFileSystem.makeDirectoryAsync).toHaveBeenCalledWith(
      'file:///documents/artwork-scans/',
      { intermediates: true },
    );
    expect(mockedFileSystem.moveAsync).toHaveBeenCalledWith({
      from: 'file:///cache/scan-1.jpg',
      to: result,
    });
    expect(result).toMatch(/^file:\/\/\/documents\/artwork-scans\/1700000000000-[a-f0-9-]{36}\.jpg$/);
  });

  it('falls back to copy + delete when move fails', async () => {
    mockedFileSystem.getInfoAsync.mockResolvedValue({ exists: true } as never);
    mockedFileSystem.moveAsync.mockRejectedValueOnce(new Error('cross-volume'));

    const result = await claimArtworkScan('file:///cache/scan-2.jpg');

    expect(mockedFileSystem.copyAsync).toHaveBeenCalledWith({
      from: 'file:///cache/scan-2.jpg',
      to: result,
    });
    expect(mockedFileSystem.deleteAsync).toHaveBeenCalledWith('file:///cache/scan-2.jpg', { idempotent: true });
  });

  it('propagates a copy failure so the caller can surface it', async () => {
    mockedFileSystem.getInfoAsync.mockResolvedValue({ exists: true } as never);
    mockedFileSystem.moveAsync.mockRejectedValueOnce(new Error('move'));
    mockedFileSystem.copyAsync.mockRejectedValueOnce(new Error('copy'));

    await expect(claimArtworkScan('file:///cache/scan-3.jpg')).rejects.toThrow('copy');
  });

  it('produces distinct ids', () => {
    expect(createArtworkScanId()).not.toEqual(createArtworkScanId());
  });
});

describe('deleteArtworkScanFile', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('deletes files inside artwork-scans/', async () => {
    const uri = `file:///documents/artwork-scans/1-${UUID_A}.jpg`;
    await deleteArtworkScanFile(uri);
    expect(mockedFileSystem.deleteAsync).toHaveBeenCalledWith(uri, { idempotent: true });
  });

  it('is a no-op outside artwork-scans/', async () => {
    await deleteArtworkScanFile('file:///cache/ImagePicker/library-photo.jpg');
    await deleteArtworkScanFile(undefined);
    expect(mockedFileSystem.deleteAsync).not.toHaveBeenCalled();
  });

  it('never throws on delete failure', async () => {
    mockedFileSystem.deleteAsync.mockRejectedValueOnce(new Error('boom'));
    await expect(
      deleteArtworkScanFile(`file:///documents/artwork-scans/1-${UUID_A}.jpg`),
    ).resolves.toBeUndefined();
  });
});

describe('sweepStaleArtworkScans', () => {
  const now = 1_800_000_000_000;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(now);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('does nothing when the directory does not exist', async () => {
    mockedFileSystem.getInfoAsync.mockResolvedValue({ exists: false } as never);
    await sweepStaleArtworkScans();
    expect(mockedFileSystem.readDirectoryAsync).not.toHaveBeenCalled();
  });

  it('deletes files older than 7 days by name timestamp, keeps recent ones and ignores foreign names', async () => {
    mockedFileSystem.getInfoAsync.mockResolvedValue({ exists: true } as never);
    const stale = `${now - 8 * DAY_MS}-${UUID_A}.jpg`;
    const fresh = `${now - 1 * DAY_MS}-${UUID_B}.jpg`;
    mockedFileSystem.readDirectoryAsync.mockResolvedValue([stale, fresh, 'notes.txt']);

    await sweepStaleArtworkScans();

    expect(mockedFileSystem.deleteAsync).toHaveBeenCalledTimes(1);
    expect(mockedFileSystem.deleteAsync).toHaveBeenCalledWith(
      `file:///documents/artwork-scans/${stale}`,
      { idempotent: true },
    );
  });

  it('skips stale files still referenced by keepUris', async () => {
    mockedFileSystem.getInfoAsync.mockResolvedValue({ exists: true } as never);
    const keptName = `${now - 9 * DAY_MS}-${UUID_A}.jpg`;
    const staleName = `${now - 9 * DAY_MS}-${UUID_C}.jpg`;
    mockedFileSystem.readDirectoryAsync.mockResolvedValue([keptName, staleName]);

    await sweepStaleArtworkScans({ keepUris: [`file:///documents/artwork-scans/${keptName}`] });

    expect(mockedFileSystem.deleteAsync).toHaveBeenCalledTimes(1);
    expect(mockedFileSystem.deleteAsync).toHaveBeenCalledWith(
      `file:///documents/artwork-scans/${staleName}`,
      { idempotent: true },
    );
  });

  it('honors a custom olderThanMs and swallows failures', async () => {
    mockedFileSystem.getInfoAsync.mockResolvedValue({ exists: true } as never);
    const name = `${now - 2 * DAY_MS}-${UUID_A}.jpg`;
    mockedFileSystem.readDirectoryAsync.mockResolvedValue([name]);
    mockedFileSystem.deleteAsync.mockRejectedValueOnce(new Error('boom'));

    await expect(sweepStaleArtworkScans({ olderThanMs: DAY_MS })).resolves.toBeUndefined();
    expect(mockedFileSystem.deleteAsync).toHaveBeenCalledTimes(1);

    mockedFileSystem.getInfoAsync.mockRejectedValueOnce(new Error('fs down'));
    await expect(sweepStaleArtworkScans()).resolves.toBeUndefined();
  });
});
