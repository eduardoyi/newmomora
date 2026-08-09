import { useFocusEffect, useLocalSearchParams, useNavigation, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { StatusBar } from 'expo-status-bar';
import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, Layers3, Volume2, VolumeX, X } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, AppState, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';

import { FamilyMemberAvatar } from '@/components/family-member-avatar';
import { OFFLINE_BANNER_CONTENT_CLEARANCE, useOfflineBannerVisible } from '@/components/offline-banner';
import { StoryFrame, StoryUnavailable } from '@/components/looking-back/story-frame';
import { StoryProgress } from '@/components/looking-back/story-progress';
import { LookingBackCoverArtwork } from '@/components/looking-back/cover-artwork';
import { fonts, getEmotionColors } from '@/constants/theme';
import { useFamily } from '@/hooks/use-family';
import { useContentSafety } from '@/hooks/useContentSafety';
import { useLookingBackPackages, type LookingBackPackageWithMemories } from '@/hooks/useLookingBackPackages';
import { useLookingBackPlayback } from '@/hooks/useLookingBackPlayback';
import { useLookingBackSession, type LookingBackCheckpoint, type LookingBackSourceGeometry } from '@/hooks/useLookingBackSession';
import { useMediaUrls } from '@/hooks/useMediaUrls';
import { memoryDetailRoute, timelineRoute } from '@/lib/routes';
import { trackEvent } from '@/services/analytics';
import type { LookingBackPackageType } from '@/services/looking-back';
import { buildLookingBackChapters, flattenLookingBackFrames } from '@/utils/looking-back-frames';
import { formatDisplayDate } from '@/utils/memories';
import { formatAgeCompactFromDob } from '@/utils/family-members';
import { mediaImageSource } from '@/utils/media-image-source';

const MAT = '#1B1610';

function packageTypeProperties(item: { packageType: LookingBackPackageType; memories: unknown[] }) {
  return { package_type: item.packageType, memory_count: item.memories.length } as const;
}

function EmotionGlow({ color }: { color: string }) {
  const reduceMotion = useReducedMotion();
  const glowColor = useSharedValue(color);
  useEffect(() => {
    glowColor.value = withTiming(color, { duration: reduceMotion ? 0 : 380 });
  }, [color, glowColor, reduceMotion]);
  const animatedStyle = useAnimatedStyle(() => ({ backgroundColor: glowColor.value }));
  return <Animated.View pointerEvents="none" style={[styles.glow, animatedStyle]} testID="looking-back-emotion-glow" />;
}

function ViewerEntryMotion({ sourceGeometry, isClosing, onClosed, cover, children }: { sourceGeometry: LookingBackSourceGeometry | null; isClosing: boolean; onClosed: () => void; cover?: React.ReactNode; children: React.ReactNode }) {
  const reduceMotion = useReducedMotion();
  const { width, height } = useWindowDimensions();
  const [resolvedGeometry, setResolvedGeometry] = useState<LookingBackSourceGeometry | null | undefined>(undefined);
  const reveal = useSharedValue(0);
  useEffect(() => {
    // Read freshness after render, so a delayed/recycled card and a rotated
    // viewport deliberately resolve to the fade path without a stray timer.
    const isFresh = Boolean(
      sourceGeometry && (isClosing || Date.now() - sourceGeometry.capturedAtMs < 1200)
      && Math.abs(sourceGeometry.windowWidth - width) < 2
      && Math.abs(sourceGeometry.windowHeight - height) < 2,
    );
    // This is an external layout freshness synchronization; it deliberately
    // resets the remembered origin when the viewport/source changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setResolvedGeometry(isFresh ? sourceGeometry : null);
  }, [height, isClosing, sourceGeometry, width]);
  useEffect(() => {
    if (resolvedGeometry === undefined) return;
    reveal.value = withTiming(isClosing ? 0 : 1, { duration: reduceMotion ? 0 : 380 }, (finished) => {
      if (finished && isClosing) runOnJS(onClosed)();
    });
  }, [isClosing, onClosed, reduceMotion, resolvedGeometry, reveal]);
  const contentStyle = useAnimatedStyle(() => ({ opacity: reveal.value }));
  const overlayStyle = useAnimatedStyle(() => {
    // On a package/access/daily-set loss the originating rail card no longer
    // exists. Hide the frozen cover in this same render rather than waiting
    // for the effect that clears its remembered geometry.
    if (!sourceGeometry || !resolvedGeometry || reduceMotion) return { opacity: 0 };
    const inverse = 1 - reveal.value;
    return {
      borderRadius: 20 * inverse,
      height: resolvedGeometry.height + ((height - resolvedGeometry.height) * reveal.value),
      left: resolvedGeometry.x * inverse,
      opacity: inverse,
      top: resolvedGeometry.y * inverse,
      width: resolvedGeometry.width + ((width - resolvedGeometry.width) * reveal.value),
    };
  });
  return <View style={styles.entryMotion}><Animated.View style={[styles.entryMotion, contentStyle]}>{children}</Animated.View>{cover ? <Animated.View pointerEvents="none" style={[styles.coverTransition, overlayStyle]}>{cover}</Animated.View> : null}</View>;
}

export default function LookingBackViewerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { familyId } = useFamily();
  const {
    isTargetReported,
    isUserBlocked,
    isLoading: isContentSafetyLoading,
    isError: isContentSafetyError,
  } = useContentSafety();
  const { viewerPackages, packages, dailySetId, isSuccess: isLookingBackLoaded, markPackageViewed, markPackageCompleted } = useLookingBackPackages();
  const { checkpoint, packageSnapshot, saveCheckpoint, savePackageSnapshot, reconcilePackageMemories, clearCheckpoint } = useLookingBackSession();
  const liveViewerItem = useMemo(() => viewerPackages.find((candidate) => candidate.id === id) ?? null, [id, viewerPackages]);
  const snapshotItem = packageSnapshot?.packageId === id && packageSnapshot.familyId === familyId ? packageSnapshot.value : null;
  const hasForeignSnapshot = Boolean(packageSnapshot?.packageId === id && packageSnapshot.familyId !== familyId);
  const sourceGeometry = packageSnapshot?.packageId === id && packageSnapshot.familyId === familyId
    ? packageSnapshot.sourceGeometry
    : null;
  const isSourceCardAvailableForClose = Boolean(
    packageSnapshot
    && dailySetId === packageSnapshot.dailySetId
    && packages.some((candidate) => candidate.id === id && candidate.dailySetId === packageSnapshot.dailySetId),
  );
  const rawItem = snapshotItem ?? liveViewerItem;
  // A package is frozen at tap for daily-set consistency, not for bypassing
  // later content-safety actions. Re-derive the only metadata that can carry
  // a reported person's name on every render.
  const item = useMemo(() => {
    if (!rawItem) return null;
    const safeMemories = rawItem.memories
      .filter((memory) => !isTargetReported('memory', memory.id) && !isUserBlocked(memory.user_id))
      .map((memory) => ({
      ...memory,
      // A frozen snapshot preserves the package identity, never a reported
      // illustration. Keep the written memory and let the frame builder use
      // its text fallback, matching useLookingBackPackages exactly.
      isIllustrationHidden: isTargetReported(
        'memory_illustration',
        memory.id,
        memory.illustration_generation_id,
      ),
      }));
    const subject = rawItem.subjectFamilyMemberId
      ? safeMemories.flatMap((memory) => memory.taggedMembers).find((member) => member.id === rawItem.subjectFamilyMemberId)
      : null;
    const subjectHidden = Boolean(rawItem.subjectFamilyMemberId && (
      isTargetReported('family_member_profile', rawItem.subjectFamilyMemberId)
      || isTargetReported('family_member_portrait', subject?.resolvedPortraitVersion?.id)
    ));
    const sanitizedItem = { ...rawItem, memories: safeMemories };
    return subjectHidden && rawItem.packageType === 'member_at_age'
      ? { ...sanitizedItem, title: 'A family memory' }
      : sanitizedItem;
  }, [isTargetReported, isUserBlocked, rawItem]);
  const chapters = useMemo(() => buildLookingBackChapters(item?.memories ?? []), [item?.memories]);
  const uncorrectedFrames = useMemo(() => flattenLookingBackFrames(chapters), [chapters]);
  const [videoDurations, setVideoDurations] = useState<Record<string, number>>({});
  const frames = useMemo(() => uncorrectedFrames.map((frame) => videoDurations[frame.id] ? { ...frame, durationMs: Math.min(9000, Math.max(3500, videoDurations[frame.id])) } : frame), [uncorrectedFrames, videoDurations]);
  const validCheckpoint = checkpoint?.packageId === id && checkpoint.familyId === familyId ? checkpoint : null;
  const [screenReaderEnabled, setScreenReaderEnabled] = useState(false);
  const [unavailableFrameId, setUnavailableFrameId] = useState<string | null>(null);
  const [readyFrameId, setReadyFrameId] = useState<string | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didRecognizeHoldRef = useRef(false);
  const [stageWidth, setStageWidth] = useState(0);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const wasMarkedViewedRef = useRef(false);
  const wasCompletedRef = useRef(false);
  const insets = useSafeAreaInsets();
  const isOfflineBannerVisible = useOfflineBannerVisible();
  const navigation = useNavigation();
  const isClosingRef = useRef(false);
  const [isClosingTransition, setIsClosingTransition] = useState(false);
  const transitionSourceGeometry = isClosingTransition && !isSourceCardAvailableForClose ? null : sourceGeometry;
  const {
    state,
    currentFrame,
    dispatch,
    pause,
    resume,
    next,
    previous,
    replay,
    toggleMuted,
    checkpointFor,
    progress,
  } = useLookingBackPlayback({ frames, checkpoint: validCheckpoint, isScreenReaderEnabled: screenReaderEnabled });
  const prefetchFrames = useMemo(() => [frames[state.frameIndex], frames[state.frameIndex + 1]].filter((frame): frame is NonNullable<typeof frame> => Boolean(frame)), [frames, state.frameIndex]);
  const prefetchKeys = useMemo(() => prefetchFrames.flatMap((frame) => {
    const primaryKey = frame.kind === 'illustration' ? frame.memory.illustration_key : frame.asset?.object_key;
    const previewKey = frame.kind === 'photo' || frame.kind === 'video' ? frame.asset?.preview_object_key : null;
    return [...new Set([primaryKey, previewKey].filter((key): key is string => Boolean(key)))];
  }), [prefetchFrames]);
  const { data: prefetchUrls } = useMediaUrls(prefetchKeys, currentFrame?.memory.updated_at);
  useEffect(() => {
    for (const frame of prefetchFrames) {
      const primaryKey = frame.kind === 'illustration' ? frame.memory.illustration_key : frame.asset?.object_key;
      const previewKey = frame.kind === 'photo' || frame.kind === 'video' ? frame.asset?.preview_object_key : null;
      // Do not prefetch raw video through expo-image. Its stored first-frame
      // JPEG poster is safe to warm and avoids an empty VideoView while the
      // active player prepares the real source.
      const imageKeys = frame.kind === 'video' ? [previewKey] : [primaryKey, previewKey];
      for (const key of [...new Set(imageKeys.filter((candidate): candidate is string => Boolean(candidate)))]) {
        const url = prefetchUrls?.[key];
        // Keep prefetch in the same stable cache slot StoryFrame uses. A
        // signed URL alone becomes a different slot after the next R2 re-sign.
        if (url) void Image.loadAsync(mediaImageSource(url, key)).catch(() => {});
      }
    }
  }, [prefetchFrames, prefetchUrls]);
  const checkpointIdentityRef = useRef<Pick<LookingBackCheckpoint, 'familyId' | 'dailySetId' | 'packageId'> | null>(null);

  useEffect(() => {
    if (liveViewerItem && !packageSnapshot) savePackageSnapshot(liveViewerItem);
  }, [liveViewerItem, packageSnapshot, savePackageSnapshot]);
  useEffect(() => {
    if (packageSnapshot?.packageId !== id || !liveViewerItem) return;
    reconcilePackageMemories(id, liveViewerItem.memories.map((memory) => memory.id));
  }, [id, liveViewerItem, packageSnapshot?.packageId, reconcilePackageMemories]);
  useEffect(() => {
    if (!item || !familyId) return;
    checkpointIdentityRef.current = { familyId, dailySetId: item.dailySetId ?? dailySetId ?? '', packageId: item.id };
  }, [dailySetId, familyId, item]);

  useEffect(() => {
    void AccessibilityInfo.isScreenReaderEnabled().then(setScreenReaderEnabled);
    const subscription = AccessibilityInfo.addEventListener('screenReaderChanged', setScreenReaderEnabled);
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    const isMediaFrame = currentFrame?.kind === 'illustration' || currentFrame?.kind === 'photo' || currentFrame?.kind === 'video';
    const isCurrentFrameReady = readyFrameId === currentFrame?.id || unavailableFrameId === currentFrame?.id;
    if (isMediaFrame && !isCurrentFrameReady) pause('buffering');
    else resume('buffering');
  }, [currentFrame?.id, currentFrame?.kind, pause, readyFrameId, resume, unavailableFrameId]);
  const previousFrameIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (previousFrameIdRef.current && previousFrameIdRef.current !== currentFrame?.id) {
      setReadyFrameId(null);
      setUnavailableFrameId(null);
    }
    previousFrameIdRef.current = currentFrame?.id ?? null;
  }, [currentFrame?.id]);

  const saveLiveCheckpoint = useCallback(() => {
    if (checkpointIdentityRef.current) saveCheckpoint(checkpointFor(checkpointIdentityRef.current));
  }, [checkpointFor, saveCheckpoint]);

  useFocusEffect(useCallback(() => {
    // A deep link starts with no rail snapshot. Wait for the package query to
    // settle before declaring it missing, while always dropping a snapshot
    // that belongs to another family immediately.
    if (hasForeignSnapshot || (item && item.familyId !== familyId) || (!item && isLookingBackLoaded && !isContentSafetyLoading && !isContentSafetyError)) {
      clearCheckpoint(id);
      router.replace(timelineRoute);
      return undefined;
    }
    if (!item) return undefined;
    resume('detail');
    return () => {
      // Pause updates the JS clock synchronously; checkpoint only after that
      // so an unmounted/remounted viewer cannot keep advancing under detail.
      pause('detail');
      saveLiveCheckpoint();
    };
  }, [clearCheckpoint, familyId, hasForeignSnapshot, id, isContentSafetyError, isContentSafetyLoading, isLookingBackLoaded, item, pause, resume, saveLiveCheckpoint]));

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') resume('background');
      else {
        pause('background');
        saveLiveCheckpoint();
      }
    });
    return () => subscription.remove();
  }, [pause, resume, saveLiveCheckpoint]);

  useEffect(() => {
    const isTextFrame = currentFrame?.kind === 'text-short' || currentFrame?.kind === 'text-long';
    if (!item || state.phase !== 'playing' || !currentFrame || wasMarkedViewedRef.current || (!isTextFrame && readyFrameId !== currentFrame.id)) return;
    wasMarkedViewedRef.current = true;
    void markPackageViewed(item.id);
  }, [currentFrame, item, markPackageViewed, readyFrameId, state.phase]);
  useEffect(() => {
    if (!item || state.phase !== 'complete' || wasCompletedRef.current) return;
    wasCompletedRef.current = true;
    void markPackageCompleted(item.id);
    trackEvent('looking_back_package_completed', { ...packageTypeProperties(item), frame_count: frames.length });
  }, [frames.length, item, markPackageCompleted, state.phase]);

  const finishClose = useCallback(() => {
    if (isClosingRef.current) return;
    isClosingRef.current = true;
    clearCheckpoint(id);
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace(timelineRoute);
    }
  }, [clearCheckpoint, id]);
  const close = useCallback(() => {
    // These branches intentionally bypass ViewerEntryMotion so they have no
    // animation completion callback to finish navigation. Close directly.
    if (!item || isContentSafetyLoading || isContentSafetyError) {
      finishClose();
      return;
    }
    if (isClosingTransition) return;
    setIsClosingTransition(true);
  }, [finishClose, isClosingTransition, isContentSafetyError, isContentSafetyLoading, item]);
  useEffect(() => {
    // Only a successful refresh of the SAME immutable daily set is proof
    // that this package was cascaded/deleted. Offline/optional failures and
    // a midnight set boundary must never discard a frozen open viewer.
    if (!packageSnapshot || !isLookingBackLoaded || dailySetId !== packageSnapshot.dailySetId || liveViewerItem) return undefined;
    const timer = setTimeout(close, 0);
    return () => clearTimeout(timer);
  }, [close, dailySetId, isLookingBackLoaded, liveViewerItem, packageSnapshot]);
  useEffect(() => navigation.addListener('beforeRemove', (event) => {
    // Detail navigation blurs this route but does not remove it. Native
    // hardware Back/swipe-pop uses the same reverse/fallback close path.
    if (isClosingRef.current) return;
    event.preventDefault();
    close();
  }), [close, navigation]);
  useEffect(() => {
    if (!item || !familyId || frames.length > 0) return undefined;
    const timer = setTimeout(close, 0);
    return () => clearTimeout(timer);
  }, [close, familyId, frames.length, item]);
  const openDetail = useCallback(() => {
    if (!item || !currentFrame) return;
    pause('detail');
    saveLiveCheckpoint();
    const memoryType = currentFrame.memory.memory_type;
    if (memoryType !== 'text_only' && memoryType !== 'text_illustration' && memoryType !== 'media') return;
    trackEvent('looking_back_memory_opened', { package_type: item.packageType, memory_type: memoryType });
    router.push(memoryDetailRoute(currentFrame.memory.id, currentFrame.assetIndex));
  }, [currentFrame, item, pause, saveLiveCheckpoint]);
  const onPressIn = useCallback(() => {
    didRecognizeHoldRef.current = false;
    holdTimer.current = setTimeout(() => { didRecognizeHoldRef.current = true; pause('manual'); }, 220);
  }, [pause]);
  const onPressOut = useCallback(() => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
    // The gesture retains the handler from press-in. Reading rendered pause
    // state here can therefore miss a hold recognized 220 ms later and leave
    // playback permanently paused. Resume is idempotent, so always release
    // this gesture's pause ownership.
    resume('manual');
  }, [resume]);
  const movePrevious = useCallback(() => {
    // expo-haptics honors the system haptics setting; only deliberate
    // navigation gets feedback, never automatic playback.
    void Haptics.selectionAsync().catch(() => {});
    previous();
  }, [previous]);
  const moveNext = useCallback(() => {
    void Haptics.selectionAsync().catch(() => {});
    next();
  }, [next]);
  const tapZone = useCallback((event: { nativeEvent: { locationX: number } }) => {
    if (didRecognizeHoldRef.current) { didRecognizeHoldRef.current = false; return; }
    if (event.nativeEvent.locationX < stageWidth / 3) movePrevious(); else moveNext();
  }, [moveNext, movePrevious, stageWidth]);
  const handleBuffering = useCallback((buffering: boolean) => {
    if (buffering) pause('buffering'); else resume('buffering');
  }, [pause, resume]);
  const handleFrameReady = useCallback(() => { setReadyFrameId(currentFrame?.id ?? null); resume('buffering'); }, [currentFrame?.id, resume]);
  const handleVideoDuration = useCallback((durationMs: number) => {
    if (!currentFrame || !Number.isFinite(durationMs)) return;
    setVideoDurations((current) => current[currentFrame.id] === durationMs ? current : { ...current, [currentFrame.id]: durationMs });
  }, [currentFrame]);
  const handleFrameUnavailable = useCallback(() => {
    setUnavailableFrameId(currentFrame?.id ?? null);
    setReadyFrameId(currentFrame?.id ?? null);
    resume('buffering');
  }, [currentFrame?.id, resume]);

  if (!item && !isLookingBackLoaded) return <View style={styles.empty} testID="looking-back-loading"><StatusBar style="light" /><FallbackClose onClose={close} /><ActivityIndicator color="#F6F1E7" /><Text style={styles.emptyText}>Loading your memories…</Text></View>;
  // Safety queries are fail-closed. A stale frozen snapshot must never flash
  // a newly reported memory or blocked author while its report set refreshes.
  if (isContentSafetyLoading || isContentSafetyError) return <View style={styles.empty} testID="looking-back-safety-pending"><StatusBar style="light" /><FallbackClose onClose={close} /><ActivityIndicator color="#F6F1E7" /><Text style={styles.emptyText}>{isContentSafetyError ? 'This package is unavailable.' : 'Loading your memories…'}</Text>{isContentSafetyError ? <Pressable onPress={close}><Text style={styles.emptyButton}>Back to your timeline</Text></Pressable> : null}</View>;
  if (!item || !familyId) return <View style={styles.empty}><StatusBar style="light" /><Text style={styles.emptyText}>This package is no longer available.</Text><Pressable onPress={close}><Text style={styles.emptyButton}>Back to your timeline</Text></Pressable></View>;
  const transitionCover = <LookingBackCoverArtwork memories={item.memories} testID="looking-back-transition-cover" tint={item.tint} />;
  if (frames.length === 0) return <ViewerEntryMotion cover={transitionCover} isClosing={isClosingTransition} onClosed={finishClose} sourceGeometry={transitionSourceGeometry}><View style={styles.empty} testID="looking-back-empty-closing"><Text style={styles.emptyText}>This package is no longer available.</Text></View></ViewerEntryMotion>;

  const emotion = getEmotionColors(currentFrame?.memory.emotion ?? item.tint);
  const isIntro = state.phase === 'intro';
  const isComplete = state.phase === 'complete';
  const isUnavailable = unavailableFrameId === currentFrame?.id;
  return <ViewerEntryMotion cover={transitionCover} isClosing={isClosingTransition} onClosed={finishClose} sourceGeometry={transitionSourceGeometry}><View style={[styles.screen, { paddingBottom: insets.bottom }, emotion ? { backgroundColor: MAT } : null]} testID="looking-back-viewer">
    <StatusBar style="light" />
    <EmotionGlow color={emotion?.c ?? '#5B4A3A'} />
    <SafeAreaView edges={['top']} style={[styles.safeTop, isOfflineBannerVisible && styles.safeTopWithBanner]}>
      <View style={styles.topChrome} testID="looking-back-top-chrome">
        <StoryProgress chapters={chapters} frame={currentFrame} frameFraction={state.frameFraction} progress={progress} />
        <View style={styles.topBar}>
        <View style={styles.topContext}><Text style={styles.topKind}>{item.displayKind}</Text><Text numberOfLines={1} style={styles.topTitle}>{item.title}</Text></View>
        {currentFrame?.kind === 'video' ? <Pressable accessibilityLabel={state.isMuted ? 'Unmute video' : 'Mute video'} accessibilityRole="button" onPress={toggleMuted} style={styles.roundButton} testID="looking-back-video-mute">{state.isMuted ? <VolumeX color="#F6F1E7" size={18} /> : <Volume2 color="#F6F1E7" size={18} />}</Pressable> : null}
        <Pressable accessibilityLabel="Close looking back" accessibilityRole="button" hitSlop={10} onPress={close} style={styles.roundButton} testID="looking-back-close"><X color="#F6F1E7" size={18} /></Pressable>
        </View>
      </View>
    </SafeAreaView>
    {isIntro ? <Intro item={item} onStart={() => dispatch({ type: 'INTRO_COMPLETE' })} /> : isComplete ? <Completion item={item} onClose={close} onReplay={() => { replay(); void markPackageViewed(item.id); trackEvent('looking_back_package_replayed', packageTypeProperties(item)); }} /> : <>
      <Pressable accessibilityActions={[{ name: 'increment', label: 'Next memory' }, { name: 'decrement', label: 'Previous memory' }]} accessibilityLabel="Story navigation" accessibilityRole="adjustable" onAccessibilityAction={(event) => { if (event.nativeEvent.actionName === 'increment') moveNext(); if (event.nativeEvent.actionName === 'decrement') movePrevious(); }} onLayout={(event) => { const { width: layoutWidth, height: layoutHeight } = event.nativeEvent.layout; setStageWidth(layoutWidth); setStageSize({ width: Math.max(0, layoutWidth - 36), height: Math.max(0, layoutHeight - 8) }); }} onPress={tapZone as never} onPressIn={onPressIn} onPressOut={onPressOut} style={styles.stage} testID="looking-back-stage">
        {isUnavailable ? <StoryUnavailable /> : <StoryFrame frame={currentFrame!} isPaused={state.pauseReasons.length > 0} muted={state.isMuted} onBuffering={handleBuffering} onDuration={handleVideoDuration} onReady={handleFrameReady} onUnavailable={handleFrameUnavailable} stageSize={stageSize} />}
      </Pressable>
      <Footer expanded={state.pauseReasons.includes('manual')} frame={currentFrame!} onOpen={openDetail} />
      {screenReaderEnabled ? <View style={styles.accessibleControls}>
        <Pressable accessibilityLabel="Previous memory" accessibilityRole="button" onPress={movePrevious} style={styles.accessibleButton}><ChevronLeft color="#F6F1E7" /></Pressable>
        <Pressable accessibilityLabel={state.isMuted ? 'Unmute video' : 'Mute video'} accessibilityRole="button" onPress={toggleMuted} style={styles.accessibleButton}>{state.isMuted ? <VolumeX color="#F6F1E7" /> : <Volume2 color="#F6F1E7" />}</Pressable>
        <Pressable accessibilityLabel="Next memory" accessibilityRole="button" onPress={moveNext} style={styles.accessibleButton}><ChevronRight color="#F6F1E7" /></Pressable>
      </View> : null}
    </>}
    {state.pauseReasons.includes('manual') ? <View pointerEvents="none" style={styles.pauseVeil} testID="looking-back-pause-veil"><Text style={styles.pausePill}>Paused</Text></View> : null}
  </View></ViewerEntryMotion>;
}

function Intro({ item, onStart }: { item: LookingBackPackageWithMemories; onStart: () => void }) {
  const emotion = getEmotionColors(item.tint);
  const sidePrintColors = [emotion?.soft ?? '#D9CBE4', emotion?.c ?? '#D2A286'];
  return <View style={styles.centerCard} testID="looking-back-intro"><View style={styles.miniStack}>{[-6, 0, 6].map((rotation, index) => <View key={rotation} style={[styles.miniPrint, { transform: [{ rotate: `${rotation}deg` }], zIndex: index === 1 ? 2 : 1 }]} testID={`looking-back-intro-print-${index}`}>{index === 1 ? <LookingBackCoverArtwork memories={item.memories} testID="looking-back-intro-cover" tint={item.tint} /> : <View style={[StyleSheet.absoluteFill, { backgroundColor: sidePrintColors[index === 0 ? 0 : 1] }]} />}</View>)}</View><Text style={styles.introKind}>{item.displayKind}</Text><Text style={styles.introTitle}>{item.title}</Text><Text style={styles.introMeta}>{item.memories.length} memories · {item.era}</Text><Pressable accessibilityLabel="Start memories" accessibilityRole="button" onPress={onStart} style={[styles.completePrimary, styles.introStart]} testID="looking-back-start"><Text style={styles.completePrimaryText}>Start</Text></Pressable></View>;
}

function FallbackClose({ onClose }: { onClose: () => void }) {
  return <SafeAreaView edges={['top']} pointerEvents="box-none" style={styles.fallbackCloseWrap}>
    <Pressable accessibilityLabel="Close looking back" accessibilityRole="button" hitSlop={10} onPress={onClose} style={styles.roundButton} testID="looking-back-fallback-close"><X color="#F6F1E7" size={18} /></Pressable>
  </SafeAreaView>;
}

function Completion({ item, onReplay, onClose }: { item: LookingBackPackageWithMemories; onReplay: () => void; onClose: () => void }) {
  const hasLeadingFrom = /^from\s+/i.test(item.title);
  const rawPackageName = item.title.replace(/^from\s+/i, '');
  // Keep proper names and date titles intact, while sentence-style archive
  // titles read naturally after “from” ("from a year ago", not "from A year ago").
  const packageName = item.packageType === 'member_at_age' || hasLeadingFrom
    ? rawPackageName
    : `${rawPackageName.charAt(0).toLowerCase()}${rawPackageName.slice(1)}`;
  const memoryLabel = item.memories.length === 1 ? 'memory' : 'memories';
  return <View style={styles.centerCard} testID="looking-back-complete"><View style={styles.fan}>{item.memories.slice(0, 4).map((memory, index) => <View key={memory.id} style={[styles.fanCard, { transform: [{ rotate: `${(index - 1.5) * 4}deg` }] }]}><LookingBackCoverArtwork memories={[memory]} testID={`looking-back-completion-cover-${index}`} tint={memory.emotion} /></View>)}</View><Text style={styles.completeTitle}>That was {item.memories.length} {memoryLabel} from {packageName}.</Text><Pressable accessibilityRole="button" onPress={onClose} style={styles.completePrimary} testID="looking-back-back-to-timeline"><ArrowLeft color={MAT} size={16} /><Text style={styles.completePrimaryText}>Back to your timeline</Text></Pressable><Pressable accessibilityRole="button" onPress={onReplay} style={styles.replay} testID="looking-back-replay"><Text style={styles.replayText}>Play it again</Text></Pressable></View>;
}

function Footer({ expanded, frame, onOpen }: { expanded: boolean; frame: NonNullable<ReturnType<typeof useLookingBackPlayback>['currentFrame']>; onOpen: () => void }) {
  const contentSafety = useContentSafety();
  const members = frame.memory.taggedMembers.filter((member) => !contentSafety.isTargetReported('family_member_profile', member.id)
    && !contentSafety.isTargetReported('family_member_portrait', member.resolvedPortraitVersion?.id));
  const member = members[0];
  const singleMemberAge = member?.date_of_birth ? formatAgeCompactFromDob(member.date_of_birth, new Date(`${frame.memory.memory_date}T12:00:00`)) : null;
  return <View style={styles.footer}><View style={styles.dateRow}><Text style={styles.date}>{formatDisplayDate(frame.memory.memory_date)}</Text>{frame.memory.emotion ? <><View style={[styles.emotionDot, { backgroundColor: getEmotionColors(frame.memory.emotion)?.c ?? '#D9CBE4' }]} /><Text style={styles.date}>{frame.memory.emotion}</Text></> : null}</View>{frame.assetCount > 1 ? <View style={styles.chapterMarker}><Layers3 color="rgba(246,241,231,0.62)" size={14} />{Array.from({ length: frame.assetCount }, (_, index) => <View key={index} style={[styles.assetPill, index === frame.assetIndex && styles.assetPillActive]} />)}<Text style={styles.chapterCount}>{frame.assetIndex + 1} of {frame.assetCount}</Text></View> : null}{frame.memory.content && frame.kind !== 'text-short' && frame.kind !== 'text-long' ? <Text numberOfLines={expanded ? undefined : 3} style={styles.caption}>{frame.memory.content}</Text> : null}<View style={styles.footerBottom}>{members.length > 0 ? <View style={styles.member}>{members.map((taggedMember, index) => <FamilyMemberAvatar key={taggedMember.id} member={taggedMember} size={24} style={index ? styles.overlapAvatar : undefined} />)}{members.length === 1 ? <Text style={styles.memberName}>{member?.name}{singleMemberAge ? `, ${singleMemberAge}` : ''}</Text> : null}</View> : <View /> }<Pressable accessibilityLabel="Open memory" accessibilityRole="button" hitSlop={4} onPress={onOpen} style={styles.openMemory} testID="looking-back-open-memory"><Text style={styles.openMemoryText}>Open memory</Text><ArrowRight color="rgba(246,241,231,0.92)" size={14} /></Pressable></View></View>;
}

const styles = StyleSheet.create({
  entryMotion: { flex: 1 }, coverTransition: { overflow: 'hidden', position: 'absolute' }, screen: { backgroundColor: MAT, flex: 1, overflow: 'hidden' },
  glow: { borderRadius: 999, height: 420, left: -80, opacity: 0.28, position: 'absolute', right: -80, top: -190 },
  safeTop: { zIndex: 2 }, safeTopWithBanner: { paddingTop: OFFLINE_BANNER_CONTENT_CLEARANCE }, topChrome: { gap: 9, paddingHorizontal: 18 }, topBar: { alignItems: 'center', flexDirection: 'row', gap: 10 }, topContext: { flex: 1 }, topKind: { color: 'rgba(246,241,231,0.55)', fontFamily: fonts.sansBold, fontSize: 9, letterSpacing: 1.1, textTransform: 'uppercase' }, topTitle: { color: '#F6F1E7', fontFamily: fonts.displayMedium, fontSize: 15, marginTop: 2 },
  roundButton: { alignItems: 'center', backgroundColor: 'rgba(246,241,231,0.14)', borderColor: 'rgba(246,241,231,0.16)', borderRadius: 22, borderWidth: 1, height: 44, justifyContent: 'center', width: 44 },
  stage: { flex: 1, justifyContent: 'center', paddingHorizontal: 18, paddingTop: 8 },
  footer: { paddingBottom: 10, paddingHorizontal: 22 }, dateRow: { alignItems: 'center', flexDirection: 'row', gap: 7 }, date: { color: 'rgba(246,241,231,0.58)', fontFamily: fonts.sansBold, fontSize: 11.5, letterSpacing: 0.45 }, emotionDot: { borderRadius: 3, height: 6, width: 6 }, chapterMarker: { alignItems: 'center', flexDirection: 'row', gap: 5, marginTop: 9 }, assetPill: { backgroundColor: 'rgba(246,241,231,0.28)', borderRadius: 3, height: 5, width: 10 }, assetPillActive: { backgroundColor: '#F6F1E7', width: 18 }, chapterCount: { color: 'rgba(246,241,231,0.55)', fontFamily: fonts.sansBold, fontSize: 10, marginLeft: 3 }, caption: { color: 'rgba(246,241,231,0.95)', fontFamily: fonts.display, fontSize: 19.5, lineHeight: 28, marginTop: 9 }, footerBottom: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginTop: 15 }, member: { alignItems: 'center', flexDirection: 'row', gap: 8 }, memberName: { color: 'rgba(246,241,231,0.60)', fontFamily: fonts.sansBold, fontSize: 11.5 }, openMemory: { alignItems: 'center', borderColor: 'rgba(246,241,231,0.28)', borderRadius: 999, borderWidth: 1, flexDirection: 'row', gap: 5, minHeight: 44, paddingHorizontal: 13, justifyContent: 'center' }, openMemoryText: { color: 'rgba(246,241,231,0.92)', fontFamily: fonts.sansBold, fontSize: 12 },
  overlapAvatar: { marginLeft: -16 },
  accessibleControls: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 22 }, accessibleButton: { alignItems: 'center', height: 44, justifyContent: 'center', width: 44 },
  pauseVeil: { ...StyleSheet.absoluteFill, alignItems: 'center', backgroundColor: 'rgba(18,13,8,0.34)', justifyContent: 'flex-start', paddingTop: 116 }, pausePill: { backgroundColor: 'rgba(246,241,231,0.18)', borderRadius: 999, color: '#F6F1E7', fontFamily: fonts.sansBold, paddingHorizontal: 15, paddingVertical: 8 },
  fallbackCloseWrap: { alignItems: 'flex-end', left: 0, paddingHorizontal: 18, position: 'absolute', right: 0, top: 0 },
  centerCard: { alignItems: 'center', flex: 1, justifyContent: 'center', paddingHorizontal: 34 }, miniStack: { height: 74, marginBottom: 22, width: 104 }, miniPrint: { backgroundColor: '#F6F1E7', borderRadius: 10, height: 62, left: 23, position: 'absolute', top: 6, width: 62 }, miniPrintTop: { backgroundColor: '#D9CBE4', transform: [{ rotate: '5deg' }] }, introKind: { color: 'rgba(246,241,231,0.5)', fontFamily: fonts.sansBold, fontSize: 10.5, letterSpacing: 1.5, textTransform: 'uppercase' }, introTitle: { color: '#F6F1E7', fontFamily: fonts.display, fontSize: 36, letterSpacing: -0.7, lineHeight: 40, marginTop: 12, textAlign: 'center' }, introMeta: { color: 'rgba(246,241,231,0.55)', fontFamily: fonts.sansBold, fontSize: 13, marginTop: 13 }, introStart: { marginTop: 28, minWidth: 112, justifyContent: 'center' },
  fan: { flexDirection: 'row', height: 66, justifyContent: 'center', marginBottom: 20 }, fanCard: { backgroundColor: '#F6F1E7', borderRadius: 9, height: 52, marginLeft: -12, width: 52 }, completeTitle: { color: '#F6F1E7', fontFamily: fonts.display, fontSize: 28, lineHeight: 33, textAlign: 'center' }, completePrimary: { alignItems: 'center', backgroundColor: '#F6F1E7', borderRadius: 999, flexDirection: 'row', gap: 7, marginTop: 27, minHeight: 46, paddingHorizontal: 19 }, completePrimaryText: { color: MAT, fontFamily: fonts.sansBold, fontSize: 13 }, replay: { minHeight: 44, justifyContent: 'center', marginTop: 7, paddingHorizontal: 18 }, replayText: { color: 'rgba(246,241,231,0.8)', fontFamily: fonts.sansBold, fontSize: 13 },
  empty: { alignItems: 'center', backgroundColor: MAT, flex: 1, justifyContent: 'center', padding: 24 }, emptyText: { color: '#F6F1E7', fontFamily: fonts.display, fontSize: 24, textAlign: 'center' }, emptyButton: { color: '#F6F1E7', fontFamily: fonts.sansBold, marginTop: 20 },
});
