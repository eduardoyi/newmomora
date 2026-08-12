import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { VideoView, type VideoPlayer, type SourceLoadEventPayload, type SourceChangeEventPayload } from 'expo-video';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';
import Animated, {
  cancelAnimation,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { colors, fonts, getEmotionColors } from '@/constants/theme';
import { useMediaUrls } from '@/hooks/useMediaUrls';
import { useVideoThumbnailResult } from '@/hooks/useVideoThumbnail';
import { frameMediaKeys, type LookingBackFrame } from '@/utils/looking-back-frames';
import { mediaImageSource } from '@/utils/media-image-source';
import { preloadLookingBackImage } from '@/utils/looking-back-image-preload';

function configureVideoPlayer(player: VideoPlayer, muted: boolean, isPaused: boolean) {
  player.muted = muted;
  player.loop = false;
  if (isPaused) player.pause(); else player.play();
}

function StoryVideo({ frameId, player, url, videoKey, posterUrl, posterKey, muted, isPaused, onBuffering, onReady, onUnavailable, onDuration, onAttach, onDetach }: { frameId: string; player: VideoPlayer | null; url: string; videoKey: string; posterUrl?: string; posterKey?: string | null; muted: boolean; isPaused: boolean; onBuffering: (isBuffering: boolean) => void; onReady: () => void; onUnavailable: () => void; onDuration: (durationMs: number) => void; onAttach?: (frameId: string, player: VideoPlayer) => number | null; onDetach?: (frameId: string, player: VideoPlayer, token: number) => void }) {
  const runtimeThumbnail = useVideoThumbnailResult(posterUrl ? null : url, videoKey);
  const placeholderUrl = posterUrl ?? runtimeThumbnail?.uri;
  const placeholderSource = useMemo(
    () => placeholderUrl
      ? posterUrl && posterKey
        ? mediaImageSource(posterUrl, posterKey)
        : { uri: placeholderUrl }
      : null,
    [placeholderUrl, posterKey, posterUrl],
  );
  const [renderedFrame, setRenderedFrame] = useState<{ player: VideoPlayer; url: string } | null>(null);
  const [attachedPlayer, setAttachedPlayer] = useState<VideoPlayer | null>(null);
  const readyVisualFallbackRef = useRef(true);
  const readyNotificationRef = useRef<{ player: VideoPlayer; url: string } | null>(null);
  const renderedFrameRef = useRef<{ player: VideoPlayer; url: string } | null>(null);
  const sourceIdentityRef = useRef<{ player: VideoPlayer | null; url: string } | null>(null);
  const callbacksRef = useRef({ onBuffering, onReady, onUnavailable, onDuration, url });
  useEffect(() => {
    callbacksRef.current = { onBuffering, onReady, onUnavailable, onDuration, url };
  }, [onBuffering, onDuration, onReady, onUnavailable, url]);

  const notifyReady = useCallback((readyPlayer: VideoPlayer, readyUrl: string) => {
    if (readyNotificationRef.current?.player === readyPlayer && readyNotificationRef.current.url === readyUrl) return;
    readyNotificationRef.current = { player: readyPlayer, url: readyUrl };
    callbacksRef.current.onReady();
  }, []);

  const setRenderedFrameState = useCallback((next: { player: VideoPlayer; url: string } | null) => {
    renderedFrameRef.current = next;
    setRenderedFrame(next);
  }, []);

  useEffect(() => {
    const previousSource = sourceIdentityRef.current;
    if (!previousSource || previousSource.player !== player) {
      readyVisualFallbackRef.current = true;
    } else if (previousSource.url !== url) {
      // A refreshed signed URL on the same native player must wait for the
      // matching source/visible first-frame path; readyToPlay alone may still
      // describe the old native item.
      readyVisualFallbackRef.current = false;
    }
    sourceIdentityRef.current = { player, url };

    if (!player) {
      callbacksRef.current.onBuffering(true);
      return undefined;
    }

    const handleStatus = (status: VideoPlayer['status']) => {
      if (status === 'loading') callbacksRef.current.onBuffering(true);
      if (status === 'error') callbacksRef.current.onUnavailable();
    };
    const sourceLoadSubscription = player.addListener('sourceLoad', (event: SourceLoadEventPayload) => {
      const loadedUrl = sourceUriFromEvent(event.videoSource);
      if (loadedUrl && loadedUrl !== url) return;
      if (Number.isFinite(event.duration) && event.duration > 0) callbacksRef.current.onDuration(event.duration * 1000);
      else if (Number.isFinite(player.duration) && player.duration > 0) callbacksRef.current.onDuration(player.duration * 1000);
    });
    const sourceChangeSubscription = player.addListener('sourceChange', (event: SourceChangeEventPayload) => {
      const changedUrl = sourceUriFromEvent(event.source);
      if (changedUrl && changedUrl !== url) return;
      // iOS can deliver the initial source event after the detached player has
      // already been accepted as a ready visual handoff. That event describes
      // the same source, not a new signed-URL boundary, so do not put the
      // loading cover back over an already-rendered frame.
      if (renderedFrameRef.current?.player === player && renderedFrameRef.current.url === url) return;
      // Keep the poster over an attached player until the newly signed source
      // actually renders its first frame.
      setRenderedFrameState(null);
      callbacksRef.current.onBuffering(true);
    });
    const statusSubscription = player.addListener('statusChange', ({ status }) => handleStatus(status));

    // A URL refresh keeps the existing lease and native surface. Reset only
    // the visual readiness boundary; the manager's source event remains the
    // authority for admitting the refreshed signed URL.
    callbacksRef.current.onBuffering(true);

    return () => {
      sourceLoadSubscription.remove();
      sourceChangeSubscription.remove();
      statusSubscription.remove();
    };
  }, [notifyReady, player, setRenderedFrameState, url]);

  useEffect(() => {
    if (!player) {
      return undefined;
    }

    const leaseToken = onAttach?.(frameId, player) ?? null;
    if (leaseToken === null) {
      callbacksRef.current.onBuffering(true);
      return undefined;
    }

    // The event subscriptions above are live before playback is started. A
    // handed-off player may already be ready, so reconcile its current native
    // state immediately instead of waiting for an event that already fired.
    const canUseReadyVisualFallback = Platform.OS === 'ios'
      && player.status === 'readyToPlay'
      && readyVisualFallbackRef.current;
    callbacksRef.current.onBuffering(!canUseReadyVisualFallback);
    if (canUseReadyVisualFallback) {
      callbacksRef.current.onBuffering(false);
      notifyReady(player, callbacksRef.current.url);
      // The player may have reached readyToPlay before this visible lease was
      // mounted. Do not wait for a first-frame event that already happened on
      // the detached preload surface.
      setRenderedFrameState({ player, url: callbacksRef.current.url });
      readyVisualFallbackRef.current = false;
    }
    if (player.status === 'error') callbacksRef.current.onUnavailable();
    if (Number.isFinite(player.duration) && player.duration > 0) callbacksRef.current.onDuration(player.duration * 1000);

    // This state change is the native-surface admission boundary: the manager
    // has granted the lease, so only the next render may mount VideoView.
    setAttachedPlayer(player);

    return () => {
      onDetach?.(frameId, player, leaseToken);
      // Do not clear a newer player's attachment if React is cleaning up an
      // older lease during a frame transition.
      setAttachedPlayer((current) => current === player ? null : current);
    };
  }, [frameId, notifyReady, onAttach, onDetach, player, setRenderedFrameState]);

  useEffect(() => {
    if (attachedPlayer) configureVideoPlayer(attachedPlayer, muted, isPaused);
  }, [attachedPlayer, isPaused, muted]);
  const handleFirstFrame = useCallback(() => {
    if (player) {
      readyVisualFallbackRef.current = false;
      callbacksRef.current.onBuffering(false);
      notifyReady(player, url);
      setRenderedFrameState({ player, url });
    }
  }, [notifyReady, player, setRenderedFrameState, url]);
  const sourceUri = attachedPlayer === player && player ? <VideoView contentFit="contain" nativeControls={false} onFirstFrameRender={handleFirstFrame} player={player} style={styles.media} testID="looking-back-video" /> : null;
  const isVideoReady = Boolean(attachedPlayer === player && player && renderedFrame?.player === player && renderedFrame.url === url);
  return <View style={styles.media}>
    {sourceUri}
    {!isVideoReady && placeholderSource ? <Image
      contentFit="contain"
      pointerEvents="none"
      source={placeholderSource}
      style={StyleSheet.absoluteFill}
      testID="looking-back-video-placeholder"
      transition={0}
    /> : null}
    {!isVideoReady ? <View pointerEvents="none" style={styles.videoLoading} testID="looking-back-video-loading">
      <View style={styles.videoLoadingBadge}><Text style={styles.videoLoadingPlay}>▶</Text><Text style={styles.videoLoadingText}>Video · Loading</Text></View>
      <ActivityIndicator color="#F6F1E7" />
    </View> : null}
  </View>;
}

function sourceUriFromEvent(source: SourceLoadEventPayload['videoSource'] | SourceChangeEventPayload['source']): string | null {
  if (typeof source === 'string') return source;
  if (source && typeof source === 'object' && 'uri' in source && typeof source.uri === 'string') return source.uri;
  return null;
}

const noopDuration = () => {};

function LoadingPlate() {
  const reduceMotion = useReducedMotion();
  const pulse = useSharedValue(0.42);
  useEffect(() => {
    if (reduceMotion) {
      pulse.value = 0.72;
      return undefined;
    }
    // Two 800 ms legs make one soft 1.6 s pulse cycle.
    pulse.value = withRepeat(withTiming(0.92, { duration: 800 }), -1, true);
    return () => cancelAnimation(pulse);
  }, [pulse, reduceMotion]);
  const animatedStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));
  return <View style={styles.loading} testID="looking-back-media-loading">
    <Animated.View style={animatedStyle}>
      <ActivityIndicator color="rgba(246,241,231,0.8)" />
    </Animated.View>
    <Text style={styles.loadingCopy}>Loading this photo…</Text>
  </View>;
}

const IMAGE_RETRY_BACKOFF_MS = [300, 800] as const;

function MissingMediaRetry({ onUnavailable, refetch }: { onUnavailable: () => void; refetch: () => Promise<unknown> }) {
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (attempt >= IMAGE_RETRY_BACKOFF_MS.length) {
      onUnavailable();
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void refetch().finally(() => {
        if (!cancelled) setAttempt((current) => current + 1);
      });
    }, IMAGE_RETRY_BACKOFF_MS[attempt]);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [attempt, onUnavailable, refetch]);
  return <LoadingPlate />;
}

interface StoryImageSource {
  key: string;
  url: string;
}

function ReliableStoryImage({
  sources,
  isIllustration,
  onReady,
  onUnavailable,
  refetch,
}: {
  sources: StoryImageSource[];
  isIllustration: boolean;
  onReady: () => void;
  onUnavailable: () => void;
  refetch: () => Promise<unknown>;
}) {
  const [sourceIndex, setSourceIndex] = useState(0);
  const [retryCycle, setRetryCycle] = useState(0);
  const [isRetrying, setIsRetrying] = useState(false);
  const readySourceRef = useRef<string | null>(null);
  const failedSourceRef = useRef<string | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  const source = sources[Math.min(sourceIndex, Math.max(0, sources.length - 1))];
  const sourceIdentity = source ? `${source.key}:${source.url}:${retryCycle}` : null;
  const sourceKey = source?.key ?? null;
  const sourceUrl = source?.url ?? null;
  const imageSource = useMemo(
    () => sourceUrl ? mediaImageSource(sourceUrl, sourceKey) : null,
    [sourceKey, sourceUrl],
  );
  const imageStyle = useMemo(
    () => isIllustration ? [styles.media, styles.illustrationInner] : styles.media,
    [isIllustration],
  );

  useEffect(() => () => {
    isMountedRef.current = false;
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
  }, []);

  const handleError = useCallback(() => {
    failedSourceRef.current = sourceIdentity;
    if (sourceIndex + 1 < sources.length) {
      setSourceIndex((current) => current + 1);
      return;
    }
    if (retryCycle >= IMAGE_RETRY_BACKOFF_MS.length) {
      onUnavailable();
      return;
    }
    setIsRetrying(true);
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null;
      void refetch().finally(() => {
        if (!isMountedRef.current) return;
        setRetryCycle((current) => current + 1);
        setSourceIndex(0);
        setIsRetrying(false);
      });
    }, IMAGE_RETRY_BACKOFF_MS[retryCycle]);
  }, [onUnavailable, refetch, retryCycle, sourceIdentity, sourceIndex, sources.length]);

  const handleReady = useCallback(() => {
    if (!sourceIdentity || readySourceRef.current === sourceIdentity) return;
    readySourceRef.current = sourceIdentity;
    onReady();
  }, [onReady, sourceIdentity]);

  useEffect(() => {
    if (Platform.OS !== 'ios' || isRetrying || !sourceKey || !sourceUrl || !sourceIdentity) return undefined;

    let cancelled = false;
    const loadingIdentity = sourceIdentity;
    void preloadLookingBackImage(mediaImageSource(sourceUrl, sourceKey))
      .then(() => {
        if (!cancelled && failedSourceRef.current !== loadingIdentity) handleReady();
      })
      .catch(() => {
        // The mounted Image remains the authority for retry/fallback errors.
      });
    return () => {
      cancelled = true;
    };
  }, [handleReady, isRetrying, sourceIdentity, sourceKey, sourceUrl]);

  const handleNativeDisplay = useCallback(() => {
    handleReady();
  }, [handleReady]);
  const handleNativeLoad = useCallback(() => {
    handleReady();
  }, [handleReady]);

  if (isRetrying || !source) return <LoadingPlate />;
  return <Image
    key={`${source.key}:${retryCycle}`}
    contentFit="contain"
    onError={handleError}
    onDisplay={handleNativeDisplay}
    onLoad={handleNativeLoad}
    priority="high"
    source={imageSource!}
    style={imageStyle}
    testID="looking-back-image"
    transition={0}
  />;
}

export function StoryFrame({
  frame,
  muted,
  isPaused,
  videoPlayer,
  onVideoAttach,
  onVideoDetach,
  onReady,
  onUnavailable,
  onBuffering,
  onDuration,
  stageSize,
}: {
  frame: LookingBackFrame;
  muted: boolean;
  isPaused: boolean;
  videoPlayer?: VideoPlayer | null;
  onVideoAttach?: (frameId: string, player: VideoPlayer) => number | null;
  onVideoDetach?: (frameId: string, player: VideoPlayer, token: number) => void;
  onReady: () => void;
  onUnavailable: () => void;
  onBuffering: (isBuffering: boolean) => void;
  onDuration?: (durationMs: number) => void;
  stageSize?: { width: number; height: number };
}) {
  const reduceMotion = useReducedMotion();
  const primaryKey = frame.kind === 'illustration'
    ? frame.memory.illustration_key
    : frame.asset?.object_key;
  const previewKey = frame.kind === 'photo' ? frame.asset?.preview_object_key : null;
  const videoPosterKey = frame.kind === 'video' ? frame.asset?.preview_object_key : null;
  const keys = useMemo(
    () => frameMediaKeys(frame).queryKeys,
    [frame],
  );
  const { data: urls, isLoading, refetch } = useMediaUrls(keys, frame.memory.updated_at);
  const primaryUrl = primaryKey ? urls?.[primaryKey] : undefined;
  const previewUrl = previewKey ? urls?.[previewKey] : undefined;
  const videoPosterUrl = videoPosterKey ? urls?.[videoPosterKey] : undefined;
  const emotion = getEmotionColors(frame.memory.emotion);

  if (frame.kind === 'text-short' || frame.kind === 'text-long') {
    return <Animated.View entering={FadeIn.duration(reduceMotion ? 0 : 300)} exiting={FadeOut.duration(reduceMotion ? 0 : 300)} key={frame.id} style={[styles.textPrint, frame.kind === 'text-long' && styles.longPrint]} testID={`looking-back-frame-${frame.kind}`}>
      <LinearGradient colors={[emotion?.soft ?? '#E9DCE8', '#F6F1E7']} end={{ x: 0.3, y: 1 }} start={{ x: 0.7, y: 0 }} style={StyleSheet.absoluteFill} />
      <Text pointerEvents="none" style={[styles.quote, { color: emotion?.ink ?? colors.ink3 }]}>“</Text>
      <Text accessibilityLabel={frame.memory.content ?? ''} numberOfLines={frame.kind === 'text-long' ? 9 : undefined} style={[styles.text, frame.kind === 'text-long' && styles.longText]}>{frame.memory.content}</Text>
      {frame.kind === 'text-long' ? <LinearGradient colors={['transparent', '#F6F1E7']} pointerEvents="none" style={styles.textFade} /> : null}
    </Animated.View>;
  }

  if (isLoading) return <LoadingPlate />;

  const imageSources = frame.kind === 'photo'
    ? [
      previewKey && previewUrl ? { key: previewKey, url: previewUrl } : null,
      primaryKey && primaryUrl ? { key: primaryKey, url: primaryUrl } : null,
    ].filter((source): source is StoryImageSource => Boolean(source))
    : primaryKey && primaryUrl ? [{ key: primaryKey, url: primaryUrl }] : [];

  if ((frame.kind === 'video' && (!primaryKey || !primaryUrl)) || (frame.kind !== 'video' && imageSources.length === 0)) {
    return <MissingMediaRetry key={frame.id} onUnavailable={onUnavailable} refetch={refetch} />;
  }

  const assetAspectRatio = frame.asset?.aspect_ratio && frame.asset.aspect_ratio > 0 ? frame.asset.aspect_ratio : 4 / 3;
  const fittedSize = fitSurface(stageSize, frame.kind === 'illustration' ? 4 / 5 : assetAspectRatio);
  if (frame.kind === 'video') return <Animated.View entering={FadeIn.duration(reduceMotion ? 0 : 300)} key={frame.id} style={[styles.mediaWrap, styles.mediaSurface, fittedSize]} testID="looking-back-frame-video"><StoryVideo frameId={frame.id} isPaused={isPaused} muted={muted} onAttach={onVideoAttach} onBuffering={onBuffering} onDetach={onVideoDetach} onDuration={onDuration ?? noopDuration} onReady={onReady} onUnavailable={onUnavailable} player={videoPlayer ?? null} posterKey={videoPosterKey} posterUrl={videoPosterUrl} url={primaryUrl!} videoKey={primaryKey!} /></Animated.View>;

  const isIllustration = frame.kind === 'illustration';
  return <Animated.View entering={FadeIn.duration(reduceMotion ? 0 : 300)} exiting={FadeOut.duration(reduceMotion ? 0 : 300)} key={frame.id} style={[styles.mediaWrap, isIllustration ? styles.illustrationPrint : styles.mediaSurface, fittedSize]} testID={`looking-back-frame-${frame.kind}`}>
    <ReliableStoryImage key={frame.id} isIllustration={isIllustration} onReady={onReady} onUnavailable={onUnavailable} refetch={refetch} sources={imageSources} />
  </Animated.View>;
}

function fitSurface(stageSize: { width: number; height: number } | undefined, aspectRatio: number) {
  if (!stageSize?.width || !stageSize.height) return { aspectRatio, width: '100%' as const };
  const widthAtFullHeight = stageSize.height * aspectRatio;
  return widthAtFullHeight <= stageSize.width
    ? { height: stageSize.height, width: widthAtFullHeight }
    : { height: stageSize.width / aspectRatio, width: stageSize.width };
}

export function StoryUnavailable() {
  return <View style={styles.unavailable} testID="looking-back-media-unavailable">
    <Text style={styles.unavailableTitle}>This photo isn&apos;t available right now.</Text>
    <Text style={styles.unavailableBody}>The memory and its words are still here.</Text>
  </View>;
}

const styles = StyleSheet.create({
  mediaWrap: { alignItems: 'center', alignSelf: 'center', justifyContent: 'center', maxHeight: '100%', overflow: 'hidden', width: '100%' },
  mediaSurface: { borderColor: 'rgba(246,241,231,0.18)', borderRadius: 20, borderWidth: 1, shadowColor: '#000', shadowOffset: { width: 0, height: 18 }, shadowOpacity: 0.32, shadowRadius: 30 },
  illustrationPrint: { backgroundColor: '#F6F1E7', borderColor: 'rgba(246,241,231,0.92)', borderRadius: 22, borderWidth: 1, padding: 9, shadowColor: '#000', shadowOffset: { width: 0, height: 18 }, shadowOpacity: 0.34, shadowRadius: 34 },
  illustrationInner: { borderRadius: 14 },
  media: { height: '100%', width: '100%' },
  videoLoading: { ...StyleSheet.absoluteFill, alignItems: 'center', backgroundColor: 'rgba(18,13,8,0.20)', gap: 12, justifyContent: 'center' },
  videoLoadingBadge: { alignItems: 'center', backgroundColor: 'rgba(18,13,8,0.62)', borderColor: 'rgba(246,241,231,0.20)', borderRadius: 999, borderWidth: 1, flexDirection: 'row', gap: 7, paddingHorizontal: 12, paddingVertical: 7 },
  videoLoadingPlay: { color: '#F6F1E7', fontSize: 11 },
  videoLoadingText: { color: '#F6F1E7', fontFamily: fonts.sansBold, fontSize: 11.5 },
  loading: { alignItems: 'center', aspectRatio: 4 / 3, backgroundColor: 'rgba(246,241,231,0.07)', borderColor: 'rgba(246,241,231,0.10)', borderRadius: 20, borderWidth: 1, gap: 12, justifyContent: 'center', width: '100%' },
  loadingCopy: { color: 'rgba(246,241,231,0.60)', fontFamily: fonts.sansMedium, fontSize: 12.5 },
  unavailable: { alignItems: 'center', aspectRatio: 4 / 3, backgroundColor: 'rgba(246,241,231,0.05)', borderColor: 'rgba(246,241,231,0.24)', borderRadius: 20, borderStyle: 'dashed', borderWidth: 1, justifyContent: 'center', paddingHorizontal: 30, width: '100%' },
  unavailableTitle: { color: '#F6F1E7', fontFamily: fonts.display, fontSize: 18, lineHeight: 24, textAlign: 'center' },
  unavailableBody: { color: 'rgba(246,241,231,0.55)', fontFamily: fonts.sans, fontSize: 12.5, lineHeight: 19, marginTop: 10, textAlign: 'center' },
  textPrint: { alignSelf: 'center', borderRadius: 24, justifyContent: 'center', maxHeight: '100%', overflow: 'hidden', paddingHorizontal: 30, paddingVertical: 34, shadowColor: '#000', shadowOffset: { width: 0, height: 26 }, shadowOpacity: 0.45, shadowRadius: 60, width: '100%' },
  longPrint: { justifyContent: 'flex-start' },
  quote: { fontFamily: fonts.display, fontSize: 88, left: 15, lineHeight: 88, opacity: 0.14, position: 'absolute', top: 14 },
  text: { color: colors.ink, fontFamily: fonts.display, fontSize: 27, letterSpacing: -0.35, lineHeight: 36 },
  longText: { fontSize: 18.5, lineHeight: 30 },
  textFade: { bottom: 0, height: 58, left: 0, position: 'absolute', right: 0 },
});
