import { act, renderHook } from '@testing-library/react-native';

import { MODAL_DISMISS_DELAY_MS, useLeaveKeepsakesPage } from '@/hooks/useLeaveKeepsakesPage';

const mockRouter = { back: jest.fn(), canGoBack: jest.fn(() => true), replace: jest.fn() };
jest.mock('expo-router', () => ({
  get router() {
    return mockRouter;
  },
}));

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockRouter.canGoBack.mockReturnValue(true);
});
afterEach(() => jest.useRealTimers());

describe('useLeaveKeepsakesPage', () => {
  it('goes back when there is history', () => {
    const { result } = renderHook(() => useLeaveKeepsakesPage());
    result.current.leave();
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it('replaces with the Keepsakes tab when there is nothing to go back to', () => {
    mockRouter.canGoBack.mockReturnValue(false);
    const { result } = renderHook(() => useLeaveKeepsakesPage());
    result.current.leave();
    expect(mockRouter.back).not.toHaveBeenCalled();
    expect(mockRouter.replace).toHaveBeenCalledWith('/(app)/(tabs)/keepsakes');
  });

  it('waits for the Modal to dismiss before leaving', () => {
    const { result } = renderHook(() => useLeaveKeepsakesPage());
    result.current.leaveAfterModalDismiss();
    expect(mockRouter.back).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(MODAL_DISMISS_DELAY_MS);
    });
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });

  it('does not navigate after unmount', () => {
    const { result, unmount } = renderHook(() => useLeaveKeepsakesPage());
    result.current.leaveAfterModalDismiss();
    unmount();
    jest.advanceTimersByTime(MODAL_DISMISS_DELAY_MS * 2);
    expect(mockRouter.back).not.toHaveBeenCalled();
  });
});
