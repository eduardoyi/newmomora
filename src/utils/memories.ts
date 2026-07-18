import { substituteLinkLabels, type LinkPreviewMap } from '@/utils/links';

export const MAX_ILLUSTRATION_MEMBERS = 6;

/**
 * Backstop for a worker that dies before its 120-second pre-finalization deadline can
 * clear the claim. Manager clients recover stale rows on their next load.
 */
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
  aspectRatio?: number | null;
  /**
   * Derived preview key (Workstream C). Omitted/null is valid -- the
   * `replace_memory_media_assets` RPC preserves an existing row's preview
   * key when the incoming value is null and `objectKey` matches.
   */
  previewObjectKey?: string | null;
}

export interface CreateMemoryInput {
  userId: string;
  familyId: string;
  content?: string;
  memoryDate: string;
  taggedMemberIds: string[];
  memoryType?: MemoryType;
}

export interface CreateMediaMemoryInput {
  userId: string;
  familyId: string;
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
  memoryType?: MemoryType;
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
  const uniqueIds = new Set(memberIds);
  if (uniqueIds.size !== memberIds.length) {
    return 'Duplicate family member tags are not allowed';
  }

  return null;
}

export function validateIllustrationMemberLimit(memberIds: string[]): string | null {
  if (memberIds.length > MAX_ILLUSTRATION_MEMBERS) {
    return `AI illustrations support up to ${MAX_ILLUSTRATION_MEMBERS} family members`;
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

  if (
    assets.some(
      (asset) =>
        asset.aspectRatio != null &&
        (!Number.isFinite(asset.aspectRatio) || asset.aspectRatio < 0.1 || asset.aspectRatio > 10),
    )
  ) {
    return 'Media aspect ratio is invalid';
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

export function formatMemoryExcerpt(
  content: string | null | undefined,
  maxLength = 140,
  linkPreviews?: LinkPreviewMap | null,
): string {
  const substituted = linkPreviews !== undefined ? substituteLinkLabels(content, linkPreviews) : (content ?? '');
  const trimmed = substituted.trim();
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
): { date: string; items: T[] }[] {
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
