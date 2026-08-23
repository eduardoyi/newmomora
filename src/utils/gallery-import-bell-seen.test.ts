import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  hasSeenGalleryImportBell,
  markGalleryImportBellSeen,
} from '@/utils/gallery-import-bell-seen';

describe('gallery-import-bell-seen', () => {
  afterEach(async () => {
    await AsyncStorage.clear();
  });

  it('is unseen by default', async () => {
    await expect(hasSeenGalleryImportBell('user-1', 'family-1', 'run-1', 3)).resolves.toBe(false);
  });

  it('persists the seen (runId, readyCount) pair scoped to the user+family pair', async () => {
    await markGalleryImportBellSeen('user-1', 'family-1', 'run-1', 3);

    await expect(hasSeenGalleryImportBell('user-1', 'family-1', 'run-1', 3)).resolves.toBe(true);
    await expect(hasSeenGalleryImportBell('user-1', 'family-2', 'run-1', 3)).resolves.toBe(false);
    await expect(hasSeenGalleryImportBell('user-2', 'family-1', 'run-1', 3)).resolves.toBe(false);
  });

  it('reads as unseen again once readyCount grows past what was marked seen', async () => {
    await markGalleryImportBellSeen('user-1', 'family-1', 'run-1', 3);

    await expect(hasSeenGalleryImportBell('user-1', 'family-1', 'run-1', 4)).resolves.toBe(false);
  });

  it('reads as unseen again for a different run, even with the same readyCount', async () => {
    await markGalleryImportBellSeen('user-1', 'family-1', 'run-1', 3);

    await expect(hasSeenGalleryImportBell('user-1', 'family-1', 'run-2', 3)).resolves.toBe(false);
  });

  it('treats a storage read failure as unseen rather than throwing', async () => {
    const spy = jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk error'));

    await expect(hasSeenGalleryImportBell('user-1', 'family-1', 'run-1', 3)).resolves.toBe(false);

    spy.mockRestore();
  });

  it('treats malformed stored JSON as unseen rather than throwing', async () => {
    const spy = jest.spyOn(AsyncStorage, 'getItem').mockResolvedValueOnce('not json');

    await expect(hasSeenGalleryImportBell('user-1', 'family-1', 'run-1', 3)).resolves.toBe(false);

    spy.mockRestore();
  });

  it('does not throw when the storage write fails', async () => {
    const spy = jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk full'));

    await expect(markGalleryImportBellSeen('user-1', 'family-1', 'run-1', 3)).resolves.toBeUndefined();

    spy.mockRestore();
  });
});
