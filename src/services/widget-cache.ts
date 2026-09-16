import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import { Image as NativeImage } from 'react-native';

import {
  WIDGET_MAX_CACHE_BYTES,
  WIDGET_MAX_ENTRIES,
  WIDGET_MAX_IMAGE_BYTES,
  WIDGET_MAX_IMAGE_EDGE,
  WIDGET_MAX_SOURCE_DOWNLOAD_BYTES,
  WIDGET_MANIFEST_SCHEMA_VERSION,
  WIDGET_LEASE_MS,
  type WidgetCacheScope,
  type WidgetManifest,
  type WidgetNativeAdapter,
} from '@/widgets/types';
import { parseWidgetManifest } from '@/widgets/manifest';

export {
  WIDGET_MAX_CACHE_BYTES,
  WIDGET_MAX_IMAGE_BYTES,
  WIDGET_MAX_IMAGE_EDGE,
  WIDGET_MAX_SOURCE_DOWNLOAD_BYTES,
  WIDGET_MANIFEST_SCHEMA_VERSION,
  WIDGET_LEASE_MS,
  type WidgetCacheScope,
  type WidgetManifest,
  type WidgetManifestColors,
  type WidgetManifestEntry,
  type WidgetManifestEntryKind,
  type WidgetNativeAdapter,
} from '@/widgets/types';

/**
 * The widget is a small, private read-only cache.  Its manifest is deliberately
 * independent from React Query: the native extension must be able to render it
 * after the app process has been killed and without a Supabase session.
 */

export { WIDGET_MAX_ENTRIES } from '@/widgets/types';
export const WIDGET_MAX_TOTAL_BYTES = WIDGET_MAX_CACHE_BYTES;

export type { WidgetNativeCapabilities } from '@/widgets/types';

export interface WidgetCacheStorage {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
}

export const widgetCacheStorage: WidgetCacheStorage = {
  getItem: (key) => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
  removeItem: (key) => AsyncStorage.removeItem(key),
};

// Kept for backwards-compatible cleanup of installations that used the old
// opt-in screen. Widget publication is now automatic for the authenticated
// active family, so these values are no longer read by the sync coordinator.
const WIDGET_PREFERENCE_KEY_PREFIX = 'momora.widget.preference';

interface WidgetPreferenceStorage {
  version: 1;
  enabled: boolean;
}

function scopePart(value: string): string {
  // UUIDs are the normal input.  Encoding also keeps this key safe if a
  // future test/runtime uses a different opaque identifier.
  return encodeURIComponent(value);
}

export function widgetPreferenceStorageKey(scope: WidgetCacheScope): string {
  return `${WIDGET_PREFERENCE_KEY_PREFIX}.${scopePart(scope.accountId)}.${scopePart(scope.familyId)}`;
}

export async function readWidgetPreference(
  scope: WidgetCacheScope,
  storage: WidgetCacheStorage = widgetCacheStorage,
): Promise<boolean> {
  try {
    const raw = await storage.getItem(widgetPreferenceStorageKey(scope));
    if (!raw) return false;

    const parsed = JSON.parse(raw) as Partial<WidgetPreferenceStorage>;
    return parsed.version === 1 && parsed.enabled === true;
  } catch {
    // A corrupt legacy preference is still reported as false to callers that
    // retain the old helper. The widget coordinator ignores this key.
    return false;
  }
}

export async function writeWidgetPreference(
  scope: WidgetCacheScope,
  enabled: boolean,
  storage: WidgetCacheStorage = widgetCacheStorage,
): Promise<void> {
  const payload: WidgetPreferenceStorage = { version: 1, enabled };
  await storage.setItem(widgetPreferenceStorageKey(scope), JSON.stringify(payload));
}

export async function clearWidgetPreference(
  scope: WidgetCacheScope,
  storage: WidgetCacheStorage = widgetCacheStorage,
): Promise<void> {
  await storage.removeItem(widgetPreferenceStorageKey(scope));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function isSafeLocalFilename(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 180
    && !value.includes('/')
    && !value.includes('\\')
    && value !== '.'
    && value !== '..'
    && !value.includes('..');
}

export interface WidgetManifestValidation {
  valid: boolean;
  reason?: string;
}

/**
 * Validates the persisted/native-facing shape before any publication.  This
 * rejects old schemas and malformed dates instead of letting a native runtime
 * interpret them as a stale, private card.
 */
export function validateWidgetManifest(
  manifest: unknown,
  now = Date.now(),
): WidgetManifestValidation {
  if (!isObject(manifest)) return { valid: false, reason: 'manifest_not_object' };
  if (manifest.schemaVersion !== WIDGET_MANIFEST_SCHEMA_VERSION) {
    return { valid: false, reason: 'schema_mismatch' };
  }
  let parsed: WidgetManifest;
  try {
    // The native parser is the one schema authority. Keeping the app-side
    // freshness check separate means native and JS cannot silently disagree
    // about ordering, field limits, or timestamp syntax.
    parsed = parseWidgetManifest(manifest);
  } catch {
    return { valid: false, reason: 'invalid_manifest' };
  }

  const verifiedAt = Date.parse(parsed.verifiedAt);
  const expiresAt = Date.parse(parsed.expiresAt);
  if (expiresAt <= verifiedAt || expiresAt - verifiedAt !== WIDGET_LEASE_MS) {
    return { valid: false, reason: 'invalid_lease_duration' };
  }
  if (expiresAt <= now) return { valid: false, reason: 'expired' };
  if (parsed.entries.length > WIDGET_MAX_ENTRIES) {
    return { valid: false, reason: 'entry_limit' };
  }

  for (const entry of parsed.entries) {
    if (Date.parse(entry.startsAt) < verifiedAt || Date.parse(entry.startsAt) >= expiresAt) {
      return { valid: false, reason: 'entry_outside_lease' };
    }
  }

  return { valid: true };
}

export function isWidgetManifestForScope(
  manifest: WidgetManifest | null | undefined,
  scope: WidgetCacheScope,
): manifest is WidgetManifest {
  return Boolean(
    manifest
    && manifest.accountId === scope.accountId
    && manifest.familyId === scope.familyId,
  );
}

export function isWidgetManifestFresh(
  manifest: WidgetManifest | null | undefined,
  scope: WidgetCacheScope,
  now = Date.now(),
): manifest is WidgetManifest {
  return isWidgetManifestForScope(manifest, scope)
    && validateWidgetManifest(manifest, now).valid;
}

export function neutralWidgetManifest(
  scope: WidgetCacheScope,
  now = new Date(),
): WidgetManifest {
  const verifiedAt = now.toISOString();
  return {
    schemaVersion: WIDGET_MANIFEST_SCHEMA_VERSION,
    accountId: scope.accountId,
    familyId: scope.familyId,
    generationId: `neutral-${now.getTime()}`,
    verifiedAt,
    expiresAt: new Date(now.getTime() + WIDGET_LEASE_MS).toISOString(),
    timezone: 'UTC',
    entries: [],
  };
}

export interface WidgetStagedFile {
  filename: string;
  uri: string;
  sizeBytes: number;
}

export interface WidgetImageToStage {
  filename: string;
  url: string;
}

export interface WidgetImageStageOptions {
  signal?: AbortSignal;
  fileSystem?: typeof FileSystem;
  imageManipulator?: typeof ImageManipulator;
  getImageSize?: (uri: string) => Promise<{ width: number; height: number }>;
}

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('Widget image staging was cancelled');
    error.name = 'AbortError';
    throw error;
  }
}

type DownloadResumable = ReturnType<typeof FileSystem.createDownloadResumable>;

async function stopDownload(task: DownloadResumable | null): Promise<void> {
  if (!task) return;
  await task.pauseAsync().catch(() => undefined);
}

async function downloadWidgetSource(
  fileSystem: typeof FileSystem,
  url: string,
  uri: string,
  signal?: AbortSignal,
): Promise<void> {
  ensureNotAborted(signal);

  let task: DownloadResumable | null = null;
  let sourceTooLarge = false;
  const onAbort = () => {
    // The legacy resumable API is the only Expo 56 download API that lets us
    // interrupt an in-flight copy.  The promise is still awaited below so a
    // late native completion cannot race the caller's cleanup.
    void stopDownload(task);
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const createResumable = fileSystem.createDownloadResumable;
    if (typeof createResumable === 'function') {
      task = createResumable(
        url,
        uri,
        {},
        (progress) => {
          if (progress.totalBytesWritten > WIDGET_MAX_SOURCE_DOWNLOAD_BYTES) {
            sourceTooLarge = true;
            void stopDownload(task);
          }
        },
      );
      const result = await task.downloadAsync();
      if (sourceTooLarge) {
        throw new Error('Widget image source exceeds the download limit');
      }
      if (!result) {
        throw new Error('Widget image download was cancelled');
      }
      if (result.status < 200 || result.status >= 300) {
        throw new Error(`Widget image download failed (${result.status})`);
      }
    } else {
      // Older test doubles and runtimes may only expose downloadAsync.  The
      // final source-size check remains mandatory, and cleanup is still in
      // the finally block of stageWidgetImage.
      const result = await fileSystem.downloadAsync(url, uri);
      if (result.status < 200 || result.status >= 300) {
        throw new Error(`Widget image download failed (${result.status})`);
      }
    }
    ensureNotAborted(signal);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (signal?.aborted) await stopDownload(task);
  }
}

function defaultImageSize(uri: string): Promise<{ width: number; height: number }> {
  return NativeImage.getSize(uri);
}

/**
 * Downloads and re-encodes one selected image.  Both the source response and
 * final preview are bounded; staging never writes outside its generation
 * directory and every failed/cancelled attempt removes its partial files.
 */
export async function stageWidgetImage(
  generationId: string,
  image: WidgetImageToStage,
  options: WidgetImageStageOptions = {},
): Promise<WidgetStagedFile> {
  if (!isSafeLocalFilename(image.filename)) {
    throw new Error('Invalid widget image filename');
  }
  if (!image.url || !/^https?:\/\//i.test(image.url)) {
    throw new Error('Invalid widget image URL');
  }
  ensureNotAborted(options.signal);

  const fileSystem = options.fileSystem ?? FileSystem;
  const imageManipulator = options.imageManipulator ?? ImageManipulator;
  const getImageSize = options.getImageSize ?? defaultImageSize;
  const root = fileSystem.cacheDirectory;
  if (!root) throw new Error('Widget cache directory is unavailable');

  const directory = `${root.replace(/\/$/, '')}/momora-widget/${encodeURIComponent(generationId)}`;
  const uri = `${directory}/${image.filename}`;
  let manipulatedUri: string | null = null;
  await fileSystem.makeDirectoryAsync(directory, { intermediates: true });
  try {
    ensureNotAborted(options.signal);
    await downloadWidgetSource(fileSystem, image.url, uri, options.signal);
    ensureNotAborted(options.signal);

    const sourceInfo = await fileSystem.getInfoAsync(uri);
    if (!sourceInfo.exists || typeof sourceInfo.size !== 'number' || sourceInfo.size <= 0) {
      throw new Error('Widget image was not written');
    }
    if (sourceInfo.size > WIDGET_MAX_SOURCE_DOWNLOAD_BYTES) {
      throw new Error('Widget image source exceeds the download limit');
    }

    const sourceSize = await getImageSize(uri);
    if (!Number.isFinite(sourceSize.width) || !Number.isFinite(sourceSize.height)
      || sourceSize.width <= 0 || sourceSize.height <= 0) {
      throw new Error('Widget image dimensions are unavailable');
    }
    ensureNotAborted(options.signal);

    const shouldResize = Math.max(sourceSize.width, sourceSize.height) > WIDGET_MAX_IMAGE_EDGE;
    const result = await imageManipulator.manipulateAsync(
      uri,
      shouldResize
        ? [{ resize: sourceSize.width >= sourceSize.height
          ? { width: WIDGET_MAX_IMAGE_EDGE }
          : { height: WIDGET_MAX_IMAGE_EDGE } }]
        : [],
      { compress: 0.78, format: imageManipulator.SaveFormat.JPEG },
    );
    manipulatedUri = result.uri;
    ensureNotAborted(options.signal);

    if (result.uri !== uri) {
      await fileSystem.deleteAsync(uri, { idempotent: true });
      await fileSystem.moveAsync({ from: result.uri, to: uri });
      manipulatedUri = null;
    }

    const finalInfo = await fileSystem.getInfoAsync(uri);
    if (!finalInfo.exists || typeof finalInfo.size !== 'number' || finalInfo.size <= 0) {
      throw new Error('Widget image preview was not written');
    }
    if (finalInfo.size > WIDGET_MAX_IMAGE_BYTES) {
      throw new Error('Widget image exceeds the size limit');
    }
    ensureNotAborted(options.signal);

    const resultWidth = typeof result.width === 'number' && result.width > 0
      ? result.width
      : (await getImageSize(uri)).width;
    const resultHeight = typeof result.height === 'number' && result.height > 0
      ? result.height
      : (await getImageSize(uri)).height;
    if (Math.max(resultWidth, resultHeight) > WIDGET_MAX_IMAGE_EDGE) {
      throw new Error('Widget image preview exceeds the dimension limit');
    }
    ensureNotAborted(options.signal);

    return { filename: image.filename, uri, sizeBytes: finalInfo.size };
  } catch (error) {
    await fileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
    if (manipulatedUri && manipulatedUri !== uri) {
      await fileSystem.deleteAsync(manipulatedUri, { idempotent: true }).catch(() => undefined);
    }
    throw error;
  }
}

export async function deleteWidgetGeneration(
  generationId: string,
  fileSystem: typeof FileSystem = FileSystem,
): Promise<void> {
  const root = fileSystem.cacheDirectory;
  if (!root) return;
  const directory = `${root.replace(/\/$/, '')}/momora-widget/${encodeURIComponent(generationId)}`;
  await fileSystem.deleteAsync(directory, { idempotent: true }).catch(() => {});
}

export interface WidgetCacheControllerOptions {
  adapter: WidgetNativeAdapter | null | undefined;
  fileSystem?: typeof FileSystem;
  now?: () => number;
}

/**
 * Serializes native mutations while using a synchronous epoch fence.  Calling
 * clear/invalidate aborts the active download and increments the epoch before
 * the clear is queued.  A publish that was already in native code therefore
 * settles before the queued clear, and a late publish cannot run after a newer
 * invalidation.
 */
export class WidgetCacheController {
  private readonly adapter: WidgetNativeAdapter | null;
  private readonly fileSystem: typeof FileSystem;
  private readonly now: () => number;
  private operationTail: Promise<void> = Promise.resolve();
  private epoch = 0;
  private activeAbortController: AbortController | null = null;
  private stagedGenerations = new Set<string>();

  constructor(options: WidgetCacheControllerOptions) {
    this.adapter = options.adapter ?? null;
    this.fileSystem = options.fileSystem ?? FileSystem;
    this.now = options.now ?? Date.now;
  }

  get currentEpoch(): number {
    return this.epoch;
  }

  invalidate(): number {
    this.epoch += 1;
    this.activeAbortController?.abort();
    this.activeAbortController = null;
    return this.epoch;
  }

  isCurrent(epoch: number): boolean {
    return epoch === this.epoch;
  }

  createAbortController(epoch: number): AbortController | null {
    if (!this.isCurrent(epoch)) return null;
    const controller = new AbortController();
    this.activeAbortController = controller;
    return controller;
  }

  markGenerationStaged(generationId: string): void {
    this.stagedGenerations.add(generationId);
  }

  markGenerationStagedIfCurrent(generationId: string, epoch: number): void {
    if (this.isCurrent(epoch)) this.markGenerationStaged(generationId);
  }

  async cleanupGeneration(generationId: string): Promise<void> {
    this.stagedGenerations.delete(generationId);
    await deleteWidgetGeneration(generationId, this.fileSystem);
  }

  async read(scope: WidgetCacheScope): Promise<WidgetManifest | null> {
    if (!this.adapter) return null;
    try {
      const manifest = await this.adapter.readManifest();
      return isWidgetManifestFresh(manifest, scope, this.now()) ? manifest : null;
    } catch {
      // Native storage is optional and a corrupt/missing snapshot is a safe
      // neutral state.  The next online sync may replace it.
      return null;
    }
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.operationTail.catch(() => {}).then(operation);
    this.operationTail = next.catch(() => {});
    return next;
  }

  async publish(
    scope: WidgetCacheScope,
    manifest: WidgetManifest,
    files: Record<string, string>,
    epoch = this.epoch,
  ): Promise<boolean> {
    if (!this.adapter || !this.isCurrent(epoch)) return false;
    const validation = validateWidgetManifest(manifest, this.now());
    if (!validation.valid || !isWidgetManifestForScope(manifest, scope)) return false;

    const expectedFiles = new Set(
      manifest.entries
        .map((entry) => entry.imageFilename)
        .filter((filename): filename is string => Boolean(filename)),
    );
    for (const filename of expectedFiles) {
      if (typeof files[filename] !== 'string' || files[filename].length === 0) return false;
    }
    // Do not let an accidental extra file become part of the native snapshot.
    // Keeping this one-to-one also makes it possible for native adapters to
    // garbage-collect safely after a successful swap.
    if (Object.keys(files).some((filename) => !expectedFiles.has(filename))) return false;

    let published = false;
    await this.enqueue(async () => {
      if (!this.adapter || !this.isCurrent(epoch)) return;
      await this.adapter.publishManifest(manifest, files);
      if (!this.isCurrent(epoch)) return;
      await this.adapter.reload();
      published = true;
      this.stagedGenerations.delete(manifest.generationId);
      await deleteWidgetGeneration(manifest.generationId, this.fileSystem);
    });
    if (published) return true;
    return false;
  }

  async clear(scope?: WidgetCacheScope): Promise<void> {
    this.invalidate();
    const generationsToRemove = [...this.stagedGenerations];
    await this.enqueue(async () => {
      // Clear is a privacy operation.  It must not be skipped just because a
      // newer sync invalidated the epoch while an older native operation was
      // draining.  The native adapter scopes this clear, and queue ordering
      // keeps a later publish after it.
      if (!this.adapter) return;
      await this.adapter.clearManifest(scope);
      await this.adapter.reload();
    });

    // Staging paths are generation-scoped and never contain the manifest.
    // Deleting them after the native clear keeps abandoned image files from
    // accumulating while preserving the native adapter's atomic swap.
    for (const generationId of generationsToRemove) {
      this.stagedGenerations.delete(generationId);
    }
    await Promise.all(
      generationsToRemove.map((generationId) => deleteWidgetGeneration(generationId, this.fileSystem)),
    );
  }
}

/**
 * Removes abandoned JS-side generation folders left by a killed process.
 * Native publication copies files before its atomic manifest swap, so no
 * generation directory is needed once the app has restarted.
 */
export async function sweepWidgetCache(
  fileSystem: typeof FileSystem = FileSystem,
): Promise<void> {
  const root = fileSystem.cacheDirectory;
  if (!root) return;
  const directory = `${root.replace(/\/$/, '')}/momora-widget`;
  let names: string[];
  try {
    names = await fileSystem.readDirectoryAsync(directory);
  } catch {
    return;
  }
  await Promise.all(names
    .filter((name) => name.length > 0 && !name.includes('/') && !name.includes('\\'))
    .map((name) => fileSystem.deleteAsync(`${directory}/${name}`, { idempotent: true }).catch(() => undefined)));
}

export function createWidgetCacheController(
  options: WidgetCacheControllerOptions,
): WidgetCacheController {
  return new WidgetCacheController(options);
}
