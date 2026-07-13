/**
 * Shared Expo push helper, extracted from send-daily-reminder so
 * family-sharing lifecycle functions (delete-user-account) can send
 * heads-up notifications without duplicating the fetch call.
 */

/**
 * Deep-link routing conventions carried in the push `data` payload (plan
 * §10, deliverable 6). Must stay in sync with `PushRouteData` in
 * `src/hooks/useNotifications.ts` -- the two can't share a type import
 * across the Deno/RN boundary. The client's notification-response listener
 * switches on `route`:
 * - 'timeline': open the family timeline
 * - 'approvals': open the pending-approvals screen
 * - 'new-memory': open the create-memory screen (send-daily-reminder)
 * - 'memory': open the memory detail screen for `memoryId`
 *   (notify-family-activity's new-memory push)
 * `familyId` is required for 'memory' so the client can reconcile the
 * recipient's active family before navigating; it's otherwise informational.
 */
export interface PushRouteData {
  route: 'timeline' | 'approvals' | 'new-memory' | 'memory';
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
