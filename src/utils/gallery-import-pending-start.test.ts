import {
  applyGalleryImportPendingScanProgress,
  clearGalleryImportPendingStart,
  getGalleryImportPendingStart,
  setGalleryImportPendingStart,
  subscribeGalleryImportPendingStart,
  updateGalleryImportPendingStart,
} from '@/utils/gallery-import-pending-start';

describe('gallery import pending-start state', () => {
  afterEach(() => {
    clearGalleryImportPendingStart();
  });

  it('starts empty and notifies subscribers on every transition', () => {
    expect(getGalleryImportPendingStart()).toBeNull();
    const seen: unknown[] = [];
    const unsubscribe = subscribeGalleryImportPendingStart((state) => seen.push(state));

    setGalleryImportPendingStart({ status: 'starting' });
    setGalleryImportPendingStart({ status: 'started', runId: 'run-1' });
    unsubscribe();
    setGalleryImportPendingStart(null);

    expect(seen).toEqual([{ status: 'starting' }, { status: 'started', runId: 'run-1' }]);
    expect(getGalleryImportPendingStart()).toBeNull();
  });

  it('merges a patch without clobbering unrelated fields', () => {
    setGalleryImportPendingStart({ status: 'starting', scannedAssetCount: 0 });
    updateGalleryImportPendingStart({ scannedAssetCount: 42 });
    expect(getGalleryImportPendingStart()).toEqual({ status: 'starting', scannedAssetCount: 42 });
  });

  it('ignores a patch once cleared, so a stale in-flight callback cannot resurrect it', () => {
    setGalleryImportPendingStart({ status: 'starting' });
    clearGalleryImportPendingStart();
    updateGalleryImportPendingStart({ scannedAssetCount: 10 });
    expect(getGalleryImportPendingStart()).toBeNull();
  });

  it('only applies scanning-stage progress to the scanned count', () => {
    setGalleryImportPendingStart({ status: 'starting' });
    applyGalleryImportPendingScanProgress({ stage: 'preparing', completed: 3, total: 10 });
    expect(getGalleryImportPendingStart()?.scannedAssetCount).toBeUndefined();

    applyGalleryImportPendingScanProgress({ stage: 'scanning', completed: 12, total: 12, scannedAssetCount: 12 });
    expect(getGalleryImportPendingStart()?.scannedAssetCount).toBe(12);
  });

  it('falls back to completed when scanning progress omits scannedAssetCount', () => {
    setGalleryImportPendingStart({ status: 'starting' });
    applyGalleryImportPendingScanProgress({ stage: 'scanning', completed: 7, total: 7 });
    expect(getGalleryImportPendingStart()?.scannedAssetCount).toBe(7);
  });
});
