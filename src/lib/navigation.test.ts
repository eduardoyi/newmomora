import { router } from 'expo-router';

import { navigateBack } from '@/lib/navigation';
import { timelineRoute } from '@/lib/routes';

jest.mock('expo-router', () => ({
  router: {
    canGoBack: jest.fn(),
    back: jest.fn(),
    replace: jest.fn(),
  },
}));

describe('navigateBack', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('goes back when navigation history exists', () => {
    jest.mocked(router.canGoBack).mockReturnValue(true);

    navigateBack();

    expect(router.back).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('replaces with the timeline when there is no history', () => {
    jest.mocked(router.canGoBack).mockReturnValue(false);

    navigateBack();

    expect(router.back).not.toHaveBeenCalled();
    expect(router.replace).toHaveBeenCalledWith(timelineRoute);
  });
});
