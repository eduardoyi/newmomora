// Shared layout for the native Keepsakes product pages
// (docs/plans/keepsakes-redesign.md D3/D4): a stack screen (no tab bar) with a
// round back button, a scrolling body and a fixed bottom CTA bar that clears
// the home indicator / Android navigation bar. The pieces below are the
// approved v3 design's vocabulary: stage, eyebrow/title/body, teal
// eligibility box, privacy note, facts box and option rows. No text inputs.
import { SymbolView } from 'expo-symbols';
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fonts, radius } from '@/constants/theme';

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

export interface ProductPageShellProps {
  testID: string;
  onBack: () => void;
  /** The fixed bottom bar (a `ProductCtaBar`); omit while the page is loading. */
  footer?: ReactNode;
  children: ReactNode;
}

export function ProductPageShell({ testID, onBack, footer, children }: ProductPageShellProps) {
  return (
    <View style={styles.screen} testID={testID}>
      <SafeAreaView edges={['top']}>
        <View style={styles.header}>
          <Pressable
            accessibilityLabel="Back"
            accessibilityRole="button"
            onPress={onBack}
            style={styles.backButton}
            testID="keepsakes-product-back"
          >
            <SymbolView
              fallback={<Text style={styles.backGlyph}>‹</Text>}
              name={{ ios: 'chevron.left', android: 'chevron_left' }}
              size={17}
              tintColor={colors.ink2}
            />
          </Pressable>
        </View>
      </SafeAreaView>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {children}
      </ScrollView>
      {footer}
    </View>
  );
}

export function ProductPageLoading() {
  return (
    <View style={styles.loading} testID="keepsakes-product-loading">
      <ActivityIndicator color={colors.primary} size="large" />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Header copy
// ---------------------------------------------------------------------------

export function ProductStage({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <View style={styles.stage} testID={testID}>
      {children}
    </View>
  );
}

export function ProductHeading({ eyebrow, title, body }: { eyebrow: string; title: string; body?: string }) {
  return (
    <View style={styles.heading}>
      <Text style={styles.eyebrow}>{eyebrow.toUpperCase()}</Text>
      <Text style={styles.title}>{title}</Text>
      {body ? <Text style={styles.body}>{body}</Text> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Notes and boxes
// ---------------------------------------------------------------------------

/** The teal "you're eligible" line. `tone="warn"` is the thin-period warning (amber, not blocking). */
export function EligibilityBox({
  children,
  tone = 'ok',
  testID,
}: {
  children: ReactNode;
  tone?: 'ok' | 'warn';
  testID?: string;
}) {
  return (
    <View style={[styles.eligibility, tone === 'warn' && styles.eligibilityWarn]} testID={testID}>
      <Text style={[styles.eligibilityText, tone === 'warn' && styles.eligibilityTextWarn]}>{children}</Text>
    </View>
  );
}

export function privacyNoteText(product: 'card' | 'book'): string {
  return `Viewers in your family won’t see this ${product}. Your surprise is safe.`;
}

export function PrivacyNote({ product }: { product: 'card' | 'book' }) {
  return (
    <View style={styles.privacy} testID="keepsakes-product-privacy">
      <SymbolView
        fallback={<Text style={styles.lockGlyph}>🔒</Text>}
        name={{ ios: 'lock.fill', android: 'lock' }}
        size={13}
        tintColor={colors.ink3}
      />
      <Text style={styles.privacyText}>{privacyNoteText(product)}</Text>
    </View>
  );
}

export interface ProductFact {
  /** Bold lead-in, e.g. "5×7, printed on both sides." */
  lead: string;
  /** The rest of the sentence(s); optional. */
  rest?: string;
}

export function FactsBox({ facts, testID }: { facts: ProductFact[]; testID?: string }) {
  return (
    <View style={styles.facts} testID={testID ?? 'keepsakes-product-facts'}>
      {facts.map((fact) => (
        <View key={fact.lead} style={styles.factRow}>
          <View style={styles.factBullet} />
          <Text style={styles.factText}>
            <Text style={styles.factLead}>{fact.lead}</Text>
            {fact.rest ? ` ${fact.rest}` : ''}
          </Text>
        </View>
      ))}
    </View>
  );
}

export function ShipByPill({ text }: { text: string }) {
  return (
    <View style={styles.shipBy} testID="holiday-card-ship-by">
      <Text style={styles.shipByText}>{text}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Options (radio rows) and chips
// ---------------------------------------------------------------------------

export function SectionLabel({ children }: { children: ReactNode }) {
  return <Text style={styles.sectionLabel}>{children}</Text>;
}

export function ChoiceChip({
  label,
  selected,
  onPress,
  testID,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.chip, selected && styles.chipSelected, pressed && styles.pressed]}
      testID={testID}
    >
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
    </Pressable>
  );
}

export interface OptionRowProps {
  label: string;
  /** Second line (a date range). */
  meta?: string | null;
  /** Right-aligned status, e.g. "already made". */
  status?: string | null;
  /** A short caution under the label (amber). */
  caution?: string | null;
  selected: boolean;
  onPress: () => void;
  testID?: string;
}

/** White radius-12 row with a radio; selected = primary border + a 3px primaryTint ring. */
export function OptionRow({ label, meta, status, caution, selected, onPress, testID }: OptionRowProps) {
  return (
    <View style={[styles.optionRing, selected && styles.optionRingSelected]}>
      <Pressable
        accessibilityRole="radio"
        accessibilityState={{ selected }}
        onPress={onPress}
        style={({ pressed }) => [styles.option, selected && styles.optionSelected, pressed && styles.pressed]}
        testID={testID}
      >
        <View style={[styles.radio, selected && styles.radioSelected]}>
          {selected ? <View style={styles.radioDot} /> : null}
        </View>
        <View style={styles.optionText}>
          <Text style={styles.optionLabel}>{label}</Text>
          {meta ? <Text style={styles.optionMeta}>{meta}</Text> : null}
          {caution ? <Text style={styles.optionCaution}>{caution}</Text> : null}
        </View>
        {status ? <Text style={styles.optionStatus}>{status}</Text> : null}
      </Pressable>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Bottom CTA bar
// ---------------------------------------------------------------------------

export interface ProductCtaBarProps {
  label: string;
  subline?: string;
  onPress: () => void;
  disabled?: boolean;
  isBusy?: boolean;
  testID: string;
}

export function ProductCtaBar({ label, subline, onPress, disabled = false, isBusy = false, testID }: ProductCtaBarProps) {
  const insets = useSafeAreaInsets();
  const isDisabled = disabled || isBusy;
  return (
    <View style={[styles.ctaBar, { paddingBottom: insets.bottom + 12 }]} testID={`${testID}-bar`}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: isDisabled, busy: isBusy }}
        disabled={isDisabled}
        onPress={onPress}
        style={({ pressed }) => [styles.cta, isDisabled && styles.ctaDisabled, pressed && styles.pressed]}
        testID={testID}
      >
        {isBusy ? <ActivityIndicator color={colors.white} size="small" /> : null}
        <Text style={[styles.ctaText, isDisabled && styles.ctaTextDisabled]}>{label}</Text>
      </Pressable>
      {subline ? <Text style={styles.ctaSubline}>{subline}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.bg, flex: 1 },
  header: { paddingHorizontal: 20, paddingVertical: 10 },
  backButton: {
    alignItems: 'center',
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: 20,
    borderWidth: 1,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  backGlyph: { color: colors.ink2, fontSize: 22, fontWeight: '300', marginTop: -2 },
  content: { gap: 16, padding: 20, paddingBottom: 28 },
  loading: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  stage: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    height: 300,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  heading: { gap: 6 },
  eyebrow: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 13, letterSpacing: 1 },
  title: { color: colors.ink, fontFamily: fonts.display, fontSize: 30, lineHeight: 36 },
  body: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 14, lineHeight: 21 },
  eligibility: { backgroundColor: colors.seaSoft, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 12 },
  eligibilityWarn: { backgroundColor: colors.sunSoft },
  eligibilityText: { color: colors.seaInk, fontFamily: fonts.sansMedium, fontSize: 13, lineHeight: 19 },
  eligibilityTextWarn: { color: colors.sunInk },
  privacy: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  lockGlyph: { fontSize: 11 },
  privacyText: { color: colors.ink2, flex: 1, fontFamily: fonts.sans, fontSize: 12.5, lineHeight: 18 },
  facts: { backgroundColor: colors.surface, borderRadius: radius.lg, gap: 10, padding: 16 },
  factRow: { alignItems: 'flex-start', flexDirection: 'row', gap: 10 },
  factBullet: { backgroundColor: colors.primary, height: 7, marginTop: 7, width: 7 },
  factText: { color: colors.ink2, flex: 1, fontFamily: fonts.sans, fontSize: 13.5, lineHeight: 21 },
  factLead: { color: colors.ink, fontFamily: fonts.sansBold },
  shipBy: {
    alignSelf: 'flex-start',
    backgroundColor: colors.primaryTint,
    borderColor: colors.primarySoft,
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  shipByText: { color: colors.primaryDark, fontFamily: fonts.sansBold, fontSize: 12.5, lineHeight: 18 },
  sectionLabel: { color: colors.ink, fontFamily: fonts.displayMedium, fontSize: 18, lineHeight: 24 },
  chip: {
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { color: colors.ink2, fontFamily: fonts.sansMedium, fontSize: 13.5 },
  chipTextSelected: { color: colors.white, fontFamily: fonts.sansBold },
  pressed: { opacity: 0.85 },
  optionRing: { borderColor: 'transparent', borderRadius: radius.md + 3, borderWidth: 3, margin: -3 },
  optionRingSelected: { borderColor: colors.primaryTint },
  option: {
    alignItems: 'center',
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  optionSelected: { borderColor: colors.primary },
  radio: {
    alignItems: 'center',
    borderColor: colors.borderStrong,
    borderRadius: 9,
    borderWidth: 1.5,
    height: 18,
    justifyContent: 'center',
    width: 18,
  },
  radioSelected: { borderColor: colors.primary },
  radioDot: { backgroundColor: colors.primary, borderRadius: 5, height: 10, width: 10 },
  optionText: { flex: 1, gap: 2 },
  optionLabel: { color: colors.ink, fontFamily: fonts.sansBold, fontSize: 14.5 },
  optionMeta: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 12 },
  optionCaution: { color: colors.sunInk, fontFamily: fonts.sans, fontSize: 11.5, lineHeight: 16 },
  optionStatus: { color: colors.ink3, fontFamily: fonts.sansMedium, fontSize: 12 },
  ctaBar: {
    backgroundColor: colors.bg,
    borderTopColor: colors.border,
    borderTopWidth: 1,
    gap: 8,
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  cta: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    flexDirection: 'row',
    gap: 8,
    height: 52,
    justifyContent: 'center',
  },
  ctaDisabled: { backgroundColor: colors.borderStrong },
  ctaText: { color: colors.white, fontFamily: fonts.sansBold, fontSize: 16 },
  ctaTextDisabled: { color: colors.white },
  ctaSubline: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 12, textAlign: 'center' },
});
