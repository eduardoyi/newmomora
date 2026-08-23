// Gallery import -- calm, full-screen exception states (design: gi-states.jsx
// GIMessage + GI_STATES). One shared visual pattern for every "this stopped
// for a reason that isn't the user's fault" screen, instead of the single
// ambiguous "Your family access or import eligibility changed" message the
// flow used to show for every server-side 'failed' status.
//
// Simplified per the 2026-08-23 copy pass (docs/plans/gallery-import-continuous.md
// I4b): pill, title, one sentence, buttons. The `removed`/`quietSkips` kinds
// and the inline `GalleryImportNotice` banner (gi-states.jsx GINotice) had no
// caller outside this file's own tests -- dropped rather than carried forward
// unused. `lapsed` keeps its dynamic ready-count note; every other kind's
// former static reassurance line is gone (the flow's one reassurance lives on
// the trust screen, gallery-import-trust.tsx).
//
// `wrongDevice` is intentionally not part of GalleryImportExceptionKind --
// it has its own always-available trigger (no local checkpoint at all) and
// stays as the restyled DeviceBoundNotice in gallery-import-shared.tsx.
import { StyleSheet, Text, View } from 'react-native';

import { KeyboardStickyShell } from '@/components/keyboard-sticky-shell';
import { colors, fonts, spacing } from '@/constants/theme';

import {
  GalleryImportPill,
  GalleryImportReassure,
  GalleryImportTopBar,
  PrimaryButton,
  SecondaryButton,
  gi,
} from './gallery-import-shared';

export type GalleryImportExceptionKind =
  | 'lapsed'
  | 'demoted'
  | 'capped'
  | 'offline'
  | 'errorRecoverable'
  | 'errorFinal';

export interface GalleryImportExceptionCopy {
  pill: string;
  tone: 'sun' | 'neutral' | 'error';
  title: string;
  body: string;
  primary: string;
  secondary?: string;
}

/** design: gi-states.jsx GI_STATES, minus fixture numbers baked into the
 * prototype's copy (docs/design/gallery-import/README.md: run ceilings and
 * counts are server-provided, not prototype constants). Callers pass real
 * counts in as `readyCount`/`reviewDaysLeft` where this screen has them. */
export const GALLERY_IMPORT_EXCEPTION_COPY: Record<GalleryImportExceptionKind, GalleryImportExceptionCopy> = {
  lapsed: {
    pill: 'Momora Plus has ended', tone: 'sun',
    title: 'You can look,\nbut not add\njust yet.',
    body: 'Your journal stays yours to read and export, but adding new memories needs an active subscription.',
    primary: 'See subscription options', secondary: 'Keep looking through them',
  },
  demoted: {
    pill: 'Your role changed', tone: 'neutral',
    title: 'Only owners and\nmanagers can add\nfrom photos.',
    body: 'Your role in this family changed, so this has stopped here, but nothing you already added was affected.',
    primary: 'Back to my journal',
  },
  capped: {
    pill: 'Enough for one go', tone: 'neutral',
    title: 'Momora has\nreached its limit\nfor now.',
    body: 'It went back as far as it could in one sitting, and there is plenty left to look through another time.',
    primary: 'Back to my journal',
  },
  offline: {
    pill: 'No connection', tone: 'neutral',
    title: 'Offline for\nnow.',
    body: 'You can keep reading suggestions already on this phone, but keeping one needs a connection.',
    primary: 'Keep reading suggestions', secondary: 'Back to my journal',
  },
  errorRecoverable: {
    pill: 'A hiccup', tone: 'sun',
    title: 'That did not\ngo through.',
    body: 'Momora could not reach its own storage just now, so this is worth trying again.',
    primary: 'Try again', secondary: 'Not now',
  },
  errorFinal: {
    pill: 'Cannot be finished', tone: 'error',
    title: 'This one has to\nstart over.',
    body: 'Momora could not recover from this, so it cleared the previews and drafts and starting again is safe.',
    primary: 'Start again', secondary: 'Back to my journal',
  },
};

export interface GalleryImportExceptionScreenProps {
  kind: GalleryImportExceptionKind;
  onPrimary: () => void;
  onSecondary?: () => void;
  onClose: () => void;
  /** Real counts to fold into `lapsed`'s note, when this screen has them --
   * never fabricated when absent (see docs/design/gallery-import/README.md
   * on run ceilings/counts being server-provided). Every other kind renders
   * no note at all. */
  readyCount?: number;
  reviewDaysLeft?: number | null;
  testID?: string;
}

/** `lapsed` is the only kind that still carries a note, and only once real
 * counts are available -- there is no static fallback line anymore. */
function lapsedReadyNote(readyCount?: number, reviewDaysLeft?: number | null): string | null {
  if (typeof readyCount !== 'number' || readyCount <= 0) return null;
  return typeof reviewDaysLeft === 'number' && reviewDaysLeft > 0
    ? `The ${readyCount} suggestion${readyCount === 1 ? '' : 's'} still here ${readyCount === 1 ? 'is' : 'are'} safe for ${reviewDaysLeft} more day${reviewDaysLeft === 1 ? '' : 's'}.`
    : `The ${readyCount} suggestion${readyCount === 1 ? '' : 's'} still here ${readyCount === 1 ? 'is' : 'are'} safe while you decide.`;
}

/** design: gi-states.jsx GIMessage, applied to the kind-specific copy above. */
export function GalleryImportExceptionScreen({ kind, onPrimary, onSecondary, onClose, readyCount, reviewDaysLeft, testID }: GalleryImportExceptionScreenProps) {
  const copy = GALLERY_IMPORT_EXCEPTION_COPY[kind];
  const note = kind === 'lapsed' ? lapsedReadyNote(readyCount, reviewDaysLeft) : null;
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
        {note ? (
          <View style={ex.noteWrap}>
            <GalleryImportReassure>{note}</GalleryImportReassure>
          </View>
        ) : null}
      </View>
    </KeyboardStickyShell>
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
