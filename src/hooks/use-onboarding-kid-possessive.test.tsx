// Focused coverage for the shared S14/S15 personalization resolver
// (see the hook's own doc comment for the full bug story). Exercises the
// priority order directly against mocked useOnboardingFlow/useFamilyMembers
// -- the two screens' own integration tests
// (onboarding.included.integration.test.tsx,
// onboarding.paywall.integration.test.tsx) cover the draft-first path
// end-to-end through real rendered screens; the real-server-data fallback
// this hook exists for is proven with unmocked draft state in
// onboarding.post-commit-real-data.integration.test.tsx.
import { renderHook } from '@testing-library/react-native';

import { useOnboardingKidPossessive } from '@/hooks/use-onboarding-kid-possessive';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { createEmptyOnboardingDraft, type OnboardingDraft } from '@/utils/onboarding-progress';

jest.mock('@/hooks/use-onboarding-flow', () => ({
  useOnboardingFlow: jest.fn(),
}));

jest.mock('@/hooks/useFamilyMembers', () => ({
  useFamilyMembers: jest.fn(),
}));

jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories cannot use ESM imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const mockedUseOnboardingFlow = useOnboardingFlow as jest.MockedFunction<typeof useOnboardingFlow>;
const mockedUseFamilyMembers = useFamilyMembers as jest.MockedFunction<typeof useFamilyMembers>;

function mockDraft(overrides: Partial<OnboardingDraft>) {
  mockedUseOnboardingFlow.mockReturnValue({
    draft: { ...createEmptyOnboardingDraft(), ...overrides },
    isHydrated: true,
    patch: jest.fn(),
    clear: jest.fn(),
  });
}

function mockMembers(members: { id: string; name: string }[]) {
  mockedUseFamilyMembers.mockReturnValue({
    members,
    isLoading: false,
  } as unknown as ReturnType<typeof useFamilyMembers>);
}

describe('useOnboardingKidPossessive', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves the single tagged kid from the draft', () => {
    mockDraft({ kidNames: ['Lila', 'Miguel'], capture: { text: 'x', taggedKidIndexes: [1] } });
    mockMembers([]);

    const { result } = renderHook(() => useOnboardingKidPossessive());

    expect(result.current).toBe("Miguel's");
  });

  it('resolves a single-kid family with nothing tagged yet from the draft', () => {
    mockDraft({ kidNames: ['Teo'], capture: null });
    mockMembers([]);

    const { result } = renderHook(() => useOnboardingKidPossessive());

    expect(result.current).toBe("Teo's");
  });

  it('resolves "their" when several kids are tagged, without consulting server data', () => {
    mockDraft({ kidNames: ['Lila', 'Miguel'], capture: { text: 'x', taggedKidIndexes: [0, 1] } });
    mockMembers([{ id: 'm-1', name: 'ShouldNeverAppear' }]);

    const { result } = renderHook(() => useOnboardingKidPossessive());

    expect(result.current).toBe('their');
  });

  it('stays neutral for a multi-child family once the draft is empty (post-commit)', () => {
    mockDraft({ kidNames: [], capture: null });
    mockMembers([{ id: 'm-lila', name: 'Lila' }, { id: 'm-miguel', name: 'Miguel' }]);

    const { result } = renderHook(() => useOnboardingKidPossessive());

    // Device testing (2026-07-31): this used to return the first entry of
    // the tag-count-sorted list ("Lila's"), which rendered "Everything
    // Lila's journal comes with:" to a parent who had entered both kids --
    // the pick-a-favorite wound spec decision 8 exists to avoid. There is
    // no need to choose on these screens: the neutral phrase reads
    // correctly at any family size (and journalPossessive flavors it
    // "your" where a screen builds "{X} journal").
    expect(result.current).toBe('their');
  });

  it('resolves a single real family member unambiguously once the draft is empty', () => {
    mockDraft({ kidNames: [], capture: null });
    mockMembers([{ id: 'm-teo', name: 'Teo' }]);

    const { result } = renderHook(() => useOnboardingKidPossessive());

    expect(result.current).toBe("Teo's");
  });

  it('falls back to "their" when the draft is empty and no member data is available yet', () => {
    mockDraft({ kidNames: [], capture: null });
    mockMembers([]);

    const { result } = renderHook(() => useOnboardingKidPossessive());

    expect(result.current).toBe('their');
  });
});
