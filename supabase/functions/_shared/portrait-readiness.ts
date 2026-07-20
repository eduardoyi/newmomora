import type { PortraitVersionCandidate } from './portrait-versions.ts';

/** Adds the claim columns needed to judge freshness, not just usability. */
export interface PortraitFreshnessCandidate extends PortraitVersionCandidate {
  generation_token?: string | null;
  generation_started_at?: string | null;
}

const IN_FLIGHT_STATUSES = new Set(['pending', 'generating']);

// Mirrors claim_family_member_portrait_generation's own reclaim window
// (migration 20260715120000:251-252) so a dead claim isn't deferred forever.
export const PORTRAIT_CLAIM_RECLAIM_WINDOW_MS = 15 * 60 * 1000;

// Covers a lost creation-time fire-and-forget invoke (useFamilyMembers.ts:
// 31-43) without waiting indefinitely on a claim that may never arrive.
export const PORTRAIT_UNCLAIMED_PENDING_GRACE_MS = 5 * 60 * 1000;

/**
 * A portrait version counts as fresh in-flight only while a completion is
 * still plausible: pending/generating, not claimed for deletion (a
 * deletion-claimed keyless row will be removed, never completed -- and the
 * deletion-claim UPDATE bumps `updated_at`, so recency alone would misread
 * it as fresh), and recent by the appropriate clock for its claim state.
 */
export function isFreshInFlightPortraitVersion(
  version: PortraitFreshnessCandidate,
  now = Date.now(),
): boolean {
  if (!IN_FLIGHT_STATUSES.has(version.illustrated_profile_status)) {
    return false;
  }
  if (version.deletion_token) {
    return false;
  }

  if (version.generation_token) {
    if (!version.generation_started_at) {
      return false;
    }
    const startedAt = Date.parse(version.generation_started_at);
    return !Number.isNaN(startedAt) && now - startedAt < PORTRAIT_CLAIM_RECLAIM_WINDOW_MS;
  }

  const createdAt = Date.parse(version.created_at);
  return !Number.isNaN(createdAt) && now - createdAt < PORTRAIT_UNCLAIMED_PENDING_GRACE_MS;
}

export function hasFreshInFlightPortraitVersion(
  versions: PortraitFreshnessCandidate[],
  now = Date.now(),
): boolean {
  return versions.some((version) => isFreshInFlightPortraitVersion(version, now));
}
