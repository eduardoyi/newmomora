import { getAuthenticatedNonAnonymousUser } from '../_shared/auth.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

export interface RevenueCatSubscriber {
  entitlements?: Record<string, {
    product_identifier?: string;
    purchase_date?: string | null;
    expires_date?: string | null;
    grace_period_expires_date?: string | null;
    unsubscribe_detected_at?: string | null;
    billing_issues_detected_at?: string | null;
    store?: string;
    is_sandbox?: boolean;
    product_plan_identifier?: string | null;
    period_type?: string | null;
  }>;
  subscriptions?: Record<string, {
    product_plan_identifier?: string | null;
    purchase_date?: string | null;
    expires_date?: string | null;
    unsubscribe_detected_at?: string | null;
    billing_issues_detected_at?: string | null;
    store?: string;
    is_sandbox?: boolean;
    grace_period_expires_date?: string | null;
    period_type?: string | null;
    store_transaction_id?: string | null;
  }>;
  management_url?: string | null;
}

export function normalizeStore(value: string | undefined): string {
  if (value?.toLowerCase() === 'play_store') return 'play_store';
  if (value?.toLowerCase() === 'app_store') return 'app_store';
  return 'unknown';
}

function normalizeProduct(productIdentifier: string, store: string, planIdentifier?: string | null): string {
  if (store === 'play_store' && productIdentifier === 'momora' && planIdentifier) {
    return `momora:${planIdentifier}`;
  }
  return productIdentifier;
}

const MOMORA_PRODUCTS = new Set([
  'momora_annual_v1',
  'momora_monthly_v1',
  'momora:annual',
  'momora:monthly',
]);

export type BillingSnapshotEntry = Record<string, unknown>;

export function isCurrentEntitlement(
  value: { expires_date?: string | null; grace_period_expires_date?: string | null },
  now = Date.now(),
): boolean {
  const expiresAt = value.expires_date ? Date.parse(value.expires_date) : Number.NaN;
  const graceUntil = value.grace_period_expires_date ? Date.parse(value.grace_period_expires_date) : Number.NEGATIVE_INFINITY;
  return Number.isFinite(expiresAt) && (expiresAt > now || graceUntil > now);
}

export function buildBillingSnapshots(
  subscriber: RevenueCatSubscriber,
): Map<string, BillingSnapshotEntry[]> {
  const snapshots = new Map<string, BillingSnapshotEntry[]>([
    ['production', []],
    ['sandbox', []],
  ]);

  for (const [entitlementId, value] of Object.entries(subscriber.entitlements ?? {})) {
    if (entitlementId !== 'momora_plus') continue;

    const productIdentifier = value.product_identifier ?? '';
    const subscription = productIdentifier ? subscriber.subscriptions?.[productIdentifier] : undefined;
    const store = normalizeStore(value.store ?? subscription?.store);
    if (store === 'unknown') continue;

    const isSandbox = value.is_sandbox ?? subscription?.is_sandbox ?? false;
    const environment = isSandbox ? 'sandbox' : 'production';
    const productPlanIdentifier = value.product_plan_identifier ?? subscription?.product_plan_identifier;
    const normalizedProduct = normalizeProduct(productIdentifier, store, productPlanIdentifier);
    if (!MOMORA_PRODUCTS.has(normalizedProduct)) continue;
    if (!isCurrentEntitlement({
      expires_date: value.expires_date ?? subscription?.expires_date,
      grace_period_expires_date: value.grace_period_expires_date ?? subscription?.grace_period_expires_date,
    })) continue;
    const periodType = value.period_type ?? subscription?.period_type ?? null;
    const entitlement = {
      entitlement_id: entitlementId,
      product_id: normalizedProduct,
      store,
      period_type: periodType,
      purchased_at: value.purchase_date ?? subscription?.purchase_date ?? null,
      expires_at: value.expires_date ?? subscription?.expires_date ?? null,
      grace_until: value.grace_period_expires_date ?? subscription?.grace_period_expires_date ?? null,
      will_renew: !value.unsubscribe_detected_at && !value.billing_issues_detected_at,
      original_transaction_id: null,
      transaction_id: subscription?.store_transaction_id ?? null,
      management_url: subscriber.management_url ?? null,
    };
    snapshots.get(environment)?.push(entitlement);
  }

  return snapshots;
}

export async function reconcileOwnerBilling(
  ownerUserId: string,
  apiKey: string,
  projectId: string,
): Promise<boolean> {
  const response = await fetch(
    `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(ownerUserId)}`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'X-Project-ID': projectId,
        Accept: 'application/json',
      },
    },
  );
  if (!response.ok) {
    await response.text().catch(() => '');
    throw new Error(`revenuecat_${response.status}`);
  }

  const payload = await response.json() as { subscriber?: RevenueCatSubscriber };
  const subscriber = payload.subscriber;
  if (!subscriber) throw new Error('revenuecat_invalid_response');

  const snapshots = buildBillingSnapshots(subscriber);
  const serviceClient = createServiceClient();
  const results = await Promise.all([...snapshots.entries()].map(([environment, entitlements]) =>
    serviceClient.rpc('reconcile_billing_snapshot', {
      p_owner_user_id: ownerUserId,
      p_environment: environment,
      p_entitlements: entitlements,
    }),
  ));
  const reconciliationError = results.find((result) => result.error)?.error;
  if (reconciliationError) throw new Error(`reconcile_db_${reconciliationError.code ?? 'unknown'}`);

  return [...snapshots.values()].some((values) => values.length > 0);
}

export async function handleBillingReconcile(req: Request): Promise<Response> {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, 'method_not_allowed');

  const user = await getAuthenticatedNonAnonymousUser(req);
  if (!user) return errorResponse('Unauthorized', 401, 'unauthorized');

  const apiKey = Deno.env.get('REVENUECAT_SECRET_API_KEY');
  const projectId = Deno.env.get('REVENUECAT_PROJECT_ID');
  if (!apiKey || !projectId) return errorResponse('Billing reconciliation is not configured', 503, 'billing_unavailable');

  try {
    const active = await reconcileOwnerBilling(user.id, apiKey, projectId);
    return jsonResponse({ success: true, active });
  } catch (error) {
    console.error('RevenueCat reconciliation failed', error instanceof Error ? error.message : 'unknown');
    return errorResponse('Could not reconcile subscription access', 502, 'reconcile_failed');
  }
}

if (import.meta.main) Deno.serve(handleBillingReconcile);
