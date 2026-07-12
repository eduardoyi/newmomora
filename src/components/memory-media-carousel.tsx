import { useEventListener } from 'expo';
import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  GestureResponderEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { colors, fonts, radius, spacing } from '@/constants/theme';
import { useMediaUrls } from '@/hooks/useMediaUrls';
import type { MemoryMediaAsset } from '@/services/memories';
import {
  DEFAULT_MEDIA_ASPECT_RATIO,
  aspectRatioFromDimensions,
  clampMediaAspectRatio,
} from '@/utils/media-aspect';
import { isVideoContentType } from '@/utils/media-validation';

interface MemoryMediaCarouselProps {
  assets: MemoryMediaAsset[];
  cacheVersion?: string | null;
  isActive?: boolean;
  nativeVideoControls?: boolean;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}

function VideoAsset({
  isActive,
  nativeControls,
  onNaturalRatio,
  url,
}: {
  isActive: boolean;
  nativeControls: boolean;
  onNaturalRatio: (ratio: number) => void;
  url: string;
}) {
  // useCaching keeps downloaded bytes on disk, so replays (timeline card →
  // detail screen, revisits) don't re-stream from R2 while the presigned URL
  // is still cached by useMediaUrls.
  const player = useVideoPlayer({ uri: url, useCaching: true }, (p) => {
    p.loop = !nativeControls;
    p.muted = !nativeControls;
  });

  useEventListener(player, 'sourceLoad', ({ availableVideoTracks }) => {
    const size = availableVideoTracks[0]?.size;
    const ratio = aspectRatioFromDimensions(size?.width, size?.height);
    if (ratio) {
      onNaturalRatio(ratio);
    }
  });

  useEffect(() => {
    if (isActive) {
      player.play();
    } else {
      player.pause();
    }
  }, [isActive, player]);

  return (
    <VideoView
      contentFit="contain"
      nativeControls={nativeControls}
      player={player}
      style={StyleSheet.absoluteFill}
      testID="memory-media-video"
    />
  );
}

function MediaPage({
  asset,
  isActive,
  preload,
  nativeVideoControls,
  onNaturalRatio,
  url,
}: {
  asset: MemoryMediaAsset;
  isActive: boolean;
  preload: boolean;
  nativeVideoControls: boolean;
  onNaturalRatio: (ratio: number) => void;
  url?: string;
}) {
  const isVideo = isVideoContentType(asset.content_type);

  if (!url) {
    return (
      <View style={[styles.page, styles.placeholder]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (isVideo) {
    // Mount the (paused) player for pages adjacent to the active one so the
    // video buffers before the user swipes to it; its first frame doubles as
    // a poster behind the play overlay.
    const showPlayer = isActive || preload;

    return (
      <View style={styles.page}>
        {showPlayer ? (
          <VideoAsset
            isActive={isActive}
            nativeControls={nativeVideoControls}
            onNaturalRatio={onNaturalRatio}
            url={url}
          />
        ) : null}
        {!isActive ? (
          <View pointerEvents="none" style={styles.videoInactive}>
            <SymbolView
              name={{ ios: 'play.fill', android: 'play_arrow' }}
              size={28}
              tintColor={colors.white}
              fallback={<Text style={styles.playFallback}>▶</Text>}
            />
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <Image
      contentFit="contain"
      onLoad={(event) => {
        const ratio = aspectRatioFromDimensions(event.source.width, event.source.height);
        if (ratio) {
          onNaturalRatio(ratio);
        }
      }}
      source={{ uri: url }}
      style={styles.page}
      testID={`memory-media-image-${asset.id}`}
    />
  );
}

export function MemoryMediaCarousel({
  assets,
  cacheVersion,
  isActive = true,
  nativeVideoControls = false,
  onPress,
  style,
}: MemoryMediaCarouselProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [width, setWidth] = useState(0);
  const [naturalRatios, setNaturalRatios] = useState<Record<string, number>>({});
  const tapStartRef = useRef<{ x: number; y: number; timestamp: number } | null>(null);
  const hasMovedRef = useRef(false);
  const keys = assets.map((asset) => asset.object_key);
  const { data: urls = {} } = useMediaUrls(keys, cacheVersion);
  const showPaging = assets.length > 1;

  // The container tracks the first asset's natural aspect ratio (clamped) so
  // media renders uncropped; other pages letterbox via `contain` if they have
  // a different shape. Falls back to 4:3 until dimensions are known.
  const firstRatio = assets.length > 0 ? naturalRatios[assets[0].object_key] : undefined;
  const containerRatio = firstRatio ? clampMediaAspectRatio(firstRatio) : DEFAULT_MEDIA_ASPECT_RATIO;

  const handleNaturalRatio = (objectKey: string, ratio: number) => {
    setNaturalRatios((prev) => (prev[objectKey] === ratio ? prev : { ...prev, [objectKey]: ratio }));
  };

  const handleScrollEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (width <= 0) {
      return;
    }

    setActiveIndex(Math.round(event.nativeEvent.contentOffset.x / width));
  };

  const handleTouchStart = (event: GestureResponderEvent) => {
    if (!onPress) {
      return;
    }

    tapStartRef.current = {
      x: event.nativeEvent.pageX,
      y: event.nativeEvent.pageY,
      timestamp: Date.now(),
    };
    hasMovedRef.current = false;
  };

  const handleTouchMove = (event: GestureResponderEvent) => {
    const start = tapStartRef.current;
    if (!start) {
      return;
    }

    const dx = Math.abs(event.nativeEvent.pageX - start.x);
    const dy = Math.abs(event.nativeEvent.pageY - start.y);
    if (dx > 8 || dy > 8) {
      hasMovedRef.current = true;
    }
  };

  const handleTouchEnd = (event: GestureResponderEvent) => {
    const start = tapStartRef.current;
    if (!onPress || !start) {
      return;
    }

    const dx = Math.abs(event.nativeEvent.pageX - start.x);
    const dy = Math.abs(event.nativeEvent.pageY - start.y);
    const elapsed = Date.now() - start.timestamp;
    tapStartRef.current = null;

    if (!hasMovedRef.current && dx <= 8 && dy <= 8 && elapsed < 600) {
      onPress();
    }
  };

  const handleTouchCancel = () => {
    tapStartRef.current = null;
    hasMovedRef.current = false;
  };

  return (
    <View
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={[styles.container, { aspectRatio: containerRatio }, style]}
      testID="memory-media-carousel"
    >
      <ScrollView
        horizontal
        nestedScrollEnabled
        onMomentumScrollEnd={handleScrollEnd}
        onScrollEndDrag={handleScrollEnd}
        onTouchCancel={handleTouchCancel}
        onTouchEnd={handleTouchEnd}
        onTouchMove={handleTouchMove}
        onTouchStart={handleTouchStart}
        pagingEnabled
        scrollEnabled={assets.length > 1}
        showsHorizontalScrollIndicator={false}
        testID="memory-media-carousel-scroll"
      >
        {assets.map((asset, index) => (
          <View key={asset.id} style={[styles.pageWrap, { width: width || 1 }]}>
            <MediaPage
              asset={asset}
              isActive={isActive && index === activeIndex}
              preload={isActive && Math.abs(index - activeIndex) === 1}
              nativeVideoControls={nativeVideoControls}
              onNaturalRatio={(ratio) => handleNaturalRatio(asset.object_key, ratio)}
              url={urls[asset.object_key]}
            />
          </View>
        ))}
      </ScrollView>

      {showPaging ? (
        <>
          <View style={styles.counter}>
            <Text style={styles.counterText}>{activeIndex + 1} / {assets.length}</Text>
          </View>
          <View style={styles.dots}>
            {assets.map((asset, index) => (
              <View
                key={asset.id}
                style={[styles.dot, index === activeIndex && styles.dotActive]}
              />
            ))}
          </View>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    overflow: 'hidden',
    width: '100%',
  },
  pageWrap: {
    height: '100%',
  },
  page: {
    backgroundColor: colors.surface,
    height: '100%',
    overflow: 'hidden',
    width: '100%',
  },
  placeholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  videoInactive: {
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.38)',
    height: '100%',
    justifyContent: 'center',
    width: '100%',
  },
  playFallback: {
    color: colors.white,
    fontSize: 26,
  },
  counter: {
    backgroundColor: 'rgba(0,0,0,0.42)',
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 4,
    position: 'absolute',
    right: spacing.sm,
    top: spacing.sm,
  },
  counterText: {
    color: colors.white,
    fontFamily: fonts.sansBold,
    fontSize: 11,
  },
  dots: {
    alignItems: 'center',
    bottom: spacing.sm,
    flexDirection: 'row',
    gap: 5,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
  },
  dot: {
    backgroundColor: 'rgba(255,255,255,0.5)',
    borderRadius: 3,
    height: 6,
    width: 6,
  },
  dotActive: {
    backgroundColor: colors.white,
    width: 14,
  },
});
