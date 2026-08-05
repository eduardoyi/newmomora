import { fireEvent, render } from '@testing-library/react-native';

import { MemoryEngagementBar } from './memory-engagement-bar';
import { useFamily } from '@/hooks/use-family';
import { useMemoryEngagement } from '@/hooks/useMemoryEngagement';
import { useShareMemoryCard } from '@/hooks/useShareMemoryCard';

jest.mock('@/hooks/useMemoryEngagement', () => ({ useMemoryEngagement: jest.fn() }));
jest.mock('@/hooks/use-family', () => ({ useFamily: jest.fn() }));
jest.mock('@/hooks/useShareMemoryCard', () => ({ useShareMemoryCard: jest.fn() }));
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light' },
}));

const mockedUseMemoryEngagement = useMemoryEngagement as jest.MockedFunction<typeof useMemoryEngagement>;
const mockedUseFamily = useFamily as jest.Mock;
const mockedUseShareMemoryCard = useShareMemoryCard as jest.Mock;

function mockEngagement(overrides: Record<string, unknown> = {}) {
  mockedUseMemoryEngagement.mockReturnValue({
    likedByMe: false,
    likeCount: 0,
    commentCount: 0,
    toggleLike: jest.fn().mockResolvedValue(undefined),
    isUpdatingLike: false,
    likeError: null,
    comments: [],
    areCommentsLoading: false,
    commentsError: null,
    refetchComments: jest.fn(),
    addComment: jest.fn(),
    isAddingComment: false,
    addCommentError: null,
    deleteComment: jest.fn(),
    isDeletingComment: false,
    deleteCommentError: null,
    ...overrides,
  } as never);
}

function mockFamily(overrides: Record<string, unknown> = {}) {
  mockedUseFamily.mockReturnValue({
    familyId: 'family-1',
    role: 'owner',
    family: { id: 'family-1', name: 'The Family', viewerSharingEnabled: true },
    memberships: [],
    isLoading: false,
    setActiveFamily: jest.fn(),
    refetchMemberships: jest.fn(),
    justLostAccess: false,
    ...overrides,
  });
}

function mockShare(overrides: Record<string, unknown> = {}) {
  mockedUseShareMemoryCard.mockReturnValue({
    shareMemoryCard: jest.fn().mockResolvedValue(undefined),
    isSharing: false,
    ...overrides,
  });
}

const memory = { id: 'memory-1', memory_date: '2026-07-14' } as never;

describe('MemoryEngagementBar', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEngagement();
    mockFamily();
    mockShare();
  });

  it('hides zero counts', () => {
    const { queryByText } = render(
      <MemoryEngagementBar memory={memory} onOpenComments={jest.fn()} />,
    );
    expect(queryByText('0')).toBeNull();
  });

  it('shows non-zero counts and delegates both actions', () => {
    const toggleLike = jest.fn().mockResolvedValue(undefined);
    const openComments = jest.fn();
    mockEngagement({ likeCount: 3, commentCount: 2, toggleLike });

    const { getByTestId, getByText } = render(
      <MemoryEngagementBar memory={memory} onOpenComments={openComments} />,
    );

    expect(getByText('3')).toBeTruthy();
    expect(getByText('2')).toBeTruthy();
    fireEvent.press(getByTestId('memory-like-memory-1'));
    fireEvent.press(getByTestId('memory-comments-memory-1'));
    expect(toggleLike).toHaveBeenCalledTimes(1);
    expect(openComments).toHaveBeenCalledTimes(1);
  });

  describe('share icon prop gating (Workstream S4)', () => {
    it('does not render the share icon by default', () => {
      const { queryByTestId } = render(
        <MemoryEngagementBar memory={memory} onOpenComments={jest.fn()} />,
      );
      expect(queryByTestId('memory-share-memory-1')).toBeNull();
    });

    it('renders the share icon when enableShare is set', () => {
      const { getByTestId } = render(
        <MemoryEngagementBar memory={memory} onOpenComments={jest.fn()} enableShare />,
      );
      expect(getByTestId('memory-share-memory-1')).toBeTruthy();
    });
  });

  describe('share visibility matrix', () => {
    it('hides the icon for a viewer when the family has sharing off', () => {
      mockFamily({ role: 'viewer', family: { id: 'f', name: 'F', viewerSharingEnabled: false } });
      const { queryByTestId } = render(
        <MemoryEngagementBar memory={memory} onOpenComments={jest.fn()} enableShare />,
      );
      expect(queryByTestId('memory-share-memory-1')).toBeNull();
    });

    it('shows the icon for a viewer when the family allows sharing', () => {
      mockFamily({ role: 'viewer', family: { id: 'f', name: 'F', viewerSharingEnabled: true } });
      const { getByTestId } = render(
        <MemoryEngagementBar memory={memory} onOpenComments={jest.fn()} enableShare />,
      );
      expect(getByTestId('memory-share-memory-1')).toBeTruthy();
    });

    it('treats a missing viewerSharingEnabled flag as enabled for a viewer', () => {
      mockFamily({ role: 'viewer', family: { id: 'f', name: 'F', viewerSharingEnabled: undefined } });
      const { getByTestId } = render(
        <MemoryEngagementBar memory={memory} onOpenComments={jest.fn()} enableShare />,
      );
      expect(getByTestId('memory-share-memory-1')).toBeTruthy();
    });

    it('always shows the icon for an owner regardless of the toggle', () => {
      mockFamily({ role: 'owner', family: { id: 'f', name: 'F', viewerSharingEnabled: false } });
      const { getByTestId } = render(
        <MemoryEngagementBar memory={memory} onOpenComments={jest.fn()} enableShare />,
      );
      expect(getByTestId('memory-share-memory-1')).toBeTruthy();
    });

    it('always shows the icon for a manager regardless of the toggle', () => {
      mockFamily({ role: 'manager', family: { id: 'f', name: 'F', viewerSharingEnabled: false } });
      const { getByTestId } = render(
        <MemoryEngagementBar memory={memory} onOpenComments={jest.fn()} enableShare />,
      );
      expect(getByTestId('memory-share-memory-1')).toBeTruthy();
    });
  });

  it('disables (dims) the share icon on a video page without hiding it', () => {
    const { getByTestId } = render(
      <MemoryEngagementBar
        currentMediaAssetId="asset-1"
        isCurrentPageVideo
        memory={memory}
        onOpenComments={jest.fn()}
        enableShare
      />,
    );
    const icon = getByTestId('memory-share-memory-1');
    expect(icon.props.accessibilityState.disabled).toBe(true);
  });

  it('shows a spinner and disables the icon while a share is pending', () => {
    mockShare({ isSharing: true });
    const { getByTestId } = render(
      <MemoryEngagementBar memory={memory} onOpenComments={jest.fn()} enableShare />,
    );
    const icon = getByTestId('memory-share-memory-1');
    expect(icon.props.accessibilityState.busy).toBe(true);
    expect(icon.props.accessibilityState.disabled).toBe(true);
  });

  it('delegates a tap to shareMemoryCard with the memory and the current media asset id', () => {
    const shareMemoryCard = jest.fn().mockResolvedValue(undefined);
    mockShare({ shareMemoryCard });
    const { getByTestId } = render(
      <MemoryEngagementBar
        currentMediaAssetId="asset-2"
        memory={memory}
        onOpenComments={jest.fn()}
        enableShare
      />,
    );

    fireEvent.press(getByTestId('memory-share-memory-1'));

    expect(shareMemoryCard).toHaveBeenCalledWith(memory, 'asset-2');
  });

  it('passes undefined (not null) when there is no current media asset id', () => {
    const shareMemoryCard = jest.fn().mockResolvedValue(undefined);
    mockShare({ shareMemoryCard });
    const { getByTestId } = render(
      <MemoryEngagementBar memory={memory} onOpenComments={jest.fn()} enableShare />,
    );

    fireEvent.press(getByTestId('memory-share-memory-1'));

    expect(shareMemoryCard).toHaveBeenCalledWith(memory, undefined);
  });
});
