import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { seedFromKey } from '@/components/audio/audio-seed';
import { SoundTile } from '@/components/audio/sound-tile';
import { colors, fonts, getEmotionColors, radius } from '@/constants/theme';
import { useMediaUrl } from '@/hooks/useMediaUrls';
import { useVideoThumbnail } from '@/hooks/useVideoThumbnail';
import type { MemoryWithTags } from '@/services/memories';
import { mediaImageSource } from '@/utils/media-image-source';
import { resolvePreferredCoverKey, resolveVideoPosterKey } from '@/utils/media-preview';

export interface MemoryStampProps {
  memory: MemoryWithTags;
  isIllustrationHidden: boolean;
  // Present on the Calendar ribbon (an inline "Show" button reveals a
  // reported illustration). Omitted on the Timeline month grid, where the
  // whole tile is the tap target and the reveal lives in the list it opens.
  onShowIllustration?: () => void;
  size?: number;
  // Hides the multi-asset count badge -- the month grid shows its own
  // "+N memories that day" badge instead.
  showMediaCount?: boolean;
  testIDPrefix?: string;
}

/**
 * One memory's square thumbnail: illustration, photo cover (preview key
 * first), video poster (or a runtime-decoded frame), sound tile, text quote
 * glyph, or a placeholder while an illustration/media is pending. Shared by
 * the Calendar ribbon and the Timeline month grid
 * (docs/plans/timeline-calendar-keepsakes.md B2).
 */
export function MemoryStamp({
  memory,
  isIllustrationHidden,
  onShowIllustration,
  size = 56,
  showMediaCount = true,
  testIDPrefix = 'calendar-memory',
}: MemoryStampProps) {
  const emo = getEmotionColors(memory.emotion);
  const isMedia = memory.memory_type === 'media';
  const coverAsset = memory.mediaAssets[0];
  const isVideo = coverAsset ? coverAsset.content_type.startsWith('video/') : isMedia && memory.media_content_type?.startsWith('video/');
  const sizeStyle = { width: size, height: size };

  const { url: illustrationUrl } = useMediaUrl(
    memory.memory_type === 'text_illustration' && !isIllustrationHidden
      ? (memory.illustration_key ?? null)
      : null,
    memory.updated_at,
  );
  // Prefers the derived preview key (Workstream C6); falls back to the
  // original when absent (legacy row, no-upscale guard, failed upload).
  // Named so the same key that drove the fetch also drives the expo-image
  // cacheKey below (Workstream O5) -- keying on anything else would pin the
  // cache to a key that isn't actually what's rendered.
  const photoMediaKey = isMedia && !isVideo ? resolvePreferredCoverKey(coverAsset, memory.media_key) : null;
  const { url: mediaUrl } = useMediaUrl(photoMediaKey, memory.updated_at);
  const posterKey = isVideo ? resolveVideoPosterKey(coverAsset) : null;
  const { url: posterUrl } = useMediaUrl(posterKey, memory.updated_at);
  const { url: videoUrl } = useMediaUrl(
    // Only fetch the actual video file when there's no stored poster --
    // avoids a full ranged fetch + native decode purely to render a
    // paused-state thumbnail.
    isVideo && !posterKey ? (coverAsset?.object_key ?? memory.media_key ?? null) : null,
    memory.updated_at,
  );
  const runtimeVideoThumbnail = useVideoThumbnail(videoUrl);
  const videoThumbnail = posterUrl ?? runtimeVideoThumbnail;

  if (memory.memory_type === 'text_illustration' && isIllustrationHidden) {
    if (!onShowIllustration) {
      return (
        <View
          style={[styles.stamp, sizeStyle, styles.hiddenStamp]}
          testID={`${testIDPrefix}-${memory.id}-illustration-hidden`}
        />
      );
    }
    return (
      <Pressable
        accessibilityLabel="Show reported AI illustration"
        accessibilityRole="button"
        onPress={(event) => {
          event.stopPropagation();
          onShowIllustration();
        }}
        style={[styles.stamp, sizeStyle, styles.hiddenStamp]}
        testID={`${testIDPrefix}-${memory.id}-illustration-show`}
      >
        <Text style={styles.hiddenStampText}>Show</Text>
      </Pressable>
    );
  }

  if (memory.memory_type === 'text_illustration' && illustrationUrl) {
    return (
      <Image
        source={mediaImageSource(illustrationUrl, memory.illustration_key)}
        style={[styles.stamp, sizeStyle]}
        contentFit="cover"
      />
    );
  }

  if (memory.memory_type === 'text_only') {
    return (
      <View style={[styles.stamp, sizeStyle, { backgroundColor: emo?.soft ?? colors.surface }]}>
        <Text
          style={[
            styles.stampQuote,
            { color: emo?.ink ?? colors.ink3, fontSize: size * 0.54, lineHeight: size * 0.6 },
          ]}
        >
          “
        </Text>
      </View>
    );
  }

  if (memory.memory_type === 'audio') {
    return (
      <SoundTile
        durationSeconds={(memory.mediaAssets[0]?.duration_ms ?? 0) / 1000}
        emotion={memory.emotion}
        seed={seedFromKey(memory.id)}
        size={size}
        testID={`${testIDPrefix}-${memory.id}-sound`}
      />
    );
  }

  const displayUri = isVideo ? videoThumbnail : mediaUrl;
  // A video without a stored poster falls back to `runtimeVideoThumbnail`, a
  // locally-decoded frame with no R2 object identity -- only pin a cacheKey
  // when the display bytes actually came from an R2 key (posterKey or the
  // photo's own display key).
  const displayKey = isVideo ? posterKey : photoMediaKey;
  if (isMedia && displayUri) {
    return (
      <View style={[styles.stamp, sizeStyle]}>
        <Image source={mediaImageSource(displayUri, displayKey)} style={[styles.stamp, sizeStyle]} contentFit="cover" />
        {isVideo && (
          <View style={styles.stampPlayOverlay}>
            <SymbolView
              name={{ ios: 'play.fill', android: 'play_arrow' }}
              size={Math.round(size / 4)}
              tintColor={colors.white}
              fallback={<Text style={{ fontSize: 12, color: colors.white }}>▶</Text>}
            />
          </View>
        )}
        {showMediaCount && memory.mediaAssets.length > 1 && (
          <View style={styles.stampCountBadge}>
            <Text style={styles.stampCountText}>{memory.mediaAssets.length}</Text>
          </View>
        )}
      </View>
    );
  }

  // fallback: illustration pending or media not yet loaded
  const isTextIllustration = memory.memory_type === 'text_illustration';
  return (
    <View style={[styles.stamp, sizeStyle, { backgroundColor: isTextIllustration ? (emo?.soft ?? colors.surface) : '#ddc9a8', alignItems: 'center', justifyContent: 'center' }]}>
      {isTextIllustration ? (
        <Text style={[styles.stampIcon, { fontSize: size * 0.36 }]}>✦</Text>
      ) : (
        <SymbolView
          name={{ ios: isVideo ? 'video' : 'camera', android: isVideo ? 'videocam' : 'photo_camera' }}
          size={Math.round(size * 0.36)}
          tintColor={colors.ink3}
          fallback={<Text style={styles.stampIcon}>{isVideo ? '▶' : '📷'}</Text>}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  stamp: {
    borderRadius: radius.md,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  stampPlayOverlay: {
    position: 'absolute',
    inset: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.30)',
  },
  stampCountBadge: {
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 9,
    height: 18,
    justifyContent: 'center',
    position: 'absolute',
    right: 4,
    top: 4,
    minWidth: 18,
  },
  stampCountText: {
    color: colors.white,
    fontFamily: fonts.sansBold,
    fontSize: 10,
    paddingHorizontal: 5,
  },
  stampIcon: {
    fontSize: 20,
    color: colors.ink3,
  },
  stampQuote: {
    fontFamily: fonts.display,
    opacity: 0.45,
  },
  hiddenStamp: { backgroundColor: colors.surface },
  hiddenStampText: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 10 },
});
