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
