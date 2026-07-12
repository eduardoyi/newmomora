import { renderHook } from '@testing-library/react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { Platform } from 'react-native';

import {
  isNotificationsAvailable,
  routeFromPushData,
  useNotificationsRegistration,
} from '@/hooks/useNotifications';
import { useUserProfile } from '@/hooks/useUserProfile';
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

jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn(),
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
const mockedUseUserProfile = useUserProfile as jest.MockedFunction<typeof useUserProfile>;
const mockedGetPermissions = Notifications.getPermissionsAsync as jest.MockedFunction<
  typeof Notifications.getPermissionsAsync
>;
const mockedRequestPermissions = Notifications.requestPermissionsAsync as jest.MockedFunction<
  typeof Notifications.requestPermissionsAsync
>;
const mockedGetExpoPushToken = Notifications.getExpoPushTokenAsync as jest.MockedFunction<
  typeof Notifications.getExpoPushTokenAsync
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

describe('useNotificationsRegistration requestRegistration', () => {
  const originalOS = Platform.OS;
  const updateProfile = jest.fn().mockResolvedValue(undefined);

  // Render with enabled: false so the mount-time effect stays quiet and each
  // test exercises exactly one explicit requestRegistration() call.
  function renderRegistration() {
    return renderHook(() => useNotificationsRegistration(false)).result.current;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    Platform.OS = 'android';
    mockedRequireOptionalNativeModule.mockReturnValue({});
    mockedUseUserProfile.mockReturnValue({ updateProfile } as never);
    mockedGetPermissions.mockResolvedValue({ status: 'granted', canAskAgain: true } as never);
    mockedGetExpoPushToken.mockResolvedValue({ data: 'ExponentPushToken[abc]' } as never);
  });

  afterEach(() => {
    Platform.OS = originalOS;
  });

  it('saves the expo push token on the happy path', async () => {
    const { requestRegistration } = renderRegistration();

    await expect(requestRegistration()).resolves.toEqual({ granted: true, canAskAgain: true });
    expect(updateProfile).toHaveBeenCalledWith({ expoPushToken: 'ExponentPushToken[abc]' });
  });

  it('still reports granted when the token fetch throws (e.g. missing Firebase config), warning instead of rejecting', async () => {
    mockedGetExpoPushToken.mockRejectedValue(
      new Error('Default FirebaseApp is not initialized in this process com.momora.app'),
    );
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(jest.fn());

    const { requestRegistration } = renderRegistration();

    await expect(requestRegistration()).resolves.toEqual({ granted: true, canAskAgain: true });
    expect(updateProfile).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Default FirebaseApp is not initialized'),
    );

    warnSpy.mockRestore();
  });

  it('reports granted when saving the token to the profile fails', async () => {
    updateProfile.mockRejectedValueOnce(new Error('network down'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(jest.fn());

    const { requestRegistration } = renderRegistration();

    await expect(requestRegistration()).resolves.toEqual({ granted: true, canAskAgain: true });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('network down'));

    warnSpy.mockRestore();
  });

  it('resolves not-granted instead of rejecting when the permission check itself throws', async () => {
    mockedGetPermissions.mockRejectedValue(new Error('permissions unavailable'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(jest.fn());

    const { requestRegistration } = renderRegistration();

    await expect(requestRegistration()).resolves.toEqual({ granted: false, canAskAgain: true });
    expect(updateProfile).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('permissions unavailable'));

    warnSpy.mockRestore();
  });

  it('resolves denied results from the permission prompt without touching the token', async () => {
    mockedGetPermissions.mockResolvedValue({ status: 'undetermined', canAskAgain: true } as never);
    mockedRequestPermissions.mockResolvedValue({ status: 'denied', canAskAgain: false } as never);

    const { requestRegistration } = renderRegistration();

    await expect(requestRegistration()).resolves.toEqual({ granted: false, canAskAgain: false });
    expect(mockedGetExpoPushToken).not.toHaveBeenCalled();
    expect(updateProfile).not.toHaveBeenCalled();
  });
});
