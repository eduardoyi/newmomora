// Deliberately outside app/ -- see onboarding.kids.integration.test.tsx /
// no-family.test.tsx for why screen tests live here and import the screen
// via a relative path instead.
//
// S15b (2026-10-02): where the paywall's "Leave" lands. The owner stays
// signed in; "Keep going" re-runs the pitch (S14 -> S13 -> S15) for a
// first-time owner, straight to the resubscribe paywall for a lapsed one, and
// "Log out" is the explicit way to sign out. The aha card: the pending draft capture,
// else the family's newest saved memory; the illustration when neither.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import PausedScreen from '../../app/(onboarding)/paused';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { useOnboardingFlow } from '@/hooks/use-onboarding-flow';
import { useOnboardingKidPossessive } from '@/hooks/use-onboarding-kid-possessive';
import { useMediaUrl } from '@/hooks/useMediaUrls';
import { onboardingIncludedRoute, onboardingPaywallRouteForMode, onboardingWelcomeRoute } from '@/lib/onboarding-routes';
import { fetchMemoriesPage } from '@/services/memories';
import { createEmptyOnboardingDraft, type OnboardingDraft } from '@/utils/onboarding-progress';

jest.mock('expo-router', () => ({
  router: { replace: jest.fn(), push: jest.fn(), back: jest.fn() },
  useLocalSearchParams: jest.fn(),
}));

jest.mock('@/hooks/use-auth', () => ({
  useAuth: jest.fn(),
}));

jest.mock('@/hooks/use-onboarding-kid-possessive', () => ({
  useOnboardingKidPossessive: jest.fn(),
}));

jest.mock('@/hooks/use-onboarding-flow', () => ({
  useOnboardingFlow: jest.fn(),
}));

jest.mock('@/hooks/use-family', () => ({
  useFamily: jest.fn(),
}));

jest.mock('@/hooks/useMediaUrls', () => ({
  useMediaUrl: jest.fn(),
}));

jest.mock('@/services/memories', () => ({
  fetchMemoriesPage: jest.fn(),
}));

jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories cannot use ESM imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedUseLocalSearchParams = useLocalSearchParams as jest.Mock;
const mockedUseOnboardingKidPossessive = useOnboardingKidPossessive as jest.MockedFunction<
  typeof useOnboardingKidPossessive
>;
const mockedUseOnboardingFlow = useOnboardingFlow as jest.MockedFunction<typeof useOnboardingFlow>;
const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedUseMediaUrl = useMediaUrl as jest.MockedFunction<typeof useMediaUrl>;
const mockedFetchMemoriesPage = fetchMemoriesPage as jest.MockedFunction<typeof fetchMemoriesPage>;

function mockDraft(overrides: Partial<OnboardingDraft> = {}) {
  mockedUseOnboardingFlow.mockReturnValue({
    draft: { ...createEmptyOnboardingDraft('paywall'), ...overrides },
    isHydrated: true,
    patch: jest.fn(),
    clear: jest.fn(),
  });
}

function screenTree() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <SafeAreaProvider
        initialMetrics={{
          frame: { height: 844, width: 390, x: 0, y: 0 },
          insets: { bottom: 34, left: 0, right: 0, top: 47 },
        }}
      >
        <PausedScreen />
      </SafeAreaProvider>
    </QueryClientProvider>
  );
}

function renderScreen() {
  return render(screenTree());
}

describe('PausedScreen (S15b)', () => {
  const signOut = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    signOut.mockResolvedValue(undefined);
    mockedUseAuth.mockReturnValue({ signOut } as never);
    mockedUseLocalSearchParams.mockReturnValue({ mode: 'new-owner' });
    mockedUseOnboardingKidPossessive.mockReturnValue("Lila's");
    mockDraft();
    mockedUseFamily.mockReturnValue({ familyId: 'family-1' } as never);
    mockedUseMediaUrl.mockReturnValue({ url: null, isLoading: false, isError: false } as never);
    mockedFetchMemoriesPage.mockResolvedValue({ data: { memories: [], nextCursor: null }, error: null } as never);
  });

  it("names the kid's journal for one kid and says 'Your journal' for several", () => {
    const { getByText, rerender } = renderScreen();
    expect(getByText("Lila's journal is waiting for you.")).toBeTruthy();

    mockedUseOnboardingKidPossessive.mockReturnValue('their');
    rerender(screenTree());
    expect(getByText('Your journal is waiting for you.')).toBeTruthy();
  });

  it('"Keep going" re-runs the pitch from "what\'s included" for a first-time owner, without signing out', () => {
    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('onb-paused-keep-going-button'));

    expect(router.replace).toHaveBeenCalledWith(onboardingIncludedRoute);
    expect(signOut).not.toHaveBeenCalled();
  });

  it('"Keep going" takes a lapsed owner straight back to the resubscribe paywall', () => {
    mockedUseLocalSearchParams.mockReturnValue({ mode: 'resubscribe' });
    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('onb-paused-keep-going-button'));

    expect(router.replace).toHaveBeenCalledWith(onboardingPaywallRouteForMode('resubscribe'));
    expect(signOut).not.toHaveBeenCalled();
  });

  it('"Log out" signs out and returns to the welcome screen', async () => {
    const { getByTestId } = renderScreen();

    await act(async () => {
      fireEvent.press(getByTestId('onb-paused-log-out-link'));
    });

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith(onboardingWelcomeRoute);
  });

  it('shows a retryable error when signing out fails', async () => {
    signOut.mockRejectedValue(new Error('offline'));
    const { getByTestId } = renderScreen();

    await act(async () => {
      fireEvent.press(getByTestId('onb-paused-log-out-link'));
    });

    await waitFor(() => expect(getByTestId('onb-paused-error')).toBeTruthy());
    expect(router.replace).not.toHaveBeenCalled();
  });

  describe('the aha card', () => {
    it("shows the family's saved first memory when the local draft has been cleared", async () => {
      mockedFetchMemoriesPage.mockResolvedValue({
        data: {
          memories: [
            {
              id: 'memory-1',
              content: 'She narrated the whole bath in a tiny robot voice.',
              memory_date: '2026-10-01',
              mediaAssets: [],
              taggedMembers: [{ id: 'member-lila', name: 'Lila' }],
            },
          ],
          nextCursor: null,
        },
        error: null,
      } as never);
      const { getByTestId, getByText, queryByTestId } = renderScreen();

      await waitFor(() => expect(getByTestId('onb-paused-memory-card')).toBeTruthy());
      expect(getByText('She narrated the whole bath in a tiny robot voice.')).toBeTruthy();
      expect(getByText('your first page, safe and sound')).toBeTruthy();
      expect(queryByTestId('onb-paused-illustration')).toBeNull();
      expect(mockedFetchMemoriesPage).toHaveBeenCalledWith('family-1', { limit: 1 });
    });

    it('uses a still-pending draft capture without fetching', () => {
      mockDraft({ kidNames: ['Lila'], capture: { text: 'Puddle jumping in the good boots.', taggedKidIndexes: [0] } });
      const { getByTestId, getByText } = renderScreen();

      expect(getByTestId('onb-paused-memory-card')).toBeTruthy();
      expect(getByText('Puddle jumping in the good boots.')).toBeTruthy();
      expect(mockedFetchMemoriesPage).not.toHaveBeenCalled();
    });

    it('shows a saved photo through its signed preview URL', async () => {
      mockedFetchMemoriesPage.mockResolvedValue({
        data: {
          memories: [
            {
              id: 'memory-1',
              content: 'First time on the big slide.',
              memory_date: '2026-10-01',
              mediaAssets: [
                {
                  object_key: 'media/original.jpg',
                  preview_object_key: 'media/preview.jpg',
                  content_type: 'image/jpeg',
                  duration_ms: null,
                },
              ],
              taggedMembers: [],
            },
          ],
          nextCursor: null,
        },
        error: null,
      } as never);
      mockedUseMediaUrl.mockImplementation(
        (key) => ({ url: key === 'media/preview.jpg' ? 'https://example.com/preview.jpg' : null }) as never,
      );
      const { getByTestId } = renderScreen();

      await waitFor(() =>
        expect([getByTestId('onb-paused-memory-media-image').props.source].flat()).toEqual([
          { uri: 'https://example.com/preview.jpg' },
        ]),
      );
    });

    it('falls back to the illustration when there is no memory to show', async () => {
      const { getByTestId, queryByTestId } = renderScreen();

      await waitFor(() => expect(mockedFetchMemoriesPage).toHaveBeenCalled());
      expect(getByTestId('onb-paused-illustration')).toBeTruthy();
      expect(queryByTestId('onb-paused-memory-card')).toBeNull();
    });
  });
});
