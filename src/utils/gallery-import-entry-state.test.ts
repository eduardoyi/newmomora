import { deriveGalleryImportEntryStatus } from '@/utils/gallery-import-entry-state';
import type { GalleryImportRun } from '@/services/gallery-import';
import type { GalleryImportCheckpoint } from '@/utils/gallery-import-checkpoint';

const NOW = new Date('2026-08-10T12:00:00.000Z');

function makeCheckpoint(overrides: Partial<GalleryImportCheckpoint> = {}): GalleryImportCheckpoint {
  return {
    version: 1,
    userId: 'user-1',
    familyId: 'family-1',
    runId: 'run-1',
    runCapability: 'cap-1',
    algorithmVersion: 'v1',
    status: 'reviewing',
    assetByToken: {},
    uploadedAssetTokens: [],
    clusterSignatures: [],
    chunks: [],
    deckCursor: 0,
    approvalOutbox: [],
    updatedAt: NOW.toISOString(),
    ...overrides,
  } as GalleryImportCheckpoint;
}

function makeRun(overrides: Partial<GalleryImportRun> = {}): GalleryImportRun {
  return {
    id: 'run-1',
    familyId: 'family-1',
    status: 'reviewing',
    reviewExpiresAt: null,
    limits: { maxClusters: 20, maxAssetsPerCluster: 6, maxChunks: 4 },
    ...overrides,
  };
}

describe('deriveGalleryImportEntryStatus', () => {
  it('is none with no checkpoint at all', () => {
    expect(deriveGalleryImportEntryStatus(null, null, NOW)).toEqual({
      state: 'none',
      attentionReason: null,
      reviewDaysLeft: null,
      readyCount: 0,
    });
  });

  it('is attention/waiting_for_wifi when the local runner paused itself, even before consulting the server', () => {
    const checkpoint = makeCheckpoint({ status: 'paused' });
    const run = makeRun({ status: 'processing' });
    expect(deriveGalleryImportEntryStatus(checkpoint, run, NOW)).toEqual({
      state: 'attention',
      attentionReason: 'waiting_for_wifi',
      reviewDaysLeft: null,
      readyCount: 0,
    });
  });

  it('is none when a checkpoint exists locally but the server has no run for it', () => {
    const checkpoint = makeCheckpoint({ status: 'scanning' });
    expect(deriveGalleryImportEntryStatus(checkpoint, null, NOW)).toEqual({
      state: 'none',
      attentionReason: null,
      reviewDaysLeft: null,
      readyCount: 0,
    });
  });

  it('is attention/run_failed when the server marks the run failed', () => {
    const checkpoint = makeCheckpoint({ status: 'scanning' });
    const run = makeRun({ status: 'failed' });
    expect(deriveGalleryImportEntryStatus(checkpoint, run, NOW)).toEqual({
      state: 'attention',
      attentionReason: 'run_failed',
      reviewDaysLeft: null,
      readyCount: 0,
    });
  });

  it.each(['scanning', 'processing'] as const)('is processing while the server run is %s', (status) => {
    const checkpoint = makeCheckpoint({ status: 'scanning' });
    const run = makeRun({ status });
    expect(deriveGalleryImportEntryStatus(checkpoint, run, NOW).state).toBe('processing');
  });

  it('is ready when reviewing has started but this device has not opened the deck yet', () => {
    const checkpoint = makeCheckpoint({ status: 'reviewing', deckCursor: 0 });
    const run = makeRun({ status: 'reviewing', readyCandidates: 5, reviewExpiresAt: '2026-09-01T00:00:00.000Z' });
    expect(deriveGalleryImportEntryStatus(checkpoint, run, NOW)).toEqual({
      state: 'ready',
      attentionReason: null,
      reviewDaysLeft: 22,
      readyCount: 5,
    });
  });

  it('is resume once this device has moved past the first card', () => {
    const checkpoint = makeCheckpoint({ status: 'reviewing', deckCursor: 3 });
    const run = makeRun({ status: 'reviewing', readyCandidates: 4, reviewExpiresAt: '2026-09-01T00:00:00.000Z' });
    expect(deriveGalleryImportEntryStatus(checkpoint, run, NOW).state).toBe('resume');
  });

  // Round 4, device-tested finding: a run can be 'reviewing' with 0 ready
  // candidates (this device already worked through everything staged so
  // far, and the server is still generating more) -- `resume`/`ready` must
  // not fire on readyCandidates 0, or the drawer shows a nonsense "0
  // suggestions left to look at" card. This reads the same as
  // scanning/processing instead: Momora is still working, check back.
  it('is processing (not resume/ready) when reviewing but nothing is ready yet, even with deck progress already made', () => {
    const reviewingSoon = makeRun({ status: 'reviewing', readyCandidates: 0, reviewExpiresAt: '2026-09-01T00:00:00.000Z' });
    expect(deriveGalleryImportEntryStatus(makeCheckpoint({ status: 'reviewing', deckCursor: 0 }), reviewingSoon, NOW))
      .toEqual({ state: 'processing', attentionReason: null, reviewDaysLeft: null, readyCount: 0 });
    expect(deriveGalleryImportEntryStatus(makeCheckpoint({ status: 'reviewing', deckCursor: 3 }), reviewingSoon, NOW).state)
      .toBe('processing');
  });

  it('is expiring when reviewExpiresAt is within the threshold, overriding resume progress', () => {
    const checkpoint = makeCheckpoint({ status: 'reviewing', deckCursor: 5 });
    const run = makeRun({ status: 'reviewing', readyCandidates: 2, reviewExpiresAt: '2026-08-13T12:00:00.000Z' }); // 3 days out
    expect(deriveGalleryImportEntryStatus(checkpoint, run, NOW)).toEqual({
      state: 'expiring',
      attentionReason: null,
      reviewDaysLeft: 3,
      readyCount: 2,
    });
  });

  it('treats a missing reviewExpiresAt as not expiring', () => {
    const checkpoint = makeCheckpoint({ status: 'reviewing', deckCursor: 0 });
    const run = makeRun({ status: 'reviewing', readyCandidates: 1, reviewExpiresAt: null });
    expect(deriveGalleryImportEntryStatus(checkpoint, run, NOW).state).toBe('ready');
  });

  it.each(['completed', 'cancelled', 'expired'] as const)('is none once the run is terminal (%s)', (status) => {
    const checkpoint = makeCheckpoint({ status: 'reviewing' });
    const run = makeRun({ status });
    expect(deriveGalleryImportEntryStatus(checkpoint, run, NOW).state).toBe('none');
  });
});
