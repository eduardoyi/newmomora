import { supabase } from '@/lib/supabase';
import type { Database } from '@/types/database';
import {
  analyzeMemoryEmotion,
  generateMemoryIllustration,
} from '@/services/ai';
import { deleteStorageObject } from '@/services/media';
import {
  type CreateMediaMemoryInput,
  type MemoryMediaAssetInput,
  type CreateMemoryInput,
  type MemoryType,
  type UpdateMemoryInput,
  validateMemoryContent,
  validateMemoryDate,
  validateMemoryMediaAssets,
  validateIllustrationMemberLimit,
  validateTaggedMembers,
  isIllustrationGenerationStale,
} from '@/utils/memories';

export type Memory = Database['public']['Tables']['memories']['Row'];
export type FamilyMember = Database['public']['Tables']['family_members']['Row'];

export interface MemoryMediaAsset {
  id: string;
  memory_id: string;
  object_key: string;
  content_type: string;
  duration_ms: number | null;
  aspect_ratio: number | null;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface MemoryWithTags extends Memory {
  taggedMembers: FamilyMember[];
  mediaAssets: MemoryMediaAsset[];
  likeCount: number;
  commentCount: number;
  likedByMe: boolean;
}

export interface ServiceError {
  message: string;
  code?: string;
}

// Keep PostgREST `.in(...)` URLs comfortably below proxy/request-line limits.
// A full family timeline can contain hundreds of memories; sending every UUID
// in one enrichment request produced ~27 KB URLs and HTTP 400 responses.
const MEMORY_RELATION_BATCH_SIZE = 100;

function chunkMemoryIds(memoryIds: string[]): string[][] {
  const chunks: string[][] = [];

  for (let index = 0; index < memoryIds.length; index += MEMORY_RELATION_BATCH_SIZE) {
    chunks.push(memoryIds.slice(index, index + MEMORY_RELATION_BATCH_SIZE));
  }

  return chunks;
}

function mapSupabaseError(error: { message: string; code?: string }): ServiceError {
  return {
    message: error.message,
    code: error.code,
  };
}

async function fetchTagsForMemories(memoryIds: string[]): Promise<Map<string, FamilyMember[]>> {
  if (memoryIds.length === 0) {
    return new Map();
  }

  const batchResults = await Promise.all(
    chunkMemoryIds(memoryIds).map(async (memoryIdBatch) => {
      const { data, error } = await supabase
        .from('memory_family_members')
        .select('memory_id, family_members(*)')
        .in('memory_id', memoryIdBatch);

      if (error) {
        throw mapSupabaseError(error);
      }

      return data ?? [];
    }),
  );

  const rows = batchResults.flat();

  const tagMap = new Map<string, FamilyMember[]>();

  for (const row of rows) {
    const member = row.family_members as FamilyMember | null;
    if (!member) {
      continue;
    }

    const existing = tagMap.get(row.memory_id) ?? [];
    existing.push(member);
    tagMap.set(row.memory_id, existing);
  }

  return tagMap;
}

function attachTags(memories: Memory[], tagMap: Map<string, FamilyMember[]>): MemoryWithTags[] {
  return memories.map((memory) => ({
    ...memory,
    taggedMembers: tagMap.get(memory.id) ?? [],
    mediaAssets: [],
    likeCount: 0,
    commentCount: 0,
    likedByMe: false,
  }));
}

function attachCalendarPreviewTags(memories: Memory[]): MemoryWithTags[] {
  return memories.map((memory) => ({
    ...memory,
    taggedMembers: [],
    mediaAssets: [],
    likeCount: 0,
    commentCount: 0,
    likedByMe: false,
  }));
}

interface MemoryEngagementRow {
  memory_id: string;
  like_count: number | string;
  comment_count: number | string;
  liked_by_me: boolean;
}

async function fetchEngagementForMemories(
  memoryIds: string[],
): Promise<Map<string, Omit<MemoryEngagementRow, 'memory_id'>>> {
  if (memoryIds.length === 0) {
    return new Map();
  }

  const batchResults = await Promise.all(
    chunkMemoryIds(memoryIds).map(async (memoryIdBatch) => {
      const { data, error } = await supabase.rpc('get_memory_engagement', {
        memory_ids: memoryIdBatch,
      });

      if (error) {
        throw mapSupabaseError(error);
      }

      return (data ?? []) as MemoryEngagementRow[];
    }),
  );

  return new Map(
    batchResults
      .flat()
      .map(({ memory_id, ...engagement }) => [memory_id, engagement]),
  );
}

function attachEngagement(
  memories: MemoryWithTags[],
  engagementMap: Map<string, Omit<MemoryEngagementRow, 'memory_id'>>,
): MemoryWithTags[] {
  return memories.map((memory) => {
    const engagement = engagementMap.get(memory.id);
    return {
      ...memory,
      likeCount: Number(engagement?.like_count ?? 0),
      commentCount: Number(engagement?.comment_count ?? 0),
      likedByMe: engagement?.liked_by_me ?? false,
    };
  });
}

function attachMediaAssets(
  memories: MemoryWithTags[],
  mediaMap: Map<string, MemoryMediaAsset[]>,
): MemoryWithTags[] {
  return memories.map((memory) => ({
    ...memory,
    mediaAssets: mediaMap.get(memory.id) ?? buildLegacyMediaAssets(memory),
  }));
}

function buildLegacyMediaAssets(memory: Memory): MemoryMediaAsset[] {
  if (memory.memory_type !== 'media' || !memory.media_key || !memory.media_content_type) {
    return [];
  }

  return [
    {
      id: `${memory.id}-legacy-media`,
      memory_id: memory.id,
      object_key: memory.media_key,
      content_type: memory.media_content_type,
      duration_ms: null,
      aspect_ratio: null,
      position: 0,
      created_at: memory.created_at,
      updated_at: memory.updated_at,
    },
  ];
}

function normalizeOptionalContent(content?: string): string | null {
  const trimmed = content?.trim();
  return trimmed ? trimmed : null;
}

async function deleteStorageKeys(keys: string[]) {
  const uniqueKeys = [...new Set(keys.filter(Boolean))];

  for (const objectKey of uniqueKeys) {
    const { error } = await deleteStorageObject(objectKey);
    if (error) {
      console.warn('Failed to delete storage object', objectKey, error.message);
    }
  }
}

async function deleteMemoryStorageKeys(
  memory: Pick<Memory, 'media_key' | 'illustration_key'>,
  mediaAssets: Pick<MemoryMediaAsset, 'object_key'>[] = [],
) {
  await deleteStorageKeys([
    memory.media_key,
    memory.illustration_key,
    ...mediaAssets.map((asset) => asset.object_key),
  ].filter(Boolean) as string[]);
}

async function fetchMediaForMemories(memoryIds: string[]): Promise<Map<string, MemoryMediaAsset[]>> {
  if (memoryIds.length === 0) {
    return new Map();
  }

  const batchResults = await Promise.all(
    chunkMemoryIds(memoryIds).map(async (memoryIdBatch) => {
      const { data, error } = await (supabase as any)
        .from('memory_media')
        .select('*')
        .in('memory_id', memoryIdBatch)
        .order('position', { ascending: true });

      if (error) {
        throw mapSupabaseError(error);
      }

      return (data ?? []) as MemoryMediaAsset[];
    }),
  );

  const rows: MemoryMediaAsset[] = batchResults.flat();

  const mediaMap = new Map<string, MemoryMediaAsset[]>();

  for (const row of rows) {
    const existing = mediaMap.get(row.memory_id) ?? [];
    existing.push(row);
    mediaMap.set(row.memory_id, existing);
  }

  return mediaMap;
}

function mediaAssetsToRpcPayload(assets: MemoryMediaAssetInput[]) {
  return assets.map((asset) => ({
    objectKey: asset.objectKey,
    contentType: asset.contentType,
    durationMs: asset.durationMs ?? null,
    aspectRatio: asset.aspectRatio ?? null,
  }));
}

async function replaceMemoryMediaAssets(
  memoryId: string,
  mediaAssets: MemoryMediaAssetInput[],
): Promise<ServiceError | null> {
  const mediaError = validateMemoryMediaAssets(mediaAssets);
  if (mediaError) {
    return { message: mediaError, code: 'validation_error' };
  }

  const { error } = await (supabase as any).rpc('replace_memory_media_assets', {
    target_memory_id: memoryId,
    assets: mediaAssetsToRpcPayload(mediaAssets),
  });

  if (error) {
    return mapSupabaseError(error);
  }

  return null;
}

export async function fetchMemories(): Promise<{
  data: MemoryWithTags[] | null;
  error: ServiceError | null;
}> {
  const { data, error } = await supabase
    .from('memories')
    .select('*')
    .order('memory_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) {
    return { data: null, error: mapSupabaseError(error) };
  }

  const memories = data ?? [];
  const memoryIds = memories.map((memory) => memory.id);
  const [tagMap, mediaMap, engagementMap] = await Promise.all([
    fetchTagsForMemories(memoryIds),
    fetchMediaForMemories(memoryIds),
    fetchEngagementForMemories(memoryIds),
  ]);

  return {
    data: attachEngagement(
      attachMediaAssets(attachTags(memories, tagMap), mediaMap),
      engagementMap,
    ),
    error: null,
  };
}

export async function fetchOldestMemoryDate(): Promise<{
  data: string | null;
  error: ServiceError | null;
}> {
  const { data, error } = await supabase
    .from('memories')
    .select('memory_date')
    .order('memory_date', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    return { data: null, error: mapSupabaseError(error) };
  }

  return { data: data?.memory_date ?? null, error: null };
}

export async function fetchMemoriesInDateRange(
  startDate: string,
  endDate: string,
): Promise<{
  data: MemoryWithTags[] | null;
  error: ServiceError | null;
}> {
  const startDateError = validateMemoryDate(startDate);
  const endDateError = validateMemoryDate(endDate);

  if (startDateError || endDateError) {
    return {
      data: null,
      error: {
        message: startDateError ?? endDateError ?? 'Invalid date range',
        code: 'validation_error',
      },
    };
  }

  if (startDate > endDate) {
    return {
      data: null,
      error: { message: 'Start date must be before end date', code: 'validation_error' },
    };
  }

  const { data, error } = await supabase
    .from('memories')
    .select('*')
    .gte('memory_date', startDate)
    .lte('memory_date', endDate)
    .order('memory_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) {
    return { data: null, error: mapSupabaseError(error) };
  }

  const memories = data ?? [];
  const memoryIds = memories.map((memory) => memory.id);
  const mediaMap = await fetchMediaForMemories(memoryIds);

  return { data: attachMediaAssets(attachCalendarPreviewTags(memories), mediaMap), error: null };
}

export async function fetchMemoryById(memoryId: string): Promise<{
  data: MemoryWithTags | null;
  error: ServiceError | null;
}> {
  const { data, error } = await supabase.from('memories').select('*').eq('id', memoryId).maybeSingle();

  if (error) {
    return { data: null, error: mapSupabaseError(error) };
  }

  if (!data) {
    return { data: null, error: null };
  }

  const [tagMap, mediaMap, engagementMap] = await Promise.all([
    fetchTagsForMemories([memoryId]),
    fetchMediaForMemories([memoryId]),
    fetchEngagementForMemories([memoryId]),
  ]);
  return {
    data: attachEngagement(
      attachMediaAssets(attachTags([data], tagMap), mediaMap),
      engagementMap,
    )[0],
    error: null,
  };
}

export async function searchMemories(query: string): Promise<{
  data: MemoryWithTags[] | null;
  error: ServiceError | null;
}> {
  const trimmed = query.trim();

  if (!trimmed) {
    return fetchMemories();
  }

  const { data, error } = await supabase
    .from('memories')
    .select('*')
    .or(`content.ilike.%${trimmed.replace(/[%_]/g, '')}%,emotion.ilike.%${trimmed.replace(/[%_]/g, '')}%`)
    .order('memory_date', { ascending: false });

  if (error) {
    return { data: null, error: mapSupabaseError(error) };
  }

  const memories = data ?? [];
  const memoryIds = memories.map((memory) => memory.id);
  const [tagMap, mediaMap, engagementMap] = await Promise.all([
    fetchTagsForMemories(memoryIds),
    fetchMediaForMemories(memoryIds),
    fetchEngagementForMemories(memoryIds),
  ]);
  return {
    data: attachEngagement(
      attachMediaAssets(attachTags(memories, tagMap), mediaMap),
      engagementMap,
    ),
    error: null,
  };
}

async function replaceMemoryTags(memoryId: string, taggedMemberIds: string[]): Promise<ServiceError | null> {
  const { error: deleteError } = await supabase
    .from('memory_family_members')
    .delete()
    .eq('memory_id', memoryId);

  if (deleteError) {
    return mapSupabaseError(deleteError);
  }

  if (taggedMemberIds.length === 0) {
    return null;
  }

  const { error: insertError } = await supabase.from('memory_family_members').insert(
    taggedMemberIds.map((familyMemberId) => ({
      memory_id: memoryId,
      family_member_id: familyMemberId,
    })),
  );

  if (insertError) {
    return mapSupabaseError(insertError);
  }

  return null;
}

interface MemoryIllustrationPipelineOptions {
  forceRegenerate?: boolean;
}

export async function markMemoryIllustrationFailed(memoryId: string): Promise<void> {
  const { error } = await supabase
    .from('memories')
    .update({ illustration_status: 'failed' })
    .eq('id', memoryId)
    .in('illustration_status', ['pending', 'generating']);

  if (error) {
    console.warn('markMemoryIllustrationFailed', memoryId, error.message);
  }
}

// The analyze-emotion edge function enforces a short cooldown per memory, so an
// immediate retry would be rejected. Wait past that window before trying again.
const EMOTION_RETRY_DELAY_MS = 6000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Analyze emotion with a single background retry. If both attempts fail the
// emotion is left empty rather than forced to a default.
async function analyzeEmotionWithRetry(
  memoryId: string,
): Promise<Awaited<ReturnType<typeof analyzeMemoryEmotion>>> {
  const first = await analyzeMemoryEmotion(memoryId);
  if (!first.error) {
    return first;
  }

  console.warn('analyze-emotion failed, retrying', memoryId, first.error.message);
  await delay(EMOTION_RETRY_DELAY_MS);

  const second = await analyzeMemoryEmotion(memoryId);
  if (second.error) {
    console.warn('analyze-emotion retry failed', memoryId, second.error.message);
  }

  return second;
}

export async function runMemoryIllustrationPipeline(
  memoryId: string,
  options?: MemoryIllustrationPipelineOptions,
): Promise<ServiceError | null> {
  try {
    let colorPalette: string | undefined;

    if (options?.forceRegenerate) {
      const { error: fetchError } = await supabase
        .from('memories')
        .select('emotion')
        .eq('id', memoryId)
        .maybeSingle();

      if (fetchError) {
        return mapSupabaseError(fetchError);
      }
    } else {
      const { data: emotionData } = await analyzeEmotionWithRetry(memoryId);
      colorPalette = emotionData?.colorPalette;
    }

    const { error: illustrationError } = await generateMemoryIllustration(
      memoryId,
      colorPalette,
      { forceRegenerate: options?.forceRegenerate },
    );

    if (illustrationError) {
      console.warn('generate-illustration failed', memoryId, illustrationError.message);
      await markMemoryIllustrationFailed(memoryId);
      return illustrationError;
    }

    return null;
  } catch (error) {
    console.warn(
      'illustration pipeline failed',
      memoryId,
      error instanceof Error ? error.message : 'unknown',
    );

    await markMemoryIllustrationFailed(memoryId);

    return {
      message: error instanceof Error ? error.message : 'Illustration pipeline failed',
      code: 'pipeline_failed',
    };
  }
}

// Both analysis runners resolve with the detected emotion (null when analysis
// failed) so callers can patch the affected memory in cache directly instead
// of invalidating and refetching entire memory lists.
export async function runMediaPhotoEmotionAnalysis(memoryId: string): Promise<string | null> {
  const { data } = await analyzeEmotionWithRetry(memoryId);
  return data?.emotion ?? null;
}

export async function runTextOnlyEmotionAnalysis(memoryId: string): Promise<string | null> {
  const { data } = await analyzeEmotionWithRetry(memoryId);
  return data?.emotion ?? null;
}

export async function createMemory(input: CreateMemoryInput): Promise<{
  data: MemoryWithTags | null;
  error: ServiceError | null;
}> {
  const memoryType: MemoryType = input.memoryType ?? 'text_illustration';

  const contentError = validateMemoryContent(input.content, memoryType);
  if (contentError) {
    return { data: null, error: { message: contentError, code: 'validation_error' } };
  }

  const dateError = validateMemoryDate(input.memoryDate);
  if (dateError) {
    return { data: null, error: { message: dateError, code: 'validation_error' } };
  }

  const tagError = validateTaggedMembers(input.taggedMemberIds);
  if (tagError) {
    return { data: null, error: { message: tagError, code: 'validation_error' } };
  }

  if (memoryType === 'text_illustration') {
    const illustrationMemberError = validateIllustrationMemberLimit(input.taggedMemberIds);
    if (illustrationMemberError) {
      return {
        data: null,
        error: { message: illustrationMemberError, code: 'illustration_member_limit' },
      };
    }
  }

  const illustrationStatus = memoryType === 'text_illustration' ? 'pending' : 'none';

  const { data: memory, error } = await supabase
    .from('memories')
    .insert({
      user_id: input.userId,
      family_id: input.familyId,
      content: normalizeOptionalContent(input.content),
      memory_date: input.memoryDate,
      memory_type: memoryType,
      illustration_status: illustrationStatus,
    })
    .select('*')
    .single();

  if (error || !memory) {
    return { data: null, error: mapSupabaseError(error ?? { message: 'Memory was not created' }) };
  }

  const tagsError = await replaceMemoryTags(memory.id, input.taggedMemberIds);
  if (tagsError) {
    await supabase.from('memories').delete().eq('id', memory.id);
    return { data: null, error: tagsError };
  }

  if (memoryType === 'text_illustration') {
    void runMemoryIllustrationPipeline(memory.id);
  } else if (memoryType === 'text_only') {
    void runTextOnlyEmotionAnalysis(memory.id);
  }

  const tagMap = await fetchTagsForMemories([memory.id]);
  return { data: attachTags([memory], tagMap)[0], error: null };
}

export async function createMediaMemory(input: CreateMediaMemoryInput): Promise<{
  data: MemoryWithTags | null;
  error: ServiceError | null;
}> {
  const contentError = validateMemoryContent(input.content, 'media');
  if (contentError) {
    return { data: null, error: { message: contentError, code: 'validation_error' } };
  }

  const dateError = validateMemoryDate(input.memoryDate);
  if (dateError) {
    return { data: null, error: { message: dateError, code: 'validation_error' } };
  }

  const tagError = validateTaggedMembers(input.taggedMemberIds);
  if (tagError) {
    return { data: null, error: { message: tagError, code: 'validation_error' } };
  }

  const mediaError = validateMemoryMediaAssets(input.mediaAssets);
  if (mediaError) {
    return { data: null, error: { message: mediaError, code: 'validation_error' } };
  }

  const coverAsset = input.mediaAssets[0];

  const { data: memory, error } = await supabase
    .from('memories')
    .insert({
      id: input.memoryId,
      user_id: input.userId,
      family_id: input.familyId,
      content: normalizeOptionalContent(input.content),
      memory_date: input.memoryDate,
      memory_type: 'media',
      media_key: coverAsset.objectKey,
      media_content_type: coverAsset.contentType,
      illustration_status: 'none',
    })
    .select('*')
    .single();

  if (error || !memory) {
    await deleteStorageKeys(input.mediaAssets.map((asset) => asset.objectKey));
    return { data: null, error: mapSupabaseError(error ?? { message: 'Memory was not created' }) };
  }

  const mediaReplaceError = await replaceMemoryMediaAssets(memory.id, input.mediaAssets);
  if (mediaReplaceError) {
    await supabase.from('memories').delete().eq('id', memory.id);
    await deleteStorageKeys(input.mediaAssets.map((asset) => asset.objectKey));
    return { data: null, error: mediaReplaceError };
  }

  const tagsError = await replaceMemoryTags(memory.id, input.taggedMemberIds);
  if (tagsError) {
    await supabase.from('memories').delete().eq('id', memory.id);
    await deleteStorageKeys(input.mediaAssets.map((asset) => asset.objectKey));
    return { data: null, error: tagsError };
  }

  const tagMap = await fetchTagsForMemories([memory.id]);
  const mediaMap = await fetchMediaForMemories([memory.id]);
  return { data: attachMediaAssets(attachTags([memory], tagMap), mediaMap)[0], error: null };
}

export async function updateMemory(
  memoryId: string,
  input: UpdateMemoryInput,
): Promise<{ data: MemoryWithTags | null; error: ServiceError | null }> {
  const { data: existingMemory, error: existingError } = await supabase
    .from('memories')
    .select('content, memory_type, illustration_key, illustration_status')
    .eq('id', memoryId)
    .maybeSingle();

  if (existingError) {
    return { data: null, error: mapSupabaseError(existingError) };
  }

  if (!existingMemory) {
    return { data: null, error: { message: 'Memory not found', code: 'not_found' } };
  }

  const existingMemoryType = existingMemory.memory_type as MemoryType;
  const memoryType = input.memoryType ?? existingMemoryType;

  if (
    (existingMemoryType === 'media' && memoryType !== 'media') ||
    (existingMemoryType !== 'media' && memoryType === 'media')
  ) {
    return {
      data: null,
      error: {
        message: 'Media memories cannot be converted to or from text memories',
        code: 'invalid_memory_type',
      },
    };
  }

  if (input.content !== undefined || memoryType !== existingMemoryType) {
    const contentError = validateMemoryContent(
      input.content ?? existingMemory.content,
      memoryType,
    );
    if (contentError) {
      return { data: null, error: { message: contentError, code: 'validation_error' } };
    }
  }

  if (input.memoryDate !== undefined) {
    const dateError = validateMemoryDate(input.memoryDate);
    if (dateError) {
      return { data: null, error: { message: dateError, code: 'validation_error' } };
    }
  }

  if (input.taggedMemberIds !== undefined) {
    const tagError = validateTaggedMembers(input.taggedMemberIds);
    if (tagError) {
      return { data: null, error: { message: tagError, code: 'validation_error' } };
    }

    if (memoryType === 'text_illustration') {
      const illustrationMemberError = validateIllustrationMemberLimit(input.taggedMemberIds);
      if (illustrationMemberError) {
        return {
          data: null,
          error: { message: illustrationMemberError, code: 'illustration_member_limit' },
        };
      }
    }
  }

  let existingMediaAssets: MemoryMediaAsset[] = [];
  if (input.mediaAssets !== undefined) {
    if (memoryType !== 'media') {
      return {
        data: null,
        error: {
          message: 'Media attachments can only be updated for media memories',
          code: 'invalid_memory_type',
        },
      };
    }

    const mediaError = validateMemoryMediaAssets(input.mediaAssets);
    if (mediaError) {
      return { data: null, error: { message: mediaError, code: 'validation_error' } };
    }

    existingMediaAssets = (await fetchMediaForMemories([memoryId])).get(memoryId) ?? [];
  }

  const updates: Partial<Memory> = {};

  if (input.content !== undefined) {
    updates.content = normalizeOptionalContent(input.content);
  }

  if (input.memoryDate !== undefined) {
    updates.memory_date = input.memoryDate;
  }

  const isDisablingIllustration =
    existingMemoryType === 'text_illustration' && memoryType === 'text_only';
  const isEnablingIllustration =
    existingMemoryType === 'text_only' && memoryType === 'text_illustration';
  const hasRetainedIllustration = Boolean(existingMemory.illustration_key);
  const isIllustrationInProgress = ['pending', 'generating'].includes(
    existingMemory.illustration_status,
  );
  const shouldStartIllustration =
    isEnablingIllustration && !hasRetainedIllustration && !isIllustrationInProgress;

  // Switch to text-only before replacing tags so the DB permits an unlimited
  // tag set. Illustration columns are deliberately retained and merely hidden
  // by memory_type, allowing the user to reveal the same image later.
  if (isDisablingIllustration) {
    updates.memory_type = 'text_only';
  }

  if (Object.keys(updates).length > 0) {
    const { error } = await supabase.from('memories').update(updates).eq('id', memoryId);

    if (error) {
      return { data: null, error: mapSupabaseError(error) };
    }
  }

  if (input.taggedMemberIds !== undefined) {
    const tagsError = await replaceMemoryTags(memoryId, input.taggedMemberIds);
    if (tagsError) {
      return { data: null, error: tagsError };
    }
  }

  // Replace tags while the row is still text-only, then enable illustration.
  // This keeps the conditional DB limit valid throughout the update.
  if (isEnablingIllustration) {
    const illustrationUpdates: Partial<Memory> = {
      memory_type: 'text_illustration',
    };

    if (shouldStartIllustration) {
      illustrationUpdates.illustration_status = 'pending';
    }

    const { error } = await supabase
      .from('memories')
      .update(illustrationUpdates)
      .eq('id', memoryId);

    if (error) {
      return { data: null, error: mapSupabaseError(error) };
    }
  }

  if (input.mediaAssets !== undefined) {
    const mediaReplaceError = await replaceMemoryMediaAssets(memoryId, input.mediaAssets);
    if (mediaReplaceError) {
      return { data: null, error: mediaReplaceError };
    }

    const nextKeys = new Set(input.mediaAssets.map((asset) => asset.objectKey));
    const removedKeys = existingMediaAssets
      .map((asset) => asset.object_key)
      .filter((key) => !nextKeys.has(key));
    await deleteStorageKeys(removedKeys);
  }

  const result = await fetchMemoryById(memoryId);

  if (!result.error && shouldStartIllustration) {
    void runMemoryIllustrationPipeline(memoryId);
  }

  return result;
}

export async function deleteMemory(memoryId: string): Promise<{ error: ServiceError | null }> {
  const { data: memory, error: fetchError } = await supabase
    .from('memories')
    .select('media_key, illustration_key')
    .eq('id', memoryId)
    .maybeSingle();

  if (fetchError) {
    return { error: mapSupabaseError(fetchError) };
  }

  if (memory) {
    const mediaAssets = (await fetchMediaForMemories([memoryId])).get(memoryId) ?? [];
    await deleteMemoryStorageKeys(memory, mediaAssets);
  }

  const { error } = await supabase.from('memories').delete().eq('id', memoryId);

  if (error) {
    return { error: mapSupabaseError(error) };
  }

  return { error: null };
}

export async function retryMemoryIllustration(memoryId: string): Promise<{ error: ServiceError | null }> {
  const { data: memory, error: fetchError } = await supabase
    .from('memories')
    .select('memory_type, illustration_status, updated_at')
    .eq('id', memoryId)
    .maybeSingle();

  if (fetchError) {
    return { error: mapSupabaseError(fetchError) };
  }

  if (!memory) {
    return { error: { message: 'Memory not found', code: 'not_found' } };
  }

  if (memory.memory_type !== 'text_illustration') {
    return {
      error: {
        message: 'Illustration retry is only available for illustrated memories',
        code: 'invalid_memory_type',
      },
    };
  }

  if (memory.illustration_status === 'ready') {
    return { error: null };
  }

  const forceRegenerate = memory.illustration_status === 'generating';

  if (
    memory.illustration_status === 'generating' &&
    !isIllustrationGenerationStale(memory)
  ) {
    return { error: null };
  }

  await supabase.from('memories').update({ illustration_status: 'pending' }).eq('id', memoryId);
  void runMemoryIllustrationPipeline(memoryId, { forceRegenerate });
  return { error: null };
}

export async function regenerateMemoryIllustration(
  memoryId: string,
): Promise<{ error: ServiceError | null }> {
  const { data: memory, error: fetchError } = await supabase
    .from('memories')
    .select('memory_type, illustration_status, updated_at')
    .eq('id', memoryId)
    .maybeSingle();

  if (fetchError) {
    return { error: mapSupabaseError(fetchError) };
  }

  if (!memory) {
    return { error: { message: 'Memory not found', code: 'not_found' } };
  }

  if (memory.memory_type !== 'text_illustration') {
    return {
      error: {
        message: 'Illustration regeneration is only available for illustrated memories',
        code: 'invalid_memory_type',
      },
    };
  }

  const { error: updateError } = await supabase
    .from('memories')
    .update({ illustration_status: 'pending' })
    .eq('id', memoryId);

  if (updateError) {
    return { error: mapSupabaseError(updateError) };
  }

  const pipelineError = await runMemoryIllustrationPipeline(memoryId, { forceRegenerate: true });
  return { error: pipelineError };
}
