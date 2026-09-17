import { deriveGalleryImportProgressOutcome, type GalleryImportProgressStageInput } from '@/utils/gallery-import-progress-stage';

function baseInput(overrides: Partial<GalleryImportProgressStageInput> = {}): GalleryImportProgressStageInput {
  return {
    checkpointStatus: 'scanning',
    deckCursor: 0,
    serverStatus: null,
    readyCount: 0,
    hasWriteAccess: true,
    isDemoted: false,
    isOffline: false,
    live: null,
    isResuming: false,
    permissionMode: 'full',
    hasTransientError: false,
    ...overrides,
  };
}

describe('deriveGalleryImportProgressOutcome', () => {
  it('prioritizes a lapsed subscription over every other signal', () => {
    expect(deriveGalleryImportProgressOutcome(baseInput({ hasWriteAccess: false, serverStatus: 'reviewing', readyCount: 9 })))
      .toEqual({ kind: 'exception', exception: 'lapsed' });
  });

  it('never treats an unloaded billing status (null) as lapsed', () => {
    const outcome = deriveGalleryImportProgressOutcome(baseInput({ hasWriteAccess: null, serverStatus: 'processing' }));
    expect(outcome).not.toEqual({ kind: 'exception', exception: 'lapsed' });
  });

  it('reports demoted when still a member but role dropped', () => {
    expect(deriveGalleryImportProgressOutcome(baseInput({ isDemoted: true })))
      .toEqual({ kind: 'exception', exception: 'demoted' });
  });

  it('shows waitingWifi from a paused checkpoint regardless of server status', () => {
    expect(deriveGalleryImportProgressOutcome(baseInput({ checkpointStatus: 'paused', serverStatus: 'processing', readyCount: 3 })))
      .toEqual({ kind: 'stage', stage: 'waitingWifi', ready: 3, value: null, total: null, scannedAssetCount: null });
  });

  it('reports offline only once permission/role/wifi-wait signals are clear', () => {
    expect(deriveGalleryImportProgressOutcome(baseInput({ isOffline: true })))
      .toEqual({ kind: 'exception', exception: 'offline' });
  });

  // The runner's former separate 'preparing'/'uploading' stages are merged
  // into one monotonic 'sending' stage (see gallery-import-runner.ts): both
  // emission sites now publish the same shape, so this is the single branch
  // that renders it.
  it('renders live sending progress with real counts', () => {
    const outcome = deriveGalleryImportProgressOutcome(baseInput({
      live: { stage: 'sending', completed: 40, total: 120 },
    }));
    expect(outcome).toEqual({ kind: 'stage', stage: 'sending', ready: 0, value: 40, total: 120, scannedAssetCount: null });
  });

  it('maps live dispatching to the processing stage while the server has not confirmed anything past it', () => {
    expect(deriveGalleryImportProgressOutcome(baseInput({ live: { stage: 'dispatching', completed: 1, total: 2 }, readyCount: 4 })))
      .toEqual({ kind: 'stage', stage: 'processing', ready: 4, value: null, total: null, scannedAssetCount: null });
  });

  // Regression for the critical device-tested bug: a 306-photo run reached
  // server status 'reviewing' (10/10 chunks, 60 candidates staged) but the
  // progress screen stayed on "Writing the drafts" indefinitely. Root cause:
  // the runner's *last* published live-progress event for a completed run is
  // always `{ stage: 'dispatching' }` (see gallery-import-live-progress.ts --
  // it is a retained snapshot, never cleared), so `live` stays stuck on
  // 'dispatching' forever once dispatch finishes. The server status must win
  // once it has moved past 'processing', regardless of that stale snapshot.
  it('lets a server-confirmed reviewing status win over a stale live.dispatching snapshot', () => {
    expect(deriveGalleryImportProgressOutcome(baseInput({
      live: { stage: 'dispatching', completed: 10, total: 10 },
      serverStatus: 'reviewing',
      readyCount: 60,
      deckCursor: 0,
    }))).toEqual({ kind: 'stage', stage: 'ready', ready: 60, value: null, total: null, scannedAssetCount: null });
  });

  it('lets a server-confirmed completed/expired/cancelled/failed status win over a stale live.dispatching snapshot too', () => {
    const stale = { stage: 'dispatching' as const, completed: 10, total: 10 };
    expect((deriveGalleryImportProgressOutcome(baseInput({ live: stale, serverStatus: 'completed', readyCount: 5 })) as any).stage).toBe('ready');
    expect((deriveGalleryImportProgressOutcome(baseInput({ live: stale, serverStatus: 'expired' })) as any).stage).toBe('expired');
    expect((deriveGalleryImportProgressOutcome(baseInput({ live: stale, serverStatus: 'cancelled' })) as any).stage).toBe('cancelled');
    expect((deriveGalleryImportProgressOutcome(baseInput({ live: stale, serverStatus: 'failed', readyCount: 3 })) as any).stage).toBe('failed');
  });

  it('still prefers live scanning/sending detail while the server genuinely has not moved past processing', () => {
    expect((deriveGalleryImportProgressOutcome(baseInput({ live: { stage: 'sending', completed: 1, total: 5 }, serverStatus: 'processing' })) as any).stage).toBe('sending');
  });

  it('maps server expired/cancelled statuses onto their stages', () => {
    expect(deriveGalleryImportProgressOutcome(baseInput({ serverStatus: 'expired' })).kind === 'stage'
      && (deriveGalleryImportProgressOutcome(baseInput({ serverStatus: 'expired' })) as any).stage).toBe('expired');
    expect((deriveGalleryImportProgressOutcome(baseInput({ serverStatus: 'cancelled' })) as any).stage).toBe('cancelled');
  });

  it('shows the partial-failure stage when some suggestions are already ready', () => {
    expect(deriveGalleryImportProgressOutcome(baseInput({ serverStatus: 'failed', readyCount: 6 })))
      .toEqual({ kind: 'stage', stage: 'failed', ready: 6, value: null, total: null, scannedAssetCount: null });
  });

  it('falls back to errorFinal when a failed run has nothing ready', () => {
    expect(deriveGalleryImportProgressOutcome(baseInput({ serverStatus: 'failed', readyCount: 0 })))
      .toEqual({ kind: 'exception', exception: 'errorFinal' });
  });

  it('treats zero-ready reviewing with an untouched deck as "nothing stood out"', () => {
    expect(deriveGalleryImportProgressOutcome(baseInput({ serverStatus: 'reviewing', readyCount: 0, deckCursor: 0, permissionMode: 'full' })))
      .toEqual({ kind: 'empty', empty: 'nothing' });
  });

  it('maps zero-ready reviewing with a touched deck to processing, never a "0 moments ready" stage', () => {
    // Device-observed: everything staged so far reviewed while the run keeps
    // writing -- the ready stage rendered "FIRST MOMENTS ARE READY / 0
    // moments, ready for you." The honest stage is 'processing'; polling
    // flips it to 'ready' when the next candidate lands.
    expect(deriveGalleryImportProgressOutcome(baseInput({ serverStatus: 'reviewing', readyCount: 0, deckCursor: 11 })))
      .toEqual({ kind: 'stage', stage: 'processing', ready: 0, value: null, total: null, scannedAssetCount: null });
  });

  it('distinguishes the limited-permission empty outcome', () => {
    expect(deriveGalleryImportProgressOutcome(baseInput({ serverStatus: 'reviewing', readyCount: 0, deckCursor: 0, permissionMode: 'limited' })))
      .toEqual({ kind: 'empty', empty: 'limitedNothing' });
  });

  it('does not call zero-ready reviewing empty once the deck has been worked', () => {
    const outcome = deriveGalleryImportProgressOutcome(baseInput({ serverStatus: 'reviewing', readyCount: 0, deckCursor: 5 }));
    expect(outcome.kind).toBe('stage');
    // 'processing', not 'ready': the ready stage with a zero count rendered
    // "0 moments, ready for you." on device. The intent of this test (a
    // worked deck is never the "nothing stood out" empty state) still holds.
    expect((outcome as any).stage).toBe('processing');
  });

  it('shows the ready stage with a positive ready count while reviewing', () => {
    expect(deriveGalleryImportProgressOutcome(baseInput({ serverStatus: 'reviewing', readyCount: 18 })))
      .toEqual({ kind: 'stage', stage: 'ready', ready: 18, value: null, total: null, scannedAssetCount: null });
  });

  it('surfaces a transient error distinctly from a server-declared failure', () => {
    expect(deriveGalleryImportProgressOutcome(baseInput({ hasTransientError: true })))
      .toEqual({ kind: 'exception', exception: 'errorRecoverable' });
  });

  it('shows interrupted for a relaunch resume that already banked ready candidates', () => {
    expect(deriveGalleryImportProgressOutcome(baseInput({ isResuming: true, readyCount: 12, serverStatus: 'processing' })))
      .toEqual({ kind: 'stage', stage: 'interrupted', ready: 12, value: null, total: null, scannedAssetCount: null });
  });

  it('defaults to an indeterminate processing stage otherwise', () => {
    expect(deriveGalleryImportProgressOutcome(baseInput({ serverStatus: 'processing' })))
      .toEqual({ kind: 'stage', stage: 'processing', ready: 0, value: null, total: null, scannedAssetCount: null });
  });

  describe('continuous model additions (S8/S9)', () => {
    it('shows pausedFairUse when pausedUntil is in the future, ahead of offline/reviewing checks', () => {
      const future = new Date(Date.now() + 60_000).toISOString();
      expect(deriveGalleryImportProgressOutcome(baseInput({ pausedUntil: future, isOffline: true, serverStatus: 'reviewing', readyCount: 3 })))
        .toEqual({ kind: 'stage', stage: 'pausedFairUse', ready: 3, value: null, total: null, scannedAssetCount: null });
    });

    it('does not show pausedFairUse once pausedUntil is in the past', () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      const outcome = deriveGalleryImportProgressOutcome(baseInput({ pausedUntil: past, serverStatus: 'processing' }));
      expect(outcome).not.toEqual(expect.objectContaining({ stage: 'pausedFairUse' }));
    });

    it('never reports "nothing stood out" while local chunks are still planned/retryable', () => {
      expect(deriveGalleryImportProgressOutcome(baseInput({
        serverStatus: 'reviewing', readyCount: 0, deckCursor: 0, localPlannedClusters: 2,
      }))).toEqual({ kind: 'stage', stage: 'processing', ready: 0, value: null, total: null, scannedAssetCount: null });
    });

    it('surfaces a transient error over the empty outcome when reviewing with nothing ready or local left', () => {
      expect(deriveGalleryImportProgressOutcome(baseInput({
        serverStatus: 'reviewing', readyCount: 0, deckCursor: 0, hasTransientError: true,
      }))).toEqual({ kind: 'exception', exception: 'errorRecoverable' });
    });

    it('shows doneLookingMoreHistory instead of the empty outcome when the frontier says more history remains', () => {
      expect(deriveGalleryImportProgressOutcome(baseInput({
        serverStatus: 'reviewing', readyCount: 0, deckCursor: 0, moreHistory: true,
      }))).toEqual({ kind: 'stage', stage: 'doneLookingMoreHistory', ready: 0, value: null, total: null, scannedAssetCount: null });
    });

    it('still shows the plain empty outcome once settled with no local work, no error, and no more history', () => {
      expect(deriveGalleryImportProgressOutcome(baseInput({
        serverStatus: 'reviewing', readyCount: 0, deckCursor: 0, localPlannedClusters: 0, moreHistory: false,
      }))).toEqual({ kind: 'empty', empty: 'nothing' });
    });
  });
});
