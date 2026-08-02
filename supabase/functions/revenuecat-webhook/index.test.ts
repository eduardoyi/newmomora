import { assertEquals } from 'jsr:@std/assert@1';

import { normalizeRevenueCatEvent } from './index.ts';

const UUID = '00000000-0000-4000-8000-000000000001';

Deno.test('normalizes a Google Play base plan and event timestamp', () => {
  const normalized = normalizeRevenueCatEvent({
    event: {
      id: 'evt-play-1',
      type: 'INITIAL_PURCHASE',
      app_user_id: UUID,
      product_id: 'momora',
      product_plan_identifier: 'annual',
      entitlement_ids: ['momora_plus'],
      store: 'play_store',
      environment: 'sandbox',
      period_type: 'TRIAL',
      event_timestamp_ms: 1785542400000,
    },
  });

  assertEquals(normalized?.productId, 'momora:annual');
  assertEquals(normalized?.store, 'play_store');
  assertEquals(normalized?.environment, 'sandbox');
  assertEquals(normalized?.eventAt, '2026-08-01T00:00:00.000Z');
  assertEquals(normalized?.willRenew, true);
});

Deno.test('rejects a webhook body without an event id', () => {
  assertEquals(normalizeRevenueCatEvent({ event: { type: 'RENEWAL' } }), null);
});

Deno.test('normalizes cancellation as non-renewing while access can continue until expiry', () => {
  const normalized = normalizeRevenueCatEvent({
    event: {
      id: 'evt-cancel-1',
      type: 'CANCELLATION',
      app_user_id: UUID,
      product_id: 'momora_monthly_v1',
      store: 'APP_STORE',
      environment: 'PRODUCTION',
      cancel_reason: 'CUSTOMER_CANCELLED',
    },
  });

  assertEquals(normalized?.willRenew, false);
  assertEquals(normalized?.productId, 'momora_monthly_v1');
});
