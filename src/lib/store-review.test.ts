import AsyncStorage from '@react-native-async-storage/async-storage';
import { requireOptionalNativeModule } from 'expo-modules-core';
import * as StoreReview from 'expo-store-review';
import { AppState, Linking, Platform } from 'react-native';

import {
  evaluateReviewEligibility,
  getStoreReviewUrl,
  noteReviewSetback,
  openStoreReviewPage,
  recordAppActiveDay,
  recordMemorySavedForReview,
  requestReviewAfterMoment,
  REVIEW_PROMPT_STORAGE_KEY,
  type ReviewPromptState,
} from '@/lib/store-review';
import { trackEvent } from '@/services/analytics';

jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories cannot use ESM imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-modules-core', () => ({
  ...jest.requireActual('expo-modules-core'),
  requireOptionalNativeModule: jest.fn(),
}));
jest.mock('expo-store-review', () => ({
  isAvailableAsync: jest.fn(),
  requestReview: jest.fn(),
}));
jest.mock('@/services/analytics', () => ({ trackEvent: jest.fn() }));

const mockedRequireNative = requireOptionalNativeModule as jest.Mock;
const mockedIsAvailable = StoreReview.isAvailableAsync as jest.Mock;
const mockedRequestReview = StoreReview.requestReview as jest.Mock;
const mockedTrackEvent = trackEvent as jest.Mock;

const NOW = new Date('2026-10-17T12:00:00').getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

function makeState(overrides: Partial<ReviewPromptState> = {}): ReviewPromptState {
  return { activeDays: ['2026-10-15', '2026-10-16'], requestCount: 0, savedMemoryCount: 0, ...overrides };
}

async function readStored(): Promise<ReviewPromptState> {
  return JSON.parse((await AsyncStorage.getItem(REVIEW_PROMPT_STORAGE_KEY)) ?? '{}');
}

async function seedState(state: ReviewPromptState) {
  await AsyncStorage.setItem(REVIEW_PROMPT_STORAGE_KEY, JSON.stringify(state));
}

/** Fires the pending prompt timer and lets its async work settle. */
async function firePrompt(delayMs: number) {
  await jest.advanceTimersByTimeAsync(delayMs);
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

const originalPlatform = Platform.OS;

// The RN jest setup leaves AppState.currentState as a mock fn, not a string.
function setAppState(value: 'active' | 'background') {
  Object.defineProperty(AppState, 'currentState', { configurable: true, value });
}

beforeEach(async () => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  jest.setSystemTime(NOW);
  await AsyncStorage.clear();
  jest.clearAllMocks();
  Platform.OS = 'ios';
  mockedRequireNative.mockReturnValue({});
  mockedIsAvailable.mockResolvedValue(true);
  mockedRequestReview.mockResolvedValue(undefined);
  setAppState('active');
});

afterEach(() => {
  // Drop any pending module-level prompt timer between tests.
  jest.clearAllTimers();
  jest.restoreAllMocks();
  jest.useRealTimers();
  Platform.OS = originalPlatform;
});

describe('getStoreReviewUrl', () => {
  it('returns the write-review deep link per platform', () => {
    expect(getStoreReviewUrl('ios')).toBe('https://apps.apple.com/app/id6745403572?action=write-review');
    expect(getStoreReviewUrl('android')).toBe('market://details?id=com.memora.app');
  });

  it('returns null on web and unknown platforms', () => {
    expect(getStoreReviewUrl('web')).toBeNull();
    expect(getStoreReviewUrl('windows')).toBeNull();
  });
});

describe('evaluateReviewEligibility', () => {
  it('is eligible with 2 active days and a clean slate', () => {
    expect(evaluateReviewEligibility(makeState(), 'year_film', NOW)).toEqual({
      eligible: true,
      reason: 'eligible',
    });
  });

  it('is never eligible on web', () => {
    Platform.OS = 'web';
    expect(evaluateReviewEligibility(makeState(), 'year_film', NOW).eligible).toBe(false);
  });

  it('blocks for 24 hours after a setback, then allows', () => {
    const justUnder = makeState({ lastSetbackAt: NOW - DAY_MS + 1000 });
    const justOver = makeState({ lastSetbackAt: NOW - DAY_MS - 1000 });
    expect(evaluateReviewEligibility(justUnder, 'year_film', NOW)).toMatchObject({
      eligible: false,
      reason: 'recent_setback',
    });
    expect(evaluateReviewEligibility(justOver, 'year_film', NOW).eligible).toBe(true);
  });

  it('enforces a 14-day cooldown after a request', () => {
    const inside = makeState({ lastRequestedAt: NOW - 13 * DAY_MS, requestCount: 1 });
    const outside = makeState({ lastRequestedAt: NOW - 15 * DAY_MS, requestCount: 1 });
    expect(evaluateReviewEligibility(inside, 'looking_back', NOW)).toMatchObject({
      eligible: false,
      reason: 'cooldown',
    });
    expect(evaluateReviewEligibility(outside, 'looking_back', NOW).eligible).toBe(true);
  });

  it('requires 2 distinct active days', () => {
    const oneDay = makeState({ activeDays: ['2026-10-17'] });
    expect(evaluateReviewEligibility(oneDay, 'memory_milestone', NOW)).toMatchObject({
      eligible: false,
      reason: 'not_enough_active_days',
    });
  });

  it('lets the first illustration reveal ask on day 1, only if never requested', () => {
    const dayOne = makeState({ activeDays: ['2026-10-17'] });
    expect(evaluateReviewEligibility(dayOne, 'illustration_reveal', NOW).eligible).toBe(true);
    expect(
      evaluateReviewEligibility({ ...dayOne, requestCount: 1 }, 'illustration_reveal', NOW).eligible,
    ).toBe(false);
    // A Rate-link tap sets lastRequestedAt without a count: the exception is spent.
    expect(
      evaluateReviewEligibility(
        { ...dayOne, lastRequestedAt: NOW - 30 * DAY_MS },
        'illustration_reveal',
        NOW,
      ).eligible,
    ).toBe(false);
  });

  it('keeps the day-1 exception subject to the setback window', () => {
    const state = makeState({ activeDays: ['2026-10-17'], lastSetbackAt: NOW - 1000 });
    expect(evaluateReviewEligibility(state, 'illustration_reveal', NOW).eligible).toBe(false);
  });

  it('does not extend the day-1 exception to other triggers', () => {
    const dayOne = makeState({ activeDays: ['2026-10-17'] });
    expect(evaluateReviewEligibility(dayOne, 'year_film', NOW).eligible).toBe(false);
    expect(evaluateReviewEligibility(dayOne, 'invite_approved', NOW).eligible).toBe(false);
  });
});

describe('openStoreReviewPage', () => {
  it('opens the iOS write-review page, tracks, and starts the prompt cooldown', async () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);

    await openStoreReviewPage('settings');

    expect(openURL).toHaveBeenCalledWith('https://apps.apple.com/app/id6745403572?action=write-review');
    expect(mockedTrackEvent).toHaveBeenCalledWith('review_link_opened', { source: 'settings' });
    expect((await readStored()).lastRequestedAt).toBe(NOW);
    expect(mockedRequestReview).not.toHaveBeenCalled();
  });

  it('falls back to the Play web URL when market:// rejects on Android', async () => {
    Platform.OS = 'android';
    const openURL = jest
      .spyOn(Linking, 'openURL')
      .mockRejectedValueOnce(new Error('no handler'))
      .mockResolvedValueOnce(true);

    await openStoreReviewPage('year_film');

    expect(openURL).toHaveBeenNthCalledWith(1, 'market://details?id=com.memora.app');
    expect(openURL).toHaveBeenNthCalledWith(2, 'https://play.google.com/store/apps/details?id=com.memora.app');
    expect(mockedTrackEvent).toHaveBeenCalledWith('review_link_opened', { source: 'year_film' });
  });

  it('does nothing on web and never throws when opening fails', async () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('nope'));

    Platform.OS = 'web';
    await expect(openStoreReviewPage('settings')).resolves.toBeUndefined();
    expect(openURL).not.toHaveBeenCalled();

    Platform.OS = 'ios';
    await expect(openStoreReviewPage('settings')).resolves.toBeUndefined();
    expect(mockedTrackEvent).not.toHaveBeenCalled();
    expect((await readStored()).lastRequestedAt).toBeUndefined();
  });
});

describe('recordAppActiveDay', () => {
  it('records firstSeenAt once and dedupes the same calendar day', async () => {
    await recordAppActiveDay();
    jest.setSystemTime(NOW + 60 * 60 * 1000);
    await recordAppActiveDay();

    const stored = await readStored();
    expect(stored.activeDays).toEqual(['2026-10-17']);
    expect(stored.firstSeenAt).toBe(NOW);
  });

  it('adds a new local day and caps the list at 30', async () => {
    await seedState(
      makeState({
        activeDays: Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`),
      }),
    );

    await recordAppActiveDay();

    const { activeDays } = await readStored();
    expect(activeDays).toHaveLength(30);
    expect(activeDays[0]).toBe('2026-09-02');
    expect(activeDays[29]).toBe('2026-10-17');
  });

  it('does not clobber concurrent updates', async () => {
    await Promise.all([recordAppActiveDay(), recordMemorySavedForReview(), recordMemorySavedForReview()]);

    const stored = await readStored();
    expect(stored.activeDays).toEqual(['2026-10-17']);
    expect(stored.savedMemoryCount).toBe(2);
  });

  it('degrades to a fresh state on corrupt storage', async () => {
    await AsyncStorage.setItem(REVIEW_PROMPT_STORAGE_KEY, '{not json');
    await expect(recordAppActiveDay()).resolves.toBeUndefined();
    expect((await readStored()).activeDays).toEqual(['2026-10-17']);
  });
});

describe('noteReviewSetback', () => {
  it('records lastSetbackAt', async () => {
    noteReviewSetback();
    await jest.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    expect((await readStored()).lastSetbackAt).toBe(NOW);
  });
});

describe('recordMemorySavedForReview', () => {
  it('only requests a review on milestone counts', async () => {
    await seedState(makeState({ savedMemoryCount: 1 }));

    await recordMemorySavedForReview(); // 2
    await firePrompt(2000);
    expect(mockedRequestReview).not.toHaveBeenCalled();

    await recordMemorySavedForReview(); // 3 -- milestone
    await firePrompt(1500);
    expect(mockedRequestReview).toHaveBeenCalledTimes(1);
    expect(mockedTrackEvent).toHaveBeenCalledWith('review_prompt_requested', { trigger: 'memory_milestone' });

    await recordMemorySavedForReview(); // 4
    await firePrompt(2000);
    expect(mockedRequestReview).toHaveBeenCalledTimes(1);
    expect((await readStored()).savedMemoryCount).toBe(4);
  });
});

describe('requestReviewAfterMoment', () => {
  beforeEach(async () => {
    await seedState(makeState());
  });

  it('is a silent no-op when the native module is missing', async () => {
    mockedRequireNative.mockReturnValue(null);

    requestReviewAfterMoment('year_film', 800);
    await firePrompt(800);

    expect(mockedRequireNative).toHaveBeenCalledWith('ExpoStoreReview');
    expect(mockedRequestReview).not.toHaveBeenCalled();
    expect(mockedTrackEvent).not.toHaveBeenCalled();
    expect((await readStored()).requestCount).toBe(0);
  });

  it('requests, tracks, and records when the module is present and the user is eligible', async () => {
    requestReviewAfterMoment('year_film', 800);
    await firePrompt(799);
    expect(mockedRequestReview).not.toHaveBeenCalled();
    await firePrompt(1);

    expect(mockedRequestReview).toHaveBeenCalledTimes(1);
    expect(mockedTrackEvent).toHaveBeenCalledWith('review_prompt_requested', { trigger: 'year_film' });
    const stored = await readStored();
    expect(stored.requestCount).toBe(1);
    expect(stored.lastRequestedAt).toBe(NOW + 800);

    // Cooldown now blocks a second prompt.
    requestReviewAfterMoment('looking_back', 800);
    await firePrompt(800);
    expect(mockedRequestReview).toHaveBeenCalledTimes(1);
  });

  it('does not track or record when the store reports the prompt unavailable', async () => {
    mockedIsAvailable.mockResolvedValue(false);

    requestReviewAfterMoment('year_film', 800);
    await firePrompt(800);

    expect(mockedRequestReview).not.toHaveBeenCalled();
    expect(mockedTrackEvent).not.toHaveBeenCalled();
    expect((await readStored()).requestCount).toBe(0);
  });

  it('does not track or record when requestReview throws', async () => {
    mockedRequestReview.mockRejectedValue(new Error('boom'));

    requestReviewAfterMoment('year_film', 800);
    await firePrompt(800);

    expect(mockedTrackEvent).not.toHaveBeenCalled();
    expect((await readStored()).requestCount).toBe(0);
  });

  it('skips when the app is not active', async () => {
    setAppState('background');

    requestReviewAfterMoment('year_film', 800);
    await firePrompt(800);

    expect(mockedRequestReview).not.toHaveBeenCalled();
  });

  it('skips when ineligible (recent setback)', async () => {
    await seedState(makeState({ lastSetbackAt: NOW - 1000 }));

    requestReviewAfterMoment('year_film', 800);
    await firePrompt(800);

    expect(mockedRequestReview).not.toHaveBeenCalled();
  });

  it('lets a newer call replace a pending one', async () => {
    requestReviewAfterMoment('year_film', 800);
    await firePrompt(400);
    requestReviewAfterMoment('looking_back', 800);
    await firePrompt(400);
    expect(mockedRequestReview).not.toHaveBeenCalled();
    await firePrompt(400);

    expect(mockedRequestReview).toHaveBeenCalledTimes(1);
    expect(mockedTrackEvent).toHaveBeenCalledTimes(1);
    expect(mockedTrackEvent).toHaveBeenCalledWith('review_prompt_requested', { trigger: 'looking_back' });
  });
});
