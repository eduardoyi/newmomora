import {
  createMediaMemory,
  createMemory,
  deleteMemory,
  fetchMemories,
  fetchMemoriesInDateRange,
  fetchOldestMemoryDate,
  regenerateMemoryIllustration,
  retryMemoryIllustration,
  runMemoryIllustrationPipeline,
  runMediaPhotoEmotionAnalysis,
} from '@/services/memories';

import { supabase } from '@/lib/supabase';
import { analyzeMemoryEmotion, generateMemoryIllustration } from '@/services/ai';
import { deleteStorageObject } from '@/services/media';

jest.mock('@/lib/supabase', () => ({
  supabase: {
    from: jest.fn(),
    rpc: jest.fn(),
    functions: {
      invoke: jest.fn(),
    },
  },
}));

jest.mock('@/services/ai', () => ({
  analyzeMemoryEmotion: jest.fn().mockResolvedValue({
    data: { emotion: 'joy', colorPalette: 'warm yellows' },
    error: null,
  }),
  generateMemoryIllustration: jest.fn().mockResolvedValue({ error: null }),
}));

jest.mock('@/services/media', () => ({
  deleteStorageObject: jest.fn().mockResolvedValue({ error: null }),
}));

type QueryResult = { data: unknown; error: { message: string; code?: string } | null };

function createQueryBuilder(finalResult: QueryResult) {
  const builder: Record<string, jest.Mock> & {
    then?: (resolve: (value: QueryResult) => void) => void;
  } = {};

  builder.select = jest.fn(() => builder);
  builder.insert = jest.fn(() => builder);
  builder.update = jest.fn(() => builder);
  builder.delete = jest.fn(() => builder);
  builder.eq = jest.fn(() => builder);
  builder.gte = jest.fn(() => builder);
  builder.in = jest.fn(() => builder);
  builder.limit = jest.fn(() => builder);
  builder.lte = jest.fn(() => builder);
  builder.or = jest.fn(() => builder);
  builder.order = jest.fn(() => builder);
  builder.single = jest.fn(async () => finalResult);
  builder.maybeSingle = jest.fn(async () => finalResult);
  builder.then = (resolve) => resolve(finalResult);

  return builder;
}

describe('memories service integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (supabase.rpc as jest.Mock).mockResolvedValue({ data: null, error: null });
  });

  it('rejects empty content on create', async () => {
    const result = await createMemory({
      userId: 'user-1',
      content: '   ',
      memoryDate: '2026-05-24',
      taggedMemberIds: [],
    });

    expect(result.error?.code).toBe('validation_error');
    expect(result.data).toBeNull();
  });

  it('creates text_only memories without starting the illustration pipeline', async () => {
    const memoryRow = {
      id: 'memory-1',
      user_id: 'user-1',
      content: 'Plain note',
      memory_date: '2026-05-24',
      memory_type: 'text_only',
      emotion: null,
      illustration_key: null,
      illustration_status: 'none',
      illustration_prompt: null,
      media_key: null,
      media_content_type: null,
      created_at: '2026-05-24T00:00:00Z',
      updated_at: '2026-05-24T00:00:00Z',
    };

    const memoriesBuilder = createQueryBuilder({ data: memoryRow, error: null });
    const tagsBuilder = createQueryBuilder({ data: [], error: null });

    (supabase.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'memories') {
        return memoriesBuilder;
      }

      if (table === 'memory_family_members') {
        return tagsBuilder;
      }

      throw new Error(`Unexpected table ${table}`);
    });

    const result = await createMemory({
      userId: 'user-1',
      content: 'Plain note',
      memoryDate: '2026-05-24',
      taggedMemberIds: [],
      memoryType: 'text_only',
    });

    expect(result.error).toBeNull();
    expect(memoriesBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        memory_type: 'text_only',
        illustration_status: 'none',
      }),
    );
    expect(generateMemoryIllustration).not.toHaveBeenCalled();
    // text_only memories still get an emotion tag (without an illustration).
    expect(analyzeMemoryEmotion).toHaveBeenCalledWith('memory-1');
  });

  it('creates media memories and rolls back storage on tag failure', async () => {
    const memoryRow = {
      id: 'memory-2',
      user_id: 'user-1',
      content: null,
      memory_date: '2026-05-24',
      memory_type: 'media',
      emotion: null,
      illustration_key: null,
      illustration_status: 'none',
      illustration_prompt: null,
      media_key: 'user-1/memories/memory-2/media.jpg',
      media_content_type: 'image/jpeg',
      created_at: '2026-05-24T00:00:00Z',
      updated_at: '2026-05-24T00:00:00Z',
    };

    const memoriesBuilder = createQueryBuilder({ data: memoryRow, error: null });
    const failingTagsBuilder = createQueryBuilder({
      data: null,
      error: { message: 'tag insert failed' },
    });

    (supabase.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'memories') {
        return memoriesBuilder;
      }

      if (table === 'memory_family_members') {
        return failingTagsBuilder;
      }

      throw new Error(`Unexpected table ${table}`);
    });

    const result = await createMediaMemory({
      userId: 'user-1',
      memoryId: 'memory-2',
      mediaAssets: [{
        objectKey: 'user-1/memories/memory-2/media.jpg',
        contentType: 'image/jpeg',
      }],
      memoryDate: '2026-05-24',
      taggedMemberIds: ['member-1'],
    });

    expect(result.error?.message).toBe('tag insert failed');
    expect(deleteStorageObject).toHaveBeenCalledWith('user-1/memories/memory-2/media.jpg');
    expect(analyzeMemoryEmotion).not.toHaveBeenCalled();
  });

  it('runMediaPhotoEmotionAnalysis invokes analyzeMemoryEmotion', async () => {
    await runMediaPhotoEmotionAnalysis('memory-photo-1');

    expect(analyzeMemoryEmotion).toHaveBeenCalledWith('memory-photo-1');
  });

  it('createMediaMemory does not invoke analyzeMemoryEmotion directly', async () => {
    const memoryRow = {
      id: 'memory-photo-2',
      user_id: 'user-1',
      content: 'Park day',
      memory_date: '2026-05-24',
      memory_type: 'media',
      emotion: null,
      illustration_key: null,
      illustration_status: 'none',
      illustration_prompt: null,
      media_key: 'user-1/memories/memory-photo-2/media.jpg',
      media_content_type: 'image/jpeg',
      created_at: '2026-05-24T00:00:00Z',
      updated_at: '2026-05-24T00:00:00Z',
    };

    const memoriesBuilder = createQueryBuilder({ data: memoryRow, error: null });
    const tagsBuilder = createQueryBuilder({ data: [], error: null });
    const mediaBuilder = createQueryBuilder({
      data: [{
        id: 'asset-1',
        memory_id: 'memory-photo-2',
        object_key: 'user-1/memories/memory-photo-2/media.jpg',
        content_type: 'image/jpeg',
        duration_ms: null,
        position: 0,
        created_at: '2026-05-24T00:00:00Z',
        updated_at: '2026-05-24T00:00:00Z',
      }],
      error: null,
    });

    (supabase.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'memories') {
        return memoriesBuilder;
      }

      if (table === 'memory_family_members') {
        return tagsBuilder;
      }

      if (table === 'memory_media') {
        return mediaBuilder;
      }

      throw new Error(`Unexpected table ${table}`);
    });

    jest.clearAllMocks();

    const result = await createMediaMemory({
      userId: 'user-1',
      memoryId: 'memory-photo-2',
      mediaAssets: [{
        objectKey: 'user-1/memories/memory-photo-2/media.jpg',
        contentType: 'image/jpeg',
      }],
      content: 'Park day',
      memoryDate: '2026-05-24',
      taggedMemberIds: [],
    });

    expect(result.error).toBeNull();
    expect(supabase.rpc).toHaveBeenCalledWith('replace_memory_media_assets', {
      target_memory_id: 'memory-photo-2',
      assets: [{
        objectKey: 'user-1/memories/memory-photo-2/media.jpg',
        contentType: 'image/jpeg',
        durationMs: null,
      }],
    });
    expect(analyzeMemoryEmotion).not.toHaveBeenCalled();
  });

  it('deletes storage keys before deleting a memory row', async () => {
    const fetchBuilder = createQueryBuilder({
      data: {
        media_key: 'user-1/memories/memory-3/media.mp4',
        illustration_key: null,
      },
      error: null,
    });
    const deleteBuilder = createQueryBuilder({ data: null, error: null });
    const mediaBuilder = createQueryBuilder({
      data: [{
        id: 'asset-1',
        memory_id: 'memory-3',
        object_key: 'user-1/memories/memory-3/media/asset-1.jpg',
        content_type: 'image/jpeg',
        duration_ms: null,
        position: 1,
        created_at: '2026-05-24T00:00:00Z',
        updated_at: '2026-05-24T00:00:00Z',
      }],
      error: null,
    });

    let memoriesCall = 0;
    (supabase.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'memories') {
        memoriesCall += 1;
        return memoriesCall === 1 ? fetchBuilder : deleteBuilder;
      }

      if (table === 'memory_media') {
        return mediaBuilder;
      }

      throw new Error(`Unexpected table ${table}`);
    });

    const result = await deleteMemory('memory-3');

    expect(result.error).toBeNull();
    expect(deleteStorageObject).toHaveBeenCalledWith('user-1/memories/memory-3/media.mp4');
    expect(deleteStorageObject).toHaveBeenCalledWith('user-1/memories/memory-3/media/asset-1.jpg');
  });

  it('regenerates illustration for ready illustrated memories', async () => {
    const fetchBuilder = createQueryBuilder({
      data: {
        memory_type: 'text_illustration',
        illustration_status: 'ready',
        updated_at: '2026-05-24T00:00:00Z',
      },
      error: null,
    });
    const updateBuilder = createQueryBuilder({ data: null, error: null });

    let memoriesCall = 0;
    (supabase.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'memories') {
        memoriesCall += 1;
        return memoriesCall === 1 ? fetchBuilder : updateBuilder;
      }

      throw new Error(`Unexpected table ${table}`);
    });

    const result = await regenerateMemoryIllustration('memory-ready');

    expect(result.error).toBeNull();
    expect(updateBuilder.update).toHaveBeenCalledWith({ illustration_status: 'pending' });
    expect(analyzeMemoryEmotion).not.toHaveBeenCalled();
    expect(generateMemoryIllustration).toHaveBeenCalledWith('memory-ready', undefined, {
      forceRegenerate: true,
    });
  });

  it('restarts illustration regeneration while generation is in progress', async () => {
    const fetchBuilder = createQueryBuilder({
      data: {
        memory_type: 'text_illustration',
        illustration_status: 'generating',
        updated_at: new Date().toISOString(),
      },
      error: null,
    });
    const updateBuilder = createQueryBuilder({ data: null, error: null });

    let memoriesCall = 0;
    (supabase.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'memories') {
        memoriesCall += 1;
        return memoriesCall === 1 ? fetchBuilder : updateBuilder;
      }

      throw new Error(`Unexpected table ${table}`);
    });

    const result = await regenerateMemoryIllustration('memory-busy');

    expect(result.error).toBeNull();
    expect(updateBuilder.update).toHaveBeenCalledWith({ illustration_status: 'pending' });
    expect(analyzeMemoryEmotion).not.toHaveBeenCalled();
    expect(generateMemoryIllustration).toHaveBeenCalledWith('memory-busy', undefined, {
      forceRegenerate: true,
    });
  });

  it('marks illustration failed when generate-illustration returns an error', async () => {
    const updateBuilder = createQueryBuilder({ data: null, error: null });

    (supabase.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'memories') {
        return updateBuilder;
      }

      throw new Error(`Unexpected table ${table}`);
    });

    (generateMemoryIllustration as jest.Mock).mockResolvedValueOnce({
      error: { message: 'Illustration generation timed out', code: 'generation_timeout' },
    });

    const result = await runMemoryIllustrationPipeline('memory-timeout', { forceRegenerate: true });

    expect(result?.code).toBe('generation_timeout');
    expect(updateBuilder.update).toHaveBeenCalledWith({ illustration_status: 'failed' });
  });

  it('rejects illustration retry for non-illustrated memories', async () => {
    const fetchBuilder = createQueryBuilder({
      data: { memory_type: 'media' },
      error: null,
    });

    (supabase.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'memories') {
        return fetchBuilder;
      }

      throw new Error(`Unexpected table ${table}`);
    });

    const result = await retryMemoryIllustration('memory-4');

    expect(result.error?.code).toBe('invalid_memory_type');
  });

  it('fetchMemories returns tagged members', async () => {
    const memoriesBuilder = createQueryBuilder({
      data: [
        {
          id: 'memory-1',
          user_id: 'user-1',
          content: 'Hello',
          memory_date: '2026-05-24',
          memory_type: 'text_illustration',
          emotion: null,
          illustration_key: null,
          illustration_status: 'pending',
          illustration_prompt: null,
          media_key: null,
          media_content_type: null,
          created_at: '2026-05-24T00:00:00Z',
          updated_at: '2026-05-24T00:00:00Z',
        },
      ],
      error: null,
    });

    const tagsBuilder = createQueryBuilder({
      data: [
        {
          memory_id: 'memory-1',
          family_members: {
            id: 'member-1',
            name: 'Emma',
          },
        },
      ],
      error: null,
    });
    const mediaBuilder = createQueryBuilder({ data: [], error: null });

    (supabase.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'memories') {
        return memoriesBuilder;
      }

      if (table === 'memory_family_members') {
        return tagsBuilder;
      }

      if (table === 'memory_media') {
        return mediaBuilder;
      }

      throw new Error(`Unexpected table ${table}`);
    });

    const { data, error } = await fetchMemories();

    expect(error).toBeNull();
    expect(data?.[0]?.taggedMembers).toHaveLength(1);
    expect(data?.[0]?.taggedMembers[0]?.name).toBe('Emma');
  });

  it('fetchOldestMemoryDate loads only the earliest memory date', async () => {
    const memoriesBuilder = createQueryBuilder({
      data: { memory_date: '2024-01-09' },
      error: null,
    });

    (supabase.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'memories') {
        return memoriesBuilder;
      }

      throw new Error(`Unexpected table ${table}`);
    });

    const { data, error } = await fetchOldestMemoryDate();

    expect(error).toBeNull();
    expect(data).toBe('2024-01-09');
    expect(memoriesBuilder.select).toHaveBeenCalledWith('memory_date');
    expect(memoriesBuilder.order).toHaveBeenCalledWith('memory_date', { ascending: true });
    expect(memoriesBuilder.limit).toHaveBeenCalledWith(1);
  });

  it('fetchMemoriesInDateRange bounds calendar preview rows by memory_date', async () => {
    const memoriesBuilder = createQueryBuilder({
      data: [
        {
          id: 'memory-range-1',
          user_id: 'user-1',
          content: 'Windowed memory',
          memory_date: '2026-05-24',
          memory_type: 'media',
          emotion: 'joy',
          illustration_key: null,
          illustration_status: 'none',
          illustration_prompt: null,
          media_key: 'user-1/memories/memory-range-1/media.jpg',
          media_content_type: 'image/jpeg',
          created_at: '2026-05-24T00:00:00Z',
          updated_at: '2026-05-24T00:00:00Z',
        },
      ],
      error: null,
    });
    const mediaBuilder = createQueryBuilder({
      data: [
        {
          id: 'asset-1',
          memory_id: 'memory-range-1',
          object_key: 'user-1/memories/memory-range-1/media.jpg',
          content_type: 'image/jpeg',
          duration_ms: null,
          position: 0,
          created_at: '2026-05-24T00:00:00Z',
          updated_at: '2026-05-24T00:00:00Z',
        },
      ],
      error: null,
    });

    (supabase.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'memories') {
        return memoriesBuilder;
      }

      if (table === 'memory_media') {
        return mediaBuilder;
      }

      throw new Error(`Unexpected table ${table}`);
    });

    const { data, error } = await fetchMemoriesInDateRange('2026-05-01', '2026-05-31');

    expect(error).toBeNull();
    expect(memoriesBuilder.gte).toHaveBeenCalledWith('memory_date', '2026-05-01');
    expect(memoriesBuilder.lte).toHaveBeenCalledWith('memory_date', '2026-05-31');
    expect(data?.[0]?.id).toBe('memory-range-1');
    expect(data?.[0]?.mediaAssets).toHaveLength(1);
    expect(data?.[0]?.taggedMembers).toEqual([]);
  });
});
