import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  dismissGalleryImportInvite,
  isGalleryImportInviteDismissed,
} from '@/utils/gallery-import-invite-dismissal';

describe('gallery-import-invite-dismissal', () => {
  afterEach(async () => {
    await AsyncStorage.clear();
  });

  it('is not dismissed by default', async () => {
    await expect(isGalleryImportInviteDismissed('user-1', 'family-1')).resolves.toBe(false);
  });

  it('persists dismissal scoped to the user+family pair', async () => {
    await dismissGalleryImportInvite('user-1', 'family-1');

    await expect(isGalleryImportInviteDismissed('user-1', 'family-1')).resolves.toBe(true);
    await expect(isGalleryImportInviteDismissed('user-1', 'family-2')).resolves.toBe(false);
    await expect(isGalleryImportInviteDismissed('user-2', 'family-1')).resolves.toBe(false);
  });

  it('treats a storage read failure as not dismissed rather than throwing', async () => {
    const spy = jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk error'));

    await expect(isGalleryImportInviteDismissed('user-1', 'family-1')).resolves.toBe(false);

    spy.mockRestore();
  });

  it('does not throw when the storage write fails', async () => {
    const spy = jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk full'));

    await expect(dismissGalleryImportInvite('user-1', 'family-1')).resolves.toBeUndefined();

    spy.mockRestore();
  });
});
