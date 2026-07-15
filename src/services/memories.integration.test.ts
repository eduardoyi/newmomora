import {
  createMediaMemory,
  createMemory,
  deleteMemory,
  fetchMemoriesInDateRange,
  fetchMemoriesPage,
  fetchMemoriesPageForMember,
  fetchMemoryById,
  fetchMemoryGenerationStatuses,
  fetchOldestMemoryDate,
  regenerateMemoryIllustration,
  retryMemoryIllustration,
  runMemoryIllustrationPipeline,
  runMediaPhotoEmotionAnalysis,
  searchMemories,
  updateMemory,
  MEMORIES_PAGE_SIZE,
  MEMORIES_SEARCH_LIMIT,
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
  builder.textSearch = jest.fn(() => builder);
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

  it('rejects more than six tags only when creating an illustrated memory', async () => {
    const result = await createMemory({
      userId: 'user-1',
      familyId: 'family-1',
      content: 'The whole family gathered.',
      memoryDate: '2026-07-14',
      taggedMemberIds: Array.from({ length: 7 }, (_, index) => `member-${index}`),
      memoryType: 'text_illustration',
    });

    expect(result.error?.code).toBe('illustration_member_limit');
    expect(supabase.from).not.toHaveBeenCalled();
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
        aspectRatio: null,
        previewObjectKey: null,
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
        preview_object_key: 'user-1/memories/memory-3/media/asset-1-preview.jpg',
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
    // Workstream C5: the derived preview must be cleaned up alongside its
    // original, not just left as an orphan.
    expect(deleteStorageObject).toHaveBeenCalledWith(
      'user-1/memories/memory-3/media/asset-1-preview.jpg',
    );
  });

  it('rolls back both the original and preview keys when createMediaMemory fails after upload', async () => {
    const failingTagsBuilder = createQueryBuilder({
      data: null,
      error: { message: 'tag insert failed' },
    });
    const memoriesBuilder = createQueryBuilder({
      data: {
        id: 'memory-preview-rollback',
        media_key: 'user-1/memories/memory-preview-rollback/media/asset-1.jpg',
        media_content_type: 'image/jpeg',
      },
      error: null,
    });

    (supabase.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'memories') return memoriesBuilder;
      if (table === 'memory_family_members') return failingTagsBuilder;
      throw new Error(`Unexpected table ${table}`);
    });

    const result = await createMediaMemory({
      userId: 'user-1',
      memoryId: 'memory-preview-rollback',
      mediaAssets: [
        {
          objectKey: 'user-1/memories/memory-preview-rollback/media/asset-1.jpg',
          previewObjectKey: 'user-1/memories/memory-preview-rollback/media/asset-1-preview.jpg',
          contentType: 'image/jpeg',
        },
      ],
      memoryDate: '2026-05-24',
      taggedMemberIds: ['member-1'],
    });

    expect(result.error?.message).toBe('tag insert failed');
    expect(deleteStorageObject).toHaveBeenCalledWith(
      'user-1/memories/memory-preview-rollback/media/asset-1.jpg',
    );
    expect(deleteStorageObject).toHaveBeenCalledWith(
      'user-1/memories/memory-preview-rollback/media/asset-1-preview.jpg',
    );
  });

  it('deletes the preview alongside the original for a media asset removed on edit', async () => {
    const existingBuilder = createQueryBuilder({
      data: {
        content: null,
        memory_type: 'media',
        illustration_key: null,
        illustration_status: 'none',
      },
      error: null,
    });
    const mediaBuilder = createQueryBuilder({
      data: [
        {
          id: 'asset-kept',
          memory_id: 'memory-edit-preview',
          object_key: 'user-1/memories/memory-edit-preview/media/asset-kept.jpg',
          preview_object_key: 'user-1/memories/memory-edit-preview/media/asset-kept-preview.jpg',
          content_type: 'image/jpeg',
          duration_ms: null,
          position: 0,
          created_at: '2026-05-24T00:00:00Z',
          updated_at: '2026-05-24T00:00:00Z',
        },
        {
          id: 'asset-removed',
          memory_id: 'memory-edit-preview',
          object_key: 'user-1/memories/memory-edit-preview/media/asset-removed.jpg',
          preview_object_key:
            'user-1/memories/memory-edit-preview/media/asset-removed-preview.jpg',
          content_type: 'image/jpeg',
          duration_ms: null,
          position: 1,
          created_at: '2026-05-24T00:00:00Z',
          updated_at: '2026-05-24T00:00:00Z',
        },
      ],
      error: null,
    });
    const detailBuilder = createQueryBuilder({
      data: {
        id: 'memory-edit-preview',
        memory_type: 'media',
        media_key: 'user-1/memories/memory-edit-preview/media/asset-kept.jpg',
        media_content_type: 'image/jpeg',
        illustration_key: null,
        illustration_status: 'none',
        created_at: '2026-05-24T00:00:00Z',
        updated_at: '2026-05-24T00:00:00Z',
      },
      error: null,
    });
    const tagsBuilder = createQueryBuilder({ data: [], error: null });

    let memoriesCall = 0;
    (supabase.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'memories') {
        memoriesCall += 1;
        return memoriesCall === 1 ? existingBuilder : detailBuilder;
      }
      if (table === 'memory_media') return mediaBuilder;
      if (table === 'memory_family_members') return tagsBuilder;
      throw new Error(`Unexpected table ${table}`);
    });

    const result = await updateMemory('memory-edit-preview', {
      mediaAssets: [
        {
          objectKey: 'user-1/memories/memory-edit-preview/media/asset-kept.jpg',
          previewObjectKey: 'user-1/memories/memory-edit-preview/media/asset-kept-preview.jpg',
          contentType: 'image/jpeg',
        },
      ],
    });

    expect(result.error).toBeNull();
    expect(deleteStorageObject).toHaveBeenCalledWith(
      'user-1/memories/memory-edit-preview/media/asset-removed.jpg',
    );
    expect(deleteStorageObject).toHaveBeenCalledWith(
      'user-1/memories/memory-edit-preview/media/asset-removed-preview.jpg',
    );
    expect(deleteStorageObject).not.toHaveBeenCalledWith(
      'user-1/memories/memory-edit-preview/media/asset-kept.jpg',
    );
    expect(deleteStorageObject).not.toHaveBeenCalledWith(
      'user-1/memories/memory-edit-preview/media/asset-kept-preview.jpg',
    );
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

  it('switches an illustrated memory to text-only without clearing its illustration', async () => {
    const existingBuilder = createQueryBuilder({
      data: {
        content: 'An illustrated memory',
        memory_type: 'text_illustration',
        illustration_key: 'user-1/memories/memory-hide/illustration.webp',
        illustration_status: 'ready',
      },
      error: null,
    });
    const disableBuilder = createQueryBuilder({ data: null, error: null });
    const detailBuilder = createQueryBuilder({
      data: {
        id: 'memory-hide',
        content: 'An illustrated memory',
        memory_date: '2026-07-14',
        memory_type: 'text_only',
        illustration_key: 'user-1/memories/memory-hide/illustration.webp',
        illustration_status: 'ready',
        media_key: null,
        media_content_type: null,
        created_at: '2026-07-14T00:00:00Z',
        updated_at: '2026-07-14T00:00:00Z',
      },
      error: null,
    });
    const tagsBuilder = createQueryBuilder({ data: [], error: null });
    const mediaBuilder = createQueryBuilder({ data: [], error: null });

    let memoriesCall = 0;
    (supabase.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'memories') {
        memoriesCall += 1;
        return [existingBuilder, disableBuilder, detailBuilder][memoriesCall - 1];
      }
      if (table === 'memory_family_members') return tagsBuilder;
      if (table === 'memory_media') return mediaBuilder;
      throw new Error(`Unexpected table ${table}`);
    });

    const result = await updateMemory('memory-hide', {
      memoryType: 'text_only',
    });

    expect(result.error).toBeNull();
    expect(disableBuilder.update).toHaveBeenCalledWith({
      memory_type: 'text_only',
    });
    expect(disableBuilder.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        illustration_key: expect.anything(),
        illustration_status: expect.anything(),
      }),
    );
    expect(analyzeMemoryEmotion).not.toHaveBeenCalled();
    expect(generateMemoryIllustration).not.toHaveBeenCalled();
  });

  it('starts generation when a text-only memory is switched to illustrated', async () => {
    const existingBuilder = createQueryBuilder({
      data: {
        content: 'A plain memory',
        memory_type: 'text_only',
        illustration_key: null,
        illustration_status: 'none',
      },
      error: null,
    });
    const enableBuilder = createQueryBuilder({ data: null, error: null });
    const detailMemory = {
      id: 'memory-enable-ai',
      content: 'A plain memory',
      memory_date: '2026-07-14',
      memory_type: 'text_illustration',
      illustration_key: null,
      illustration_status: 'pending',
      media_key: null,
      media_content_type: null,
      created_at: '2026-07-14T00:00:00Z',
      updated_at: '2026-07-14T00:00:00Z',
    };
    const detailBuilder = createQueryBuilder({ data: detailMemory, error: null });
    const tagsBuilder = createQueryBuilder({ data: [], error: null });
    const mediaBuilder = createQueryBuilder({ data: [], error: null });

    let memoriesCall = 0;
    (supabase.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'memories') {
        memoriesCall += 1;
        return [existingBuilder, enableBuilder, detailBuilder][memoriesCall - 1];
      }
      if (table === 'memory_family_members') return tagsBuilder;
      if (table === 'memory_media') return mediaBuilder;
      throw new Error(`Unexpected table ${table}`);
    });

    const result = await updateMemory('memory-enable-ai', {
      memoryType: 'text_illustration',
      taggedMemberIds: ['one', 'two', 'three', 'four', 'five', 'six'],
    });

    expect(result.error).toBeNull();
    expect(enableBuilder.update).toHaveBeenCalledWith({
      memory_type: 'text_illustration',
      illustration_status: 'pending',
    });
    expect(analyzeMemoryEmotion).toHaveBeenCalledWith('memory-enable-ai');
  });

  it('reveals a retained illustration without generating a replacement', async () => {
    const existingBuilder = createQueryBuilder({
      data: {
        content: 'A hidden illustrated memory',
        memory_type: 'text_only',
        illustration_key: 'user-1/memories/memory-retained/illustration.webp',
        illustration_status: 'ready',
      },
      error: null,
    });
    const enableBuilder = createQueryBuilder({ data: null, error: null });
    const detailBuilder = createQueryBuilder({
      data: {
        id: 'memory-retained',
        content: 'A hidden illustrated memory',
        memory_date: '2026-07-14',
        memory_type: 'text_illustration',
        illustration_key: 'user-1/memories/memory-retained/illustration.webp',
        illustration_status: 'ready',
        media_key: null,
        media_content_type: null,
        created_at: '2026-07-14T00:00:00Z',
        updated_at: '2026-07-14T00:00:00Z',
      },
      error: null,
    });
    const tagsBuilder = createQueryBuilder({ data: [], error: null });
    const mediaBuilder = createQueryBuilder({ data: [], error: null });

    let memoriesCall = 0;
    (supabase.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'memories') {
        memoriesCall += 1;
        return [existingBuilder, enableBuilder, detailBuilder][memoriesCall - 1];
      }
      if (table === 'memory_family_members') return tagsBuilder;
      if (table === 'memory_media') return mediaBuilder;
      throw new Error(`Unexpected table ${table}`);
    });

    const result = await updateMemory('memory-retained', {
      memoryType: 'text_illustration',
      taggedMemberIds: [],
    });

    expect(result.error).toBeNull();
    expect(enableBuilder.update).toHaveBeenCalledWith({
      memory_type: 'text_illustration',
    });
    expect(analyzeMemoryEmotion).not.toHaveBeenCalled();
    expect(generateMemoryIllustration).not.toHaveBeenCalled();
  });

  it('fetchMemoriesPage returns tagged members', async () => {
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
    (supabase.rpc as jest.Mock).mockResolvedValueOnce({
      data: [
        {
          memory_id: 'memory-1',
          like_count: 4,
          comment_count: 2,
          liked_by_me: true,
        },
      ],
      error: null,
    });

    const { data, error } = await fetchMemoriesPage({});

    expect(error).toBeNull();
    expect(data?.memories[0]?.taggedMembers).toHaveLength(1);
    expect(data?.memories[0]?.taggedMembers[0]?.name).toBe('Emma');
    expect(data?.memories[0]).toMatchObject({ likeCount: 4, commentCount: 2, likedByMe: true });
  });

  it('fetchMemoryById enriches a single memory with tags and media', async () => {
    const memoriesBuilder = createQueryBuilder({
      data: {
        id: 'memory-1',
        user_id: 'user-1',
        content: 'Hello',
        memory_date: '2026-05-24',
        memory_type: 'media',
        emotion: null,
        illustration_key: null,
        illustration_status: 'none',
        illustration_prompt: null,
        media_key: 'user-1/memories/memory-1/media.jpg',
        media_content_type: 'image/jpeg',
        created_at: '2026-05-24T00:00:00Z',
        updated_at: '2026-05-24T00:00:00Z',
      },
      error: null,
    });
    const tagsBuilder = createQueryBuilder({
      data: [
        {
          memory_id: 'memory-1',
          family_members: { id: 'member-1', name: 'Emma' },
        },
      ],
      error: null,
    });
    const mediaBuilder = createQueryBuilder({
      data: [
        {
          id: 'asset-1',
          memory_id: 'memory-1',
          object_key: 'user-1/memories/memory-1/media.jpg',
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

      if (table === 'memory_family_members') {
        return tagsBuilder;
      }

      if (table === 'memory_media') {
        return mediaBuilder;
      }

      throw new Error(`Unexpected table ${table}`);
    });

    const { data, error } = await fetchMemoryById('memory-1');

    expect(error).toBeNull();
    expect(data?.id).toBe('memory-1');
    expect(data?.taggedMembers[0]?.name).toBe('Emma');
    expect(data?.mediaAssets[0]?.object_key).toBe('user-1/memories/memory-1/media.jpg');
  });

  it('fetchMemoriesPage batches tag and media enrichment for large timelines', async () => {
    const memoryRows = Array.from({ length: 205 }, (_, index) => ({
      id: `memory-${index}`,
      user_id: 'user-1',
      content: null,
      memory_date: '2026-05-24',
      memory_type: 'media',
      emotion: null,
      illustration_key: null,
      illustration_status: 'none',
      illustration_prompt: null,
      media_key: `user-1/memories/memory-${index}/media.jpg`,
      media_content_type: 'image/jpeg',
      created_at: '2026-05-24T00:00:00Z',
      updated_at: '2026-05-24T00:00:00Z',
    }));
    const memoriesBuilder = createQueryBuilder({ data: memoryRows, error: null });
    const tagBuilders: ReturnType<typeof createQueryBuilder>[] = [];
    const mediaBuilders: ReturnType<typeof createQueryBuilder>[] = [];

    (supabase.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'memories') {
        return memoriesBuilder;
      }

      if (table === 'memory_family_members') {
        const builder = createQueryBuilder({ data: [], error: null });
        tagBuilders.push(builder);
        return builder;
      }

      if (table === 'memory_media') {
        const builder = createQueryBuilder({ data: [], error: null });
        mediaBuilders.push(builder);
        return builder;
      }

      throw new Error(`Unexpected table ${table}`);
    });

    const { data, error } = await fetchMemoriesPage({ limit: 205 });

    expect(error).toBeNull();
    expect(data?.memories).toHaveLength(205);
    expect(tagBuilders).toHaveLength(3);
    expect(mediaBuilders).toHaveLength(3);
    expect(tagBuilders.map((builder) => builder.in.mock.calls[0]?.[1])).toEqual([
      memoryRows.slice(0, 100).map((memory) => memory.id),
      memoryRows.slice(100, 200).map((memory) => memory.id),
      memoryRows.slice(200).map((memory) => memory.id),
    ]);
    expect(mediaBuilders.map((builder) => builder.in.mock.calls[0]?.[1])).toEqual([
      memoryRows.slice(0, 100).map((memory) => memory.id),
      memoryRows.slice(100, 200).map((memory) => memory.id),
      memoryRows.slice(200).map((memory) => memory.id),
    ]);
    expect((supabase.rpc as jest.Mock).mock.calls.map((call) => call[1]?.memory_ids)).toEqual([
      memoryRows.slice(0, 100).map((memory) => memory.id),
      memoryRows.slice(100, 200).map((memory) => memory.id),
      memoryRows.slice(200).map((memory) => memory.id),
    ]);
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

  describe('fetchMemoriesPage (Workstream A1)', () => {
    function memoryRow(overrides: Record<string, unknown> = {}) {
      return {
        id: 'memory-1',
        user_id: 'user-1',
        content: 'Hello',
        memory_date: '2026-05-24',
        memory_type: 'text_only',
        emotion: null,
        illustration_key: null,
        illustration_status: 'none',
        illustration_prompt: null,
        media_key: null,
        media_content_type: null,
        created_at: '2026-05-24T00:00:00.000Z',
        updated_at: '2026-05-24T00:00:00.000Z',
        ...overrides,
      };
    }

    function mockEnrichmentTables(memoriesBuilder: ReturnType<typeof createQueryBuilder>) {
      (supabase.from as jest.Mock).mockImplementation((table: string) => {
        if (table === 'memories') {
          return memoriesBuilder;
        }
        if (table === 'memory_family_members' || table === 'memory_media') {
          return createQueryBuilder({ data: [], error: null });
        }
        throw new Error(`Unexpected table ${table}`);
      });
    }

    it('does not apply a keyset filter on the first page', async () => {
      const memoriesBuilder = createQueryBuilder({ data: [memoryRow()], error: null });
      mockEnrichmentTables(memoriesBuilder);

      const { data, error } = await fetchMemoriesPage({ limit: MEMORIES_PAGE_SIZE });

      expect(error).toBeNull();
      expect(memoriesBuilder.or).not.toHaveBeenCalled();
      expect(memoriesBuilder.limit).toHaveBeenCalledWith(MEMORIES_PAGE_SIZE);
      expect(data?.memories).toHaveLength(1);
    });

    it('builds a keyset .or() predicate matching (memory_date desc, created_at desc), URL-safe timestamp included', async () => {
      const memoriesBuilder = createQueryBuilder({ data: [], error: null });
      mockEnrichmentTables(memoriesBuilder);

      // Real ISO timestamp fixture (with the +00:00-equivalent 'Z' suffix) --
      // per the plan's risk note, verify supabase-js's .or() call receives the
      // exact cursor values it needs to URL-encode, not a mangled string.
      await fetchMemoriesPage({
        cursor: { memoryDate: '2026-05-20', createdAt: '2026-05-20T08:30:00.000Z' },
        limit: 40,
      });

      expect(memoriesBuilder.or).toHaveBeenCalledWith(
        'memory_date.lt.2026-05-20,' +
          'and(memory_date.eq.2026-05-20,created_at.lt.2026-05-20T08:30:00.000Z)',
      );
    });

    it('returns a nextCursor from the last row when a full page comes back', async () => {
      const rows = [
        memoryRow({ id: 'memory-1', memory_date: '2026-05-24', created_at: '2026-05-24T02:00:00.000Z' }),
        memoryRow({ id: 'memory-2', memory_date: '2026-05-23', created_at: '2026-05-23T02:00:00.000Z' }),
      ];
      const memoriesBuilder = createQueryBuilder({ data: rows, error: null });
      mockEnrichmentTables(memoriesBuilder);

      const { data } = await fetchMemoriesPage({ limit: 2 });

      expect(data?.nextCursor).toEqual({ memoryDate: '2026-05-23', createdAt: '2026-05-23T02:00:00.000Z' });
    });

    it('returns a null nextCursor when the page comes back short of the limit', async () => {
      const memoriesBuilder = createQueryBuilder({ data: [memoryRow()], error: null });
      mockEnrichmentTables(memoriesBuilder);

      const { data } = await fetchMemoriesPage({ limit: 40 });

      expect(data?.nextCursor).toBeNull();
    });
  });

  describe('fetchMemoriesPageForMember (Workstream A6)', () => {
    it('inner-joins memory_family_members and strips the join column from the returned rows', async () => {
      const memoriesBuilder = createQueryBuilder({
        data: [
          {
            id: 'memory-1',
            user_id: 'user-1',
            content: 'Hello',
            memory_date: '2026-05-24',
            memory_type: 'text_only',
            emotion: null,
            illustration_key: null,
            illustration_status: 'none',
            illustration_prompt: null,
            media_key: null,
            media_content_type: null,
            created_at: '2026-05-24T00:00:00.000Z',
            updated_at: '2026-05-24T00:00:00.000Z',
            memory_family_members: { family_member_id: 'member-1' },
          },
        ],
        error: null,
      });

      (supabase.from as jest.Mock).mockImplementation((table: string) => {
        if (table === 'memories') {
          return memoriesBuilder;
        }
        if (table === 'memory_family_members' || table === 'memory_media') {
          return createQueryBuilder({ data: [], error: null });
        }
        throw new Error(`Unexpected table ${table}`);
      });

      const { data, error } = await fetchMemoriesPageForMember('member-1', { limit: 40 });

      expect(error).toBeNull();
      expect(memoriesBuilder.select).toHaveBeenCalledWith(
        '*, memory_family_members!inner(family_member_id)',
      );
      expect(memoriesBuilder.eq).toHaveBeenCalledWith(
        'memory_family_members.family_member_id',
        'member-1',
      );
      expect(data?.memories[0]).not.toHaveProperty('memory_family_members');
      expect(data?.memories[0]?.id).toBe('memory-1');
    });
  });

  describe('searchMemories (Workstream E1b/E2/E3)', () => {
    function searchMemoryRow(overrides: Record<string, unknown> = {}) {
      return {
        id: 'memory-1',
        user_id: 'user-1',
        content: 'Bedtime stories',
        memory_date: '2026-05-24',
        created_at: '2026-05-24T00:00:00.000Z',
        memory_type: 'text_only',
        emotion: null,
        illustration_key: null,
        illustration_status: 'none',
        illustration_prompt: null,
        media_key: null,
        media_content_type: null,
        updated_at: '2026-05-24T00:00:00.000Z',
        ...overrides,
      };
    }

    it('returns an empty result without querying for a blank/whitespace query', async () => {
      const { data, error } = await searchMemories('   ');

      expect(error).toBeNull();
      expect(data).toEqual([]);
      expect(supabase.from).not.toHaveBeenCalled();
    });

    it('runs a websearch full-text query on content, capped at the search limit, and drops fetchMemories entirely', async () => {
      const contentBuilder = createQueryBuilder({ data: [searchMemoryRow()], error: null });
      let fromMemoriesCallCount = 0;

      (supabase.from as jest.Mock).mockImplementation((table: string) => {
        if (table === 'memories') {
          fromMemoriesCallCount += 1;
          return contentBuilder;
        }
        if (table === 'memory_family_members' || table === 'memory_media') {
          return createQueryBuilder({ data: [], error: null });
        }
        throw new Error(`Unexpected table ${table}`);
      });

      const { data, error } = await searchMemories('  bedtime  ');

      expect(error).toBeNull();
      // Trimmed, not stripped/escaped the way the old ILIKE arm mangled it --
      // `websearch_to_tsquery` parsing handles free text safely, no manual
      // `%`/`_` stripping needed.
      expect(contentBuilder.textSearch).toHaveBeenCalledWith('content', 'bedtime', {
        type: 'websearch',
        config: 'english',
      });
      expect(contentBuilder.limit).toHaveBeenCalledWith(MEMORIES_SEARCH_LIMIT);
      // 'bedtime' isn't a known emotion label, so only the content query runs.
      expect(fromMemoriesCallCount).toBe(1);
      expect(data?.[0]?.id).toBe('memory-1');
    });

    it('OR-merges a known emotion label with the content search, deduping overlapping rows', async () => {
      const contentBuilder = createQueryBuilder({
        data: [searchMemoryRow({ id: 'memory-1', emotion: 'joy' })],
        error: null,
      });
      const emotionBuilder = createQueryBuilder({
        data: [
          searchMemoryRow({ id: 'memory-1', emotion: 'joy' }),
          searchMemoryRow({ id: 'memory-2', content: 'Playground afternoon', emotion: 'joy' }),
        ],
        error: null,
      });
      const memoriesBuilders = [contentBuilder, emotionBuilder];
      let callIndex = 0;

      (supabase.from as jest.Mock).mockImplementation((table: string) => {
        if (table === 'memories') {
          return memoriesBuilders[callIndex++] ?? contentBuilder;
        }
        if (table === 'memory_family_members' || table === 'memory_media') {
          return createQueryBuilder({ data: [], error: null });
        }
        throw new Error(`Unexpected table ${table}`);
      });

      const { data, error } = await searchMemories('Joy');

      expect(error).toBeNull();
      expect(emotionBuilder.eq).toHaveBeenCalledWith('emotion', 'joy');
      expect(emotionBuilder.limit).toHaveBeenCalledWith(MEMORIES_SEARCH_LIMIT);
      // memory-1 matched both arms -- deduped to a single row, not duplicated.
      expect(data).toHaveLength(2);
      expect(data?.map((memory) => memory.id).sort()).toEqual(['memory-1', 'memory-2']);
    });

    it('does not run an emotion query when the term is not a known emotion label', async () => {
      const contentBuilder = createQueryBuilder({ data: [], error: null });
      (supabase.from as jest.Mock).mockImplementation((table: string) => {
        if (table === 'memories') {
          return contentBuilder;
        }
        if (table === 'memory_family_members' || table === 'memory_media') {
          return createQueryBuilder({ data: [], error: null });
        }
        throw new Error(`Unexpected table ${table}`);
      });

      await searchMemories('stroller');

      expect(contentBuilder.eq).not.toHaveBeenCalled();
    });
  });

  describe('fetchMemoryGenerationStatuses (Workstream A5)', () => {
    it('short-circuits without a request for an empty id list', async () => {
      const { data, error } = await fetchMemoryGenerationStatuses([]);

      expect(error).toBeNull();
      expect(data).toEqual([]);
      expect(supabase.from).not.toHaveBeenCalled();
    });

    it('selects only the generation-status columns for the given ids', async () => {
      const memoriesBuilder = createQueryBuilder({
        data: [
          {
            id: 'memory-1',
            illustration_status: 'ready',
            illustration_key: 'user-1/memories/memory-1/illustration.webp',
            emotion: 'joy',
            updated_at: '2026-05-24T00:00:00.000Z',
          },
        ],
        error: null,
      });
      (supabase.from as jest.Mock).mockImplementation((table: string) => {
        if (table === 'memories') {
          return memoriesBuilder;
        }
        throw new Error(`Unexpected table ${table}`);
      });

      const { data, error } = await fetchMemoryGenerationStatuses(['memory-1']);

      expect(error).toBeNull();
      expect(memoriesBuilder.select).toHaveBeenCalledWith(
        'id, illustration_status, illustration_key, emotion, updated_at',
      );
      expect(memoriesBuilder.in).toHaveBeenCalledWith('id', ['memory-1']);
      expect(data).toHaveLength(1);
      expect(data?.[0]).toMatchObject({ id: 'memory-1', illustration_status: 'ready' });
    });
  });
});
