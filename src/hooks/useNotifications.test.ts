import { requireOptionalNativeModule } from 'expo-modules-core';
import { router } from 'expo-router';
import { Platform } from 'react-native';

import { isNotificationsAvailable, routeFromPushData } from '@/hooks/useNotifications';
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

// isNotificationsAvailable() is exercised directly below with a controlled
// mock, rather than relying on jest-expo's automocking of native modules.
// Other expo internals (e.g. the winter fetch runtime) call into the same
// module at import time, so keep everything else intact.
jest.mock('expo-modules-core', () => ({
  ...jest.requireActual('expo-modules-core'),
  requireOptionalNativeModule: jest.fn(),
}));

const mockedPush = router.push as jest.MockedFunction<typeof router.push>;
const mockedRequireOptionalNativeModule = requireOptionalNativeModule as jest.MockedFunction<
  typeof requireOptionalNativeModule
>;

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

describe('isNotificationsAvailable', () => {
  const originalOS = Platform.OS;

  afterEach(() => {
    Platform.OS = originalOS;
    jest.clearAllMocks();
  });

  it('returns false on web regardless of native module presence', () => {
    Platform.OS = 'web';
    mockedRequireOptionalNativeModule.mockReturnValue({});

    expect(isNotificationsAvailable()).toBe(false);
    expect(mockedRequireOptionalNativeModule).not.toHaveBeenCalled();
  });

  it('returns true when the ExpoPushTokenManager module is registered (native)', () => {
    Platform.OS = 'ios';
    mockedRequireOptionalNativeModule.mockReturnValue({});

    expect(isNotificationsAvailable()).toBe(true);
    expect(mockedRequireOptionalNativeModule).toHaveBeenCalledWith('ExpoPushTokenManager');
  });

  it('returns false when the module registry has no ExpoPushTokenManager (e.g. Expo Go)', () => {
    Platform.OS = 'android';
    mockedRequireOptionalNativeModule.mockReturnValue(null);

    expect(isNotificationsAvailable()).toBe(false);
  });

  it('returns false if the module lookup throws', () => {
    Platform.OS = 'android';
    mockedRequireOptionalNativeModule.mockImplementation(() => {
      throw new Error('boom');
    });

    expect(isNotificationsAvailable()).toBe(false);
  });
});
