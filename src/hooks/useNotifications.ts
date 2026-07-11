import { NativeModules, Platform } from 'react-native';
import { router } from 'expo-router';
import { useEffect } from 'react';

import { useUserProfile } from '@/hooks/useUserProfile';
import { sharingApprovalsRoute, timelineRoute } from '@/lib/routes';

export function isNotificationsAvailable(): boolean {
  if (Platform.OS === 'web') {
    return false;
  }

  return Boolean(
    NativeModules.ExpoPushTokenManager ||
      (NativeModules as Record<string, unknown>).ExpoNotifications,
  );
}

export function useNotificationsRegistration(enabled: boolean) {
  const { updateProfile } = useUserProfile();

  useEffect(() => {
    if (!enabled || !isNotificationsAvailable()) {
      return;
    }

    void registerForPushNotifications(updateProfile);
  }, [enabled, updateProfile]);
}

async function registerForPushNotifications(
  updateProfile: ReturnType<typeof useUserProfile>['updateProfile'],
): Promise<void> {
  const Notifications = await import('expo-notifications');

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

  if (finalStatus !== 'granted') {
    const requested = await Notifications.requestPermissionsAsync();
    finalStatus = requested.status;
  }

  if (finalStatus !== 'granted') {
    return;
  }

  const token = await Notifications.getExpoPushTokenAsync();
  await updateProfile({ expoPushToken: token.data });
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

    let subscription: { remove: () => void } | undefined;
    let cancelled = false;

    void (async () => {
      const Notifications = await import('expo-notifications');

      if (cancelled) {
        return;
      }

      subscription = Notifications.addNotificationResponseReceivedListener((response) => {
        routeFromPushData(response.notification.request.content.data);
      });
    })();

    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, []);
}
