// Year Film player (docs/plans/year-film-p2.md Step 6, feature doc
// docs/features/year-film.md "Player & share"). Full-screen, sound on.
// The playback controller (create-once expo-video player, replaceAsync-only
// source changes, URL-expiry retry) is src/hooks/useYearFilmPlayer.ts; share
// is src/hooks/useYearFilmShare.ts.
import { useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { VideoView } from 'expo-video';
import { ChevronLeft, ChevronRight, Pause, Play, Share2, Volume2, VolumeX, X } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { BookToast } from '@/components/memory-books/book-toast';
import { EditFilmButton } from '@/components/year-films/edit/edit-film-button';
import { FILM_EDIT_SAVED_MESSAGE, FilmEditSheet } from '@/components/year-films/edit/film-edit-sheet';
import { FilmCompletion } from '@/components/year-films/player/film-completion';
import { FilmProgress } from '@/components/year-films/player/film-progress';
import { FilmShareProgress } from '@/components/year-films/player/film-share-progress';
import { fonts } from '@/constants/theme';
import { useFamily } from '@/hooks/use-family';
import { useYearFilm } from '@/hooks/useYearFilm';
import { useYearFilmPlayer } from '@/hooks/useYearFilmPlayer';
import { useYearFilmShare } from '@/hooks/useYearFilmShare';
import { invalidateYearFilms, useMarkYearFilmCompleted, useMarkYearFilmViewed } from '@/hooks/useYearFilms';
import { timelineRoute, type YearFilmOpenSource } from '@/lib/routes';
import { trackEvent } from '@/services/analytics';
import { canEditFamilyContent } from '@/utils/roles';

// Dark plum letterbox (the film's own background family). No theme token exists.
const PLUM = '#1F1428';
const CREAM = '#F6F1E7';
const HOLD_MS = 220;
/** After a saved edit the player stays this long so the "Remaking" toast can be read. */
const LEAVE_AFTER_SAVE_MS = 2200;
const UNAVAILABLE_MESSAGE = "This film isn't available right now.";
// The row is `blocked` while an edit that removed moments is being remade.
const UNAVAILABLE_REMAKING_MESSAGE = 'This film is being remade. Check back in a few minutes.';
/** A tap in the left third goes back, the rest goes forward (looking-back convention). */
const PREVIOUS_ZONE_WIDTH = '33%';

const OPEN_SOURCES: readonly YearFilmOpenSource[] = ['timeline', 'keepsakes', 'push', 'drawer', 'calendar'];

function parseOpenSource(value: string | string[] | undefined): YearFilmOpenSource {
  const raw = Array.isArray(value) ? value[0] : value;
  return OPEN_SOURCES.find((candidate) => candidate === raw) ?? 'timeline';
}

function close() {
  // A push can cold-start straight into this screen; Back then lands on the
  // tabs (Timeline), same as the memory-book push.
  if (router.canGoBack()) router.back();
  else router.replace(timelineRoute);
}

export default function YearFilmScreen() {
  const { id, source } = useLocalSearchParams<{ id?: string | string[]; source?: string | string[] }>();
  const filmId = (Array.isArray(id) ? id[0] : id) ?? '';
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const { film, title, refetch: refetchFilm } = useYearFilm(filmId);
  const markViewed = useMarkYearFilmViewed();
  const markCompleted = useMarkYearFilmCompleted();

  const kind = film?.kind ?? null;
  // The film's family, not the active one: a push can open this before the
  // active-family switch completes.
  const filmFamilyId = film?.family_id ?? null;

  // Edit (owners/managers of the FILM's family only; the RPC enforces it too).
  const { memberships } = useFamily();
  const canEditFilm = canEditFamilyContent(
    filmFamilyId ? memberships.find((membership) => membership.familyId === filmFamilyId)?.role : null,
  );
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
    },
    [],
  );
  const closeEditSheet = useCallback(() => setIsEditOpen(false), []);
  const onEditSaved = useCallback(() => {
    // A removal takes the film down, so leave the player once the toast has
    // been seen.
    setIsEditOpen(false);
    setToastMessage(FILM_EDIT_SAVED_MESSAGE);
    if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
    leaveTimerRef.current = setTimeout(close, LEAVE_AFTER_SAVE_MS);
  }, []);
  const dismissToast = useCallback(() => setToastMessage(null), []);

  const player = useYearFilmPlayer({
    filmId,
    fallbackDurationMs: film?.duration_ms ?? null,
    onFirstPlay: () => markViewed.mutate(filmId),
    onComplete: (durationMs) => {
      markCompleted.mutate(filmId);
      if (kind) trackEvent('year_film_completed', { kind, duration_s: Math.round(durationMs / 1000) });
    },
    onUnavailable: () => {
      void invalidateYearFilms(queryClient, filmFamilyId);
      // The by-id row decides the copy below ("being remade" when blocked).
      void refetchFilm();
    },
  });

  const share = useYearFilmShare({ filmId, kind, title });

  // `year_film_opened`: once, as soon as the film row (its kind) is known.
  const openedTrackedRef = useRef(false);
  const openSource = parseOpenSource(source);
  useEffect(() => {
    if (!kind || openedTrackedRef.current) return;
    openedTrackedRef.current = true;
    trackEvent('year_film_opened', { kind, source: openSource });
  }, [kind, openSource]);

  const [isScreenReaderEnabled, setIsScreenReaderEnabled] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isScreenReaderEnabled()
      .then(setIsScreenReaderEnabled)
      .catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener('screenReaderChanged', setIsScreenReaderEnabled);
    return () => subscription.remove();
  }, []);

  // Hold = pause; a recognised hold must not also count as a tap.
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didHoldRef = useRef(false);
  const { hold, release, next, previous } = player;
  const onPressIn = useCallback(() => {
    didHoldRef.current = false;
    holdTimerRef.current = setTimeout(() => {
      didHoldRef.current = true;
      hold();
    }, HOLD_MS);
  }, [hold]);
  const onPressOut = useCallback(() => {
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    holdTimerRef.current = null;
    // Idempotent; always release this gesture's hold.
    release();
  }, [release]);
  useEffect(
    () => () => {
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    },
    [],
  );
  // Share from the top bar pauses via `hold()`, and the film stays paused after
  // the share finishes or is cancelled. The tap that resumes it (its pressOut
  // already released the hold) must not also skip a scene.
  const pausedByShareRef = useRef(false);
  const { hold: holdPlayback, togglePaused } = player;
  const { share: startShare } = share;
  const onSharePlayer = useCallback(() => {
    pausedByShareRef.current = true;
    holdPlayback();
    void startShare('player');
  }, [holdPlayback, startShare]);
  const onToggleAccessiblePause = useCallback(() => {
    pausedByShareRef.current = false;
    togglePaused();
  }, [togglePaused]);
  const onTapPrevious = useCallback(() => {
    if (didHoldRef.current) {
      didHoldRef.current = false;
      pausedByShareRef.current = false;
      return;
    }
    if (pausedByShareRef.current) {
      pausedByShareRef.current = false;
      return;
    }
    previous();
  }, [previous]);
  const onTapNext = useCallback(() => {
    if (didHoldRef.current) {
      didHoldRef.current = false;
      pausedByShareRef.current = false;
      return;
    }
    if (pausedByShareRef.current) {
      pausedByShareRef.current = false;
      return;
    }
    next();
  }, [next]);

  const filmLabel = title ? `${title}, film` : 'Film';
  const isPlayable = player.phase === 'loading' || player.phase === 'ready';
  const showPoster = Boolean(player.posterUrl) && !player.hasFirstFrame;
  const showSpinner =
    isPlayable && !player.hasFirstFrame && !player.needsMotionConfirm;
  const showControls = isPlayable && !player.isComplete && !player.needsMotionConfirm;
  const isPausedByHold = player.isHeld && !player.isComplete;
  const canShareFromPlayer =
    player.phase === 'ready' && !player.isComplete && !player.needsMotionConfirm && kind !== null;
  const isShareBusy = share.status !== 'idle';

  return (
    <View style={styles.screen} testID="year-film-player">
      <StatusBar style="light" />

      {/* Stage: the picture only. Named for screen readers; the touch zones and
          controls are siblings so they are not swallowed by this group. */}
      <View accessibilityLabel={filmLabel} accessible style={StyleSheet.absoluteFill} testID="year-film-stage">
        <VideoView
          contentFit="contain"
          nativeControls={false}
          onFirstFrameRender={player.markFirstFrame}
          player={player.player}
          style={StyleSheet.absoluteFill}
          testID="year-film-video"
        />
        {showPoster ? (
          <Image
            accessibilityIgnoresInvertColors
            contentFit="contain"
            source={{
              uri: player.posterUrl!,
              // Stable identity: the presigned URL changes on every fetch.
              cacheKey: film ? `film-poster:${film.id}:${film.ready_at ?? ''}` : undefined,
            }}
            style={[StyleSheet.absoluteFill, styles.poster]}
            testID="year-film-poster"
          />
        ) : null}
        {showSpinner ? (
          <View pointerEvents="none" style={styles.center}>
            <ActivityIndicator color={CREAM} testID="year-film-loading" />
          </View>
        ) : null}
      </View>

      {showControls ? (
        <View pointerEvents="box-none" style={styles.zones}>
          <Pressable
            accessible={false}
            onPress={onTapPrevious}
            onPressIn={onPressIn}
            onPressOut={onPressOut}
            style={{ width: PREVIOUS_ZONE_WIDTH }}
            testID="year-film-tap-previous"
          />
          <Pressable
            accessible={false}
            onPress={onTapNext}
            onPressIn={onPressIn}
            onPressOut={onPressOut}
            style={styles.nextZone}
            testID="year-film-tap-next"
          />
        </View>
      ) : null}

      {share.status === 'downloading' && !player.isComplete ? (
        <FilmShareProgress onCancel={share.cancel} progress={share.progress} />
      ) : null}

      <SafeAreaView edges={['top']} pointerEvents="box-none" style={styles.top}>
        <View pointerEvents="box-none" style={styles.topChrome}>
          {isPlayable ? (
            <FilmProgress
              activeIndex={player.sceneIndex}
              isComplete={player.isComplete}
              positionMs={player.positionMs}
              scenes={player.scenes}
            />
          ) : null}
          <View style={styles.topBar}>
            <Text numberOfLines={1} style={styles.topTitle} testID="year-film-title">
              {title ?? ''}
            </Text>
            {isPlayable ? (
              <Pressable
                accessibilityLabel={player.isMuted ? 'Unmute film' : 'Mute film'}
                accessibilityRole="button"
                onPress={player.toggleMute}
                style={styles.roundButton}
                testID="year-film-mute"
              >
                {player.isMuted ? <VolumeX color={CREAM} size={18} /> : <Volume2 color={CREAM} size={18} />}
              </Pressable>
            ) : null}
            {canShareFromPlayer ? (
              <Pressable
                accessibilityLabel="Share film"
                accessibilityRole="button"
                accessibilityState={{ disabled: isShareBusy }}
                disabled={isShareBusy}
                onPress={onSharePlayer}
                style={[styles.roundButton, isShareBusy && styles.roundButtonDisabled]}
                testID="year-film-share-top"
              >
                <Share2 color={CREAM} size={18} />
              </Pressable>
            ) : null}
            <Pressable
              accessibilityLabel="Close film"
              accessibilityRole="button"
              hitSlop={10}
              onPress={close}
              style={styles.roundButton}
              testID="year-film-close"
            >
              <X color={CREAM} size={18} />
            </Pressable>
          </View>
        </View>
      </SafeAreaView>

      {isPausedByHold ? (
        <View pointerEvents="none" style={styles.pauseVeil} testID="year-film-pause-veil">
          <Text style={styles.pausePill}>Paused</Text>
        </View>
      ) : null}

      {showControls && isScreenReaderEnabled ? (
        <View style={[styles.accessibleControls, { paddingBottom: insets.bottom + 16 }]}>
          <Pressable
            accessibilityLabel="Previous scene"
            accessibilityRole="button"
            onPress={player.previous}
            style={styles.accessibleButton}
          >
            <ChevronLeft color={CREAM} />
          </Pressable>
          <Pressable
            accessibilityLabel={player.isHeld ? 'Play film' : 'Pause film'}
            accessibilityRole="button"
            onPress={onToggleAccessiblePause}
            style={styles.accessibleButton}
          >
            {player.isHeld ? <Play color={CREAM} /> : <Pause color={CREAM} />}
          </Pressable>
          <Pressable
            accessibilityLabel="Next scene"
            accessibilityRole="button"
            onPress={player.next}
            style={styles.accessibleButton}
          >
            <ChevronRight color={CREAM} />
          </Pressable>
        </View>
      ) : null}

      {player.needsMotionConfirm && isPlayable ? (
        <View style={styles.overlayCenter} testID="year-film-motion-warning">
          <Text style={styles.message}>This film has a lot of motion.</Text>
          <Pressable
            accessibilityLabel="Play film"
            accessibilityRole="button"
            onPress={player.confirmPlay}
            style={styles.primaryButton}
            testID="year-film-motion-play"
          >
            <Text style={styles.primaryButtonText}>Play</Text>
          </Pressable>
        </View>
      ) : null}

      {player.isComplete ? (
        <FilmCompletion
          onReplay={player.replay}
          renderExtraActions={canEditFilm ? () => <EditFilmButton onPress={() => setIsEditOpen(true)} /> : undefined}
          share={{ status: share.status, progress: share.progress, onShare: () => void share.share('completion'), onCancel: share.cancel }}
          title={title}
        />
      ) : null}

      {canEditFilm && filmFamilyId ? (
        <FilmEditSheet
          familyId={filmFamilyId}
          filmId={filmId}
          onClose={closeEditSheet}
          onSaved={onEditSaved}
          visible={isEditOpen}
        />
      ) : null}
      <BookToast bottomOffset={insets.bottom + 24} message={toastMessage} onDismiss={dismissToast} />

      {player.phase === 'unavailable' ? (
        <View style={styles.overlayFull} testID="year-film-unavailable">
          <Text style={styles.message}>
            {film?.blocked ? UNAVAILABLE_REMAKING_MESSAGE : UNAVAILABLE_MESSAGE}
          </Text>
          <Pressable
            accessibilityLabel="Close"
            accessibilityRole="button"
            onPress={close}
            style={styles.primaryButton}
            testID="year-film-unavailable-close"
          >
            <Text style={styles.primaryButtonText}>Close</Text>
          </Pressable>
        </View>
      ) : null}

      {player.phase === 'error' ? (
        <View style={styles.overlayFull} testID="year-film-error">
          <Text style={styles.message}>This film couldn&apos;t be played.</Text>
          <Pressable
            accessibilityLabel="Try again"
            accessibilityRole="button"
            onPress={player.retry}
            style={styles.primaryButton}
            testID="year-film-retry"
          >
            <Text style={styles.primaryButtonText}>Try again</Text>
          </Pressable>
          <Pressable accessibilityLabel="Close" accessibilityRole="button" onPress={close} style={styles.textButton}>
            <Text style={styles.textButtonText}>Close</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: PLUM, flex: 1, overflow: 'hidden' },
  poster: { backgroundColor: PLUM },
  center: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  zones: { ...StyleSheet.absoluteFill, flexDirection: 'row' },
  nextZone: { flex: 1 },
  top: { left: 0, position: 'absolute', right: 0, top: 0 },
  topChrome: { paddingHorizontal: 14, paddingTop: 8 },
  topBar: { alignItems: 'center', flexDirection: 'row', gap: 10, marginTop: 12 },
  topTitle: { color: CREAM, flex: 1, fontFamily: fonts.sansBold, fontSize: 13 },
  roundButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(246,241,231,0.14)',
    borderColor: 'rgba(246,241,231,0.16)',
    borderRadius: 22,
    borderWidth: 1,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  roundButtonDisabled: { opacity: 0.5 },
  pauseVeil: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    backgroundColor: 'rgba(18,10,26,0.34)',
    justifyContent: 'flex-start',
    paddingTop: 116,
  },
  pausePill: {
    backgroundColor: 'rgba(246,241,231,0.18)',
    borderRadius: 999,
    color: CREAM,
    fontFamily: fonts.sansBold,
    overflow: 'hidden',
    paddingHorizontal: 15,
    paddingVertical: 8,
  },
  accessibleControls: {
    bottom: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 18,
    left: 0,
    position: 'absolute',
    right: 0,
  },
  accessibleButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(246,241,231,0.14)',
    borderRadius: 26,
    height: 52,
    justifyContent: 'center',
    width: 52,
  },
  overlayCenter: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    backgroundColor: 'rgba(31,20,40,0.6)',
    justifyContent: 'center',
    paddingHorizontal: 34,
  },
  overlayFull: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    backgroundColor: PLUM,
    justifyContent: 'center',
    paddingHorizontal: 34,
  },
  message: { color: CREAM, fontFamily: fonts.display, fontSize: 24, lineHeight: 30, textAlign: 'center' },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: CREAM,
    borderRadius: 999,
    justifyContent: 'center',
    marginTop: 24,
    minHeight: 48,
    minWidth: 140,
    paddingHorizontal: 22,
  },
  primaryButtonText: { color: PLUM, fontFamily: fonts.sansBold, fontSize: 14 },
  textButton: { alignItems: 'center', justifyContent: 'center', minHeight: 44, marginTop: 8, paddingHorizontal: 18 },
  textButtonText: { color: 'rgba(246,241,231,0.8)', fontFamily: fonts.sansBold, fontSize: 13 },
});
