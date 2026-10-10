import type { FrameKind } from '@/components/artwork/frame-geometry';
import { pickFrameStyle } from '@/components/artwork/frame-style';
import { artworkRatio } from '@/components/artwork/artwork-layout';
import type { MemoryMediaAsset, MemoryWithTags } from '@/services/memories';
import { AGE_PILL_MAX_YEARS, formatAgeFromDob, getAgePartsFromDob } from '@/utils/family-members';
import { toLinkPreviewMap } from '@/utils/links';
import { formatMemoryExcerpt } from '@/utils/memories';
import { resolveMediaDisplayKey } from '@/utils/media-preview';

// What the Timeline artwork card draws, derived once per memory.

export interface ArtworkPiece {
  /** The media asset id (the memory id for a legacy row with no asset). It
   * is the seed for the frame, so a piece wears the same frame on the
   * Timeline and on the detail screen. */
  id: string;
  /** R2 key of the list-sized image, or null when there is none. */
  displayKey: string | null;
  ratio: number;
  kind: FrameKind;
  color: string;
  /** Degrees. */
  tilt: number;
}

/** Takes the parts (not the whole memory) so a card can memoize on the media
 * array and ignore like / comment count patches. */
export function artworkPieces(
  memoryId: string,
  mediaAssets: readonly MemoryMediaAsset[] | null | undefined,
  legacyMediaKey: string | null | undefined,
): ArtworkPiece[] {
  const assets = mediaAssets ?? [];
  if (assets.length === 0) {
    // Legacy single-asset row with no memory_media row: fall back to the
    // memory's own key and id (docs/plans/artwork-scanning-v2.md "Risks").
    return [
      {
        id: memoryId,
        displayKey: legacyMediaKey ?? null,
        ratio: artworkRatio(null),
        ...pickFrameStyle(memoryId),
      },
    ];
  }
  return assets.map((asset) => ({
    id: asset.id,
    displayKey: resolveMediaDisplayKey(asset, true),
    ratio: artworkRatio(asset.aspect_ratio),
    ...pickFrameStyle(asset.id),
  }));
}

export interface ArtworkLabelContent {
  /** Caption as a handwritten title, curly-quoted; null when there is none. */
  title: string | null;
  /** "Artist, age" for the first tagged member; null when nobody is tagged. */
  artist: string | null;
}

const TITLE_MAX_LENGTH = 80;

/** "2 years" / "5 years" / "7 months": the long formatter's leading unit only
 * (no months once a child is a year old), matching the approved mockup. Null
 * for adults, so they show a name only. */
function leadingAge(dateOfBirth: string, referenceDate: Date): string | null {
  const parts = getAgePartsFromDob(dateOfBirth, referenceDate);
  if (!parts || parts.years >= AGE_PILL_MAX_YEARS) return null;
  const leading = formatAgeFromDob(dateOfBirth, referenceDate).split(',')[0].trim();
  if (!leading) return null;
  return leading === 'Newborn' ? 'newborn' : leading;
}

export function artworkLabelContent(memory: MemoryWithTags): ArtworkLabelContent {
  const excerpt = memory.content
    ? formatMemoryExcerpt(memory.content, TITLE_MAX_LENGTH, toLinkPreviewMap(memory.link_previews))
    : '';
  const member = memory.taggedMembers[0];
  let artist: string | null = null;
  if (member) {
    const age = member.date_of_birth
      ? leadingAge(member.date_of_birth, new Date(`${memory.memory_date}T12:00:00`))
      : null;
    artist = age ? `${member.name}, ${age}` : member.name;
  }
  return { title: excerpt ? `“${excerpt}”` : null, artist };
}
