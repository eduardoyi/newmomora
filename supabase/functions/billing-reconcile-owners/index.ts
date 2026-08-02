import { validateCronSecret } from '../_shared/cron.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';
import { reconcileOwnerBilling } from '../billing-reconcile/index.ts';

export async function handleBillingReconcileOwners(req: Request): Promise<Response> {
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, 'method_not_allowed');
  if (!validateCronSecret(req)) return errorResponse('Unauthorized', 401, 'unauthorized');

  const apiKey = Deno.env.get('REVENUECAT_SECRET_API_KEY');
  const projectId = Deno.env.get('REVENUECAT_PROJECT_ID');
  if (!apiKey || !projectId) return errorResponse('Billing reconciliation is not configured', 503, 'billing_unavailable');

  const serviceClient = createServiceClient();
  const { data: owners, error } = await serviceClient.rpc('claim_billing_reconcile_owners', { p_limit: 50 });
  if (error) {
    console.error('billing owner reconciliation claim failed', error.code ?? 'unknown');
    return errorResponse('Could not claim billing reconciliations', 500, 'internal_error');
  }

  let reconciled = 0;
  let failed = 0;
  for (const row of (owners ?? []) as Array<{ owner_user_id: string }>) {
    try {
      await reconcileOwnerBilling(row.owner_user_id, apiKey, projectId);
      reconciled += 1;
    } catch (reconcileError) {
      failed += 1;
      console.error(
        'scheduled billing reconciliation failed',
        reconcileError instanceof Error ? reconcileError.message : 'unknown',
      );
    }
  }

  return jsonResponse({ success: true, claimed: (owners ?? []).length, reconciled, failed });
}

if (import.meta.main) Deno.serve(handleBillingReconcileOwners);
