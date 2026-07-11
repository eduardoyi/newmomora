/**
 * Shared Expo push helper, extracted from send-daily-reminder so
 * family-sharing lifecycle functions (delete-user-account) can send
 * heads-up notifications without duplicating the fetch call.
 */
export async function sendExpoPushNotification(
  expoPushToken: string,
  title: string,
  body: string,
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
    }),
  });

  return response.ok;
}
