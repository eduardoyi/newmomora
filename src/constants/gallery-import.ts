/**
 * Frozen local-scanner defaults. Phase 0 may replace these values only together
 * with a new algorithm version and benchmark record; the server remains the
 * authority for admission and hard per-run limits.
 */
export const GALLERY_IMPORT_ALGORITHM_VERSION = 'gallery-v1';
export const GALLERY_IMPORT_CLUSTER_GAP_MS = 3 * 60 * 60 * 1000;
export const GALLERY_IMPORT_SCAN_PAGE_SIZE = 100;
// Foreground enumeration is deliberately bounded. We scan newest-first and
// expose a truncated corpus rather than materializing an unbounded camera roll
// in JS while the server's candidate caps only need a finite recent window.
export const GALLERY_IMPORT_MAX_ENUMERATED_ASSETS = 2_000;
export const GALLERY_IMPORT_MAX_ASSETS_PER_CLUSTER = 10;
export const GALLERY_IMPORT_MAX_CLUSTERS_PER_RUN = 60;
export const GALLERY_IMPORT_CHECKPOINT_VERSION = 2;
export const GALLERY_IMPORT_CHECKPOINT_MAX_BYTES = 900_000;
export const GALLERY_IMPORT_MIN_CAPTURE_TIME_MS = Date.UTC(2000, 0, 1);
