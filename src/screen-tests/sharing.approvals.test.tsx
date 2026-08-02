// See no-family.test.tsx for why screen tests live outside app/.
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import ApprovalsScreen from '../../app/(app)/sharing/approvals';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { useFamilyInvites } from '@/hooks/useFamilyInvites';
import { trackEvent } from '@/services/analytics';
import { fetchInviteRedeemer, resolveFamilyInvite } from '@/services/invites';
import type { FamilyInvite } from '@/services/invites';

jest.mock('expo-router', () => ({
  router: {
    back: jest.fn(),
  },
}));

jest.mock('@/hooks/use-auth', () => ({
  useAuth: jest.fn(),
}));

jest.mock('@/hooks/use-family', () => ({
  useFamily: jest.fn(),
}));

jest.mock('@/hooks/useFamilyInvites', () => ({
  useFamilyInvites: jest.fn(),
}));

jest.mock('@/services/invites', () => ({
  fetchInviteRedeemer: jest.fn(),
  resolveFamilyInvite: jest.fn(),
}));

jest.mock('@/services/analytics', () => ({
  trackEvent: jest.fn(),
}));

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedUseFamilyInvites = useFamilyInvites as jest.MockedFunction<typeof useFamilyInvites>;
const mockedFetchRedeemer = fetchInviteRedeemer as jest.MockedFunction<typeof fetchInviteRedeemer>;
const mockedResolveInvite = resolveFamilyInvite as jest.MockedFunction<typeof resolveFamilyInvite>;
const mockedTrackEvent = trackEvent as jest.MockedFunction<typeof trackEvent>;

const PENDING_INVITE = {
  id: 'invite-1',
  family_id: 'family-1',
  role: 'viewer',
  code: 'sunny-tiger-lake',
  status: 'redeemed',
} as FamilyInvite;

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <QueryClientProvider client={queryClient}>
        <ApprovalsScreen />
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
}

describe('ApprovalsScreen -- invite_resolved analytics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedUseAuth.mockReturnValue({ user: { id: 'user-1' } } as never);
    mockedUseFamily.mockReturnValue({ familyId: 'family-1', role: 'owner' } as never);
    mockedUseFamilyInvites.mockReturnValue({
      redeemedInvites: [PENDING_INVITE],
      isLoading: false,
    } as never);
    mockedFetchRedeemer.mockResolvedValue({
      data: { name: 'Jamie', email: 'jamie@example.com' } as never,
      error: null,
    });
  });

  it('reports invite_resolved({outcome: approved, family_id}) when an invite is approved', async () => {
    mockedResolveInvite.mockResolvedValue({ data: { success: true, status: 'approved' }, error: null });

    const { getByTestId } = renderScreen();

    await waitFor(() => expect(getByTestId('approval-invite-1-approve')).toBeTruthy());
    fireEvent.press(getByTestId('approval-invite-1-approve'));

    await waitFor(() => {
      expect(mockedTrackEvent).toHaveBeenCalledWith('invite_resolved', {
        outcome: 'approved',
        family_id: 'family-1',
      });
    });
  });

  it('reports invite_resolved({outcome: rejected, family_id}) when an invite is rejected', async () => {
    mockedResolveInvite.mockResolvedValue({ data: { success: true, status: 'rejected' }, error: null });

    const { getByTestId } = renderScreen();

    await waitFor(() => expect(getByTestId('approval-invite-1-reject')).toBeTruthy());
    fireEvent.press(getByTestId('approval-invite-1-reject'));

    await waitFor(() => {
      expect(mockedTrackEvent).toHaveBeenCalledWith('invite_resolved', {
        outcome: 'rejected',
        family_id: 'family-1',
      });
    });
  });

  it('does not report invite_resolved when the resolve call fails', async () => {
    mockedResolveInvite.mockResolvedValue({ data: null, error: { message: 'Could not resolve the invite' } });

    const { getByTestId, findByText } = renderScreen();

    await waitFor(() => expect(getByTestId('approval-invite-1-approve')).toBeTruthy());
    fireEvent.press(getByTestId('approval-invite-1-approve'));

    expect(await findByText('Could not resolve the invite')).toBeTruthy();
    expect(mockedTrackEvent).not.toHaveBeenCalled();
  });
});
