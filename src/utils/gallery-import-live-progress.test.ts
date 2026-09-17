import {
  clearGalleryImportLiveProgress,
  getLatestGalleryImportLiveProgress,
  isGalleryImportRunnerActive,
  markGalleryImportRunnerActive,
  markGalleryImportRunnerInactive,
  publishGalleryImportLiveProgress,
  subscribeGalleryImportLiveProgress,
} from '@/utils/gallery-import-live-progress';

describe('gallery import live progress bus', () => {
  afterEach(() => {
    clearGalleryImportLiveProgress('run-1');
    markGalleryImportRunnerInactive('run-1');
  });

  it('notifies subscribers and retains the latest snapshot for late mounts', () => {
    const seen: unknown[] = [];
    const unsubscribe = subscribeGalleryImportLiveProgress('run-1', (progress) => seen.push(progress));
    publishGalleryImportLiveProgress('run-1', { stage: 'sending', completed: 1, total: 10 });
    expect(seen).toEqual([{ stage: 'sending', completed: 1, total: 10 }]);
    expect(getLatestGalleryImportLiveProgress('run-1')).toEqual({ stage: 'sending', completed: 1, total: 10 });

    // A screen mounting after the fact reads the retained snapshot without
    // needing to have been subscribed when it was published.
    expect(getLatestGalleryImportLiveProgress('run-1')).not.toBeNull();
    unsubscribe();
    publishGalleryImportLiveProgress('run-1', { stage: 'sending', completed: 2, total: 10 });
    expect(seen).toHaveLength(1);
  });

  it('never cross-talks between runs', () => {
    publishGalleryImportLiveProgress('run-1', { stage: 'scanning', completed: 3, total: 3 });
    expect(getLatestGalleryImportLiveProgress('run-2')).toBeNull();
    clearGalleryImportLiveProgress('run-2');
  });

  it('tracks whether a runner call is already in flight for a run', () => {
    expect(isGalleryImportRunnerActive('run-1')).toBe(false);
    markGalleryImportRunnerActive('run-1');
    expect(isGalleryImportRunnerActive('run-1')).toBe(true);
    markGalleryImportRunnerInactive('run-1');
    expect(isGalleryImportRunnerActive('run-1')).toBe(false);
  });

  it('clears retained progress without touching the active-run flag', () => {
    publishGalleryImportLiveProgress('run-1', { stage: 'scanning', completed: 1, total: 1 });
    markGalleryImportRunnerActive('run-1');
    clearGalleryImportLiveProgress('run-1');
    expect(getLatestGalleryImportLiveProgress('run-1')).toBeNull();
    expect(isGalleryImportRunnerActive('run-1')).toBe(true);
  });
});
