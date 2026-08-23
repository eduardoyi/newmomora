/**
 * Frozen local-scanner defaults. Phase 0 may replace these values only together
 * with a new algorithm version and benchmark record; the server remains the
 * authority for admission and hard per-run limits.
 */
export const GALLERY_IMPORT_ALGORITHM_VERSION = 'gallery-v1';
export const GALLERY_IMPORT_CLUSTER_GAP_MS = 3 * 60 * 60 * 1000;
export const GALLERY_IMPORT_SCAN_PAGE_SIZE = 100;
// Foreground enumeration is deliberately bounded. We scan newest-first (or,
// with a progressive-deepening frontier -- see gallery-import-frontier.ts --
// newest-first within two disjoint windows) and expose a truncated corpus
// rather than materializing an unbounded camera roll in JS while the
// server's candidate caps only need a finite window per run.
//
// Bumped 2,000 -> 4,000 (2026-08-11) for the enumeration-ceiling/progressive-
// deepening change. This intentionally does NOT bump
// GALLERY_IMPORT_ALGORITHM_VERSION: createClusterSignature hashes the
// algorithm version plus one event's raw (osAssetId, captureAtMs) pairs
// (gallery-import-scanner.ts), and clusterGalleryAssets's 3-hour gap rule is
// unchanged. Neither depends on how many assets a given scan pass walks
// before hitting this ceiling -- a specific already-decided cluster hashes
// identically before and after this bump. The ceiling only changes how much
// of the corpus one pass can reach, which is exactly what progressive
// deepening (a persistent frontier across runs) is for; it is not a change
// to the clustering algorithm itself, so existing skip/approve receipts
// keyed by cluster_signature remain valid and correctly suppress re-staging
// after this change ships.
//
// iOS cost: the per-asset screenshot-subtype lookup in
// createExpoGalleryMediaLibraryAdapter's getPhotoPage (one native
// Asset.getMediaSubtypes() call per photo, run in parallel per page with
// per-asset failure isolation) now runs up to 4,000 times per scan instead
// of 2,000. That is still bounded and failure-isolated exactly as before;
// nothing here changes to batch or skip it. It has not been benchmarked on
// a real device at this ceiling -- expect scan wall-clock time to roughly
// double versus the 2,000 baseline (each page's per-asset native calls run
// in parallel via Promise.all, so the increase should track additional
// *pages*, not a linear per-asset serial cost, but this is an estimate, not
// a measurement; a real-device timing pass belongs in a Phase 0 benchmark
// before wide rollout).
export const GALLERY_IMPORT_MAX_ENUMERATED_ASSETS = 4_000;
export const GALLERY_IMPORT_MAX_ASSETS_PER_CLUSTER = 10;
/**
 * Continuous model (2026-08-23): one scan pass now produces at most one
 * "window" of clusters (see docs/plans/gallery-import-continuous.md's
 * Internal model) instead of one whole run's worth. `GALLERY_IMPORT_WINDOW_CLUSTERS`
 * is the new name for that per-pass cap; `GALLERY_IMPORT_MAX_CLUSTERS_PER_RUN`
 * is kept as an alias only so any code/tests that still reference the old
 * name keep compiling -- new code should use the window name.
 */
export const GALLERY_IMPORT_WINDOW_CLUSTERS = 60;
/** @deprecated Alias for {@link GALLERY_IMPORT_WINDOW_CLUSTERS}. A run is no
 * longer capped at a fixed cluster count -- it keeps sweeping window by
 * window until the library is covered (or the user stops it). */
export const GALLERY_IMPORT_MAX_CLUSTERS_PER_RUN = GALLERY_IMPORT_WINDOW_CLUSTERS;
/** Clusters per checkpoint chunk (chunk ordinals continue across windows). */
export const GALLERY_IMPORT_CLUSTERS_PER_CHUNK = 4;
/** A new window is only planned once server pending + local planned/failed
 * clusters drops below this backlog target (see maybeExtendGalleryImportPlan
 * in gallery-import-runner.ts). */
export const GALLERY_IMPORT_TARGET_BACKLOG = 120;
/** How often the app-root driver (gallery-import-driver.ts) re-kicks the
 * runner while a run has unsettled work, in addition to AppState/NetInfo
 * event-driven kicks. */
export const GALLERY_IMPORT_DRIVER_TICK_MS = 60_000;
/** Hard ceiling on one Edge Function round-trip (gallery-import.ts's
 * invokeGalleryImport). A hung request must fail the pass, never hang it
 * indefinitely -- the driver retries on its own backoff schedule. */
export const GALLERY_IMPORT_EDGE_TIMEOUT_MS = 45_000;
/** A checkpoint chunk that fails this many register/upload/dispatch attempts
 * in a row is marked 'abandoned' (terminal, locally) rather than retried
 * forever -- see gallery-import-runner.ts's processGalleryImportChunks. */
export const GALLERY_IMPORT_CHUNK_MAX_ATTEMPTS = 3;
export const GALLERY_IMPORT_CHECKPOINT_VERSION = 2;
// Raised 900,000 -> 1,500,000 (2026-08-23) for the continuous model: a
// long-lived run's checkpoint now accumulates many more windows/chunks over
// its lifetime than a single-pass run ever did. pruneGalleryImportCheckpoint
// (gallery-import-checkpoint.ts) keeps growth bounded regardless.
export const GALLERY_IMPORT_CHECKPOINT_MAX_BYTES = 1_500_000;
export const GALLERY_IMPORT_MIN_CAPTURE_TIME_MS = Date.UTC(2000, 0, 1);
