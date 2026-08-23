import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  clearGalleryImportFrontier,
  loadGalleryImportFrontier,
  mergeGalleryImportFrontierCoverage,
  saveGalleryImportFrontier,
  type GalleryImportFrontier,
} from '@/utils/gallery-import-frontier';

jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories cannot use ESM imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const USER_ID = 'user-1';
const FAMILY_ID = 'family-1';

function frontier(overrides: Partial<GalleryImportFrontier> = {}): GalleryImportFrontier {
  return { oldestCoveredMs: 1_000, coveredThroughNewestMs: 5_000, completedLibrary: false, corpusMode: 'camera_album', autoContinue: true, ...overrides };
}

describe('gallery import frontier storage', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.restoreAllMocks();
  });

  it('returns null when nothing is stored', async () => {
    expect(await loadGalleryImportFrontier(USER_ID, FAMILY_ID)).toBeNull();
  });

  it('round-trips a saved frontier', async () => {
    await saveGalleryImportFrontier(USER_ID, FAMILY_ID, frontier());
    expect(await loadGalleryImportFrontier(USER_ID, FAMILY_ID)).toEqual(frontier());
  });

  it('scopes storage per user and family -- a different family sees nothing', async () => {
    await saveGalleryImportFrontier(USER_ID, FAMILY_ID, frontier());
    expect(await loadGalleryImportFrontier(USER_ID, 'family-2')).toBeNull();
    expect(await loadGalleryImportFrontier('user-2', FAMILY_ID)).toBeNull();
  });

  it('clears the stored frontier', async () => {
    await saveGalleryImportFrontier(USER_ID, FAMILY_ID, frontier());
    await clearGalleryImportFrontier(USER_ID, FAMILY_ID);
    expect(await loadGalleryImportFrontier(USER_ID, FAMILY_ID)).toBeNull();
  });

  it('degrades to null for corrupt or shape-invalid stored data', async () => {
    await AsyncStorage.setItem('gallery-import-frontier:user-1:family-1', 'not json');
    expect(await loadGalleryImportFrontier(USER_ID, FAMILY_ID)).toBeNull();

    await AsyncStorage.setItem('gallery-import-frontier:user-1:family-1', JSON.stringify({ oldestCoveredMs: 5_000, coveredThroughNewestMs: 1_000, completedLibrary: false, corpusMode: 'camera_album' }));
    expect(await loadGalleryImportFrontier(USER_ID, FAMILY_ID)).toBeNull(); // oldest must be <= newest

    await AsyncStorage.setItem('gallery-import-frontier:user-1:family-1', JSON.stringify({ oldestCoveredMs: 1_000 }));
    expect(await loadGalleryImportFrontier(USER_ID, FAMILY_ID)).toBeNull(); // missing fields

    await AsyncStorage.setItem('gallery-import-frontier:user-1:family-1', JSON.stringify({ oldestCoveredMs: 1_000, coveredThroughNewestMs: 5_000, completedLibrary: false, corpusMode: 'whatsapp' }));
    expect(await loadGalleryImportFrontier(USER_ID, FAMILY_ID)).toBeNull(); // corpusMode must be one of the closed values

    await AsyncStorage.setItem('gallery-import-frontier:user-1:family-1', JSON.stringify({ oldestCoveredMs: 1_000, coveredThroughNewestMs: 5_000, completedLibrary: false }));
    expect(await loadGalleryImportFrontier(USER_ID, FAMILY_ID)).toBeNull(); // missing corpusMode
  });

  it('defaults autoContinue to true for a frontier persisted before the field existed', async () => {
    await AsyncStorage.setItem(
      'gallery-import-frontier:user-1:family-1',
      JSON.stringify({ oldestCoveredMs: 1_000, coveredThroughNewestMs: 5_000, completedLibrary: false, corpusMode: 'camera_album' }),
    );
    expect(await loadGalleryImportFrontier(USER_ID, FAMILY_ID)).toEqual(frontier({ autoContinue: true }));
  });

  it('degrades to null when the read itself fails', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk on fire'));
    expect(await loadGalleryImportFrontier(USER_ID, FAMILY_ID)).toBeNull();
  });

  it('swallows a write failure (best effort)', async () => {
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk on fire'));
    await expect(saveGalleryImportFrontier(USER_ID, FAMILY_ID, frontier())).resolves.toBeUndefined();
  });

  it('swallows a clear failure (best effort)', async () => {
    jest.spyOn(AsyncStorage, 'removeItem').mockRejectedValueOnce(new Error('disk on fire'));
    await expect(clearGalleryImportFrontier(USER_ID, FAMILY_ID)).resolves.toBeUndefined();
  });
});

describe('mergeGalleryImportFrontierCoverage', () => {
  it('creates a fresh frontier from the first run\'s registered coverage, tagged with its corpus mode', () => {
    expect(mergeGalleryImportFrontierCoverage(null, { oldestCoveredMs: 1_000, newestCoveredMs: 5_000 }, false, 'camera_album'))
      .toEqual({ oldestCoveredMs: 1_000, coveredThroughNewestMs: 5_000, completedLibrary: false, corpusMode: 'camera_album', autoContinue: true });
  });

  it('extends coveredThroughNewestMs forward and oldestCoveredMs backward monotonically within the same corpus mode', () => {
    const existing = frontier({ oldestCoveredMs: 3_000, coveredThroughNewestMs: 5_000 });
    // Phase A found something newer, Phase B found something older.
    const next = mergeGalleryImportFrontierCoverage(existing, { oldestCoveredMs: 500, newestCoveredMs: 6_000 }, false, 'camera_album');
    expect(next).toEqual({ oldestCoveredMs: 500, coveredThroughNewestMs: 6_000, completedLibrary: false, corpusMode: 'camera_album', autoContinue: true });
  });

  it('tolerates overlap gracefully: coverage fully inside the existing range never shrinks the frontier', () => {
    const existing = frontier({ oldestCoveredMs: 1_000, coveredThroughNewestMs: 10_000 });
    // A re-registered/duplicated pass reporting a narrower range than what
    // is already covered (e.g. after an overlap the server suppresses).
    const next = mergeGalleryImportFrontierCoverage(existing, { oldestCoveredMs: 4_000, newestCoveredMs: 6_000 }, false, 'camera_album');
    expect(next).toEqual(existing);
  });

  it('sets completedLibrary when this pass reached the library end, and keeps it sticky afterward', () => {
    const withoutEnd = frontier({ completedLibrary: false });
    const reachedEnd = mergeGalleryImportFrontierCoverage(withoutEnd, { oldestCoveredMs: 0, newestCoveredMs: 5_000 }, true, 'camera_album');
    expect(reachedEnd?.completedLibrary).toBe(true);

    // A later run that does not itself reach the end must not clear it.
    const stillTrue = mergeGalleryImportFrontierCoverage(reachedEnd, { oldestCoveredMs: -100, newestCoveredMs: 5_500 }, false, 'camera_album');
    expect(stillTrue?.completedLibrary).toBe(true);
  });

  it('returns null when nothing was registered and no frontier exists yet', () => {
    expect(mergeGalleryImportFrontierCoverage(null, null, false, 'camera_album')).toBeNull();
    expect(mergeGalleryImportFrontierCoverage(null, null, true, 'full_library_fallback')).toBeNull();
  });

  it('when nothing was registered but a same-mode frontier exists, only completedLibrary can move -- bounds are untouched', () => {
    const existing = frontier({ completedLibrary: false });
    expect(mergeGalleryImportFrontierCoverage(existing, null, false, 'camera_album')).toEqual(existing);
    expect(mergeGalleryImportFrontierCoverage(existing, null, true, 'camera_album')).toEqual({ ...existing, completedLibrary: true });
  });

  describe('corpus-mode change resets rather than mixes', () => {
    it('discards an existing frontier built under a different corpus mode before merging new coverage', () => {
      // The Android camera album disappeared: last run was 'camera_album',
      // this run resolved 'full_library_fallback'.
      const existing = frontier({ oldestCoveredMs: 1_000, coveredThroughNewestMs: 10_000, completedLibrary: true, corpusMode: 'camera_album' });
      const next = mergeGalleryImportFrontierCoverage(existing, { oldestCoveredMs: 200, newestCoveredMs: 300 }, false, 'full_library_fallback');
      // A fresh frontier anchored ONLY on this run's coverage -- not merged
      // with (or bounded by) the stale camera_album range, and completedLibrary
      // resets rather than inheriting the old mode's sticky true.
      expect(next).toEqual({ oldestCoveredMs: 200, coveredThroughNewestMs: 300, completedLibrary: false, corpusMode: 'full_library_fallback', autoContinue: true });
    });

    it('a mode change with nothing registered this run leaves no frontier rather than reviving the stale one', () => {
      const existing = frontier({ corpusMode: 'camera_album' });
      expect(mergeGalleryImportFrontierCoverage(existing, null, false, 'full_library_fallback')).toBeNull();
      // Even a library-end signal this run cannot resurrect the other mode's frontier.
      expect(mergeGalleryImportFrontierCoverage(existing, null, true, 'full_library_fallback')).toBeNull();
    });

    it('the album reappearing (full_library_fallback -> camera_album) also resets, not merges', () => {
      const existing = frontier({ oldestCoveredMs: 1_000, coveredThroughNewestMs: 10_000, corpusMode: 'full_library_fallback' });
      const next = mergeGalleryImportFrontierCoverage(existing, { oldestCoveredMs: 5_000, newestCoveredMs: 6_000 }, false, 'camera_album');
      expect(next).toEqual({ oldestCoveredMs: 5_000, coveredThroughNewestMs: 6_000, completedLibrary: false, corpusMode: 'camera_album', autoContinue: true });
    });
  });

  describe('autoContinue', () => {
    it('defaults a brand-new frontier to autoContinue: true', () => {
      expect(mergeGalleryImportFrontierCoverage(null, { oldestCoveredMs: 1_000, newestCoveredMs: 5_000 }, false, 'camera_album')?.autoContinue).toBe(true);
    });

    it('carries an existing frontier\'s autoContinue: false forward across a same-mode merge', () => {
      const existing = frontier({ autoContinue: false });
      const next = mergeGalleryImportFrontierCoverage(existing, { oldestCoveredMs: 500, newestCoveredMs: 6_000 }, false, 'camera_album');
      expect(next?.autoContinue).toBe(false);
    });

    it('resets autoContinue to true when the corpus mode changes, same as the bounds', () => {
      const existing = frontier({ autoContinue: false, corpusMode: 'camera_album' });
      const next = mergeGalleryImportFrontierCoverage(existing, { oldestCoveredMs: 200, newestCoveredMs: 300 }, false, 'full_library_fallback');
      expect(next?.autoContinue).toBe(true);
    });
  });
});
