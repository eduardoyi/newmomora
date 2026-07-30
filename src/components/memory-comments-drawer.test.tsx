import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert, Keyboard, StyleSheet } from 'react-native';
import { State } from 'react-native-gesture-handler';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import {
  getCommentsDrawerBottomPadding,
  getCommentsKeyboardAvoidingBehavior,
  MemoryCommentsDrawer,
  shouldDismissCommentsDrawer,
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
jest.mock('@/hooks/useContentSafety', () => ({
  useContentSafety: () => ({
    isLoading: false, isError: false, isReporting: false,
    isTargetReported: () => false, hasActiveReport: () => false,
    isUserBlocked: () => false, revealTarget: jest.fn(), revealBlockedUser: jest.fn(),
    report: jest.fn(), refetch: jest.fn(),
  }),
}));
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

  function renderDrawer(onClose = jest.fn()) {
    const drawer = (visible: boolean) => (
      <SafeAreaProvider
        initialMetrics={{
          frame: { height: 844, width: 390, x: 0, y: 0 },
          insets: { bottom: 34, left: 0, right: 0, top: 47 },
        }}
      >
        <MemoryCommentsDrawer
          memory={{ id: 'memory-1' } as never}
          onClose={onClose}
          visible={visible}
        />
      </SafeAreaProvider>
    );
    const view = render(drawer(true));

    return {
      ...view,
      onClose,
      rerenderDrawer: (visible: boolean) => view.rerender(drawer(visible)),
    };
  }

  function drawerTranslateY(style: unknown) {
    const transform = StyleSheet.flatten(style)?.transform as { translateY?: number }[] | undefined;
    return transform?.find((entry) => entry.translateY !== undefined)?.translateY;
  }

  it('shows account attribution and posts from the fixed composer', async () => {
    const { getByTestId, getByText } = renderDrawer();

    expect(getByText('Sam · you')).toBeTruthy();
    fireEvent.changeText(getByTestId('comment-input'), 'A new comment');
    fireEvent.press(getByTestId('comment-submit'));

    await waitFor(() => expect(addComment).toHaveBeenCalledWith('A new comment'));
  });

  it('lets the author delete from the explicit comment actions', () => {
    jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.text === 'Delete')?.onPress?.();
    });
    const { getByTestId } = renderDrawer();

    fireEvent.press(getByTestId('comment-comment-1-actions'));
    fireEvent.press(getByTestId('comment-action-delete', { includeHiddenElements: true }));
    expect(deleteComment).toHaveBeenCalledWith(ownComment);
  });

  it('uses adaptive keyboard avoidance without a fixed sheet height', () => {
    const { getByTestId } = renderDrawer();
    const sheetStyle = StyleSheet.flatten(getByTestId('comments-drawer').props.style);

    expect(getCommentsKeyboardAvoidingBehavior('ios', false)).toBe('padding');
    expect(getCommentsKeyboardAvoidingBehavior('android', true)).toBe('height');
    expect(getCommentsKeyboardAvoidingBehavior('android', false)).toBeUndefined();
    expect(sheetStyle.flex).toBe(1);
    expect(sheetStyle.maxHeight).toBe('80%');
    expect(sheetStyle.height).toBeUndefined();
  });

  it('removes the safe-area spacer while typing and restores it after keyboard close', () => {
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

  it('dismisses from a deliberate downward handle drag exactly once', async () => {
    const dismissKeyboardSpy = jest.spyOn(Keyboard, 'dismiss');
    const onClose = jest.fn();
    const { getByTestId } = renderDrawer(onClose);

    await act(async () => {
      fireGestureHandler(getByGestureTestId('comments-drawer-dismiss-pan'), [
        { state: State.BEGAN, translationY: 0, velocityY: 0 },
        { state: State.ACTIVE, translationY: 128, velocityY: 0 },
        { state: State.END, translationY: 128, velocityY: 0 },
      ]);
    });

    expect(dismissKeyboardSpy).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.press(getByTestId('comments-drawer-backdrop', { includeHiddenElements: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
    dismissKeyboardSpy.mockRestore();
  });

  it('snaps a short, slow handle drag back instead of dismissing', async () => {
    const onClose = jest.fn();
    const { getByTestId, rerenderDrawer } = renderDrawer(onClose);

    await act(async () => {
      fireGestureHandler(getByGestureTestId('comments-drawer-dismiss-pan'), [
        { state: State.BEGAN, translationY: 0, velocityY: 0 },
        { state: State.ACTIVE, translationY: 48, velocityY: 0 },
        { state: State.END, translationY: 48, velocityY: 0 },
      ]);
    });

    expect(onClose).not.toHaveBeenCalled();
    rerenderDrawer(true);
    expect(drawerTranslateY(getByTestId('comments-drawer').props.style)).toBe(0);
  });

  it('snaps a cancelled handle drag back instead of leaving the drawer displaced', async () => {
    const onClose = jest.fn();
    const { getByTestId, rerenderDrawer } = renderDrawer(onClose);

    await act(async () => {
      fireGestureHandler(getByGestureTestId('comments-drawer-dismiss-pan'), [
        { state: State.BEGAN, translationY: 0, velocityY: 0 },
        { state: State.ACTIVE, translationY: 72, velocityY: 0 },
        { state: State.CANCELLED, translationY: 72, velocityY: 0 },
      ]);
    });

    rerenderDrawer(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(drawerTranslateY(getByTestId('comments-drawer').props.style)).toBe(0);
  });

  it('clamps an upward handle drag, allows a fast downward flick, and resets for reopening', async () => {
    const onClose = jest.fn();
    const { getByTestId, rerenderDrawer } = renderDrawer(onClose);

    await act(async () => {
      fireGestureHandler(getByGestureTestId('comments-drawer-dismiss-pan'), [
        { state: State.BEGAN, translationY: 0, velocityY: 0 },
        { state: State.ACTIVE, translationY: -48, velocityY: 0 },
        { state: State.END, translationY: -48, velocityY: 0 },
      ]);
    });

    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      fireGestureHandler(getByGestureTestId('comments-drawer-dismiss-pan'), [
        { state: State.BEGAN, translationY: 0, velocityY: 0 },
        { state: State.ACTIVE, translationY: 12, velocityY: 950 },
        { state: State.END, translationY: 12, velocityY: 950 },
      ]);
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(shouldDismissCommentsDrawer(119, 899)).toBe(false);

    await act(async () => {
      rerenderDrawer(false);
    });
    await act(async () => {
      rerenderDrawer(true);
    });

    expect(drawerTranslateY(getByTestId('comments-drawer').props.style)).toBe(0);
    fireEvent.press(getByTestId('comments-drawer-close'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
