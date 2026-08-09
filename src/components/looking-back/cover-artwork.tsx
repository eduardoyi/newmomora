import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, Text } from 'react-native';

import { colors, fonts, getEmotionColors } from '@/constants/theme';
import { useMediaUrls } from '@/hooks/useMediaUrls';
import type { MemoryWithTags } from '@/services/memories';
import { lookingBackCover } from '@/utils/looking-back-frames';
import { isVideoContentType } from '@/utils/media-validation';
import { mediaImageSource } from '@/utils/media-image-source';

export function LookingBackCoverArtwork({ memories, tint, testID }: { memories: (MemoryWithTags & { isIllustrationHidden?: boolean })[]; tint?: string | null; testID?: string }) {
  const cover = lookingBackCover(memories);
  const memory = cover?.memory;
  const isIllustration = Boolean(memory?.illustration_key && memory.illustration_status === 'ready' && !memory.isIllustrationHidden);
  const mediaKey = cover?.mediaAsset && (!isVideoContentType(cover.mediaAsset.content_type) || cover.mediaAsset.preview_object_key)
    ? cover.mediaAsset.preview_object_key ?? cover.mediaAsset.object_key
    : null;
  const key = isIllustration ? memory?.illustration_key : mediaKey;
  const { data: urls } = useMediaUrls(key ? [key] : [], memory?.updated_at);
  const url = key ? urls?.[key] : null;
  const emotion = getEmotionColors(memory?.emotion ?? tint);

  if (url && key) return <Image contentFit="cover" source={mediaImageSource(url, key)} style={StyleSheet.absoluteFill} testID={testID} transition={180} />;
  return <LinearGradient colors={[emotion?.soft ?? colors.surface2, '#F6F1E7']} end={{ x: 0.2, y: 1 }} start={{ x: 0.8, y: 0 }} style={StyleSheet.absoluteFill} testID={testID}>
    <Text style={[styles.quote, { color: emotion?.ink ?? colors.ink3 }]}>”</Text>
  </LinearGradient>;
}

const styles = StyleSheet.create({ quote: { fontFamily: fonts.display, fontSize: 72, left: 10, lineHeight: 80, opacity: 0.15, position: 'absolute', top: 4 } });
