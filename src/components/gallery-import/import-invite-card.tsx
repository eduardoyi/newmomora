// The post-onboarding Timeline invitation (design: gi-entry.jsx
// GIImportInvite, ~L250-287). The one place this feature earns a spot in the
// feed: dismissible, with a dedicated CTA (not a whole-card tap target) and a
// 5-photo placeholder strip.
//
// The design's strip is real photo stand-ins (GIPhoto) -- this card must
// NEVER read the user's actual camera roll just to decorate an offer they
// haven't accepted yet, so it uses flat theme-tinted blocks instead.
//
// Simplified per the 2026-08-23 copy pass (docs/plans/gallery-import-continuous.md
// I4b): eyebrow, title, CTA, dismiss -- the body paragraph, the shield
// reassurance line, and the "photos only" clarification duplicated the entry
// screen (gallery-import-entry.tsx), which still carries all three right
// before the OS permission prompt.
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radius, spacing } from '@/constants/theme';

const STRIP_TINTS = [colors.primaryTint, colors.surface, colors.seaSoft, colors.surface2, colors.primarySoft];

function PhotoStripPlaceholder() {
  return (
    <View style={styles.strip}>
      {STRIP_TINTS.map((tint, index) => (
        <View
          key={tint}
          style={[
            styles.stripBlock,
            { backgroundColor: tint },
            { transform: [{ rotate: `${(index % 2 ? 1 : -1) * 1.1}deg` }] },
          ]}
        />
      ))}
    </View>
  );
}

export interface ImportInviteCardProps {
  onStart: () => void;
  onDismiss: () => void;
}

export function ImportInviteCard({ onStart, onDismiss }: ImportInviteCardProps) {
  return (
    <View style={styles.card} testID="timeline-gallery-import">
      <View style={styles.headerRow}>
        <Text style={styles.eyebrow}>From your photos</Text>
        <View style={styles.headerSpacer} />
        <Pressable
          accessibilityLabel="Not now"
          accessibilityRole="button"
          hitSlop={8}
          onPress={onDismiss}
          style={styles.dismissBtn}
          testID="timeline-gallery-import-dismiss"
        >
          <Text style={styles.dismissBtnText}>✕</Text>
        </Pressable>
      </View>
      <Text style={styles.title}>Your journal does not have to start empty.</Text>
      <PhotoStripPlaceholder />
      <Pressable
        accessibilityRole="button"
        onPress={onStart}
        style={({ pressed }) => [styles.ctaButton, pressed && styles.ctaButtonPressed]}
        testID="timeline-gallery-import-start"
      >
        <Text style={styles.ctaButtonText}>Look through my photos</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: radius.xl,
    borderWidth: 1,
    marginHorizontal: spacing.md,
    marginTop: spacing.lg,
    padding: spacing.md,
    shadowColor: '#281E0000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.06,
    shadowRadius: 24,
  },
  headerRow: { alignItems: 'center', flexDirection: 'row' },
  eyebrow: {
    color: colors.ink3,
    fontFamily: fonts.sansBold,
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  headerSpacer: { flex: 1 },
  dismissBtn: {
    alignItems: 'center',
    borderRadius: 14,
    height: 28,
    justifyContent: 'center',
    width: 28,
  },
  dismissBtnText: { color: colors.ink3, fontSize: 13, fontFamily: fonts.sansBold },
  title: {
    color: colors.ink,
    fontFamily: fonts.display,
    fontSize: 21,
    lineHeight: 24,
    marginTop: 8,
  },
  strip: {
    flexDirection: 'row',
    gap: 5,
    marginTop: 14,
  },
  stripBlock: {
    borderRadius: 8,
    flex: 1,
    height: 62,
  },
  ctaButton: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    justifyContent: 'center',
    marginTop: 15,
    minHeight: 48,
  },
  ctaButtonPressed: { opacity: 0.85 },
  ctaButtonText: {
    color: colors.white,
    fontFamily: fonts.sansBold,
    fontSize: 15,
  },
});
