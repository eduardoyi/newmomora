// Gallery import -- the pre-permission trust explainer and the post-permission
// outcome screens (design: gi-trust.jsx GIExplainer ~L7-111 and
// GIPermissionOutcome ~L229-289). Shown before the OS ever asks, and after it
// answers, replacing the flow's previous inline error strings.
import { useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { KeyboardStickyShell } from '@/components/keyboard-sticky-shell';
import { colors, fonts, radius, spacing } from '@/constants/theme';

import {
  GalleryImportFact,
  GalleryImportPill,
  GalleryImportReassure,
  GalleryImportSheet,
  GalleryImportTopBar,
  PrimaryButton,
  SecondaryButton,
  gi,
} from './gallery-import-shared';

const REVIEW_DAYS_FALLBACK = 30;

// ── Trust cards ─────────────────────────────────────────────────────

function TrustCard({ n, title, body, foot, action, tone = 'primary' }: {
  n: string; title: string; body: string; foot: string;
  action?: { label: string; onPress: () => void };
  tone?: 'primary' | 'sun';
}) {
  const numberColor = tone === 'sun' ? colors.sunInk : colors.primary;
  return (
    <View style={tc.card}>
      <View style={[tc.badge, { backgroundColor: tone === 'sun' ? colors.sunSoft : colors.primaryTint }]}>
        <Text style={[tc.badgeText, { color: numberColor }]}>{n}</Text>
      </View>
      <View style={tc.copy}>
        <Text style={tc.title}>{title}</Text>
        <Text style={tc.body}>{body}</Text>
        <View style={tc.footRow}>
          <GalleryImportPill tone={tone === 'sun' ? 'sun' : 'soft'}>{foot}</GalleryImportPill>
          {action ? (
            <Text onPress={action.onPress} style={tc.action} testID={`gallery-import-trust-detail-${action.label}`}>
              {action.label}
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function RetentionRow({ label, value, body, tone }: { label: string; value: string; body: string; tone: 'sea' | 'sun' | 'primary' }) {
  const barColor = { sea: colors.sea, sun: colors.sunInk, primary: colors.primary }[tone];
  return (
    <View style={rr.row}>
      <View style={[rr.bar, { backgroundColor: barColor }]} />
      <View style={rr.copy}>
        <View style={rr.headline}>
          <Text style={rr.label}>{label}</Text>
          <Text style={[rr.value, { color: barColor }]}>{value}</Text>
        </View>
        <Text style={rr.body}>{body}</Text>
      </View>
    </View>
  );
}

export type GalleryImportTrustPlatform = 'ios' | 'android';

export interface GalleryImportTrustExplainerProps {
  platform?: GalleryImportTrustPlatform;
  onContinue: () => void;
  onCancel: () => void;
  reviewDays?: number;
  testID?: string;
}

/** design: gi-trust.jsx GIExplainer. Shown before the OS permission prompt
 * whenever the app does not already have photo permission -- see
 * gallery-import-entry.tsx's requestPermissionThenStart. */
export function GalleryImportTrustExplainer({ platform = Platform.OS === 'android' ? 'android' : 'ios', onContinue, onCancel, reviewDays = REVIEW_DAYS_FALLBACK, testID = 'gallery-import-trust-explainer' }: GalleryImportTrustExplainerProps) {
  const [openSheet, setOpenSheet] = useState<'preview' | 'retention' | null>(null);
  return (
    <>
      <KeyboardStickyShell
        header={<GalleryImportTopBar left="Cancel" onLeft={onCancel} testID="gallery-import-trust-cancel" />}
        contentContainerStyle={tr.scrollContent}
        footer={<>
          <PrimaryButton label={platform === 'ios' ? 'Choose which photos' : 'Continue'} onPress={onContinue} testID="gallery-import-trust-continue" />
          <SecondaryButton label="Not now" onPress={onCancel} testID="gallery-import-trust-not-now" />
          <Text style={tr.footer}>Next, {platform === 'ios' ? 'iOS' : 'Android'} will ask what Momora may see.</Text>
        </>}
        footerStyle={[gi.stickyFooterSurface, tr.actions]}
        footerTestID="gallery-import-trust-footer"
        safeAreaStyle={tr.screen}
        scrollTestID="gallery-import-trust-scroll"
        testID={testID}
      >
        <View style={tr.header}>
          <Text style={tr.eyebrow}>Before we look</Text>
          <Text style={tr.display}>Here is exactly{'\n'}what happens.</Text>
        </View>
        <View style={tr.cards}>
          <TrustCard
            body="Momora reads the photos you allow: dates, and how they group into events. Nothing is deleted, moved, edited or tidied up."
            foot="Reading only · stays on this phone"
            n="1"
            title="Your phone does the looking"
          />
          <TrustCard
            action={{ label: 'What a preview is', onPress: () => setOpenSheet('preview') }}
            body="To suggest captions and pick which photos tell the story, Momora sends small, low-resolution copies to its own private storage, which it uses to write the drafts."
            foot="Small copies, before you approve anything"
            n="2"
            title="Small previews are sent to Momora’s private storage"
            tone="sun"
          />
          <TrustCard
            action={{ label: 'What is kept, and for how long', onPress: () => setOpenSheet('retention') }}
            body="When you keep a suggestion, Momora saves the full-size photos into your journal. Everything else, including the previews, is cleared."
            foot={`Suggestions clear after ${reviewDays} days`}
            n="3"
            title="Only what you keep is saved"
          />
        </View>
        <View style={tr.noFaceCard}>
          <Text style={tr.noFaceTitle}>No face recognition. No location.</Text>
          <Text style={tr.noFaceBody}>
            Momora never tries to work out who is in a photo or where it was taken. It writes what it can see, and you add the names.
          </Text>
        </View>
        <View style={tr.noteWrap}>
          <GalleryImportReassure />
        </View>
      </KeyboardStickyShell>

      {openSheet === 'preview' ? (
        <GalleryImportSheet onClose={() => setOpenSheet(null)} subtitle="The honest version, in plain terms." testID="gallery-import-trust-preview-sheet" title="What a preview is">
          <View style={sh.body}>
            <Text style={sh.paragraph}>
              A preview is a copy of your photo shrunk to about the size of a thumbnail, roughly a hundredth of the detail of the original. It is enough for Momora to tell a snowy morning from a birthday, and not much more.
            </Text>
            <View style={sh.facts}>
              <GalleryImportFact icon="layers" title="Where they go">
                Momora’s own private storage, which it uses to write the drafts. Nobody else in your family can see them.
              </GalleryImportFact>
              <GalleryImportFact icon="trash" title="How long they last">
                {`Until you finish reviewing, or ${reviewDays} days, whichever comes first. Then they are cleared.`}
              </GalleryImportFact>
              <GalleryImportFact icon="x" title="What is never sent">
                Names, ages, who is related to whom, your location, file names, and anything you have already written in Momora.
              </GalleryImportFact>
            </View>
            <Text style={sh.footnote}>
              This is the one part of Momora where photos leave your phone before you approve anything. We would rather say so plainly than bury it.
            </Text>
          </View>
        </GalleryImportSheet>
      ) : null}

      {openSheet === 'retention' ? (
        <GalleryImportSheet onClose={() => setOpenSheet(null)} subtitle="Three different things, three different lives." testID="gallery-import-trust-retention-sheet" title="What is kept">
          <View style={sh.body}>
            <RetentionRow body="Momora only reads. It cannot delete, move or edit a photo, even if you wanted it to." label="Your camera roll" tone="sea" value="Never touched" />
            <RetentionRow body="Cleared as soon as you finish, or automatically when the review period ends." label="Previews and drafts" tone="sun" value={`Up to ${reviewDays} days`} />
            <RetentionRow body="Full-size photos, saved into your private family journal with the location data stripped out." label="Memories you keep" tone="primary" value="Yours, until you delete them" />
            <View style={sh.divider} />
            <Text style={sh.paragraph}>
              You can stop the whole thing at any point. Stopping clears the previews and the drafts, and keeps anything you already saved.
            </Text>
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
  accessibleCount?: number | null;
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
export function GalleryImportPermissionOutcome({ kind, platform = Platform.OS === 'android' ? 'android' : 'ios', accessibleCount, onPrimary, onSecondary, onClose, testID = `gallery-import-permission-${kind}` }: GalleryImportPermissionOutcomeProps) {
  const isIOS = platform === 'ios';
  const countLabel = typeof accessibleCount === 'number' && accessibleCount > 0
    ? `the ${accessibleCount} photo${accessibleCount === 1 ? '' : 's'} you chose`
    : 'the photos you chose';
  const copy = {
    limited: {
      pill: 'Limited access', tone: 'sun' as const,
      title: `Momora can see\n${countLabel}.`,
      body: isIOS
        ? 'That works. Momora will look through those and suggest what it can. If you want it to see more, choose them now, since once it starts looking, it works with what it has.'
        : 'That works. Momora will look through those and suggest what it can. If you want it to see more, select them now, since once it starts looking, it works with what it has.',
      primary: 'Look through these', secondary: isIOS ? 'Choose more photos' : 'Select more photos',
      note: 'Fewer photos usually means fewer suggestions, not worse ones.',
    },
    denied: {
      pill: 'No photo access', tone: 'neutral' as const,
      title: 'Momora cannot\nsee your photos.',
      body: isIOS
        ? 'That is a completely reasonable choice, and nothing else in Momora is affected. If you change your mind, photo access lives in iOS Settings under Momora.'
        : 'That is a completely reasonable choice, and nothing else in Momora is affected. If you change your mind, photo access lives in Android settings under Momora.',
      primary: isIOS ? 'Open Settings' : 'Open app settings', secondary: 'Back to my journal',
      note: 'You can always add photos to a memory yourself, one at a time.',
    },
    blocked: {
      pill: 'Needs a settings change', tone: 'neutral' as const,
      title: 'This one has to\nbe changed in\nsettings.',
      body: isIOS
        ? 'iOS only asks once. To let Momora look through your photos, open Settings › Momora › Photos and choose All Photos or Selected Photos.'
        : 'Android only asks twice. To let Momora look through your photos, open Settings › Apps › Momora › Permissions › Photos and videos.',
      primary: isIOS ? 'Open Settings' : 'Open app settings', secondary: 'Not now',
      note: 'Momora will not ask you again here.',
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
      <View style={tr.noteWrap}>
        <GalleryImportReassure>{copy.note}</GalleryImportReassure>
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
  cards: { gap: 10, paddingHorizontal: 20, paddingTop: 24 },
  noFaceCard: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: radius.lg, borderWidth: 1, marginHorizontal: spacing.lg, marginTop: 20, padding: 14 },
  noFaceTitle: { color: colors.ink, fontFamily: fonts.sansBold, fontSize: 13 },
  noFaceBody: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 12.5, lineHeight: 18, marginTop: 5 },
  noteWrap: { paddingHorizontal: spacing.lg, paddingTop: 22 },
  // The solid background + hairline top border live in the shared
  // `gi.stickyFooterSurface` (composed in via `footerStyle` above) -- this
  // is only the element spacing within the footer stack.
  actions: { gap: 10 },
  footer: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 11.5, textAlign: 'center' },
});

const tc = StyleSheet.create({
  card: { backgroundColor: colors.white, borderColor: colors.border, borderRadius: radius.lg, borderWidth: 1, flexDirection: 'row', gap: 12, padding: 16 },
  badge: { alignItems: 'center', borderRadius: 12, height: 24, justifyContent: 'center', marginTop: 1, width: 24 },
  badgeText: { fontFamily: fonts.sansBold, fontSize: 12 },
  copy: { flex: 1 },
  title: { color: colors.ink, fontFamily: fonts.sansBold, fontSize: 15, lineHeight: 19 },
  body: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 13.5, lineHeight: 20, marginTop: 6 },
  footRow: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 11 },
  action: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 12.5, textDecorationLine: 'underline' },
});

const rr = StyleSheet.create({
  row: { flexDirection: 'row', gap: 12 },
  bar: { borderRadius: 999, width: 3 },
  copy: { flex: 1 },
  headline: { alignItems: 'baseline', flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  label: { color: colors.ink, fontFamily: fonts.sansBold, fontSize: 14 },
  value: { fontFamily: fonts.sansBold, fontSize: 12.5 },
  body: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 12.5, lineHeight: 18, marginTop: 4 },
});

const sh = StyleSheet.create({
  body: { gap: 18, paddingBottom: 26, paddingHorizontal: spacing.lg, paddingTop: 16 },
  paragraph: { color: colors.ink, fontFamily: fonts.sans, fontSize: 14, lineHeight: 22 },
  facts: { gap: 14 },
  footnote: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 12.5, lineHeight: 18 },
  divider: { backgroundColor: colors.border, height: 1, marginVertical: 4 },
});
