import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

import { claimArtworkScan, deleteArtworkScanFile } from '@/utils/artwork-scan-custody';
import { getLocalFileSizeBytes } from '@/utils/local-files';

import { getMomoraArtworkScannerNativeModule } from '../../modules/momora-artwork-scanner';
import { ArtworkScanError, isArtworkScannerAvailable, scanArtwork } from './artwork-scanner';

jest.mock('../../modules/momora-artwork-scanner', () => ({
  getMomoraArtworkScannerNativeModule: jest.fn(),
}));

jest.mock('expo-file-system/legacy', () => ({
  deleteAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/utils/artwork-scan-custody', () => ({
  claimArtworkScan: jest.fn(),
  deleteArtworkScanFile: jest.fn().mockResolvedValue(undefined),
  createArtworkScanId: jest.fn(() => 'attachment-id'),
}));

jest.mock('@/utils/local-files', () => ({
  getLocalFileSizeBytes: jest.fn(),
}));

const mockedGetModule = getMomoraArtworkScannerNativeModule as jest.Mock;
const mockedClaim = claimArtworkScan as jest.Mock;
const mockedDeleteClaimed = deleteArtworkScanFile as jest.Mock;
const mockedSize = getLocalFileSizeBytes as jest.Mock;
const mockedDeleteAsync = FileSystem.deleteAsync as jest.Mock;

const originalPlatform = Platform.OS;

function setPlatform(os: 'ios' | 'android' | 'web') {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: os });
}

function page(index: number, width = 3000, height = 2000) {
  return { uri: `file:///cache/native-${index}.jpg`, width, height };
}

function makeModule(overrides: Partial<{ isAvailable: jest.Mock; scan: jest.Mock }> = {}) {
  return {
    isAvailable: jest.fn(() => true),
    scan: jest.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  setPlatform('ios');
  mockedClaim.mockImplementation(async (uri: string) =>
    uri.replace('file:///cache/native-', 'file:///documents/artwork-scans/claimed-'),
  );
  mockedSize.mockResolvedValue(1_500_000);
});

afterAll(() => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
});

describe('isArtworkScannerAvailable', () => {
  it('is false on web without touching the module', () => {
    setPlatform('web');
    expect(isArtworkScannerAvailable()).toBe(false);
    expect(mockedGetModule).not.toHaveBeenCalled();
  });

  it('is false when the native module is missing (old binary)', () => {
    mockedGetModule.mockReturnValue(null);
    expect(isArtworkScannerAvailable()).toBe(false);
  });

  it('on iOS follows isAvailable()', () => {
    mockedGetModule.mockReturnValue(makeModule({ isAvailable: jest.fn(() => false) }));
    expect(isArtworkScannerAvailable()).toBe(false);

    mockedGetModule.mockReturnValue(makeModule({ isAvailable: jest.fn(() => true) }));
    expect(isArtworkScannerAvailable()).toBe(true);
  });

  it('on iOS is false when isAvailable() throws', () => {
    mockedGetModule.mockReturnValue(
      makeModule({
        isAvailable: jest.fn(() => {
          throw new Error('native');
        }),
      }),
    );
    expect(isArtworkScannerAvailable()).toBe(false);
  });

  it('on Android is true whenever the module is present, without calling isAvailable()', () => {
    setPlatform('android');
    const module = makeModule({ isAvailable: jest.fn(() => false) });
    mockedGetModule.mockReturnValue(module);
    expect(isArtworkScannerAvailable()).toBe(true);
    expect(module.isAvailable).not.toHaveBeenCalled();
  });
});

describe('scanArtwork', () => {
  it('rejects scanner_unavailable when the module is missing', async () => {
    mockedGetModule.mockReturnValue(null);
    await expect(scanArtwork({ remainingSlots: 5 })).rejects.toMatchObject({
      code: 'scanner_unavailable',
    });
  });

  it('does not open the scanner when no slots remain', async () => {
    const module = makeModule();
    mockedGetModule.mockReturnValue(module);

    const result = await scanArtwork({ remainingSlots: 0 });

    expect(result.status).toBe('cancel');
    expect(module.scan).not.toHaveBeenCalled();
  });

  it('returns an empty cancel result when the user cancels', async () => {
    const module = makeModule({ scan: jest.fn().mockResolvedValue({ status: 'cancel', pages: [] }) });
    mockedGetModule.mockReturnValue(module);

    const result = await scanArtwork({ remainingSlots: 4 });

    expect(module.scan).toHaveBeenCalledWith({ pageLimit: 4 });
    expect(result).toEqual({
      status: 'cancel',
      attachments: [],
      droppedCount: 0,
      rejectedCount: 0,
      validationError: null,
    });
    expect(mockedClaim).not.toHaveBeenCalled();
  });

  it('maps pages to scan-sourced image/jpeg attachments in custody', async () => {
    const module = makeModule({
      scan: jest.fn().mockResolvedValue({
        status: 'success',
        pages: [page(1, 3000, 2000), page(2, 1500, 2000)],
      }),
    });
    mockedGetModule.mockReturnValue(module);

    const result = await scanArtwork({ remainingSlots: 10 });

    expect(result.status).toBe('success');
    expect(result.droppedCount).toBe(0);
    expect(result.attachments).toHaveLength(2);
    expect(result.attachments[0]).toEqual({
      id: 'attachment-id',
      uri: 'file:///documents/artwork-scans/claimed-1.jpg',
      contentType: 'image/jpeg',
      aspectRatio: 1.5,
      sizeBytes: 1_500_000,
      source: 'scan',
    });
    expect(result.attachments[1]?.aspectRatio).toBeCloseTo(0.75);
    expect(result.attachments[0]).not.toHaveProperty('capturedAtIso');
    expect(mockedClaim).toHaveBeenCalledWith('file:///cache/native-1.jpg');
  });

  it('caps the native page limit at 10', async () => {
    const module = makeModule({ scan: jest.fn().mockResolvedValue({ status: 'cancel', pages: [] }) });
    mockedGetModule.mockReturnValue(module);

    await scanArtwork({ remainingSlots: 25 });

    expect(module.scan).toHaveBeenCalledWith({ pageLimit: 10 });
  });

  it('truncates pages beyond remainingSlots and deletes the dropped native files', async () => {
    const module = makeModule({
      scan: jest.fn().mockResolvedValue({
        status: 'success',
        pages: [page(1), page(2), page(3), page(4)],
      }),
    });
    mockedGetModule.mockReturnValue(module);

    const result = await scanArtwork({ remainingSlots: 2 });

    expect(result.attachments.map((a) => a.uri)).toEqual([
      'file:///documents/artwork-scans/claimed-1.jpg',
      'file:///documents/artwork-scans/claimed-2.jpg',
    ]);
    expect(result.droppedCount).toBe(2);
    expect(mockedClaim).toHaveBeenCalledTimes(2);
    expect(mockedDeleteAsync).toHaveBeenCalledWith('file:///cache/native-3.jpg', { idempotent: true });
    expect(mockedDeleteAsync).toHaveBeenCalledWith('file:///cache/native-4.jpg', { idempotent: true });
    expect(mockedDeleteAsync).toHaveBeenCalledTimes(2);
  });

  it('surfaces validation failures and deletes the rejected claimed file', async () => {
    const module = makeModule({
      scan: jest.fn().mockResolvedValue({ status: 'success', pages: [page(1), page(2)] }),
    });
    mockedGetModule.mockReturnValue(module);
    mockedSize.mockResolvedValueOnce(25 * 1024 * 1024).mockResolvedValueOnce(2_000_000);

    const result = await scanArtwork({ remainingSlots: 5 });

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]?.uri).toBe('file:///documents/artwork-scans/claimed-2.jpg');
    expect(result.rejectedCount).toBe(1);
    expect(result.validationError).toBe('Photos must be 20 MB or smaller.');
    expect(mockedDeleteClaimed).toHaveBeenCalledWith('file:///documents/artwork-scans/claimed-1.jpg');
  });

  it('treats an unreadable file size as a validation failure', async () => {
    const module = makeModule({
      scan: jest.fn().mockResolvedValue({ status: 'success', pages: [page(1)] }),
    });
    mockedGetModule.mockReturnValue(module);
    mockedSize.mockResolvedValueOnce(null);

    const result = await scanArtwork({ remainingSlots: 5 });

    expect(result.attachments).toEqual([]);
    expect(result.rejectedCount).toBe(1);
    expect(result.validationError).toBeTruthy();
  });

  it.each(['scanner_unavailable', 'scanner_failed', 'scanner_busy'] as const)(
    'maps native rejection %s to a typed error',
    async (code) => {
      const nativeError = Object.assign(new Error('native'), { code });
      mockedGetModule.mockReturnValue(makeModule({ scan: jest.fn().mockRejectedValue(nativeError) }));

      const error = await scanArtwork({ remainingSlots: 3 }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ArtworkScanError);
      expect((error as ArtworkScanError).code).toBe(code);
    },
  );

  it('maps unknown native errors to scanner_failed', async () => {
    mockedGetModule.mockReturnValue(
      makeModule({ scan: jest.fn().mockRejectedValue(new Error('something else')) }),
    );

    await expect(scanArtwork({ remainingSlots: 3 })).rejects.toMatchObject({ code: 'scanner_failed' });
  });

  it('cleans up the whole batch and fails when a page cannot be moved into custody', async () => {
    mockedGetModule.mockReturnValue(
      makeModule({
        scan: jest.fn().mockResolvedValue({ status: 'success', pages: [page(1), page(2)] }),
      }),
    );
    mockedClaim.mockResolvedValueOnce('file:///documents/artwork-scans/claimed-1.jpg');
    mockedClaim.mockRejectedValueOnce(new Error('disk full'));

    await expect(scanArtwork({ remainingSlots: 5 })).rejects.toMatchObject({ code: 'scanner_failed' });

    expect(mockedDeleteClaimed).toHaveBeenCalledWith('file:///documents/artwork-scans/claimed-1.jpg');
    expect(mockedDeleteAsync).toHaveBeenCalledWith('file:///cache/native-2.jpg', { idempotent: true });
  });
});
