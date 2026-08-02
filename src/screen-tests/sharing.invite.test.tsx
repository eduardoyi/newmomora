// See no-family.test.tsx for why screen tests live outside app/.
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { router } from 'expo-router';
import { Share } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import InviteFamilyMemberScreen from '../../app/(app)/sharing/invite';
import { useFamily } from '@/hooks/use-family';
import { sharingPendingInvitesRoute } from '@/lib/routes';
import { trackEvent } from '@/services/analytics';
import { createFamilyInvite } from '@/services/invites';

jest.mock('expo-router', () => ({
  router: {
    replace: jest.fn(),
    back: jest.fn(),
  },
}));

jest.mock('@/hooks/use-family', () => ({
  useFamily: jest.fn(),
}));

jest.mock('@/services/invites', () => ({
  createFamilyInvite: jest.fn(),
}));

jest.mock('@/services/analytics', () => ({
  trackEvent: jest.fn(),
}));

const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedCreateInvite = createFamilyInvite as jest.MockedFunction<typeof createFamilyInvite>;
const mockedTrackEvent = trackEvent as jest.MockedFunction<typeof trackEvent>;

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
        <InviteFamilyMemberScreen />
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
}

describe('InviteFamilyMemberScreen -- invite_created analytics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction });
    mockedUseFamily.mockReturnValue({
      family: { id: 'family-1', name: 'The Test Family' },
      familyId: 'family-1',
      role: 'owner',
    } as never);
  });

  it('reports invite_created with the selected role and family_id once the invite is created', async () => {
    mockedCreateInvite.mockResolvedValue({
      data: { id: 'invite-1', code: 'sunny-tiger-lake', role: 'manager' } as never,
      error: null,
    });

    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('sharing-invite-role-manager'));
    fireEvent.press(getByTestId('sharing-invite-create-button'));

    await waitFor(() => {
      expect(mockedTrackEvent).toHaveBeenCalledWith('invite_created', {
        role: 'manager',
        family_id: 'family-1',
      });
    });
    expect(router.replace).toHaveBeenCalledWith(sharingPendingInvitesRoute);
  });

  it('does not report invite_created when the invite creation fails', async () => {
    mockedCreateInvite.mockResolvedValue({
      data: null,
      error: { message: 'Could not create the invite' },
    });

    const { getByTestId, findByText } = renderScreen();

    fireEvent.press(getByTestId('sharing-invite-create-button'));

    expect(await findByText('Could not create the invite')).toBeTruthy();
    expect(mockedTrackEvent).not.toHaveBeenCalled();
  });
});
