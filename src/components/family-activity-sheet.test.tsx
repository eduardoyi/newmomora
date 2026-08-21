import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { FamilyActivitySheet, type FamilyActivitySheetProps } from './family-activity-sheet';
import { useFamily } from '@/hooks/use-family';
import { useFamilyActivity, useMarkFamilyActivitySeen } from '@/hooks/useFamilyActivity';
import { useFamilyMemberProfiles } from '@/hooks/useFamilyMemberProfiles';
import type { FamilyActivityEvent } from '@/services/family-activity';

// src/services/family-activity.ts imports the real @/lib/supabase client,
// whose AsyncStorage import blows up under Jest -- mock the client directly
// so that chain never runs. (family-activity-sheet.tsx pulls its
// pull-down-dismiss helpers from the dependency-free
// src/utils/bottom-sheet-dismiss.ts, not from memory-comments-drawer.tsx, so
// no other hook chain needs mocking here.)
jest.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: jest.fn(),
    from: jest.fn(),
    auth: { getUser: jest.fn() },
    functions: { invoke: jest.fn() },
  },
}));

jest.mock('@/hooks/use-family', () => ({ useFamily: jest.fn() }));
jest.mock('@/hooks/useFamilyActivity', () => ({
  useFamilyActivity: jest.fn(),
  useMarkFamilyActivitySeen: jest.fn(),
}));
jest.mock('@/hooks/useFamilyMemberProfiles', () => ({ useFamilyMemberProfiles: jest.fn() }));
jest.mock('@/hooks/useMediaUrls', () => ({ useMediaUrls: jest.fn(() => ({ data: {} })) }));
jest.mock('@/components/family-member-avatar', () => {
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    FamilyMemberAvatar: ({ member }: { member: { name: string } }) => <Text>{member.name}</Text>,
  };
});

const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedUseFamilyActivity = useFamilyActivity as jest.MockedFunction<typeof useFamilyActivity>;
const mockedUseMarkSeen = useMarkFamilyActivitySeen as jest.MockedFunction<typeof useMarkFamilyActivitySeen>;
const mockedUseProfiles = useFamilyMemberProfiles as jest.MockedFunction<typeof useFamilyMemberProfiles>;

function makeEvent(overrides: Partial<FamilyActivityEvent> = {}): FamilyActivityEvent {
  return {
    id: 'event-1',
    kind: 'memory_added',
    createdAt: new Date().toISOString(),
    actorId: 'actor-1',
    actorName: 'Ana',
    actorIsFormer: false,
    memoryId: 'memory-1',
    memoryCreationSource: 'manual',
    memoryExcerpt: 'First swim',
    memoryIllustrationKey: null,
    memoryMediaKey: null,
    memoryMediaContentType: null,
    commentId: null,
    commentSnippet: null,
    inviteId: null,
    ...overrides,
  };
}

const safeAreaMetrics = {
  frame: { height: 844, width: 390, x: 0, y: 0 },
  insets: { bottom: 34, left: 0, right: 0, top: 47 },
};

function wrapSheet(props: FamilyActivitySheetProps) {
  return (
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <FamilyActivitySheet {...props} />
    </SafeAreaProvider>
  );
}

function renderSheet(props: Partial<FamilyActivitySheetProps> = {}) {
  const defaultProps: FamilyActivitySheetProps = {
    visible: true,
    onClose: jest.fn(),
    onOpenMemory: jest.fn(),
    onOpenComments: jest.fn(),
    onOpenApprovals: jest.fn(),
    onInvite: jest.fn(),
  };
  const merged = { ...defaultProps, ...props };
  const utils = render(wrapSheet(merged));
  return {
    ...utils,
    props: merged,
    // Simulates the parent (timeline.tsx) flipping its `visible` state to
    // false after `onClose` fires -- the real trigger for the sheet's
    // deferred-navigation effect (see family-activity-sheet.tsx).
    rerenderVisible: (visible: boolean) => utils.rerender(wrapSheet({ ...merged, visible })),
  };
}

describe('FamilyActivitySheet', () => {
  const mutate = jest.fn();
  const refetch = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockedUseFamily.mockReturnValue({ familyId: 'family-1', role: 'owner' } as never);
    mockedUseProfiles.mockReturnValue({
      profiles: [
        { user_id: 'user-1', is_active_member: true } as never,
        { user_id: 'user-2', is_active_member: true } as never,
      ],
      isLoading: false,
      isError: false,
      error: null,
    });
    mockedUseMarkSeen.mockReturnValue({ mutate } as never);
    mockedUseFamilyActivity.mockReturnValue({
      events: [],
      isLoading: false,
      isRefetching: false,
      isError: false,
      error: null,
      refetch,
    });
  });

  it('shows a loading skeleton of 3 rows', () => {
    mockedUseFamilyActivity.mockReturnValue({
      events: [],
      isLoading: true,
      isRefetching: false,
      isError: false,
      error: null,
      refetch,
    });

    const { getByTestId } = renderSheet();

    expect(getByTestId('family-activity-sheet-loading')).toBeTruthy();
    expect(getByTestId('family-activity-skeleton-row-0')).toBeTruthy();
    expect(getByTestId('family-activity-skeleton-row-1')).toBeTruthy();
    expect(getByTestId('family-activity-skeleton-row-2')).toBeTruthy();
  });

  it('shows an error state with retry', () => {
    mockedUseFamilyActivity.mockReturnValue({
      events: [],
      isLoading: false,
      isRefetching: false,
      isError: true,
      error: new Error('boom'),
      refetch,
    });

    const { getByTestId, getByText } = renderSheet();

    expect(getByTestId('family-activity-sheet-error')).toBeTruthy();
    fireEvent.press(getByText('Try again'));
    expect(refetch).toHaveBeenCalled();
  });

  it('shows the empty state copy and no invite link when the family has more than one active member', () => {
    const { getByTestId, queryByTestId, getByText } = renderSheet();

    expect(getByTestId('family-activity-sheet-empty')).toBeTruthy();
    expect(
      getByText(/Quiet for now\. When someone adds a moment or leaves a comment/),
    ).toBeTruthy();
    expect(queryByTestId('family-activity-sheet-invite')).toBeNull();
  });

  it('shows the invite link in the empty state only for a solo family', () => {
    mockedUseProfiles.mockReturnValue({
      profiles: [{ user_id: 'user-1', is_active_member: true } as never],
      isLoading: false,
      isError: false,
      error: null,
    });

    const { getByTestId } = renderSheet();

    expect(getByTestId('family-activity-sheet-invite')).toBeTruthy();
  });

  it('closes immediately but defers the invite callback until visible becomes false', () => {
    mockedUseProfiles.mockReturnValue({
      profiles: [{ user_id: 'user-1', is_active_member: true } as never],
      isLoading: false,
      isError: false,
      error: null,
    });
    const onClose = jest.fn();
    const onInvite = jest.fn();

    const { getByTestId, rerenderVisible } = renderSheet({ onClose, onInvite });
    fireEvent.press(getByTestId('family-activity-sheet-invite'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onInvite).not.toHaveBeenCalled();

    rerenderVisible(false);

    expect(onInvite).toHaveBeenCalledTimes(1);
  });

  it('groups events into Today/Yesterday/This week/Earlier sections', () => {
    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    mockedUseFamilyActivity.mockReturnValue({
      events: [
        makeEvent({ id: 'e1', createdAt: today.toISOString() }),
        makeEvent({ id: 'e2', actorId: 'actor-2', createdAt: yesterday.toISOString() }),
      ],
      isLoading: false,
      isRefetching: false,
      isError: false,
      error: null,
      refetch,
    });

    const { getByText } = renderSheet();

    expect(getByText('Today')).toBeTruthy();
    expect(getByText('Yesterday')).toBeTruthy();
  });

  it('shows a Review pill only for a member_pending row', () => {
    mockedUseFamilyActivity.mockReturnValue({
      events: [
        makeEvent({
          id: 'e1',
          kind: 'member_pending',
          actorName: 'Marta',
          memoryId: null,
          memoryExcerpt: null,
        }),
        makeEvent({ id: 'e2', actorId: 'actor-2', kind: 'memory_added' }),
      ],
      isLoading: false,
      isRefetching: false,
      isError: false,
      error: null,
      refetch,
    });

    const { getByTestId, queryByTestId } = renderSheet();

    expect(getByTestId('family-activity-row-group-e1-review')).toBeTruthy();
    expect(queryByTestId('family-activity-row-group-e2-review')).toBeNull();
  });

  it('closes immediately but defers the approvals route until visible becomes false', () => {
    mockedUseFamilyActivity.mockReturnValue({
      events: [makeEvent({ id: 'e1', kind: 'member_pending', memoryId: null, memoryExcerpt: null })],
      isLoading: false,
      isRefetching: false,
      isError: false,
      error: null,
      refetch,
    });
    const onClose = jest.fn();
    const onOpenApprovals = jest.fn();

    const { getByTestId, rerenderVisible } = renderSheet({ onClose, onOpenApprovals });
    fireEvent.press(getByTestId('family-activity-row-group-e1'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpenApprovals).not.toHaveBeenCalled();

    rerenderVisible(false);

    expect(onOpenApprovals).toHaveBeenCalledTimes(1);
  });

  it('closes immediately but defers the memory route until visible becomes false', () => {
    mockedUseFamilyActivity.mockReturnValue({
      events: [makeEvent({ id: 'e1', kind: 'memory_added', memoryId: 'memory-9' })],
      isLoading: false,
      isRefetching: false,
      isError: false,
      error: null,
      refetch,
    });
    const onClose = jest.fn();
    const onOpenMemory = jest.fn();

    const { getByTestId, rerenderVisible } = renderSheet({ onClose, onOpenMemory });
    fireEvent.press(getByTestId('family-activity-row-group-e1'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpenMemory).not.toHaveBeenCalled();

    rerenderVisible(false);

    expect(onOpenMemory).toHaveBeenCalledTimes(1);
    expect(onOpenMemory).toHaveBeenCalledWith('memory-9');
  });

  it('closes immediately but defers the comments route until visible becomes false', () => {
    mockedUseFamilyActivity.mockReturnValue({
      events: [
        makeEvent({
          id: 'e1',
          kind: 'memory_commented',
          memoryId: 'memory-9',
          commentSnippet: 'Sweet!',
        }),
      ],
      isLoading: false,
      isRefetching: false,
      isError: false,
      error: null,
      refetch,
    });
    const onClose = jest.fn();
    const onOpenComments = jest.fn();

    const { getByTestId, rerenderVisible } = renderSheet({ onClose, onOpenComments });
    fireEvent.press(getByTestId('family-activity-row-group-e1'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpenComments).not.toHaveBeenCalled();

    rerenderVisible(false);

    expect(onOpenComments).toHaveBeenCalledTimes(1);
    expect(onOpenComments).toHaveBeenCalledWith('memory-9');
  });

  it('closes a member_joined row tap with no deferred action (no-op tap target)', () => {
    mockedUseFamilyActivity.mockReturnValue({
      events: [makeEvent({ id: 'e1', kind: 'member_joined', memoryId: null, memoryExcerpt: null })],
      isLoading: false,
      isRefetching: false,
      isError: false,
      error: null,
      refetch,
    });
    const onClose = jest.fn();

    const { getByTestId, rerenderVisible } = renderSheet({ onClose });
    fireEvent.press(getByTestId('family-activity-row-group-e1'));

    expect(onClose).toHaveBeenCalledTimes(1);

    rerenderVisible(false);
    // No route callback exists for member_joined -- nothing further to
    // assert beyond onClose having fired and nothing throwing.
  });

  it('fires mark-seen on open', () => {
    renderSheet({ visible: true });

    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('does not mount the data hooks (and so never fetches or marks seen) while closed', () => {
    renderSheet({ visible: false });

    expect(mockedUseFamily).not.toHaveBeenCalled();
    expect(mockedUseFamilyActivity).not.toHaveBeenCalled();
    expect(mockedUseMarkSeen).not.toHaveBeenCalled();
    expect(mockedUseProfiles).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });
});
