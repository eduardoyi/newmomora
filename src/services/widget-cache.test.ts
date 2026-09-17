import {
  WIDGET_LEASE_MS,
  WIDGET_MANIFEST_SCHEMA_VERSION,
  WIDGET_MAX_ENTRIES,
  WidgetCacheController,
  neutralWidgetManifest,
  readWidgetPreference,
  validateWidgetManifest,
  widgetPreferenceStorageKey,
  writeWidgetPreference,
  type WidgetCacheScope,
  type WidgetManifest,
  type WidgetNativeAdapter,
} from './widget-cache';

const scope: WidgetCacheScope = { accountId: 'account-a', familyId: 'family-a' };

function manifest(overrides: Partial<WidgetManifest> = {}): WidgetManifest {
  const verifiedAt = new Date('2026-09-15T12:00:00.000Z');
  return {
    ...neutralWidgetManifest(scope, verifiedAt),
    generationId: 'generation-a',
    entries: [{
      startsAt: verifiedAt.toISOString(),
      memoryId: 'memory-a',
      sourceUpdatedAt: verifiedAt.toISOString(),
      memoryDate: '2026-09-15',
      dateLabel: 'Sep 15, 2026',
      excerpt: 'A little moment',
      colors: { background: '#F2EFF8', foreground: '#2C2418' },
      kind: 'text',
    }],
    ...overrides,
  };
}

function adapter(overrides: Partial<WidgetNativeAdapter> = {}): WidgetNativeAdapter {
  return {
    available: jest.fn(() => true),
    readManifest: jest.fn(async () => null),
    publishManifest: jest.fn(async () => undefined),
    clearManifest: jest.fn(async () => undefined),
    reload: jest.fn(async () => undefined),
    ...overrides,
  };
}

describe('widget cache manifest', () => {
  it('rejects an expired or old-schema manifest', () => {
    const old = manifest({ schemaVersion: 0 as never });
    expect(validateWidgetManifest(old, Date.parse('2026-09-15T12:01:00.000Z'))).toEqual({
      valid: false,
      reason: 'schema_mismatch',
    });

    const expired = manifest({
      expiresAt: new Date(Date.parse('2026-09-15T12:00:00.000Z') + WIDGET_LEASE_MS).toISOString(),
    });
    expect(validateWidgetManifest(expired, Date.parse(expired.expiresAt))).toEqual({
      valid: false,
      reason: 'expired',
    });
    expect(WIDGET_MANIFEST_SCHEMA_VERSION).toBe(1);
  });

  it('requires every referenced local image and rejects unreferenced files', async () => {
    const native = adapter();
    const cache = new WidgetCacheController({ adapter: native });
    const withImage = manifest({
      entries: [{ ...manifest().entries[0], imageFilename: 'memory-a.jpg' }],
    });
    const epoch = cache.currentEpoch;

    await expect(cache.publish(scope, withImage, {}, epoch)).resolves.toBe(false);
    await expect(cache.publish(scope, withImage, { 'memory-a.jpg': 'file:///tmp/a.jpg', extra: 'file:///tmp/e' }, epoch))
      .resolves.toBe(false);
    await expect(cache.publish(scope, withImage, { 'memory-a.jpg': 'file:///tmp/a.jpg' }, epoch))
      .resolves.toBe(true);
    expect(native.publishManifest).toHaveBeenCalledWith(withImage, { 'memory-a.jpg': 'file:///tmp/a.jpg' });
  });

  it('accepts 24 timeline entries while publishing at most seven unique images', async () => {
    const native = adapter();
    const cache = new WidgetCacheController({ adapter: native });
    const base = manifest().entries[0];
    const daytime = manifest({
      entries: Array.from({ length: WIDGET_MAX_ENTRIES }, (_, index) => ({
        ...base,
        startsAt: new Date(Date.parse(base.startsAt) + index * 6 * 60 * 60 * 1000).toISOString(),
        memoryId: `memory-${index % 7}`,
        imageFilename: `memory-${index % 7}.jpg`,
      })),
    });
    const files = Object.fromEntries(Array.from({ length: 7 }, (_, index) => [
      `memory-${index}.jpg`,
      `file:///tmp/memory-${index}.jpg`,
    ]));

    expect(validateWidgetManifest(daytime)).toEqual({ valid: true });
    await expect(cache.publish(scope, daytime, files)).resolves.toBe(true);
    expect(native.publishManifest).toHaveBeenCalledWith(daytime, files);
  });

  it('rejects more than seven unique cached images before native publication', async () => {
    const native = adapter();
    const cache = new WidgetCacheController({ adapter: native });
    const base = manifest().entries[0];
    const tooManyImages = manifest({
      entries: Array.from({ length: 8 }, (_, index) => ({
        ...base,
        startsAt: new Date(Date.parse(base.startsAt) + index * 60 * 60 * 1000).toISOString(),
        imageFilename: `memory-${index}.jpg`,
      })),
    });
    const files = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [
      `memory-${index}.jpg`,
      `file:///tmp/memory-${index}.jpg`,
    ]));

    await expect(cache.publish(scope, tooManyImages, files)).resolves.toBe(false);
    expect(native.publishManifest).not.toHaveBeenCalled();
  });

  it('serializes an in-flight publish before clearing the old generation', async () => {
    let releasePublish!: () => void;
    const publishStarted = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    const native = adapter({
      publishManifest: jest.fn(async () => publishStarted),
    });
    const cache = new WidgetCacheController({ adapter: native });
    const publishPromise = cache.publish(scope, manifest(), {});

    // Let the queued operation enter the adapter before invalidating it.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const clearPromise = cache.clear(scope);
    releasePublish();

    await expect(publishPromise).resolves.toBe(false);
    await expect(clearPromise).resolves.toBeUndefined();
    expect(native.publishManifest).toHaveBeenCalledTimes(1);
    expect(native.clearManifest).toHaveBeenCalledWith(scope);
    expect(native.reload).toHaveBeenCalledTimes(1);
  });

  it('does not skip a queued privacy clear after a later invalidation', async () => {
    let releasePublish!: () => void;
    const publishStarted = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    const native = adapter({
      publishManifest: jest.fn(async () => publishStarted),
    });
    const cache = new WidgetCacheController({ adapter: native });
    const publishPromise = cache.publish(scope, manifest(), {});

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const clearPromise = cache.clear(scope);
    // A second lifecycle event can invalidate again before the first queued
    // native operation drains. The clear still has to execute.
    cache.invalidate();
    releasePublish();

    await expect(publishPromise).resolves.toBe(false);
    await expect(clearPromise).resolves.toBeUndefined();
    expect(native.clearManifest).toHaveBeenCalledWith(scope);
    expect(native.reload).toHaveBeenCalledTimes(1);
  });

  it('stores opt-in per account/family and fails closed on corrupt values', async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: jest.fn(async (key: string) => values.get(key) ?? null),
      setItem: jest.fn(async (key: string, value: string) => { values.set(key, value); }),
      removeItem: jest.fn(async (key: string) => { values.delete(key); }),
    };

    expect(await readWidgetPreference(scope, storage)).toBe(false);
    await writeWidgetPreference(scope, true, storage);
    expect(await readWidgetPreference(scope, storage)).toBe(true);
    expect(widgetPreferenceStorageKey(scope)).toContain('account-a');

    values.set(widgetPreferenceStorageKey(scope), '{bad json');
    expect(await readWidgetPreference(scope, storage)).toBe(false);
  });
});
