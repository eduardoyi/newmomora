import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import { ARTWORK_NAIL_HEIGHT, getArtworkFrameSize } from '@/components/artwork-frame';
import { artworkRatio } from '@/components/artwork/artwork-layout';
import { ArtworkPiece, fitArtWidthToHeight } from '@/components/artwork/artwork-piece';
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

/** Art width for one slide: capped so the frame fits both the slide pitch and the track. */
export function getGalleryWalkArtWidth(layout: GalleryWalkLayout, aspectRatio: number): number {
  const maxFrameHeight = layout.trackHeight - ARTWORK_NAIL_HEIGHT - FRAME_MARGIN * 2;
  const byHeight = fitArtWidthToHeight(layout.artWidth, aspectRatio, maxFrameHeight);
  let artWidth = byHeight;
  while (
    artWidth > 1 &&
    getArtworkFrameSize(artWidth, aspectRatio).width > layout.slideSpacing - FRAME_MARGIN * 2
  ) {
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
  onUrlError?: () => void;
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
}: GalleryWalkProps) {
  const layout = useMemo(() => getGalleryWalkLayout(screenWidth), [screenWidth]);
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
                artWidth={getGalleryWalkArtWidth(layout, artworkRatio(item.aspect_ratio))}
                asset={item}
                memoryId={memoryId}
                onPress={isCurrent ? () => onOpen(index) : () => goTo(index)}
                onUrlError={onUrlError}
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
