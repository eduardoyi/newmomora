export const MAX_MEMORY_TAGS = 4;

/** Edge image generation can exceed function limits; recover after this window. */
/** Slightly above Supabase Edge ~150s limit so stuck jobs recover quickly. */
export const ILLUSTRATION_GENERATION_STALE_MS = 3 * 60 * 1000;

export type IllustrationStatus = 'none' | 'pending' | 'generating' | 'ready' | 'failed';

export interface IllustrationRecoveryMemory {
  memory_type: string;
  illustration_status: string | null;
  updated_at: string;
}

export type MemoryType = 'text_illustration' | 'text_only' | 'media';

export const MAX_MEMORY_MEDIA_ASSETS = 10;

export interface MemoryMediaAssetInput {
  objectKey: string;
  contentType: string;
  durationMs?: number | null;
}

export interface CreateMemoryInput {
  userId: string;
  content?: string;
  memoryDate: string;
  taggedMemberIds: string[];
  memoryType?: MemoryType;
}

export interface CreateMediaMemoryInput {
  userId: string;
  memoryId: string;
  mediaAssets: MemoryMediaAssetInput[];
  content?: string;
  memoryDate: string;
  taggedMemberIds: string[];
}

export interface UpdateMemoryInput {
  content?: string;
  memoryDate?: string;
  taggedMemberIds?: string[];
  mediaAssets?: MemoryMediaAssetInput[];
}

export function validateMemoryContent(
  content: string | null | undefined,
  memoryType: MemoryType = 'text_illustration',
): string | null {
  if (memoryType === 'media') {
    if (content == null) {
      return null;
    }

    const trimmed = content.trim();
    if (!trimmed) {
      return null;
    }

    if (trimmed.length > 5000) {
      return 'Memory must be 5000 characters or fewer';
    }

    return null;
  }

  const trimmed = (content ?? '').trim();

  if (!trimmed) {
    return 'Memory text is required';
  }

  if (trimmed.length > 5000) {
    return 'Memory must be 5000 characters or fewer';
  }

  return null;
}

export function validateMemoryDate(memoryDate: string): string | null {
  const trimmed = memoryDate.trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return 'Use YYYY-MM-DD format';
  }

  const parsed = new Date(`${trimmed}T00:00:00`);

  if (Number.isNaN(parsed.getTime())) {
    return 'Enter a valid memory date';
  }

  return null;
}

export function validateTaggedMembers(memberIds: string[]): string | null {
  if (memberIds.length > MAX_MEMORY_TAGS) {
    return `You can tag up to ${MAX_MEMORY_TAGS} family members`;
  }

  const uniqueIds = new Set(memberIds);
  if (uniqueIds.size !== memberIds.length) {
    return 'Duplicate family member tags are not allowed';
  }

  return null;
}

export function validateMemoryMediaAssets(assets: MemoryMediaAssetInput[]): string | null {
  if (assets.length === 0) {
    return 'Attach at least one photo or video before saving.';
  }

  if (assets.length > MAX_MEMORY_MEDIA_ASSETS) {
    return `You can attach up to ${MAX_MEMORY_MEDIA_ASSETS} photos or videos`;
  }

  const keys = new Set(assets.map((asset) => asset.objectKey));
  if (keys.size !== assets.length) {
    return 'Duplicate media attachments are not allowed';
  }

  return null;
}

export function isIllustrationGenerationStale(
  memory: Pick<IllustrationRecoveryMemory, 'illustration_status' | 'updated_at'>,
  now = Date.now(),
): boolean {
  if (memory.illustration_status !== 'generating') {
    return false;
  }

  const updatedAt = new Date(memory.updated_at).getTime();
  if (Number.isNaN(updatedAt)) {
    return false;
  }

  return now - updatedAt >= ILLUSTRATION_GENERATION_STALE_MS;
}

export function isIllustrationPendingTooLong(
  memory: Pick<IllustrationRecoveryMemory, 'illustration_status' | 'updated_at'>,
  now = Date.now(),
): boolean {
  if (memory.illustration_status !== 'pending') {
    return false;
  }

  const updatedAt = new Date(memory.updated_at).getTime();
  if (Number.isNaN(updatedAt)) {
    return false;
  }

  return now - updatedAt >= ILLUSTRATION_GENERATION_STALE_MS;
}

export function needsIllustrationRecovery(
  memory: IllustrationRecoveryMemory,
  now = Date.now(),
): boolean {
  if (memory.memory_type !== 'text_illustration') {
    return false;
  }

  if (memory.illustration_status === 'ready' || memory.illustration_status === 'failed') {
    return false;
  }

  return (
    isIllustrationGenerationStale(memory, now) || isIllustrationPendingTooLong(memory, now)
  );
}

export function isIllustrationInProgress(
  status: IllustrationStatus | string | null | undefined,
): boolean {
  return status === 'pending' || status === 'generating';
}

export function getIllustrationStatusLabel(status: IllustrationStatus): string {
  switch (status) {
    case 'none':
      return '';
    case 'pending':
      return 'Illustration pending';
    case 'generating':
      return 'Generating illustration…';
    case 'ready':
      return 'Illustration ready';
    case 'failed':
      return 'Illustration failed';
    default:
      return 'Illustration pending';
  }
}

export function formatMemoryExcerpt(content: string | null | undefined, maxLength = 140): string {
  const trimmed = (content ?? '').trim();
  if (!trimmed) {
    return '';
  }

  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength - 1)}…`;
}

export function formatDisplayDate(dateValue: string): string {
  const parsed = new Date(`${dateValue}T00:00:00`);

  if (Number.isNaN(parsed.getTime())) {
    return dateValue;
  }

  return parsed.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function groupMemoriesByDate<T extends { memory_date: string }>(
  memories: T[],
): Array<{ date: string; items: T[] }> {
  const groups = new Map<string, T[]>();

  for (const memory of memories) {
    const existing = groups.get(memory.memory_date) ?? [];
    existing.push(memory);
    groups.set(memory.memory_date, existing);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => right.localeCompare(left))
    .map(([date, items]) => ({ date, items }));
}

export function getCalendarMonthKey(referenceDate = new Date()): string {
  const year = referenceDate.getFullYear();
  const month = String(referenceDate.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

export function getDaysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

export function deriveMemoryType(input: {
  hasAttachedMedia: boolean;
  illustrationEnabled: boolean;
}): MemoryType {
  if (input.hasAttachedMedia) {
    return 'media';
  }

  return input.illustrationEnabled ? 'text_illustration' : 'text_only';
}

export function formatVideoDurationLabel(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
