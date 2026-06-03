import { NativeModules, Platform } from 'react-native';
import { useEffect } from 'react';

import { useUserProfile } from '@/hooks/useUserProfile';

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
