import type { ArtworkPiece } from '@/components/artwork/artwork-pieces';
import { deckLayout } from '@/components/artwork/artwork-layout';
import { pickFrameStyle } from '@/components/artwork/frame-style';
import type { MemoryMediaAsset, MemoryWithTags } from '@/services/memories';

// Shared builders for the artwork card / deck tests.

export function artworkAsset(index: number, overrides: Partial<MemoryMediaAsset> = {}): MemoryMediaAsset {
  return {
    id: `asset-${index}`,
    memory_id: 'memory-1',
    object_key: `user-1/memories/memory-1/media/asset-${index}.jpg`,
    preview_object_key: `user-1/memories/memory-1/media/asset-${index}-preview.jpg`,
    content_type: 'image/jpeg',
    duration_ms: null,
    aspect_ratio: 0.75,
    position: index,
    share_card_key: null,
    waveform: null,
    created_at: '2026-10-10T00:00:00.000Z',
    updated_at: '2026-10-10T00:00:00.000Z',
    ...overrides,
  } as MemoryMediaAsset;
}

export function artworkMemory(
  assetCount: number,
  overrides: Record<string, unknown> = {},
): MemoryWithTags {
  return {
    id: 'memory-1',
    user_id: 'user-1',
    family_id: 'family-1',
    content: 'A dragon for Daddy',
    memory_date: '2026-10-10',
    memory_type: 'media',
    media_variant: 'artwork',
    artwork_medium: 'crayon',
    emotion: 'joy',
    illustration_key: null,
    illustration_status: 'none',
    illustration_prompt: null,
    media_key: null,
    media_content_type: null,
    link_previews: {},
    created_at: '2026-10-10T00:00:00.000Z',
    updated_at: '2026-10-10T00:00:00.000Z',
    taggedMembers: [
      {
        id: 'member-1',
        name: 'Mara',
        date_of_birth: '2024-10-01',
        profile_picture_key: null,
        illustrated_profile_key: null,
        illustrated_profile_status: 'ready',
      },
    ],
    mediaAssets: Array.from({ length: assetCount }, (_, index) => artworkAsset(index + 1)),
    likeCount: 0,
    commentCount: 0,
    likedByMe: false,
    myReaction: null,
    topReactions: [],
    ...overrides,
  } as unknown as MemoryWithTags;
}

export function artworkTestPieces(count: number): ArtworkPiece[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `asset-${index + 1}`,
    displayKey: `user-1/memories/memory-1/media/asset-${index + 1}-preview.jpg`,
    ratio: 0.75,
    ...pickFrameStyle(`asset-${index + 1}`),
  }));
}

export function artworkTestDeckLayout(count: number) {
  return deckLayout(358, Array.from({ length: count }, () => 0.75));
}
