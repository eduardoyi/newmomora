// JS wrapper around the local `MomoraArtworkScanner` native module
// (modules/momora-artwork-scanner; docs/plans/artwork-scanning.md, 3.1).
//
// The module is reached ONLY through `requireOptionalNativeModule`: OTA
// bundles reach binaries built before the scanner existed, and a missing
// module must hide the feature, never crash at import time.
// `isArtworkScannerAvailable()` is the single gate for the scan button -- a
// JS-only kill switch is a one-line change here.
import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

import type { MediaAttachment } from '@/components/memory-media-picker';
import {
  getMomoraArtworkScannerNativeModule,
  type ArtworkScanNativePage,
} from '../../modules/momora-artwork-scanner';
import {
  claimArtworkScan,
  createArtworkScanId,
  deleteArtworkScanFile,
} from '@/utils/artwork-scan-custody';
import { getLocalFileSizeBytes } from '@/utils/local-files';
import { aspectRatioFromDimensions } from '@/utils/media-aspect';
import { validateMediaFileCheap } from '@/utils/media-validation';
import { MAX_MEMORY_MEDIA_ASSETS } from '@/utils/memories';

export type ArtworkScanErrorCode = 'scanner_unavailable' | 'scanner_failed' | 'scanner_busy';

export class ArtworkScanError extends Error {
  readonly code: ArtworkScanErrorCode;

  constructor(code: ArtworkScanErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'ArtworkScanError';
    this.code = code;
  }
}

export interface ScanArtworkResult {
  status: 'success' | 'cancel';
  /** Pages kept (claimed into app storage, validated). Empty on cancel. */
  attachments: MediaAttachment[];
  /** Pages the scanner returned beyond `remainingSlots` (iOS has no page limit). */
  droppedCount: number;
  /** Pages that failed validation and were discarded. */
  rejectedCount: number;
  /** First validation failure message, for inline display. */
  validationError: string | null;
}

export function isArtworkScannerAvailable(): boolean {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    return false;
  }

  const scanner = getMomoraArtworkScannerNativeModule();
  if (!scanner) {
    return false;
  }

  if (Platform.OS === 'ios') {
    try {
      return scanner.isAvailable() === true;
    } catch {
      return false;
    }
  }

  return true;
}

function toArtworkScanError(error: unknown): ArtworkScanError {
  if (error instanceof ArtworkScanError) {
    return error;
  }

  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'scanner_unavailable' || code === 'scanner_busy' || code === 'scanner_failed') {
    return new ArtworkScanError(code);
  }
  return new ArtworkScanError('scanner_failed');
}

/** Best-effort delete of a native-scanner output file (cache dir, not custody). */
async function discardNativePageFile(uri: string): Promise<void> {
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // Best-effort.
  }
}

/**
 * Presents the native scanner and returns validated attachments whose files
 * live in `documentDirectory/artwork-scans/`. Rejects with
 * {@link ArtworkScanError} (`scanner_unavailable | scanner_failed |
 * scanner_busy`). Never logs file paths or content.
 */
export async function scanArtwork({
  remainingSlots,
}: {
  remainingSlots: number;
}): Promise<ScanArtworkResult> {
  const cancelled: ScanArtworkResult = {
    status: 'cancel',
    attachments: [],
    droppedCount: 0,
    rejectedCount: 0,
    validationError: null,
  };

  const scanner = getMomoraArtworkScannerNativeModule();
  if (!scanner) {
    throw new ArtworkScanError('scanner_unavailable');
  }
  if (remainingSlots <= 0) {
    return cancelled;
  }

  const pageLimit = Math.min(Math.floor(remainingSlots), MAX_MEMORY_MEDIA_ASSETS);

  let nativeResult;
  try {
    nativeResult = await scanner.scan({ pageLimit });
  } catch (error) {
    throw toArtworkScanError(error);
  }

  const nativePages: ArtworkScanNativePage[] = nativeResult.pages ?? [];
  if (nativeResult.status !== 'success' || nativePages.length === 0) {
    await Promise.all(nativePages.map((page) => discardNativePageFile(page.uri)));
    return cancelled;
  }

  // iOS VisionKit has no page limit: keep the first `pageLimit` pages and
  // delete the rest.
  const keptPages = nativePages.slice(0, pageLimit);
  const droppedPages = nativePages.slice(pageLimit);
  await Promise.all(droppedPages.map((page) => discardNativePageFile(page.uri)));

  const attachments: MediaAttachment[] = [];
  let rejectedCount = 0;
  let validationError: string | null = null;
  const claimedUris: string[] = [];

  try {
    for (const page of keptPages) {
      const claimedUri = await claimArtworkScan(page.uri);
      claimedUris.push(claimedUri);

      const sizeBytes = await getLocalFileSizeBytes(claimedUri);
      const message = validateMediaFileCheap({ contentType: 'image/jpeg', sizeBytes });
      if (message || sizeBytes == null) {
        rejectedCount += 1;
        validationError ??= message ?? 'Could not read file size. Try scanning again.';
        await deleteArtworkScanFile(claimedUri);
        continue;
      }

      attachments.push({
        id: createArtworkScanId(),
        uri: claimedUri,
        contentType: 'image/jpeg',
        aspectRatio: aspectRatioFromDimensions(page.width, page.height) ?? undefined,
        sizeBytes,
        source: 'scan',
      });
    }
  } catch {
    // A page could not be moved into app storage. Don't leave a half batch
    // behind: remove claimed files and any not-yet-claimed native files.
    await Promise.all(claimedUris.map((uri) => deleteArtworkScanFile(uri)));
    await Promise.all(keptPages.map((page) => discardNativePageFile(page.uri)));
    throw new ArtworkScanError('scanner_failed');
  }

  return {
    status: 'success',
    attachments,
    droppedCount: droppedPages.length,
    rejectedCount,
    validationError,
  };
}
