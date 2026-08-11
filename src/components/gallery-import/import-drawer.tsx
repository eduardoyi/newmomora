// The status drawer behind the Timeline import glyph (design: gi-entry.jsx
// GIImportDrawer, ~L172-245, built on gi-shared.jsx's GISheet). One status
// card (variant per entry state) and a "suggestions clear" note. USER
// DECISION: the caption-settings link row and the camera-roll reassure line
// were both removed as unnecessary chrome on this sheet -- captions settings
// stays reachable elsewhere, and the reassure line was repeating what the
// status card itself already implies. Bottom-sheet chrome follows this
// repo's existing pattern (src/components/family-roster-sheet.tsx) rather
// than the web prototype's CSS transitions.
import { Image } from 'expo-image';
import { useEffect } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fonts, radius, spacing } from '@/constants/theme';
import { useGalleryImportRunCandidates } from '@/hooks/useGalleryImport';
import type { GalleryImportRun } from '@/services/gallery-import';
import type { GalleryImportCheckpoint } from '@/utils/gallery-import-checkpoint';
import type { GalleryImportAttentionReason, GalleryImportEntryState } from '@/utils/gallery-import-entry-state';

const THUMB_SIZE = 36;

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

interface DrawerCardCopy {
  eyebrow: string;
  tone: string;
  title: string;
  sub: string;
  cta: string;
  /** null = no bar; 'indeterminate' = still-scanning pulse; a fraction = a real progress bar. */
  progress: 'indeterminate' | { value: number; total: number } | null;
}

function buildCardCopy(
  state: Exclude<GalleryImportEntryState, 'none'>,
  attentionReason: GalleryImportAttentionReason,
  readyCount: number,
  keptCount: number,
  reviewDaysLeft: number | null,
  asideCount: number,
): DrawerCardCopy {
  switch (state) {
    case 'processing':
      // Round 4, device evidence: at readyCount 0 the eyebrow and title used
      // to be the identical string stacked ("Looking through your photos" /
      // "Looking through your photos"), and the CTA still said "Start
      // reviewing" -- which routes to the progress screen, not a deck, when
      // there is nothing ready (timeline.tsx's handlePrimaryAction). Give
      // the zero-ready title its own copy and a CTA that names where it
      // actually goes.
      return {
        eyebrow: 'Looking through your photos',
        tone: colors.seaInk,
        title: readyCount > 0 ? `${readyCount} ${pluralize(readyCount, 'suggestion')} ready so far` : 'Momora is still looking.',
        sub: 'Still looking through the rest. Safe to close Momora.',
        cta: readyCount > 0 ? 'Start reviewing' : 'Check progress',
        progress: 'indeterminate',
      };
    case 'ready':
      return {
        eyebrow: 'Ready when you are',
        tone: colors.primary,
        title: `${readyCount} ${pluralize(readyCount, 'suggestion')} from your photos`,
        sub: 'Keep the ones you want, no rush.',
        cta: 'Review suggestions',
        progress: null,
      };
    case 'resume': {
      const total = keptCount + readyCount;
      return {
        eyebrow: 'Where you left off',
        tone: colors.primary,
        title: `${readyCount} ${pluralize(readyCount, 'suggestion')} left to look at`,
        sub: `${keptCount} kept so far. Your place is saved.`,
        cta: 'Pick up where you left off',
        progress: total > 0 ? { value: keptCount, total } : null,
      };
    }
    case 'expiring':
      return {
        eyebrow: 'Ending soon',
        tone: colors.sunInk,
        title: reviewDaysLeft !== null
          ? `${asideCount} set aside, ${reviewDaysLeft} ${pluralize(reviewDaysLeft, 'day')} left`
          : `${asideCount} set aside`,
        sub: 'After that the suggestions clear, and your camera roll is untouched.',
        cta: 'Take a last look',
        progress: null,
      };
    case 'attention':
    default:
      return attentionReason === 'waiting_for_wifi'
        ? {
          eyebrow: 'Waiting for Wi‑Fi',
          tone: colors.sunInk,
          title: 'Paused until you are on Wi‑Fi',
          sub: 'Momora will carry on by itself. Or use cellular data now.',
          cta: 'See options',
          progress: null,
        }
        : {
          eyebrow: 'Needs your attention',
          tone: colors.sunInk,
          title: 'Something needs a second look',
          sub: 'Open Momora’s photo suggestions to see what happened and try again.',
          cta: 'See options',
          progress: null,
        };
  }
}

function IndeterminateBar() {
  // design: gi-shared.jsx GIProgress's `indeterminate` sweep. This repo's
  // reanimated Jest mock has no `interpolate`/`withSequence` (see
  // jest.setup.ts), so the pulse reuses the same opacity-breathe primitive as
  // the glyph's status dot rather than a translating sweep -- same "still
  // working, indeterminate" motion intent, cheaper animation surface.
  const opacity = useSharedValue(0.35);
  useEffect(() => {
    opacity.value = withRepeat(withTiming(0.85, { duration: 750 }), -1, true);
  }, [opacity]);
  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <View style={styles.progressTrack}>
      <Animated.View style={[styles.progressIndeterminateFill, animatedStyle]} />
    </View>
  );
}

function ProgressBar({ value, total }: { value: number; total: number }) {
  const pct = total > 0 ? Math.max(3, Math.round((value / total) * 100)) : 0;
  return (
    <View style={styles.progressTrack}>
      <View style={[styles.progressFill, { width: `${pct}%` }]} />
    </View>
  );
}

export interface ImportDrawerProps {
  visible: boolean;
  state: Exclude<GalleryImportEntryState, 'none'>;
  attentionReason: GalleryImportAttentionReason;
  reviewDaysLeft: number | null;
  run: GalleryImportRun | null;
  checkpoint: GalleryImportCheckpoint | null;
  onClose: () => void;
  onPrimaryAction: () => void;
}

export function ImportDrawer({
  visible,
  state,
  attentionReason,
  reviewDaysLeft,
  run,
  checkpoint,
  onClose,
  onPrimaryAction,
}: ImportDrawerProps) {
  const insets = useSafeAreaInsets();
  // Candidate previews are short-lived signed URLs -- only fetched while the
  // drawer is actually open, not held on a standing subscription.
  const candidatesQuery = useGalleryImportRunCandidates(checkpoint, visible);
  const candidates = candidatesQuery.data ?? [];

  const readyCandidates = candidates.filter((candidate) => candidate.status === 'ready');
  const keptCount = candidates.filter((candidate) => candidate.status === 'kept' || candidate.status === 'approved').length;
  const asideCount = candidates.filter((candidate) => candidate.status === 'skipped').length;
  // run.readyCandidates is the server's own count (works even before the full
  // candidate list has loaded); fall back to what's been fetched so far.
  const readyCount = run?.readyCandidates ?? readyCandidates.length;

  const copy = buildCardCopy(state, attentionReason, readyCount, keptCount, reviewDaysLeft, asideCount);

  const thumbs = readyCandidates
    .flatMap((candidate) => (candidate.previewUrls?.[0] ? [{ id: candidate.id, url: candidate.previewUrls[0] }] : []))
    .slice(0, 3);
  const moreCount = state === 'ready' ? Math.max(0, readyCount - thumbs.length) : 0;

  const clearsNoteText = reviewDaysLeft !== null && reviewDaysLeft > 0
    ? `Suggestions clear in ${reviewDaysLeft} ${pluralize(reviewDaysLeft, 'day')}. Kept memories stay forever.`
    : 'Set-aside suggestions clear automatically. Kept memories stay forever.';

  return (
    <Modal animationType="slide" onRequestClose={onClose} presentationStyle="overFullScreen" transparent visible={visible}>
      <View style={styles.root}>
        <Pressable accessibilityLabel="Close" accessibilityRole="button" onPress={onClose} style={styles.backdrop} />
        {/* Inset PLUS a gap -- the bare max left the last row flush against
            the translucent Android nav band (see GalleryImportSheet). */}
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, spacing.lg) + spacing.lg }]} testID="import-drawer-sheet">
          <View style={styles.handle} />
          <View style={styles.header}>
            <Text style={styles.headerTitle}>From your photos</Text>
            <Pressable accessibilityLabel="Close" accessibilityRole="button" onPress={onClose} style={styles.closeBtn} testID="import-drawer-close">
              <Text style={styles.closeBtnText}>Close</Text>
            </Pressable>
          </View>

          <View style={styles.card}>
            <View style={styles.eyebrowRow}>
              {state === 'processing' ? <View style={styles.eyebrowDot} /> : null}
              <Text style={[styles.eyebrow, { color: copy.tone }]}>{copy.eyebrow}</Text>
            </View>
            <Text style={styles.cardTitle}>{copy.title}</Text>
            <Text style={styles.cardSub}>{copy.sub}</Text>
            {copy.progress === 'indeterminate' ? <IndeterminateBar /> : null}
            {copy.progress && copy.progress !== 'indeterminate' ? (
              <ProgressBar total={copy.progress.total} value={copy.progress.value} />
            ) : null}
            <View style={styles.cardFooter}>
              {thumbs.length > 0 ? (
                <View style={styles.thumbRow}>
                  {thumbs.map((thumb) => (
                    <View key={thumb.id} style={styles.thumb}>
                      <Image contentFit="cover" source={{ uri: thumb.url }} style={styles.thumbImage} />
                    </View>
                  ))}
                  {moreCount > 0 ? (
                    <View style={styles.thumbMore}>
                      <Text style={styles.thumbMoreText}>+{moreCount}</Text>
                    </View>
                  ) : null}
                </View>
              ) : <View style={styles.cardFooterSpacer} />}
              <Pressable
                accessibilityRole="button"
                onPress={onPrimaryAction}
                style={({ pressed }) => [styles.ctaButton, pressed && styles.ctaButtonPressed]}
                testID="import-drawer-cta"
              >
                <Text style={styles.ctaButtonText}>{copy.cta}</Text>
              </Pressable>
            </View>
          </View>

          <View style={styles.linksCard}>
            <View style={styles.linkRow}>
              <Text style={styles.clearsNote}>{clearsNoteText}</Text>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(44, 36, 24, 0.4)',
  },
  sheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    maxHeight: '88%',
    paddingTop: spacing.sm,
  },
  handle: {
    alignSelf: 'center',
    backgroundColor: colors.borderStrong,
    borderRadius: 2,
    height: 4,
    marginBottom: spacing.md,
    width: 36,
  },
  header: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  headerTitle: {
    color: colors.ink,
    fontFamily: fonts.display,
    fontSize: 22,
    flex: 1,
  },
  closeBtn: { paddingTop: 2 },
  closeBtnText: {
    color: colors.primary,
    fontFamily: fonts.sansBold,
    fontSize: 14.5,
  },
  card: {
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    marginHorizontal: spacing.lg,
    padding: 15,
  },
  eyebrowRow: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  eyebrowDot: { backgroundColor: colors.sea, borderRadius: 4, height: 7, width: 7 },
  eyebrow: {
    fontFamily: fonts.sansBold,
    fontSize: 10,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  cardTitle: {
    color: colors.ink,
    fontFamily: fonts.display,
    fontSize: 19,
    lineHeight: 22,
    marginTop: 8,
  },
  cardSub: {
    color: colors.ink2,
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 5,
  },
  progressTrack: {
    backgroundColor: colors.border,
    borderRadius: radius.pill,
    height: 6,
    marginTop: 12,
    overflow: 'hidden',
  },
  progressFill: {
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    height: '100%',
  },
  progressIndeterminateFill: {
    backgroundColor: colors.sea,
    borderRadius: radius.pill,
    height: '100%',
    width: '100%',
  },
  cardFooter: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    marginTop: 13,
  },
  cardFooterSpacer: { flex: 1 },
  thumbRow: { flex: 1, flexDirection: 'row', gap: 5 },
  thumb: {
    backgroundColor: colors.surface,
    borderRadius: 7,
    height: THUMB_SIZE,
    overflow: 'hidden',
    width: THUMB_SIZE,
  },
  thumbImage: { height: '100%', width: '100%' },
  thumbMore: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 1,
    height: THUMB_SIZE,
    justifyContent: 'center',
    width: THUMB_SIZE,
  },
  thumbMoreText: {
    color: colors.ink3,
    fontFamily: fonts.sansBold,
    fontSize: 12.5,
  },
  ctaButton: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    justifyContent: 'center',
    minHeight: 40,
    paddingHorizontal: spacing.md,
  },
  ctaButtonPressed: { opacity: 0.85 },
  ctaButtonText: {
    color: colors.white,
    fontFamily: fonts.sansBold,
    fontSize: 13.5,
  },
  linksCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    overflow: 'hidden',
  },
  linkRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  clearsNote: {
    color: colors.ink3,
    flex: 1,
    fontFamily: fonts.sans,
    fontSize: 12.5,
    lineHeight: 17,
  },
});
