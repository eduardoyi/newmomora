import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { ArtworkMediumTag } from '@/components/artwork-medium-chip';
import { FamilyMemberAvatar } from '@/components/family-member-avatar';
import { colors, fonts, getEmotionColors, spacing } from '@/constants/theme';
import type { MemoryWithTags } from '@/services/memories';
import { formatDisplayDate, isArtworkMemory } from '@/utils/memories';
import { isVideoContentType } from '@/utils/media-validation';

// The date / tagged-members / chip row under every Timeline card. Split out of
// memory-card.tsx so ArtworkCard can reuse it without an import cycle.
// KEEP IN SYNC with supabase/functions/compose-share-card/layout.ts (see the
// note on SpreadCard in memory-card.tsx).

const MAX_TIMELINE_MEMBER_AVATARS = 6;

// ── Emotion chip ──────────────────────────────────────────────────────────────
function EmotionChip({ emotion }: { emotion: string }) {
  const emo = getEmotionColors(emotion);
  if (!emo) return null;
  return (
    <View style={[styles.emotionChip, { backgroundColor: emo.soft }]}>
      <View style={[styles.emotionDot, { backgroundColor: emo.c }]} />
      <Text style={[styles.emotionLabel, { color: emo.ink }]}>{emotion}</Text>
    </View>
  );
}

// ── Member avatar cluster ──────────────────────────────────────────────────────
function AvatarCluster({ members }: { members: MemoryWithTags['taggedMembers'] }) {
  const visibleMembers = members.slice(0, MAX_TIMELINE_MEMBER_AVATARS);
  const hiddenMemberCount = members.length - visibleMembers.length;

  return (
    <View style={styles.avatarCluster}>
      {visibleMembers.map((m, i) => (
        <FamilyMemberAvatar
          key={m.id}
          member={m}
          size={22}
          style={[styles.avatarCircle, { marginLeft: i === 0 ? 0 : -7 }]}
          testID={`memory-card-member-${m.id}`}
        />
      ))}
      {hiddenMemberCount > 0 ? (
        <View
          accessibilityLabel={`${hiddenMemberCount} more tagged members`}
          style={[styles.avatarCircle, styles.avatarOverflow, { marginLeft: -7 }]}
          testID="memory-card-member-overflow"
        >
          <Text style={styles.avatarOverflowText}>+{hiddenMemberCount}</Text>
        </View>
      ) : null}
    </View>
  );
}

// ── Shared card footer ────────────────────────────────────────────────────────
export function CardFooter({ memory, style }: { memory: MemoryWithTags; style?: StyleProp<ViewStyle> }) {
  const dayLabel = formatDisplayDate(memory.memory_date);
  const isMedia = memory.memory_type === 'media';
  const isArtwork = isArtworkMemory(memory);
  const mediaTypes = memory.mediaAssets.map((asset) => asset.content_type);
  const hasVideo = mediaTypes.some(isVideoContentType);
  const hasPhoto = mediaTypes.some((contentType) => !isVideoContentType(contentType));
  const mediaLabel = hasPhoto && hasVideo
    ? 'Media'
    : hasVideo
      ? 'Video'
      : 'Photo';

  return (
    <View style={[styles.footer, style]}>
      <Text style={styles.footerDay}>{dayLabel}</Text>
      {memory.taggedMembers.length > 0 && (
        <AvatarCluster members={memory.taggedMembers} />
      )}
      <View style={styles.footerSpacer} />
      {isArtwork ? (
        // The medium chip (or "Artwork" fallback) replaces the emotion chip
        // on artwork -- emotion is still stored, just not shown here.
        <ArtworkMediumTag medium={memory.artwork_medium} />
      ) : memory.emotion ? (
        <EmotionChip emotion={memory.emotion} />
      ) : isMedia ? (
        <View style={styles.mediaBadge}>
          <Text style={styles.mediaBadgeText}>{mediaLabel}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: spacing.md,
    paddingTop: 9,
    paddingBottom: 13,
  },
  footerDay: {
    fontFamily: fonts.sansBold,
    fontSize: 10,
    letterSpacing: 0.14 * 10,
    textTransform: 'uppercase',
    color: colors.ink3,
  },
  footerSpacer: {
    flex: 1,
  },
  avatarCluster: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 2,
  },
  avatarCircle: {
    borderWidth: 1.5,
    borderColor: colors.white,
  },
  avatarOverflow: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 11,
    height: 22,
    justifyContent: 'center',
    width: 22,
  },
  avatarOverflowText: {
    color: colors.ink3,
    fontFamily: fonts.sansBold,
    fontSize: 8,
  },
  emotionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 3,
    paddingLeft: 7,
    paddingRight: 9,
    borderRadius: 999,
  },
  emotionDot: {
    width: 5,
    height: 5,
    borderRadius: 999,
  },
  emotionLabel: {
    fontFamily: fonts.sansBold,
    fontSize: 10.5,
    letterSpacing: 0.02 * 10.5,
  },
  mediaBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingVertical: 3,
    paddingHorizontal: 9,
  },
  mediaBadgeText: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    color: colors.ink3,
  },
});
