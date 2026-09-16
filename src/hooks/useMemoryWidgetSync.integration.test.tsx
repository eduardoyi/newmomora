import {
  MemoryWidgetSyncCoordinator,
  type MemoryWidgetSyncDependencies,
} from './useMemoryWidgetSync';
import {
  WIDGET_LEASE_MS,
  type WidgetManifest,
  type WidgetNativeAdapter,
} from '@/widgets/types';
import type { MemoryWithTags } from '@/services/memories';

const scope = { accountId: 'account-a', familyId: 'family-a' };
const verifiedAt = '2026-09-15T12:00:00.000Z';

function memory(
  id: string,
  overrides: Partial<MemoryWithTags> = {},
): MemoryWithTags {
  return {
    id,
    family_id: scope.familyId,
    user_id: scope.accountId,
    memory_date: '2026-09-15',
    content: `Memory ${id}`,
    description: null,
    memory_type: 'text_illustration',
    updated_at: verifiedAt,
    created_at: verifiedAt,
    illustration_key: `private/${id}.jpg`,
    illustration_status: 'ready',
    illustration_generation_id: null,
    emotion: 'tender',
    media_key: null,
    media_content_type: null,
    taggedMembers: [],
    mediaAssets: [],
    likeCount: 0,
    commentCount: 0,
    likedByMe: false,
    ...overrides,
  } as MemoryWithTags;
}

function manifestWithEntries(memoryIds: string[]): WidgetManifest {
  return {
    schemaVersion: 1,
    accountId: scope.accountId,
    familyId: scope.familyId,
    generationId: 'generation-old',
    verifiedAt: '2026-09-15T11:00:00.000Z',
    expiresAt: new Date(Date.parse('2026-09-15T11:00:00.000Z') + WIDGET_LEASE_MS).toISOString(),
    timezone: 'UTC',
    entries: memoryIds.map((memoryId, index) => ({
      startsAt: new Date(Date.parse('2026-09-15T11:00:00.000Z') + index * 60 * 60 * 1000).toISOString(),
      memoryId,
      sourceUpdatedAt: verifiedAt,
      memoryDate: '2026-09-15',
      dateLabel: 'Sep 15, 2026',
      excerpt: memoryId,
      colors: { background: '#F2EFF8', foreground: '#2C2418' },
      kind: 'text',
    })),
  };
}

function makeAdapter(initial: WidgetManifest | null = null) {
  let current = initial;
  const native: WidgetNativeAdapter = {
    available: () => true,
    readManifest: jest.fn(async () => current),
    publishManifest: jest.fn(async (next) => {
      current = next;
    }),
    clearManifest: jest.fn(async () => {
      current = null;
    }),
    reload: jest.fn(async () => undefined),
  };
  return { native, getManifest: () => current };
}

function dependencies(
  candidates: MemoryWithTags[],
  overrides: Partial<MemoryWidgetSyncDependencies> = {},
): MemoryWidgetSyncDependencies {
  return {
    now: () => Date.parse(verifiedAt),
    getTimezone: () => 'UTC',
    sweep: async () => undefined,
    fetchCandidates: async () => ({
      data: {
        candidates: candidates.map((item) => ({ id: item.id, memoryDate: item.memory_date, ageBand: 'recent' as const })),
        clock: {
          familyDate: '2026-09-15',
          timezoneName: 'UTC',
          nextDayBoundary: '2026-09-16T00:00:00.000Z',
        },
        memories: candidates,
      },
      error: null,
      failure: null,
    }),
    fetchRetained: async () => ({ data: [], error: null, failure: null }),
    fetchReports: async () => ({ data: [], error: null }),
    fetchBlocks: async () => ({ data: [], error: null }),
    signMedia: async (keys) => ({ data: { urls: Object.fromEntries(keys.map((key) => [key, `https://example.test/${key}`])) }, error: null }),
    stageImage: async (_generationId, image) => ({ filename: image.filename, uri: `file://${image.filename}`, sizeBytes: 10 }),
    ...overrides,
  };
}

describe('MemoryWidgetSyncCoordinator', () => {
  it('visits all 40 eligible images before repeating across manual taps', async () => {
    const memories = Array.from({ length: 40 }, (_, index) => memory(`memory-${index}`, {
      memory_date: ['2026-09-01', '2025-09-01', '2024-09-01', '2020-09-01'][index % 4],
    }));
    const adapter = makeAdapter(manifestWithEntries(['memory-0']));
    const coordinator = new MemoryWidgetSyncCoordinator(adapter.native, dependencies(memories, {
      fetchRetained: async () => ({ data: memories, error: null, failure: null }),
    }));
    const shown = ['memory-0'];
    // Even the same RNG draw must not cause the old short loop.
    const random = jest.spyOn(Math, 'random').mockReturnValue(0.25);
    try {
      for (let index = 0; index < 39; index += 1) {
        await coordinator.sync(scope, { showAnother: true });
        shown.push(adapter.getManifest()!.entries[0].memoryId);
        await coordinator.sync(scope);
        expect(adapter.getManifest()!.entries[0].memoryId).toBe(shown.at(-1));
      }
      expect(new Set(shown).size).toBe(40);
      await coordinator.sync(scope, { showAnother: true });
      expect(adapter.getManifest()!.entries[0].memoryId).not.toBe(shown.at(-1));
    } finally {
      random.mockRestore();
    }
  });

  it('manual rotation changes the current memory while automatic sync preserves it', async () => {
    const memories = [memory('memory-a'), memory('memory-b')];
    const adapter = makeAdapter(manifestWithEntries(['memory-a']));
    const coordinator = new MemoryWidgetSyncCoordinator(adapter.native, dependencies(memories, {
      fetchRetained: async () => ({ data: memories, error: null, failure: null }),
    }));
    await coordinator.sync(scope);
    expect(adapter.getManifest()?.entries[0].memoryId).toBe('memory-a');
    await coordinator.sync(scope, { showAnother: true });
    expect(adapter.getManifest()?.entries[0].memoryId).toBe('memory-b');
    await coordinator.sync(scope);
    expect(adapter.getManifest()?.entries[0].memoryId).toBe('memory-b');
    await coordinator.sync(scope, { showAnother: true });
    expect(adapter.getManifest()?.entries[0].memoryId).toBe('memory-a');
  });

  it('manual rotation keeps the sole eligible memory', async () => {
    const memories = [memory('memory-a')];
    const adapter = makeAdapter(manifestWithEntries(['memory-a']));
    const coordinator = new MemoryWidgetSyncCoordinator(adapter.native, dependencies(memories, {
      fetchRetained: async () => ({ data: memories, error: null, failure: null }),
    }));
    await expect(coordinator.sync(scope, { showAnother: true })).resolves.toEqual({ published: true, cleared: false });
    expect(adapter.getManifest()?.entries[0].memoryId).toBe('memory-a');
  });

  it('publishes seven illustration slots for one image memory', async () => {
    const adapter = makeAdapter();
    const result = await new MemoryWidgetSyncCoordinator(
      adapter.native,
      dependencies([memory('memory-a')]),
    ).sync(scope);

    expect(result).toEqual({ published: true, cleared: false });
    expect(adapter.getManifest()?.entries).toHaveLength(7);
    expect(new Set(adapter.getManifest()?.entries.map((entry) => entry.memoryId))).toEqual(new Set(['memory-a']));
  });

  it('stages a repeated preview image once and keeps its preview media key', async () => {
    const adapter = makeAdapter();
    const stageImage = jest.fn(async (_generationId: string, image: { filename: string; url: string }) => ({
      filename: image.filename,
      uri: `file://${image.filename}`,
      sizeBytes: 10,
    }));
    const photo = memory('memory-photo', {
      memory_type: 'media',
      mediaAssets: [{
        id: 'asset-1',
        memory_id: 'memory-photo',
        object_key: 'private/original.jpg',
        preview_object_key: 'private/preview.jpg',
        content_type: 'image/jpeg',
        duration_ms: null,
        aspect_ratio: 1,
        share_card_key: null,
        position: 0,
        created_at: verifiedAt,
        updated_at: verifiedAt,
      }],
    });
    const result = await new MemoryWidgetSyncCoordinator(
      adapter.native,
      dependencies([photo], {
        signMedia: async (keys) => ({ data: { urls: Object.fromEntries(keys.map((key) => [key, `https://cdn.test/${key}`])) }, error: null }),
        stageImage: stageImage as MemoryWidgetSyncDependencies['stageImage'],
      }),
    ).sync(scope);

    expect(result.published).toBe(true);
    expect(stageImage).toHaveBeenCalledTimes(1);
    expect(stageImage.mock.calls[0]?.[1].url).toContain('private/preview.jpg');
    expect(adapter.getManifest()?.entries.every((entry) => entry.imageFilename === 'memory-memory-photo-0.jpg')).toBe(true);
  });

  it('removes a retained ID absent from the fresh sample instead of resurrecting it', async () => {
    const previous = manifestWithEntries(['memory-old']);
    const adapter = makeAdapter(previous);
    const oldMemory = memory('memory-old');
    const candidate = memory('memory-new');
    const result = await new MemoryWidgetSyncCoordinator(
      adapter.native,
      dependencies([candidate], {
        fetchRetained: async () => ({ data: [], error: null, failure: null }),
      }),
    ).sync(scope);

    expect(result.published).toBe(true);
    expect(adapter.getManifest()?.entries).toHaveLength(7);
    expect(adapter.getManifest()?.entries.some((entry) => entry.memoryId === oldMemory.id)).toBe(false);
    expect(adapter.getManifest()?.entries[0]?.memoryId).toBe(candidate.id);
  });

  it('keeps the current same-day card first while filling the remaining slots', async () => {
    const previous = manifestWithEntries(['memory-current', 'memory-current', 'memory-current']);
    const adapter = makeAdapter(previous);
    const current = memory('memory-current');
    const next = memory('memory-next', { memory_date: '2025-01-01' });
    const result = await new MemoryWidgetSyncCoordinator(
      adapter.native,
      dependencies([next], { fetchRetained: async () => ({ data: [current], error: null, failure: null }) }),
    ).sync(scope);

    expect(result.published).toBe(true);
    expect(adapter.getManifest()?.entries).toHaveLength(7);
    expect(adapter.getManifest()?.entries[0]?.memoryId).toBe(current.id);
    expect(adapter.getManifest()?.entries.slice(1).some((entry) => entry.memoryId === next.id)).toBe(true);
  });

  it('preserves the old lease on a temporary candidate failure', async () => {
    const previous = manifestWithEntries(['memory-old']);
    const adapter = makeAdapter(previous);
    const result = await new MemoryWidgetSyncCoordinator(
      adapter.native,
      dependencies([memory('memory-new')], {
        fetchCandidates: async () => ({ data: null, error: { message: 'offline' }, failure: 'unavailable' }),
      }),
    ).sync(scope);

    expect(result).toEqual({ published: false, cleared: false, reason: 'candidate_unavailable' });
    expect(adapter.getManifest()).toBe(previous);
    expect(adapter.native.clearManifest).not.toHaveBeenCalled();
  });

  it('clears only on a definitive candidate authorization failure', async () => {
    const adapter = makeAdapter();
    const result = await new MemoryWidgetSyncCoordinator(
      adapter.native,
      dependencies([], {
        fetchCandidates: async () => ({ data: null, error: { message: 'forbidden' }, failure: 'authorization' }),
      }),
    ).sync(scope);

    expect(result).toEqual({ published: false, cleared: true, reason: 'authorization_lost' });
    expect(adapter.native.clearManifest).toHaveBeenCalledWith(scope);
  });
});

it('only schedules photos or ready unreported illustrations, never text, audio, or video', async () => {
  const adapter = makeAdapter();
  const video = memory('video', { memory_type: 'media', mediaAssets: [{
    id: 'video-asset', memory_id: 'video', object_key: 'private/video.mp4',
    preview_object_key: 'private/poster.jpg', content_type: 'video/mp4', position: 0,
  } as never] });
  const result = await new MemoryWidgetSyncCoordinator(adapter.native, dependencies([
    memory('text', { memory_type: 'text_only' }),
    memory('audio', { memory_type: 'audio', media_key: 'private/audio.m4a', media_content_type: 'audio/mp4' }),
    video,
    memory('pending', { illustration_status: 'pending' }),
    memory('ready'),
  ])).sync(scope);
  expect(result.published).toBe(true);
  expect(adapter.getManifest()?.entries).toHaveLength(7);
  expect(adapter.getManifest()?.entries.every((entry) => entry.memoryId === 'ready' && entry.imageFilename)).toBe(true);
});

it('publishes a neutral widget when the only illustration is reported', async () => {
  const adapter = makeAdapter();
  const result = await new MemoryWidgetSyncCoordinator(adapter.native, dependencies([memory('reported')], {
    fetchReports: async () => ({ data: [{ target_type: 'memory_illustration', target_id: 'reported', target_version_id: null } as never], error: null }),
  })).sync(scope);
  expect(result.published).toBe(true);
  expect(adapter.getManifest()?.entries).toEqual([]);
});

it('uses neutral content instead of text when every eligible image fails to stage', async () => {
  const adapter = makeAdapter();
  const result = await new MemoryWidgetSyncCoordinator(adapter.native, dependencies([memory('broken')], {
    stageImage: async () => { throw new Error('download failed'); },
  })).sync(scope);
  expect(result.published).toBe(true);
  expect(adapter.getManifest()?.entries).toEqual([]);
});

it('fills failed artwork slots with a successfully staged image and preserves all seven dates', async () => {
  const adapter = makeAdapter();
  const result = await new MemoryWidgetSyncCoordinator(adapter.native, dependencies([memory('good'), memory('broken')], {
    stageImage: async (_generation, image) => {
      if (image.filename.includes('broken')) throw new Error('download failed');
      return { filename: image.filename, uri: `file://${image.filename}`, sizeBytes: 10 };
    },
  })).sync(scope);
  expect(result.published).toBe(true);
  const entries = adapter.getManifest()?.entries ?? [];
  expect(entries).toHaveLength(7);
  expect(entries.every((entry) => entry.memoryId === 'good' && entry.imageFilename)).toBe(true);
  expect(new Set(entries.map((entry) => entry.startsAt)).size).toBe(7);
});
