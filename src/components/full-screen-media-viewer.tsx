import { useEventListener } from 'expo';
import { Image } from 'expo-image';
import { StatusBar } from 'expo-status-bar';
import { SymbolView } from 'expo-symbols';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
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
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, fonts, radius, spacing } from '@/constants/theme';
import { useMediaUrls } from '@/hooks/useMediaUrls';
import { isVideoContentType } from '@/utils/media-validation';

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

function FullScreenVideo({ isActive, uri }: { isActive: boolean; uri: string }) {
  const player = useVideoPlayer({ uri, useCaching: true }, (videoPlayer) => {
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
      <StatusBar style="light" />
      <View
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
          scrollEnabled={items.length > 1}
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
                  <Image
                    accessibilityLabel={`Media ${index + 1} of ${items.length}`}
                    contentFit="contain"
                    onError={item.objectKey ? () => void refetchMediaUrls() : undefined}
                    source={{
                      uri,
                      cacheKey: `${item.objectKey ?? item.uri ?? item.id}:${cacheVersion ?? ''}`,
                    }}
                    style={styles.mediaPage}
                    testID={`full-screen-media-image-${item.id}`}
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
      </View>
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
