// Gallery import -- the pre-permission trust explainer and the post-permission
// outcome screens (design: gi-trust.jsx GIExplainer ~L7-111 and
// GIPermissionOutcome ~L229-289). Shown before the OS ever asks, and after it
// answers, replacing the flow's previous inline error strings.
//
// Simplified per the 2026-08-23 copy pass (docs/plans/gallery-import-continuous.md
// I4b, "each reassurance once per flow, on the trust screen"): what used to
// be three numbered cards, a boxed "no face recognition" callout, a shield
// reassurance row, and two separate detail sheets is now three plain lines
// plus a single merged "Details" sheet. Every other screen in this flow
// keeps at most one line of reassurance, if any.
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { KeyboardStickyShell } from '@/components/keyboard-sticky-shell';
import { colors, fonts, spacing } from '@/constants/theme';

import {
  GalleryImportFact,
  GalleryImportPill,
  GalleryImportSheet,
  GalleryImportTopBar,
  PrimaryButton,
  SecondaryButton,
  gi,
} from './gallery-import-shared';

export type GalleryImportTrustPlatform = 'ios' | 'android';

export interface GalleryImportTrustExplainerProps {
  platform?: GalleryImportTrustPlatform;
  onContinue: () => void;
  onCancel: () => void;
  testID?: string;
}

/** design: gi-trust.jsx GIExplainer. Shown before the OS permission prompt
 * whenever the app does not already have photo permission -- see
 * gallery-import-entry.tsx's requestPermissionThenStart. */
export function GalleryImportTrustExplainer({ platform = Platform.OS === 'android' ? 'android' : 'ios', onContinue, onCancel, testID = 'gallery-import-trust-explainer' }: GalleryImportTrustExplainerProps) {
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  return (
    <>
      <KeyboardStickyShell
        header={<GalleryImportTopBar left="Not now" onLeft={onCancel} testID="gallery-import-trust-not-now" />}
        contentContainerStyle={tr.scrollContent}
        footer={<>
          <PrimaryButton label={platform === 'ios' ? 'Choose which photos' : 'Continue'} onPress={onContinue} testID="gallery-import-trust-continue" />
          <Text style={tr.footer}>Next, {platform === 'ios' ? 'iOS' : 'Android'} will ask what Momora may see.</Text>
        </>}
        footerStyle={[gi.stickyFooterSurface, tr.actions]}
        footerTestID="gallery-import-trust-footer"
        safeAreaStyle={tr.screen}
        scrollTestID="gallery-import-trust-scroll"
        testID={testID}
      >
        <View style={tr.header}>
          <Text style={tr.eyebrow}>Before Momora starts</Text>
          <Text style={tr.display}>Here is how{'\n'}it works.</Text>
        </View>
        <View style={tr.rows}>
          <Text style={tr.row}>Your phone groups your photos by day. Nothing is changed or deleted.</Text>
          <Text style={tr.row}>Small previews go to Momora to pick the best photos and write draft captions. No names, no faces recognized, no location.</Text>
          <Text style={tr.row}>You review every suggestion. Only what you keep is saved. The rest clears on its own.</Text>
        </View>
        <Pressable accessibilityRole="button" onPress={() => setIsDetailsOpen(true)} style={tr.detailsLink} testID="gallery-import-trust-details">
          <Text style={tr.detailsLinkText}>Details</Text>
        </Pressable>
      </KeyboardStickyShell>

      {isDetailsOpen ? (
        <GalleryImportSheet onClose={() => setIsDetailsOpen(false)} testID="gallery-import-trust-details-sheet" title="Details">
          <View style={sh.body}>
            <GalleryImportFact icon="image" title="What a preview is">
              A shrunk copy of your photo, about the size of a thumbnail.
            </GalleryImportFact>
            <GalleryImportFact icon="layers" title="Where it goes">
              Momora’s own private storage, used only to write the drafts.
            </GalleryImportFact>
            <GalleryImportFact icon="clock" title="How long it lasts">
              Until you finish reviewing, then it clears on its own.
            </GalleryImportFact>
            <GalleryImportFact icon="x" title="What is never sent">
              Names, ages, who is related to whom, your location, and file names.
            </GalleryImportFact>
            <GalleryImportFact icon="shield" title="Your camera roll">
              Read only. Momora cannot delete, move or edit a photo, and you can stop at any time.
            </GalleryImportFact>
          </View>
        </GalleryImportSheet>
      ) : null}
    </>
  );
}

// ── Permission outcome screens ──────────────────────────────────────

export type GalleryImportPermissionOutcomeKind = 'limited' | 'denied' | 'blocked';

export interface GalleryImportPermissionOutcomeProps {
  kind: GalleryImportPermissionOutcomeKind;
  platform?: GalleryImportTrustPlatform;
  onPrimary: () => void;
  onSecondary: () => void;
  /** The top bar's "Close" button -- always just dismisses back to the entry
   * screen, distinct from the labeled secondary action (e.g. "Choose more
   * photos" for `limited`, which must not also close the screen). */
  onClose: () => void;
  testID?: string;
}

/** design: gi-trust.jsx GIPermissionOutcome. Replaces the flow's former
 * inline error strings in gallery-import-entry.tsx's requestPermissionThenStart
 * error branches. */
export function GalleryImportPermissionOutcome({ kind, platform = Platform.OS === 'android' ? 'android' : 'ios', onPrimary, onSecondary, onClose, testID = `gallery-import-permission-${kind}` }: GalleryImportPermissionOutcomeProps) {
  const isIOS = platform === 'ios';
  const copy = {
    limited: {
      pill: 'Limited access', tone: 'sun' as const,
      title: 'Momora can see\nthe photos you chose.',
      body: isIOS
        ? 'Momora will look through those and suggest what it can. Choose more now if you want it to see further.'
        : 'Momora will look through those and suggest what it can. Select more now if you want it to see further.',
      primary: 'Look through these', secondary: isIOS ? 'Choose more photos' : 'Select more photos',
    },
    denied: {
      pill: 'No photo access', tone: 'neutral' as const,
      title: 'Momora cannot\nsee your photos.',
      body: isIOS
        ? 'Nothing else in Momora is affected. Change this anytime in iOS Settings under Momora.'
        : 'Nothing else in Momora is affected. Change this anytime in Android settings under Momora.',
      primary: isIOS ? 'Open Settings' : 'Open app settings', secondary: 'Back to my journal',
    },
    blocked: {
      pill: 'Needs a settings change', tone: 'neutral' as const,
      title: 'This one has to\nbe changed in\nsettings.',
      body: isIOS
        ? 'Open Settings, then Momora, then Photos, and choose All Photos or Selected Photos.'
        : 'Open Settings, then Apps, then Momora, then Permissions, then Photos and videos.',
      primary: isIOS ? 'Open Settings' : 'Open app settings', secondary: 'Not now',
    },
  }[kind];
  return (
    <KeyboardStickyShell
      contentContainerStyle={tr.scrollContent}
      footer={<>
        <PrimaryButton label={copy.primary} onPress={onPrimary} testID={`${testID}-primary`} />
        <SecondaryButton label={copy.secondary} onPress={onSecondary} testID={`${testID}-secondary`} />
      </>}
      footerStyle={[gi.stickyFooterSurface, tr.actions]}
      footerTestID={`${testID}-footer`}
      safeAreaStyle={tr.screen}
      scrollTestID={`${testID}-scroll`}
      testID={testID}
    >
      <GalleryImportTopBar left="Close" onLeft={onClose} testID={`${testID}-top-bar-close`} />
      <View style={tr.header}>
        <GalleryImportPill tone={copy.tone === 'sun' ? 'sun' : 'soft'}>{copy.pill}</GalleryImportPill>
        <Text style={[tr.display, tr.displayTight]}>{copy.title}</Text>
        <Text style={tr.displayBody}>{copy.body}</Text>
      </View>
    </KeyboardStickyShell>
  );
}

const tr = StyleSheet.create({
  screen: { backgroundColor: colors.bg, flex: 1 },
  // Real bottom padding beyond this is computed by KeyboardStickyShell
  // itself (from the footer's measured height) -- this is only the resting
  // cushion below the last content block once the scroll reaches its end.
  scrollContent: { paddingBottom: spacing.lg },
  header: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  eyebrow: { color: colors.ink3, fontFamily: fonts.sansBold, fontSize: 10, letterSpacing: 1.4, textTransform: 'uppercase' },
  display: { color: colors.ink, fontFamily: fonts.display, fontSize: 32, lineHeight: 36, marginTop: 12 },
  displayTight: { marginTop: 14 },
  displayBody: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 14.5, lineHeight: 22, marginTop: 14 },
  rows: { gap: 14, paddingHorizontal: spacing.lg, paddingTop: 24 },
  row: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 14.5, lineHeight: 21 },
  detailsLink: { alignSelf: 'flex-start', marginLeft: spacing.lg, marginTop: 18 },
  detailsLinkText: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 13.5, textDecorationLine: 'underline' },
  // The solid background + hairline top border live in the shared
  // `gi.stickyFooterSurface` (composed in via `footerStyle` above) -- this
  // is only the element spacing within the footer stack.
  actions: { gap: 10 },
  footer: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 11.5, textAlign: 'center' },
});

const sh = StyleSheet.create({
  body: { gap: 18, paddingBottom: 26, paddingHorizontal: spacing.lg, paddingTop: 16 },
});
