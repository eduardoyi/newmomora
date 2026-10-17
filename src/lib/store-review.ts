// App Store / Play review prompts (docs/features/app-review-prompt.md).
//
// expo-store-review ships a native module, so it only exists in store builds
// from 1.5.1 on. OTA updates still reach older binaries (1.5.0 / 1.4.x) that
// lack it, so the package is only required after its native module
// ('ExpoStoreReview') is confirmed present -- never imported at module scope.
// A missing module makes the native prompt a silent no-op; the static
// "Rate Momora" links (Linking only) work on every binary. Nothing here may
// throw to a caller.
//
// Store-policy rules: never ask a sentiment question near a review prompt or
// link, never ask for a specific rating, never offer an incentive, never gate
// a feature on reviewing, and never call the native prompt from a button tap
// (taps open the store's write-review page instead). Eligibility gates the
// prompt on a calm moment: 2+ active days (except the deliberate day-1 ask
// after a first illustration), no setback in the last 24h, and a 14-day
// cooldown. Analytics are content-free: closed enums only.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { AppState, Linking, Platform } from 'react-native';

import { trackEvent } from '@/services/analytics';

export type ReviewTrigger =
  | 'year_film'
  | 'looking_back'
  | 'illustration_reveal'
  | 'memory_milestone'
  | 'invite_approved';
export type ReviewLinkSource = 'settings' | 'year_film';

export const REVIEW_PROMPT_STORAGE_KEY = 'momora.reviewPrompt.v1';

const IOS_REVIEW_URL = 'https://apps.apple.com/app/id6745403572?action=write-review';
const ANDROID_REVIEW_URL = 'market://details?id=com.memora.app';
const ANDROID_REVIEW_WEB_URL = 'https://play.google.com/store/apps/details?id=com.memora.app';

const DAY_MS = 24 * 60 * 60 * 1000;
const SETBACK_WINDOW_MS = DAY_MS;
const COOLDOWN_MS = 14 * DAY_MS;
const MIN_ACTIVE_DAYS = 2;
const MAX_ACTIVE_DAYS_KEPT = 30;
const MEMORY_MILESTONES = [3, 10, 25, 50, 100, 200];

export interface ReviewPromptState {
  firstSeenAt?: number;
  /** Distinct local calendar days (YYYY-MM-DD) the app was active, oldest first, capped. */
  activeDays: string[];
  lastRequestedAt?: number;
  requestCount: number;
  lastSetbackAt?: number;
  savedMemoryCount: number;
}

type StoreReviewModule = typeof import('expo-store-review');

function createEmptyState(): ReviewPromptState {
  return { activeDays: [], requestCount: 0, savedMemoryCount: 0 };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeState(value: unknown): ReviewPromptState {
  if (!value || typeof value !== 'object') return createEmptyState();
  const candidate = value as Partial<ReviewPromptState>;
  return {
    firstSeenAt: isFiniteNumber(candidate.firstSeenAt) ? candidate.firstSeenAt : undefined,
    activeDays: Array.isArray(candidate.activeDays)
      ? candidate.activeDays.filter((day): day is string => typeof day === 'string')
      : [],
    lastRequestedAt: isFiniteNumber(candidate.lastRequestedAt) ? candidate.lastRequestedAt : undefined,
    requestCount: isFiniteNumber(candidate.requestCount) ? candidate.requestCount : 0,
    lastSetbackAt: isFiniteNumber(candidate.lastSetbackAt) ? candidate.lastSetbackAt : undefined,
    savedMemoryCount: isFiniteNumber(candidate.savedMemoryCount) ? candidate.savedMemoryCount : 0,
  };
}

async function loadState(): Promise<ReviewPromptState> {
  try {
    const stored = await AsyncStorage.getItem(REVIEW_PROMPT_STORAGE_KEY);
    return stored ? normalizeState(JSON.parse(stored)) : createEmptyState();
  } catch {
    // Storage hiccups or corrupt JSON degrade to a fresh state: the worst case
    // is a prompt that is a little early, which the OS rate-limits anyway.
    return createEmptyState();
  }
}

// Concurrent read-modify-write updates (an app-active tick racing a setback)
// must not clobber each other.
let storageMutationChain: Promise<void> = Promise.resolve();

function updateState<T = void>(mutate: (state: ReviewPromptState) => T): Promise<T | undefined> {
  const run = async (): Promise<T | undefined> => {
    try {
      const state = await loadState();
      const result = mutate(state);
      await AsyncStorage.setItem(REVIEW_PROMPT_STORAGE_KEY, JSON.stringify(state));
      return result;
    } catch {
      // Best-effort: a lost write only delays or advances a prompt.
      return undefined;
    }
  };
  const result = storageMutationChain.then(run, run);
  storageMutationChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function localDayKey(now: number): string {
  const date = new Date(now);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function getStoreReviewUrl(platform: string): string | null {
  if (platform === 'ios') return IOS_REVIEW_URL;
  if (platform === 'android') return ANDROID_REVIEW_URL;
  return null;
}

/**
 * PURE. Whether the native review prompt may be shown right now. `reason` is
 * for tests and debugging only -- it is never sent to analytics.
 */
export function evaluateReviewEligibility(
  state: ReviewPromptState,
  trigger: ReviewTrigger,
  now: number,
): { eligible: boolean; reason: string } {
  if (Platform.OS === 'web') return { eligible: false, reason: 'web' };
  if (state.lastSetbackAt !== undefined && now - state.lastSetbackAt < SETBACK_WINDOW_MS) {
    return { eligible: false, reason: 'recent_setback' };
  }
  if (state.lastRequestedAt !== undefined && now - state.lastRequestedAt < COOLDOWN_MS) {
    return { eligible: false, reason: 'cooldown' };
  }
  // The one deliberate day-1 ask: right after a user's first illustration.
  const isFirstIllustrationAsk =
    trigger === 'illustration_reveal' && state.requestCount === 0 && state.lastRequestedAt === undefined;
  if (!isFirstIllustrationAsk && state.activeDays.length < MIN_ACTIVE_DAYS) {
    return { eligible: false, reason: 'not_enough_active_days' };
  }
  return { eligible: true, reason: 'eligible' };
}

function getStoreReviewModule(): StoreReviewModule | null {
  try {
    if (Platform.OS === 'web' || !requireOptionalNativeModule('ExpoStoreReview')) return null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- must stay lazy (see top)
    return require('expo-store-review') as StoreReviewModule;
  } catch {
    return null;
  }
}

/**
 * Opens the store's write-review page. Safe from a button tap: it is a plain
 * link, not the native prompt. Counts toward the native prompt's cooldown so a
 * parent who just tapped Rate is not prompted again days later.
 */
export async function openStoreReviewPage(source: ReviewLinkSource): Promise<void> {
  try {
    const url = getStoreReviewUrl(Platform.OS);
    if (!url) return;
    try {
      await Linking.openURL(url);
    } catch {
      // market:// has no handler on devices without the Play Store app.
      if (Platform.OS !== 'android') return;
      await Linking.openURL(ANDROID_REVIEW_WEB_URL);
    }
    trackEvent('review_link_opened', { source });
    const now = Date.now();
    await updateState((state) => {
      state.lastRequestedAt = now;
    });
  } catch {
    // Nothing to do: the parent can tap again.
  }
}

/** Records the first-seen time and today's local calendar day (deduped, capped). */
export async function recordAppActiveDay(): Promise<void> {
  const now = Date.now();
  const today = localDayKey(now);
  await updateState((state) => {
    if (state.firstSeenAt === undefined) state.firstSeenAt = now;
    if (state.activeDays.includes(today)) return;
    state.activeDays = [...state.activeDays, today].slice(-MAX_ACTIVE_DAYS_KEPT);
  });
}

/** A save/illustration failure: no prompt for the next 24h. Fire-and-forget. */
export function noteReviewSetback(): void {
  const now = Date.now();
  void updateState((state) => {
    state.lastSetbackAt = now;
  });
}

let pendingPromptTimer: ReturnType<typeof setTimeout> | null = null;

async function runReviewRequest(trigger: ReviewTrigger): Promise<void> {
  try {
    if (AppState.currentState !== 'active') return;
    const now = Date.now();
    const state = await loadState();
    if (!evaluateReviewEligibility(state, trigger, now).eligible) return;
    const storeReview = getStoreReviewModule();
    if (!storeReview || !(await storeReview.isAvailableAsync())) return;
    await storeReview.requestReview();
    await updateState((current) => {
      current.lastRequestedAt = now;
      current.requestCount += 1;
    });
    trackEvent('review_prompt_requested', { trigger });
  } catch {
    // The prompt is a nicety; never surface a failure.
  }
}

/**
 * Asks for the native review prompt after a happy moment, once eligible. The
 * timer is module-level so it survives the calling screen unmounting; a newer
 * call replaces a pending one.
 */
export function requestReviewAfterMoment(trigger: ReviewTrigger, delayMs = 1000): void {
  if (pendingPromptTimer) clearTimeout(pendingPromptTimer);
  pendingPromptTimer = setTimeout(() => {
    pendingPromptTimer = null;
    void runReviewRequest(trigger);
  }, delayMs);
}

/** Counts a successfully saved memory and asks at count milestones. */
export async function recordMemorySavedForReview(): Promise<void> {
  const count = await updateState((state) => {
    state.savedMemoryCount += 1;
    return state.savedMemoryCount;
  });
  if (count !== undefined && MEMORY_MILESTONES.includes(count)) {
    requestReviewAfterMoment('memory_milestone', 1500);
  }
}
