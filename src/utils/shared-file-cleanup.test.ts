import { readFileSync } from 'fs';
import { join } from 'path';

import { Paths } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import { getSharedPayloads } from 'expo-sharing';
import { Platform } from 'react-native';

import {
  deleteShareCopies,
  isShareCopyUri,
  SHARE_APP_GROUP_ID,
  sweepShareContainer,
} from './shared-file-cleanup';

const IOS_ROOT = 'file:///private/var/mobile/Containers/Shared/AppGroup/ABC-123';
const ANDROID_CACHE = 'file:///data/user/0/com.memora.app/cache/';

let mockSharedContainers: Record<string, { uri: string }> = {};
let mockContainersThrow = false;

jest.mock('expo-file-system', () => ({
  Paths: {
    get appleSharedContainers() {
      if (mockContainersThrow) {
        throw new Error('no entitlement');
      }
      return mockSharedContainers;
    },
  },
}));
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///data/user/0/com.memora.app/cache/',
  getInfoAsync: jest.fn(),
  deleteAsync: jest.fn(),
  readDirectoryAsync: jest.fn(),
}));
jest.mock('expo-sharing', () => ({ getSharedPayloads: jest.fn(() => []) }));

const mockedFs = FileSystem as jest.Mocked<typeof FileSystem>;
const mockedGetSharedPayloads = getSharedPayloads as jest.Mock;
const originalOs = Platform.OS;

function setPlatform(os: 'ios' | 'android') {
  Object.defineProperty(Platform, 'OS', { configurable: true, get: () => os });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockContainersThrow = false;
  mockSharedContainers = { [SHARE_APP_GROUP_ID]: { uri: `${IOS_ROOT}/` } };
  mockedFs.deleteAsync.mockResolvedValue(undefined);
  mockedGetSharedPayloads.mockReturnValue([]);
  setPlatform('ios');
});

afterAll(() => {
  Object.defineProperty(Platform, 'OS', { configurable: true, get: () => originalOs });
});

describe('SHARE_APP_GROUP_ID', () => {
  it('matches the expo-sharing appGroupId in app.json', () => {
    const appJson = JSON.parse(readFileSync(join(__dirname, '../../app.json'), 'utf8'));
    const plugins: unknown[] = appJson.expo.plugins;
    const sharing = plugins.find(
      (plugin): plugin is [string, { ios: { appGroupId: string } }] =>
        Array.isArray(plugin) && plugin[0] === 'expo-sharing',
    );
    expect(sharing?.[1].ios.appGroupId).toBe(SHARE_APP_GROUP_ID);
  });
});

describe('isShareCopyUri (iOS)', () => {
  it('accepts a file directly in the share container root', () => {
    expect(isShareCopyUri(`${IOS_ROOT}/IMG_0001.HEIC`)).toBe(true);
  });

  it('normalizes /private prefixes, percent-encoding and a trailing-slash root', () => {
    expect(isShareCopyUri('file:///var/mobile/Containers/Shared/AppGroup/ABC-123/My%20Photo.jpg')).toBe(true);
    mockSharedContainers = { [SHARE_APP_GROUP_ID]: { uri: 'file:///var/mobile/Containers/Shared/AppGroup/ABC-123' } };
    expect(isShareCopyUri(`${IOS_ROOT}/a.jpg`)).toBe(true);
  });

  it('rejects subdirectories, the root itself and Library', () => {
    expect(isShareCopyUri(`${IOS_ROOT}/sub/a.jpg`)).toBe(false);
    expect(isShareCopyUri(`${IOS_ROOT}/Library/Preferences/x.plist`)).toBe(false);
    expect(isShareCopyUri(`${IOS_ROOT}/Library`)).toBe(false);
    expect(isShareCopyUri(`${IOS_ROOT}/library/`)).toBe(false);
    expect(isShareCopyUri(`${IOS_ROOT}/`)).toBe(false);
    expect(isShareCopyUri(`${IOS_ROOT}/../other/a.jpg`)).toBe(false);
  });

  it('rejects other locations, the Android-style cache and malformed values', () => {
    expect(isShareCopyUri('file:///var/mobile/Containers/Data/Application/X/Documents/a.jpg')).toBe(false);
    expect(isShareCopyUri('file:///var/mobile/Containers/Shared/AppGroup/OTHER/a.jpg')).toBe(false);
    expect(isShareCopyUri(`${ANDROID_CACHE}a.jpg`)).toBe(false);
    expect(isShareCopyUri('https://example.com/a.jpg')).toBe(false);
    expect(isShareCopyUri('')).toBe(false);
    expect(isShareCopyUri(null)).toBe(false);
    expect(isShareCopyUri(undefined)).toBe(false);
  });

  it('is false when the container is unavailable or throws', () => {
    mockSharedContainers = {};
    expect(isShareCopyUri(`${IOS_ROOT}/a.jpg`)).toBe(false);
    mockContainersThrow = true;
    expect(isShareCopyUri(`${IOS_ROOT}/a.jpg`)).toBe(false);
  });
});

describe('isShareCopyUri (Android)', () => {
  beforeEach(() => setPlatform('android'));

  it('accepts a file directly in the cache root', () => {
    expect(isShareCopyUri(`${ANDROID_CACHE}IMG_20240101.jpg`)).toBe(true);
    expect(isShareCopyUri('file:///data/data/com.memora.app/cache/a.mp4')).toBe(true);
  });

  it('rejects cache subdirectories such as expo-image-picker output', () => {
    expect(isShareCopyUri(`${ANDROID_CACHE}ImagePicker/abc.jpg`)).toBe(false);
    expect(isShareCopyUri(`${ANDROID_CACHE}DocumentPicker/abc.m4a`)).toBe(false);
    expect(isShareCopyUri('file:///data/user/0/com.memora.app/files/a.jpg')).toBe(false);
    expect(isShareCopyUri(`${IOS_ROOT}/a.jpg`)).toBe(false);
  });
});

describe('deleteShareCopies', () => {
  it('deletes only share copies, once each, idempotently', async () => {
    await deleteShareCopies([
      `${IOS_ROOT}/a.jpg`,
      `${IOS_ROOT}/a.jpg`,
      `${IOS_ROOT}/sub/b.jpg`,
      'file:///var/mobile/Containers/Data/Application/X/Documents/c.jpg',
      null,
      undefined,
    ]);
    expect(mockedFs.deleteAsync).toHaveBeenCalledTimes(1);
    expect(mockedFs.deleteAsync).toHaveBeenCalledWith(`${IOS_ROOT}/a.jpg`, { idempotent: true });
  });

  it('never throws, even when deletion fails, and never logs', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    mockedFs.deleteAsync.mockRejectedValue(new Error('boom'));
    await expect(deleteShareCopies([`${IOS_ROOT}/a.jpg`, `${IOS_ROOT}/b.jpg`])).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
    log.mockRestore();
  });

  it('handles an empty list', async () => {
    await expect(deleteShareCopies([])).resolves.toBeUndefined();
    expect(mockedFs.deleteAsync).not.toHaveBeenCalled();
  });
});

describe('sweepShareContainer', () => {
  const NOW = 1_800_000_000_000;
  const DAY = 24 * 60 * 60 * 1000;

  function mockEntries(entries: Record<string, { isDirectory?: boolean; ageMs?: number; exists?: boolean }>) {
    mockedFs.readDirectoryAsync.mockResolvedValue(Object.keys(entries));
    mockedFs.getInfoAsync.mockImplementation((async (uri: string) => {
      const name = decodeURIComponent(uri.slice(uri.lastIndexOf('/') + 1));
      const entry = entries[name];
      return {
        exists: entry.exists ?? true,
        isDirectory: entry.isDirectory ?? false,
        uri,
        modificationTime: (NOW - (entry.ageMs ?? 0)) / 1000,
      };
    }) as never);
  }

  it('deletes only regular files older than the threshold', async () => {
    mockEntries({
      'old.jpg': { ageMs: DAY + 1000 },
      'fresh.jpg': { ageMs: 60 * 1000 },
      'borderline.jpg': { ageMs: DAY },
      Library: { isDirectory: true, ageMs: 5 * DAY },
      'some folder': { isDirectory: true, ageMs: 5 * DAY },
    });
    await sweepShareContainer({ now: NOW });
    expect(mockedFs.readDirectoryAsync).toHaveBeenCalledWith(`${IOS_ROOT}/`);
    expect(mockedFs.deleteAsync).toHaveBeenCalledTimes(1);
    expect(mockedFs.deleteAsync).toHaveBeenCalledWith(`${IOS_ROOT}/old.jpg`, { idempotent: true });
  });

  it('never touches Library even when it reports as a file', async () => {
    mockEntries({ Library: { isDirectory: false, ageMs: 9 * DAY } });
    await sweepShareContainer({ now: NOW });
    expect(mockedFs.getInfoAsync).not.toHaveBeenCalled();
    expect(mockedFs.deleteAsync).not.toHaveBeenCalled();
  });

  it('honours a custom threshold and encodes names', async () => {
    mockEntries({ 'My Photo.jpg': { ageMs: 2000 } });
    await sweepShareContainer({ now: NOW, olderThanMs: 1000 });
    expect(mockedFs.deleteAsync).toHaveBeenCalledWith(`${IOS_ROOT}/My%20Photo.jpg`, { idempotent: true });
  });

  it('skips files an unconsumed share still points at', async () => {
    mockEntries({ 'pending.jpg': { ageMs: 9 * DAY }, 'stale.jpg': { ageMs: 9 * DAY } });
    mockedGetSharedPayloads.mockReturnValue([
      { value: `${IOS_ROOT}/pending.jpg`, shareType: 'image', mimeType: 'image/jpeg' },
    ]);
    await sweepShareContainer({ now: NOW });
    expect(mockedFs.deleteAsync).toHaveBeenCalledTimes(1);
    expect(mockedFs.deleteAsync).toHaveBeenCalledWith(`${IOS_ROOT}/stale.jpg`, { idempotent: true });
  });

  it('captures the pending payloads before listing, so a payload cleared mid-sweep stays protected', async () => {
    mockEntries({ 'pending.jpg': { ageMs: 9 * DAY } });
    mockedGetSharedPayloads.mockReturnValue([
      { value: `${IOS_ROOT}/pending.jpg`, shareType: 'image', mimeType: 'image/jpeg' },
    ]);
    // The composer consumes and clears the payload while the directory is listed.
    mockedFs.readDirectoryAsync.mockImplementation(async () => {
      mockedGetSharedPayloads.mockReturnValue([]);
      return ['pending.jpg'];
    });
    await sweepShareContainer({ now: NOW });
    expect(mockedFs.deleteAsync).not.toHaveBeenCalled();
  });

  it('is a no-op on Android and when the container is unavailable', async () => {
    setPlatform('android');
    await sweepShareContainer({ now: NOW });
    expect(mockedFs.readDirectoryAsync).not.toHaveBeenCalled();

    setPlatform('ios');
    mockSharedContainers = {};
    await sweepShareContainer({ now: NOW });
    expect(mockedFs.readDirectoryAsync).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    mockedFs.readDirectoryAsync.mockRejectedValue(new Error('boom'));
    await expect(sweepShareContainer({ now: NOW })).resolves.toBeUndefined();

    mockEntries({ 'a.jpg': { ageMs: 9 * DAY }, 'b.jpg': { ageMs: 9 * DAY } });
    mockedFs.deleteAsync.mockRejectedValueOnce(new Error('boom'));
    await expect(sweepShareContainer({ now: NOW })).resolves.toBeUndefined();
    expect(mockedFs.deleteAsync).toHaveBeenCalledTimes(2);

    mockContainersThrow = true;
    await expect(sweepShareContainer({ now: NOW })).resolves.toBeUndefined();
  });
});
