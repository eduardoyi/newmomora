import {
  parseWidgetManifest,
} from './manifest';
import {
  WIDGET_LEASE_MS,
  WIDGET_MAX_ENTRIES,
  WIDGET_MAX_CACHED_IMAGES,
  WIDGET_MAX_RETAINED_MEMORY_IDS,
  WIDGET_MANIFEST_SCHEMA_VERSION,
  type WidgetManifest,
} from './types';

const verifiedAt = new Date('2026-09-15T12:00:00.000Z');

function manifestWithEntries(
  entryCount: number,
  options: { uniqueImages?: number; uniqueMemoryIds?: number } = {},
): WidgetManifest {
  const uniqueImages = options.uniqueImages ?? Math.min(entryCount, WIDGET_MAX_CACHED_IMAGES);
  const uniqueMemoryIds = options.uniqueMemoryIds ?? Math.min(entryCount, WIDGET_MAX_RETAINED_MEMORY_IDS);
  return {
    schemaVersion: WIDGET_MANIFEST_SCHEMA_VERSION,
    accountId: 'account-a',
    familyId: 'family-a',
    generationId: 'generation-a',
    verifiedAt: verifiedAt.toISOString(),
    expiresAt: new Date(verifiedAt.getTime() + WIDGET_LEASE_MS).toISOString(),
    timezone: 'Europe/Lisbon',
    entries: Array.from({ length: entryCount }, (_, index) => ({
      startsAt: new Date(verifiedAt.getTime() + index * 6 * 60 * 60 * 1000).toISOString(),
      memoryId: `memory-${index % uniqueMemoryIds}`,
      sourceUpdatedAt: verifiedAt.toISOString(),
      memoryDate: '2026-09-15',
      dateLabel: 'Sep 15, 2026',
      excerpt: 'Synthetic widget memory',
      colors: { background: '#FFFFFF', foreground: '#222222' },
      kind: 'photo' as const,
      imageFilename: `memory-${index % uniqueImages}.jpg`,
    })),
  };
}

describe('widget manifest daytime contract', () => {
  it('accepts the 24-entry maximum', () => {
    expect(parseWidgetManifest(manifestWithEntries(WIDGET_MAX_ENTRIES)).entries).toHaveLength(24);
  });

  it('rejects a 25-entry manifest', () => {
    expect(() => parseWidgetManifest(manifestWithEntries(WIDGET_MAX_ENTRIES + 1))).toThrow(
      'Invalid widget manifest entries',
    );
  });

  it('keeps unique retained memory IDs and cached images at seven', () => {
    expect(() => parseWidgetManifest(manifestWithEntries(8, { uniqueMemoryIds: 8 }))).toThrow(
      'too many retained memory IDs',
    );
    expect(() => parseWidgetManifest(manifestWithEntries(8, { uniqueImages: 8 }))).toThrow(
      'too many cached images',
    );
  });
});
