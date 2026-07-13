import { fireEvent, render } from '@testing-library/react-native';

import { MemoryEngagementBar } from './memory-engagement-bar';
import { useMemoryEngagement } from '@/hooks/useMemoryEngagement';

jest.mock('@/hooks/useMemoryEngagement', () => ({ useMemoryEngagement: jest.fn() }));
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: 'light' },
}));

const mockedUseMemoryEngagement = useMemoryEngagement as jest.MockedFunction<typeof useMemoryEngagement>;

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

const memory = { id: 'memory-1' } as never;

describe('MemoryEngagementBar', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEngagement();
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
});
