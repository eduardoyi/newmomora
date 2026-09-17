import { Platform } from 'react-native';

import {
  getMomoraWidgetCapabilities,
  getMomoraWidgetNativeModule,
  type MomoraWidgetNativeModule,
} from '../../modules/momora-widget';
import { parseWidgetManifest, serializeWidgetManifest } from './manifest';
import type {
  WidgetCacheScope,
  WidgetManifest,
  WidgetNativeCapabilities,
  WidgetNativeAdapter,
} from './types';
import {
  WIDGET_LEGACY_MAX_ENTRIES,
  WIDGET_MAX_ENTRIES,
} from './types';

interface MomoraIosTimelineEntry {
  date: Date;
  props: {
    kind: 'memory' | 'neutral';
    imageKind?: 'photo' | 'illustration';
    familyId?: string;
    memoryId?: string;
    mediaIndex?: number;
    expiresAt?: string;
    dateLabel?: string;
    excerpt?: string;
    imageUri?: string;
    backgroundColor?: string;
    foregroundColor?: string;
    deepLink?: string;
  };
}

interface MomoraIosWidget {
  updateTimeline: (entries: MomoraIosTimelineEntry[]) => void;
  reload: () => void;
}

let iosWidget: MomoraIosWidget | null | undefined;

/**
 * Loading expo-widgets is deliberately deferred. Its public iOS entry point
 * uses requireNativeModule and throws in Expo Go, web, and older binaries.
 */
function getIosWidget(): MomoraIosWidget | null {
  if (Platform.OS !== 'ios') return null;
  if (iosWidget !== undefined) return iosWidget;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loaded = require('./MomoraMemoryWidget') as {
      default?: MomoraIosWidget;
      MomoraMemoryWidget?: MomoraIosWidget;
    };
    iosWidget = loaded.MomoraMemoryWidget ?? loaded.default ?? null;
  } catch {
    iosWidget = null;
  }
  return iosWidget;
}

function capabilities(): WidgetNativeCapabilities | null {
  const raw = getMomoraWidgetCapabilities();
  if (!raw || typeof raw.supported !== 'boolean' || typeof raw.enabled !== 'boolean') {
    return null;
  }
  const reportedLimit = raw.maxTimelineEntries;
  const maxTimelineEntries = typeof reportedLimit === 'number'
    && Number.isInteger(reportedLimit)
    && reportedLimit >= WIDGET_MAX_ENTRIES
    ? Math.min(reportedLimit, WIDGET_MAX_ENTRIES)
    : WIDGET_LEGACY_MAX_ENTRIES;
  return { ...raw, maxTimelineEntries };
}

/**
 * Binaries shipped before the daytime contract have no capability field and
 * understand only the original seven daily entries. Keep that fallback
 * conservative; the coordinator uses this value when choosing its timeline.
 */
function nativeTimelineCapacity(): number {
  return capabilities()?.maxTimelineEntries ?? WIDGET_LEGACY_MAX_ENTRIES;
}

function localFileUri(sharedDirectory: string | undefined, manifest: WidgetManifest, filename: string): string | undefined {
  if (!sharedDirectory) return undefined;
  // Native stores are generation-addressed. Filenames and generation IDs are
  // validated before this path is built, so the extension never receives a
  // caller-controlled path segment.
  return `file://${sharedDirectory.replace(/\/$/, '')}/generations/${manifest.generationId}/${filename}`;
}

function widgetDeepLink(manifest: WidgetManifest, memoryId?: string, mediaIndex?: number): string {
  if (!memoryId) return 'momora://widget';
  const query = [
    `memoryId=${encodeURIComponent(memoryId)}`,
    `familyId=${encodeURIComponent(manifest.familyId)}`,
    ...(mediaIndex === undefined ? [] : [`mediaIndex=${mediaIndex}`]),
  ].join('&');
  return `momora://widget?${query}`;
}

function timelineForManifest(
  manifest: WidgetManifest,
  sharedDirectory: string | undefined,
): MomoraIosTimelineEntry[] {
  const entries: MomoraIosTimelineEntry[] = manifest.entries.filter((entry) =>
    (entry.kind === 'photo' || entry.kind === 'illustration') && entry.imageFilename
  ).map((entry) => ({
    date: new Date(entry.startsAt),
    props: {
      kind: 'memory' as const,
      imageKind: entry.kind === 'illustration' ? 'illustration' as const : 'photo' as const,
      familyId: manifest.familyId,
      expiresAt: manifest.expiresAt,
      memoryId: entry.memoryId,
      ...(entry.mediaIndex === undefined ? {} : { mediaIndex: entry.mediaIndex }),
      dateLabel: entry.dateLabel,
      excerpt: entry.excerpt,
      ...(entry.imageFilename
        ? { imageUri: localFileUri(sharedDirectory, manifest, entry.imageFilename) }
        : {}),
      backgroundColor: entry.colors.background,
      foregroundColor: entry.colors.foreground,
      deepLink: widgetDeepLink(manifest, entry.memoryId, entry.mediaIndex),
    },
  }));
  if (entries.length === 0) {
    return [{ date: new Date(manifest.verifiedAt), props: { kind: 'neutral', deepLink: 'momora://widget' } }];
  }
  // WidgetKit's .atEnd policy is not a hard expiry guarantee, but the
  // explicit neutral entry prevents a valid old card from being the planned
  // post-lease timeline value.
  entries.push({
    date: new Date(manifest.expiresAt),
    props: { kind: 'neutral', deepLink: 'momora://widget' },
  });
  return entries;
}

function scopeJson(scope?: WidgetCacheScope): string | undefined {
  return scope ? JSON.stringify(scope) : undefined;
}

function exactFiles(manifest: WidgetManifest, files: Record<string, string>): boolean {
  const expected = new Set(
    manifest.entries
      .map((entry) => entry.imageFilename)
      .filter((filename): filename is string => Boolean(filename)),
  );
  return expected.size === Object.keys(files).length
    && Object.keys(files).every((filename) => expected.has(filename));
}

function createAdapter(native: MomoraWidgetNativeModule | null): WidgetNativeAdapter {
  return {
    available: () => {
      const current = capabilities();
      return Boolean(native && current?.supported && current.enabled
        && (Platform.OS !== 'ios' || getIosWidget()));
    },

    maxTimelineEntries: () => nativeTimelineCapacity(),

    readManifest: async () => {
      if (!native) return null;
      try {
        const raw = await native.readManifest();
        return raw ? parseWidgetManifest(JSON.parse(raw)) : null;
      } catch {
        return null;
      }
    },

    publishManifest: async (manifest, files) => {
      if (!native) return;
      const normalized = parseWidgetManifest(manifest);
      const maxEntries = nativeTimelineCapacity();
      if (normalized.entries.length > maxEntries) {
        throw new Error(
          `Widget manifest has ${normalized.entries.length} entries; installed native binary supports ${maxEntries}`,
        );
      }
      if (!exactFiles(normalized, files)) {
        throw new Error('Widget files do not match the manifest');
      }
      await native.publishManifest(serializeWidgetManifest(normalized), JSON.stringify(files));

      const widget = getIosWidget();
      if (Platform.OS === 'ios' && !widget) {
        throw new Error('The iOS widget runtime is unavailable');
      }
      if (widget) {
        try {
          widget.updateTimeline(timelineForManifest(
            normalized,
            capabilities()?.sharedDirectory,
          ));
        } catch (error) {
          // The native cache is already committed, but the visible iOS
          // timeline failed. Surface this as a recoverable error so the next
          // sync can retry instead of silently reporting success.
          throw new Error(
            error instanceof Error
              ? `Could not update the iOS widget timeline: ${error.message}`
              : 'Could not update the iOS widget timeline',
          );
        }
      }
    },

    clearManifest: async (scope, generationId) => {
      if (!native) return;
      let current: WidgetManifest | null = null;
      try {
        const raw = await native.readManifest();
        current = raw ? parseWidgetManifest(JSON.parse(raw)) : null;
      } catch {
        current = null;
      }
      if (scope && current
        && (current.accountId !== scope.accountId || current.familyId !== scope.familyId)) {
        // A late logout/family clear must never replace a newer family's
        // WidgetKit timeline with a neutral snapshot.
        return;
      }

      const result = await native.clearManifest(
        scopeJson(scope),
        generationId ?? current?.generationId,
      );
      if (result === false) return;

      const widget = getIosWidget();
      if (widget) {
        try {
          widget.updateTimeline([{
            date: new Date(),
            props: { kind: 'neutral', deepLink: 'momora://widget' },
          }]);
        } catch (error) {
          throw new Error(
            error instanceof Error
              ? `Could not clear the iOS widget timeline: ${error.message}`
              : 'Could not clear the iOS widget timeline',
          );
        }
        widget.reload();
      }
    },

    reload: async () => {
      if (!native) return;
      await native.reload();
      getIosWidget()?.reload();
    },
  };
}

/** Native cache adapter for the optional iOS/Android widget binary. */
export const momoraWidgetAdapter = createAdapter(getMomoraWidgetNativeModule());

export function getMomoraWidgetAdapterCapabilities(): WidgetNativeCapabilities | null {
  return capabilities();
}

export function resetMomoraWidgetAdapterForTests(): void {
  iosWidget = undefined;
}
