import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  clearOnboardingDraft,
  createEmptyOnboardingDraft,
  getOnboardingDraft,
  ONBOARDING_DRAFT_STORAGE_KEY,
  patchOnboardingDraft,
  type OnboardingDraft,
} from '@/utils/onboarding-progress';

jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories cannot use ESM imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

describe('onboarding draft storage', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.restoreAllMocks();
  });

  it('returns null when nothing is stored', async () => {
    expect(await getOnboardingDraft()).toBeNull();
  });

  it('creates a fresh draft defaulting to the welcome step', () => {
    expect(createEmptyOnboardingDraft()).toEqual({
      version: 1,
      step: 'welcome',
      kidNames: [],
      familyName: '',
      capture: null,
      notificationChoice: null,
    });
  });

  it('creates a fresh draft at a given step', () => {
    expect(createEmptyOnboardingDraft('kids').step).toBe('kids');
  });

  it('patches and round-trips a draft', async () => {
    await patchOnboardingDraft({ step: 'kids', kidNames: ['Lila'] });
    const draft = await getOnboardingDraft();

    expect(draft).toEqual({
      version: 1,
      step: 'kids',
      kidNames: ['Lila'],
      familyName: '',
      capture: null,
      notificationChoice: null,
    });
  });

  it('merges successive patches onto the existing draft', async () => {
    await patchOnboardingDraft({ step: 'kids', kidNames: ['Lila'] });
    await patchOnboardingDraft({ step: 'family-name', familyName: "Lila's Family" });
    const draft = await getOnboardingDraft();

    expect(draft?.kidNames).toEqual(['Lila']);
    expect(draft?.familyName).toBe("Lila's Family");
    expect(draft?.step).toBe('family-name');
  });

  it('persists the capture payload without a media uri when none is captured', async () => {
    await patchOnboardingDraft({
      step: 'capture',
      capture: { text: 'Said something funny.', taggedKidIndexes: [0] },
    });
    const draft = await getOnboardingDraft();

    expect(draft?.capture).toEqual({ text: 'Said something funny.', taggedKidIndexes: [0] });
  });

  it('round-trips the paywall resume mode', async () => {
    await patchOnboardingDraft({ step: 'paywall', paywallMode: 'resubscribe' });

    expect((await getOnboardingDraft())?.paywallMode).toBe('resubscribe');
  });

  it('treats an invalid paywall mode as an absent draft', async () => {
    await AsyncStorage.setItem(
      ONBOARDING_DRAFT_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        step: 'paywall',
        kidNames: [],
        familyName: '',
        capture: null,
        notificationChoice: null,
        paywallMode: 'unknown',
      }),
    );

    expect(await getOnboardingDraft()).toBeNull();
  });

  // Regression coverage for the media-sizing bug: the aspect ratio (and, for
  // video, duration) captured alongside the media uri must round-trip
  // through the device-local draft the same as every other capture field.
  it('round-trips the captured media aspect ratio and duration', async () => {
    await patchOnboardingDraft({
      step: 'capture',
      capture: {
        text: 'Look at this.',
        mediaUri: 'file:///video.mov',
        mediaContentType: 'video/quicktime',
        mediaAspectRatio: 0.5625,
        mediaDurationMs: 4200,
        taggedKidIndexes: [0],
      },
    });
    const draft = await getOnboardingDraft();

    expect(draft?.capture).toEqual({
      text: 'Look at this.',
      mediaUri: 'file:///video.mov',
      mediaContentType: 'video/quicktime',
      mediaAspectRatio: 0.5625,
      mediaDurationMs: 4200,
      taggedKidIndexes: [0],
    });
  });

  // Backward-compat guarantee for the persisted, versioned draft shape:
  // ONBOARDING_DRAFT_VERSION did NOT bump when mediaAspectRatio/
  // mediaDurationMs were added, because isOnboardingDraftShape only
  // validates the draft's top-level fields (version/step/kidNames/
  // familyName) -- it never inspects `capture`'s internal shape. A draft
  // written by the shipped pre-fix version (capture with no aspect-ratio/
  // duration fields at all) must still load cleanly after the upgrade,
  // rather than being treated as a version mismatch and silently discarded.
  it('loads a pre-fix on-disk draft (capture missing mediaAspectRatio/mediaDurationMs) without discarding it', async () => {
    const preFixDraft = {
      version: 1,
      step: 'aha',
      kidNames: ['Lila'],
      familyName: "Lila's Family",
      capture: {
        text: 'Said something funny.',
        mediaUri: 'file:///photo.jpg',
        mediaContentType: 'image/jpeg',
        taggedKidIndexes: [0],
      },
      notificationChoice: null,
    };
    await AsyncStorage.setItem(ONBOARDING_DRAFT_STORAGE_KEY, JSON.stringify(preFixDraft));

    const draft = await getOnboardingDraft();

    expect(draft).toEqual(preFixDraft);
    expect(draft?.capture?.mediaAspectRatio).toBeUndefined();
    expect(draft?.capture?.mediaDurationMs).toBeUndefined();
  });

  it('clears the stored draft', async () => {
    await patchOnboardingDraft({ step: 'kids' });
    await clearOnboardingDraft();

    expect(await getOnboardingDraft()).toBeNull();
  });

  it('treats an unknown version as absent (forward-compat)', async () => {
    await AsyncStorage.setItem(
      ONBOARDING_DRAFT_STORAGE_KEY,
      JSON.stringify({ version: 2, step: 'kids', kidNames: [], familyName: '' }),
    );

    expect(await getOnboardingDraft()).toBeNull();
  });

  it('treats a malformed/corrupt value as absent', async () => {
    await AsyncStorage.setItem(ONBOARDING_DRAFT_STORAGE_KEY, 'not json{{{');

    expect(await getOnboardingDraft()).toBeNull();
  });

  it('treats a shape missing required fields as absent', async () => {
    await AsyncStorage.setItem(ONBOARDING_DRAFT_STORAGE_KEY, JSON.stringify({ version: 1 }));

    expect(await getOnboardingDraft()).toBeNull();
  });

  it('degrades to null when a storage read fails', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk on fire'));
    expect(await getOnboardingDraft()).toBeNull();
  });

  it('swallows storage write failures (patch is best-effort) and still returns the merged draft', async () => {
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk on fire'));

    const result = await patchOnboardingDraft({ step: 'kids', kidNames: ['Lila'] });

    expect(result.kidNames).toEqual(['Lila']);
  });

  it('starts from an empty draft when patching with nothing stored', async () => {
    const result: OnboardingDraft = await patchOnboardingDraft({ familyName: "Lila's Family" });

    expect(result.step).toBe('welcome');
    expect(result.familyName).toBe("Lila's Family");
  });
});
