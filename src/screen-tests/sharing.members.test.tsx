// See no-family.test.tsx for why screen tests live outside app/.
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Alert } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import FamilyMembersScreen from '../../app/(app)/sharing/members';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { useFamilyInvites } from '@/hooks/useFamilyInvites';
import { useFamilyMemberProfiles } from '@/hooks/useFamilyMemberProfiles';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useFamilyRelationships } from '@/hooks/useFamilyRelationships';
import { sharingApprovalsRoute, sharingInviteRoute, sharingPendingInvitesRoute } from '@/lib/routes';
import { removeMember, updateMemberRole } from '@/services/family';

const mockIsTargetReported = jest.fn((_type: string, _id?: string | null) => false);

jest.mock('expo-router', () => ({
  router: {
    replace: jest.fn(),
    push: jest.fn(),
    back: jest.fn(),
  },
}));

jest.mock('@/hooks/use-auth', () => ({
  useAuth: jest.fn(),
}));

jest.mock('@/hooks/use-family', () => ({
  useFamily: jest.fn(),
  familyMembershipsQueryKey: ['family-memberships'],
}));

jest.mock('@/hooks/useFamilyInvites', () => ({
  useFamilyInvites: jest.fn(),
}));

jest.mock('@/hooks/useFamilyMemberProfiles', () => ({
  useFamilyMemberProfiles: jest.fn(),
}));

jest.mock('@/hooks/useFamilyMembers', () => ({
  useFamilyMembers: jest.fn(),
}));

jest.mock('@/hooks/useFamilyRelationships', () => ({
  useFamilyRelationships: jest.fn(),
}));

jest.mock('@/hooks/useContentSafety', () => ({
  useContentSafety: () => ({
    isLoading: false,
    isError: false,
    isReporting: false,
    isUpdatingBlock: false,
    isTargetReported: (type: string, id?: string | null) => mockIsTargetReported(type, id),
    hasActiveReport: () => false,
    getBlockForUser: () => undefined,
    isUserBlocked: () => false,
    setAccountBlocked: jest.fn(),
    report: jest.fn(),
    refetch: jest.fn(),
  }),
}));

jest.mock('@/services/family', () => ({
  updateMemberRole: jest.fn(),
  removeMember: jest.fn(),
}));

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedUseFamilyMemberProfiles = useFamilyMemberProfiles as jest.MockedFunction<
  typeof useFamilyMemberProfiles
>;
const mockedUseFamilyInvites = useFamilyInvites as jest.MockedFunction<typeof useFamilyInvites>;
const mockedUseFamilyMembers = useFamilyMembers as jest.Mock;
const mockedUseFamilyRelationships = useFamilyRelationships as jest.Mock;
const mockedUpdateMemberRole = updateMemberRole as jest.MockedFunction<typeof updateMemberRole>;
const mockedRemoveMember = removeMember as jest.MockedFunction<typeof removeMember>;

const ownerProfile = {
  user_id: 'user-1',
  name: 'Rosa',
  role: 'owner',
  is_active_member: true,
  created_at: '2026-05-28T00:00:00Z',
};
const managerProfile = {
  user_id: 'user-2',
  name: 'Dana',
  role: 'manager',
  is_active_member: true,
  created_at: '2026-05-28T00:00:00Z',
};
const viewerProfile = {
  user_id: 'user-3',
  name: 'Ana',
  role: 'viewer',
  is_active_member: true,
  created_at: '2026-05-28T00:00:00Z',
};

function renderScreen() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { gcTime: Infinity, retry: false },
      mutations: { gcTime: Infinity, retry: false },
    },
  });

  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <QueryClientProvider client={queryClient}>
        <FamilyMembersScreen />
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
}

const FUTURE_EXPIRY = '2030-01-01T00:00:00Z';
const PAST_EXPIRY = '2020-01-01T00:00:00Z';

function setInvites({
  pendingInvites = [],
  redeemedInvites = [],
  isLoading = false,
}: {
  pendingInvites?: { id: string; status: string; expires_at: string }[];
  redeemedInvites?: { id: string; status: string }[];
  isLoading?: boolean;
} = {}) {
  mockedUseFamilyInvites.mockReturnValue({
    invites: [],
    pendingInvites,
    redeemedInvites,
    isLoading,
    isError: false,
    error: null,
    refetch: jest.fn(),
    revokeInvite: jest.fn(),
    isRevoking: false,
  } as never);
}

function setFamily(role: string, userId = 'user-1') {
  mockedUseAuth.mockReturnValue({
    session: { user: { id: userId } } as never,
    user: { id: userId, email: 'test@example.com' } as never,
    isLoading: false,
    requestSignInOtp: jest.fn(),
    requestSignUpOtp: jest.fn(),
    verifyOtp: jest.fn(),
    signInWithPassword: jest.fn(),
    signOut: jest.fn(),
  });
  mockedUseFamily.mockReturnValue({
    family: { id: 'family-1', name: "Rosa's family" },
    familyId: 'family-1',
    role,
    memberships: [{ id: 'm1', familyId: 'family-1', role, name: "Rosa's family" }],
    isLoading: false,
    setActiveFamily: jest.fn(),
    refetchMemberships: jest.fn(),
    justLostAccess: false,
  } as never);
}

const people = [
  { id: 'person-ana', name: 'Grandma Ana', relationship: 'grandparent', date_of_birth: '1950-01-01' },
  { id: 'person-bo', name: 'Uncle Bo', relationship: 'aunt_uncle', date_of_birth: '1975-01-01' },
  { id: 'person-kid', name: 'Kiddo', relationship: 'child', date_of_birth: '2021-01-01' },
  { id: 'person-rex', name: 'Rex', relationship: 'pet', date_of_birth: null },
];

const mockLinkAccount = jest.fn();
const mockUnlinkAccount = jest.fn();

function setLinks(links: { userId: string; familyMemberId: string | null }[], isLoadingLinks = false) {
  mockedUseFamilyRelationships.mockReturnValue({
    links: links.map((link) => ({ notInList: false, ...link })),
    isLoadingLinks,
    linkAccount: mockLinkAccount,
    unlinkAccount: mockUnlinkAccount,
  });
}

describe('Family members screen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsTargetReported.mockReturnValue(false);
    mockLinkAccount.mockResolvedValue(undefined);
    mockUnlinkAccount.mockResolvedValue(undefined);
    mockedUseFamilyMembers.mockReturnValue({ members: people });
    setLinks([]);
    setInvites();
    mockedUseFamilyMemberProfiles.mockReturnValue({
      profiles: [ownerProfile, managerProfile, viewerProfile],
      isLoading: false,
      isError: false,
      error: null,
    });
  });

  it('shows the invite affordance for an owner and routes to the invite screen', () => {
    const { router } = jest.requireMock('expo-router') as { router: { push: jest.Mock } };
    setFamily('owner', 'user-1');

    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('members-invite-family-member'));
    expect(router.push).toHaveBeenCalledWith(sharingInviteRoute);
  });

  it('shows the invite affordance for a manager', () => {
    setFamily('manager', 'user-2');

    const { getByTestId } = renderScreen();

    expect(getByTestId('members-invite-family-member')).toBeTruthy();
  });

  it('hides the invite affordance for a viewer', () => {
    setFamily('viewer', 'user-3');

    const { queryByTestId } = renderScreen();

    expect(queryByTestId('members-invite-family-member')).toBeNull();
  });

  it('lets the owner manage manager/viewer rows but not the owner row or their own', () => {
    setFamily('owner', 'user-1');

    const { getByTestId, queryByTestId } = renderScreen();

    // Own row (the owner) offers link actions only -- no role/remove actions.
    fireEvent.press(getByTestId('member-row-user-1'));
    expect(queryByTestId('member-action-remove')).toBeNull();
    expect(queryByTestId('member-action-promote')).toBeNull();
    expect(getByTestId('member-action-link')).toBeTruthy();
    fireEvent.press(getByTestId('member-action-cancel'));

    // Manager row is actionable -- offers "Make viewer".
    fireEvent.press(getByTestId('member-row-user-2'));
    expect(getByTestId('member-action-demote')).toBeTruthy();
    fireEvent.press(getByTestId('member-action-cancel'));

    // Viewer row is actionable -- offers "Make manager".
    fireEvent.press(getByTestId('member-row-user-3'));
    expect(getByTestId('member-action-promote')).toBeTruthy();
  });

  it('lets a manager manage other non-owner rows but not the owner or their own row', () => {
    setFamily('manager', 'user-2');

    const { getByTestId, queryByTestId } = renderScreen();

    fireEvent.press(getByTestId('member-row-user-1'));
    expect(queryByTestId('member-action-remove')).toBeNull();
    fireEvent.press(getByTestId('member-action-cancel'));

    fireEvent.press(getByTestId('member-row-user-2'));
    expect(queryByTestId('member-action-remove')).toBeNull();
    fireEvent.press(getByTestId('member-action-cancel'));

    fireEvent.press(getByTestId('member-row-user-3'));
    expect(getByTestId('member-action-promote')).toBeTruthy();
  });

  it('never offers member actions to a viewer, and the list stays read-only', () => {
    setFamily('viewer', 'user-3');

    const { getByTestId, queryByTestId } = renderScreen();

    fireEvent.press(getByTestId('member-row-user-1'));
    fireEvent.press(getByTestId('member-row-user-2'));
    fireEvent.press(getByTestId('member-row-user-3'));
    expect(queryByTestId('member-action-promote')).toBeNull();
    expect(queryByTestId('member-action-demote')).toBeNull();
    expect(queryByTestId('member-action-remove')).toBeNull();
  });

  it('promotes a viewer with a single tap', async () => {
    setFamily('manager', 'user-2');
    mockedUpdateMemberRole.mockResolvedValue({ data: [{ id: 'membership-3', role: 'manager' }], error: null });

    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('member-row-user-3'));
    fireEvent.press(getByTestId('member-action-promote'));

    await waitFor(() => {
      expect(mockedUpdateMemberRole).toHaveBeenCalledWith('family-1', 'user-3', 'manager');
    });
  });

  it('demotes a manager with a single tap', async () => {
    setFamily('owner', 'user-1');
    mockedUpdateMemberRole.mockResolvedValue({ data: [{ id: 'membership-2', role: 'viewer' }], error: null });

    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('member-row-user-2'));
    fireEvent.press(getByTestId('member-action-demote'));

    await waitFor(() => {
      expect(mockedUpdateMemberRole).toHaveBeenCalledWith('family-1', 'user-2', 'viewer');
    });
  });

  it('only removes a member after confirming the destructive alert', async () => {
    setFamily('owner', 'user-1');
    mockedRemoveMember.mockResolvedValue({ data: [{ id: 'membership-3' }], error: null });

    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((title, message, buttons) => {
      expect(title).toBe('Remove from family');
      expect(message).toContain('Ana');
      expect(message).toContain('will no longer be able to see the family journal');
      const cancelButton = buttons?.find((button) => button.text === 'Cancel');
      cancelButton?.onPress?.();
    });

    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('member-row-user-3'));
    fireEvent.press(getByTestId('member-action-remove'));

    expect(alertSpy).toHaveBeenCalled();
    expect(mockedRemoveMember).not.toHaveBeenCalled();

    alertSpy.mockImplementation((_title, _message, buttons) => {
      const removeButton = buttons?.find((button) => button.text === 'Remove');
      removeButton?.onPress?.();
    });

    fireEvent.press(getByTestId('member-row-user-3'));
    fireEvent.press(getByTestId('member-action-remove'));

    await waitFor(() => {
      expect(mockedRemoveMember).toHaveBeenCalledWith('family-1', 'user-3');
    });

    alertSpy.mockRestore();
  });

  it('falls back to "This family member" for a blank name, in both the row label and the removal confirm copy (WP6 safety net)', () => {
    setFamily('owner', 'user-1');
    mockedUseFamilyMemberProfiles.mockReturnValue({
      profiles: [ownerProfile, { ...viewerProfile, user_id: 'user-4', name: '' }],
      isLoading: false,
      isError: false,
      error: null,
    });

    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    const { getByTestId, getByText } = renderScreen();

    expect(getByText('This family member')).toBeTruthy();

    fireEvent.press(getByTestId('member-row-user-4'));
    fireEvent.press(getByTestId('member-action-remove'));

    expect(alertSpy).toHaveBeenCalledWith(
      'Remove from family',
      'This family member will no longer be able to see the family journal. Memories and photos they added will stay.',
      expect.anything(),
    );

    alertSpy.mockRestore();
  });

  it('refreshes the list with a non-scary message when the member was already changed elsewhere', async () => {
    setFamily('owner', 'user-1');
    mockedUpdateMemberRole.mockResolvedValue({ data: [], error: null });

    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

    const { getByTestId } = renderScreen();

    fireEvent.press(getByTestId('member-row-user-3'));
    fireEvent.press(getByTestId('member-action-promote'));

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith(
        'List refreshed',
        'Looks like something changed — the list has been refreshed.',
      );
    });

    alertSpy.mockRestore();
  });

  describe('pending invites and approvals', () => {
    it('routes a manager to approvals with the redeemed-invite count', () => {
      const { router } = jest.requireMock('expo-router') as { router: { push: jest.Mock } };
      setFamily('manager', 'user-2');
      setInvites({ redeemedInvites: [{ id: 'invite-1', status: 'redeemed' }, { id: 'invite-2', status: 'redeemed' }] });

      const { getByTestId, getByText } = renderScreen();

      expect(getByText('Waiting for approval')).toBeTruthy();
      expect(getByText('2')).toBeTruthy();
      fireEvent.press(getByTestId('members-approvals'));
      expect(router.push).toHaveBeenCalledWith(sharingApprovalsRoute);
    });

    it('only shows Pending invites for a non-expired pending invite', () => {
      const { router } = jest.requireMock('expo-router') as { router: { push: jest.Mock } };
      setFamily('owner');
      setInvites({ pendingInvites: [{ id: 'invite-1', status: 'pending', expires_at: PAST_EXPIRY }] });

      const { queryByTestId, unmount } = renderScreen();
      expect(queryByTestId('members-pending-invites')).toBeNull();
      unmount();

      setInvites({ pendingInvites: [{ id: 'invite-2', status: 'pending', expires_at: FUTURE_EXPIRY }] });
      const { getByTestId } = renderScreen();
      fireEvent.press(getByTestId('members-pending-invites'));
      expect(router.push).toHaveBeenCalledWith(sharingPendingInvitesRoute);
    });

    it('does not flicker either row while invite data is loading', () => {
      setFamily('owner');
      setInvites({
        pendingInvites: [{ id: 'invite-1', status: 'pending', expires_at: FUTURE_EXPIRY }],
        redeemedInvites: [{ id: 'invite-2', status: 'redeemed' }],
        isLoading: true,
      });

      const { queryByTestId } = renderScreen();

      expect(queryByTestId('members-pending-invites')).toBeNull();
      expect(queryByTestId('members-approvals')).toBeNull();
    });

    it('never fires the invites query for a viewer', () => {
      setFamily('viewer', 'user-3');

      const { queryByTestId } = renderScreen();

      expect(mockedUseFamilyInvites).toHaveBeenCalledWith('family-1', { enabled: false });
      expect(queryByTestId('members-approvals')).toBeNull();
      expect(queryByTestId('members-pending-invites')).toBeNull();
    });
  });

  describe('manager-linked "this is me"', () => {
    it('shows the linked person next to the role', () => {
      setFamily('manager', 'user-2');
      setLinks([{ userId: 'user-3', familyMemberId: 'person-ana' }]);

      const { getByText } = renderScreen();

      expect(getByText('Viewer · Grandma Ana')).toBeTruthy();
      expect(getByText('Owner')).toBeTruthy();
    });

    it('leaves the role alone when the linked profile is content-safety hidden', () => {
      setFamily('manager', 'user-2');
      setLinks([{ userId: 'user-3', familyMemberId: 'person-ana' }]);
      mockIsTargetReported.mockImplementation((type) => type === 'family_member_profile');

      const { queryByText, getByText } = renderScreen();

      expect(queryByText(/Grandma Ana/)).toBeNull();
      expect(getByText('Viewer')).toBeTruthy();
    });

    it('makes the owner row and own row tappable for an owner with link-only actions', () => {
      setFamily('owner', 'user-1');

      const { getByTestId, queryByTestId } = renderScreen();

      fireEvent.press(getByTestId('member-row-user-1'));
      expect(getByTestId('member-action-link')).toBeTruthy();
      expect(queryByTestId('member-action-promote')).toBeNull();
      expect(queryByTestId('member-action-demote')).toBeNull();
      expect(queryByTestId('member-action-remove')).toBeNull();
    });

    it('makes the owner row tappable for a manager with link-only actions', () => {
      setFamily('manager', 'user-2');

      const { getByTestId, queryByTestId } = renderScreen();

      fireEvent.press(getByTestId('member-row-user-1'));
      expect(getByTestId('member-action-link')).toBeTruthy();
      expect(queryByTestId('member-action-remove')).toBeNull();
    });

    it('offers no link actions to a viewer, and own/other rows stay inert for them', () => {
      setFamily('viewer', 'user-3');
      setLinks([{ userId: 'user-1', familyMemberId: 'person-ana' }]);

      const { getByTestId, queryByTestId } = renderScreen();

      fireEvent.press(getByTestId('member-row-user-3'));
      expect(queryByTestId('member-action-link')).toBeNull();
      fireEvent.press(getByTestId('member-row-user-1'));
      expect(queryByTestId('member-action-link')).toBeNull();
      expect(queryByTestId('member-action-change-person')).toBeNull();
      expect(queryByTestId('member-action-unlink-person')).toBeNull();
    });

    it('does not offer link actions while the links are still loading', () => {
      setFamily('owner', 'user-1');
      setLinks([], true);

      const { getByTestId, queryByTestId } = renderScreen();

      fireEvent.press(getByTestId('member-row-user-3'));
      expect(queryByTestId('member-action-link')).toBeNull();
      expect(getByTestId('member-action-promote')).toBeTruthy();
    });

    it('offers "Link to a person…" for an unlinked account and links the chosen person', async () => {
      setFamily('manager', 'user-2');
      setLinks([{ userId: 'user-1', familyMemberId: 'person-bo' }]);

      const { getByTestId, queryByTestId, getByText } = renderScreen();

      fireEvent.press(getByTestId('member-row-user-3'));
      expect(queryByTestId('member-action-change-person')).toBeNull();
      expect(queryByTestId('member-action-unlink-person')).toBeNull();
      fireEvent.press(getByTestId('member-action-link'));

      // Picker: eligible people only (no kid, pet or person held by another account).
      expect(getByText('Who is Ana?')).toBeTruthy();
      expect(getByTestId('link-person-option-person-ana')).toBeTruthy();
      expect(queryByTestId('link-person-option-person-bo')).toBeNull();
      expect(queryByTestId('link-person-option-person-kid')).toBeNull();
      expect(queryByTestId('link-person-option-person-rex')).toBeNull();

      fireEvent.press(getByTestId('link-person-option-person-ana'));

      await waitFor(() => {
        expect(mockLinkAccount).toHaveBeenCalledWith({ userId: 'user-3', memberId: 'person-ana' });
      });
      expect(queryByTestId('link-person-sheet')).toBeNull();
    });

    it('offers "Change person…" and "Unlink person" for a linked account, with the current person selected', async () => {
      setFamily('owner', 'user-1');
      setLinks([{ userId: 'user-3', familyMemberId: 'person-ana' }]);

      const { getByTestId, queryByTestId, getByText } = renderScreen();

      fireEvent.press(getByTestId('member-row-user-3'));
      expect(queryByTestId('member-action-link')).toBeNull();
      expect(getByText('This is Grandma Ana')).toBeTruthy();
      fireEvent.press(getByTestId('member-action-change-person'));

      expect(getByTestId('link-person-option-person-ana').props.accessibilityState.selected).toBe(true);
      expect(getByTestId('link-person-option-person-bo').props.accessibilityState.selected).toBe(false);

      fireEvent.press(getByTestId('link-person-option-person-bo'));
      await waitFor(() => {
        expect(mockLinkAccount).toHaveBeenCalledWith({ userId: 'user-3', memberId: 'person-bo' });
      });
    });

    it('does nothing when the current person is picked again', () => {
      setFamily('owner', 'user-1');
      setLinks([{ userId: 'user-3', familyMemberId: 'person-ana' }]);

      const { getByTestId, queryByTestId } = renderScreen();

      fireEvent.press(getByTestId('member-row-user-3'));
      fireEvent.press(getByTestId('member-action-change-person'));
      fireEvent.press(getByTestId('link-person-option-person-ana'));

      expect(mockLinkAccount).not.toHaveBeenCalled();
      expect(queryByTestId('link-person-sheet')).toBeNull();
    });

    it('unlinks the account\'s person with a single tap', async () => {
      setFamily('manager', 'user-2');
      setLinks([{ userId: 'user-1', familyMemberId: 'person-bo' }]);

      const { getByTestId } = renderScreen();

      fireEvent.press(getByTestId('member-row-user-1'));
      fireEvent.press(getByTestId('member-action-unlink-person'));

      await waitFor(() => {
        expect(mockUnlinkAccount).toHaveBeenCalledWith('person-bo');
      });
    });

    it('can link the caller\'s own account', async () => {
      setFamily('manager', 'user-2');

      const { getByTestId } = renderScreen();

      fireEvent.press(getByTestId('member-row-user-2'));
      fireEvent.press(getByTestId('member-action-link'));
      fireEvent.press(getByTestId('link-person-option-person-bo'));

      await waitFor(() => {
        expect(mockLinkAccount).toHaveBeenCalledWith({ userId: 'user-2', memberId: 'person-bo' });
      });
    });

    it('maps member_already_linked to the "unlink them first" message', async () => {
      const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      setFamily('owner', 'user-1');
      mockLinkAccount.mockRejectedValue({ message: 'member_already_linked', code: '23505' });

      const { getByTestId } = renderScreen();

      fireEvent.press(getByTestId('member-row-user-3'));
      fireEvent.press(getByTestId('member-action-link'));
      fireEvent.press(getByTestId('link-person-option-person-ana'));

      await waitFor(() => {
        expect(alertSpy).toHaveBeenCalledWith(
          'Already taken',
          'Someone else already says this is them. Unlink them on that person’s page first.',
        );
      });
      alertSpy.mockRestore();
    });

    it.each(['member_not_linkable', 'member_not_in_family', 'account_not_in_family'])(
      'maps %s to the refreshed-list message',
      async (token) => {
        const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
        setFamily('owner', 'user-1');
        mockLinkAccount.mockRejectedValue({ message: token, code: '22023' });

        const { getByTestId } = renderScreen();

        fireEvent.press(getByTestId('member-row-user-3'));
        fireEvent.press(getByTestId('member-action-link'));
        fireEvent.press(getByTestId('link-person-option-person-ana'));

        await waitFor(() => {
          expect(alertSpy).toHaveBeenCalledWith('Could not link', 'That didn’t work. The list has been refreshed.');
        });
        alertSpy.mockRestore();
      },
    );

    it('falls back to a generic retry message for unknown errors', async () => {
      const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      setFamily('owner', 'user-1');
      mockLinkAccount.mockRejectedValue({ message: 'boom' });

      const { getByTestId } = renderScreen();

      fireEvent.press(getByTestId('member-row-user-3'));
      fireEvent.press(getByTestId('member-action-link'));
      fireEvent.press(getByTestId('link-person-option-person-ana'));

      await waitFor(() => {
        expect(alertSpy).toHaveBeenCalledWith('Could not link', 'Please try again.');
      });
      alertSpy.mockRestore();
    });
  });
});
