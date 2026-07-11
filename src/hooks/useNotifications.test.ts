import { router } from 'expo-router';

import { routeFromPushData } from '@/hooks/useNotifications';
import { sharingApprovalsRoute, timelineRoute } from '@/lib/routes';

jest.mock('expo-router', () => ({
  router: {
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
  },
}));

// useNotifications.ts also exports the registration hook, which pulls in
// useUserProfile -> the Supabase client -> AsyncStorage's native module
// (unavailable under plain Jest). routeFromPushData doesn't touch any of
// that, so stub the hook out rather than dragging the whole chain in.
jest.mock('@/hooks/useUserProfile', () => ({
  useUserProfile: jest.fn(),
}));

const mockedPush = router.push as jest.MockedFunction<typeof router.push>;

describe('routeFromPushData (plan §10 push deep links)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('routes to the approvals screen for an invite-redeemed push', () => {
    routeFromPushData({ route: 'approvals', familyId: 'family-1' });

    expect(mockedPush).toHaveBeenCalledWith(sharingApprovalsRoute);
  });

  it('routes to the timeline for a new-memory-activity push', () => {
    routeFromPushData({ route: 'timeline', familyId: 'family-1', memoryId: 'memory-1' });

    expect(mockedPush).toHaveBeenCalledWith(timelineRoute);
  });

  it('routes to the timeline for an invite-approved push', () => {
    routeFromPushData({ route: 'timeline', familyId: 'family-1' });

    expect(mockedPush).toHaveBeenCalledWith(timelineRoute);
  });

  it('does nothing for a push with no data payload', () => {
    routeFromPushData(undefined);

    expect(mockedPush).not.toHaveBeenCalled();
  });

  it('does nothing for a push with an unrecognized route', () => {
    routeFromPushData({ route: 'something-else' });

    expect(mockedPush).not.toHaveBeenCalled();
  });

  it('does nothing for the plain daily-reminder push (no route field)', () => {
    routeFromPushData({});

    expect(mockedPush).not.toHaveBeenCalled();
  });
});
