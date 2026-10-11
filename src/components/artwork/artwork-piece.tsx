import { Image } from 'expo-image';
import { memo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { ARTWORK_NAIL_HEIGHT, ArtworkFrame, getArtworkFrameSize } from '@/components/artwork-frame';
import { frameBodyBounds, frameVisualBounds } from '@/components/artwork/artwork-bounds';
import { artworkRatio } from '@/components/artwork/artwork-layout';
import type { ArtworkUrlErrorHandler } from '@/components/artwork/artwork-piece-image';
import { DETAIL_TILT_MAX, pickDetailTilt, pickFrameStyle } from '@/components/artwork/frame-style';
import { colors } from '@/constants/theme';
import type { MemoryMediaAsset } from '@/services/memories';
import { mediaImageSource } from '@/utils/media-image-source';

// One piece hanging on the detail wall: a nailed ArtworkFrame holding the
// scan, in the frame style derived from the asset id (the same pick the
// Timeline card makes, so a piece wears one frame everywhere).

/** Key for `pickFrameStyle`: the asset id, falling back to the memory id. */
export function artworkFrameKey(asset: Pick<MemoryMediaAsset, 'id'> | undefined, memoryId: string): string {
  return asset?.id || memoryId;
}

/**
 * Largest art width <= `targetArtWidth` whose whole frame fits `maxFrameHeight`
 * (tall art shrinks instead of overflowing the screen).
 */
export function fitArtWidthToHeight(
  targetArtWidth: number,
  aspectRatio: number,
  maxFrameHeight: number,
): number {
  let artWidth = Math.max(1, Math.floor(targetArtWidth));
  while (artWidth > 1 && getArtworkFrameSize(artWidth, aspectRatio).height > maxFrameHeight) {
    // Frame height is ~linear in art width; step proportionally, then verify.
    const frameHeight = getArtworkFrameSize(artWidth, aspectRatio).height;
    artWidth = Math.max(1, Math.min(artWidth - 1, Math.floor(artWidth * (maxFrameHeight / frameHeight))));
  }
  return artWidth;
}

/** Single piece on the detail wall: art width as a fraction of the screen,
 * and the tallest the whole frame may be (tall art shrinks). */
export const DETAIL_SINGLE_WIDTH_RATIO = 0.64;
export const DETAIL_SINGLE_MAX_FRAME_HEIGHT = 480;
/** Gap kept between a leaning frame and the screen edge. */
const DETAIL_SIDE_MARGIN = 8;
/** Air above the highest point the nailed frame (or its nail) reaches. */
const DETAIL_TOP_MARGIN = 8;

export interface DetailSingleLayout {
  artWidth: number;
  /** Padding above the frame box: the nail's room plus the lean's lift. */
  topPad: number;
}

/** Half the width the frame's body spans (about its box center) when leaning
 * `tilt` degrees about the nail. */
function leanHalfExtent(width: number, height: number, tilt: number): number {
  const body = frameBodyBounds(width, height, tilt, true);
  return Math.max(width / 2 - body.left, body.right - width / 2);
}

/** Layout of the single piece on the detail wall. The frame leans up to
 * DETAIL_TILT_MAX either way about its nail, so the art width also shrinks
 * until the leaning body fits the screen, and the top padding grows to hold
 * the nail and the corner the lean lifts. */
export function getDetailSingleLayout(screenWidth: number, aspectRatio: number): DetailSingleLayout {
  let artWidth = fitArtWidthToHeight(
    Math.round(screenWidth * DETAIL_SINGLE_WIDTH_RATIO),
    aspectRatio,
    DETAIL_SINGLE_MAX_FRAME_HEIGHT,
  );
  const fits = (width: number) => {
    const size = getArtworkFrameSize(width, aspectRatio);
    return (
      leanHalfExtent(size.width, size.height, DETAIL_TILT_MAX) <= screenWidth / 2 - DETAIL_SIDE_MARGIN &&
      leanHalfExtent(size.width, size.height, -DETAIL_TILT_MAX) <= screenWidth / 2 - DETAIL_SIDE_MARGIN
    );
  };
  while (artWidth > 1 && !fits(artWidth)) artWidth -= 1;
  const size = getArtworkFrameSize(artWidth, aspectRatio);
  const reach = Math.max(
    -frameVisualBounds(size.width, size.height, DETAIL_TILT_MAX, true).top,
    -frameVisualBounds(size.width, size.height, -DETAIL_TILT_MAX, true).top,
    ARTWORK_NAIL_HEIGHT,
  );
  return { artWidth, topPad: Math.ceil(reach) + DETAIL_TOP_MARGIN };
}

interface ArtworkPieceProps {
  asset: MemoryMediaAsset;
  /** Fallback seed when the asset has no id of its own. */
  memoryId: string;
  /** Signed URL for the asset (undefined while loading). */
  url: string | undefined;
  artWidth: number;
  onPress?: () => void;
  onUrlError?: ArtworkUrlErrorHandler;
  onUrlLoad?: ArtworkUrlErrorHandler;
  accessibilityLabel: string;
  /** Lean direction on the wall (see `walkLeanDirection`); defaults to the
   * piece's own seed sign, which is right for a single piece. */
  leanDirection?: 1 | -1;
  testID?: string;
}

function ArtworkPieceBase({
  asset,
  memoryId,
  url,
  artWidth,
  onPress,
  onUrlError,
  onUrlLoad,
  accessibilityLabel,
  leanDirection,
  testID,
}: ArtworkPieceProps) {
  const frameKey = artworkFrameKey(asset, memoryId);
  // Kind and color are the Timeline's pick (a piece wears one frame
  // everywhere); the lean is the detail wall's own, bolder and alternating.
  const { kind, color } = pickFrameStyle(frameKey);
  const tilt = pickDetailTilt(frameKey, leanDirection);

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      disabled={!onPress}
      onPress={onPress}
    >
      <ArtworkFrame
        artWidth={artWidth}
        aspectRatio={artworkRatio(asset.aspect_ratio)}
        color={color}
        kind={kind}
        nail
        testID={testID}
        tilt={tilt}
      >
        {url ? (
          <Image
            contentFit="contain"
            onError={onUrlError ? () => onUrlError(asset.object_key) : undefined}
            onLoad={onUrlLoad ? () => onUrlLoad(asset.object_key) : undefined}
            source={mediaImageSource(url, asset.object_key)}
            style={StyleSheet.absoluteFill}
            testID={`memory-media-image-${asset.id}`}
          />
        ) : (
          <View style={styles.loading}>
            <ActivityIndicator color={colors.primary} />
          </View>
        )}
      </ArtworkFrame>
    </Pressable>
  );
}

export const ArtworkPiece = memo(ArtworkPieceBase);

const styles = StyleSheet.create({
  loading: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
});
