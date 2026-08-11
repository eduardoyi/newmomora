// Kicks off (or retries) the gallery-import runner outside any screen's
// component lifecycle, so the in-flight scan/prepare/upload pass survives the
// entry screen navigating away the instant permission is granted (see
// gallery-import-entry.tsx and gallery-import-progress.tsx's pending-start
// rendering). A React component calling this can unmount immediately after;
// this function's own promise chain keeps running regardless, coordinating
// solely through gallery-import-pending-start.ts + gallery-import-live-progress.ts
// rather than through any component's state.
import { trackEvent } from '@/services/analytics';
import {
  GalleryImportWaitingForWifiError,
  startGalleryImportRunner,
} from '@/services/gallery-import-runner';
import { markGalleryImportRunnerActive, markGalleryImportRunnerInactive, publishGalleryImportLiveProgress } from '@/utils/gallery-import-live-progress';
import { applyGalleryImportPendingScanProgress, getGalleryImportPendingStart, setGalleryImportPendingStart } from '@/utils/gallery-import-pending-start';
import type { GalleryMediaLibraryAdapter } from '@/utils/gallery-import-scanner';

export interface BeginGalleryImportPipelineInput {
  userId: string;
  familyId: string;
  useCellular: boolean;
  adapter: GalleryMediaLibraryAdapter;
  /** Only used for the `gallery_import_run_started` analytics event, fired
   * once the run actually exists -- entry.tsx has already navigated away by
   * then, so this function (not the screen) owns that call. */
  permissionMode: 'full' | 'limited';
}

/** Fire-and-forget: starts (or restarts, e.g. the cellular-confirm retry)
 * the runner and threads its progress through the pending-start slot until a
 * run id exists, then through the run-id-keyed live-progress bus exactly as
 * before. Callers must not `await` this before navigating -- the whole point
 * is that the progress screen renders the 'starting'/'waitingWifi' pending
 * state while this keeps running in the background. */
export function beginGalleryImportPipeline(input: BeginGalleryImportPipelineInput): void {
  setGalleryImportPendingStart({ status: 'starting', permissionMode: input.permissionMode });
  void startGalleryImportRunner({
    userId: input.userId,
    familyId: input.familyId,
    useCellular: input.useCellular,
    adapter: input.adapter,
    onProgress: (progress) => {
      const pending = getGalleryImportPendingStart();
      if (pending?.runId) {
        publishGalleryImportLiveProgress(pending.runId, progress);
      } else {
        applyGalleryImportPendingScanProgress(progress);
      }
    },
    onRunStarted: (runId) => {
      markGalleryImportRunnerActive(runId);
      setGalleryImportPendingStart({ status: 'started', runId, permissionMode: input.permissionMode });
    },
  })
    .then((result) => {
      // Defensive only -- onRunStarted already set 'started' with this same
      // id before the function resolves (see startGalleryImportRunner).
      if (getGalleryImportPendingStart()?.status !== 'started') {
        setGalleryImportPendingStart({ status: 'started', runId: result.runId, permissionMode: input.permissionMode });
      }
      trackEvent('gallery_import_run_started', {
        permission_mode: input.permissionMode,
        scanned_asset_count: result.scannedAssetCount,
        cluster_count: result.clusterCount,
      });
    })
    .catch((caught) => {
      if (caught instanceof GalleryImportWaitingForWifiError) {
        setGalleryImportPendingStart({ status: 'waitingWifi', error: caught, permissionMode: input.permissionMode });
      } else {
        setGalleryImportPendingStart({ status: 'failed', error: caught, permissionMode: input.permissionMode });
      }
    })
    .finally(() => {
      const pending = getGalleryImportPendingStart();
      if (pending?.runId) markGalleryImportRunnerInactive(pending.runId);
    });
}
