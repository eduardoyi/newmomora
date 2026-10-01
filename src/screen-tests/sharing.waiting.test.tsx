// See no-family.test.tsx for why screen tests live outside app/.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import WaitingForApprovalScreen from '../../app/(app)/sharing/waiting';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { useRedeemedInviteStatus } from '@/hooks/useRedeemedInviteStatus';
import { timelineRoute, whosWhoSelfRoute } from '@/lib/routes';
import { shouldOfferWhosWhoAfterJoin } from '@/services/family-relationships';

jest.mock('expo-router', () => ({
  router: { replace: jest.fn(), push: jest.fn(), back: jest.fn() },
  useLocalSearchParams: () => ({ familyName: 'Rivera Family' }),
}));

jest.mock('@/hooks/use-auth', () => ({ useAuth: jest.fn() }));
jest.mock('@/hooks/use-family', () => ({ useFamily: jest.fn() }));
jest.mock('@/hooks/useUserProfile', () => ({ userProfileQueryKey: ['user-profile'] }));
jest.mock('@/hooks/useRedeemedInviteStatus', () => ({ useRedeemedInviteStatus: jest.fn() }));
jest.mock('@/services/family-relationships', () => ({ shouldOfferWhosWhoAfterJoin: jest.fn() }));

const mockedShouldOffer = shouldOfferWhosWhoAfterJoin as jest.MockedFunction<typeof shouldOfferWhosWhoAfterJoin>;

function renderScreen() {
  const queryClient = new QueryClient();
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <QueryClientProvider client={queryClient}>
        <WaitingForApprovalScreen />
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  (useAuth as jest.Mock).mockReturnValue({ user: { id: 'user-1' } });
  (useFamily as jest.Mock).mockReturnValue({
    familyId: 'family-old',
    memberships: [],
    refetchMemberships: jest
      .fn()
      .mockResolvedValue([{ id: 'm1', familyId: 'family-new', role: 'viewer', name: 'Rivera Family' }]),
    setActiveFamily: jest.fn().mockResolvedValue(undefined),
  });
  (useRedeemedInviteStatus as jest.Mock).mockReturnValue({
    outcome: { kind: 'approved', familyName: 'Rivera Family' },
    isLoading: false,
    isError: false,
  });
});

describe('WaitingForApprovalScreen approval routing', () => {
  it('skips Who\'s who when the helper says the account is already linked', async () => {
    mockedShouldOffer.mockResolvedValue(false);

    renderScreen();

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(timelineRoute));
    expect(mockedShouldOffer).toHaveBeenCalledWith('family-new', 'user-1');
  });

  it('routes to Who\'s who when it should be offered', async () => {
    mockedShouldOffer.mockResolvedValue(true);

    renderScreen();

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(whosWhoSelfRoute('timeline')));
  });
});
