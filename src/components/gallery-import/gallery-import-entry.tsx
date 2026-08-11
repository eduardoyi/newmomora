// Gallery import -- offer/entry screen. Rebuilt per docs/design/gallery-import/README.md
// (design source: gi-entry.jsx GIOffer ~L1-129, gi-shared.jsx GITopBar) and the
// approved gallery-import fix plan: the trust/permission explainer now gates
// requestPermissionThenStart whenever permission is not already granted, the
// permission outcomes are full screens instead of inline error text, and the
// runner is kicked off via beginGalleryImportPipeline (gallery-import-pipeline.ts)
// -- a module-level function, not this component's own state -- so this
// screen can navigate to progress the *instant* permission is granted
// instead of waiting out the whole scan+prepare+upload pass first. The
// entry screen must never be visible again once that navigation happens;
// gallery-import-progress.tsx's pending-start rendering owns everything
// that can go wrong before a run id exists (Wi-Fi wait, an empty library, a
// server-declared cap, or any other start failure).
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { KeyboardStickyShell } from '@/components/keyboard-sticky-shell';
import { colors, fonts, radius, spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useBilling } from '@/hooks/use-billing';
import { useFamily } from '@/hooks/use-family';
import { trackEvent } from '@/services/analytics';
import { loadLatestGalleryImportCheckpoint } from '@/utils/gallery-import-checkpoint';
import { getGalleryImportE2eAdapter } from '@/utils/gallery-import-e2e-adapter';
import { beginGalleryImportPipeline } from '@/utils/gallery-import-pipeline';
import {
  createExpoGalleryMediaLibraryAdapter,
  getGalleryPhotoPermissionState,
  type GalleryPhotoPermissionState,
} from '@/utils/gallery-import-scanner';
import { canEditFamilyContent } from '@/utils/roles';

import { GalleryImportExceptionScreen } from './gallery-import-exception';
import { GalleryImportFact, GalleryImportReassure, GalleryImportTopBar, PrimaryButton, gi } from './gallery-import-shared';
import { GalleryImportPermissionOutcome, GalleryImportTrustExplainer, type GalleryImportPermissionOutcomeKind } from './gallery-import-trust';

export type GalleryImportSurface = 'offer' | 'settings' | 'timeline' | 'glyph';

type EntryOverlay =
  | { kind: 'trust' }
  | { kind: 'permission'; outcome: GalleryImportPermissionOutcomeKind }
  | { kind: 'exception'; outcome: 'lapsed' };

/** No route param: the progress screen picks the run up through the
 * pending-start slot (gallery-import-pending-start.ts) until a run id
 * exists, then adopts it into its own URL via `router.setParams`. */
const PROGRESS_ROUTE = '/(app)/gallery-import/progress' as never;

export function GalleryImportEntry({ surface = 'settings' }: { surface?: GalleryImportSurface }) {
  const { user } = useAuth();
  const { familyId, role } = useFamily();
  const billing = useBilling();
  const [permission, setPermission] = useState<GalleryPhotoPermissionState | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [resumableRunId, setResumableRunId] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<EntryOverlay | null>(null);
  const canStart = canEditFamilyContent(role);

  useEffect(() => { trackEvent('gallery_import_opened', { surface }); }, [surface]);
  useEffect(() => {
    if (!canStart) return;
    const adapter = getGalleryImportE2eAdapter() ?? createExpoGalleryMediaLibraryAdapter();
    void adapter.getPermission().then((response) => setPermission(getGalleryPhotoPermissionState(response))).catch(() => undefined);
  }, [canStart]);
  useEffect(() => {
    if (!user?.id || !familyId || !canStart) return;
    void loadLatestGalleryImportCheckpoint(user.id, familyId)
      .then((checkpoint) => setResumableRunId(checkpoint?.runId ?? null));
  }, [canStart, familyId, user?.id]);

  const chooseMorePhotos = useCallback(async () => {
    const adapter = getGalleryImportE2eAdapter() ?? createExpoGalleryMediaLibraryAdapter();
    await adapter.presentPermissionPicker?.();
    const response = await adapter.getPermission();
    const state = getGalleryPhotoPermissionState(response);
    setPermission(state);
    setOverlay(state === 'limited' ? { kind: 'permission', outcome: 'limited' } : null);
  }, []);
  const openDeviceSettings = useCallback(() => { void Linking.openSettings(); }, []);

  // Fires the runner (which keeps running after this component unmounts --
  // see gallery-import-pipeline.ts) and navigates immediately, without
  // waiting for a run id. Never awaited by a caller.
  const startAndNavigate = useCallback((permissionMode: 'full' | 'limited') => {
    if (!user || !familyId) return;
    const adapter = getGalleryImportE2eAdapter() ?? createExpoGalleryMediaLibraryAdapter();
    beginGalleryImportPipeline({ userId: user.id, familyId, useCellular: false, adapter, permissionMode });
    setOverlay(null);
    router.replace(PROGRESS_ROUTE);
  }, [familyId, user]);

  const requestPermissionThenStart = useCallback(async () => {
    if (!user || !familyId || !canStart || isStarting) return;
    if (billing.status && billing.status.has_write_access === false) {
      setOverlay({ kind: 'exception', outcome: 'lapsed' });
      return;
    }
    if (resumableRunId) {
      router.replace({ pathname: '/(app)/gallery-import/progress' as never, params: { runId: resumableRunId } });
      return;
    }
    setIsStarting(true);
    const adapter = getGalleryImportE2eAdapter() ?? createExpoGalleryMediaLibraryAdapter();
    const response = await adapter.getPermission();
    const state = getGalleryPhotoPermissionState(response);
    setPermission(state);
    if (state === 'blocked') { setIsStarting(false); setOverlay({ kind: 'permission', outcome: 'blocked' }); return; }
    // 'full' or an already-established 'limited' grant from a previous visit:
    // the design's permission-outcome screen belongs right after the OS
    // prompt resolves for the first time (see continueFromExplainer below),
    // not as a repeated confirmation tap every time someone with a known,
    // working limited grant presses the primary button.
    if (state === 'full' || state === 'limited') { startAndNavigate(state); return; }
    // 'denied' and askable: nothing has explained the OS prompt yet.
    setIsStarting(false);
    setOverlay({ kind: 'trust' });
  }, [billing.status, canStart, familyId, isStarting, resumableRunId, startAndNavigate, user]);

  const continueFromExplainer = useCallback(async () => {
    const adapter = getGalleryImportE2eAdapter() ?? createExpoGalleryMediaLibraryAdapter();
    const response = await adapter.requestPermission();
    const state = getGalleryPhotoPermissionState(response);
    setPermission(state);
    trackEvent('gallery_import_permission_resolved', { outcome: state });
    if (state === 'full') { startAndNavigate(state); return; }
    setOverlay({ kind: 'permission', outcome: state === 'blocked' ? 'blocked' : state === 'limited' ? 'limited' : 'denied' });
  }, [startAndNavigate]);

  if (overlay?.kind === 'trust') {
    return (
      <GalleryImportTrustExplainer
        onCancel={() => setOverlay(null)}
        onContinue={() => void continueFromExplainer()}
        platform={Platform.OS === 'android' ? 'android' : 'ios'}
      />
    );
  }
  if (overlay?.kind === 'permission') {
    return (
      <GalleryImportPermissionOutcome
        kind={overlay.outcome}
        onClose={() => setOverlay(null)}
        onPrimary={() => {
          if (overlay.outcome === 'limited') { startAndNavigate('limited'); return; }
          openDeviceSettings();
        }}
        onSecondary={() => {
          if (overlay.outcome === 'limited') { void chooseMorePhotos(); return; }
          setOverlay(null);
        }}
        platform={Platform.OS === 'android' ? 'android' : 'ios'}
      />
    );
  }
  if (overlay?.kind === 'exception') {
    return (
      <GalleryImportExceptionScreen
        kind={overlay.outcome}
        onClose={() => setOverlay(null)}
        onPrimary={() => {
          // Same "see subscription options" destination as Settings' own
          // "Manage subscription" row (app/(app)/(tabs)/settings.tsx) -- the
          // paywall itself resolves management-url vs resubscribe.
          router.push(
            billing.status?.has_ever_had_access
              ? { pathname: '/(onboarding)/paywall', params: { mode: 'resubscribe' } }
              : '/(onboarding)/paywall',
          );
        }}
        onSecondary={() => setOverlay(null)}
      />
    );
  }

  return (
    <KeyboardStickyShell
      safeAreaStyle={styles.screen}
      header={<GalleryImportTopBar left="Not now" onLeft={() => router.back()} testID="gallery-import-back" />}
      contentContainerStyle={styles.entryContent}
      footer={<>
        <PrimaryButton
          disabled={!canStart || isStarting}
          label={isStarting ? 'Working…' : resumableRunId ? 'Pick up where you left off' : 'Look through my photos'}
          onPress={() => void requestPermissionThenStart()}
          testID="gallery-import-start"
        />
        <Pressable accessibilityRole="button" onPress={() => router.back()} testID="gallery-import-not-now"><Text style={styles.ghostButton}>Maybe later</Text></Pressable>
        <Text style={styles.footerHint}>You can start this any time from Settings.</Text>
      </>}
      footerStyle={[gi.stickyFooterSurface, styles.footerGap]}
      footerTestID="gallery-import-entry-footer"
      scrollTestID="gallery-import-entry-scroll"
      testID="gallery-import-entry"
    >
      <Text style={styles.eyebrow}>Before you start writing</Text>
      <Text style={styles.display}>Some of it is{`\n`}already on{`\n`}<Text style={styles.displayAccent}>your phone.</Text></Text>
      <Text style={styles.body}>Momora can look through the photos you already have and suggest a handful of moments worth keeping. You decide which ones become memories.</Text>
      <View accessibilityLabel="A stack of family photo prints" style={styles.printStack}>
        <View style={[styles.print, styles.printBackOne]} />
        <View style={[styles.print, styles.printBackTwo]} />
        <View style={styles.printFront}>
          <View style={styles.photoPlaceholder}>
            <Text style={styles.placeholderSun}>✦</Text>
            <Text style={styles.placeholderStamp}>yours to find</Text>
          </View>
          <View style={styles.thumbRow}>{[0, 1, 2, 3].map((index) => <View key={index} style={styles.thumb} />)}</View>
        </View>
      </View>
      <GalleryImportFact icon="search" title="It looks for events, not good photos">
        Days with a lot going on, like a snowy morning or an afternoon outside, grouped the way you would remember them.
      </GalleryImportFact>
      <GalleryImportFact icon="image" title="Nothing is deleted or tidied up">
        Momora only reads your photos. Your camera roll stays exactly as it is.
      </GalleryImportFact>
      <GalleryImportFact icon="check" title="Nothing is added without you">
        You look at each suggestion and keep only the ones you want. The rest quietly go away.
      </GalleryImportFact>
      <Text style={styles.videosNote}>Momora suggests photos only for now.</Text>
      <View style={styles.reassureWrap}>
        <GalleryImportReassure />
      </View>
      {permission === 'limited' && !overlay ? <Text style={styles.note}>Momora will only look at the photos you allowed. You can choose more before you start.</Text> : null}
      {permission === 'limited' && !overlay ? <Pressable accessibilityRole="button" onPress={() => void chooseMorePhotos()} testID="gallery-import-choose-more"><Text style={styles.managePhotos}>Choose more photos</Text></Pressable> : null}
      {permission === 'blocked' && !overlay ? <Pressable accessibilityRole="button" onPress={openDeviceSettings} testID="gallery-import-open-settings"><Text style={styles.managePhotos}>Open device settings</Text></Pressable> : null}
      {!canStart ? <Text style={styles.error}>Only a family owner or manager can start looking through photos.</Text> : null}
    </KeyboardStickyShell>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.bg, flex: 1 },
  entryContent: { paddingBottom: spacing.xxl, paddingHorizontal: spacing.lg },
  // Design (primitives.jsx Eyebrow): default color is the primary pink, not
  // a muted ink -- device screenshots confirmed the tan version read wrong.
  eyebrow: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 10, letterSpacing: 1.4, marginTop: 10, textTransform: 'uppercase' },
  display: { color: colors.ink, fontFamily: fonts.display, fontSize: 38, letterSpacing: -0.7, lineHeight: 39, marginTop: 11 },
  displayAccent: { color: colors.primary, fontFamily: fonts.displayItalic },
  body: { color: colors.ink2, fontFamily: fonts.sans, fontSize: 14.5, lineHeight: 23, marginTop: 16 },
  printStack: { height: 208, marginTop: 26, position: 'relative' },
  print: { backgroundColor: colors.white, borderColor: colors.border, borderRadius: radius.lg, borderWidth: 1, bottom: 18, left: 18, position: 'absolute', right: 18, top: 12 },
  printBackOne: { transform: [{ rotate: '-4deg' }] },
  printBackTwo: { left: 10, right: 10, top: 7, transform: [{ rotate: '2deg' }] },
  printFront: { backgroundColor: colors.white, borderColor: colors.border, borderRadius: radius.lg, borderWidth: 1, bottom: 13, left: 0, padding: 12, position: 'absolute', right: 0, top: 0, transform: [{ rotate: '-1deg' }] },
  photoPlaceholder: { alignItems: 'center', backgroundColor: colors.primaryTint, borderRadius: radius.md, height: 118, justifyContent: 'center', overflow: 'hidden' },
  placeholderSun: { color: colors.primary, fontSize: 34 },
  placeholderStamp: { bottom: 8, color: 'rgba(60,44,30,0.4)', fontFamily: fonts.script, fontSize: 16, position: 'absolute', right: 10, transform: [{ rotate: '-4deg' }] },
  thumbRow: { flexDirection: 'row', gap: 6, marginTop: 10 },
  thumb: { backgroundColor: colors.seaSoft, borderRadius: 6, flex: 1, height: 34 },
  videosNote: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 12, lineHeight: 18, marginTop: 20 },
  reassureWrap: { marginTop: 12 },
  // The solid background + hairline top border that give this footer its
  // own visual identity now live in the shared `gi.stickyFooterSurface`
  // (composed in via `footerStyle` on KeyboardStickyShell above) -- this is
  // only the element spacing between the button/ghost-button/hint stack.
  footerGap: { gap: 10 },
  ghostButton: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 13, padding: 8, textAlign: 'center' },
  footerHint: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 11.5, lineHeight: 16, textAlign: 'center' },
  error: { color: colors.error, fontFamily: fonts.sans, fontSize: 12.5, lineHeight: 18, marginTop: spacing.md },
  note: { color: colors.seaInk, fontFamily: fonts.sans, fontSize: 12, lineHeight: 18, marginTop: spacing.lg },
  managePhotos: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 12.5, marginTop: spacing.sm },
});
