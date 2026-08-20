import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { seedFromKey } from '@/components/audio/audio-seed';
import { SoundTile } from '@/components/audio/sound-tile';
import { colors, fonts, radius, spacing } from '@/constants/theme';
import type { PendingMemoryUpload } from '@/hooks/use-pending-memory-uploads';
import { isAudioContentType, isVideoContentType } from '@/utils/media-validation';

interface PendingMemoryUploadCardProps {
  upload: PendingMemoryUpload;
  onRetry: () => void;
  onDiscard: () => void;
}

// Honest, audio-specific copy (docs/plans/audio-memories-v1.md P3.3 /
// audio-memories-design-feedback.md) -- the generic "Uploading X of Y" /
// "Couldn't post memory" strings read like a photo upload progress bar,
// which the sound doesn't have (a single clip, no page count) and
// shouldn't borrow. Detected from `previewContentType` -- the queue state
// this card receives has no `kind` field of its own (only the enqueue
// input, in memory-posting.ts, does), so this mirrors how the hook already
// distinguishes audio when building `previewUri`/`previewContentType`.
function statusLine(upload: PendingMemoryUpload): string {
  const isAudio = isAudioContentType(upload.previewContentType ?? '');
  if (upload.status === 'failed') {
    if (isAudio) {
      return 'It’s still on this phone — try again.';
    }
    return upload.errorMessage ?? 'Could not save memory';
  }
  if (isAudio) {
    return 'Keep Momora open just a moment.';
  }
  if (upload.uploadedAssets >= upload.totalAssets) {
    return 'Finishing up…';
  }
  return `Uploading ${Math.min(upload.uploadedAssets + 1, upload.totalAssets)} of ${upload.totalAssets}`;
}

export function PendingMemoryUploadCard({ upload, onRetry, onDiscard }: PendingMemoryUploadCardProps) {
  const isFailed = upload.status === 'failed';
  const isAudioUpload = isAudioContentType(upload.previewContentType ?? '');
  const isVideoPreview = isVideoContentType(upload.previewContentType ?? '');
  // Never let the bar sit at 0 -- a sliver of progress reads as "working".
  const progress = Math.max(
    0.06,
    upload.totalAssets > 0 ? upload.uploadedAssets / upload.totalAssets : 0,
  );

  return (
    <View style={styles.card} testID={`pending-memory-card-${upload.memoryId}`}>
      <View style={styles.thumbWrap}>
        {isAudioUpload ? (
          // Trace + seal-ish visual in place of the photo thumb (design
          // handoff: SoundCardPending) -- neutral graphite, since emotion
          // analysis hasn't run yet for a memory that isn't even saved.
          <SoundTile
            durationSeconds={0}
            emotion={null}
            seed={seedFromKey(upload.memoryId)}
            showDuration={false}
            size={52}
            testID={`pending-memory-card-${upload.memoryId}-sound`}
          />
        ) : upload.previewUri && !isVideoPreview ? (
          <Image contentFit="cover" source={{ uri: upload.previewUri }} style={styles.thumb} />
        ) : (
          <View style={[styles.thumb, styles.thumbPlaceholder]}>
            <SymbolView
              name={{ ios: isVideoPreview ? 'play.fill' : 'photo', android: isVideoPreview ? 'play_arrow' : 'image' }}
              size={18}
              tintColor={colors.ink3}
              fallback={<Text style={styles.thumbFallback}>{isVideoPreview ? '▶' : '🖼'}</Text>}
            />
          </View>
        )}
      </View>

      <View style={styles.body}>
        <Text style={[styles.title, isFailed && styles.titleFailed]}>
          {isFailed
            ? (isAudioUpload ? 'The sound didn’t finish posting' : "Couldn't post memory")
            : 'Posting memory…'}
        </Text>
        <Text numberOfLines={1} style={styles.subtitle}>{statusLine(upload)}</Text>
        {isFailed ? (
          <View style={styles.actions}>
            <Pressable
              onPress={onRetry}
              style={styles.actionBtn}
              testID={`pending-memory-retry-${upload.memoryId}`}
            >
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
            <Pressable
              onPress={onDiscard}
              style={styles.actionBtn}
              testID={`pending-memory-discard-${upload.memoryId}`}
            >
              <Text style={styles.discardText}>Discard</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${Math.min(progress, 1) * 100}%` }]} />
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: spacing.sm,
  },
  thumbWrap: {
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  thumb: {
    width: 52,
    height: 52,
    backgroundColor: colors.surface,
  },
  thumbPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbFallback: {
    fontSize: 16,
    color: colors.ink3,
  },
  body: {
    flex: 1,
    gap: 4,
  },
  title: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
    color: colors.ink,
  },
  titleFailed: {
    color: colors.error,
  },
  subtitle: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.ink3,
  },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.surface,
    overflow: 'hidden',
    marginTop: 2,
  },
  progressFill: {
    height: '100%',
    borderRadius: 2,
    backgroundColor: colors.primary,
  },
  actions: {
    flexDirection: 'row',
    gap: 16,
    marginTop: 2,
  },
  actionBtn: {
    paddingVertical: 2,
  },
  retryText: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
    color: colors.primary,
  },
  discardText: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
    color: colors.ink3,
  },
});
