import type { MemoryMediaAsset, MemoryWithTags } from '@/services/memories';
import { isVideoContentType } from '@/utils/media-validation';

export const LOOKING_BACK_DWELL = {
  intro: 2600,
  illustration: 5600,
  photo: 4600,
  fallbackVideo: 6000,
  textShort: 5600,
  unavailable: 4600,
} as const;

export type LookingBackFrameKind = 'illustration' | 'photo' | 'video' | 'text-short' | 'text-long' | 'unavailable';

export interface LookingBackChapter {
  memory: MemoryWithTags;
  frames: LookingBackFrame[];
  totalDurationMs: number;
}

export interface LookingBackFrame {
  id: string;
  index: number;
  chapterIndex: number;
  assetIndex: number;
  assetCount: number;
  kind: LookingBackFrameKind;
  durationMs: number;
  memory: MemoryWithTags;
  asset?: MemoryMediaAsset;
}

export function wordCount(value: string | null | undefined): number {
  return (value ?? '').trim().split(/\s+/).filter(Boolean).length;
}

export function textDurationMs(content: string | null | undefined): number {
  const words = wordCount(content);
  return words > 45 ? Math.min(16000, 6000 + words * 260) : LOOKING_BACK_DWELL.textShort;
}

export function videoDurationMs(durationMs: number | null | undefined): number {
  return Math.min(9000, Math.max(3500, durationMs ?? LOOKING_BACK_DWELL.fallbackVideo));
}

function buildChapterFrames(memory: MemoryWithTags, chapterIndex: number): LookingBackFrame[] {
  if (memory.memory_type === 'media' && memory.mediaAssets.length > 0) {
    return [...memory.mediaAssets]
      .sort((left, right) => left.position - right.position)
      .map((asset, assetIndex) => {
        const isVideo = isVideoContentType(asset.content_type);
        return {
          id: `${memory.id}:${asset.id}`,
          index: -1,
          chapterIndex,
          assetIndex,
          assetCount: memory.mediaAssets.length,
          kind: isVideo ? 'video' : 'photo',
          durationMs: isVideo ? videoDurationMs(asset.duration_ms) : LOOKING_BACK_DWELL.photo,
          memory,
          asset,
        };
      });
  }

  const hasReadyIllustration = memory.memory_type === 'text_illustration'
    && memory.illustration_status === 'ready'
    && Boolean(memory.illustration_key)
    // LookingBackMemory augments this standard service type after the
    // content-safety selector. Keep the written chapter, never its report-
    // hidden illustration, if the viewer receives that extension.
    && !(memory as MemoryWithTags & { isIllustrationHidden?: boolean }).isIllustrationHidden;
  const isLongText = wordCount(memory.content) > 45;

  return [{
    id: memory.id,
    index: -1,
    chapterIndex,
    assetIndex: 0,
    assetCount: 1,
    kind: hasReadyIllustration ? 'illustration' : isLongText ? 'text-long' : 'text-short',
    durationMs: hasReadyIllustration ? LOOKING_BACK_DWELL.illustration : textDurationMs(memory.content),
    memory,
  }];
}

export function buildLookingBackChapters(memories: MemoryWithTags[]): LookingBackChapter[] {
  let frameIndex = 0;
  return memories.map((memory, chapterIndex) => {
    const frames = buildChapterFrames(memory, chapterIndex).map((frame) => ({ ...frame, index: frameIndex++ }));
    return {
      memory,
      frames,
      totalDurationMs: frames.reduce((total, frame) => total + frame.durationMs, 0),
    };
  });
}

export function flattenLookingBackFrames(chapters: LookingBackChapter[]): LookingBackFrame[] {
  return chapters.flatMap((chapter) => chapter.frames);
}

export interface LookingBackCover<T extends MemoryWithTags> {
  memory: T;
  /** Undefined deliberately means the typographic plate. In particular, a
   * legacy video with no poster is not an expo-image source. */
  mediaAsset?: MemoryMediaAsset;
}

export function lookingBackCover<T extends MemoryWithTags & { isIllustrationHidden?: boolean }>(memories: T[]): LookingBackCover<T> | null {
  const illustration = memories.find((memory) => memory.memory_type === 'text_illustration'
    && memory.illustration_status === 'ready' && memory.illustration_key && !memory.isIllustrationHidden);
  if (illustration) return { memory: illustration };

  // Do not use a video object as an Image source. Choose an ordered photo or
  // an explicitly stored video poster, searching past a legacy no-poster
  // video rather than letting it hide a later usable photo.
  for (const memory of memories) {
    if (memory.memory_type !== 'media') continue;
    const asset = [...memory.mediaAssets]
      .sort((left, right) => left.position - right.position)
      .find((candidate) => !isVideoContentType(candidate.content_type) || Boolean(candidate.preview_object_key));
    if (asset) return { memory, mediaAsset: asset };
  }

  return memories[0] ? { memory: memories[0] } : null;
}

export function lookingBackCoverMemory<T extends MemoryWithTags & { isIllustrationHidden?: boolean }>(memories: T[]): T | null {
  return lookingBackCover(memories)?.memory ?? null;
}
