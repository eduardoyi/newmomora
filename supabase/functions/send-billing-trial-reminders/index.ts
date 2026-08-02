import { sendTransactionalEmailWithOutcome } from '../_shared/bento.ts';
import { validateCronSecret } from '../_shared/cron.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { sendExpoPushNotification } from '../_shared/expo-push.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

interface ReminderRow {
  id: string;
  owner_user_id: string;
  channel: 'email' | 'push';
  claim_token: string;
}

interface ReminderEntitlement {
  status: string;
  period_type: string;
  expires_at: string | null;
}

async function failClaim(
  serviceClient: ReturnType<typeof createServiceClient>,
  row: ReminderRow,
  reason: string,
): Promise<void> {
  await serviceClient
    .from('billing_trial_reminder_outbox')
    .update({ status: 'failed', claim_token: null, last_error: reason, updated_at: new Date().toISOString() })
    .eq('id', row.id)
    .eq('claim_token', row.claim_token)
    .eq('status', 'sending');
}

function reminderHtml(): string {
  return '<p>Your Momora free week ends in two days.</p><p>Manage or cancel your subscription from your device store before the trial ends. Your saved memories remain exportable.</p>';
}

export async function handleSendBillingTrialReminders(req: Request): Promise<Response> {
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, 'method_not_allowed');
  if (!validateCronSecret(req)) return errorResponse('Unauthorized', 401, 'unauthorized');

  const serviceClient = createServiceClient();
  const { data: rows, error } = await serviceClient.rpc('claim_billing_trial_reminders', { p_limit: 100 });
  if (error) return errorResponse('Could not claim trial reminders', 500, 'internal_error');

  let sent = 0;
  for (const row of (rows ?? []) as ReminderRow[]) {
    // The entitlement trigger cancels most stale rows, but this final
    // just-in-time check closes the race between claim and provider delivery.
    const { data: reminder } = await serviceClient
      .from('billing_trial_reminder_outbox')
      .select('entitlement_id')
      .eq('id', row.id)
      .eq('claim_token', row.claim_token)
      .maybeSingle();
    const { data: entitlement } = reminder?.entitlement_id
      ? await serviceClient
        .from('owner_entitlements')
        .select('status, period_type, expires_at')
        .eq('id', reminder.entitlement_id)
        .eq('owner_user_id', row.owner_user_id)
        .maybeSingle()
      : { data: null };
    const trial = entitlement as ReminderEntitlement | null;
    if (
      !trial ||
      trial.status !== 'trial' ||
      trial.period_type !== 'annual' ||
      !trial.expires_at ||
      Date.parse(trial.expires_at) <= Date.now()
    ) {
      await failClaim(serviceClient, row, 'trial_no_longer_active');
      continue;
    }

    let delivered = false;
    let outcome: 'sent' | 'rejected' | 'unknown' = 'sent';
    if (row.channel === 'email') {
      const { data: authUser } = await serviceClient.auth.admin.getUserById(row.owner_user_id);
      const email = authUser.user?.email;
      if (email) {
        outcome = await sendTransactionalEmailWithOutcome({
          to: email,
          subject: 'Your Momora trial ends in two days',
          htmlBody: reminderHtml(),
        });
        delivered = outcome === 'sent';
      } else {
        await failClaim(serviceClient, row, 'no_email_destination');
        continue;
      }
    } else {
      const { data: profile } = await serviceClient
        .from('user_profiles')
        .select('expo_push_token')
        .eq('id', row.owner_user_id)
        .maybeSingle();
      if (profile?.expo_push_token) {
        delivered = await sendExpoPushNotification(
          profile.expo_push_token,
          'Your Momora trial ends in two days',
          'Manage or cancel from your device store before the trial ends.',
          { route: 'timeline' },
        );
      } else {
        await failClaim(serviceClient, row, 'no_push_destination');
        continue;
      }
    }

    if (delivered) {
      await serviceClient.rpc('mark_billing_trial_reminder_sent', { p_id: row.id, p_claim_token: row.claim_token });
      sent += 1;
    } else {
      await serviceClient.rpc('release_billing_trial_reminder', {
        p_id: row.id,
        p_claim_token: row.claim_token,
        p_error: outcome === 'unknown' ? 'delivery_unknown' : 'provider_rejected',
      });
    }
  }

  return jsonResponse({ success: true, claimed: (rows ?? []).length, sent });
}

if (import.meta.main) Deno.serve(handleSendBillingTrialReminders);
