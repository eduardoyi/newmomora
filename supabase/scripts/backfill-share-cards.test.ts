import { assertEquals } from 'jsr:@std/assert@1';

import {
  BACKFILL_WARM_MAX_ATTEMPTS,
  BACKFILL_WARM_RETRY_BACKOFF_MS,
  decideWarmRetry,
  describeTarget,
  type MediaAssetTargetRow,
  type MemoryTargetRow,
  SHARE_CARD_RETRYABLE_STATUS,
  shapeMediaAssetTargets,
  shapeMemoryTargets,
} from './backfill-share-cards.ts';

const FAMILY_A = '11111111-1111-4111-8111-111111111111';
const FAMILY_B = '22222222-2222-4222-8222-222222222222';
const MEMORY_1 = '33333333-3333-4333-8333-333333333333';
const MEMORY_2 = '44444444-4444-4444-8444-444444444444';
const ASSET_1 = '55555555-5555-4555-8555-555555555555';

// --- shapeMemoryTargets -----------------------------------------------------

Deno.test('shapeMemoryTargets: maps each row to a per-MEMORY target carrying its family id', () => {
  const rows: MemoryTargetRow[] = [
    { id: MEMORY_1, family_id: FAMILY_A },
    { id: MEMORY_2, family_id: FAMILY_B },
  ];

  assertEquals(shapeMemoryTargets(rows), [
    { kind: 'memory', memoryId: MEMORY_1, familyId: FAMILY_A },
    { kind: 'memory', memoryId: MEMORY_2, familyId: FAMILY_B },
  ]);
});

Deno.test('shapeMemoryTargets: empty input produces an empty target list', () => {
  assertEquals(shapeMemoryTargets([]), []);
});

// --- shapeMediaAssetTargets --------------------------------------------------

Deno.test('shapeMediaAssetTargets: maps each row to a per-ASSET target, pulling family id off the nested memories join', () => {
  const rows: MediaAssetTargetRow[] = [
    { id: ASSET_1, memory_id: MEMORY_1, content_type: 'image/jpeg', memories: { family_id: FAMILY_A } },
  ];

  assertEquals(shapeMediaAssetTargets(rows), [
    { kind: 'asset', memoryId: MEMORY_1, assetId: ASSET_1, familyId: FAMILY_A },
  ]);
});

Deno.test('shapeMediaAssetTargets: drops a row whose nested memories join came back null instead of throwing (dangling-FK defensive case)', () => {
  const rows: MediaAssetTargetRow[] = [
    { id: ASSET_1, memory_id: MEMORY_1, content_type: 'image/jpeg', memories: null },
    { id: 'asset-2', memory_id: MEMORY_2, content_type: 'image/png', memories: { family_id: FAMILY_B } },
  ];

  assertEquals(shapeMediaAssetTargets(rows), [
    { kind: 'asset', memoryId: MEMORY_2, assetId: 'asset-2', familyId: FAMILY_B },
  ]);
});

// --- describeTarget -----------------------------------------------------

Deno.test('describeTarget: memory-kind target has no asset id in the description', () => {
  assertEquals(describeTarget({ kind: 'memory', memoryId: MEMORY_1, familyId: FAMILY_A }), `memory ${MEMORY_1}`);
});

Deno.test('describeTarget: asset-kind target includes both memory and asset id', () => {
  assertEquals(
    describeTarget({ kind: 'asset', memoryId: MEMORY_1, assetId: ASSET_1, familyId: FAMILY_A }),
    `memory ${MEMORY_1} asset ${ASSET_1}`,
  );
});

// --- decideWarmRetry -----------------------------------------------------
// Mirrors src/services/share-card.ts's client-side warm retry contract
// (Part 3 of the four-part production fix): retry ONLY on 546, stop
// immediately on everything else -- most importantly 429, which must never
// be retried (it would just burn the warm bucket further).

Deno.test('decideWarmRetry: 204 is success regardless of attempt number', () => {
  assertEquals(decideWarmRetry(204, 1), { action: 'success' });
  assertEquals(decideWarmRetry(204, 6), { action: 'success' });
});

Deno.test('decideWarmRetry: 546 retries with the fixed backoff while under the max attempt count', () => {
  for (let attempt = 1; attempt < BACKFILL_WARM_MAX_ATTEMPTS; attempt++) {
    assertEquals(
      decideWarmRetry(SHARE_CARD_RETRYABLE_STATUS, attempt),
      { action: 'retry', delayMs: BACKFILL_WARM_RETRY_BACKOFF_MS },
    );
  }
});

Deno.test('decideWarmRetry: 546 gives up once the max attempt count is reached (no infinite retry)', () => {
  assertEquals(decideWarmRetry(SHARE_CARD_RETRYABLE_STATUS, BACKFILL_WARM_MAX_ATTEMPTS), { action: 'give_up' });
  assertEquals(decideWarmRetry(SHARE_CARD_RETRYABLE_STATUS, BACKFILL_WARM_MAX_ATTEMPTS + 1), { action: 'give_up' });
});

Deno.test('decideWarmRetry: 429 gives up immediately on the very first attempt -- never retried', () => {
  assertEquals(decideWarmRetry(429, 1), { action: 'give_up' });
});

Deno.test('decideWarmRetry: every other status (4xx/5xx) gives up immediately, same as 429', () => {
  for (const status of [400, 403, 404, 415, 500]) {
    assertEquals(decideWarmRetry(status, 1), { action: 'give_up' });
  }
});

Deno.test('decideWarmRetry: a thrown-fetch network error gives up immediately (not retried)', () => {
  assertEquals(decideWarmRetry('network_error', 1), { action: 'give_up' });
});

Deno.test('decideWarmRetry: respects a custom maxAttempts override', () => {
  assertEquals(decideWarmRetry(SHARE_CARD_RETRYABLE_STATUS, 1, 2), {
    action: 'retry',
    delayMs: BACKFILL_WARM_RETRY_BACKOFF_MS,
  });
  assertEquals(decideWarmRetry(SHARE_CARD_RETRYABLE_STATUS, 2, 2), { action: 'give_up' });
});
