import { validateCronSecret } from '../_shared/cron.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

const REMINDER_MESSAGES = [
  'What made you smile with your family today?',
  'Capture a small moment before the day ends.',
  'Your future self will love remembering today.',
  'Take 60 seconds to save a parenting moment.',
  'What do you want to remember about today?',
];

export interface SendDailyReminderRequest {
  userId: string;
}

export interface SendDailyReminderResponse {
  success: true;
  skipped?: boolean;
}

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

export async function handleSendDailyReminder(req: Request): Promise<Response> {
  const corsResponse = handleCors(req);
  if (corsResponse) {
    return corsResponse;
  }

  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405, 'method_not_allowed');
  }

  if (!validateCronSecret(req)) {
    return errorResponse('Unauthorized', 401, 'unauthorized');
  }

  let body: SendDailyReminderRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, 'invalid_json');
  }

  const { userId } = body;

  if (!userId || typeof userId !== 'string') {
    return errorResponse('userId is required', 400, 'validation_error');
  }

  const supabase = createServiceClient();

  const { data: profile, error } = await supabase
    .from('user_profiles')
    .select('enable_daily_reminder, expo_push_token, deleted_at')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    console.error('send-daily-reminder lookup failed', error.message);
    return errorResponse('Failed to load user profile', 500, 'internal_error');
  }

  if (
    !profile ||
    profile.deleted_at ||
    !profile.enable_daily_reminder ||
    !profile.expo_push_token
  ) {
    return jsonResponse({ success: true, skipped: true } satisfies SendDailyReminderResponse);
  }

  const message = REMINDER_MESSAGES[Math.floor(Math.random() * REMINDER_MESSAGES.length)];
  const sent = await sendExpoPushNotification(profile.expo_push_token, 'Momora', message);

  if (!sent) {
    return errorResponse('Failed to send push notification', 500, 'PUSH_FAILED');
  }

  return jsonResponse({ success: true } satisfies SendDailyReminderResponse);
}

if (import.meta.main) {
  Deno.serve(handleSendDailyReminder);
}
