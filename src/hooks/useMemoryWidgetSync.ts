import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { colors, getEmotionColors } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { useUserProfile } from '@/hooks/useUserProfile';
import { useIsOnline } from '@/lib/connectivity';
import {
  stageWidgetImage,
  sweepWidgetCache,
  neutralWidgetManifest,
  WidgetCacheController,
  WIDGET_MANIFEST_SCHEMA_VERSION,
  type WidgetCacheScope,
  type WidgetImageToStage,
  type WidgetManifest,
  type WidgetManifestEntry,
  type WidgetNativeAdapter,
} from '@/services/widget-cache';
import {
  fetchMyBlockedFamilyAccounts,
  fetchMyContentReports,
  type BlockedFamilyAccount,
  type ContentReport,
} from '@/services/content-safety';
import {
  fetchWidgetCandidateMemories,
  fetchWidgetRetainedMemoriesByIds,
  type WidgetCandidateMemorySet,
} from '@/services/widget-memories';
import { getMediaUrls } from '@/services/media';
import { formatDisplayDate } from '@/utils/memories';
import { isAudioContentType, isVideoContentType } from '@/utils/media-validation';
import {
  buildWidgetTimeline,
  selectWidgetMemorySlots,
  widgetLocalDateAt,
  WIDGET_DAYTIME_TIMELINE_ENTRY_LIMIT,
  WIDGET_TIMELINE_SLOT_COUNT,
  type WidgetSelectionCandidate,
} from '@/utils/widget-selection';
import type { MemoryWithTags, MemoryMediaAsset } from '@/services/memories';
import { getDeviceTimezone } from '@/services/auth';

/**
 * Native registration is intentionally optional. Older binaries, Expo Go,
 * web, and tests can leave it unset; the rest of the app continues normally.
 * The native adapter can register itself during app bootstrap without making
 * the coordinator import a native-only module.
 */
let registeredAdapter: WidgetNativeAdapter | null = null;
const adapterListeners = new Set<() => void>();

export function registerMemoryWidgetNativeAdapter(adapter: WidgetNativeAdapter | null): void {
  registeredAdapter = adapter;
  for (const listener of adapterListeners) listener();
}

/** Alias used by native bootstrap code and kept deliberately domain-specific. */
export const setMemoryWidgetNativeAdapter = registerMemoryWidgetNativeAdapter;

export function getMemoryWidgetNativeAdapter(): WidgetNativeAdapter | null {
  return registeredAdapter;
}

// All app entry points share one sweep promise. A force-quit can leave an
// interrupted staging directory behind, but two independent sweeps racing a
// first publish could also delete a generation while it is being installed.
let widgetCacheSweepPromise: Promise<void> | null = null;

export function ensureMemoryWidgetCacheSwept(): Promise<void> {
  if (!widgetCacheSweepPromise) {
    widgetCacheSweepPromise = sweepWidgetCache().catch(() => undefined);
  }
  return widgetCacheSweepPromise;
}

function subscribeAdapter(listener: () => void): () => void {
  adapterListeners.add(listener);
  return () => adapterListeners.delete(listener);
}

function getAdapterSnapshot(): WidgetNativeAdapter | null {
  return registeredAdapter;
}

export interface MemoryWidgetSyncResult {
  published: boolean;
  cleared: boolean;
  reason?: string;
}

interface WidgetSafetyState {
  reports: ContentReport[];
  blocks: BlockedFamilyAccount[];
}

export interface MemoryWidgetSyncDependencies {
  now?: () => number;
  getTimezone?: () => string;
  fetchCandidates?: typeof fetchWidgetCandidateMemories;
  fetchRetained?: typeof fetchWidgetRetainedMemoriesByIds;
  fetchReports?: typeof fetchMyContentReports;
  fetchBlocks?: typeof fetchMyBlockedFamilyAccounts;
  signMedia?: typeof getMediaUrls;
  stageImage?: typeof stageWidgetImage;
  sweep?: () => Promise<void>;
}

type RequiredMemoryWidgetSyncDependencies = {
  [Key in 'fetchCandidates' | 'fetchRetained' | 'fetchReports' | 'fetchBlocks'
    | 'signMedia' | 'stageImage' | 'sweep']: NonNullable<MemoryWidgetSyncDependencies[Key]>
} & Pick<MemoryWidgetSyncDependencies, 'now' | 'getTimezone'>;

interface ProjectedImage {
  key: string;
  filename: string;
  mediaIndex?: number;
  kind: 'illustration' | 'photo';
}

interface ProjectedMemory {
  memory: MemoryWithTags;
  image: ProjectedImage | null;
  entry: Omit<WidgetManifestEntry, 'startsAt'>;
}

function scopeKey(scope: WidgetCacheScope): string {
  return `${scope.accountId}:${scope.familyId}`;
}

function normalizeNativeTimelineCapacity(value: number | undefined): number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= WIDGET_DAYTIME_TIMELINE_ENTRY_LIMIT
    ? WIDGET_DAYTIME_TIMELINE_ENTRY_LIMIT
    : WIDGET_TIMELINE_SLOT_COUNT;
}

function safeFilename(memoryId: string, index: number): string {
  const safeId = memoryId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 96) || 'memory';
  return `memory-${safeId}-${index}.jpg`;
}

function isReportedMemory(reports: readonly ContentReport[], memoryId: string): boolean {
  return reports.some((report) => report.target_type === 'memory' && report.target_id === memoryId);
}

function isReportedIllustration(
  reports: readonly ContentReport[],
  memory: MemoryWithTags,
): boolean {
  const currentGenerationId = memory.illustration_generation_id ?? null;
  return reports.some((report) => report.target_type === 'memory_illustration'
    && report.target_id === memory.id
    && report.target_version_id === currentGenerationId);
}

function isBlocked(blocks: readonly BlockedFamilyAccount[], userId: string | null): boolean {
  return Boolean(userId) && blocks.some((block) => block.blocked_user_id === userId);
}

function imageAssetForMemory(memory: MemoryWithTags): {
  asset: MemoryMediaAsset;
  index: number;
  kind: 'photo';
} | null {
  const assets = [...memory.mediaAssets].sort((left, right) => left.position - right.position);
  for (const [index, asset] of assets.entries()) {
    if (isAudioContentType(asset.content_type)) continue;
    if (isVideoContentType(asset.content_type)) continue;
    const imageKey = asset.preview_object_key ?? asset.object_key;
    if (asset.content_type.startsWith('image/') && imageKey) {
      return { asset: { ...asset, object_key: imageKey }, index, kind: 'photo' };
    }
  }

  // Legacy media rows are hydrated into mediaAssets by fetchMemoriesByIds, but
  // retain this fallback for a test double or an older adapter response.
  if (memory.media_key && memory.media_content_type) {
    if (isVideoContentType(memory.media_content_type)) return null;
    if (!isAudioContentType(memory.media_content_type) && memory.media_content_type.startsWith('image/')) {
      return {
        asset: {
          id: `${memory.id}-legacy-media`,
          memory_id: memory.id,
          object_key: memory.media_key,
          content_type: memory.media_content_type,
          duration_ms: null,
          aspect_ratio: null,
          preview_object_key: null,
          share_card_key: null,
          position: 0,
          created_at: memory.created_at,
          updated_at: memory.updated_at,
        },
        index: 0,
        kind: 'photo',
      };
    }
  }
  return null;
}

function chooseImage(
  memory: MemoryWithTags,
  reports: readonly ContentReport[],
): ProjectedImage | null {
  if (memory.memory_type === 'text_illustration'
    && memory.illustration_status === 'ready'
    && memory.illustration_key
    && !isReportedIllustration(reports, memory)) {
    return {
      key: memory.illustration_key,
      filename: safeFilename(memory.id, 0),
      kind: 'illustration',
    };
  }

  if (memory.memory_type !== 'media') return null;
  const media = imageAssetForMemory(memory);
  if (!media) return null;
  return {
    key: media.asset.object_key,
    filename: safeFilename(memory.id, media.index),
    mediaIndex: media.index > 0 ? media.index : undefined,
    kind: media.kind,
  };
}

function colorsForMemory(memory: MemoryWithTags): { background: string; foreground: string; accent: string } {
  const emotion = getEmotionColors(memory.emotion);
  return {
    background: emotion?.soft ?? colors.surface2,
    foreground: emotion?.ink ?? colors.ink,
    accent: emotion?.c ?? colors.primary,
  };
}

function projectMemory(
  memory: MemoryWithTags,
  reports: readonly ContentReport[],
): ProjectedMemory {
  const image = chooseImage(memory, reports);
  const emotionColors = colorsForMemory(memory);
  return {
    memory,
    image,
    entry: {
      memoryId: memory.id,
      sourceUpdatedAt: memory.updated_at,
      memoryDate: memory.memory_date,
      dateLabel: formatDisplayDate(memory.memory_date),
      ...(image?.mediaIndex === undefined ? {} : { mediaIndex: image.mediaIndex }),
      ...(image ? { imageFilename: image.filename } : {}),
      excerpt: 'A family memory',
      colors: emotionColors,
      kind: image?.kind ?? 'text',
    },
  };
}

function normalizeSafety(
  reports: ContentReport[] | null,
  blocks: BlockedFamilyAccount[] | null,
): WidgetSafetyState {
  return { reports: reports ?? [], blocks: blocks ?? [] };
}

function widgetCandidatesFromMemories(
  memories: readonly MemoryWithTags[],
  familyDate: string,
): WidgetSelectionCandidate[] {
  return memories.map((memory) => ({ id: memory.id, memoryDate: memory.memory_date }))
    .filter((candidate) => Boolean(candidate.id && candidate.memoryDate && familyDate));
}

/**
 * The coordinator owns the full freshness boundary. React Query may contain
 * useful display data, but this path always performs its own online candidate,
 * retained-memory, and content-safety reads before extending the lease.
 */
export class MemoryWidgetSyncCoordinator {
  // Track displayed cards, not the six future timeline slots. Scoped to this
  // app session; a restart starts a fresh shuffle excluding the current card.
  private readonly manuallySeen = new Map<string, Set<string>>();
  private readonly controller: WidgetCacheController;
  private readonly adapter: WidgetNativeAdapter | null;
  private readonly dependencies: RequiredMemoryWidgetSyncDependencies;

  constructor(
    adapter: WidgetNativeAdapter | null | undefined,
    dependencies: MemoryWidgetSyncDependencies = {},
  ) {
    this.adapter = adapter ?? null;
    this.controller = new WidgetCacheController({
      adapter,
      now: dependencies.now,
    });
    this.dependencies = {
      fetchCandidates: dependencies.fetchCandidates ?? fetchWidgetCandidateMemories,
      fetchRetained: dependencies.fetchRetained ?? fetchWidgetRetainedMemoriesByIds,
      fetchReports: dependencies.fetchReports ?? fetchMyContentReports,
      fetchBlocks: dependencies.fetchBlocks ?? fetchMyBlockedFamilyAccounts,
      signMedia: dependencies.signMedia ?? getMediaUrls,
      stageImage: dependencies.stageImage ?? stageWidgetImage,
      sweep: dependencies.sweep ?? ensureMemoryWidgetCacheSwept,
      now: dependencies.now,
      getTimezone: dependencies.getTimezone,
    };
  }

  get currentEpoch(): number {
    return this.controller.currentEpoch;
  }

  private async nativeTimelineCapacity(): Promise<number> {
    const readCapacity = this.adapter?.maxTimelineEntries;
    if (!readCapacity) return WIDGET_TIMELINE_SLOT_COUNT;
    try {
      return normalizeNativeTimelineCapacity(await readCapacity());
    } catch {
      // A capability read is local metadata, not freshness evidence. Keep the
      // old seven-entry schedule when an older/partial binary cannot answer.
      return WIDGET_TIMELINE_SLOT_COUNT;
    }
  }

  invalidate(): number {
    return this.controller.invalidate();
  }

  async clear(scope?: WidgetCacheScope): Promise<void> {
    if (scope) this.manuallySeen.delete(scopeKey(scope));
    else this.manuallySeen.clear();
    await this.controller.clear(scope);
  }

  async read(scope: WidgetCacheScope): Promise<WidgetManifest | null> {
    return this.controller.read(scope);
  }

  async sync(scope: WidgetCacheScope, options: { showAnother?: boolean } = {}): Promise<MemoryWidgetSyncResult> {
    if (!this.adapter) return { published: false, cleared: false, reason: 'native_unavailable' };

    const epoch = this.controller.invalidate();
    const abortController = this.controller.createAbortController(epoch);
    if (!abortController) return { published: false, cleared: false, reason: 'superseded' };
    const signal = abortController.signal;

    // This resolves the app-wide startup sweep. Tests may inject their own
    // sweep, while production always shares ensureMemoryWidgetCacheSwept().
    await this.dependencies.sweep().catch(() => undefined);
    if (!this.controller.isCurrent(epoch) || signal.aborted) {
      return { published: false, cleared: false, reason: 'superseded' };
    }

    const syncStartedAt = new Date((this.dependencies.now ?? Date.now)()).toISOString();
    const previous = await this.controller.read(scope);
    const candidateResult = await this.dependencies.fetchCandidates(scope.familyId);
    if (!this.controller.isCurrent(epoch) || signal.aborted) {
      return { published: false, cleared: false, reason: 'superseded' };
    }
    if (candidateResult.failure === 'authorization') {
      await this.controller.clear(scope);
      return { published: false, cleared: true, reason: 'authorization_lost' };
    }
    if (candidateResult.error || !candidateResult.data) {
      // Network/temporary errors are not proof that access disappeared. Keep
      // the previously verified snapshot until its existing lease expires.
      return { published: false, cleared: false, reason: 'candidate_unavailable' };
    }

    // A daytime manifest repeats at most seven selected IDs over many entries.
    // Deduplicate before passing the retained set through its seven-ID bound.
    const retainedIds = [...new Set(previous?.entries.map((entry) => entry.memoryId) ?? [])]
      .filter((memoryId) => memoryId.length > 0);
    let retainedMemories: MemoryWithTags[] = [];
    if (retainedIds.length > 0) {
      const retainedResult = await this.dependencies.fetchRetained(scope.familyId, retainedIds);
      if (!this.controller.isCurrent(epoch) || signal.aborted) {
        return { published: false, cleared: false, reason: 'superseded' };
      }
      if (retainedResult.failure === 'authorization') {
        await this.controller.clear(scope);
        return { published: false, cleared: true, reason: 'authorization_lost' };
      }
      if (retainedResult.error || !retainedResult.data) {
        // A missing/failed retained read must never renew the old lease. A
        // non-definitive RLS/network error also must not masquerade as access
        // loss and clear private data.
        return { published: false, cleared: false, reason: 'retained_unavailable' };
      }
      retainedMemories = retainedResult.data;
    }

    const [reportsResult, blocksResult] = await Promise.all([
      this.dependencies.fetchReports(scope.familyId),
      this.dependencies.fetchBlocks(scope.familyId),
    ]);
    if (!this.controller.isCurrent(epoch) || signal.aborted) {
      return { published: false, cleared: false, reason: 'superseded' };
    }
    if (reportsResult.error || blocksResult.error) {
      // Safety lookup failure is deliberately fail-closed for renewal, but it
      // is not definitive membership loss.
      return { published: false, cleared: false, reason: 'safety_unavailable' };
    }
    const safety = normalizeSafety(reportsResult.data, blocksResult.data);

    const candidateData: WidgetCandidateMemorySet = candidateResult.data;
    const retainedResultIds = new Set(retainedMemories.map((memory) => memory.id));
    const retainedMissingIds = new Set(retainedIds.filter((memoryId) => !retainedResultIds.has(memoryId)));
    const freshMemories = candidateData.memories.filter((memory) =>
      !retainedMissingIds.has(memory.id)
      && !isReportedMemory(safety.reports, memory.id)
      && !isBlocked(safety.blocks, memory.user_id));
    const retainedSafe = retainedMemories.filter((memory) =>
      !isReportedMemory(safety.reports, memory.id)
      && !isBlocked(safety.blocks, memory.user_id));
    const byId = new Map<string, MemoryWithTags>();
    for (const memory of [...freshMemories, ...retainedSafe]) {
      if (chooseImage(memory, safety.reports)) byId.set(memory.id, memory);
    }

    if (byId.size === 0) {
      // A successful online validation with no accessible memories must
      // replace any old card with the scoped neutral state. This keeps a
      // deleted last memory from surviving its next successful revalidation.
      const neutral = neutralWidgetManifest(scope, new Date(syncStartedAt));
      const published = await this.controller.publish(scope, neutral, {}, epoch);
      return published
        ? { published: true, cleared: false }
        : { published: false, cleared: false, reason: 'superseded' };
    }

    const timezoneName = candidateData.clock?.timezoneName
      ?? this.dependencies.getTimezone?.()
      ?? getDeviceTimezone();
    const verifiedAt = syncStartedAt;
    const familyDate = candidateData.clock?.familyDate
      ?? widgetLocalDateAt(verifiedAt, timezoneName)
      ?? new Date(verifiedAt).toISOString().slice(0, 10);
    const maxTimelineEntries = await this.nativeTimelineCapacity();
    if (!this.controller.isCurrent(epoch) || signal.aborted) {
      return { published: false, cleared: false, reason: 'superseded' };
    }
    const currentEntry = previous?.entries
      .filter((entry) => Date.parse(entry.startsAt) <= Date.parse(verifiedAt))
      .sort((left, right) => Date.parse(right.startsAt) - Date.parse(left.startsAt))[0];
    const selectionMemories = [...byId.values()].filter((memory) =>
      !options.showAnother || byId.size <= 1 || memory.id !== currentEntry?.memoryId);
    const candidates = widgetCandidatesFromMemories(selectionMemories, familyDate);
    const verifiedMilliseconds = Date.parse(verifiedAt);
    // Future entries are planned exposure, not displayed history. They must
    // not make an automatic refresh or a manual shuffle treat those IDs as
    // already seen before their boundary arrives.
    const recentScheduledIds = [...new Set(previous?.entries
      .filter((entry) => Date.parse(entry.startsAt) <= verifiedMilliseconds)
      .map((entry) => entry.memoryId) ?? [])];
    let slots = selectWidgetMemorySlots({
      familyId: scope.familyId,
      familyDate,
      candidates,
      recentScheduledIds,
    });
    let manualSeen: Set<string> | undefined;
    if (options.showAnother) {
      const eligibleIds = new Set(candidates.map((candidate) => candidate.id));
      manualSeen = new Set([...(this.manuallySeen.get(scopeKey(scope)) ?? [])]
        .filter((id) => eligibleIds.has(id)));
      if (currentEntry) manualSeen.add(currentEntry.memoryId);
      let unseen = candidates.filter((candidate) => !manualSeen!.has(candidate.id));
      if (unseen.length === 0) {
        manualSeen = new Set(currentEntry ? [currentEntry.memoryId] : []);
        unseen = candidates;
      }
      // Uniformly choose an unseen image across age bands. The daily scheduler
      // still supplies later slots, but never determines the manual pick.
      const next = unseen[Math.floor(Math.random() * unseen.length)];
      if (next) {
        slots = [
          { slotIndex: 0, memoryId: next.id },
          ...slots.filter((slot) => slot.memoryId !== next.id),
          ...slots,
        ].slice(0, 7).map((slot, slotIndex) => ({ ...slot, slotIndex }));
      }
    }
    // A refresh in the same local day keeps the card currently on screen in
    // slot one when it still passed retained RLS and safety checks. This also
    // prevents a deterministic re-shuffle from replacing today's card on
    // every foreground or mutation-triggered refresh.
    if (!options.showAnother && currentEntry && byId.has(currentEntry.memoryId)) {
      const remainingRotation = [
        ...slots.filter((slot) => slot.memoryId !== currentEntry.memoryId),
        { slotIndex: 0, memoryId: currentEntry.memoryId },
      ];
      slots = [
        { slotIndex: 0, memoryId: currentEntry.memoryId },
        ...Array.from({ length: 6 }, (_, index) => ({
          ...remainingRotation[index % remainingRotation.length],
          slotIndex: index + 1,
        })),
      ];
    }
    const timeline = buildWidgetTimeline({
      verifiedAt,
      timezoneName,
      slots,
      maxTimelineEntries,
    });
    if (!timeline) return { published: false, cleared: false, reason: 'timeline_invalid' };

    // The timeline can carry up to 24 entries, but the selected rotation is
    // intentionally capped at seven unique memories/files.
    const rotationMemoryIds = [...new Set(timeline.entries.map((entry) => entry.memoryId))]
      .slice(0, WIDGET_TIMELINE_SLOT_COUNT);
    const projectedById = new Map<string, ProjectedMemory>();
    for (const memoryId of rotationMemoryIds) {
      const memory = byId.get(memoryId);
      if (memory) projectedById.set(memoryId, projectMemory(memory, safety.reports));
    }
    const imageCandidates = [...projectedById.values()]
      .flatMap((projection) => projection.image ? [projection.image] : []);
    const mediaKeys = [...new Set(imageCandidates.map((image) => image.key))];
    let signedUrls: Record<string, string> = {};
    if (mediaKeys.length > 0) {
      const signed = await this.dependencies.signMedia(mediaKeys);
      if (signed.data && !signed.error) signedUrls = signed.data.urls;
    }

    const generationId = `${scope.accountId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.controller.markGenerationStaged(generationId);
    const files: Record<string, string> = {};
    const successfulById = new Map<string, ProjectedMemory>();
    const successfulIds: string[] = [];
    try {
      for (const memoryId of rotationMemoryIds) {
        const projection = projectedById.get(memoryId);
        if (!projection) continue;
        const image = projection.image;
        const url = image ? signedUrls[image.key] : undefined;
        if (image && url) {
          try {
            // Repeated daytime slots reuse one staged file. With seven
            // selected IDs this keeps both cache bytes and native retained
            // IDs within the existing seven-item budget.
            if (!files[image.filename]) {
              const staged = await this.dependencies.stageImage(
                generationId,
                { filename: image.filename, url } satisfies WidgetImageToStage,
                { signal },
              );
              files[staged.filename] = staged.uri;
            }
          } catch {
            // An unavailable image is replaced by a different successful
            // image below; the journal memory itself remains untouched.
          }
          if (files[image.filename]) {
            successfulById.set(memoryId, projection);
            successfulIds.push(memoryId);
          }
        }
        if (!this.controller.isCurrent(epoch) || signal.aborted) {
          await this.controller.cleanupGeneration(generationId);
          return { published: false, cleared: false, reason: 'superseded' };
        }
      }

      if (successfulIds.length === 0) {
        await this.controller.cleanupGeneration(generationId);
        const published = await this.controller.publish(
          scope, neutralWidgetManifest(scope, new Date(syncStartedAt)), {}, epoch,
        );
        return { published, cleared: false, ...(published ? {} : { reason: 'superseded' as const }) };
      }
      // Keep every scheduled boundary while replacing failures with a
      // successful staged image. Rotate fallback IDs so two surviving images
      // can never appear consecutively, including at the cycle boundary.
      let fallbackCursor = 0;
      let previousDisplayedId: string | undefined;
      const completeEntries: WidgetManifestEntry[] = timeline.entries.map((slot) => {
        const preferredId = slot.memoryId;
        let selectedId = preferredId;
        if (
          !successfulById.has(selectedId)
          || (successfulIds.length > 1 && selectedId === previousDisplayedId)
        ) {
          for (let offset = 0; offset < successfulIds.length; offset += 1) {
            const index = (fallbackCursor + offset) % successfulIds.length;
            const candidateId = successfulIds[index];
            if (successfulIds.length === 1 || candidateId !== previousDisplayedId) {
              selectedId = candidateId;
              fallbackCursor = (index + 1) % successfulIds.length;
              break;
            }
          }
        } else {
          fallbackCursor = (successfulIds.indexOf(selectedId) + 1) % successfulIds.length;
        }
        const projection = successfulById.get(selectedId) ?? successfulById.get(successfulIds[0]);
        // successfulIds is non-empty, so this fallback is only for defensive
        // type narrowing if a future refactor changes the map construction.
        if (!projection) throw new Error('Widget staged image projection is missing');
        previousDisplayedId = selectedId;
        return {
          ...projection.entry,
          startsAt: slot.startsAt,
        };
      });

      const manifest: WidgetManifest = {
        schemaVersion: WIDGET_MANIFEST_SCHEMA_VERSION,
        accountId: scope.accountId,
        familyId: scope.familyId,
        generationId,
        verifiedAt: timeline.verifiedAt,
        expiresAt: timeline.expiresAt,
        timezone: timeline.timezoneName,
        entries: completeEntries,
      };
      const published = await this.controller.publish(scope, manifest, files, epoch);
      if (!published) {
        await this.controller.cleanupGeneration(generationId);
        return { published: false, cleared: false, reason: 'superseded' };
      }
      if (manualSeen && completeEntries[0]) {
        manualSeen.add(completeEntries[0].memoryId);
        this.manuallySeen.set(scopeKey(scope), manualSeen);
      }
      return { published: true, cleared: false };
    } catch (error) {
      await this.controller.cleanupGeneration(generationId);
      if (signal.aborted || !this.controller.isCurrent(epoch)) {
        return { published: false, cleared: false, reason: 'superseded' };
      }
      return {
        published: false,
        cleared: false,
        reason: error instanceof Error ? error.message : 'publish_failed',
      };
    }
  }
}

export interface UseMemoryWidgetSyncResult {
  isSupported: boolean;
  isLoading: boolean;
  manifest: WidgetManifest | null;
  syncNow: (options?: { showAnother?: boolean }) => Promise<MemoryWidgetSyncResult>;
  clear: () => Promise<void>;
}

function appStateIsActive(state: AppStateStatus | null): boolean {
  // React Native can report null briefly while the bridge is starting. Treat
  // that startup window as active so automatic preparation is not skipped
  // until a later foreground event; explicit background events still stop
  // sync work.
  return state === 'active' || state === null;
}

const coordinatorByAdapter = new WeakMap<object, MemoryWidgetSyncCoordinator>();

function coordinatorFor(adapter: WidgetNativeAdapter | null, _accountId: string | null, _familyId: string | null): MemoryWidgetSyncCoordinator | null {
  if (!adapter) return null;
  const existing = coordinatorByAdapter.get(adapter);
  if (existing) return existing;
  const created = new MemoryWidgetSyncCoordinator(adapter);
  coordinatorByAdapter.set(adapter, created);
  return created;
}

const MemoryWidgetSyncContext = createContext<UseMemoryWidgetSyncResult | null>(null);

function useMemoryWidgetSyncInternal(): UseMemoryWidgetSyncResult {
  const { user, isLoading: isAuthLoading } = useAuth();
  const { familyId, isLoading: isFamilyLoading, memberships } = useFamily();
  const { profile, isLoading: isProfileLoading } = useUserProfile();
  const queryClient = useQueryClient();
  const isOnline = useIsOnline();
  const adapter = useSyncExternalStore(subscribeAdapter, getAdapterSnapshot, getAdapterSnapshot);
  const [isAppActive, setIsAppActive] = useState(
    appStateIsActive(AppState.currentState as AppStateStatus | null),
  );
  const [manifest, setManifest] = useState<WidgetManifest | null>(null);
  const [isNativeAvailable, setIsNativeAvailable] = useState(false);
  const lastScopeRef = useRef<WidgetCacheScope | null>(null);
  const lastAdapterRef = useRef<WidgetNativeAdapter | null>(adapter);
  const syncTailRef = useRef<Promise<MemoryWidgetSyncResult>>(Promise.resolve({
    published: false,
    cleared: false,
  }));
  const currentScopeRef = useRef<WidgetCacheScope | null>(null);
  const lifecycleTokenRef = useRef(0);
  const canSyncRef = useRef(false);
  const bootClearedAdaptersRef = useRef(new WeakSet<object>());
  const deletionClearKeyRef = useRef<string | null>(null);

  const accountId = user && !user.is_anonymous ? user.id : null;
  const scope = useMemo(
    () => (accountId && familyId ? { accountId, familyId } : null),
    [accountId, familyId],
  );
  const coordinator = useMemo(
    () => coordinatorFor(adapter, accountId, familyId),
    [adapter, accountId, familyId],
  );
  useLayoutEffect(() => {
    currentScopeRef.current = scope;
    canSyncRef.current = !isAuthLoading && !isFamilyLoading && !isProfileLoading
      && !profile?.deleted_at && isOnline;
  }, [scope, isAuthLoading, isFamilyLoading, isProfileLoading, profile?.deleted_at, isOnline]);

  useEffect(() => {
    // Sweep once even when auth is still restoring or the device is signed
    // out. The shared promise keeps this housekeeping serialized with the
    // first generation publish.
    void ensureMemoryWidgetCacheSwept();
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      setIsAppActive(appStateIsActive(nextState));
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!adapter) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Mirror optional native adapter removal immediately.
      setIsNativeAvailable(false);
      return () => { cancelled = true; };
    }
    void Promise.resolve(adapter.available()).then((available) => {
      if (!cancelled) setIsNativeAvailable(available === true);
    }).catch(() => {
      if (!cancelled) setIsNativeAvailable(false);
    });
    return () => { cancelled = true; };
  }, [adapter]);

  useEffect(() => {
    // The provider can mount while signed out, so there may be no previous
    // React scope to compare. A shared device must start with a neutral native
    // snapshot in that case.
    if (isAuthLoading || accountId || !adapter || bootClearedAdaptersRef.current.has(adapter)) return;
    bootClearedAdaptersRef.current.add(adapter);
    void (coordinatorFor(adapter, null, null)?.clear() ?? Promise.resolve()).catch(() => undefined);
  }, [adapter, accountId, isAuthLoading]);

  useEffect(() => {
    // The widget is prepared automatically for the authenticated active
    // family. Reset the in-memory view while an account/family transition is
    // settling so a previous scope cannot appear in the new one.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Reset scoped native state after an identity transition.
    setManifest(null);
  }, [scope]);

  useEffect(() => {
    // A process restart has no previous React scope. Reconcile persisted native
    // content as well, including an offline login to a different account.
    if (!adapter || isAuthLoading || isFamilyLoading || isProfileLoading) return;
    let cancelled = false;
    void Promise.resolve(adapter.readManifest()).then(async (cached) => {
      if (cancelled || !cached) return;
      const cachedScope = { accountId: cached.accountId, familyId: cached.familyId };
      if (!scope || profile?.deleted_at || scopeKey(cachedScope) !== scopeKey(scope)) {
        await coordinatorFor(adapter, cached.accountId, cached.familyId)?.clear(cachedScope);
      }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [adapter, isAuthLoading, isFamilyLoading, isProfileLoading, profile?.deleted_at, scope]);

  useEffect(() => {
    if (!coordinator || !scope || !isNativeAvailable) return;
    let cancelled = false;
    void coordinator.read(scope).then((cached) => {
      if (!cancelled) setManifest(cached);
    });
    return () => { cancelled = true; };
  }, [coordinator, scope, isNativeAvailable]);

  // Account replacement (A -> B), sign-out, family switch, and membership
  // loss all use the previous scope, so a failed new sync cannot leave A's
  // private native snapshot visible to B.
  useEffect(() => {
    const previousScope = lastScopeRef.current;
    const previousAdapter = lastAdapterRef.current;
    const previousScopeKey = previousScope ? scopeKey(previousScope) : 'none';
    const nextScopeKey = scope ? scopeKey(scope) : 'none';
    if (previousScopeKey !== nextScopeKey || previousAdapter !== adapter) {
      lifecycleTokenRef.current += 1;
    }
    if (previousScope && (!scope || scopeKey(previousScope) !== scopeKey(scope))) {
      void (coordinatorFor(previousAdapter ?? adapter, previousScope.accountId, previousScope.familyId)
        ?.clear(previousScope) ?? Promise.resolve()).catch(() => undefined);
    }
    lastScopeRef.current = scope;
    lastAdapterRef.current = adapter;
  }, [adapter, scope]);

  useEffect(() => {
    if (!profile?.deleted_at || !scope) return;
    const key = scopeKey(scope);
    if (deletionClearKeyRef.current === key) return;
    deletionClearKeyRef.current = key;
    lifecycleTokenRef.current += 1;
    void (coordinatorFor(adapter, scope.accountId, scope.familyId)?.clear(scope) ?? Promise.resolve())
      .catch(() => undefined);
  }, [adapter, profile?.deleted_at, scope]);

  const enqueueSync = useCallback((
    targetScope: WidgetCacheScope,
    targetCoordinator: MemoryWidgetSyncCoordinator,
    token: number,
    options: { showAnother?: boolean } = {},
  ): Promise<MemoryWidgetSyncResult> => {
    syncTailRef.current = syncTailRef.current
      .catch(() => ({ published: false, cleared: false }))
      .then(() => {
        const current = currentScopeRef.current;
        if (
          token !== lifecycleTokenRef.current
          || !current
          || scopeKey(current) !== scopeKey(targetScope)
          || !canSyncRef.current
        ) {
          return { published: false, cleared: false, reason: 'superseded' };
        }
        return targetCoordinator.sync(targetScope, options);
      });
    return syncTailRef.current;
  }, []);

  useEffect(() => {
    if (!coordinator || !scope || !isNativeAvailable || !isOnline || !isAppActive) return;
    if (profile?.deleted_at || isAuthLoading || isFamilyLoading || isProfileLoading) return;
    if (memberships.length > 0 && !memberships.some((membership) => membership.familyId === scope.familyId)) return;
    const request = enqueueSync(scope, coordinator, lifecycleTokenRef.current);
    void request.then((result) => {
      if (result.published) void coordinator.read(scope).then(setManifest);
    });
  }, [coordinator, enqueueSync, scope, isNativeAvailable, isOnline, isAppActive, profile?.deleted_at, isAuthLoading, isFamilyLoading, isProfileLoading, memberships]);

  // Reconnect and successful mutations are deliberately app-wide. This
  // subscription does not inspect memory content and never blocks a mutation.
  useEffect(() => {
    if (!coordinator || !scope || !isNativeAvailable || !isOnline || !isAppActive) return;
    if (profile?.deleted_at || isAuthLoading || isFamilyLoading || isProfileLoading) return;
    if (memberships.length > 0 && !memberships.some((membership) => membership.familyId === scope.familyId)) return;
    const unsubscribe = queryClient.getMutationCache().subscribe((event) => {
      if (event.type !== 'updated' || event.mutation.state.status !== 'success') return;
      void enqueueSync(scope, coordinator, lifecycleTokenRef.current);
    });
    return unsubscribe;
  }, [coordinator, enqueueSync, queryClient, scope, isNativeAvailable, isOnline, isAppActive, profile?.deleted_at, isAuthLoading, isFamilyLoading, isProfileLoading, memberships]);

  const syncNow = useCallback(async (options: { showAnother?: boolean } = {}) => {
    if (
      !coordinator
      || !scope
      || !isNativeAvailable
      || !isOnline
    ) {
      return { published: false, cleared: false, reason: 'not_ready' };
    }
    return enqueueSync(scope, coordinator, lifecycleTokenRef.current, options);
  }, [coordinator, enqueueSync, scope, isNativeAvailable, isOnline]);

  const clear = useCallback(async () => {
    if (!scope) return;
    lifecycleTokenRef.current += 1;
    await coordinator?.clear(scope);
    setManifest(null);
  }, [coordinator, scope]);

  return {
    isSupported: isNativeAvailable,
    isLoading: isAuthLoading || isFamilyLoading || isProfileLoading,
    manifest,
    syncNow,
    clear,
  };
}

export function useMemoryWidgetSync(): UseMemoryWidgetSyncResult {
  const context = useContext(MemoryWidgetSyncContext);
  if (!context) {
    throw new Error('useMemoryWidgetSync must be used inside MemoryWidgetSyncProvider');
  }
  return context;
}

/** Mount once under AuthProvider/FamilyProvider in AppProviders. */
export function MemoryWidgetSyncProvider({ children }: { children: ReactNode }) {
  const value = useMemoryWidgetSyncInternal();
  return createElement(MemoryWidgetSyncContext.Provider, { value }, children);
}

/** Explicit lifecycle hook for deletion/leave flows that do not render a scope. */
export async function clearMemoryWidgetForScope(scope: WidgetCacheScope): Promise<void> {
  const adapter = getMemoryWidgetNativeAdapter();
  if (!adapter) return;
  const coordinator = coordinatorFor(adapter, scope.accountId, scope.familyId);
  await coordinator?.clear(scope);
}
