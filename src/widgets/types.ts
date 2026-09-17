/** Shared app/native wire types for the home-screen widget. */

export const WIDGET_MANIFEST_SCHEMA_VERSION = 1 as const;
/**
 * A daytime manifest can carry the current card plus the next daylight
 * boundaries in the seven-day lease.  Native binaries that predate this
 * contract advertise (or default to) the legacy seven-entry capacity.
 */
export const WIDGET_MAX_ENTRIES = 24;
export const WIDGET_LEGACY_MAX_ENTRIES = 7;
/** Native storage is intentionally bounded independently of timeline slots. */
export const WIDGET_MAX_CACHED_IMAGES = 7;
export const WIDGET_MAX_RETAINED_MEMORY_IDS = 7;
export const WIDGET_LEASE_MS = 168 * 60 * 60 * 1000;
export const WIDGET_MAX_IMAGE_EDGE = 512;
export const WIDGET_MAX_IMAGE_BYTES = 1024 * 1024;
export const WIDGET_MAX_CACHE_BYTES = 10 * 1024 * 1024;
/**
 * A signed image may be much larger than the final widget preview.  This
 * bound stops a single malicious or accidentally huge response before the
 * image decoder sees it.
 */
export const WIDGET_MAX_SOURCE_DOWNLOAD_BYTES = 8 * 1024 * 1024;

export type WidgetManifestEntryKind =
  | 'illustration'
  | 'photo'
  | 'video'
  | 'audio'
  | 'text'
  | 'neutral';

export interface WidgetManifestColors {
  background: string;
  foreground: string;
  accent?: string;
}

export interface WidgetManifestEntry {
  startsAt: string;
  memoryId: string;
  sourceUpdatedAt: string;
  memoryDate: string;
  dateLabel: string;
  mediaIndex?: number;
  imageFilename?: string;
  excerpt: string;
  colors: WidgetManifestColors;
  kind: WidgetManifestEntryKind;
}

export interface WidgetManifest {
  schemaVersion: typeof WIDGET_MANIFEST_SCHEMA_VERSION;
  accountId: string;
  familyId: string;
  generationId: string;
  verifiedAt: string;
  expiresAt: string;
  timezone: string;
  entries: WidgetManifestEntry[];
}

export interface WidgetCacheScope {
  accountId: string;
  familyId: string;
}

export interface WidgetNativeCapabilities {
  supported: boolean;
  enabled: boolean;
  platform?: 'ios' | 'android' | 'web' | 'unknown';
  sharedDirectory?: string;
  supportsSystemSmall?: boolean;
  supportsAndroidTall?: boolean;
  /** Maximum manifest entries understood by this installed native binary. */
  maxTimelineEntries?: number;
}

/**
 * Native must install the staged files before swapping its manifest.  The
 * scope and generation are compare-and-set fences; missing native support is
 * expected on web, Expo Go, and older binaries.
 */
export interface WidgetNativeAdapter {
  available: () => boolean | Promise<boolean>;
  /**
   * Returns the installed native binary's manifest capacity. Missing or
   * malformed capability data is treated as the legacy seven-entry limit.
   */
  maxTimelineEntries?: () => number | Promise<number>;
  readManifest: () => WidgetManifest | null | Promise<WidgetManifest | null>;
  publishManifest: (
    manifest: WidgetManifest,
    files: Record<string, string>,
  ) => void | Promise<void>;
  clearManifest: (
    scope?: WidgetCacheScope,
    generationId?: string,
  ) => void | Promise<void>;
  reload: () => void | Promise<void>;
}
