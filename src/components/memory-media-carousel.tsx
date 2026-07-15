import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { createVideoPlayer, type VideoPlayer, VideoView } from 'expo-video';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  GestureResponderEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { colors, fonts, radius, spacing } from '@/constants/theme';
import { useMediaUrls } from '@/hooks/useMediaUrls';
import { useVideoThumbnailResult } from '@/hooks/useVideoThumbnail';
import type { MemoryMediaAsset } from '@/services/memories';
import {
  DEFAULT_MEDIA_ASPECT_RATIO,
  aspectRatioFromDimensions,
} from '@/utils/media-aspect';
import { resolveMediaDisplayKey, resolveVideoPosterKey } from '@/utils/media-preview';
import { isVideoContentType } from '@/utils/media-validation';

interface MemoryMediaCarouselProps {
  assets: MemoryMediaAsset[];
  cacheVersion?: string | null;
  isActive?: boolean;
  stableLayout?: boolean;
  videoTapToToggle?: boolean;
  mutedVideos?: boolean;
  onPress?: (activeIndex: number) => void;
  style?: StyleProp<ViewStyle>;
  /**
   * List-view surfaces (Workstream C6) request the derived preview key when
   * present, falling back to the original. Detail/full-screen callers must
   * leave this false (default) to always render the untouched original.
   * Photos only -- video posters (paused/inactive thumbnail) are always
   * preferred when present regardless of this flag; a video's playback
   * source always stays its own object_key. See resolveVideoPosterKey.
   */
  preferPreview?: boolean;
}

function useDeferredReleaseVideoPlayer(url: string, isMuted: boolean): VideoPlayer | null {
  const [player, setPlayer] = useState<VideoPlayer | null>(null);

  useEffect(() => {
    const nextPlayer = createVideoPlayer({ uri: url, useCaching: true });
    nextPlayer.bufferOptions = {
      preferredForwardBufferDuration: 8,
      maxBufferBytes: 16 * 1024 * 1024,
    };
    nextPlayer.loop = true;
    nextPlayer.muted = isMuted;
    setPlayer(nextPlayer);

    return () => {
      nextPlayer.pause();
      // FlatList can detach/recycle the native surface a frame after React
      // unmounts its row. Releasing immediately lets that recycled surface be
      // assigned a dead shared object on Android.
      requestAnimationFrame(() => nextPlayer.release());
    };
  }, [url]);

  useEffect(() => {
    if (player) {
      player.muted = isMuted;
    }
  }, [isMuted, player]);

  return player;
}

function VideoAsset({
  hasPreferredNaturalRatio,
  isActive,
  isMuted,
  tapToToggle,
  onFirstFrameRender,
  onNaturalRatio,
  url,
}: {
  hasPreferredNaturalRatio: boolean;
  isActive: boolean;
  isMuted: boolean;
  tapToToggle: boolean;
  onFirstFrameRender: () => void;
  onNaturalRatio: (ratio: number) => void;
  url: string;
}) {
  const player = useDeferredReleaseVideoPlayer(url, isMuted);

  useEffect(() => {
    if (!player || hasPreferredNaturalRatio) {
      return;
    }

    const subscription = player.addListener('sourceLoad', ({ availableVideoTracks }) => {
      const size = availableVideoTracks[0]?.size;
      const ratio = aspectRatioFromDimensions(size?.width, size?.height);
      if (ratio) {
        onNaturalRatio(ratio);
      }
    });

    return () => subscription.remove();
  }, [hasPreferredNaturalRatio, onNaturalRatio, player]);

  useEffect(() => {
    if (!player) {
      return;
    }

    if (isActive) {
      player.play();
    } else {
      player.pause();
    }
  }, [isActive, player]);

  if (!player) {
    return null;
  }

  const video = (
    <VideoView
      contentFit="contain"
      nativeControls={false}
      onFirstFrameRender={onFirstFrameRender}
      player={player}
      style={StyleSheet.absoluteFill}
      testID="memory-media-video"
    />
  );

  if (!tapToToggle) {
    return video;
  }

  return (
    <Pressable
      accessibilityLabel="Play or pause video"
      accessibilityRole="button"
      onPress={() => {
        if (player.playing) {
          player.pause();
        } else {
          player.play();
        }
      }}
      style={StyleSheet.absoluteFill}
      testID="memory-media-video-toggle"
    >
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>{video}</View>
    </Pressable>
  );
}

function MediaPage({
  asset,
  isActive,
  cacheKey,
  mutedVideos,
  videoTapToToggle,
  onNaturalRatio,
  onUrlError,
  url,
  posterUrl,
  shouldLoadVideoThumbnail,
  shouldMeasureNaturalRatio,
}: {
  asset: MemoryMediaAsset;
  isActive: boolean;
  cacheKey: string;
  mutedVideos: boolean;
  videoTapToToggle: boolean;
  onNaturalRatio: (objectKey: string, ratio: number) => void;
  onUrlError: () => void;
  url?: string;
  posterUrl?: string;
  shouldLoadVideoThumbnail: boolean;
  shouldMeasureNaturalRatio: boolean;
}) {
  const isVideo = isVideoContentType(asset.content_type);
  const [hasRenderedFirstFrame, setHasRenderedFirstFrame] = useState(false);
  // A stored poster (upload-time first frame, see resolveVideoPosterKey)
  // covers the paused/inactive thumbnail without a runtime video
  // fetch+decode. Still run the runtime extraction when there's no poster
  // (legacy row, not yet backfilled, or a failed upload-time poster) OR when
  // this page also needs to MEASURE a natural ratio for a legacy null
  // aspect_ratio row -- a poster URL alone doesn't expose pixel dimensions.
  const needsRuntimeThumbnail = shouldLoadVideoThumbnail && (!posterUrl || shouldMeasureNaturalRatio);
  // Track metadata can report the encoded dimensions before phone rotation
  // metadata is applied (for example 1920x1080 for a portrait 1080x1920
  // clip). A generated frame has the display transform applied, so it is the
  // authoritative aspect ratio for the asset that controls the container.
  const videoThumbnail = useVideoThumbnailResult(
    isVideo && needsRuntimeThumbnail ? url : null,
    cacheKey,
  );
  const thumbnailUri = posterUrl ?? videoThumbnail?.uri ?? null;
  const reportNaturalRatio = useCallback(
    (ratio: number) => onNaturalRatio(asset.object_key, ratio),
    [asset.object_key, onNaturalRatio],
  );

  useEffect(() => {
    if (!shouldMeasureNaturalRatio || !videoThumbnail) {
      return;
    }
    const ratio = aspectRatioFromDimensions(videoThumbnail.width, videoThumbnail.height);
    if (ratio) {
      reportNaturalRatio(ratio);
    }
  }, [reportNaturalRatio, shouldMeasureNaturalRatio, videoThumbnail]);

  useEffect(() => {
    if (!isActive) {
      setHasRenderedFirstFrame(false);
    }
  }, [isActive]);

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
            hasPreferredNaturalRatio={!shouldMeasureNaturalRatio || videoThumbnail !== null}
            isActive={isActive}
            isMuted={mutedVideos}
            onFirstFrameRender={() => setHasRenderedFirstFrame(true)}
            onNaturalRatio={reportNaturalRatio}
            tapToToggle={videoTapToToggle}
            url={url}
          />
        ) : null}
        {thumbnailUri && (!isActive || !hasRenderedFirstFrame) ? (
          <Image
            contentFit="contain"
            pointerEvents="none"
            source={{ uri: thumbnailUri, cacheKey: `${cacheKey}:thumbnail` }}
            style={StyleSheet.absoluteFill}
            testID={`memory-media-video-thumbnail-${asset.id}`}
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
      onError={onUrlError}
      onLoad={(event) => {
        if (!shouldMeasureNaturalRatio) {
          return;
        }
        const ratio = aspectRatioFromDimensions(event.source.width, event.source.height);
        if (ratio) {
          reportNaturalRatio(ratio);
        }
      }}
      source={{ uri: url, cacheKey }}
      style={styles.page}
      testID={`memory-media-image-${asset.id}`}
    />
  );
}

export function MemoryMediaCarousel({
  assets,
  cacheVersion,
  isActive = true,
  stableLayout = false,
  mutedVideos = true,
  onPress,
  style,
  videoTapToToggle = false,
  preferPreview = false,
}: MemoryMediaCarouselProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [width, setWidth] = useState(0);
  const [naturalRatios, setNaturalRatios] = useState<Record<string, number>>({});
  const tapStartRef = useRef<{ x: number; y: number; timestamp: number } | null>(null);
  const hasMovedRef = useRef(false);
  // A video's display/playback source must always stay its own object_key
  // (a stored preview_object_key on a video is a poster JPEG, not a
  // playable file -- resolveMediaDisplayKey's preference logic is only
  // correct for photos). Only photos honor preferPreview here.
  const displayKeys = assets.map((asset) =>
    isVideoContentType(asset.content_type)
      ? asset.object_key
      : resolveMediaDisplayKey(asset, preferPreview),
  );
  // Video posters are fetched separately -- purely for the paused/inactive
  // thumbnail, never as a substitute for the playback source above.
  const posterKeys = assets
    .map((asset) => (isVideoContentType(asset.content_type) ? resolveVideoPosterKey(asset) : null))
    .filter((key): key is string => Boolean(key));
  const { data: urls = {}, refetch: refetchMediaUrls } = useMediaUrls(
    [...displayKeys, ...posterKeys],
    cacheVersion,
  );
  const showPaging = assets.length > 1;

  // Stable list rows use the persisted ratio from their first render. Detail
  // views can still adopt a runtime-measured ratio for a legacy null row.
  // Every carousel page keeps the first asset's exact ratio. Later assets use
  // contain inside that fixed frame, so swiping never changes row geometry.
  const firstAsset = assets[0];
  const firstRatio = firstAsset?.aspect_ratio ?? (
    firstAsset && !stableLayout ? naturalRatios[firstAsset.object_key] : undefined
  );
  const containerRatio = firstRatio ?? DEFAULT_MEDIA_ASPECT_RATIO;

  const handleNaturalRatio = useCallback((objectKey: string, ratio: number) => {
    setNaturalRatios((prev) => (prev[objectKey] === ratio ? prev : { ...prev, [objectKey]: ratio }));
  }, []);

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
      onPress(activeIndex);
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
        {assets.map((asset, index) => {
          const posterKey = isVideoContentType(asset.content_type)
            ? resolveVideoPosterKey(asset)
            : null;

          return (
            <View key={asset.id} style={[styles.pageWrap, { width: width || 1 }]}>
              {width > 0 ? (
                <MediaPage
                  asset={asset}
                  cacheKey={`${displayKeys[index]}:${cacheVersion ?? ''}`}
                  isActive={isActive && index === activeIndex}
                  mutedVideos={mutedVideos}
                  onNaturalRatio={handleNaturalRatio}
                  onUrlError={() => void refetchMediaUrls()}
                  posterUrl={posterKey ? urls[posterKey] : undefined}
                  url={urls[displayKeys[index]]}
                  videoTapToToggle={videoTapToToggle}
                  shouldLoadVideoThumbnail={
                    index === 0 || (isActive && index === activeIndex)
                  }
                  shouldMeasureNaturalRatio={
                    index === 0 && firstAsset?.aspect_ratio == null
                  }
                />
              ) : null}
            </View>
          );
        })}
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
