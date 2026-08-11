import { GALLERY_IMPORT_CLUSTER_GAP_MS } from '@/constants/gallery-import';
import type { GalleryImportRun } from '@/services/gallery-import';
import {
  GALLERY_DECK_COMMIT_THRESHOLD_PX,
  GALLERY_DECK_INTENT_THRESHOLD_PX,
  GALLERY_DECK_MAX_ROTATION_DEG,
  buildGalleryImportDayPool,
  deriveGalleryImportComingIndicator,
  galleryDeckIntentOpacity,
  galleryDeckRotationDeg,
  galleryDeckSwipeCommit,
  isGalleryDeckRestPointDue,
  isGalleryImportRunTerminal,
} from '@/utils/gallery-import-deck';

describe('gallery deck swipe math', () => {
  it('rotates dx / 28 and caps at ±8 degrees', () => {
    expect(galleryDeckRotationDeg(0)).toBe(0);
    expect(galleryDeckRotationDeg(28)).toBe(1);
    expect(galleryDeckRotationDeg(-56)).toBe(-2);
    expect(galleryDeckRotationDeg(1000)).toBe(GALLERY_DECK_MAX_ROTATION_DEG);
    expect(galleryDeckRotationDeg(-1000)).toBe(-GALLERY_DECK_MAX_ROTATION_DEG);
  });

  it('keeps intent stamps hidden until 26px, then ramps opacity with distance', () => {
    expect(galleryDeckIntentOpacity(GALLERY_DECK_INTENT_THRESHOLD_PX, 'keep')).toBe(0);
    expect(galleryDeckIntentOpacity(20, 'keep')).toBe(0);
    expect(galleryDeckIntentOpacity(55, 'keep')).toBeCloseTo(0.5);
    expect(galleryDeckIntentOpacity(400, 'keep')).toBe(1);
    // The aside stamp answers leftward travel only.
    expect(galleryDeckIntentOpacity(55, 'aside')).toBe(0);
    expect(galleryDeckIntentOpacity(-55, 'aside')).toBeCloseTo(0.5);
    expect(galleryDeckIntentOpacity(-400, 'aside')).toBe(1);
  });

  it('commits at 92px of travel in either direction', () => {
    expect(galleryDeckSwipeCommit(GALLERY_DECK_COMMIT_THRESHOLD_PX)).toBeNull();
    expect(galleryDeckSwipeCommit(GALLERY_DECK_COMMIT_THRESHOLD_PX + 1)).toBe('keep');
    expect(galleryDeckSwipeCommit(-(GALLERY_DECK_COMMIT_THRESHOLD_PX + 1))).toBe('aside');
    expect(galleryDeckSwipeCommit(40)).toBeNull();
    expect(galleryDeckSwipeCommit(-40)).toBeNull();
  });

  it('commits a fling over 0.6 px/ms only when it agrees with the drag direction', () => {
    expect(galleryDeckSwipeCommit(40, 0.7)).toBe('keep');
    expect(galleryDeckSwipeCommit(-40, -0.7)).toBe('aside');
    expect(galleryDeckSwipeCommit(40, -0.7)).toBeNull();
    expect(galleryDeckSwipeCommit(40, 0.5)).toBeNull();
    expect(galleryDeckSwipeCommit(0, 0.9)).toBeNull();
  });
});

describe('gallery deck rest point cadence', () => {
  it('is due after every sixth keep until acknowledged for that milestone', () => {
    expect(isGalleryDeckRestPointDue(0, null)).toBe(false);
    expect(isGalleryDeckRestPointDue(5, null)).toBe(false);
    expect(isGalleryDeckRestPointDue(6, null)).toBe(true);
    expect(isGalleryDeckRestPointDue(6, 6)).toBe(false);
    expect(isGalleryDeckRestPointDue(7, 6)).toBe(false);
    expect(isGalleryDeckRestPointDue(12, 6)).toBe(true);
    expect(isGalleryDeckRestPointDue(12, 12)).toBe(false);
  });
});

describe('buildGalleryImportDayPool', () => {
  const hour = 60 * 60 * 1000;
  const base = Date.UTC(2024, 0, 14, 9, 0, 0);
  function asset(token: string, osAssetId: string, captureAtMs: number) {
    return { assetToken: token, osAssetId, captureAtMs, width: 100, height: 100, isFavorite: false };
  }
  const checkpoint = {
    assetByToken: {
      // The candidate's cluster: four photos within the scanner's gap.
      'token-a': asset('token-a', 'os-a', base),
      'token-b': asset('token-b', 'os-b', base + hour),
      'token-c': asset('token-c', 'os-c', base + 2 * hour),
      'token-d': asset('token-d', 'os-d', base + 2.5 * hour),
      // A different day, beyond the cluster gap: never offered.
      'token-e': asset('token-e', 'os-e', base + GALLERY_IMPORT_CLUSTER_GAP_MS + 4 * hour),
    },
    uploadedAssetTokens: ['token-a', 'token-b', 'token-c', 'token-e'],
  };

  it('returns the candidate cluster, admitted assets only, in capture order', () => {
    const pool = buildGalleryImportDayPool(checkpoint, ['token-b']);
    // token-d was never admitted (no preview upload, not selected) and
    // token-e sits outside the cluster gap; both are excluded.
    expect(pool.map((item) => item.assetToken)).toEqual(['token-a', 'token-b', 'token-c']);
    expect(pool[0].captureAtMs).toBeLessThan(pool[1].captureAtMs);
  });

  it('keeps a selected asset in the pool even without a preview upload', () => {
    const pool = buildGalleryImportDayPool(checkpoint, ['token-d']);
    expect(pool.map((item) => item.assetToken)).toEqual(['token-a', 'token-b', 'token-c', 'token-d']);
  });

  it('returns nothing for an empty selection', () => {
    expect(buildGalleryImportDayPool(checkpoint, [])).toEqual([]);
  });
});

describe('isGalleryImportRunTerminal', () => {
  it.each(['completed', 'cancelled', 'expired', 'failed'] as const)('treats %s as terminal', (status) => {
    expect(isGalleryImportRunTerminal(status)).toBe(true);
  });

  it.each(['scanning', 'processing', 'reviewing'] as const)('treats %s as not terminal', (status) => {
    expect(isGalleryImportRunTerminal(status)).toBe(false);
  });

  it('treats a missing status as not terminal', () => {
    expect(isGalleryImportRunTerminal(null)).toBe(false);
    expect(isGalleryImportRunTerminal(undefined)).toBe(false);
  });
});

describe('deriveGalleryImportComingIndicator', () => {
  function run(overrides: Partial<GalleryImportRun> = {}): GalleryImportRun {
    return {
      id: 'run-1', familyId: 'family-1', status: 'reviewing', reviewExpiresAt: null,
      limits: { maxClusters: 20, maxAssetsPerCluster: 6, maxChunks: 4 },
      ...overrides,
    };
  }

  it('is unknown before a run has loaded at all -- never guesses "none" too early', () => {
    expect(deriveGalleryImportComingIndicator(null)).toEqual({ kind: 'unknown' });
    expect(deriveGalleryImportComingIndicator(undefined)).toEqual({ kind: 'unknown' });
  });

  it.each(['completed', 'cancelled', 'expired', 'failed'] as const)('is none once the run is terminal (%s), regardless of a stale pendingClusters value', (status) => {
    expect(deriveGalleryImportComingIndicator(run({ status, pendingClusters: 9 }))).toEqual({ kind: 'none' });
  });

  it.each(['scanning', 'processing'] as const)('is unknown while %s -- more is coming by definition, before any count is meaningful', (status) => {
    expect(deriveGalleryImportComingIndicator(run({ status, pendingClusters: 0 }))).toEqual({ kind: 'unknown' });
  });

  it('is a real count while reviewing with a positive server-computed pendingClusters', () => {
    expect(deriveGalleryImportComingIndicator(run({ status: 'reviewing', pendingClusters: 7 })))
      .toEqual({ kind: 'count', count: 7 });
  });

  // Round 4, device-tested finding: a real production run planned ~16
  // chunks/61 clusters locally while the server had only 4 chunks
  // completed -- the client's local count showed a phantom "+51 coming"
  // that never resolved. pendingClusters is server truth instead.
  it('is none (not a stale local number) once reviewing with a server-confirmed zero pending', () => {
    expect(deriveGalleryImportComingIndicator(run({ status: 'reviewing', pendingClusters: 0 })))
      .toEqual({ kind: 'none' });
  });

  it('is unknown while reviewing when the server could not compute pendingClusters (null/absent)', () => {
    expect(deriveGalleryImportComingIndicator(run({ status: 'reviewing', pendingClusters: null })))
      .toEqual({ kind: 'unknown' });
    expect(deriveGalleryImportComingIndicator(run({ status: 'reviewing', pendingClusters: undefined })))
      .toEqual({ kind: 'unknown' });
  });
});
