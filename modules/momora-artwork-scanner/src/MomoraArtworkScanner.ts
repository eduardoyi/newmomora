import { requireOptionalNativeModule } from 'expo-modules-core';

export interface ArtworkScanNativePage {
  /** `file://` URI of a JPEG written by the native scanner. */
  uri: string;
  /** Pixel dimensions of the written image. */
  width: number;
  height: number;
}

export interface ArtworkScanNativeResult {
  status: 'success' | 'cancel';
  pages: ArtworkScanNativePage[];
}

/** Rejection codes the native module uses (`error.code` on the JS side). */
export type ArtworkScanNativeErrorCode =
  | 'scanner_unavailable'
  | 'scanner_failed'
  | 'scanner_busy';

export interface MomoraArtworkScannerNativeModule {
  /**
   * iOS: `VNDocumentCameraViewController.isSupported`. Android: always true --
   * availability is only discoverable on scan (Play services / ML Kit module).
   */
  isAvailable: () => boolean;
  /**
   * Presents the platform document scanner. `pageLimit` is enforced by
   * Android's ML Kit only; iOS VisionKit has no limit, so callers truncate.
   */
  scan: (options: { pageLimit: number }) => Promise<ArtworkScanNativeResult>;
}

/**
 * Optional because Expo Go, web, and binaries built before the scanner do not
 * contain the local module. Never import a native module statically here --
 * OTA bundles reach old binaries, and a missing module must hide the feature
 * instead of crashing at import time.
 */
export const momoraArtworkScannerNativeModule =
  requireOptionalNativeModule<MomoraArtworkScannerNativeModule>('MomoraArtworkScanner');

export function getMomoraArtworkScannerNativeModule(): MomoraArtworkScannerNativeModule | null {
  return momoraArtworkScannerNativeModule;
}
