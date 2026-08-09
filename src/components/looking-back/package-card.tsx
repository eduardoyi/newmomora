import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useRef } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { colors, fonts, getEmotionColors } from '@/constants/theme';
import { useMediaUrls } from '@/hooks/useMediaUrls';
import type { MemoryWithTags } from '@/services/memories';
import { mediaImageSource } from '@/utils/media-image-source';
import { lookingBackCover } from '@/utils/looking-back-frames';

export interface LookingBackPackageCardData {
  id: string;
  displayKind: string;
  title: string;
  era: string;
  memories: (MemoryWithTags & { isIllustrationHidden?: boolean })[];
  view?: { firstViewedAt?: string | null } | null;
  tint?: string | null;
}

/** Keep the native view as the method receiver under React Native's New Architecture. */
export function measureLookingBackCard(
  card: Pick<View, 'measureInWindow'>,
  callback: Parameters<View['measureInWindow']>[0],
): void {
  card.measureInWindow(callback);
}

export function LookingBackPackageCard({
  item,
  onPress,
}: {
  item: LookingBackPackageCardData;
  onPress: (geometry: { x: number; y: number; width: number; height: number; windowWidth: number; windowHeight: number } | null) => void;
}) {
  const resolvedCover = lookingBackCover(item.memories);
  const cover = resolvedCover?.memory;
  const isIllustration = Boolean(
    cover?.illustration_key
    && cover?.illustration_status === 'ready'
    && !cover.isIllustrationHidden,
  );
  const mediaAsset = !isIllustration ? resolvedCover?.mediaAsset : undefined;
  const coverKey = isIllustration ? cover?.illustration_key : mediaAsset?.preview_object_key ?? mediaAsset?.object_key;
  const { data: urls } = useMediaUrls(coverKey ? [coverKey] : [], cover?.updated_at);
  const coverUrl = coverKey ? urls?.[coverKey] : undefined;
  const emotion = getEmotionColors(cover?.emotion ?? item.tint);
  const isTextPlate = !coverUrl;
  const viewed = Boolean(item.view?.firstViewedAt);
  const meta = viewed ? 'Revisited today' : `${item.memories.length} memories · ${item.era}`;
  const cardRef = useRef<View>(null);
  const pressProgress = useSharedValue(0);
  const pressStyle = useAnimatedStyle(() => ({ opacity: 1 - (pressProgress.value * 0.1) }));
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const handlePress = useCallback(() => {
    const card = cardRef.current;
    if (!card) { onPress(null); return; }
    let delivered = false;
    const fallbackTimer = setTimeout(() => {
      if (delivered) return;
      delivered = true;
      onPress(null);
    }, 32);
    measureLookingBackCard(card, (x, y, width, height) => {
      if (delivered) return;
      delivered = true;
      clearTimeout(fallbackTimer);
      if (width <= 0 || height <= 0) { onPress(null); return; }
      onPress({ x, y, width, height, windowWidth, windowHeight });
    });
  }, [onPress, windowHeight, windowWidth]);
  const handlePressIn = useCallback(() => {
    // Reanimated shared values are deliberately mutated from gesture callbacks.
    // Keep the timing config UI-runtime-native. Passing React Native's
    // Easing.bezier function here crashed Android release builds when the
    // worklet tried to call that JS-thread function.
    // eslint-disable-next-line react-hooks/immutability
    pressProgress.value = withTiming(1, { duration: 140 });
  }, [pressProgress]);
  const handlePressOut = useCallback(() => {
    // eslint-disable-next-line react-hooks/immutability
    pressProgress.value = withTiming(0, { duration: 140 });
  }, [pressProgress]);

  return (
    <Animated.View ref={cardRef} collapsable={false} style={pressStyle}>
    <Pressable
      accessibilityLabel={`${item.displayKind}, ${item.title}, ${meta}`}
      accessibilityRole="button"
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      onPress={handlePress}
      style={[styles.card, viewed && styles.viewedCard, isTextPlate && { borderColor: emotion?.soft ?? colors.border }]}
      testID={`looking-back-package-${item.id}`}
    >
      {coverUrl ? (
        <Image contentFit="cover" source={mediaImageSource(coverUrl, coverKey)} style={StyleSheet.absoluteFill} transition={300} />
      ) : (
        <LinearGradient colors={[emotion?.soft ?? colors.surface2, '#FBF8F2', emotion?.soft ?? colors.surface2]} end={{ x: 1, y: 1 }} start={{ x: 0, y: 0 }} style={[StyleSheet.absoluteFill, styles.textPlate]}>
          <Text style={[styles.quote, { color: emotion?.ink ?? colors.ink3 }]}>”</Text>
        </LinearGradient>
      )}
      {viewed ? <View pointerEvents="none" style={[styles.viewedVeil, isTextPlate && styles.textViewedVeil]} /> : null}
      {!isTextPlate ? <LinearGradient colors={viewed ? ['transparent', 'rgba(38,28,20,0.5)', 'rgba(38,28,20,0.74)'] : ['transparent', 'rgba(38,28,20,0.62)', 'rgba(38,28,20,0.86)']} locations={[0, 0.58, 1]} pointerEvents="none" style={styles.scrim} /> : null}
      <View style={styles.copy}>
        <Text style={[styles.kind, { color: isTextPlate ? emotion?.ink ?? colors.ink3 : viewed ? 'rgba(246,241,231,0.66)' : '#F6E9D8' }]}>{item.displayKind}</Text>
        <Text numberOfLines={2} style={[styles.title, { color: isTextPlate ? colors.ink : '#FBF6EE' }]}>{item.title}</Text>
        <Text style={[styles.meta, { color: isTextPlate ? colors.ink3 : 'rgba(251,246,238,0.72)' }]}>{meta}</Text>
      </View>
    </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: { borderColor: colors.border, borderRadius: 20, borderWidth: 1, height: 244, overflow: 'hidden', shadowColor: '#281E14', shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.13, shadowRadius: 28, width: 168 },
  viewedCard: { shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 2 },
  textPlate: { backgroundColor: colors.surface2 },
  quote: { fontFamily: fonts.display, fontSize: 104, left: 13, lineHeight: 104, opacity: 0.17, position: 'absolute', top: 5 },
  viewedVeil: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(250,250,253,0.20)' },
  textViewedVeil: { backgroundColor: 'rgba(250,250,253,0.50)' },
  scrim: { bottom: 0, height: '64%', left: 0, position: 'absolute', right: 0 },
  copy: { bottom: 14, gap: 6, left: 14, position: 'absolute', right: 14 },
  kind: { fontFamily: fonts.sansBold, fontSize: 9.5, letterSpacing: 1.45, textTransform: 'uppercase' },
  title: { fontFamily: fonts.displayMedium, fontSize: 18, letterSpacing: -0.25, lineHeight: 20.5 },
  meta: { fontFamily: fonts.sansBold, fontSize: 10.5 },
});
