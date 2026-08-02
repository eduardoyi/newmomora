import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

interface RevenueCatEvent {
  id?: string;
  type?: string;
  app_user_id?: string;
  product_id?: string;
  base_plan_id?: string;
  product_plan_identifier?: string;
  entitlement_ids?: string[];
  store?: string;
  environment?: string;
  period_type?: string;
  purchased_at_ms?: number;
  expiration_at_ms?: number;
  grace_period_expiration_at_ms?: number;
  cancel_reason?: string;
  original_transaction_id?: string;
  transaction_id?: string;
  management_url?: string | null;
  event_timestamp_ms?: number;
  unsubscribe_detected_at_ms?: number;
}

interface RevenueCatWebhookBody {
  event?: RevenueCatEvent;
}

function isoFromMillis(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value).toISOString();
}

function normalizeStore(value: string | undefined): string {
  if (value?.toUpperCase() === 'APP_STORE') return 'app_store';
  if (value?.toUpperCase() === 'PLAY_STORE') return 'play_store';
  return 'unknown';
}

function normalizeEnvironment(value: string | undefined): string {
  if (value?.toUpperCase() === 'PRODUCTION') return 'production';
  if (value?.toUpperCase() === 'SANDBOX') return 'sandbox';
  return 'unknown';
}

function normalizeProduct(event: RevenueCatEvent): string | null {
  if (typeof event.product_id !== 'string' || !event.product_id.trim()) return null;
  const basePlan = typeof event.base_plan_id === 'string'
    ? event.base_plan_id.trim()
    : typeof event.product_plan_identifier === 'string'
      ? event.product_plan_identifier.trim()
      : '';
  if (event.store?.toUpperCase() === 'PLAY_STORE' && basePlan && !event.product_id.includes(':')) {
    return `${event.product_id}:${basePlan}`;
  }
  return event.product_id.trim();
}

export function normalizeRevenueCatEvent(body: unknown): {
  eventId: string;
  store: string;
  environment: string;
  eventType: string;
  appUserId: string | null;
  productId: string | null;
  entitlementId: string | null;
  periodType: string | null;
  purchasedAt: string | null;
  expiresAt: string | null;
  graceUntil: string | null;
  eventAt: string | null;
  willRenew: boolean;
  originalTransactionId: string | null;
  transactionId: string | null;
  managementUrl: string | null;
} | null {
  if (!body || typeof body !== 'object' || !('event' in body)) return null;
  const event = (body as RevenueCatWebhookBody).event;
  if (!event || typeof event !== 'object' || typeof event.id !== 'string' || !event.id.trim()) return null;

  const eventType = typeof event.type === 'string' ? event.type.trim() : 'UNKNOWN';
  return {
    eventId: event.id.trim(),
    store: normalizeStore(event.store),
    environment: normalizeEnvironment(event.environment),
    eventType,
    appUserId: typeof event.app_user_id === 'string' ? event.app_user_id : null,
    productId: normalizeProduct(event),
    entitlementId: event.entitlement_ids?.find((value) => typeof value === 'string') ?? null,
    periodType: typeof event.period_type === 'string' ? event.period_type : null,
    purchasedAt: isoFromMillis(event.purchased_at_ms),
    expiresAt: isoFromMillis(event.expiration_at_ms),
    graceUntil: isoFromMillis(event.grace_period_expiration_at_ms),
    eventAt: isoFromMillis(event.event_timestamp_ms),
    willRenew: !['CANCELLATION', 'EXPIRATION', 'REFUND'].includes(eventType) && !Boolean(event.cancel_reason),
    originalTransactionId: typeof event.original_transaction_id === 'string' ? event.original_transaction_id : null,
    transactionId: typeof event.transaction_id === 'string' ? event.transaction_id : null,
    managementUrl: typeof event.management_url === 'string' ? event.management_url : null,
  };
}

export async function handleRevenueCatWebhook(req: Request): Promise<Response> {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, 'method_not_allowed');

  const expectedSecret = Deno.env.get('REVENUECAT_WEBHOOK_SECRET');
  const suppliedHeader = req.headers.get('x-revenuecat-webhook-authorization') ?? req.headers.get('authorization');
  const suppliedSecret = suppliedHeader?.replace(/^Bearer\s+/i, '') ?? null;
  if (!expectedSecret || suppliedSecret !== expectedSecret) {
    return errorResponse('Unauthorized', 401, 'unauthorized');
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, 'invalid_json');
  }

  const normalized = normalizeRevenueCatEvent(body);
  if (!normalized) return errorResponse('Webhook event is invalid', 400, 'validation_error');

  const { data, error } = await createServiceClient().rpc('queue_billing_webhook_event', {
    p_event_id: normalized.eventId,
    p_store: normalized.store,
    p_environment: normalized.environment,
    p_event_type: normalized.eventType,
    p_event_at: normalized.eventAt,
    p_app_user_id: normalized.appUserId,
    p_product_id: normalized.productId,
    p_entitlement_id: normalized.entitlementId,
    p_period_type: normalized.periodType,
    p_purchased_at: normalized.purchasedAt,
    p_expires_at: normalized.expiresAt,
    p_grace_until: normalized.graceUntil,
    p_will_renew: normalized.willRenew,
    p_original_transaction_id: normalized.originalTransactionId,
    p_transaction_id: normalized.transactionId,
    p_management_url: normalized.managementUrl,
  });

  if (error) {
    console.error('RevenueCat webhook queue failed', error.code ?? 'unknown');
    return errorResponse('Webhook queue unavailable', 500, 'queue_unavailable');
  }

  // Dead-lettered unknown accounts/products/events deliberately return 200 so
  // RevenueCat never retries an event that can never be applied.
  return jsonResponse({ received: true, status: data?.status ?? 'queued' });
}

if (import.meta.main) Deno.serve(handleRevenueCatWebhook);
