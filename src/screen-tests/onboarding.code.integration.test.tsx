// Deliberately outside app/ -- see onboarding.kids.integration.test.tsx /
// no-family.test.tsx for why screen tests live here and import the screen
// via a relative path instead.
//
// Covers WP2's S12B (docs/plans/onboarding-implementation.md), specifically
// the membership-query invalidation fix: commitOnboarding creates/resolves
// the family through direct service calls, not a query-invalidating
// mutation, so FamilyProvider's cached membership list
// (src/hooks/use-family.tsx) could otherwise still read empty for a
// brand-new owner arriving at their own journal for the first time --
// app/(app)/_layout.tsx's no-family guard would bounce them. This asserts
// the fix lives at the source: code.tsx invalidates the memberships query,
// awaited, before navigating away, on every successful commit branch.
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { router } from 'expo-router';
import { KeyboardController } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import OnboardingCodeScreen from '../../app/(onboarding)/code';
import { useAuth } from '@/hooks/use-auth';
import { familyMembershipsQueryKey, useFamily } from '@/hooks/use-family';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { usePendingMemoryUploads } from '@/hooks/use-pending-memory-uploads';
import { onboardingTrialRoute } from '@/lib/onboarding-routes';
import { timelineRoute } from '@/lib/routes';
import { commitOnboarding } from '@/services/onboarding';
import { createEmptyOnboardingDraft } from '@/utils/onboarding-progress';
import { getPendingInviteCode } from '@/utils/pending-invite-code';

jest.mock('expo-router', () => ({
  router: { replace: jest.fn(), push: jest.fn(), back: jest.fn() },
  useLocalSearchParams: jest.fn(() => ({ email: 'sam@rivera.family' })),
}));

jest.mock('@/hooks/use-auth', () => ({
  useAuth: jest.fn(),
}));

jest.mock('@/hooks/use-family', () => ({
  // Real value (not a mock) -- this suite asserts invalidation targets this
  // exact key, so it must be the same reference/shape the real hook exports.
  familyMembershipsQueryKey: ['family-memberships'],
  useFamily: jest.fn(),
}));

jest.mock('@/hooks/use-onboarding-flow', () => ({
  useOnboardingFlow: jest.fn(),
}));

jest.mock('@/hooks/use-pending-memory-uploads', () => ({
  usePendingMemoryUploads: jest.fn(),
}));

jest.mock('@/services/onboarding', () => ({
  commitOnboarding: jest.fn(),
}));

jest.mock('@/utils/pending-invite-code', () => ({
  getPendingInviteCode: jest.fn(),
}));

// createEmptyOnboardingDraft lives in the same module as the real
// AsyncStorage-backed persistence helpers (src/utils/onboarding-progress.ts)
// -- swap in the maintained mock so importing it doesn't pull in the native
// module under Jest (same pattern as onboarding.paywall.integration.test.tsx).
jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories cannot use ESM imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedUseOnboardingFlow = useOnboardingFlow as jest.MockedFunction<typeof useOnboardingFlow>;
const mockedUsePendingMemoryUploads = usePendingMemoryUploads as jest.MockedFunction<typeof usePendingMemoryUploads>;
const mockedCommitOnboarding = commitOnboarding as jest.MockedFunction<typeof commitOnboarding>;
const mockedGetPendingInviteCode = getPendingInviteCode as jest.MockedFunction<typeof getPendingInviteCode>;

function renderScreen(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <SafeAreaProvider
        initialMetrics={{
          frame: { height: 844, width: 390, x: 0, y: 0 },
          insets: { bottom: 34, left: 0, right: 0, top: 47 },
        }}
      >
        <OnboardingCodeScreen />
      </SafeAreaProvider>
    </QueryClientProvider>,
  );
}

describe('OnboardingCodeScreen (S12B) -- membership query invalidation', () => {
  const verifyOtp = jest.fn().mockResolvedValue({ error: null });
  const clear = jest.fn().mockResolvedValue(undefined);
  const enqueue = jest.fn();
  const refetchMemberships = jest.fn().mockResolvedValue([]);

  beforeEach(() => {
    jest.clearAllMocks();
    verifyOtp.mockResolvedValue({ error: null });
    clear.mockResolvedValue(undefined);
    refetchMemberships.mockResolvedValue([]);

    mockedUseAuth.mockReturnValue({
      session: null,
      user: null,
      isLoading: false,
      requestSignInOtp: jest.fn(),
      requestSignUpOtp: jest.fn().mockResolvedValue({ error: null }),
      verifyOtp,
      signInWithPassword: jest.fn(),
      signOut: jest.fn(),
    } as never);
    mockedUseOnboardingFlow.mockReturnValue({
      draft: createEmptyOnboardingDraft('code'),
      isHydrated: true,
      patch: jest.fn(),
      clear,
    });
    mockedUsePendingMemoryUploads.mockReturnValue({
      enqueue,
      retry: jest.fn(),
      discard: jest.fn(),
      uploads: [],
    });
    mockedUseFamily.mockReturnValue({
      family: null,
      familyId: null,
      role: null,
      memberships: [],
      isLoading: false,
      setActiveFamily: jest.fn(),
      refetchMemberships,
      justLostAccess: false,
    } as never);
    mockedGetPendingInviteCode.mockResolvedValue(null);
  });

  it('hides the OTP field with opacity as well as color -- color alone does not reliably hide TextInput text on Android', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = renderScreen(queryClient);
    const input = screen.getByTestId('onboarding-code-input');

    expect(input.props.accessibilityLabel).toBe('Verification code');
    expect(input.props.accessibilityHint).toBe('Enter the six digits from your email.');
    expect(input.props.caretHidden).toBe(true);
    expect(input.props.cursorColor).toBe('transparent');
    expect(input.props.style).toEqual(expect.objectContaining({ color: 'transparent', opacity: 0 }));
  });

  it('checks the keyboard state when the OTP boxes are tapped again', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = renderScreen(queryClient);

    fireEvent.press(screen.getByTestId('onboarding-code-input-target'));

    expect(KeyboardController.isVisible).toHaveBeenCalled();
  });

  it('invalidates the memberships query before navigating a brand-new owner into S13', async () => {
    mockedCommitOnboarding.mockResolvedValue({
      data: { familyId: 'family-1', memoryId: 'memory-1', isNewFamily: true, pendingMediaUpload: null },
      error: null,
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const screen = renderScreen(queryClient);
    fireEvent.changeText(screen.getByTestId('onboarding-code-input'), '123456');

    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith(onboardingTrialRoute);
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: familyMembershipsQueryKey });

    // Ordering matters here (unlike the usual fire-and-forget invalidation):
    // the very next screen's layout reads this state, so the invalidation
    // must be awaited before navigation, not just eventually called.
    const invalidateOrder = invalidateSpy.mock.invocationCallOrder[0];
    const navigateOrder = (router.replace as jest.Mock).mock.invocationCallOrder[0];
    expect(invalidateOrder).toBeLessThan(navigateOrder);
  });

  it('invalidates the memberships query for a returning owner too, before routing via resolvePostAuthDestination', async () => {
    mockedCommitOnboarding.mockResolvedValue({
      data: { familyId: 'family-existing', memoryId: 'memory-1', isNewFamily: false, pendingMediaUpload: null },
      error: null,
    });
    refetchMemberships.mockResolvedValue([
      { id: 'membership-1', familyId: 'family-existing', role: 'owner', name: 'Our Family' },
    ]);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const screen = renderScreen(queryClient);
    fireEvent.changeText(screen.getByTestId('onboarding-code-input'), '123456');

    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith(timelineRoute);
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: familyMembershipsQueryKey });

    const invalidateOrder = invalidateSpy.mock.invocationCallOrder[0];
    const navigateOrder = (router.replace as jest.Mock).mock.invocationCallOrder[0];
    expect(invalidateOrder).toBeLessThan(navigateOrder);
  });

  it('does not invalidate anything when commitOnboarding fails', async () => {
    mockedCommitOnboarding.mockResolvedValue({
      data: null,
      error: { message: 'Could not finish setting up your journal. Please try again.' },
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const screen = renderScreen(queryClient);
    fireEvent.changeText(screen.getByTestId('onboarding-code-input'), '123456');

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-code-error')).toBeTruthy();
    });

    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalledWith(onboardingTrialRoute);
    expect(router.replace).not.toHaveBeenCalledWith(timelineRoute);
  });

  // Bug fix: commitOnboarding can fail *after* it has already confirmed the
  // signed-in user owns a real, existing family (the returning-owner
  // branch, decision 18) -- e.g. the memory failed to save. Previously this
  // showed the same dead-end red error + "Try again" as a genuinely new
  // owner's failure, stranding an already-verified returning owner on this
  // screen. The account and family are real, so this must route them into
  // their journal instead.
  it('routes a returning owner straight to their journal, with no red error, when commitOnboarding fails after finding their existing family', async () => {
    mockedCommitOnboarding.mockResolvedValue({
      data: null,
      error: { message: 'Could not save your memory. Please try again.' },
      existingFamilyId: 'family-existing',
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const screen = renderScreen(queryClient);
    fireEvent.changeText(screen.getByTestId('onboarding-code-input'), '123456');

    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith(timelineRoute);
    });

    expect(clear).toHaveBeenCalled();
    expect(screen.queryByTestId('onboarding-code-error')).toBeNull();
    expect(screen.queryByTestId('onboarding-code-retry')).toBeNull();
  });

  // Bug fix (the closure-staleness half): finishAfterCommit's async chain
  // is created on the render right before the code is submitted --
  // necessarily pre-auth, so a plain destructured `enqueue` closure stays
  // bound to that stale (pre-auth) snapshot for the whole call. Asserting
  // the *current* `enqueue` mock is invoked (not some earlier throwaway
  // closure) proves the screen reads it fresh via a ref rather than
  // capturing it once at the top of the render. Ordering also matters: the
  // enqueue call must come after the membership invalidation, since
  // usePendingMemoryUploads().enqueue's own user/family guard reads
  // FamilyProvider's React state, which has no way to know about a
  // brand-new family until that invalidation resolves.
  it('enqueues a pending media capture only after the membership invalidation resolves', async () => {
    const pendingMediaUpload = {
      memoryId: 'memory-1',
      mediaAssets: [{ fileUri: 'file:///photo.jpg', contentType: 'image/jpeg' }],
      content: 'Garbage truck fan club.',
      memoryDate: '2026-07-30',
      taggedMemberIds: ['member-lila'],
    };
    mockedCommitOnboarding.mockResolvedValue({
      data: { familyId: 'family-1', memoryId: 'memory-1', isNewFamily: true, pendingMediaUpload },
      error: null,
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    const screen = renderScreen(queryClient);
    fireEvent.changeText(screen.getByTestId('onboarding-code-input'), '123456');

    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith(onboardingTrialRoute);
    });

    expect(enqueue).toHaveBeenCalledWith(pendingMediaUpload);

    const invalidateOrder = invalidateSpy.mock.invocationCallOrder[0];
    const enqueueOrder = enqueue.mock.invocationCallOrder[0];
    expect(invalidateOrder).toBeLessThan(enqueueOrder);
  });
});
