// Shared chrome for the gallery-import flow (mechanical split of the former
// gallery-import-flow.tsx -- see docs/design/gallery-import/README.md for
// the design authority). Screen-specific components live in sibling
// gallery-import-*.tsx files; this file holds only what more than one of
// them needs: the back-chevron header, the two button styles, the
// checkpoint-loading hook, the two generic terminal notices, and the shared
// StyleSheet.
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

import { colors, fonts, radius, spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import {
  loadGalleryImportCheckpoint,
  updateGalleryImportCheckpoint,
  type GalleryImportCheckpoint,
} from '@/utils/gallery-import-checkpoint';

export function humanError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Something went wrong. Please try again.';
}

export function Header({ title, onBack }: { title: string; onBack?: () => void }) {
  return (
    <View style={styles.header}>
      <Pressable accessibilityLabel="Go back" accessibilityRole="button" hitSlop={12} onPress={onBack ?? (() => router.back())} testID="gallery-import-back">
        <Text style={styles.back}>‹</Text>
      </Pressable>
      <Text style={styles.headerTitle}>{title}</Text>
      <View style={styles.headerSpacer} />
    </View>
  );
}

export function PrimaryButton({ label, onPress, disabled, testID }: { label: string; onPress: () => void; disabled?: boolean; testID: string }) {
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.primaryButton, (disabled || pressed) && styles.buttonPressed]} testID={testID}><Text style={styles.primaryButtonText}>{label}</Text></Pressable>;
}

export function SecondaryButton({ label, onPress, testID, disabled }: { label: string; onPress: () => void; testID: string; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.secondaryButton, (disabled || pressed) && styles.buttonPressed]} testID={testID}><Text style={styles.secondaryButtonText}>{label}</Text></Pressable>;
}

/**
 * The one way OUT of the gallery-import surfaces and back to the journal.
 * These screens present as iOS modals (app/(app)/_layout.tsx); a plain
 * `router.replace('/(app)/(tabs)/timeline')` issued from inside a modal
 * nested a fresh tab navigator inside the sheet -- the "app within an app"
 * observed on a real iPhone (2026-08-23). Android's full-screen presentation
 * masked it. Dismiss the modal stack first, then navigate the underlying
 * tab navigator (navigate, not replace: reuse the existing tabs instance).
 */
export function exitGalleryImportToTimeline(): void {
  // Optional-chained so a partial router (Jest mocks) degrades to the plain
  // replace below; on-device expo-router always has all three.
  if (router.canDismiss?.()) router.dismissAll?.();
  if (router.navigate) router.navigate('/(app)/(tabs)/timeline' as never);
  else router.replace('/(app)/(tabs)/timeline' as never);
}

export function useRunCheckpoint(runId: string | undefined) {
  const { user } = useAuth();
  const { familyId } = useFamily();
  const userId = user?.id ?? null;
  const [checkpoint, setCheckpoint] = useState<GalleryImportCheckpoint | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const hasLoadedRef = useRef(false);
  const refresh = useCallback(async () => {
    if (!userId || !familyId || !runId) { setCheckpoint(null); setIsLoading(false); return null; }
    // Only the first read shows a loading state. Later re-reads (focus,
    // the deck's quiet poll) are silent: flipping `isLoading` on each one
    // unmounted the whole deck for a frame every few seconds
    // (device-observed 2026-08-23).
    if (!hasLoadedRef.current) setIsLoading(true);
    const next = await loadGalleryImportCheckpoint(userId, familyId, runId);
    hasLoadedRef.current = true;
    setCheckpoint(next);
    setIsLoading(false);
    return next;
  }, [familyId, runId, userId]);
  const update = useCallback(async (updater: (current: GalleryImportCheckpoint) => GalleryImportCheckpoint) => {
    if (!userId || !familyId || !runId) return null;
    const next = await updateGalleryImportCheckpoint(userId, familyId, runId, updater);
    if (next) setCheckpoint(next);
    return next;
  }, [familyId, runId, userId]);
  useEffect(() => { void refresh(); }, [refresh]);
  return { checkpoint, isLoading, refresh, update, userId, familyId };
}

// design: gi-states.jsx GI_STATES.wrongDevice, restyled onto the GIMessage
// pattern. `extraAction` is additive/optional (default omitted keeps
// review.tsx's parameterless `<DeviceBoundNotice />` call rendering the same
// single "Back to my journal" button as before) -- gallery-import-progress.tsx
// is the only caller that passes it, to add the design's "Look through this
// phone's photos" primary action.
export function DeviceBoundNotice({ extraAction }: { extraAction?: { label: string; onPress: () => void } } = {}) {
  return (
    <SafeAreaView style={styles.screen}>
      <GalleryImportTopBar left="Close" onLeft={() => router.replace('/(app)/(tabs)/timeline')} testID="gallery-import-device-bound-close" />
      {/* Short, fixed-length copy fits comfortably on every real device, but
          a ScrollView here (rather than a plain View) costs nothing and
          keeps this screen consistent with the rest of the flow -- content
          can never become silently unreachable if this copy ever grows. */}
      <ScrollView contentContainerStyle={gi.deviceBoundScrollContent} testID="gallery-import-device-bound-scroll">
        <View style={gi.deviceBoundBody}>
          <GalleryImportPill tone="soft">Started on another phone</GalleryImportPill>
          <Text style={styles.displaySmall}>These photos live{'\n'}on your other{'\n'}phone.</Text>
          <Text style={styles.body}>
            Momora only ever reads photos from the phone they are on, so the suggestions from that import can only be finished there. Nothing is lost, so open Momora on that phone and pick up where you left off.
          </Text>
          <View style={gi.deviceBoundNoteWrap}>
            <GalleryImportReassure>You can still start a fresh look through the photos on this phone.</GalleryImportReassure>
          </View>
        </View>
        <View style={gi.deviceBoundActions}>
          {extraAction ? <PrimaryButton label={extraAction.label} onPress={extraAction.onPress} testID="gallery-import-device-bound-primary" /> : null}
          {extraAction
            ? <SecondaryButton label="Back to my journal" onPress={() => router.replace('/(app)/(tabs)/timeline')} testID="gallery-import-device-bound-back" />
            : <PrimaryButton label="Back to my journal" onPress={() => router.replace('/(app)/(tabs)/timeline')} testID="gallery-import-device-bound-back" />}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

export function TerminalImportNotice({ title, body, testID }: { title: string; body: string; testID: string }) { return <SafeAreaView style={styles.screen}><Header title="From your photos" /><View style={styles.empty}><Text style={styles.displaySmall}>{title}</Text><Text style={styles.body}>{body}</Text><PrimaryButton label="Back to my journal" onPress={() => router.replace('/(app)/(tabs)/timeline')} testID={testID} /></View></SafeAreaView>; }

// ── New shared primitives (Phase 2 -- trust/progress/empty/exception
// screens). Additive only: everything above this line is untouched so
// gallery-import-review.tsx/gallery-import-approval.tsx (owned by a parallel
// change) keep working unmodified. design: gi-shared.jsx.

export type GalleryImportIconName =
  | 'search' | 'image' | 'check' | 'x' | 'moon' | 'clock' | 'alert'
  | 'trash' | 'refresh' | 'layers' | 'shield' | 'chevronLeft' | 'chevronRight' | 'arrowRight';

/** One small stroke-icon set covering every glyph gi-shared.jsx's `Icon` uses
 * across the trust/progress/empty/exception screens. Kept in this shared file
 * (rather than duplicated per screen) because every one of those screens
 * needs at least two of these. */
export function GalleryImportIcon({ name, size = 16, color = colors.ink2, strokeWidth = 1.9 }: { name: GalleryImportIconName; size?: number; color?: string; strokeWidth?: number }) {
  const common = { fill: 'none' as const, stroke: color, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, strokeWidth };
  switch (name) {
    case 'search':
      return <Svg height={size} viewBox="0 0 24 24" width={size}><Circle cx={11} cy={11} r={8} {...common} /><Path d="m21 21-4.3-4.3" {...common} /></Svg>;
    case 'image':
      return <Svg height={size} viewBox="0 0 24 24" width={size}><Rect height={18} rx={2} width={18} x={3} y={3} {...common} /><Circle cx={9} cy={9} r={2} {...common} /><Path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" {...common} /></Svg>;
    case 'check':
      return <Svg height={size} viewBox="0 0 24 24" width={size}><Path d="M20 6 9 17l-5-5" {...common} /></Svg>;
    case 'x':
      return <Svg height={size} viewBox="0 0 24 24" width={size}><Path d="M18 6 6 18" {...common} /><Path d="M6 6l12 12" {...common} /></Svg>;
    case 'moon':
      return <Svg height={size} viewBox="0 0 24 24" width={size}><Path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" {...common} /></Svg>;
    case 'clock':
      return <Svg height={size} viewBox="0 0 24 24" width={size}><Circle cx={12} cy={12} r={10} {...common} /><Path d="M12 6v6l4 2" {...common} /></Svg>;
    case 'alert':
      return <Svg height={size} viewBox="0 0 24 24" width={size}><Circle cx={12} cy={12} r={10} {...common} /><Path d="M12 8v4" {...common} /><Path d="M12 16h.01" {...common} /></Svg>;
    case 'trash':
      return <Svg height={size} viewBox="0 0 24 24" width={size}><Path d="M3 6h18" {...common} /><Path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" {...common} /><Path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" {...common} /></Svg>;
    case 'refresh':
      return <Svg height={size} viewBox="0 0 24 24" width={size}><Path d="M3 12a9 9 0 0 1 15.74-6.26L21 8" {...common} /><Path d="M21 3v5h-5" {...common} /><Path d="M21 12a9 9 0 0 1-15.74 6.26L3 16" {...common} /><Path d="M3 21v-5h5" {...common} /></Svg>;
    case 'layers':
      return <Svg height={size} viewBox="0 0 24 24" width={size}><Path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" {...common} /><Path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" {...common} /><Path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" {...common} /></Svg>;
    case 'chevronLeft':
      return <Svg height={size} viewBox="0 0 24 24" width={size}><Path d="m15 18-6-6 6-6" {...common} /></Svg>;
    case 'chevronRight':
      return <Svg height={size} viewBox="0 0 24 24" width={size}><Path d="m9 18 6-6-6-6" {...common} /></Svg>;
    case 'arrowRight':
      return <Svg height={size} viewBox="0 0 24 24" width={size}><Path d="M5 12h14" {...common} /><Path d="m12 5 7 7-7 7" {...common} /></Svg>;
    case 'shield':
    default:
      return <Svg height={size} viewBox="0 0 24 24" width={size}><Path d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6l7-3z" {...common} /><Path d="M9 12l2 2 4-4" {...common} /></Svg>;
  }
}

/** design: gi-shared.jsx GITopBar. iOS gets a left text button ("Cancel" /
 * "Close" / "Not now"); Android gets a round back-arrow button, per this
 * app's platform layout rules -- see gallery-import-entry.tsx and
 * gallery-import-progress.tsx, the only two callers (review/approval keep
 * using the older `Header` above, untouched). */
// Design: gi-shared.jsx GITopBar, translated verbatim. Android renders the
// 22px ink chevron centered in a 44x44 round touchable on a bar with its OWN
// paddingLeft of 12; iOS renders the pink text button. The bar must be
// rendered FULL-BLEED (KeyboardStickyShell's `header` slot, never inside a
// horizontally padded content container) -- stacking the content padding
// under the bar's padding is what pushed the chevron ~2x too far from the
// edge on device (three rounds of misdiagnosis before comparing against the
// design frame; do not "fix" this by changing the affordance again).
export function GalleryImportTopBar({ left, onLeft, right, testID }: { left: string; onLeft: () => void; right?: ReactNode; testID?: string }) {
  return (
    <View style={gi.topBar}>
      {Platform.OS === 'android' ? (
        <Pressable accessibilityLabel="Back" accessibilityRole="button" onPress={onLeft} style={gi.topBarBack} testID={testID}>
          <GalleryImportIcon color={colors.ink} name="chevronLeft" size={22} strokeWidth={2} />
        </Pressable>
      ) : (
        <Pressable accessibilityLabel={left} accessibilityRole="button" hitSlop={8} onPress={onLeft} testID={testID}>
          <Text style={gi.topBarLeft}>{left}</Text>
        </Pressable>
      )}
      <View style={gi.topBarSpacer} />
      {right}
    </View>
  );
}

/** design: gi-shared.jsx GIReassure -- the one line that has to be true on
 * every screen of this flow. Built once here so every screen this phase owns
 * reuses the identical copy/shield motif instead of re-typing it. */
export function GalleryImportReassure({ children = 'Your camera roll is never changed.' }: { children?: string }) {
  return (
    <View style={gi.reassureRow}>
      <GalleryImportIcon color={colors.sea} name="shield" size={14} strokeWidth={1.9} />
      <Text style={gi.reassureText}>{children}</Text>
    </View>
  );
}

export type GalleryImportPillTone = 'neutral' | 'soft' | 'primary' | 'sea' | 'sun' | 'error';

export function GalleryImportPill({ children, tone = 'neutral' }: { children: string; tone?: GalleryImportPillTone }) {
  const toneStyle = {
    neutral: { backgroundColor: colors.white, borderColor: colors.border, color: colors.ink2 },
    soft: { backgroundColor: colors.surface, borderColor: colors.border, color: colors.ink2 },
    primary: { backgroundColor: colors.primaryTint, borderColor: colors.primarySoft, color: colors.primary },
    sea: { backgroundColor: colors.seaSoft, borderColor: colors.seaSoft, color: colors.seaInk },
    sun: { backgroundColor: colors.sunSoft, borderColor: colors.sunSoft, color: colors.sunInk },
    error: { backgroundColor: colors.errorSoft, borderColor: colors.errorSoft, color: colors.error },
  }[tone];
  return (
    <View style={[gi.pill, { backgroundColor: toneStyle.backgroundColor, borderColor: toneStyle.borderColor }]}>
      <Text style={[gi.pillText, { color: toneStyle.color }]}>{children}</Text>
    </View>
  );
}

/** design: gi-shared.jsx GIFact -- an icon, a headline, one plain sentence. */
export function GalleryImportFact({ icon, title, children, tone = colors.primary }: { icon: GalleryImportIconName; title: string; children: string; tone?: string }) {
  return (
    <View style={gi.factRow}>
      <View style={gi.factIconWrap}>
        <GalleryImportIcon color={tone} name={icon} size={17} strokeWidth={1.8} />
      </View>
      <View style={gi.factCopyWrap}>
        <Text style={gi.factTitle}>{title}</Text>
        <Text style={gi.factBody}>{children}</Text>
      </View>
    </View>
  );
}

/** design: gi-shared.jsx GIProgress -- indeterminate while the total is
 * unknown, a real bar only once it is (see docs/design/gallery-import/README.md's
 * progress principle: never fake a percentage of an unknown total). The
 * indeterminate motion reuses the opacity-breathe primitive established by
 * import-drawer.tsx's IndeterminateBar -- this repo's reanimated Jest mock has
 * no `interpolate`/`withSequence`, so a translating sweep is not available. */
export function GalleryImportProgressBar({ value, total, indeterminate, tone = colors.primary }: { value?: number | null; total?: number | null; indeterminate?: boolean; tone?: string }) {
  const isIndeterminate = indeterminate || !total;
  const opacity = useSharedValue(0.35);
  useEffect(() => {
    if (!isIndeterminate) return;
    opacity.value = withRepeat(withTiming(0.85, { duration: 750 }), -1, true);
  }, [isIndeterminate, opacity]);
  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  if (isIndeterminate) {
    return (
      <View style={gi.progressTrack} testID="gallery-import-progress-indeterminate">
        <Animated.View style={[gi.progressIndeterminateFill, { backgroundColor: tone }, animatedStyle]} />
      </View>
    );
  }
  const pct = Math.max(3, Math.round(((value ?? 0) / (total ?? 1)) * 100));
  return (
    <View style={gi.progressTrack} testID="gallery-import-progress-determinate">
      <View style={[gi.progressFill, { width: `${pct}%`, backgroundColor: tone }]} />
    </View>
  );
}

export interface GalleryImportSheetProps {
  title: string;
  subtitle?: string;
  onClose: () => void;
  closeLabel?: string;
  footer?: ReactNode;
  children: ReactNode;
  testID?: string;
}

/** design: gi-shared.jsx GISheet, translated onto this repo's established
 * bottom-sheet pattern (see import-drawer.tsx / gallery-import-caption-settings.tsx's
 * locale picker) rather than the prototype's CSS slide-up. */
export function GalleryImportSheet({ title, subtitle, onClose, closeLabel = 'Done', footer, children, testID }: GalleryImportSheetProps) {
  const insets = useSafeAreaInsets();
  return (
    <Modal animationType="slide" onRequestClose={onClose} presentationStyle="overFullScreen" transparent visible>
      <View style={gi.sheetRoot}>
        <Pressable accessibilityLabel="Close" accessibilityRole="button" onPress={onClose} style={gi.sheetBackdrop} />
        {/* Inset PLUS a breathing gap, not max(inset, gap): with the bare max,
            the sheet's last row sat flush against -- and on device, half
            behind -- the translucent Android nav band (same fix class as the
            keyboard-sticky-shell footers). */}
        <View style={[gi.sheetBody, { paddingBottom: Math.max(insets.bottom, spacing.lg) + spacing.lg }]} testID={testID}>
          <View style={gi.sheetGrabber} />
          <View style={gi.sheetHeader}>
            <View style={gi.sheetHeaderCopy}>
              <Text style={gi.sheetTitle}>{title}</Text>
              {subtitle ? <Text style={gi.sheetSubtitle}>{subtitle}</Text> : null}
            </View>
            <Pressable accessibilityRole="button" onPress={onClose} testID={testID ? `${testID}-close` : undefined}>
              <Text style={gi.sheetClose}>{closeLabel}</Text>
            </Pressable>
          </View>
          {/* Sheet content can exceed `sheetBody`'s 88vh cap (long detail
              copy, four GIFact rows, etc.) -- a plain View let it overflow
              invisibly with no way to reach the rest. */}
          <ScrollView contentContainerStyle={gi.sheetContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator style={gi.sheetScroll} testID={testID ? `${testID}-scroll` : undefined}>
            {children}
          </ScrollView>
          {footer ? <View style={gi.sheetFooter}>{footer}</View> : null}
        </View>
      </View>
    </Modal>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg }, center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }, header: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', minHeight: 54, paddingHorizontal: spacing.lg }, back: { color: colors.ink, fontFamily: fonts.display, fontSize: 34, lineHeight: 34 }, headerTitle: { color: colors.ink2, fontFamily: fonts.sansBold, fontSize: 13 }, headerSpacer: { width: 22 }, entryContent: { paddingBottom: spacing.xxl, paddingHorizontal: spacing.lg }, eyebrow: { color: colors.ink3, fontFamily: fonts.sansBold, fontSize: 10, letterSpacing: 1.4, textTransform: 'uppercase' }, display: { color: colors.ink, fontFamily: fonts.display, fontSize: 38, letterSpacing: -0.7, lineHeight: 39, marginTop: 11 }, displayAccent: { color: colors.primary, fontFamily: fonts.displayItalic }, displaySmall: { color: colors.ink, fontFamily: fonts.display, fontSize: 31, lineHeight: 34, marginTop: 12 }, body: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 14.5, lineHeight: 23, marginTop: 16 }, printStack: { height: 208, marginTop: 26, position: 'relative' }, print: { backgroundColor: colors.white, borderColor: colors.border, borderRadius: radius.lg, borderWidth: 1, bottom: 18, left: 18, position: 'absolute', right: 18, top: 12 }, printBackOne: { transform: [{ rotate: '-4deg' }] }, printBackTwo: { left: 10, right: 10, top: 7, transform: [{ rotate: '2deg' }] }, printFront: { backgroundColor: colors.white, borderColor: colors.border, borderRadius: radius.lg, borderWidth: 1, bottom: 13, left: 0, padding: 12, position: 'absolute', right: 0, top: 0, transform: [{ rotate: '-1deg' }] }, photoPlaceholder: { alignItems: 'center', backgroundColor: colors.primaryTint, borderRadius: radius.md, height: 118, justifyContent: 'center' }, placeholderSun: { color: colors.primary, fontSize: 34 }, thumbRow: { flexDirection: 'row', gap: 6, marginTop: 10 }, thumb: { backgroundColor: colors.seaSoft, borderRadius: 6, flex: 1, height: 34 }, fact: { alignItems: 'flex-start', flexDirection: 'row', gap: 12, marginTop: 17 }, factMark: { alignItems: 'center', backgroundColor: colors.primaryTint, borderRadius: 12, height: 32, justifyContent: 'center', width: 32 }, factMarkText: { color: colors.primary, fontFamily: fonts.sansBold }, factCopy: { flex: 1 }, factTitle: { color: colors.ink, fontFamily: fonts.sansBold, fontSize: 14 }, factBody: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 12.5, lineHeight: 19, marginTop: 3 }, consent: { backgroundColor: colors.surface, borderRadius: radius.md, marginTop: spacing.lg, padding: 14 }, consentTitle: { color: colors.ink, fontFamily: fonts.sansBold, fontSize: 13 }, consentBody: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 12, lineHeight: 18, marginTop: 5 }, footerStack: { gap: 10, paddingHorizontal: spacing.lg }, primaryButton: { alignItems: 'center', backgroundColor: colors.primary, borderRadius: radius.pill, minHeight: 52, justifyContent: 'center', paddingHorizontal: spacing.lg }, primaryButtonText: { color: colors.white, fontFamily: fonts.sansBold, fontSize: 15 }, secondaryButton: { alignItems: 'center', backgroundColor: colors.white, borderColor: colors.borderStrong, borderRadius: radius.pill, borderWidth: 1, flex: 1, minHeight: 52, justifyContent: 'center', paddingHorizontal: spacing.md }, secondaryButtonText: { color: colors.ink2, fontFamily: fonts.sansBold, fontSize: 14 }, buttonPressed: { opacity: 0.55 }, ghostButton: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 13, padding: 8, textAlign: 'center' }, footerHint: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 11.5, lineHeight: 16, textAlign: 'center' }, error: { color: colors.error, fontFamily: fonts.sans, fontSize: 12.5, lineHeight: 18, marginTop: spacing.md }, errorCard: { backgroundColor: colors.errorSoft, borderRadius: radius.md, marginTop: spacing.md, padding: 12 }, note: { color: colors.seaInk, fontFamily: fonts.sans, fontSize: 12, lineHeight: 18, marginTop: spacing.md }, managePhotos: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 12.5, marginTop: spacing.sm }, statusCard: { backgroundColor: colors.white, borderColor: colors.border, borderRadius: radius.lg, borderWidth: 1, gap: 7, marginTop: spacing.lg, padding: spacing.md }, statusEyebrow: { color: colors.seaInk, fontFamily: fonts.sansBold, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase' }, statusTitle: { color: colors.ink, fontFamily: fonts.display, fontSize: 23 }, statusBody: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 12.5 }, progressContent: { padding: spacing.lg }, progressTrack: { backgroundColor: colors.border, borderRadius: 999, height: 5, marginTop: spacing.xl, overflow: 'hidden' }, progressFill: { backgroundColor: colors.primary, borderRadius: 999, height: '100%' }, safeCard: { backgroundColor: colors.seaSoft, borderRadius: radius.lg, marginTop: spacing.xl, padding: spacing.md }, safeTitle: { color: colors.seaInk, fontFamily: fonts.sansBold, fontSize: 13 }, safeText: { color: colors.seaInk, fontFamily: fonts.sans, fontSize: 12, lineHeight: 18, marginTop: 4 }, fixedActions: { backgroundColor: colors.bg, borderTopColor: colors.border, borderTopWidth: 1, gap: 8, paddingHorizontal: spacing.lg, paddingTop: spacing.sm }, empty: { flex: 1, gap: spacing.md, justifyContent: 'center', padding: spacing.lg }, deckProgress: { backgroundColor: colors.border, height: 3, marginHorizontal: spacing.lg, overflow: 'hidden' }, deckProgressFill: { backgroundColor: colors.primary, height: '100%' }, deck: { flex: 1, margin: spacing.lg, minHeight: 300, position: 'relative' }, deckBack: { backgroundColor: colors.white, borderColor: colors.border, borderRadius: radius.xl, borderWidth: 1, bottom: 2, left: 10, position: 'absolute', right: 10, top: 8, transform: [{ rotate: '-1.2deg' }] }, deckCard: { backgroundColor: colors.white, borderColor: colors.border, borderRadius: radius.xl, borderWidth: 1, flex: 1, padding: 12 }, heroImage: { backgroundColor: colors.primaryTint, borderRadius: radius.md, flex: 1, minHeight: 180, width: '100%' }, heroImageFallback: { alignItems: 'center', backgroundColor: colors.primaryTint, borderRadius: radius.md, flex: 1, justifyContent: 'center', minHeight: 180 }, previewStrip: { flexDirection: 'row', gap: 5, marginTop: 9 }, previewThumb: { backgroundColor: colors.surface, borderRadius: 6, height: 36, width: 36 }, deckDate: { color: colors.ink3, fontFamily: fonts.sansBold, fontSize: 10, letterSpacing: 1, marginTop: 13, textTransform: 'uppercase' }, deckCaption: { color: colors.ink, fontFamily: fonts.display, fontSize: 20, lineHeight: 27, marginTop: 7 }, deckActions: { alignItems: 'stretch', flexDirection: 'row', flexWrap: 'wrap', gap: 10, padding: spacing.lg, paddingTop: 0 }, deckHint: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 11.5, lineHeight: 16, textAlign: 'center', width: '100%' }, asideList: { backgroundColor: colors.surface, borderRadius: radius.md, marginTop: 4, overflow: 'hidden', width: '100%' }, asideScroll: { maxHeight: 168 }, asideTitle: { color: colors.ink2, fontFamily: fonts.sansBold, fontSize: 12, padding: 12 }, asideRow: { alignItems: 'center', borderTopColor: colors.border, borderTopWidth: 1, flexDirection: 'row', gap: 8, minHeight: 48, padding: 12 }, asideCaption: { color: colors.ink2, flex: 1, fontFamily: fonts.sans, fontSize: 12 }, restore: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 12 },
});

// New primitives' styles (Phase 2). Kept separate from `styles` above so
// nothing here can ever collide with a key review.tsx/approval.tsx reads.
export const gi = StyleSheet.create({
  // Real top clearance (status bar / notch) comes from the screen's own
  // SafeAreaView -- every caller of this component renders inside one (see
  // KeyboardStickyShell's `safeAreaStyle`/entry.tsx, or DeviceBoundNotice's
  // own SafeAreaView). This is only the small breathing-room gap *below*
  // that real inset, not a simulated status-bar height -- adding a second,
  // fixed status-bar-sized padding here on top of the real inset was the
  // cause of the back button floating with an oversized gap on Android.
  // Design paddings verbatim (gi-shared.jsx GITopBar): android left 12 /
  // ios left 20, right 20, bottom 6; the design's paddingTop 42/54 simulates
  // the web frame's status area -- the real SafeAreaView supplies that here,
  // leaving only a small breathing gap.
  topBar: { alignItems: 'center', flexDirection: 'row', minHeight: 44, paddingBottom: 6, paddingLeft: Platform.OS === 'android' ? 12 : 20, paddingRight: 20, paddingTop: 6 },
  topBarLeft: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 15.5, paddingVertical: 10 },
  topBarBack: { alignItems: 'center', borderRadius: 22, height: 44, justifyContent: 'center', width: 44 },
  // Sized to the icon (see the component's own comment on why this is no
  topBarSpacer: { flex: 1 },
  // Shared visual treatment for every gallery-import screen's fixed footer
  // pinned below scrollable content: a solid screen-background fill (so
  // nothing scrolled can ever show through) plus a hairline top border --
  // the same idiom this file's own (currently unused) `styles.fixedActions`
  // and memory-composer-form.tsx's bottom toolbar already establish
  // elsewhere in the app -- so the footer reads as a deliberate floating
  // surface content slides *under*, not an accidental hard cut at the
  // primary button's edge (device-tested finding on the entry screen: the
  // "Nothing is deleted or tidied up" fact row hard-cut against the pink
  // button with no visual transition). One shared style, composed into each
  // screen's own `footerStyle` array, so the treatment can never drift
  // per-screen.
  stickyFooterSurface: { backgroundColor: colors.bg, borderTopColor: colors.border, borderTopWidth: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  reassureRow: { alignItems: 'flex-start', flexDirection: 'row', gap: 7 },
  reassureText: { color: colors.ink3, flex: 1, fontFamily: fonts.sans, fontSize: 12.5, lineHeight: 18, marginTop: 1 },
  pill: { alignSelf: 'flex-start', borderRadius: radius.pill, borderWidth: 1, paddingHorizontal: 11, paddingVertical: 5 },
  pillText: { fontFamily: fonts.sansBold, fontSize: 12 },
  factRow: { flexDirection: 'row', gap: 13 },
  factIconWrap: { alignItems: 'center', backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 11, borderWidth: 1, height: 34, justifyContent: 'center', width: 34 },
  factCopyWrap: { flex: 1 },
  factTitle: { color: colors.ink, fontFamily: fonts.sansBold, fontSize: 14.5, lineHeight: 19 },
  factBody: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 13, lineHeight: 19, marginTop: 3 },
  progressTrack: { backgroundColor: colors.border, borderRadius: radius.pill, height: 6, overflow: 'hidden' },
  progressFill: { borderRadius: radius.pill, height: '100%' },
  progressIndeterminateFill: { borderRadius: radius.pill, height: '100%', width: '38%' },
  sheetRoot: { flex: 1, justifyContent: 'flex-end' },
  sheetBackdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(36, 28, 18, 0.34)' },
  sheetBody: { backgroundColor: colors.white, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, maxHeight: '88%' },
  sheetGrabber: { alignSelf: 'center', backgroundColor: colors.border, borderRadius: 999, height: 5, marginTop: 10, width: 38 },
  sheetHeader: { alignItems: 'flex-start', flexDirection: 'row', gap: 12, paddingHorizontal: spacing.lg, paddingTop: 10 },
  sheetHeaderCopy: { flex: 1 },
  sheetTitle: { color: colors.ink, fontFamily: fonts.display, fontSize: 22 },
  sheetSubtitle: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 13, lineHeight: 19, marginTop: 5 },
  sheetClose: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 14.5, paddingTop: 2 },
  sheetScroll: { flexShrink: 1 },
  sheetContent: { flexGrow: 1 },
  sheetFooter: { borderTopColor: colors.border, borderTopWidth: 1, gap: 8, paddingHorizontal: spacing.lg, paddingTop: 12 },
  deviceBoundScrollContent: { flexGrow: 1, justifyContent: 'center' },
  deviceBoundBody: { gap: spacing.md, paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  deviceBoundNoteWrap: { marginTop: 4 },
  deviceBoundActions: { gap: 10, paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
});
