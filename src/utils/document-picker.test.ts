import { requireOptionalNativeModule } from 'expo-modules-core';

import { isDocumentPickerAvailable, pickAudioDocument } from './document-picker';

jest.mock('expo-modules-core', () => ({
  ...jest.requireActual<typeof import('expo-modules-core')>('expo-modules-core'),
  requireOptionalNativeModule: jest.fn(),
}));

const mockGetDocumentAsync = jest.fn();
// Counts how often the lazy require actually loads the JS package: it must
// stay at zero while the native module is missing (older binaries).
const mockPackageLoaded = jest.fn();
jest.mock('expo-document-picker', () => {
  mockPackageLoaded();
  return { getDocumentAsync: (...args: unknown[]) => mockGetDocumentAsync(...args) };
});

const mockedRequireOptional = requireOptionalNativeModule as jest.Mock;

describe('document-picker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reports unavailable when the native module is missing', () => {
    mockedRequireOptional.mockReturnValue(null);
    expect(isDocumentPickerAvailable()).toBe(false);
    expect(mockedRequireOptional).toHaveBeenCalledWith('ExpoDocumentPicker');
  });

  it('reports available when the native module exists', () => {
    mockedRequireOptional.mockReturnValue({});
    expect(isDocumentPickerAvailable()).toBe(true);
  });

  it('treats a throwing lookup as unavailable', () => {
    mockedRequireOptional.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(isDocumentPickerAvailable()).toBe(false);
  });

  it('never loads expo-document-picker when the native module is missing', async () => {
    mockedRequireOptional.mockReturnValue(null);

    await expect(pickAudioDocument()).resolves.toBeNull();

    expect(mockPackageLoaded).not.toHaveBeenCalled();
    expect(mockGetDocumentAsync).not.toHaveBeenCalled();
  });

  it('opens the picker for audio types with a cache copy and returns the asset', async () => {
    mockedRequireOptional.mockReturnValue({});
    mockGetDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///cache/DocumentPicker/a.m4a', name: 'a.m4a', mimeType: 'audio/mp4', size: 1234, lastModified: 0 }],
    });

    await expect(pickAudioDocument()).resolves.toEqual({
      uri: 'file:///cache/DocumentPicker/a.m4a',
      name: 'a.m4a',
      mimeType: 'audio/mp4',
      size: 1234,
    });
    expect(mockGetDocumentAsync).toHaveBeenCalledWith({
      type: ['audio/*', 'application/ogg', 'audio/ogg', 'audio/opus'],
      copyToCacheDirectory: true,
      multiple: false,
    });
  });

  it('normalises a missing mime type and size to null', async () => {
    mockedRequireOptional.mockReturnValue({});
    mockGetDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///cache/x.opus', name: 'x.opus', lastModified: 0 }],
    });

    await expect(pickAudioDocument()).resolves.toEqual({
      uri: 'file:///cache/x.opus',
      name: 'x.opus',
      mimeType: null,
      size: null,
    });
  });

  it('returns null on cancel, an empty result, or a picker error', async () => {
    mockedRequireOptional.mockReturnValue({});

    mockGetDocumentAsync.mockResolvedValueOnce({ canceled: true, assets: null });
    await expect(pickAudioDocument()).resolves.toBeNull();

    mockGetDocumentAsync.mockResolvedValueOnce({ canceled: false, assets: [] });
    await expect(pickAudioDocument()).resolves.toBeNull();

    mockGetDocumentAsync.mockRejectedValueOnce(new Error('picker failed'));
    await expect(pickAudioDocument()).resolves.toBeNull();
  });
});
