import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import WhosWhoScreen from '../../app/(app)/whos-who';
import { useFamily } from '@/hooks/use-family';
import { useContentSafety } from '@/hooks/useContentSafety';
import { useFamilyMembers } from '@/hooks/useFamilyMembers';
import { useFamilyRelationships } from '@/hooks/useFamilyRelationships';
import type { FamilyMember } from '@/services/family-members';
import type { FamilyMemberSuggestion } from '@/services/family-relationships';

let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true) },
  useLocalSearchParams: () => mockParams,
}));
jest.mock('@/hooks/use-family', () => ({ useFamily: jest.fn() }));
jest.mock('@/hooks/useFamilyMembers', () => ({ useFamilyMembers: jest.fn() }));
jest.mock('@/hooks/useFamilyRelationships', () => ({ useFamilyRelationships: jest.fn() }));
jest.mock('@/hooks/useContentSafety', () => ({ useContentSafety: jest.fn() }));
jest.mock('@/components/family-profile-portrait-photo', () => ({
  FamilyProfilePortraitPhoto: 'FamilyProfilePortraitPhoto',
}));

const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedUseFamilyMembers = useFamilyMembers as jest.MockedFunction<typeof useFamilyMembers>;
const mockedUseRelationships = useFamilyRelationships as jest.MockedFunction<typeof useFamilyRelationships>;
const mockedUseContentSafety = useContentSafety as jest.MockedFunction<typeof useContentSafety>;

function member(id: string, name: string, extra: Partial<FamilyMember> = {}): FamilyMember {
  return {
    additional_info: null,
    created_at: '2026-01-01T00:00:00.000Z',
    date_of_birth: '1960-01-01',
    family_id: 'family-1',
    gender: null,
    id,
    illustrated_profile_key: null,
    illustrated_profile_status: 'ready',
    is_user_profile: false,
    name,
    nicknames: [],
    profile_picture_key: null,
    updated_at: '2026-01-01T00:00:00.000Z',
    user_id: 'user-1',
    relationship: null,
    family_side: null,
    side_member_id: null,
    ...extra,
  } as FamilyMember;
}

function suggestion(id: string, memberId: string, field: string, value: string, extra: Partial<FamilyMemberSuggestion> = {}) {
  return {
    id,
    family_id: 'family-1',
    family_member_id: memberId,
    field,
    value,
    side_member_id: null,
    based_on: null,
    status: 'pending',
    created_at: '2026-09-28T10:00:00Z',
    decided_at: null,
    decided_by: null,
    ...extra,
  } as FamilyMemberSuggestion;
}

const dad = member('dad', 'Eduardo', { relationship: 'parent' });
const mirian = member('mirian', 'Mirian');
const rosa = member('rosa', 'Rosa');
const tomas = member('tomas', 'Tomás', { relationship: 'child', date_of_birth: '2022-10-17' });

const mockResolve = jest.fn();
const mockLinkMe = jest.fn();
const mockUpdateMember = jest.fn();

function setup(options: { myMemberId?: string | null; canEdit?: boolean; suggestions?: FamilyMemberSuggestion[] } = {}) {
  mockedUseFamily.mockReturnValue({ family: { id: 'family-1', name: 'Yi family' } } as ReturnType<typeof useFamily>);
  mockedUseFamilyMembers.mockReturnValue({
    members: [dad, mirian, rosa, tomas],
    isLoading: false,
    updateMember: mockUpdateMember,
  } as unknown as ReturnType<typeof useFamilyMembers>);
  mockedUseContentSafety.mockReturnValue({ isTargetReported: () => false } as unknown as ReturnType<typeof useContentSafety>);
  mockedUseRelationships.mockReturnValue({
    canEdit: options.canEdit ?? true,
    suggestions: options.suggestions ?? [],
    isLoadingSuggestions: false,
    myLink: null,
    myMemberId: options.myMemberId === undefined ? 'dad' : options.myMemberId,
    claimedByOthers: new Set(['rosa']),
    isLoadingLinks: false,
    resolve: mockResolve,
    isResolving: false,
    linkMe: mockLinkMe,
    isLinking: false,
    unlinkAccount: jest.fn(),
    requestSuggestions: jest.fn(),
  } as unknown as ReturnType<typeof useFamilyRelationships>);
}

function renderScreen() {
  return render(
    <SafeAreaProvider
      initialMetrics={{ frame: { height: 844, width: 390, x: 0, y: 0 }, insets: { bottom: 34, left: 0, right: 0, top: 47 } }}
    >
      <WhosWhoScreen />
    </SafeAreaProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = {};
  mockResolve.mockResolvedValue(undefined);
  mockLinkMe.mockResolvedValue(undefined);
  mockUpdateMember.mockResolvedValue(undefined);
});

describe('WhosWhoScreen', () => {
  it('accepts kept chips and dismisses dropped ones in one call', async () => {
    setup({
      suggestions: [
        suggestion('s-role', 'mirian', 'relationship', 'grandparent'),
        suggestion('s-side', 'mirian', 'family_side', 'member', { side_member_id: 'dad' }),
        suggestion('s-nick', 'mirian', 'nickname', 'Abuela'),
      ],
    });
    const { getByTestId, getByText } = renderScreen();
    expect(getByText("Eduardo's side")).toBeTruthy();
    fireEvent.press(getByTestId('whos-who-chip-s-nick'));
    fireEvent.press(getByTestId('whos-who-confirm'));
    await waitFor(() => expect(mockResolve).toHaveBeenCalledWith({ accept: ['s-role', 's-side'], dismiss: ['s-nick'] }));
    expect(mockUpdateMember).not.toHaveBeenCalled();
    expect(router.back).toHaveBeenCalled();
  });

  it('"Not quite" writes the hand-picked role first and dismisses the AI role/side', async () => {
    setup({
      suggestions: [
        suggestion('s-role', 'mirian', 'relationship', 'grandparent'),
        suggestion('s-nick', 'mirian', 'nickname', 'Abuela'),
      ],
    });
    const { getByTestId } = renderScreen();
    fireEvent.press(getByTestId('whos-who-not-quite-mirian'));
    fireEvent.press(getByTestId('whos-who-mirian-role-family_friend'));
    fireEvent.press(getByTestId('whos-who-confirm'));
    await waitFor(() => expect(mockResolve).toHaveBeenCalledWith({ accept: ['s-nick'], dismiss: ['s-role'] }));
    expect(mockUpdateMember).toHaveBeenCalledWith({
      memberId: 'mirian',
      relationship: 'family_friend',
      familySide: null,
      sideMemberId: null,
    });
    expect(mockUpdateMember.mock.invocationCallOrder[0]).toBeLessThan(mockResolve.mock.invocationCallOrder[0]);
  });

  it('asks an unlinked account which one they are, hiding kids and taken people', async () => {
    mockParams = { mode: 'self', next: 'timeline' };
    setup({ myMemberId: null, canEdit: false });
    const { getByTestId, queryByTestId, getByText } = renderScreen();
    expect(getByText('Are you in the family?')).toBeTruthy();
    expect(queryByTestId('whos-who-me-tomas')).toBeNull();
    expect(getByTestId('whos-who-me-rosa').props.accessibilityState).toEqual({ disabled: true });
    fireEvent.press(getByTestId('whos-who-me-mirian'));
    await waitFor(() => expect(mockLinkMe).toHaveBeenCalledWith({ memberId: 'mirian', notInList: false }));
    expect(router.replace).toHaveBeenCalledWith('/(app)/(tabs)/timeline');
  });

  it('"I\'m not in the list" records it and finishes', async () => {
    mockParams = { mode: 'self' };
    setup({ myMemberId: null, canEdit: false });
    const { getByTestId } = renderScreen();
    fireEvent.press(getByTestId('whos-who-not-listed'));
    await waitFor(() => expect(mockLinkMe).toHaveBeenCalledWith({ memberId: null, notInList: true }));
  });
});
