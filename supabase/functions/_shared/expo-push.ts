/**
 * Shared Expo push helper, extracted from send-daily-reminder so
 * family-sharing lifecycle functions (delete-user-account) can send
 * heads-up notifications without duplicating the fetch call.
 */

/**
 * Deep-link routing conventions carried in the push `data` payload (plan
 * §10, deliverable 6). The client's notification-response listener
 * (`src/hooks/useNotifications.ts`) switches on `route`:
 * - 'timeline': open the family timeline (optionally scoped to `memoryId`)
 * - 'approvals': open the pending-approvals screen
 * `familyId`/`memoryId` are informational -- the client doesn't currently
 * filter on them, but carrying them keeps the payload forward-compatible.
 */
export interface PushRouteData {
  route: 'timeline' | 'approvals';
  familyId?: string;
  memoryId?: string;
}

export async function sendExpoPushNotification(
  expoPushToken: string,
  title: string,
  body: string,
  data?: PushRouteData,
): Promise<boolean> {
  const response = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      to: expoPushToken,
      title,
      body,
      sound: 'default',
      ...(data ? { data } : {}),
    }),
  });

  return response.ok;
}
