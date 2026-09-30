// The end-of-film overlay: Replay - Share (+ a slot for more actions).
// Share shows its download progress and a Cancel in place (films are
// 25-65 MB). Step 11 (docs/plans/year-film-p2.md, the owner/manager edit
// sheet) adds its "Edit" button through `renderExtraActions` without
// restructuring this component.
import { RotateCcw, Share2 } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { fonts } from '@/constants/theme';
import type { YearFilmShareStatus } from '@/hooks/useYearFilmShare';

const CREAM = '#F6F1E7';
const PLUM = '#1F1428';

interface FilmCompletionProps {
  title: string | null;
  onReplay: () => void;
  share: {
    status: YearFilmShareStatus;
    progress: number;
    onShare: () => void;
    onCancel: () => void;
  };
  /** Extra action buttons rendered after Replay / Share (e.g. Edit for owners/managers). */
  renderExtraActions?: () => ReactNode;
}

export function shareProgressLabel(progress: number): string {
  return `Preparing video… ${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`;
}

export function FilmCompletion({ title, onReplay, share, renderExtraActions }: FilmCompletionProps) {
  const insets = useSafeAreaInsets();
  const isBusy = share.status !== 'idle';
  return (
    <View
      style={[styles.overlay, { paddingBottom: insets.bottom + 24 }]}
      testID="year-film-complete"
    >
      <Text style={styles.kicker}>The end</Text>
      {title ? (
        <Text accessibilityRole="header" style={styles.title}>
          {title}
        </Text>
      ) : null}

      {share.status === 'downloading' ? (
        <View style={styles.shareStatus}>
          <ActivityIndicator color={CREAM} />
          <Text accessibilityLiveRegion="polite" style={styles.shareLabel} testID="year-film-share-progress">
            {shareProgressLabel(share.progress)}
          </Text>
          <Pressable
            accessibilityLabel="Cancel"
            accessibilityRole="button"
            hitSlop={8}
            onPress={share.onCancel}
            style={styles.cancel}
            testID="year-film-share-cancel"
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.actions}>
          <Pressable
            accessibilityLabel="Watch again"
            accessibilityRole="button"
            disabled={isBusy}
            onPress={onReplay}
            style={[styles.primary, isBusy && styles.disabled]}
            testID="year-film-replay"
          >
            <RotateCcw color={PLUM} size={16} />
            <Text style={styles.primaryText}>Replay</Text>
          </Pressable>
          <Pressable
            accessibilityLabel="Share this film"
            accessibilityRole="button"
            disabled={isBusy}
            onPress={share.onShare}
            style={[styles.secondary, isBusy && styles.disabled]}
            testID="year-film-share"
          >
            <Share2 color={CREAM} size={16} />
            <Text style={styles.secondaryText}>{share.status === 'sharing' ? 'Sharing…' : 'Share'}</Text>
          </Pressable>
          {/* Extra actions slot (Step 11 edit sheet: owners/managers). */}
          {renderExtraActions?.()}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    backgroundColor: 'rgba(31,20,40,0.82)',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  kicker: {
    color: 'rgba(246,241,231,0.5)',
    fontFamily: fonts.sansBold,
    fontSize: 10.5,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  title: {
    color: CREAM,
    fontFamily: fonts.display,
    fontSize: 32,
    lineHeight: 37,
    marginTop: 10,
    textAlign: 'center',
  },
  actions: { alignItems: 'center', gap: 12, marginTop: 30 },
  primary: {
    alignItems: 'center',
    backgroundColor: CREAM,
    borderRadius: 999,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    minHeight: 48,
    minWidth: 168,
    paddingHorizontal: 22,
  },
  primaryText: { color: PLUM, fontFamily: fonts.sansBold, fontSize: 14 },
  secondary: {
    alignItems: 'center',
    borderColor: 'rgba(246,241,231,0.4)',
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    minHeight: 48,
    minWidth: 168,
    paddingHorizontal: 22,
  },
  secondaryText: { color: CREAM, fontFamily: fonts.sansBold, fontSize: 14 },
  disabled: { opacity: 0.5 },
  shareStatus: { alignItems: 'center', gap: 14, marginTop: 30 },
  shareLabel: { color: CREAM, fontFamily: fonts.sansMedium, fontSize: 14 },
  cancel: { alignItems: 'center', justifyContent: 'center', minHeight: 44, paddingHorizontal: 18 },
  cancelText: { color: 'rgba(246,241,231,0.8)', fontFamily: fonts.sansBold, fontSize: 13 },
});
