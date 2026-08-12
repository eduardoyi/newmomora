import AsyncStorage from '@react-native-async-storage/async-storage';

import { supabase } from '@/lib/supabase';
import type { MemoryWithTags, ServiceError } from '@/services/memories';

export const lookingBackPackageTypes = [
  'member_birthday',
  'on_this_day',
  'one_year_ago',
  'member_at_age',
  'members_together',
  'around_this_time',
  'emotion_archive',
  'month_archive',
  'written_archive',
  'archive_mix',
] as const;

export type LookingBackPackageType = (typeof lookingBackPackageTypes)[number];

export interface LookingBackPackageView {
  firstViewedAt: string | null;
  lastViewedAt: string | null;
  completedAt: string | null;
}

export interface LookingBackPackageMetadata {
  id: string;
  dailySetId: string;
  familyId: string;
  packageDate: string;
  packageType: LookingBackPackageType;
  subjectFamilyMemberId: string | null;
  secondarySubjectFamilyMemberId: string | null;
  displayKind: string;
  title: string;
  subtitle: string | null;
  era: string;
  tint: string | null;
  position: number;
  memoryIds: string[];
  view: LookingBackPackageView;
  refreshAfter: string;
}

export interface LookingBackPackage extends Omit<LookingBackPackageMetadata, 'memoryIds'> {
  memories: MemoryWithTags[];
}

export interface LookingBackPackageSet {
  dailySetId: string | null;
  packageDate: string | null;
  refreshAfter: string | null;
  packages: LookingBackPackageMetadata[];
}

export type LookingBackFetchFailure = 'authorization' | 'unavailable';

export interface LookingBackServiceResult<T> {
  data: T | null;
  error: ServiceError | null;
  failure: LookingBackFetchFailure | null;
}

interface LookingBackPackageRpcRow {
  daily_set_id: string | null;
  package_id: string | null;
  package_date: string | null;
  package_type: string | null;
  subject_family_member_id: string | null;
  secondary_subject_family_member_id: string | null;
  display_kind: string | null;
  display_title: string | null;
  display_subtitle: string | null;
  display_era: string | null;
  tint: string | null;
  position: number | null;
  memory_ids: string[] | null;
  first_viewed_at: string | null;
  last_viewed_at: string | null;
  completed_at: string | null;
  refresh_after: string | null;
}

export interface PendingLookingBackView {
  packageId: string;
  firstViewedAt: string;
  lastViewedAt: string;
  completedAt: string | null;
}

interface PendingLookingBackViewStorage {
  version: 1;
  entries: PendingLookingBackView[];
}

const PENDING_VIEW_KEY_PREFIX = 'momora.lookingBackPendingViews';
export const LOOKING_BACK_PENDING_VIEW_MAX_AGE_MS = 45 * 24 * 60 * 60 * 1000;
export const LOOKING_BACK_PENDING_VIEW_MAX_ENTRIES = 100;
const outboxLocks = new Map<string, Promise<void>>();

function isLookingBackPackageType(value: string | null): value is LookingBackPackageType {
  return Boolean(value && (lookingBackPackageTypes as readonly string[]).includes(value));
}

function mapSupabaseError(error: { message: string; code?: string }): ServiceError {
  return { message: error.message, code: error.code };
}

function failureForSupabaseError(error: { code?: string }): LookingBackFetchFailure {
  // Postgres insufficient_privilege and PostgREST's authenticated-policy
  // failure are genuine authorization outcomes. Everything else must quietly
  // collapse the optional rail, never become a Timeline error state.
  return error.code === '42501' || error.code === '28000' || error.code === 'PGRST301'
    ? 'authorization'
    : 'unavailable';
}

function toPackage(row: LookingBackPackageRpcRow): LookingBackPackageMetadata | null {
  if (
    !row.package_id ||
    !row.daily_set_id ||
    !row.package_date ||
    !isLookingBackPackageType(row.package_type) ||
    !row.display_kind ||
    !row.display_title ||
    !row.display_era ||
    row.position === null ||
    !row.refresh_after
  ) {
    return null;
  }

  return {
    id: row.package_id,
    dailySetId: row.daily_set_id,
    // The materialization response deliberately omits a redundant family id;
    // fetchLookingBackPackages attaches the caller-supplied family context.
    familyId: '',
    packageDate: row.package_date,
    packageType: row.package_type,
    subjectFamilyMemberId: row.subject_family_member_id,
    secondarySubjectFamilyMemberId: row.secondary_subject_family_member_id ?? null,
    displayKind: row.display_kind,
    title: row.display_title,
    subtitle: row.display_subtitle,
    era: row.display_era,
    tint: row.tint,
    position: row.position,
    memoryIds: row.memory_ids ?? [],
    view: {
      firstViewedAt: row.first_viewed_at,
      lastViewedAt: row.last_viewed_at,
      completedAt: row.completed_at,
    },
    refreshAfter: row.refresh_after,
  };
}

/** Materializes (or returns) the active family-local day's package set. */
export async function fetchLookingBackPackages(
  familyId: string,
): Promise<LookingBackServiceResult<LookingBackPackageSet>> {
  try {
    const { data, error } = await supabase.rpc('get_or_create_looking_back_packages', {
      p_family_id: familyId,
    });

    if (error) {
      return { data: null, error: mapSupabaseError(error), failure: failureForSupabaseError(error) };
    }

    if (!Array.isArray(data)) {
      return {
        data: null,
        error: { message: 'Looking Back packages returned an invalid response' },
        failure: 'unavailable',
      };
    }

    const first = data[0];
    const packages = data
      .map(toPackage)
      .filter((item): item is LookingBackPackageMetadata => item !== null)
      .map((item) => ({ ...item, familyId }))
      .sort((left, right) => left.position - right.position);

    return {
      data: {
        dailySetId: first?.daily_set_id ?? null,
        packageDate: first?.package_date ?? null,
        refreshAfter: first?.refresh_after ?? null,
        packages,
      },
      error: null,
      failure: null,
    };
  } catch (error) {
    return {
      data: null,
      error: { message: error instanceof Error ? error.message : 'Could not load Looking Back packages' },
      failure: 'unavailable',
    };
  }
}

/** The server owns first/latest/completion timestamp semantics and upserts. */
export async function markLookingBackPackageViewed(
  packageId: string,
  completed = false,
): Promise<LookingBackServiceResult<LookingBackPackageView>> {
  try {
    const { data, error } = await supabase.rpc('mark_looking_back_package_viewed', {
      p_package_id: packageId,
      p_completed: completed,
    });

    if (error) {
      return { data: null, error: mapSupabaseError(error), failure: failureForSupabaseError(error) };
    }

    const row = data;

    return {
      data: {
        firstViewedAt: row?.first_viewed_at ?? null,
        lastViewedAt: row?.last_viewed_at ?? null,
        completedAt: row?.completed_at ?? null,
      },
      error: null,
      failure: null,
    };
  } catch (error) {
    return {
      data: null,
      error: { message: error instanceof Error ? error.message : 'Could not update Looking Back view' },
      failure: 'unavailable',
    };
  }
}

export function lookingBackPendingViewStorageKey(userId: string, familyId: string): string {
  return `${PENDING_VIEW_KEY_PREFIX}.${userId}.${familyId}`;
}

function earliest(first: string, second: string): string {
  return first <= second ? first : second;
}

function latest(first: string | null, second: string | null): string | null {
  if (!first) return second;
  if (!second) return first;
  return first >= second ? first : second;
}

async function readPendingViews(key: string): Promise<PendingLookingBackView[]> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<PendingLookingBackViewStorage>;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return [];

    return parsed.entries.filter((entry): entry is PendingLookingBackView => (
      Boolean(entry) &&
      typeof entry.packageId === 'string' &&
      typeof entry.firstViewedAt === 'string' &&
      typeof entry.lastViewedAt === 'string' &&
      (entry.completedAt === null || typeof entry.completedAt === 'string')
    ));
  } catch {
    // A corrupt personal outbox must not prevent the optional rediscovery UI
    // from loading. The next write replaces it with a valid envelope.
    return [];
  }
}

function prunePendingViews(entries: PendingLookingBackView[]): PendingLookingBackView[] {
  const oldestAllowed = Date.now() - LOOKING_BACK_PENDING_VIEW_MAX_AGE_MS;
  return entries
    .filter((entry) => {
      const lastViewedAt = Date.parse(entry.lastViewedAt);
      return !Number.isNaN(lastViewedAt) && lastViewedAt >= oldestAllowed;
    })
    .sort((left, right) => right.lastViewedAt.localeCompare(left.lastViewedAt))
    .slice(0, LOOKING_BACK_PENDING_VIEW_MAX_ENTRIES);
}

async function writePendingViews(key: string, entries: PendingLookingBackView[]): Promise<void> {
  if (entries.length === 0) {
    await AsyncStorage.removeItem(key);
    return;
  }

  const payload: PendingLookingBackViewStorage = { version: 1, entries };
  await AsyncStorage.setItem(key, JSON.stringify(payload));
}

function enqueueOutboxOperation<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = outboxLocks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  outboxLocks.set(key, next.then(() => undefined, () => undefined));
  return next;
}

export async function getPendingLookingBackViews(
  userId: string,
  familyId: string,
): Promise<PendingLookingBackView[]> {
  const key = lookingBackPendingViewStorageKey(userId, familyId);
  return enqueueOutboxOperation(key, async () => {
    const current = await readPendingViews(key);
    const pruned = prunePendingViews(current);
    if (pruned.length !== current.length) await writePendingViews(key, pruned);
    return pruned;
  });
}

/**
 * Writes the durable local fact before the optimistic query cache changes.
 * This lets a server refetch merge the local view back in if the device went
 * offline after the real frame became visible.
 */
export async function enqueuePendingLookingBackView(
  userId: string,
  familyId: string,
  packageId: string,
  options: { completed?: boolean; occurredAt?: string } = {},
): Promise<PendingLookingBackView> {
  const key = lookingBackPendingViewStorageKey(userId, familyId);
  const occurredAt = options.occurredAt ?? new Date().toISOString();

  return enqueueOutboxOperation(key, async () => {
    const current = prunePendingViews(await readPendingViews(key));
    const existing = current.find((entry) => entry.packageId === packageId);
    const next: PendingLookingBackView = existing
      ? {
          packageId,
          firstViewedAt: earliest(existing.firstViewedAt, occurredAt),
          lastViewedAt: latest(existing.lastViewedAt, occurredAt) ?? occurredAt,
          completedAt: options.completed ? latest(existing.completedAt, occurredAt) : existing.completedAt,
        }
      : {
          packageId,
          firstViewedAt: occurredAt,
          lastViewedAt: occurredAt,
          completedAt: options.completed ? occurredAt : null,
        };

    await writePendingViews(key, prunePendingViews([
      ...current.filter((entry) => entry.packageId !== packageId),
      next,
    ]));
    return next;
  });
}

/** Applies locally pending timestamps over a newly fetched server result. */
export function mergeLookingBackPendingViews<T extends { id: string; view: LookingBackPackageView }>(
  packages: readonly T[],
  pendingViews: readonly PendingLookingBackView[],
): T[] {
  const byPackageId = new Map(pendingViews.map((entry) => [entry.packageId, entry]));

  return packages.map((item) => {
    const pending = byPackageId.get(item.id);
    if (!pending) return item;

    return {
      ...item,
      view: {
        firstViewedAt: item.view.firstViewedAt
          ? earliest(item.view.firstViewedAt, pending.firstViewedAt)
          : pending.firstViewedAt,
        lastViewedAt: latest(item.view.lastViewedAt, pending.lastViewedAt),
        completedAt: latest(item.view.completedAt, pending.completedAt),
      },
    };
  });
}

export interface FlushLookingBackPendingViewsResult {
  acknowledgedPackageIds: string[];
  remainingPackageIds: string[];
}

/**
 * The view RPC is idempotent, so flushing after a lost response is safe. An
 * acknowledgement only removes the exact snapshot that was sent; a newer
 * event written while the request was in flight stays durable.
 */
export async function flushPendingLookingBackViews(
  userId: string,
  familyId: string,
): Promise<FlushLookingBackPendingViewsResult> {
  try {
    const key = lookingBackPendingViewStorageKey(userId, familyId);
    const snapshot = await enqueueOutboxOperation(key, async () => {
      const current = await readPendingViews(key);
      const pruned = prunePendingViews(current);
      if (pruned.length !== current.length) await writePendingViews(key, pruned);
      return pruned;
    });
    const acknowledged = new Set<string>();

    for (const entry of snapshot) {
      const result = await markLookingBackPackageViewed(entry.packageId, Boolean(entry.completedAt));
      if (result.data) acknowledged.add(entry.packageId);
    }

    const remaining = await enqueueOutboxOperation(key, async () => {
      const current = prunePendingViews(await readPendingViews(key));
      const snapshotById = new Map(snapshot.map((entry) => [entry.packageId, entry]));
      const next = current.filter((entry) => {
        const sent = snapshotById.get(entry.packageId);
        if (!sent || !acknowledged.has(entry.packageId)) return true;

        return entry.firstViewedAt !== sent.firstViewedAt ||
          entry.lastViewedAt !== sent.lastViewedAt ||
          entry.completedAt !== sent.completedAt;
      });
      await writePendingViews(key, next);
      return next;
    });

    return {
      acknowledgedPackageIds: [...acknowledged],
      remainingPackageIds: remaining.map((entry) => entry.packageId),
    };
  } catch {
    // A best-effort replay failure must not reject a Timeline/viewer effect.
    // Any entry that could not be acknowledged remains for the next trigger.
    return { acknowledgedPackageIds: [], remainingPackageIds: [] };
  }
}

export async function clearLookingBackPendingViews(userId: string, familyId: string): Promise<void> {
  const key = lookingBackPendingViewStorageKey(userId, familyId);
  await enqueueOutboxOperation(key, async () => {
    await AsyncStorage.removeItem(key);
  });
}

/** Used by the existing account/family-loss cache purge backstop. */
export async function clearAllLookingBackPendingViews(): Promise<void> {
  const keys = await AsyncStorage.getAllKeys();
  const lookingBackKeys = keys.filter((key) => key.startsWith(`${PENDING_VIEW_KEY_PREFIX}.`));
  if (lookingBackKeys.length > 0) {
    await AsyncStorage.multiRemove(lookingBackKeys);
  }
  for (const key of lookingBackKeys) outboxLocks.delete(key);
}
