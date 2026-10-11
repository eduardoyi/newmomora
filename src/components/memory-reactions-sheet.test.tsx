import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { MemoryReactionsSheet } from './memory-reactions-sheet';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { useFamilyMemberProfiles } from '@/hooks/useFamilyMemberProfiles';
import { useMemoryEngagement } from '@/hooks/useMemoryEngagement';
import { useUserProfile } from '@/hooks/useUserProfile';

jest.mock('@/hooks/use-auth', () => ({ useAuth: jest.fn() }));
jest.mock('@/hooks/use-family', () => ({ useFamily: jest.fn() }));
jest.mock('@/hooks/useMemoryEngagement', () => ({ useMemoryEngagement: jest.fn() }));
jest.mock('@/hooks/useFamilyMemberProfiles', () => ({
  useFamilyMemberProfiles: jest.fn(),
  resolveAttributionName: (profiles: { user_id: string; name: string }[], id: string) =>
    profiles.find((profile) => profile.user_id === id)?.name ?? 'a former member',
}));
jest.mock('@/hooks/useUserProfile', () => ({ useUserProfile: jest.fn() }));
const mockSafety = {
  isLoading: false,
  isError: false,
  isUserBlocked: jest.fn((_id: string) => false),
  refetch: jest.fn(),
};
jest.mock('@/hooks/useContentSafety', () => ({ useContentSafety: () => mockSafety }));

const reactions = [
  { userId: 'user-1', emoji: '😂', updatedAt: '2026-10-11T12:00:00Z' },
  { userId: 'user-2', emoji: '❤️', updatedAt: '2026-10-11T11:00:00Z' },
  { userId: 'user-3', emoji: '😂', updatedAt: '2026-10-11T10:00:00Z' },
];

describe('MemoryReactionsSheet', () => {
  const setReaction = jest.fn().mockResolvedValue(undefined);

  function mockEngagement(overrides: Record<string, unknown> = {}) {
    (useMemoryEngagement as jest.Mock).mockReturnValue({
      likeCount: 3,
      reactions,
      areReactionsLoading: false,
      reactionsError: null,
      refetchReactions: jest.fn(),
      setReaction,
      ...overrides,
    });
  }

  function renderSheet(onClose = jest.fn()) {
    return {
      onClose,
      ...render(
        <SafeAreaProvider
          initialMetrics={{
            frame: { height: 844, width: 390, x: 0, y: 0 },
            insets: { bottom: 34, left: 0, right: 0, top: 47 },
          }}
        >
          <MemoryReactionsSheet memory={{ id: 'memory-1' } as never} onClose={onClose} visible />
        </SafeAreaProvider>,
      ),
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (useAuth as jest.Mock).mockReturnValue({ user: { id: 'user-1' } });
    (useFamily as jest.Mock).mockReturnValue({ familyId: 'family-1' });
    (useUserProfile as jest.Mock).mockReturnValue({ profile: { name: 'Sam' } });
    (useFamilyMemberProfiles as jest.Mock).mockReturnValue({
      profiles: [
        { user_id: 'user-2', name: 'Mateo' },
        { user_id: 'user-3', name: 'Abuela' },
      ],
    });
    mockSafety.isLoading = false;
    mockSafety.isError = false;
    mockSafety.isUserBlocked.mockImplementation(() => false);
    mockEngagement();
  });

  it('renders a blocked reactor as "Blocked account" with a bullet avatar but keeps the emoji', () => {
    mockSafety.isUserBlocked.mockImplementation((id: string) => id === 'user-2');
    const { queryByText, getByText, getByTestId } = renderSheet();

    expect(queryByText('Mateo')).toBeNull();
    expect(getByText('Blocked account')).toBeTruthy();
    expect(getByText('•')).toBeTruthy();
    expect(getByTestId('reaction-row-user-2')).toBeTruthy();
    expect(getByText('❤️')).toBeTruthy();
    // Aggregates are unchanged.
    expect(getByTestId('reactions-filter-all')).toBeTruthy();
  });

  it('waits for content safety and offers a retry when it fails', () => {
    mockSafety.isLoading = true;
    const loading = renderSheet();
    expect(loading.queryByTestId('reactions-list')).toBeNull();
    loading.unmount();

    mockSafety.isLoading = false;
    mockSafety.isError = true;
    const failed = renderSheet();
    fireEvent.press(failed.getByTestId('reactions-sheet-safety-retry'));
    expect(mockSafety.refetch).toHaveBeenCalled();
  });

  it('lists each reactor with their emoji and marks my row', () => {
    const { getByText, getAllByText, getByTestId } = renderSheet();

    expect(getByText('You')).toBeTruthy();
    expect(getByText('Tap to remove')).toBeTruthy();
    expect(getByText('Mateo')).toBeTruthy();
    expect(getByText('Abuela')).toBeTruthy();
    expect(getAllByText('😂')).toHaveLength(2); // one per row; chip labels read "😂 2"
    expect(getByTestId('reaction-row-user-2')).toBeTruthy();
  });

  it('filters by emoji chip', () => {
    const { queryByTestId, getByTestId } = renderSheet();

    fireEvent.press(getByTestId('reactions-filter-❤️'));
    expect(queryByTestId('reaction-row-user-2')).toBeTruthy();
    expect(queryByTestId('reaction-row-user-1')).toBeNull();

    fireEvent.press(getByTestId('reactions-filter-all'));
    expect(queryByTestId('reaction-row-user-1')).toBeTruthy();
  });

  it('removes my reaction when tapping my row', () => {
    const { getByTestId } = renderSheet();
    fireEvent.press(getByTestId('reaction-row-user-1'));
    expect(setReaction).toHaveBeenCalledWith(null);
  });

  it('closes from the explicit close button', () => {
    const { getByTestId, onClose } = renderSheet();
    fireEvent.press(getByTestId('reactions-sheet-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows loading, empty and error states', () => {
    mockEngagement({ areReactionsLoading: true, reactions: [] });
    const loading = renderSheet();
    expect(loading.queryByTestId('reactions-list')).toBeNull();
    loading.unmount();

    mockEngagement({ reactions: [], likeCount: 0 });
    const empty = renderSheet();
    expect(empty.getByTestId('reactions-sheet-empty')).toBeTruthy();
    empty.unmount();

    const refetchReactions = jest.fn();
    mockEngagement({ reactions: [], reactionsError: new Error('x'), refetchReactions });
    const error = renderSheet();
    fireEvent.press(error.getByTestId('reactions-sheet-retry'));
    expect(refetchReactions).toHaveBeenCalled();
  });
});
