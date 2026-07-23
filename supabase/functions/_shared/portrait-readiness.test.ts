import { assertEquals } from 'jsr:@std/assert@1';

import {
  hasFreshInFlightPortraitVersion,
  isFreshInFlightPortraitVersion,
  PORTRAIT_CLAIM_RECLAIM_WINDOW_MS,
  PORTRAIT_UNCLAIMED_PENDING_GRACE_MS,
  type PortraitFreshnessCandidate,
} from './portrait-readiness.ts';

const NOW = Date.parse('2026-07-20T12:00:00Z');

function version(overrides: Partial<PortraitFreshnessCandidate>): PortraitFreshnessCandidate {
  return {
    id: 'version-id',
    family_member_id: 'member-id',
    reference_date: '2026-01-01',
    profile_picture_key: 'photo.jpg',
    illustrated_profile_key: null,
    illustrated_profile_status: 'generating',
    deletion_token: null,
    created_at: new Date(NOW - 60_000).toISOString(),
    generation_token: null,
    generation_started_at: null,
    ...overrides,
  };
}

Deno.test('claimed row within the 5:30 reclaim window is fresh in-flight', () => {
  const claimed = version({
    illustrated_profile_status: 'generating',
    generation_token: 'attempt-1',
    generation_started_at: new Date(NOW - (PORTRAIT_CLAIM_RECLAIM_WINDOW_MS - 1000)).toISOString(),
  });

  assertEquals(isFreshInFlightPortraitVersion(claimed, NOW), true);
});

Deno.test('claimed row past the 5:30 reclaim window is stale', () => {
  const staleClaim = version({
    illustrated_profile_status: 'generating',
    generation_token: 'attempt-1',
    generation_started_at: new Date(NOW - PORTRAIT_CLAIM_RECLAIM_WINDOW_MS - 1000).toISOString(),
  });

  assertEquals(isFreshInFlightPortraitVersion(staleClaim, NOW), false);
});

Deno.test('unclaimed pending row within the 3-minute grace window is fresh in-flight', () => {
  const unclaimed = version({
    illustrated_profile_status: 'pending',
    generation_token: null,
    generation_started_at: null,
    created_at: new Date(NOW - (PORTRAIT_UNCLAIMED_PENDING_GRACE_MS - 1000)).toISOString(),
  });

  assertEquals(isFreshInFlightPortraitVersion(unclaimed, NOW), true);
});

Deno.test('unclaimed pending row past the 3-minute grace window is stale', () => {
  const staleUnclaimed = version({
    illustrated_profile_status: 'pending',
    generation_token: null,
    generation_started_at: null,
    created_at: new Date(NOW - PORTRAIT_UNCLAIMED_PENDING_GRACE_MS - 1000).toISOString(),
  });

  assertEquals(isFreshInFlightPortraitVersion(staleUnclaimed, NOW), false);
});

Deno.test('a deletion-claimed row never counts as fresh in-flight, even if freshly claimed', () => {
  const deletionClaimed = version({
    illustrated_profile_status: 'pending',
    deletion_token: 'delete-1',
    generation_token: null,
    generation_started_at: null,
    created_at: new Date(NOW - 1000).toISOString(),
  });

  assertEquals(isFreshInFlightPortraitVersion(deletionClaimed, NOW), false);
});

Deno.test('ready and failed statuses never count as in-flight', () => {
  const ready = version({ illustrated_profile_status: 'ready', illustrated_profile_key: 'key.webp' });
  const failed = version({ illustrated_profile_status: 'failed' });

  assertEquals(isFreshInFlightPortraitVersion(ready, NOW), false);
  assertEquals(isFreshInFlightPortraitVersion(failed, NOW), false);
});

Deno.test('hasFreshInFlightPortraitVersion is true when any version in the set is fresh in-flight', () => {
  const versions = [
    version({ illustrated_profile_status: 'failed' }),
    version({
      illustrated_profile_status: 'pending',
      created_at: new Date(NOW - 1000).toISOString(),
    }),
  ];

  assertEquals(hasFreshInFlightPortraitVersion(versions, NOW), true);
});

Deno.test('hasFreshInFlightPortraitVersion is false when no version in the set is fresh in-flight', () => {
  const versions = [
    version({ illustrated_profile_status: 'failed' }),
    version({ illustrated_profile_status: 'ready', illustrated_profile_key: 'key.webp' }),
  ];

  assertEquals(hasFreshInFlightPortraitVersion(versions, NOW), false);
});
