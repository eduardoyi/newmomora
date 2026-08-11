// The post-onboarding Timeline invitation (design: gi-entry.jsx
// GIImportInvite, ~L250-287). The one place this feature earns a spot in the
// feed: dismissible, with a dedicated CTA (not a whole-card tap target), a
// 5-photo placeholder strip, and the universal camera-roll reassure line.
//
// The design's strip is real photo stand-ins (GIPhoto) -- this card must
// NEVER read the user's actual camera roll just to decorate an offer they
// haven't accepted yet, so it uses flat theme-tinted blocks instead.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

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

function ShieldIcon() {
  return (
    <Svg
      fill="none"
      height={14}
      stroke={colors.sea}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.9}
      style={styles.shieldIcon}
      viewBox="0 0 24 24"
      width={14}
    >
      <Path d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6l7-3z" />
      <Path d="M9 12l2 2 4-4" />
    </Svg>
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
        <Text style={styles.eyebrow}>Start with what you have</Text>
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
      <Text style={styles.body}>
        Momora can look through the photos already on your phone and suggest a handful of moments worth
        keeping. You decide which ones become memories.
      </Text>
      <PhotoStripPlaceholder />
      <Pressable
        accessibilityRole="button"
        onPress={onStart}
        style={({ pressed }) => [styles.ctaButton, pressed && styles.ctaButtonPressed]}
        testID="timeline-gallery-import-start"
      >
        <Text style={styles.ctaButtonText}>Look through my photos</Text>
      </Pressable>
      <View style={styles.reassureRow}>
        <ShieldIcon />
        <Text style={styles.reassureText}>Nothing is added without you, and your camera roll is never changed.</Text>
      </View>
      {/* Approved clarification (docs/design/gallery-import/README.md): videos
          are not suggested in v1, and this must not read as an accident. */}
      <Text style={styles.videoNote}>Momora suggests photos only for now.</Text>
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
  body: {
    color: colors.ink2,
    fontFamily: fonts.sans,
    fontSize: 13.5,
    lineHeight: 20,
    marginTop: 7,
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
  reassureRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 7,
    marginTop: 13,
  },
  shieldIcon: { marginTop: 2 },
  reassureText: {
    color: colors.ink3,
    flex: 1,
    fontFamily: fonts.sans,
    fontSize: 12.5,
    lineHeight: 18,
  },
  videoNote: {
    color: colors.ink3,
    fontFamily: fonts.sans,
    fontSize: 11.5,
    lineHeight: 16,
    marginTop: 6,
  },
});
