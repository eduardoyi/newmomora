import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert, Keyboard, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import {
  getCommentsDrawerBottomPadding,
  getCommentsKeyboardAvoidingBehavior,
  MemoryCommentsDrawer,
} from './memory-comments-drawer';
import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { useMemoryEngagement } from '@/hooks/useMemoryEngagement';
import { useFamilyMemberProfiles } from '@/hooks/useFamilyMemberProfiles';
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
jest.mock('@/services/engagement', () => ({ MAX_COMMENT_LENGTH: 1000 }));

const mockedUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockedUseFamily = useFamily as jest.MockedFunction<typeof useFamily>;
const mockedUseEngagement = useMemoryEngagement as jest.MockedFunction<typeof useMemoryEngagement>;
const mockedUseProfiles = useFamilyMemberProfiles as jest.MockedFunction<typeof useFamilyMemberProfiles>;
const mockedUseUserProfile = useUserProfile as jest.MockedFunction<typeof useUserProfile>;

const ownComment = {
  id: 'comment-1',
  memory_id: 'memory-1',
  user_id: 'user-1',
  content: 'I love this.',
  created_at: new Date().toISOString(),
};

describe('MemoryCommentsDrawer', () => {
  const addComment = jest.fn().mockResolvedValue(ownComment);
  const deleteComment = jest.fn().mockResolvedValue(ownComment);

  beforeEach(() => {
    jest.clearAllMocks();
    mockedUseAuth.mockReturnValue({ user: { id: 'user-1' } } as never);
    mockedUseFamily.mockReturnValue({ familyId: 'family-1', role: 'viewer' } as never);
    mockedUseProfiles.mockReturnValue({
      profiles: [{ user_id: 'user-2', name: 'Mateo' } as never],
      isLoading: false,
      isError: false,
      error: null,
    });
    mockedUseUserProfile.mockReturnValue({ profile: { name: 'Sam' } } as never);
    mockedUseEngagement.mockReturnValue({
      likedByMe: false,
      likeCount: 0,
      commentCount: 1,
      toggleLike: jest.fn(),
      isUpdatingLike: false,
      likeError: null,
      comments: [ownComment],
      areCommentsLoading: false,
      commentsError: null,
      refetchComments: jest.fn(),
      addComment,
      isAddingComment: false,
      addCommentError: null,
      deleteComment,
      isDeletingComment: false,
      deleteCommentError: null,
    } as never);
  });

  function renderDrawer() {
    return render(
      <SafeAreaProvider
        initialMetrics={{
          frame: { height: 844, width: 390, x: 0, y: 0 },
          insets: { bottom: 34, left: 0, right: 0, top: 47 },
        }}
      >
        <MemoryCommentsDrawer
          memory={{ id: 'memory-1' } as never}
          onClose={jest.fn()}
          visible
        />
      </SafeAreaProvider>,
    );
  }

  it('shows account attribution and posts from the fixed composer', async () => {
    const { getByTestId, getByText } = renderDrawer();

    expect(getByText('Sam · you')).toBeTruthy();
    fireEvent.changeText(getByTestId('comment-input'), 'A new comment');
    fireEvent.press(getByTestId('comment-submit'));

    await waitFor(() => expect(addComment).toHaveBeenCalledWith('A new comment'));
  });

  it('lets the author long-press and confirm deletion', () => {
    jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.text === 'Delete')?.onPress?.();
    });
    const { getByTestId } = renderDrawer();

    fireEvent(getByTestId('comment-comment-1'), 'longPress');
    expect(deleteComment).toHaveBeenCalledWith(ownComment);
  });

  it('uses one keyboard-resize strategy and sizes the sheet to the visible viewport', () => {
    const { getByTestId } = renderDrawer();
    const sheetStyle = StyleSheet.flatten(getByTestId('comments-drawer').props.style);

    expect(getCommentsKeyboardAvoidingBehavior('ios')).toBe('padding');
    expect(getCommentsKeyboardAvoidingBehavior('android')).toBeUndefined();
    expect(sheetStyle.flex).toBe(1);
    expect(sheetStyle.maxHeight).toBe('80%');
    expect(sheetStyle.height).toBeUndefined();
  });

  it('removes the safe-area spacer while the keyboard is visible', () => {
    const keyboardListeners: Record<string, () => void> = {};
    const addListenerSpy = jest.spyOn(Keyboard, 'addListener').mockImplementation(
      (event, listener) => {
        keyboardListeners[event] = listener as () => void;
        return { remove: jest.fn() } as never;
      },
    );
    const { getByTestId } = renderDrawer();

    expect(getCommentsDrawerBottomPadding(34, false)).toBe(34);
    expect(StyleSheet.flatten(getByTestId('comments-drawer').props.style).paddingBottom).toBe(34);

    act(() => keyboardListeners.keyboardDidShow());
    expect(StyleSheet.flatten(getByTestId('comments-drawer').props.style).paddingBottom).toBe(0);

    act(() => keyboardListeners.keyboardDidHide());
    expect(StyleSheet.flatten(getByTestId('comments-drawer').props.style).paddingBottom).toBe(34);

    addListenerSpy.mockRestore();
  });
});
