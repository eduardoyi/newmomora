import { validateCronSecret } from '../_shared/cron.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';
import { handleSendDailyReminder } from '../send-daily-reminder/index.ts';

export interface ScheduleDailyRemindersResponse {
  success: true;
  scheduledCount: number;
}

function getLocalHour(timezone: string, reference = new Date()): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hour12: false,
  });

  const hour = Number(formatter.format(reference));
  return Number.isNaN(hour) ? reference.getUTCHours() : hour;
}

function getLocalMinute(timezone: string, reference = new Date()): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    minute: 'numeric',
    hour12: false,
  });

  const minute = Number(formatter.format(reference));
  return Number.isNaN(minute) ? reference.getUTCMinutes() : minute;
}

function parseNotificationHour(timeValue: string | null): number | null {
  if (!timeValue) {
    return null;
  }

  const [hourPart] = timeValue.split(':');
  const hour = Number(hourPart);
  return Number.isNaN(hour) ? null : hour;
}

export async function handleScheduleDailyReminders(req: Request): Promise<Response> {
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

  const supabase = createServiceClient();

  const { data: profiles, error } = await supabase
    .from('user_profiles')
    .select('id, timezone, notification_time, enable_daily_reminder, expo_push_token, deleted_at')
    .eq('enable_daily_reminder', true)
    .not('expo_push_token', 'is', null)
    .is('deleted_at', null);

  if (error) {
    console.error('schedule-daily-reminders lookup failed', error.message);
    return errorResponse('Failed to load reminder profiles', 500, 'internal_error');
  }

  let scheduledCount = 0;
  const now = new Date();

  for (const profile of profiles ?? []) {
    const targetHour = parseNotificationHour(profile.notification_time);
    if (targetHour === null) {
      continue;
    }

    const localHour = getLocalHour(profile.timezone || 'UTC', now);
    const localMinute = getLocalMinute(profile.timezone || 'UTC', now);

    if (localHour !== targetHour || localMinute > 5) {
      continue;
    }

    const reminderRequest = new Request('http://localhost/send-daily-reminder', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-cron-secret': req.headers.get('x-cron-secret') ?? '',
      },
      body: JSON.stringify({ userId: profile.id }),
    });

    const response = await handleSendDailyReminder(reminderRequest);

    if (response.ok) {
      scheduledCount += 1;
    }
  }

  const result: ScheduleDailyRemindersResponse = {
    success: true,
    scheduledCount,
  };

  return jsonResponse(result);
}

if (import.meta.main) {
  Deno.serve(handleScheduleDailyReminders);
}
