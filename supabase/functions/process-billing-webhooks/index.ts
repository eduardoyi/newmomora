import { validateCronSecret } from '../_shared/cron.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

const MAX_BILLING_WEBHOOK_ATTEMPTS = 5;

export async function handleProcessBillingWebhooks(req: Request): Promise<Response> {
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, 'method_not_allowed');
  if (!validateCronSecret(req)) return errorResponse('Unauthorized', 401, 'unauthorized');

  const serviceClient = createServiceClient();
  const { data: claimed, error: claimError } = await serviceClient.rpc('claim_billing_webhook_events', {
    p_limit: 100,
  });
  if (claimError) {
    console.error('billing webhook claim failed', claimError.code ?? 'unknown');
    return errorResponse('Could not claim billing events', 500, 'internal_error');
  }

  let processed = 0;
  let failed = 0;
  for (const event of (claimed ?? []) as Array<{ event_id: string; attempts: number }>) {
    const { data, error } = await serviceClient.rpc('apply_billing_webhook_event', {
      p_event_id: event.event_id,
    });
    if (!error && (data?.status === 'processed' || data?.status === 'dead_letter')) {
      processed += 1;
      continue;
    }
    failed += 1;
    const failure = error?.message ?? 'apply_failed';
    if (event.attempts >= MAX_BILLING_WEBHOOK_ATTEMPTS) {
      await serviceClient
        .from('billing_webhook_events')
        .update({ status: 'dead_letter', last_error: failure })
        .eq('event_id', event.event_id)
        .eq('status', 'processing');
      await serviceClient
        .from('billing_dead_letters')
        .upsert({ event_id: event.event_id, reason: `processing_failed:${failure}` }, { onConflict: 'event_id' });
    } else {
      // claim_billing_webhook_events already increments attempts atomically;
      // do not increment it again on the retry path.
      await serviceClient
        .from('billing_webhook_events')
        .update({
          status: 'pending',
          next_attempt_at: new Date(Date.now() + Math.min(60 * 60 * 1000, 2 ** event.attempts * 30_000)).toISOString(),
          last_error: failure,
        })
        .eq('event_id', event.event_id)
        .eq('status', 'processing');
    }
  }

  const { error: expiryError } = await serviceClient.rpc('expire_billing_entitlements', {});
  if (expiryError) console.error('billing entitlement expiry failed', expiryError.code ?? 'unknown');
  const { error: reminderError } = await serviceClient.rpc('enqueue_billing_trial_reminders', {});
  if (reminderError) console.error('billing reminder enqueue failed', reminderError.code ?? 'unknown');
  const { error: exportExpiryError } = await serviceClient.rpc('expire_export_jobs', {});
  if (exportExpiryError) console.error('export job expiry failed', exportExpiryError.code ?? 'unknown');

  return jsonResponse({ success: true, claimed: (claimed ?? []).length, processed, failed });
}

if (import.meta.main) Deno.serve(handleProcessBillingWebhooks);
