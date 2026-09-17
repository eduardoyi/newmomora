import type { WidgetManifest } from './types';

const mockTimeline = jest.fn();
const mockWidgetReload = jest.fn();
const mockNative = {
  readManifest: jest.fn(),
  publishManifest: jest.fn(),
  clearManifest: jest.fn(),
  reload: jest.fn(),
};
let mockNativePresent = true;
let mockStoredManifest: WidgetManifest | null;
let mockMaxTimelineEntries: number | undefined;

jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('../../modules/momora-widget', () => ({
  getMomoraWidgetNativeModule: () => mockNativePresent ? mockNative : null,
  getMomoraWidgetCapabilities: () => mockNativePresent ? {
    supported: true,
    enabled: true,
    platform: 'ios',
    sharedDirectory: '/private/widget-cache',
    ...(mockMaxTimelineEntries === undefined ? {} : { maxTimelineEntries: mockMaxTimelineEntries }),
  } : null,
}));
jest.mock('./MomoraMemoryWidget', () => ({
  MomoraMemoryWidget: {
    updateTimeline: (...args: unknown[]) => mockTimeline(...args),
    reload: () => mockWidgetReload(),
  },
}));

function manifest(): WidgetManifest {
  return {
    schemaVersion: 1,
    accountId: 'account-a',
    familyId: 'family-a',
    generationId: 'generation-a',
    verifiedAt: '2026-09-15T12:00:00.000Z',
    expiresAt: '2026-09-22T12:00:00.000Z',
    timezone: 'Europe/Lisbon',
    entries: [{
      startsAt: '2026-09-15T12:00:00.000Z',
      memoryId: 'memory-a',
      sourceUpdatedAt: '2026-09-14T12:00:00+00:00',
      memoryDate: '2026-09-14',
      dateLabel: 'September 14, 2026',
      excerpt: 'Private family memory',
      colors: { background: '#FFFFFF', foreground: '#222222' },
      kind: 'photo',
      imageFilename: 'memory-a.jpg',
    }],
  };
}

function daytimeManifest(): WidgetManifest {
  const base = manifest();
  return {
    ...base,
    entries: Array.from({ length: 24 }, (_, index) => ({
      ...base.entries[0],
      startsAt: new Date(Date.parse(base.verifiedAt) + index * 6 * 60 * 60 * 1000).toISOString(),
      memoryId: `memory-${index % 7}`,
      imageFilename: `memory-${index % 7}.jpg`,
    })),
  };
}

function daytimeFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (let index = 0; index < 7; index += 1) {
    files[`memory-${index}.jpg`] = `file:///staging/memory-${index}.jpg`;
  }
  return files;
}

function loadAdapter() {
  // A fresh import models a new app process, including old installed binaries.
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Re-import after resetting module state to model a new native binary.
  return require('./native-adapter').momoraWidgetAdapter as import('./types').WidgetNativeAdapter;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTimeline.mockReset();
  mockNativePresent = true;
  mockMaxTimelineEntries = 24;
  mockStoredManifest = null;
  mockNative.readManifest.mockImplementation(async () => mockStoredManifest ? JSON.stringify(mockStoredManifest) : null);
  mockNative.publishManifest.mockImplementation(async (raw: string) => {
    mockStoredManifest = JSON.parse(raw);
  });
  mockNative.clearManifest.mockImplementation(async (scopeJson?: string) => {
    const scope = scopeJson ? JSON.parse(scopeJson) : null;
    if (!scope || (scope.accountId === mockStoredManifest?.accountId && scope.familyId === mockStoredManifest?.familyId)) {
      mockStoredManifest = null;
    }
  });
});

it('schedules a neutral expiry and never puts signed image URLs in iOS props', async () => {
  const adapter = loadAdapter();
  await adapter.publishManifest(manifest(), { 'memory-a.jpg': 'file:///staging/memory-a.jpg' });
  const timeline = mockTimeline.mock.calls[0][0];
  expect(timeline[0].props.imageUri).toBe('file:///private/widget-cache/generations/generation-a/memory-a.jpg');
  expect(timeline[0].props.deepLink).not.toContain('Private');
  expect(timeline.at(-1)).toMatchObject({
    date: new Date('2026-09-22T12:00:00.000Z'),
    props: { kind: 'neutral' },
  });
});

it('passes every daytime entry to the iOS timeline and exposes native capacity', async () => {
  const adapter = loadAdapter();
  expect(adapter.maxTimelineEntries?.()).toBe(24);
  await adapter.publishManifest(daytimeManifest(), daytimeFiles());
  const timeline = mockTimeline.mock.calls[0][0];
  expect(timeline).toHaveLength(25);
  expect(timeline.slice(0, 24).map((entry: { props: { memoryId?: string } }) => entry.props.memoryId))
    .toEqual(Array.from({ length: 24 }, (_, index) => `memory-${index % 7}`));
  expect(timeline.at(-1).props.kind).toBe('neutral');
});

it('defaults old native binaries to seven entries and blocks a daytime publish', async () => {
  mockMaxTimelineEntries = undefined;
  const adapter = loadAdapter();
  expect(adapter.maxTimelineEntries?.()).toBe(7);
  await expect(adapter.publishManifest(daytimeManifest(), daytimeFiles())).rejects.toThrow(
    'installed native binary supports 7',
  );
  expect(mockNative.publishManifest).not.toHaveBeenCalled();
});

it('clears the separately persisted iOS timeline on logout', async () => {
  const adapter = loadAdapter();
  await adapter.publishManifest(manifest(), { 'memory-a.jpg': 'file:///staging/memory-a.jpg' });
  await adapter.clearManifest({ accountId: 'account-a', familyId: 'family-a' });
  const timeline = mockTimeline.mock.calls.at(-1)?.[0];
  expect(timeline).toHaveLength(1);
  expect(timeline[0].props.kind).toBe('neutral');
  expect(JSON.stringify(timeline)).not.toContain('Private family memory');
  expect(JSON.stringify(timeline)).not.toContain('memory-a.jpg');
});

it('rejects unreferenced local files before touching native storage', async () => {
  const adapter = loadAdapter();
  await expect(adapter.publishManifest(manifest(), {
    'memory-a.jpg': 'file:///staging/memory-a.jpg',
    'unexpected.jpg': 'file:///private/unrelated.jpg',
  })).rejects.toThrow();
  expect(mockNative.publishManifest).not.toHaveBeenCalled();
});

it('does not neutralize a different account when an old scoped clear arrives', async () => {
  const adapter = loadAdapter();
  const other = { ...manifest(), accountId: 'account-b', familyId: 'family-b' };
  await adapter.publishManifest(other, { 'memory-a.jpg': 'file:///staging/memory-a.jpg' });
  const publishedCount = mockTimeline.mock.calls.length;
  await adapter.clearManifest({ accountId: 'account-a', familyId: 'family-a' });
  expect(mockStoredManifest?.accountId).toBe('account-b');
  expect(mockTimeline).toHaveBeenCalledTimes(publishedCount);
});

it('reports a failed iOS timeline update instead of claiming publication succeeded', async () => {
  const adapter = loadAdapter();
  mockTimeline.mockImplementation(() => { throw new Error('WidgetKit storage unavailable'); });
  await expect(adapter.publishManifest(manifest(), {
    'memory-a.jpg': 'file:///staging/memory-a.jpg',
  })).rejects.toThrow();
});

it('old binaries expose no widget and never load its isolated runtime', async () => {
  mockNativePresent = false;
  const adapter = loadAdapter();
  expect(await adapter.available()).toBe(false);
  await adapter.clearManifest();
  await adapter.reload();
  expect(mockTimeline).not.toHaveBeenCalled();
  expect(mockNative.clearManifest).not.toHaveBeenCalled();
});
