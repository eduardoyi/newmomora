// See no-family.test.tsx for why screen tests live outside app/.
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { Share } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import InviteFamilyMemberScreen from '../../app/(app)/sharing/invite';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useFamilyRelationships } from '@/hooks/useFamilyRelationships';
import { sharingPendingInvitesRoute } from '@/lib/routes';
import { trackEvent } from '@/services/analytics';
import { createFamilyInvite } from '@/services/invites';

jest.mock('expo-router', () => ({
  router: {
    replace: jest.fn(),
    back: jest.fn(),
  },
  useLocalSearchParams: jest.fn(),
}));

jest.mock('@/components/family-member-avatar', () => ({ FamilyMemberAvatar: () => null }));

jest.mock('@/hooks/useFamilyMembers', () => ({ useFamilyMembers: jest.fn() }));

jest.mock('@/hooks/useFamilyRelationships', () => ({ useFamilyRelationships: jest.fn() }));

const mockIsTargetReported = jest.fn((type: string, id?: string) => false);
jest.mock('@/hooks/useContentSafety', () => ({
  useContentSafety: () => ({
    isLoading: false,
    isError: false,
    isTargetReported: (type: string, id?: string) => mockIsTargetReported(type, id),
  }),
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
const mockedUseParams = useLocalSearchParams as jest.Mock;
const mockedUseFamilyMembers = useFamilyMembers as jest.Mock;
const mockedUseFamilyRelationships = useFamilyRelationships as jest.Mock;

const ANA = { id: 'm-ana', name: 'Grandma Ana', relationship: 'grandparent' };
const LUCA = { id: 'm-luca', name: '  Luca  ', relationship: 'parent' };
const TOMAS = { id: 'm-tomas', name: 'Tomás', relationship: 'child' };
const TAKEN = { id: 'm-taken', name: 'Tia Rosa', relationship: 'aunt_uncle' };
const HIDDEN = { id: 'm-hidden', name: 'Hidden Person', relationship: 'cousin' };
const LONG_NAME = 'A'.repeat(80);
const LONG = { id: 'm-long', name: LONG_NAME, relationship: 'cousin' };

function setPeople(links: { familyMemberId: string | null }[] = [{ familyMemberId: 'm-taken' }]) {
  mockedUseFamilyMembers.mockReturnValue({
    members: [ANA, LUCA, TOMAS, TAKEN, HIDDEN, LONG],
    isLoading: false,
  });
  mockedUseFamilyRelationships.mockReturnValue({ links, isLoadingLinks: false });
}

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
    mockedUseParams.mockReturnValue({});
    mockIsTargetReported.mockImplementation((type, id) => type === 'family_member_profile' && id === 'm-hidden');
    setPeople();
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
        has_invitee_name: false,
        for_family_member: false,
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

describe('InviteFamilyMemberScreen -- who is this for', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction });
    mockedUseParams.mockReturnValue({});
    mockIsTargetReported.mockImplementation((type, id) => type === 'family_member_profile' && id === 'm-hidden');
    setPeople();
    mockedUseFamily.mockReturnValue({
      family: { id: 'family-1', name: 'The Test Family' },
      familyId: 'family-1',
      role: 'owner',
    } as never);
    mockedCreateInvite.mockResolvedValue({
      data: { id: 'invite-1', code: 'sunny-tiger-lake', role: 'viewer' } as never,
      error: null,
    });
  });

  it('shows only eligible people as chips (no kids, claimed, or hidden people)', () => {
    const { queryByTestId } = renderScreen();

    expect(queryByTestId('sharing-invite-person-m-ana')).toBeTruthy();
    expect(queryByTestId('sharing-invite-person-m-luca')).toBeTruthy();
    expect(queryByTestId('sharing-invite-person-m-tomas')).toBeNull();
    expect(queryByTestId('sharing-invite-person-m-taken')).toBeNull();
    expect(queryByTestId('sharing-invite-person-m-hidden')).toBeNull();
  });

  it('hides the chip row when nobody is eligible', () => {
    mockedUseFamilyMembers.mockReturnValue({ members: [TOMAS], isLoading: false });
    const { queryByTestId } = renderScreen();

    expect(queryByTestId('sharing-invite-name-input')).toBeTruthy();
    expect(queryByTestId('sharing-invite-person-m-tomas')).toBeNull();
  });

  it('caps the input at 60 characters and capitalizes words', () => {
    const { getByTestId } = renderScreen();
    const input = getByTestId('sharing-invite-name-input');

    expect(input.props.maxLength).toBe(60);
    expect(input.props.autoCapitalize).toBe('words');
  });

  it('passes a typed name (trimmed) with no person, and greets them in the share message', async () => {
    const { getByTestId } = renderScreen();

    fireEvent.changeText(getByTestId('sharing-invite-name-input'), '  Grandma Ana ');
    fireEvent.press(getByTestId('sharing-invite-create-button'));

    await waitFor(() => {
      expect(mockedCreateInvite).toHaveBeenCalledWith('family-1', 'viewer', {
        inviteeName: 'Grandma Ana',
        inviteeMemberId: undefined,
      });
    });
    expect(Share.share).toHaveBeenCalledWith({
      message: expect.stringContaining('Hi Grandma Ana! I\'m journaling'),
    });
    expect(mockedTrackEvent).toHaveBeenCalledWith('invite_created', {
      role: 'viewer',
      family_id: 'family-1',
      has_invitee_name: true,
      for_family_member: false,
    });
  });

  it('omits the name when blank', async () => {
    const { getByTestId } = renderScreen();

    fireEvent.changeText(getByTestId('sharing-invite-name-input'), '   ');
    fireEvent.press(getByTestId('sharing-invite-create-button'));

    await waitFor(() => {
      expect(mockedCreateInvite).toHaveBeenCalledWith('family-1', 'viewer', {
        inviteeName: undefined,
        inviteeMemberId: undefined,
      });
    });
  });

  it('selecting a chip fills the trimmed name and passes the person; tapping again deselects but keeps the text', async () => {
    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('sharing-invite-person-m-luca'));
    expect(getByTestId('sharing-invite-name-input').props.value).toBe('Luca');
    expect(getByTestId('sharing-invite-person-m-luca').props.accessibilityState).toEqual({ selected: true });

    fireEvent.press(getByTestId('sharing-invite-person-m-luca'));
    expect(getByTestId('sharing-invite-name-input').props.value).toBe('Luca');
    expect(getByTestId('sharing-invite-person-m-luca').props.accessibilityState).toEqual({ selected: false });

    fireEvent.press(getByTestId('sharing-invite-person-m-ana'));
    fireEvent.press(getByTestId('sharing-invite-create-button'));

    await waitFor(() => {
      expect(mockedCreateInvite).toHaveBeenCalledWith('family-1', 'viewer', {
        inviteeName: 'Grandma Ana',
        inviteeMemberId: 'm-ana',
      });
    });
    expect(mockedTrackEvent).toHaveBeenCalledWith('invite_created', expect.objectContaining({
      has_invitee_name: true,
      for_family_member: true,
    }));
  });

  it('truncates a long member name to 60 characters when filling the field', () => {
    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('sharing-invite-person-m-long'));

    expect(getByTestId('sharing-invite-name-input').props.value).toBe(LONG_NAME.slice(0, 60));
  });

  it('preselects the person from the memberId param and fills the name', async () => {
    mockedUseParams.mockReturnValue({ memberId: 'm-ana' });
    const { getByTestId } = renderScreen();

    await waitFor(() => {
      expect(getByTestId('sharing-invite-person-m-ana').props.accessibilityState).toEqual({ selected: true });
    });
    expect(getByTestId('sharing-invite-name-input').props.value).toBe('Grandma Ana');

    fireEvent.press(getByTestId('sharing-invite-create-button'));
    await waitFor(() => {
      expect(mockedCreateInvite).toHaveBeenCalledWith('family-1', 'viewer', {
        inviteeName: 'Grandma Ana',
        inviteeMemberId: 'm-ana',
      });
    });
  });

  it.each(['m-taken', 'm-tomas', 'm-hidden', 'm-missing'])(
    'ignores an ineligible memberId param (%s) silently',
    async (memberId) => {
      mockedUseParams.mockReturnValue({ memberId });
      const { getByTestId, queryByText } = renderScreen();

      fireEvent.press(getByTestId('sharing-invite-create-button'));

      await waitFor(() => {
        expect(mockedCreateInvite).toHaveBeenCalledWith('family-1', 'viewer', {
          inviteeName: undefined,
          inviteeMemberId: undefined,
        });
      });
      expect(getByTestId('sharing-invite-name-input').props.value).toBe('');
      expect(queryByText(/can't be invited/)).toBeNull();
    },
  );

  it.each([
    ['member_already_linked', 'Someone in the family already says this is them.', true],
    ['member_not_linkable', "That person can't be invited anymore. Pick someone else or type a name.", true],
    ['member_not_in_family', "That person can't be invited anymore. Pick someone else or type a name.", true],
    ['invitee_name_too_long', 'That name is a bit long.', false],
  ])('maps the %s error to friendly copy', async (token, copy, clearsChip) => {
    mockedCreateInvite.mockResolvedValue({ data: null, error: { message: token, code: '22023' } });
    const { getByTestId, findByText, queryByText } = renderScreen();

    fireEvent.press(getByTestId('sharing-invite-person-m-ana'));
    fireEvent.press(getByTestId('sharing-invite-create-button'));

    expect(await findByText(copy)).toBeTruthy();
    expect(queryByText(token)).toBeNull();
    expect(getByTestId('sharing-invite-person-m-ana').props.accessibilityState).toEqual({
      selected: !clearsChip,
    });
    expect(mockedTrackEvent).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('maps a 23514 check violation to the name-too-long copy', async () => {
    mockedCreateInvite.mockResolvedValue({
      data: null,
      error: { message: 'new row violates check constraint', code: '23514' },
    });
    const { getByTestId, findByText } = renderScreen();

    fireEvent.press(getByTestId('sharing-invite-create-button'));

    expect(await findByText('That name is a bit long.')).toBeTruthy();
  });

  it('falls back to the raw message for unmapped errors', async () => {
    mockedCreateInvite.mockResolvedValue({ data: null, error: { message: 'Not authorized', code: '42501' } });
    const { getByTestId, findByText } = renderScreen();

    fireEvent.press(getByTestId('sharing-invite-create-button'));

    expect(await findByText('Not authorized')).toBeTruthy();
  });
});
