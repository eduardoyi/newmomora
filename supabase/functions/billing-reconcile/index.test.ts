import { assertEquals } from 'jsr:@std/assert@1';

import { buildBillingSnapshots, isCurrentEntitlement, normalizeStore } from './index.ts';

Deno.test('normalizes RevenueCat store identifiers from REST responses', () => {
  assertEquals(normalizeStore('play_store'), 'play_store');
  assertEquals(normalizeStore('PLAY_STORE'), 'play_store');
  assertEquals(normalizeStore('app_store'), 'app_store');
  assertEquals(normalizeStore('stripe'), 'unknown');
});

Deno.test('keeps production and sandbox entitlements in separate snapshots', () => {
  const snapshots = buildBillingSnapshots({
    management_url: 'https://apps.apple.com/account/subscriptions',
    entitlements: {
      momora_plus: {
        product_identifier: 'momora',
        purchase_date: '2099-08-01T00:00:00Z',
        expires_date: '2099-08-08T00:00:00Z',
        is_sandbox: true,
      },
    },
    subscriptions: {
      momora: {
        product_plan_identifier: 'annual',
        store: 'play_store',
        is_sandbox: true,
        period_type: 'trial',
        store_transaction_id: 'GPA.test',
      },
    },
  });

  assertEquals(snapshots.get('production'), []);
  assertEquals(snapshots.get('sandbox'), [{
    entitlement_id: 'momora_plus',
    product_id: 'momora:annual',
    store: 'play_store',
    period_type: 'trial',
    purchased_at: '2099-08-01T00:00:00Z',
    expires_at: '2099-08-08T00:00:00Z',
    grace_until: null,
    will_renew: true,
    original_transaction_id: null,
    transaction_id: 'GPA.test',
    management_url: 'https://apps.apple.com/account/subscriptions',
  }]);
});

Deno.test('ignores products that are not in Momora’s billing allowlist', () => {
  const snapshots = buildBillingSnapshots({
    entitlements: {
      momora_plus: { product_identifier: 'legacy_monthly', store: 'app_store' },
    },
  });

  assertEquals(snapshots.get('production'), []);
  assertEquals(snapshots.get('sandbox'), []);
});

Deno.test('does not reconcile expired RevenueCat entitlements as active access', () => {
  assertEquals(isCurrentEntitlement({}, Date.parse('2026-08-01T00:00:00Z')), false);
  assertEquals(isCurrentEntitlement({ expires_date: '2026-07-31T23:59:59Z' }, Date.parse('2026-08-01T00:00:00Z')), false);
  assertEquals(isCurrentEntitlement({ expires_date: '2026-07-31T23:59:59Z', grace_period_expires_date: '2026-08-02T00:00:00Z' }, Date.parse('2026-08-01T00:00:00Z')), true);
});
