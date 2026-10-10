import { Image } from 'expo-image';
import { memo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { ArtworkFrame, getArtworkFrameSize } from '@/components/artwork-frame';
import { artworkRatio } from '@/components/artwork/artwork-layout';
import { pickFrameStyle } from '@/components/artwork/frame-style';
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

interface ArtworkPieceProps {
  asset: MemoryMediaAsset;
  /** Fallback seed when the asset has no id of its own. */
  memoryId: string;
  /** Signed URL for the asset (undefined while loading). */
  url: string | undefined;
  artWidth: number;
  onPress?: () => void;
  onUrlError?: () => void;
  accessibilityLabel: string;
  testID?: string;
}

function ArtworkPieceBase({
  asset,
  memoryId,
  url,
  artWidth,
  onPress,
  onUrlError,
  accessibilityLabel,
  testID,
}: ArtworkPieceProps) {
  const { kind, color, tilt } = pickFrameStyle(artworkFrameKey(asset, memoryId));

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
            onError={onUrlError}
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
