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
  pruneGalleryImportCheckpoint,
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

describe('pruneGalleryImportCheckpoint', () => {
  function asset(token: string, captureAtMs: number) {
    return { assetToken: token, osAssetId: `os-${token}`, captureAtMs, width: 10, height: 10, isFavorite: false };
  }

  function baseCheckpoint(overrides: Partial<GalleryImportCheckpoint> = {}): GalleryImportCheckpoint {
    return { ...checkpoint(), assetByToken: {}, chunks: [], approvalOutbox: [], ...overrides };
  }

  it('returns the checkpoint unchanged when no server run is available', () => {
    const original = baseCheckpoint({ assetByToken: { a: asset('a', 1) } });
    expect(pruneGalleryImportCheckpoint(original, null)).toBe(original);
  });

  it('drops assetByToken entries whose chunk is server-terminal and not otherwise protected', () => {
    const original = baseCheckpoint({
      assetByToken: { a: asset('a', 1), b: asset('b', 2) },
      chunks: [
        { ordinal: 0, chunkId: 'chunk-0', status: 'dispatched', clusters: [{ clusterSignature: 'sig-a', assetTokens: ['a'] }], previewUploads: [] },
        { ordinal: 1, chunkId: 'chunk-1', status: 'dispatched', clusters: [{ clusterSignature: 'sig-b', assetTokens: ['b'] }], previewUploads: [] },
      ],
    });
    const pruned = pruneGalleryImportCheckpoint(original, {
      chunks: [{ ordinal: 0, status: 'completed' }, { ordinal: 1, status: 'processing' }],
      liveCandidateAssetTokens: [],
    });
    // Chunk 0 is server-terminal ('completed') and token 'a' is otherwise
    // unprotected -> dropped. Chunk 1 is not terminal ('processing') -> kept.
    expect(pruned.assetByToken).toEqual({ b: asset('b', 2) });
  });

  it('keeps a token whose chunk is server-terminal but is referenced by the approval outbox', () => {
    const original = baseCheckpoint({
      assetByToken: { a: asset('a', 1) },
      chunks: [{ ordinal: 0, chunkId: 'chunk-0', status: 'dispatched', clusters: [{ clusterSignature: 'sig-a', assetTokens: ['a'] }], previewUploads: [] }],
      approvalOutbox: [{ candidateId: 'candidate-1', leaseId: 'lease-1', memoryId: 'memory-1', assetTokens: ['a'], status: 'uploading' }],
    });
    const pruned = pruneGalleryImportCheckpoint(original, { chunks: [{ ordinal: 0, status: 'completed' }], liveCandidateAssetTokens: [] });
    expect(pruned.assetByToken).toEqual({ a: asset('a', 1) });
  });

  it('keeps a token within the 3-hour cluster gap of a live candidate\'s own selected capture time', () => {
    const hour = 60 * 60 * 1000;
    const original = baseCheckpoint({
      assetByToken: {
        live: asset('live', 10_000),
        near: asset('near', 10_000 + hour), // within 3h of the live candidate token
        far: asset('far', 10_000 + 4 * hour), // beyond the 3h gap
      },
      chunks: [{ ordinal: 0, chunkId: 'chunk-0', status: 'dispatched', clusters: [{ clusterSignature: 'sig', assetTokens: ['live', 'near', 'far'] }], previewUploads: [] }],
    });
    const pruned = pruneGalleryImportCheckpoint(original, {
      chunks: [{ ordinal: 0, status: 'completed' }],
      liveCandidateAssetTokens: ['live'],
    });
    expect(Object.keys(pruned.assetByToken).sort()).toEqual(['live', 'near']);
  });

  it('keeps every token of a chunk that has no server row yet (not yet known to be terminal)', () => {
    const original = baseCheckpoint({
      assetByToken: { a: asset('a', 1) },
      chunks: [{ ordinal: 5, status: 'planned', clusters: [{ clusterSignature: 'sig', assetTokens: ['a'] }], previewUploads: [] }],
    });
    const pruned = pruneGalleryImportCheckpoint(original, { chunks: [], liveCandidateAssetTokens: [] });
    expect(pruned.assetByToken).toEqual({ a: asset('a', 1) });
  });

  it('prunes clusterSignatures belonging to a dispatched chunk', () => {
    const original = baseCheckpoint({
      clusterSignatures: ['sig-a', 'sig-b'],
      chunks: [
        { ordinal: 0, chunkId: 'chunk-0', status: 'dispatched', clusters: [{ clusterSignature: 'sig-a', assetTokens: [] }], previewUploads: [] },
        { ordinal: 1, chunkId: 'chunk-1', status: 'planned', clusters: [{ clusterSignature: 'sig-b', assetTokens: [] }], previewUploads: [] },
      ],
    });
    const pruned = pruneGalleryImportCheckpoint(original, { chunks: [{ ordinal: 0, status: 'completed' }, { ordinal: 1, status: 'registered' }], liveCandidateAssetTokens: [] });
    expect(pruned.clusterSignatures).toEqual(['sig-b']);
  });
});
