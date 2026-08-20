import { useQueryClient } from '@tanstack/react-query';
import { createVideoPlayer, type SourceChangeEventPayload, type SourceLoadEventPayload, type VideoPlayer, type VideoSource } from 'expo-video';
import { AppState, Platform } from 'react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { mediaUrlsQueryOptions } from '@/hooks/useMediaUrls';
import type { LookingBackWarmupPhase } from '@/hooks/useLookingBackMediaWarmup';
import type { LookingBackFrame } from '@/utils/looking-back-frames';
import { frameMediaKeys } from '@/utils/looking-back-frames';

const MAX_LOOKING_BACK_PLAYERS = 2;
const LOOKING_BACK_VIDEO_WINDOW = 2;
const PREFERRED_FORWARD_BUFFER_SECONDS = 8;
const ANDROID_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

interface VideoFrameDescriptor {
  frameId: string;
  objectKey: string;
  cacheVersion: string;
  url: string | null;
}

interface VideoPlayerLease {
  frameId: string;
  token: number;
}

interface LookingBackVideoSlot {
  player: VideoPlayer;
  playerId: number;
  frameId: string;
  objectKey: string;
  cacheVersion: string;
  desiredUrl: string;
  appliedUrl: string | null;
  sourceRequestUrl: string | null;
  hasConfirmedSource: boolean;
  allowInitialReadyFallback: boolean;
  replacementInFlight: boolean;
  replacementAttempts: number;
  retryOnForeground: boolean;
  operationGeneration: number;
  currentClaim: boolean;
  preloadLease: boolean;
  retired: boolean;
  attachment: VideoPlayerLease | null;
  subscriptions: { remove: () => void }[];
}

export interface LookingBackVideoPreloadOptions {
  frames: LookingBackFrame[];
  phase: LookingBackWarmupPhase;
  frameIndex: number;
  /** Changes whenever the route returns to the foreground. */
  foregroundGeneration?: number;
}

export interface LookingBackVideoPreloadValue {
  currentPlayer: VideoPlayer | null;
  attachVideoPlayer: (frameId: string, player: VideoPlayer) => number | null;
  detachVideoPlayer: (frameId: string, player: VideoPlayer, token: number) => void;
}

function sourceUri(source: VideoSource | null | undefined): string | null {
  if (typeof source === 'string') return source;
  if (source && typeof source === 'object' && 'uri' in source && typeof source.uri === 'string') {
    return source.uri;
  }
  return null;
}

function descriptorForFrame(
  frame: LookingBackFrame | undefined,
  queryClient: ReturnType<typeof useQueryClient>,
): VideoFrameDescriptor | null {
  if (frame?.kind !== 'video' || !frame.asset?.object_key) return null;

  const objectKey = frame.asset.object_key;
  const queryKeys = frameMediaKeys(frame).queryKeys;
  const queryOptions = mediaUrlsQueryOptions(queryKeys, frame.memory.updated_at);
  const query = queryClient.getQueryCache().find({ queryKey: queryOptions.queryKey, exact: true });
  const data = query?.state.data;
  const url = query
    && query.state.status === 'success'
    && !query.state.isInvalidated
    && !query.isStaleByTime(queryOptions.staleTime)
    && data
    && typeof data === 'object'
    && objectKey in data
    && typeof (data as Record<string, unknown>)[objectKey] === 'string'
    ? (data as Record<string, string>)[objectKey]
    : null;

  return {
    frameId: frame.id,
    objectKey,
    cacheVersion: frame.memory.updated_at,
    url,
  };
}

function configurePreloadedPlayer(player: VideoPlayer): void {
  player.bufferOptions = Platform.OS === 'android'
    ? {
      preferredForwardBufferDuration: PREFERRED_FORWARD_BUFFER_SECONDS,
      maxBufferBytes: ANDROID_MAX_BUFFER_BYTES,
    }
    : { preferredForwardBufferDuration: PREFERRED_FORWARD_BUFFER_SECONDS };
  player.loop = false;
  player.muted = true;
  player.pause();
}

function diagnostics(event: string, slot: LookingBackVideoSlot): void {
  if (__DEV__ && process.env.NODE_ENV !== 'test') {
    // IDs and lifecycle events are safe diagnostics; do not log media URLs or
    // memory content because signed URLs are credentials.
    console.debug('[looking-back-video]', event, {
      frameId: slot.frameId,
      playerId: slot.playerId,
    });
  }
}

/**
 * Owns every Looking Back player. Keeping this ownership outside StoryVideo
 * makes the player handed from the detached preload surface to the visible
 * VideoView the exact same native object.
 */
export class LookingBackVideoPreloadController {
  private readonly queryClient: ReturnType<typeof useQueryClient>;
  private readonly onChange: () => void;
  private readonly slots: LookingBackVideoSlot[] = [];
  private nextPlayerId = 1;
  private nextLeaseToken = 1;
  private disposed = false;
  private isActive = true;
  private lastForegroundGeneration = 0;
  private readonly blockedSourceKeys = new Set<string>();
  private options: LookingBackVideoPreloadOptions = {
    frames: [],
    phase: 'closed',
    frameIndex: 0,
    foregroundGeneration: 0,
  };

  public constructor(
    queryClient: ReturnType<typeof useQueryClient>,
    onChange: () => void,
  ) {
    this.queryClient = queryClient;
    this.onChange = onChange;
  }

  public update(options: LookingBackVideoPreloadOptions): void {
    if (this.disposed) return;
    if (options.foregroundGeneration !== this.lastForegroundGeneration) {
      this.lastForegroundGeneration = options.foregroundGeneration ?? 0;
      this.blockedSourceKeys.clear();
      for (const slot of this.slots) {
        slot.replacementAttempts = 0;
        slot.retryOnForeground = true;
      }
    }
    this.options = options;
    if (!this.isActive) {
      this.onChange();
      return;
    }
    this.reconcile();
  }

  public getCurrentPlayer(): VideoPlayer | null {
    if (this.disposed) return null;
    if (this.options.phase === 'intro' || this.options.phase === 'complete' || this.options.phase === 'closed') return null;
    const frame = this.options.frames[this.options.frameIndex];
    const descriptor = descriptorForFrame(frame, this.queryClient);
    if (!descriptor) return null;

    const slot = this.slots.find((candidate) => (
      candidate.frameId === descriptor.frameId
      && candidate.currentClaim
      && !candidate.retired
    ));
    if (!slot) return null;

    // An already attached current player may remain visible while its signed
    // source is being refreshed. A detached/preloaded player must never be
    // handed to a new VideoView until its exact desired source is applied.
    if (slot.attachment || (descriptor.url && slot.appliedUrl === descriptor.url)) {
      return slot.player;
    }
    return null;
  }

  public attach(frameId: string, player: VideoPlayer): number | null {
    if (this.disposed) return null;
    const slot = this.slots.find((candidate) => candidate.player === player);
    if (!slot || slot.retired || !slot.currentClaim || slot.frameId !== frameId || slot.appliedUrl !== slot.desiredUrl) return null;

    const token = this.nextLeaseToken++;
    slot.attachment = { frameId, token };
    slot.preloadLease = false;
    diagnostics('attach', slot);
    this.onChange();
    return token;
  }

  public detach(frameId: string, player: VideoPlayer, token: number): void {
    const slot = this.slots.find((candidate) => candidate.player === player);
    if (!slot || slot.attachment?.frameId !== frameId || slot.attachment.token !== token) return;

    slot.attachment = null;
    try {
      slot.player.pause();
    } catch {
      // Native release/detach races are harmless; the release path remains
      // idempotent and will be retried only when the matching lease is gone.
    }
    diagnostics('detach', slot);
    this.releaseIfUnused(slot);
    this.reconcile();
  }

  public handleBackground(): void {
    if (this.disposed) return;
    this.isActive = false;
    for (const slot of [...this.slots]) {
      // Keep the mounted current surface alive; the route's playback hook
      // owns its pause reason. Detached upcoming work is disposable.
      if (slot.preloadLease && !slot.attachment) this.retire(slot);
    }
    this.onChange();
  }

  public handleForeground(): void {
    if (this.disposed) return;
    this.isActive = true;
    this.reconcile();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const slot of [...this.slots]) {
      slot.currentClaim = false;
      slot.preloadLease = false;
      slot.retired = true;
      this.releaseIfUnused(slot);
    }
  }

  private reconcile(): void {
    if (this.disposed || !this.isActive) return;

    const currentFrame = this.options.phase === 'intro' || this.options.phase === 'complete' || this.options.phase === 'closed'
      ? undefined
      : this.options.frames[this.options.frameIndex];
    const currentDescriptor = descriptorForFrame(currentFrame, this.queryClient);
    const upcomingDescriptor = this.findUpcomingDescriptor();
    const targetFrameIds = new Set(
      [currentDescriptor?.frameId, upcomingDescriptor?.frameId].filter((value): value is string => Boolean(value)),
    );

    for (const slot of [...this.slots]) {
      if (slot.retired || !targetFrameIds.has(slot.frameId)) {
        this.retire(slot);
        continue;
      }

      if (currentDescriptor?.frameId === slot.frameId) {
        slot.currentClaim = true;
        slot.preloadLease = false;
        this.syncSlot(slot, currentDescriptor);
      } else {
        slot.currentClaim = false;
        slot.preloadLease = true;
        this.syncSlot(slot, upcomingDescriptor!);
      }
    }

    if (currentDescriptor) {
      let currentSlot = this.findActiveSlot(currentDescriptor.frameId);
      if (!currentSlot && currentDescriptor.url) {
        currentSlot = this.createSlot(currentDescriptor, 'current');
      }
      if (currentSlot) {
        currentSlot.currentClaim = true;
        currentSlot.preloadLease = false;
        this.syncSlot(currentSlot, currentDescriptor);
      }
    }

    if (upcomingDescriptor && upcomingDescriptor.url && upcomingDescriptor.frameId !== currentDescriptor?.frameId) {
      let upcomingSlot = this.findActiveSlot(upcomingDescriptor.frameId);
      if (!upcomingSlot) upcomingSlot = this.createSlot(upcomingDescriptor, 'preload');
      if (upcomingSlot) {
        upcomingSlot.currentClaim = false;
        upcomingSlot.preloadLease = true;
        this.syncSlot(upcomingSlot, upcomingDescriptor);
      }
    }

    for (const slot of [...this.slots]) this.releaseIfUnused(slot);
    this.onChange();
  }

  private findUpcomingDescriptor(): VideoFrameDescriptor | null {
    if (this.options.phase === 'complete' || this.options.phase === 'closed') return null;

    const startIndex = this.options.phase === 'intro' ? 0 : Math.max(0, this.options.frameIndex + 1);
    const frames = this.options.frames.slice(startIndex, startIndex + LOOKING_BACK_VIDEO_WINDOW);
    for (const frame of frames) {
      const descriptor = descriptorForFrame(frame, this.queryClient);
      if (descriptor) return descriptor;
    }
    return null;
  }

  private findActiveSlot(frameId: string): LookingBackVideoSlot | null {
    return this.slots.find((slot) => slot.frameId === frameId && !slot.retired) ?? null;
  }

  private createSlot(
    descriptor: VideoFrameDescriptor,
    role: 'current' | 'preload',
  ): LookingBackVideoSlot | null {
    if (this.disposed || !descriptor.url) return null;
    if (this.blockedSourceKeys.has(this.sourceKey(descriptor, descriptor.url))) return null;

    if (this.slots.length >= MAX_LOOKING_BACK_PLAYERS) {
      if (role === 'current') {
        // Current playback wins over an unattached upcoming preload.
        for (const slot of [...this.slots]) {
          if (slot.preloadLease && !slot.attachment) this.retire(slot);
        }
      }
      if (this.slots.length >= MAX_LOOKING_BACK_PLAYERS) return null;
    }

    let player: VideoPlayer;
    try {
      // Start empty so native sourceChange/sourceLoad is the authority for
      // the first applied URL too. The listener is installed before the
      // asynchronous source load begins below.
      player = createVideoPlayer(null);
      configurePreloadedPlayer(player);
    } catch {
      return null;
    }

    const slot: LookingBackVideoSlot = {
      player,
      playerId: this.nextPlayerId++,
      frameId: descriptor.frameId,
      objectKey: descriptor.objectKey,
      cacheVersion: descriptor.cacheVersion,
      desiredUrl: descriptor.url,
      appliedUrl: null,
      sourceRequestUrl: null,
      hasConfirmedSource: false,
      allowInitialReadyFallback: Platform.OS === 'ios',
      replacementInFlight: false,
      replacementAttempts: 0,
      retryOnForeground: false,
      operationGeneration: 0,
      currentClaim: role === 'current',
      preloadLease: role === 'preload',
      retired: false,
      attachment: null,
      subscriptions: [],
    };
    this.slots.push(slot);
    this.bindSourceEvents(slot);
    this.replaceSlotSource(slot, descriptor.url);
    if (slot.retired) return null;
    diagnostics('create', slot);
    return slot;
  }

  private bindSourceEvents(slot: LookingBackVideoSlot): void {
    slot.subscriptions.push(slot.player.addListener('sourceChange', (event: SourceChangeEventPayload) => {
      this.handleAppliedSource(slot, event.source);
    }));
    slot.subscriptions.push(slot.player.addListener('sourceLoad', (event: SourceLoadEventPayload) => {
      this.handleAppliedSource(slot, event.videoSource);
    }));
    slot.subscriptions.push(slot.player.addListener('statusChange', ({ status }) => {
      this.handleInitialReadyFallback(slot, status);
    }));
  }

  private handleAppliedSource(slot: LookingBackVideoSlot, source: VideoSource | null | undefined): void {
    if (slot.retired) return;
    const uri = sourceUri(source);
    if (!uri || uri !== slot.sourceRequestUrl) return;

    slot.replacementInFlight = false;
    // A late event for an older request confirms only that older native item;
    // it must never make that item attachable while a newer URL is desired.
    if (uri !== slot.desiredUrl) {
      slot.appliedUrl = null;
      if (this.isActive) this.replaceSlotSource(slot, slot.desiredUrl);
      return;
    }

    slot.appliedUrl = uri;
    slot.sourceRequestUrl = null;
    slot.hasConfirmedSource = true;
    slot.replacementAttempts = 0;
    slot.retryOnForeground = false;
    diagnostics('source-applied', slot);
    this.onChange();
  }

  private handleInitialReadyFallback(slot: LookingBackVideoSlot, status: VideoPlayer['status']): void {
    // On iOS an initially detached AVPlayer can reach readyToPlay without
    // delivering the sourceChange/sourceLoad event to JavaScript. This is
    // safe only for the first source: later signed-URL replacements must keep
    // the exact source-event confirmation rule to avoid handing off a stale
    // native item.
    if (
      status !== 'readyToPlay'
      || slot.retired
      || slot.hasConfirmedSource
      || !slot.allowInitialReadyFallback
      || slot.appliedUrl
      || slot.sourceRequestUrl !== slot.desiredUrl
    ) return;

    slot.replacementInFlight = false;
    slot.appliedUrl = slot.desiredUrl;
    slot.sourceRequestUrl = null;
    slot.hasConfirmedSource = true;
    slot.allowInitialReadyFallback = false;
    slot.replacementAttempts = 0;
    slot.retryOnForeground = false;
    diagnostics('source-applied-ready-fallback', slot);
    this.onChange();
  }

  private syncSlot(slot: LookingBackVideoSlot, descriptor: VideoFrameDescriptor): void {
    if (!descriptor.url) {
      if (!slot.attachment) this.retire(slot);
      return;
    }

    const identityChanged = slot.objectKey !== descriptor.objectKey || slot.cacheVersion !== descriptor.cacheVersion;
    slot.frameId = descriptor.frameId;
    slot.objectKey = descriptor.objectKey;
    slot.cacheVersion = descriptor.cacheVersion;

    const desiredUrlChanged = slot.desiredUrl !== descriptor.url;
    const shouldRetry = slot.retryOnForeground && slot.appliedUrl !== descriptor.url;
    if (!desiredUrlChanged && !identityChanged && !shouldRetry) return;

    if (desiredUrlChanged || identityChanged) {
      // Once the initial signed URL or its owning-row identity changes, a
      // later readyToPlay event cannot prove which native item is ready.
      // From here on, exact sourceChange/sourceLoad confirmation is required.
      slot.allowInitialReadyFallback = false;
    }

    slot.desiredUrl = descriptor.url;
    slot.retryOnForeground = false;
    if (slot.appliedUrl === descriptor.url) return;

    slot.appliedUrl = null;
    // Serialize source replacements. A matching native event for the older
    // request starts the latest desired URL; overlapping requests cannot
    // deliver an ambiguous late source event.
    if (slot.replacementInFlight) return;
    if (this.blockedSourceKeys.has(this.sourceKey(descriptor, descriptor.url))) return;
    this.replaceSlotSource(slot, descriptor.url);
  }

  private replaceSlotSource(slot: LookingBackVideoSlot, url: string): void {
    if (this.disposed || !this.isActive || slot.retired || slot.replacementInFlight) return;
    const operationGeneration = ++slot.operationGeneration;
    slot.replacementInFlight = true;
    slot.sourceRequestUrl = url;
    slot.replacementAttempts += 1;
    try {
      void slot.player.replaceAsync({ uri: url, useCaching: true }).then(() => {
        // The promise only means the asynchronous request was accepted. The
        // sourceChange/sourceLoad listener is the authority for native swap.
        if (slot.operationGeneration !== operationGeneration || slot.retired) return;
        slot.replacementInFlight = false;
        if (slot.desiredUrl !== url && this.isActive) {
          slot.appliedUrl = null;
          slot.replacementAttempts = 0;
          this.replaceSlotSource(slot, slot.desiredUrl);
        }
      }).catch(() => {
        if (slot.operationGeneration !== operationGeneration || slot.retired) return;
        slot.replacementInFlight = false;
        if (slot.desiredUrl !== url) {
          // The desired URL changed while the old request was failing. Do not
          // spend the new URL's retry budget on the obsolete source.
          slot.appliedUrl = null;
          slot.replacementAttempts = 0;
          queueMicrotask(() => this.replaceSlotSource(slot, slot.desiredUrl));
          return;
        }
        if (slot.replacementAttempts < 2) {
          queueMicrotask(() => this.replaceSlotSource(slot, url));
          return;
        }
        this.blockedSourceKeys.add(this.sourceKey({
          frameId: slot.frameId,
          objectKey: slot.objectKey,
          cacheVersion: slot.cacheVersion,
        }, url));
        slot.retryOnForeground = true;
        if (!slot.attachment) this.retire(slot);
        this.onChange();
      });
    } catch {
      slot.replacementInFlight = false;
      if (slot.desiredUrl !== url) {
        slot.appliedUrl = null;
        slot.replacementAttempts = 0;
        queueMicrotask(() => this.replaceSlotSource(slot, slot.desiredUrl));
        return;
      }
      if (slot.replacementAttempts < 2) {
        queueMicrotask(() => this.replaceSlotSource(slot, url));
        return;
      }
      this.blockedSourceKeys.add(this.sourceKey({
        frameId: slot.frameId,
        objectKey: slot.objectKey,
        cacheVersion: slot.cacheVersion,
      }, url));
      slot.retryOnForeground = true;
      if (!slot.attachment) this.retire(slot);
      this.onChange();
    }
  }

  private sourceKey(
    descriptor: Pick<VideoFrameDescriptor, 'frameId' | 'objectKey' | 'cacheVersion'>,
    url: string,
  ): string {
    return `${descriptor.frameId}\u0000${descriptor.objectKey}\u0000${descriptor.cacheVersion}\u0000${url}`;
  }

  private retire(slot: LookingBackVideoSlot): void {
    if (slot.retired) {
      this.releaseIfUnused(slot);
      return;
    }
    slot.retired = true;
    slot.currentClaim = false;
    slot.preloadLease = false;
    this.releaseIfUnused(slot);
  }

  private releaseIfUnused(slot: LookingBackVideoSlot): void {
    if (!slot.retired || slot.attachment || slot.currentClaim || slot.preloadLease) return;

    slot.retired = true;
    for (const subscription of slot.subscriptions) subscription.remove();
    slot.subscriptions = [];
    try {
      slot.player.pause();
      slot.player.release();
    } catch {
      // Releasing twice or after a native detach is safe from the manager's
      // perspective; the slot is removed exactly once below.
    }
    diagnostics('release', slot);
    const index = this.slots.indexOf(slot);
    if (index >= 0) this.slots.splice(index, 1);
  }
}

export function useLookingBackVideoPreload({
  frames,
  phase,
  frameIndex,
  foregroundGeneration = 0,
}: LookingBackVideoPreloadOptions): LookingBackVideoPreloadValue {
  const queryClient = useQueryClient();
  const [, forceUpdate] = useState(0);
  const [controller] = useState(
    () => new LookingBackVideoPreloadController(queryClient, () => forceUpdate((value) => value + 1)),
  );
  // Do not key reconciliation to the frames array identity. The route
  // rebuilds frame objects when native video duration arrives; player
  // identity is instead tied to frame id, media object key, and URL version.
  const frameSignature = JSON.stringify(frames.map((frame) => [
    frame.id,
    frame.kind,
    frame.memory.updated_at,
    frame.asset?.object_key ?? null,
    frame.asset?.preview_object_key ?? null,
  ]));
  // `frameSignature` intentionally replaces the array identity dependency so
  // duration-only frame rebuilds do not churn the player manager.
  const options = useMemo(
    () => ({ frames, phase, frameIndex, foregroundGeneration }),
    [frameSignature, foregroundGeneration, frameIndex, phase], // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    controller.update(options);
  }, [controller, options]);

  useEffect(() => {
    const unsubscribe = queryClient.getQueryCache().subscribe(() => {
      // Query-cache updates can arrive after the package-wide signing effect.
      // Reconciliation always reads the exact frame grouping and freshness
      // state, rather than trusting a one-time getQueryData result.
      controller.update(options);
    });
    return unsubscribe;
  }, [controller, options, queryClient]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') controller.handleForeground();
      else controller.handleBackground();
    });
    return () => subscription.remove();
  }, [controller]);

  useEffect(() => () => controller.dispose(), [controller]);

  const attachVideoPlayer = useCallback((frameId: string, player: VideoPlayer) => controller.attach(frameId, player), [controller]);
  const detachVideoPlayer = useCallback((frameId: string, player: VideoPlayer, token: number) => controller.detach(frameId, player, token), [controller]);

  return {
    currentPlayer: controller.getCurrentPlayer(),
    attachVideoPlayer,
    detachVideoPlayer,
  };
}
