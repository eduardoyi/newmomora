import { assertEquals } from 'jsr:@std/assert@1';

import {
  ILLUSTRATION_GENERATION_STALE_MS,
  isIllustrationGenerationStale,
} from './illustration-status.ts';

Deno.test('isIllustrationGenerationStale returns true after the stale window', () => {
  const now = Date.parse('2026-05-28T12:00:00Z');
  const staleUpdatedAt = new Date(now - ILLUSTRATION_GENERATION_STALE_MS - 1000).toISOString();

  assertEquals(isIllustrationGenerationStale('generating', staleUpdatedAt, now), true);
});

Deno.test('isIllustrationGenerationStale returns false for fresh generating status', () => {
  const now = Date.parse('2026-05-28T12:00:00Z');
  const freshUpdatedAt = new Date(now - 60_000).toISOString();

  assertEquals(isIllustrationGenerationStale('generating', freshUpdatedAt, now), false);
  assertEquals(isIllustrationGenerationStale('pending', freshUpdatedAt, now), false);
});

Deno.test('isIllustrationGenerationStale uses the dedicated clock over unrelated updated_at writes', () => {
  const now = Date.parse('2026-05-28T12:00:00Z');
  const oldStart = new Date(now - ILLUSTRATION_GENERATION_STALE_MS - 1).toISOString();
  const recentUnrelatedUpdate = new Date(now - 1_000).toISOString();

  assertEquals(
    isIllustrationGenerationStale('generating', recentUnrelatedUpdate, oldStart, now),
    true,
  );
});
