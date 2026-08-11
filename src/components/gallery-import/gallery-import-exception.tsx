// Gallery import -- calm, full-screen exception states (design: gi-states.jsx
// GIMessage + GI_STATES) and the inline notice banner (gi-states.jsx GINotice).
// One shared visual pattern for every "this stopped for a reason that isn't
// the user's fault" screen, instead of the single ambiguous "Your family
// access or import eligibility changed" message the flow used to show for
// every server-side 'failed' status.
//
// `wrongDevice` is intentionally not part of GalleryImportExceptionKind --
// it has its own always-available trigger (no local checkpoint at all) and
// stays as the restyled DeviceBoundNotice in gallery-import-shared.tsx.
import { StyleSheet, Text, View } from 'react-native';

import { KeyboardStickyShell } from '@/components/keyboard-sticky-shell';
import { colors, fonts, radius, spacing } from '@/constants/theme';

import {
  GalleryImportIcon,
  GalleryImportPill,
  GalleryImportReassure,
  GalleryImportTopBar,
  PrimaryButton,
  SecondaryButton,
  gi,
  type GalleryImportIconName,
} from './gallery-import-shared';

export type GalleryImportExceptionKind =
  | 'lapsed'
  | 'demoted'
  | 'removed'
  | 'capped'
  | 'offline'
  | 'errorRecoverable'
  | 'errorFinal'
  | 'quietSkips';

export interface GalleryImportExceptionCopy {
  pill: string;
  tone: 'sun' | 'neutral' | 'error';
  title: string;
  body: string;
  note: string;
  primary: string;
  secondary?: string;
}

/** design: gi-states.jsx GI_STATES, minus fixture numbers baked into the
 * prototype's copy (docs/design/gallery-import/README.md: run ceilings and
 * counts are server-provided, not prototype constants). Callers pass real
 * counts in as `facts` where this screen has them. */
export const GALLERY_IMPORT_EXCEPTION_COPY: Record<GalleryImportExceptionKind, GalleryImportExceptionCopy> = {
  lapsed: {
    pill: 'Momora Plus has ended', tone: 'sun',
    title: 'You can look,\nbut not add\njust yet.',
    body: 'Your journal and everything already in it stays yours to read and export. Adding new memories, including these suggestions, needs an active subscription.',
    note: 'These suggestions are still safe to look through while you decide.',
    primary: 'See subscription options', secondary: 'Keep looking through them',
  },
  demoted: {
    pill: 'Your role changed', tone: 'neutral',
    title: 'Only owners and\nmanagers can add\nfrom photos.',
    body: 'Your role in this family changed while this was open, so it has stopped here. Nothing you already added has been affected.',
    note: 'The drafts and previews have been cleared. Your camera roll was never changed.',
    primary: 'Back to my journal',
  },
  removed: {
    pill: 'No longer in this family', tone: 'neutral',
    title: 'This journal is\nno longer\nshared with you.',
    body: 'You have been removed from this family, so its memories and any suggestions from your photos are no longer available on this phone.',
    note: 'Momora has cleared the drafts and previews from this device.',
    primary: 'Back to my journal',
  },
  capped: {
    pill: 'Enough for one go', tone: 'neutral',
    title: 'Momora has\nreached its limit\nfor now.',
    body: 'It went back as far as it could in one sitting. There is plenty left, and you can look through more another time.',
    note: 'Nothing was missed or thrown away. Your camera roll is untouched.',
    primary: 'Back to my journal',
  },
  offline: {
    pill: 'No connection', tone: 'neutral',
    title: 'Offline for\nnow.',
    body: 'You can keep reading the suggestions already on this phone. Keeping one needs a connection, because the full-size photos are sent then.',
    note: 'Momora will pick up on its own when you are back online.',
    primary: 'Keep reading suggestions', secondary: 'Back to my journal',
  },
  errorRecoverable: {
    pill: 'A hiccup', tone: 'sun',
    title: 'That did not\ngo through.',
    body: 'Momora could not reach its own storage just now. Your place is saved and nothing was lost, so this is worth another try in a moment.',
    note: 'Nothing was added to your journal and your camera roll is untouched.',
    primary: 'Try again', secondary: 'Not now',
  },
  errorFinal: {
    pill: 'Cannot be finished', tone: 'error',
    title: 'This one has to\nstart over.',
    body: 'Something went wrong that Momora cannot recover from. It has cleaned up after itself: the previews and drafts are cleared. Starting again is safe and will not re-suggest anything you set aside.',
    note: 'Anything you already kept is still in your journal.',
    primary: 'Start again', secondary: 'Back to my journal',
  },
  quietSkips: {
    pill: 'A few left out', tone: 'neutral',
    title: 'Some events\nwere left out.',
    body: 'Momora only suggests groups it is confident about. Screens, receipts, near-identical shots and events it could not read clearly are quietly passed over; nothing has been judged or graded.',
    note: 'Everything is still in your camera roll, exactly as it was.',
    primary: 'Review what it found', secondary: 'Back to my journal',
  },
};

export interface GalleryImportExceptionScreenProps {
  kind: GalleryImportExceptionKind;
  onPrimary: () => void;
  onSecondary?: () => void;
  onClose: () => void;
  /** Real counts to fold into the note line, when this screen has them --
   * never fabricated when absent (see docs/design/gallery-import/README.md
   * on run ceilings/counts being server-provided). */
  readyCount?: number;
  reviewDaysLeft?: number | null;
  testID?: string;
}

function noteFor(kind: GalleryImportExceptionKind, base: string, readyCount?: number, reviewDaysLeft?: number | null): string {
  if (kind === 'lapsed' && typeof readyCount === 'number' && readyCount > 0) {
    return typeof reviewDaysLeft === 'number' && reviewDaysLeft > 0
      ? `The ${readyCount} suggestion${readyCount === 1 ? '' : 's'} still here ${readyCount === 1 ? 'is' : 'are'} safe for ${reviewDaysLeft} more day${reviewDaysLeft === 1 ? '' : 's'}.`
      : `The ${readyCount} suggestion${readyCount === 1 ? '' : 's'} still here ${readyCount === 1 ? 'is' : 'are'} safe while you decide.`;
  }
  return base;
}

/** design: gi-states.jsx GIMessage, applied to the kind-specific copy above. */
export function GalleryImportExceptionScreen({ kind, onPrimary, onSecondary, onClose, readyCount, reviewDaysLeft, testID }: GalleryImportExceptionScreenProps) {
  const copy = GALLERY_IMPORT_EXCEPTION_COPY[kind];
  const footerTestID = testID ? `${testID}-footer` : 'gallery-import-exception-footer';
  return (
    <KeyboardStickyShell
      header={<GalleryImportTopBar left="Close" onLeft={onClose} testID={testID ? `${testID}-top-bar-close` : undefined} />}
      contentContainerStyle={ex.scrollContent}
      footer={<>
        <PrimaryButton label={copy.primary} onPress={onPrimary} testID={testID ? `${testID}-primary` : 'gallery-import-exception-primary'} />
        {copy.secondary && onSecondary ? (
          <SecondaryButton label={copy.secondary} onPress={onSecondary} testID={testID ? `${testID}-secondary` : 'gallery-import-exception-secondary'} />
        ) : null}
      </>}
      footerStyle={[gi.stickyFooterSurface, ex.actions]}
      footerTestID={footerTestID}
      safeAreaStyle={ex.screen}
      scrollTestID={testID ? `${testID}-scroll` : 'gallery-import-exception-scroll'}
      testID={testID}
    >
      <View style={ex.body}>
        <GalleryImportPill tone={copy.tone === 'error' ? 'error' : copy.tone === 'sun' ? 'sun' : 'soft'}>{copy.pill}</GalleryImportPill>
        <Text style={ex.title}>{copy.title}</Text>
        <Text style={ex.text}>{copy.body}</Text>
        <View style={ex.noteWrap}>
          <GalleryImportReassure>{noteFor(kind, copy.note, readyCount, reviewDaysLeft)}</GalleryImportReassure>
        </View>
      </View>
    </KeyboardStickyShell>
  );
}

export type GalleryImportNoticeTone = 'sun' | 'sea' | 'soft' | 'error';

export interface GalleryImportNoticeProps {
  tone?: GalleryImportNoticeTone;
  icon: GalleryImportIconName;
  title: string;
  body?: string;
  action?: { label: string; onPress: () => void };
  testID?: string;
}

/** design: gi-states.jsx GINotice -- the inline banner for anything that does
 * not need to stop the parent (still-finding-more, waiting-for-Wi-Fi, a
 * limited-access reminder, an iCloud download, a clears-in-N-days note). */
export function GalleryImportNotice({ tone = 'sun', icon, title, body, action, testID }: GalleryImportNoticeProps) {
  const palette = {
    sun: { bg: colors.sunSoft, fg: colors.sunInk },
    sea: { bg: colors.seaSoft, fg: colors.seaInk },
    soft: { bg: colors.surface, fg: colors.ink2 },
    error: { bg: colors.errorSoft, fg: colors.error },
  }[tone];
  return (
    <View style={[nt.card, { backgroundColor: palette.bg }]} testID={testID}>
      <GalleryImportIcon color={palette.fg} name={icon} size={16} strokeWidth={1.9} />
      <View style={nt.copy}>
        <Text style={[nt.title, { color: palette.fg }]}>{title}</Text>
        {body ? <Text style={[nt.body, { color: palette.fg }]}>{body}</Text> : null}
        {action ? (
          <Text onPress={action.onPress} style={[nt.action, { color: palette.fg }]} testID={testID ? `${testID}-action` : undefined}>
            {action.label}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const ex = StyleSheet.create({
  screen: { backgroundColor: colors.bg, flex: 1 },
  scrollContent: { paddingBottom: spacing.lg },
  body: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  title: { color: colors.ink, fontFamily: fonts.display, fontSize: 32, lineHeight: 36, marginTop: 14 },
  text: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 14.5, lineHeight: 23, marginTop: 14 },
  noteWrap: { marginTop: 22 },
  // The solid background + hairline top border live in the shared
  // `gi.stickyFooterSurface` (composed in via `footerStyle` above) -- this
  // is only the element spacing within the footer stack.
  actions: { gap: 10 },
});

const nt = StyleSheet.create({
  card: { borderRadius: radius.lg, flexDirection: 'row', gap: 10, padding: 13 },
  copy: { flex: 1 },
  title: { fontFamily: fonts.sansBold, fontSize: 13, lineHeight: 17 },
  body: { fontFamily: fonts.sans, fontSize: 12, lineHeight: 17, marginTop: 3, opacity: 0.88 },
  action: { fontFamily: fonts.sansBold, fontSize: 12, marginTop: 8, textDecorationLine: 'underline' },
});
