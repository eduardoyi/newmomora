/* eslint-disable import/first -- AsyncStorage mock must be registered before tested imports. */
import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Jest mock factory.
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

import {
  clearGalleryImportCheckpoint,
  getGalleryImportCheckpointKey,
  loadGalleryImportCheckpoint,
  saveGalleryImportCheckpoint,
  updateGalleryImportCheckpoint,
  type GalleryImportCheckpoint,
} from '@/utils/gallery-import-checkpoint';

const USER_ID = 'user-1';
const FAMILY_ID = 'family-1';
const RUN_ID = 'run-1';

function checkpoint(): GalleryImportCheckpoint {
  return {
    version: 2,
    userId: USER_ID,
    familyId: FAMILY_ID,
    runId: RUN_ID,
    runCapability: 'capability-that-stays-local',
    algorithmVersion: 'gallery-v1',
    status: 'reviewing',
    assetByToken: {
      token: {
        assetToken: 'token',
        osAssetId: 'ph://private-device-id',
        captureAtMs: 1,
        width: 10,
        height: 10,
        isFavorite: false,
      },
    },
    uploadedAssetTokens: [],
    clusterSignatures: ['signature'],
    chunks: [],
    deckCursor: 0,
    approvalOutbox: [],
    updatedAt: '2026-08-09T00:00:00.000Z',
  };
}

describe('gallery import checkpoint', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('round-trips local-only resume data scoped to the user, family, and run', async () => {
    await saveGalleryImportCheckpoint(checkpoint());
    await expect(loadGalleryImportCheckpoint(USER_ID, FAMILY_ID, RUN_ID)).resolves.toEqual(
      expect.objectContaining({ runCapability: 'capability-that-stays-local' }),
    );
    await expect(loadGalleryImportCheckpoint('another-user', FAMILY_ID, RUN_ID)).resolves.toBeNull();
  });

  it('removes corrupt checkpoint data instead of surfacing it to another session', async () => {
    const key = getGalleryImportCheckpointKey(USER_ID, FAMILY_ID, RUN_ID);
    await AsyncStorage.setItem(key, 'not JSON');
    await expect(loadGalleryImportCheckpoint(USER_ID, FAMILY_ID, RUN_ID)).resolves.toBeNull();
    await expect(AsyncStorage.getItem(key)).resolves.toBeNull();
  });

  it('does not revive a pre-v2 checkpoint that lacks chunk receipts', async () => {
    const legacyKey = `gallery-import-checkpoint:v1:${USER_ID}:${FAMILY_ID}:${RUN_ID}`;
    await AsyncStorage.setItem(legacyKey, JSON.stringify({ ...checkpoint(), version: 1, chunks: undefined }));
    await expect(loadGalleryImportCheckpoint(USER_ID, FAMILY_ID, RUN_ID)).resolves.toBeNull();
  });

  it('serializes checkpoint mutations so parallel changes are not lost', async () => {
    await saveGalleryImportCheckpoint(checkpoint());
    await Promise.all([
      updateGalleryImportCheckpoint(USER_ID, FAMILY_ID, RUN_ID, (current) => ({ ...current, deckCursor: 2 })),
      updateGalleryImportCheckpoint(USER_ID, FAMILY_ID, RUN_ID, (current) => ({
        ...current,
        uploadedAssetTokens: [...current.uploadedAssetTokens, 'token'],
      })),
    ]);
    await expect(loadGalleryImportCheckpoint(USER_ID, FAMILY_ID, RUN_ID)).resolves.toEqual(
      expect.objectContaining({ deckCursor: 2, uploadedAssetTokens: ['token'] }),
    );
  });

  it('clears a terminal run checkpoint without failing the caller', async () => {
    await saveGalleryImportCheckpoint(checkpoint());
    await clearGalleryImportCheckpoint(USER_ID, FAMILY_ID, RUN_ID);
    await expect(loadGalleryImportCheckpoint(USER_ID, FAMILY_ID, RUN_ID)).resolves.toBeNull();
  });

});
