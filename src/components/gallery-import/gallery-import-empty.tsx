// Gallery import -- outcomes with nothing to show (design: gi-entry.jsx
// GIOutcomeEmpty, ~L330-385). Three distinct screens instead of the flow's
// former generic error text: nothing stood out among photos Momora could
// read, an empty photo library on this device, and nothing found among the
// few photos a limited-access grant allowed.
//
// Simplified per the 2026-08-23 copy pass (docs/plans/gallery-import-continuous.md
// I4b): eyebrow, title, one line, buttons -- no script card, no shield
// reassurance line. The one reassurance for this whole flow lives on the
// trust screen (gallery-import-trust.tsx).
import { StyleSheet, Text, View } from 'react-native';

import { KeyboardStickyShell } from '@/components/keyboard-sticky-shell';
import { colors, fonts, spacing } from '@/constants/theme';

import { GalleryImportTopBar, PrimaryButton, SecondaryButton, gi } from './gallery-import-shared';

export type GalleryImportEmptyKind = 'nothing' | 'emptyLibrary' | 'limitedNothing';

interface EmptyCopy {
  eyebrow: string;
  title: string;
  body: string;
  primary: string;
  secondary?: string;
}

/** design: gi-entry.jsx GIOutcomeEmpty's `map`. */
const GALLERY_IMPORT_EMPTY_COPY: Record<GalleryImportEmptyKind, EmptyCopy> = {
  nothing: {
    eyebrow: 'All done looking',
    title: 'Nothing stood out\nthis time.',
    body: 'Momora did not find a group of photos it felt confident about.',
    primary: 'Add a photo myself', secondary: 'Back to my journal',
  },
  emptyLibrary: {
    eyebrow: 'Nothing to look through',
    title: 'No photos here\nyet.',
    body: 'Try this from the phone your photos actually live on.',
    primary: 'Back to my journal', secondary: undefined,
  },
  limitedNothing: {
    eyebrow: 'All done looking',
    title: 'Nothing yet from\nthe photos you\nchose.',
    body: 'Choosing a few more days of photos usually helps.',
    primary: 'Choose more photos', secondary: 'Back to my journal',
  },
};

export interface GalleryImportEmptyOutcomeProps {
  kind: GalleryImportEmptyKind;
  onPrimary: () => void;
  onSecondary?: () => void;
  onClose: () => void;
  testID?: string;
}

export function GalleryImportEmptyOutcome({ kind, onPrimary, onSecondary, onClose, testID = `gallery-import-empty-${kind}` }: GalleryImportEmptyOutcomeProps) {
  const copy = GALLERY_IMPORT_EMPTY_COPY[kind];
  return (
    <KeyboardStickyShell
      header={<GalleryImportTopBar left="Close" onLeft={onClose} testID={`${testID}-top-bar-close`} />}
      contentContainerStyle={em.scrollContent}
      footer={<>
        <PrimaryButton label={copy.primary} onPress={onPrimary} testID={testID ? `${testID}-primary` : 'gallery-import-empty-primary'} />
        {copy.secondary && onSecondary ? (
          <SecondaryButton label={copy.secondary} onPress={onSecondary} testID={testID ? `${testID}-secondary` : 'gallery-import-empty-secondary'} />
        ) : null}
      </>}
      footerStyle={[gi.stickyFooterSurface, em.actions]}
      footerTestID={`${testID}-footer`}
      safeAreaStyle={em.screen}
      scrollTestID={`${testID}-scroll`}
      testID={testID}
    >
      <View style={em.header}>
        <Text style={em.eyebrow}>{copy.eyebrow}</Text>
        <Text style={em.title}>{copy.title}</Text>
      </View>
      <View style={em.body}>
        <Text style={em.text}>{copy.body}</Text>
      </View>
    </KeyboardStickyShell>
  );
}

const em = StyleSheet.create({
  screen: { backgroundColor: colors.bg, flex: 1 },
  scrollContent: { paddingBottom: spacing.lg },
  header: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  eyebrow: { color: colors.ink3, fontFamily: fonts.sansBold, fontSize: 10, letterSpacing: 1.4, textTransform: 'uppercase' },
  title: { color: colors.ink, fontFamily: fonts.display, fontSize: 34, lineHeight: 38, marginTop: 12 },
  body: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  text: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 14.5, lineHeight: 23 },
  // The solid background + hairline top border live in the shared
  // `gi.stickyFooterSurface` (composed in via `footerStyle` above) -- this
  // is only the element spacing within the footer stack.
  actions: { gap: 10 },
});
