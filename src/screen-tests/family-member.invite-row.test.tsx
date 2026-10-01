// "Family sharing" row on person detail (docs/plans/invite-for-person.md D7).
import { fireEvent, render } from '@testing-library/react-native';
import { router } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import ViewFamilyMemberScreen from '../../app/(app)/family/[id]';
import { useFamily } from '@/hooks/use-family';
import { useFamilyInvites } from '@/hooks/useFamilyInvites';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useFamilyRelationships } from '@/hooks/useFamilyRelationships';
import { useMemberMemories } from '@/hooks/useMemories';
import { usePortraitVersions } from '@/hooks/usePortraitVersions';
import { sharingApprovalsRoute, sharingInviteForMemberRoute, sharingPendingInvitesRoute } from '@/lib/routes';

jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn() },
  useLocalSearchParams: () => ({ id: 'member-1' }),
}));

jest.mock('expo-symbols', () => ({ SymbolView: () => null }));

jest.mock('@/components/cast-card', () => ({ CastCard: () => null }));
jest.mock('@/components/content-action-sheet', () => ({ ContentActionSheet: () => null }));
jest.mock('@/components/content-hidden-notice', () => ({ ContentHiddenNotice: () => null }));
jest.mock('@/components/full-screen-media-viewer', () => ({ FullScreenMediaViewer: () => null }));
jest.mock('@/components/report-sheet', () => ({ ReportSheet: () => null }));

jest.mock('@/hooks/use-family', () => ({ useFamily: jest.fn() }));
jest.mock('@/hooks/useFamilyInvites', () => ({ useFamilyInvites: jest.fn() }));
jest.mock('@/hooks/useFamilyMembers', () => ({ useFamilyMembers: jest.fn() }));
jest.mock('@/hooks/useFamilyRelationships', () => ({ useFamilyRelationships: jest.fn() }));
jest.mock('@/hooks/useMemories', () => ({ useMemberMemories: jest.fn() }));
jest.mock('@/hooks/usePortraitVersions', () => ({ usePortraitVersions: jest.fn() }));
jest.mock('@/hooks/useMediaUrls', () => ({ useMediaUrl: jest.fn(() => ({ url: null })) }));
jest.mock('@/hooks/useVideoThumbnail', () => ({ useVideoThumbnail: jest.fn(() => null) }));

const mockIsTargetReported = jest.fn((type: string, id?: string | null) => false);
jest.mock('@/hooks/useContentSafety', () => ({
  useContentSafety: () => ({
    isLoading: false,
    isError: false,
    isTargetReported: (type: string, id?: string | null) => mockIsTargetReported(type, id),
    hasActiveReport: () => false,
    isUserBlocked: () => false,
    revealTarget: jest.fn(),
    refetch: jest.fn(),
  }),
}));

const mockedUseFamily = useFamily as jest.Mock;
const mockedUseFamilyInvites = useFamilyInvites as jest.Mock;
const mockedUseFamilyMembers = useFamilyMembers as jest.Mock;
const mockedUseFamilyRelationships = useFamilyRelationships as jest.Mock;
const mockedUseMemberMemories = useMemberMemories as jest.Mock;
const mockedUsePortraitVersions = usePortraitVersions as jest.Mock;

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;

function makeInvite(over: Record<string, unknown> = {}) {
  return {
    id: 'invite-1',
    family_member_id: 'member-1',
    status: 'pending',
    created_at: new Date(NOW - HOUR).toISOString(),
    expires_at: new Date(NOW + 3 * 24 * HOUR).toISOString(),
    ...over,
  };
}

function setup(options: {
  role?: string;
  relationship?: string | null;
  links?: { familyMemberId: string | null }[];
  invites?: ReturnType<typeof makeInvite>[];
  isLoadingLinks?: boolean;
} = {}) {
  mockedUseFamily.mockReturnValue({ familyId: 'family-1', role: options.role ?? 'owner' });
  mockedUseFamilyMembers.mockReturnValue({
    members: [
      {
        id: 'member-1',
        name: 'Grandma Ana',
        nicknames: [],
        relationship: options.relationship === undefined ? 'grandparent' : options.relationship,
        resolvedPortraitVersion: null,
        avatarUpdatedAt: null,
        updated_at: '2026-08-19T00:00:00.000Z',
      },
    ],
    isLoading: false,
    deleteMember: jest.fn(),
    isDeleting: false,
  });
  mockedUseFamilyRelationships.mockReturnValue({
    canEdit: true,
    suggestions: [],
    isLoadingSuggestions: false,
    myLink: null,
    myMemberId: null,
    claimedByOthers: new Set(),
    links: options.links ?? [],
    isLoadingLinks: options.isLoadingLinks ?? false,
    resolve: jest.fn(),
    isResolving: false,
    linkMe: jest.fn(),
    isLinking: false,
    unlinkAccount: jest.fn(),
    requestSuggestions: jest.fn(),
  });
  mockedUseFamilyInvites.mockReturnValue({ invites: options.invites ?? [], isLoading: false });
}

function renderScreen() {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <ViewFamilyMemberScreen />
    </SafeAreaProvider>,
  );
}

const ROW_IDS = ['family-member-invite', 'family-member-invite-pending', 'family-member-invite-approval'];

function visibleRows(screen: ReturnType<typeof renderScreen>) {
  return ROW_IDS.filter((id) => screen.queryByTestId(id) !== null);
}

describe('person detail -- invite row', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsTargetReported.mockReturnValue(false);
    mockedUsePortraitVersions.mockReturnValue({ versions: [] });
    mockedUseMemberMemories.mockReturnValue({
      memories: [],
      fetchNextPage: jest.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
    });
  });

  it('offers "Invite {name} to Momora" to an owner/manager and opens the invite screen with the person', () => {
    setup();
    const screen = renderScreen();

    expect(screen.getByText('Invite Grandma Ana to Momora')).toBeTruthy();
    expect(screen.getByText('They’ll see every memory once you approve them')).toBeTruthy();
    fireEvent.press(screen.getByTestId('family-member-invite'));
    expect(router.push).toHaveBeenCalledWith(sharingInviteForMemberRoute('member-1'));
  });

  it('enables the invites query only for owners/managers', () => {
    setup({ role: 'viewer' });
    renderScreen();

    expect(mockedUseFamilyInvites).toHaveBeenCalledWith('family-1', { enabled: false });

    setup({ role: 'manager' });
    renderScreen();

    expect(mockedUseFamilyInvites).toHaveBeenLastCalledWith('family-1', { enabled: true });
  });

  it('shows no row to a viewer', () => {
    setup({ role: 'viewer' });
    expect(visibleRows(renderScreen())).toEqual([]);
  });

  it('shows no row for a child', () => {
    setup({ relationship: 'child' });
    expect(visibleRows(renderScreen())).toEqual([]);
  });

  it('shows no row for a person already linked to an account (any account)', () => {
    setup({ links: [{ familyMemberId: 'member-1' }] });
    expect(visibleRows(renderScreen())).toEqual([]);
  });

  it('shows no row while links are loading', () => {
    setup({ isLoadingLinks: true });
    expect(visibleRows(renderScreen())).toEqual([]);
  });

  it('shows no row for a content-safety hidden profile', () => {
    setup();
    mockIsTargetReported.mockImplementation((type) => type === 'family_member_profile');
    expect(visibleRows(renderScreen())).toEqual([]);
  });

  it('shows "Invite sent" with the expiry for a live pending invite and opens Pending invites', () => {
    setup({ invites: [makeInvite()] });
    const screen = renderScreen();

    expect(visibleRows(screen)).toEqual(['family-member-invite-pending']);
    expect(screen.getByText('Invite sent · Expires in 2d')).toBeTruthy();
    fireEvent.press(screen.getByTestId('family-member-invite-pending'));
    expect(router.push).toHaveBeenCalledWith(sharingPendingInvitesRoute);
  });

  it('shows "Waiting for your approval" for a redeemed invite, which beats a pending one', () => {
    setup({ invites: [makeInvite(), makeInvite({ id: 'invite-2', status: 'redeemed' })] });
    const screen = renderScreen();

    expect(visibleRows(screen)).toEqual(['family-member-invite-approval']);
    fireEvent.press(screen.getByTestId('family-member-invite-approval'));
    expect(router.push).toHaveBeenCalledWith(sharingApprovalsRoute);
  });

  it('falls back to the invite row when the only pending invite has expired', () => {
    setup({ invites: [makeInvite({ expires_at: new Date(NOW - HOUR).toISOString() })] });
    expect(visibleRows(renderScreen())).toEqual(['family-member-invite']);
  });

  it('ignores invites aimed at someone else or already revoked/approved', () => {
    setup({
      invites: [
        makeInvite({ family_member_id: 'member-2' }),
        makeInvite({ id: 'invite-3', status: 'revoked' }),
        makeInvite({ id: 'invite-4', status: 'approved' }),
      ],
    });
    expect(visibleRows(renderScreen())).toEqual(['family-member-invite']);
  });
});
