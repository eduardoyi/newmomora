import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import { validateCronSecret } from '../_shared/cron.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { sendExpoPushNotification } from '../_shared/expo-push.ts';
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

// Re-exported for existing importers -- the implementation now lives in
// _shared/expo-push.ts so delete-user-account can reuse it.
export { sendExpoPushNotification };

export async function processSendDailyReminder(
  serviceClient: SupabaseClient,
  userId: string,
): Promise<Response> {
  const { data: profile, error } = await serviceClient
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
  // Deep-link straight to the create-memory screen -- the whole point of the
  // reminder is to capture a moment, so tapping it should never just open
  // the app wherever it was last left.
  const sent = await sendExpoPushNotification(profile.expo_push_token, 'Momora', message, {
    route: 'new-memory',
  });

  if (!sent) {
    return errorResponse('Failed to send push notification', 500, 'PUSH_FAILED');
  }

  return jsonResponse({ success: true } satisfies SendDailyReminderResponse);
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

  return processSendDailyReminder(createServiceClient(), userId);
}

if (import.meta.main) {
  Deno.serve(handleSendDailyReminder);
}
