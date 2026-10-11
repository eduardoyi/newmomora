import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import { ARTWORK_NAIL_HEIGHT, getArtworkFrameSize } from '@/components/artwork-frame';
import { frameBodyBounds, frameVisualBounds } from '@/components/artwork/artwork-bounds';
import { artworkRatio } from '@/components/artwork/artwork-layout';
import type { ArtworkUrlErrorHandler } from '@/components/artwork/artwork-piece-image';
import {
  ArtworkPiece,
  artworkFrameKey,
  fitArtWidthToHeight,
} from '@/components/artwork/artwork-piece';
import { DETAIL_TILT_MAX, walkLeanDirection } from '@/components/artwork/frame-style';
import type { MemoryMediaAsset } from '@/services/memories';

// The batch detail view (docs/plans/artwork-scanning-v2.md decision 6): a
// horizontal "gallery walk". A snapping carousel where the current piece is
// centered and the previous / next pieces, frames included, peek in from the
// screen edges. Content padding of (width - spacing) / 2 centers the first and
// last piece, so nothing peeks past either end.

/** Slide pitch as a fraction of the screen width (neighbours peek ~55px at 390). */
export const GALLERY_WALK_SPACING_RATIO = 0.67;
/** Art width as a fraction of the screen width. */
const ART_WIDTH_RATIO = 0.46;
/** Fixed track height; frames are vertically centered in it. */
export const GALLERY_WALK_TRACK_HEIGHT = 420;
/** Gap kept between a frame and the neighbour's frame / track edge. */
const FRAME_MARGIN = 8;
/** Smallest gap between two neighbours' leaning bodies at their closest. */
const NEIGHBOUR_GAP = 8;

export interface GalleryWalkLayout {
  slideSpacing: number;
  sidePadding: number;
  artWidth: number;
  trackHeight: number;
}

export function getGalleryWalkLayout(screenWidth: number): GalleryWalkLayout {
  const slideSpacing = Math.round(screenWidth * GALLERY_WALK_SPACING_RATIO);
  return {
    slideSpacing,
    sidePadding: Math.round((screenWidth - slideSpacing) / 2),
    artWidth: Math.round(screenWidth * ART_WIDTH_RATIO),
    trackHeight: GALLERY_WALK_TRACK_HEIGHT,
  };
}

/** Whether a frame leaning up to DETAIL_TILT_MAX either way (neighbours lean
 * opposite ways, so each one needs its own half of the slide) stays inside its
 * slide horizontally and inside the track vertically. The track clips, and the
 * frame leans about its nail, so the lift above and the swing below count. */
function fitsSlide(layout: GalleryWalkLayout, artWidth: number, aspectRatio: number): boolean {
  const size = getArtworkFrameSize(artWidth, aspectRatio);
  // The slide centers [nail room + frame] in the track.
  const free = (layout.trackHeight - ARTWORK_NAIL_HEIGHT - size.height) / 2;
  if (free < 0) return false;
  for (const tilt of [-DETAIL_TILT_MAX, DETAIL_TILT_MAX]) {
    const body = frameBodyBounds(size.width, size.height, tilt, true);
    const halfExtent = Math.max(size.width / 2 - body.left, body.right - size.width / 2);
    // Converging neighbours (every second pair) meet at their lower corners.
    if (halfExtent > layout.slideSpacing / 2 - NEIGHBOUR_GAP / 2) return false;
    const visual = frameVisualBounds(size.width, size.height, tilt, true);
    if (-visual.top > ARTWORK_NAIL_HEIGHT + free - FRAME_MARGIN / 2) return false;
    if (visual.bottom - size.height > free - FRAME_MARGIN / 2) return false;
  }
  return true;
}

/** Art width for one slide: capped so the leaning frame (nail, string and
 * shadow included) fits both the slide pitch and the track. */
export function getGalleryWalkArtWidth(layout: GalleryWalkLayout, aspectRatio: number): number {
  const maxFrameHeight = layout.trackHeight - ARTWORK_NAIL_HEIGHT - FRAME_MARGIN * 2;
  let artWidth = fitArtWidthToHeight(layout.artWidth, aspectRatio, maxFrameHeight);
  while (artWidth > 1 && !fitsSlide(layout, artWidth, aspectRatio)) {
    artWidth -= 1;
  }
  return artWidth;
}

/** Nearest slide index for a scroll offset, clamped into range. */
export function indexForOffset(offsetX: number, slideSpacing: number, count: number): number {
  if (slideSpacing <= 0 || count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, Math.round(offsetX / slideSpacing)));
}

interface GalleryWalkProps {
  assets: MemoryMediaAsset[];
  /** Signed URLs keyed by `object_key`. */
  urls: Record<string, string>;
  /** Fallback seed for `pickFrameStyle` when an asset has no id. */
  memoryId: string;
  screenWidth: number;
  /** Page to open on (clamped into range). */
  initialIndex?: number;
  /** Fires with the settled page (and once on mount with the initial one). */
  onActiveIndexChange?: (index: number) => void;
  /** Tap on the current piece. */
  onOpen: (index: number) => void;
  onUrlError?: ArtworkUrlErrorHandler;
  onUrlLoad?: ArtworkUrlErrorHandler;
}

export function GalleryWalk({
  assets,
  urls,
  memoryId,
  screenWidth,
  initialIndex = 0,
  onActiveIndexChange,
  onOpen,
  onUrlError,
  onUrlLoad,
}: GalleryWalkProps) {
  const layout = useMemo(() => getGalleryWalkLayout(screenWidth), [screenWidth]);
  // Fitting a leaning frame to its slide is a small search: once per piece.
  const artWidths = useMemo(
    () => assets.map((asset) => getGalleryWalkArtWidth(layout, artworkRatio(asset.aspect_ratio))),
    [assets, layout],
  );
  // Every piece's lean flips from the first piece's seed sign, so neighbours
  // lean opposite ways.
  const firstKey = artworkFrameKey(assets[0], memoryId);
  const startIndex = Math.min(Math.max(Math.trunc(initialIndex) || 0, 0), Math.max(assets.length - 1, 0));
  const [activeIndex, setActiveIndex] = useState(startIndex);
  const listRef = useRef<FlatList<MemoryMediaAsset>>(null);
  const settle = useCallback(
    (index: number) => {
      setActiveIndex(index);
      onActiveIndexChange?.(index);
    },
    [onActiveIndexChange],
  );

  // Report the initial page once so the screen's share target is right even
  // before the first scroll; settle() reports every later change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { onActiveIndexChange?.(startIndex); }, []);

  const handleMomentumEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = indexForOffset(event.nativeEvent.contentOffset.x, layout.slideSpacing, assets.length);
    if (next !== activeIndex) settle(next);
  };

  const goTo = (index: number) => {
    listRef.current?.scrollToIndex({ animated: true, index });
    // The animated scroll's momentum-end is not guaranteed on every platform.
    if (index !== activeIndex) settle(index);
  };

  return (
    <View style={{ height: layout.trackHeight }}>
      <FlatList
        contentContainerStyle={{ paddingHorizontal: layout.sidePadding }}
        data={assets}
        decelerationRate="fast"
        extraData={activeIndex}
        getItemLayout={(_, index) => ({
          index,
          length: layout.slideSpacing,
          offset: layout.slideSpacing * index,
        })}
        horizontal
        initialNumToRender={assets.length}
        initialScrollIndex={startIndex > 0 ? startIndex : undefined}
        keyExtractor={(asset) => asset.id}
        onMomentumScrollEnd={handleMomentumEnd}
        ref={listRef}
        renderItem={({ item, index }) => {
          const isCurrent = index === activeIndex;
          return (
            <View
              style={[
                styles.slide,
                {
                  paddingTop: ARTWORK_NAIL_HEIGHT,
                  width: layout.slideSpacing,
                },
              ]}
            >
              <ArtworkPiece
                accessibilityLabel={
                  isCurrent
                    ? 'View artwork full screen'
                    : `Show piece ${index + 1} of ${assets.length}`
                }
                artWidth={artWidths[index] ?? 1}
                asset={item}
                memoryId={memoryId}
                onPress={isCurrent ? () => onOpen(index) : () => goTo(index)}
                onUrlError={onUrlError}
                onUrlLoad={onUrlLoad}
                leanDirection={walkLeanDirection(firstKey, index)}
                testID={
                  isCurrent
                    ? 'memory-detail-artwork-frame'
                    : `memory-detail-gallery-walk-slide-${index}`
                }
                url={urls[item.object_key]}
              />
            </View>
          );
        }}
        showsHorizontalScrollIndicator={false}
        snapToAlignment="start"
        snapToInterval={layout.slideSpacing}
        testID="memory-detail-gallery-walk"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  slide: {
    alignItems: 'center',
    // Pieces are vertically centered in the fixed track (the nail's room sits
    // above each frame, so the paddingTop is part of what is centered).
    height: GALLERY_WALK_TRACK_HEIGHT,
    justifyContent: 'center',
  },
});
