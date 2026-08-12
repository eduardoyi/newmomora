import { useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { useEffect, useMemo, useRef } from 'react';

import { mediaUrlsQueryOptions } from '@/hooks/useMediaUrls';
import type { LookingBackFrame } from '@/utils/looking-back-frames';
import { frameMediaKeys } from '@/utils/looking-back-frames';
import { mediaImageSource } from '@/utils/media-image-source';

const LOOKAHEAD_MEDIA_FRAME_COUNT = 3;
const MAX_CONCURRENT_IMAGE_WARMS = 2;

export type LookingBackWarmupPhase = 'intro' | 'playing' | 'complete' | 'closed';

export interface LookingBackMediaWarmupOptions {
  frames: LookingBackFrame[];
  phase: LookingBackWarmupPhase;
  frameIndex: number;
  foregroundGeneration?: number;
}

interface MediaFrameEntry {
  frame: LookingBackFrame;
  queryKeys: string[];
  warmKeys: string[];
}

interface WarmupRun {
  cancelled: boolean;
  hasSettledSigning: boolean;
  urlsByKey: Map<string, string>;
  desiredWarmOrder: string[];
  desiredWarmKeys: Set<string>;
  queue: string[];
  queuedKeys: Set<string>;
  inFlightKeys: Set<string>;
  warmedKeys: Set<string>;
}

interface WarmupCoordinator {
  activeLoadCount: number;
  inFlightKeys: Set<string>;
  warmedKeys: Set<string>;
  currentRun: WarmupRun | null;
}

function createWarmupRun(): WarmupRun {
  return {
    cancelled: false,
    hasSettledSigning: false,
    urlsByKey: new Map(),
    desiredWarmOrder: [],
    desiredWarmKeys: new Set(),
    queue: [],
    queuedKeys: new Set(),
    inFlightKeys: new Set(),
    warmedKeys: new Set(),
  };
}

function createWarmupCoordinator(): WarmupCoordinator {
  return {
    activeLoadCount: 0,
    inFlightKeys: new Set(),
    warmedKeys: new Set(),
    currentRun: null,
  };
}

function isMediaFrame(frame: LookingBackFrame): boolean {
  return frame.kind === 'illustration' || frame.kind === 'photo' || frame.kind === 'video';
}

function lookaheadMediaFrames(
  entries: MediaFrameEntry[],
  phase: LookingBackWarmupPhase,
  frameIndex: number,
): MediaFrameEntry[] {
  if (phase === 'complete' || phase === 'closed') return [];

  const startIndex = phase === 'intro' ? 0 : Math.max(0, frameIndex);
  return entries
    .slice(startIndex)
    .filter(({ frame }) => isMediaFrame(frame))
    .slice(0, LOOKAHEAD_MEDIA_FRAME_COUNT);
}

function drainWarmQueue(run: WarmupRun, coordinator: WarmupCoordinator): void {
  if (run.cancelled || !run.hasSettledSigning) return;

  while (coordinator.activeLoadCount < MAX_CONCURRENT_IMAGE_WARMS && run.queue.length > 0) {
    const key = run.queue.shift();
    if (!key) continue;
    run.queuedKeys.delete(key);

    if (
      !run.desiredWarmKeys.has(key)
      || run.warmedKeys.has(key)
      || run.inFlightKeys.has(key)
      || coordinator.warmedKeys.has(key)
      || coordinator.inFlightKeys.has(key)
    ) {
      continue;
    }

    const url = run.urlsByKey.get(key);
    if (!url) continue;

    run.inFlightKeys.add(key);
    coordinator.inFlightKeys.add(key);
    coordinator.activeLoadCount += 1;
    let didWarm = false;
    void Promise.resolve()
      .then(() => Image.loadAsync(mediaImageSource(url, key)))
      .then((imageRef) => {
        // The native reference is only needed long enough to populate the
        // disk cache. Retaining it while warming a large package can create a
        // decoded-bitmap spike; the stable cacheKey remains reusable.
        imageRef.release();
        didWarm = true;
        run.warmedKeys.add(key);
        coordinator.warmedKeys.add(key);
      })
      .catch(() => {
        // A failed key intentionally stays out of warmedKeys. The next
        // lookahead reconciliation can retry it, while offline playback
        // falls through to StoryFrame's existing retry/unavailable path.
      })
      .finally(() => {
        run.inFlightKeys.delete(key);
        coordinator.inFlightKeys.delete(key);
        coordinator.activeLoadCount = Math.max(0, coordinator.activeLoadCount - 1);
        // A superseded run may have been the only owner of this key. Give
        // the current run a chance to retry it only when that old attempt
        // failed; a failed key in the current run waits for a later
        // lookahead reconciliation instead of retrying in a tight loop.
        if (
          !didWarm
          && coordinator.currentRun
          && coordinator.currentRun !== run
          && !coordinator.currentRun.cancelled
        ) {
          reconcileWarmQueue(coordinator.currentRun, coordinator.currentRun.desiredWarmOrder, coordinator);
        } else if (coordinator.currentRun && !coordinator.currentRun.cancelled) {
          drainWarmQueue(coordinator.currentRun, coordinator);
        }
      });
  }
}

function reconcileWarmQueue(
  run: WarmupRun,
  orderedKeys: string[],
  coordinator: WarmupCoordinator,
): void {
  if (run.cancelled) return;

  run.desiredWarmOrder = orderedKeys;
  run.desiredWarmKeys = new Set(orderedKeys);

  // Keep already queued keys in their original order, dropping a window that
  // the user has navigated past. In-flight work is allowed to finish; it has
  // already crossed the native boundary and its ref is owned by that promise.
  const retainedQueue = run.queue.filter((key) => run.desiredWarmKeys.has(key));
  run.queue = retainedQueue;
  run.queuedKeys = new Set(retainedQueue);

  for (const key of orderedKeys) {
    if (
      !run.urlsByKey.has(key)
      || run.warmedKeys.has(key)
      || run.inFlightKeys.has(key)
      || run.queuedKeys.has(key)
    ) {
      continue;
    }

    run.queue.push(key);
    run.queuedKeys.add(key);
  }

  drainWarmQueue(run, coordinator);
}

function frameGenerationKey(entries: MediaFrameEntry[]): string {
  return JSON.stringify(entries.map(({ frame, queryKeys, warmKeys }) => [
    frame.id,
    frame.memory.updated_at,
    queryKeys,
    warmKeys,
  ]));
}

/**
 * Signs every media frame in a package once, then warms only the current plus
 * two following media frames. The run is intentionally viewer-scoped so it
 * does not change the persisted media-URL query shape used by other screens.
 */
export function useLookingBackMediaWarmup({
  frames,
  phase,
  frameIndex,
  foregroundGeneration = 0,
}: LookingBackMediaWarmupOptions): void {
  const queryClient = useQueryClient();
  const runRef = useRef<WarmupRun | null>(null);
  const coordinatorRef = useRef<WarmupCoordinator>(createWarmupCoordinator());
  const entries = useMemo<MediaFrameEntry[]>(
    () => frames.map((frame) => {
      const keys = frameMediaKeys(frame);
      return { frame, queryKeys: keys.queryKeys, warmKeys: keys.warmKeys };
    }),
    [frames],
  );
  const generation = useMemo(() => frameGenerationKey(entries), [entries]);
  const entriesRef = useRef(entries);

  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  useEffect(() => {
    const coordinator = coordinatorRef.current;
    const run = createWarmupRun();
    runRef.current = run;
    coordinator.currentRun = run;

    const signingRequests = entriesRef.current
      .filter(({ queryKeys }) => queryKeys.length > 0)
      .map(({ frame, queryKeys }) => {
        try {
          // Issue every request synchronously before observing any result so
          // media.ts's 25 ms coalescer sees the whole package in one window.
          return queryClient.fetchQuery(
            mediaUrlsQueryOptions(queryKeys, frame.memory.updated_at),
          );
        } catch (error) {
          return Promise.reject(error);
        }
      });

    void Promise.allSettled(signingRequests).then((results) => {
      if (run.cancelled || runRef.current !== run) return;

      for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        for (const [key, url] of Object.entries(result.value)) {
          run.urlsByKey.set(key, url);
        }
      }

      run.hasSettledSigning = true;
      reconcileWarmQueue(run, run.desiredWarmOrder, coordinator);
    });

    return () => {
      run.cancelled = true;
      if (runRef.current === run) runRef.current = null;
      if (coordinator.currentRun === run) coordinator.currentRun = null;
    };
  }, [foregroundGeneration, generation, queryClient]);

  useEffect(() => {
    const run = runRef.current;
    if (!run) return;

    const orderedKeys = lookaheadMediaFrames(entries, phase, frameIndex)
      .flatMap(({ warmKeys }) => warmKeys);
    reconcileWarmQueue(run, orderedKeys, coordinatorRef.current);
  }, [entries, frameIndex, generation, phase]);
}
