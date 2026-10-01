// See no-family.test.tsx for why screen tests live outside app/.
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { Share } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import PendingInvitesScreen from '../../app/(app)/sharing/pending-invites';
import { useFamily } from '@/hooks/use-family';
import { useFamilyInvites } from '@/hooks/useFamilyInvites';
import type { FamilyInvite } from '@/services/invites';

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn() },
}));

jest.mock('@/hooks/use-family', () => ({ useFamily: jest.fn() }));
jest.mock('@/hooks/useFamilyInvites', () => ({ useFamilyInvites: jest.fn() }));

const mockedUseFamily = useFamily as jest.Mock;
const mockedUseFamilyInvites = useFamilyInvites as jest.Mock;

const NAMED = {
  id: 'invite-named',
  family_id: 'family-1',
  role: 'viewer',
  code: 'sunny-tiger-lake',
  status: 'pending',
  expires_at: '2099-01-01T00:00:00Z',
  invitee_name: 'Grandma Ana',
  family_member_id: 'm-ana',
} as FamilyInvite;

const UNNAMED = {
  id: 'invite-plain',
  family_id: 'family-1',
  role: 'manager',
  code: 'brave-otter-moon',
  status: 'pending',
  expires_at: '2099-01-01T00:00:00Z',
  invitee_name: null,
  family_member_id: null,
} as FamilyInvite;

function renderScreen() {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <PendingInvitesScreen />
    </SafeAreaProvider>,
  );
}

describe('PendingInvitesScreen -- invitee name', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction });
    mockedUseFamily.mockReturnValue({ family: { id: 'family-1', name: 'The Test Family' }, familyId: 'family-1', role: 'owner' });
    mockedUseFamilyInvites.mockReturnValue({
      pendingInvites: [NAMED, UNNAMED],
      redeemedInvites: [],
      isLoading: false,
      revokeInvite: jest.fn(),
      isRevoking: false,
    });
  });

  it('shows the name as the primary label with the code beneath it', () => {
    const { getByTestId } = renderScreen();

    expect(getByTestId('pending-invite-invite-named-name').props.children).toBe('Grandma Ana');
    expect(getByTestId('pending-invite-invite-named-code').props.children).toBe('sunny-tiger-lake');
  });

  it('keeps today\'s code-only layout when there is no name', () => {
    const { getByTestId, queryByTestId } = renderScreen();

    expect(getByTestId('pending-invite-invite-plain-code').props.children).toBe('brave-otter-moon');
    expect(queryByTestId('pending-invite-invite-plain-name')).toBeNull();
  });

  it('Share again greets a named invitee and stays generic otherwise', async () => {
    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('pending-invite-invite-named-share'));
    await waitFor(() => {
      expect(Share.share).toHaveBeenLastCalledWith({
        message: expect.stringContaining("Hi Grandma Ana! I'm journaling"),
      });
    });

    fireEvent.press(getByTestId('pending-invite-invite-plain-share'));
    await waitFor(() => {
      expect(Share.share).toHaveBeenLastCalledWith({
        message: expect.stringContaining("Hi! I'm journaling"),
      });
    });
  });
});
