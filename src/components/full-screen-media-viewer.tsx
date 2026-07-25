import { useEventListener } from 'expo';
import { Image, type ImageLoadEventData } from 'expo-image';
import { StatusBar } from 'expo-status-bar';
import { SymbolView } from 'expo-symbols';
import { createVideoPlayer, type VideoPlayer, VideoView } from 'expo-video';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  type LayoutChangeEvent,
  Modal,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { colors, fonts, radius, spacing } from '@/constants/theme';
import { useMediaUrls } from '@/hooks/useMediaUrls';
import { isVideoContentType } from '@/utils/media-validation';

// Illustrations are generated at 1024x1024 and photos are uploaded at their
// original resolution, so 4x is past pixel-for-pixel on a phone screen --
// zooming further only magnifies interpolation.
const MAX_ZOOM_SCALE = 4;
const DOUBLE_TAP_ZOOM_SCALE = 2;
const ZOOM_ANIMATION_MS = 180;

function clampValue(value: number, min: number, max: number) {
  'worklet';
  return Math.min(Math.max(value, min), max);
}

export interface FullScreenMediaItem {
  id: string;
  contentType: string;
  objectKey?: string;
  uri?: string | null;
}

interface FullScreenMediaViewerProps {
  items: FullScreenMediaItem[];
  initialIndex?: number;
  cacheVersion?: string | null;
  accessibilityLabel?: string;
  onClose: () => void;
}

// expo-video's own `useVideoPlayer` recreates and releases the player
// whenever its source argument changes (see `useReleasingSharedObject`),
// which is exactly what makes memory-media-carousel's equivalent unsafe: a
// caption edit bumps cacheVersion, producing a fresh signed URL for the same
// asset while this VideoView stays mounted (same activeIndex). Create the
// player once and swap its source in place instead.
function useVideoSourcePlayer(uri: string, setup: (player: VideoPlayer) => void): VideoPlayer {
  const [player] = useState(() => {
    const nextPlayer = createVideoPlayer({ uri, useCaching: true });
    setup(nextPlayer);
    return nextPlayer;
  });
  const loadedUriRef = useRef(uri);

  useEffect(() => {
    if (loadedUriRef.current === uri) {
      return;
    }
    loadedUriRef.current = uri;
    // Swap the source on the existing player instead of recreating it. Sync
    // `replace` can stall the UI thread on Android; `replaceAsync` offloads
    // the load to a different thread.
    const wasPlaying = player.playing;
    void player.replaceAsync({ uri, useCaching: true }).then(() => {
      // A source swap can leave the native player paused on the new asset.
      // Only resume if it was actually playing -- a user's manual
      // tap-to-pause must not be overridden by an unrelated caption edit.
      if (wasPlaying) {
        player.play();
      }
      // The swap can lose the race with unmount/release ("already released"
      // rejection); failure just leaves the old frame until the next mount.
    }).catch(() => {});
  }, [player, uri]);

  useEffect(() => {
    return () => {
      player.release();
    };
    // Released only on unmount -- see the swap effect above for uri changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return player;
}

function FullScreenVideo({ isActive, uri }: { isActive: boolean; uri: string }) {
  const player = useVideoSourcePlayer(uri, (videoPlayer) => {
    videoPlayer.bufferOptions = {
      preferredForwardBufferDuration: 8,
      maxBufferBytes: 16 * 1024 * 1024,
    };
    videoPlayer.loop = true;
    videoPlayer.muted = false;
  });
  const [isPlaying, setIsPlaying] = useState(false);

  useEventListener(player, 'playingChange', ({ isPlaying: nextIsPlaying }) => {
    setIsPlaying(nextIsPlaying);
  });

  useEffect(() => {
    if (isActive) {
      player.play();
    } else {
      player.pause();
    }
  }, [isActive, player]);

  return (
    <Pressable
      accessibilityLabel={isPlaying ? 'Pause video' : 'Play video'}
      accessibilityRole="button"
      onPress={() => {
        if (player.playing) {
          player.pause();
        } else {
          player.play();
        }
      }}
      style={styles.mediaPage}
      testID="full-screen-media-video-toggle"
    >
      <VideoView
        contentFit="contain"
        nativeControls={false}
        player={player}
        style={StyleSheet.absoluteFill}
        testID="full-screen-media-video"
      />
      {!isPlaying ? (
        <View pointerEvents="none" style={styles.playOverlay}>
          <View style={styles.playButton}>
            <SymbolView
              name={{ ios: 'play.fill', android: 'play_arrow' }}
              size={28}
              tintColor={colors.white}
              fallback={<Text style={styles.playFallback}>▶</Text>}
            />
          </View>
        </View>
      ) : null}
    </Pressable>
  );
}

interface ZoomableImageProps {
  accessibilityLabel: string;
  cacheKey: string;
  /** False for off-screen pages -- they drop any zoom instead of keeping it. */
  isActive: boolean;
  /**
   * Single-finger panning may only claim the touch once the image is zoomed
   * in; otherwise it would fight the paging ScrollView for horizontal drags.
   * The viewer disables paging over the same flag, so exactly one of the two
   * owns a drag at any moment.
   */
  isPanEnabled: boolean;
  onError?: () => void;
  onZoomedChange: (isZoomed: boolean) => void;
  testID: string;
  uri: string;
}

/**
 * A pinch/double-tap zoomable page. Geometry convention for every gesture
 * below: coordinates are relative to the frame centre, and a point `p` on the
 * unscaled image lands at `translate + scale * p`. Anchoring a focal point is
 * therefore just solving that for `translate`.
 */
function ZoomableImage({
  accessibilityLabel,
  cacheKey,
  isActive,
  isPanEnabled,
  onError,
  onZoomedChange,
  testID,
  uri,
}: ZoomableImageProps) {
  const scale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const startScale = useSharedValue(1);
  const startTranslateX = useSharedValue(0);
  const startTranslateY = useSharedValue(0);
  // Unscaled image point pinned under the pinch focal for the whole gesture.
  const pinchAnchorX = useSharedValue(0);
  const pinchAnchorY = useSharedValue(0);
  const frameWidth = useSharedValue(0);
  const frameHeight = useSharedValue(0);
  // Natural ratio of the loaded asset; 0 until expo-image reports it.
  const contentRatio = useSharedValue(0);
  const isZoomed = useSharedValue(false);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    frameWidth.set(event.nativeEvent.layout.width);
    frameHeight.set(event.nativeEvent.layout.height);
  }, [frameHeight, frameWidth]);

  const handleLoad = useCallback((event: ImageLoadEventData) => {
    const height = event.source?.height ?? 0;
    const width = event.source?.width ?? 0;
    contentRatio.set(height > 0 && width > 0 ? width / height : 0);
  }, [contentRatio]);

  useEffect(() => {
    if (isActive) {
      return;
    }

    // Paging is blocked while zoomed, so this only fires for a programmatic
    // page change -- reset anyway so a page is never restored mid-zoom.
    scale.set(1);
    translateX.set(0);
    translateY.set(0);
    if (isZoomed.get()) {
      isZoomed.set(false);
      onZoomedChange(false);
    }
  }, [isActive, isZoomed, onZoomedChange, scale, translateX, translateY]);

  useEffect(() => {
    // A zoomed page can disappear under the viewer -- a family member editing
    // the memory's media refreshes `items` while it's open. Hand paging back on
    // the way out; nobody is left to pinch this page out to fit.
    return () => {
      if (isZoomed.get()) {
        onZoomedChange(false);
      }
    };
  }, [isZoomed, onZoomedChange]);

  // `contain` letterboxes the image inside the page frame, so the pannable
  // range is bounded by the *content* box, not the frame -- clamping against
  // the frame would let a portrait image be dragged past its own edge.
  const panLimit = (nextScale: number) => {
    'worklet';
    const width = frameWidth.get();
    const height = frameHeight.get();
    if (width <= 0 || height <= 0) {
      return { x: 0, y: 0 };
    }

    const frameRatio = width / height;
    // Before onLoad lands, assume the asset fills the frame: a slightly loose
    // clamp beats freezing the pan entirely.
    const ratio = contentRatio.get() > 0 ? contentRatio.get() : frameRatio;
    const contentWidth = ratio > frameRatio ? width : height * ratio;
    const contentHeight = ratio > frameRatio ? width / ratio : height;

    return {
      x: Math.max(0, (contentWidth * nextScale - width) / 2),
      y: Math.max(0, (contentHeight * nextScale - height) / 2),
    };
  };

  const syncZoomed = (nextIsZoomed: boolean) => {
    'worklet';
    if (isZoomed.get() === nextIsZoomed) {
      return;
    }

    isZoomed.set(nextIsZoomed);
    runOnJS(onZoomedChange)(nextIsZoomed);
  };

  const settleToFit = () => {
    'worklet';
    scale.set(withTiming(1, { duration: ZOOM_ANIMATION_MS }));
    translateX.set(withTiming(0, { duration: ZOOM_ANIMATION_MS }));
    translateY.set(withTiming(0, { duration: ZOOM_ANIMATION_MS }));
    syncZoomed(false);
  };

  const pinch = Gesture.Pinch()
    .withTestId(`${testID}-pinch`)
    .onStart((event) => {
      startScale.set(scale.get());
      const focalX = event.focalX - frameWidth.get() / 2;
      const focalY = event.focalY - frameHeight.get() / 2;
      pinchAnchorX.set((focalX - translateX.get()) / scale.get());
      pinchAnchorY.set((focalY - translateY.get()) / scale.get());
    })
    .onUpdate((event) => {
      // Clamped at 1 rather than allowed to overshoot, so pinching out always
      // lands exactly back on the fitted image with no rubber-band to unwind.
      const nextScale = clampValue(startScale.get() * event.scale, 1, MAX_ZOOM_SCALE);
      const limit = panLimit(nextScale);
      // Tracking the live focal (not just the start focal) keeps a two-finger
      // drag panning the image mid-pinch.
      const focalX = event.focalX - frameWidth.get() / 2;
      const focalY = event.focalY - frameHeight.get() / 2;

      scale.set(nextScale);
      translateX.set(clampValue(focalX - nextScale * pinchAnchorX.get(), -limit.x, limit.x));
      translateY.set(clampValue(focalY - nextScale * pinchAnchorY.get(), -limit.y, limit.y));
      syncZoomed(nextScale > 1);
    })
    .onEnd(() => {
      if (scale.get() <= 1) {
        settleToFit();
      }
    });

  const pan = Gesture.Pan()
    .withTestId(`${testID}-pan`)
    // Two-finger movement belongs to the pinch's focal tracking; letting pan
    // see it too would apply the same translation twice.
    .maxPointers(1)
    .enabled(isPanEnabled)
    .onStart(() => {
      startTranslateX.set(translateX.get());
      startTranslateY.set(translateY.get());
    })
    .onUpdate((event) => {
      const limit = panLimit(scale.get());
      translateX.set(clampValue(
        startTranslateX.get() + event.translationX,
        -limit.x,
        limit.x,
      ));
      translateY.set(clampValue(
        startTranslateY.get() + event.translationY,
        -limit.y,
        limit.y,
      ));
    });

  const doubleTap = Gesture.Tap()
    .withTestId(`${testID}-double-tap`)
    .numberOfTaps(2)
    .onEnd((event) => {
      if (scale.get() > 1) {
        settleToFit();
        return;
      }

      // At rest (scale 1, no translation) the tapped screen point *is* the
      // image point under it, so anchoring it reduces to focal - scale*focal.
      const focalX = event.x - frameWidth.get() / 2;
      const focalY = event.y - frameHeight.get() / 2;
      const limit = panLimit(DOUBLE_TAP_ZOOM_SCALE);
      const timing = { duration: ZOOM_ANIMATION_MS };

      scale.set(withTiming(DOUBLE_TAP_ZOOM_SCALE, timing));
      translateX.set(withTiming(
        clampValue(focalX - DOUBLE_TAP_ZOOM_SCALE * focalX, -limit.x, limit.x),
        timing,
      ));
      translateY.set(withTiming(
        clampValue(focalY - DOUBLE_TAP_ZOOM_SCALE * focalY, -limit.y, limit.y),
        timing,
      ));
      syncZoomed(true);
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.get() },
      { translateY: translateY.get() },
      { scale: scale.get() },
    ],
  }));

  return (
    <GestureDetector gesture={Gesture.Race(doubleTap, Gesture.Simultaneous(pinch, pan))}>
      <View
        collapsable={false}
        onLayout={handleLayout}
        style={styles.mediaPage}
        testID={`${testID}-frame`}
      >
        <Animated.View
          style={[styles.mediaPage, animatedStyle]}
          testID={`${testID}-zoom-layer`}
        >
          <Image
            accessibilityHint="Pinch or double tap to zoom"
            accessibilityLabel={accessibilityLabel}
            contentFit="contain"
            onError={onError}
            onLoad={handleLoad}
            source={{ uri, cacheKey }}
            style={styles.mediaPage}
            testID={testID}
          />
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

export function FullScreenMediaViewer({
  items,
  initialIndex = 0,
  cacheVersion,
  accessibilityLabel = 'Full-screen media viewer',
  onClose,
}: FullScreenMediaViewerProps) {
  const { width } = useWindowDimensions();
  const scrollRef = useRef<ScrollView>(null);
  const safeInitialIndex = Math.min(Math.max(initialIndex, 0), Math.max(items.length - 1, 0));
  const [activeIndex, setActiveIndex] = useState(safeInitialIndex);
  // Zoom and paging are mutually exclusive owners of a horizontal drag.
  const [isZoomed, setIsZoomed] = useState(false);
  const keys = items.flatMap((item) => item.objectKey ? [item.objectKey] : []);
  const { data: urls = {}, refetch: refetchMediaUrls } = useMediaUrls(keys, cacheVersion);

  useEffect(() => {
    scrollRef.current?.scrollTo({ animated: false, x: safeInitialIndex * width, y: 0 });
  }, [safeInitialIndex, width]);

  const handleScrollEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (width <= 0) {
      return;
    }

    setActiveIndex(Math.round(event.nativeEvent.contentOffset.x / width));
  };

  return (
    <Modal
      animationType="fade"
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible
    >
      <SafeAreaProvider testID="full-screen-media-safe-area-provider">
        <StatusBar style="light" />
        {/* A Modal is its own native window on Android, so it does not inherit
            the app-level root view -- the zoom gestures below need their own. */}
        <GestureHandlerRootView
          accessibilityLabel={accessibilityLabel}
          accessibilityViewIsModal
          style={styles.container}
          testID="full-screen-media-viewer"
        >
          <ScrollView
            contentOffset={{ x: safeInitialIndex * width, y: 0 }}
            horizontal
            onMomentumScrollEnd={handleScrollEnd}
            onScrollEndDrag={handleScrollEnd}
            pagingEnabled
            ref={scrollRef}
            scrollEnabled={items.length > 1 && !isZoomed}
            showsHorizontalScrollIndicator={false}
            testID="full-screen-media-scroll"
          >
            {items.map((item, index) => {
              const uri = item.uri ?? (item.objectKey ? urls[item.objectKey] : undefined);
              return (
                <View key={item.id} style={[styles.pageWrap, { width }]}>
                  {!uri ? (
                    <ActivityIndicator color={colors.white} size="large" />
                  ) : isVideoContentType(item.contentType) ? (
                    index === activeIndex ? (
                      <FullScreenVideo isActive={index === activeIndex} uri={uri} />
                    ) : (
                      <View style={styles.mediaPage} />
                    )
                  ) : (
                    <ZoomableImage
                      accessibilityLabel={`Media ${index + 1} of ${items.length}`}
                      cacheKey={`${item.objectKey ?? item.uri ?? item.id}:${cacheVersion ?? ''}`}
                      isActive={index === activeIndex}
                      isPanEnabled={isZoomed}
                      onError={item.objectKey ? () => void refetchMediaUrls() : undefined}
                      onZoomedChange={setIsZoomed}
                      testID={`full-screen-media-image-${item.id}`}
                      uri={uri}
                    />
                  )}
                </View>
              );
            })}
          </ScrollView>

          <SafeAreaView edges={['top', 'bottom']} pointerEvents="box-none" style={styles.chrome}>
            <View style={styles.topBar} pointerEvents="box-none">
              <View style={styles.topSpacer} />
              {items.length > 1 ? (
                <View style={styles.counter} testID="full-screen-media-counter">
                  <Text style={styles.counterText}>{activeIndex + 1} / {items.length}</Text>
                </View>
              ) : <View style={styles.topSpacer} />}
              <Pressable
                accessibilityLabel="Close full-screen media"
                accessibilityRole="button"
                hitSlop={8}
                onPress={onClose}
                style={({ pressed }) => [styles.closeButton, pressed && styles.buttonPressed]}
                testID="full-screen-media-close"
              >
                <SymbolView
                  name={{ ios: 'xmark', android: 'close' }}
                  size={18}
                  tintColor={colors.white}
                  fallback={<Text style={styles.closeFallback}>×</Text>}
                />
              </Pressable>
            </View>

            {items.length > 1 ? (
              <View style={styles.dots}>
                {items.map((item, index) => (
                  <View
                    key={item.id}
                    style={[styles.dot, index === activeIndex && styles.dotActive]}
                  />
                ))}
              </View>
            ) : null}
          </SafeAreaView>
        </GestureHandlerRootView>
      </SafeAreaProvider>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#211C24',
    flex: 1,
  },
  pageWrap: {
    alignItems: 'center',
    height: '100%',
    justifyContent: 'center',
  },
  mediaPage: {
    height: '100%',
    width: '100%',
  },
  playOverlay: {
    alignItems: 'center',
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  playButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(44,36,24,0.62)',
    borderRadius: radius.pill,
    height: 64,
    justifyContent: 'center',
    width: 64,
  },
  playFallback: {
    color: colors.white,
    fontSize: 26,
  },
  chrome: {
    bottom: 0,
    justifyContent: 'space-between',
    left: 0,
    paddingBottom: spacing.md,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  topBar: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  topSpacer: {
    width: 42,
  },
  closeButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderColor: 'rgba(255,255,255,0.20)',
    borderRadius: 21,
    borderWidth: 1,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  buttonPressed: {
    opacity: 0.72,
  },
  closeFallback: {
    color: colors.white,
    fontFamily: fonts.sans,
    fontSize: 28,
    lineHeight: 29,
  },
  counter: {
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  counterText: {
    color: colors.white,
    fontFamily: fonts.sansBold,
    fontSize: 12,
  },
  dots: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
    minHeight: 20,
  },
  dot: {
    backgroundColor: 'rgba(255,255,255,0.38)',
    borderRadius: radius.pill,
    height: 5,
    width: 5,
  },
  dotActive: {
    backgroundColor: colors.white,
    width: 16,
  },
});
