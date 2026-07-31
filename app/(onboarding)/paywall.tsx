// S15 -- Paywall (docs/plans/onboarding-design-brief.md, WP3).
//
// TODO(paywall): this screen is a deliberate, non-functional placeholder --
// the owner wants it to LOOK like a real paywall without being wired to
// anything. When real billing lands, swap in:
//   1. A RevenueCat-or-equivalent SDK dependency (none is added here --
//      docs/features/onboarding.md calls this out as "not yet chosen").
//   2. Real package/offering data behind the single plan card below (price
//      currently hardcoded from docs/PRICING_STRATEGY.md's $99.99/yr decision).
//   3. An actual purchase flow behind "Start my free week" -- it currently
//      just calls router.push(onboardingPortraitRoute) with zero billing
//      side effects.
//   4. A real "Restore purchases" handler (currently an inert Pressable).
//   5. A real entitlement check somewhere upstream of this screen/the (app)
//      group once subscriptions exist -- none exists yet, so nothing today
//      is actually gated by a purchase.
// The close-confirm sheet's "Leave" button is likewise inert by design (see
// its own comment below) -- do not wire it to a real "abandon onboarding"
// action without re-reading that comment first.
import { Image } from 'expo-image';
import { Link, router } from 'expo-router';
import { Check, X } from 'lucide-react-native';
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { OnbButton } from '@/components/onboarding/onb-button';
import { OnbBody, OnbDisplay, OnbTitle } from '@/components/onboarding/onb-typography';
import { OnbShell } from '@/components/onboarding/onb-shell';
import { colors, emotionColors, fonts, radius } from '@/constants/theme';
import { paywallBackdropMemories, type OnboardingSampleMemory } from '@/constants/onboarding-memories';
import { useOnboardingKidPossessive } from '@/hooks/use-onboarding-kid-possessive';
import { onboardingPortraitRoute } from '@/lib/onboarding-routes';

const TRUST_BULLETS = [
  '$0.00 today',
  'Reminder before your trial ends',
  'Cancelling takes about 10 seconds',
  'Your memories export free, forever',
];

interface BackdropLayout {
  rotateDeg: number;
  offsetX: number;
  zIndex: number;
}

// Real memory pages (src/constants/onboarding-memories.ts's
// paywallBackdropMemories -- the same three yearMemories entries the design
// brief calls out for this backdrop) fill the same three fanned positions
// the old generic "paywall-page-1/3/4" illustration slots used to occupy.
const BACKDROP_LAYOUTS: readonly BackdropLayout[] = [
  { rotateDeg: -6, offsetX: -104, zIndex: 1 },
  { rotateDeg: 2, offsetX: 0, zIndex: 2 },
  { rotateDeg: 7, offsetX: 104, zIndex: 1 },
];

const PAGE_WIDTH = 132;
const PAGE_HEIGHT = 168;

export default function PaywallScreen() {
  const [isCloseSheetVisible, setIsCloseSheetVisible] = useState(false);

  // Draft-first, real-server-data-once-cleared -- shared with included.tsx
  // (see src/hooks/use-onboarding-kid-possessive.ts for why this moved out
  // of a per-screen local resolver: S12B's code.tsx clears the draft before
  // routing into this screen, the same bug WP6 already fixed on S16).
  const resolvedPossessive = useOnboardingKidPossessive();

  const handleStartTrial = () => {
    // No billing call of any kind -- see the TODO(paywall) block above.
    router.push(onboardingPortraitRoute);
  };

  const openCloseSheet = () => setIsCloseSheetVisible(true);

  // "Stay" is the sheet's real action: dismiss the confirm sheet and remain
  // on the paywall. "Leave" is deliberately inert *beyond* dismissing this
  // same local overlay -- per the plan, it must not touch billing or advance
  // the flow, and there is no "exit onboarding" destination specified for
  // it yet. Closing the sheet (rather than leaving it stuck open forever) is
  // the one bit of behavior both buttons share; wiring a real "leave" action
  // is TODO(paywall) work, not a placeholder detail.
  const dismissCloseSheet = () => setIsCloseSheetVisible(false);

  return (
    <>
      <OnbShell
        contentContainerStyle={styles.scrollContent}
        footer={
          <View>
            <OnbButton
              label="Start my free week"
              onPress={handleStartTrial}
              style={styles.fullWidthButton}
              testID="onb-paywall-cta-button"
            />
            <View style={styles.legalRow}>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  // Inert -- see TODO(paywall) block above.
                }}
                testID="onb-paywall-restore-button"
              >
                <Text style={styles.legalText}>Restore purchases</Text>
              </Pressable>
              <Link href="https://usemomora.com/terms-of-service/" style={styles.legalText} testID="onb-paywall-terms-link">
                Terms
              </Link>
              <Link href="https://usemomora.com/privacy-policy/" style={styles.legalText} testID="onb-paywall-privacy-link">
                Privacy
              </Link>
            </View>
          </View>
        }
        testID="onb-paywall-screen"
      >
        <View style={styles.root}>
          <Pressable
            accessibilityLabel="Close"
            accessibilityRole="button"
            hitSlop={10}
            onPress={openCloseSheet}
            style={styles.closeButton}
            testID="onb-paywall-close-button"
          >
            <X color={colors.ink3} size={15} strokeWidth={2} />
          </Pressable>

          <View style={styles.backdrop}>
            {paywallBackdropMemories.map((memory: OnboardingSampleMemory, index) => {
              const layout = BACKDROP_LAYOUTS[index];
              return (
                <View
                  key={memory.key}
                  style={[
                    styles.backdropPage,
                    {
                      marginLeft: layout.offsetX - PAGE_WIDTH / 2,
                      transform: [{ rotate: `${layout.rotateDeg}deg` }],
                      zIndex: layout.zIndex,
                    },
                  ]}
                >
                  <Image
                    accessibilityLabel={memory.text}
                    contentFit="cover"
                    source={memory.asset}
                    style={styles.backdropPageImage}
                    testID={`onb-paywall-page-${memory.key}`}
                  />
                </View>
              );
            })}
          </View>

          <OnbDisplay size={27} style={styles.headline}>
            {`Turn ${resolvedPossessive} little moments into something you'll hold forever.`}
          </OnbDisplay>

          <View style={styles.planCard} testID="onb-paywall-plan-card">
            <View style={styles.planCardText}>
              <OnbTitle size={17}>7 days free, then $99.99/year</OnbTitle>
              <OnbBody muted size={13} style={styles.planCardSubtext}>
                {"That's $8.33/month"}
              </OnbBody>
            </View>
            <View style={styles.planCardCheck}>
              <Check color={colors.white} size={13} strokeWidth={3} />
            </View>
          </View>

          <View style={styles.trustList}>
            {TRUST_BULLETS.map((bullet) => (
              <View key={bullet} style={styles.trustRow}>
                <Check color={emotionColors.calm.c} size={12} strokeWidth={2.5} />
                <OnbBody muted size={12.5}>
                  {bullet}
                </OnbBody>
              </View>
            ))}
          </View>
        </View>
      </OnbShell>

      <Modal animationType="fade" onRequestClose={dismissCloseSheet} transparent visible={isCloseSheetVisible}>
        <Pressable
          accessibilityLabel="Dismiss"
          accessibilityRole="button"
          onPress={dismissCloseSheet}
          style={styles.sheetBackdrop}
          testID="onb-paywall-sheet-backdrop"
        />
        <View pointerEvents="box-none" style={styles.sheetWrap}>
          <View style={styles.sheetCard} testID="onb-paywall-sheet">
            <View style={styles.sheetHandle} />
            <OnbTitle size={20}>{`Leave ${resolvedPossessive} first page here for now?`}</OnbTitle>
            <OnbBody muted size={14.5} style={styles.sheetBody}>
              {"It'll be waiting if you come back."}
            </OnbBody>
            <View style={styles.sheetButtons}>
              <OnbButton
                label="Leave"
                onPress={dismissCloseSheet}
                style={styles.sheetLeaveButton}
                testID="onb-paywall-sheet-leave-button"
                variant="secondary"
              />
              <OnbButton
                label="Stay"
                onPress={dismissCloseSheet}
                style={styles.sheetStayButton}
                testID="onb-paywall-sheet-stay-button"
              />
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    paddingBottom: 0,
  },
  root: {
    flex: 1,
  },
  closeButton: {
    position: 'absolute',
    top: 8,
    right: 18,
    zIndex: 5,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(44,36,24,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  backdrop: {
    height: 208,
    marginTop: 44,
  },
  backdropPage: {
    position: 'absolute',
    left: '50%',
    top: 20,
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 5,
    shadowColor: colors.ink,
    shadowOpacity: 0.14,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
    elevation: 5,
  },
  backdropPageImage: {
    width: '100%',
    height: '100%',
  },
  headline: {
    marginTop: 6,
    paddingHorizontal: 26,
    textAlign: 'center',
  },
  planCard: {
    marginTop: 18,
    marginHorizontal: 24,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.white,
    borderWidth: 2,
    borderColor: colors.primary,
    borderRadius: radius.xl,
    padding: 16,
  },
  planCardText: {
    flex: 1,
  },
  planCardSubtext: {
    marginTop: 3,
  },
  planCardCheck: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  trustList: {
    marginTop: 12,
    marginHorizontal: 24,
    gap: 5,
  },
  trustRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  fullWidthButton: {
    width: '100%',
  },
  legalRow: {
    marginTop: 10,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 16,
  },
  legalText: {
    fontFamily: fonts.sans,
    fontSize: 11,
    color: colors.ink3,
  },
  sheetBackdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(44, 36, 24, 0.32)',
  },
  sheetWrap: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheetCard: {
    backgroundColor: colors.white,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 40,
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.border,
    marginBottom: 18,
  },
  sheetBody: {
    marginTop: 8,
  },
  sheetButtons: {
    marginTop: 20,
    flexDirection: 'row',
    gap: 10,
  },
  sheetLeaveButton: {
    flex: 1,
  },
  sheetStayButton: {
    flex: 2,
  },
});
