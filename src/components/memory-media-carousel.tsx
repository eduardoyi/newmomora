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
  url,
}: {
  isActive: boolean;
  nativeControls: boolean;
  url: string;
}) {
  const player = useVideoPlayer(url, (p) => {
    p.loop = !nativeControls;
    p.muted = !nativeControls;
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
      contentFit="cover"
      nativeControls={nativeControls}
      player={player}
      style={StyleSheet.absoluteFill}
    />
  );
}

function MediaPage({
  asset,
  isActive,
  nativeVideoControls,
  url,
}: {
  asset: MemoryMediaAsset;
  isActive: boolean;
  nativeVideoControls: boolean;
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
    return (
      <View style={styles.page}>
        {isActive ? (
          <VideoAsset
            isActive={isActive}
            nativeControls={nativeVideoControls}
            url={url}
          />
        ) : (
          <View style={styles.videoInactive}>
            <SymbolView
              name={{ ios: 'play.fill', android: 'play_arrow' }}
              size={28}
              tintColor={colors.white}
              fallback={<Text style={styles.playFallback}>▶</Text>}
            />
          </View>
        )}
      </View>
    );
  }

  return (
    <Image
      contentFit="cover"
      source={{ uri: url }}
      style={styles.page}
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
  const tapStartRef = useRef<{ x: number; y: number; timestamp: number } | null>(null);
  const hasMovedRef = useRef(false);
  const keys = assets.map((asset) => asset.object_key);
  const { data: urls = {} } = useMediaUrls(keys, cacheVersion);
  const showPaging = assets.length > 1;

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
      style={[styles.container, style]}
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
              nativeVideoControls={nativeVideoControls}
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
    aspectRatio: 4 / 3,
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
