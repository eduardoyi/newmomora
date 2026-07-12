import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { router } from 'expo-router';
import { useCallback, useEffect } from 'react';

import { useUserProfile } from '@/hooks/useUserProfile';
import { sharingApprovalsRoute, timelineRoute } from '@/lib/routes';

/**
 * expo-notifications registers its native module through expo-modules-core's
 * module registry (`global.expo.modules`), not React Native's `NativeModules`
 * -- so detection has to go through `requireOptionalNativeModule`, which
 * returns `null` instead of throwing when the module isn't installed (e.g.
 * Expo Go, or a dev client built before this module was added).
 */
export function isNotificationsAvailable(): boolean {
  if (Platform.OS === 'web') {
    return false;
  }

  try {
    return Boolean(requireOptionalNativeModule('ExpoPushTokenManager'));
  } catch {
    return false;
  }
}

/** Result of a registration attempt, so callers can react to a denial (see settings.tsx). */
export interface PushRegistrationResult {
  granted: boolean;
  canAskAgain: boolean;
}

export function useNotificationsRegistration(enabled: boolean) {
  const { updateProfile } = useUserProfile();

  useEffect(() => {
    if (!enabled || !isNotificationsAvailable()) {
      return;
    }

    void registerForPushNotifications(updateProfile);
  }, [enabled, updateProfile]);

  // Explicit registration for callers that need to react to the outcome
  // (e.g. a toggle switching ON should prompt for settings on denial --
  // the mount-time effect above stays silent on purpose).
  const requestRegistration = useCallback(async (): Promise<PushRegistrationResult | null> => {
    if (!isNotificationsAvailable()) {
      return null;
    }

    return registerForPushNotifications(updateProfile);
  }, [updateProfile]);

  return { requestRegistration };
}

function warnRegistrationFailure(step: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`Push notification ${step} failed: ${message}`);
}

// Lazy require keeps expo-notifications out of app startup (it's only needed
// once a notification setting is enabled). A require rather than a dynamic
// import() so Jest can resolve it through its module registry.
function loadNotifications(): typeof import('expo-notifications') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('expo-notifications');
}

// Never throws: the mount-time effect fires this as a fire-and-forget `void`
// call, so any rejection would surface as an unhandled rejection (dev
// red-box). E.g. getExpoPushTokenAsync throws on Android when the binary
// predates google-services.json ("Default FirebaseApp is not initialized").
async function registerForPushNotifications(
  updateProfile: ReturnType<typeof useUserProfile>['updateProfile'],
): Promise<PushRegistrationResult> {
  let canAskAgain = true;

  try {
    const Notifications = loadNotifications();

    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });

    const permissions = await Notifications.getPermissionsAsync();

    let finalStatus = permissions.status;
    canAskAgain = permissions.canAskAgain;

    if (finalStatus !== 'granted') {
      const requested = await Notifications.requestPermissionsAsync();
      finalStatus = requested.status;
      canAskAgain = requested.canAskAgain;
    }

    if (finalStatus !== 'granted') {
      return { granted: false, canAskAgain };
    }

    // Permission is granted from here on -- report granted: true even if the
    // token fetch/save fails (e.g. missing Firebase config), so the settings
    // screen doesn't show the misleading "notifications are off" alert.
    try {
      const token = await Notifications.getExpoPushTokenAsync();
      await updateProfile({ expoPushToken: token.data });
    } catch (error) {
      warnRegistrationFailure('token registration', error);
    }

    return { granted: true, canAskAgain };
  } catch (error) {
    warnRegistrationFailure('permission check', error);
    return { granted: false, canAskAgain };
  }
}

/**
 * Deep-link data payload carried by pushes (plan §10, deliverable 6). Must
 * stay in sync with `PushRouteData` in
 * `supabase/functions/_shared/expo-push.ts` -- the two can't share a type
 * import across the Deno/RN boundary.
 */
export interface PushRouteData {
  route?: 'timeline' | 'approvals';
  familyId?: string;
  memoryId?: string;
}

export function routeFromPushData(data: unknown): void {
  const payload = data as PushRouteData | undefined;

  if (payload?.route === 'approvals') {
    router.push(sharingApprovalsRoute);
    return;
  }

  if (payload?.route === 'timeline') {
    router.push(timelineRoute);
  }
}

/**
 * Routes to the relevant screen when the user taps a push notification.
 * Mounted once near the app root (app/(app)/_layout.tsx) so it's live for
 * the whole authenticated session, independent of which screen is
 * currently focused.
 */
export function useNotificationResponseRouting(): void {
  useEffect(() => {
    if (!isNotificationsAvailable()) {
      return;
    }

    const Notifications = loadNotifications();

    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      routeFromPushData(response.notification.request.content.data);
    });

    return () => {
      subscription.remove();
    };
  }, []);
}
