// Gallery import -- the review deck (design: gi-review.jsx + gi-notes.jsx;
// authority: docs/design/gallery-import/README.md). The deck is read-only and
// asks one question per card: Keep or Set aside. Right swipe / Keep opens the
// memory composer as a push, not a commit; left swipe / Set aside is
// recoverable from the "Set aside · N" sheet, never a bin. Progress is a
// ledger and per-suggestion ticks -- never a completion bar over a total
// Momora cannot know yet.
import { Image } from 'expo-image';
import { router, useFocusEffect } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, fonts, radius, spacing } from '@/constants/theme';
import {
  completeGalleryImportRun,
  getGalleryImportCandidates,
  getGalleryImportRun,
  setGalleryImportCandidateSkip,
  type GalleryImportCandidate,
  type GalleryImportRun,
} from '@/services/gallery-import';
import { trackEvent } from '@/services/analytics';
import { clearGalleryImportCheckpoint, clearGalleryImportPreviewCache } from '@/utils/gallery-import-checkpoint';
import {
  GALLERY_DECK_EXIT_DURATION_MS,
  GALLERY_DECK_REDUCED_EXIT_DURATION_MS,
  buildGalleryImportDayPool,
  deriveGalleryImportComingIndicator,
  isGalleryDeckRestPointDue,
  isGalleryImportRunTerminal,
  type GalleryDeckSwipeDirection,
  type GalleryImportComingIndicator,
} from '@/utils/gallery-import-deck';
import { loadGalleryImportFrontier, type GalleryImportFrontier } from '@/utils/gallery-import-frontier';

import { GalleryImportDeckCard } from './gallery-import-deck-card';
import { GalleryImportPhotoChooser, GalleryImportSetAsideSheet } from './gallery-import-review-sheets';
import { DeviceBoundNotice, exitGalleryImportToTimeline, gi, humanError, styles as sharedStyles, useRunCheckpoint } from './gallery-import-shared';

const DECK_TICK_MAX = 12;

// Session-only record of what was kept, so the rest point and done state can
// show the prints (get-candidates omits approved cards). Preview URLs are
// short-lived signed URLs; this cache never persists and never leaves memory.
const sessionKeptByRun = new Map<string, { candidateId: string; previewUri?: string }[]>();

/** Test-only: the kept-print cache is module state shared across renders. */
export function resetGalleryImportReviewSessionCache() {
  sessionKeptByRun.clear();
}

function recordSessionKeep(runId: string, candidate: GalleryImportCandidate) {
  const list = sessionKeptByRun.get(runId) ?? [];
  if (!list.some((item) => item.candidateId === candidate.id)) {
    sessionKeptByRun.set(runId, [...list, { candidateId: candidate.id, previewUri: candidate.previewUrls?.[0] }]);
  }
}

function reconcileSessionKept(runId: string, liveCandidates: GalleryImportCandidate[]) {
  const list = sessionKeptByRun.get(runId);
  if (!list?.length) return;
  // A candidate that is visible again was not finalized -- the composer was
  // cancelled and the card is back in the deck, untouched.
  const liveIds = new Set(liveCandidates.filter((candidate) => candidate.status === 'ready' || candidate.status === 'skipped').map((candidate) => candidate.id));
  sessionKeptByRun.set(runId, list.filter((item) => !liveIds.has(item.candidateId)));
}

export function GalleryImportReview({ runId }: { runId?: string }) {
  const { checkpoint, isLoading, refresh: refreshCheckpoint, update: updateCheckpoint, userId, familyId } = useRunCheckpoint(runId);
  // The composer (pushed on top of this deck) and the app-root driver both
  // write the checkpoint in storage while this screen stays mounted, so the
  // in-memory copy here goes stale. Re-read it whenever the deck regains
  // focus -- otherwise an approval outbox item captured mid-save kept
  // `pendingApproval` truthy after the composer had already finalized and
  // cleared it, which gated the candidate poll off and left the deck on its
  // redirect spinner forever (device-observed 2026-08-23).
  const [isFocused, setIsFocused] = useState(false);
  useFocusEffect(useCallback(() => {
    setIsFocused(true);
    void refreshCheckpoint();
    return () => setIsFocused(false);
  }, [refreshCheckpoint]));
  const reducedMotion = useReducedMotion();
  const [candidates, setCandidates] = useState<GalleryImportCandidate[]>([]);
  // Round 4, device-tested finding: the local checkpoint plan (chunks the
  // client itself scheduled) goes stale the moment a run is resumed after a
  // stall/reload -- it is this device's own upload intent, not what the
  // server has actually received or resolved. `run` (server truth: status +
  // readyCandidates + pendingClusters) now drives every judgment about
  // whether more is coming and whether the run is safe to conclude. See
  // deriveGalleryImportComingIndicator (gallery-import-deck.ts).
  const [run, setRun] = useState<GalleryImportRun | null>(null);
  const [isActioning, setIsActioning] = useState(false);
  const [exitDirection, setExitDirection] = useState<GalleryDeckSwipeDirection | null>(null);
  // Which candidate `exitDirection` actually belongs to. Device-tested
  // finding (card promotion jank): `current` can advance to the next
  // candidate before this clears (see asideInFlightIdsRef below), and
  // without this guard the freshly-promoted card would inherit the exiting
  // card's leftover exitDirection prop -- a stale "Set aside" stamp/rotation
  // flashing on the wrong card. GalleryImportDeckCard is only ever told a
  // card is exiting when it truly is the one that was swiped/tapped.
  const [exitingCandidateId, setExitingCandidateId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'photos' | 'aside' | null>(null);
  const [restAcknowledgedAtKept, setRestAcknowledgedAtKept] = useState<number | null>(null);
  const actionInFlightRef = useRef(false);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const redirectedApprovalLeaseRef = useRef<string | null>(null);
  const announcedReadyIdsRef = useRef<Set<string> | null>(null);
  // Device-tested finding: after Set aside (button or swipe), the same card
  // could re-render as the front card for a fraction of a second before the
  // next one appeared. `candidates` state still carries the acted-on card's
  // pre-mutation 'ready' status for a window this component does not fully
  // control the length of (the setGalleryImportCandidateSkip mutation and its
  // checkpoint/refresh follow-through), so `activeCandidates[0]` could
  // resolve back to it. This ref -- populated the instant the 240ms exit
  // animation finishes and the mutation actually starts, cleared once
  // changeSkip's outcome (success or failure) is known -- keeps that one
  // candidate out of the queue for exactly that window, regardless of the
  // precise render/microtask ordering on a given device. It does not apply
  // to Keep: cancelling the composer must still return the same card, and
  // Keep never mutates `candidates` in the first place.
  const asideInFlightIdsRef = useRef<Set<string>>(new Set());
  // Bumped by every local candidate mutation (set aside / bring back). A
  // candidates refresh that STARTED before a mutation must not apply its
  // (now stale) response: the 9 s poll was racing the skip call, and a
  // response that left the server moments before the skip committed put the
  // just-dismissed card straight back on top of the deck, so it had to be
  // dismissed twice (device-observed 2026-08-23).
  const mutationSeqRef = useRef(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [frontier, setFrontier] = useState<GalleryImportFrontier | null>(null);
  // Set when the server refuses to complete the run with a "still has work"
  // error (S9/step 7) -- `comingIndicator` alone may not have caught up to
  // that fact yet (this device's own view of pending/local chunks can be a
  // beat behind), so this flag forces the between-batches branch even if
  // `comingIndicator.kind` still reads 'none' at the moment the error lands.
  const [forceBetweenBatches, setForceBetweenBatches] = useState(false);
  const pendingApproval = checkpoint?.approvalOutbox[0] ?? null;
  const orphanedApproval = pendingApproval ? null : candidates.find((candidate) => candidate.status === 'approving') ?? null;
  const activeCandidates = candidates.filter(
    (candidate) => candidate.status === 'ready' && !asideInFlightIdsRef.current.has(candidate.id),
  );
  const setAside = candidates.filter((candidate) => candidate.status === 'skipped');
  // The server returns candidates in deterministic run order. Treat ready
  // cards as a queue: when the head changes status, the next head advances
  // without indexing into an already-shrinking filtered array.
  const current = activeCandidates[0] ?? null;
  const deckTotal = Math.max(checkpoint?.deckTotal ?? 0, candidates.length, 1);
  const deckPosition = Math.min((checkpoint?.deckCursor ?? 0) + 1, deckTotal);
  const keptCount = Math.max(0, (checkpoint?.deckCursor ?? 0) - setAside.length);
  // Server truth (round 4), now folding in local planned/failed chunks and
  // the frontier's own moreHistory (S9) -- 'none' only once the run is
  // genuinely terminal, or 'reviewing' with a server-confirmed zero clusters
  // pending AND nothing local still unsettled AND the frontier says the
  // library is fully covered. See deriveGalleryImportComingIndicator's own
  // doc comment for why the local checkpoint plan alone can never answer
  // this question correctly across a resume.
  const comingIndicator = deriveGalleryImportComingIndicator(run, checkpoint, frontier);
  const isRunTerminal = isGalleryImportRunTerminal(run?.status);
  const dayPool = useMemo(
    () => checkpoint && current ? buildGalleryImportDayPool(checkpoint, current.selectedAssetTokens) : [],
    [checkpoint, current],
  );
  const sessionKept = (runId ? sessionKeptByRun.get(runId) : undefined) ?? [];
  // The server's own ready count, when known -- every "N left"/"N ready"
  // surface reads this instead of the locally-fetched `activeCandidates`
  // length (get-candidates' page may lag or omit rows a concurrent poll on
  // another device already changed).
  const readyCandidateCount = run?.readyCandidates ?? activeCandidates.length;

  useEffect(() => () => { if (exitTimerRef.current) clearTimeout(exitTimerRef.current); }, []);
  useEffect(() => {
    if (!userId || !familyId) { setFrontier(null); return; }
    let cancelled = false;
    void loadGalleryImportFrontier(userId, familyId).then((next) => {
      if (!cancelled) setFrontier(next);
    });
    return () => { cancelled = true; };
  }, [userId, familyId]);
  useEffect(() => {
    // Only the FOCUSED deck may redirect to a pending approval: while the
    // composer is pushed on top, the deck's checkpoint re-reads legitimately
    // see that composer's own in-flight outbox item, and redirecting from
    // underneath replaced routes under a live save (device-observed
    // 2026-08-23). Relaunch recovery still works -- the deck is focused then.
    if (!isFocused || !pendingApproval || !runId || redirectedApprovalLeaseRef.current === pendingApproval.leaseId) return;
    redirectedApprovalLeaseRef.current = pendingApproval.leaseId;
    router.replace({ pathname: '/(app)/gallery-import/approve' as never, params: { runId, candidateId: pendingApproval.candidateId } });
  }, [isFocused, pendingApproval, runId]);
  useEffect(() => {
    // Same focus gate as above: the candidate poll can observe the composer's
    // own candidate in its transient 'approving' state while it is on top.
    if (!isFocused || !orphanedApproval || !runId) return;
    router.replace({ pathname: '/(app)/gallery-import/approve' as never, params: { runId, candidateId: orphanedApproval.id } });
  }, [isFocused, orphanedApproval, runId]);
  // Round 4: this used to gate a manual "Check again" empty/refreshing
  // screen (killed below -- see the removed branch's history). There is no
  // more a quiet-vs-loud distinction to make: candidates always refresh the
  // same way, and the auto quiet-poll below means a user is never expected
  // to trigger this by hand.
  const refresh = useCallback(async () => {
    if (!checkpoint || !runId || pendingApproval) return;
    const startSeq = mutationSeqRef.current;
    try {
      const response = await getGalleryImportCandidates({ runId, capability: checkpoint.runCapability });
      if (response.error) throw new Error(response.error.message);
      // A mutation landed while this request was in flight -- its response
      // predates that mutation. Drop it; the next poll fetches fresh state.
      if (mutationSeqRef.current !== startSeq) return;
      const nextCandidates = response.data?.candidates ?? [];
      const skippedCount = nextCandidates.filter((candidate) => candidate.status === 'skipped').length;
      await updateCheckpoint((currentCheckpoint) => ({
        ...currentCheckpoint,
        // Approved cards are omitted by get-candidates. Skipped cards are not,
        // so subtract them from the cursor before inferring the unique total.
        deckTotal: Math.max(
          currentCheckpoint.deckTotal ?? 0,
          nextCandidates.length + Math.max(0, currentCheckpoint.deckCursor - skippedCount),
        ),
      }));
      reconcileSessionKept(runId, nextCandidates);
      // A polite one-time announcement when new suggestions arrive -- once per
      // batch, not per card (gi-notes.jsx accessibility spec).
      const readyIds = nextCandidates.filter((candidate) => candidate.status === 'ready').map((candidate) => candidate.id);
      if (announcedReadyIdsRef.current) {
        const arrived = readyIds.filter((id) => !announcedReadyIdsRef.current!.has(id)).length;
        if (arrived > 0) {
          AccessibilityInfo.announceForAccessibility(`${arrived} new ${arrived === 1 ? 'suggestion' : 'suggestions'} ready.`);
        }
      }
      announcedReadyIdsRef.current = new Set(readyIds);
      setCandidates(nextCandidates);
      setActionError(null);
    } catch (caught) {
      setActionError(humanError(caught));
    }
  }, [checkpoint?.runCapability, pendingApproval, runId, updateCheckpoint]);
  useEffect(() => { void refresh(); }, [refresh]);
  // Self-healing hero: a front card with no preview URL (seen on device as
  // the pink placeholder that "loaded after a bit") or one whose signed URL
  // has expired (expo-image onError) triggers one quiet re-sign per
  // candidate instead of waiting for the next 9 s poll.
  const resignedHeroIdsRef = useRef<Set<string>>(new Set());
  const resignHeroFor = useCallback((candidateId: string) => {
    if (resignedHeroIdsRef.current.has(candidateId)) return;
    resignedHeroIdsRef.current.add(candidateId);
    void refresh();
  }, [refresh]);
  const currentHeroId = current?.id ?? null;
  const currentHasHero = Boolean(current?.previewUrls?.length);
  useEffect(() => {
    if (currentHeroId && !currentHasHero) resignHeroFor(currentHeroId);
  }, [currentHeroId, currentHasHero, resignHeroFor]);
  // Round 4: server truth for "is more still coming" -- see the doc comment
  // on `comingIndicator` above and deriveGalleryImportComingIndicator's own
  // (gallery-import-deck.ts) for why the local checkpoint plan can't answer
  // this honestly across a resume/stall. A transient fetch error keeps
  // whatever `run` was last known-good rather than nulling it out, so one
  // flaky poll can't flash the screen back to "unknown".
  const refreshRun = useCallback(async () => {
    if (!checkpoint || !runId) return;
    const response = await getGalleryImportRun({ runId, runCapability: checkpoint.runCapability });
    if (response.error) return;
    if (response.data) setRun(response.data);
  }, [checkpoint?.runCapability, runId]);
  useEffect(() => { void refreshRun(); }, [refreshRun]);
  // Round 3+4, device-tested finding: chunks now genuinely keep streaming in
  // over minutes (server+runner change), so while the run is not yet
  // terminal this screen polls quietly every ~8-10s for both newly-ready
  // candidates and the server's own run status -- never the local
  // checkpoint plan (round 4: a resume/stall left that plan stale enough to
  // show a phantom "+51 coming" that never resolved on a real device). The
  // arrival announcement (AccessibilityInfo.announceForAccessibility above)
  // fires naturally off the quiet candidates refresh -- no separate wiring
  // needed. Stops the instant the run reaches a truly terminal status, and
  // this is the only poll/interval in this file.
  const hasCheckpoint = Boolean(checkpoint);
  useEffect(() => {
    if (!hasCheckpoint || !runId || isRunTerminal) return;
    const timer = setInterval(() => {
      // While an approval outbox item is pending, the candidate refresh is
      // deliberately off (see `refresh`), but the checkpoint itself must keep
      // being re-read so a finished/cleared outbox is noticed (see the
      // useFocusEffect above for the device-observed deadlock this avoids).
      void refreshCheckpoint();
      void refresh();
      void refreshRun();
    }, 9_000);
    return () => clearInterval(timer);
  }, [hasCheckpoint, isRunTerminal, refresh, refreshCheckpoint, refreshRun, runId]);
  // The aside sheet always opens over freshly signed preview URLs; a stale
  // row would otherwise render an empty thumbnail after the 5-minute expiry.
  const openAsideSheet = useCallback(() => {
    setSheet('aside');
    void refresh();
  }, [refresh]);

  // Deliberately NOT wrapped in useCallback: the React Compiler's own
  // dependency inference for this closure (which mixes ref mutations, a
  // conditional early return, and a try/catch/finally) does not agree with
  // any manually-specified dependency array we can write by hand -- lint
  // previously flagged this as "Compilation Skipped: Existing memoization
  // could not be preserved" (inferred dep `setActionError`, vs. the
  // then-listed `[checkpoint, refresh, runId, updateCheckpoint]`). There is
  // nothing costly enough in this component's render to need this memoized
  // (it is one of several handlers on a single-card screen), so the
  // straightforward fix is to stop asserting a memoization the compiler
  // itself cannot verify.
  const changeSkip = async (candidate: GalleryImportCandidate, skip: boolean) => {
    if (!checkpoint || !runId || actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setIsActioning(true);
    setActionError(null);
    try {
      const result = await setGalleryImportCandidateSkip({ candidateId: candidate.id, capability: checkpoint.runCapability, skip });
      if (result.error || !result.data) { setActionError(result.error?.message ?? 'Could not update this suggestion.'); return; }
      mutationSeqRef.current += 1;
      await updateCheckpoint((currentCheckpoint) => ({
        ...currentCheckpoint,
        deckCursor: Math.max(0, currentCheckpoint.deckCursor + (skip ? 1 : -1)),
      }));
      trackEvent('gallery_import_candidate_actioned', { action: skip ? 'skip' : 'restore' });
      setCandidates((items) => items.map((item) => {
        if (item.id !== candidate.id) return item;
        const next = result.data!.candidate;
        // set-gallery-import-candidate-skip's response carries no preview
        // URLs (only get-candidates signs them), so a wholesale replace would
        // strip the photos off an aside row and a brought-back card. Keep the
        // URLs already in memory whenever the response has none.
        return next.previewUrls?.length ? next : { ...next, previewUrls: item.previewUrls };
      }));
      // Bring back can restore a card whose in-memory preview URL was signed
      // whenever the aside sheet was last opened -- possibly minutes ago, and
      // signed URLs are short-lived. The optimistic merge above keeps that
      // URL so the card never flashes empty, but re-sign quietly right after
      // so the deck front it returns to renders a URL that has not expired,
      // the same quiet re-sign openAsideSheet already does on open.
      if (!skip) void refresh();
    } catch (caught) {
      setActionError(humanError(caught));
    } finally {
      actionInFlightRef.current = false;
      setIsActioning(false);
      // Whatever the outcome: on success `candidates` above already carries
      // the new status, so the exclusion is redundant from here on; on
      // failure/error `candidates` is untouched, so releasing it lets the
      // still-'ready' card reappear once exitDirection clears -- the existing,
      // intentional retry-visible behaviour (unchanged by this fix).
      asideInFlightIdsRef.current.delete(candidate.id);
    }
  };

  // One commit path for swipe, buttons, and screen-reader actions: play the
  // 240ms exit (90ms under reduced motion), then act.
  const fire = useCallback((direction: GalleryDeckSwipeDirection) => {
    if (!current || !runId || exitDirection || isActioning) return;
    setExitDirection(direction);
    const commitTarget = current;
    setExitingCandidateId(commitTarget.id);
    exitTimerRef.current = setTimeout(() => {
      if (direction === 'keep') {
        recordSessionKeep(runId, commitTarget);
        trackEvent('gallery_import_candidate_actioned', { action: 'keep' });
        // Hand the approval screen the server's own ready count up front
        // (it accepts an optional readyCount prop and still refreshes it in
        // the background) -- see app/(app)/gallery-import/approve.tsx.
        router.push({
          pathname: '/(app)/gallery-import/approve' as never,
          params: { runId, candidateId: commitTarget.id, readyCount: String(readyCandidateCount) },
        });
        setExitDirection(null);
        setExitingCandidateId(null);
      } else {
        // From this instant the exit animation has visually finished --
        // exclude the card now (see asideInFlightIdsRef above) so the next
        // card advances the moment the animation ends instead of waiting on
        // the network, and so this card can never be selected as the front
        // card again while the mutation is in flight.
        asideInFlightIdsRef.current.add(commitTarget.id);
        void changeSkip(commitTarget, true).finally(() => {
          setExitDirection(null);
          setExitingCandidateId(null);
        });
      }
    }, reducedMotion ? GALLERY_DECK_REDUCED_EXIT_DURATION_MS : GALLERY_DECK_EXIT_DURATION_MS);
  }, [changeSkip, current, exitDirection, isActioning, readyCandidateCount, reducedMotion, runId]);

  const finish = async () => {
    if (!checkpoint || !runId || !userId || !familyId) return;
    // The done state itself is only reachable once comingIndicator is
    // 'none' (see the between-batches branch below), so this is
    // belt-and-suspenders -- route to plain navigation instead of ever
    // completing early.
    if (comingIndicator.kind !== 'none') { exitToTimeline(); return; }
    // complete_gallery_import_run (SQL) requires the run to still be
    // 'reviewing' -- if it already reached a terminal status through some
    // other path (cancelled/expired/failed elsewhere, e.g. another device),
    // there is nothing left to complete server-side; calling it would only
    // error. Just clear local state and leave, the same outcome either way.
    if (run?.status === 'reviewing') {
      const result = await completeGalleryImportRun({ runId, capability: checkpoint.runCapability });
      if (result.error) {
        // The server refuses to complete a run with reviewable candidates or
        // in-flight chunks still outstanding (I1 step 4) -- both surface as
        // the same generic `not_available` code, and both mean the exact
        // same thing to this screen: it is not actually done. Refresh and
        // fall back to the between-batches view rather than a bare error
        // string next to the Finish button.
        setForceBetweenBatches(true);
        void refresh();
        void refreshRun();
        return;
      }
    }
    await Promise.all([clearGalleryImportCheckpoint(userId, familyId, runId), clearGalleryImportPreviewCache(runId)]);
    sessionKeptByRun.delete(runId);
    exitGalleryImportToTimeline();
  };
  const exitToTimeline = () => exitGalleryImportToTimeline();

  if (isLoading) return <View style={sharedStyles.center}><ActivityIndicator color={colors.primary} /></View>;
  if (!checkpoint) return <DeviceBoundNotice />;
  if (pendingApproval || orphanedApproval) return <View style={sharedStyles.center} testID="gallery-import-outbox-redirect"><ActivityIndicator color={colors.primary} /></View>;

  const sheets = (
    <>
      {sheet === 'photos' && current ? (
        <GalleryImportPhotoChooser
          candidate={current}
          mode="browse"
          onClose={() => setSheet(null)}
          pool={dayPool}
        />
      ) : null}
      {sheet === 'aside' ? (
        <GalleryImportSetAsideSheet
          candidates={setAside}
          isActioning={isActioning}
          onBringBack={(candidate) => void changeSkip(candidate, false)}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </>
  );

  // A place to stop -- gi-review.jsx GIRestPoint. The cursor already
  // persists, so leaving is safe; continuing is one tap. Minimal per the
  // I4a copy principle: eyebrow · title · "N more ready." · buttons, no
  // boxed reassurance ("your place is saved" lives once on the trust
  // screen -- see docs/design/gallery-import/README.md).
  if (current && isGalleryDeckRestPointDue(keptCount, restAcknowledgedAtKept)) {
    return (
      <SafeAreaView style={sharedStyles.screen} testID="gallery-import-rest-point">
        <DeckTopBar asideCount={setAside.length} onClose={exitToTimeline} onOpenAside={openAsideSheet} />
        <ScrollView contentContainerStyle={styles.restContent} style={styles.scrollBody}>
          <Text style={sharedStyles.eyebrow}>{keptCount} in a row</Text>
          <Text style={sharedStyles.displaySmall}>That is {keptCount}{'\n'}new memories.</Text>
          <Text style={sharedStyles.body}>{readyCandidateCount} more ready.</Text>
          {sessionKept.length > 0 ? (
            <View style={styles.restStrip}>
              {sessionKept.slice(-6).map((item, index) => (
                <View key={item.candidateId} style={[styles.restPrint, { transform: [{ rotate: `${(index % 2 ? 1 : -1) * 1.4}deg` }] }]}>
                  {item.previewUri ? <Image contentFit="cover" source={{ uri: item.previewUri }} style={styles.restPrintImage} /> : <View style={styles.restPrintEmpty} />}
                </View>
              ))}
            </View>
          ) : null}
        </ScrollView>
        <View style={[gi.stickyFooterSurface, styles.actionArea]} testID="gallery-import-action-area">
          <Pressable accessibilityRole="button" onPress={() => setRestAcknowledgedAtKept(keptCount)} style={({ pressed }) => [styles.primaryAction, pressed && styles.actionPressed]} testID="gallery-import-rest-continue">
            <Text style={styles.primaryActionText}>Keep going · {readyCandidateCount} ready</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={exitToTimeline} style={styles.ghostAction} testID="gallery-import-rest-stop">
            <Text style={styles.ghostActionText}>That is enough for now</Text>
          </Pressable>
        </View>
        {sheets}
      </SafeAreaView>
    );
  }

  if (!current) {
    // Round 4, device-tested finding: the old empty/refreshing branch here
    // ("Writing drafts." + a manual "Check again" button the user had to
    // hammer) is gone for good -- the drawer said suggestions were ready,
    // tapping through landed on a bare non-interactive screen. The
    // between-batches state below (round 3) now covers every "nothing to
    // show right now, but the run has not confirmed it's done" case, always
    // backed by the auto quiet-poll above; there is no more a manual refresh
    // surface anywhere on this screen.
    //
    // Server truth (S9) gates which of the two remaining states shows:
    // between-batches unless the run is genuinely terminal or 'reviewing'
    // with a server-confirmed zero clusters pending, nothing local
    // unsettled, and the frontier confirms full coverage
    // (comingIndicator.kind 'none') -- see deriveGalleryImportComingIndicator's
    // own doc comment for why the local checkpoint plan alone can never
    // answer this honestly across a resume/stall (finish() guards the same
    // condition, belt-and-suspenders). `forceBetweenBatches` additionally
    // covers the server's own "still has work" refusal from completeGalleryImportRun,
    // which can land a beat before this device's own comingIndicator catches up.
    if (comingIndicator.kind !== 'none' || forceBetweenBatches) {
      const moreHistoryOnly = comingIndicator.kind === 'unknown'
        ? comingIndicator.moreHistory
        : comingIndicator.kind === 'count' && comingIndicator.count === 0 && comingIndicator.moreHistory;
      return (
        <SafeAreaView style={sharedStyles.screen} testID="gallery-import-between-batches">
          <DeckTopBar asideCount={setAside.length} onClose={exitToTimeline} onOpenAside={openAsideSheet} />
          <ScrollView contentContainerStyle={styles.restContent} style={styles.scrollBody}>
            <View style={styles.eyebrowRow}>
              <BreathingDot />
              <Text style={sharedStyles.eyebrow}>More on the way</Text>
            </View>
            <Text style={sharedStyles.displaySmall}>
              {comingIndicator.kind === 'count' && comingIndicator.count > 0
                ? `${comingIndicator.count} more\nbeing written.`
                : moreHistoryOnly
                  ? 'Momora is still\nlooking through your photos.'
                  : 'More suggestions\nare being written.'}
            </Text>
            <Text style={sharedStyles.body}>
              {keptCount > 0
                ? `You are caught up on what is ready. Your ${keptCount} kept ${keptCount === 1 ? 'memory is' : 'memories are'} already in your journal.`
                : 'You are caught up on what is ready for now.'}
            </Text>
            {actionError ? <Text style={sharedStyles.error}>{actionError}</Text> : null}
          </ScrollView>
          <View style={[gi.stickyFooterSurface, styles.actionArea]} testID="gallery-import-action-area">
            <Pressable accessibilityRole="button" onPress={exitToTimeline} style={({ pressed }) => [styles.primaryAction, pressed && styles.actionPressed]} testID="gallery-import-between-batches-journal">
              <Text style={styles.primaryActionText}>Go to my journal</Text>
            </Pressable>
            {setAside.length > 0 ? (
              <Pressable accessibilityRole="button" onPress={openAsideSheet} style={styles.ghostAction} testID="gallery-import-between-batches-aside">
                <Text style={styles.ghostActionText}>Look at the {setAside.length} I set aside</Text>
              </Pressable>
            ) : null}
          </View>
          {sheets}
        </SafeAreaView>
      );
    }
    // All caught up -- gi-review.jsx GIDeckDone. comingIndicator.kind is
    // guaranteed 'none' here (the branch above claims every other case).
    return (
      <SafeAreaView style={sharedStyles.screen} testID="gallery-import-done">
        <DeckTopBar asideCount={setAside.length} onClose={exitToTimeline} onOpenAside={openAsideSheet} />
        <ScrollView contentContainerStyle={styles.restContent} style={styles.scrollBody}>
          <Text style={sharedStyles.eyebrow}>All caught up</Text>
          {keptCount > 0 ? (
            <Text style={sharedStyles.displaySmall}>{keptCount} {keptCount === 1 ? 'memory' : 'memories'},{'\n'}from years{'\n'}you already had.</Text>
          ) : (
            <Text style={sharedStyles.displaySmall}>All caught up.</Text>
          )}
          <Text style={sharedStyles.body}>
            {keptCount > 0
              ? `They are in your journal on the days they happened. Your family gets one quiet summary, not ${keptCount} ${keptCount === 1 ? 'notification' : 'notifications'}.`
              // "Will not come back in a future look" already lives in the
              // aside-pill copy right below, next to the set-aside count --
              // saying it twice on one screen read as a mistake (device
              // screenshot). Kept short here on purpose.
              : 'Nothing new to look at right now.'}
          </Text>
          {sessionKept.length > 0 ? (
            <View style={styles.doneGrid} testID="gallery-import-done-grid">
              {sessionKept.slice(0, 6).map((item) => (
                <View key={item.candidateId} style={styles.doneTile}>
                  {item.previewUri ? <Image contentFit="cover" source={{ uri: item.previewUri }} style={styles.doneTileImage} /> : <View style={styles.doneTileEmpty} />}
                </View>
              ))}
            </View>
          ) : null}
          {setAside.length > 0 ? (
            <View style={styles.donePillRow}>
              <View style={styles.donePill}><Text style={styles.donePillText}>{setAside.length} set aside</Text></View>
              <Text style={styles.donePillCopy}>Won’t be suggested again.</Text>
            </View>
          ) : null}
          {actionError ? <Text style={sharedStyles.error}>{actionError}</Text> : null}
        </ScrollView>
        <View style={[gi.stickyFooterSurface, styles.actionArea]} testID="gallery-import-action-area">
          <Pressable accessibilityRole="button" onPress={() => void finish()} style={({ pressed }) => [styles.primaryAction, pressed && styles.actionPressed]} testID="gallery-import-complete">
            {/* Device screenshot: "See them in my journal" reads wrong when
                nothing was kept -- there is nothing to "see". */}
            <Text style={styles.primaryActionText}>{keptCount > 0 ? 'See them in my journal' : 'Go to my journal'}</Text>
          </Pressable>
          {setAside.length > 0 ? (
            <Pressable accessibilityRole="button" onPress={openAsideSheet} style={styles.ghostAction} testID="gallery-import-done-aside">
              <Text style={styles.ghostActionText}>Look at the {setAside.length} I set aside</Text>
            </Pressable>
          ) : null}
        </View>
        {sheets}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={sharedStyles.screen}>
      <DeckTopBar asideCount={setAside.length} onClose={exitToTimeline} onOpenAside={openAsideSheet} />
      <DeckTicks coming={comingIndicator} onPressComing={() => router.push({ pathname: '/(app)/gallery-import/progress' as never, params: { runId } })} position={deckPosition} total={deckTotal} />
      <View style={styles.deck}>
        {/* the next prints, peeking (gi-review.jsx ~124-131) */}
        <View pointerEvents="none" style={[styles.peek, styles.peekBack]} />
        <View pointerEvents="none" style={[styles.peek, styles.peekFront]} />
        <GalleryImportDeckCard
          candidate={current}
          disabled={isActioning}
          // Device-tested finding (card promotion jank): only ever tell the
          // card it is exiting when it truly is the one that was swiped/
          // tapped -- `current` can already point at the next candidate
          // while exitDirection is still clearing (see asideInFlightIdsRef
          // above), and a stale exitDirection prop on a freshly-promoted
          // card produced a leftover tilt + a visible snap once it cleared.
          exitDirection={current.id === exitingCandidateId ? exitDirection : null}
          onChoosePhotos={() => setSheet('photos')}
          onCommit={fire}
          onHeroUnavailable={() => resignHeroFor(current.id)}
          onShowSetAside={openAsideSheet}
          poolCount={dayPool.length > 0 ? dayPool.length : null}
          position={deckPosition}
          total={deckTotal}
        />
      </View>
      {/* accessible equivalents -- never gesture-only */}
      <View style={[gi.stickyFooterSurface, styles.actionArea]} testID="gallery-import-action-area">
        <View style={styles.actionRow}>
          <Pressable accessibilityRole="button" disabled={isActioning || Boolean(exitDirection)} onPress={() => fire('aside')} style={({ pressed }) => [styles.secondaryAction, (pressed || isActioning) && styles.actionPressed]} testID="gallery-import-set-aside">
            <SymbolView fallback={<Text style={styles.secondaryActionText}>✕</Text>} name={{ ios: 'xmark', android: 'close' }} size={15} tintColor={colors.ink2} />
            <Text style={styles.secondaryActionText}>Set aside</Text>
          </Pressable>
          <Pressable accessibilityRole="button" disabled={isActioning || Boolean(exitDirection)} onPress={() => fire('keep')} style={({ pressed }) => [styles.keepAction, (pressed || isActioning) && styles.actionPressed]} testID="gallery-import-keep">
            <SymbolView fallback={<Text style={styles.keepActionText}>✓</Text>} name={{ ios: 'checkmark', android: 'check' }} size={15} tintColor={colors.white} />
            <Text style={styles.keepActionText}>Keep this</Text>
          </Pressable>
        </View>
        {actionError
          ? <Text style={sharedStyles.error}>{actionError}</Text>
          : <Text style={styles.previewNote} testID="gallery-import-preview-note">Small previews here. Kept photos save at full size.</Text>}
      </View>
      {sheets}
    </SafeAreaView>
  );
}

// ── Deck chrome ──────────────────────────────────────────────────────────
// One affordance on both platforms: the app's pink text button ("Close"),
// matching GalleryImportTopBar and the composer's Cancel. The prototype's
// Android bare-glyph arrow read as a stray mark next to the rest of the app
// (device-tested finding).
function DeckTopBar({ asideCount, onClose, onOpenAside }: { asideCount: number; onClose: () => void; onOpenAside: () => void }) {
  return (
    <View style={styles.topBar}>
      <Pressable accessibilityRole="button" hitSlop={10} onPress={onClose} style={styles.topBarClose} testID="gallery-import-back">
        <Text style={styles.topBarCloseText}>Close</Text>
      </Pressable>
      <View style={styles.topBarSpacer} />
      <Pressable
        accessibilityLabel={`Set aside, ${asideCount} ${asideCount === 1 ? 'suggestion' : 'suggestions'}`}
        accessibilityRole="button"
        onPress={onOpenAside}
        style={({ pressed }) => [styles.asidePill, pressed && styles.actionPressed]}
        testID="gallery-import-set-aside-pill"
      >
        <SymbolView fallback={<Text style={styles.asidePillText}>↺</Text>} name={{ ios: 'clock.arrow.circlepath', android: 'history' }} size={14} tintColor={colors.ink2} />
        <Text style={styles.asidePillText}>Set aside · {asideCount}</Text>
      </Pressable>
    </View>
  );
}

// The still-coming dot breathes while the run stages (design: gi-shared.jsx
// giBreathe, opacity .5 -> .9). withRepeat's reverse flag reproduces the
// back-and-forth without Easing/withSequence (unavailable in the repo's
// reanimated Jest mock -- same pattern as import-glyph.tsx). Reduced motion
// keeps it solid (gi-notes.jsx: "Breathing dots become solid").
function BreathingDot() {
  const reducedMotion = useReducedMotion();
  const opacity = useSharedValue(0.9);
  useEffect(() => {
    if (reducedMotion) {
      opacity.set(0.9);
      return;
    }
    opacity.set(withRepeat(withTiming(0.5, { duration: 1600 }), -1, true));
  }, [opacity, reducedMotion]);
  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.get() }));
  return <Animated.View style={[styles.comingDot, animatedStyle]} />;
}

// Round 4: "+N coming" text for a GalleryImportComingIndicator -- a real
// number when the server knows it, qualitative "more coming" copy (no
// digit) when it does not, nothing once the run is genuinely caught up.
function galleryImportComingLabel(coming: GalleryImportComingIndicator): string | null {
  if (coming.kind === 'none') return null;
  if (coming.kind === 'count') return `+${coming.count} coming`;
  return 'more coming';
}

// Per-suggestion segment ticks plus the breathing "+N coming" indicator --
// never a continuous completion bar over an unknown total.
function DeckTicks({ position, total, coming, onPressComing }: { position: number; total: number; coming: GalleryImportComingIndicator; onPressComing?: () => void }) {
  const tickCount = Math.min(total, DECK_TICK_MAX);
  // When the deck outgrows the tick row, ticks represent proportional
  // progress; the accessible label always carries the exact position.
  const activeTick = total <= DECK_TICK_MAX
    ? position - 1
    : Math.min(tickCount - 1, Math.floor(((position - 1) / total) * tickCount));
  const comingLabel = galleryImportComingLabel(coming);
  return (
    <View accessibilityLabel={`Suggestion ${position} of ${total}`} style={styles.ticksRow} testID="gallery-import-deck-progress">
      <View style={styles.ticks}>
        {Array.from({ length: tickCount }).map((_, index) => (
          <View
            key={index}
            style={[styles.tick, index < activeTick ? styles.tickDone : index === activeTick ? styles.tickActive : null]}
          />
        ))}
      </View>
      {comingLabel ? (
        // Tappable: with cards ready, every entry point routes to this deck,
        // so this indicator is the one door to the progress screen (status,
        // "Stop looking for more", fair-use pause).
        <Pressable accessibilityLabel={`${comingLabel}. See progress.`} accessibilityRole="button" hitSlop={8} onPress={onPressComing} style={styles.coming} testID="gallery-import-still-coming">
          <BreathingDot />
          <Text style={styles.comingText}>{comingLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  topBar: { alignItems: 'center', flexDirection: 'row', minHeight: 44, paddingHorizontal: spacing.lg },
  topBarClose: { paddingVertical: 10 },
  topBarCloseText: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 15.5 },
  topBarSpacer: { flex: 1 },
  asidePill: {
    alignItems: 'center',
    backgroundColor: colors.white,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    minHeight: 36,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  asidePillText: { color: colors.ink2, fontFamily: fonts.sansBold, fontSize: 12.5 },

  ticksRow: { alignItems: 'center', flexDirection: 'row', gap: 10, paddingHorizontal: spacing.lg, paddingTop: 2 },
  ticks: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: 4 },
  tick: { backgroundColor: colors.border, borderRadius: radius.pill, flex: 1, height: 3, maxWidth: 26 },
  tickDone: { backgroundColor: colors.primary },
  tickActive: { backgroundColor: colors.primarySoft },
  coming: { alignItems: 'center', flexDirection: 'row', gap: 5, marginLeft: 6 },
  comingDot: { backgroundColor: colors.sea, borderRadius: radius.pill, height: 6, width: 6 },
  comingText: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 11.5 },

  deck: { flex: 1, margin: spacing.lg, marginBottom: spacing.sm, minHeight: 300, position: 'relative' },
  peek: { backgroundColor: colors.white, borderColor: colors.border, borderRadius: radius.xl, borderWidth: 1, position: 'absolute' },
  peekBack: { bottom: 6, left: 30, right: 30, top: 12, transform: [{ rotate: '-1.4deg' }] },
  peekFront: { bottom: 4, left: 25, right: 25, top: 6, transform: [{ rotate: '1deg' }] },

  // Bottom clearance below gi.stickyFooterSurface's own paddingHorizontal/
  // paddingTop (composed at each usage site). This screen's outer
  // SafeAreaView keeps its default (all-edge) insets, so this footer is
  // normal flow, not absolutely positioned -- the native bottom safe-area
  // inset already reaches it and this is only the usual visual gap on top
  // of that, never a second copy of the inset itself.
  actionArea: { gap: 10, paddingBottom: spacing.lg },
  // Without an explicit flex here a ScrollView sizes to its content instead
  // of the space actually available above the pinned footer -- on a tall
  // rest-point/done body that let the footer's bottom edge run past the
  // screen and under the Android system nav bar (device-tested finding).
  scrollBody: { flex: 1 },
  actionRow: { alignItems: 'center', flexDirection: 'row', gap: 10 },
  secondaryAction: {
    alignItems: 'center',
    backgroundColor: colors.white,
    borderColor: colors.borderStrong,
    borderRadius: radius.pill,
    borderWidth: 1,
    flex: 1,
    flexDirection: 'row',
    gap: 7,
    justifyContent: 'center',
    minHeight: 52,
    paddingHorizontal: spacing.md,
  },
  secondaryActionText: { color: colors.ink2, fontFamily: fonts.sansBold, fontSize: 14 },
  keepAction: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    flex: 1.25,
    flexDirection: 'row',
    gap: 7,
    justifyContent: 'center',
    minHeight: 52,
    paddingHorizontal: spacing.md,
  },
  keepActionText: { color: colors.white, fontFamily: fonts.sansBold, fontSize: 15 },
  primaryAction: {
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
    justifyContent: 'center',
    minHeight: 52,
    paddingHorizontal: spacing.lg,
  },
  primaryActionText: { color: colors.white, fontFamily: fonts.sansBold, fontSize: 15 },
  ghostAction: { alignItems: 'center', minHeight: 44, justifyContent: 'center' },
  ghostActionText: { color: colors.primary, fontFamily: fonts.sansBold, fontSize: 13 },
  previewNote: { color: colors.ink3, fontFamily: fonts.sans, fontSize: 12, lineHeight: 16, marginTop: 8, textAlign: 'center' },
  actionPressed: { opacity: 0.55 },

  // Between-batches waiting room (round 3): the same breathing dot the
  // deck's own "+N coming" indicator uses, next to the eyebrow instead of
  // buried in a progress bar.
  eyebrowRow: { alignItems: 'center', flexDirection: 'row', gap: 7 },

  restContent: { paddingBottom: 160, paddingHorizontal: spacing.lg, paddingTop: 14 },
  restStrip: { flexDirection: 'row', gap: 7, marginTop: spacing.lg },
  restPrint: { borderRadius: radius.sm, flex: 1, height: 74, overflow: 'hidden' },
  restPrintImage: { height: '100%', width: '100%' },
  restPrintEmpty: { backgroundColor: colors.surface, height: '100%', width: '100%' },

  doneGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: spacing.lg },
  doneTile: { aspectRatio: 1, borderRadius: 10, overflow: 'hidden', width: '31.5%' },
  doneTileImage: { height: '100%', width: '100%' },
  doneTileEmpty: { backgroundColor: colors.surface, height: '100%', width: '100%' },
  donePillRow: { alignItems: 'center', flexDirection: 'row', gap: 10, marginTop: spacing.lg },
  donePill: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: radius.pill, borderWidth: 1, paddingHorizontal: 11, paddingVertical: 5 },
  donePillText: { color: colors.ink2, fontFamily: fonts.sansBold, fontSize: 12 },
  donePillCopy: { color: colors.ink2, flex: 1, fontFamily: fonts.sans, fontSize: 12.5, lineHeight: 18 },
});
